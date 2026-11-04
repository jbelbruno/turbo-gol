// Hardening regressions for the client netcode (review of the phase 1 online mode):
//   node --test tests/net-hardening.test.mjs
// - NetClient.queue(): a persistent 401 re-registers the guest once, then fails (no endless loop)
// - NetClient: close code 4000 'replaced' is final (no /api/rejoin), error codes surface in messages
// - OnlineSession: at most ONE input packet per advance() once >= 2 ticks were stepped (a slow frame
//   sends one fat packet instead of a burst), and a hard resync while ahead is counted once per stall
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const P = await import('../src/net/protocol.ts');
const T = await import('../src/sim/types.ts');
const NC = await import('../src/net/NetClient.ts');
const { NetClient, NetError, CLOSE_REPLACED } = NC;
const { OnlineSession, HARD_RESYNC_TICKS } = await import('../src/game/OnlineSession.ts');
const { TICK_MS } = await import('../src/net/ClockSync.ts');
const { seatCars } = await import('../src/net/cosmetics.ts');

const { MsgType, encodeJson, encodeSnapshot, encodePong, decodeInput, fnv1a32 } = P;
const { STATE_BUFFER_FLOATS, H_TICK_COUNT, H_NUM_CARS, CARS_OFFSET, CAR_STRIDE, C_ID, C_TEAM, C_POS, BALL_OFFSET, B_POS, PACKED_INPUT_BYTES, TICK_DT } = T;

// ---- fakes ---------------------------------------------------------------------------------

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.binaryType = 'blob';
    this.readyState = 0;
    this.protocol = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(data instanceof Uint8Array ? new Uint8Array(data) : data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.protocol = 'tg1';
    if (this.onopen) this.onopen({});
  }
  deliver(bytes) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (this.onmessage) this.onmessage({ data: copy.buffer });
  }
  dropped(code, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeClient(routes, opts = {}) {
  const sockets = [];
  const calls = [];
  let t = 1000;
  const client = new NetClient({
    storage: new FakeStorage(),
    now: () => t,
    fetchFn: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      const r = routes[url];
      if (typeof r === 'function') return r(init, calls.length);
      return r ?? jsonResponse(404, {});
    },
    webSocketFactory: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    pingIntervalMs: 1e9,
    reconnectDelaysMs: [0], // the reconnection's tries without their waits
    ...opts,
  });
  return { client, sockets, calls, setTime: (v) => (t = v), now: () => t };
}

const GUEST = { playerId: 'p1', name: 'Tester', session: 'jwt-session', expiresAt: Date.now() + 24 * 3600 * 1000 };

/** Tiny RollbackSim: state = tick + car x positions; throttle moves a car along +x. */
class FakeSim {
  constructor(numCars) {
    this.buf = new Float32Array(STATE_BUFFER_FLOATS);
    this.n = numCars;
    this.buf[H_NUM_CARS] = numCars;
    this.controls = new Int8Array(numCars * PACKED_INPUT_BYTES);
    for (let i = 0; i < numCars; i++) {
      const o = CARS_OFFSET + i * CAR_STRIDE;
      this.buf[o + C_ID] = i + 1;
      this.buf[o + C_TEAM] = i % 2;
      this.buf[o + C_POS] = -1000 + i * 500;
    }
    this.buf[BALL_OFFSET + B_POS + 2] = 93;
    this.bytes = 4 + numCars * 4;
  }
  get tickCount() {
    return this.buf[H_TICK_COUNT];
  }
  get numCars() {
    return this.n;
  }
  carOffset(slot) {
    return CARS_OFFSET + slot * CAR_STRIDE;
  }
  setControlsPacked(packed, numSlots) {
    for (let i = 0; i < numSlots * PACKED_INPUT_BYTES; i++) this.controls[i] = packed[i];
  }
  step(n = 1) {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < this.n; i++) {
        const o = CARS_OFFSET + i * CAR_STRIDE;
        this.buf[o + C_POS] = Math.fround(this.buf[o + C_POS] + this.controls[i * PACKED_INPUT_BYTES] / 127);
      }
      this.buf[H_TICK_COUNT] = this.buf[H_TICK_COUNT] + 1;
    }
  }
  sync() {}
  stateSizeMax() {
    return this.bytes;
  }
  saveState(out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(0, this.buf[H_TICK_COUNT], true);
    for (let i = 0; i < this.n; i++) dv.setFloat32(4 + i * 4, this.buf[CARS_OFFSET + i * CAR_STRIDE + C_POS], true);
    return this.bytes;
  }
  loadState(blob, len = blob.length) {
    if (len !== this.bytes) return 4;
    const dv = new DataView(blob.buffer, blob.byteOffset, len);
    this.buf[H_TICK_COUNT] = dv.getUint32(0, true);
    for (let i = 0; i < this.n; i++) this.buf[CARS_OFFSET + i * CAR_STRIDE + C_POS] = dv.getFloat32(4 + i * 4, true);
    return 0;
  }
  stateHash() {
    const out = new Uint8Array(this.bytes);
    return fnv1a32(out, this.saveState(out));
  }
}

/**
 * An OnlineSession in the 'playing' state on a fake Game, with the fake socket and clock exposed;
 * `routes` add / override API routes; `connecting: true` stops right after the socket was created;
 * `welcome` adds fields to the Welcome (hostColo 'node:<name>': a community node); `prepare(client)`
 * runs before the queue (an account's sessionProvider).
 */
async function playingSession(routes = {}, { connecting = false, welcome = {}, prepare = null, lobby = false } = {}) {
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' }),
    ...routes,
  });
  const sim = new FakeSim(2);
  const controls = T.emptyControls();
  controls.throttle = 1;
  const game = {
    sim,
    hud: { netVisible: false },
    ticks: 0,
    rosterCalls: [],
    applyOnlineRoster(w, cars) {
      this.rosterCalls.push({ w, cars });
    },
    afterRollback() {},
    startOnlineMatch() {},
    onOnlineEvent() {},
    restoreOfflineRoster() {},
    onOnlineDisconnected() {},
    onlineTick() {
      this.ticks++;
      session.stepTick(controls);
    },
  };
  const session = new OnlineSession(game, { client: h.client, now: h.now });
  if (prepare !== null) prepare(h.client);
  if (lobby) session.joinAssigned('1v1', { matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' }, '', true);
  else session.quickMatch('1v1');
  for (let i = 0; i < 10 && h.sockets.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.state, 'connecting');
  const ws = h.sockets[0];
  if (connecting) return { session, game, ws, client: h.client, calls: h.calls, setTime: h.setTime, now: h.now };
  ws.open();
  const roster = [
    { carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player' },
    { carId: 2, slot: 1, team: 1, name: 'Bot 1', kind: 'bot' },
  ];
  ws.deliver(encodeJson(MsgType.Welcome, { protocol: P.PROTOCOL_VERSION, matchId: 'm1', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster, tick: 0, matchLengthSeconds: 300, ...welcome }));
  assert.ok(session.predictor, 'predictor built from the Welcome');
  // First authoritative state (tick 0): the match is on screen.
  const state = new Uint8Array(sim.stateSizeMax());
  const len = sim.saveState(state);
  const out = new Uint8Array(1024);
  const n = encodeSnapshot(out, 0, 0, 0, 2, new Int8Array(12), state, len, fnv1a32(state, len));
  ws.deliver(out.subarray(0, n));
  assert.equal(session.state, 'playing');
  ws.sent.length = 0;
  return { session, game, ws, client: h.client, calls: h.calls, setTime: h.setTime, now: h.now };
}

const inputPackets = (ws) => ws.sent.filter((f) => f[0] === MsgType.Input);

// ---- NetClient -----------------------------------------------------------------------------

test('queue: a persistent 401 re-registers the guest once and then fails instead of looping', async () => {
  let guests = 0;
  let queues = 0;
  const { client } = makeClient({
    '/api/guest': () => jsonResponse(200, { ...GUEST, playerId: `p${++guests}` }),
    '/api/queue': () => {
      queues++;
      return jsonResponse(401, { error: 'unauthorized' });
    },
  });
  await assert.rejects(client.queue('1v1'), (err) => err instanceof NetError && err.code === 'http' && err.status === 401 && /session rejected/.test(err.message));
  assert.equal(guests, 2, 'one re-registration');
  assert.equal(queues, 2, 'two attempts, then the error');
  assert.equal(client.queueing, false);
});

test('queue / rejoin failures carry the server error code', async () => {
  const { client } = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(503, { error: 'capacity', message: 'all rooms are busy' }),
  });
  // The server's `message` rides along (the menu shows the real reason); a bare code stays bare.
  await assert.rejects(client.queue('2v2'), (err) => err instanceof NetError && err.status === 503 && err.message === 'queue failed (503 capacity: all rooms are busy)');
  const h2 = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/rejoin': () => jsonResponse(410, { error: 'match_reset' }),
  });
  await assert.rejects(h2.client.rejoin('abc'), (err) => err instanceof NetError && err.status === 410 && err.message === 'rejoin failed (410 match_reset)');
  // Through the automatic rejoin: the onClose reason is that message (no doubled prefix).
  const closes = [];
  h2.client.onClose = (code, reason, reconnecting) => closes.push([code, reason, reconnecting]);
  h2.client.matchId = 'abc';
  h2.client.connect('/ws/abc', 't');
  h2.sockets[0].open();
  h2.sockets[0].dropped(1006, 'network');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(closes, [
    [1006, 'network', true],
    [1006, 'rejoin failed (410 match_reset)', false],
  ]);
});

// ---- the queue loop of the modes redesign (November 2026): retries, the body, early re-POSTs -------

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const MATCHED = { status: 'matched', matchId: 'm1', ticket: 'T', wsUrl: '/ws/m1' };
const WAITING = { status: 'waiting', waiting: 1, region: 'SA', wait: { searching: 1, searchingHere: 1, waitedMs: 0, widened: false, widenInMs: 60_000, estimateMs: 300_000, estimateKind: 'bots', botsInMs: 300_000, busy: false } };
/** A long-poll that answers only when its POST is aborted (the loop's own controller), like a browser's fetch. */
const hanging = (init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
  });
const queueCalls = (h) => h.calls.filter((c) => c.url === '/api/queue');

test('queue loop: a network error, 500, 502, 504 or a 503 without a known code waits 1, 2, 4... s and tries again (queueRetrying meanwhile)', async () => {
  const answers = ['throw', 500, 502, 504, 503];
  let n = 0;
  const retryingSeen = [];
  const h = makeClient(
    {
      '/api/guest': () => jsonResponse(200, GUEST),
      '/api/queue': () => {
        retryingSeen.push(h.client.queueRetrying);
        const a = answers[n++];
        if (a === 'throw') throw new Error('offline');
        if (a !== undefined) return jsonResponse(a, a === 503 ? { error: 'something_new' } : {});
        return jsonResponse(200, MATCHED);
      },
    },
    { queueTiming: { retryMs: [3, 6] } },
  );
  const m = await h.client.queue('2v2', 'server');
  assert.equal(m.matchId, 'm1');
  assert.equal(queueCalls(h).length, 6, 'five failures, each tried again');
  assert.deepEqual(retryingSeen, [false, true, true, true, true, true], 'retrying from the first failure until an answer');
  assert.equal(h.client.queueRetrying, false);
  assert.deepEqual(NC.QUEUE_RETRY_MS, [1000, 2000, 4000, 8000, 15000, 30000], '1, 2, 4, 8, 15, then 30 s');
});

test('queue loop: it goes on forever while not cancelled; cancelQueue ends it', async () => {
  const h = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => Promise.reject(new Error('offline')) }, { queueTiming: { retryMs: [1] } });
  const p = h.client.queue('2v2', 'server');
  for (let i = 0; i < 50 && queueCalls(h).length < 8; i++) await tick(2);
  assert.ok(queueCalls(h).length >= 8, 'still trying');
  h.client.cancelQueue();
  await assert.rejects(p, (err) => err instanceof NetError && err.code === 'cancelled');
  assert.equal(h.client.queueRetrying, false);
});

test('queue loop: known codes end the search at once (426 reload_required, 403 account_required, 429 ranked_ban, 503 matchmaking_off / do_disabled, a 400); rate_limited after its own wait, once', async () => {
  const cases = [
    [426, 'reload_required'],
    [403, 'account_required'],
    [429, 'ranked_ban'],
    [503, 'matchmaking_off'],
    [503, 'do_disabled'],
    [400, 'bad_mode'],
  ];
  for (const [status, code] of cases) {
    const h = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => jsonResponse(status, { error: code }) }, { queueTiming: { retryMs: [1] } });
    await assert.rejects(h.client.queue('2v2', 'server'), (err) => err instanceof NetError && err.status === status && err.serverCode === code, code);
    assert.equal(queueCalls(h).length, 1, code + ': no retry');
  }
  for (const [status, code, want] of [[500, '', 'retry'], [502, '', 'retry'], [503, '', 'retry'], [503, 'capacity', 'end'], [429, 'rate_limited', 'rateLimited'], [429, 'no_show', 'end'], [401, 'unauthorized', 'end']]) assert.equal(NC.queueFailure(status, code), want, `${status} ${code}`);
  // rate_limited: its retryAfterMs, one try more; a second one ends it.
  const rl = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => jsonResponse(429, { error: 'rate_limited', retryAfterMs: 5 }) });
  await assert.rejects(rl.client.queue('2v2', 'server'), (err) => err instanceof NetError && err.serverCode === 'rate_limited');
  assert.equal(queueCalls(rl).length, 2);
  let k = 0;
  const ok = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => (++k === 1 ? jsonResponse(429, { error: 'rate_limited', retryAfterMs: 5 }) : jsonResponse(200, MATCHED)) });
  assert.equal((await ok.client.queue('2v2', 'server')).matchId, 'm1');
});

test('queue body: api, prefer, local and visible; never p2p; the waiting answer\'s wait kept with its time', async () => {
  let visible = false;
  let n = 0;
  const h = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => (++n === 1 ? jsonResponse(200, WAITING) : jsonResponse(200, MATCHED)) }, { visible: () => visible });
  h.client.queuePrefer = '3v3';
  h.client.queueLocal = 'bots';
  h.client.queueModes = ['3v3'];
  h.client.region = 'EU';
  const waits = [];
  h.setTime(5000);
  await h.client.queue('3v3', 'p2p', (count, wait) => waits.push({ count, wait, at: h.client.lastWaitAt }));
  assert.deepEqual(queueCalls(h)[0].body, { api: 2, mode: '3v3', kind: 'server', modes: ['3v3'], region: 'EU', prefer: '3v3', local: 'bots', visible: false });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].count, 1);
  assert.equal(waits[0].wait.estimateKind, 'bots');
  assert.equal(waits[0].at, 5000, 'lastWaitAt: when it came (the local countdowns)');
  assert.equal(h.client.waitingAnswers, 1);
  // Casual's prefer off (Competitive): no field; a visible tab says so.
  visible = true;
  h.client.queuePrefer = null;
  h.client.queueLocal = null;
  n = 1;
  await h.client.queue('2v2', 'ranked');
  assert.deepEqual(queueCalls(h).at(-1).body, { api: 2, mode: '2v2', kind: 'ranked', modes: ['3v3'], region: 'EU', visible: true });
  // A malformed wait (an older server): none.
  assert.equal(NC.parseQueueWait({ searching: 'x' }), null);
  assert.equal(NC.parseQueueWait(undefined), null);
  const odd = NC.parseQueueWait({ ...WAITING.wait, estimateKind: 'odd', botsInMs: undefined });
  assert.equal(odd.estimateKind, 'none', 'an unknown kind: no estimate');
  assert.equal('botsInMs' in odd, false, 'ranked: no bots time');
  assert.deepEqual(NC.parseQueueWait(WAITING.wait), WAITING.wait);
});

test('early re-POST: a prefer or local change aborts the long-poll in flight and re-POSTs at once (no backoff), at most once per repostMinMs, later changes in one', async () => {
  let n = 0;
  const h = makeClient(
    {
      '/api/guest': () => jsonResponse(200, GUEST),
      // The first answer of a search comes at once; every later POST long-polls until aborted.
      '/api/queue': (init) => (++n === 1 ? jsonResponse(200, WAITING) : hanging(init)),
    },
    { queueTiming: { retryMs: [60_000], repostMinMs: 150 }, visible: () => true },
  );
  h.client.queuePrefer = '2v2';
  const p = h.client.queue('2v2', 'server');
  for (let i = 0; i < 20 && queueCalls(h).length < 2; i++) await tick(1);
  assert.equal(queueCalls(h).length, 2, 'the fresh answer, then the long-poll');
  h.client.queuePrefer = '1v1';
  for (let i = 0; i < 20 && queueCalls(h).length < 3; i++) await tick(1);
  assert.equal(queueCalls(h).length, 3, 'the change re-POSTed at once');
  assert.equal(queueCalls(h)[2].body.prefer, '1v1');
  assert.equal(h.client.queueRetrying, false, 'no backoff: an abort of our own is no network error');
  // Inside the window: no POST yet, then one at its end with both changes.
  h.client.queueLocal = 'bots';
  h.client.queuePrefer = '3v3';
  await tick(30);
  assert.equal(queueCalls(h).length, 3, 'held for the rest of the window');
  for (let i = 0; i < 40 && queueCalls(h).length < 4; i++) await tick(10);
  assert.equal(queueCalls(h).length, 4, 'one re-POST at the end of it');
  assert.equal(queueCalls(h)[3].body.prefer, '3v3');
  assert.equal(queueCalls(h)[3].body.local, 'bots');
  await tick(200);
  assert.equal(queueCalls(h).length, 4, 'nothing more without a change');
  // The same value again: no re-POST.
  h.client.queuePrefer = '3v3';
  await tick(200);
  assert.equal(queueCalls(h).length, 4);
  h.client.cancelQueue();
  await assert.rejects(p, (err) => err instanceof NetError && err.code === 'cancelled');
});

test('the watchdog: a queue POST hung past its timeout is aborted and re-sent at once (no backoff)', async () => {
  let n = 0;
  const h = makeClient(
    { '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': (init) => (++n === 1 ? hanging(init) : jsonResponse(200, MATCHED)) },
    { queueTiming: { retryMs: [60_000], postTimeoutMs: 20 } },
  );
  const t0 = Date.now();
  const m = await h.client.queue('2v2', 'server');
  assert.equal(m.matchId, 'm1');
  assert.equal(queueCalls(h).length, 2);
  assert.ok(Date.now() - t0 < 5_000, 'no 60 s backoff');
  assert.equal(NC.QUEUE_POST_TIMEOUT_MS, 35_000, "the long-poll's 25 s plus 10 s");
});

test('the tab: hidden or shown re-POSTs (visible in the body); back in view a POST older than the stale time is aborted and re-sent, and a retry wait wakes at once', async () => {
  let visible = true;
  let n = 0;
  const h = makeClient(
    { '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': (init) => (++n === 1 ? jsonResponse(200, WAITING) : hanging(init)) },
    { queueTiming: { retryMs: [60_000], repostMinMs: 0, staleMs: 30_000 }, visible: () => visible },
  );
  const p = h.client.queue('2v2', 'server');
  for (let i = 0; i < 20 && queueCalls(h).length < 2; i++) await tick(1);
  visible = false;
  h.client.noteVisibility();
  for (let i = 0; i < 20 && queueCalls(h).length < 3; i++) await tick(1);
  assert.equal(queueCalls(h).length, 3);
  assert.equal(queueCalls(h)[2].body.visible, false, 'hidden: the 5:00 bots match waits for a visible tab');
  // A phone asleep 40 s: back in view, the long-poll of before is not waited out.
  h.setTime(h.now() + 40_000);
  visible = true;
  h.client.noteVisibility();
  for (let i = 0; i < 20 && queueCalls(h).length < 4; i++) await tick(1);
  assert.equal(queueCalls(h).length, 4);
  assert.equal(queueCalls(h)[3].body.visible, true);
  h.client.cancelQueue();
  await assert.rejects(p, (err) => err instanceof NetError && err.code === 'cancelled');
  assert.equal(NC.QUEUE_STALE_MS, 30_000);

  // Offline and waiting to retry (60 s here): the tab coming back tries at once.
  let vis = true;
  let k = 0;
  const off = makeClient(
    { '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => (++k === 1 ? Promise.reject(new Error('offline')) : jsonResponse(200, MATCHED)) },
    { queueTiming: { retryMs: [60_000] }, visible: () => vis },
  );
  const q = off.client.queue('2v2', 'server');
  for (let i = 0; i < 20 && !off.client.queueRetrying; i++) await tick(1);
  assert.equal(off.client.queueRetrying, true);
  vis = false;
  off.client.noteVisibility();
  vis = true;
  off.client.noteVisibility();
  assert.equal((await q).matchId, 'm1', 'woken: no 60 s wait');
});

test('close code 4000 (replaced by a newer socket) is final: no rejoin, no new socket', async () => {
  assert.equal(CLOSE_REPLACED, 4000);
  let rejoins = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/rejoin': () => {
      rejoins++;
      return jsonResponse(200, { status: 'matched', matchId: 'm9', ticket: 'T2', wsUrl: '/ws/m9' });
    },
  });
  const closes = [];
  h.client.onClose = (code, reason, reconnecting) => closes.push([code, reason, reconnecting]);
  h.client.matchId = 'm9';
  h.client.connect('/ws/m9', 'T1');
  h.sockets[0].open();
  h.sockets[0].dropped(CLOSE_REPLACED, 'replaced');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 0);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(closes, [[4000, 'replaced', false]]);
  assert.equal(h.client.reconnects, 0);
  // An ordinary abnormal close still rejoins once.
  h.client.connect('/ws/m9', 'T1');
  h.sockets[1].open();
  h.sockets[1].dropped(1006, 'network');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 1);
  assert.equal(h.sockets.length, 3);
});

// ---- OnlineSession -------------------------------------------------------------------------

test('advance() sends at most one input packet per frame, once two or more ticks were stepped', async () => {
  const { session, game, ws } = await playingSession();
  const pkt = { firstTick: 0, count: 0, ackTick: 0, packed: new Int8Array(P.INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };

  // A normal 60 fps frame: two ticks, one packet with those two ticks.
  session.advance(2.5 * TICK_DT);
  assert.equal(game.ticks, 2);
  assert.equal(inputPackets(ws).length, 1);
  assert.ok(decodeInput(inputPackets(ws)[0], pkt));
  assert.equal(pkt.firstTick, 1);
  assert.equal(pkt.count, 2);
  // A frame that steps no tick or a single tick sends nothing; the next tick completes the pair.
  session.advance(0.4 * TICK_DT);
  assert.equal(game.ticks, 2);
  session.advance(0.2 * TICK_DT); // acc 1.1 ticks -> 1 tick
  assert.equal(game.ticks, 3);
  assert.equal(inputPackets(ws).length, 1, 'odd tick waits for the next one');
  session.advance(1 * TICK_DT); // acc 1.1 ticks -> 1 tick
  assert.equal(game.ticks, 4);
  assert.equal(inputPackets(ws).length, 2);
  assert.ok(decodeInput(inputPackets(ws)[1], pkt));
  assert.equal(pkt.firstTick, 1, 'unacked ticks are resent from tick 1');
  assert.equal(pkt.count, 4);
  // A slow frame (0.1 s = the clamp, ~12 ticks): ONE packet, not six, carrying the newest ticks.
  session.advance(0.1);
  assert.ok(game.ticks >= 15, `slow frame stepped ${game.ticks - 4} ticks`);
  assert.equal(inputPackets(ws).length, 3, 'a multi-tick frame emits a single packet');
  assert.ok(decodeInput(inputPackets(ws)[2], pkt));
  assert.equal(pkt.firstTick + pkt.count - 1, session.predictor.localTick, 'the packet ends at the newest local tick');
  assert.ok(pkt.count >= 15 && pkt.count <= 16, `every unacked tick up to the cap (${pkt.count})`);
  // Nothing more goes out while no tick runs.
  session.advance(0);
  assert.equal(inputPackets(ws).length, 3);
});

test('a hard resync while ahead is counted once per stall, not once per frame', async () => {
  const { session, game, ws, now, setTime } = await playingSession();
  // Pong with zero rtt / offset at the client's clock: host tick estimate = (now - 1000) / TICK_MS.
  const pong = new Uint8Array(P.PONG_LEN);
  encodePong(pong, now(), now(), now(), 0);
  ws.deliver(pong);
  assert.equal(session.client.clock.samples, 1);
  assert.equal(session.hardResyncs, 0);
  // Run 12 local ticks while the host clock stands still: local 12 vs target 2 -> 10 ticks ahead.
  session.advance(0.1);
  assert.equal(game.ticks, 12);
  assert.equal(session.hardResyncs, 0, 'the resync is decided at the next frame');
  session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1);
  assert.ok(session.drift > HARD_RESYNC_TICKS);
  assert.equal(game.ticks, 12, 'stalled: no local tick');
  // The stall lasts several frames (the host has to catch up): still ONE resync.
  for (let i = 0; i < 5; i++) session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1, 'not inflated per frame');
  assert.equal(game.ticks, 12);
  // The host catches up (12 ticks later on the clock): the remaining stall drains without a new count.
  setTime(now() + 12 * TICK_MS);
  for (let i = 0; i < 3; i++) session.advance(2 * TICK_DT);
  assert.equal(session.hardResyncs, 1, 'draining the stall is not a new resync');
  assert.equal(game.ticks, 12);
  assert.ok(session.drift <= HARD_RESYNC_TICKS);
  // Local ticks run again; with the host clock frozen the sim gets ahead once more: a second event.
  let frames = 0;
  while (session.hardResyncs === 1 && frames < 40) {
    session.advance(2 * TICK_DT);
    frames++;
  }
  assert.equal(session.hardResyncs, 2, `a new stall counts again (after ${frames} frames)`);
  assert.ok(game.ticks > 12, 'the sim ticked between the two stalls');
});

// ---- OnlineSession: explicit quit vs lost connection -----------------------------------------

/** A /api/leave route that records each body and whether the match socket was still open when it went out. */
function leaveRecorder() {
  const rec = { seen: [], ws: null };
  rec.route = (init) => {
    rec.seen.push({ body: JSON.parse(init.body), auth: init.headers.authorization, socketClosed: rec.ws !== null && rec.ws.closed !== null });
    return jsonResponse(200, { ok: true, left: false, released: true });
  };
  return rec;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test('OnlineSession.leave (quit from the menu) POSTs /api/leave { matchId } with the session before closing the socket 1000, once', async () => {
  const rec = leaveRecorder();
  const s = await playingSession({ '/api/leave': rec.route });
  rec.ws = s.ws;
  s.session.leave();
  assert.equal(s.session.state, 'idle');
  assert.deepEqual(rec.seen, [{ body: { matchId: 'm1' }, auth: 'Bearer jwt-session', socketClosed: false }], 'the leave goes out before the close');
  assert.deepEqual(s.ws.closed, { code: 1000, reason: 'leave' });
  assert.equal(s.client.leaves, 1);
  // Leaving again (idle) sends nothing more.
  s.session.leave();
  await flush();
  assert.equal(rec.seen.length, 1);
});

test('OnlineSession: no /api/leave after the connection was lost for good (the rejoin path keeps the lock) nor after the whistle', async () => {
  // Lost: the socket drops, the automatic rejoins fail (RECONNECT_TRIES), the Game shows the menu (-> leave()).
  const rec = leaveRecorder();
  let disconnected = null;
  const s = await playingSession({ '/api/leave': rec.route, '/api/rejoin': () => jsonResponse(503, { error: 'unavailable' }) });
  s.game.onOnlineDisconnected = (msg) => (disconnected = msg);
  s.ws.dropped(1006, 'network');
  for (let i = 0; i < 20 && disconnected === null; i++) await flush();
  assert.ok(disconnected !== null, 'the session reported the lost connection');
  s.session.leave();
  await flush();
  assert.deepEqual(rec.seen, [], 'a lost connection is not a quit: the server lock stays for the next queue');

  // The whistle: the match frees the locks itself.
  const rec2 = leaveRecorder();
  const s2 = await playingSession({ '/api/leave': rec2.route });
  s2.ws.deliver(encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 }));
  assert.equal(s2.session.state, 'ended');
  s2.session.leave();
  await flush();
  assert.deepEqual(rec2.seen, []);
  assert.deepEqual(s2.ws.closed, { code: 1000, reason: 'leave' });
});

test('OnlineSession.cancel while connecting quits the assigned match (/api/leave { matchId }, connected: false before the Welcome); cancel while queueing only drops the waiter ({})', async () => {
  const rec = leaveRecorder();
  const s = await playingSession({ '/api/leave': rec.route }, { connecting: true });
  rec.ws = s.ws;
  s.session.cancel();
  assert.equal(s.session.state, 'idle');
  assert.deepEqual(rec.seen, [{ body: { matchId: 'm1', connected: false }, auth: 'Bearer jwt-session', socketClosed: false }]);
  assert.deepEqual(s.ws.closed, { code: 1000, reason: 'cancel' });

  // The Welcome came (the slot is ours on the host), the first snapshot not yet: a plain quit.
  const rec2 = leaveRecorder();
  const s2 = await playingSession({ '/api/leave': rec2.route }, { connecting: true });
  s2.ws.open();
  s2.ws.deliver(encodeJson(MsgType.Welcome, { protocol: P.PROTOCOL_VERSION, matchId: 'm1', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster: [{ carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player' }, { carId: 2, slot: 1, team: 1, name: 'Bot 1', kind: 'bot' }], tick: 0, matchLengthSeconds: 300 }));
  assert.equal(s2.session.state, 'connecting');
  s2.session.cancel();
  assert.deepEqual(rec2.seen.map((r) => r.body), [{ matchId: 'm1' }]);

  // Still in the queue (the long-poll is pending): no match to quit, the waiter is dropped with {}.
  const bodies = [];
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': (init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    '/api/leave': (init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: true, released: false });
    },
  });
  const game = { sim: new FakeSim(2), hud: { netVisible: false }, restoreOfflineRoster() {}, onOnlineDisconnected() {} };
  const session = new OnlineSession(game, { client: h.client, now: h.now });
  session.quickMatch('1v1');
  await flush();
  assert.equal(session.state, 'queue');
  session.cancel();
  await flush();
  assert.equal(session.state, 'idle');
  assert.deepEqual(bodies, [{}]);
});

// ---- OnlineSession on a community node (Welcome.hostColo 'node:<name>') -----------------------

const RANKED_QUEUE = { '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1', ranked: true }) };
const NODE_WELCOME = { welcome: { hostColo: 'node:sao-paulo-1' } };

test('OnlineSession: a ranked match that ends on a community node is flagged for the longer result wait (lastRankedOnNode)', async () => {
  const ended = encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 });
  const node = await playingSession(RANKED_QUEUE, NODE_WELCOME);
  node.ws.deliver(ended);
  assert.equal(node.session.lastRankedMatchId, 'm1');
  assert.equal(node.session.lastRankedOnNode, true);
  const colo = await playingSession(RANKED_QUEUE, { welcome: { hostColo: 'GRU' } });
  colo.ws.deliver(ended);
  assert.equal(colo.session.lastRankedMatchId, 'm1');
  assert.equal(colo.session.lastRankedOnNode, false);
});

test('OnlineSession: the network view carries the host of the Welcome (the panel names a community node), cleared after the match', async () => {
  const s = await playingSession({}, NODE_WELCOME);
  s.session.advance(0.01);
  assert.equal(s.session.stats.host, 'node:sao-paulo-1');
  s.session.leave();
  assert.equal(s.session.stats.host, '');
});

test('OnlineSession: a hostColo that is not a string (the Welcome is not validated) is no node and breaks nothing', async () => {
  const { formatNetStats } = await import('../src/render/Hud.ts');
  for (const hostColo of [null, 42, { name: 'node:x' }]) {
    const s = await playingSession(RANKED_QUEUE, { welcome: { hostColo } });
    s.session.advance(0.01);
    assert.equal(s.session.stats.host, '');
    assert.doesNotThrow(() => formatNetStats(s.session.stats));
    s.ws.deliver(encodeJson(MsgType.Event, { type: 'ended', winner: 0, blue: 1, red: 0, tick: 500 }));
    assert.equal(s.session.lastRankedOnNode, false);
  }
  assert.equal(P.isNodeHost('node:sao-paulo-1'), true);
  assert.equal(P.isNodeHost('GRU'), false);
  assert.equal(P.isNodeHost(undefined), false);
});

/**
 * A match played under an account session (an AccountClient on a fake clock, wired like Game.ts)
 * with ten minutes left on its Bearer when the match starts; the first /api/leave answers 401.
 */
async function accountMatch(welcome) {
  const { AccountClient } = await import('../src/net/AccountClient.ts');
  let t = 1_000_000;
  let issued = 0;
  const accounts = new AccountClient({
    storage: null,
    now: () => t,
    fetchFn: async (url) => {
      assert.equal(url, '/api/auth/refresh');
      issued++;
      return jsonResponse(200, { kind: 'account', playerId: 'acc1', name: 'Tomi', session: `jwt-a${issued}`, expiresAt: t + 3600_000 });
    },
  });
  await accounts.restore();
  t += 50 * 60_000;
  const auths = [];
  const leave = (init) => {
    auths.push(init.headers.authorization);
    return auths.length === 1 ? jsonResponse(401, { error: 'unauthorized' }) : jsonResponse(200, { ok: true, left: true, released: true });
  };
  const prepare = (client) => {
    client.sessionProvider = (minValidMs) => accounts.sessionForQueue(minValidMs);
    client.onSessionRejected = () => accounts.sessionRejected();
  };
  const s = await playingSession({ '/api/leave': leave }, { welcome, prepare });
  await flush();
  return { ...s, auths, issued: () => issued };
}

test('OnlineSession on a community node: the first Welcome renews an account Bearer with less than 15 min left; a quit refused with 401 goes again with a fresh one', async () => {
  const s = await accountMatch(NODE_WELCOME.welcome);
  assert.equal(s.issued(), 2, 'the queue kept jwt-a1 (10 min left), the Welcome renewed it');
  assert.equal(s.client.lastBearer, 'jwt-a2');
  s.session.leave();
  assert.deepEqual(s.auths, ['Bearer jwt-a2'], 'the first leave goes out before the socket closes');
  await flush();
  assert.equal(s.issued(), 3);
  assert.deepEqual(s.auths, ['Bearer jwt-a2', 'Bearer jwt-a3']);
  assert.equal(s.client.leaves, 2);
});

test('OnlineSession on a Durable Object: no early renewal and a refused quit is not retried (as before)', async () => {
  const s = await accountMatch({ hostColo: 'GRU' });
  assert.equal(s.issued(), 1);
  assert.equal(s.client.lastBearer, 'jwt-a1');
  s.session.leave();
  await flush();
  assert.equal(s.issued(), 1);
  assert.deepEqual(s.auths, ['Bearer jwt-a1']);
});

// ---- a match found over, a lobby's match rejoined (PR 17) -----------------------------------

/** sessionStorage for rejoinStore.ts (node has none): a Map behind the Storage methods. */
function withSessionStorage() {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
  return () => {
    const raw = m.get('turbogol.rejoin');
    return raw === undefined ? null : JSON.parse(raw);
  };
}

test("OnlineSession: a lobby's server match is kept as one (its rejoin comes back as the lobby's); the server's 1000 close before 'ended' is the match over, not a lost connection", async () => {
  const record = withSessionStorage();
  try {
    const s = await playingSession({}, { lobby: true });
    s.ws.deliver(encodeJson(MsgType.Event, { type: 'clock', seconds: 200, tick: 10 }));
    assert.equal(record()?.kind, 'lobby', 'the record names the lobby');
    let disconnected = null;
    s.game.onOnlineDisconnected = (msg) => (disconnected = msg);
    s.ws.dropped(1000, 'ended');
    await flush();
    assert.equal(disconnected, (await import('../src/i18n.ts')).t('online.matchOver'), 'the match is over');
    assert.equal(record(), null, 'nothing to rejoin');
    // A queue's match: kept as casual, and an abnormal close is still a lost connection.
    const q = await playingSession();
    q.ws.deliver(encodeJson(MsgType.Event, { type: 'clock', seconds: 200, tick: 10 }));
    assert.equal(record()?.kind, 'casual');
    const r = q.session.rejoinable;
    assert.equal(r.kind, 'casual');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('OnlineSession: an automatic reconnection whose rejoin finds the match over (404 / 410) forgets the record and says so', async () => {
  const record = withSessionStorage();
  try {
    const { t } = await import('../src/i18n.ts');
    for (const status of [404, 410]) {
      const s = await playingSession({ '/api/rejoin': () => jsonResponse(status, { error: status === 404 ? 'no_match' : 'match_over' }) });
      s.ws.deliver(encodeJson(MsgType.Event, { type: 'clock', seconds: 200, tick: 10 }));
      assert.equal(record()?.kind, 'casual');
      let disconnected = null;
      s.game.onOnlineDisconnected = (msg) => (disconnected = msg);
      s.ws.dropped(1006, 'network');
      for (let i = 0; i < 20 && disconnected === null; i++) await flush();
      assert.equal(disconnected, t('online.matchOver'), `${status}: over, not lost`);
      assert.equal(record(), null, `${status}: the record went`);
      assert.equal(s.session.rejoinable, null, `${status}: no VOLVER A ENTRAR`);
    }
    // A rejoin refused for a moment (503) is still a lost connection, the record kept.
    const s = await playingSession({ '/api/rejoin': () => jsonResponse(503, { error: 'unavailable' }) });
    s.ws.deliver(encodeJson(MsgType.Event, { type: 'clock', seconds: 200, tick: 10 }));
    let disconnected = null;
    s.game.onOnlineDisconnected = (msg) => (disconnected = msg);
    s.ws.dropped(1006, 'network');
    for (let i = 0; i < 40 && disconnected === null; i++) await flush();
    assert.equal(disconnected, t('online.connectionLost'));
    assert.notEqual(record(), null, 'kept: VOLVER A ENTRAR');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('cars on a community node\'s match: the Worker\'s list alone; a car the node writes in its own Welcome is never drawn', async () => {
  const roster = [
    { carId: 1, slot: 0, team: 0, name: 'Tester', kind: 'player', car: 'tero' },
    { carId: 2, slot: 1, team: 1, name: 'Amigo', kind: 'player', car: 'condor' },
  ];
  const nodeQueue = (cars) => ({ '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: 'wss://node/ws/m1', node: true, ...(cars ? { cars } : {}) }) });
  const welcome = { hostColo: 'node:sao-paulo-1', roster };
  // The Worker seated the player on pampero and the other seat on the default car.
  let s = await playingSession(nodeQueue(['pampero', null]), { welcome });
  let call = s.game.rosterCalls.at(-1);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['pampero', 'dune']);
  s.session.leave();
  // Every seat on the default car: the Worker sends no `cars`, and the node's cars still do not count.
  s = await playingSession(nodeQueue(null), { welcome });
  call = s.game.rosterCalls.at(-1);
  assert.deepEqual(call.cars, []);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['dune', 'dune']);
  s.session.leave();
  // A MatchDO's Welcome (no node: true on the answer) is the Worker's own: its cars are drawn.
  s = await playingSession({}, { welcome: { roster } });
  call = s.game.rosterCalls.at(-1);
  assert.equal(call.cars, null);
  assert.deepEqual(seatCars(call.w.roster, call.cars), ['tero', 'condor']);
  s.session.leave();
});
