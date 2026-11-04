// End-to-end smoke test against a running Worker: `wrangler dev --port 8787` (run from server/) or a
// deploy. Node 24 (global fetch + WebSocket), no browser.
//   npm run smoke                                         (server/: local wrangler dev)
//   npm run smoke:remote -- --duration=20                 (root; API env or --api=... picks the target)
//   API=https://turbo-gol.com MODE=1v1 node server/test/smoke.mjs --duration=20
//
// Options (flags win over env): --api=<base url> / API (default http://127.0.0.1:8787; the match socket
// uses ws:// or wss:// from the same scheme), --mode=<1v1|2v2|3v3> / MODE (the format the account
// prefers; two humans always play a 2v2), --duration=<s> / SECONDS (seconds of snapshot capture,
// default 10), --session=<jwt> / SESSION and --session2=<jwt> / SESSION2 (two ready-made ACCOUNT
// sessions, see Sessions below).
//
// Casual is for accounts since the modes redesign (November 2026): two accounts searching together
// form a match at once (2 humans: a 2v2 with a bot each), a lone one only after 5:00.
// Flow: health -> /api/where (edge colo) -> /api/config (botFillMs null, queue clocks) -> a guest's
// queue is 403 account_required -> an account's request without api is 426 reload_required -> A
// queues (the first answer comes at once: waiting + wait) -> B queues: matched at once (2v2, mode,
// host, humans) -> A's next POST collects its match -> a third account queues and leaves (POST
// /api/leave answers at once) -> WebSocket with ['tg1', 'ticket.<jwt>'] -> Welcome (prints hostColo, the
// Cloudflare colo the match object runs in) -> Ready -> inputs at 60 pps (2 ticks each, packet size
// steered by bufferHint) for the duration -> asserts >= 25 snapshots per second, strictly increasing
// ticks, decodes every frame with src/net/protocol.ts and, when the shared wasm exposes save/load,
// re-creates the arena in node, loads every snapshot blob and checks stateHash() === snapshot.stateHash
// (host == client sim). Then the explicit quit (OnlineSession.leave from the menu): POST /api/leave
// { matchId } -> 200 released, the host closes our socket (1000 'left') and its bots take the car, a
// queue right after is not refused with 409 (its first answer is 'waiting' at once; POST
// /api/leave {} drops that waiter) and POST /api/rejoin answers 410 'left' (B still holds its seat)
// or 404 'no_match' (we were the last human). Prints RTT stats (4-timestamp pings at 4 Hz), the snapshot
// interval and the bufferHint distribution, then one line to paste into docs/online/PHASE1.md:
//   SUMMARY edge=<colo> host=<colo> rtt_p50=.. rtt_p90=.. jitter=.. snap_p50=.. snap_p90=.. snap_max=.. hint_mode=.. desyncs=..
// Exit 0 = pass, 1 = a check failed, 2 = cannot run (no account sessions).
//
// Sessions: under wrangler dev with --var DEV_AUTH:1 the script signs in three dev accounts itself
// (POST /api/dev/signin, loopback only). Elsewhere give it two account sessions: sign in on the
// game in two browsers and copy each tab's Bearer (DevTools > Network, any /api/ call) into
// SESSION and SESSION2; the third-account leave test is then skipped. A deploy with Turnstile also
// needs a browser for its guest: the guest check is skipped when POST /api/guest is refused.
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const P = await import('../../src/net/protocol.ts');
const T = await import('../../src/sim/types.ts');
const { GUEST_NAME_RE, guestNameOf } = await import('../../src/net/guestName.ts');

// ---- options ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 3);
};
const API = (argOf('api') ?? process.env.API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MODE = argOf('mode') ?? process.env.MODE ?? '1v1';
const SECONDS = Number(argOf('duration') ?? process.env.SECONDS ?? 10);
const SESSION = (argOf('session') ?? process.env.SESSION ?? '').trim();
if (!/^https?:\/\//.test(API)) {
  console.error(`API must be an http(s) URL, got '${API}'`);
  process.exit(2);
}
if (!['1v1', '2v2', '3v3'].includes(MODE) || !(SECONDS > 0)) {
  console.error(`bad --mode '${MODE}' or --duration '${SECONDS}'`);
  process.exit(2);
}
/** ws:// for http://, wss:// for https:// (what the Worker's wsUrl also does for its own origin). */
const WS_BASE = API.replace(/^http/, 'ws');
const MIN_SNAPSHOTS_PER_SECOND = 25;
const LEAD_TICKS = 4;
/** The client clamps its lead to [2, 24] ticks; a remote host at 150 ms RTT needs well over 16. */
const MAX_LEAD = 24;

const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s]`, ...a);
const t0 = performance.now();
let failures = 0;
const check = (cond, msg) => {
  if (cond) log('ok  ', msg);
  else {
    failures++;
    log('FAIL', msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];

async function api(path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

/** Decoded JWT payload (not verified: only to print who the session is), null when it is not a JWT. */
function jwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** First non-empty string under a key containing 'sitekey' (two levels deep): the Turnstile sitekey of /api/config, if any. */
function findSitekey(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/sitekey/i.test(k) && typeof v === 'string' && v.length > 0) return v;
    const nested = findSitekey(v, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** Absolute socket URL: the Worker answers with its own origin; a relative path goes through API. */
function resolveWs(wsUrl) {
  if (/^wss?:\/\//.test(wsUrl)) return wsUrl;
  if (/^https?:\/\//.test(wsUrl)) return wsUrl.replace(/^http/, 'ws');
  return WS_BASE + (wsUrl.startsWith('/') ? '' : '/') + wsUrl;
}

// ---- 1. health, where, config, session -------------------------------------------------------------
log(`target ${API} (sockets ${WS_BASE}), mode ${MODE}, capture ${SECONDS} s${SESSION ? ', session from env' : ''}`);
const tHealth = performance.now();
const health = await api('/api/health');
/** One HTTP round trip to the API (ms): scales the waits that depend on the remote latency. */
const httpRtt = performance.now() - tHealth;
check(health.status === 200 && health.json?.ok === true, `GET /api/health -> ${health.status} ${health.text} (${httpRtt.toFixed(0)} ms)`);
check(health.json?.protocol === P.PROTOCOL_VERSION, `server protocol ${health.json?.protocol} == client ${P.PROTOCOL_VERSION}`);

const where = await api('/api/where');
check(where.status === 200 && where.json !== null && 'edgeColo' in where.json, `GET /api/where -> ${where.status} ${where.text.slice(0, 160)}`);
const edgeColo = typeof where.json?.edgeColo === 'string' && where.json.edgeColo.length > 0 ? where.json.edgeColo : 'unknown';
log(`edge colo ${edgeColo}, country ${where.json?.country ?? '?'}, city ${where.json?.city ?? '?'}, asn ${where.json?.asn ?? '?'}, ip ${where.json?.ip ?? '?'}`);

const config = await api('/api/config');
const sitekey = config.status === 200 ? findSitekey(config.json) : null;
if (config.status === 200) log(`GET /api/config -> ${config.text.slice(0, 160)}`);
else log(`GET /api/config -> ${config.status} (no config endpoint: Turnstile state unknown)`);
if (sitekey !== null) {
  log(`turnstile: the deploy reports a sitekey (${sitekey.slice(0, 10)}...): POST /api/guest needs a browser challenge; ${SESSION ? 'using the SESSION token instead of creating a guest' : 'without SESSION the guest step below may fail (see the header comment)'}`);
}

/** An account session of the dev sign-in (wrangler dev with DEV_AUTH=1, a loopback host), or null. */
async function devAccount(name) {
  const r = await api('/api/dev/signin', { name });
  return r.status === 200 && typeof r.json?.session === 'string' && r.json.kind === 'account' ? r.json : null;
}
const SESSION2 = (argOf('session2') ?? process.env.SESSION2 ?? '').trim();
let session = SESSION;
let session2 = SESSION2;
let session3 = '';
let playerName = null;
if (SESSION.length > 0 || SESSION2.length > 0) {
  for (const [label, tok] of [['SESSION', SESSION], ['SESSION2', SESSION2]]) {
    const claims = jwtPayload(tok);
    check(claims !== null && claims.acct === 1, `${label} is an account session (sub ${claims?.sub ?? '?'}, exp ${claims?.exp ? new Date(claims.exp * 1000).toISOString() : '?'})`);
  }
  playerName = jwtPayload(SESSION)?.name ?? null;
  log('dev sign-in skipped (SESSION / SESSION2 given); the leave test needs a third account: skipped');
} else {
  const [a, b, c] = [await devAccount('smoke_a'), await devAccount('smoke_b'), await devAccount('smoke_c')];
  if (a === null || b === null || c === null) {
    log('no account sessions: run wrangler dev with --var DEV_AUTH:1, or pass SESSION and SESSION2 (see the header comment)');
    process.exit(2);
  }
  [session, session2, session3] = [a.session, b.session, c.session];
  playerName = a.name;
  check(true, `three dev accounts signed in (${a.name}, ${b.name}, ${c.name})`);
}
if (session.length === 0 || session2.length === 0) {
  log('two account sessions are needed (SESSION and SESSION2)');
  process.exit(2);
}
check(config.json?.botFillMs === null && config.json?.queue?.soloAfterMs === 300_000 && config.json?.queue?.accountRequired === true, `GET /api/config: botFillMs ${config.json?.botFillMs}, queue ${JSON.stringify(config.json?.queue)}`);
// A guest never queues (decision 2): 403 account_required, whatever its page sends.
const guestTry = await api('/api/guest', { name: 'Smoke Guest' });
if (guestTry.status === 200 && typeof guestTry.json?.session === 'string') {
  const gq = await api('/api/queue', { api: 2, mode: MODE }, guestTry.json.session);
  check(gq.status === 403 && gq.json?.error === 'account_required', `a guest's POST /api/queue -> ${gq.status} ${gq.json?.error}: ${gq.json?.message}`);
  check(GUEST_NAME_RE.test(guestTry.json.name) && guestTry.json.name === guestNameOf(guestTry.json.playerId), `the server names the guest (the name sent is ignored): ${guestTry.json.name}`);
} else log(`SKIP the guest check: POST /api/guest -> ${guestTry.status} ${guestTry.json?.error ?? ''}`);
// A page cached from before the deploy (no api marker): told to reload.
const oldPage = await api('/api/queue', { mode: MODE, kind: 'p2p', p2pProtocol: 5 }, session);
check(oldPage.status === 426 && oldPage.json?.error === 'reload_required', `an account's queue without api -> ${oldPage.status} ${oldPage.json?.error}: ${oldPage.json?.message}`);
const noAuth = await api('/api/queue', { mode: MODE });
check(noAuth.status === 401, `POST /api/queue without a session -> ${noAuth.status}`);
const badMode = await api('/api/queue', { api: 2, mode: '9v9' }, session);
check(badMode.status === 400, `POST /api/queue bad mode -> ${badMode.status}`);

// ---- 2. queue: A's first answer at once, B forms the match at once, A collects it -------------------
const QUEUE = { api: 2, mode: MODE, prefer: MODE, visible: true };
const qStart = performance.now();
const first = await api('/api/queue', QUEUE, session);
log(`A: POST /api/queue -> ${first.status} ${first.text.slice(0, 160)}`);
if (first.status === 401 && SESSION.length > 0) {
  log('the SESSION token was rejected (expired or signed by another JWT_SECRET): get a fresh one from the browser');
  process.exit(2);
}
const firstMs = performance.now() - qStart;
check(first.status === 200 && first.json?.status === 'waiting' && typeof first.json?.wait?.botsInMs === 'number', `A's first answer: waiting with its wait, ${firstMs.toFixed(0)} ms (no long-poll)`);
check(firstMs < 5_000 + 4 * httpRtt, 'the first answer came at once');
const b = await api('/api/queue', QUEUE, session2);
log(`B: POST /api/queue -> ${b.status} ${b.text.slice(0, 160)}`);
check(b.status === 200 && b.json?.status === 'matched' && b.json?.humans === 2 && b.json?.mode === '2v2', `B matched at once: ${b.json?.mode}, ${b.json?.humans} humans, host ${b.json?.host}`);
let queued = null;
for (let attempt = 0; attempt < 3 && !queued; attempt++) {
  const q = await api('/api/queue', QUEUE, session);
  log(`A: POST /api/queue -> ${q.status} ${q.text.slice(0, 100)}`);
  if (q.status !== 200) {
    failures++;
    break;
  }
  if (q.json.status === 'matched') queued = q.json;
}
check(queued !== null, `A matched after ${((performance.now() - qStart) / 1000).toFixed(1)} s`);
if (!queued) process.exit(1);
check(queued.matchId === b.json?.matchId, 'the same match for A and B');
check(/^[0-9a-f]{64}$/.test(queued.matchId), `matchId ${queued.matchId}`);
check(typeof queued.ticket === 'string' && queued.ticket.split('.').length === 3, 'ticket is a JWT');
check(typeof queued.wsUrl === 'string' && queued.wsUrl.endsWith('/ws/' + queued.matchId), `wsUrl ${queued.wsUrl}`);
const wsTarget = resolveWs(queued.wsUrl);
check(wsTarget.startsWith(WS_BASE.slice(0, WS_BASE.indexOf('://') + 3)), `socket scheme matches the API (${wsTarget.slice(0, wsTarget.indexOf('://') + 3)} for ${API.slice(0, API.indexOf('://') + 3)})`);

// a second queue request while the match is active is refused (one active match per player)
const again = await api('/api/queue', QUEUE, session);
check(again.status === 409 && again.json?.error === 'active_match', `queue again during a match -> ${again.status} ${again.json?.error}`);

// ---- 2b. leave: a third account that stops waiting is dropped at once ----------------------------------
if (session3.length === 0) {
  log('SKIP leave test (needs a third account; SESSION mode)');
} else {
  const s3 = session3;
  const tLeave = performance.now();
  const q1 = await api('/api/queue', QUEUE, s3);
  check(q1.status === 200 && q1.json?.status === 'waiting', `the third account's first answer: ${q1.text.slice(0, 80)}`);
  // Its next POST long-polls (up to 25 s); the leave answers it at once.
  const settleMs = Math.max(300, Math.ceil(4 * httpRtt));
  const pending = api('/api/queue', QUEUE, s3);
  await sleep(settleMs);
  const left = await api('/api/leave', {}, s3);
  check(left.status === 200 && left.json?.left === true, `POST /api/leave -> ${left.status} ${left.text} (after ${settleMs} ms)`);
  const q2 = await Promise.race([pending, sleep(3000 + 4 * httpRtt).then(() => ({ status: 0, json: null, text: 'timeout' }))]);
  check((q2.status === 200 && q2.json?.status === 'waiting') || (q2.status === 404 && q2.json?.error === 'not_queued'), `the pending queue request answered ${((performance.now() - tLeave) / 1000).toFixed(2)} s after the leave (${q2.text.slice(0, 60)})`);
  const again2 = await api('/api/leave', {}, s3);
  check(again2.status === 200 && again2.json?.left === false, `leave when not queued -> left: ${again2.json?.left}`);
}

// ---- 3. WebSocket -----------------------------------------------------------------------------------
const badTicket = await new Promise((resolve) => {
  const ws = new WebSocket(wsTarget, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + 'not.a.jwt']);
  ws.onopen = () => resolve('opened');
  ws.onerror = () => resolve('rejected');
  ws.onclose = () => resolve('rejected');
});
check(badTicket === 'rejected', 'bad ticket is rejected at the edge');

const ws = new WebSocket(wsTarget, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + queued.ticket]);
ws.binaryType = 'arraybuffer';
const welcome = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no Welcome within 15 s')), 15_000);
  ws.onopen = () => log('ws open, protocol =', JSON.stringify(ws.protocol));
  ws.onerror = (e) => {
    clearTimeout(timer);
    reject(new Error('ws error ' + (e?.message ?? '')));
  };
  ws.onclose = (e) => {
    clearTimeout(timer);
    reject(new Error(`ws closed ${e.code} ${e.reason}`));
  };
  ws.onmessage = (ev) => {
    const buf = new Uint8Array(ev.data);
    if (P.msgType(buf) === P.MsgType.Welcome) {
      clearTimeout(timer);
      resolve(P.decodeJson(buf));
    }
  };
}).catch((e) => {
  check(false, e.message);
  process.exit(1);
});
check(ws.protocol === P.WS_SUBPROTOCOL, `negotiated subprotocol '${ws.protocol}'`);
check(welcome.protocol === P.PROTOCOL_VERSION && welcome.matchId === queued.matchId, `Welcome: match ${welcome.matchId} mode ${welcome.mode} slot ${welcome.slot} carId ${welcome.carId}`);
check(Array.isArray(welcome.roster) && welcome.roster.length === 2 * Number(queued.mode[0]), `roster has ${welcome.roster?.length} entries: ${welcome.roster.map((r) => `${r.slot}:${r.kind}/${r.team}`).join(' ')}`);
check(welcome.roster[welcome.slot]?.kind === 'player' && welcome.roster[welcome.slot]?.carId === welcome.carId, 'our slot is a player with our carId');
if (playerName !== null) check(welcome.roster[welcome.slot]?.name === playerName, `our roster name is '${welcome.roster[welcome.slot]?.name}'`);
const hostColo = typeof welcome.hostColo === 'string' && welcome.hostColo.length > 0 ? welcome.hostColo : 'missing';
check(hostColo !== 'missing', `Welcome.hostColo = ${hostColo} (edge ${edgeColo})`);

// ---- 4. play: Ready, inputs at 60 pps, pings at 4 Hz, collect snapshots ------------------------------
const snapshots = [];
const events = [];
const pongs = [];
const hints = new Map();
let lastTick = -1;
let ticksIncreasing = true;
let hostTickAtSnapshot = 0;
let snapshotAt = 0;
let firstSnapshotAt = 0;
let lastSnapshotAt = 0;
let lead = LEAD_TICKS;
const snapshotGaps = [];
const pkt = { tick: 0, lastInputTick: 0, bufferHint: 0, numCars: 0, inputs: new Int8Array(T.MAX_CARS * T.PACKED_INPUT_BYTES), stateLen: 0, state: new Uint8Array(0), stateHash: 0 };
const pong = { t0: 0, t1: 0, t2: 0, hostTick: 0 };

ws.onmessage = (ev) => {
  const buf = new Uint8Array(ev.data);
  switch (P.msgType(buf)) {
    case P.MsgType.Snapshot: {
      if (!P.decodeSnapshot(buf, pkt)) {
        check(false, 'undecodable snapshot');
        return;
      }
      if (pkt.tick <= lastTick) ticksIncreasing = false;
      lastTick = pkt.tick;
      hostTickAtSnapshot = pkt.tick;
      snapshotAt = performance.now();
      if (firstSnapshotAt === 0) firstSnapshotAt = snapshotAt;
      hints.set(pkt.bufferHint, (hints.get(pkt.bufferHint) ?? 0) + 1);
      // lead control: an underrun risk (queue below target) raises the lead, a fat queue lowers it
      if (pkt.bufferHint < 0 && lead < MAX_LEAD) lead++;
      else if (pkt.bufferHint > 3 && lead > 2) lead--;
      if (lastSnapshotAt) snapshotGaps.push(snapshotAt - lastSnapshotAt);
      lastSnapshotAt = snapshotAt;
      snapshots.push({
        tick: pkt.tick,
        lastInputTick: pkt.lastInputTick,
        bufferHint: pkt.bufferHint,
        numCars: pkt.numCars,
        inputs: Int8Array.from(pkt.inputs.subarray(0, pkt.numCars * 6)),
        state: Uint8Array.from(pkt.state),
        stateHash: pkt.stateHash,
        bytes: buf.length,
      });
      return;
    }
    case P.MsgType.Pong: {
      if (!P.decodePong(buf, pong)) return;
      const t3 = performance.now();
      pongs.push({ rtt: t3 - pong.t0 - (pong.t2 - pong.t1), hostTick: pong.hostTick });
      return;
    }
    case P.MsgType.Event:
      events.push(P.decodeJson(buf));
      return;
    case P.MsgType.Error:
    case P.MsgType.Kick:
      log('host says', P.msgType(buf), JSON.stringify(P.decodeJson(buf)));
      return;
    default:
      check(false, `unexpected message type ${buf[0]}`);
  }
};
let closed = null;
ws.onclose = (e) => {
  closed = e;
};

ws.send(P.encodeJson(P.MsgType.Ready, {}));
log('sent Ready');

const inputBuf = new Uint8Array(P.INPUT_HEADER + P.INPUT_MAX_BATCH * 6);
const pingBuf = new Uint8Array(P.PING_LEN);
const MAX_SEND = 8;
const packed = new Int8Array(MAX_SEND * 6);
let nextTick = welcome.tick + LEAD_TICKS;
let sentPackets = 0;
let sentTicks = 0;

const inputTimer = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Keep inputs sent up to (host tick estimate + lead). The estimate is the latest snapshot tick
  // plus the elapsed time; `lead` adapts to the host's bufferHint (see the snapshot handler), so
  // the steady state is ~2 ticks per packet at 60 pps whatever the timer jitter on either side.
  const estHost = hostTickAtSnapshot + (snapshotAt ? Math.floor(((performance.now() - snapshotAt) * P.TICK_RATE) / 1000) : 0);
  const target = estHost + lead;
  if (snapshotAt && nextTick < target - 16) nextTick = target - 2; // fell behind by a lot: jump
  const count = Math.max(0, Math.min(MAX_SEND, target - nextTick + 1));
  if (count === 0) return; // ahead of the target: skip this packet
  const phase = Math.floor(performance.now() / 1500) % 4;
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    packed[o] = 127; // throttle
    packed[o + 1] = phase === 1 ? 90 : phase === 3 ? -90 : 0; // steer
    packed[o + 2] = 0;
    packed[o + 3] = 0;
    packed[o + 4] = 0;
    packed[o + 5] = phase === 2 ? T.BTN_BOOST : 0;
  }
  const len = P.encodeInput(inputBuf, nextTick, count, lastTick < 0 ? 0 : lastTick, packed, 0);
  ws.send(inputBuf.subarray(0, len));
  nextTick += count;
  sentPackets++;
  sentTicks += count;
}, 1000 / 60);
const pingTimer = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(pingBuf.subarray(0, P.encodePing(pingBuf, performance.now())));
}, 250);

// wait for the first snapshot (the loop starts on Ready), then SECONDS more
await sleep(1000);
const waitFirst = performance.now();
while (snapshots.length === 0 && performance.now() - waitFirst < 10_000 && !closed) await sleep(50);
check(snapshots.length > 0, `first snapshot after ${((performance.now() - waitFirst) / 1000).toFixed(2)} s (closed: ${closed ? closed.code : 'no'})`);
const countFrom = snapshots.length;
const runStart = performance.now();
while (performance.now() - runStart < SECONDS * 1000 && !closed) await sleep(100);
clearInterval(inputTimer);
clearInterval(pingTimer);
const collected = snapshots.length - countFrom;

// ---- 5. assertions ----------------------------------------------------------------------------------
check(!closed, `socket still open (${closed ? `closed ${closed.code} ${closed.reason}` : 'yes'})`);
check(collected >= MIN_SNAPSHOTS_PER_SECOND * SECONDS, `${collected} snapshots in ${SECONDS} s (>= ${MIN_SNAPSHOTS_PER_SECOND * SECONDS})`);
check(ticksIncreasing, 'snapshot ticks strictly increasing');
if (snapshots.length > 1) {
  const first = snapshots[countFrom] ?? snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const dt = (performance.now() - runStart) / 1000;
  const rate = (last.tick - first.tick) / dt;
  check(rate > 110 && rate < 130, `host tick rate ${rate.toFixed(1)} Hz over ${dt.toFixed(1)} s (ticks ${first.tick} -> ${last.tick})`);
  const stepOk = snapshots.every((s, i) => i === 0 || (s.tick - snapshots[i - 1].tick) % 4 === 0);
  check(stepOk, 'snapshot ticks are multiples of 4 apart (30 Hz cadence)');
  check(last.lastInputTick > 0 && last.tick - last.lastInputTick <= 4, `host applied our inputs: lastInputTick ${last.lastInputTick} at tick ${last.tick} (gap ${last.tick - last.lastInputTick}, <= 4)`);
  // Cars are frozen (controls zeroed by the host) during kickoff countdowns and goal pauses, so the
  // echo is checked over the whole capture rather than on the last snapshot only.
  const echoedTicks = snapshots.filter((s) => s.inputs[welcome.slot * 6] === 127).length;
  check(echoedTicks > snapshots.length / 4, `echoed throttle 127 for our slot in ${echoedTicks}/${snapshots.length} snapshots (last = ${last.inputs[welcome.slot * 6]})`);
  const sizes = snapshots.map((s) => s.bytes);
  log(`snapshot bytes: min ${Math.min(...sizes)} max ${Math.max(...sizes)} (state ${last.state.length} B)`);
  for (const s of snapshots) {
    if (P.fnv1a32(s.state, s.state.length) !== s.stateHash) {
      check(false, `fnv1a32(state) != stateHash at tick ${s.tick}`);
      break;
    }
  }
  check(true, `fnv1a32(state) == stateHash for all ${snapshots.length} snapshots`);
}
log(`inputs sent: ${sentPackets} packets / ${sentTicks} ticks, final lead ${lead} ticks; events: ${events.map((e) => e.type).join(',')}`);
const summary = { rttP50: NaN, rttP90: NaN, jitter: NaN, snapP50: NaN, snapP90: NaN, snapMax: NaN, hintMode: 'n/a', desyncs: 'n/a' };
if (snapshotGaps.length > 10) {
  const gaps = snapshotGaps.slice().sort((a, b) => a - b);
  summary.snapP50 = quantile(gaps, 0.5);
  summary.snapP90 = quantile(gaps, 0.9);
  summary.snapMax = gaps[gaps.length - 1];
  log(`snapshot interval ms (host setInterval jitter + transport as seen by the client): p50 ${summary.snapP50.toFixed(1)} p90 ${summary.snapP90.toFixed(1)} p99 ${quantile(gaps, 0.99).toFixed(1)} max ${summary.snapMax.toFixed(1)} (nominal 33.3)`);
}
if (hints.size > 0) {
  const sorted = [...hints.entries()].sort((a, b) => a[0] - b[0]);
  log(`bufferHint distribution (hint:count): ${sorted.map(([h, n]) => `${h}:${n}`).join(' ')}`);
  summary.hintMode = sorted.reduce((best, e) => (e[1] > best[1] ? e : best))[0];
}
if (pongs.length) {
  const rtts = pongs.map((p) => p.rtt).sort((a, b) => a - b);
  summary.rttP50 = quantile(rtts, 0.5);
  summary.rttP90 = quantile(rtts, 0.9);
  // jitter as src/net/ClockSync.ts defines it: mean |rtt sample - median rtt| (over every pong here)
  summary.jitter = rtts.reduce((acc, r) => acc + Math.abs(r - summary.rttP50), 0) / rtts.length;
  log(`RTT ms over ${rtts.length} pongs: min ${quantile(rtts, 0).toFixed(2)} p50 ${summary.rttP50.toFixed(2)} p90 ${summary.rttP90.toFixed(2)} max ${rtts[rtts.length - 1].toFixed(2)} jitter ${summary.jitter.toFixed(2)}`);
} else check(false, 'no pongs received');
check(events.some((e) => e.type === 'countdown') && events.some((e) => e.type === 'go'), 'countdown + go events received');

// ---- 6. determinism: load every snapshot in a local sim and compare the hash --------------------------
try {
  const { RocketSim } = await import('../../src/sim/RocketSimBridge.ts');
  const { buildArenaMesh } = await import('../../src/sim/arenaMesh.ts');
  const sim = await RocketSim.load();
  if (typeof sim.loadState !== 'function' || typeof sim.stateHash !== 'function') {
    log('SKIP determinism check: the local wasm has no loadState/stateHash yet (npm run build:wasm)');
  } else {
    sim.initArena(buildArenaMesh().physics);
    sim.createArena(T.TICK_RATE);
    for (const r of welcome.roster) sim.addCar(r.team, T.CarPreset.Standard);
    let mismatches = 0;
    let loadErrors = 0;
    for (const s of snapshots) {
      try {
        sim.loadState(s.state);
      } catch (e) {
        loadErrors++;
        if (loadErrors === 1) log('loadState error:', e.message ?? e);
        continue;
      }
      sim.sync();
      if (sim.stateHash() !== s.stateHash) mismatches++;
      else if (sim.tickCount !== s.tick) mismatches++;
    }
    check(loadErrors === 0, `loadState accepted all ${snapshots.length} blobs (${loadErrors} errors)`);
    check(mismatches === 0, `stateHash() == snapshot.stateHash and tickCount == tick for all snapshots (${mismatches} mismatches)`);
    summary.desyncs = mismatches + loadErrors;
    // replay: load snapshot i, apply the echoed inputs of the following ticks... needs the inputs of
    // every tick (only every 4th is echoed), so only the direct hash check is done here.
  }
} catch (e) {
  log('SKIP determinism check (wasm not loadable in node):', e.message ?? e);
}

// ---- 7. explicit quit: POST /api/leave { matchId } frees the server lock at once -----------------------
// What OnlineSession.leave does from the menu. Phase 1 kept the lock until the match ended (a reload
// rejoins through the queue's 409), so a P2P queue after quitting was answered 409 kind 'server' and the
// client rejoined the match it had just quit. Now the host closes our socket, its bots take our car for
// good, the P2P queue goes through and the match cannot be rejoined. When we were its last human the
// quit ends the match at once (no room left alive per quit: a guest queueing and quitting back to back
// would otherwise hold a MAX_ACTIVE_ROOMS slot per quit): the rejoin then finds no match (404).
const otherHumans = welcome.roster.filter((r) => r.kind === 'player' && r.slot !== welcome.slot && !events.some((e) => e.type === 'botTakeover' && e.slot === r.slot)).length;
const socketClosed = new Promise((resolve) => {
  ws.onclose = (e) => {
    closed = e;
    resolve(e);
  };
});
const quit = await api('/api/leave', { matchId: queued.matchId }, session);
check(quit.status === 200 && quit.json?.released === true, `POST /api/leave { matchId } -> ${quit.status} ${quit.text}`);
const closeEv = await Promise.race([socketClosed, sleep(3000 + 4 * httpRtt).then(() => null)]);
check(closeEv !== null && closeEv.code === 1000 && closeEv.reason === 'left', `the host closed our socket after the quit: ${closeEv ? `${closeEv.code} '${closeEv.reason}'` : 'still open'}`);

// After the quit a queue is not refused with 409: its first answer is 'waiting' at once ('p2p' is Casual now).
const afterQuit = await api('/api/queue', { ...QUEUE, kind: 'p2p' }, session);
check(afterQuit.status === 200 && (afterQuit.json?.status === 'waiting' || afterQuit.json?.status === 'matched'), `POST /api/queue after the quit -> ${afterQuit.status} ${afterQuit.text.slice(0, 120)} (not 409)`);
if (afterQuit.json?.status === 'matched') await api('/api/leave', { matchId: afterQuit.json.matchId }, session);
else {
  const dropped = await api('/api/leave', {}, session);
  check(dropped.status === 200 && dropped.json?.left === true, `POST /api/leave {} drops that waiter -> ${dropped.status} ${dropped.text}`);
}
const rejoinAfterQuit = await api('/api/rejoin', { matchId: queued.matchId }, session);
const [wantStatus, wantError] = otherHumans > 0 ? [410, 'left'] : [404, 'no_match'];
check(
  rejoinAfterQuit.status === wantStatus && rejoinAfterQuit.json?.error === wantError,
  `POST /api/rejoin after the quit -> ${rejoinAfterQuit.status} ${rejoinAfterQuit.json?.error ?? rejoinAfterQuit.text.slice(0, 80)} (want ${wantStatus} ${wantError}: ${otherHumans} other human(s) in the match)`,
);

ws.close(1000, 'done');
await sleep(200);
const ms = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
console.log(
  `SUMMARY edge=${edgeColo} host=${hostColo} rtt_p50=${ms(summary.rttP50)} rtt_p90=${ms(summary.rttP90)} jitter=${ms(summary.jitter)} snap_p50=${ms(summary.snapP50)} snap_p90=${ms(summary.snapP90)} snap_max=${ms(summary.snapMax)} hint_mode=${summary.hintMode} desyncs=${summary.desyncs}`,
);
log(failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
