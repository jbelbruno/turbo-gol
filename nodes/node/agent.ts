/**
 * The node's control connection: one outbound WebSocket to the control plane (like a GitHub
 * Actions runner or a Lichess fishnet client, the node never listens for commands). Handles the
 * challenge / response login with the node's own Ed25519 key, heartbeats, the assign / leave /
 * verify requests, drain and update notices, and the reliable delivery of match reports: a report
 * stays queued until the control plane acknowledges it, across reconnects, and is re-sent while
 * unacknowledged (the control plane skips the ack of a report it failed to process). Replays are
 * uploaded over HTTP before their report is queued; an upload in flight counts in the backlog.
 *
 * Clock: every welcome carries the control plane's time. The node keeps the offset and signs
 * replay requests (and times its matches) with serverNow(), so a PC with a wrong clock still works.
 *
 * Refusals (refusalOf): a link the control plane closes with 4403 (a banned or retired node) or
 * 1008 'address not allowed' (a hello on an address its token does not allow) is refused for good:
 * the agent stops and never logs in again, whatever the launcher does next. 1008 'too many hellos'
 * or 'too many address changes' is a rate limit: the next login waits at least RATE_LIMIT_WAIT_MS
 * (the welcome that comes before the refused hello resets the backoff to 1 s, so without it the node
 * would log in about every second, each login waking the control plane). Any other close
 * reconnects with the usual backoff (1 s doubling to 30 s).
 *
 * Uses Node's built-in WebSocket client and fetch; no dependencies.
 */
import {
  HEARTBEAT_MS,
  authMessage,
  replayRequestMessage,
} from '../shared/controlProtocol';
import type {
  AssignAnswer,
  FromNode,
  HeartbeatData,
  HelloData,
  IceServer,
  LeaveAnswer,
  MatchAssignment,
  MatchReport,
  MatchResult,
  MatchStats,
  NodeStatus,
  ReleaseChannel,
  RtcAnswer,
  ToNode,
  VerifyJob,
  VerifyVerdict,
} from '../shared/controlProtocol';
import { importPrivateKey, sha256Hex, sign } from '../shared/edcrypto';

export interface AgentIdentity {
  nodeId: string;
  /** PKCS#8 base64url (the node's own key). */
  privateKey: string;
  /** ws(s)://.../nodes/connect */
  controlUrl: string;
  /** http(s)://... base of the control plane (replay uploads). */
  httpBase: string;
}

/** The shortest wait before logging in again after a rate-limit refusal (1008 'too many hellos' / 'too many address changes'). */
export const RATE_LIMIT_WAIT_MS = 60 * 60_000;

/**
 * How the agent takes a close of its control link: 'final' (refused for good: 4403, 1008 'address
 * not allowed'), 'wait' (rate-limited: 1008 'too many hellos' / 'too many address changes'), or
 * null (anything else: reconnect with the usual backoff). The close code and its reason are all it
 * needs: the control plane's reasons are fixed strings (server/src/NodeRegistryDO.ts helloRefused,
 * nodes/control-plane/controlPlane.ts auth).
 */
export function refusalOf(code: number, reason: string): 'final' | 'wait' | null {
  if (code === 4403) return 'final';
  if (code !== 1008) return null;
  if (reason === 'address not allowed') return 'final';
  if (reason === 'too many hellos' || reason === 'too many address changes') return 'wait';
  return null;
}

/** A logged-in link that closed, or a refusal at any point (AgentHandlers.closed). */
export interface LinkClosed {
  code: number;
  reason: string;
  refusal: 'final' | 'wait' | null;
  /** ms until the next login; null after a 'final' refusal (the agent stopped). */
  retryInMs: number | null;
}

/** A request the node refuses (sent back as { ok: false, code }). */
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface AgentHandlers {
  hello(): HelloData;
  heartbeat(): HeartbeatData;
  assign(match: MatchAssignment): Promise<AssignAnswer>;
  leave(matchId: string, playerId: string): Promise<LeaveAnswer>;
  verify(job: VerifyJob): Promise<VerifyVerdict>;
  /** A player's WebRTC offer for a match on this node (rtc transport). */
  rtcOffer(offer: { matchId: string; ticket: string; sdp: string; iceServers: IceServer[] }): Promise<RtcAnswer>;
  drain(reason: string): void;
  update(version: string): void;
  welcome(w: { status: NodeStatus; region: string; channel: ReleaseChannel; serverTime: number; iceServers: IceServer[] }): void;
  status(status: NodeStatus, reason?: string): void;
  /**
   * The link closed after a login, or the control plane refused it (also before a login). After a
   * 'final' refusal the agent is stopped: nothing more arrives, and nothing queued is delivered.
   */
  closed(c: LinkClosed): void;
}

export interface AgentOptions {
  heartbeatMs?: number;
  log?: (msg: string) => void;
  /**
   * Replay upload attempts (network errors, 5xx, 429) before the match is reported lost. The
   * default 12, with the default waits, keeps trying for about 75 s: a match that ends while the
   * control plane restarts (a Worker deploy) still gets its replay stored, instead of a 'lost'
   * report, which is a strike for the node and a void for the players.
   */
  uploadAttempts?: number;
  /** First wait between upload attempts (doubles, up to 10 s). */
  uploadRetryMs?: number;
  /** Upload retry waits go through this when given (tests record them); stop() cuts a wait short either way. */
  sleep?: (ms: number) => Promise<void>;
  /** While connected, re-send every this often the reports still unacknowledged... */
  resendMs?: number;
  /** ...that were last sent at least this long ago. */
  resendAfterMs?: number;
  /** A replay upload refused as 'stale' (clock): retries, each after the next welcome. */
  staleRetries?: number;
  /** How long a 'stale' retry waits for that welcome before re-syncing from the answer's Date header. */
  staleWaitMs?: number;
  /** The shortest wait before the next login after a rate-limit refusal (default RATE_LIMIT_WAIT_MS). */
  rateLimitWaitMs?: number;
}

interface PendingReport {
  report: MatchReport;
  /** performance.now() of the last send (-Infinity: never sent). */
  sentAt: number;
}

export class Agent {
  private readonly id: AgentIdentity;
  private readonly h: AgentHandlers;
  private readonly heartbeatMs: number;
  private readonly log: (msg: string) => void;
  private readonly uploadAttempts: number;
  private readonly uploadRetryMs: number;
  private readonly resendMs: number;
  private readonly resendAfterMs: number;
  private readonly staleRetries: number;
  private readonly staleWaitMs: number;
  private readonly rateLimitWaitMs: number;
  private readonly sleepHook: ((ms: number) => Promise<void>) | undefined;
  private key: Promise<CryptoKey>;
  private ws: WebSocket | null = null;
  private authed = false;
  private stopped = false;
  private backoffMs = 1_000;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingReport>();
  /** Replay uploads whose report is not queued yet. */
  private uploading = 0;
  /** Control-plane requests (assign, leave, verify, rtcOffer) being answered. */
  private answering = 0;
  /** Control plane clock - local clock (ms): set at every welcome (or, after a stale refusal with no welcome, from its Date header). */
  private offset = 0;
  private connectedListeners: Array<() => void> = [];
  /** Waiting for the next welcome (true) or for stop() (false). */
  private welcomeListeners: Array<(welcomed: boolean) => void> = [];
  /** Retry sleeps, cut short by stop(). */
  private readonly sleepers = new Set<() => void>();

  constructor(id: AgentIdentity, h: AgentHandlers, opts: AgentOptions = {}) {
    this.id = id;
    this.h = h;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.log = opts.log ?? ((m) => console.log(`[agent] ${m}`));
    this.uploadAttempts = opts.uploadAttempts ?? 12;
    this.uploadRetryMs = opts.uploadRetryMs ?? 500;
    this.resendMs = opts.resendMs ?? 20_000;
    this.resendAfterMs = opts.resendAfterMs ?? 15_000;
    this.staleRetries = opts.staleRetries ?? 2;
    this.staleWaitMs = opts.staleWaitMs ?? 30_000;
    this.rateLimitWaitMs = opts.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS;
    this.sleepHook = opts.sleep;
    this.key = importPrivateKey(id.privateKey);
  }

  get connected(): boolean {
    return this.authed;
  }

  /** Reports not acknowledged yet, plus replay uploads whose report is not queued yet. */
  get backlog(): number {
    return this.pending.size + this.uploading;
  }

  /** Nothing rides on the control connection right now: no request being answered, no report or upload in flight. */
  get idle(): boolean {
    return this.backlog === 0 && this.answering === 0;
  }

  /** The control plane's clock (ms since the epoch), from the offset measured at the last welcome. */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Resolves once logged in (or right away when already). */
  whenConnected(): Promise<void> {
    if (this.authed) return Promise.resolve();
    return new Promise((r) => this.connectedListeners.push(r));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearSessionTimers();
    for (const s of [...this.sleepers]) s();
    const wl = this.welcomeListeners;
    this.welcomeListeners = [];
    for (const l of wl) l(false);
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    if (ws) {
      try {
        ws.close(1000, 'stop');
      } catch {
        /* gone */
      }
    }
  }

  /**
   * Log in again right away, for a fresh welcome (new ICE servers, the clock). The control plane
   * replaces the old session; pending reports are re-sent at the welcome. Callers make sure the
   * connection is idle: an answer still due on the old session would be lost.
   */
  reconnect(): void {
    if (this.stopped) return;
    const ws = this.ws;
    this.ws = null; // its close handler ignores it now
    this.authed = false;
    this.clearSessionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (ws) {
      try {
        ws.close(1000, 'refresh');
      } catch {
        /* gone */
      }
    }
    this.connect();
  }

  /** Re-send hello (the WebRTC self-test finished, the capacity changed...). */
  rehello(): void {
    if (this.authed) this.send({ t: 'hello', data: this.h.hello() });
  }

  /** Send a heartbeat right away (after a big state change). */
  pulse(): void {
    if (this.authed) this.send({ t: 'heartbeat', data: this.h.heartbeat() });
  }

  // ---- reports ------------------------------------------------------------------------------

  submit(report: MatchReport): void {
    const id = `${report.kind}:${report.matchId}`;
    const entry: PendingReport = { report, sentAt: -Infinity };
    this.pending.set(id, entry);
    this.sendReport(id, entry);
  }

  private sendReport(id: string, entry: PendingReport): void {
    if (!this.authed) return;
    this.send({ t: 'report', id, report: entry.report });
    entry.sentAt = performance.now();
  }

  /** Re-send the reports the control plane has not acknowledged for a while. */
  private resend(): void {
    const now = performance.now();
    for (const [id, entry] of this.pending) if (now - entry.sentAt >= this.resendAfterMs) this.sendReport(id, entry);
  }

  /**
   * Upload the replay (with retries), then queue the 'ended' report; a failed upload becomes 'lost'.
   * From the call until the report is queued the upload counts in the backlog: a draining node
   * must not exit while it is still in flight (its report would never be sent).
   */
  async submitEnded(matchId: string, result: MatchResult, replay: Uint8Array, stats: MatchStats): Promise<void> {
    this.uploading++;
    try {
      let sha = '';
      let ok = false;
      try {
        sha = await sha256Hex(replay);
        ok = await this.uploadReplay(matchId, sha, replay);
      } catch (e) {
        this.log(`replay upload ${matchId} failed: ${String(e)}`);
      }
      if (ok) this.submit({ kind: 'ended', matchId, result, replaySha256: sha, replayBytes: replay.length, stats });
      else this.submit({ kind: 'lost', matchId, reason: 'replay_upload_failed' });
    } finally {
      this.uploading--;
    }
  }

  /** PUT the replay; true once stored. Network errors, 5xx and 429 retry with backoff; a 'stale' clock retries after a re-sync. */
  private async uploadReplay(matchId: string, sha: string, replay: Uint8Array): Promise<boolean> {
    let delay = this.uploadRetryMs;
    let failures = 0;
    let stale = 0;
    while (!this.stopped) {
      let status = 0;
      let code: string | null = null;
      let date: string | null = null;
      let receivedAt = 0;
      try {
        const ts = Math.round(this.serverNow());
        const sig = await sign(await this.key, replayRequestMessage('PUT', matchId, sha, ts));
        const res = await fetch(`${this.id.httpBase}/nodes/replays/${matchId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-node-id': this.id.nodeId, 'x-node-ts': String(ts), 'x-node-sig': sig, 'x-replay-sha256': sha },
          body: replay as Uint8Array<ArrayBuffer>,
        });
        receivedAt = Date.now();
        status = res.status;
        date = res.headers.get('date');
        code = await errorCode(res);
      } catch (e) {
        this.log(`replay upload ${matchId} failed: ${String(e)}`);
      }
      if (status >= 200 && status < 300) return true;
      if (status === 401 && code === 'stale' && stale < this.staleRetries) {
        // Our clock (plus the offset) is too far from the control plane's: not this replay's fault.
        stale++;
        this.log(`replay upload ${matchId} refused as stale: re-syncing the clock before retrying`);
        await this.resync(date, receivedAt);
        continue;
      }
      if (status !== 0 && status < 500 && status !== 429) {
        this.log(`replay upload ${matchId} refused: ${status} ${code ?? ''}`);
        return false;
      }
      if (++failures >= this.uploadAttempts) return false;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    return false;
  }

  /**
   * After a 'stale' refusal: wait for the next welcome (it carries the control plane's time). If
   * none comes (still connected, the local clock jumped), take the time from the refusal's Date
   * header (one-second resolution: the middle of that second).
   */
  private async resync(date: string | null, receivedAt: number): Promise<void> {
    if (await this.nextWelcome(this.staleWaitMs)) return;
    if (this.stopped) return;
    const d = date ? Date.parse(date) : NaN;
    if (!Number.isFinite(d) || receivedAt <= 0) return;
    this.offset = d + 500 - receivedAt;
    this.log(`clock re-synced from the control plane's Date header (offset ${Math.round(this.offset / 1000)} s)`);
  }

  /** Resolves true at the next welcome, false after `ms` or at stop(). */
  private nextWelcome(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (welcomed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.welcomeListeners = this.welcomeListeners.filter((l) => l !== finish);
        resolve(welcomed);
      };
      const timer = setTimeout(() => finish(false), ms);
      this.welcomeListeners.push(finish);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      this.sleepers.add(wake);
      if (this.sleepHook) this.sleepHook(ms).then(wake, wake);
      else timer = setTimeout(wake, ms);
    });
  }

  /** Download a replay for a verification job (signed GET). */
  async fetchReplay(job: VerifyJob): Promise<Uint8Array> {
    const ts = Math.round(this.serverNow());
    const sig = await sign(await this.key, replayRequestMessage('GET', job.matchId, job.replaySha256, ts));
    const res = await fetch(job.replayUrl, { headers: { 'x-node-id': this.id.nodeId, 'x-node-ts': String(ts), 'x-node-sig': sig, 'x-replay-sha256': job.replaySha256 } });
    if (!res.ok) throw new AgentError('replay_fetch', `GET replay -> ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== job.replaySha256) throw new AgentError('replay_sha', 'replay hash differs from the job');
    return bytes;
  }

  // ---- connection ---------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.id.controlUrl);
    } catch (e) {
      this.log(`connect failed: ${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.authed = false;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: ToNode;
      try {
        msg = JSON.parse(ev.data) as ToNode;
      } catch {
        return;
      }
      void this.onMessage(ws, msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.authed;
      this.authed = false;
      this.clearSessionTimers();
      const refusal = refusalOf(ev.code, ev.reason);
      if (was || refusal) this.log(`control connection closed (${ev.code} ${ev.reason})`);
      if (refusal === 'final') {
        this.log('refused by the control plane for good: not logging in again');
        void this.stop();
        this.h.closed({ code: ev.code, reason: ev.reason, refusal, retryInMs: null });
        return;
      }
      const wait = this.scheduleReconnect(refusal === 'wait' ? this.rateLimitWaitMs : 0);
      if (refusal === 'wait' && wait !== null) this.log(`rate-limited by the control plane: next login in ${duration(wait)}`);
      if (was || refusal) this.h.closed({ code: ev.code, reason: ev.reason, refusal, retryInMs: wait });
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /** Arm the next login (backoff with jitter, never sooner than minMs); returns its wait, null when none was armed. */
  private scheduleReconnect(minMs = 0): number | null {
    if (this.stopped || this.reconnectTimer) return null;
    // A rate limit is shared by every node the control plane refused at once (a restart): spread them.
    const wait = minMs > 0 ? minMs * (1 + Math.random() * 0.1) : this.backoffMs * (0.75 + Math.random() * 0.5);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    return wait;
  }

  /** Timers that only run while logged in: heartbeats and report re-sends. */
  private clearSessionTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.hbTimer = null;
    this.resendTimer = null;
  }

  private send(m: FromNode): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(m));
    } catch {
      /* the close handler reconnects */
    }
  }

  private async onMessage(ws: WebSocket, m: ToNode): Promise<void> {
    if (this.ws !== ws) return;
    switch (m.t) {
      case 'challenge': {
        const sig = await sign(await this.key, authMessage(this.id.nodeId, m.nonce));
        this.send({ t: 'auth', nodeId: this.id.nodeId, sig });
        return;
      }
      case 'welcome': {
        this.authed = true;
        this.backoffMs = 1_000;
        if (typeof m.serverTime === 'number' && Number.isFinite(m.serverTime) && m.serverTime > 0) this.offset = m.serverTime - Date.now();
        this.h.welcome({ status: m.status, region: m.region, channel: m.channel, serverTime: m.serverTime, iceServers: Array.isArray(m.iceServers) ? m.iceServers : [] });
        // The handler may have stopped us (an idle node below the channel minimum exits for the
        // update right away): arm nothing on a stopped agent.
        if (this.stopped || this.ws !== ws) return;
        this.send({ t: 'hello', data: this.h.hello() });
        this.send({ t: 'heartbeat', data: this.h.heartbeat() });
        for (const [id, entry] of this.pending) this.sendReport(id, entry);
        this.clearSessionTimers();
        this.hbTimer = setInterval(() => this.send({ t: 'heartbeat', data: this.h.heartbeat() }), this.heartbeatMs);
        // The control plane does not ack a report it failed to process: keep re-sending until it does.
        this.resendTimer = setInterval(() => this.resend(), this.resendMs);
        const ls = this.connectedListeners;
        this.connectedListeners = [];
        for (const l of ls) l();
        const wl = this.welcomeListeners;
        this.welcomeListeners = [];
        for (const l of wl) l(true);
        return;
      }
      case 'ack':
        this.pending.delete(m.id);
        return;
      case 'status':
        this.h.status(m.status, m.reason);
        return;
      case 'drain':
        this.h.drain(m.reason);
        return;
      case 'update':
        this.h.update(m.version);
        return;
      case 'error':
        this.log(`control error: ${m.code} ${m.message ?? ''}`);
        return;
      case 'assign':
        return this.answer(m.rid, () => this.h.assign(m.match));
      case 'leave':
        return this.answer(m.rid, () => this.h.leave(m.matchId, m.playerId));
      case 'verify':
        return this.answer(m.rid, () => this.h.verify(m.job));
      case 'rtcOffer':
        return this.answer(m.rid, () => this.h.rtcOffer({ matchId: m.matchId, ticket: m.ticket, sdp: m.sdp, iceServers: Array.isArray(m.iceServers) ? m.iceServers : [] }));
    }
  }

  private async answer(rid: string, fn: () => Promise<unknown>): Promise<void> {
    this.answering++;
    try {
      const data = await fn();
      this.send({ t: 'reply', rid, ok: true, data });
    } catch (e) {
      const code = e instanceof AgentError ? e.code : 'internal';
      this.send({ t: 'reply', rid, ok: false, code, message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.answering--;
    }
  }
}

/** A wait for the log: '42 s', '60 min'. */
function duration(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/** The control plane's error code ({ error }) of a refused request, null otherwise; consumes the body. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    if (res.ok) {
      await res.body?.cancel();
      return null;
    }
    const j = JSON.parse(await res.text()) as { error?: unknown } | null;
    return j && typeof j.error === 'string' ? j.error : null;
  } catch {
    return null;
  }
}
