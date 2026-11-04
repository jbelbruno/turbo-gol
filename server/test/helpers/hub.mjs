// The queue hub on fakes (the modes redesign's tests: queue-hub.test.mjs, queue-stats.test.mjs).
// Every MATCHMAKER name is a real MatchmakerDO on its own fake storage, sharing one settable clock;
// MATCH, ROOM and ACCOUNTS are fakes that record their calls (MATCH records the location hint its
// `get` was given); NODES, when asked for, is a fake control plane. The Worker (index.ts) runs on
// the same env, so a test can go through POST /api/queue or straight to the hub's routes.
//
//   const w = await makeHubWorld({ flags?, nodes?, rooms? })
//   w.join(id, { home?, prefer?, visible?, local?, kind?, mode?, modes? })  -> the hub's /join answer
//   w.hub()                                                                 -> the 'mm:SA' instance
//   w.queue(token, body), w.post(path, body, token)                         -> through the Worker
//   w.advance(ms), w.time()                                                 -> the hub's clock
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

// The hub's sweep and long-poll timers must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

export const M = await import('../../src/MatchmakerDO.ts');
export const Q = await import('../../src/queuePlan.ts');
export const S = await import('../../src/queueStats.ts');
export const worker = (await import('../../src/index.ts')).default;
const auth = await import('../../src/auth.ts');
export const { INTERNAL_HEADER, internalSecret, createSession, signJwt } = auth;

export const SECRET = 'queue-hub-test-secret';
export const ORIGIN = 'https://turbo-gol.com';
const RealResponse = globalThis.Response;
export const pause = (ms) => new Promise((r) => realSetTimeout(r, ms));
const HEX = '0123456789abcdef';
export const hex64 = () => Array.from({ length: 64 }, () => HEX[Math.floor(Math.random() * 16)]).join('');
/** A fresh 16-hex player id (a counter, then random: never the same twice in a run). */
let idn = 0;
export const pid = () => (++idn).toString(16).padStart(8, '0') + Array.from({ length: 8 }, () => HEX[Math.floor(Math.random() * 16)]).join('');

export class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(k) {
    return structuredClone(this.map.get(k));
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.map.delete(k);
  }
  async list({ prefix }) {
    const out = new Map();
    for (const [k, v] of [...this.map].sort(([a], [b]) => (a < b ? -1 : 1))) if (k.startsWith(prefix)) out.set(k, structuredClone(v));
    return out;
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t) {
    this.alarm = t;
  }
}

/** A namespace whose objects answer `handler(path, body, id)`; `calls` records { id, opts, path, body }. */
export function fakeNs(handler = () => ({ ok: true })) {
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
          calls.push({ id: String(id), opts, path: u.pathname, body });
          const r = await handler(u.pathname, body, String(id));
          return r instanceof RealResponse ? r : new RealResponse(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
}

/** A control plane that places every match it is offered (`place` replaceable). */
export function fakeNodes() {
  const calls = [];
  const n = {
    calls,
    place: (body) => ({ placement: placementOf(body), hosts: 1 }),
    of: (path) => calls.filter((c) => c.path === path),
    ns: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          calls.push({ path: u.pathname, body });
          const answer = u.pathname === '/internal/place' ? n.place(body) : u.pathname === '/internal/status' ? { state: 'assigned', left: false } : { recorded: true };
          return new RealResponse(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  return n;
}

export function placementOf(body) {
  const matchId = hex64();
  return { matchId, nodeId: 'node-1', nodeName: 'sao-paulo-1', transport: 'wss', wsUrl: `wss://sp1.turbo-gol.com/m/${matchId}`, tickets: body.humans.map((h, i) => ({ playerId: h.playerId, slot: i, team: i % 2, ticket: 'node-ticket.' + h.playerId })) };
}

/** An account session (Casual and ranked are for accounts). */
export const accountToken = (sub, name = 'Ana') => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });
export const guestToken = async (sub) => (await createSession(SECRET, sub, 'Invitado')).token;

/**
 * The world: `flags` the KV flags, `nodes: true` configures a control plane (placing everything),
 * `rooms` MatchDO matches already alive in the hub (`solos` of them solo matches: ids room:solo0...), `ranked` what AccountsDO's /ranked-check answers.
 */
export async function makeHubWorld({ flags = {}, nodes = false, rooms = 0, solos = 0, now = Date.UTC(2026, 10, 4, 12), ranked = null } = {}) {
  let t = now;
  const secret = await internalSecret(SECRET);
  const matchStatus = new Map(); // matchId -> { ended }
  const match = fakeNs((path, _body, id) => (path === '/internal/status' ? { matchId: id, ended: matchStatus.get(id)?.ended === true, reset: false } : { ok: true }));
  const room = fakeNs();
  const accounts = fakeNs((path) => (path === '/ranked-check' ? (ranked ?? { banUntil: 0, active: null, ratings: { '1v1': { mu: 25, sigma: 8 }, '2v2': { mu: 25, sigma: 8 }, '3v3': { mu: 25, sigma: 8 } } }) : { ok: true }));
  const objs = new Map();
  const mmCalls = [];
  const control = nodes ? fakeNodes() : null;
  const env = {
    JWT_SECRET: SECRET,
    MATCH_LENGTH_SECONDS: 180,
    REGION_OVERRIDE: '',
    FLAGS: { get: async (k) => flags[k] ?? null },
    MATCH: match.ns,
    ROOM: room.ns,
    ACCOUNTS: accounts.ns,
    LOBBY: fakeNs().ns,
    LOBBY_DIR: fakeNs((path) => (path === '/count' ? { count: 2 } : path === '/allocate' ? { code: 'ABCDEF' } : path === '/resolve' ? { lobbyId: 'ab'.repeat(32) } : { ok: true })).ns,
    MATCHMAKER: {
      idFromName: (n) => n,
      get: (name) => ({
        fetch: async (url, init) => {
          const req = url instanceof Request ? url : new Request(url, init);
          mmCalls.push({ name, path: new URL(req.url).pathname, query: Object.fromEntries(new URL(req.url).searchParams) });
          if (!objs.has(name)) {
            const storage = new FakeStorage();
            if (name === 'mm:SA') for (let i = 0; i < rooms; i++) storage.map.set('room:' + hex64(), { until: t + 3_600_000, kind: 'server', host: 'SA' });
            if (name === 'mm:SA') for (let i = 0; i < solos; i++) storage.map.set('room:solo' + i, { until: t + 3_600_000, kind: 'server', host: 'SA', solo: { playerId: 'seed' + i, joinedAt: t - 400_000, home: 'SA', at: t - 200_000 } });
            const mm = new M.MatchmakerDO({ storage, blockConcurrencyWhile: (fn) => fn() }, env);
            await pause(0);
            mm.now = () => t;
            objs.set(name, mm);
          }
          return objs.get(name).fetch(req);
        },
      }),
    },
    ...(control ? { NODES: control.ns, NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'p', NODES_PUBLIC_BASE: ORIGIN } : {}),
  };
  const call = async (path, body, region = 'SA') => {
    const res = await env.MATCHMAKER.get('mm:' + region).fetch('https://matchmaker' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', 'x-region': region },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const w = {
    env,
    call,
    match,
    room,
    accounts,
    control,
    matchStatus,
    mmCalls,
    objs,
    advance: (ms) => (t += ms),
    time: () => t,
    hub: () => objs.get('mm:SA'),
    /** The hub's /join as the Worker sends it (home, prefer, visible; kind 'server' by default). */
    join: (playerId, o = {}) => call('/join', { playerId, name: o.name ?? 'P-' + playerId.slice(0, 4), modes: o.modes ?? [o.mode ?? '2v2'], kind: o.kind ?? 'server', home: o.home ?? 'SA', ...(o.prefer ? { prefer: o.prefer } : {}), visible: o.visible !== false, ...(o.local ? { local: o.local } : {}), ...(o.kind === 'ranked' ? { ratings: o.ratings ?? { [o.mode ?? '2v2']: { mu: o.mu ?? 25, sigma: 8 } } } : {}), ...(o.extra ?? {}) }),
    leave: (playerId, matchId) => call('/leave', { playerId, ...(matchId ? { matchId } : {}) }),
    release: (matchId, playerIds) => call('/release', { matchId, playerIds }),
    stats: async () => (await call('/stats')).json,
    daily: async (days) => (await call('/daily-stats' + (days ? '?days=' + days : ''))).json,
    created: () => match.calls.filter((c) => c.path === '/internal/create'),
    /** Through the Worker: POST `path` with `body` and a Bearer `token`. */
    post: async (path, body, token, headers = {}) => {
      const res = await worker.fetch(new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.' + (1 + (idn % 250)), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(body) }), env);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    get: async (path, token) => {
      const res = await worker.fetch(new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': '203.0.113.9', ...(token ? { authorization: 'Bearer ' + token } : {}) } }), env);
      return { status: res.status, headers: res.headers, json: await res.json() };
    },
  };
  w.queue = (token, body) => w.post('/api/queue', body, token);
  return w;
}
