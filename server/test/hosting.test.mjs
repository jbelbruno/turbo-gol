// Hosting by the community, deployed dark (Prompt 2, PR 1): the opening's policy and its guard, and
// what an account outside the project meets to host. The NodeRegistryDO on fakes as
// nodeRegistry.test.mjs runs it (node:sqlite, fake sockets, a fake ACCOUNTS that answers GET /me and
// records /host-consent and /host-freeze, a KV that records its writes, fake webhooks for the team's
// and the community nodes' staff-only channels); the Worker in front of a recording NODES
// (nodeRoutes.test.mjs's way) for its gate, the register's continent and GET /api/config; and a
// real AccountsDO on node:sqlite for the 'host' consents row. Nothing leaves this machine. Run from
// server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = () => { throw new Error("no wasm in this test"); };';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    if (specifier === './wasm' && context.parentURL !== undefined && context.parentURL.endsWith('/server/src/MatchDO.ts')) return { url: WASM_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

// The control plane's timers must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const D = await import('../src/NodeRegistryDO.ts');
const ENV = await import('../src/env.ts');
const P = await import('../src/hostPolicy.ts');
const { CLIENT_BUILD } = await import('../src/nodeApi.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { INTERNAL_HEADER, internalSecret, signJwt } = await import('../src/auth.ts');
const { generateEd25519, importPrivateKey, sign } = await import('../../nodes/shared/edcrypto.ts');
const { authMessage, reachMessage } = await import('../../nodes/shared/controlProtocol.ts');
const { makeAccount } = await import('./helpers/accounts.mjs');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'hosting-test-secret';
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
Date.now = () => clock;
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
const BASE = 'https://turbo-gol.test';
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' };
const NODE_BUILD = { ...CLIENT_BUILD, version: '0.2.0' };
const CONTROL = await generateEd25519();
const secret = await internalSecret(SECRET);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
async function waitFor(fn, what) {
  for (let i = 0; i < 200 && !(await fn()); i++) await sleep(2);
  assert.ok(await fn(), what);
}
/** (b) in force: the version and its hosting minimum. */
const IN_FORCE = { TERMS_VERSION: '2026-11-16', NODE_HOSTING_TERMS: '2026-11-16' };
const ADMIN = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
const ACTOR = 'admin Proyecto Señor (a1b2c3d4e5f60718)';

// ---- fakes (nodeRegistry.test.mjs's) -------------------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    this.sent.push(JSON.parse(text));
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

/** A KV namespace that records its reads and writes. */
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

/** Accounts as AccountsDO's GET /me answers them, and the calls the object made. */
const person = (over = {}) => ({ createdAt: clock - 30 * DAY, emailVerified: true, terms: IN_FORCE.TERMS_VERSION, deletionAt: 0, ...over });
function accountsNs(people = new Map()) {
  const ns = {
    people,
    calls: [],
    /** When set, /host-consent answers this (status, body). */
    consent: null,
    /** Milliseconds each answer takes (a real AccountsDO is another object: its answer comes on a later turn). */
    delay: 0,
    idFromName: (n) => ({ n }),
    get: () => ({
      fetch: async (url, init) => {
        const u = new URL(url);
        const body = init?.body ? JSON.parse(init.body) : null;
        ns.calls.push({ path: u.pathname, body });
        if (ns.delay > 0) await sleep(ns.delay);
        const out = (b, status = 200) => new RealResponse(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/me') {
          const p = people.get(u.searchParams.get('userId'));
          return p ? out(p) : out({ error: 'no_user' }, 404);
        }
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
const postedTo = (url) => posts.filter((p) => p.url === url).map((p) => p.content);
const hosts = new Map();
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === HOOK || String(url) === CHOOK) {
    posts.push({ url: String(url), content: JSON.parse(init.body).content });
    return new RealResponse(null, { status: 204 });
  }
  const u = new URL(String(url));
  const h = hosts.get(u.host);
  if (u.pathname !== '/healthz' || !h) throw new Error('BLOCKED network call in a test: ' + url);
  return new RealResponse(JSON.stringify({ ok: true, nodeId: h.nodeId, draining: false, sig: await sign(h.key, reachMessage(h.nodeId, u.searchParams.get('nonce'))) }));
};

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
    ACCOUNTS: accountsNs(new Map([[JUAN, person()], [ANA, person()]])),
    MATCHMAKER: accountsNs(),
    ...over,
  };
}

/** The object hosting is open in for JUAN (a canary of one) unless `over` says otherwise. */
const openEnv = (over = {}) => makeEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: JUAN }), ...over });

async function boot(env, ctx = new FakeCtx()) {
  const obj = new D.NodeRegistryDO(ctx, env);
  obj.alertSleep = () => Promise.resolve();
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
/** A token for `op` (JUAN by default): a community account's ask, with its host and the two boxes unless `body` says otherwise. */
const ask = (h, body = {}, op = JUAN) =>
  call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', publicHost: 'juan.example.org', acceptHost: true, adult: true, ...body }, headers: { 'x-operator-id': op, 'x-operator-name': encodeURIComponent('Juan') } });
const projectToken = (h, body = {}) => call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', ...body }, headers: ADMIN });

let installs = 0;
/** Register with `token` on `publicUrl`, seen from `continent` (null: no header at all), from an address of its own (5 an hour each). */
async function register(h, token, { publicUrl = 'wss://juan.example.org', continent = 'SA', extra = {} } = {}) {
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', {
    body: { token, publicKey: keys.publicKey, roles: ['host'], publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP, ...extra },
    headers: { 'x-client-ip': '198.51.100.' + (++installs % 250), ...(continent !== null ? { 'x-client-continent': continent } : {}) },
  });
  if (r.status !== 200) return r;
  const node = { ...r.json, key: await importPrivateKey(keys.privateKey), publicUrl };
  if (publicUrl) hosts.set(new URL(publicUrl).host, node);
  return { ...r, node };
}

/**
 * `op` holds the rules for hosts in force, as its first code leaves it (hostGate's writeHostRules):
 * AccountsDO's 'host' row (GET /me's hostTerms) and the object's copy (host_rules), which placement reads.
 */
function holdRules(h, op = JUAN) {
  const v = P.hostRulesVersion(h.env);
  const p = h.env.ACCOUNTS.people.get(op);
  if (p) p.hostTerms = v;
  h.obj.noteHostRules(op, v);
}

/**
 * A community node registered (a token the registry mints, as nodeRegistry.test.mjs's communityNode),
 * logged in and on probation; its operator holds the rules for hosts as its first code left them
 * (`rules` false: it never accepted any).
 */
async function liveCommunity(h, { op = JUAN, host = 'juan.example.org', name, rules = true } = {}) {
  if (rules) holdRules(h, op);
  const { token } = await h.obj.cp.registry.createToken({ id: op, name: 'Juan' }, 'SA', clock, name, { publicHost: host });
  const r = await register(h, token, { publicUrl: `wss://${host}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ws = await logIn(h, r.node);
  await waitFor(() => h.obj.cp.registry.node(r.node.nodeId).status === 'probation', 'probation');
  return { node: r.node, ws };
}

async function logIn(h, node) {
  await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  const ws = h.ctx.sockets.at(-1);
  const challenge = ws.of('challenge')[0];
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, challenge.nonce)) }));
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'hello', data: { bootId: 'boot-1', build: NODE_BUILD, roles: ['host'], transports: ['wss'], publicUrl: node.publicUrl, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null } }));
  return ws;
}
const beat = (over = {}) => ({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...over } });

// ---- the guard: closed whatever the flag says, until the terms describe hosting -----------------

test('terms versions in order; hosting in force only from NODE_HOSTING_TERMS on, and never while either is unset', () => {
  const order = ['2026-11-04-2', '2026-11-05', '2026-11-05-2', '2026-11-16', '2026-12-01', '2027-01-01'];
  for (let i = 0; i + 1 < order.length; i++) assert.equal(ENV.compareTermsVersions(order[i], order[i + 1]), -1, order[i]);
  assert.equal(ENV.compareTermsVersions('2026-11-16', '2026-11-16'), 0);
  const inForce = (TERMS_VERSION, NODE_HOSTING_TERMS) => ENV.hostingTermsInForce({ TERMS_VERSION, NODE_HOSTING_TERMS });
  assert.equal(inForce('2026-11-05', undefined), false, 'unset: closed (wrangler.jsonc today)');
  assert.equal(inForce('2026-11-05', '2026-11-16'), false, 'version (a) under (b)');
  assert.equal(inForce('2026-11-16', '2026-11-16'), true);
  assert.equal(inForce('2026-12-01', '2026-11-16'), true, 'a later version keeps it');
  assert.equal(inForce(undefined, '2026-11-16'), false);
  assert.equal(inForce('2026-11-16', 'NOT A VERSION'), false, 'malformed: closed');
  // The flag as nodes_on is read, but for the opening; a value the panel writes is stricter.
  assert.equal(ENV.hostingModeOf(null), 'closed');
  assert.equal(ENV.hostingModeOf('0'), 'closed');
  assert.equal(ENV.hostingModeOf('junk'), 'closed');
  assert.equal(ENV.hostingModeOf(' 1 '), 'all');
  assert.deepEqual([...ENV.hostingModeOf(`${JUAN}, nope`)], [JUAN]);
  assert.equal(ENV.hostingFlagValue(` ${JUAN},${ANA},${JUAN} `), `${JUAN},${ANA}`);
  for (const bad of ['', 'yes', `${JUAN},nope`, 1, null, Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(16, '0')).join(',')]) assert.equal(ENV.hostingFlagValue(bad), null, String(bad).slice(0, 40));
  assert.equal(P.hostingWords(`${JUAN},${ANA}`), 'open to a canary of 2 accounts');
  assert.equal(ENV.communityPointsPerDay({}), 300, "the owner's default");
  assert.deepEqual([ENV.communityPointsPerDay({ NODE_COMMUNITY_POINTS_PER_DAY: '150' }), ENV.communityPointsPerDay({ NODE_COMMUNITY_POINTS_PER_DAY: '0' }), ENV.communityPointsPerDay({ NODE_COMMUNITY_POINTS_PER_DAY: 'x' })], [150, 300, 300]);
  assert.deepEqual([ENV.communityRanked({}), ENV.communityRanked({ NODE_COMMUNITY_RANKED: '1' })], [false, true]);
});

test('the rules for hosts in force (hostPolicy.ts, Terms 12.2): the TERMS_VERSION in force once the terms describe hosting, moving with it, never the flag; none before; where each operator accepts them', () => {
  assert.equal(P.hostRulesVersion({ TERMS_VERSION: '2026-11-05' }), null, 'NODE_HOSTING_TERMS unset');
  assert.equal(P.hostRulesVersion({ TERMS_VERSION: '2026-11-05', NODE_HOSTING_TERMS: '2026-11-16' }), null, 'older than its minimum');
  assert.equal(P.hostRulesVersion(IN_FORCE), '2026-11-16');
  assert.equal(P.hostRulesVersion({ ...IN_FORCE, TERMS_VERSION: '2026-12-01' }), '2026-12-01', 'a new version: the rules move with it');
  assert.equal(P.hostRulesVersion({ ...IN_FORCE, FLAGS: kvOf({ node_operators: '0' }) }), '2026-11-16', 'the flag closed again changes nothing');
  assert.deepEqual(
    [P.hostRulesHeld('2026-11-16', '2026-11-16'), P.hostRulesHeld('2026-11-16', '2026-12-01'), P.hostRulesHeld(null, '2026-11-16'), P.hostRulesHeld(null, null), P.hostRulesHeld('2026-11-05', null)],
    [true, false, false, false, false],
  );
  assert.equal(P.hostRulesStep('2026-12-01', '2026-12-01', 2), 'held');
  assert.equal(P.hostRulesStep(null, '2026-12-01', 0), 'first', 'never accepted, no server: with its first code');
  assert.equal(P.hostRulesStep('2026-11-16', '2026-12-01', 0), 'again', 'an earlier version: again, with no server left too');
  assert.equal(P.hostRulesStep(null, '2026-12-01', 1), 'again', 'a server without any (an account that left the project): again');
});

test('closed while TERMS_VERSION < NODE_HOSTING_TERMS even with node_operators 1: no community token, no AccountsDO call, no consent row, no new row; the project works as before', async () => {
  const dark = [
    ['NODE_HOSTING_TERMS unset', { TERMS_VERSION: '2026-11-05', FLAGS: kvOf({ node_operators: '1' }) }],
    ['TERMS_VERSION older', { TERMS_VERSION: '2026-11-05', NODE_HOSTING_TERMS: '2026-11-16', FLAGS: kvOf({ node_operators: '1' }) }],
    ['the flag absent', { ...IN_FORCE }],
    ['the flag 0', { ...IN_FORCE, FLAGS: kvOf({ node_operators: '0' }) }],
    ['the flag junk', { ...IN_FORCE, FLAGS: kvOf({ node_operators: 'everyone' }) }],
  ];
  for (const [why, over] of dark) {
    const h = await boot(makeEnv(over));
    const r = await ask(h);
    assert.deepEqual([r.status, r.json.error], [403, 'hosting_closed'], why);
    const pub = await call(h, 'POST', '/nodes/mine/public', { body: { show: true }, headers: { 'x-operator-id': JUAN } });
    assert.deepEqual([pub.status, pub.json.error], [403, 'hosting_closed'], why);
    assert.equal((await call(h, 'POST', '/nodes/mine/public', { body: { show: false }, headers: { 'x-operator-id': JUAN } })).status, 200, 'withdrawing is always taken');
    const again = await call(h, 'POST', '/nodes/mine/accept', { body: { acceptHost: true, adult: true }, headers: { 'x-operator-id': JUAN } });
    assert.deepEqual([again.status, again.json.error], [403, 'hosting_closed'], `${why}: no acceptance in Mis servidores either`);
    assert.deepEqual(h.env.ACCOUNTS.calls, [], `${why}: AccountsDO never asked, no consent row`);
    assert.deepEqual([rows(h, 'operator_tokens'), rows(h, 'operators'), rows(h, 'admin_audit'), rows(h, 'node_tokens'), rows(h, 'host_rules')], [[], [], [], [], []], why);
    assert.equal(h.obj.cp.registry.tokenList().length, 0, why);
    const t = await projectToken(h, { name: 'sao-paulo-1' });
    assert.equal(t.status, 200, `${why}: the project's token`);
  }
  // With the terms in force, the canary's account passes and another one does not.
  const h = await boot(openEnv());
  assert.equal((await ask(h)).status, 200);
  assert.deepEqual([(await ask(h, {}, ANA)).json.error], ['hosting_closed']);
  const all = await boot(openEnv({ FLAGS: kvOf({ node_operators: '1' }) }));
  assert.equal((await ask(all, {}, ANA)).status, 200);
});

// ---- the gate of an account outside the project --------------------------------------------------

test('requirements in order (email, deletion, age, terms), each before any token; then the rules for hosts and the 18-or-older declaration, written once with the token', async () => {
  const h = await boot(openEnv());
  const p = h.env.ACCOUNTS.people;
  const refused = async (code, extra = {}, headers = {}) => {
    h.obj.hostAccounts.clear(); // its minute's cache
    const r = await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', publicHost: 'juan.example.org', ...extra }, headers: { 'x-operator-id': JUAN, 'x-operator-name': 'Juan', ...headers } });
    assert.deepEqual([r.status, r.json.error], [403, code], JSON.stringify(r.json));
    return r.json;
  };
  p.set(JUAN, person({ emailVerified: false, deletionAt: clock + DAY, createdAt: clock - DAY, terms: '2026-11-05' }));
  await refused('email_required');
  p.set(JUAN, person({ deletionAt: clock + DAY, createdAt: clock - DAY, terms: '2026-11-05' }));
  await refused('deletion_pending');
  p.set(JUAN, person({ createdAt: clock - 2 * DAY, terms: '2026-11-05' }));
  assert.equal((await refused('account_too_new')).daysLeft, 5);
  p.set(JUAN, person({ terms: '2026-11-05' }));
  assert.equal((await refused('account_too_new', {}, { 'x-operator-since': String(Math.floor((clock - 3 * DAY) / 1000)) })).daysLeft, 4, "the session's since, the younger of the two");
  p.set(JUAN, person({ createdAt: 0, terms: '2026-11-05' }));
  assert.equal((await refused('account_too_new')).daysLeft, 7, 'no age known at all');
  p.set(JUAN, person({ terms: '2026-11-05' }));
  assert.equal((await refused('terms_required')).version, IN_FORCE.TERMS_VERSION, 'the terms in force not accepted');
  p.set(JUAN, person());
  assert.equal((await refused('terms_required')).version, IN_FORCE.TERMS_VERSION, 'the rules for hosts: no acceptHost');
  await refused('adult_required', { acceptHost: true });
  await refused('adult_required', { acceptHost: true, adult: 'yes' });
  assert.deepEqual(h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-consent'), [], 'never a row without both');
  assert.equal(h.obj.cp.registry.tokenList().length, 0);
  const t = await ask(h);
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.deepEqual(h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-consent').map((c) => c.body), [{ userId: JUAN, version: IN_FORCE.TERMS_VERSION, adult: true }]);
  assert.match(t.json.install.linux, / --transport wss --public-host juan\.example\.org$/);
  // Its acceptance holds for the version: the next token asks for nothing again.
  const again = await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', publicHost: 'juan.example.org' }, headers: { 'x-operator-id': JUAN } });
  assert.equal(again.status, 200);
  assert.equal(h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-consent').length, 1);
  assert.equal(h.obj.cp.registry.tokenList().at(-1).operatorName, 'Anfitrión', "a token without the session's name is never the start of its id");
  // AccountsDO's refusals of the row are the token's: nothing minted.
  const h2 = await boot(openEnv());
  h2.env.ACCOUNTS.consent = { status: 409, body: { error: 'terms_changed', version: '2026-12-01' } };
  assert.deepEqual([(await ask(h2)).status, (await ask(h2)).json.error], [403, 'terms_required']);
  h2.env.ACCOUNTS.consent = { status: 500, body: { error: 'internal' } };
  assert.equal((await ask(h2)).status, 503);
  assert.equal(h2.obj.cp.registry.tokenList().length, 0);
  // GET /me is read once a minute per account: a change on the account shows within that minute.
  const h3 = await boot(openEnv());
  h3.env.ACCOUNTS.people.set(JUAN, person({ createdAt: clock - DAY }));
  const reads = () => h3.env.ACCOUNTS.calls.filter((c) => c.path === '/me').length;
  const seen = [];
  for (const step of [0, 1_000, 58_000, 2_000]) {
    clock += step;
    assert.equal((await ask(h3)).json.error, 'account_too_new');
    seen.push(reads());
  }
  assert.deepEqual(seen, [1, 1, 1, 2], 'read again past 60 s');
});

test('the caps: 2 unused codes at once, 3 a day counted in SQLite through a deploy, 3 servers; a code of its own host only, never under turbo-gol.com, never verify, never a taken name', async () => {
  const db = new DatabaseSync(':memory:');
  const env = openEnv({ NODE_ALERT_WEBHOOK: HOOK });
  let h = await boot(env, new FakeCtx(db));
  const ids = [];
  for (let i = 0; i < 2; i++) assert.equal((await ask(h)).status, 200);
  const out = await ask(h);
  assert.deepEqual([out.status, out.json.error], [409, 'too_many_tokens'], 'two unused at once');
  ids.push(...h.obj.cp.registry.tokenList().map((t) => t.hash.slice(0, 12)));
  for (const id of ids) h.obj.cp.registry.revokeToken(id, clock);
  assert.equal((await ask(h)).status, 200, 'the third of the day');
  for (const t of h.obj.cp.registry.tokenList()) h.obj.cp.registry.revokeToken(t.hash.slice(0, 12), clock);
  assert.deepEqual([(await ask(h)).status, (await ask(h)).json.error], [409, 'too_many_tokens']);
  assert.equal(rows(h, 'operator_tokens').length, 3, 'only the minted ones');
  h = await boot(env, new FakeCtx(db));
  assert.equal((await ask(h)).json.error, 'too_many_tokens', 'a deploy does not reset it');
  clock += DAY;
  assert.equal((await ask(h)).status, 200, 'a new day');
  // The cron's prune: a day's counts, and every code an hour past its expiry, also when nobody asks for another.
  clock += DAY + 1;
  assert.equal((await call(h, 'POST', '/internal/prune')).status, 200);
  assert.deepEqual([rows(h, 'operator_tokens'), rows(h, 'node_tokens'), h.obj.cp.registry.tokenList()], [[], [], []]);
  // The token's host.
  for (const [body, code, status] of [
    [{ publicHost: undefined }, 'bad_public_host', 400],
    [{ publicHost: 'srv.turbo-gol.com' }, 'bad_public_host', 400],
    [{ publicHost: '203.0.113.9' }, 'bad_public_host', 400],
    [{ roles: 'host,verify' }, 'verify_reserved', 403],
  ]) {
    const r = await ask(h, body);
    assert.deepEqual([r.status, r.json.error], [status, code], JSON.stringify(body));
  }
  // A name a project node holds is never a community node's, in any case. Each refusal of a first
  // request (no 'host' row yet, acceptHost and adult sent) comes before its acceptance is written.
  const consents = (x) => x.env.ACCOUNTS.calls.filter((k) => k.path === '/host-consent');
  const p = await boot(openEnv());
  const pt = await projectToken(p, { name: 'sao-paulo-1', publicHost: 'sp1.example.org' });
  assert.equal(pt.status, 200);
  const sp = await register(p, pt.json.token, { publicUrl: 'wss://sp1.example.org', continent: '' });
  assert.equal(sp.status, 200, JSON.stringify(sp.json));
  assert.deepEqual([(await ask(p, { name: 'SAO-PAULO-1' })).json.error], ['name_taken']);
  assert.deepEqual(consents(p), [], 'name_taken: nothing written');
  // Its unused codes, and its codes of the day, from before it ever accepted (put straight in the registry and the store).
  const u = await boot(openEnv());
  for (let i = 0; i < 2; i++) await u.obj.cp.registry.createToken({ id: JUAN, name: 'Juan' }, 'SA', clock, undefined, { publicHost: 'juan.example.org' });
  assert.deepEqual([(await ask(u)).json.error, consents(u)], ['too_many_tokens', []], 'two unused: nothing written');
  const d = await boot(openEnv());
  for (let i = 0; i < 3; i++) d.obj.store.tokenMinted(JUAN, clock);
  assert.deepEqual([(await ask(d)).json.error, consents(d)], ['too_many_tokens', []], 'three today: nothing written');
  // At its 3 servers: no code, nothing written, and a line on the community nodes' channel, never the team's.
  const c = await boot(openEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_COMMUNITY_WEBHOOK: CHOOK }));
  for (let i = 0; i < 3; i++) await liveCommunity(c, { host: `j${i}.example.org` });
  posts.length = 0;
  const full = await ask(c);
  assert.deepEqual([full.status, full.json.error, consents(c)], [409, 'too_many_nodes', []]);
  await c.ctx.settle();
  assert.deepEqual(postedTo(HOOK).filter((l) => l.includes('no token')), []);
  assert.deepEqual(postedTo(CHOOK), [`**ALERT** \`community operator Juan (${JUAN}): no token created, it already has its 3 servers\``]);
  assert.ok(rows(c, 'node_alerts').some((r) => r.line.includes('no token created')), "in the panel's ring");
});

test('one token request of a community account at a time: parallel first requests never pass the caps together', async () => {
  const h = await boot(openEnv());
  h.env.ACCOUNTS.delay = 5;
  const all = await Promise.all(Array.from({ length: 8 }, () => ask(h)));
  const minted = all.filter((r) => r.status === 200).length;
  assert.equal(minted, 1, all.map((r) => `${r.status} ${r.json?.error ?? ''}`).join(', '));
  assert.ok(all.every((r) => r.status === 200 || (r.status === 429 && r.json.error === 'rate_limited')));
  // One after the other: the second, then the unused cap.
  assert.equal((await ask(h)).status, 200);
  assert.equal((await ask(h)).json.error, 'too_many_tokens');
  assert.deepEqual([h.obj.cp.registry.tokenList().length, rows(h, 'operator_tokens').length, h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-consent').length], [2, 2, 1]);
});

test("registration of a community node: its token's continent (an unknown one or none too), wss on 443, no WebRTC, each before the token is spent; one line for the team's channel; a project node only marked", async () => {
  const h = await boot(openEnv({ NODE_ALERT_WEBHOOK: HOOK }));
  const t = (await ask(h)).json.token;
  for (const [continent, code] of [['EU', 'region_mismatch'], ['', 'region_mismatch'], [null, 'region_mismatch'], ['AN', 'region_mismatch'], ['T1', 'region_mismatch']]) {
    const r = await register(h, t, { continent });
    assert.deepEqual([r.status, r.json.error], [403, code], String(continent));
  }
  assert.deepEqual([(await register(h, t, { publicUrl: 'wss://juan.example.org:8443' })).json.error], ['bad_public_url']);
  assert.deepEqual([(await register(h, t, { publicUrl: null, extra: { transports: ['rtc'] } })).json.error], ['rtc_not_available']);
  posts.length = 0;
  const ok = await register(h, t);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const n = h.obj.cp.registry.node(ok.node.nodeId);
  assert.deepEqual([n.seenContinent, n.trusted, n.status], ['SA', false, 'pending']);
  assert.equal(JSON.parse(rows(h, 'nodes').find((r) => r.node_id === n.nodeId).data).seenContinent, 'SA', 'written');
  await h.ctx.settle();
  assert.deepEqual(postedTo(HOOK), [`**ALERT** \`community node ${n.name} (${n.nodeId}) registered for Juan (${JUAN}), region SA, host juan.example.org\``]);
  // A project node registered from another continent: registered, and the overview lists it.
  const pt = (await projectToken(h, { name: 'eu-1', publicHost: 'eu1.example.org' })).json.token;
  const eu = await register(h, pt, { publicUrl: 'wss://eu1.example.org', continent: 'EU' });
  assert.equal(eu.status, 200);
  const o = await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN });
  assert.deepEqual(o.json.regionMismatches, [{ nodeId: eu.node.nodeId, name: 'eu-1', region: 'SA', seen: 'EU' }]);
  const v = o.json.nodes.find((x) => x.nodeId === n.nodeId);
  assert.deepEqual([v.capacityEffective, v.seenContinent, v.refusals], [4, 'SA', { recent: 0, of: 0, outUntil: null }]);
});

// ---- blocking an operator -------------------------------------------------------------------------

test('a blocked operator: its sockets closed (4403) and every login refused, no code, no registration, its wallet frozen; unblocked it hosts again; suspend_all; audited with its id and reason', async () => {
  const db = new DatabaseSync(':memory:');
  const env = openEnv({ NODE_ALERT_WEBHOOK: HOOK });
  let h = await boot(env, new FakeCtx(db));
  const { node, ws } = await liveCommunity(h);
  const pending = (await ask(h)).json.token;
  const op = (body) => call(h, 'POST', '/nodes/admin/operator', { body, headers: ADMIN });
  for (const [body, code] of [
    [{ operatorId: 'x', action: 'block', reason: 'r' }, 'bad_account'],
    [{ operatorId: JUAN, action: 'ban', reason: 'r' }, 'bad_action'],
    [{ operatorId: JUAN, action: 'block' }, 'reason_required'],
    [{ operatorId: PROJECT, action: 'block', reason: 'r' }, 'trusted'],
  ])
    assert.equal((await op(body)).json.error, code, JSON.stringify(body));
  assert.equal((await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'block', reason: 'r' }, headers: { 'x-operator-id': JUAN } })).status, 403, 'a maintainer route');
  posts.length = 0;
  const b = await op({ operatorId: JUAN, action: 'block', reason: 'fabricated matches' });
  assert.deepEqual([b.status, b.json.status, b.json.walletFrozen, b.json.nodes], [200, 'blocked', true, 1]);
  assert.deepEqual(ws.closed, { code: 4403, reason: 'operator blocked' });
  assert.deepEqual(h.env.ACCOUNTS.calls.filter((c) => c.path === '/host-freeze').map((c) => c.body), [{ userId: JUAN, reason: 'operator_blocked:fabricated matches', at: clock }]);
  await h.ctx.settle();
  assert.ok(postedTo(HOOK).some((l) => l.includes(`${ACTOR}: operator ${JUAN} blocked (1 node off, wallet frozen): fabricated matches`)), postedTo(HOOK).join('\n'));
  assert.deepEqual([(await ask(h)).json.error], ['operator_blocked']);
  assert.deepEqual([(await register(h, pending)).json.error], ['operator_blocked'], 'its unused code registers nothing');
  // Through a deploy: the block holds, its node's login is refused at its hello.
  h = await boot(env, new FakeCtx(db));
  const again = await logIn(h, node);
  assert.deepEqual(again.closed, { code: 4403, reason: 'operator blocked' });
  const view = await call(h, 'GET', '/nodes/admin/operators', { headers: ADMIN });
  const juan = view.json.operators.find((o) => o.operatorId === JUAN);
  assert.deepEqual([juan.status, juan.reason, juan.nodes.length, juan.points.cap, juan.running.max], ['blocked', 'fabricated matches', 1, 300, 32]);
  // Unblocked: it logs in again; its wallet stays frozen (no unfreeze sent).
  const u = await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'unblock' }, headers: ADMIN });
  assert.equal(u.json.status, 'ok');
  const back = await logIn(h, node);
  assert.equal(back.closed, null);
  assert.ok(!h.env.ACCOUNTS.calls.some((c) => c.path === '/host-unfreeze'));
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'probation', 'probation');
  const s = await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: JUAN, action: 'suspend_all', reason: 'review' }, headers: ADMIN });
  assert.deepEqual([s.json.suspended, h.obj.cp.registry.node(node.nodeId).status], [1, 'suspended']);
});

// ---- the opening's flag: the panel's one KV write ------------------------------------------------

test("POST /nodes/admin/flags: node_operators only, a valid value and a reason; nothing at all while the terms do not describe hosting, 0 too, and no ALERT; audited without the canary's ids; kept a year", async () => {
  const dark = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK }));
  const flags = (h, body, headers = ADMIN) => call(h, 'POST', '/nodes/admin/flags', { body, headers });
  for (const [body, code] of [
    [{ name: 'nodes_on', value: '1', reason: 'x' }, 'bad_flag'],
    [{ name: 'node_operators', value: 'yes', reason: 'x' }, 'bad_value'],
    [{ name: 'node_operators', value: `${JUAN},nope`, reason: 'x' }, 'bad_value'],
    [{ name: 'node_operators', value: '1' }, 'reason_required'],
  ])
    assert.equal((await flags(dark, body)).json.error, code, JSON.stringify(body));
  assert.equal((await flags(dark, { name: 'node_operators', value: '1', reason: 'x' }, { 'x-operator-id': JUAN })).json.error, 'not_trusted');
  posts.length = 0;
  for (const value of ['1', JUAN, '0']) {
    const early = await flags(dark, { name: 'node_operators', value, reason: 'too early' });
    assert.deepEqual([early.status, early.json.error], [409, 'hosting_terms'], value);
  }
  await dark.ctx.settle();
  const about = (l) => l.includes('hosting') || l.includes('node_operators');
  assert.deepEqual([dark.env.FLAGS.puts, rows(dark, 'admin_audit'), postedTo(HOOK).filter(about), rows(dark, 'node_alerts').filter((r) => about(r.line))], [[], [], [], []], 'nothing written, no ALERT, under the terms of before');
  assert.ok(lines.some((l) => l.includes('the hosting flag node_operators not set (closed)')), 'a log line');
  // The terms in force: a canary, deduplicated; the line says how many, never who.
  const h = await boot(makeEnv({ ...IN_FORCE, NODE_ALERT_WEBHOOK: HOOK }));
  posts.length = 0;
  const w = await flags(h, { name: 'node_operators', value: ` ${JUAN},${ANA},${JUAN}`, reason: 'the canary' });
  assert.deepEqual([w.status, w.json.value, w.json.was, w.json.stage], [200, `${JUAN},${ANA}`, null, 'canary']);
  assert.deepEqual(h.env.FLAGS.puts, [['node_operators', `${JUAN},${ANA}`]]);
  const [row] = rows(h, 'admin_audit');
  assert.deepEqual([row.actor, row.flag, row.old, row.new, row.reason], [ACTOR.slice('admin '.length), 'node_operators', null, `${JUAN},${ANA}`, 'the canary']);
  await h.ctx.settle();
  const line = postedTo(HOOK).find((l) => l.includes('hosting closed'));
  assert.equal(line, `**ALERT** \`${ACTOR}: hosting closed -> open to a canary of 2 accounts (node_operators): the canary\``);
  assert.ok(!postedTo(HOOK).some((l) => l.includes(JUAN) || l.includes(ANA)), 'no id on the channel');
  const o = await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN });
  assert.deepEqual([o.json.hosting.stage, o.json.hosting.terms, o.json.hosting.changes.length], ['canary', { inForce: true, version: IN_FORCE.TERMS_VERSION, needed: IN_FORCE.NODE_HOSTING_TERMS }, 1]);
  // A year later the cron's prune takes it.
  clock += 366 * DAY;
  await call(h, 'POST', '/internal/prune');
  assert.deepEqual(rows(h, 'admin_audit'), []);
});

// ---- the community nodes' alerts ------------------------------------------------------------------

test("a community node's ALERTs go to the community nodes' channel, never the team's; without that webhook, only the panel's ring; a hello off port 443 closes its link", async () => {
  for (const community of [CHOOK, undefined]) {
    const h = await boot(openEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_COMMUNITY_WEBHOOK: community }));
    const { ws } = await liveCommunity(h, { host: community ? 'lag1.example.org' : 'lag2.example.org' });
    await h.ctx.settle();
    posts.length = 0;
    for (let i = 0; i < 3; i++) await h.obj.webSocketMessage(ws, JSON.stringify(beat({ tickLagP99Ms: 20 })));
    await h.ctx.settle();
    assert.deepEqual(postedTo(HOOK), [], "nothing on the team's channel");
    assert.equal(postedTo(CHOOK).filter((l) => l.includes('tick lag')).length, community ? 1 : 0);
    assert.ok(rows(h, 'node_alerts').some((r) => r.line.includes('tick lag')), "in the panel's ring");
    const o = await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN });
    assert.equal(o.json.hosting.communityWebhook, community !== undefined);
  }
  // A hello that moves a community node off port 443 of its host closes its link; its address stays.
  const h = await boot(openEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_COMMUNITY_WEBHOOK: CHOOK }));
  const { node, ws } = await liveCommunity(h, { host: 'port.example.org' });
  await h.ctx.settle();
  posts.length = 0;
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'hello', data: { bootId: 'boot-2', build: NODE_BUILD, roles: ['host'], transports: ['wss'], publicUrl: 'wss://port.example.org:8443', rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null } }));
  assert.deepEqual(ws.closed, { code: 1008, reason: 'address not allowed' });
  assert.equal(h.obj.cp.registry.node(node.nodeId).publicUrl, 'wss://port.example.org');
  await h.ctx.settle();
  assert.deepEqual(postedTo(HOOK), []);
  assert.ok(postedTo(CHOOK).some((l) => l.includes('wss://port.example.org:8443, an address it may not move to (a community server is on port 443 only)')), postedTo(CHOOK).join('\n'));
});

// ---- the operator's name, by its choice ------------------------------------------------------------

test('the opt-in: an operator outside the project named in the public list only once it chose to, and only while hosting is open for it; withdrawn with the same switch; gone for good with its account', async () => {
  const h = await boot(openEnv());
  await liveCommunity(h);
  const status = async () => (await call(h, 'GET', '/nodes/status')).json.nodes.map((n) => n.operator);
  assert.deepEqual(await status(), ['Anfitrión 1']);
  const pub = (show, op = JUAN) => call(h, 'POST', '/nodes/mine/public', { body: { show }, headers: { 'x-operator-id': op } });
  assert.equal((await pub('yes')).status, 400);
  assert.deepEqual([(await pub(true)).json, await status()], [{ showPublic: true }, ['Juan']]);
  assert.equal(rows(h, 'operators')[0].show_public, 1);
  assert.deepEqual([(await pub(false)).json, await status()], [{ showPublic: false }, ['Anfitrión 1']]);
  assert.equal((await pub(true, PROJECT)).json.error, 'trusted');
  await pub(true);
  // Its points keep it in the hosts' ranking after its account goes: by its number from then on.
  h.obj.cp.ledger.record({ matchId: 'e'.repeat(64), nodeId: 'n1', operatorId: JUAN, region: 'SA', mode: '2v2', ranked: false, verified: true, endReason: 'rules', players: ['a', 'b'].map((x) => ({ playerId: x.repeat(16), connectedMs: 600_000, account: true, accountAgeDays: 30 })), tickLagP99Ms: 2, underrunRate: 0, at: clock }, 1);
  const hostsNow = async () => (await call(h, 'GET', '/nodes/status')).json.hosts.map((x) => x.name);
  assert.deepEqual(await hostsNow(), ['Juan']);
  const pending = (await ask(h)).json.token;
  // A blocked operator, and a canary that names both, before the two accounts are purged.
  await call(h, 'POST', '/nodes/admin/operator', { body: { operatorId: ANA, action: 'block', reason: 'fake reports' }, headers: ADMIN });
  await call(h, 'POST', '/nodes/admin/flags', { body: { name: 'node_operators', value: `${JUAN},${ANA}`, reason: 'the canary' }, headers: ADMIN });
  for (const id of [JUAN, ANA]) assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: id } })).status, 200);
  assert.deepEqual(await hostsNow(), ['Anfitrión 1'], 'gone for good, at once');
  assert.deepEqual(await status(), [], 'its node banned: off the list too');
  const ops = rows(h, 'operators');
  assert.deepEqual(
    ops.map((r) => [/^deleted:[0-9a-f]{12}$/.test(r.operator_id), r.status, r.reason, r.show_public]),
    [[true, 'blocked', 'fake reports', 0]],
    "the opt-in's row gone, the block kept without the id",
  );
  assert.deepEqual(rows(h, 'operator_tokens'), []);
  const [audit] = rows(h, 'admin_audit');
  assert.equal(audit.new, 'deleted,deleted');
  const kept = JSON.stringify([ops, rows(h, 'admin_audit'), [...h.obj.operators.keys()]]);
  assert.ok(!kept.includes(JUAN) && !kept.includes(ANA), 'no account id left in them');
  assert.equal(h.obj.cp.registry.tokenList().find((t) => t.operatorId === JUAN && t.usedBy === null).revokedAt, clock, 'its unused code revoked');
  assert.equal((await register(h, pending)).json.error, 'token_revoked');
});

// ---- the Worker: the gate, the register's continent, GET /api/config ------------------------------

/** NODES whose one object answers 200 and records each forwarded request. */
function nodesNs() {
  const seen = [];
  return {
    seen,
    idFromName: (name) => ({ name }),
    get: () => ({ fetch: async (req) => (seen.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) }), new RealResponse('{"ok":true}', { headers: { 'content-type': 'application/json' } })) }),
  };
}
const ORIGIN = 'https://turbo-gol.com';
const workerEnv = (over = {}) => ({ JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: kvOf(), NODES: nodesNs(), NODE_REPLAYS: bucket(), NODE_RELEASES: bucket(), NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey, NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey, NODE_TRUSTED_OPERATORS: PROJECT, NODES_PUBLIC_BASE: ORIGIN, ...over });
let ip = 0;
const wreq = (env, method, path, { body, headers = {} } = {}) => worker.fetch(new Request(ORIGIN + path, { method, headers: { 'CF-Connecting-IP': `198.18.0.${++ip}`, Origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
const s = () => Math.floor(Date.now() / 1000);
const session = (sub, extra = {}) => signJwt(SECRET, { sub, name: 'Juan', iat: s(), exp: s() + 3600, acct: 1, aat: s(), aal: 2, since: s() - 30 * 86_400, ...extra });

test("the Worker: a community account's token only while hosting is open for it, never from a TV, fresh as a maintainer's; the session's since goes on; the panel's new routes behind the maintainer gate", async () => {
  const closed = workerEnv({ FLAGS: kvOf({ node_operators: '1' }) });
  const r = await wreq(closed, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(JUAN)) } });
  assert.deepEqual([r.status, (await r.json()).error], [403, 'hosting_closed'], 'the flag alone opens nothing');
  assert.deepEqual([closed.NODES.seen, closed.FLAGS.reads], [[], []], 'not asked, not even KV');
  const env = workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: JUAN }) });
  const tv = await wreq(env, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(JUAN, { tv: 1 })) } });
  assert.equal((await tv.json()).error, 'tv_session');
  const stale = await wreq(env, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(JUAN, { aat: s() - 16 * 60 })) } });
  assert.equal((await stale.json()).error, 'reauth_required');
  const other = await wreq(env, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(ANA)) } });
  assert.equal((await other.json()).error, 'hosting_closed', 'not in the canary');
  const staleOther = await wreq(env, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(ANA, { aat: s() - 16 * 60 })) } });
  assert.equal((await staleOther.json()).error, 'hosting_closed', 'the policy before the freshness: closed is closed, confirmed or not');
  const ok = await wreq(env, 'POST', '/nodes/tokens', { body: { region: 'SA' }, headers: { authorization: 'Bearer ' + (await session(JUAN)), 'x-operator-since': '1' } });
  assert.equal(ok.status, 200);
  const [seen] = env.NODES.seen;
  assert.deepEqual([seen.path, seen.headers['x-operator-id'], seen.headers['x-operator-since']], ['/nodes/tokens', JUAN, String(s() - 30 * 86_400)]);
  // The opt-in's switch: an account, never a TV; the object decides the rest.
  const tvPub = await wreq(env, 'POST', '/nodes/mine/public', { body: { show: true }, headers: { authorization: 'Bearer ' + (await session(JUAN, { tv: 1 })) } });
  assert.equal((await tvPub.json()).error, 'tv_session');
  assert.equal((await wreq(env, 'POST', '/nodes/mine/public', { body: { show: true }, headers: { authorization: 'Bearer ' + (await session(JUAN)) } })).status, 200);
  assert.equal(env.NODES.seen.at(-1).path, '/nodes/mine/public');
  // The panel's routes: a maintainer's only.
  for (const [method, what] of [['POST', 'flags'], ['POST', 'operator'], ['GET', 'operators']]) {
    const res = await wreq(env, method, '/nodes/admin/' + what, { body: method === 'POST' ? {} : undefined, headers: { authorization: 'Bearer ' + (await session(JUAN)) } });
    assert.equal((await res.json()).error, 'not_trusted', what);
    const mine = await wreq(env, method, '/nodes/admin/' + what, { body: method === 'POST' ? {} : undefined, headers: { authorization: 'Bearer ' + (await session(PROJECT)) } });
    assert.equal(mine.status, 200, what);
  }
  // The register's continent: set here, whatever the caller sent ('' with no cf data).
  await wreq(env, 'POST', '/nodes/register', { body: {}, headers: { 'x-client-continent': 'SA' } });
  assert.equal(env.NODES.seen.at(-1).headers['x-client-continent'], '');
});

test('GET /api/config says whether hosting is open: closed (no KV read) until the terms describe it, then as the flag says; closed without the node settings', async () => {
  const config = async (env) => (await (await wreq(env, 'GET', '/api/config')).json()).hosting;
  const dark = workerEnv({ FLAGS: kvOf({ node_operators: '1' }) });
  assert.deepEqual(await config(dark), { open: false, stage: 'closed' });
  assert.ok(!dark.FLAGS.reads.includes('node_operators'), 'the flag is not even read');
  assert.deepEqual(await config(workerEnv({ ...IN_FORCE })), { open: false, stage: 'closed' });
  assert.deepEqual(await config(workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: `${JUAN},${ANA}` }) })), { open: true, stage: 'canary' });
  assert.deepEqual(await config(workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: '1' }) })), { open: true, stage: 'all' });
  assert.deepEqual(await config(workerEnv({ ...IN_FORCE, FLAGS: kvOf({ node_operators: '1' }), NODE_CONTROL_PRIVATE_KEY: undefined })), { open: false, stage: 'closed' });
});

// ---- AccountsDO: the 'host' consents row -----------------------------------------------------------

function accountsDO(env = {}) {
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  let alarm = null;
  const ctx = { storage: { sql, transactionSync, getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, { JWT_SECRET: SECRET, FLAGS: kvOf(), ...env });
  const post = async (path, body) => {
    const res = await obj.fetch(new Request('https://accounts' + path, { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  };
  const me = async (id) => (await obj.fetch(new Request('https://accounts/me?userId=' + id, { headers: { [INTERNAL_HEADER]: secret } }))).json();
  const hostRows = (id) => sql.exec("SELECT version, granted, source FROM consents WHERE user_id = ? AND kind = 'host' ORDER BY id", id).toArray();
  return { obj, post, me, hostRows };
}

test("POST /host-consent: a 'host' row (source node_token) only with adult: true, for the version in force, once per version, never while the terms do not describe hosting; GET /me says hostTerms, null before", async () => {
  const dark = accountsDO({ TERMS_VERSION: '2026-11-05' });
  const d = makeAccount(dark.obj.store, 'Oscura', { email: 'oscura@example.org' }).userId;
  dark.obj.store.acceptTerms(d, '2026-11-05', clock);
  const off = await dark.post('/host-consent', { userId: d, version: '2026-11-05', adult: true });
  assert.deepEqual([off.status, off.json.error], [400, 'bad_consent']);
  assert.deepEqual(dark.hostRows(d), []);
  assert.equal((await dark.me(d)).hostTerms, null, 'none while closed');
  const a = accountsDO(IN_FORCE);
  const id = makeAccount(a.obj.store, 'Anfitrion', { email: 'anfitrion@example.org' }).userId;
  const v = IN_FORCE.TERMS_VERSION;
  const first = await a.post('/host-consent', { userId: id, version: v, adult: true });
  assert.deepEqual([first.status, first.json.error, first.json.version], [403, 'terms_required', v], 'the terms of that version first');
  a.obj.store.acceptTerms(id, v, clock);
  for (const [body, status, code] of [
    [{ userId: id, version: v }, 403, 'adult_required'],
    [{ userId: id, version: v, adult: 'true' }, 403, 'adult_required'],
    [{ userId: id, version: '2026-11-05', adult: true }, 409, 'terms_changed'],
    [{ userId: 'x', version: v, adult: true }, 400, 'bad_consent'],
    [{ userId: 'f'.repeat(16), version: v, adult: true }, 404, 'no_user'],
  ]) {
    const r = await a.post('/host-consent', body);
    assert.deepEqual([r.status, r.json.error], [status, code], JSON.stringify(body));
  }
  assert.deepEqual(a.hostRows(id), []);
  const ok = await a.post('/host-consent', { userId: id, version: v, adult: true });
  assert.deepEqual([ok.status, ok.json], [200, { hostTerms: v }]);
  assert.deepEqual((await a.post('/host-consent', { userId: id, version: v, adult: true })).json, { hostTerms: v });
  assert.deepEqual(a.hostRows(id), [{ version: v, granted: 1, source: 'node_token' }], 'one row per version');
  assert.equal((await a.me(id)).hostTerms, v);
  // The rules of a new version accepted again in Mis servidores (again: true, POST /nodes/mine/accept):
  // the same row, its source saying where, once per version too; the terms of that version first.
  const next = '2026-12-01';
  a.obj.env.TERMS_VERSION = next;
  assert.equal((await a.post('/host-consent', { userId: id, version: next, adult: true, again: true })).json.error, 'terms_required');
  a.obj.store.acceptTerms(id, next, clock);
  assert.equal((await a.post('/host-consent', { userId: id, version: next, again: true })).json.error, 'adult_required', 'never without the declaration, again neither');
  const again = await a.post('/host-consent', { userId: id, version: next, adult: true, again: true });
  assert.deepEqual([again.status, again.json], [200, { hostTerms: next }]);
  assert.deepEqual((await a.post('/host-consent', { userId: id, version: next, adult: true, again: true })).json, { hostTerms: next });
  assert.deepEqual(a.hostRows(id), [{ version: v, granted: 1, source: 'node_token' }, { version: next, granted: 1, source: 'host_reaccept' }]);
  assert.equal((await a.me(id)).hostTerms, next);
  a.obj.env.TERMS_VERSION = v;
  // A deletion pending writes nothing.
  const g = makeAccount(a.obj.store, 'Seva', { email: 'seva@example.org' }).userId;
  a.obj.store.acceptTerms(g, v, clock);
  a.obj.store.sql.exec('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?', clock, clock + DAY, g);
  const pending = await a.post('/host-consent', { userId: g, version: v, adult: true });
  assert.deepEqual([pending.status, pending.json.error, pending.json.purgeAt], [403, 'deletion_pending', clock + DAY]);
  assert.deepEqual(a.hostRows(g), []);
});
