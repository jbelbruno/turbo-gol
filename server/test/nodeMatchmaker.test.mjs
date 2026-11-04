// Matches on community nodes, the Worker's side, without workerd: the matchmaker's node hook
// (server/src/MatchmakerDO.ts behind nodes_on: placement on a node of the host region, the fallbacks
// to a MatchDO, the room cap, do_disabled (the host region's node, then SA's), the ranked lock, the
// release of a node match in the queue hub, node locks verified and quit through the control plane, and what
// polls, leaves and the sweep do while a placement is in flight) and the
// Worker's /api/queue, /api/rejoin and /api/leave around them (server/src/index.ts). The
// NodeRegistryDO is a fake answering its internal routes (server/src/nodeApi.ts); FLAGS, MATCH,
// ROOM, ACCOUNTS and MATCHMAKER are fakes that record their calls, with a settable clock. With
// nodes_on absent, or the nodes not configured, everything is pinned to the behaviour without
// nodes. 'cloudflare:workers' and MatchDO's wasm are stubbed by the resolve hook
// (nodeRoutes.test.mjs). Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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

// The matchmaker's sweep and long-poll timers must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const M = await import('../src/MatchmakerDO.ts');
const API = await import('../src/nodeApi.ts');
const worker = (await import('../src/index.ts')).default;
const { ROOM_PROTOCOL } = await import('../src/RoomDO.ts');
const { INTERNAL_HEADER, internalSecret, signJwt } = await import('../src/auth.ts');
const Q = await import('../src/queuePlan.ts');
const { RPC_TIMEOUT_MS } = await import('../../nodes/shared/controlProtocol.ts');

const SECRET = 'node-matchmaker-test-secret';
const RealResponse = globalThis.Response;
const secret = await internalSecret(SECRET);
const A = 'a1b2c3d4e5f60718';
const B = '0123456789abcdef';
const C = 'fedcba9876543210';
const NODE_URL = 'wss://sp1.turbo-gol.com';
const HEX = '0123456789abcdef';
const hex64 = () => Array.from({ length: 64 }, () => HEX[Math.floor(Math.random() * 16)]).join('');

/** console.error lines while `fn` runs (the expected failures are logged; nothing else is printed). */
async function errorsOf(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

// ---- fakes -------------------------------------------------------------------------------------

/** FLAGS in memory; `reads` records every name read. */
function kv(values) {
  const reads = [];
  return {
    reads,
    values,
    FLAGS: {
      async get(name) {
        reads.push(name);
        return values[name] ?? null;
      },
    },
  };
}

/** A DO namespace whose objects answer `handler(path, body)`; `calls` records { id, path, body }. */
function makeNs(handler = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    ns: {
      newUniqueId: () => ({ toString: hex64 }),
      idFromString: (s) => s,
      idFromName: (n) => n,
      get: (id, opts) => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          calls.push({ id: String(id), path: u.pathname, body, ...(opts !== undefined ? { opts } : {}) });
          const r = handler(u.pathname, body);
          return r instanceof RealResponse ? r : new RealResponse(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
}

/** What the control plane answers a placement it takes: the node's URL and one ticket per human. */
function placementOf(body, over = {}) {
  const matchId = hex64();
  return {
    matchId,
    nodeId: 'node-1',
    nodeName: 'sao-paulo-1',
    transport: 'wss',
    wsUrl: `${NODE_URL}/m/${matchId}`,
    tickets: body.humans.map((h, i) => ({ playerId: h.playerId, slot: i, team: i % 2, ticket: 'node-ticket.' + h.playerId })),
    ...over,
  };
}

/**
 * The NodeRegistryDO's internal routes. Each route answers `{ status?, body }`; an Error is thrown
 * as a network failure, and a promise that never settles is a control plane that does not answer.
 * `calls` records { path, query, body, internal, opts }.
 */
function fakeNodes() {
  const calls = [];
  const n = {
    calls,
    place: (body) => ({ body: { placement: placementOf(body), hosts: 1 } }),
    status: () => ({ body: { state: 'assigned', left: false } }),
    leave: () => ({ body: { recorded: true, answer: { slot: 0, closed: true, already: false, ended: false } } }),
    rejoin: (body) => ({ body: { ticket: 'node-ticket-again.' + body.playerId, wsUrl: `${NODE_URL}/m/${body.matchId}` } }),
    of: (path) => calls.filter((c) => c.path === path),
    ns: {
      idFromName: (name) => ({ name }),
      get: (id, opts) => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          const query = Object.fromEntries(u.searchParams);
          calls.push({ id, opts, path: u.pathname, query, body, internal: init.headers[INTERNAL_HEADER] });
          const route = { '/internal/place': n.place, '/internal/status': n.status, '/internal/leave': n.leave, '/internal/rejoin': n.rejoin }[u.pathname];
          const r = await route(body ?? query);
          if (r instanceof Error) throw r;
          return new RealResponse(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  return n;
}

/** Every node setting nodesConfigured asks for (only NODES is ever called here). */
function nodeSettings(nodes) {
  return { NODES: nodes.ns, NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'private', NODE_CONTROL_PUBLIC_KEY: 'public', NODES_PUBLIC_BASE: 'https://turbo-gol.com' };
}

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t) {
    this.alarm = t;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.map.delete(k);
  }
  async list({ prefix }) {
    const out = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, v);
    return out;
  }
}

/**
 * A MatchmakerDO for region `region` (SA: a region the nodes know). `flags` are the KV flags,
 * `configured: false` leaves every node setting out, and `rooms` MatchDO matches are already alive.
 */
async function makeMm({ flags = { nodes_on: '1' }, configured = true, region = 'SA', rooms = 0 } = {}) {
  const nodes = fakeNodes();
  const flagsKv = kv(flags);
  const matchStatus = { matchId: 'x', ended: false, reset: false };
  const matchNs = makeNs((path) => (path === '/internal/status' ? matchStatus : { ok: true }));
  const roomNs = makeNs();
  const accountsNs = makeNs();
  const storage = new FakeStorage();
  for (let i = 0; i < rooms; i++) storage.map.set('room:' + hex64(), { until: Date.now() + 3_600_000, kind: 'server' });
  const ctx = { storage, blockConcurrencyWhile: (fn) => fn() };
  const env = {
    JWT_SECRET: SECRET,
    MATCH_LENGTH_SECONDS: 300,
    REGION_OVERRIDE: '',
    MATCH: matchNs.ns,
    ROOM: roomNs.ns,
    ACCOUNTS: accountsNs.ns,
    FLAGS: flagsKv.FLAGS,
    ...(configured ? nodeSettings(nodes) : {}),
  };
  const mm = new M.MatchmakerDO(ctx, env);
  await new Promise((r) => realSetTimeout(r, 0)); // the constructor's storage load
  let t = 1_000_000;
  mm.now = () => t;
  const call = async (path, body) => {
    const res = await mm.fetch(
      new Request('https://matchmaker' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', 'x-region': region },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  };
  /** `extra`: more join fields (doDisabled: the Worker read do_disabled set). */
  const join = (playerId, kind = 'server', mode = '1v1', extra = {}) =>
    call('/join', { playerId, name: 'P-' + playerId.slice(0, 4), mode, kind, ...(kind === 'ranked' ? { ratings: { [mode]: { mu: 25, sigma: 8 } } } : {}), ...extra });
  const poll = (playerId) => call('/poll?playerId=' + playerId);
  /** Two Casual humans (any format: 2 humans play a 2v2 with a bot each): the first waits, the second forms the match; the first collects its result by joining again. */
  const pair = async (a, b, kind = 'server') => {
    const first = await join(a, kind);
    assert.equal(first.json.status, 'waiting', JSON.stringify(first.json));
    const qb = await join(b, kind);
    const qa = await join(a, kind);
    return [qa, qb];
  };
  const stats = async () => (await call('/stats')).json;
  return { mm, env, call, join, poll, pair, stats, nodes, flags: flagsKv, match: matchNs, room: roomNs, accounts: accountsNs, matchStatus, setTime: (v) => (t = v), time: () => t };
}

const created = (h) => h.match.calls.filter((c) => c.path === '/internal/create');

/** A promise and its resolve: a route held open until the test lets it answer. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const pause = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** Wait (real time: the sweep runs on a 500 ms timer) until `check()` holds; false after `ms`. */
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await pause(20);
  }
  return true;
}

/** Wait until `n` players of `h` are being formed (a placement or a create held open). */
async function formingOf(h, n) {
  assert.ok(await until(async () => (await h.stats()).forming === n), n + ' forming');
}

/** `h`'s placements wait for `gate`, then answer `answer(body)` (default: placed). */
function holdPlace(h, gate, answer = (body) => ({ placement: placementOf(body), hosts: 1 })) {
  h.nodes.place = async (body) => {
    await gate.promise;
    return { body: answer(body) };
  };
}

// ---- nodeApi.ts: the matchmaker's half of the contract ----------------------------------------------

test('the matchmaker waits for the control plane longer than one RPC to a node', () => {
  assert.equal(API.NODE_CALL_TIMEOUT_MS, 8_000);
  assert.ok(API.NODE_CALL_TIMEOUT_MS > RPC_TIMEOUT_MS, 'the node’s own timeout comes back first');
  assert.equal(M.NO_HOSTS_BACKOFF_MS, 60_000);
  assert.equal(M.NODES_MODE_TTL_MS, 10_000);
});

test('placementFor: a 64-hex id, the node’s wss:// URL and exactly one ticket per player; anything else is null', () => {
  const body = { humans: [{ playerId: A }, { playerId: B }] };
  const p = placementOf(body);
  assert.equal(API.placementFor({ placement: p, hosts: 1 }, [A, B]), p);
  assert.equal(API.placementFor({ placement: p, hosts: 1 }, [B, A]), p, 'in any order');
  const bad = [
    null,
    { placement: null, hosts: 1 },
    { placement: { ...p, matchId: 'ab' } },
    { placement: { ...p, matchId: 'AB'.repeat(32) } },
    { placement: { ...p, wsUrl: 'ws://sp1.turbo-gol.com/m/x' } },
    { placement: { ...p, wsUrl: '/ws/' + p.matchId } },
    { placement: { ...p, wsUrl: 'wss://' } },
    { placement: { ...p, tickets: p.tickets.slice(0, 1) } },
    { placement: { ...p, tickets: [p.tickets[0], p.tickets[0]] } },
    { placement: { ...p, tickets: [p.tickets[0], { ...p.tickets[1], playerId: C }] } },
    { placement: { ...p, tickets: [p.tickets[0], { ...p.tickets[1], ticket: '' }] } },
    { placement: { ...p, tickets: [p.tickets[0], { ...p.tickets[1], team: 2 }] } },
    { placement: { ...p, tickets: [p.tickets[0], { ...p.tickets[1], slot: 0.5 }] } },
    { placement: { ...p, tickets: 'all' } },
  ];
  for (const a of bad) assert.equal(API.placementFor(a, [A, B]), null, JSON.stringify(a));
});

test('rejoinTicketOf and nodeLockHeld: only a real ticket or status counts; an answer of another shape keeps the lock', () => {
  const ok = { ticket: 't', wsUrl: `${NODE_URL}/m/x` };
  assert.deepEqual(API.rejoinTicketOf(ok), ok);
  const junk = [null, 'not a ticket', {}, { ticket: 't' }, { ticket: '', wsUrl: ok.wsUrl }, { ticket: 7, wsUrl: ok.wsUrl }, { ticket: 't', wsUrl: '/m/x' }, { ticket: 't', wsUrl: 'ws://sp1.turbo-gol.com/m/x' }];
  for (const b of junk) assert.equal(API.rejoinTicketOf(b), null, JSON.stringify(b));
  for (const s of [null, 'assigned', {}, { state: 'done' }, { left: false }, { state: 7, left: false }, { state: 'done', left: 'no' }]) assert.equal(API.nodeLockHeld(s), true, JSON.stringify(s));
  assert.equal(API.nodeLockHeld({ state: 'done', left: false }), false);
});

test('askNodes: to nodes-v1 near São Paulo with the internal header; a GET without a body; the whole answer within the timeout', async () => {
  const nodes = fakeNodes();
  const env = { JWT_SECRET: SECRET, NODES: nodes.ns };
  const r = await API.askNodes(env, '/internal/status?matchId=m&playerId=p');
  assert.deepEqual(r, { status: 200, body: { state: 'assigned', left: false } });
  assert.deepEqual(nodes.calls[0].id, { name: 'nodes-v1' });
  assert.deepEqual(nodes.calls[0].opts, { locationHint: 'sam' });
  assert.equal(nodes.calls[0].internal, secret);
  assert.deepEqual(nodes.calls[0].query, { matchId: 'm', playerId: 'p' });
  nodes.leave = () => ({ status: 503, body: { error: 'offline', message: 'offline' } });
  const lv = await API.askNodes(env, '/internal/leave', { matchId: 'm', playerId: 'p' });
  assert.deepEqual([lv.status, API.replyCode(lv.body)], [503, 'offline']);
  assert.deepEqual(nodes.calls[1].body, { matchId: 'm', playerId: 'p' });
  nodes.place = () => new Promise(() => {});
  await assert.rejects(API.askNodes(env, '/internal/place', {}, 20), /no answer/);
  assert.equal(API.replyCode(null), '');
  assert.equal(API.replyCode({ error: 7 }), '');
});

// ---- with the nodes off: exactly as without them ------------------------------------------------------

test('nodes_on absent: a Casual match is a MatchDO, the node registry is never asked, and at the room cap the pair waits (busy, no 503)', async () => {
  const h = await makeMm({ flags: {} });
  const [qa, qb] = await h.pair(A, B);
  assert.equal(qa.json.status, 'matched');
  assert.deepEqual(Object.keys(qa.json).sort(), ['host', 'humans', 'matchId', 'mode', 'status', 'ticket', 'wsUrl']);
  assert.deepEqual([qa.json.mode, qa.json.host, qa.json.humans], ['2v2', 'SA', 2], 'the hub\'s extras: 2 humans play a 2v2');
  assert.deepEqual(created(h)[0].opts, { locationHint: 'sam' }, 'hosted SA: the MatchDO is asked for near São Paulo');
  assert.equal(qa.json.wsUrl, '/ws/' + qa.json.matchId);
  assert.equal(qb.json.matchId, qa.json.matchId);
  assert.equal(created(h).length, 1);
  assert.equal(h.nodes.calls.length, 0, 'no call to the NodeRegistryDO');
  const st = await h.stats();
  assert.deepEqual([st.rooms, st.active, st.nodeLocks], [1, 2, 0]);
  // do_disabled is read before the MatchDO is created (a group let in for the nodes may outlive them: no MatchDO under it).
  assert.deepEqual([...new Set(h.flags.reads)].sort(), ['do_disabled', 'nodes_on', 'vm_disabled']);
  // A server lock verified with its MatchDO, never with the registry.
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
  const r = await h.join(A);
  assert.equal(r.status, 409);
  assert.deepEqual([r.json.kind, r.json.node], ['server', undefined]);
  assert.equal(h.nodes.calls.length, 0);

  const full = await makeMm({ flags: {}, rooms: M.MAX_ACTIVE_ROOMS });
  const cap = await full.join(A);
  assert.deepEqual([cap.status, cap.json.status], [200, 'waiting'], 'no 503 capacity');
  const busy = await full.join(B);
  assert.deepEqual([busy.json.status, busy.json.wait.busy], ['waiting', true]);
  assert.equal(full.nodes.calls.length, 0);
  assert.equal(created(full).length, 0);
});

test('nodes not configured (a fork, a test env): nodes_on is not even read and nothing reaches a node', async () => {
  const h = await makeMm({ flags: { nodes_on: '1' }, configured: false });
  const [qa] = await h.pair(A, B);
  assert.equal(qa.json.wsUrl, '/ws/' + qa.json.matchId);
  assert.equal(created(h).length, 1);
  assert.deepEqual(h.flags.reads, [], 'no KV read');
  const full = await makeMm({ flags: { nodes_on: '1' }, configured: false, rooms: M.MAX_ACTIVE_ROOMS });
  assert.equal((await full.join(A)).json.status, 'waiting');
  assert.equal((await full.join(B)).json.wait.busy, true);
});

// ---- placement ------------------------------------------------------------------------------------

test('a match placed on a node: node: true, the node’s own wss:// URL and ticket, a node lock, no room counted', async () => {
  const h = await makeMm();
  const [qa, qb] = await h.pair(A, B);
  assert.equal(qa.json.status, 'matched');
  assert.equal(qa.json.node, true);
  assert.match(qa.json.matchId, /^[0-9a-f]{64}$/);
  assert.equal(qa.json.wsUrl, `${NODE_URL}/m/${qa.json.matchId}`);
  assert.equal(qa.json.ticket, 'node-ticket.' + A);
  assert.equal(qb.json.ticket, 'node-ticket.' + B);
  assert.equal(qb.json.matchId, qa.json.matchId);
  assert.equal(qa.json.ranked, undefined);
  assert.equal(created(h).length, 0, 'no MatchDO');
  const places = h.nodes.of('/internal/place');
  assert.equal(places.length, 1);
  assert.deepEqual(places[0].body, { mode: '2v2', region: 'SA', ranked: false, matchLengthSeconds: 300, humans: [{ playerId: A, name: 'P-a1b2' }, { playerId: B, name: 'P-0123' }] }, 'no transports, no account fields');
  assert.deepEqual([qa.json.mode, qa.json.host, qa.json.humans], ['2v2', 'SA', 2]);
  const st = await h.stats();
  assert.deepEqual([st.rooms, st.active, st.nodeLocks], [0, 2, 0 + 2], 'MAX_ACTIVE_ROOMS does not count it');
  // A fresh node lock: 409 as a server match with node: true (the client rejoins it).
  const r = await h.join(A, 'p2p');
  assert.equal(r.status, 409);
  assert.deepEqual([r.json.error, r.json.matchId, r.json.kind, r.json.node], ['active_match', qa.json.matchId, 'server', true]);
  assert.match(r.json.message, /rejoin/);
  // The outbox's /release frees the node lock like any other.
  assert.deepEqual((await h.call('/release', { matchId: qa.json.matchId, playerIds: [A, B] })).json, { ok: true, released: 2 });
  assert.equal((await h.stats()).nodeLocks, 0);
});

test('a lone Casual human after 5:00 goes to a node too (hosted SA): its solo match in the format it prefers, in the phase 1 shape', async () => {
  const h = await makeMm();
  assert.equal((await h.join(C, 'p2p')).json.status, 'waiting');
  h.setTime(h.time() + Q.SOLO_AFTER_MS - 1);
  assert.equal((await h.join(C, 'p2p')).json.status, 'waiting', 'not before 5:00');
  h.setTime(h.time() + 1);
  const r = await h.join(C, 'p2p', '1v1', { prefer: '3v3' });
  assert.equal(r.json.status, 'matched');
  assert.deepEqual([r.json.kind, r.json.node, r.json.mode, r.json.humans], [undefined, true, '3v3', 1]);
  const place = h.nodes.of('/internal/place')[0].body;
  assert.deepEqual([place.mode, place.humans], ['3v3', [{ playerId: C, name: 'P-fedc' }]]);
  assert.equal(h.room.calls.length + created(h).length, 0);
});

test('two Casual humans (an older page\'s p2p kind too) go to a node, never to a P2P room; a lobby start never asks for a placement (D10)', async () => {
  const h = await makeMm();
  assert.equal((await h.join(A, 'p2p')).json.status, 'waiting');
  const r = await h.join(B, 'p2p');
  assert.deepEqual([r.json.kind, r.json.node], [undefined, true]);
  const custom = await h.call('/custom', { kind: 'server', mode: '1v1', members: [{ playerId: C, name: 'Carla', team: 0, guest: false }, { playerId: 'c0ffee00c0ffee00', name: 'Dani', team: 1, guest: false }], matchLengthSeconds: 1200 });
  assert.equal(custom.status, 200);
  assert.equal(custom.json.results[C].kind, 'p2p', 'lobbies are P2P only');
  assert.equal(custom.json.results[C].node, undefined);
  assert.equal(created(h).length, 0);
  assert.equal(h.nodes.of('/internal/place').length, 1, 'the Casual pair only');
});

test('an experimental lobby never reaches a node: with the nodes on, its rules go to a RoomDO (a server pick too), a lone start is need_players, a queue join with rules is refused', async () => {
  const h = await makeMm();
  const rules = { v: 1, name: 'Low gravity', values: { gravity: 50, ballDrag: 50 } };
  const members = [{ playerId: A, name: 'Ana', team: 0, guest: false }, { playerId: B, name: 'Beto', team: 1, guest: false }];
  let r = await h.call('/custom', { kind: 'p2p', mode: '1v1', members: members.slice(0, 1), matchLengthSeconds: 300, physics: rules });
  assert.equal(r.json.error, 'need_players', 'a lone human with rules: no MatchDO / node fallback');
  r = await h.join(C, 'server', '1v1', { physics: rules });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'experimental_lobby_only');
  r = await h.join(C, 'ranked', '1v1', { physics: rules });
  assert.equal(r.json.error, 'experimental_lobby_only');
  r = await h.call('/custom', { kind: 'server', mode: '1v1', members, matchLengthSeconds: 300, physics: rules });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[A].kind, 'p2p');
  assert.deepEqual(h.room.calls.find((c) => c.path === '/internal/create').body.physics, rules);
  assert.equal(h.nodes.of('/internal/place').length, 0, 'never asked for a placement');
  assert.equal(created(h).length, 0, 'no MatchDO');
});

test('a ranked match on a node: balanced teams in the placement, the AccountsDO ranked lock on the node’s match id', async () => {
  const h = await makeMm();
  const [qa, qb] = await h.pair(A, B, 'ranked');
  assert.deepEqual([qa.json.node, qa.json.ranked, qb.json.ranked], [true, true, true]);
  const place = h.nodes.of('/internal/place')[0].body;
  assert.equal(place.ranked, true);
  assert.deepEqual(place.teams, { blue: [A], red: [B] });
  const locks = h.accounts.calls.filter((c) => c.path === '/ranked-lock');
  assert.equal(locks.length, 1);
  assert.deepEqual(locks[0].body, { matchId: qa.json.matchId, region: 'SA', userIds: [A, B], until: 1_000_000 + 300_000 + 600_000 });
  assert.equal(created(h).length, 0);
});

// ---- fallbacks to a MatchDO -------------------------------------------------------------------------

/**
 * One server pair on `h`: true when it went to a node, false when to a MatchDO (each in its own
 * shape). Its locks are released afterwards, as the match's end would, so the next pair starts clean.
 */
async function pairOnNode(h, a = A, b = B) {
  const [qa] = await h.pair(a, b);
  assert.equal(qa.json.status, 'matched');
  const onNode = qa.json.node === true;
  assert.equal(qa.json.wsUrl, onNode ? `${NODE_URL}/m/${qa.json.matchId}` : '/ws/' + qa.json.matchId);
  await h.call('/release', { matchId: qa.json.matchId, playerIds: [a, b] });
  return onNode;
}

test('a canary list: nodes only when every human of the match is in it (D8); vm_disabled turns them off', async () => {
  let h = await makeMm({ flags: { nodes_on: `${A}, ${B}` } });
  assert.equal(await pairOnNode(h, A, B), true);
  h = await makeMm({ flags: { nodes_on: A } });
  assert.equal(await pairOnNode(h, A, C), false, 'C is not in the canary');
  assert.equal(h.nodes.calls.length, 0);
  h = await makeMm({ flags: { nodes_on: '1', vm_disabled: '1' } });
  assert.equal(await pairOnNode(h), false);
  assert.equal(h.nodes.calls.length, 0);
  h = await makeMm({ flags: { nodes_on: '0' } });
  assert.equal(await pairOnNode(h), false);
});

test('nodes_on is read again after 10 s, not at every join', async () => {
  const h = await makeMm({ flags: {} });
  assert.equal(await pairOnNode(h), false);
  h.flags.values.nodes_on = '1';
  assert.equal(await pairOnNode(h), false, 'still the value read 0 s ago');
  h.setTime(h.time() + M.NODES_MODE_TTL_MS);
  assert.equal(await pairOnNode(h), true);
  h.flags.values.vm_disabled = '1';
  h.setTime(h.time() + M.NODES_MODE_TTL_MS);
  assert.equal(await pairOnNode(h, C, B), false, 'the kill switch, within the same 10 s');
});

test('a registry that fails (500), throws, does not answer or answers junk: a MatchDO at once, then no placement asked for a minute', async () => {
  const cases = [
    ['500', () => ({ status: 500, body: { error: 'internal' } })],
    ['throw', () => new Error('object reset')],
    ['junk', (body) => ({ body: { placement: placementOf(body, { wsUrl: 'http://evil.example/m' }), hosts: 1 } })],
    ['timeout', () => new Promise(() => {})],
  ];
  for (const [name, place] of cases) {
    const h = await makeMm();
    h.mm.nodeTimeoutMs = 30;
    h.nodes.place = place;
    let onNode;
    const errors = await errorsOf(async () => {
      onNode = await pairOnNode(h);
    });
    assert.equal(onNode, false, name);
    assert.equal(created(h).length, 1, name + ': a MatchDO');
    assert.ok(errors.some((l) => l.includes('node placement failed')), name + ': logged');
    assert.equal(errors.some((l) => l.includes('form failed')), false, name + ': the formation did not fail');
    h.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
    h.setTime(h.time() + M.NO_HOSTS_BACKOFF_MS - 1);
    assert.equal(await pairOnNode(h, C, B), false, name + ': backing off');
    assert.equal(h.nodes.of('/internal/place').length, 1, name + ': asked once');
    h.setTime(h.time() + 1);
    assert.equal(await pairOnNode(h), true, name + ': asked again after a minute');
  }
});

test('no node free: a MatchDO; hosts 0 also stops asking for a minute, a busy node (hosts 1) does not', async () => {
  const h = await makeMm();
  h.nodes.place = () => ({ body: { placement: null, hosts: 1 } });
  assert.equal(await pairOnNode(h), false);
  assert.equal(await pairOnNode(h), false);
  assert.equal(h.nodes.of('/internal/place').length, 2, 'asked for each match');
  h.nodes.place = () => ({ body: { placement: null, hosts: 0 } });
  assert.equal(await pairOnNode(h), false);
  assert.equal(await pairOnNode(h), false);
  assert.equal(h.nodes.of('/internal/place').length, 3, 'not asked again');
  h.setTime(h.time() + M.NO_HOSTS_BACKOFF_MS);
  h.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
  assert.equal(await pairOnNode(h), true);
  assert.equal(created(h).length, 4);
});

// ---- regional placement: a node of the host region first ------------------------------------------

const EU = { home: 'EU' };

/** The control plane with a node in `regions` only: a placement elsewhere finds hosts 0. */
function nodesIn(h, ...regions) {
  h.nodes.place = (body) => (regions.includes(body.region) ? { body: { placement: placementOf(body), hosts: 1 } } : { body: { placement: null, hosts: 0 } });
}

test('a match hosted outside SA asks a node of its own region: two EU accounts in a canary get the EU node (host EU), also with the global cap full', async () => {
  for (const rooms of [0, M.MAX_ACTIVE_ROOMS]) {
    const h = await makeMm({ flags: { nodes_on: `${A},${B}` }, rooms });
    nodesIn(h, 'EU');
    assert.equal((await h.join(A, 'server', '1v1', EU)).json.status, 'waiting');
    const r = await h.join(B, 'server', '1v1', EU);
    assert.deepEqual([r.json.status, r.json.node, r.json.host], ['matched', true, 'EU'], 'rooms ' + rooms);
    assert.deepEqual(h.nodes.of('/internal/place').map((c) => c.body.region), ['EU'], 'asked once, for EU only');
    assert.equal(created(h).length, 0, 'no MatchDO');
    assert.equal((await h.stats()).nodeLocks, 2);
  }
});

test('a ranked match hosted outside SA: the EU node too, with EU in the placement (the region its result names)', async () => {
  const h = await makeMm({ rooms: M.MAX_ACTIVE_ROOMS });
  nodesIn(h, 'EU');
  assert.equal((await h.join(A, 'ranked', '1v1', EU)).json.status, 'waiting');
  const r = await h.join(B, 'ranked', '1v1', EU);
  assert.deepEqual([r.json.status, r.json.node, r.json.ranked, r.json.host], ['matched', true, true, 'EU']);
  const place = h.nodes.of('/internal/place');
  assert.deepEqual(place.map((c) => [c.body.region, c.body.ranked]), [['EU', true]]);
  assert.deepEqual(h.accounts.calls.filter((c) => c.path === '/ranked-lock').map((c) => c.body.region), ['SA'], 'the ranked lock names the hub, where the match is locked');
});

test('no EU node (hosts 0): the EU match goes to a MatchDO near EU, its region the hub\'s, its host EU; EU is not asked again for a minute, SA still is', async () => {
  const h = await makeMm();
  nodesIn(h, 'SA');
  assert.equal((await h.join(A, 'server', '1v1', EU)).json.status, 'waiting');
  const r = await h.join(B, 'server', '1v1', EU);
  assert.deepEqual([r.json.status, r.json.node, r.json.host], ['matched', undefined, 'EU']);
  assert.deepEqual(h.nodes.of('/internal/place').map((c) => c.body.region), ['EU']);
  assert.deepEqual(created(h)[0].opts, { locationHint: 'weur' });
  assert.deepEqual([created(h)[0].body.region, created(h)[0].body.host], ['SA', 'EU'], 'its release comes back to the hub; its ranked result would name EU');
  await h.call('/release', { matchId: r.json.matchId, playerIds: [A, B] });
  // Within the minute: EU forms without asking, SA's pair still asks (the back-off is per region).
  h.setTime(h.time() + M.NO_HOSTS_BACKOFF_MS - 1);
  assert.equal((await h.join(A, 'server', '1v1', EU)).json.status, 'waiting');
  const again = await h.join(B, 'server', '1v1', EU);
  assert.deepEqual([again.json.node, again.json.host], [undefined, 'EU']);
  assert.equal(h.nodes.of('/internal/place').length, 1, 'EU not asked within its minute');
  assert.equal(await pairOnNode(h, C, 'c0ffee00c0ffee00'), true, 'an SA pair still goes to the SA node');
  assert.deepEqual(h.nodes.of('/internal/place').map((c) => c.body.region), ['EU', 'SA']);
  await h.call('/release', { matchId: again.json.matchId, playerIds: [A, B] });
  h.setTime(h.time() + 1);
  nodesIn(h, 'SA', 'EU');
  assert.equal((await h.join(A, 'server', '1v1', EU)).json.status, 'waiting');
  assert.deepEqual([(await h.join(B, 'server', '1v1', EU)).json.node], [true], 'a minute later EU is asked again');
});

test('NA, OC and AF (no node there today): one placement asked a minute, hosts 0, then MatchDOs with their own hints', async () => {
  for (const [home, hint] of [['NA', 'enam'], ['OC', 'oc'], ['AF', 'afr']]) {
    const h = await makeMm();
    nodesIn(h, 'SA');
    for (let i = 0; i < 3; i++) {
      assert.equal((await h.join(A, 'server', '1v1', { home })).json.status, 'waiting');
      const r = await h.join(B, 'server', '1v1', { home });
      assert.deepEqual([r.json.node, r.json.host], [undefined, home], home);
      await h.call('/release', { matchId: r.json.matchId, playerIds: [A, B] });
      h.setTime(h.time() + 10_000);
    }
    assert.deepEqual(h.nodes.of('/internal/place').map((c) => c.body.region), [home], home + ': asked once in the minute');
    assert.deepEqual(created(h).map((c) => c.opts.locationHint), [hint, hint, hint]);
  }
});

test('a ranked MatchDO hosted EU: the create body carries host EU (its result and cancel name EU) and the hub as its region (its release)', async () => {
  const h = await makeMm({ flags: {} });
  assert.equal((await h.join(A, 'ranked', '1v1', EU)).json.status, 'waiting');
  const r = await h.join(B, 'ranked', '1v1', EU);
  assert.deepEqual([r.json.status, r.json.ranked, r.json.host], ['matched', true, 'EU']);
  assert.deepEqual([created(h)[0].body.region, created(h)[0].body.host, created(h)[0].body.ranked], ['SA', 'EU', true]);
  const sa = await makeMm({ flags: {} });
  const [qa] = await sa.pair(A, B, 'ranked');
  assert.deepEqual([qa.json.host, created(sa)[0].body.region, created(sa)[0].body.host], ['SA', 'SA', 'SA'], 'SA as before');
});

test('the release of an EU node match reaches the queue hub through the outbox and frees its locks and its solo row', async () => {
  const O = await import('../src/nodeOutcome.ts');
  const h = await makeMm();
  nodesIn(h, 'EU');
  // A lone EU waiter after 5:00: its solo match on the EU node (a 'solo:' row in the hub).
  assert.equal((await h.join(C, 'server', '1v1', EU)).json.status, 'waiting');
  h.setTime(h.time() + Q.SOLO_AFTER_MS);
  const r = await h.join(C, 'server', '1v1', { ...EU, prefer: '1v1' });
  assert.deepEqual([r.json.status, r.json.node, r.json.host, r.json.humans], ['matched', true, 'EU', 1]);
  const place = h.nodes.of('/internal/place')[0].body;
  assert.equal(place.region, 'EU');
  const soloKey = 'solo:' + r.json.matchId;
  assert.equal(h.mm.ctx.storage.map.has(soloKey), true, 'its solo row');
  assert.equal((await h.stats()).nodeLocks, 1);
  // The node match settles: the NodeRegistryDO's outbox delivers its /release (outcomeCalls -> deliverCall).
  const assign = { matchId: r.json.matchId, mode: place.mode, region: 'EU', ranked: false, roster: [{ slot: 0, team: 0, kind: 'player', name: 'P-fedc', playerId: C }], matchLengthSeconds: 300, kickoffSeed: 1, botDifficulty: 'medium', createdAt: h.time() };
  const calls = O.outcomeCalls({ kind: 'unrated', matchId: r.json.matchId, nodeId: 'node-eu', blue: 1, red: 0, verified: true }, assign, [C]);
  assert.deepEqual(calls.map((c) => [c.target, c.path]), [[O.HUB_TARGET, '/release']]);
  const reached = [];
  const MATCHMAKER = { idFromName: (n) => n, get: (name) => ({ fetch: (url, init) => (reached.push(name), h.mm.fetch(new Request(url, init))) }) };
  assert.equal(await O.deliverCall({ JWT_SECRET: SECRET, REGION_OVERRIDE: '', ACCOUNTS: {}, MATCHMAKER }, calls[0], (l) => assert.fail(l)), 'done');
  assert.deepEqual(reached, ['mm:SA'], 'the hub, never mm:EU');
  assert.equal((await h.stats()).nodeLocks, 0, 'the lock is free');
  assert.equal(h.mm.ctx.storage.map.has(soloKey), false, 'the solo row is gone');
  // Released at once, so never played: the hub read its solo row, and the search goes on with its clock.
  const next = await h.join(C, 'server', '1v1', { ...EU, prefer: '1v1' });
  assert.deepEqual([next.json.status, next.json.node, next.json.host], ['matched', true, 'EU'], 'a new solo match at once, on the EU node');
});

// ---- the room cap and do_disabled (D9) ----------------------------------------------------------------

test('at MAX_ACTIVE_ROOMS a node match still forms; without a node the waiters stay queued (no error), and form once one is free', async () => {
  const h = await makeMm({ rooms: M.MAX_ACTIVE_ROOMS });
  assert.equal(await pairOnNode(h), true, 'not refused at the cap, and placed');
  assert.equal((await h.stats()).rooms, M.MAX_ACTIVE_ROOMS);

  const w = await makeMm({ rooms: M.MAX_ACTIVE_ROOMS });
  w.nodes.place = () => ({ body: { placement: null, hosts: 1 } });
  const errors = await errorsOf(async () => {
    assert.equal((await w.join(A)).json.status, 'waiting');
    assert.equal((await w.join(B)).json.status, 'waiting', 'no node and no room: back in the queue');
  });
  assert.deepEqual(errors, [], 'waiting for a node is no failure');
  assert.equal(created(w).length, 0);
  assert.equal(w.nodes.of('/internal/place').length, 1);
  assert.equal((await w.stats()).queues.casual, 2);
  assert.equal((await w.join(B)).json.wait.busy, true, 'the cap: busy');
  w.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
  w.setTime(w.time() + 5_000); // the queue's retry back-off
  const r = await w.join(A);
  assert.deepEqual([r.json.status, r.json.node], ['matched', true]);
});

test('the cap with a canary: a pair with a player outside it waits busy (no node, no 503); a pair inside it waits for a node', async () => {
  const h = await makeMm({ flags: { nodes_on: A }, rooms: M.MAX_ACTIVE_ROOMS });
  const c = await h.join(C);
  assert.deepEqual([c.status, c.json.status], [200, 'waiting']);
  const a = await h.join(A);
  assert.deepEqual([a.json.status, a.json.wait.busy], ['waiting', true], 'C is outside the canary: a MatchDO, and none is free');
  assert.equal(h.nodes.calls.length, 0);
  await h.call('/leave', { playerId: C });
  const g = await makeMm({ flags: { nodes_on: `${A},${B}` }, rooms: M.MAX_ACTIVE_ROOMS });
  assert.equal((await g.join(A)).json.status, 'waiting');
  assert.deepEqual([(await g.join(B)).json.node], [true], 'both in the canary: a node, the cap does not count it');
});

test('do_disabled with the nodes on: no MatchDO is created; the humans wait for a node and get one when it is free', async () => {
  const h = await makeMm({ flags: { nodes_on: '1', do_disabled: '1' } });
  const off = { doDisabled: true }; // as the Worker sends it
  h.nodes.place = () => ({ body: { placement: null, hosts: 1 } });
  assert.equal((await h.join(A, 'server', '1v1', off)).json.status, 'waiting');
  assert.equal((await h.join(B, 'server', '1v1', off)).json.status, 'waiting', 'a busy node (hosts 1): wait for it');
  h.setTime(h.time() + 5_000);
  assert.equal((await h.join(A, 'server', '1v1', off)).json.status, 'waiting');
  assert.equal(created(h).length, 0, 'never a MatchDO');
  assert.equal(h.nodes.of('/internal/place').length, 2);
  h.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
  h.setTime(h.time() + 5_000);
  assert.equal((await h.join(B, 'server', '1v1', off)).json.node, true);
});

test('do_disabled with the nodes on, where no node can host (hosts 0): the groups wait busy through the back-off, never a 503 (§1.8, §2.1) nor a MatchDO; a node takes them once it is over', async () => {
  const h = await makeMm({ flags: { nodes_on: '1', do_disabled: '1' } });
  h.nodes.place = () => ({ body: { placement: null, hosts: 0 } });
  assert.equal((await h.join(A)).json.status, 'waiting', 'no hosts known yet');
  let polled = null;
  const pollA = h.poll(A).then((r) => (polled = r));
  const rb = await h.join(B); // its placement finds hosts 0
  assert.deepEqual([rb.status, rb.json.status, rb.json.wait.busy, rb.json.wait.estimateKind], [200, 'waiting', true, 'none'], 'waits, busy: no node can take it now');
  await pause(30);
  assert.equal(polled, null, 'A\'s long-poll goes on: nothing is refused');
  // Through the back-off: a newcomer and the waiters wait (no 503), no node is asked, no MatchDO.
  h.setTime(h.time() + 5_000);
  const rc = await h.join(C);
  assert.deepEqual([rc.status, rc.json.status, rc.json.wait.busy], [200, 'waiting', true], 'held with the group');
  const ra = await h.join(A);
  assert.deepEqual([ra.status, ra.json.status, ra.json.wait.busy], [200, 'waiting', true]);
  assert.equal((await h.stats()).queues.casual, 3, 'all three still queued');
  assert.deepEqual([created(h).length, h.nodes.of('/internal/place').length], [0, 1], 'never a MatchDO; no node asked in the back-off');
  // A minute later a node may be back: the three (polling meanwhile) get one.
  h.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
  let last = [];
  for (let i = 0; i < 3; i++) {
    h.setTime(h.time() + 20_000);
    last = [];
    for (const id of [A, B, C]) last.push(await h.join(id));
  }
  assert.deepEqual(last.map((r) => [r.json.status, r.json.node]), [['matched', true], ['matched', true], ['matched', true]]);
  await pollA;
  assert.deepEqual([polled.json.status, polled.json.node], ['matched', true], 'the first long-poll got the match too');
  assert.equal(created(h).length, 0);

  // At the cap without do_disabled: once no node can host, newcomers wait (no 503) and the
  // waiters wait for a free room without asking again.
  const full = await makeMm({ rooms: M.MAX_ACTIVE_ROOMS });
  full.nodes.place = () => ({ body: { placement: null, hosts: 0 } });
  assert.equal((await full.join(A)).json.status, 'waiting');
  assert.equal((await full.join(B)).json.status, 'waiting');
  const c = await full.join(C);
  assert.deepEqual([c.status, c.json.status, c.json.wait.busy], [200, 'waiting', true], 'held with the group at the cap');
  const fullReads = full.flags.reads.filter((n) => n === 'do_disabled').length;
  full.setTime(full.time() + 5_000);
  assert.equal((await full.join(A)).json.wait.busy, true);
  assert.equal(full.nodes.of('/internal/place').length, 1);
  assert.equal(full.flags.reads.filter((n) => n === 'do_disabled').length, fullReads, 'no formation tried at the cap');
});

test('do_disabled outside SA: a node of the host region first, then one of SA (host SA), never a MatchDO; with neither the group waits busy', async () => {
  const flags = { nodes_on: '1', do_disabled: '1' };
  const off = { ...EU, doDisabled: true }; // as the Worker sends it
  // An EU node free: the EU node.
  const both = await makeMm({ flags });
  nodesIn(both, 'EU', 'SA');
  assert.equal((await both.join(A, 'server', '1v1', off)).json.status, 'waiting');
  const r1 = await both.join(B, 'server', '1v1', off);
  assert.deepEqual([r1.json.node, r1.json.host], [true, 'EU']);
  assert.deepEqual(both.nodes.of('/internal/place').map((c) => c.body.region), ['EU']);

  // No EU node (hosts 0): SA's, the result's host SA; within EU's minute SA is asked straight away.
  const sa = await makeMm({ flags });
  nodesIn(sa, 'SA');
  assert.equal((await sa.join(A, 'server', '1v1', off)).json.status, 'waiting');
  const r2 = await sa.join(B, 'server', '1v1', off);
  assert.deepEqual([r2.json.node, r2.json.host], [true, 'SA']);
  assert.deepEqual(sa.nodes.of('/internal/place').map((c) => c.body.region), ['EU', 'SA']);
  await sa.call('/release', { matchId: r2.json.matchId, playerIds: [A, B] });
  sa.setTime(sa.time() + 6_000);
  assert.equal((await sa.join(A, 'server', '1v1', off)).json.status, 'waiting');
  assert.deepEqual([(await sa.join(B, 'server', '1v1', off)).json.host], ['SA']);
  assert.deepEqual(sa.nodes.of('/internal/place').map((c) => c.body.region), ['EU', 'SA', 'SA'], 'EU backs off: SA at once');
  // A ranked EU group the same way: placed in SA, so its result names SA (the assignment's region).
  for (const id of [C, 'c0ffee00c0ffee00']) await sa.join(id, 'ranked', '1v1', off);
  const ranked = sa.nodes.of('/internal/place').at(-1).body;
  assert.deepEqual([ranked.region, ranked.ranked], ['SA', true]);
  assert.equal(created(sa).length, 0);

  // Neither: the group waits busy, no MatchDO, and nothing is refused.
  const none = await makeMm({ flags });
  nodesIn(none);
  assert.equal((await none.join(A, 'server', '1v1', off)).json.status, 'waiting');
  const r3 = await none.join(B, 'server', '1v1', off);
  assert.deepEqual([r3.status, r3.json.status, r3.json.wait.busy], [200, 'waiting', true]);
  assert.deepEqual(none.nodes.of('/internal/place').map((c) => c.body.region), ['EU', 'SA']);
  none.setTime(none.time() + 6_000);
  const r4 = await none.join(A, 'server', '1v1', off);
  assert.deepEqual([r4.json.status, r4.json.wait.busy], ['waiting', true]);
  assert.equal(none.nodes.of('/internal/place').length, 2, 'both regions back off for their minute');
  assert.equal(created(none).length, 0, 'never a MatchDO');
  assert.equal((await none.stats()).queues.casual, 2);
});

test('do_disabled, and the owner turns the nodes off while groups wait for one: still no MatchDO (Casual and ranked); they wait busy until the Worker\'s own 503 ends each search', async () => {
  const D = 'd4c3b2a1f6e50718';
  const h = await makeMm({ flags: { nodes_on: '1', do_disabled: '1' } });
  h.nodes.place = () => ({ body: { placement: null, hosts: 0 } });
  await h.join(A);
  assert.equal((await h.join(B)).json.wait.busy, true, 'no node can host: busy');
  await h.join(C, 'ranked');
  assert.equal((await h.join(D, 'ranked')).json.wait.busy, true);
  delete h.flags.values.nodes_on;
  h.flags.values.vm_disabled = '1';
  // No POST in between (their long-polls are open): the hub reads the nodes again, the back-off is over.
  h.setTime(h.time() + M.NODES_MODE_TTL_MS + 1_000);
  if (h.mm.sweepTimer) clearTimeout(h.mm.sweepTimer);
  h.mm.sweepTimer = null;
  await h.mm.sweep();
  await pause(10);
  assert.equal(created(h).length, 0, 'never a MatchDO under do_disabled');
  const st = await h.stats();
  assert.deepEqual([st.queues.casual, st.queues['1v1:ranked'], st.forming], [2, 2, 0], 'all four still queued');
  // A join that still reached the hub (the Worker now answers these players 503 first) finds the group waiting, busy.
  h.setTime(h.time() + 6_000);
  const again = await h.join(A);
  assert.deepEqual([again.json.status, again.json.wait.busy, created(h).length], ['waiting', true, 0]);
});

test('a group that finds no node and no MatchDO (the cap) backs off: no placement asked again within RETRY_AFTER_MS (busy meanwhile); hosts 0 stops asking for a minute', async () => {
  for (const [flags, hosts] of [[{ nodes_on: `${A},${B}` }, 1], [{ nodes_on: '1' }, 1], [{ nodes_on: '1' }, 0]]) {
    const label = JSON.stringify({ flags, hosts });
    const h = await makeMm({ flags, rooms: M.MAX_ACTIVE_ROOMS });
    h.nodes.place = () => ({ body: { placement: null, hosts } });
    assert.equal((await h.join(A)).json.status, 'waiting', label);
    const b = await h.join(B);
    assert.deepEqual([b.json.status, b.json.wait.busy], ['waiting', true], label + ': no node and no room');
    h.setTime(h.time() + 1_000);
    assert.equal((await h.join(A)).json.status, 'waiting', label);
    assert.equal(h.nodes.of('/internal/place').length, 1, label + ': not asked again within its back-off');
    h.setTime(h.time() + 5_000);
    assert.equal((await h.join(A)).json.status, 'waiting', label);
    assert.equal(h.nodes.of('/internal/place').length, hosts === 1 ? 2 : 1, label + (hosts === 1 ? ': asked again after it' : ': hosts 0: not for a minute'));
  }
});

// ---- node locks: verified with the registry ------------------------------------------------------------

test('a node lock is checked with the registry: assigned or reporting holds it; verifying, done, left or 404 frees it; an error keeps it', async () => {
  const h = await makeMm();
  const [qa] = await h.pair(A, B);
  const id = qa.json.matchId;
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
  const answers = [
    [{ body: { state: 'assigned', left: false } }, 409],
    [{ body: { state: 'reporting', left: false } }, 409],
    [{ status: 500, body: { error: 'internal' } }, 409],
    [{ status: 503, body: { error: 'nodes_unavailable' } }, 409],
    [new Error('object reset'), 409],
    [{ body: {} }, 409], // a 200 that is no status keeps it
    [{ body: null }, 409],
    [{ body: { state: 'done' } }, 409],
  ];
  for (const [answer, status] of answers) {
    h.nodes.status = () => answer;
    const errors = await errorsOf(async () => {
      const r = await h.join(A);
      assert.equal(r.status, status, JSON.stringify(answer));
      assert.deepEqual([r.json.kind, r.json.node, r.json.matchId], ['server', true, id]);
    });
    if (answer instanceof Error) assert.ok(errors.some((l) => l.includes('lock verification failed')));
  }
  const last = h.nodes.of('/internal/status').at(-1);
  assert.deepEqual(last.query, { matchId: id, playerId: A });
  assert.equal(last.internal, secret);
  h.nodes.status = () => ({ body: { state: 'verifying', left: false } });
  assert.equal((await h.join(A)).json.status, 'waiting', 'verifying: the match is over for the player');
  h.nodes.status = () => ({ status: 404, body: { error: 'no_match' } });
  assert.equal((await h.join(B, 'p2p')).json.status, 'matched', 'unknown to the control plane: freed (and A was waiting: they pair again)');
  assert.equal(h.room.calls.length, 0, 'no room is told of a node lock');
  await h.call('/leave', { playerId: A });
  await h.call('/leave', { playerId: B });

  const g = await makeMm();
  const [qc] = await g.pair(C, B);
  g.setTime(g.time() + M.LOCK_VERIFY_AFTER_MS);
  g.nodes.status = () => ({ body: { state: 'assigned', left: true } });
  assert.equal((await g.join(C)).json.status, 'waiting', 'left: free while the match goes on');
  g.nodes.status = () => ({ body: { state: 'done', left: false } });
  assert.equal((await g.join(B)).json.status, 'matched', 'done: free, and C was waiting');
  assert.notEqual((await g.join(B)).json.matchId, qc.json.matchId);
});

test('a node lock left over where the nodes are no longer configured holds nothing', async () => {
  const h = await makeMm();
  const [qa] = await h.pair(A, B);
  for (const k of ['NODES', 'NODE_REPLAYS', 'NODE_RELEASES', 'NODE_CONTROL_PRIVATE_KEY', 'NODE_CONTROL_PUBLIC_KEY', 'NODES_PUBLIC_BASE']) delete h.env[k];
  h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
  assert.equal((await h.join(A)).json.status, 'waiting');
  assert.deepEqual((await h.call('/leave', { playerId: B, matchId: qa.json.matchId })).json, { ok: true, left: false, released: true });
  assert.equal(h.nodes.of('/internal/status').length + h.nodes.of('/internal/leave').length, 0);
});

// ---- /leave of a node match (P23) -----------------------------------------------------------------------

test('/leave of a node match: the node first; recorded (200), unknown (404) or over (410) frees the lock; connected: false is passed on', async () => {
  for (const [answer, connected] of [[{}, undefined], [{}, false], [{ status: 404, body: { error: 'no_match' } }, undefined], [{ status: 410, body: { error: 'match_over' } }, undefined]]) {
    const h = await makeMm();
    const [qa] = await h.pair(A, B);
    if (answer.status) h.nodes.leave = () => answer;
    const r = await h.call('/leave', { playerId: A, matchId: qa.json.matchId, ...(connected === false ? { connected: false } : {}) });
    assert.deepEqual(r.json, { ok: true, left: false, released: true }, JSON.stringify(answer));
    const leaves = h.nodes.of('/internal/leave');
    assert.equal(leaves.length, 1);
    assert.deepEqual(leaves[0].body, { matchId: qa.json.matchId, playerId: A, ...(connected === false ? { connected: false } : {}) });
    const st = await h.stats();
    assert.deepEqual([st.active, st.nodeLocks], [1, 1], 'only B is still locked');
    assert.equal((await h.join(A, 'p2p')).json.status, 'waiting', 'A queues again at once');
    await h.call('/leave', { playerId: A });
  }
});

test('/leave of a node match the node did not take (503, an error, no answer): the lock stays, released: false', async () => {
  for (const leave of [() => ({ status: 503, body: { error: 'offline' } }), () => ({ status: 500, body: { error: 'internal' } }), () => new Error('reset'), () => new Promise(() => {})]) {
    const h = await makeMm();
    h.mm.nodeTimeoutMs = 30;
    const [qa] = await h.pair(A, B);
    h.nodes.leave = leave;
    const errors = await errorsOf(async () => {
      const r = await h.call('/leave', { playerId: A, matchId: qa.json.matchId });
      assert.deepEqual(r.json, { ok: true, left: false, released: false });
    });
    assert.ok(errors.some((l) => l.includes('lock kept')));
    assert.equal((await h.stats()).nodeLocks, 2);
    h.setTime(h.time() + M.LOCK_VERIFY_AFTER_MS);
    const r = await h.join(A, 'p2p');
    assert.deepEqual([r.status, r.json.node], [409, true], 'still in the match: no second one');
  }
});

test('/leave without the node match’s id (Esc in a queue, a P2P teardown) or with another id keeps the node lock and never calls the node', async () => {
  const h = await makeMm();
  await h.pair(A, B);
  assert.deepEqual((await h.call('/leave', { playerId: A })).json, { ok: true, left: false, released: false });
  assert.deepEqual((await h.call('/leave', { playerId: A, matchId: 'f'.repeat(64) })).json, { ok: true, left: false, released: false });
  assert.equal(h.nodes.of('/internal/leave').length, 0);
  assert.equal((await h.stats()).nodeLocks, 2);
});

// ---- a placement in flight: polls, leaves, the sweep, the first nodes_on read -------------------------

test('while a node placement is in flight, a poll of its humans waits for the outcome instead of answering at once', async () => {
  const h = await makeMm();
  const gate = deferred();
  holdPlace(h, gate);
  assert.equal((await h.join(A)).json.status, 'waiting');
  const formingB = h.join(B); // forms the match: its placement is held open
  await formingOf(h, 2);
  // A between two long-polls: its join answers 'waiting' (the Worker polls next), and the poll waits
  // (an answer at once would have the client ask again at once, into the queue rate limit).
  assert.equal((await h.join(A)).json.status, 'waiting');
  let polled = null;
  const pollA = h.poll(A).then((r) => (polled = r));
  await pause(30);
  assert.equal(polled, null, 'no answer while the node is asked');
  gate.resolve();
  const rb = await formingB;
  await pollA;
  assert.deepEqual([polled.json.status, polled.json.node, polled.json.matchId], ['matched', true, rb.json.matchId]);

  // No node and no MatchDO allowed: back in the queue, its poll still waiting, answered by the next formation.
  const w = await makeMm({ flags: { nodes_on: '1', do_disabled: '1' } });
  const g = deferred();
  holdPlace(w, g, () => ({ placement: null, hosts: 1 }));
  await w.join(A);
  const formingB2 = w.join(B);
  await formingOf(w, 2);
  let polled2 = null;
  const pollA2 = w.poll(A).then((r) => (polled2 = r));
  g.resolve();
  assert.equal((await formingB2).json.status, 'waiting');
  await pause(30);
  assert.equal(polled2, null, 'still waiting, in the queue again');
  w.nodes.place = (body) => ({ body: { placement: placementOf(body), hosts: 1 } });
  w.setTime(w.time() + 5_000);
  assert.equal((await w.join(B)).json.node, true);
  await pollA2;
  assert.deepEqual([polled2.json.status, polled2.json.node], ['matched', true]);
});

test('a /leave while the match is being placed takes the player out: the node match is quit with connected: false, nothing is handed to it', async () => {
  const h = await makeMm();
  const gate = deferred();
  holdPlace(h, gate);
  await h.join(A);
  const formingB = h.join(B);
  await formingOf(h, 2);
  assert.deepEqual((await h.call('/leave', { playerId: A })).json, { ok: true, left: true, released: false });
  // Esc, then Play again at once: it waits for that formation's end and gets nothing of it.
  assert.equal((await h.join(A)).json.status, 'waiting');
  let polled = null;
  h.poll(A).then((r) => (polled = r));
  // The match is placed; A's leave of it is held open at the node: still nothing reaches A (no
  // ticket from its cached result, no 409 from its lock).
  const leaveGate = deferred();
  const recorded = h.nodes.leave;
  h.nodes.leave = async (body) => {
    await leaveGate.promise;
    return recorded(body);
  };
  gate.resolve();
  assert.ok(await until(() => h.nodes.of('/internal/leave').length === 1));
  assert.equal((await h.join(A)).json.status, 'waiting');
  let polledLate = null;
  h.poll(A).then((r) => (polledLate = r));
  await pause(20);
  assert.deepEqual([polled, polledLate], [null, null]);
  leaveGate.resolve();
  const rb = await formingB;
  assert.deepEqual([rb.json.status, rb.json.node], ['matched', true]);
  assert.ok(await until(() => polled !== null && polledLate !== null, 500), 'answered at the end of the formation');
  assert.deepEqual([polled.json.status, polledLate.json.status], ['waiting', 'waiting']);
  assert.deepEqual(h.nodes.of('/internal/leave').map((c) => c.body), [{ matchId: rb.json.matchId, playerId: A, connected: false }]);
  const st = await h.stats();
  assert.deepEqual([st.active, st.nodeLocks, st.forming, st.matched], [1, 1, 0, 1], 'only B holds the match');
  assert.equal((await h.join(A)).json.status, 'waiting', 'a fresh waiter: no 409');
  assert.equal((await h.stats()).queues.casual, 1);

  // The node does not take that leave (offline): D12, the lock stays and the next queue gets the match.
  const g = await makeMm();
  const gate2 = deferred();
  holdPlace(g, gate2);
  g.nodes.leave = () => ({ status: 503, body: { error: 'offline' } });
  await g.join(A);
  const formingB2 = g.join(B);
  await formingOf(g, 2);
  await g.call('/leave', { playerId: A });
  const errors = await errorsOf(async () => {
    gate2.resolve();
    await formingB2;
  });
  assert.ok(errors.some((l) => l.includes('lock kept')));
  assert.equal((await g.stats()).nodeLocks, 2);
  const ra = await g.join(A);
  assert.deepEqual([ra.json.status, ra.json.node], ['matched', true]);
});

test('a /leave while the nodes are asked for a match none takes: no MatchDO is created with the player, and it is not put back in the queue', async () => {
  for (const opts of [{}, { flags: { nodes_on: '1', do_disabled: '1' } }, { rooms: M.MAX_ACTIVE_ROOMS }]) {
    const label = JSON.stringify(opts);
    const h = await makeMm(opts);
    const gate = deferred();
    holdPlace(h, gate, () => ({ placement: null, hosts: 1 }));
    await h.join(A);
    const formingB = h.join(B);
    await formingOf(h, 2);
    assert.equal((await h.call('/leave', { playerId: A })).json.left, true, label);
    gate.resolve();
    assert.equal((await formingB).json.status, 'waiting', label);
    assert.equal(created(h).length, 0, label + ': no MatchDO');
    const st = await h.stats();
    assert.deepEqual([st.queues.casual, st.active, st.forming], [1, 0, 0], label + ': B alone in the queue');
    if (opts.flags === undefined && opts.rooms === undefined) {
      // A leave is no failure: no retry back-off, B forms with the next human at once (without A).
      h.nodes.place = () => ({ body: { placement: null, hosts: 1 } });
      assert.equal((await h.join(C)).json.status, 'matched');
      assert.deepEqual(created(h)[0].body.roster.filter((e) => e.kind === 'player').map((e) => e.playerId), [B, C]);
    }
  }
});

test('a /leave while its MatchDO is being created: its lock stays, as for a leave without its id, and the next queue gets that match', async () => {
  const g = await makeMm({ flags: {} });
  const mGate = deferred();
  const realNs = g.env.MATCH;
  g.env.MATCH = {
    ...realNs,
    get: (id, opts) => ({
      fetch: async (url, init) => {
        if (new URL(url).pathname === '/internal/create') await mGate.promise;
        return realNs.get(id, opts).fetch(url, init);
      },
    }),
  };
  await g.join(A);
  const formingB2 = g.join(B);
  await formingOf(g, 2);
  assert.equal((await g.call('/leave', { playerId: A })).json.left, true);
  mGate.resolve();
  const rb2 = await formingB2;
  const ra = await g.join(A);
  assert.deepEqual([ra.json.status, ra.json.matchId], ['matched', rb2.json.matchId], 'the next queue gets that match');
  assert.equal(g.match.calls.filter((c) => c.path === '/internal/leave').length, 0);
});

test('a slow node placement does not hold up the other formations: a pair of another region forms its MatchDO meanwhile', async () => {
  const h = await makeMm();
  const gate = deferred();
  holdPlace(h, gate);
  const held = h.nodes.place;
  // SA's placement is held open; EU has no node (hosts 0 at once): a MatchDO near EU.
  h.nodes.place = (body) => (body.region === 'SA' ? held(body) : { body: { placement: null, hosts: 0 } });
  assert.equal((await h.join(A)).json.status, 'waiting');
  const formingAB = h.join(B); // hosted SA: its placement is held open
  await formingOf(h, 2);
  assert.equal((await h.join(C, 'server', '1v1', { home: 'EU' })).json.status, 'waiting');
  const d = await h.join('c0ffee00c0ffee00', 'server', '1v1', { home: 'EU' });
  assert.deepEqual([d.json.status, d.json.host, d.json.node], ['matched', 'EU', undefined], 'the EU pair formed while A and B are placed');
  assert.equal((await h.stats()).forming, 2);
  gate.resolve();
  assert.equal((await formingAB).json.node, true);
  assert.equal((await h.stats()).nodeLocks, 2);
});

test('a fresh matchmaker: joins that land while its first nodes_on read is in flight wait for it, never use the default off', async () => {
  const h = await makeMm({ flags: { nodes_on: '1', do_disabled: '1' } });
  const off = { doDisabled: true };
  const gate = deferred();
  const asked = [];
  const get = h.env.FLAGS.get;
  h.env.FLAGS.get = async (name) => {
    asked.push(name);
    if (name === 'nodes_on') await gate.promise;
    return get(name);
  };
  const joinB = h.join(B, 'server', '1v1', off); // the first read: KV slow
  assert.ok(await until(() => asked.includes('nodes_on')));
  const joinC = h.join(C, 'server', '1v1', off);
  await pause(20); // C is at its readNodes by now
  gate.resolve();
  const [rb, rc] = await Promise.all([joinB, joinC]);
  assert.deepEqual([rb.json.status, rc.json.status, rc.json.node], ['waiting', 'matched', true]);
  assert.equal(created(h).length, 0, 'no MatchDO while do_disabled is set');
  assert.equal(h.flags.reads.filter((n) => n === 'nodes_on').length, 1, 'one read for both');
});

// ---- the Worker: /api/queue, /api/rejoin, /api/leave ----------------------------------------------------

/**
 * A Worker env: the matchmaker answers every /join with `joinAnswer` and records its calls; MATCH
 * and ROOM take no id (every id here is a node's); `nodes` is configured unless `configured: false`.
 */
function workerEnv({ flags = {}, configured = true, joinAnswer = { status: 'waiting', waiting: 1 } } = {}) {
  const nodes = fakeNodes();
  const mmCalls = [];
  const notOurs = () => {
    throw new Error('not an id of this namespace');
  };
  const env = {
    JWT_SECRET: SECRET,
    REGION_OVERRIDE: 'SA',
    FLAGS: kv(flags).FLAGS,
    MATCH: { idFromString: notOurs },
    ROOM: { idFromString: notOurs },
    MATCHMAKER: {
      idFromName: (n) => n,
      get: (name) => ({
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          mmCalls.push({ name, path, body: init.body ? JSON.parse(init.body) : null });
          const out = path === '/join' || path === '/poll' ? joinAnswer : path === '/leave' ? { ok: true, left: false, released: true } : { ok: true };
          return new RealResponse(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
    ...(configured ? nodeSettings(nodes) : {}),
  };
  return { env, nodes, mmCalls };
}

async function post(env, path, body, token) {
  const res = await worker.fetch(new Request('https://turbo-gol.com' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json() };
}

/** An account session (Casual and ranked are for accounts: a guest gets 403 account_required). */
const tokenOf = (playerId) => signJwt(SECRET, { sub: playerId, name: 'P-' + playerId.slice(0, 4), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });

test('Worker /api/queue: a node match keeps the node’s wss:// URL; a MatchDO match still gets the Worker’s /ws/ one', async () => {
  const id = hex64();
  const onNode = workerEnv({ joinAnswer: { status: 'matched', matchId: id, ticket: 'node-ticket', wsUrl: `${NODE_URL}/m/${id}`, node: true } });
  let r = await post(onNode.env, '/api/queue', { api: 2, mode: '1v1', kind: 'server' }, await tokenOf(A));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'matched', matchId: id, ticket: 'node-ticket', wsUrl: `${NODE_URL}/m/${id}`, node: true, region: 'SA' });
  const onDo = workerEnv({ joinAnswer: { status: 'matched', matchId: id, ticket: 't', wsUrl: '/ws/' + id } });
  r = await post(onDo.env, '/api/queue', { api: 2, mode: '1v1', kind: 'server' }, await tokenOf(A));
  assert.equal(r.json.wsUrl, 'wss://turbo-gol.com/ws/' + id);
  assert.equal(r.json.node, undefined);
});

test('Worker /api/queue with do_disabled: 503 as before unless the nodes are on for this player; then Casual (an older p2p kind too) waits for a node (D9)', async () => {
  const server = { api: 2, mode: '1v1', kind: 'server' };
  const p2p = { api: 2, mode: '1v1', kind: 'p2p', p2pProtocol: ROOM_PROTOCOL };
  const cases = [
    [{ do_disabled: '1' }, true, A, server, 503],
    [{ do_disabled: '1' }, true, A, p2p, 503],
    [{ do_disabled: '1', nodes_on: '1' }, false, A, server, 503], // not configured: nodes_on means nothing
    [{ do_disabled: '1', nodes_on: '1', vm_disabled: '1' }, true, A, server, 503],
    [{ do_disabled: '1', nodes_on: '1' }, true, A, server, 200],
    [{ do_disabled: '1', nodes_on: '1' }, true, A, p2p, 200], // 'p2p' is Casual: no RoomDO any more
    [{ do_disabled: '1', nodes_on: A }, true, A, server, 200],
    [{ do_disabled: '1', nodes_on: A }, true, C, server, 503],
    [{ nodes_on: A }, true, C, p2p, 200],
  ];
  for (const [flags, configured, who, body, status] of cases) {
    const w = workerEnv({ flags, configured });
    const r = await post(w.env, '/api/queue', body, await tokenOf(who));
    const label = JSON.stringify({ flags, configured, who, kind: body.kind });
    assert.equal(r.status, status, label + ' ' + JSON.stringify(r.json));
    if (status === 503) {
      assert.equal(r.json.error, 'do_disabled', label);
      assert.equal(w.mmCalls.length, 0, label + ': the matchmaker never hears of it');
    }
    // The 503 is the Worker's alone: the hub refuses nothing for do_disabled (its groups wait for a node, busy).
    if (status === 200) assert.equal('doDisabled' in w.mmCalls[0].body, false, label);
    assert.equal(w.nodes.calls.length, 0, label);
  }
});

test('Worker /api/rejoin of a node match: a fresh node ticket and the node’s URL; the refusals free or keep the lock as for a MatchDO', async () => {
  const token = await tokenOf(A);
  const id = hex64();
  let w = workerEnv();
  let r = await post(w.env, '/api/rejoin', { matchId: id }, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'matched', matchId: id, ticket: 'node-ticket-again.' + A, wsUrl: `${NODE_URL}/m/${id}`, node: true });
  assert.deepEqual(w.nodes.of('/internal/rejoin')[0].body, { matchId: id, playerId: A });
  assert.equal(w.mmCalls.length, 0);

  const refusals = [
    [410, 'left', false],
    [410, 'match_over', true],
    [404, 'no_match', true],
    [404, 'not_in_match', true],
    [503, 'offline', false],
    [503, 'nodes_unavailable', false],
  ];
  for (const [status, code, releases] of refusals) {
    w = workerEnv();
    w.nodes.rejoin = () => ({ status, body: { error: code, message: code } });
    r = await post(w.env, '/api/rejoin', { matchId: id, region: 'SA' }, token);
    assert.deepEqual([r.status, r.json.error], [status, code]);
    assert.deepEqual(w.mmCalls, releases ? [{ name: 'mm:SA', path: '/release', body: { matchId: id, playerIds: [A] } }] : [], code);
  }
  w = workerEnv();
  w.nodes.rejoin = () => new Error('object reset');
  const errors = await errorsOf(async () => {
    r = await post(w.env, '/api/rejoin', { matchId: id }, token);
  });
  assert.deepEqual([r.status, r.json.error], [503, 'offline'], 'no answer: as if the node were out of reach, the lock stays');
  assert.equal(w.mmCalls.length, 0);
  assert.ok(errors.some((l) => l.includes('node rejoin failed')));
});

test('Worker /api/rejoin: a registry 200 that is no ticket (none, a relative or ws:// URL, null or not JSON) is 503 offline and the lock stays', async () => {
  const token = await tokenOf(C); // A has used most of its rejoins per minute above
  for (const body of [{}, { ticket: 't', wsUrl: '/m/x' }, { ticket: 't', wsUrl: 'ws://sp1.turbo-gol.com/m/x' }, { ticket: '', wsUrl: `${NODE_URL}/m/x` }, null]) {
    const w = workerEnv();
    w.nodes.rejoin = () => ({ body });
    let r;
    const errors = await errorsOf(async () => {
      r = await post(w.env, '/api/rejoin', { matchId: hex64() }, token);
    });
    assert.deepEqual([r.status, r.json.error], [503, 'offline'], JSON.stringify(body));
    assert.equal(w.mmCalls.length, 0, 'the lock stays');
    assert.ok(errors.some((l) => l.includes('node rejoin')));
  }
});

test('Worker /api/rejoin of an id that is neither a MatchDO, a RoomDO nor a node match: 404 and its lock freed', async () => {
  const token = await tokenOf(B);
  const id = hex64();
  const w = workerEnv({ configured: false });
  const r = await post(w.env, '/api/rejoin', { matchId: id }, token);
  assert.deepEqual([r.status, r.json.error], [404, 'no_match']);
  assert.deepEqual(w.mmCalls, [{ name: 'mm:SA', path: '/release', body: { matchId: id, playerIds: [B] } }]);
  assert.equal((await post(w.env, '/api/rejoin', { matchId: 'zz' }, token)).status, 400, 'not 64 hex: still 400');
});

test('Worker /api/leave passes connected: false on to the matchmaker, and nothing else', async () => {
  const w = workerEnv();
  const token = await tokenOf(C);
  const id = hex64();
  for (const connected of [false, true, 'false', undefined]) await post(w.env, '/api/leave', { matchId: id, ...(connected === undefined ? {} : { connected }) }, token);
  assert.deepEqual(
    w.mmCalls.map((c) => c.body),
    [{ playerId: C, matchId: id, connected: false }, { playerId: C, matchId: id }, { playerId: C, matchId: id }, { playerId: C, matchId: id }],
  );
  assert.equal(w.nodes.calls.length, 0, 'the matchmaker calls the node, not the Worker');
});

// ---- cosmetic cars on node matches (src/net/cosmetics.ts) ----------------------------------------------

test("a node match's cars: the placement takes each human's car, account and age (the control plane keeps them; the node's assignment never has them), the result carries the cars by slot; none at all when every seat drives the default", async () => {
  const h = await makeMm();
  const seatA = { car: 'tero', account: true, accountAgeDays: 12.7 };
  assert.equal((await h.join(A, 'server', '1v1', seatA)).json.status, 'waiting');
  const qb = await h.join(B, 'server', '1v1', { car: 'not-a-car', account: true });
  const qa = await h.join(A, 'server', '1v1', seatA);
  const place = h.nodes.of('/internal/place')[0].body;
  assert.deepEqual(place.humans, [
    { playerId: A, name: 'P-a1b2', account: true, accountAgeDays: 12, car: 'tero' },
    { playerId: B, name: 'P-0123', account: true },
  ]);
  assert.deepEqual(qa.json.cars, ['tero', null, null, null], 'by slot (the placement put A in slot 0; two humans play a 2v2)');
  assert.deepEqual(qb.json.cars, qa.json.cars, 'every seat gets the whole match');
  assert.equal(qa.json.node, true);
  await h.call('/release', { matchId: qa.json.matchId, playerIds: [A, B] });
  // Nobody on another car: the result is exactly what it was before cars.
  const [pa] = await h.pair(A, B);
  assert.equal('cars' in pa.json, false);
  assert.deepEqual(Object.keys(pa.json).sort(), ['host', 'humans', 'matchId', 'mode', 'node', 'status', 'ticket', 'wsUrl']);
});

test("Worker /api/rejoin of a node match passes the match's cars on; a `cars` of another shape is dropped and the ticket still counts", async () => {
  const P = 'c0ffee00c0ffee00'; // its own rejoin budget (10 a minute per player)
  const token = await tokenOf(P);
  const id = hex64();
  let w = workerEnv();
  w.nodes.rejoin = (body) => ({ body: { ticket: 'again.' + body.playerId, wsUrl: `${NODE_URL}/m/${body.matchId}`, cars: [null, 'condor'] } });
  let r = await post(w.env, '/api/rejoin', { matchId: id }, token);
  assert.deepEqual(r.json, { status: 'matched', matchId: id, ticket: 'again.' + P, wsUrl: `${NODE_URL}/m/${id}`, node: true, cars: [null, 'condor'] });
  w = workerEnv();
  w.nodes.rejoin = (body) => ({ body: { ticket: 't', wsUrl: `${NODE_URL}/m/${body.matchId}`, cars: ['x'] } });
  r = await post(w.env, '/api/rejoin', { matchId: id }, token);
  assert.equal(r.status, 200);
  assert.equal('cars' in r.json, false);
  const url = `${NODE_URL}/m/x`;
  for (const junk of [['x'], 'tero', [1, 2], Array(7).fill(null), { 0: 'tero' }]) assert.deepEqual(API.rejoinTicketOf({ ticket: 't', wsUrl: url, cars: junk }), { ticket: 't', wsUrl: url }, JSON.stringify(junk));
  assert.deepEqual(API.rejoinTicketOf({ ticket: 't', wsUrl: url, cars: ['tero', null] }), { ticket: 't', wsUrl: url, cars: ['tero', null] });
  assert.equal(API.rejoinTicketOf({ ticket: 't', wsUrl: '/m/x', cars: ['tero'] }), null, 'cars never make a ticket of what is none');
  // A queue answer from the matchmaker keeps its cars too.
  const onNode = workerEnv({ joinAnswer: { status: 'matched', matchId: id, ticket: 'n', wsUrl: `${NODE_URL}/m/${id}`, node: true, cars: ['tero', null] } });
  r = await post(onNode.env, '/api/queue', { api: 2, mode: '1v1', kind: 'server' }, token);
  assert.deepEqual(r.json.cars, ['tero', null]);
});
