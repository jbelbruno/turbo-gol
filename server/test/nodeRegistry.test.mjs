// The NodeRegistryDO (server/src/NodeRegistryDO.ts, its tables in server/src/nodeStore.ts) on
// fakes, without workerd: its SQLite on node:sqlite (the same SQL), a fake DurableObjectState with
// hibernatable sockets, an alarm and waitUntil, R2 buckets in memory, ACCOUNTS and MATCHMAKER
// namespaces that record what the outbox delivers, and a node played by the test (it signs the
// challenge and its /healthz nonce, says hello, answers 'assign' and 'leave', reports). A fake
// fetch answers that /healthz (or fails it as a test asks) and takes the posts of the team's
// webhook, for the ALERTs, the watch, the cron's health check and the maintainers' routes. Date.now
// is the test's clock. A "deploy" builds a new object on the same database with every socket
// closed; a "hibernation" builds one on the same database and the same open sockets.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
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

// The control plane's auth (10 s) and RPC (5 s) timers must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const D = await import('../src/NodeRegistryDO.ts');
const { NodeStore } = await import('../src/nodeStore.ts');
const { CLIENT_BUILD } = await import('../src/nodeApi.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../../nodes/shared/edcrypto.ts');
const { authMessage, reachMessage, replayRequestMessage } = await import('../../nodes/shared/controlProtocol.ts');
const { LINK_TIMEOUT_MS, NODE_OFFLINE_MS, RESTART_GRACE_MS } = await import('../../nodes/control-plane/controlPlane.ts');
const { STATE_VERSION } = await import('../../nodes/control-plane/persist.ts');

const SECRET = 'node-registry-test-secret';
const RealResponse = globalThis.Response;
/** Node refuses a 101 Response: the object's upgrade answer is kept as a 200 marked `upgraded` (room.test.mjs). */
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

/** Every line the object logged (console.log), for the ALERT checks. NODELOG=1 prints them too. */
const lines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(' ');
  lines.push(line);
  if (process.env.NODELOG) realLog(line);
};
const alerts = () => lines.filter((l) => l.startsWith('[nodes] ALERT'));

const PROJECT = 'a1b2c3d4e5f60718';
const STRANGER = '0123456789abcdef';
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const BASE = 'https://turbo-gol.test';
const NODE_URL = 'wss://sp1.turbo-gol.test';
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' };
const NODE_BUILD = { ...CLIENT_BUILD, version: '0.2.0' };
const CONTROL = await generateEd25519();
const secret = await internalSecret(SECRET);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** `p`, or a failure once `ms` passed without it: a hang fails its test instead of stalling the file. */
async function within(ms, p, what) {
  let timer;
  const late = new Promise((_, reject) => (timer = realSetTimeout(() => reject(new Error(what)), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(fn, what) {
  for (let i = 0; i < 200 && !(await fn()); i++) await sleep(2);
  assert.ok(await fn(), what);
}

// ---- fakes ---------------------------------------------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
    /** The node behind it: sees every message the control plane sends. */
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

/** node:sqlite behind ctx.storage.sql (exec(...).toArray()) and transactionSync, as accounts.test.mjs. */
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

/** The object's key-value storage (ctx.storage.get / put), one per database: a deploy keeps it with the tables. */
const kvOf = new WeakMap();

class FakeCtx {
  constructor(db = new DatabaseSync(':memory:'), sockets = []) {
    this.db = db;
    this.sockets = sockets;
    this.alarm = null;
    this.waits = [];
    const { sql, transactionSync } = sqlOf(db);
    if (!kvOf.has(db)) kvOf.set(db, new Map());
    const kv = kvOf.get(db);
    this.storage = {
      sql,
      transactionSync,
      get: async (k) => structuredClone(kv.get(k)),
      put: async (k, v) => void kv.set(k, structuredClone(v)),
      getAlarm: async () => this.alarm,
      setAlarm: async (t) => {
        this.alarm = t;
      },
      deleteAlarm: async () => {
        this.alarm = null;
      },
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
  /** Every waitUntil so far (the outbox drains it kicks), settled. */
  async settle() {
    while (this.waits.length > 0) await Promise.all(this.waits.splice(0));
  }
}

/** An R2 bucket in memory. */
function bucket(initial = {}) {
  const objects = new Map();
  const enc = new TextEncoder();
  const put = (k, v) => objects.set(k, typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
  for (const [k, v] of Object.entries(initial)) put(k, v);
  const view = (k) => {
    const b = objects.get(k);
    return b ? { key: k, size: b.byteLength, httpEtag: `"${b.byteLength}-${b[0] ?? 0}"`, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
  };
  return {
    objects,
    get: async (k) => view(k),
    head: async (k) => view(k),
    put: async (k, v) => void put(k, v),
  };
}

/** A DO namespace whose objects answer `answer(name, path, body)` (a Response, or an Error to throw); `calls` records each POST. */
function namespace(answer = () => new RealResponse('{"ok":true}')) {
  const calls = [];
  const ns = {
    calls,
    /** While set, every delivery waits for it (to look at the outbox before anything is delivered). */
    gate: null,
    answer,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (url, init) => {
        if (ns.gate) await ns.gate;
        // A GET (accountsCall without a payload) has no body: its query is part of the path here.
        const u = new URL(url);
        const path = u.pathname + u.search;
        const body = init?.body === undefined ? null : JSON.parse(init.body);
        calls.push({ name: id.name, path, body });
        const r = ns.answer(id.name, path, body);
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  };
  return ns;
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
    NODES_PUBLIC_BASE: BASE + '/',
    ACCOUNTS: namespace(),
    MATCHMAKER: namespace(),
    ...over,
  };
}

/** The team's Discord webhook (NODE_ALERT_WEBHOOK) and what it got: each post's JSON body. */
const HOOK = 'https://discord.test/api/webhooks/1/secret';
const posts = [];
const posted = () => posts.map((p) => p.content);

/**
 * The nodes behind the fake /healthz: host -> { nodeId, key, draining?, fail? } (the registered
 * node: setting `draining` or `fail(url, init)` on it changes what its /healthz answers).
 */
const hosts = new Map();
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === HOOK) {
    posts.push(JSON.parse(init.body));
    return new RealResponse(null, { status: 204 });
  }
  const u = new URL(String(url));
  const h = hosts.get(u.host);
  if (u.pathname !== '/healthz' || !h) throw new Error('unexpected fetch ' + url);
  if (h.fail) return h.fail(u, init);
  const nonce = u.searchParams.get('nonce');
  return new RealResponse(JSON.stringify({ ok: true, nodeId: h.nodeId, draining: h.draining === true, sig: await sign(h.key, reachMessage(h.nodeId, nonce)) }));
};

/** A NodeRegistryDO on `ctx`, started. An ALERT post's turn comes at once (nodeOps.test.mjs times the turns). */
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
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

const tokenFor = (h, op = PROJECT, region = 'SA') => call(h, 'POST', '/nodes/tokens', { body: { region, name: 'sao-paulo-1' }, headers: { 'x-operator-id': op, 'x-operator-name': encodeURIComponent('Proyecto Señor') } });

/** Register a node with a fresh key; `node.key` signs for it. */
async function registerNode(h, { ip = '203.0.113.1', roles = ['host', 'verify'], publicUrl = NODE_URL, op = PROJECT } = {}) {
  const t = await tokenFor(h, op);
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', {
    body: { token: t.json.token, publicKey: keys.publicKey, roles, publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP },
    headers: { 'x-client-ip': ip },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const node = { ...r.json, key: await importPrivateKey(keys.privateKey), publicUrl };
  if (publicUrl) hosts.set(new URL(publicUrl).host, node);
  return node;
}

/** The node's reflexes on a socket: it answers 'assign' and 'leave' on whatever object `h.obj` is now. */
function answer(h, ws, node, opts = {}) {
  ws.onSend = (m) => {
    const reply = (data) => setImmediate(() => void h.obj.webSocketMessage(ws, JSON.stringify({ t: 'reply', rid: m.rid, ok: true, data })));
    if (m.t === 'assign') reply({ wsUrl: `${node.publicUrl}/m/${m.match.matchId}` });
    if (m.t === 'leave') reply({ slot: 0, closed: true, already: false, ended: false });
    opts.onSend?.(m);
  };
}

/** Open /nodes/connect for `node` and log in (no hello yet). */
async function connect(h, node) {
  const res = await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  assert.equal(res.upgraded, true, 'upgraded');
  const ws = h.ctx.sockets.at(-1);
  answer(h, ws, node);
  const challenge = ws.of('challenge')[0];
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, challenge.nonce)) }));
  assert.equal(ws.of('welcome').length, 1, 'welcome');
  return ws;
}

const helloOf = (node, over = {}) => ({ bootId: 'boot-1', build: NODE_BUILD, roles: ['host', 'verify'], transports: ['wss'], publicUrl: node.publicUrl, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...over });
const beat = (over = {}) => ({ active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...over });
const send = (h, ws, m) => h.obj.webSocketMessage(ws, JSON.stringify(m));

/** A trusted node registered, connected, said hello and proven reachable (active). */
async function liveNode(h, opts = {}) {
  const node = await registerNode(h, opts);
  const ws = await connect(h, node);
  await send(h, ws, { t: 'hello', data: helloOf(node) });
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'active', 'active after its probe');
  return { node, ws };
}

/** A body that counts how many chunks were pulled from it. */
function stream(chunks) {
  const s = { pulls: 0 };
  s.body = new ReadableStream(
    {
      pull(c) {
        if (s.pulls >= chunks.length) return c.close();
        c.enqueue(chunks[s.pulls++]);
      },
    },
    { highWaterMark: 0 }, // nothing is pulled before a read
  );
  return s;
}

const humans = (...ids) => ids.map((id, i) => ({ playerId: id, name: 'P' + i }));
const placeBody = (over = {}) => ({ mode: '1v1', region: 'SA', ranked: false, matchLengthSeconds: 180, humans: humans(A, B), ...over });

/** The rows of a table. */
const rows = (h, table) => h.ctx.db.prepare(`SELECT * FROM ${table}`).all();

// ---- the store -------------------------------------------------------------------------------------

test('migrate() is idempotent and keeps the rows; a state version this build does not read is refused', () => {
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  const store = new NodeStore(sql, transactionSync);
  store.migrate();
  db.prepare("INSERT INTO nodes (node_id, operator_id, public_key, data) VALUES ('n', 'o', 'k', '{}')").run();
  store.migrate();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 1);
  assert.deepEqual(db.prepare('SELECT k, v FROM meta').all().map((r) => ({ ...r })), [{ k: 'state_version', v: String(STATE_VERSION) }]);
  db.prepare("UPDATE meta SET v = ? WHERE k = 'state_version'").run(String(STATE_VERSION + 1));
  assert.throws(() => store.migrate(), /state version 2 .*a newer build wrote them/);
});

test('a state version written by a newer build: the object starts down with an ALERT, answers 503 and touches nothing', async () => {
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  new NodeStore(sql, transactionSync).migrate();
  db.prepare("UPDATE meta SET v = '9' WHERE k = 'state_version'").run();
  lines.length = 0;
  const h = await boot(makeEnv(), new FakeCtx(db));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /not started, its state is left as it is: .*state version 9/);
  const r = await call(h, 'GET', '/nodes/status');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'nodes_unavailable');
  assert.doesNotMatch(r.json.message, /state|version|unreadable/, 'the cause is for the ALERT line, not for any caller');
  assert.equal(h.ctx.alarm, null);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'state_version'").get().v, '9', 'the rows wait for the build that wrote them');
});

test('without the node settings the object serves nothing; every route needs the internal header', async () => {
  const h = await boot(makeEnv({ NODE_CONTROL_PRIVATE_KEY: undefined }));
  assert.equal((await call(h, 'GET', '/nodes/status')).status, 503);
  const ok = await boot(makeEnv());
  const res = await ok.obj.fetch(new Request('https://nodes/nodes/status'));
  assert.equal(res.status, 403);
});

// ---- tokens, registration ------------------------------------------------------------------------

test('tokens: a trusted operator only while hosting is closed, a known region, 10 a day; the answer carries the install line', async () => {
  const h = await boot(makeEnv());
  assert.deepEqual((await tokenFor(h, STRANGER)).json.error, 'hosting_closed');
  assert.equal((await tokenFor(h, STRANGER)).status, 403);
  assert.equal((await tokenFor(h, PROJECT, 'XX')).status, 400);
  const t = await tokenFor(h);
  assert.equal(t.status, 200);
  assert.match(t.json.token, /^tgn1_/);
  assert.equal(t.json.ttlMinutes, 60);
  assert.equal(t.json.install.linux, `curl -fsSL ${BASE}/nodes/releases/install.sh | sudo bash -s -- --control ${BASE} --token ${t.json.token} --name sao-paulo-1`);
  assert.equal(t.headers.get('cache-control'), 'no-store');
  const rec = h.obj.cp.registry.tokenList()[0];
  assert.equal(rec.operatorName, 'Proyecto Señor', 'the name comes URL-encoded');
  assert.equal(rows(h, 'node_tokens').length, 1, 'written through');
  for (let i = 1; i < D.TOKENS_PER_ACCOUNT_PER_DAY; i++) assert.equal((await tokenFor(h)).status, 200);
  assert.equal((await tokenFor(h)).status, 429);
  clock += 24 * 3_600_000;
  assert.equal((await tokenFor(h)).status, 200, 'a new day');
});

test('register: the control public key and the wss URL; 5 a hour per address, refused attempts included', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h, { ip: '198.51.100.7' });
  assert.equal(node.controlPublicKey, CONTROL.publicKey);
  assert.equal(node.controlUrl, 'wss://turbo-gol.test/nodes/connect');
  assert.equal(node.status, 'pending');
  assert.equal(rows(h, 'nodes').length, 1);
  const bad = { body: { token: 'tgn1_nope' }, headers: { 'x-client-ip': '198.51.100.7' } };
  for (let i = 1; i < D.REGISTER_PER_IP_PER_HOUR; i++) assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 403);
  assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 429);
  assert.equal((await call(h, 'POST', '/nodes/register', { ...bad, headers: { 'x-client-ip': '198.51.100.8' } })).status, 403, 'another address');
  clock += 3_600_000;
  assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 403, 'an hour later');
});

test('register reads at most 4 KB of its body: a bigger one, sent without a Content-Length, is refused without being read whole', async () => {
  const h = await boot(makeEnv());
  // Valid JSON, so only the cap can refuse it (read whole, it would be a 403 for its token).
  const text = new TextEncoder().encode('{"token":"tgn1_' + 'a'.repeat(64 * 1024) + '"}');
  const big = stream(Array.from({ length: Math.ceil(text.byteLength / 1024) }, (_, i) => text.slice(i * 1024, (i + 1) * 1024)));
  const req = new Request('https://nodes/nodes/register', { method: 'POST', duplex: 'half', body: big.body, headers: { [INTERNAL_HEADER]: secret, 'x-client-ip': '198.51.100.30' } });
  assert.equal(req.headers.get('content-length'), null, 'a streamed body declares no length');
  const res = await h.obj.fetch(req);
  assert.deepEqual([res.status, (await res.json()).error], [400, 'bad_request']);
  assert.ok(big.pulls <= 5, `reading stopped at the cap (${big.pulls} KiB of ${Math.ceil(text.byteLength / 1024)} pulled)`);
  const declared = stream([text]);
  const r2 = await h.obj.fetch(new Request('https://nodes/nodes/register', { method: 'POST', duplex: 'half', body: declared.body, headers: { [INTERNAL_HEADER]: secret, 'x-client-ip': '198.51.100.30', 'content-length': String(text.byteLength) } }));
  assert.equal(r2.status, 400);
  assert.equal(declared.pulls, 0, 'a declared length over the cap: not a byte read');
});

test('register: an IPv6 /64 is one address; the limits keep a bounded number of windows and still let a new address in', async () => {
  const h = await boot(makeEnv());
  const bad = (ip) => call(h, 'POST', '/nodes/register', { body: { token: 'tgn1_nope' }, headers: { 'x-client-ip': ip } });
  for (let i = 1; i <= D.REGISTER_PER_IP_PER_HOUR; i++) assert.equal((await bad(`2001:db8:1:2::${i.toString(16)}`)).status, 403);
  assert.equal((await bad('2001:db8:1:2:ffff:ffff:ffff:ffff')).status, 429, 'another address of the same /64');
  assert.equal((await bad('2001:0db8:0001:0002:0:0:0:abcd')).status, 429, 'written out in full');
  assert.equal((await bad('2001:db8:1:3::1')).status, 403, 'the next /64');
  // A flood of fresh keys (one /64 each): the oldest windows go, the map never passes its cap.
  for (let i = 0; i < D.LIMIT_KEYS_MAX + 500; i++) h.obj.limited(`register:2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`, 5, 3_600_000);
  assert.equal(h.obj.limits.size, D.LIMIT_KEYS_MAX);
  assert.equal(h.obj.limits.has('register:2001:db8:1:2::/64'), false, 'the oldest window went first');
  assert.equal((await bad('203.0.113.77')).status, 403, 'a new address is still let through, not refused for a full map');
  assert.equal(h.obj.limits.size, D.LIMIT_KEYS_MAX);
});

test('a control public key that is not the private key’s half: ALERT, and no registration, placement or rejoin', async () => {
  for (const over of [{ NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey }, { NODE_CONTROL_PRIVATE_KEY: 'not a key' }]) {
    lines.length = 0;
    const h = await boot(makeEnv(over));
    assert.equal(alerts().length, 1, Object.keys(over)[0]);
    assert.match(alerts()[0], /NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY/);
    const t = await tokenFor(h);
    const keys = await generateEd25519();
    const r = await call(h, 'POST', '/nodes/register', { body: { token: t.json.token, publicKey: keys.publicKey, roles: ['host'], publicUrl: NODE_URL, build: NODE_BUILD, specs: SPECS, capacity: CAP } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'nodes_unavailable', 'what any outage answers: an anonymous caller does not learn the key pair is wrong');
    assert.doesNotMatch(r.json.message, /key|sign|ticket/);
    assert.equal(h.obj.cp.registry.tokenList()[0].usedBy, null, 'the token is still good');
    assert.deepEqual((await call(h, 'POST', '/internal/place', { body: placeBody() })).json, { placement: null, hosts: 0 });
    const rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: 'ab'.repeat(32), playerId: A } });
    assert.deepEqual([rj.status, rj.json.error], [503, 'offline'], 'the code that keeps the lock, not nodes_unavailable');
  }
});

// ---- sockets ---------------------------------------------------------------------------------------

test('a node logs in, its { nodeId } is attached once, its probe makes it active, and the alarm runs from the first socket', async () => {
  const h = await boot(makeEnv());
  assert.equal(h.ctx.alarm, null, 'nothing to do yet');
  const node = await registerNode(h);
  const ws = await connect(h, node);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.deepEqual(ws.att, { nodeId: node.nodeId });
  ws.att = 'untouched';
  await send(h, ws, { t: 'hello', data: helloOf(node) });
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'active', 'trusted: active once reachable');
  await send(h, ws, { t: 'heartbeat', data: beat() });
  assert.equal(ws.att, 'untouched', 'stored once');
  assert.equal(ws.of('welcome')[0].channel.minimum, '0.2.0', 'the channel from R2');
  assert.equal(ws.of('update').length, 0);
  assert.equal(ws.closed, null);
});

test('socket guards: a binary frame closes 1003, a frame over 256 KB 1009, bad JSON 1008, and each frees its session', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h);
  const open = async () => {
    await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
    return h.ctx.sockets.at(-1);
  };
  const plain = await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret } }));
  assert.equal(plain.status, 426);
  const a = await open();
  await h.obj.webSocketMessage(a, new ArrayBuffer(8));
  assert.deepEqual(a.closed, { code: 1003, reason: 'text only' });
  const b = await open();
  await h.obj.webSocketMessage(b, 'x'.repeat(D.MAX_FRAME_CHARS + 1));
  assert.equal(b.closed.code, 1009);
  const c = await open();
  await h.obj.webSocketMessage(c, '{nope');
  assert.equal(c.closed.code, 1008);
  // A message on a socket the object already let go is not handled (a logged-in one's is only counted).
  await h.obj.webSocketMessage(c, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: 'x' }));
  assert.equal(c.closed.code, 1008);
  const d = await open();
  await h.obj.webSocketClose(d, 1001, 'bye', true);
  assert.deepEqual(d.closed, { code: 1001, reason: 'bye' }, 'the close handshake is completed');
  assert.equal(h.ctx.getWebSockets().length, 0);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'no socket, no match: the alarm stops');
});

test('a socket the control plane closes ends its session at once, with or without a close event', async () => {
  const h = await boot(makeEnv());
  const { ws } = await liveNode(h);
  assert.equal((await call(h, 'POST', '/internal/place', { body: placeBody() })).json.hosts, 1);
  await send(h, ws, { t: 'heartbeat', data: { active: 'lots' } });
  assert.deepEqual(ws.closed, { code: 1008, reason: 'bad heartbeat' });
  assert.deepEqual((await call(h, 'POST', '/internal/place', { body: placeBody() })).json, { placement: null, hosts: 0 }, 'offline now, not at its heartbeat timeout');
});

// ---- placement and the internal routes -------------------------------------------------------------

test('place: the node is assigned and the row is written before the answer; rejoin, leave and status answer the contract', async () => {
  const h = await boot(makeEnv());
  const { node } = await liveNode(h);
  assert.equal((await call(h, 'POST', '/internal/place', { body: { ...placeBody(), mode: '4v4' } })).status, 400);
  const p = await call(h, 'POST', '/internal/place', { body: placeBody() });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const { placement, hosts } = p.json;
  assert.equal(hosts, 1);
  assert.equal(placement.nodeId, node.nodeId);
  assert.equal(placement.wsUrl, `${NODE_URL}/m/${placement.matchId}`);
  assert.match(placement.matchId, /^[0-9a-f]{64}$/);
  assert.deepEqual(placement.tickets.map((t) => t.playerId), [A, B]);
  assert.deepEqual(rows(h, 'node_matches').map((r) => [r.match_id, r.state]), [[placement.matchId, 'assigned']]);
  const id = placement.matchId;

  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${A}`)).json, { state: 'assigned', left: false });
  assert.equal((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${STRANGER}`)).status, 404);
  const rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: A } });
  assert.equal(rj.status, 200);
  assert.equal(rj.json.wsUrl, placement.wsUrl);
  assert.ok(rj.json.ticket.length > 100);
  assert.equal((await call(h, 'POST', '/internal/rejoin', { body: { matchId: 'cd'.repeat(32), playerId: A } })).json.error, 'no_match');
  assert.equal((await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: STRANGER } })).status, 404);

  const lv = await call(h, 'POST', '/internal/leave', { body: { matchId: id, playerId: B, connected: false } });
  assert.equal(lv.status, 200, JSON.stringify(lv.json));
  assert.deepEqual(lv.json, { recorded: true, answer: { slot: 0, closed: true, already: false, ended: false } });
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${B}`)).json, { state: 'assigned', left: true });
  const again = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: B } });
  assert.deepEqual([again.status, again.json.error], [410, 'left']);
  assert.equal((await call(h, 'POST', '/internal/leave', { body: { matchId: 'cd'.repeat(32), playerId: A } })).status, 404);
  assert.equal(JSON.parse(rows(h, 'node_matches')[0].data).neverJoined[0], B, 'connected: false is kept');
});

test('a node that dropped its link: a leave is not recorded (503) and the lock stays with the player', async () => {
  const h = await boot(makeEnv());
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await h.obj.webSocketClose(ws, 1006, '', false);
  const lv = await call(h, 'POST', '/internal/leave', { body: { matchId: placement.matchId, playerId: A } });
  assert.deepEqual([lv.status, lv.json.error], [503, 'offline']);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
});

// ---- a stalled control link ------------------------------------------------------------------------

/** 2026-10-21 at `hms` UTC. */
const at = (hms) => Date.parse('2026-10-21T' + hms + 'Z');

for (const trusted of [true, false]) {
  test(`a stalled control link, the 2026-10-21 timeline on a ${trusted ? 'project' : 'community'} node: the beats held from x1.7 to x26.7 arrive at once, the link and the match stay, and placement skips the node until then`, async () => {
    clock = at('00:00:40.000');
    const h = await boot(makeEnv());
    clock = at('00:00:50.000');
    const { ws, node } = await liveNode(h);
    // Stage 1 registers only the project's nodes: a community one is the same record, untrusted.
    if (!trusted) h.obj.cp.registry.node(node.nodeId).trusted = false;
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
    assert.ok(placement, 'placed');
    const place = async () => (await call(h, 'POST', '/internal/place', { body: placeBody({ humans: humans(STRANGER) }) })).json;
    // The node beats at x1.7 and x6.7 s, the alarm runs at x3.4 and x8.4 s. Every beat sent between
    // 00:01:07 and 00:01:30.6 is held on the way; the four of them arrive at 00:01:30.619.
    const events = [{ t: at('00:01:30.619'), kind: 'flush' }];
    for (let t = at('00:00:51.000'); t <= at('00:01:40.000'); t += 100) {
      if (t % 5_000 === 1_700) events.push({ t, kind: t > at('00:01:07') && t < at('00:01:30.6') ? 'held' : 'beat' });
      if (t % 5_000 === 3_400) events.push({ t, kind: 'alarm' });
    }
    events.sort((a, b) => a.t - b.t);
    lines.length = 0;
    let held = 0;
    let stalled = null;
    let after = null;
    for (const e of events) {
      clock = e.t;
      if (e.kind === 'beat') await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
      if (e.kind === 'held') held++;
      if (e.kind === 'alarm') await h.obj.alarm();
      if (e.kind === 'flush') {
        for (let i = 0; i < held; i++) await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
        after = { online: h.obj.cp.registry.node(node.nodeId).online, place: await place() };
      }
      if (clock === at('00:01:23.400')) stalled = { closed: ws.closed, online: h.obj.cp.registry.node(node.nodeId).online, place: await place() };
    }
    assert.equal(held, 4);
    assert.deepEqual(stalled, { closed: null, online: false, place: { placement: null, hosts: 0 } }, 'out of placement at the heartbeat timeout, the link kept');
    assert.ok(lines.includes('[nodes] node sao-paulo-1: no heartbeat for 17 s, no new matches until the next one'), lines.join('\n'));
    assert.equal(after.online, true);
    assert.equal(after.place.hosts, 1);
    assert.equal(after.place.placement?.nodeId, node.nodeId, 'placement takes the node again after the burst');
    assert.ok(lines.includes('[nodes] node sao-paulo-1: heartbeat again after 24 s'), lines.join('\n'));
    assert.equal(ws.closed, null);
    assert.ok(!lines.some((l) => l.includes('4408')), lines.join('\n'));
    assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
    const n = h.obj.cp.registry.node(node.nodeId);
    assert.deepEqual([n.counters.lost, n.counters.strikes], [0, 0]);
  });
}

test('a link silent past LINK_TIMEOUT_MS is closed with 4408, its silence logged; what it held is counted once, and the same process comes back to its match', async () => {
  const h = await boot(makeEnv());
  const { ws, node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  const last = clock;
  lines.length = 0;
  while (clock + D.TICK_MS - last <= LINK_TIMEOUT_MS) {
    clock += D.TICK_MS;
    await h.obj.alarm();
  }
  assert.equal(ws.closed, null);
  clock += D.TICK_MS;
  await h.obj.alarm();
  assert.deepEqual(ws.closed, { code: 4408, reason: 'heartbeat timeout' });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1: silent ${Math.round((clock - last) / 1000)} s, closing its control link (4408)`), lines.join('\n'));
  // The stall ends: its heartbeats come in on the closed socket, then the node's answer to the close.
  clock += 1_000;
  const late = clock - last;
  for (let i = 0; i < 10; i++) await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.webSocketClose(ws, 4408, 'heartbeat timeout', true);
  assert.equal(h.obj.cp.registry.node(node.nodeId).lastSeen, last, 'a closed link carries no heartbeat');
  // The same process logs in again (its backoff starts at 1 s), within NODE_OFFLINE_MS of its last heartbeat.
  clock += 1_000;
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node) });
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  for (let i = 0; i < 4; i++) {
    clock += D.TICK_MS;
    await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
    await h.obj.alarm();
  }
  assert.deepEqual(
    lines.filter((l) => l.includes('after its link was closed')),
    [`[nodes] node sao-paulo-1: 10 messages so far after its link was closed, up to ${Math.round((late - 5_000) / 1000)} s late`],
    'once, at the next alarm',
  );
  assert.equal(back.closed, null);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
  const n = h.obj.cp.registry.node(node.nodeId);
  assert.deepEqual([n.counters.lost, n.counters.strikes], [0, 0]);
});

// ---- settled matches and the outbox ----------------------------------------------------------------

test('a ranked match the node lost: the settled row and its outbox rows exist when the ack goes out; /ranked-cancel then /release', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
  let atAck = null;
  answer(h, ws, { publicUrl: NODE_URL }, { onSend: (m) => m.t === 'ack' && (atAck = { matches: rows(h, 'node_matches').map((r) => r.state), outbox: rows(h, 'outbox').map((r) => r.path) }) });
  let open;
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = new Promise((r) => (open = r));
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  assert.deepEqual(atAck, { matches: ['done'], outbox: ['/ranked-cancel', '/release'] });
  open();
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = null;
  await h.ctx.settle();
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.name, c.path, c.body.playlist, c.body.region, c.body.players, c.body.reason]), [['accounts-v1', '/ranked-cancel', '1v1', 'SA', [A, B], 'lost:tick_error']]);
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => [c.name, c.path, c.body]), [['mm:SA', '/release', { matchId: placement.matchId, playerIds: [A, B] }]]);
  assert.deepEqual(rows(h, 'outbox'), [], 'delivered right away, not at the next alarm');
});

test('a casual match only frees its locks; a 5xx is tried again later, further apart, with an ALERT after a day', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  env.MATCHMAKER.answer = () => new RealResponse('down', { status: 503 });
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  await h.ctx.settle();
  assert.equal(env.ACCOUNTS.calls.length, 0, 'a casual match records nothing');
  assert.equal(env.MATCHMAKER.calls.length, 1);
  let [row] = rows(h, 'outbox');
  assert.deepEqual([row.path, row.attempts, row.next_at - clock], ['/release', 1, 2_000]);
  /** An alarm and the delivery it starts (not waited for by the alarm itself). */
  const tick = async () => {
    await h.obj.alarm();
    await h.ctx.settle();
  };
  await tick();
  assert.equal(env.MATCHMAKER.calls.length, 1, 'not due yet');
  clock += 2_000;
  await tick();
  [row] = rows(h, 'outbox');
  assert.deepEqual([row.attempts, row.next_at - clock], [2, 4_000]);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'an undelivered row keeps the alarm');
  lines.length = 0;
  clock += 24 * 3_600_000;
  await tick();
  await tick();
  const late = alerts().filter((l) => l.includes(' outbox '));
  assert.equal(late.length, 1, 'once');
  assert.match(late[0], /ALERT outbox \/release for match \w{8} \(hub\) undelivered for a day, 3 tries/, 'the row names the queue hub (nodeOutcome.ts HUB_TARGET)');
  assert.equal(rows(h, 'outbox')[0].next_at - clock, 8_000);
  env.MATCHMAKER.answer = () => new RealResponse('{"ok":true}');
  clock += 300_000;
  await tick();
  assert.deepEqual(rows(h, 'outbox'), []);
});

test('a target that never answers holds back neither the alarm nor the other targets; its rows are retried after the timeout, one wait per pass', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  h.obj.timeoutMs = 200;
  env.ACCOUNTS.gate = new Promise(() => {}); // AccountsDO is stuck: no answer, no error
  /** A ranked match the node lost: a /ranked-cancel (AccountsDO) and a /release (the matchmaker). */
  const lose = async () => {
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
    await send(h, ws, { t: 'report', id: 'r-' + placement.matchId.slice(0, 8), report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
    return placement.matchId;
  };
  const first = await lose(); // its delivery starts now and waits on AccountsDO
  h.ctx.alarm = null; // the runtime consumed the alarm that runs now
  lines.length = 0;
  await within(1_000, h.obj.alarm(), 'the alarm waited for a delivery that never ends');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 're-armed while the delivery still waits');
  assert.equal(rows(h, 'outbox')[0].attempts, 0, 'not given up yet: the alarm did not wait for it');
  await within(1_000, h.obj.alarm(), 'the alarm waited for the drain in flight');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'a second run neither');
  await h.ctx.settle();
  assert.deepEqual(rows(h, 'outbox').map((r) => [r.match_id, r.path, r.attempts, r.next_at - clock]), [[first, '/ranked-cancel', 1, 2_000]]);
  assert.ok(lines.some((l) => /outbox \/ranked-cancel failed \(match \w{8}, accounts\), to retry: Error: no answer in 0\.2 s/.test(l)), lines.join('\n'));
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.body.matchId), [first], 'the other target was not held back');
  const second = await lose();
  await h.ctx.settle();
  clock += 2_000; // both /ranked-cancel rows are due
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(
    rows(h, 'outbox').map((r) => [r.match_id, r.attempts]),
    [
      [first, 2],
      [second, 1],
    ],
    'one wait for the stuck target in that pass: its second row waited for the next one',
  );
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.body.matchId), [first, second]);
  env.ACCOUNTS.gate = null;
  clock += 4_000;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(rows(h, 'outbox'), []);
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.path, c.body.matchId]), [['/ranked-cancel', first], ['/ranked-cancel', second]]);
});

test('a read of channel.json that never answers is given up: the alarm still re-arms and the last channel is kept', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  h.obj.timeoutMs = 50;
  env.NODE_RELEASES.get = () => new Promise(() => {});
  lines.length = 0;
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  h.ctx.alarm = null;
  await within(1_000, h.obj.alarm(), 'the alarm waited for a read that never ends');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.ok(lines.some((l) => l === '[nodes] channel.json not read, keeping the last one: Error: no answer in 0.05 s'), lines.join('\n'));
  assert.equal(ws.of('update').length, 0);
  assert.equal(ws.closed, null);
});

// ---- the alarm -------------------------------------------------------------------------------------

test('the alarm: re-armed while a socket, a match, a grace or an offline trusted node needs it, deleted when nothing does; a sweep that throws still re-arms', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws, node } = await liveNode(h);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'a socket');
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await h.obj.webSocketClose(ws, 1006, '', false);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'no socket, but a match the sweep must still void');
  // The store fails while the sweep voids the silent node's match: an ALERT, the match stays, the alarm too.
  const store = h.obj.store;
  const finished = store.finished;
  store.finished = () => {
    throw new Error('disk full');
  };
  lines.length = 0;
  clock += NODE_OFFLINE_MS + 1;
  await h.obj.alarm();
  assert.match(alerts()[0], /ALERT sweep failed: Error: disk full/);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  store.finished = finished;
  clock += D.TICK_MS;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(rows(h, 'node_matches')[0].state, 'done');
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.path), ['/release']);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'the trusted node is still offline: its ALERT needs the alarm');
  h.obj.cp.setStatus(node.nodeId, 'suspended', 'retired');
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'nothing left: deleted');
});

test('channel.json is read again every minute: a new minimum sends the nodes below it their update', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  /** Time passes for a node that keeps beating. */
  const later = async (ms) => {
    clock += ms;
    await send(h, ws, { t: 'heartbeat', data: beat() });
    await h.obj.alarm();
  };
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  await later(30_000);
  assert.equal(ws.of('update').length, 0, 'not read yet');
  await later(D.CHANNEL_REFRESH_MS);
  assert.deepEqual(ws.of('update'), [{ t: 'update', version: '0.3.0' }]);
  await later(D.CHANNEL_REFRESH_MS);
  assert.equal(ws.of('update').length, 1, 'unchanged: nothing new');
  // A broken channel keeps the last good one, with one ALERT.
  lines.length = 0;
  await env.NODE_RELEASES.put('channel.json', '{"stable":');
  await later(D.CHANNEL_REFRESH_MS);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /release channel missing or invalid .*holding the nodes to stable 0\.3\.0, minimum 0\.3\.0/);
});

// ---- deploys and hibernations ------------------------------------------------------------------------

test('a deploy (no socket survives) with an unfinished match: a grace, the alarm armed, and nothing voided before it ends', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws, node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  ws.close(1012, 'deploy');
  const ctx = new FakeCtx(h.ctx.db);
  h = await boot(env, ctx);
  assert.equal(h.obj.cp.inGrace(), true);
  assert.equal(ctx.alarm, clock + D.TICK_MS);
  clock += RESTART_GRACE_MS - 1_000;
  await h.obj.alarm();
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  // The same node process comes back within the grace: its match goes on.
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node) });
  clock += 10_000;
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.alarm();
  assert.equal(h.obj.cp.inGrace(), false);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  assert.equal(env.MATCHMAKER.calls.length, 0);
});

test('a deploy whose node never comes back: its match is void once the grace is over', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  ws.close(1012, 'deploy');
  h = await boot(env, new FakeCtx(h.ctx.db));
  clock += RESTART_GRACE_MS + 1_000;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(rows(h, 'node_matches')[0].state, 'done');
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => [c.path, c.body.matchId]), [['/release', placement.matchId]]);
});

test('a hibernation: the sockets are adopted without a grace, a placement uses the node before its next heartbeat, which is accepted', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws, node } = await liveNode(h);
  const first = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement;
  // A second socket still logging in when the object slept.
  await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  const pending = h.ctx.sockets.at(-1);
  const ctx = h.ctx;
  h.obj = new D.NodeRegistryDO(ctx, env); // same sockets, same database: the memory is all that went
  await h.obj.ready;
  assert.equal(h.obj.cp.unfinished(), 1);
  assert.equal(h.obj.cp.inGrace(), false, 'the node never lost its link: no grace');
  assert.deepEqual(pending.closed, { code: 4401, reason: 'log in again' });
  assert.equal(ws.closed, null);
  clock += 3_000;
  const p = await call(h, 'POST', '/internal/place', { body: placeBody() });
  assert.equal(p.json.placement?.nodeId, node.nodeId, 'adopted: online from the wake');
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  assert.equal(ws.closed, null, 'no new challenge: the heartbeat is taken');
  assert.equal(h.obj.cp.registry.node(node.nodeId).active, 1);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${first.matchId}&playerId=${A}`)).json.state, 'assigned');
});

test('a hibernation with a node gone quiet: its socket, marked when the node went quiet, is closed (4408) at the wake, not adopted; the same process logs in again and keeps its match', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws, node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  assert.deepEqual(ws.att, { nodeId: node.nodeId });
  // No heartbeat for 15 s: the alarm marks the socket. The next heartbeat takes the mark off.
  clock += 20_000;
  await h.obj.alarm();
  assert.deepEqual(ws.att, { nodeId: node.nodeId, quiet: true });
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  assert.deepEqual(ws.att, { nodeId: node.nodeId });
  clock += 20_000;
  await h.obj.alarm();
  assert.deepEqual(ws.att, { nodeId: node.nodeId, quiet: true });
  assert.equal(ws.closed, null, 'its link is still open');
  lines.length = 0;
  h.obj = new D.NodeRegistryDO(h.ctx, env); // same sockets, same database: the memory is all that went
  await h.obj.ready;
  assert.deepEqual(ws.closed, { code: 4408, reason: 'heartbeat timeout' });
  assert.ok(lines.includes('[nodes] node sao-paulo-1: silent when the control plane restarted, closing its control link (4408)'), lines.join('\n'));
  assert.deepEqual((await call(h, 'POST', '/internal/place', { body: placeBody({ humans: humans(STRANGER) }) })).json, { placement: null, hosts: 0 }, 'no placement on a node already silent');
  clock += 2_000;
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node) });
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  clock += D.TICK_MS;
  await h.obj.alarm();
  assert.equal(back.closed, null);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
  const n = h.obj.cp.registry.node(node.nodeId);
  assert.deepEqual([n.counters.lost, n.counters.strikes], [0, 0]);
});

// ---- replays -----------------------------------------------------------------------------------------

test('a replay upload: refused before its body is read when the signature is wrong; 413 past 16 MiB; stored in R2 otherwise', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const id = placement.matchId;
  const bytes = new Uint8Array(4096).map((_, i) => i & 0xff);
  const sha = await sha256Hex(bytes);
  const put = async (s, sig, ts = clock) =>
    h.obj.fetch(
      new Request(`https://nodes/nodes/replays/${id}`, {
        method: 'PUT',
        duplex: 'half',
        body: s.body,
        headers: { [INTERNAL_HEADER]: secret, 'x-node-id': node.nodeId, 'x-node-ts': String(ts), 'x-node-sig': sig, 'x-replay-sha256': sha },
      }),
    );
  const forged = stream([bytes]);
  const other = await importPrivateKey((await generateEd25519()).privateKey);
  const r1 = await put(forged, await sign(other, replayRequestMessage('PUT', id, sha, clock)));
  assert.deepEqual([r1.status, (await r1.json()).error], [401, 'bad_sig']);
  assert.equal(forged.pulls, 0, 'not a byte read');
  const sig = await sign(node.key, replayRequestMessage('PUT', id, sha, clock));
  const huge = stream(Array.from({ length: 20 }, () => new Uint8Array(1024 * 1024)));
  const r2 = await put(huge, sig);
  assert.equal(r2.status, 413);
  assert.ok(huge.pulls <= 17, 'reading stopped at the cap');
  const r3 = await put(stream([bytes.slice(0, 1000), bytes.slice(1000)]), sig);
  assert.equal(r3.status, 200, await r3.clone().text());
  assert.deepEqual(env.NODE_REPLAYS.objects.get(id), bytes);
  assert.equal(JSON.parse(rows(h, 'node_matches')[0].data).replaySha, sha, 'written before the 200');
  // Only the verifier the job went to may read it back.
  const get = await h.obj.fetch(new Request(`https://nodes/nodes/replays/${id}`, { headers: { [INTERNAL_HEADER]: secret, 'x-node-id': node.nodeId, 'x-node-ts': String(clock), 'x-node-sig': sig, 'x-replay-sha256': sha } }));
  assert.equal(get.status, 404);
});

// ---- public views ------------------------------------------------------------------------------------

test('status lists the nodes without their address; mine shows the operator its own', async () => {
  const h = await boot(makeEnv());
  const { node } = await liveNode(h);
  const s = await call(h, 'GET', '/nodes/status');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.build, CLIENT_BUILD);
  assert.equal(s.json.nodes.length, 1);
  assert.deepEqual([s.json.nodes[0].name, s.json.nodes[0].status, s.json.nodes[0].trusted, s.json.nodes[0].compatible], ['sao-paulo-1', 'active', true, true]);
  assert.ok(!JSON.stringify(s.json).includes('sp1.turbo-gol.test'), 'no address');
  assert.ok(!JSON.stringify(s.json).includes(node.nodeId), 'no node id');
  const mine = await call(h, 'GET', '/nodes/mine', { headers: { 'x-operator-id': PROJECT } });
  assert.deepEqual(mine.json.operator, { id: PROJECT, trusted: true });
  assert.deepEqual(mine.json.nodes.map((n) => [n.nodeId, n.publicUrl, n.reachable]), [[node.nodeId, NODE_URL, true]]);
  assert.deepEqual((await call(h, 'GET', '/nodes/mine', { headers: { 'x-operator-id': STRANGER } })).json.nodes, []);
});

// ---- the team's channel, the watch, the cron's health check --------------------------------------------

const MIN = 60_000;

/**
 * A NodeRegistryDO posting its ALERTs to the fake webhook, with a live trusted node and nothing
 * posted yet: a minute later, so the token's and the registration's posts are behind every limit.
 */
async function watched(over = {}) {
  const env = makeEnv({ NODE_ALERT_WEBHOOK: HOOK, ...over });
  const h = await boot(env);
  const live = await liveNode(h);
  await h.ctx.settle();
  clock += MIN;
  await send(h, live.ws, { t: 'heartbeat', data: beat() });
  posts.length = 0;
  return { h, env, ...live };
}

test('ALERT lines go to the team’s channel, the registry’s and the outbox’s too: in a code span, no mention; every token and trusted node each time', async () => {
  posts.length = 0;
  const env = makeEnv({ NODE_ALERT_WEBHOOK: HOOK });
  const h = await boot(env);
  const { node, ws } = await liveNode(h);
  await tokenFor(h); // the same line as the first token's: an account's action, posted again
  await h.ctx.settle();
  const token = '**ALERT** `registration token created for trusted operator Proyecto Señor (a1b2c3d4e5f60718), region SA`';
  assert.deepEqual(posted(), [token, `**ALERT** \`trusted node sao-paulo-1 (${node.nodeId}) registered for Proyecto Señor (a1b2c3d4e5f60718), roles host+verify at wss://sp1.turbo-gol.test\``, token]);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
  clock += 5 * MIN;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await tokenFor(h);
  await h.ctx.settle();
  assert.deepEqual(posted().slice(3), [token], 'five minutes later too');
  // A call AccountsDO refuses: the outbox drops it with an ALERT, which carries the body.
  env.ACCOUNTS.answer = () => new RealResponse('{"error":"bad_request"}', { status: 400 });
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  await h.ctx.settle();
  assert.match(posted().at(-1), /^\*\*ALERT\*\* `outbox \/ranked-cancel 400 \(match \w{8}, accounts\), dropped: \{"error":"bad_request"\}; body \{.*\}`$/);
  // The control key: logged while the object starts, posted all the same.
  posts.length = 0;
  const bad = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey }));
  await bad.ctx.settle();
  assert.deepEqual(posted(), ['**ALERT** `NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY: no placement, registration or rejoin until they match`']);
  // Without the webhook nothing is posted.
  posts.length = 0;
  const quiet = await boot(makeEnv());
  await tokenFor(quiet);
  await quiet.ctx.settle();
  assert.deepEqual(posts, []);
});

test('a trusted node offline for 2 minutes: one ALERT, the alarm running for it until then; a restart does not raise it again, its return is a plain line', async () => {
  const { h, env, node, ws } = await watched();
  const kept = () => rows(h, 'meta').find((r) => r.k === 'offline_alerted')?.v;
  await h.obj.webSocketClose(ws, 1006, '', false);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'no socket and no match: the offline node keeps the alarm');
  clock += 2 * MIN;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(posts, [], 'not yet');
  clock += D.TICK_MS;
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'its ALERT is out: nothing needs the alarm any more');
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(posts.length, 1, 'once');
  assert.match(posted()[0], new RegExp(`^\\*\\*ALERT\\*\\* \`trusted node sao-paulo-1 \\(${node.nodeId}\\) offline for 2 min \\(last heartbeat \\d\\d:\\d\\d:\\d\\d UTC\\): no match goes to it\`$`));
  assert.equal(kept(), JSON.stringify([node.nodeId]));
  // A deploy, or the object evicted while it slept: the new one knows that ALERT went out.
  lines.length = 0;
  const later = await boot(env, new FakeCtx(h.ctx.db));
  assert.equal(later.ctx.alarm, null, 'nothing to wait for');
  clock += 3 * MIN;
  await later.obj.alarm();
  assert.deepEqual(alerts(), [], 'not raised again');
  // Its return: a plain line, and the row lets it go.
  const back = await connect(later, node);
  await send(later, back, { t: 'hello', data: helloOf(node) });
  await later.obj.alarm();
  await later.ctx.settle();
  assert.ok(lines.includes(`[nodes] trusted node sao-paulo-1 (${node.nodeId}) back online`), lines.join('\n'));
  assert.equal(posts.length, 1, 'not an ALERT');
  assert.equal(kept(), '[]');
  // Offline again, taken out of service, and back in service while still offline: a new outage, and the alarm runs for it.
  const status = (s) => call(later, 'POST', '/nodes/admin/status', { body: { nodeId: node.nodeId, status: s }, headers: { 'x-operator-id': PROJECT } });
  await later.obj.webSocketClose(back, 1006, '', false);
  clock += 3 * MIN;
  await later.obj.alarm();
  assert.deepEqual([kept(), later.ctx.alarm], [JSON.stringify([node.nodeId]), null]);
  await status('suspended');
  assert.deepEqual([kept(), later.ctx.alarm], ['[]', null], 'out of service: not watched');
  lines.length = 0;
  await status('active');
  assert.equal(later.ctx.alarm, clock + D.TICK_MS);
  await later.obj.alarm();
  assert.equal(alerts().filter((l) => l.includes(`trusted node sao-paulo-1 (${node.nodeId}) offline for`)).length, 1);
});

test('the watch: tick lag over 8 ms in 3 heartbeats, traffic at 80 % of the cap, a verification waiting 30 minutes, an update deferred for 2 hours', async () => {
  const { h, env, node, ws } = await watched();
  for (let i = 0; i < 3; i++) await send(h, ws, { t: 'heartbeat', data: beat({ tickLagP99Ms: 9.5 }) });
  await h.ctx.settle();
  assert.deepEqual(posted(), [`**ALERT** \`node sao-paulo-1 (${node.nodeId}): tick lag p99 9.5 ms in 3 heartbeats in a row (over 8 ms: its matches stutter)\``], 'at the third heartbeat, not at an alarm');
  await send(h, ws, { t: 'heartbeat', data: beat({ egressGB: 850, egressCapGB: 1000 }) });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.match(posted()[1], /has sent 850\.0 GB of its 1000 GB monthly cap \(85 %\): at the cap it takes no more matches`$/);
  // A match its verifier has not answered for half an hour.
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  Object.assign(h.obj.cp.matches.get(placement.matchId), { state: 'verifying', report: { kind: 'ended', replaySha256: 'ab'.repeat(32) }, queuedAt: clock - 31 * MIN });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.match(posted()[2], new RegExp(`^\\*\\*ALERT\\*\\* \`1 match waiting for verification, the oldest \\(${placement.matchId.slice(0, 8)} on sao-paulo-1\\) for 31 min: is a verifier on its build online\\?\`$`));
  // The channel moves on; the node verifies matches of its build, so its update waits for them.
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await h.obj.alarm();
  assert.deepEqual(ws.of('update'), [], 'deferred');
  await h.obj.alarm();
  clock += 2 * 60 * MIN + D.TICK_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(posts.length, 4);
  assert.match(posted()[3], new RegExp(`node sao-paulo-1 \\(${node.nodeId}\\) still on 0\\.2\\.0, below the channel's minimum 0\\.3\\.0, for 2 h: its update is deferred or it does not take it\`$`));
});

test('the cron’s health check: a TLS error while the heartbeats look fine is an ALERT, once; a drain nobody asked for too, not one the control plane asked for', async () => {
  const { h, node, ws } = await watched();
  const health = async () => (await call(h, 'POST', '/internal/health')).json;
  assert.deepEqual(await health(), { probed: 1, problems: 0 });
  node.fail = () => {
    throw new TypeError('fetch failed: certificate has expired');
  };
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await send(h, ws, { t: 'heartbeat', data: beat() });
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await h.ctx.settle();
  assert.deepEqual(posted(), [`**ALERT** \`node sao-paulo-1 (${node.nodeId}) /healthz at https://sp1.turbo-gol.test: TLS error (an expired or invalid certificate?): TypeError: fetch failed: certificate has expired\``]);
  assert.equal(h.obj.cp.registry.node(node.nodeId).online, true, 'its heartbeats look fine');
  node.fail = null;
  lines.length = 0;
  assert.deepEqual(await health(), { probed: 1, problems: 0 });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1 (${node.nodeId}) /healthz answers again`));
  // A new problem is a new ALERT; past 10 minutes, the channel takes this node's again.
  clock += 10 * MIN;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  node.draining = true;
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await h.ctx.settle();
  assert.match(posted().at(-1), /: draining, and the control plane did not ask it to \(no drain, no update\)`$/);
  h.obj.cp.drain(node.nodeId, 'maintenance');
  assert.deepEqual(ws.of('drain'), [{ t: 'drain', reason: 'maintenance' }]);
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'a drain the control plane asked for');
  await send(h, ws, { t: 'hello', data: helloOf(node, { bootId: 'boot-2', draining: true }) });
  assert.deepEqual(await health(), { probed: 1, problems: 1 }, 'a new node process that drains: nobody asked that one');
  node.draining = false;
  h.obj.healthzTimeoutMs = 30;
  node.fail = () => new Promise(() => {});
  lines.length = 0;
  assert.deepEqual(await within(1_000, health(), 'the probe waited for a node that never answers'), { probed: 1, problems: 1 });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1 (${node.nodeId}) /healthz at https://sp1.turbo-gol.test still fails, now: no answer in 0.03 s`), lines.join('\n'));
  assert.deepEqual(alerts(), [], 'the same problem in another kind: no new ALERT');
  node.fail = null;
  await h.obj.webSocketClose(ws, 1006, '', false);
  assert.equal((await health()).probed, 1, 'offline, but seen within the hour');
  clock += 61 * MIN;
  assert.deepEqual(await health(), { probed: 0, problems: 0 }, 'gone for more than an hour: its offline ALERT went out');
});

test('the cron’s health check through a deploy: a drain asked before it is still expected, and so is the drain of a node below the channel’s minimum', async () => {
  const { h: before, env, node, ws } = await watched();
  before.obj.cp.drain(node.nodeId, 'maintenance');
  assert.equal(rows(before, 'meta').find((r) => r.k === 'drains_asked')?.v, JSON.stringify({ [node.nodeId]: 'boot-1' }), 'written down with the node process it went to');
  node.draining = true;
  // A deploy: every socket drops, and the same node process logs in again, still draining.
  ws.close(1012, 'deploy');
  const h = await boot(env, new FakeCtx(before.ctx.db));
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node, { draining: true }) });
  const health = async () => (await call(h, 'POST', '/internal/health')).json;
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'the drain asked before the deploy');
  // A new node process, a match on its build, and a channel that moves on: the verifier's update
  // waits for the match (no 'update' goes out), and the node drains by itself, as its welcome says.
  node.draining = false;
  await send(h, back, { t: 'hello', data: helloOf(node, { bootId: 'boot-2' }) });
  assert.ok((await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement);
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.alarm();
  assert.deepEqual(back.of('update'), [], 'deferred');
  node.draining = true;
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'below the minimum: an update');
  await h.ctx.settle();
  assert.deepEqual(posts, []);
});

test('the maintainers’ routes: a trusted account only; the list, status, drain, update and reprobe, each an ALERT naming the account', async () => {
  const { h, env, node, ws } = await watched();
  const admin = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
  const actor = 'admin Proyecto Señor (a1b2c3d4e5f60718)';
  const run = (method, what, body, headers = admin) => call(h, method, '/nodes/admin/' + what, { body, headers });
  for (const [m, w] of [['GET', 'nodes'], ['POST', 'drain'], ['POST', 'update']]) assert.equal((await run(m, w, m === 'POST' ? {} : undefined, { 'x-operator-id': STRANGER })).status, 403, w);
  assert.equal((await run('GET', 'status')).status, 404);
  assert.equal((await run('POST', 'reboot', { nodeId: node.nodeId })).status, 404);
  assert.equal((await run('POST', 'drain', { nodeId: 'nope' })).json.error, 'bad_node_id');
  assert.equal((await run('POST', 'drain', { nodeId: 'f'.repeat(16) })).json.error, 'no_node');
  // The list: everything about every node, its address and the matches held for it included.
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const list = await run('GET', 'nodes');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.json.channel, { stable: '0.2.0', minimum: '0.2.0' });
  const [v] = list.json.nodes;
  assert.deepEqual([v.nodeId, v.publicUrl, v.operator, v.status, v.online, v.matches, v.lastSeen], [node.nodeId, NODE_URL, { id: PROJECT, name: 'Proyecto Señor' }, 'active', true, 1, clock]);
  await h.ctx.settle();
  const read = `**ALERT** \`${actor}: read the nodes (1, with their addresses) (a maintainer's reads come here once per 30 min, every one is in the logs)\``;
  assert.deepEqual(posted(), [read], 'a read too: the list holds the addresses');
  // The same read again within the window: in the logs, not in the channel.
  assert.equal((await run('GET', 'nodes')).status, 200);
  await h.ctx.settle();
  assert.deepEqual(posted(), [read], 'one read line per window');
  assert.ok(lines.at(-1).endsWith(`${actor}: read the nodes (1, with their addresses)`), lines.at(-1));
  // The match ends: no work left on the node's build, so an update is not deferred.
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  // status
  assert.equal((await run('POST', 'status', { nodeId: node.nodeId, status: 'pending' })).json.error, 'bad_status');
  const st = await run('POST', 'status', { nodeId: node.nodeId, status: 'suspended', reason: 'disk\nfull' });
  assert.deepEqual(st.json, { nodeId: node.nodeId, name: 'sao-paulo-1', status: 'suspended', was: 'active' });
  assert.deepEqual(ws.of('status').at(-1), { t: 'status', status: 'suspended', reason: 'disk full' });
  assert.equal((await run('POST', 'status', { nodeId: node.nodeId, status: 'active' })).json.status, 'active');
  // drain
  const dr = await run('POST', 'drain', { nodeId: node.nodeId, reason: 'kernel update' });
  assert.deepEqual([dr.status, dr.json.draining], [200, true]);
  assert.deepEqual(ws.of('drain'), [{ t: 'drain', reason: 'kernel update' }]);
  // update: the channel read again now, not within the minute
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  const up = await run('POST', 'update');
  assert.deepEqual(up.json, { channel: { stable: '0.3.0', minimum: '0.3.0' }, below: [{ nodeId: node.nodeId, name: 'sao-paulo-1', version: '0.2.0' }] });
  assert.deepEqual(ws.of('update'), [{ t: 'update', version: '0.3.0' }], 'told once');
  assert.equal((await run('POST', 'update')).status, 200);
  assert.equal(ws.of('update').length, 2, 'asked again, told again');
  // reprobe: the control plane's probe and a direct one
  node.fail = () => {
    throw new TypeError('fetch failed: certificate has expired');
  };
  const rp = await run('POST', 'reprobe', { nodeId: node.nodeId });
  assert.deepEqual([rp.json.reachable, rp.json.healthz.kind], [true, 'tls'], 'one failed re-probe does not take a node out yet');
  node.fail = null;
  await h.ctx.settle();
  assert.deepEqual(posted(), [
    read,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) active -> suspended: disk full\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) suspended -> active\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) told to drain: kernel update\``,
    `**ALERT** \`${actor}: the nodes were told the channel again (stable 0.3.0, minimum 0.3.0): 1 online below its minimum\``,
    `**ALERT** \`${actor}: the nodes were told the channel again (stable 0.3.0, minimum 0.3.0): 1 online below its minimum\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) probed: TLS error (an expired or invalid certificate?): TypeError: fetch failed: certificate has expired; in wss placement\``,
  ], 'every call, the same one twice too, and more in a minute than the 5 alerts a minute');
  // A node offline is told nothing.
  await h.obj.webSocketClose(ws, 1006, '', false);
  const off = await run('POST', 'drain', { nodeId: node.nodeId });
  assert.deepEqual([off.status, off.json.error], [409, 'offline']);
  assert.ok(lines.at(-1).endsWith('not drained, it is offline: asked by a maintainer'), lines.at(-1));
});

// ---- cosmetic cars on node matches, the hosts' points kept, the maintainers' inventory routes ---------

const { REPEAT_WINDOW_MS, WINDOW_DAYS } = await import('../../nodes/control-plane/ledger.ts');
const C1 = 'c1c1c1c1c1c1c1c1';
const C2 = 'c2c2c2c2c2c2c2c2';

test('parsePlace keeps a known car with each human (for the rejoin answer) and drops one of another shape; nothing else changes', () => {
  const p = D.parsePlace(placeBody({ humans: [{ playerId: A, name: 'P0', car: 'tero', account: true, accountAgeDays: 9 }, { playerId: B, name: 'P1', car: 'ferrari' }] }));
  assert.deepEqual(p.humans, [{ playerId: A, name: 'P0', account: true, accountAgeDays: 9, car: 'tero' }, { playerId: B, name: 'P1' }]);
  assert.deepEqual(D.parsePlace(placeBody()).humans, humans(A, B), 'a placement without cars: as before');
});

test('a node match with cars: the assignment the node gets is byte for byte the one without (no car reaches a 0.3.0 node); the rejoin answer carries them, through a deploy too', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws } = await liveNode(h);
  const plain = await call(h, 'POST', '/internal/place', { body: placeBody() });
  const withCars = await call(h, 'POST', '/internal/place', { body: placeBody({ humans: [{ playerId: A, name: 'P0', car: 'tero' }, { playerId: B, name: 'P1' }] }) });
  assert.equal(withCars.status, 200, JSON.stringify(withCars.json));
  const assigns = ws.of('assign').map((m) => m.match);
  assert.equal(assigns.length, 2);
  // The id and the kickoff seed are random per match; everything else must be the same bytes.
  const bytes = (a) => JSON.stringify({ ...a, matchId: 'x', kickoffSeed: 0 });
  assert.equal(bytes(assigns[1]), bytes(assigns[0]));
  assert.ok(!JSON.stringify(ws.sent).includes('tero'), 'nothing the node is sent names a car');
  assert.deepEqual(Object.keys(assigns[1].roster[0]).sort(), ['kind', 'name', 'playerId', 'slot', 'team']);
  const id = withCars.json.placement.matchId;
  assert.deepEqual(JSON.parse(rows(h, 'node_matches').find((r) => r.match_id === id).data).humans[0], { playerId: A, name: 'P0', car: 'tero' }, 'kept with the match');
  let rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: B } });
  assert.deepEqual(rj.json.cars, ['tero', null]);
  rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: plain.json.placement.matchId, playerId: A } });
  assert.equal('cars' in rj.json, false, 'every seat on the default car: no field');
  ws.close(1012, 'deploy');
  h = await boot(env, new FakeCtx(h.ctx.db));
  rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: A } });
  assert.deepEqual([rj.status, rj.json.cars], [200, ['tero', null]], 'restored from the row');
});

/**
 * A placed match of `h` settled by hand, as the control plane settles one: `score` records its
 * ledger entry (at `at`, for `players`) and `freeze` is set, as applyVerdict does.
 */
async function settleByHand(h, { score = false, at = clock, players, freeze, outcome } = {}) {
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const m = h.obj.cp.matches.get(placement.matchId);
  m.state = 'done';
  m.doneAt = clock;
  m.ledger = score ? scoreOn(h, placement.matchId, at, players) : null;
  if (freeze) m.freeze = freeze;
  m.outcome = outcome ?? { kind: 'unrated', matchId: placement.matchId, nodeId: m.nodeId, blue: 1, red: 0, verified: true };
  h.obj.store.finished(m, m.outcome);
  return m;
}

/** A community operator's scored match (what ControlPlane.applyVerdict records), on `h`'s own ledger. */
const scoreOn = (h, matchId, at = clock, players = [A, B]) =>
  h.obj.cp.ledger.record(
    { matchId, nodeId: 'n1', operatorId: STRANGER, region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', players: players.map((p) => ({ playerId: p, connectedMs: 5 * 60_000, account: true, accountAgeDays: 30 })), tickLagP99Ms: 2, underrunRate: 0, at },
    1.5,
  );

test("the hosts' points: a scored match writes its ledger entry, its operator's totals and the /host-credit row in the transaction that settles it; a failed verification /host-freeze", async () => {
  const env = makeEnv();
  const h = await boot(env);
  await liveNode(h);
  const m = await settleByHand(h, { score: true });
  const e = m.ledger;
  const id = m.assign.matchId;
  assert.ok(e.points > 0);
  assert.deepEqual(rows(h, 'ledger_entries').map((r) => [r.match_id, r.operator_id]), [[id, STRANGER]]);
  assert.deepEqual(rows(h, 'ledger_totals').map((r) => ({ ...r })), [{ operator_id: STRANGER, earned: e.points, verified: 1 }]);
  assert.deepEqual(rows(h, 'outbox').map((r) => r.path), ['/host-credit', '/release'], 'in the same transaction as the settled row');
  await h.ctx.settle();
  const credit = env.ACCOUNTS.calls.find((c) => c.path === '/host-credit');
  assert.deepEqual(credit, { name: 'accounts-v1', path: '/host-credit', body: { matchId: id, userId: STRANGER, nodeId: 'n1', points: e.points, verified: true, at: clock } });
  assert.equal(rows(h, 'outbox').length, 0, 'delivered');
  // A failed verification: the operator's wallet freezes, with the time the match settled.
  clock += 1000;
  const f = await settleByHand(h, { freeze: { operatorId: STRANGER, reason: 'verification_failed:x' } });
  await h.ctx.settle();
  const freeze = env.ACCOUNTS.calls.find((c) => c.path === '/host-freeze');
  assert.deepEqual(freeze.body, { userId: STRANGER, reason: 'verification_failed:x', at: f.doneAt });
  // A match with neither (every project node's): no AccountsDO call at all.
  const before = env.ACCOUNTS.calls.length;
  await settleByHand(h);
  await h.ctx.settle();
  assert.equal(env.ACCOUNTS.calls.length, before);
  assert.equal(m.ledger, e);
});

test('the ledger survives a deploy: the leaderboard, the totals, /nodes/mine rewards and the 24 h repeat decay (its notes too); entries past 30 days go, their points stay in the totals', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws } = await liveNode(h);
  const old = (await settleByHand(h, { score: true, at: clock - (WINDOW_DAYS + 1) * 24 * 60 * 60_000, players: [C1, C2] })).ledger;
  assert.equal(rows(h, 'ledger_entries').length, 0, 'out of the window at once');
  const e1 = (await settleByHand(h, { score: true })).ledger;
  assert.equal(e1.repeat, 1);
  h.obj.cp.ledger.noteGroup(STRANGER, [B, A], clock + 1); // an unsampled match of the same group
  assert.equal(rows(h, 'ledger_notes').length, 1);
  await h.ctx.settle();
  ws.close(1012, 'deploy');
  clock += 60_000;
  h = await boot(env, new FakeCtx(h.ctx.db));
  const L = h.obj.cp.ledger;
  assert.equal(L.earned(STRANGER), Math.round((old.points + e1.points) * 100) / 100, 'all time');
  assert.equal(L.verifiedMatches(STRANGER), 2);
  assert.deepEqual(L.leaderboard(clock), [{ operatorId: STRANGER, points: e1.points }], 'the window only');
  const status = await call(h, 'GET', '/nodes/status');
  assert.deepEqual(status.json.hosts, [{ name: 'Anfitrión 1', points: e1.points }], 'a community operator by a number, never the start of its id');
  const mine = await call(h, 'GET', '/nodes/mine', { headers: { 'x-operator-id': STRANGER } });
  assert.deepEqual([mine.json.rewards.operatorId, mine.json.rewards.points30d, mine.json.rewards.matches30d, mine.json.rewards.earned], [STRANGER, e1.points, 1, L.earned(STRANGER)]);
  // The same group again within 24 h: the entry and the note before the deploy both count.
  const e2 = scoreOn(h, 'ef'.repeat(32));
  assert.equal(e2.repeat, 1 / 3);
  // A day later the decay is over (and the notes are pruned at the next start).
  clock += REPEAT_WINDOW_MS;
  assert.equal(scoreOn(h, '12'.repeat(32)).repeat, 1);
  h = await boot(env, new FakeCtx(h.ctx.db));
  assert.equal(rows(h, 'ledger_notes').length, 0);
});

test('the public list: only the nodes in service (probation, active, never retired); the project by its name, any other operator as "Anfitrión <n>" in the nodes and in the hosts, never its name, its id or the start of it', async () => {
  const env = makeEnv({ NODE_TRUSTED_OPERATORS: `${PROJECT},${STRANGER}`, NODE_TRUSTED_MAX_NODES: '4' });
  const h = await boot(env);
  const { ws } = await liveNode(h);
  const nodeNamed = async (name, ip, { op = PROJECT, roles = ['verify'], publicUrl = null } = {}) => {
    const who = { 'x-operator-id': op, 'x-operator-name': encodeURIComponent(op === PROJECT ? 'Proyecto Señor' : 'Vecino Real') };
    const t = await call(h, 'POST', '/nodes/tokens', { body: { region: 'SA', name }, headers: who });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    const keys = await generateEd25519();
    const body = { token: t.json.token, publicKey: keys.publicKey, roles, ...(publicUrl ? { transports: ['wss'], publicUrl } : {}), build: NODE_BUILD, specs: SPECS, capacity: CAP };
    const r = await call(h, 'POST', '/nodes/register', { body, headers: { 'x-client-ip': ip } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.nodeId;
  };
  const maint = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
  const admin = async (what, body) => assert.equal((await call(h, 'POST', '/nodes/admin/' + what, { body, headers: maint })).status, 200, what);
  await nodeNamed('pendiente', '203.0.113.31', { roles: ['host'], publicUrl: 'wss://sp2.turbo-gol.test' }); // never proven reachable
  await admin('status', { nodeId: await nodeNamed('baneado', '203.0.113.32'), status: 'banned', reason: 'test' });
  await admin('retire', { nodeId: await nodeNamed('retirado', '203.0.113.33'), reason: 'test' });
  await admin('status', { nodeId: await nodeNamed('suspendido', '203.0.113.34'), status: 'suspended', reason: 'test' });
  clock += 1000;
  await nodeNamed('vecino-1', '203.0.113.35', { op: STRANGER });
  // A deploy with STRANGER out of NODE_TRUSTED_OPERATORS: its node is a community one in probation.
  ws.close(1012, 'deploy');
  await h.ctx.settle();
  const h2 = await boot({ ...env, NODE_TRUSTED_OPERATORS: PROJECT }, new FakeCtx(h.ctx.db));
  const e = scoreOn(h2, 'ab'.repeat(32));
  const s = await call(h2, 'GET', '/nodes/status');
  assert.equal(s.status, 200);
  assert.deepEqual(
    s.json.nodes.map((n) => [n.name, n.status, n.operator, n.trusted]).sort(),
    [
      ['sao-paulo-1', 'active', 'Proyecto Señor', true],
      ['vecino-1', 'probation', 'Anfitrión 1', false],
    ],
  );
  assert.deepEqual(s.json.hosts, [{ name: 'Anfitrión 1', points: e.points }], 'the same number as in the nodes');
  const text = JSON.stringify(s.json);
  for (const id of [PROJECT, STRANGER]) assert.ok(!text.includes(id.slice(0, 6)), 'no operator id, not even its start');
  assert.ok(!text.includes('Vecino Real'), "a community operator's name is never shown");
  // The panel still sees every node, and each operator its own: only the public list is filtered.
  assert.equal((await call(h2, 'GET', '/nodes/admin/nodes', { headers: maint })).json.nodes.length, 6);
  assert.equal((await call(h2, 'GET', '/nodes/mine', { headers: { 'x-operator-id': PROJECT } })).json.nodes.length, 4, 'every node but the retired one');
});

test('the public list is a 200 with { build, nodes, hosts } when it is empty too: the deploy check asks for one (scripts/deploy-check.mjs)', async () => {
  const h = await boot(makeEnv());
  const s = await call(h, 'GET', '/nodes/status');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { build: CLIENT_BUILD, nodes: [], hosts: [] });
});

test("the maintainers' inventory routes: grant, revoke and unfreeze go to AccountsDO as they are answered, each an ALERT naming the account; a trusted account only", async () => {
  const { h, env } = await watched();
  env.ACCOUNTS.answer = (name, path, body) => new RealResponse(JSON.stringify(path === '/host-unfreeze' ? { unfrozen: true } : path === '/host-grant' ? { granted: true, items: [body.item] } : { revoked: true, refunded: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
  const admin = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
  const run = (what, body, headers = admin) => call(h, 'POST', '/nodes/admin/' + what, { body, headers });
  assert.equal((await run('grant', { account: A, item: 'tero' }, { 'x-operator-id': STRANGER })).status, 403);
  assert.equal((await run('grant', { account: 'nope', item: 'tero' })).json.error, 'bad_account');
  assert.equal((await run('grant', { account: A, item: 'car-next-1' })).json.error, 'unknown_item');
  assert.equal((await run('revoke', { account: A })).json.error, 'unknown_item');
  assert.equal(env.ACCOUNTS.calls.length, 0, 'nothing reached AccountsDO');
  const g = await run('grant', { account: A, item: 'tero' });
  assert.deepEqual([g.status, g.json], [200, { granted: true, items: ['tero'] }]);
  assert.deepEqual((await run('revoke', { account: A, item: 'tero' })).json, { revoked: true, refunded: 0, items: [] });
  assert.deepEqual((await run('unfreeze', { account: B, item: 'ignored' })).json, { unfrozen: true });
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.name, c.path, c.body]), [
    ['accounts-v1', '/host-grant', { userId: A, item: 'tero' }],
    ['accounts-v1', '/host-revoke', { userId: A, item: 'tero' }],
    ['accounts-v1', '/host-unfreeze', { userId: B }],
  ]);
  // AccountsDO's refusal is passed on as it is.
  env.ACCOUNTS.answer = () => new RealResponse('{"error":"no_user"}', { status: 404 });
  assert.deepEqual((await run('grant', { account: A, item: 'pampero' })).json, { error: 'no_user' });
  await h.ctx.settle();
  const actor = 'admin Proyecto Señor (a1b2c3d4e5f60718)';
  assert.deepEqual(posted().map((p) => p.replace(/ -> (\d+) .*`$/, ' -> $1`')), [
    `**ALERT** \`${actor}: grant tero for account ${A} -> 200\``,
    `**ALERT** \`${actor}: revoke tero for account ${A} -> 200\``,
    `**ALERT** \`${actor}: unfreeze for account ${B} -> 200\``,
    `**ALERT** \`${actor}: grant pampero for account ${A} -> 404\``,
  ]);
});

// ---- the maintainers' panel (prompt 1, PR 1): tokens, retire, guards, trust, the overview, reads --------

const ADMIN = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
const ACTOR = 'admin Proyecto Señor (a1b2c3d4e5f60718)';
const { REGIONS } = await import('../../src/net/account.ts');
const { KV_FLAGS } = await import('../src/env.ts');

/**
 * A community operator's node (STRANGER's), registered with a token the registry mints directly:
 * the token route stays the project's while hosting is closed. Seen from its token's continent, as
 * a community node must be (hosting.test.mjs checks the rule).
 */
async function communityNode(h, { ip = '198.51.100.40', publicUrl = 'wss://juan.turbo-gol.test' } = {}) {
  const { token } = await h.obj.cp.registry.createToken({ id: STRANGER, name: 'Juan' }, 'SA', clock);
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', { body: { token, publicKey: keys.publicKey, roles: ['host'], publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP }, headers: { 'x-client-ip': ip, 'x-client-continent': 'SA' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...r.json, key: await importPrivateKey(keys.privateKey), publicUrl };
}

test('panel tokens: publicHost, roles, matches and egressCapGB checked, then composed into a shell-safe install line; at the cap no token at all (409, an ALERT); the registration stays on the pinned host, never an IP address', async () => {
  const env = makeEnv({ NODE_TRUSTED_MAX_NODES: '3', NODE_ALERT_WEBHOOK: HOOK });
  const h = await boot(env);
  const ask = (body) => call(h, 'POST', '/nodes/tokens', { body: { region: 'EU', ...body }, headers: ADMIN });
  const t = await ask({ name: 'frankfurt-1', publicHost: 'DE1.Turbo-Gol.test', roles: ['host', 'verify'], matches: 12, egressCapGB: 2000 });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(
    t.json.install.linux,
    `curl -fsSL ${BASE}/nodes/releases/install.sh | sudo bash -s -- --control ${BASE} --token ${t.json.token} --name frankfurt-1 --roles host,verify --transport wss --public-host de1.turbo-gol.test --matches 12 --egress-cap-gb 2000`,
  );
  assert.match(t.json.install.linux, /^[A-Za-z0-9 .:/|,_-]+$/, 'nothing a shell reads as more than words');
  const rec = h.obj.cp.registry.tokenList().at(-1);
  assert.deepEqual([rec.publicHost, rec.roles, rec.region, rec.name], ['de1.turbo-gol.test', ['host', 'verify'], 'EU', 'frankfurt-1']);
  assert.match((await ask({ roles: 'verify,host', matches: 'auto' })).json.install.linux, / --roles host,verify --matches auto$/);
  for (const [body, code] of [
    [{ publicHost: '203.0.113.7' }, 'bad_public_host'],
    [{ publicHost: '[2001:db8::1]' }, 'bad_public_host'],
    [{ publicHost: 'de1.turbo-gol.test:8443' }, 'bad_public_host'],
    [{ publicHost: 'https://de1.turbo-gol.test' }, 'bad_public_host'],
    [{ publicHost: 'localhost' }, 'bad_public_host'],
    [{ publicHost: 'de1.localhost' }, 'bad_public_host'],
    [{ publicHost: 'box.local' }, 'bad_public_host'],
    [{ publicHost: 'node.internal' }, 'bad_public_host'],
    [{ publicHost: 'de1.turbo-gol.test;reboot' }, 'bad_public_host'],
    [{ publicHost: 'de1.turbo-gol.test', roles: ['verify'] }, 'bad_roles'],
    [{ roles: ['host', 'admin'] }, 'bad_roles'],
    [{ roles: [] }, 'bad_roles'],
    [{ matches: 0 }, 'bad_matches'],
    [{ matches: 201 }, 'bad_matches'],
    [{ matches: '12' }, 'bad_matches'],
    [{ egressCapGB: 0 }, 'bad_egress_cap'],
    [{ egressCapGB: 1.5 }, 'bad_egress_cap'],
    [{ name: 'Proyecto Señor' }, 'bad_name'],
    [{ name: '$(id)' }, 'bad_name'],
  ]) {
    const r = await ask(body);
    assert.deepEqual([r.status, r.json.error], [400, code], JSON.stringify(body));
  }
  assert.equal(h.obj.cp.registry.tokenList().length, 2, 'none of them made a token');
  // The registration: the pinned token on another host, or on an IP address, is refused and stays good.
  const keys = await generateEd25519();
  const register = (token, publicUrl) =>
    call(h, 'POST', '/nodes/register', { body: { token, publicKey: keys.publicKey, roles: ['host', 'verify'], publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP }, headers: { 'x-client-ip': '203.0.113.50' } });
  assert.deepEqual((await register(t.json.token, 'wss://de2.turbo-gol.test')).json.error, 'public_host_mismatch');
  assert.deepEqual((await register(t.json.token, 'wss://203.0.113.9')).json.error, 'public_host_mismatch');
  const free = await ask({});
  assert.deepEqual((await register(free.json.token, 'wss://203.0.113.9')).json.error, 'ip_not_supported', 'an IP address, for every registration');
  const de = await register(t.json.token, 'wss://de1.turbo-gol.test');
  assert.equal(de.status, 200, JSON.stringify(de.json));
  assert.deepEqual([de.json.region, de.json.name, h.obj.cp.registry.node(de.json.nodeId).publicHost], ['EU', 'frankfurt-1', 'de1.turbo-gol.test']);
  // Three nodes (the var): a fourth token is refused before it exists, and costs none of the 10 a day.
  await registerNode(h, { publicUrl: 'wss://sp2.turbo-gol.test' });
  await registerNode(h, { ip: '203.0.113.2', publicUrl: 'wss://sp3.turbo-gol.test' });
  const before = h.obj.cp.registry.tokenList().length;
  const full = await ask({ name: 'kuala-lumpur-1' });
  assert.deepEqual([full.status, full.json.error], [409, 'too_many_nodes']);
  assert.equal(h.obj.cp.registry.tokenList().length, before, 'no token');
  // Retiring one (never connected: offline) frees its slot.
  assert.equal((await call(h, 'POST', '/nodes/admin/retire', { body: { nodeId: de.json.nodeId, reason: 'test' }, headers: ADMIN })).status, 200);
  assert.equal((await ask({ name: 'kuala-lumpur-1' })).status, 200);
  await h.ctx.settle();
  assert.ok(posted().includes(`**ALERT** \`admin Proyecto Señor (${PROJECT}): no token created, the operator already has its 3 nodes\``), posted().join('\n'));
});

test('retire: only a node offline, or drained with no open match; its socket closes (4403) and every login is refused; out of the cap, /nodes/mine, the operator counts, placement, the cron and the watch; kept in the panel; audited', async () => {
  const { h, env, node, ws } = await watched();
  const run = (what, body) => call(h, 'POST', '/nodes/admin/' + what, { body, headers: ADMIN });
  assert.deepEqual((await run('retire', { nodeId: node.nodeId })).json.error, 'reason_required');
  let r = await run('retire', { nodeId: node.nodeId, reason: 'moved' });
  assert.deepEqual([r.status, r.json.error], [409, 'not_retirable'], 'online and not drained');
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  assert.ok(placement);
  assert.equal((await run('drain', { nodeId: node.nodeId, reason: 'moving' })).status, 200);
  await send(h, ws, { t: 'heartbeat', data: beat({ draining: true, active: 1 }) });
  r = await run('retire', { nodeId: node.nodeId, reason: 'moved' });
  assert.deepEqual([r.status, r.json.error], [409, 'not_retirable'], 'drained, one match open');
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  await send(h, ws, { t: 'heartbeat', data: beat({ draining: true, active: 0 }) });
  r = await run('retire', { nodeId: node.nodeId, reason: 'moved to a new machine' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.retiredAt, r.json.retiredReason, r.json.slots], [clock, 'moved to a new machine', { used: 0, max: 2 }]);
  assert.deepEqual(ws.closed, { code: 4403, reason: 'retired' });
  // Its next login: refused as a banned node's is.
  await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  const again = h.ctx.sockets.at(-1);
  await h.obj.webSocketMessage(again, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, again.of('challenge')[0].nonce)) }));
  assert.deepEqual([again.of('error'), again.closed], [[{ t: 'error', code: 'retired' }], { code: 4403, reason: 'retired' }]);
  // Off the operator's books, still in the panel.
  assert.deepEqual((await call(h, 'GET', '/nodes/mine', { headers: ADMIN })).json.nodes, []);
  assert.deepEqual((await call(h, 'GET', '/internal/operators')).json.operators, []);
  const ov = (await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN })).json;
  assert.deepEqual([ov.nodes.length, ov.nodes[0].retiredAt, ov.nodes[0].retiredReason, ov.operator.slotsUsed], [1, r.json.retiredAt, 'moved to a new machine', 0]);
  assert.equal((await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement, null, 'no match');
  assert.deepEqual((await call(h, 'POST', '/internal/health')).json, { probed: 0, problems: 0 }, 'the cron probes it no more');
  for (let i = 0; i < 6; i++) {
    clock += MIN;
    await h.obj.alarm();
  }
  assert.deepEqual((await run('status', { nodeId: node.nodeId, status: 'active' })).json.error, 'retired');
  assert.deepEqual((await run('retire', { nodeId: node.nodeId, reason: 'again' })).json.error, 'already_retired');
  await h.ctx.settle();
  const out = posted();
  assert.ok(out.includes(`**ALERT** \`${ACTOR}: node sao-paulo-1 (${node.nodeId}) (active, trusted) retired: moved to a new machine\``), out.join('\n'));
  assert.ok(!out.some((p) => / offline for /.test(p)), 'a retired node switched off never alarms');
  // Through a deploy: retired still.
  const back = await boot(env, new FakeCtx(h.ctx.db));
  assert.equal(back.obj.cp.registry.node(node.nodeId).retiredReason, 'moved to a new machine');
});

test('status guards: active for a node that is not trusted needs { force: true, reason }; a host never proven reachable is never set in service, through a ban either; a ban needs a reason; a trusted banned node leaves its ban only into a free slot', async () => {
  const h = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK }));
  const juan = await communityNode(h);
  const run = (body) => call(h, 'POST', '/nodes/admin/status', { body: { nodeId: juan.nodeId, ...body }, headers: ADMIN });
  const unproven = async (what) => {
    for (const status of ['probation', 'active']) {
      const r = await run({ status, force: true, reason: 'step' });
      assert.deepEqual([r.status, r.json.error], [409, 'not_reachable'], `${what} -> ${status}`);
    }
  };
  await unproven('pending');
  // Its probe never passed, whatever status it leaves: a ban, or a suspension, skips nothing.
  assert.equal((await run({ status: 'banned', reason: 'step' })).json.status, 'banned');
  await unproven('banned');
  assert.equal((await run({ status: 'suspended', reason: 'it may log in and be probed' })).json.status, 'suspended');
  await unproven('suspended');
  // Proven (its probe passed while suspended): in service again.
  h.obj.cp.registry.markReachable(juan.nodeId, clock);
  assert.equal(h.obj.cp.registry.node(juan.nodeId).status, 'suspended', 'the probe moves only a pending node');
  assert.equal((await run({ status: 'probation' })).json.status, 'probation');
  assert.deepEqual((await run({ status: 'active' })).json.error, 'force_required');
  assert.deepEqual((await run({ status: 'active', force: true })).json.error, 'force_required', 'a forced one needs its reason');
  assert.deepEqual((await run({ status: 'active', reason: 'trust me' })).json.error, 'force_required');
  assert.deepEqual((await run({ status: 'banned' })).json.error, 'reason_required');
  assert.equal(h.obj.cp.registry.node(juan.nodeId).status, 'probation', 'none of them changed it');
  const forced = await run({ status: 'active', force: true, reason: 'verified by hand' });
  assert.deepEqual([forced.status, forced.json.status], [200, 'active']);
  assert.equal((await run({ status: 'banned', reason: 'cheating' })).json.status, 'banned');
  await h.ctx.settle();
  assert.ok(posted().includes(`**ALERT** \`${ACTOR}: node sa-node-1 (${juan.nodeId}) probation -> active (forced, its verified matches skipped): verified by hand\``), posted().join('\n'));
  assert.ok(posted().includes(`**ALERT** \`${ACTOR}: node sa-node-1 (${juan.nodeId}) active -> banned: cheating\``));
  // A trusted operator's banned node takes no slot: out of its ban it takes one again, so at the cap
  // (2 here) it stays banned, with an ALERT, as a token is refused there. Else ban, register, unban
  // would add a trusted node past the cap with every token.
  const set = (nodeId, body) => call(h, 'POST', '/nodes/admin/status', { body: { nodeId, ...body }, headers: ADMIN });
  const t1 = await registerNode(h, { publicUrl: 'wss://t1.turbo-gol.test' });
  const t2 = await registerNode(h, { publicUrl: 'wss://t2.turbo-gol.test' });
  for (const t of [t1, t2]) h.obj.cp.registry.markReachable(t.nodeId, clock);
  assert.equal((await set(t1.nodeId, { status: 'banned', reason: 'a bad first install' })).status, 200);
  assert.deepEqual(h.obj.cp.registry.slots(PROJECT), { used: 1, max: 2 });
  const t3 = await registerNode(h, { publicUrl: 'wss://t3.turbo-gol.test' });
  for (const status of ['active', 'probation', 'suspended']) {
    const r = await set(t1.nodeId, { status, reason: 'unban' });
    assert.deepEqual([r.status, r.json.error], [409, 'too_many_nodes'], status);
  }
  assert.deepEqual([h.obj.cp.registry.node(t1.nodeId).status, h.obj.cp.registry.slots(PROJECT)], ['banned', { used: 2, max: 2 }], 'never past the cap');
  // A trusted host never proven reachable (t3: pending) skips its probe through a ban neither.
  assert.equal((await set(t3.nodeId, { status: 'banned', reason: 'step' })).json.status, 'banned');
  assert.deepEqual((await set(t3.nodeId, { status: 'active' })).json.error, 'not_reachable');
  // A slot free (t3 retired: it never connected): the same unban goes through.
  assert.equal((await call(h, 'POST', '/nodes/admin/retire', { body: { nodeId: t3.nodeId, reason: 'test' }, headers: ADMIN })).status, 200);
  const back = await set(t1.nodeId, { status: 'active', reason: 'unban' });
  assert.deepEqual([back.status, back.json.was, back.json.status], [200, 'banned', 'active']);
  assert.deepEqual(h.obj.cp.registry.slots(PROJECT), { used: 2, max: 2 });
  await h.ctx.settle();
  assert.ok(posted().includes(`**ALERT** \`${ACTOR}: node sao-paulo-1 (${t1.nodeId}) stays banned (not set active), the operator already has its 2 nodes\``), posted().join('\n'));
});

test('trust lost at a deploy: a trusted node whose account left NODE_TRUSTED_OPERATORS starts in probation, 0 of 20, with one ALERT, once; the overview marks it; active again only forced', async () => {
  const MAINT = 'b1b2c3d4e5f60718';
  const env = makeEnv({ NODE_TRUSTED_OPERATORS: `${PROJECT},${MAINT}`, NODE_ALERT_WEBHOOK: HOOK });
  const h = await boot(env);
  const { node, ws } = await liveNode(h);
  assert.equal(h.obj.cp.registry.node(node.nodeId).status, 'active');
  ws.close(1012, 'deploy');
  await h.ctx.settle();
  posts.length = 0;
  const moved = { ...env, NODE_TRUSTED_OPERATORS: MAINT };
  const h2 = await boot(moved, new FakeCtx(h.ctx.db));
  const n = h2.obj.cp.registry.node(node.nodeId);
  assert.deepEqual([n.trusted, n.status, n.statusReason, n.counters.probationVerified, n.trustRemovedAt], [false, 'probation', 'trust_removed', 0, clock]);
  await h2.ctx.settle();
  assert.deepEqual(posted().filter((p) => p.includes('lost its trust')), [
    `**ALERT** \`node sao-paulo-1 (${node.nodeId}) of Proyecto Señor (${PROJECT}) lost its trust (the operator is no longer in NODE_TRUSTED_OPERATORS): active -> probation, 0 of 20 verified matches\``,
  ]);
  const maint = { 'x-operator-id': MAINT, 'x-operator-name': 'Mantenedor' };
  const ov = (await call(h2, 'GET', '/nodes/admin/overview', { headers: maint })).json;
  assert.deepEqual([ov.nodes[0].trustRemovedAt, ov.nodes[0].trusted], [clock, false]);
  assert.ok(ov.warnings.some((w) => w.kind === 'trust_removed' && w.nodeId === node.nodeId));
  assert.deepEqual((await call(h2, 'POST', '/nodes/admin/status', { body: { nodeId: node.nodeId, status: 'active' }, headers: maint })).json.error, 'force_required');
  // The next start: the row says untrusted already, nothing again.
  posts.length = 0;
  const h3 = await boot(moved, new FakeCtx(h.ctx.db));
  await h3.ctx.settle();
  assert.deepEqual(posted(), []);
  assert.equal(h3.obj.cp.registry.node(node.nodeId).status, 'probation');
});

test('revoking a token: by the short id the overview lists (never the token); it registers nothing after; a used one 409, an unknown one 404; audited', async () => {
  const h = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK }));
  const t = await tokenFor(h);
  const ov = await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN });
  const text = JSON.stringify(ov.json);
  assert.ok(!text.includes(t.json.token) && !text.includes('tgn1_'), 'no token in the overview');
  const [view] = ov.json.tokens;
  assert.deepEqual([view.id.length, view.state, view.region, view.name, view.usedBy, view.publicHost], [12, 'unused', 'SA', 'sao-paulo-1', null, null]);
  const revoke = (id) => call(h, 'POST', '/nodes/admin/tokens/revoke', { body: { id }, headers: ADMIN });
  assert.deepEqual((await revoke(view.id)).json, { id: view.id, revoked: true, already: false });
  assert.deepEqual((await revoke(view.id)).json, { id: view.id, revoked: true, already: true });
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', { body: { token: t.json.token, publicKey: keys.publicKey, roles: ['host'], publicUrl: NODE_URL, build: NODE_BUILD, specs: SPECS, capacity: CAP }, headers: { 'x-client-ip': '198.51.100.60' } });
  assert.deepEqual([r.status, r.json.error], [403, 'token_revoked']);
  assert.equal((await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN })).json.tokens[0].state, 'revoked');
  const used = await registerNode(h);
  const usedId = (await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN })).json.tokens.find((x) => x.usedBy === used.nodeId).id;
  assert.deepEqual([(await revoke(usedId)).status, (await revoke(usedId)).json.error], [409, 'token_used']);
  assert.deepEqual([(await revoke('f'.repeat(12))).status, (await revoke('f'.repeat(12))).json.error], [404, 'no_token']);
  assert.deepEqual((await revoke('nope')).json.error, 'bad_token_id');
  await h.ctx.settle();
  assert.equal(posted().filter((p) => p.includes(`: token ${view.id} (SA, sao-paulo-1) revoked`)).length, 1, 'once: the second revoke changed nothing');
});

test('the overview: every node in full (specs, last probe, link cuts, pins), the slots, tokens, regions, verifiers, queue, outbox, the eight KV flags (read once a minute) and the warnings', async () => {
  const kv = { nodes_on: '1', replays_off: 'true', vm_disabled: '0' };
  let kvReads = 0;
  const FLAGS = {
    get: async (k) => {
      kvReads++;
      return kv[k] ?? null;
    },
  };
  const NODE_RELEASES = bucket({ 'channel.json': JSON.stringify({ stable: '0.3.0', minimum: '0.2.0' }) });
  const { h, node, ws } = await watched({ FLAGS, NODE_RELEASES });
  const two = await liveNode(h, { ip: '203.0.113.2', publicUrl: 'wss://sp2.turbo-gol.test' });
  await send(h, two.ws, { t: 'hello', data: helloOf(two.node, { specs: { ...SPECS, node: '22' } }) });
  await h.obj.webSocketClose(two.ws, 1006, '', false);
  const mark = lines.length;
  const res = await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const o = res.json;
  assert.deepEqual([o.build, o.channel, o.verifying], [CLIENT_BUILD, { stable: '0.3.0', minimum: '0.2.0' }, 0]);
  assert.deepEqual(o.operator, { id: PROJECT, name: 'Proyecto Señor', slotsUsed: 2, slotsMax: 2 });
  const v = o.nodes.find((x) => x.nodeId === node.nodeId);
  assert.deepEqual(
    [v.publicUrl, v.operator, v.status, v.online, v.specs, v.capacityMax, typeof v.reachableAt, v.lastProbe.ok, v.lastProbe.error, v.probeFailures, v.strikeTimes, v.pauseTimes, v.publicHost, v.retiredAt, v.trustRemovedAt, v.linkCuts],
    [NODE_URL, { id: PROJECT, name: 'Proyecto Señor' }, 'active', true, SPECS, 4, 'number', true, null, 0, [], [], null, null, null, { count24h: 0, lastAt: null }],
  );
  assert.deepEqual(o.nodes.find((x) => x.nodeId === two.node.nodeId).linkCuts, { count24h: 1, lastAt: clock }, 'its link closed once');
  assert.deepEqual(o.tokens.map((t) => [t.state, t.operatorId]), [['used', PROJECT], ['used', PROJECT]]);
  assert.deepEqual(o.regions.map((r) => r.region), REGIONS.map((r) => r.id));
  const sa = o.regions.find((r) => r.region === 'SA');
  assert.deepEqual([sa.hostsOnline, sa.slots, sa.active, sa.matches, sa.unplaced, sa.rankedReady, typeof sa.regionFactor], [1, 4, 0, 0, 0, true, 'number']);
  const eu = o.regions.find((r) => r.region === 'EU');
  assert.deepEqual([eu.hostsOnline, eu.slots, eu.rankedReady], [0, 0, false]);
  assert.deepEqual(o.verifiers.find((x) => x.nodeId === node.nodeId), { nodeId: node.nodeId, name: 'sao-paulo-1', region: 'SA', version: '0.2.0', node: '24', status: 'active', online: true, verifying: 0 });
  assert.deepEqual([o.verifyQueue, o.outbox], [[], { rows: 0, byPath: [] }]);
  assert.deepEqual(o.flags.map((f) => f.name), [...KV_FLAGS]);
  assert.deepEqual(o.flags.find((f) => f.name === 'nodes_on'), { name: 'nodes_on', raw: '1', set: true, meaning: "every player: their Casual and ranked matches may go to a node" });
  assert.deepEqual(o.flags.filter((f) => f.set).map((f) => f.name), ['nodes_on', 'replays_off']);
  assert.deepEqual(o.alerts, { webhook: true });
  assert.deepEqual(o.warnings.map((w) => w.kind).sort(), ['trusted_off_channel', 'trusted_off_channel', 'verifier_node_versions']);
  assert.deepEqual(o.warnings.find((w) => w.kind === 'verifier_node_versions').nodes.map((x) => x.node).sort(), ['22', '24']);
  // Ten reads in five minutes: one line in the channel, ten in the logs; the flags read once a minute
  // (the eight and the opening's, node_operators, which the overview shows apart: closed, the terms not in force).
  assert.equal(kvReads, KV_FLAGS.length + 1);
  assert.deepEqual([o.hosting.flag, o.hosting.raw, o.hosting.stage, o.hosting.terms.inForce, o.hosting.changes], ['node_operators', null, 'closed', false, []]);
  for (let i = 1; i < 10; i++) {
    clock += 30_000;
    assert.equal((await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN })).status, 200);
  }
  assert.ok(kvReads <= (KV_FLAGS.length + 1) * 5, `${kvReads} KV reads`);
  await h.ctx.settle();
  const reads = () => posted().filter((p) => p.includes(': read '));
  assert.deepEqual(reads(), [`**ALERT** \`${ACTOR}: read the overview (2 nodes, with their addresses, and 2 tokens) (a maintainer's reads come here once per 30 min, every one is in the logs)\``]);
  assert.equal(lines.slice(mark).filter((l) => l.includes(`${ACTOR}: read the overview`)).length, 10);
  // The other reads share the window, the Worker's (account-stats) too; actions are posted each time.
  await call(h, 'GET', '/nodes/admin/nodes', { headers: ADMIN });
  assert.equal((await call(h, 'POST', '/internal/read-audit', { body: { what: 'account-stats' }, headers: ADMIN })).status, 200);
  assert.equal((await call(h, 'POST', '/internal/read-audit', { body: { what: 'account-stats' }, headers: { 'x-operator-id': STRANGER } })).status, 403);
  assert.equal((await call(h, 'POST', '/internal/read-audit', { body: { what: 'everything' }, headers: ADMIN })).status, 400);
  await call(h, 'POST', '/nodes/admin/update', { headers: ADMIN });
  await h.ctx.settle();
  assert.equal(reads().length, 1);
  assert.equal(posted().filter((p) => p.includes('were told the channel again')).length, 1);
  // A new window after 30 minutes, kept through a restart in meta.
  clock += 30 * MIN;
  assert.equal((await call(h, 'POST', '/internal/read-audit', { body: { what: 'queue-stats' }, headers: ADMIN })).status, 200);
  await h.ctx.settle();
  assert.equal(reads().at(-1), `**ALERT** \`${ACTOR}: read the queue counters (a maintainer's reads come here once per 30 min, every one is in the logs)\``);
  ws.close(1012, 'deploy');
  const after = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK }), new FakeCtx(h.ctx.db));
  posts.length = 0;
  await call(after, 'GET', '/nodes/admin/overview', { headers: ADMIN });
  await after.ctx.settle();
  assert.deepEqual(posted().filter((p) => p.includes(': read ')), [], 'the window outlived the deploy');
});

test('the points tab: a wallet (AccountsDO /shop and /items) and the frozen wallets (/host-frozen), as AccountsDO answers; the reads share the window; grant, revoke and unfreeze carry their reason into the audit line', async () => {
  const { h, env } = await watched();
  const reason = 'verification_failed:' + 'f'.repeat(64);
  env.ACCOUNTS.answer = (name, path, body) => {
    const j = (v, status = 200) => new RealResponse(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === `/shop?userId=${A}`) return j({ items: [{ id: 'tero', cost: 300, claimable: false }], wallet: { earned: 12.5, spent: 0, balance: 12.5, frozen: reason } });
    if (path === `/items?userId=${A}`) return j({ items: ['badge-host'], car: 'pampero', cars: ['pampero'] });
    if (path === '/host-frozen') return j({ frozen: [{ account: A, reason, at: 1234 }], more: false });
    if (path.startsWith('/shop?') || path.startsWith('/items?')) return j({ error: 'no_user' }, 404);
    return j(path === '/host-unfreeze' ? { unfrozen: true } : { granted: true, items: [body?.item] });
  };
  assert.deepEqual((await call(h, 'GET', '/nodes/admin/wallet?account=nope', { headers: ADMIN })).json.error, 'bad_account');
  assert.equal(env.ACCOUNTS.calls.length, 0);
  const w = await call(h, 'GET', `/nodes/admin/wallet?account=${A}`, { headers: ADMIN });
  assert.equal(w.headers.get('cache-control'), 'no-store');
  assert.deepEqual(w.json, { account: A, wallet: { earned: 12.5, spent: 0, balance: 12.5, frozen: reason }, items: ['badge-host'], car: 'pampero', catalog: [{ id: 'tero', cost: 300, claimable: false }] });
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.path, c.body]).sort(), [[`/items?userId=${A}`, null], [`/shop?userId=${A}`, null]]);
  const none = await call(h, 'GET', `/nodes/admin/wallet?account=${B}`, { headers: ADMIN });
  assert.deepEqual([none.status, none.json], [404, { error: 'no_user' }]);
  const fz = await call(h, 'GET', '/nodes/admin/frozen', { headers: ADMIN });
  assert.deepEqual([fz.status, fz.json, fz.headers.get('cache-control')], [200, { frozen: [{ account: A, reason, at: 1234 }], more: false }, 'no-store']);
  assert.equal((await call(h, 'POST', '/nodes/admin/unfreeze', { body: { account: A, reason: 'replay\nchecked by hand' }, headers: ADMIN })).status, 200);
  assert.equal((await call(h, 'POST', '/nodes/admin/grant', { body: { account: A, item: 'tero' }, headers: ADMIN })).status, 200);
  await h.ctx.settle();
  assert.deepEqual(posted().map((p) => p.replace(/ -> (\d+) .*`$/, ' -> $1`')), [
    `**ALERT** \`${ACTOR}: read the wallet of account ${A} (a maintainer's reads come here once per 30 min, every one is in the logs)\``,
    `**ALERT** \`${ACTOR}: unfreeze for account ${A} (replay checked by hand) -> 200\``,
    `**ALERT** \`${ACTOR}: grant tero for account ${A} -> 200\``,
  ]);
});

// ---- the control socket under a flood of anonymous upgrades -----------------------------------------

/** Open /nodes/connect from `ip` (the Worker's x-client-ip) and hand back the socket; nothing is answered yet. */
async function upgrade(h, ip) {
  const headers = { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' };
  if (ip) headers['x-client-ip'] = ip;
  const res = await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers }));
  assert.equal(res.upgraded, true);
  return h.ctx.sockets.at(-1);
}

/** The node answers the challenge its socket got. */
async function logIn(h, ws, node) {
  const challenge = ws.of('challenge')[0];
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, challenge.nonce)) }));
}

test('anonymous upgrades from one network churn their own sockets: a node between its challenge and its login is not pushed out', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h);
  const ws = await upgrade(h, '198.51.100.20');
  answer(h, ws, node);
  const flood = [];
  for (let i = 1; i <= 100; i++) flood.push(await upgrade(h, `2001:db8:6:7::${i.toString(16)}`));
  assert.equal(ws.closed, null, 'the node socket stays open');
  await logIn(h, ws, node);
  assert.equal(ws.of('welcome').length, 1, 'logged in after the flood');
  assert.equal(flood.filter((w) => w.closed === null).length, D.PENDING_PER_ADDRESS, 'one /64 keeps PENDING_PER_ADDRESS sockets at most');
  assert.deepEqual(flood[0].closed, { code: 1013, reason: 'busy' });
  assert.ok(D.PENDING_UNKNOWN_MAX + D.PENDING_KNOWN_MAX < 64, 'the pools stay below the control plane cap (MAX_UNAUTHENTICATED)');
});

test('a node coming back from an address it logged in from keeps a slot, through a deploy, under a flood from many prefixes', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const node = await registerNode(h);
  const first = await upgrade(h, '198.51.100.21');
  await logIn(h, first, node);
  assert.equal(first.of('welcome').length, 1);
  first.close(1012, 'deploy');
  h = await boot(env, new FakeCtx(h.ctx.db));
  for (let i = 0; i < 60; i++) await upgrade(h, `2001:db8:${(0x100 + i).toString(16)}::1`);
  const back = await upgrade(h, '198.51.100.21');
  answer(h, back, node);
  for (let i = 60; i < 160; i++) await upgrade(h, `2001:db8:${(0x100 + i).toString(16)}::1`);
  assert.equal(back.closed, null, 'the returning node keeps its place');
  const open = h.ctx.sockets.filter((w) => w.closed === null).length;
  assert.ok(open <= D.PENDING_UNKNOWN_MAX + 1, `at most the unknown pool and the node (${open})`);
  await logIn(h, back, node);
  assert.equal(back.of('welcome').length, 1);
});

// ---- a logged-in node's control socket -----------------------------------------------------------------

/** Count the node rows written from now on (a trigger on the object's own SQLite). */
function countNodeWrites(h) {
  h.ctx.db.exec('CREATE TABLE IF NOT EXISTS node_writes (n INTEGER); CREATE TRIGGER IF NOT EXISTS node_write AFTER UPDATE ON nodes BEGIN INSERT INTO node_writes VALUES (1); END;');
  h.ctx.db.exec('DELETE FROM node_writes');
  return () => h.ctx.db.prepare('SELECT COUNT(*) AS n FROM node_writes').get().n;
}

test('the same hello again writes no row; a node past 30 hellos in 10 minutes has its socket closed (1008)', async () => {
  const h = await boot(makeEnv());
  const { node, ws } = await liveNode(h);
  const writes = countNodeWrites(h);
  for (let i = 0; i < 200; i++) {
    clock += 1000;
    await send(h, ws, { t: 'hello', data: helloOf(node) });
  }
  assert.equal(writes(), 0, 'a repeated hello is dropped');
  assert.equal(ws.closed, null);
  let accepted = 0;
  for (let i = 1; i <= 40 && ws.closed === null; i++) {
    clock += 1000;
    await send(h, ws, { t: 'hello', data: helloOf(node, { egressCapGB: i }) });
    if (ws.closed === null) accepted++;
  }
  assert.deepEqual(ws.closed, { code: 1008, reason: 'too many hellos' });
  assert.equal(accepted, D.HELLOS_PER_WINDOW - 1, 'the login hello counted too');
  assert.ok(writes() <= D.HELLOS_PER_WINDOW, 'one row write per hello taken at most');
});

test('publicUrl changes: four an hour per node, the fifth closes its socket; never onto an IP address; the probe never fetches a private or loopback address', async () => {
  const h = await boot(makeEnv());
  const { node, ws } = await liveNode(h);
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(new URL(String(url)).host);
    return realFetch(url, init);
  };
  let again;
  try {
    // An IP address, public or not: its link closes before anything is probed (a Worker cannot probe one).
    for (const publicUrl of ['wss://10.0.0.5', 'wss://[fd00::5]', 'wss://169.254.169.254', 'wss://203.0.113.80']) {
      const s = publicUrl === 'wss://10.0.0.5' ? ws : await connect(h, node);
      clock += 1000;
      await send(h, s, { t: 'hello', data: helloOf(node, { publicUrl }) });
      assert.deepEqual(s.closed, { code: 1008, reason: 'address not allowed' }, publicUrl);
    }
    assert.ok(alerts().some((l) => l.includes('said hello on wss://10.0.0.5, an address it may not move to (an IP address): its link is closed')));
    assert.equal(h.obj.cp.registry.node(node.nodeId).publicUrl, NODE_URL, 'the address it had');
    again = await connect(h, node);
    for (const publicUrl of ['wss://localhost:8443', 'wss://box.local', 'wss://a2.turbo-gol.test', 'wss://a3.turbo-gol.test', 'wss://a4.turbo-gol.test']) {
      clock += 1000;
      await send(h, again, { t: 'hello', data: helloOf(node, { publicUrl }) });
      await sleep(5);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(again.closed, { code: 1008, reason: 'too many address changes' }, 'the refused ones were not counted');
  assert.deepEqual(fetched.filter((x) => !x.endsWith('.turbo-gol.test')), [], 'never a private or loopback target');
  assert.ok(lines.some((l) => /probe sao-paulo-1 failed: Error: refused target/.test(l)), 'the refusal is the probe failure');
});

test('a ban closes the node live socket at once (4403), after telling it; a frame on a banned node socket closes it too', async () => {
  const h = await boot(makeEnv());
  const { node, ws } = await liveNode(h);
  const r = await call(h, 'POST', '/nodes/admin/status', { body: { nodeId: node.nodeId, status: 'banned', reason: 'test' }, headers: { 'x-operator-id': PROJECT } });
  assert.equal(r.status, 200);
  assert.equal(ws.of('status').at(-1)?.status, 'banned', 'told first');
  assert.deepEqual(ws.closed, { code: 4403, reason: 'banned' });
  const other = await liveNode(h, { ip: '203.0.113.2', publicUrl: 'wss://sp2.turbo-gol.test' });
  h.obj.cp.registry.setStatus(other.node.nodeId, 'banned', 'strikes');
  await send(h, other.ws, { t: 'heartbeat', data: beat() });
  assert.deepEqual(other.ws.closed, { code: 4403, reason: 'banned' });
});

test('a purged operator account (AccountsDO, sign-in PR 12: POST /internal/operator-deleted): each of its nodes banned, told, its socket closed (4403), one ALERT; again changes nothing; a trusted operator 409, its nodes kept', async () => {
  const OP = 'c0ffee0123456789';
  const env = makeEnv({ NODE_TRUSTED_OPERATORS: `${PROJECT},${OP}` });
  const h = await boot(env);
  const mine = await liveNode(h, { op: OP, ip: '203.0.113.21', publicUrl: 'wss://op1.turbo-gol.test' });
  const project = await liveNode(h, { ip: '203.0.113.22', publicUrl: 'wss://op2.turbo-gol.test' });
  // The account left the project's list (a deploy: the same sockets and database), then it was deleted.
  h.obj = new D.NodeRegistryDO(h.ctx, { ...env, NODE_TRUSTED_OPERATORS: PROJECT });
  h.obj.alertSleep = () => Promise.resolve();
  await h.obj.ready;
  assert.deepEqual((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: 'nope' } })).status, 400);
  const from = alerts().length;
  const r = await call(h, 'POST', '/internal/operator-deleted', { body: { userId: OP } });
  assert.deepEqual([r.status, r.json], [200, { ok: true, banned: 1 }]);
  assert.equal(h.obj.cp.registry.node(mine.node.nodeId).status, 'banned');
  assert.equal(mine.ws.of('status').at(-1)?.status, 'banned', 'told first');
  assert.deepEqual(mine.ws.closed, { code: 4403, reason: 'banned' });
  assert.equal(alerts().slice(from).filter((l) => l.includes(`operator ${OP} deleted their account: 1 node banned`)).length, 1);
  const again = await call(h, 'POST', '/internal/operator-deleted', { body: { userId: OP } });
  assert.deepEqual(again.json, { ok: true, banned: 0 });
  // The project's account is never deleted: nothing is banned for it.
  const t = await call(h, 'POST', '/internal/operator-deleted', { body: { userId: PROJECT } });
  assert.deepEqual([t.status, t.json.error], [409, 'trusted']);
  assert.equal(h.obj.cp.registry.node(project.node.nodeId).status, 'active');
  assert.equal(project.ws.closed, null);
  // Internal only, as every route: no header, no answer.
  const res = await h.obj.fetch(new Request('https://nodes/internal/operator-deleted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: PROJECT }) }));
  assert.equal(res.status, 403);
});

test('frames: a node steady traffic never trips the budget; a flood on one socket closes it (1008) once its burst is spent', async () => {
  const h = await boot(makeEnv());
  const { ws } = await liveNode(h);
  for (let i = 0; i < 300; i++) {
    clock += 1000;
    await send(h, ws, { t: 'heartbeat', data: beat() });
  }
  assert.equal(ws.closed, null);
  const other = await liveNode(h, { ip: '203.0.113.3', publicUrl: 'wss://sp3.turbo-gol.test' });
  let sent = 0;
  for (; sent < 200 && other.ws.closed === null; sent++) await send(h, other.ws, { t: 'heartbeat', data: beat() });
  assert.deepEqual(other.ws.closed, { code: 1008, reason: 'too many messages' });
  assert.ok(sent <= D.FRAME_BURST + 1, `closed within its burst (${sent})`);
});

test('the probe of a publicUrl reads at most 16 KB of its answer', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h, { publicUrl: 'wss://big.turbo-gol.test' });
  const big = stream(Array.from({ length: 64 }, () => new Uint8Array(64 * 1024).fill(32)));
  node.fail = () => new RealResponse(big.body);
  const ws = await connect(h, node);
  lines.length = 0;
  await send(h, ws, { t: 'hello', data: helloOf(node) });
  await waitFor(() => lines.some((l) => l.includes('probe sao-paulo-1 failed')), 'the probe fails');
  assert.ok(lines.some((l) => l.includes('an answer over 16384 bytes')), lines.join('\n'));
  assert.ok(big.pulls <= 2, `stopped at the cap (${big.pulls} chunks pulled)`);
});

// ---- replay uploads in the one object ----------------------------------------------------------------

/** A body that hands out `chunks` once `open()` was called; `pulls` counts the chunks taken. */
function gated(chunks) {
  let open;
  const gate = new Promise((r) => (open = r));
  const g = { pulls: 0, open: () => open() };
  g.body = new ReadableStream(
    {
      async pull(c) {
        await gate;
        if (g.pulls >= chunks.length) return c.close();
        c.enqueue(chunks[g.pulls++]);
      },
    },
    { highWaterMark: 0 },
  );
  return g;
}

test('replay uploads: one per match at a time (429), two per node; a stored replay answers its retry without a second read, another one 409', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { node } = await liveNode(h);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await call(h, 'POST', '/internal/place', { body: placeBody({ humans: humans('p' + i + 'a', 'p' + i + 'b') }) })).json.placement.matchId);
  const bytes = new Uint8Array(3000).map((_, i) => i & 0xff);
  const sha = await sha256Hex(bytes);
  const put = async (id, body, { digest = sha, length } = {}) =>
    h.obj.fetch(
      new Request(`https://nodes/nodes/replays/${id}`, {
        method: 'PUT',
        duplex: 'half',
        body,
        headers: {
          [INTERNAL_HEADER]: secret,
          'x-node-id': node.nodeId,
          'x-node-ts': String(clock),
          'x-node-sig': await sign(node.key, replayRequestMessage('PUT', id, digest, clock)),
          'x-replay-sha256': digest,
          ...(length !== undefined ? { 'content-length': String(length) } : {}),
        },
      }),
    );
  const a = gated([bytes]);
  const first = put(ids[0], a.body, { length: bytes.length });
  await sleep(5);
  const again = await within(2000, put(ids[0], gated([bytes]).body, { length: bytes.length }), 'a second upload of the match is answered before its body is read');
  assert.deepEqual([again.status, (await again.json()).error], [429, 'upload_in_progress'], 'the same match while its upload is read');
  const b = gated([bytes]);
  const second = put(ids[1], b.body, { length: bytes.length });
  await sleep(5);
  const third = await within(2000, put(ids[2], gated([bytes]).body, { length: bytes.length }), 'a third upload of the node is answered before its body is read');
  assert.deepEqual([third.status, (await third.json()).error], [429, 'busy'], 'a third upload of one node');
  a.open();
  b.open();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(env.NODE_REPLAYS.objects.get(ids[0]), bytes);
  const retry = gated([bytes]);
  retry.open();
  const r = await put(ids[0], retry.body, { length: bytes.length });
  assert.equal(r.status, 200, 'its retry after a lost answer');
  assert.equal(retry.pulls, 0, 'not read again');
  const other = new Uint8Array(3000).fill(7);
  const o = gated([other]);
  o.open();
  const r2 = await put(ids[0], o.body, { digest: await sha256Hex(other), length: other.length });
  assert.deepEqual([r2.status, (await r2.json()).error], [409, 'already_uploaded']);
  assert.deepEqual(env.NODE_REPLAYS.objects.get(ids[0]), bytes, 'the stored replay stays');
});

test('replay uploads: a budget of bytes in flight across nodes (503 busy, tried again by the node); a body longer than it declared is refused', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const one = await liveNode(h);
  const id = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement.matchId;
  const bytes = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff);
  const sha = await sha256Hex(bytes);
  const put = async (body, length) =>
    h.obj.fetch(
      new Request(`https://nodes/nodes/replays/${id}`, {
        method: 'PUT',
        duplex: 'half',
        body,
        headers: { [INTERNAL_HEADER]: secret, 'x-node-id': one.node.nodeId, 'x-node-ts': String(clock), 'x-node-sig': await sign(one.node.key, replayRequestMessage('PUT', id, sha, clock)), 'x-replay-sha256': sha, 'content-length': String(length) },
      }),
    );
  h.obj.replayBudget = 2000;
  const r = await within(2000, put(gated([bytes]).body, bytes.length), 'an upload over the budget is answered before its body is read');
  assert.deepEqual([r.status, (await r.json()).error], [503, 'busy'], 'over the budget: tried again later');
  h.obj.replayBudget = D.REPLAY_INFLIGHT_BYTES;
  const longer = gated([bytes, bytes]);
  longer.open();
  const r2 = await put(longer.body, bytes.length);
  assert.deepEqual([r2.status, (await r2.json()).error], [400, 'bad_length']);
  assert.equal(env.NODE_REPLAYS.objects.has(id), false);
  const ok = gated([bytes.slice(0, 1000), bytes.slice(1000)]);
  ok.open();
  assert.equal((await put(ok.body, bytes.length)).status, 200);
  assert.deepEqual(env.NODE_REPLAYS.objects.get(id), bytes);
});

// ---- the maintainers' history (prompt 1, PR 4: A9) ---------------------------------------------------

const { HISTORY_DAYS, ALERT_RING_MAX } = await import('../src/nodeStore.ts');
const DAY = 24 * 60 * MIN;
const json200 = (v, status = 200) => new RealResponse(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

test("the history: a settled match's row and seats are in the transaction that settles it (void ones too: reason, strike); GET /nodes/admin/history pages them newest first, one node's or one match's; a hidden name left out, every name when AccountsDO cannot say; a purged account's seat blanked", async () => {
  const { h, env, node, ws } = await watched();
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
  let atAck = null;
  answer(h, ws, node, { onSend: (m) => m.t === 'ack' && (atAck = rows(h, 'node_match_history').map((r) => [r.match_id, r.result, r.reason])) });
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  assert.deepEqual(atAck, [[placement.matchId, 'void', 'lost:tick_error']], 'written with the settled row, before the ack');
  assert.deepEqual(rows(h, 'node_match_players').map((r) => [r.slot, r.player_id, r.name]), [[0, A, 'P0'], [1, B, 'P1']]);
  // More than a page, each a millisecond apart.
  const ids = [placement.matchId];
  for (let i = 0; i < D.HISTORY_PAGE + 2; i++) {
    clock += 1;
    ids.unshift((await settleByHand(h)).assign.matchId);
  }
  env.ACCOUNTS.answer = (name, path, body) => (path === '/replay-hidden' ? json200({ ids: body.ids.filter((x) => x === B), names: [] }) : json200({ ok: true }));
  const first = await call(h, 'GET', '/nodes/admin/history', { headers: ADMIN });
  assert.deepEqual([first.status, first.headers.get('cache-control'), first.json.names], [200, 'no-store', 'shown']);
  assert.equal(first.json.matches.length, D.HISTORY_PAGE);
  assert.deepEqual(first.json.matches.map((m) => m.matchId), ids.slice(0, D.HISTORY_PAGE), 'newest first');
  const top = first.json.matches[0];
  assert.deepEqual([top.result, top.nodeName, top.verified, top.score, top.listed, top.published, top.delistedAt], ['unrated', 'sao-paulo-1', true, { blue: 1, red: 0 }, false, false, null]);
  assert.deepEqual(top.seats, [
    { slot: 0, team: 0, bot: false, name: 'P0', id: A, hidden: false },
    { slot: 1, team: 1, bot: false, name: null, id: B, hidden: true },
  ]);
  const next = await call(h, 'GET', '/nodes/admin/history?before=' + first.json.next, { headers: ADMIN });
  assert.deepEqual(next.json.matches.map((m) => m.matchId), ids.slice(D.HISTORY_PAGE));
  assert.equal(next.json.next, null);
  const lost = next.json.matches.at(-1);
  assert.deepEqual([lost.result, lost.reason, lost.strike, lost.ranked, lost.score, lost.replay, lost.verified], ['void', 'lost:tick_error', 'tick_error', true, null, false, false]);
  const one = await call(h, 'GET', '/nodes/admin/history?match=' + placement.matchId, { headers: ADMIN });
  assert.deepEqual(one.json.matches.map((m) => m.matchId), [placement.matchId]);
  assert.equal((await call(h, 'GET', '/nodes/admin/history?node=' + node.nodeId, { headers: ADMIN })).json.matches.length, D.HISTORY_PAGE);
  assert.equal((await call(h, 'GET', '/nodes/admin/history?node=' + 'ab'.repeat(8), { headers: ADMIN })).json.matches.length, 0);
  for (const q of ['before=nope', 'node=xyz', 'match=12']) assert.equal((await call(h, 'GET', '/nodes/admin/history?' + q, { headers: ADMIN })).status, 400, q);
  // AccountsDO cannot say whose names are hidden: none is shown.
  env.ACCOUNTS.answer = (name, path) => (path === '/replay-hidden' ? new RealResponse('down', { status: 503 }) : json200({ ok: true }));
  h.obj.replayNames.clear();
  const blind = await call(h, 'GET', '/nodes/admin/history?match=' + placement.matchId, { headers: ADMIN });
  assert.deepEqual([blind.status, blind.json.names, blind.json.matches[0].seats.map((s) => [s.name, s.id])], [200, 'unavailable', [[null, A], [null, B]]]);
  // A purged account (every one comes to /internal/operator-deleted): its name and id leave every seat.
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: A } })).status, 200);
  assert.deepEqual(new Set(rows(h, 'node_match_players').filter((r) => r.slot === 0).map((r) => `${r.player_id}|${r.name}`)), new Set(['null|null']));
  assert.equal(rows(h, 'node_match_players').filter((r) => r.player_id === B).length, ids.length, 'the others keep theirs');
  // Every read in the one window: one line in the channel.
  await h.ctx.settle();
  assert.deepEqual(posted().filter((p) => p.includes(': read ')), [`**ALERT** \`${ACTOR}: read the match history (a maintainer's reads come here once per 30 min, every one is in the logs)\``]);
});

test("the node events: each change written as it happens (registration, its token, online, reachable, status, drain, link cuts...), a maintainer's with their name; GET /nodes/admin/events pages them newest first, one node's or all; a lost trust at a restart too", async () => {
  const env = makeEnv({ NODE_ALERT_WEBHOOK: HOOK });
  let h = await boot(env);
  const { node, ws } = await liveNode(h);
  const kinds = (list) => list.map((e) => e.kind);
  let r = await call(h, 'GET', '/nodes/admin/events?node=' + node.nodeId, { headers: ADMIN });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(kinds(r.json.events).reverse(), ['token_used', 'registered', 'online', 'status_change', 'reachable']);
  assert.deepEqual(r.json.events.map((e) => [e.nodeId, e.nodeName]).at(0), [node.nodeId, 'sao-paulo-1']);
  assert.equal(r.json.events.find((e) => e.kind === 'status_change').detail, 'pending -> active');
  assert.ok(r.json.events.every((e) => e.actor === null), 'nobody made them happen');
  // A maintainer's drain names them; the node's link closed is its offline.
  assert.equal((await call(h, 'POST', '/nodes/admin/drain', { body: { nodeId: node.nodeId, reason: 'move' }, headers: ADMIN })).status, 200);
  await h.obj.webSocketClose(ws, 1006, '', false);
  r = await call(h, 'GET', '/nodes/admin/events', { headers: ADMIN });
  assert.deepEqual(r.json.events.slice(0, 2).map((e) => [e.kind, e.detail, e.actor]), [
    ['offline', null, null],
    ['drain', 'move', 'Proyecto Señor (a1b2c3d4e5f60718)'],
  ]);
  // More than a page: the cursor walks back.
  for (let i = 0; i < D.EVENTS_PAGE + 5; i++) h.obj.cp.registry.setStatus(node.nodeId, i % 2 === 0 ? 'suspended' : 'active', 'test');
  r = await call(h, 'GET', '/nodes/admin/events', { headers: ADMIN });
  assert.equal(r.json.events.length, D.EVENTS_PAGE);
  const rest = await call(h, 'GET', '/nodes/admin/events?before=' + r.json.next, { headers: ADMIN });
  assert.ok(rest.json.events.length > 0 && rest.json.events.every((e) => e.id < r.json.events.at(-1).id));
  assert.equal((await call(h, 'GET', '/nodes/admin/events?before=x', { headers: ADMIN })).status, 400);
  // A deploy with the account off the list: the lost trust is an event, and its ALERT is in the ring.
  h = await boot({ ...env, NODE_TRUSTED_OPERATORS: 'ffffffffffffffff' }, new FakeCtx(h.ctx.db));
  assert.equal(rows(h, 'node_events').filter((e) => e.kind === 'trust_removed').length, 1);
  assert.ok(rows(h, 'node_alerts').some((a) => a.kind === 'audit' && a.line.includes('lost its trust')), 'logged before the store was up, kept all the same');
});

test('the alert lines: every ALERT the object posts (an alert once in 10 minutes, every audit line; with or without a webhook) into a ring of ALERT_RING_MAX, paged newest first; a start line too', async () => {
  const bad = await boot(makeEnv({ NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey }));
  assert.deepEqual(rows(bad, 'node_alerts').map((a) => [a.kind, a.line]), [['alert', 'ALERT NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY: no placement, registration or rejoin until they match']], 'no webhook, and before the store was up');
  const h = await boot(makeEnv());
  await tokenFor(h);
  const r = await call(h, 'GET', '/nodes/admin/alerts', { headers: ADMIN });
  assert.deepEqual(r.json.alerts.map((a) => [a.kind, a.line]), [['audit', 'ALERT registration token created for trusted operator Proyecto Señor (a1b2c3d4e5f60718), region SA']]);
  assert.deepEqual([r.json.next, r.json.webhook], [null, false]);
  // The same alert again within 10 minutes (its numbers aside): one line, as the channel would get it; an audit line every time.
  const before = rows(h, 'node_alerts').length;
  h.obj.log('ALERT node sp1 (0123456789abcdef) lost 3 matches');
  h.obj.log('ALERT node sp1 (0123456789abcdef) lost 4 matches');
  h.obj.audit('ALERT admin x: drain');
  h.obj.audit('ALERT admin x: drain');
  assert.equal(rows(h, 'node_alerts').length, before + 3);
  clock += 10 * MIN;
  h.obj.log('ALERT node sp1 (0123456789abcdef) lost 5 matches');
  assert.equal(rows(h, 'node_alerts').length, before + 4, 'ten minutes later: again');
  for (let i = 0; i < ALERT_RING_MAX + 5; i++) h.obj.store.alertLine(clock, 'alert', `ALERT line ${i}`);
  assert.equal(rows(h, 'node_alerts').length, ALERT_RING_MAX);
  const page = await call(h, 'GET', '/nodes/admin/alerts', { headers: ADMIN });
  assert.deepEqual([page.json.alerts.length, page.json.alerts[0].line], [D.ALERTS_PAGE, `ALERT line ${ALERT_RING_MAX + 4}`]);
  const second = await call(h, 'GET', '/nodes/admin/alerts?before=' + page.json.next, { headers: ADMIN });
  assert.equal(second.json.alerts[0].line, `ALERT line ${ALERT_RING_MAX + 4 - D.ALERTS_PAGE}`);
});

test('the raw replay: the TGR1 bytes as R2 keeps them, no-store, an ALERT every time (never in the read window); 404 for a match the history does not keep, once delisted (its R2 delete failed or not) and once pruned', async () => {
  const { h, env, ws } = await watched();
  const bytes = new TextEncoder().encode('TGR1 a replay');
  const id = (await settleByHand(h)).assign.matchId;
  // settleByHand settles one without a replay: this one has its upload, so it is listed in the public replays too.
  const withReplay = async () => {
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
    const x = h.obj.cp.matches.get(placement.matchId);
    Object.assign(x, { state: 'done', doneAt: clock, replaySha: 'c'.repeat(64), outcome: { kind: 'unrated', matchId: placement.matchId, nodeId: x.nodeId, blue: 1, red: 0, verified: true } });
    h.obj.store.finished(x, x.outcome);
    await env.NODE_REPLAYS.put(placement.matchId, bytes);
    return placement.matchId;
  };
  const rid = await withReplay();
  const get = (matchId) => h.obj.fetch(new Request('https://nodes/nodes/admin/replay?matchId=' + matchId, { headers: { [INTERNAL_HEADER]: secret, ...ADMIN } }));
  for (let i = 0; i < 2; i++) {
    const res = await get(rid);
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    assert.deepEqual([res.headers.get('content-type'), res.headers.get('cache-control'), res.headers.get('content-disposition')], ['application/octet-stream', 'no-store', `attachment; filename="${rid}.tgr"`]);
  }
  const none = await get(id);
  assert.deepEqual([none.status, none.headers.get('cache-control')], [404, 'no-store'], 'never uploaded: refused, and never kept either');
  assert.equal((await get('9'.repeat(64))).status, 404, 'not in the history');
  assert.equal((await get('nope')).status, 400);
  await h.ctx.settle();
  assert.deepEqual(posted().filter((p) => p.includes('replay of match')), [
    `**ALERT** \`${ACTOR}: downloaded the replay of match ${rid} (${bytes.byteLength} bytes)\``,
    `**ALERT** \`${ACTOR}: downloaded the replay of match ${rid} (${bytes.byteLength} bytes)\``,
    `**ALERT** \`${ACTOR}: the replay of match ${id} was asked for, none served (never uploaded)\``,
    `**ALERT** \`${ACTOR}: the replay of match ${'9'.repeat(64)} was asked for, none served (not in the history)\``,
  ]);
  // Its detail says where it is public; a delist (this bucket cannot delete: the object stays) ends the download.
  clock += 3 * 60 * MIN;
  const detail = (await call(h, 'GET', '/nodes/admin/history?match=' + rid, { headers: ADMIN })).json.matches[0];
  assert.deepEqual([detail.replay, detail.listed, detail.published], [true, true, true]);
  assert.equal((await call(h, 'POST', '/nodes/admin/delist', { body: { matchId: rid, reason: 'a parent asked' }, headers: ADMIN })).status, 200);
  assert.ok(env.NODE_REPLAYS.objects.has(rid), 'the R2 object is still there');
  assert.equal((await get(rid)).status, 404, 'delisted');
  const gone = (await call(h, 'GET', '/nodes/admin/history?match=' + rid, { headers: ADMIN })).json.matches[0];
  assert.deepEqual([gone.listed, gone.published, gone.delistedAt], [false, false, clock]);
  // Past HISTORY_DAYS the cron prunes the history: no download either.
  await send(h, ws, { t: 'heartbeat', data: beat() });
  const old = await withReplay();
  clock += (HISTORY_DAYS + 1) * DAY;
  assert.equal((await call(h, 'POST', '/internal/health')).status, 200);
  assert.equal(rows(h, 'node_match_history').filter((r) => r.match_id === old).length, 0);
  assert.equal((await get(old)).status, 404, 'pruned');
});

test('match void and verify: a maintainer voids a match not settled (its outbox in the settling transaction, no strike unless asked, the reason in the history) or asks for its verification now; each an ALERT; the overview counts the voids of 24 h', async () => {
  const { h, env, node, ws } = await watched();
  const place = async (ranked) => (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked }) })).json.placement.matchId;
  const run = (what, body) => call(h, 'POST', '/nodes/admin/match/' + what, { body, headers: ADMIN });
  const a = await place(true);
  assert.equal((await run('void', { matchId: a })).json.error, 'reason_required');
  assert.equal((await run('void', { matchId: 'zz', reason: 'x' })).json.error, 'bad_match_id');
  assert.equal((await run('void', { matchId: '9'.repeat(64), reason: 'x' })).status, 404);
  let open = null;
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = new Promise((r) => (open = r));
  const v = await run('void', { matchId: a, reason: 'stuck after a reboot' });
  assert.deepEqual([v.status, v.json], [200, { matchId: a, voided: true, strike: false }]);
  assert.deepEqual(rows(h, 'outbox').map((r) => r.path), ['/ranked-cancel', '/release'], 'written with the settled row');
  open();
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = null;
  await h.ctx.settle();
  assert.equal(env.ACCOUNTS.calls.find((c) => c.path === '/ranked-cancel').body.reason, 'admin_void');
  const n = h.obj.cp.registry.node(node.nodeId);
  assert.deepEqual([n.counters.lost, n.strikeTimes.length], [0, 0], 'no strike');
  let row = (await call(h, 'GET', '/nodes/admin/history?match=' + a, { headers: ADMIN })).json.matches[0];
  assert.deepEqual([row.result, row.reason, row.adminReason, row.strike], ['void', 'admin_void', 'stuck after a reboot', null]);
  assert.equal((await run('void', { matchId: a, reason: 'again' })).json.error, 'already_settled');
  // With a strike: one, as the node's fault.
  const b = await place(false);
  assert.deepEqual((await run('void', { matchId: b, reason: 'fabricated', strike: true })).json, { matchId: b, voided: true, strike: true });
  assert.deepEqual([n.counters.lost, n.strikeTimes.length], [1, 1]);
  row = (await call(h, 'GET', '/nodes/admin/history?match=' + b, { headers: ADMIN })).json.matches[0];
  assert.equal(row.strike, 'admin_void');
  // Verify now: only a match waiting for its verification, and not one a verifier has.
  const c = await place(false);
  assert.equal((await run('verify', { matchId: c })).json.error, 'not_verifying');
  Object.assign(h.obj.cp.matches.get(c), { state: 'verifying', queuedAt: clock, lastTry: clock, report: { kind: 'ended', matchId: c, replaySha256: 'ab'.repeat(32), result: { winner: 0, blue: 1, red: 0, endTick: 100, endReason: 'rules' }, stats: { slots: [], tickLagP99Ms: 1 } } });
  assert.deepEqual((await run('verify', { matchId: c })).json, { matchId: c, queued: true });
  assert.equal(ws.of('verify').at(-1)?.job.matchId, c, 'sent to a verifier now, not after its retry wait');
  assert.equal((await run('verify', { matchId: c })).json.error, 'in_flight');
  await h.ctx.settle();
  const said = posted().filter((p) => p.includes(`${ACTOR}: match `));
  assert.equal(said.length, 7, 'every call that named a match: the refused ones too');
  assert.ok(said.includes(`**ALERT** \`${ACTOR}: match ${a} on sao-paulo-1 (${node.nodeId}) voided: stuck after a reboot\``), said.join('\n'));
  assert.ok(said.includes(`**ALERT** \`${ACTOR}: match ${b} on sao-paulo-1 (${node.nodeId}) voided, a strike for its node: fabricated\``));
  const o = (await call(h, 'GET', '/nodes/admin/overview', { headers: ADMIN })).json;
  assert.deepEqual(o.voids24h, [{ nodeId: node.nodeId, reason: 'admin_void', count: 2, name: 'sao-paulo-1' }]);
  assert.equal(typeof o.nodes[0].seenAt, 'number', 'when it was last seen, kept at its transitions');
});

test('the open matches: what the control plane holds and has not settled, newest first, with where each stands and its seats (a hidden name left out); a settled one leaves the list', async () => {
  const { h, env } = await watched();
  const place = async (over) => (await call(h, 'POST', '/internal/place', { body: placeBody(over) })).json.placement.matchId;
  const first = await place({ ranked: true });
  clock += 1000;
  const second = await place();
  env.ACCOUNTS.answer = (name, path, body) => (path === '/replay-hidden' ? json200({ ids: body.ids.filter((x) => x === A), names: [] }) : json200({ ok: true }));
  const r = await call(h, 'GET', '/nodes/admin/matches', { headers: ADMIN });
  assert.deepEqual([r.status, r.headers.get('cache-control'), r.json.total, r.json.names], [200, 'no-store', 2, 'shown']);
  assert.deepEqual(r.json.matches.map((m) => [m.matchId, m.state, m.ranked, m.nodeName, m.replay, m.verifying]), [
    [second, 'assigned', false, 'sao-paulo-1', false, false],
    [first, 'assigned', true, 'sao-paulo-1', false, false],
  ]);
  assert.deepEqual(r.json.matches[0].seats.map((s) => [s.slot, s.bot, s.name, s.id, s.hidden]), [
    [0, false, null, A, true],
    [1, false, 'P1', B, false],
  ]);
  await settleByHand(h);
  h.obj.cp.matches.get(first).state = 'done';
  const after = await call(h, 'GET', '/nodes/admin/matches', { headers: ADMIN });
  assert.deepEqual(after.json.matches.map((m) => m.matchId), [second]);
});

test('a player purged while their match is held: the open matches show their seat blank, and the seat the settle writes later has neither name nor id; the purged id goes after HISTORY_DAYS', async () => {
  const { h, env, ws } = await watched();
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const asked = [];
  env.ACCOUNTS.answer = (name, path, body) => (path === '/replay-hidden' ? (asked.push(...body.ids), json200({ ids: body.ids.filter((x) => x === A), names: [] })) : json200({ ok: true }));
  // AccountsDO tells the purge once, while the match is still being played.
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: A } })).status, 200);
  const open = await call(h, 'GET', '/nodes/admin/matches', { headers: ADMIN });
  assert.deepEqual(open.json.matches[0].seats.map((s) => [s.slot, s.bot, s.name, s.id, s.hidden]), [
    [0, false, null, null, false],
    [1, false, 'P1', B, false],
  ]);
  assert.deepEqual(asked, [B], 'a purged id is not even asked about');
  assert.deepEqual(h.obj.cp.matches.get(placement.matchId).assign.roster.find((e) => e.slot === 0).playerId, A, 'the roster keeps it: the outcome is delivered with it');
  // It settles afterwards: the row is written with the seat blank, never with the id and the name.
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  assert.deepEqual(rows(h, 'node_match_players').map((r) => [r.slot, r.player_id, r.name]), [[0, null, null], [1, B, 'P1']]);
  assert.ok(!rows(h, 'node_match_history').some((r) => r.data.includes(A)));
  h.obj.replayNames.clear();
  const one = (await call(h, 'GET', '/nodes/admin/history?match=' + placement.matchId, { headers: ADMIN })).json.matches[0];
  assert.deepEqual(one.seats[0], { slot: 0, team: 0, bot: false, name: null, id: null, hidden: false });
  // Only the id is kept, and only HISTORY_DAYS: the cron's prune takes it with the history.
  assert.deepEqual(rows(h, 'node_forgotten').map((r) => r.player_id), [A]);
  assert.deepEqual([...h.obj.store.forgotten([B, A, A, ...Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(16, '0'))])], [A], 'asked in parts, each id once');
  clock += (HISTORY_DAYS + 1) * DAY;
  assert.equal((await call(h, 'POST', '/internal/health')).status, 200);
  assert.deepEqual(rows(h, 'node_forgotten'), []);
});

test("a replay listed before the history was kept (its index row, no history row): the panel's lookup by match id finds no row, and the delist still takes it", async () => {
  const { h, env } = await watched();
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const x = h.obj.cp.matches.get(placement.matchId);
  Object.assign(x, { state: 'done', doneAt: clock, replaySha: 'c'.repeat(64), outcome: { kind: 'unrated', matchId: placement.matchId, nodeId: x.nodeId, blue: 1, red: 0, verified: true } });
  h.obj.store.finished(x, x.outcome);
  await env.NODE_REPLAYS.put(placement.matchId, new TextEncoder().encode('TGR1 old'));
  // What a match settled before this build looks like: listed, with no row in the history.
  h.ctx.db.prepare('DELETE FROM node_match_history WHERE match_id = ?').run(placement.matchId);
  h.ctx.db.prepare('DELETE FROM node_match_players WHERE match_id = ?').run(placement.matchId);
  clock += 3 * 60 * MIN;
  const one = await call(h, 'GET', '/nodes/admin/history?match=' + placement.matchId, { headers: ADMIN });
  assert.deepEqual([one.status, one.json.matches], [200, []]);
  const d = await call(h, 'POST', '/nodes/admin/delist', { body: { matchId: placement.matchId, reason: 'a player asked' }, headers: ADMIN });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual(rows(h, 'replay_index'), []);
  const again = await call(h, 'POST', '/nodes/admin/delist', { body: { matchId: placement.matchId, reason: 'a player asked' }, headers: ADMIN });
  assert.deepEqual([again.status, again.json.error], [404, 'no_replay'], 'what the lookup shows when it is not listed');
});

test("the cron's prune while nodes_off is set (POST /internal/prune): what is past HISTORY_DAYS goes from every table, the newer rows stay; no node is probed or told anything, no ALERT, where the health check probes", async () => {
  // A bucket that deletes: the prune takes the R2 objects too.
  const replays = bucket();
  replays.delete = async (keys) => void [].concat(keys).forEach((k) => replays.objects.delete(k));
  const { h, env, node, ws } = await watched({ NODE_REPLAYS: replays });
  const start = clock;
  const withReplay = async () => {
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
    const x = h.obj.cp.matches.get(placement.matchId);
    Object.assign(x, { state: 'done', doneAt: clock, replaySha: 'c'.repeat(64), outcome: { kind: 'unrated', matchId: placement.matchId, nodeId: x.nodeId, blue: 1, red: 0, verified: true } });
    h.obj.store.finished(x, x.outcome);
    await env.NODE_REPLAYS.put(placement.matchId, new TextEncoder().encode('TGR1 a replay'));
    return placement.matchId;
  };
  const STARRER = 'cccccccccccccccc';
  // The old rows: the registration's events and ALERT lines, a match with its replay, seats and a star, a purged id.
  const old = await withReplay();
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: 'd'.repeat(16) } })).status, 200);
  clock += 3 * 60 * MIN;
  assert.equal(h.obj.store.setReplayStar(STARRER, old, true, 10), 1);
  // Two days later, the newer ones (none of these writes reaches back 30 days).
  clock += 2 * DAY;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  const fresh = await withReplay();
  h.obj.store.nodeEvent({ nodeId: node.nodeId, at: clock, kind: 'reachable', detail: null, actor: null });
  h.obj.store.alertLine(clock, 'alert', 'ALERT a newer line');
  assert.equal((await call(h, 'POST', '/internal/operator-deleted', { body: { userId: 'e'.repeat(16) } })).status, 200);
  clock += 3 * 60 * MIN;
  assert.equal(h.obj.store.setReplayStar(STARRER, fresh, true, 10), 1);
  // The old ones turn 31 days old; nothing pruned them yet (no cron, no write since).
  clock = start + (HISTORY_DAYS + 1) * DAY;
  const cutoff = clock - HISTORY_DAYS * DAY;
  const timed = { replay_index: 'match_id', node_match_history: 'match_id', node_events: 'id', node_alerts: 'id', node_forgotten: 'player_id' };
  const byMatch = (table) => [...new Set(rows(h, table).map((r) => r.match_id))].sort();
  const kept = {};
  for (const [t, k] of Object.entries(timed)) {
    const all = rows(h, t);
    assert.ok(all.some((r) => r.at < cutoff) && all.some((r) => r.at >= cutoff), `${t}: rows on both sides of the 30 days`);
    kept[t] = all.filter((r) => r.at >= cutoff).map((r) => String(r[k])).sort();
  }
  for (const t of ['replay_players', 'replay_stars', 'node_match_players']) assert.deepEqual(byMatch(t), [old, fresh].sort(), t);
  const probes = [];
  const fetchFn = h.obj.fetchFn;
  h.obj.fetchFn = (url, init) => (new URL(String(url)).pathname === '/healthz' && probes.push(String(url)), fetchFn(url, init));
  const told = ws.sent.length;
  lines.length = 0;
  posts.length = 0;
  const r = await call(h, 'POST', '/internal/prune');
  assert.deepEqual([r.status, r.json], [200, { replays: 1, history: 1 }]);
  for (const [t, k] of Object.entries(timed)) {
    assert.deepEqual(rows(h, t).map((x) => String(x[k])).sort(), kept[t], `${t}: what is past 30 days gone, the rest kept`);
  }
  for (const t of ['replay_players', 'replay_stars', 'node_match_players']) assert.deepEqual(byMatch(t), [fresh], t);
  assert.deepEqual([replays.objects.has(old), replays.objects.has(fresh)], [false, true], 'the R2 object with its row');
  await h.ctx.settle();
  assert.deepEqual([probes, ws.sent.length, alerts(), posts], [[], told, [], []], 'no probe, nothing sent to the node, no ALERT');
  // The same object's health check would have probed it.
  assert.deepEqual((await call(h, 'POST', '/internal/health')).json, { probed: 1, problems: 0 });
  assert.equal(probes.length, 1);
});

test("the maintainers' lists hide what is past HISTORY_DAYS before any prune: the history (one match's lookup and its raw replay too), the node events and the alert lines", async () => {
  const { h, node, ws } = await watched();
  const start = clock;
  const old = (await settleByHand(h)).assign.matchId;
  clock += 2 * DAY;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  const fresh = (await settleByHand(h)).assign.matchId;
  h.obj.store.nodeEvent({ nodeId: node.nodeId, at: clock, kind: 'reachable', detail: 'newer', actor: null });
  h.obj.store.alertLine(clock, 'alert', 'ALERT a newer line');
  clock = start + (HISTORY_DAYS + 1) * DAY;
  const cutoff = clock - HISTORY_DAYS * DAY;
  for (const t of ['node_match_history', 'node_events', 'node_alerts']) assert.ok(rows(h, t).some((r) => r.at < cutoff), `${t}: an old row, not pruned yet`);
  // The alert lines first: a read's own audit line prunes the ring on its way.
  const a = (await call(h, 'GET', '/nodes/admin/alerts', { headers: ADMIN })).json.alerts;
  assert.ok(a.some((x) => x.line === 'ALERT a newer line') && a.every((x) => x.at >= cutoff), JSON.stringify(a));
  const e = (await call(h, 'GET', '/nodes/admin/events', { headers: ADMIN })).json.events;
  assert.ok(e.some((x) => x.detail === 'newer') && e.every((x) => x.at >= cutoff), JSON.stringify(e));
  assert.ok((await call(h, 'GET', '/nodes/admin/events?node=' + node.nodeId, { headers: ADMIN })).json.events.every((x) => x.at >= cutoff));
  const ids = async (q) => (await call(h, 'GET', '/nodes/admin/history' + q, { headers: ADMIN })).json.matches.map((m) => m.matchId);
  assert.deepEqual(await ids(''), [fresh]);
  assert.deepEqual(await ids('?node=' + node.nodeId), [fresh]);
  assert.deepEqual(await ids('?match=' + old), []);
  assert.deepEqual(await ids('?match=' + fresh), [fresh]);
  lines.length = 0;
  assert.equal((await h.obj.fetch(new Request('https://nodes/nodes/admin/replay?matchId=' + old, { headers: { [INTERNAL_HEADER]: secret, ...ADMIN } }))).status, 404);
  assert.ok(lines.some((l) => l.endsWith(`the replay of match ${old} was asked for, none served (not in the history)`)), lines.join('\n'));
  // Hidden, not pruned: the cron's prune takes them.
  assert.ok(rows(h, 'node_match_history').some((r) => r.match_id === old));
  assert.ok(rows(h, 'node_events').some((r) => r.at < cutoff));
});

test("an idle object woken by the cron's prune (nodes_off set) starts again at each run: its start's ALERT reaches the channel and the ring once in 10 minutes, as one object's would; one that cannot start prunes nothing", async () => {
  // Four of the cron's runs, 5 minutes apart, each on a new instance: nothing keeps the object awake between them.
  const runs = async (env, db, answer) => {
    lines.length = 0;
    posts.length = 0;
    let h;
    for (let i = 0; i < 4; i++) {
      h = await boot(env, new FakeCtx(db));
      const r = await call(h, 'POST', '/internal/prune');
      answer(r);
      await h.ctx.settle();
      clock += 5 * MIN;
    }
    return h;
  };
  // A state a newer build wrote: no start of this one reads it.
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  new NodeStore(sql, transactionSync).migrate();
  db.prepare("UPDATE meta SET v = '9' WHERE k = 'state_version'").run();
  await runs(makeEnv({ NODE_ALERT_WEBHOOK: HOOK }), db, (r) => assert.deepEqual([r.status, r.json.error], [503, 'nodes_unavailable'], 'nothing pruned until a start reads it'));
  assert.equal(alerts().length, 4, 'the logs keep every one');
  assert.equal(posted().length, 2, 'the first run and 10 minutes later');
  assert.ok(posted().every((p) => p.includes('node control plane not started, its state is left as it is')), posted().join('\n'));
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'state_version'").get().v, '9');
  // A control key that is not its pair: the start goes on and the prune runs; the ring keeps the line as the channel gets it.
  const pair = makeEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey });
  const h = await runs(pair, new DatabaseSync(':memory:'), (r) => assert.deepEqual([r.status, r.json], [200, { replays: 0, history: 0 }]));
  assert.equal(alerts().length, 4);
  assert.deepEqual(posted(), Array(2).fill('**ALERT** `NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY: no placement, registration or rejoin until they match`'));
  assert.equal(rows(h, 'node_alerts').filter((a) => a.line.includes('not the public half')).length, 2);
});
