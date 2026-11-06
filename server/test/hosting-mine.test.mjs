// "Mis servidores" on the server, deployed dark (Prompt 2, PR 2): an operator's own servers in full
// (A11) and its actions on them (A12), the community server's mark and the "Solo servidores del
// proyecto" preference (A15), and the players' reports (A16). The NodeRegistryDO on fakes as
// hosting.test.mjs runs it (node:sqlite, fake sockets that answer an assign, a fake ACCOUNTS that
// answers GET /me, a KV that records its reads, fake webhooks for both staff channels); the queue
// hub on its fakes (helpers/hub.mjs) for the preference's way through the Worker and the hub; and
// the Worker in front of a recording NODES for its routes. Every rule is checked closed too: while
// hosting is closed nothing new is stored and no player sees anything new. Nothing leaves this
// machine. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeHubWorld, accountToken } from './helpers/hub.mjs';

// The control plane's timers must never keep the test process alive (helpers/hub.mjs unrefs them too).
const realSetTimeout = globalThis.setTimeout;

const D = await import('../src/NodeRegistryDO.ts');
const { CLIENT_BUILD, rejoinTicketOf, serverMarkOf } = await import('../src/nodeApi.ts');
const { REPORT_DAYS } = await import('../src/nodeStore.ts');
const { hostRulesVersion } = await import('../src/hostPolicy.ts');
const { backoffKey, projectOnlyOf } = await import('../src/MatchmakerDO.ts');
const { INTERNAL_HEADER, internalSecret, signJwt } = await import('../src/auth.ts');
const { generateEd25519, importPrivateKey, sign } = await import('../../nodes/shared/edcrypto.ts');
const { authMessage, reachMessage } = await import('../../nodes/shared/controlProtocol.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'hosting-mine-test-secret';
const RealResponse = globalThis.Response;
globalThis.Response = class Response extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      this.upgraded = true;
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

let clock = 1_800_000_000_000;
const realNow = Date.now;
const DAY = 24 * 3_600_000;

const lines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(' ');
  lines.push(line);
  if (process.env.NODELOG) realLog(line);
};

const PROJECT = 'a1b2c3d4e5f60718';
const JUAN = '0123456789abcdef';
const ANA = 'fedcba9876543210';
const EVA = '00112233445566ee';
const BASE = 'https://turbo-gol.test';
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' };
const NODE_BUILD = { ...CLIENT_BUILD, version: '0.2.0' };
const CONTROL = await generateEd25519();
const secret = await internalSecret(SECRET);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
async function waitFor(fn, what) {
  for (let i = 0; i < 300 && !(await fn()); i++) await sleep(2);
  assert.ok(await fn(), what);
}
/** (b) in force: the version and its hosting minimum. */
const IN_FORCE = { TERMS_VERSION: '2026-11-16', NODE_HOSTING_TERMS: '2026-11-16' };
const ADMIN = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto') };
const as = (id) => ({ 'x-operator-id': id, 'x-operator-name': 'Juan' });
const hex64 = (c) => c.repeat(64).slice(0, 64);

// ---- fakes (hosting.test.mjs's, with a node that answers its assigns) ----------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
    this.onSend = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    const m = JSON.parse(text);
    this.sent.push(m);
    this.onSend?.(m);
  }
  close(code, reason) {
    if (this.readyState === 3) throw new Error('already closed');
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(a) {
    this.att = JSON.parse(JSON.stringify(a));
  }
  deserializeAttachment() {
    return this.att;
  }
  of(t) {
    return this.sent.filter((m) => m.t === t);
  }
}
globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};

function sqlOf(db) {
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  let depth = 0;
  const transactionSync = (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
  return { sql, transactionSync };
}

class FakeCtx {
  constructor(db = new DatabaseSync(':memory:')) {
    this.db = db;
    this.sockets = [];
    this.alarm = null;
    this.waits = [];
    const { sql, transactionSync } = sqlOf(db);
    const kv = new Map();
    this.storage = {
      sql,
      transactionSync,
      get: async (k) => structuredClone(kv.get(k)),
      put: async (k, v) => void kv.set(k, structuredClone(v)),
      getAlarm: async () => this.alarm,
      setAlarm: async (t) => void (this.alarm = t),
      deleteAlarm: async () => void (this.alarm = null),
    };
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((w) => w.readyState === 1);
  }
  waitUntil(p) {
    this.waits.push(Promise.resolve(p));
  }
  async settle() {
    while (this.waits.length > 0) await Promise.all(this.waits.splice(0));
  }
}

function bucket(initial = {}) {
  const objects = new Map();
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(initial)) objects.set(k, enc.encode(v));
  const view = (k) => {
    const b = objects.get(k);
    return b ? { key: k, size: b.byteLength, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
  };
  return { objects, get: async (k) => view(k), head: async (k) => view(k), put: async (k, v) => void objects.set(k, typeof v === 'string' ? enc.encode(v) : v), delete: async () => undefined };
}

/** A KV namespace that records its reads. */
function kvOf(values = {}) {
  const map = new Map(Object.entries(values));
  const kv = {
    map,
    reads: [],
    puts: [],
    get: async (k) => {
      kv.reads.push(k);
      return map.has(k) ? map.get(k) : null;
    },
    put: async (k, v) => {
      kv.puts.push([k, v]);
      map.set(k, v);
    },
  };
  return kv;
}

const person = (over = {}) => ({ createdAt: clock - 30 * DAY, emailVerified: true, terms: IN_FORCE.TERMS_VERSION, deletionAt: 0, ...over });
function accountsNs(people = new Map()) {
  const ns = {
    people,
    calls: [],
    /** When set, /host-consent answers this (status, body). */
    consent: null,
    /** When set, the next GET /me answers the account as it is now, but only once this settles (a late answer). */
    holdNext: null,
    idFromName: (n) => ({ n }),
    get: () => ({
      fetch: async (url, init) => {
        const u = new URL(url);
        const body = init?.body ? JSON.parse(init.body) : null;
        ns.calls.push({ path: u.pathname, body });
        const out = (b, status = 200) => new RealResponse(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/me') {
          const p = people.get(u.searchParams.get('userId'));
          const answer = p ? out(p) : out({ error: 'no_user' }, 404);
          const hold = ns.holdNext;
          ns.holdNext = null;
          if (hold) await hold;
          return answer;
        }
        // The 'host' row as AccountsDO writes it (hosting.test.mjs checks the real one): GET /me says it from then on.
        if (u.pathname === '/host-consent') {
          if (ns.consent) return out(ns.consent.body, ns.consent.status);
          people.get(body.userId).hostTerms = body.version;
          return out({ hostTerms: body.version });
        }
        return out({ ok: true, applied: true });
      },
    }),
  };
  return ns;
}

const HOOK = 'https://discord.test/api/webhooks/1/team';
const CHOOK = 'https://discord.test/api/webhooks/2/community';
const posts = [];
const hosts = new Map();
const realFetch = globalThis.fetch;
const fakeFetch = async (url, init = {}) => {
  if (String(url) === HOOK || String(url) === CHOOK) {
    posts.push({ url: String(url), content: JSON.parse(init.body).content });
    return new RealResponse(null, { status: 204 });
  }
  const u = new URL(String(url));
  const h = hosts.get(u.host);
  if (u.pathname !== '/healthz' || !h) throw new Error('BLOCKED network call in a test: ' + url);
  return new RealResponse(JSON.stringify({ ok: true, nodeId: h.nodeId, draining: false, sig: await sign(h.key, reachMessage(h.nodeId, u.searchParams.get('nonce'))) }));
};

/** The object's tests run on this file's clock and fetch; the hub's (helpers/hub.mjs) on theirs. */
function objectWorld() {
  Date.now = () => clock;
  globalThis.fetch = fakeFetch;
}
function realWorld() {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}

function makeEnv(over = {}) {
  return {
    JWT_SECRET: SECRET,
    NODES: {},
    NODE_REPLAYS: bucket(),
    NODE_RELEASES: bucket({ 'channel.json': JSON.stringify({ stable: '0.2.0', minimum: '0.2.0' }) }),
    NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey,
    NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey,
    NODE_TRUSTED_OPERATORS: PROJECT,
    NODE_TRUSTED_MAX_NODES: '6',
    NODES_PUBLIC_BASE: BASE,
    FLAGS: kvOf(),
    ACCOUNTS: accountsNs(new Map([[JUAN, person()], [ANA, person()], [EVA, person()]])),
    MATCHMAKER: accountsNs(),
    NODE_ALERT_WEBHOOK: HOOK,
    NODE_COMMUNITY_WEBHOOK: CHOOK,
    ...over,
  };
}

/** Closed: the terms of today (version (a)) with the flag at '1' all the same. */
const closedEnv = (over = {}) => makeEnv({ TERMS_VERSION: '2026-11-05', FLAGS: kvOf({ node_operators: '1' }), ...over });
/** Open: (b) in force and hosting open to every account. */
const openEnv = (over = {}) => makeEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: '1' }), ...over });

/** The DNS a community registration reads (NodeRegistryDO dnsFn): no records for any name, so never Cloudflare's proxy (hosting.test.mjs tests the lookup). */
const fakeDns = async () => [];

async function boot(env, ctx = new FakeCtx()) {
  objectWorld();
  const obj = new D.NodeRegistryDO(ctx, env);
  obj.alertSleep = () => Promise.resolve();
  // A community registration reads its name's DNS records (proxyCheck.ts): never the network here.
  obj.dnsFn = fakeDns;
  await obj.ready;
  return { obj, ctx, env };
}

async function call(h, method, path, { body, headers = {} } = {}) {
  const res = await h.obj.fetch(
    new Request('https://nodes' + path, {
      method,
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

const rows = (h, table) => h.ctx.db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));

let installs = 0;
async function register(h, token, { publicUrl, continent = 'SA' }) {
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', {
    body: { token, publicKey: keys.publicKey, roles: ['host'], publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP },
    headers: { 'x-client-ip': '198.51.100.' + (++installs % 250), 'x-client-continent': continent },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const node = { ...r.json, key: await importPrivateKey(keys.privateKey), publicUrl };
  hosts.set(new URL(publicUrl).host, node);
  return node;
}

/** Log `node` in and say its hello; its socket answers every assign with its URL (unless `refuse`). */
async function logIn(h, node) {
  await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  const ws = h.ctx.sockets.at(-1);
  ws.onSend = (m) => {
    if (m.t === 'assign') setImmediate(() => void h.obj.webSocketMessage(ws, JSON.stringify({ t: 'reply', rid: m.rid, ok: true, data: { wsUrl: `${node.publicUrl}/m/${m.match.matchId}` } })));
  };
  const challenge = ws.of('challenge')[0];
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, challenge.nonce)) }));
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'hello', data: { bootId: 'boot-1', build: NODE_BUILD, roles: ['host'], transports: ['wss'], publicUrl: node.publicUrl, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null } }));
  await h.obj.webSocketMessage(ws, JSON.stringify(beat()));
  return ws;
}
const beat = (over = {}) => ({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...over } });

/**
 * `op` holds the rules for hosts in force, as its first code leaves it (hostGate's writeHostRules):
 * AccountsDO's 'host' row (GET /me's hostTerms) and the object's copy (host_rules), which placement
 * reads. None while the terms in force do not describe hosting (hostRulesVersion null).
 */
function holdRules(h, op = JUAN) {
  const v = hostRulesVersion(h.env);
  const p = h.env.ACCOUNTS.people.get(op);
  if (p) p.hostTerms = v;
  h.obj.noteHostRules(op, v);
}

/**
 * A community node of `op` (a token the registry mints: the gate is hosting.test.mjs's), live on
 * probation, or active with `active`: no verifier runs here, and a node on probation takes only
 * matches some verifier can re-simulate. Its operator holds the rules for hosts as its first code
 * left them (`rules` false: it never accepted any).
 */
async function community(h, { op = JUAN, host = 'juan.example.org', name = 'juan-1', active = false, rules = true } = {}) {
  if (rules) holdRules(h, op);
  const { token } = await h.obj.cp.registry.createToken({ id: op, name: 'Juan' }, 'SA', clock, name, { publicHost: host });
  const node = await register(h, token, { publicUrl: `wss://${host}` });
  const ws = await logIn(h, node);
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'probation', 'probation');
  if (active) h.obj.cp.registry.setStatus(node.nodeId, 'active', null);
  return { node, ws };
}

/** A project node, live and active. */
async function project(h, { host = 'sp1.example.org', name = 'sao-paulo-1' } = {}) {
  const t = await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', name, publicHost: host }, headers: ADMIN });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const node = await register(h, t.json.token, { publicUrl: `wss://${host}`, continent: '' });
  const ws = await logIn(h, node);
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'active', 'active');
  return { node, ws };
}

const playersOf = (...ids) => ids.map((id, i) => ({ playerId: id, name: 'P' + i, account: true, accountAgeDays: 30 }));
const place = (h, body = {}) => call(h, 'POST', '/internal/place', { body: { mode: '1v1', region: 'SA', ranked: false, matchLengthSeconds: 180, humans: playersOf(ANA, EVA), ...body } });
const mine = (h, id = JUAN, headers = {}) => call(h, 'GET', '/nodes/mine', { headers: { ...as(id), ...headers } });
const own = (h, what, body, id = JUAN) => call(h, 'POST', what === 'revoke' ? '/nodes/tokens/revoke' : '/nodes/mine/' + what, { body, headers: as(id) });
const report = (h, body, id = ANA) => call(h, 'POST', '/nodes/report', { body: { reason: 'lag', ...body }, headers: { 'x-operator-id': id } });

// ---- dark: nothing new while hosting is closed ------------------------------------------------------

test('closed: /nodes/mine asks AccountsDO nothing and says hosting is closed; a rename is refused and writes nothing; a report is refused and stores nothing; a project server has no mark; drain, retire and a revoke of its own still go', async () => {
  const h = await boot(closedEnv());
  const { node } = await community(h, { active: true });
  const m = await mine(h);
  assert.equal(m.status, 200);
  assert.deepEqual([m.json.hosting, m.json.requirements, m.json.terms], [{ open: false, reason: 'hosting_closed' }, null, null]);
  assert.deepEqual(h.env.ACCOUNTS.calls, [], 'AccountsDO never asked');
  assert.deepEqual([m.json.nodes.length, m.json.limits.maxNodes, m.json.showPublic], [1, 3, false]);
  // A name it chooses is new data: refused, nothing written.
  const before = rows(h, 'nodes').find((r) => r.node_id === node.nodeId).data;
  const r = await own(h, 'rename', { nodeId: node.nodeId, name: 'casa-juan' });
  assert.deepEqual([r.status, r.json.error], [403, 'hosting_closed']);
  assert.deepEqual([h.obj.cp.registry.node(node.nodeId).name, rows(h, 'nodes').find((x) => x.node_id === node.nodeId).data], ['juan-1', before]);
  // No match for a community server while the terms do not describe hosting: nobody outside the
  // project holds the rules for hosts (hostRulesVersion null), and the region backs off as one with no host.
  const p = await place(h);
  assert.deepEqual([p.status, p.json], [200, { placement: null, hosts: 0 }]);
  assert.deepEqual(h.ctx.sockets.flatMap((s) => s.of('assign')), [], 'nothing sent to it');
  // A report: refused before anything is read, nothing in the table.
  const rep = await report(h, { matchId: hex64('e') });
  assert.deepEqual([rep.status, rep.json.error, rows(h, 'node_reports')], [403, 'hosting_closed', []]);
  // A project server while closed: no mark at all (a community one is always marked: honest, "the mark" below).
  const hp = await boot(closedEnv());
  await project(hp);
  const pp = await place(hp);
  assert.deepEqual([pp.json.placement.trusted, 'server' in pp.json], [true, false], 'no mark for a project server while dark');
  const rj = await call(hp, 'POST', '/internal/rejoin', { body: { matchId: pp.json.placement.matchId, playerId: ANA } });
  assert.deepEqual([rj.status, 'server' in rj.json], [200, false]);
  assert.ok(!hp.env.FLAGS.reads.includes('node_operators'), 'the flag is not even read while the terms do not describe hosting');
  // What stops something is always taken: a code of its own revoked, a server drained and retired.
  await h.obj.cp.registry.createToken({ id: JUAN, name: 'Juan' }, 'SA', clock, undefined, { publicHost: 'j2.example.org' });
  const tok = (await mine(h)).json.tokens.find((t) => t.state === 'unused');
  assert.equal((await own(h, 'revoke', { id: tok.id })).status, 200);
  assert.equal((await own(h, 'drain', { nodeId: node.nodeId })).status, 200);
  const [ws] = h.ctx.sockets.filter((x) => x.readyState === 1);
  await h.obj.webSocketMessage(ws, JSON.stringify(beat({ draining: true })));
  assert.equal((await own(h, 'retire', { nodeId: node.nodeId })).status, 200, 'drained, and no match ever went to it');
  // The rules for hosts: no acceptance again before the terms describe hosting, nothing asked or stored.
  const again = await call(h, 'POST', '/nodes/mine/accept', { body: { acceptHost: true, adult: true }, headers: as(JUAN) });
  assert.deepEqual([again.status, again.json.error, rows(h, 'host_rules')], [403, 'hosting_closed', []]);
  assert.deepEqual(h.env.ACCOUNTS.calls, [], 'still never asked');
});

// ---- A11: GET /nodes/mine in full ---------------------------------------------------------------------

test("open: /nodes/mine in full for a community operator: each node's service state, probe, progress, strikes, refusals and effective capacity; what it lacks in the token's order; the rules for hosts; its own codes and limits; today's points against the cap; never the reports", async () => {
  const h = await boot(openEnv());
  const p = h.env.ACCOUNTS.people;
  const { node } = await community(h);
  await community(h, { op: ANA, host: 'ana.example.org', name: 'ana-1' });
  const createdAt = h.obj.cp.registry.node(node.nodeId).createdAt;
  clock += 1000;
  await h.obj.cp.registry.createToken({ id: ANA, name: 'Ana' }, 'SA', clock, undefined, { publicHost: 'ana2.example.org' });
  await h.obj.cp.registry.createToken({ id: JUAN, name: 'Juan' }, 'SA', clock, 'juan-2', { publicHost: 'j2.example.org' });
  // The rules for hosts of an earlier version: to accept again (Terms 12.2), after what else it lacks.
  p.set(JUAN, person({ emailVerified: false, createdAt: clock - 2 * DAY, hostTerms: '2026-11-05' }));
  const m = await mine(h);
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const n = m.json.nodes[0];
  assert.deepEqual(
    [n.nodeId, n.name, n.status, n.createdAt, n.draining, n.reachableAt !== null, n.lastProbe.ok, n.needed, n.strikes, n.pauses, n.afterPause, n.refused, n.capacityEffective, n.publicUrl],
    [node.nodeId, 'juan-1', 'probation', createdAt, false, true, true, 20, { count: 0, max: 3, windowDays: 7, nextExpiry: null }, { count: 0, windowDays: 30 }, null, { count: 0, rate: 0, recent: 0, of: 0, outUntil: null }, 4, 'wss://juan.example.org'],
  );
  assert.deepEqual(m.json.hosting, { open: true });
  assert.deepEqual(m.json.requirements, { missing: ['email_required', 'account_too_new', 'reaccept_required'], daysLeft: 5 });
  assert.deepEqual(m.json.terms, { version: IN_FORCE.TERMS_VERSION, accepted: false, acceptedVersion: '2026-11-05', again: true }, 'the rules for hosts of before: accepted again first');
  assert.deepEqual(m.json.limits, { nodes: 1, maxNodes: 3, tokensToday: 0, tokensLeftToday: 3, outstanding: 1, maxOutstanding: 2 });
  assert.deepEqual(
    m.json.tokens.map((t) => [t.region, t.name, t.publicHost, t.state, t.nodeId]),
    [
      ['SA', 'juan-2', 'j2.example.org', 'unused', null],
      ['SA', 'juan-1', 'juan.example.org', 'used', node.nodeId],
    ],
    'its own codes only, never Ana’s',
  );
  assert.deepEqual([m.json.rewards.pointsToday, m.json.rewards.capToday, m.json.showPublic, m.json.channel], [0, 300, false, { stable: '0.2.0', minimum: '0.2.0' }]);
  // The session's since: the younger of the two.
  h.obj.hostAccounts.clear();
  const since = await mine(h, JUAN, { 'x-operator-since': String(Math.floor((clock - DAY) / 1000)) });
  assert.equal(since.json.requirements.daysLeft, 6);
  // A blocked operator lacks that first; once it meets everything, nothing is missing.
  await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'block', reason: 'review' }, headers: ADMIN });
  p.set(JUAN, person({ hostTerms: IN_FORCE.TERMS_VERSION }));
  h.obj.hostAccounts.clear();
  const blocked = await mine(h);
  assert.deepEqual([blocked.json.requirements.missing, blocked.json.terms.accepted], [['operator_blocked'], true]);
  await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'unblock' }, headers: ADMIN });
  assert.deepEqual((await mine(h)).json.requirements, { missing: [], daysLeft: 0 });
  // GET /me is read once a minute for it (the screen refreshes every 10 s).
  const reads = () => h.env.ACCOUNTS.calls.filter((c) => c.path === '/me').length;
  const was = reads();
  for (let i = 0; i < 7; i++) {
    clock += 10_000;
    await mine(h);
  }
  assert.equal(reads(), was + 1, 'one more read past the minute');
  // A project account lacks nothing and has no community caps; AccountsDO is not asked for it.
  const calls = h.env.ACCOUNTS.calls.length;
  const pm = await mine(h, PROJECT);
  assert.deepEqual([pm.json.operator.trusted, pm.json.hosting, pm.json.requirements, pm.json.terms.accepted, pm.json.limits.maxOutstanding, pm.json.limits.tokensLeftToday, pm.json.rewards.capToday, pm.json.showPublic], [true, { open: true }, { missing: [], daysLeft: 0 }, true, null, null, null, true]);
  assert.equal(h.env.ACCOUNTS.calls.length, calls);
  // Hosting open to a canary that is not it: closed for it, nothing asked.
  const c = await boot(openEnv({ FLAGS: kvOf({ node_operators: ANA }) }));
  await community(c);
  const cm = await mine(c);
  assert.deepEqual([cm.json.hosting, cm.json.requirements, c.env.ACCOUNTS.calls], [{ open: false, reason: 'hosting_closed' }, null, []]);
});

test('/nodes/mine shows the automatic measures (Terms 9.2 and 12.6.1, "MIS SERVIDORES te muestra tus faltas"): the lost matches in their window and when the oldest goes, a strike pause and where it leaves the server, a second one back to probation, a failed verification', async () => {
  const h = await boot(openEnv());
  const { node } = await community(h, { active: true });
  const reg = h.obj.cp.registry;
  const view = async () => (await mine(h)).json.nodes.find((n) => n.nodeId === node.nodeId);
  const t0 = clock;
  reg.onLost(node.nodeId, 'node_offline', t0);
  let n = await view();
  assert.deepEqual([n.status, n.strikes, n.pauses, n.afterPause], ['active', { count: 1, max: 3, windowDays: 7, nextExpiry: t0 + 7 * DAY }, { count: 0, windowDays: 30 }, null]);
  // The third in the window: a pause of a day, back where it was (active) when it lifts.
  reg.onLost(node.nodeId, 'node_offline', t0 + 1000);
  reg.onLost(node.nodeId, 'node_offline', t0 + 2000);
  n = await view();
  assert.deepEqual([n.status, n.statusReason, n.suspendedUntil, n.afterPause, n.pauses.count, n.strikes.count], ['suspended', 'strikes:node_offline', t0 + 2000 + DAY, 'active', 1, 3]);
  // It lifts; another lost match within the week pauses it again, the second time in 30 days: back to probation after it.
  clock = t0 + 2000 + DAY;
  reg.sweep(clock);
  assert.equal(reg.node(node.nodeId).status, 'active');
  reg.onLost(node.nodeId, 'node_offline', clock);
  n = await view();
  assert.deepEqual([n.status, n.afterPause, n.pauses.count, n.strikes.count, n.strikes.nextExpiry], ['suspended', 'probation', 2, 4, t0 + 7 * DAY]);
  // A week after the last, the lost matches are out of their window: none counted, whatever the counter last said.
  clock = t0 + 2000 + 8 * DAY;
  n = await view();
  assert.deepEqual([n.strikes.count, n.strikes.nextExpiry, n.pauses.count], [0, null, 2]);
  // Lifted, on probation now. Three lost matches 29.5 days after the second pause began: a third
  // pause, a repeated one, so Registry.onLost demotes it again. Its window ends where it began: still
  // said once the second pause has left the 30 days, while this one runs.
  reg.sweep(clock);
  assert.equal(reg.node(node.nodeId).status, 'probation');
  const third = t0 + 2000 + DAY + 29.5 * DAY;
  for (const at of [third - 2000, third - 1000, third]) reg.onLost(node.nodeId, 'node_offline', at);
  clock = third + 0.75 * DAY;
  n = await view();
  assert.deepEqual([n.status, n.afterPause, n.pauses.count, n.suspendedUntil], ['suspended', 'probation', 2, third + DAY]);
  assert.equal(reg.node(node.nodeId).counters.probationVerified, 0);
  clock = third + DAY;
  reg.sweep(clock);
  n = await view();
  assert.deepEqual([n.status, n.afterPause, n.pauses.count], ['probation', null, 1], 'lifted: the 30 days from now again');
  // A failed verification: suspended until a person looks, no end, nowhere it goes by itself.
  reg.onVerified(node.nodeId, false, false);
  n = await view();
  assert.deepEqual([n.status, n.statusReason, n.suspendedUntil, n.afterPause], ['suspended', 'verification_failed', null, null]);
  clock = t0;
});

// ---- A12: the owner's actions -------------------------------------------------------------------------

test("the owner's actions on its own servers: drain, rename and retire, and its own codes revoked; another's is no_node / no_token; a project account's are the panel's; a banned server untouched, a suspended one never retired, a blocked operator's never renamed; a log line each, never an ALERT", async () => {
  const h = await boot(openEnv());
  const { node, ws } = await community(h);
  const ana = await community(h, { op: ANA, host: 'ana.example.org', name: 'ana-1' });
  const sp = await project(h);
  await h.ctx.settle();
  posts.length = 0;
  lines.length = 0;
  // Whose: another operator's server is none of yours; a project account goes to the panel.
  assert.deepEqual([(await own(h, 'drain', { nodeId: ana.node.nodeId })).status, (await own(h, 'drain', { nodeId: ana.node.nodeId })).json.error], [404, 'no_node']);
  for (const what of ['drain', 'rename', 'retire']) assert.equal((await own(h, what, { nodeId: sp.node.nodeId, name: 'x1' }, PROJECT)).json.error, 'trusted', what);
  assert.equal((await own(h, 'revoke', { id: 'abcdef12' }, PROJECT)).json.error, 'trusted');
  assert.equal((await own(h, 'drain', { nodeId: 'zz' })).json.error, 'bad_node_id');
  // Rename: a --name's characters, free in its region, never a project server's (in any case); the public list and the mark at once.
  for (const [name, code] of [['x', 'bad_name'], ['con espacio', 'bad_name'], ['ANA-1', 'name_taken'], ['Sao-Paulo-1', 'name_taken']]) assert.equal((await own(h, 'rename', { nodeId: node.nodeId, name })).json.error, code, name);
  const rn = await own(h, 'rename', { nodeId: node.nodeId, name: 'casa-juan' });
  assert.deepEqual([rn.status, rn.json.name, rn.json.was], [200, 'casa-juan', 'juan-1']);
  assert.equal(JSON.parse(rows(h, 'nodes').find((r) => r.node_id === node.nodeId).data).name, 'casa-juan', 'written');
  assert.ok((await call(h, 'GET', '/nodes/status')).json.nodes.some((n) => n.name === 'casa-juan'));
  assert.equal((await own(h, 'rename', { nodeId: node.nodeId, name: 'CASA-JUAN' })).status, 200, 'its own name in another case');
  // Retire: not while online and serving; drain first (the node is told), then it goes.
  assert.equal((await own(h, 'retire', { nodeId: node.nodeId })).json.error, 'not_retirable');
  const dr = await own(h, 'drain', { nodeId: node.nodeId });
  assert.deepEqual([dr.status, dr.json.draining, ws.of('drain').length], [200, true, 1]);
  await h.obj.webSocketMessage(ws, JSON.stringify(beat({ draining: true })));
  const rt = await own(h, 'retire', { nodeId: node.nodeId });
  assert.deepEqual([rt.status, rt.json.slots], [200, { used: 0, max: 3 }]);
  assert.deepEqual(ws.closed, { code: 4403, reason: 'retired' });
  assert.equal(h.obj.cp.registry.node(node.nodeId).retiredReason, 'retired by its operator');
  assert.deepEqual((await mine(h)).json.nodes, [], 'out of /nodes/mine');
  for (const what of ['drain', 'rename', 'retire']) assert.equal((await own(h, what, { nodeId: node.nodeId, name: 'otra-1' })).json.error, 'retired', what);
  // An offline server is retired at once; drain one that is offline: nothing sent.
  const off = await community(h, { host: 'j3.example.org', name: 'juan-3' });
  off.ws.close(1000, 'bye');
  await h.obj.webSocketClose(off.ws, 1000, 'bye', true);
  assert.equal((await own(h, 'drain', { nodeId: off.node.nodeId })).json.error, 'offline');
  assert.equal((await own(h, 'retire', { nodeId: off.node.nodeId })).status, 200);
  // A server the team banned keeps its slot: none of the owner's actions touches it.
  const ban = await community(h, { host: 'j6.example.org', name: 'juan-6' });
  assert.equal((await call(h, 'POST', '/nodes/admin/status', { body: { nodeId: ban.node.nodeId, status: 'banned', reason: 'tampering' }, headers: ADMIN })).status, 200);
  for (const what of ['drain', 'rename', 'retire']) assert.equal((await own(h, what, { nodeId: ban.node.nodeId, name: 'otra-6' })).json.error, 'banned', what);
  assert.deepEqual(h.obj.cp.registry.slots(JUAN), { used: 1, max: 3 }, 'its slot stays taken');
  // Its own codes: an unused one revoked (it registers nothing), another's none of yours, a used one is its server's.
  const mineTok = await h.obj.cp.registry.createToken({ id: JUAN, name: 'Juan' }, 'SA', clock, undefined, { publicHost: 'j4.example.org' });
  await h.obj.cp.registry.createToken({ id: ANA, name: 'Ana' }, 'SA', clock, undefined, { publicHost: 'ana4.example.org' });
  const list = (await mine(h)).json.tokens;
  const unused = list.find((t) => t.state === 'unused');
  const used = list.find((t) => t.state === 'used');
  const anas = (await mine(h, ANA)).json.tokens.find((t) => t.state === 'unused');
  assert.deepEqual([(await own(h, 'revoke', { id: anas.id })).json.error, (await own(h, 'revoke', { id: used.id })).json.error], ['no_token', 'token_used']);
  const rv = await own(h, 'revoke', { id: unused.id });
  assert.deepEqual([rv.status, rv.json.already], [200, false]);
  assert.equal((await own(h, 'revoke', { id: unused.id })).json.already, true);
  const keys = await generateEd25519();
  const reg = await call(h, 'POST', '/nodes/register', { body: { token: mineTok.token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://j4.example.org', build: NODE_BUILD, specs: SPECS, capacity: CAP }, headers: { 'x-client-ip': '198.51.100.200', 'x-client-continent': 'SA' } });
  assert.equal(reg.json.error, 'token_revoked');
  // A suspended server waits for a person (a failed verification) or for its pause to end (3
  // strikes): never retired by its owner, online or not, so its slot never frees past them. A drain still goes.
  const sus = await community(h, { host: 'j7.example.org', name: 'juan-7' });
  h.obj.cp.registry.onVerified(sus.node.nodeId, false, false);
  assert.equal(h.obj.cp.registry.node(sus.node.nodeId).status, 'suspended');
  assert.equal((await own(h, 'drain', { nodeId: sus.node.nodeId })).status, 200, 'what stops something still goes');
  await h.obj.webSocketMessage(sus.ws, JSON.stringify(beat({ draining: true })));
  assert.equal((await own(h, 'retire', { nodeId: sus.node.nodeId })).json.error, 'suspended', 'drained, with no open match');
  sus.ws.close(1000, 'bye');
  await h.obj.webSocketClose(sus.ws, 1000, 'bye', true);
  assert.equal((await own(h, 'retire', { nodeId: sus.node.nodeId })).json.error, 'suspended', 'offline');
  const pause = await community(h, { host: 'j8.example.org', name: 'juan-8' });
  for (let i = 0; i < 3; i++) h.obj.cp.registry.onLost(pause.node.nodeId, 'node_offline', clock);
  assert.deepEqual([h.obj.cp.registry.node(pause.node.nodeId).status, (await own(h, 'retire', { nodeId: pause.node.nodeId })).json.error], ['suspended', 'suspended']);
  assert.deepEqual(h.obj.cp.registry.slots(JUAN), { used: 3, max: 3 }, 'both slots stay taken');
  // A blocked operator (A4): its servers get no new name (the public list); nothing written.
  await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'block', reason: 'review' }, headers: ADMIN });
  const bl = await own(h, 'rename', { nodeId: sus.node.nodeId, name: 'otra-7' });
  assert.deepEqual([bl.status, bl.json.error, h.obj.cp.registry.node(sus.node.nodeId).name], [403, 'operator_blocked', 'juan-7']);
  assert.equal(JSON.parse(rows(h, 'nodes').find((r) => r.node_id === sus.node.nodeId).data).name, 'juan-7');
  // None of it reached a channel: the operator's own business, in the logs.
  await h.ctx.settle();
  assert.deepEqual(posts.filter((p) => /drain|renamed|casa-juan|retired|revoked/.test(p.content)), []);
  assert.ok(lines.some((l) => l.includes(`community operator ${JUAN}: node ${node.nodeId} renamed juan-1 -> casa-juan`)));
  assert.ok(lines.some((l) => l.includes(`community operator ${JUAN}: token ${unused.id.slice(0, 12)} revoked`)));
  assert.ok(!rows(h, 'node_alerts').some((r) => r.line.includes('casa-juan') || r.line.includes('retired by')), "nothing in the panel's ring");
});

// ---- Terms 12.2: the rules for hosts of a new version, accepted again ---------------------------------

/** POST /nodes/mine/accept as the Worker forwards it. */
const acceptAgain = (h, body = { acceptHost: true, adult: true }, id = JUAN) => call(h, 'POST', '/nodes/mine/accept', { body, headers: as(id) });
const consents = (h) => h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-consent').map((c) => c.body);
const NEXT = '2026-12-01';

test('a new terms version: its servers get no new match (running ones finish), no code (reaccept_required), until it accepts the rules again in Mis servidores with the first code\'s gate and row (source host_reaccept); never a first acceptance there; the project never held to it; kept through a deploy, gone with the account', async () => {
  const db = new DatabaseSync(':memory:');
  const env = openEnv();
  const h = await boot(env, new FakeCtx(db));
  const p = h.env.ACCOUNTS.people;
  const { node } = await community(h, { active: true });
  const first = await place(h);
  assert.equal(first.json.placement.nodeId, node.nodeId, 'it holds the rules in force: placed');
  // The deploy of a new version: the version the rules need moves with TERMS_VERSION (NODE_HOSTING_TERMS is its minimum).
  env.TERMS_VERSION = NEXT;
  assert.equal(hostRulesVersion(env), NEXT);
  p.get(JUAN).terms = NEXT; // the general terms accepted again (their own sheet)
  const sent = h.ctx.sockets.flatMap((x) => x.of('assign')).length;
  const none = await place(h, { humans: playersOf(EVA) });
  assert.deepEqual([none.json.placement, none.json.hosts], [null, 0], 'no new match, and the region backs off');
  assert.equal(h.ctx.sockets.flatMap((x) => x.of('assign')).length, sent, 'nothing sent to it');
  const rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: first.json.placement.matchId, playerId: ANA } });
  assert.equal(rj.status, 200, 'its running match goes on');
  // Mis servidores says so, after what else it lacks; a code waits for it.
  h.obj.hostAccounts.clear();
  const m = await mine(h);
  assert.deepEqual([m.json.terms, m.json.requirements], [{ version: NEXT, accepted: false, acceptedVersion: IN_FORCE.TERMS_VERSION, again: true }, { missing: ['reaccept_required'], daysLeft: 0 }]);
  const code = await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', publicHost: 'j2.example.org', acceptHost: true, adult: true }, headers: as(JUAN) });
  assert.deepEqual([code.status, code.json.error, code.json.version, consents(h)], [403, 'reaccept_required', NEXT, []], 'never with a code');
  // The acceptance: both, as for the first code; nothing written without them.
  for (const [body, error] of [[{}, 'terms_required'], [{ acceptHost: true }, 'adult_required'], [{ acceptHost: true, adult: 'yes' }, 'adult_required'], [{ adult: true }, 'terms_required']]) {
    const r = await acceptAgain(h, body);
    assert.deepEqual([r.status, r.json.error], [403, error], JSON.stringify(body));
  }
  assert.equal((await call(h, 'POST', '/nodes/mine/accept', { body: 'nope', headers: as(JUAN) })).status, 400);
  assert.deepEqual([consents(h), rows(h, 'host_rules').map((r) => r.version)], [[], [IN_FORCE.TERMS_VERSION]]);
  lines.length = 0;
  const ok = await acceptAgain(h);
  assert.deepEqual([ok.status, ok.json], [200, { hostTerms: NEXT, already: false }]);
  assert.deepEqual(consents(h), [{ userId: JUAN, version: NEXT, adult: true, again: true }]);
  assert.deepEqual(rows(h, 'host_rules'), [{ operator_id: JUAN, version: NEXT, at: clock }]);
  assert.ok(lines.some((l) => l.includes(`community operator ${JUAN} accepted again the rules for hosts of ${NEXT} and declared 18 or older`)));
  assert.deepEqual((await acceptAgain(h)).json, { hostTerms: NEXT, already: true }, 'a second press writes nothing');
  assert.equal(consents(h).length, 1);
  // From then on: new matches, a code without accepting anything again, nothing left to do.
  assert.equal((await place(h, { humans: playersOf(EVA) })).json.placement.nodeId, node.nodeId);
  const m2 = await mine(h);
  assert.deepEqual([m2.json.terms, m2.json.requirements.missing], [{ version: NEXT, accepted: true, acceptedVersion: NEXT, again: false }, []]);
  assert.equal((await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', publicHost: 'j2.example.org' }, headers: as(JUAN) })).status, 200);
  // The Operadores tab says which rules each host holds.
  const ops = (await call(h, 'GET', '/nodes/admin/operators', { headers: ADMIN })).json.operators;
  assert.deepEqual(ops.find((o) => o.operatorId === JUAN).rules, { accepted: NEXT, held: true });
  // A first acceptance is never here: an account that never accepted any and has no server accepts with its first code.
  p.get(ANA).terms = NEXT;
  const fresh = await acceptAgain(h, undefined, ANA);
  assert.deepEqual([fresh.status, fresh.json.error, consents(h).length], [409, 'first_code', 1]);
  // A server on its books without any (an account that left the project's): no match until it accepts, here.
  const ana = await community(h, { op: ANA, host: 'ana.example.org', name: 'ana-1', active: true, rules: false });
  assert.equal((await mine(h, ANA)).json.terms.again, true);
  for (let i = 0; i < 3; i++) assert.notEqual((await place(h, { humans: playersOf(hex64(String(i)).slice(0, 16)) })).json.placement?.nodeId, ana.node.nodeId);
  assert.deepEqual(ana.ws.of('assign'), [], 'never asked');
  assert.equal((await acceptAgain(h, undefined, ANA)).status, 200);
  assert.equal(h.obj.rulesHeld(ANA), true);
  // Blocked: refused before anything is read.
  await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: EVA, action: 'block', reason: 'review' }, headers: ADMIN });
  const calls = h.env.ACCOUNTS.calls.length;
  assert.deepEqual([(await acceptAgain(h, undefined, EVA)).json.error, h.env.ACCOUNTS.calls.length], ['operator_blocked', calls]);
  // AccountsDO's refusal is its: nothing kept.
  env.TERMS_VERSION = '2026-12-15';
  p.get(JUAN).terms = '2026-12-15';
  h.env.ACCOUNTS.consent = { status: 409, body: { error: 'terms_changed', version: '2027-01-01' } };
  assert.deepEqual([(await acceptAgain(h)).json.error, h.obj.rulesHeld(JUAN), rows(h, 'host_rules').find((r) => r.operator_id === JUAN).version], ['terms_required', false, NEXT]);
  h.env.ACCOUNTS.consent = null;
  env.TERMS_VERSION = NEXT;
  // Through a deploy: the copy holds, and so does placement.
  const back = await boot(env, new FakeCtx(db));
  assert.deepEqual([back.obj.rulesHeld(JUAN), back.obj.rulesHeld(ANA)], [true, true]);
  // The project: never held to the rules (A2, A3), its servers placed whatever its account holds.
  const pj = await boot(openEnv());
  await project(pj);
  pj.env.TERMS_VERSION = NEXT;
  assert.equal((await place(pj)).json.placement.trusted, true);
  assert.equal((await acceptAgain(pj, undefined, PROJECT)).json.error, 'trusted');
  assert.deepEqual((await mine(pj, PROJECT)).json.terms, { version: NEXT, accepted: true, acceptedVersion: null, again: false });
  // Hosting not open for the account (a canary it is not in): refused, AccountsDO never asked.
  const c = await boot(openEnv({ FLAGS: kvOf({ node_operators: ANA }) }));
  assert.deepEqual([(await acceptAgain(c)).json.error, c.env.ACCOUNTS.calls], ['hosting_closed', []]);
  // The account purged: its copy goes with it.
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: JUAN } })).status, 200);
  assert.deepEqual([rows(h, 'host_rules').map((r) => r.operator_id), h.obj.rulesHeld(JUAN)], [[ANA], false]);
});

test("the copy of the rules for hosts: a GET /me answer older than an acceptance again, or than the purge, keeps nothing; a purged account never gets one back; a row the store fails to keep leaves the copy as it was, and the next read writes it", async () => {
  const env = openEnv();
  const h = await boot(env);
  const p = h.env.ACCOUNTS.people;
  const { node } = await community(h, { active: true });
  env.TERMS_VERSION = NEXT;
  p.get(JUAN).terms = NEXT;
  h.obj.hostAccounts.clear();
  const reads = () => h.env.ACCOUNTS.calls.filter((c) => c.path === '/me').length;
  /** `go` with the next GET /me's answer held until the returned function is called. */
  const late = async (go) => {
    let release;
    h.env.ACCOUNTS.holdNext = new Promise((r) => (release = r));
    const n = reads();
    const out = go();
    while (reads() === n) await sleep(1);
    return { out, release: () => release() };
  };
  // Mis servidores' poll reads the account (the rules of before) and its answer lands after VOLVER A ACEPTAR.
  const poll = await late(() => mine(h));
  assert.deepEqual((await acceptAgain(h)).json, { hostTerms: NEXT, already: false });
  poll.release();
  assert.equal((await poll.out).status, 200);
  assert.deepEqual([h.obj.rulesHeld(JUAN), rows(h, 'host_rules').map((r) => r.version), h.obj.hostAccounts.has(JUAN)], [true, [NEXT], false], 'the late answer neither copied nor kept');
  assert.equal((await place(h)).json.placement.nodeId, node.nodeId);
  assert.deepEqual((await mine(h)).json.terms, { version: NEXT, accepted: true, acceptedVersion: NEXT, again: false }, 'the next read is fresh');
  // A read under way when the account is purged: its answer brings nothing back.
  h.obj.hostAccounts.clear();
  const gone = await late(() => mine(h));
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: JUAN } })).status, 200);
  gone.release();
  await gone.out;
  assert.deepEqual([rows(h, 'host_rules'), h.obj.rulesHeld(JUAN), h.obj.hostAccounts.has(JUAN)], [[], false, false]);
  // Nor a write that lands after the purge: node_forgotten has the id.
  h.obj.noteHostRules(JUAN, NEXT);
  assert.deepEqual([rows(h, 'host_rules'), h.obj.rulesHeld(JUAN)], [[], false]);
  // The store fails to keep a row: the copy stays as it was, and the account's next read writes it.
  Object.assign(p.get(ANA), { terms: NEXT, hostTerms: NEXT });
  h.obj.store.setHostRules = () => {
    throw new Error('disk full');
  };
  lines.length = 0;
  assert.equal((await mine(h, ANA)).status, 200);
  assert.deepEqual([h.obj.rulesHeld(ANA), rows(h, 'host_rules')], [false, []]);
  assert.ok(lines.some((l) => l.includes(`the rules for hosts of ${ANA} not kept: Error: disk full`)));
  delete h.obj.store.setHostRules;
  h.obj.hostAccounts.clear();
  await mine(h, ANA);
  assert.deepEqual([h.obj.rulesHeld(ANA), rows(h, 'host_rules').map((r) => [r.operator_id, r.version])], [true, [[ANA, NEXT]]]);
});

// ---- A15: the community server's mark and the preference, at the object ---------------------------------

test("the mark: a community server's in every placement and rejoin, a project server's once the terms describe hosting (never by the flag: neither it nor the reports go when it is closed again or its read fails), by the name the registry holds; projectOnly places on the project's nodes alone, its hosts the project's", async () => {
  const h = await boot(openEnv());
  const sp = await project(h);
  const pp = await place(h);
  assert.deepEqual([pp.json.placement.nodeId, pp.json.server], [sp.node.nodeId, { name: 'sao-paulo-1', community: false }], 'open: a project server is marked as such');
  // A region with a community server only.
  const c = await boot(openEnv());
  const { node } = await community(c, { active: true });
  await own(c, 'rename', { nodeId: node.nodeId, name: 'casa-juan' });
  const cp = await place(c);
  assert.deepEqual([cp.json.placement.trusted, cp.json.server], [false, { name: 'casa-juan', community: true }], 'the name as the registry holds it, never the node’s');
  const rj = await call(c, 'POST', '/internal/rejoin', { body: { matchId: cp.json.placement.matchId, playerId: ANA } });
  assert.deepEqual(rj.json.server, { name: 'casa-juan', community: true });
  // "Solo servidores del proyecto": the community server is never asked, and the hosts counted are the project's.
  const sent = c.ctx.sockets.flatMap((s) => s.of('assign')).length;
  const po = await place(c, { projectOnly: true, humans: playersOf(EVA) });
  assert.deepEqual([po.status, po.json.placement, po.json.hosts, 'server' in po.json], [200, null, 0, false]);
  assert.equal(c.ctx.sockets.flatMap((s) => s.of('assign')).length, sent, 'no assign sent');
  assert.equal((await place(c, { humans: playersOf(EVA) })).json.hosts, 1, 'for everyone else the region has its host');
  const both = await boot(openEnv());
  await community(both, { active: true });
  const spb = await project(both);
  for (let i = 0; i < 3; i++) assert.equal((await place(both, { projectOnly: true, humans: playersOf(i.toString(16).repeat(16)) })).json.placement.nodeId, spb.node.nodeId);
  assert.equal((await place(both, { projectOnly: 'yes' })).status, 400, 'a boolean or nothing');
  // From the terms on, the KV flag never takes a project server's mark or the reports away: closed
  // again ('0') while community servers still host, absent, or a failed read (flagValue's null).
  const down = () => ({ reads: [], get: async () => { throw new Error('KV down'); } });
  for (const [what, FLAGS] of [['0', kvOf({ node_operators: '0' })], ['absent', kvOf()], ['a failed read', down()]]) {
    const z = await boot(openEnv({ FLAGS }));
    await project(z);
    assert.deepEqual((await place(z)).json.server, { name: 'sao-paulo-1', community: false }, what);
    const zc = await boot(openEnv({ FLAGS }));
    await community(zc, { active: true });
    const zm = (await place(zc)).json;
    assert.deepEqual(zm.server, { name: 'juan-1', community: true }, what);
    assert.deepEqual([(await report(zc, { matchId: zm.placement.matchId })).status, rows(zc, 'node_reports').length], [200, 1], `a report: ${what}`);
  }
  // The mark's parse: junk is no mark.
  assert.deepEqual([serverMarkOf({ name: 'x', community: true }), serverMarkOf({ name: '', community: true }), serverMarkOf({ name: 'x' }), serverMarkOf('x')], [{ name: 'x', community: true }, null, null, null]);
  assert.deepEqual(rejoinTicketOf({ ticket: 't', wsUrl: 'wss://n.example.org/m/1', server: { name: 'n', community: true } }).server, { name: 'n', community: true });
  assert.equal('server' in rejoinTicketOf({ ticket: 't', wsUrl: 'wss://n.example.org/m/1', server: { name: 1 } }), false);
  assert.deepEqual([projectOnlyOf([{}, { projectOnly: true }]), projectOnlyOf([{}, {}]), backoffKey('EU', true), backoffKey('EU', false)], [true, false, 'EU:project', 'EU']);
});

// ---- A16: the players' reports ------------------------------------------------------------------------

test('reports: only a player of the match (the live roster, then the history or the public replays), a community server only, once per match, 20 a day; never its host’s to see; the Operadores tab counts them; 30 days; a purged reporter’s go, a purged host’s are re-keyed and none is taken about its servers after', async () => {
  const db = new DatabaseSync(':memory:');
  const env = openEnv();
  let h = await boot(env, new FakeCtx(db));
  const { node } = await community(h, { active: true });
  const p = await place(h);
  const matchId = p.json.placement.matchId;
  for (const [body, code] of [
    [{ matchId: 'x' }, 'bad_match_id'],
    [{ matchId, reason: 'cheater' }, 'bad_reason'],
    [{ matchId, ping: -1 }, 'bad_numbers'],
    [{ matchId, ping: 1.5 }, 'bad_numbers'],
    [{ matchId, corrections: 'many' }, 'bad_numbers'],
  ])
    assert.equal((await report(h, body)).json.error, code, JSON.stringify(body));
  assert.deepEqual([(await report(h, { matchId }, JUAN)).status, (await report(h, { matchId }, JUAN)).json.error], [404, 'no_match'], 'not a player of it');
  assert.equal((await report(h, { matchId: hex64('e') })).json.error, 'no_match', 'no such match: the same answer');
  const ok = await report(h, { matchId, reason: 'unresponsive', ping: 180, corrections: 42 });
  assert.deepEqual([ok.status, ok.json], [200, { reported: true }]);
  assert.deepEqual([(await report(h, { matchId })).status, (await report(h, { matchId })).json.error], [409, 'already_reported']);
  assert.equal((await report(h, { matchId, reason: 'disconnected' }, EVA)).status, 200, 'another player of it');
  assert.deepEqual(
    rows(h, 'node_reports').map((r) => [r.match_id, r.reporter_id, r.node_id, r.operator_id, r.reason, r.ping, r.corrections]),
    [
      [matchId, ANA, node.nodeId, JUAN, 'unresponsive', 180, 42],
      [matchId, EVA, node.nodeId, JUAN, 'disconnected', null, null],
    ],
  );
  assert.ok(lines.some((l) => l.includes(`report on community node ${node.nodeId} (unresponsive)`)) && !lines.some((l) => l.includes('report') && l.includes(ANA)), 'a log line without the account');
  // A project server is never reported.
  const sp = await boot(openEnv());
  await project(sp);
  const spm = (await place(sp)).json.placement.matchId;
  assert.deepEqual([(await report(sp, { matchId: spm })).status, (await report(sp, { matchId: spm })).json.error, rows(sp, 'node_reports')], [409, 'project_server', []]);
  // The Operadores tab: how many, from how many accounts, by reason and node; the host's own view never.
  const ops = await call(h, 'GET', '/nodes/admin/operators', { headers: ADMIN });
  const juan = ops.json.operators.find((o) => o.operatorId === JUAN);
  assert.deepEqual([juan.reports.days, juan.reports.count, juan.reports.accounts, juan.reports.byReason, juan.reports.byNode], [7, 2, 2, { unresponsive: 1, lag: 0, disconnected: 1, other: 0 }, [{ nodeId: node.nodeId, reports: 2, accounts: 2 }]]);
  assert.deepEqual(juan.reports.recent.map((r) => r.reporterId).sort(), [ANA, EVA].sort());
  assert.deepEqual(juan.reports.recent.map((r) => [r.matchId, r.ping]).sort(), [[matchId, 180], [matchId, null]].sort(), 'the team sees the numbers too');
  assert.ok(!JSON.stringify((await mine(h)).json).includes(ANA), "never in its host's view");
  // A settled match the control plane no longer holds: the history's seat proves it (a void one too), or the public replays'.
  const old = hex64('a');
  h.ctx.db.prepare('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(old, node.nodeId, clock, 'void', 'node_offline', '{}');
  h.ctx.db.prepare('INSERT INTO node_match_players (match_id, slot, player_id, name) VALUES (?, 0, ?, ?)').run(old, ANA, 'Ana');
  assert.equal((await report(h, { matchId: old, reason: 'disconnected' })).status, 200, 'a void match its bad server left');
  const listed = hex64('b');
  h.ctx.db.prepare('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(listed, node.nodeId, clock, 'unrated', null, '{}');
  h.ctx.db.prepare('INSERT INTO replay_players (match_id, slot, player_id) VALUES (?, 0, ?)').run(listed, EVA);
  assert.equal((await report(h, { matchId: listed }, EVA)).status, 200, "the public replays' seat");
  assert.equal((await report(h, { matchId: listed }, JUAN)).json.error, 'no_match');
  // 20 a day per account, counted in SQLite (a deploy does not reset it).
  for (let i = 0; i < 18; i++) {
    const id = (i + 16).toString(16).padStart(2, '0').repeat(32);
    h.ctx.db.prepare('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(id, node.nodeId, clock, 'unrated', null, '{}');
    h.ctx.db.prepare('INSERT INTO node_match_players (match_id, slot, player_id, name) VALUES (?, 0, ?, ?)').run(id, ANA, 'Ana');
    assert.equal((await report(h, { matchId: id })).status, 200, `report ${i + 3}`);
  }
  const extra = hex64('c');
  h.ctx.db.prepare('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(extra, node.nodeId, clock, 'unrated', null, '{}');
  h.ctx.db.prepare('INSERT INTO node_match_players (match_id, slot, player_id, name) VALUES (?, 0, ?, ?)').run(extra, ANA, 'Ana');
  h = await boot(env, new FakeCtx(db));
  assert.deepEqual([(await report(h, { matchId: extra })).status, (await report(h, { matchId: extra })).json.error], [429, 'too_many_reports']);
  clock += DAY + 1;
  assert.equal((await report(h, { matchId: extra })).status, 200, 'a new day');
  // The host's purge: its reports stay their 30 days under its opaque key. The reporter's: its reports go at once.
  const gone = await community(h, { host: 'j9.example.org', name: 'juan-9' });
  gone.ws.close(1000, 'bye');
  await h.obj.webSocketClose(gone.ws, 1000, 'bye', true);
  assert.equal((await own(h, 'retire', { nodeId: gone.node.nodeId })).status, 200, 'retired before the purge: the purge leaves it as it is');
  const seat = (matchId, nodeId) => {
    h.ctx.db.prepare('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(matchId, nodeId, clock, 'unrated', null, '{}');
    h.ctx.db.prepare('INSERT INTO node_match_players (match_id, slot, player_id, name) VALUES (?, 0, ?, ?)').run(matchId, EVA, 'Eva');
  };
  seat(hex64('5'), node.nodeId);
  seat(hex64('6'), gone.node.nodeId);
  const before = rows(h, 'node_reports').length;
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: JUAN } })).status, 200);
  const after = rows(h, 'node_reports');
  assert.equal(after.length, before);
  assert.ok(after.every((r) => /^deleted:[0-9a-f]{12}$/.test(r.operator_id)), 'no host id left in them');
  // A seat in a match before the purge still proves it, but a report then would write the purged
  // id again: refused. Its banned server by the purge's ban, its retired one by node_forgotten, and
  // the ban alone once node_forgotten's row is gone (a match held at the purge settles after it).
  for (const m of ['5', '6']) assert.deepEqual([(await report(h, { matchId: hex64(m) }, EVA)).json.error, rows(h, 'node_reports').length], ['host_deleted', before], m);
  h.ctx.db.prepare('DELETE FROM node_forgotten').run();
  assert.equal((await report(h, { matchId: hex64('5') }, EVA)).json.error, 'host_deleted');
  assert.ok(!rows(h, 'node_reports').some((r) => r.operator_id === JUAN), 'its id never came back');
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: ANA } })).status, 200);
  assert.deepEqual(rows(h, 'node_reports').map((r) => r.reporter_id), [EVA, EVA], "Ana's gone, Eva's kept");
  // 30 days: the cron's prune, and the start's.
  clock += REPORT_DAYS * DAY;
  assert.equal((await call(h, 'POST', '/internal/prune')).status, 200);
  assert.deepEqual(rows(h, 'node_reports'), []);
  h.ctx.db.prepare("INSERT INTO node_reports (match_id, reporter_id, at, node_id, operator_id, reason) VALUES (?, ?, ?, ?, ?, 'lag')").run(hex64('d'), EVA, clock - (REPORT_DAYS * DAY + 1), node.nodeId, 'x');
  await boot(env, new FakeCtx(db));
  assert.deepEqual(rows(h, 'node_reports'), [], 'pruned at the start too');
});

// ---- the Worker: the routes, the preference through the hub -------------------------------------------

/** NODES whose one object records each forwarded request and answers `answer(path)` (200 { ok: true } by default). */
function nodesNs(answer = () => ({ ok: true })) {
  const seen = [];
  return {
    seen,
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (url, init) => {
        const req = url instanceof Request ? url : new Request(url, init);
        const path = new URL(req.url).pathname;
        seen.push({ path, headers: Object.fromEntries(req.headers), body: await req.text() });
        return new RealResponse(JSON.stringify(answer(path)), { headers: { 'content-type': 'application/json' } });
      },
    }),
  };
}
const ORIGIN = 'https://turbo-gol.com';
const notOurs = () => {
  throw new Error('not an id of this namespace');
};
const workerEnv = (over = {}) => ({ JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: kvOf(), NODES: nodesNs(), NODE_REPLAYS: bucket(), NODE_RELEASES: bucket(), NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey, NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey, NODE_TRUSTED_OPERATORS: PROJECT, NODES_PUBLIC_BASE: ORIGIN, MATCH: { idFromString: notOurs }, ROOM: { idFromString: notOurs }, ...over });
let ip = 0;
const wreq = async (env, method, path, { body, token } = {}) => {
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'CF-Connecting-IP': `198.18.1.${++ip % 250}`, Origin: ORIGIN, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const s = () => Math.floor(Date.now() / 1000);
const session = (sub, extra = {}) => signJwt(SECRET, { sub, name: 'Juan', iat: s(), exp: s() + 3600, acct: 1, aat: s(), aal: 2, since: s() - 30 * 86_400, ...extra });

test("the Worker: the owner's actions never from a TV, 10 a minute; a report from any account's session, 403 hosting_closed before the object while the terms do not describe hosting (no KV read), never by the flag after, 10 a minute; /nodes/mine passes the session's since; the rejoin's mark goes on", async () => {
  realWorld();
  const closed = workerEnv({ TERMS_VERSION: '2026-11-05', FLAGS: kvOf({ node_operators: '1' }) });
  const juan = await session(JUAN);
  const r = await wreq(closed, 'POST', '/nodes/report', { body: { matchId: hex64('a'), reason: 'lag' }, token: juan });
  assert.deepEqual([r.status, r.json.error, closed.NODES.seen, closed.FLAGS.reads], [403, 'hosting_closed', [], []], 'the object never asked, KV not even read');
  assert.equal((await wreq(closed, 'POST', '/nodes/report', { body: {}, token: await session(JUAN, { acct: 0 }) })).json.error, 'account_required');
  const env = workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: '1' }) });
  assert.equal((await wreq(env, 'POST', '/nodes/report', { body: { matchId: hex64('a'), reason: 'lag' }, token: await session(JUAN, { tv: 1 }) })).status, 200, "a TV's session reports: its player played there");
  assert.deepEqual([env.NODES.seen.at(-1).path, env.NODES.seen.at(-1).headers['x-operator-id']], ['/nodes/report', JUAN]);
  for (let i = 1; i < 10; i++) await wreq(env, 'POST', '/nodes/report', { body: {}, token: juan });
  assert.equal((await wreq(env, 'POST', '/nodes/report', { body: {}, token: juan })).status, 429);
  // From the terms on the flag never stops a report: closed again, absent, or a failed read (the object decides).
  for (const [what, FLAGS] of [['0', kvOf({ node_operators: '0' })], ['absent', kvOf()], ['a failed read', { get: async () => { throw new Error('KV down'); } }]]) {
    const e = workerEnv({ ...IN_FORCE, FLAGS });
    const rr = await wreq(e, 'POST', '/nodes/report', { body: { matchId: hex64('a'), reason: 'lag' }, token: await session(EVA) });
    assert.deepEqual([rr.status, e.NODES.seen.map((x) => x.path)], [200, ['/nodes/report']], what);
  }
  // The owner's actions: an account, never a TV; one limit for the four.
  for (const path of ['/nodes/mine/drain', '/nodes/mine/rename', '/nodes/mine/retire', '/nodes/tokens/revoke']) {
    assert.equal((await wreq(env, 'POST', path, { body: {}, token: await session(ANA, { tv: 1 }) })).json.error, 'tv_session', path);
    assert.equal((await wreq(env, 'POST', path, { body: {} })).status, 401, path);
  }
  const ana = await session(ANA);
  const paths = ['/nodes/mine/drain', '/nodes/mine/rename', '/nodes/mine/retire', '/nodes/tokens/revoke'];
  for (let i = 0; i < 10; i++) assert.equal((await wreq(env, 'POST', paths[i % 4], { body: {}, token: ana })).status, 200);
  assert.equal((await wreq(env, 'POST', '/nodes/mine/drain', { body: {}, token: ana })).status, 429);
  assert.deepEqual(env.NODES.seen.filter((x) => x.headers['x-operator-id'] === ANA).map((x) => x.path).slice(0, 4), paths);
  // GET /nodes/mine: the session's since goes on.
  // (A since of its own: the session's clock and this line's could fall on two sides of a second.)
  const since = s() - 30 * 86_400;
  await wreq(env, 'GET', '/nodes/mine', { token: await session(JUAN, { since }) });
  assert.equal(env.NODES.seen.at(-1).headers['x-operator-since'], String(since));
  // A node match's rejoin: the object's mark on the answer; none from it, none here.
  const mark = workerEnv({ NODES: nodesNs((path) => (path === '/internal/rejoin' ? { ticket: 't', wsUrl: 'wss://n.example.org/m/x', server: { name: 'casa-juan', community: true } } : { ok: true })) });
  const rj = await wreq(mark, 'POST', '/api/rejoin', { body: { matchId: hex64('f') }, token: juan });
  assert.deepEqual([rj.status, rj.json.node, rj.json.server], [200, true, { name: 'casa-juan', community: true }]);
  const plain = workerEnv({ NODES: nodesNs((path) => (path === '/internal/rejoin' ? { ticket: 't', wsUrl: 'wss://n.example.org/m/x' } : { ok: true })) });
  assert.equal('server' in (await wreq(plain, 'POST', '/api/rejoin', { body: { matchId: hex64('f') }, token: juan })).json, false);
});

test("the Worker: POST /nodes/mine/accept takes the first code's steps: closed while the terms do not describe hosting (the object never asked, no KV read), never a TV's session, a canary it is not in, fresh as a maintainer's; the session's since goes on; 10 a minute", async () => {
  realWorld();
  const body = { acceptHost: true, adult: true };
  const closed = workerEnv({ TERMS_VERSION: '2026-11-05', FLAGS: kvOf({ node_operators: '1' }) });
  const r = await wreq(closed, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN) });
  assert.deepEqual([r.status, r.json.error, closed.NODES.seen, closed.FLAGS.reads], [403, 'hosting_closed', [], []], 'the object never asked, KV not even read');
  const env = workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: JUAN }) });
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body })).status, 401);
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN, { tv: 1 }) })).json.error, 'tv_session');
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(ANA) })).json.error, 'hosting_closed', 'not in the canary');
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN, { aat: s() - 16 * 60 }) })).json.error, 'reauth_required', 'its password or a mailed code in the last 15 minutes, as for a code');
  assert.deepEqual(env.NODES.seen, []);
  const since = s() - 30 * 86_400;
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN, { since }) })).status, 200);
  const [seen] = env.NODES.seen;
  assert.deepEqual([seen.path, seen.headers['x-operator-id'], seen.headers['x-operator-since'], JSON.parse(seen.body)], ['/nodes/mine/accept', JUAN, String(since), body]);
  for (let i = 1; i < 10; i++) await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN) });
  assert.equal((await wreq(env, 'POST', '/nodes/mine/accept', { body, token: await session(JUAN) })).status, 429);
});

test('the preference through the Worker and the hub: closed, POST /api/queue with projectOnly is as without it (nothing kept, no KV read); from the terms on never dropped by the flag (absent, 0, a failed read); one human with it takes the whole group to the project’s nodes; none free: a MatchDO, with a back-off of its own; do_disabled: it waits, its region’s and then SA’s project nodes only; never kept in a dropped search', async () => {
  realWorld();
  const A = '1111222233334444';
  const B = '5555666677778888';
  const queue = async (w, id, extra = {}) => w.queue(await accountToken(id), { api: 2, mode: '2v2', kind: 'server', region: 'SA', first: true, ...extra });
  // Closed (the terms of today): the hub never hears of it, the placement neither.
  const dark = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1' }, nodes: true });
  const reads = [];
  const get = dark.env.FLAGS.get;
  dark.env.FLAGS.get = async (k) => (reads.push(k), get(k));
  // The Worker's guard on its own: the /join body it sends the hub (the hub's own guard would drop it too).
  const joins = [];
  const mm = dark.env.MATCHMAKER.get;
  dark.env.MATCHMAKER.get = (name) => ({
    fetch: async (url, init) => {
      const req = url instanceof Request ? url : new Request(url, init);
      if (new URL(req.url).pathname === '/join') joins.push(JSON.parse(await req.clone().text()));
      return mm(name).fetch(req);
    },
  });
  await queue(dark, A, { projectOnly: true });
  assert.deepEqual([joins.length, 'projectOnly' in joins[0]], [1, false], 'the Worker sends the hub none');
  assert.equal(dark.hub().casual.find((x) => x.playerId === A).projectOnly, undefined, 'the hub keeps nothing of it');
  const r = await queue(dark, B);
  assert.equal(r.json.status, 'matched', JSON.stringify(r.json));
  const [p0] = dark.control.of('/internal/place');
  assert.equal('projectOnly' in p0.body, false, 'not passed on');
  assert.ok(!reads.includes('node_operators'), 'not even read');
  assert.equal('server' in r.json, false, 'and no mark from the object: none came');
  // A community node of the region: it takes any match but a project-only one, which nothing takes here.
  const onCommunity = (body) => (body.projectOnly ? { placement: null, hosts: 0 } : { placement: { matchId: hex64('8'), nodeId: 'node-2', nodeName: 'casa-juan', trusted: false, transport: 'wss', wsUrl: `wss://j.example.org/m/${hex64('8')}`, tickets: body.humans.map((y, i) => ({ playerId: y.playerId, slot: i, team: i % 2, ticket: 't.' + y.playerId })) }, hosts: 1, server: { name: 'casa-juan', community: true } });
  // From the terms on, the KV flag never drops it, never fails open: the flag absent, closed again
  // ('0') while community servers still host, or a failed read (flagValue's null). Each of the
  // search's POSTs keeps it on the waiter, and its group never goes to the community node.
  for (const [what, flags, broken] of [['absent', { nodes_on: '1' }, false], ['0', { nodes_on: '1', node_operators: '0' }, false], ['a failed read', { nodes_on: '1', node_operators: '1' }, true]]) {
    const t = await makeHubWorld({ flags, nodes: true });
    Object.assign(t.env, IN_FORCE);
    const kv = t.env.FLAGS.get;
    if (broken) t.env.FLAGS.get = async (k) => (k === 'node_operators' ? Promise.reject(new Error('KV down')) : kv(k));
    t.control.place = onCommunity;
    await queue(t, A, { projectOnly: true });
    await queue(t, A, { projectOnly: true });
    assert.equal(t.hub().casual.find((x) => x.playerId === A).projectOnly, true, `kept on every POST: ${what}`);
    const tb = await queue(t, B);
    assert.deepEqual([tb.json.status, tb.json.node, t.created().length], ['matched', undefined, 1], `a MatchDO, never the community node: ${what}`);
    assert.deepEqual(t.control.of('/internal/place').map((c) => c.body.projectOnly), [true], what);
  }
  // The hub's guard on its own: a join that carries it while the terms do not describe hosting is read as none.
  const hub = await makeHubWorld({ flags: { nodes_on: '1' }, nodes: true });
  assert.equal((await hub.join(A, { extra: { projectOnly: true } })).json.status, 'waiting');
  assert.equal(hub.hub().casual.find((x) => x.playerId === A).projectOnly, undefined);
  Object.assign(hub.env, IN_FORCE);
  await hub.join(A, { extra: { projectOnly: true } });
  assert.equal(hub.hub().casual.find((x) => x.playerId === A).projectOnly, true, 'kept once the terms describe hosting (the Worker’s guard is the same)');
  // Open: the hub keeps it while the player searches (memory) and the whole group asks for the project's nodes.
  const w = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1' }, nodes: true });
  Object.assign(w.env, IN_FORCE);
  const mark = { name: 'sao-paulo-1', community: false };
  w.control.place = (body) => ({ placement: { matchId: hex64('9'), nodeId: 'node-1', nodeName: 'sao-paulo-1', trusted: true, transport: 'wss', wsUrl: `wss://sp1.turbo-gol.com/m/${hex64('9')}`, tickets: body.humans.map((x, i) => ({ playerId: x.playerId, slot: i, team: i % 2, ticket: 't.' + x.playerId })) }, hosts: 1, server: mark });
  const wa = await queue(w, A, { projectOnly: true, visible: true });
  assert.equal(wa.json.status, 'waiting');
  assert.equal(w.hub().casual.find((x) => x.playerId === A).projectOnly, true);
  assert.ok(![...w.storage().map.values()].some((v) => JSON.stringify(v).includes('projectOnly')), 'never in storage');
  const wb = await queue(w, B);
  assert.deepEqual([wb.json.status, wb.json.server], ['matched', mark], 'the object’s mark on the answer');
  assert.deepEqual(w.control.of('/internal/place').map((c) => c.body.projectOnly), [true], 'the group asked for the project’s only');
  // The one who asked need not be the first of the group: any of its humans takes it there.
  const F1 = 'ffff111122223333';
  const F2 = 'ffff444455556666';
  await queue(w, F1);
  assert.equal((await queue(w, F2, { projectOnly: true })).json.status, 'matched');
  assert.deepEqual(w.control.of('/internal/place').map((c) => c.body.projectOnly), [true, true]);
  // A change of the setting updates the waiter in place; a search dropped keeps nothing of it.
  const C = '9999aaaabbbbcccc';
  await queue(w, C, { projectOnly: true });
  await queue(w, C);
  assert.equal(w.hub().casual.find((x) => x.playerId === C).projectOnly, undefined);
  await queue(w, C, { projectOnly: true });
  w.advance(60_000);
  await w.hub().sweep();
  assert.ok(w.hub().recent.has(C) && !JSON.stringify([...w.hub().recent.values()]).includes('projectOnly'), 'the dropped search: its clock only');
  // No project node free: a MatchDO, and the region's project nodes back off on their own key.
  const x = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1' }, nodes: true });
  Object.assign(x.env, IN_FORCE);
  x.control.place = onCommunity;
  await queue(x, A, { projectOnly: true });
  const xb = await queue(x, B);
  assert.deepEqual([xb.json.status, xb.json.node, x.created().length], ['matched', undefined, 1], 'a MatchDO, never the community node');
  assert.deepEqual([x.hub().noHostsUntil.has('SA:project'), x.hub().noHostsUntil.has('SA')], [true, false]);
  const D1 = 'dddd111122223333';
  const D2 = 'dddd444455556666';
  await queue(x, D1);
  const xd = await queue(x, D2);
  assert.deepEqual([xd.json.node, xd.json.server], [true, { name: 'casa-juan', community: true }], 'everyone else still gets the region’s community node, marked');
  const E1 = 'eeee111122223333';
  const E2 = 'eeee444455556666';
  const asked = x.control.of('/internal/place').length;
  await queue(x, E1, { projectOnly: true });
  await queue(x, E2);
  assert.deepEqual([x.control.of('/internal/place').length, x.created().length], [asked, 2], 'in its back-off: a MatchDO without asking');
  // do_disabled: the group waits for a project node, never a MatchDO and never the community's.
  const y = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1', do_disabled: '1' }, nodes: true });
  Object.assign(y.env, IN_FORCE);
  y.control.place = (body) => (body.projectOnly ? { placement: null, hosts: 1 } : onCommunity(body));
  await queue(y, A, { projectOnly: true });
  const yb = await queue(y, B);
  assert.deepEqual([yb.json.status, y.created().length], ['waiting', 0]);
  assert.ok(y.control.of('/internal/place').every((c) => c.body.projectOnly === true));
  // do_disabled, a group hosted outside SA: its own region's project nodes (none), then SA's, never
  // SA's community node and never a MatchDO (formMatch's second ask keeps the preference).
  const eu = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1', do_disabled: '1' }, nodes: true });
  Object.assign(eu.env, IN_FORCE);
  eu.control.place = (body) => (body.region === 'EU' ? { placement: null, hosts: 0 } : onCommunity(body));
  await queue(eu, A, { projectOnly: true, region: 'EU' });
  const eb = await queue(eu, B, { region: 'EU' });
  assert.deepEqual([eb.json.status, eb.json.node, eu.created().length], ['waiting', undefined, 0], 'it waits');
  assert.deepEqual(eu.control.of('/internal/place').map((c) => [c.body.region, c.body.projectOnly]), [['EU', true], ['SA', true]], 'SA asked for its project nodes only');
  assert.deepEqual(eu.hub().casual.filter((x) => x.playerId === A || x.playerId === B).length, 2, 'both still searching');
  // Ranked too: the pair's placement asks for the project's only.
  const k = await makeHubWorld({ flags: { nodes_on: '1', node_operators: '1' }, nodes: true });
  Object.assign(k.env, IN_FORCE);
  await k.queue(await accountToken(A), { api: 2, mode: '1v1', kind: 'ranked', region: 'SA', first: true, projectOnly: true });
  await k.queue(await accountToken(B), { api: 2, mode: '1v1', kind: 'ranked', region: 'SA', first: true });
  assert.deepEqual(k.control.of('/internal/place').map((c) => [c.body.ranked, c.body.projectOnly]), [[true, true]]);
});
