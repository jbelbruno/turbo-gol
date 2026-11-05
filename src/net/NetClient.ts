/**
 * Browser network client for the phase 1 online mode (docs/online/PHASE1.md):
 *
 *   config          GET /api/config once per page load (ServerConfig: turnstileSiteKey, protocol,
 *                   version, region), fetched lazily before the first guest registration; a failed
 *                   fetch is not cached
 *   guest session   POST /api/guest { turnstileToken? } -> GuestSession, kept in localStorage
 *                   (GUEST_STORAGE_KEY). The name is the server's ('Invitado 4821' from the player id,
 *                   src/net/guestName.ts): a guest never chooses or changes it, and each page shows it
 *                   in its own language (src/ui/names.ts playerName). With a sitekey the token comes
 *                   from a Turnstile widget rendered into the Hud's container (Turnstile.getToken; onTurnstile reports the
 *                   challenge to the UI); 403 turnstile_failed / 503 turnstile_unconfigured and a
 *                   client-side challenge failure reject with NetError 'turnstile'. Inicio pre-warms
 *                   one token (prewarmAntiBot, kept WARM_MS) for the next registration; a check that
 *                   wants the player says so (onAntiBotAsk: the menus' sheet, its CANCEL ends it)
 *   matchmaking     POST /api/queue { api, mode, modes?, kind, region?, prefer?, bots?, local?, visible,
 *                   first? } (Bearer session) long-poll loop until 'matched' (the modes redesign,
 *                   November 2026: `api` is QUEUE_API, src/net/queueWait.ts, and a page without it
 *                   gets 426 reload_required; Casual is kind 'server' and pools every format, its
 *                   `prefer` the format of its online bots match and `bots` (queueBots) that
 *                   match's bots level once the player picked one (none: the server's, the KV
 *                   flag bot_level); `local` says what the player does
 *                   locally meanwhile, for the daily counters; `visible` whether the tab is in
 *                   view, which gates the 5:00 bots match). Kind 'p2p' is never sent any more (read
 *                   as 'server'). The first answer of a search comes at once (`first: true` until
 *                   it came: a reloaded page's search too, whose waiter the hub still holds), then
 *                   each POST long-polls (25 s); a waiting answer's `wait` (QueueWait: the counts,
 *                   the estimate, the 5:00 countdown, the widening) is `lastWait` and its `region`
 *                   `lastWaitRegion`, a matched one's `mode` / `host` / `humans` are `lastMatched`.
 *                   The loop goes on through a network error, a 500 / 502 / 504 or a 503 without a
 *                   known code, its session's (a guest's registration, an account's refresh) too:
 *                   it waits QUEUE_RETRY_MS (1, 2, 4, 8, 15, then 30 s, forever while not
 *                   cancelled; `queueRetrying`, cleared once a retried POST is in flight
 *                   QUEUE_RETRY_CLEAR_MS), and a tab coming back into view or the network coming
 *                   back wakes it at once (at most once per QUEUE_REPOST_MIN_MS). An account's
 *                   session is renewed before it runs out (a search may outlast its hour). The page
 *                   going away (pagehide) stops it without a leave (the hub keeps the clock for a
 *                   reload); shown again (pageshow) it goes on. Known codes end it
 *                   (account_required, ranked_ban, matchmaking_off, do_disabled, rate_limited
 *                   after its own wait, reload_required, a 401 twice in a row...). Each POST
 *                   has a watchdog (QUEUE_POST_TIMEOUT_MS) and, on the tab coming back, one in
 *                   flight longer than QUEUE_STALE_MS is aborted: both re-POST at once. A change
 *                   of `queuePrefer`, `queueBots`, `queueLocal` or the tab's visibility aborts the long-poll in
 *                   flight with the client's own controller (neither a cancel nor a network error)
 *                   and re-POSTs at once, at most once per QUEUE_REPOST_MIN_MS (a later change
 *                   goes in one re-POST at the end of them). cancelQueue() aborts it and POSTs
 *                   /api/leave (best effort) so the
 *                   matchmaker drops us. 409 active_match on a 'server' queue: a 'server' match of
 *                   ours is alive -> rejoin it with a fresh ticket (the phase 1 reconnect), and if
 *                   the rejoin says the match is gone (404 / 410: the Worker freed the lock) queue
 *                   again once; a 'p2p' room cannot be rejoined -> POST /api/leave { matchId } (the
 *                   matchmaker frees the room lock and kicks our room socket) and queue again
 *                   once. 409 on a 'p2p' queue: the player asked for P2P, so whatever holds the
 *                   lock (a P2P room or a server match, e.g. one quit before the release reached
 *                   the server) is never rejoined: POST /api/leave { matchId } (a server match
 *                   hands our car to its bots) and queue again once. A second 409 rejects with
 *                   the server's reason in the message (the menu shows it)
 *   accounts        a signed-in player (AccountClient) queues under its account: `sessionProvider`
 *                   answers before the guest session (ensureGuest), `onSessionRejected` refreshes it
 *                   after a 401; leave / ice / cancel reuse the Bearer of the last queue (`lastBearer`),
 *                   which refreshBearer renews early for a match on a community node
 *   menus           `queueModes` (several playlists searched at once) and `region` (a REGIONS id, or
 *                   null = automatic) go into every queue body; the region also into leave / rejoin
 *                   so they reach the same matchmaker; kind 'ranked' (accounts only) is a server
 *                   match tagged `ranked` (rated by the server; AccountClient.waitRankedResult)
 *   errors          every failed API call rejects with NetError: `status`, `serverCode` = the
 *                   body's `error` code (callers branch on it, never on the message text: 410
 *                   p2p_room, 429 no_show, 426 reload_required, 403 turnstile_failed...),
 *                   `serverMessage` and `retryAfterMs` (429 no_show); the message itself is
 *                   developer text (logs), the menus show netErrorText (src/net/netErrorText.ts)
 *   leaveMatch      POST /api/leave after a P2P room (P2PSession.teardown, no matchId: a server
 *                   lock is kept) or with the matchId of a server match the player quits
 *                   (OnlineSession.leave: the lock is freed, the slot goes to the host's bots, no
 *                   rejoin); the next queue() waits for it first so its join is never refused by
 *                   our own stale lock. A quit before the Welcome says `connected: false`. On a
 *                   community node a 401 is retried once with a refreshed account session
 *                   (`retryRejected`)
 *   ice             GET /api/ice -> the STUN / TURN servers for the P2P mesh (fetchIce)
 *   match socket    new WebSocket(wsUrl, ['tg1', 'ticket.<jwt>']), binaryType 'arraybuffer';
 *                   Welcome / Snapshot / Event / Error / Kick are dispatched to the callbacks
 *   inputs          sendInputs(firstTick, count, packed, ackTick) into one reusable buffer
 *   clock           a ping 4x/s; the pong feeds ClockSync (median rtt / jitter / offset, host tick
 *                   estimate); snapshot tick gaps feed the loss estimate; bytes in / out are counted
 *   reconnect       POST /api/rejoin { matchId } + reconnect when the socket closes with a code
 *                   other than 1000 or 4000 'replaced' (a newer socket of ours took the slot: final),
 *                   unless the client closed it or was kicked: up to RECONNECT_TRIES tries in a row
 *                   (RECONNECT_DELAYS_MS apart; a Welcome starts the count again), each one a socket
 *                   that drops before its Welcome or a rejoin the network or the server's load
 *                   refused (no answer, 429, 5xx); a rejoin answering 404 / 410 (the match is over)
 *                   ends them. `reconnectAttempt` is the try under way (the HUD's "attempt 2/5")
 *   cars            a community node's match has its cars by slot in the queue result and the rejoin
 *                   answer only (src/net/cosmetics.ts MatchedCars, nodeCarsOf: [] when every seat
 *                   drives the default): MatchAssignment.cars and `matchCars`, which the Game reads
 *                   instead of the node's Welcome (a MatchDO's Welcome has them, matchCars null)
 *
 * The HTTP and WebSocket implementations are injectable (fetch / WebSocket by default) so the
 * logic runs in node tests with fakes. No allocations on the per-message path beyond the
 * Uint8Array view over each incoming frame.
 */
import { MAX_CARS, PACKED_INPUT_BYTES } from '../sim/types';
import { STORAGE_PREFIX } from '../brand';
import { ClockSync } from './ClockSync';
import { LossEstimator } from './NetStats';
import type { IceServer, QueueResultP2p } from './p2p/protocol';
import { QUEUE_API, type QueueMatchedExtra, type QueueWait } from './queueWait';
import type { GameMode } from '../sim/constants';
import type { Difficulty } from '../ai/Bot';
import { getToken as turnstileToken, type TurnstileLoader } from './Turnstile';
import {
  INPUT_HEADER,
  INPUT_MAX_BATCH,
  MsgType,
  PING_LEN,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  WS_TICKET_PREFIX,
  decodeJson,
  decodePong,
  decodeSnapshot,
  encodeInput,
  encodeJson,
  encodePing,
  msgType,
  type GuestSession,
  type MatchEvent,
  type PongPacket,
  type QueueResult,
  type SnapshotPacket,
  type Welcome,
} from './protocol';
import { nodeCarsOf, type CosmeticQueueResult } from './cosmetics';
import { guestNameOf } from './guestName';
import { TERMS_VERSION_RE } from './terms';
import type { CarId } from '../game/cosmetics';

export const GUEST_STORAGE_KEY = STORAGE_PREFIX + 'guest';
export const PING_INTERVAL_MS = 250;
/** A guest session is renewed when it expires within this many ms. */
const SESSION_MIN_REMAINING_MS = 60_000;
/** A pre-warmed Turnstile token is kept this long (Cloudflare accepts one for 300 s). */
export const WARM_MS = 270_000;
/** A pre-warm asked again solves a new token once the one it has is this old (before it goes at WARM_MS). */
export const REWARM_AFTER_MS = 200_000;
/** The queue loop's waits after a network error, a 500 / 502 / 504 or an unknown 503 (ms); the last repeats. */
export const QUEUE_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** A queue POST's own timeout: the long-poll's 25 s (MatchmakerDO POLL_TIMEOUT_MS) plus 10 s. */
export const QUEUE_POST_TIMEOUT_MS = 35_000;
/** The tab back in view: a queue POST in flight longer than this (a phone's sleep) is aborted and re-sent. */
export const QUEUE_STALE_MS = 30_000;
/** Early re-POSTs (a prefer / local / visibility change) and the wakes of a retry wait (the tab or the network back) go at most once per this (under the 20 / min limit). */
export const QUEUE_REPOST_MIN_MS = 5_000;
/** A retried queue POST in flight this long has reached the server (a long-poll): the "Offline: ..." line goes. */
export const QUEUE_RETRY_CLEAR_MS = 2_000;
/** 429 rate_limited without its own retryAfterMs: the wait before the one try more. */
const QUEUE_RATE_WAIT_MS = 30_000;
/** 503 codes that end a search (the rest of the 503s are retried: a Worker's hiccup). */
const QUEUE_END_503: ReadonlySet<string> = new Set(['matchmaking_off', 'do_disabled', 'capacity']);

/** What the queue loop does with a refused POST /api/queue: end the search, wait and try again, or rate_limited's own wait. */
export function queueFailure(status: number, code: string): 'end' | 'retry' | 'rateLimited' {
  if (status === 429 && code === 'rate_limited') return 'rateLimited';
  if (status === 503) return QUEUE_END_503.has(code) ? 'end' : 'retry';
  if (status >= 500) return 'retry';
  return 'end';
}

/**
 * A failure on the way to the server, tried again as a queue POST's is (the search's session: a
 * guest's registration, an account's refresh): a fetch that threw (offline), the config or the
 * registration unreachable, a 500 / 502 / 504 or an unknown 503. Never a cancel, a refusal or a
 * failed anti-bot check.
 */
export function networkFailure(err: unknown): boolean {
  if (err instanceof NetError) return err.code === 'network' || (err.code === 'http' && queueFailure(err.status, err.serverCode) === 'retry');
  return err instanceof TypeError;
}

/** A waiting answer's `wait` (src/net/queueWait.ts), read defensively; null when absent or malformed (an older server). */
export function parseQueueWait(v: unknown): QueueWait | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const searching = num(o.searching);
  const searchingHere = num(o.searchingHere);
  const waitedMs = num(o.waitedMs);
  const widenInMs = num(o.widenInMs);
  if (searching === null || searchingHere === null || waitedMs === null || widenInMs === null) return null;
  const kind = o.estimateKind === 'humans' || o.estimateKind === 'bots' ? o.estimateKind : 'none';
  const out: QueueWait = {
    searching: Math.max(0, searching),
    searchingHere: Math.max(0, searchingHere),
    waitedMs: Math.max(0, waitedMs),
    widened: o.widened === true,
    widenInMs: Math.max(0, widenInMs),
    estimateMs: num(o.estimateMs),
    estimateKind: kind,
    busy: o.busy === true,
  };
  const bots = num(o.botsInMs);
  if (bots !== null) out.botsInMs = Math.max(0, bots);
  return out;
}

/** The matched answer's extras (the hub's: the format, the host region, how many humans), each only when well formed. */
function matchedExtraOf(q: unknown): QueueMatchedExtra {
  const o = q as Record<string, unknown>;
  const out: QueueMatchedExtra = {};
  if (o.mode === '1v1' || o.mode === '2v2' || o.mode === '3v3') out.mode = o.mode;
  if (typeof o.host === 'string' && o.host.length > 0) out.host = o.host;
  if (typeof o.humans === 'number' && Number.isFinite(o.humans)) out.humans = o.humans;
  return out;
}

/** A timer that never keeps a node test alive. */
function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const h = setTimeout(fn, ms);
  const u = h as unknown as { unref?: () => void };
  if (typeof u.unref === 'function') u.unref();
  return h;
}

/** `p`, or a rejection as soon as `signal` aborts (a fetch that ignores its signal never holds the loop). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Why the queue loop aborted its own POST (not a cancel, not a network error): re-POST at once, no
 * backoff; 'page': the page is going away (pagehide), the next POST waits until it comes back.
 */
type PostAbort = 'repost' | 'watchdog' | 'stale' | 'page';

// ---- Injectable environment ----------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** The subset of the DOM WebSocket the client uses (a fake implements it in the tests). */
export interface WebSocketLike {
  binaryType: 'blob' | 'arraybuffer';
  readonly readyState: number;
  readonly protocol: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface NetClientOptions {
  /** Prefix for the /api/* paths ('' = same origin, through the Vite proxy in dev). */
  apiBase?: string;
  fetchFn?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  /** Clock for t0 / t3 (performance.now by default). */
  now?: () => number;
  /** null disables persistence (tests). Defaults to window.localStorage when available. */
  storage?: StorageLike | null;
  pingIntervalMs?: number;
  /** The waits before each reconnection try (RECONNECT_DELAYS_MS; tests). */
  reconnectDelaysMs?: readonly number[];
  /**
   * The element the Turnstile widget renders into (the Hud's container), read when a guest is
   * registered and the server has a sitekey. null / absent = the challenge cannot run.
   */
  turnstileContainer?: () => HTMLElement | null;
  /** Loader of the Turnstile API (the script tag by default; a fake in tests). */
  turnstileLoader?: TurnstileLoader;
  /**
   * The tab is in view (the queue body's `visible`; default document.visibilityState, true without
   * a document). With it given, the client listens to nothing: the caller calls noteVisibility(),
   * noteOnline(), notePageHide() and notePageShow() (without it: visibilitychange, and window's
   * online, pagehide and pageshow).
   */
  visible?: () => boolean;
  /** The queue loop's timings (tests): QUEUE_RETRY_MS, QUEUE_POST_TIMEOUT_MS, QUEUE_STALE_MS, QUEUE_REPOST_MIN_MS, QUEUE_RETRY_CLEAR_MS by default. */
  queueTiming?: { retryMs?: readonly number[]; postTimeoutMs?: number; staleMs?: number; repostMinMs?: number; rateWaitMs?: number; retryClearMs?: number };
}

/** 'turnstile': the anti-bot check failed (status 403 / 503 from the server, 0 = on the client). */
export type NetErrorCode = 'cancelled' | 'http' | 'network' | 'protocol' | 'state' | 'turnstile';

/** What the JSON error body of a failed API response said (absent fields: '' / '' / 0). */
export interface ServerError {
  /** `error`: the machine-readable code ('p2p_room', 'no_show', 'reload_required', ...). */
  code: string;
  message: string;
  /** `retryAfterMs` (429 'no_show'): how long the refusal lasts. */
  retryAfterMs: number;
}

export class NetError extends Error {
  readonly code: NetErrorCode;
  readonly status: number;
  /** The server's `error` code ('' when the failure did not come with one): callers branch on this, never on the message text. */
  readonly serverCode: string;
  /** The server's `message` ('' when absent; the code itself when the server gave no text). */
  readonly serverMessage: string;
  /** The server's `retryAfterMs` (0 when absent). */
  readonly retryAfterMs: number;

  constructor(code: NetErrorCode, message: string, status = 0, server?: ServerError) {
    super(message);
    this.name = 'NetError';
    this.code = code;
    this.status = status;
    this.serverCode = server !== undefined ? server.code : '';
    this.serverMessage = server !== undefined ? server.message : '';
    this.retryAfterMs = server !== undefined ? server.retryAfterMs : 0;
  }
}

/** What /api/queue (or /api/rejoin) resolved to once a match exists. */
export interface MatchAssignment {
  matchId: string;
  ticket: string;
  wsUrl: string;
  /**
   * A community node's match: each slot's car (src/net/cosmetics.ts MatchedCars, null = the
   * default car; [] = every seat on the default car), always present on one (nodeCarsOf): the only
   * cars of that match, a car in the node's own Welcome is never read. Absent for a MatchDO match
   * (its Welcome has them).
   */
  cars?: Array<CarId | null>;
}

/** POST /api/queue `kind`: a Durable Object host (phase 1) or a P2P signaling room (phase 2). */
export type QueueKind = 'server' | 'p2p' | 'ranked';

/** A server (Durable Object) match: the phase 1 assignment tagged with its kind. */
export interface ServerAssignment extends MatchAssignment {
  kind: 'server';
  /** A ranked match (queue kind 'ranked'): rated when it ends. */
  ranked?: boolean;
}

/** A P2P room: open wsUrl (/room/:roomId) with the ticket in the subprotocol (RoomClient). */
export interface P2pAssignment {
  kind: 'p2p';
  roomId: string;
  ticket: string;
  wsUrl: string;
}

/** What a queue of either kind resolved to; a 'p2p' queue may still get a server match (lone human). */
export type QueueAssignment = ServerAssignment | P2pAssignment;

/** leaveMatch options. */
export interface LeaveOptions {
  /**
   * false: no Welcome of the match was received. The socket may still have opened and the host
   * attached the slot (its Welcome in flight), so this is only a hint: sent as `connected: false`
   * for stage 2 of the community nodes, where the server must confirm with the node that the slot
   * never attached before taking it for a no-show; the Worker ignores it today. true / absent adds
   * nothing to the body.
   */
  connected?: boolean;
  /**
   * A 401 refreshes the account's session and sends the leave once more, as the same player: the
   * match is on a community node, where the leave is the only way out and the Bearer of the queue
   * may have expired during the match (account sessions last 1 h).
   */
  retryRejected?: boolean;
}

/** Default when the server has no /api/ice route (local dev without the phase 2 Worker). */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

function isIceServer(v: unknown): v is IceServer {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const urls = o.urls;
  if (typeof urls === 'string') return urls.length > 0;
  return Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string');
}

/** The ice servers of a GET /api/ice body ({ iceServers: [...] } or a bare array); null when malformed. */
export function parseIceServers(v: unknown): IceServer[] | null {
  const list = Array.isArray(v) ? v : typeof v === 'object' && v !== null ? (v as { iceServers?: unknown }).iceServers : undefined;
  if (!Array.isArray(list)) return null;
  const out: IceServer[] = [];
  for (const e of list) {
    if (!isIceServer(e)) return null;
    const server: IceServer = { urls: e.urls };
    if (typeof e.username === 'string') server.username = e.username;
    if (typeof e.credential === 'string') server.credential = e.credential;
    out.push(server);
  }
  return out;
}

/** localStorage 'turbogol.guest': the guest session (a `name` stored by an older page is ignored). */
export interface GuestRecord {
  session: GuestSession | null;
}

/** GET /api/config (public, no auth); the Worker builds the same shape in server/src/index.ts. */
export interface ServerConfig {
  /** Turnstile sitekey to render before POST /api/guest; null = no anti-bot check (local dev). */
  turnstileSiteKey: string | null;
  protocol: number;
  version: string;
  /** Cloudflare colo that answered ('local' under wrangler dev). */
  region: string;
  /** The matchmaking region the server picks for "automatic" (the continent of the request; '' when unknown). */
  autoRegion?: string;
  /** Sign-in providers the server has credentials for ('google', 'discord'). */
  oauth?: string[];
  /** The server queue's bot fill, ms (MatchmakerDO BOT_FILL_MS); null since the modes redesign (old pages hide their countdown). */
  botFillMs?: number | null;
  /**
   * The queue's times (the modes redesign): Casual's online bots match after `soloAfterMs` alone,
   * every region after `widenMs` of each kind, and `botLevel`: the bots' level of that match while the
   * player picked none (the KV flag bot_level; MODOS shows it picked). Absent from an older Worker
   * (the menus' defaults then).
   */
  queue?: { soloAfterMs: number; widenMs: { casual: number; ranked: number }; botLevel?: Difficulty };
  /** legal.terms: the terms version in force (src/net/terms.ts), absent until the owner publishes them (Inicio's links then: the legal draft's P12). */
  terms?: string;
  /**
   * Whether accounts outside the project may host a server: closed until the terms in force describe
   * it and the opening's flag opens it (a canary first). The hosting screens, the community server's
   * mark and its report stay hidden while it is closed. Absent from an older Worker: closed.
   */
  hosting?: { open: boolean; stage: 'closed' | 'canary' | 'all' };
}

/** POST /api/guest body: no name, the server names every guest (a name sent anyway is ignored). */
interface GuestRequest {
  turnstileToken?: string;
}

export function parseServerConfig(v: unknown): ServerConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const key = o.turnstileSiteKey;
  // The terms version only once the owner published one (unpublished, the config is read as before).
  const terms = typeof o.legal === 'object' && o.legal !== null ? (o.legal as Record<string, unknown>).terms : undefined;
  const queue = queueTimesOf(o.queue);
  return {
    turnstileSiteKey: typeof key === 'string' && key.length > 0 ? key : null,
    protocol: typeof o.protocol === 'number' ? o.protocol : 0,
    version: typeof o.version === 'string' ? o.version : '',
    region: typeof o.region === 'string' ? o.region : '',
    autoRegion: typeof o.autoRegion === 'string' ? o.autoRegion : '',
    oauth: Array.isArray(o.oauth) ? o.oauth.filter((x): x is string => typeof x === 'string') : [],
    botFillMs: typeof o.botFillMs === 'number' && Number.isFinite(o.botFillMs) && o.botFillMs > 0 ? o.botFillMs : null,
    ...(typeof terms === 'string' && TERMS_VERSION_RE.test(terms) ? { terms } : {}),
    ...(queue !== null ? { queue } : {}),
  };
}

/** GET /api/config's `queue`: each time a positive number, else the hub's (300 s, 60 s, 120 s), and botLevel only as one of the three levels; null when there is no object. */
function queueTimesOf(v: unknown): ServerConfig['queue'] | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const ms = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);
  const w = typeof o.widenMs === 'object' && o.widenMs !== null ? (o.widenMs as Record<string, unknown>) : {};
  const level = o.botLevel === 'easy' || o.botLevel === 'medium' || o.botLevel === 'hard' ? o.botLevel : null;
  return { soloAfterMs: ms(o.soloAfterMs, 300_000), widenMs: { casual: ms(w.casual, 60_000), ranked: ms(w.ranked, 120_000) }, ...(level !== null ? { botLevel: level } : {}) };
}

// ---- Guest persistence ---------------------------------------------------------------------

function isGuestSession(v: unknown): v is GuestSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.playerId === 'string' && typeof o.name === 'string' && typeof o.session === 'string' && typeof o.expiresAt === 'number';
}

/**
 * The stored guest session. A `name` beside it (a page that let guests choose one) is ignored, and so
 * is the one inside a session signed before the server named guests: it shows the server's name for
 * that id, as the server reads that session now (verifySession).
 */
export function loadGuestRecord(storage: StorageLike | null): GuestRecord {
  const rec: GuestRecord = { session: null };
  if (storage === null) return rec;
  try {
    const raw = storage.getItem(GUEST_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const s = parsed.session;
      if (isGuestSession(s)) rec.session = /^[0-9a-f]{16}$/.test(s.playerId) ? { ...s, name: guestNameOf(s.playerId) } : s;
    }
  } catch {
    /* storage disabled / corrupt */
  }
  return rec;
}

export function saveGuestRecord(storage: StorageLike | null, rec: GuestRecord): void {
  if (storage === null) return;
  try {
    storage.setItem(GUEST_STORAGE_KEY, JSON.stringify(rec));
  } catch {
    /* ignore */
  }
}

/** expiresAt in ms (the server may send seconds or milliseconds since the epoch). */
export function sessionExpiryMs(s: GuestSession): number {
  return s.expiresAt > 1e11 ? s.expiresAt : s.expiresAt * 1000;
}

export function sessionValid(s: GuestSession | null, nowEpochMs = Date.now()): s is GuestSession {
  return s !== null && sessionExpiryMs(s) - nowEpochMs > SESSION_MIN_REMAINING_MS;
}

/** Absolute WebSocket URL from what the matchmaker returned (relative paths go through the page origin). */
export function resolveWsUrl(wsUrl: string): string {
  if (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://')) return wsUrl;
  if (wsUrl.startsWith('http://')) return `ws://${wsUrl.slice(7)}`;
  if (wsUrl.startsWith('https://')) return `wss://${wsUrl.slice(8)}`;
  if (typeof location === 'undefined') return wsUrl;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${wsUrl.startsWith('/') ? '' : '/'}${wsUrl}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Resolves once `p` settled; rejects with NetError 'cancelled' if `signal` aborts first. */
function untilSettled(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(new NetError('cancelled', 'queue cancelled'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new NetError('cancelled', 'queue cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WS_OPEN = 1;
/** Reconnection tries in a row after a dropped match socket, and the wait before each (ms). */
export const RECONNECT_TRIES = 5;
export const RECONNECT_DELAYS_MS: readonly number[] = [0, 1_000, 2_000, 4_000, 6_000];

/** Host close code: this socket was replaced by a newer one for the same slot (MatchDO); no rejoin. */
export const CLOSE_REPLACED = 4000;

/** The fields of an API error body this client reads. */
interface ErrorBody {
  error?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
}

/** The parsed body of a 409 from /api/queue. */
interface ConflictBody extends ErrorBody {
  matchId?: unknown;
  kind?: unknown;
}

/** The ServerError of a parsed error body (anything else: empty). */
function serverErrorFrom(body: unknown): ServerError {
  if (typeof body !== 'object' || body === null) return { code: '', message: '', retryAfterMs: 0 };
  const b = body as ErrorBody;
  const r = b.retryAfterMs;
  return {
    code: typeof b.error === 'string' ? b.error : '',
    message: typeof b.message === 'string' ? b.message : '',
    retryAfterMs: typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.ceil(r) : 0,
  };
}

/** The error body of a failed response (empty when it is not JSON). */
async function serverErrorOf(res: ResponseLike): Promise<ServerError> {
  try {
    return serverErrorFrom(await res.json());
  } catch {
    return serverErrorFrom(null);
  }
}

/** 'code' or 'code: message' for messages ('' without a code). */
function errorDetail(e: ServerError): string {
  if (e.code.length === 0) return '';
  return e.message.length > 0 && e.message !== e.code ? `${e.code}: ${e.message}` : e.code;
}

/** ' detail' for messages, '' without one. */
function codeSuffix(detail: string): string {
  return detail.length > 0 ? ` ${detail}` : '';
}

/** NetError 'http' of a failed response: "<what> failed (<status> <code>: <message>)", the server's code / retryAfterMs attached. */
async function httpError(what: string, res: ResponseLike): Promise<NetError> {
  const info = await serverErrorOf(res);
  return new NetError('http', `${what} failed (${res.status}${codeSuffix(errorDetail(info))})`, res.status, info);
}

// ---- Client --------------------------------------------------------------------------------

export class NetClient {
  readonly clock = new ClockSync();
  readonly loss = new LossEstimator();

  guest: GuestSession | null;
  welcome: Welcome | null = null;
  matchId: string | null = null;
  /**
   * The cars of the match being joined (MatchAssignment.cars): the last matched queue result's or
   * rejoin answer's when it is a node match (seatCars then reads only these, never the node's
   * Welcome), null = not one (the Welcome's roster entries carry theirs). OnlineSession.joinAssigned
   * sets it for a match assigned elsewhere (a lobby, a P2P queue).
   */
  matchCars: Array<CarId | null> | null = null;

  // Counters (monotonic; NetStats turns them into rates).
  bytesIn = 0;
  bytesOut = 0;
  messagesIn = 0;
  messagesOut = 0;
  snapshotsIn = 0;
  reconnects = 0;
  /** The reconnection try under way (1..RECONNECT_TRIES), 0 when none is. */
  reconnectAttempt = 0;
  /** Client clock (now()) when the last snapshot arrived; -1 before the first. */
  lastSnapshotAt = -1;
  /** From the last snapshot. */
  lastBufferHint = 0;
  lastInputTickAcked = 0;

  onOpen: (() => void) | null = null;
  onWelcome: ((w: Welcome) => void) | null = null;
  /** The packet (and its `state` view) is only valid during the callback: copy what you keep. */
  onSnapshot: ((pkt: SnapshotPacket) => void) | null = null;
  onEvent: ((e: MatchEvent) => void) | null = null;
  /**
   * `reconnecting` = a rejoin is in progress; a second onClose with false follows if it fails.
   * `gone`: that rejoin found the match over (404 / 410), nothing to come back to.
   */
  onClose: ((code: number, reason: string, reconnecting: boolean, gone?: boolean) => void) | null = null;
  /** Error / Kick messages from the host and protocol problems. */
  onError: ((code: string, message: string) => void) | null = null;
  /** A Turnstile challenge started (true) / finished (false), for the menu's status line. */
  onTurnstile: ((active: boolean) => void) | null = null;
  /** The check on screen wants the player (true: the menus' sheet, its CANCEL is cancelChallenge) / no longer (false). */
  onAntiBotAsk: ((asking: boolean) => void) | null = null;
  /** A token solved ahead (prewarmAntiBot), for the next challenge. */
  private warm: { token: string; at: number } | null = null;
  private warming = false;
  /** The config came and asks for no anti-bot check (no sitekey: local development). */
  private noSiteKey = false;

  /**
   * Anti-bot flows run one at a time (exclusive): the Hud has a single widget slot that
   * Turnstile.getToken hides on exit, and a caller that waited reuses the guest the one before it
   * registered instead of solving a second challenge.
   */
  private antiBotTail: Promise<void> = Promise.resolve();
  /** Bumped by cancelChallenge: flows queued before it give up instead of rendering a widget. */
  private antiBotEpoch = 0;
  /** Aborts the challenge on screen (cancelChallenge). */
  private challengeAbort: AbortController | null = null;

  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;
  private readonly makeWs: WebSocketFactory;
  private readonly now: () => number;
  private readonly storage: StorageLike | null;
  private readonly pingIntervalMs: number;
  private readonly turnstileContainer: () => HTMLElement | null;
  private readonly turnstileLoader: TurnstileLoader | undefined;
  /** GET /api/config in flight or done (null again after a failure so the next call retries). */
  private configPromise: Promise<ServerConfig> | null = null;

  private ws: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  /** Reconnection tries since the last Welcome. */
  private reconnectTries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelays: readonly number[];
  private allowReconnect = true;
  private queueAbort: AbortController | null = null;
  /** A leaveMatch() / cancelQueue() leave in flight: the next queue waits for it (the lock must be free before the join). */
  private leavePending: Promise<boolean> | null = null;
  /** /api/leave calls made for a 409 / leaveMatch (tests, debug). */
  leaves = 0;
  /** Playlists searched by the next queue (several at once); null = only the `mode` argument. */
  queueModes: Welcome['mode'][] | null = null;
  /** Matchmaking region (REGIONS id) of the next queue, null = automatic (the continent of the request). */
  region: string | null = null;
  /**
   * A signed-in account's session (AccountClient.sessionForQueue), valid for at least `minValidMs`
   * more when given (refreshBearer); null / unset = guest.
   */
  sessionProvider: ((minValidMs?: number) => Promise<GuestSession | null>) | null = null;
  /** The server refused the session (401): an account refreshes it (AccountClient.sessionRejected). */
  onSessionRejected: (() => Promise<unknown>) | null = null;
  /**
   * Asked before ensureGuest hands out a session (`account`: the signed-in account's, else the
   * guest's, stored or new): the terms' acceptance (src/ui/screens/terms.ts termsGate). It resolves
   * at once while there is nothing to accept; a rejection (NetError 'cancelled': the player closed
   * the sheet) stops the queue, the lobby or the rejoin that asked. Null: nothing asked.
   */
  beforeSession: ((account: boolean, signal?: AbortSignal) => Promise<void>) | null = null;
  /** The Bearer of the last queue / rejoin (an account's or the guest's): leave / ice / cancel use it. */
  lastBearer: string | null = null;
  /** Whose `lastBearer` it is: refreshBearer only swaps in a session of the same player. */
  private lastBearerPlayer: string | null = null;
  /** The region the last queue went to (leave / rejoin must reach the same matchmaker). */
  private queuedRegion: string | null = null;

  /** The last waiting answer's `wait` of the running search (null: none yet, or an older server), and when it came (now()). */
  lastWait: QueueWait | null = null;
  lastWaitAt = 0;
  /** Waiting answers of the running search so far (the menus' "While you search" opens on the first). */
  waitingAnswers = 0;
  /** The last waiting answer's `region`: the hub's normalized home, the region its `searchingHere` counts (null: none said). */
  lastWaitRegion: string | null = null;
  /** now() when the running search's first POST left (0: none yet, still at the terms or the session): "While you search" opens about 1 s after it. */
  queuePostedAt = 0;
  /** The last matched answer's extras (the found band's "Casual · 2v2 · Sudamérica"). */
  lastMatched: QueueMatchedExtra | null = null;
  /** The queue's requests fail and are retried (the menus' and the HUD's "Offline: the search goes on..."). */
  queueRetrying = false;
  private preferValue: GameMode | null = null;
  private botsValue: Difficulty | null = null;
  private localValue: 'bots' | 'training' | null = null;
  private readonly visibleFn: () => boolean;
  private lastVisible: boolean;
  private readonly timing: { retryMs: readonly number[]; postTimeoutMs: number; staleMs: number; repostMinMs: number; rateWaitMs: number; retryClearMs: number };
  /** The page is going away (pagehide): the queue loop sends nothing more until it shows again (pageshow, the back / forward cache). */
  private pageGone = false;
  /** Ends the loop's wait for the page to show again. */
  private pageBack: (() => void) | null = null;
  /** The queue POST in flight (null between them): its own controller, when it left (now()), the body version it carries, why the loop aborted it. */
  private queuePost: { ctrl: AbortController; at: number; version: number; reason: PostAbort | null } | null = null;
  /** Bumped by every change the body carries (prefer, bots, local, visibility). */
  private bodyVersion = 0;
  /** now() of the last early re-POST, and the one waiting for its 5 s. */
  private repostAt = Number.NEGATIVE_INFINITY;
  private repostTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ends a plain retry wait at once (the tab back in view, the network back): not rate_limited's own wait. */
  private retryWake: (() => void) | null = null;

  private readonly inputBuf = new Uint8Array(INPUT_HEADER + INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  private readonly pingBuf = new Uint8Array(PING_LEN);
  private readonly pong: PongPacket = { t0: 0, t1: 0, t2: 0, hostTick: 0 };
  private readonly snapshot: SnapshotPacket = {
    tick: 0,
    lastInputTick: 0,
    bufferHint: 0,
    numCars: 0,
    inputs: new Int8Array(MAX_CARS * PACKED_INPUT_BYTES),
    stateLen: 0,
    state: new Uint8Array(0),
    stateHash: 0,
  };

  constructor(opts: NetClientOptions = {}) {
    this.apiBase = opts.apiBase ?? '';
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.makeWs = opts.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    this.now = opts.now ?? defaultNow;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.reconnectDelays = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.turnstileContainer = opts.turnstileContainer ?? (() => null);
    this.turnstileLoader = opts.turnstileLoader;
    this.guest = loadGuestRecord(this.storage).session;
    const qt = opts.queueTiming ?? {};
    this.timing = {
      retryMs: qt.retryMs !== undefined && qt.retryMs.length > 0 ? qt.retryMs : QUEUE_RETRY_MS,
      postTimeoutMs: qt.postTimeoutMs ?? QUEUE_POST_TIMEOUT_MS,
      staleMs: qt.staleMs ?? QUEUE_STALE_MS,
      repostMinMs: qt.repostMinMs ?? QUEUE_REPOST_MIN_MS,
      rateWaitMs: qt.rateWaitMs ?? QUEUE_RATE_WAIT_MS,
      retryClearMs: qt.retryClearMs ?? QUEUE_RETRY_CLEAR_MS,
    };
    const doc = typeof document !== 'undefined' ? document : null;
    this.visibleFn = opts.visible ?? (() => doc === null || doc.visibilityState === 'visible');
    this.lastVisible = this.visibleFn();
    if (opts.visible === undefined && doc !== null && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', () => this.noteVisibility());
    const win = typeof window !== 'undefined' ? window : null;
    if (opts.visible === undefined && win !== null && typeof win.addEventListener === 'function') {
      win.addEventListener('online', () => this.noteOnline());
      win.addEventListener('pagehide', () => this.notePageHide());
      win.addEventListener('pageshow', () => this.notePageShow());
    }
  }

  /** Casual's preferred format, sent as `prefer` (null: none); a change re-POSTs a running search at once (the hub updates it in place). */
  get queuePrefer(): GameMode | null {
    return this.preferValue;
  }

  set queuePrefer(v: GameMode | null) {
    if (v === this.preferValue) return;
    this.preferValue = v;
    this.requestRepost();
  }

  /**
   * Casual's bots level for its solo match, sent as `bots` (null: none, the server's level); a
   * change re-POSTs a running search at once, as queuePrefer does (the hub updates it in place).
   */
  get queueBots(): Difficulty | null {
    return this.botsValue;
  }

  set queueBots(v: Difficulty | null) {
    if (v === this.botsValue) return;
    this.botsValue = v;
    this.requestRepost();
  }

  /** What the player does locally while searching, sent as `local` (the counters only); a change re-POSTs as queuePrefer does. */
  get queueLocal(): 'bots' | 'training' | null {
    return this.localValue;
  }

  set queueLocal(v: 'bots' | 'training' | null) {
    if (v === this.localValue) return;
    this.localValue = v;
    this.requestRepost();
  }

  /**
   * The tab came into view or left it (visibilitychange; the caller's, with opts.visible): the
   * body's `visible` changed, so a running search re-POSTs (the hub's 5:00 bots match waits for a
   * visible tab). Back in view, a POST in flight longer than QUEUE_STALE_MS (a phone's sleep) is
   * aborted and re-sent at once, and a plain retry wait ends (wakeRetry). Hidden, the re-POST goes
   * a moment later: a page going away hides its tab as it goes, and its pagehide stops the loop
   * first (notePageHide), so a dying page sends nothing.
   */
  noteVisibility(): void {
    const v = this.visibleFn();
    if (v === this.lastVisible) return;
    this.lastVisible = v;
    if (this.queueAbort === null) return;
    if (!v) {
      timer(() => {
        if (!this.pageGone) this.requestRepost();
      }, 0);
      return;
    }
    const p = this.queuePost;
    if (p !== null && this.now() - p.at > this.timing.staleMs) {
      this.bodyVersion++;
      this.abortPost('stale');
      return;
    }
    if (this.wakeRetry()) {
      this.bodyVersion++;
      return;
    }
    this.requestRepost();
  }

  /** The network came back (window 'online'; the caller's, with opts.visible): a plain retry wait ends (wakeRetry). */
  noteOnline(): void {
    if (this.queueAbort !== null) this.wakeRetry();
  }

  /**
   * The page is going away (pagehide: a reload, a closed tab, the back / forward cache): the queue
   * loop stops sending, the long-poll in flight is dropped, and no /api/leave goes (the hub keeps
   * the search's clock for a while: a reloaded page searching again finds it). Shown again from the
   * back / forward cache (notePageShow), the same search POSTs again at once.
   */
  notePageHide(): void {
    this.pageGone = true;
    this.abortPost('page');
  }

  /** The page shows again (pageshow): a search stopped by notePageHide goes on. */
  notePageShow(): void {
    this.pageGone = false;
    const back = this.pageBack;
    this.pageBack = null;
    if (back !== null) back();
  }

  /**
   * End a plain retry wait at once (the tab back in view, the network back), at most once per
   * repostMinMs as the early re-POSTs (toggling the tab through an outage keeps most of the
   * backoff); never rate_limited's own wait. True when it woke one.
   */
  private wakeRetry(): boolean {
    const wake = this.retryWake;
    if (wake === null || this.now() - this.repostAt < this.timing.repostMinMs) return false;
    this.repostAt = this.now();
    wake();
    return true;
  }

  /** While the page is gone (notePageHide): wait until it shows again, or the search is cancelled. */
  private async pageGate(signal: AbortSignal): Promise<void> {
    while (this.pageGone && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done);
          if (this.pageBack === done) this.pageBack = null;
          resolve();
        };
        signal.addEventListener('abort', done);
        this.pageBack = done;
      });
    }
  }

  /**
   * The anti-bot check would pass without asking anything (a TV guest's rooms, Inicio): a guest
   * session is stored, a quiet check passed within WARM_MS (prewarmAntiBot), or the server asks for
   * none (no sitekey).
   */
  get antiBotReady(): boolean {
    if (sessionValid(this.guest)) return true;
    if (this.warm !== null && this.now() - this.warm.at < WARM_MS) return true;
    return this.noSiteKey;
  }

  /** The body changed (prefer, local, visibility): abort the long-poll in flight and re-POST, at most once per repostMinMs. */
  private requestRepost(): void {
    this.bodyVersion++;
    if (this.queueAbort === null || this.queuePost === null) return; // between POSTs or waiting to retry: the next one carries it
    const wait = this.repostAt + this.timing.repostMinMs - this.now();
    if (wait <= 0) {
      this.repostAt = this.now();
      this.abortPost('repost');
      return;
    }
    if (this.repostTimer !== null) return;
    this.repostTimer = timer(() => {
      this.repostTimer = null;
      const p = this.queuePost;
      if (this.queueAbort === null || p === null || p.version >= this.bodyVersion) return;
      this.repostAt = this.now();
      this.abortPost('repost');
    }, wait);
  }

  /** Abort the queue POST in flight with the loop's own controller (`reason`: re-POST at once, no backoff). */
  private abortPost(reason: PostAbort): void {
    const p = this.queuePost;
    if (p === null || p.reason !== null) return;
    p.reason = reason;
    p.ctrl.abort();
  }

  // ---- guest / queue ---------------------------------------------------------------------

  /** The guest's name, the server's wire form ('Invitado 4821'; src/ui/names.ts playerName shows it), '' before the first session. */
  get name(): string {
    return this.guest?.name ?? '';
  }

  /**
   * The server's public configuration, fetched once (GET /api/config) and cached for the life of
   * the client (= the page). A 404 (server without the route) counts as "no sitekey"; any other
   * failure rejects and is retried by the next call.
   */
  config(): Promise<ServerConfig> {
    let p = this.configPromise;
    if (p !== null) return p;
    p = this.fetchConfig();
    this.configPromise = p;
    p.catch(() => {
      if (this.configPromise === p) this.configPromise = null;
    });
    return p;
  }

  private async fetchConfig(): Promise<ServerConfig> {
    let res: ResponseLike;
    try {
      res = await this.fetchFn(this.apiBase + '/api/config', { method: 'GET', headers: {} });
    } catch (err) {
      throw new NetError('network', `config request failed: ${describe(err)}`);
    }
    // 404: a server without the route (before Turnstile) -> no sitekey, nothing else known.
    if (res.status === 404) {
      this.noSiteKey = true;
      return { turnstileSiteKey: null, protocol: 0, version: '', region: '' };
    }
    if (!res.ok) throw await httpError('config', res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetError('protocol', 'malformed config');
    }
    const cfg = parseServerConfig(body);
    if (cfg === null) throw new NetError('protocol', 'malformed config');
    if (cfg.protocol !== 0 && cfg.protocol !== PROTOCOL_VERSION) {
      throw new NetError('protocol', `server protocol ${cfg.protocol} (client ${PROTOCOL_VERSION})`);
    }
    this.noSiteKey = cfg.turnstileSiteKey === null;
    return cfg;
  }

  /**
   * The stored session, or a fresh one from POST /api/guest. With a
   * sitekey in the config a Turnstile token is obtained first (the widget lives in the container
   * from the options; `signal` cancels the challenge). Rejects with NetError 'turnstile' when the
   * check fails on either side.
   */
  async ensureGuest(signal?: AbortSignal): Promise<GuestSession> {
    if (this.sessionProvider !== null) {
      const a = await this.sessionProvider();
      if (a !== null) {
        if (this.beforeSession !== null) await this.beforeSession(true, signal);
        this.lastBearer = a.session;
        this.lastBearerPlayer = a.playerId;
        return a;
      }
    }
    // The terms' acceptance (the legal draft's P2, P33) before a guest's session is used or made.
    if (this.beforeSession !== null) await this.beforeSession(false, signal);
    const g = this.storedGuest();
    if (g !== null) return g;
    // A lobby join, a queue and a sign-up can ask together: one registration (and one widget) at a
    // time; whoever waited re-checks and reuses the session registered before it.
    return this.exclusive(signal, () => {
      const again = this.storedGuest();
      return again !== null ? Promise.resolve(again) : this.registerGuest(signal);
    });
  }

  /** The stored guest session when it is still valid (and remembered as the bearer). */
  private storedGuest(): GuestSession | null {
    const g = this.guest;
    if (!sessionValid(g)) return null;
    this.lastBearer = g.session;
    this.lastBearerPlayer = g.playerId;
    return g;
  }

  /** POST /api/guest, with a Turnstile token first when the config has a sitekey. Run under exclusive(). */
  private async registerGuest(signal?: AbortSignal): Promise<GuestSession> {
    const cfg = await this.config();
    const req: GuestRequest = {};
    if (cfg.turnstileSiteKey !== null) req.turnstileToken = await this.challenge(cfg.turnstileSiteKey, signal);
    const res = await this.post('/api/guest', req, null);
    if (!res.ok) {
      const info = await serverErrorOf(res);
      if (info.code === 'turnstile_failed' || info.code === 'turnstile_unconfigured') {
        throw new NetError('turnstile', `guest registration refused (${res.status} ${info.code})`, res.status, info);
      }
      throw new NetError('http', `guest registration failed (${res.status}${codeSuffix(errorDetail(info))})`, res.status, info);
    }
    const body = await res.json();
    if (!isGuestSession(body)) throw new NetError('protocol', 'malformed guest session');
    this.guest = body;
    this.lastBearer = body.session;
    this.lastBearerPlayer = body.playerId;
    saveGuestRecord(this.storage, { session: body });
    return body;
  }

  /**
   * A Turnstile token when the server asks for one (its config has a sitekey), else null: account
   * registration (AccountClient) goes through the same anti-bot check as guests. `quiet`: never ask
   * the player (a TV's remote cannot answer Cloudflare's challenge): a check that wants a press
   * rejects at once, as the pre-warm's does, and the caller goes on without a token.
   */
  async antiBotToken(signal?: AbortSignal, quiet = false): Promise<string | null> {
    const siteKey = (await this.config()).turnstileSiteKey;
    return siteKey === null ? null : this.exclusive(signal, () => this.challenge(siteKey, signal, quiet));
  }

  /**
   * Inicio opened: with a sitekey and no guest session stored, solve the check now and keep its
   * token for the next registration (a guest's, a sign-up's), so JUGAR rarely waits for it. A check
   * that wants an interaction is dropped quietly: the registration's own asks the player. A token
   * older than REWARM_AFTER_MS is solved again (a TV guest's rooms re-warm it every 4 minutes while
   * Inicio or SALAS is up: antiBotReady holds through, the old token stays until the new one comes).
   */
  prewarmAntiBot(): void {
    if (this.warming || (this.warm !== null && this.now() - this.warm.at < REWARM_AFTER_MS)) return;
    if (sessionValid(this.guest)) return;
    this.warming = true;
    void (async () => {
      try {
        const siteKey = (await this.config()).turnstileSiteKey;
        if (siteKey === null) return;
        const token = await this.exclusive(undefined, () => this.challenge(siteKey, undefined, true, false));
        this.warm = { token, at: this.now() };
      } catch {
        /* offline, refused, wanted a click: the next registration runs its own check */
      } finally {
        this.warming = false;
      }
    })();
  }

  /**
   * Ends the anti-bot challenge on screen and drops the flows waiting for the widget (the menus
   * closed into a match: nobody is there to solve it). They reject with NetError 'cancelled'.
   */
  cancelChallenge(): void {
    this.antiBotEpoch++;
    if (this.challengeAbort !== null) this.challengeAbort.abort();
  }

  /**
   * Run `fn` after every anti-bot flow queued before it settled. `signal` (or a cancelChallenge
   * meanwhile) gives up the wait with NetError 'cancelled'; the next flow still waits for the ones
   * before this one.
   */
  private async exclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = this.antiBotTail;
    let release!: () => void;
    this.antiBotTail = new Promise<void>((r) => (release = r));
    const epoch = this.antiBotEpoch;
    let running = false;
    try {
      await untilSettled(prev, signal);
      if (epoch !== this.antiBotEpoch) throw new NetError('cancelled', 'challenge cancelled');
      running = true;
      return await fn();
    } finally {
      if (running) release();
      else void prev.then(release);
    }
  }

  /**
   * One Turnstile challenge in the Hud's container (or the pre-warmed token, while fresh);
   * onTurnstile brackets it for the status line, onAntiBotAsk an interaction. `quiet`: the pre-warm,
   * which reports nothing and gives up on an interaction. `useWarm` false: a new token whatever the
   * warm one (the pre-warm renewing it, which keeps it meanwhile). Run under exclusive().
   */
  private async challenge(siteKey: string, signal?: AbortSignal, quiet = false, useWarm = true): Promise<string> {
    if (useWarm) {
      const warm = this.warm;
      this.warm = null;
      if (warm !== null && this.now() - warm.at < WARM_MS) return warm.token;
    }
    const container = this.turnstileContainer();
    if (container === null) throw new NetError('turnstile', 'no element to render the Turnstile widget into');
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    if (signal !== undefined) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort);
    }
    this.challengeAbort = ctrl;
    if (this.onTurnstile && !quiet) this.onTurnstile(true);
    const onInteractive = (on: boolean): void => {
      if (quiet) {
        if (on) ctrl.abort();
      } else if (this.onAntiBotAsk) this.onAntiBotAsk(on);
    };
    try {
      return await turnstileToken(siteKey, container, { load: this.turnstileLoader, signal: ctrl.signal, onInteractive });
    } catch (err) {
      if (signal !== undefined && signal.aborted) throw new NetError('cancelled', 'queue cancelled');
      if (ctrl.signal.aborted) throw new NetError('cancelled', 'challenge cancelled');
      throw new NetError('turnstile', describe(err));
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      if (this.challengeAbort === ctrl) this.challengeAbort = null;
      if (this.onTurnstile && !quiet) this.onTurnstile(false);
    }
  }

  /**
   * Quick match: long-poll POST /api/queue until the matchmaker assigns a match. `onWaiting`
   * reports the players waiting after each poll and the answer's `wait` (absent from an older
   * server). Rejects with NetError 'cancelled' on cancelQueue(). Without a kind (phase 1 callers)
   * the queue is a server match and resolves to a MatchAssignment; with one it resolves to the
   * QueueAssignment the server formed.
   */
  queue(mode: Welcome['mode'], onWaiting?: (waiting: number, wait?: QueueWait) => void): Promise<MatchAssignment>;
  queue(mode: Welcome['mode'], kind: QueueKind, onWaiting?: (waiting: number, wait?: QueueWait) => void): Promise<QueueAssignment>;
  queue(mode: Welcome['mode'], kindOrWaiting?: QueueKind | ((waiting: number, wait?: QueueWait) => void), onWaiting?: (waiting: number, wait?: QueueWait) => void): Promise<MatchAssignment | QueueAssignment> {
    if (typeof kindOrWaiting === 'string') return this.queueKind(mode, kindOrWaiting, onWaiting);
    // Phase 1 shape: the plain server assignment (a p2p answer to a server queue is a protocol error).
    return this.queueKind(mode, 'server', kindOrWaiting).then((a) => {
      if (a.kind !== 'server') throw new NetError('protocol', 'server queue answered with a p2p room');
      return { matchId: a.matchId, ticket: a.ticket, wsUrl: a.wsUrl, ...(a.cars ? { cars: a.cars } : {}) };
    });
  }

  /**
   * Wait `ms` between queue tries, unless the search is cancelled (NetError 'cancelled'). A plain
   * retry's wait (`wakeable`: a network error, a 5xx) also ends when the tab comes back into view or
   * the network comes back (wakeRetry); rate_limited's own wait never does.
   */
  private async queueWait(ms: number, signal: AbortSignal, wakeable = false): Promise<void> {
    if (signal.aborted) throw new NetError('cancelled', 'queue cancelled');
    await new Promise<void>((resolve) => {
      let h: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (h !== null) clearTimeout(h);
        signal.removeEventListener('abort', done);
        if (this.retryWake === done) this.retryWake = null;
        resolve();
      };
      h = timer(done, ms);
      signal.addEventListener('abort', done);
      if (wakeable) this.retryWake = done;
    });
    if (signal.aborted) throw new NetError('cancelled', 'queue cancelled');
  }

  private async queueKind(mode: Welcome['mode'], kind: QueueKind, onWaiting?: (waiting: number, wait?: QueueWait) => void): Promise<QueueAssignment> {
    if (this.queueAbort !== null) throw new NetError('state', 'already queueing');
    const ctrl = new AbortController();
    this.queueAbort = ctrl;
    this.matchCars = null;
    this.lastWait = null;
    this.lastWaitAt = 0;
    this.waitingAnswers = 0;
    this.lastWaitRegion = null;
    this.queuePostedAt = 0;
    this.lastMatched = null;
    this.queueRetrying = false;
    this.repostAt = Number.NEGATIVE_INFINITY;
    let retries = 0;
    let rateLimited = false;
    /** The next wait after a failure that is retried (1, 2, 4, 8, 15, then 30 s): `queueRetrying` meanwhile. */
    const retryLater = async (): Promise<void> => {
      this.queueRetrying = true;
      const steps = this.timing.retryMs;
      await this.queueWait(steps[Math.min(retries++, steps.length - 1)], ctrl.signal, true);
    };
    /**
     * The search's session (ensureGuest: the terms, an account's or the guest's), its failures on
     * the way to the server tried again as a POST's are (a phone that starts a search offline).
     */
    const sessionOf = async (): Promise<GuestSession> => {
      for (;;) {
        try {
          return await this.ensureGuest(ctrl.signal);
        } catch (err) {
          if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
          if (!networkFailure(err)) throw err;
          await retryLater();
        }
      }
    };
    try {
      let session = await sessionOf();
      /** A 401 since the last answer: the session was registered (or refreshed) again once. */
      let reRegistered = false;
      let recovered = false;
      /** No answer yet: the POST says it is the loop's first (`first`: the Worker answers it at once). */
      let answered = false;
      for (;;) {
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        // The page going away: nothing more is sent (back from the back / forward cache: on we go).
        await this.pageGate(ctrl.signal);
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        // A room lock being released (leaveMatch): the join must land after it, or it answers 409.
        const leaving = this.leavePending;
        if (leaving !== null) await leaving.catch(() => false);
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        // An account's session lasts an hour and a search may last longer (Competitive, the wait's
        // unlimited match): renewed before it runs out, never mid-search by a 401.
        if (this.sessionProvider !== null && sessionExpiryMs(session) - Date.now() <= SESSION_MIN_REMAINING_MS) {
          const fresh = await this.sessionProvider().catch(() => null);
          if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
          if (fresh !== null && fresh.playerId === session.playerId) {
            session = fresh;
            this.lastBearer = fresh.session;
          }
        }
        // This POST's own controller: the cancel aborts it, and so does the loop (an early re-POST,
        // the watchdog, a stale long-poll on the tab coming back), which then re-POSTs at once.
        const post = { ctrl: new AbortController(), at: this.now(), version: this.bodyVersion, reason: null as PostAbort | null };
        const onCancel = (): void => post.ctrl.abort();
        ctrl.signal.addEventListener('abort', onCancel);
        this.queuePost = post;
        if (this.queuePostedAt === 0) this.queuePostedAt = post.at || 1;
        const watchdog = timer(() => this.abortPost('watchdog'), this.timing.postTimeoutMs);
        // A retried POST still in flight after a moment reached the server (a long-poll): the
        // "Offline: ..." line goes (a failure brings it back).
        const cleared = this.queueRetrying
          ? timer(() => {
              if (this.queuePost === post) this.queueRetrying = false;
            }, this.timing.retryClearMs)
          : null;
        let res: ResponseLike | null = null;
        let body: unknown = undefined;
        let failed = false;
        try {
          res = await raceAbort(this.post('/api/queue', this.queueBody(mode, kind, !answered), session.session, post.ctrl.signal), post.ctrl.signal);
          // A waiting or matched answer's body, read here: an abort while it streams is the same abort.
          if (res.ok) body = await raceAbort(res.json(), post.ctrl.signal);
        } catch {
          failed = true;
        } finally {
          clearTimeout(watchdog);
          if (cleared !== null) clearTimeout(cleared);
          ctrl.signal.removeEventListener('abort', onCancel);
          if (this.queuePost === post) this.queuePost = null;
        }
        if (ctrl.signal.aborted) throw new NetError('cancelled', 'queue cancelled');
        // The loop's own abort: the same search goes on at once with the new body (no backoff).
        if (post.reason !== null) continue;
        if (failed || res === null) {
          // No answer (the network, a long-poll the browser dropped) or an unreadable one: try again.
          await retryLater();
          continue;
        }
        if (res.status === 401) {
          // Expired / unknown session: register again (an account: refresh it), once per answer. A
          // second 401 in a row (a proxy stripping Authorization, a server misconfiguration) is an
          // error, not a loop; a refresh that could not reach the server (the same session back) is
          // the network's, tried again later.
          if (reRegistered) throw new NetError('http', 'session rejected', 401);
          reRegistered = true;
          if (this.onSessionRejected !== null) await this.onSessionRejected().catch(() => undefined);
          this.guest = null;
          const refused = session.session;
          session = await sessionOf();
          // An account's refresh that never reached the server hands the refused session back (a
          // guest's registration always makes a new one, kept as `guest`).
          if (session !== this.guest && session.session === refused) {
            reRegistered = false;
            await retryLater();
          }
          continue;
        }
        if (res.status === 409) {
          let body: ConflictBody = {};
          try {
            const parsed: unknown = await res.json();
            if (typeof parsed === 'object' && parsed !== null) body = parsed as ConflictBody;
          } catch {
            /* no body */
          }
          const info = serverErrorFrom(body);
          if (body.error === 'active_match' && typeof body.matchId === 'string') {
            if (body.kind === 'p2p' || kind === 'p2p') {
              // A P2P room of ours is (or looks) alive: it cannot be rejoined (single-use ticket, no
              // authority to resync from). A server match on a P2P queue is not rejoined either: the
              // player asked for P2P (a match it quit whose release never reached the server would
              // pull it back in). Free that lock (POST /api/leave { matchId }: a server match hands
              // our car to its bots) and queue again, once.
              if (!recovered) {
                recovered = true;
                await this.leaveActive(session.session, body.matchId, ctrl.signal);
                continue;
              }
              const what = body.kind === 'p2p' ? `la sala P2P ${body.matchId.slice(0, 8)} sigue activa` : `el partido en servidor ${body.matchId.slice(0, 8)} sigue activo`;
              throw new NetError('http', `queue failed (409 ${errorDetail(info) || 'active_match'}: ${what})`, 409, info);
            }
            // A server match of ours is alive (e.g. the matchmaker filled a room we had stopped
            // polling for): rejoin it with a fresh ticket instead of failing. Gone (404 / 410: the
            // Worker freed the lock) -> queue again, once.
            try {
              const m = await this.rejoin(body.matchId);
              this.reconnectTries = 0; // a fresh assignment gets its own reconnect budget
              this.allowReconnect = true;
              return { kind: 'server', matchId: m.matchId, ticket: m.ticket, wsUrl: m.wsUrl, ...(m.cars ? { cars: m.cars } : {}), ...(kind === 'ranked' ? { ranked: true } : {}) };
            } catch (err) {
              if (recovered || !(err instanceof NetError) || (err.status !== 404 && err.status !== 410)) throw err;
              recovered = true;
              // 410 p2p_room: that id is a P2P room (an older server 409 without its kind): free it first.
              if (err.serverCode === 'p2p_room') await this.leaveActive(session.session, body.matchId, ctrl.signal);
              continue;
            }
          }
          throw new NetError('http', `queue failed (409 ${errorDetail(info) || 'conflict'})`, 409, info);
        }
        if (!res.ok) {
          // 426 reload_required, 403 account_required, 429 ranked_ban, 503 matchmaking_off...: the
          // code rides on the error and ends the search. A server's hiccup (a 500, 502, 504, a 503
          // without a known code) is tried again; rate_limited once more after its own wait.
          const err = await httpError('queue', res);
          const what = queueFailure(res.status, err.serverCode);
          if (what === 'end' || (what === 'rateLimited' && rateLimited)) throw err;
          if (what === 'rateLimited') {
            rateLimited = true;
            await this.queueWait(err.retryAfterMs > 0 ? err.retryAfterMs : this.timing.rateWaitMs, ctrl.signal);
          } else await retryLater();
          continue;
        }
        // An answer: the network and the server are back, and the session good (a 401 later, after
        // the hour an account's lasts, is refreshed again).
        retries = 0;
        rateLimited = false;
        reRegistered = false;
        this.queueRetrying = false;
        if (typeof body !== 'object' || body === null) {
          await retryLater();
          continue;
        }
        answered = true;
        const q = body as QueueResult | QueueResultP2p;
        if (q.status === 'matched') {
          if (typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string') throw new NetError('protocol', 'matched without ticket / wsUrl');
          if ((q as QueueResultP2p).kind === 'p2p') {
            const roomId = (q as QueueResultP2p).roomId;
            if (typeof roomId !== 'string') throw new NetError('protocol', 'p2p match without roomId');
            return { kind: 'p2p', roomId, ticket: q.ticket, wsUrl: q.wsUrl };
          }
          const matchId = (q as QueueResult).matchId;
          if (typeof matchId !== 'string') throw new NetError('protocol', 'matched without matchId');
          this.matchId = matchId;
          this.reconnectTries = 0;
          this.allowReconnect = true;
          const out: ServerAssignment = { kind: 'server', matchId, ticket: q.ticket, wsUrl: q.wsUrl };
          if ((q as QueueResult).ranked === true) out.ranked = true;
          // A node match's cars by slot, from the Worker ([] when all drive the default; the node's
          // own Welcome is never read for them); a field of another shape is dropped.
          const cars = nodeCarsOf(q);
          this.matchCars = cars ?? null;
          if (cars) out.cars = cars;
          this.lastMatched = matchedExtraOf(q);
          return out;
        }
        const waiting = (q as QueueResult).waiting;
        const wait = parseQueueWait((q as { wait?: unknown }).wait);
        const home = (q as { region?: unknown }).region;
        this.lastWait = wait;
        this.lastWaitAt = this.now();
        this.lastWaitRegion = typeof home === 'string' && home.length > 0 ? home : null;
        this.waitingAnswers++;
        if (onWaiting) onWaiting(typeof waiting === 'number' ? waiting : 0, wait ?? undefined);
      }
    } finally {
      if (this.queueAbort === ctrl) this.queueAbort = null;
      // No search of ours runs any more (a new one started after a cancel keeps its own state).
      if (this.queueAbort === null) {
        if (this.repostTimer !== null) clearTimeout(this.repostTimer);
        this.repostTimer = null;
        this.queueRetrying = false;
      }
    }
  }

  /**
   * GET /api/ice: the STUN / TURN servers for the P2P mesh (TURN credentials are short-lived, so
   * fetch right before the room). A server without the route (404) gives DEFAULT_ICE_SERVERS; a
   * malformed body rejects with NetError 'protocol'. Sent with the session when there is one.
   */
  async fetchIce(): Promise<IceServer[]> {
    const headers: Record<string, string> = {};
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    let res: ResponseLike;
    try {
      res = await this.fetchFn(this.apiBase + '/api/ice', { method: 'GET', headers });
    } catch (err) {
      throw new NetError('network', `ice request failed: ${describe(err)}`);
    }
    if (res.status === 404) return DEFAULT_ICE_SERVERS.slice();
    if (!res.ok) throw await httpError('ice', res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetError('protocol', 'malformed ice servers');
    }
    const servers = parseIceServers(body);
    if (servers === null) throw new NetError('protocol', 'malformed ice servers');
    return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS.slice();
  }

  get queueing(): boolean {
    return this.queueAbort !== null;
  }

  /**
   * Stop waiting: aborts the long-poll (queue() rejects with 'cancelled') and tells the matchmaker
   * to drop us (POST /api/leave, best effort, no retry) so the bot fill does not open a room we
   * never join. Without a session yet nothing was queued server-side (the join is skipped). A
   * queue() right after it (a search restarted with another format) is allowed at once and waits
   * for that leave, so the leave never drops the new waiter.
   */
  cancelQueue(): void {
    const ctrl = this.queueAbort;
    if (ctrl === null) return;
    ctrl.abort();
    // The aborted loop's finally runs later: free the slot now (that finally only clears its own).
    this.queueAbort = null;
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer === null) return;
    const prior = this.leavePending;
    const p: Promise<boolean> = this.post('/api/leave', this.withRegion({}), bearer)
      .then(
        (res) => res.ok,
        () => false,
      )
      // A leaveMatch still in flight is waited for too: the next queue sees only this one.
      .then((ok) => (prior !== null ? prior.then(() => ok) : ok))
      .finally(() => {
        if (this.leavePending === p) this.leavePending = null;
      });
    this.leavePending = p;
  }

  /**
   * POST /api/leave after a P2P room (fallback, leave, cancel, failure, the final whistle; no
   * `matchId`): the matchmaker frees our one-active-match lock for the room at once and kicks our
   * room socket if it is still open. With the `matchId` of a server match (OnlineSession.leave: an
   * explicit quit) that match's lock is freed too and the MatchDO hands our car to its bots for
   * good (no rejoin); without one a server lock is kept (the rejoin path). Resolves with the
   * server's `released` flag (false without a session, on a network error or when there was
   * nothing to release). The next queue() waits for it. `opts.connected` false adds
   * `connected: false` (no Welcome came). `opts.retryRejected` (a match on a community node, which
   * this POST is the only way out of): a 401 is retried once with a refreshed account session
   * (leaveAgain).
   */
  leaveMatch(matchId?: string, opts: LeaveOptions = {}): Promise<boolean> {
    const bearer = this.lastBearer ?? this.guest?.session ?? null;
    if (bearer === null) return Promise.resolve(false);
    // Whose leave it is: lastBearer may belong to someone else by the time a retry goes out.
    const who = this.lastBearerPlayer;
    this.leaves++;
    const fields: { matchId?: string; connected?: false } = matchId !== undefined ? { matchId } : {};
    if (opts.connected === false) fields.connected = false;
    const payload = this.withRegion(fields);
    // The first POST goes out now, before the caller closes the socket; only a retry waits.
    let answer = this.post('/api/leave', payload, bearer);
    if (opts.retryRejected === true) answer = answer.then((res) => (res.status === 401 ? this.leaveAgain(payload, bearer, who, res) : res));
    const p = answer
      .then(async (res) => {
        if (!res.ok) return false;
        try {
          const body = (await res.json()) as { released?: unknown };
          return body.released === true;
        } catch {
          return false;
        }
      })
      .catch(() => false)
      .finally(() => {
        if (this.leavePending === p) this.leavePending = null;
      });
    this.leavePending = p;
    return p;
  }

  /**
   * A leave refused with 401: refresh the account's session (onSessionRejected) and POST the same
   * body with it, once. Only a fresh session of `who`, the player the leave was sent as, is used:
   * another flow (the menu starting a queue) may have moved lastBearer to a guest or another
   * account meanwhile. Resolves the refusal when there is none (a guest, a sign-out, a refresh
   * that failed) or the retry does not get through.
   */
  private async leaveAgain(body: object, bearer: string, who: string | null, refused: ResponseLike): Promise<ResponseLike> {
    if (this.onSessionRejected !== null) await this.onSessionRejected().catch(() => undefined);
    const fresh = await this.refreshBearer();
    if (fresh === null || fresh.playerId !== who || fresh.session === bearer) return refused;
    this.leaves++;
    return this.post('/api/leave', body, fresh.session).catch(() => refused);
  }

  /**
   * Make `lastBearer` (what leave / ice / cancel send) good for `minValidMs` more: an account's
   * session is refreshed early through sessionProvider, a guest's (24 h) stays. Only a session of
   * the player `lastBearer` belongs to replaces it (a sign-in since the queue must not leave as
   * someone else). Resolves the session it adopted, null when the old Bearer stays. Never rejects:
   * on a failure the old Bearer stays and a 401 on the leave asks again.
   */
  async refreshBearer(minValidMs?: number): Promise<GuestSession | null> {
    const provider = this.sessionProvider;
    if (provider === null) return null;
    let s: GuestSession | null;
    try {
      s = await provider(minValidMs);
    } catch {
      return null;
    }
    if (s === null || s.playerId !== this.lastBearerPlayer) return null;
    this.lastBearer = s.session;
    return s;
  }

  /**
   * POST /api/queue body (read once per POST): the client-version marker (QUEUE_API: a page without
   * it is refused with 426 reload_required), the playlists (`queueModes`, else `mode`), the kind
   * (never 'p2p': the P2P queue is gone, the server reads it as 'server'), the region when one is
   * chosen, Casual's `prefer` and `bots`, what the player does locally (`local`), whether the tab is in view,
   * and `first: true` while the search has had no answer yet (`first`: a new search, or one a
   * reloaded page starts again, whose waiter the hub still holds): the Worker answers that join at
   * once, without the long-poll. Only the loop's first POST in practice; again only when it got no
   * answer (the network, the watchdog, an abort of the loop's own, a 5xx, a 401's new session).
   */
  private queueBody(mode: Welcome['mode'], kind: QueueKind, first: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { api: QUEUE_API, mode, kind: kind === 'p2p' ? 'server' : kind };
    const modes = this.queueModes;
    if (modes !== null && modes.length > 0) body.modes = modes.slice();
    if (this.region !== null) body.region = this.region;
    if (this.preferValue !== null) body.prefer = this.preferValue;
    if (this.botsValue !== null) body.bots = this.botsValue;
    if (this.localValue !== null) body.local = this.localValue;
    body.visible = this.visibleFn();
    if (first) body.first = true;
    this.queuedRegion = this.region;
    return body;
  }

  /** `body` plus the region of the last queue (leave / rejoin reach the matchmaker that holds our lock). */
  private withRegion<T extends object>(body: T): T & { region?: string } {
    return this.queuedRegion !== null ? { ...body, region: this.queuedRegion } : body;
  }

  /** The 409 recovery: POST /api/leave { matchId } (awaited; errors are swallowed: the retry's answer decides). */
  private async leaveActive(bearer: string, matchId: string, signal: AbortSignal): Promise<void> {
    this.leaves++;
    try {
      await this.post('/api/leave', this.withRegion({ matchId }), bearer, signal);
    } catch {
      /* the retry below reports the real reason */
    }
  }

  // ---- socket ----------------------------------------------------------------------------

  /**
   * Open the match socket of a new assignment (its own reconnection tries); the ticket travels in
   * the subprotocol list (browsers cannot set headers).
   */
  connect(wsUrl: string, ticket: string): void {
    this.reconnectTries = 0;
    this.reconnectAttempt = 0;
    this.allowReconnect = true;
    this.openSocket(wsUrl, ticket);
  }

  private openSocket(wsUrl: string, ticket: string): void {
    this.stopReconnect();
    this.closeSocket(1000, 'reconnect');
    this.closedByUs = false;
    this.welcome = null;
    this.clock.reset();
    this.loss.reset();
    this.lastSnapshotAt = -1;
    const ws = this.makeWs(resolveWsUrl(wsUrl), [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.startPing();
      if (this.onOpen) this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (ws === this.ws) this.handleMessage(ev.data);
    };
    ws.onclose = (ev) => this.handleClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      /* a close event follows */
    };
    this.ws = ws;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Close the socket (code 1000 = leaving on purpose: no reconnect). */
  close(code = 1000, reason = ''): void {
    this.closedByUs = true;
    this.stopReconnect();
    this.cancelQueue();
    this.closeSocket(code, reason);
  }

  /** Batched inputs: `count` ticks from `firstTick`, 6 int8 each at packed[packedOff..], oldest first. */
  sendInputs(firstTick: number, count: number, packed: Int8Array, ackTick: number, packedOff = 0): boolean {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN || count < 1 || count > INPUT_MAX_BATCH) return false;
    const len = encodeInput(this.inputBuf, firstTick, count, ackTick, packed, packedOff);
    ws.send(this.inputBuf.subarray(0, len));
    this.bytesOut += len;
    this.messagesOut++;
    return true;
  }

  sendReady(): void {
    this.sendJson(MsgType.Ready, {});
  }

  /** Estimated host tick now (fractional); 0 until the first pong. */
  hostTickEstimate(nowMs = this.now()): number {
    return this.clock.hostTickEstimate(nowMs);
  }

  get rtt(): number {
    return this.clock.rtt;
  }

  get jitter(): number {
    return this.clock.jitter;
  }

  /** ms since the last snapshot arrived (-1 before the first). */
  snapshotAge(nowMs = this.now()): number {
    return this.lastSnapshotAt < 0 ? -1 : nowMs - this.lastSnapshotAt;
  }

  /** Drop everything (leaving the menu); counters stay for the panel. */
  dispose(): void {
    this.close(1000, 'dispose');
    this.onOpen = null;
    this.onWelcome = null;
    this.onSnapshot = null;
    this.onEvent = null;
    this.onClose = null;
    this.onError = null;
  }

  // ---- internals -------------------------------------------------------------------------

  private async post(path: string, body: unknown, bearer: string | null, signal?: AbortSignal): Promise<ResponseLike> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    const init: RequestInitLike = { method: 'POST', headers, body: JSON.stringify(body) };
    if (signal !== undefined) init.signal = signal;
    return this.fetchFn(this.apiBase + path, init);
  }

  private sendJson(type: MsgType, payload: unknown): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return;
    const frame = encodeJson(type, payload);
    ws.send(frame);
    this.bytesOut += frame.length;
    this.messagesOut++;
  }

  private startPing(): void {
    this.stopPing();
    this.sendPing();
    const timer: unknown = setInterval(() => this.sendPing(), this.pingIntervalMs);
    // Under node (tests) a live interval would keep the process alive after the test ends.
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as { unref(): void }).unref();
    }
    this.pingTimer = timer as ReturnType<typeof setInterval>;
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Public for tests / manual clock probes. */
  sendPing(): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return;
    const len = encodePing(this.pingBuf, this.now());
    ws.send(this.pingBuf.subarray(0, len));
    this.bytesOut += len;
    this.messagesOut++;
  }

  private handleMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const buf = new Uint8Array(data);
    this.bytesIn += buf.length;
    this.messagesIn++;
    if (buf.length === 0) return;
    switch (msgType(buf)) {
      case MsgType.Snapshot: {
        const pkt = this.snapshot;
        if (!decodeSnapshot(buf, pkt)) return;
        this.snapshotsIn++;
        this.lastSnapshotAt = this.now();
        this.lastBufferHint = pkt.bufferHint;
        this.lastInputTickAcked = pkt.lastInputTick;
        this.loss.onSnapshotTick(pkt.tick);
        if (this.onSnapshot) this.onSnapshot(pkt);
        return;
      }
      case MsgType.Pong: {
        const p = this.pong;
        if (!decodePong(buf, p)) return;
        this.clock.addPong(p.t0, p.t1, p.t2, this.now(), p.hostTick);
        return;
      }
      case MsgType.Welcome: {
        const w = decodeJson<Welcome>(buf);
        if (w.protocol !== PROTOCOL_VERSION) {
          this.fail('protocol', `protocol ${w.protocol} (client ${PROTOCOL_VERSION})`);
          return;
        }
        this.welcome = w;
        this.matchId = w.matchId;
        this.reconnectTries = 0; // back in: a later drop gets every try again
        this.reconnectAttempt = 0;
        if (this.onWelcome) this.onWelcome(w);
        return;
      }
      case MsgType.Event: {
        const e = decodeJson<MatchEvent>(buf);
        if (e.type === 'ended') this.allowReconnect = false;
        if (this.onEvent) this.onEvent(e);
        return;
      }
      case MsgType.Error: {
        const e = decodeJson<{ code?: string; message?: string }>(buf);
        if (this.onError) this.onError(e.code ?? 'error', e.message ?? 'host error');
        return;
      }
      case MsgType.Kick: {
        const k = decodeJson<{ reason?: string }>(buf);
        this.allowReconnect = false;
        if (this.onError) this.onError('kick', k.reason ?? 'kicked');
        return;
      }
      default:
        return;
    }
  }

  private fail(code: string, message: string): void {
    this.allowReconnect = false;
    if (this.onError) this.onError(code, message);
    this.close(1002, message);
  }

  private handleClose(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopPing();
    const canRejoin = !this.closedByUs && this.allowReconnect && code !== 1000 && code !== CLOSE_REPLACED && this.matchId !== null;
    if (!canRejoin) {
      this.reconnectAttempt = 0;
      if (this.onClose) this.onClose(code, reason, false);
      return;
    }
    this.reconnectNext(code, reason);
  }

  /** The next reconnection try after its wait, or the final onClose once RECONNECT_TRIES are spent. */
  private reconnectNext(code: number, reason: string): void {
    if (this.reconnectTries >= RECONNECT_TRIES) {
      this.reconnectAttempt = 0;
      if (this.onClose) this.onClose(code, reason, false);
      return;
    }
    const delay = this.reconnectDelays[Math.min(this.reconnectTries, this.reconnectDelays.length - 1)];
    this.reconnectTries++;
    this.reconnectAttempt = this.reconnectTries;
    this.reconnects++;
    if (this.onClose) this.onClose(code, reason, true);
    this.stopReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUs) return;
      this.rejoin(this.matchId as string).then(
        (m) => {
          if (!this.closedByUs) this.openSocket(m.wsUrl, m.ticket);
        },
        (err: unknown) => {
          if (this.closedByUs) return;
          // No answer, the server's load (429, 5xx): the next try. Anything else (404 / 410: the
          // match is over; a refused session): the end.
          const transient = !(err instanceof NetError) || err.code === 'network' || err.status === 429 || err.status >= 500;
          const why = err instanceof NetError ? err.message : `rejoin failed: ${describe(err)}`;
          if (transient) this.reconnectNext(code, why);
          else {
            this.reconnectAttempt = 0;
            if (this.onClose) this.onClose(code, why, false, err instanceof NetError && (err.status === 404 || err.status === 410));
          }
        },
      );
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * POST /api/rejoin { matchId } with the session -> a fresh ticket for a match that still lists
   * us (reconnection, or a room the matchmaker formed while we were not polling).
   */
  async rejoin(matchId: string): Promise<MatchAssignment> {
    const session = await this.ensureGuest();
    const res = await this.post('/api/rejoin', this.withRegion({ matchId }), session.session);
    // 404 no_match / 410 match_over, match_reset: the room is gone (the Worker frees our lock);
    // 410 p2p_room: a P2P room id (never rejoinable; POST /api/leave frees that lock).
    if (!res.ok) throw await httpError('rejoin', res);
    const q = (await res.json()) as CosmeticQueueResult;
    if (typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string') throw new NetError('protocol', 'rejoin without ticket / wsUrl');
    this.matchId = q.matchId ?? matchId;
    // A node match's answer carries its cars again (NodeRegistryDO keeps them with the match).
    const cars = nodeCarsOf(q);
    this.matchCars = cars ?? null;
    return { matchId: this.matchId, ticket: q.ticket, wsUrl: q.wsUrl, ...(cars ? { cars } : {}) };
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.stopPing();
    if (ws === null) return;
    this.ws = null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
