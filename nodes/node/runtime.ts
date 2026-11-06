/**
 * NodeRuntime: everything a running node is. The player-facing HTTP server (GET /healthz, the
 * match WebSockets at /m/<matchId>), the WebRTC acceptor, the match rooms, the node-wide ticker,
 * the control-plane agent and, with the 'verify' role, the replay verifier.
 *
 *   wss node   players --wss--> [Caddy :443, TLS] --> http://127.0.0.1:7350 /m/<matchId>
 *   rtc node   players --DataChannel (ICE: host / srflx / TURN)--> this process
 *              (the offer / answer travels over the control connection)
 *   always     node --wss--> control plane /nodes/connect   (outbound only)
 *
 * The node trusts nothing it is told by players beyond what MatchDO trusts, and holds no secret of
 * the project: tickets are checked with the control plane's PUBLIC key (aud = this node), and the
 * node's own private key only proves who the node is.
 *
 * <data>/status.json (StatusFile, mode 0600): what the control plane last told this node over its
 * own logged-in link (the welcome's status, a status message, a refusal), rewritten whole at each
 * change and when the node stops. A new run keeps what an earlier run of the same node was told
 * (its status and a refusal for good, marked as an earlier run's) until it hears from the control
 * plane itself: a node restarted while the control plane is unreachable, or refused at its login,
 * still says what it last knew. `turbogol-node status` prints it: the public list holds only
 * nodes in service, without ids, so a pending, suspended or banned node cannot find itself there.
 *
 * Refused for good (4403, 1008 'address not allowed'; agent.ts refusalOf): the node drains and
 * exits 0 once its running matches are over, which the installed launcher takes as a stop (it is
 * never updated, so this cannot rely on anything newer). Nothing queued for the link is waited for:
 * it can never be delivered.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../../src/net/protocol';
import { EXIT_UPDATE, compareVersions, reachMessage } from '../shared/controlProtocol';
import type {
  AssignAnswer,
  BuildId,
  HeartbeatData,
  HelloData,
  IceServer,
  LeaveAnswer,
  MatchAssignment,
  NodeCapacity,
  NodeRole,
  NodeSpecs,
  NodeStatus,
  NodeTransport,
  RtcAnswer,
  VerifyJob,
  VerifyVerdict,
} from '../shared/controlProtocol';
import { importPrivateKey, importPublicKey, randomHexId, sign } from '../shared/edcrypto';
import { verifyNodeTicket } from '../shared/nodeTickets';
import { nodeSimFactory } from '../shared/nodeArena';
import { verifyReplay } from '../shared/verify';
import { Agent, AgentError } from './agent';
import type { AgentOptions, LinkClosed } from './agent';
import { errorJson, json, startHttp } from './http';
import type { IncomingMessage, RunningServer, ServerResponse } from './http';
import { MAX_FRAME_BYTES, MatchRoom } from './matchRoom';
import type { RoomTimings } from './matchRoom';
import { answerOffer, rtcSelfTest } from './rtcTransport';
import type { RtcConfig, SelfTest } from './rtcTransport';
import { Ticker } from './ticker';
import { acceptUpgrade, clientIp, offeredProtocols, rejectUpgrade } from './wsServer';

/** What `turbogol-node register` writes to <data>/node.json. */
export interface NodeIdentityFile {
  nodeId: string;
  operatorId: string;
  name: string;
  region: string;
  privateKey: string;
  publicKey: string;
  controlPublicKey: string;
  /** ws(s)://.../nodes/connect */
  controlUrl: string;
  /** http(s)://... */
  httpBase: string;
  roles: NodeRole[];
  /** How players reach this node (older node.json files: ['wss']). */
  transports?: NodeTransport[];
  /** ws(s)://host[:port] players use; null without the 'wss' transport. */
  publicUrl: string | null;
}

/** In <data>: what the running node knows of itself (StatusFile). */
export const STATUS_FILE = 'status.json';

/** <data>/status.json. Times are ISO 8601 on this machine's clock. */
export interface StatusFile {
  nodeId: string;
  name: string;
  region: string;
  version: string;
  /** The process that wrote it. running goes false when it stops; a crash leaves it true (`status` checks the pid). */
  pid: number;
  running: boolean;
  /** Logged in to the control plane when written. */
  connected: boolean;
  draining: boolean;
  /** What the control plane last said this node is (welcome or status message); null until a run of this node hears it. */
  status: NodeStatus | null;
  reason?: string;
  statusAt?: string;
  /** status, reason and statusAt were told to an earlier run of this node: this one has not heard from the control plane yet. */
  statusFromEarlierRun?: true;
  /**
   * The last close of the control link, until the next welcome. refusal 'final' (retryAt null):
   * refused for good; fromEarlierRun: an earlier run's (a new run tries to log in again).
   */
  closed?: { code: number; reason: string; refusal: 'final' | 'wait' | null; at: string; retryAt: string | null; fromEarlierRun?: true };
  updatedAt: string;
}

/** Every NodeStatus, to check one read back from status.json. */
const NODE_STATUSES: Record<NodeStatus, true> = { pending: true, probation: true, active: true, suspended: true, banned: true };

export interface RuntimeOptions {
  identity: NodeIdentityFile;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
  listenPort: number;
  listenHost: string;
  /** Where egress counters and status.json live (optional). */
  dataDir?: string;
  egressCapGB?: number | null;
  timings?: Partial<RoomTimings>;
  heartbeatMs?: number;
  /** WebRTC host candidates: port range, extra addresses (tests use 127.0.0.1). */
  rtc?: Omit<RtcConfig, 'iceServers'>;
  log?: (msg: string) => void;
  /** Drained for an update (or asked to stop): the process should exit with this code. */
  onExit?: (code: number) => void;
  /** The WebRTC self-test (default rtcSelfTest; tests inject a fake). */
  selfTest?: (cfg: RtcConfig) => Promise<SelfTest>;
  /**
   * WebRTC self-test schedule (ms): retries while not passing through TURN, doubling from retryMs
   * up to maxRetryMs; re-runs every refreshMs while passing. A scheduled run needs ICE servers
   * younger than iceFreshMs; older ones are renewed by logging in again once the control
   * connection is idle (checked every quietPollMs).
   */
  rtcSchedule?: { retryMs?: number; maxRetryMs?: number; refreshMs?: number; iceFreshMs?: number; quietPollMs?: number };
  /** Agent retry timings (tests). */
  agent?: Omit<AgentOptions, 'heartbeatMs' | 'log'>;
}

const MATCH_PATH = /^\/m\/([0-9A-Za-z_-]{8,64})$/;
const MATCH_ID = /^[0-9A-Za-z_-]{8,64}$/;
/** WebRTC self-test: first retry after a failure (doubles), its cap, and the refresh while passing (TURN credentials expire). */
const RTC_RETRY_MS = 30_000;
const RTC_MAX_RETRY_MS = 10 * 60_000;
const RTC_REFRESH_MS = 30 * 60_000;
/**
 * ICE servers older than this are not used for a scheduled self-test: the control plane's TURN
 * credentials are short-lived (10 min in production) and come only with a welcome or a player's
 * offer, so a test with older ones could fail a healthy node.
 */
const ICE_FRESH_MS = 5 * 60_000;
/** Renewing the ICE servers waits for an idle control connection; it looks again this often. */
const RTC_QUIET_POLL_MS = 30_000;
/** A draining node with an upload or a report still in flight looks again this often. */
const EXIT_POLL_MS = 500;

const setImmediateFn = (globalThis as unknown as { setImmediate: (cb: () => void) => unknown }).setImmediate;
/** Verification slices waiting for their turn. */
const sliceQueue: Array<() => void> = [];
function releaseSlice(): void {
  const next = sliceQueue.shift();
  // Queued from inside an immediate: runs at the NEXT loop turn, after the timers (the ticker).
  if (sliceQueue.length > 0) setImmediateFn(releaseSlice);
  next?.();
}
/**
 * Let the matches tick between verification slices (verifyReplay awaits it every few hundred
 * ticks). One slice per event-loop turn in total: two verifications at once take turns instead of
 * running their slices back to back before the ticker gets a chance.
 */
const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    sliceQueue.push(resolve);
    if (sliceQueue.length === 1) setImmediateFn(releaseSlice);
  });

/** The list offers a TURN server (a self-test through it can prove players behind any NAT reach this node). */
function hasTurn(servers: readonly IceServer[]): boolean {
  return servers.some((s) => !!s && (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => typeof u === 'string' && /^turns?:/.test(u)));
}

/** Light shape check of a verification job (the control plane is trusted, but a malformed job must not crash or mislead). */
function validJob(j: unknown): j is VerifyJob {
  if (!j || typeof j !== 'object') return false;
  const v = j as Record<string, unknown>;
  return (
    typeof v.matchId === 'string' &&
    MATCH_ID.test(v.matchId) &&
    typeof v.hostNodeId === 'string' &&
    v.hostNodeId.length > 0 &&
    v.hostNodeId.length <= 64 &&
    typeof v.replayUrl === 'string' &&
    /^https?:\/\//.test(v.replayUrl) &&
    typeof v.replaySha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.replaySha256) &&
    !!v.expect &&
    typeof v.expect === 'object' &&
    Array.isArray(v.leaves) &&
    v.leaves.length <= 64 &&
    v.leaves.every((p) => typeof p === 'string' && p.length <= 64)
  );
}

export function transportsOf(id: NodeIdentityFile): NodeTransport[] {
  if (!id.roles.includes('host')) return []; // a verifier only dials out
  if (id.transports && id.transports.length > 0) return id.transports;
  return id.publicUrl ? ['wss'] : ['rtc'];
}

/**
 * What the operator reads in the log when the control plane refuses this node for good: why, and
 * what to do next. The node then exits 0, and the launcher exits 0 after it, which its service
 * does not restart (systemd Restart=on-failure, launchd SuccessfulExit false: only a failure), so a
 * fix by hand ends with starting the node again.
 * Only install.sh makes wss nodes, the only ones a 1008 'address not allowed' reaches; a 4403 can
 * come to a node of any installer, so it gets no command. A new registration needs no start: the
 * installer starts the node.
 */
export function refusedAdvice(c: { code: number; reason: string }, id: NodeIdentityFile): string {
  const servers = `'Mis servidores' (${id.httpBase}/#servers)`;
  if (c.code === 1008) {
    return (
      `the control plane does not accept this node's public address (${id.publicUrl ?? 'none'}): it is an IP address, or not the host name ` +
      `its registration token allows. Put back in node.json the address it was registered with, then start the node again (installed ` +
      `with install.sh: sudo systemctl start turbogol-node); or register this machine again with a new token and a DNS name (move ` +
      `node.json away first). Your nodes: ${servers}`
    );
  }
  if (c.reason === 'retired') {
    return `this node was retired (${c.code}): it gets no more matches. To serve again, register this machine with a new token (move node.json away first): ${servers}`;
  }
  return `the control plane refused this node (${c.code} ${c.reason}): it will not log in again. Its state and what you can do: ${servers}. If it is let back in, start the node again (it does not restart on its own)`;
}

/** Tries, and the wait between them, of the rename that puts a new status.json in place (2 s in all). */
const STATUS_RENAME_TRIES = 40;
const STATUS_RENAME_RETRY_MS = 50;

/**
 * Write <dir>/status.json whole: a temporary file, mode 0600 like node.json, renamed over the old
 * one (a reader never sees half of it). On Windows that rename fails (EPERM, EACCES, EBUSY) while
 * another process has status.json open (`turbogol-node status`, an antivirus scan): it is tried
 * again, as the next write, the next change of state, may be hours away.
 */
async function writeStatusFile(dir: string, body: string): Promise<void> {
  const file = join(dir, STATUS_FILE);
  const tmp = file + '.tmp';
  await writeFile(tmp, body);
  await chmod(tmp, 0o600).catch(() => undefined);
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(tmp, file);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (attempt >= STATUS_RENAME_TRIES || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, STATUS_RENAME_RETRY_MS));
    }
  }
}

/** The pid of this process (types/node-shim.d.ts declares only what the rest of the package uses). */
const ownPid = (): number => (process as unknown as { pid: number }).pid;

export class NodeRuntime {
  readonly opts: RuntimeOptions;
  readonly rooms = new Map<string, MatchRoom>();
  readonly ticker = new Ticker();
  readonly agent: Agent;
  readonly transports: NodeTransport[];
  status: NodeStatus = 'pending';
  draining = false;
  /** An update the control plane asked for (exit EXIT_UPDATE once drained, unless a stop was requested). */
  updateTo: string | null = null;
  /** The operator asked to stop (SIGTERM, the launcher): exit 0 once drained, whatever update comes. */
  stopRequested = false;
  /** The control plane refused this node for good (the agent stopped): exit 0 once the running matches are over. */
  refused = false;
  /** Random per process start, the same on every re-hello: a new one tells the control plane this node restarted. */
  readonly bootId = randomHexId(16);
  server: RunningServer | null = null;
  /** ICE servers from the latest welcome or player's offer (STUN, short-lived TURN credentials). */
  iceServers: IceServer[] = [];
  /** performance.now() when iceServers arrived. */
  iceAt = 0;
  rtcReady = false;
  /** The passing self-test went through a TURN relay. */
  rtcRelay = false;
  lastSelfTest: SelfTest | null = null;

  private readonly controlKey: Promise<CryptoKey>;
  private readonly nodeKey: Promise<CryptoKey>;
  private readonly log: (msg: string) => void;
  private egressMonth = '';
  private egressBytes = 0;
  private cpuPrev = process.cpuUsage();
  private cpuPrevAt = performance.now();
  private verifying = 0;
  private exited = false;
  private stopped = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private selfTesting = false;
  /** A welcome (new ICE servers) arrived during a self-test: run again right after it. */
  private selfTestAgain = false;
  private rtcTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcFailures = 0;
  /** What the control plane last said this node is, for status.json (null: nothing yet; earlier: told to an earlier run, loadStatus). */
  private told: { status: NodeStatus; reason?: string; at: number; earlier?: true } | null = null;
  /** The welcome's region (node.json's until the first one). */
  private region: string;
  private lastClose: (LinkClosed & { at: number; earlier?: true }) | null = null;
  /** Rewrites of status.json, one after the other. */
  private statusWrites: Promise<void> = Promise.resolve();

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
    this.transports = transportsOf(opts.identity);
    this.log = opts.log ?? ((m) => console.log(`[node] ${m}`));
    this.region = opts.identity.region;
    this.controlKey = importPublicKey(opts.identity.controlPublicKey);
    this.nodeKey = importPrivateKey(opts.identity.privateKey);
    const id = opts.identity;
    this.agent = new Agent(
      { nodeId: id.nodeId, privateKey: id.privateKey, controlUrl: id.controlUrl, httpBase: id.httpBase },
      {
        hello: () => this.hello(),
        heartbeat: () => this.heartbeat(),
        assign: (m) => this.assign(m),
        leave: (matchId, playerId) => this.leave(matchId, playerId),
        verify: (job) => this.verify(job),
        rtcOffer: (o) => this.rtcOffer(o.matchId, o.ticket, o.sdp, o.iceServers),
        drain: (reason) => this.drain(reason),
        update: (version) => this.update(version),
        status: (s, reason) => {
          this.status = s;
          this.told = { status: s, ...(reason ? { reason } : {}), at: Date.now() };
          this.log(`status ${s}${reason ? ` (${reason})` : ''}`);
          this.writeStatus();
        },
        welcome: (w) => {
          this.status = w.status;
          this.told = { status: w.status, at: Date.now() };
          this.lastClose = null;
          this.region = w.region;
          this.iceServers = w.iceServers;
          this.iceAt = performance.now();
          this.log(`connected to the control plane: ${w.status}, region ${w.region}, stable ${w.channel.stable}`);
          this.writeStatus();
          if (compareVersions(this.opts.build.version, w.channel.minimum) < 0) this.update(w.channel.stable);
          // Fresh TURN credentials: test with them now (or right after the test in progress).
          if (this.transports.includes('rtc')) void this.selfTest();
        },
        closed: (c) => this.linkClosed(c),
      },
      { ...(opts.agent ?? {}), heartbeatMs: opts.heartbeatMs, log: (m) => this.log(m) },
    );
  }

  async start(): Promise<void> {
    await this.loadEgress();
    await this.loadStatus();
    if (this.transports.includes('wss')) {
      this.server = await startHttp(this.opts.listenPort, this.opts.listenHost, {
        onRequest: (req, res) => this.onRequest(req, res),
        onUpgrade: (req, socket, head) => this.onUpgrade(req, socket, head),
      });
      this.log(`listening on ${this.opts.listenHost}:${this.server.port}`);
    } else {
      this.log('WebRTC node: no listening port (players connect through ICE)');
    }
    this.writeStatus();
    this.agent.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.rtcTimer = null;
    this.exitTimer = null;
    for (const r of [...this.rooms.values()]) r.dispose('node_shutdown');
    await this.agent.stop();
    if (this.server) await this.server.close();
    this.server = null;
    // The last word in status.json: not running (main.ts exits right after this).
    this.writeStatus(false);
    await this.statusWrites;
  }

  // ---- status.json --------------------------------------------------------------------------

  /** What status.json says right now. */
  statusFile(running = !this.stopped): StatusFile {
    const id = this.opts.identity;
    const iso = (t: number): string => new Date(t).toISOString();
    const c = this.lastClose;
    return {
      nodeId: id.nodeId,
      name: id.name,
      region: this.region,
      version: this.opts.build.version,
      pid: ownPid(),
      running,
      connected: this.agent.connected,
      draining: this.draining,
      status: this.told?.status ?? null,
      ...(this.told?.reason ? { reason: this.told.reason } : {}),
      ...(this.told ? { statusAt: iso(this.told.at) } : {}),
      ...(this.told?.earlier ? { statusFromEarlierRun: true as const } : {}),
      ...(c ? { closed: { code: c.code, reason: c.reason, refusal: c.refusal, at: iso(c.at), retryAt: c.retryInMs === null ? null : iso(c.at + c.retryInMs), ...(c.earlier ? { fromEarlierRun: true as const } : {}) } } : {}),
      updatedAt: iso(Date.now()),
    };
  }

  /**
   * At start: what an earlier run of this node last heard, from its status.json (the same node id):
   * its status until this run's first welcome or status message, a refusal for good until its first
   * close or welcome. Nothing else: a wait or a reconnect belonged to that run's link.
   */
  private async loadStatus(): Promise<void> {
    if (!this.opts.dataDir) return;
    let s: Partial<StatusFile>;
    try {
      s = JSON.parse(await readFile(join(this.opts.dataDir, STATUS_FILE), 'utf8')) as Partial<StatusFile>;
    } catch {
      return; // first run, or unreadable: start from nothing
    }
    if (!s || typeof s !== 'object' || s.nodeId !== this.opts.identity.nodeId) return;
    const time = (v: unknown): number | null => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    const statusAt = time(s.statusAt);
    if (typeof s.status === 'string' && NODE_STATUSES[s.status] === true && statusAt !== null) {
      this.told = { status: s.status, ...(typeof s.reason === 'string' && s.reason ? { reason: s.reason } : {}), at: statusAt, earlier: true };
    }
    const c = s.closed;
    const closedAt = time(c?.at);
    if (c && c.refusal === 'final' && typeof c.code === 'number' && typeof c.reason === 'string' && closedAt !== null) {
      this.lastClose = { code: c.code, reason: c.reason, refusal: 'final', retryInMs: null, at: closedAt, earlier: true };
    }
  }

  /** Queue a rewrite of <data>/status.json with the state as it is now (no data dir: nothing). */
  private writeStatus(running = !this.stopped): void {
    const dir = this.opts.dataDir;
    if (!dir) return;
    const body = JSON.stringify(this.statusFile(running), null, 2) + '\n';
    this.statusWrites = this.statusWrites.then(() => writeStatusFile(dir, body)).catch((e) => this.log(`cannot write ${STATUS_FILE}: ${String(e)}`));
  }

  /**
   * The control link closed (the agent's handler). Refused for good, no new match can come and
   * nothing queued can be delivered: drain, and exit 0 once the running matches are over.
   */
  private linkClosed(c: LinkClosed): void {
    this.lastClose = { ...c, at: Date.now() };
    if (c.refusal !== 'final') {
      this.writeStatus();
      return;
    }
    this.refused = true;
    this.log(`${refusedAdvice(c, this.opts.identity)}. The node stops once its matches are over (${this.rooms.size} running).`);
    this.drain('refused by the control plane');
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Run the WebRTC reachability self-test with the latest ICE servers. Called at every welcome
   * (fresh TURN credentials) and by its own schedule: until a test passes through TURN (what the
   * control plane requires when it hands out TURN), retries with backoff (30 s, 60 s, 120 s... up
   * to 10 min); once it does, again every 30 min. A call during a test (a new welcome) runs once
   * more right after it; it then returns null.
   */
  async selfTest(): Promise<SelfTest | null> {
    if (this.selfTesting) {
      this.selfTestAgain = true;
      return null;
    }
    if (this.stopped) return null;
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    this.rtcTimer = null;
    this.selfTesting = true;
    let r: SelfTest;
    try {
      const run = this.opts.selfTest ?? rtcSelfTest;
      r = await run({ iceServers: this.iceServers, ...(this.opts.rtc ?? {}) });
    } catch (e) {
      r = { ok: false, relay: false, ms: 0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.selfTesting = false;
    }
    if (this.stopped) return r;
    this.lastSelfTest = r;
    const was = { ready: this.rtcReady, relay: this.rtcRelay };
    this.rtcReady = r.ok;
    this.rtcRelay = r.ok && r.relay;
    this.log(r.ok ? `WebRTC self-test ok in ${r.ms} ms${r.relay ? ' (through TURN)' : ' (no TURN relay)'}` : `WebRTC self-test FAILED: ${r.error ?? 'no channel'}`);
    if (was.ready !== this.rtcReady || was.relay !== this.rtcRelay) this.agent.rehello();
    if (this.selfTestAgain) {
      // A welcome came during the test: its ICE servers have not been tried yet.
      this.selfTestAgain = false;
      void this.selfTest();
      return r;
    }
    this.scheduleSelfTest(this.rtcRelay);
    return r;
  }

  private scheduleSelfTest(passed: boolean): void {
    const s = this.opts.rtcSchedule ?? {};
    let wait: number;
    if (passed) {
      this.rtcFailures = 0;
      wait = s.refreshMs ?? RTC_REFRESH_MS;
    } else {
      const first = s.retryMs ?? RTC_RETRY_MS;
      wait = Math.min(first * 2 ** Math.min(this.rtcFailures, 20), s.maxRetryMs ?? RTC_MAX_RETRY_MS);
      this.rtcFailures++;
    }
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    this.rtcTimer = setTimeout(() => this.scheduledSelfTest(), wait);
  }

  /**
   * A retry or a refresh. It runs only with ICE servers fresh enough to judge the node by: TURN
   * credentials expire, and a test with expired ones would fail a healthy node (rtcReady false:
   * no more rtc matches). Older ones, or a list without TURN (the control plane could not mint
   * credentials), are renewed by logging in again, which the control plane answers with a welcome
   * carrying new ones (its handler runs the test); but only while nothing depends on the control
   * connection (no match, verification, request or report in flight), else it looks again later.
   */
  private scheduledSelfTest(): void {
    this.rtcTimer = null;
    // Draining: no new matches, nothing to prove. Offline: the next welcome runs it.
    if (this.stopped || this.draining || this.selfTesting || !this.agent.connected) return;
    const s = this.opts.rtcSchedule ?? {};
    const fresh = performance.now() - this.iceAt < (s.iceFreshMs ?? ICE_FRESH_MS) && hasTurn(this.iceServers);
    if (fresh) {
      void this.selfTest();
      return;
    }
    if (this.rooms.size === 0 && this.verifying === 0 && this.agent.idle) {
      this.log('logging in again for fresh ICE servers (WebRTC self-test)');
      this.agent.reconnect();
      return;
    }
    this.rtcTimer = setTimeout(() => this.scheduledSelfTest(), s.quietPollMs ?? RTC_QUIET_POLL_MS);
  }

  // ---- HTTP (wss transport) ------------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://node');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const body: Record<string, unknown> = {
        ok: true,
        nodeId: this.opts.identity.nodeId,
        version: this.opts.build.version,
        active: this.rooms.size,
        capacity: this.opts.capacity.matches,
        draining: this.draining,
      };
      const nonce = url.searchParams.get('nonce');
      if (nonce && /^[A-Za-z0-9_-]{16,64}$/.test(nonce)) body.sig = await sign(await this.nodeKey, reachMessage(this.opts.identity.nodeId, nonce));
      return json(res, 200, body);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Turbogol community node ${this.opts.identity.name} (${this.opts.build.version})\n`);
      return;
    }
    errorJson(res, 404, 'not_found');
  }

  private async onUpgrade(req: IncomingMessage, socket: Socket, head: Uint8Array): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://node');
    const m = MATCH_PATH.exec(url.pathname);
    if (!m) return rejectUpgrade(socket, 404, 'not_found');
    const matchId = m[1];
    const room = this.rooms.get(matchId);
    if (!room) return rejectUpgrade(socket, 404, 'no_match');
    const offered = offeredProtocols(req);
    if (!offered.includes(WS_SUBPROTOCOL)) return rejectUpgrade(socket, 400, 'bad_protocol');
    const t = offered.find((p) => p.startsWith(WS_TICKET_PREFIX));
    if (!t) return rejectUpgrade(socket, 401, 'no_ticket');
    // Tickets expire on the control plane's clock (90 s), not this machine's.
    const claims = await verifyNodeTicket(await this.controlKey, t.slice(WS_TICKET_PREFIX.length), matchId, this.opts.identity.nodeId, this.agent.serverNow());
    if (!claims) return rejectUpgrade(socket, 403, 'bad_ticket');
    if (socket.destroyed) return;
    // From here to attach() everything is synchronous: no other upgrade can interleave.
    const pre = room.precheck(claims);
    if (!pre.ok) return rejectUpgrade(socket, pre.status, pre.code, pre.message);
    const ws = acceptUpgrade(req, socket, head, { protocol: WS_SUBPROTOCOL, maxMessageBytes: MAX_FRAME_BYTES, remoteAddress: clientIp(req) });
    if (!ws) return;
    room.attach(ws, claims);
  }

  // ---- WebRTC (rtc transport) ----------------------------------------------------------------

  /** A player's offer, relayed by the control plane: the same checks as a WebSocket upgrade. */
  private async rtcOffer(matchId: string, ticket: string, sdp: string, iceServers: IceServer[]): Promise<RtcAnswer> {
    if (!this.transports.includes('rtc')) throw new AgentError('no_rtc');
    if (iceServers.length > 0) {
      // Minted for this node just now: the next scheduled self-test can use them.
      this.iceServers = iceServers;
      this.iceAt = performance.now();
    }
    const room = this.rooms.get(matchId);
    if (!room) throw new AgentError('no_match');
    // Tickets expire on the control plane's clock (90 s), not this machine's.
    const claims = await verifyNodeTicket(await this.controlKey, ticket, matchId, this.opts.identity.nodeId, this.agent.serverNow());
    if (!claims) throw new AgentError('bad_ticket');
    const pre = room.reserve(claims);
    if (!pre.ok) throw new AgentError(pre.code, pre.message);
    const cfg: RtcConfig = { iceServers: iceServers.length > 0 ? iceServers : this.iceServers, ...(this.opts.rtc ?? {}) };
    try {
      const answer = await answerOffer(
        sdp,
        cfg,
        WS_SUBPROTOCOL,
        (conn) => {
          // The seat may have changed while ICE ran (left, match over, a newer socket).
          const again = room.precheck(claims, { reserved: true });
          if (!again.ok) {
            room.unreserve(claims.jti);
            conn.close(1008, again.code);
            return;
          }
          room.attach(conn, claims);
        },
        () => room.unreserve(claims.jti),
      );
      return { sdp: answer };
    } catch (e) {
      room.unreserve(claims.jti);
      throw new AgentError('bad_offer', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- agent handlers ---------------------------------------------------------------------

  private hello(): HelloData {
    return {
      bootId: this.bootId,
      build: this.opts.build,
      roles: this.opts.identity.roles,
      transports: this.transports,
      publicUrl: this.opts.identity.publicUrl,
      rtcReady: this.rtcReady,
      rtcRelay: this.rtcRelay,
      specs: this.opts.specs,
      capacity: this.opts.capacity,
      draining: this.draining,
      egressCapGB: this.opts.egressCapGB ?? null,
    };
  }

  heartbeat(): HeartbeatData {
    const now = performance.now();
    const cpu = process.cpuUsage(this.cpuPrev);
    const wall = Math.max(1, now - this.cpuPrevAt);
    this.cpuPrev = process.cpuUsage();
    this.cpuPrevAt = now;
    const lag = this.ticker.lag.quantile(0.99);
    this.ticker.lag.reset();
    return {
      active: this.rooms.size,
      capacity: this.opts.capacity.matches,
      draining: this.draining,
      egressGB: this.egressGB(),
      egressCapGB: this.opts.egressCapGB ?? null,
      tickLagP99Ms: lag,
      cpuLoad: (cpu.user + cpu.system) / 1000 / wall,
      rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      matches: [...this.rooms.values()].map((r) => r.status()),
    };
  }

  private async assign(match: MatchAssignment): Promise<AssignAnswer> {
    const publicUrl = this.opts.identity.publicUrl;
    if (!this.opts.identity.roles.includes('host')) throw new AgentError('not_a_host');
    const wsUrl = this.transports.includes('wss') && publicUrl ? `${publicUrl}/m/${match.matchId}` : null;
    if (wsUrl === null && !this.transports.includes('rtc')) throw new AgentError('no_transport');
    if (this.rooms.has(match.matchId)) return { wsUrl }; // a retried assign
    if (this.draining) throw new AgentError('draining');
    if (this.status === 'suspended' || this.status === 'banned' || this.status === 'pending') throw new AgentError('not_eligible', this.status);
    if (this.rooms.size >= this.opts.capacity.matches) throw new AgentError('full');
    const cap = this.opts.egressCapGB;
    if (cap !== null && cap !== undefined && this.egressGB() >= cap) throw new AgentError('egress_cap');
    if (!/^[0-9A-Za-z_-]{8,64}$/.test(match.matchId) || !Array.isArray(match.roster) || match.roster.length < 1 || match.roster.length > 8) {
      throw new AgentError('bad_assignment');
    }
    const room = await MatchRoom.create(match, {
      nodeId: this.opts.identity.nodeId,
      label: 'node:' + this.opts.identity.name,
      build: this.opts.build,
      ticker: this.ticker,
      timings: this.opts.timings,
      // The control plane's clock (createdAt and the TTL are on it), not this machine's.
      serverNow: () => this.agent.serverNow(),
      hooks: {
        onEnded: (r, result, replay, stats) => {
          this.addEgress(stats.egressBytes);
          void this.agent.submitEnded(r.matchId, result, replay, stats);
        },
        onCancelled: (r, reason, noShows) => this.agent.submit({ kind: 'cancelled', matchId: r.matchId, reason, noShows }),
        onLost: (r, reason) => this.agent.submit({ kind: 'lost', matchId: r.matchId, reason }),
        onClosed: (r) => {
          this.rooms.delete(r.matchId);
          this.agent.pulse();
          this.maybeExit();
        },
      },
    });
    this.rooms.set(match.matchId, room);
    this.agent.pulse();
    return { wsUrl };
  }

  private async leave(matchId: string, playerId: string): Promise<LeaveAnswer> {
    const room = this.rooms.get(matchId);
    if (!room) throw new AgentError('no_match');
    const a = room.leave(playerId);
    if ('error' in a) throw new AgentError(a.code);
    return a;
  }

  private async verify(job: VerifyJob): Promise<VerifyVerdict> {
    if (!this.opts.identity.roles.includes('verify')) throw new AgentError('not_a_verifier');
    if (!validJob(job)) throw new AgentError('bad_job');
    if (this.verifying >= 2) throw new AgentError('busy');
    // Draining: no new jobs (the control plane retries them elsewhere or after the restart).
    if (this.draining) throw new AgentError('draining');
    this.verifying++;
    try {
      const bytes = await this.agent.fetchReplay(job);
      // Its set-up (up to the first slice) takes a loop turn of its own too.
      await yieldToLoop();
      return await verifyReplay(bytes, {
        makeSim: nodeSimFactory,
        wasmSha256: this.opts.build.wasmSha256,
        protocol: this.opts.build.protocol,
        // The match's JavaScript (rules, bots, arena mesh) ships in the node release: same release only.
        version: this.opts.build.version,
        expect: job.expect,
        expectNodeId: job.hostNodeId,
        // Only the leaves the control plane relayed may appear as takeovers.
        leaves: job.leaves,
        // A host + verify node keeps ticking its matches while it re-simulates.
        yieldFn: yieldToLoop,
      });
    } finally {
      this.verifying--;
      this.maybeExit(); // a draining verifier exits once its last verification is answered
    }
  }

  private drain(reason: string): void {
    if (!this.draining) this.log(`draining: ${reason}`);
    this.draining = true;
    this.agent.pulse();
    this.writeStatus();
    this.maybeExit();
  }

  private update(version: string): void {
    if (this.updateTo === version) return;
    this.updateTo = version;
    if (this.stopRequested) {
      this.log(`update to ${version} available, but a stop was requested: the node stops (no restart)`);
      return;
    }
    this.log(`update to ${version} requested: draining (${this.rooms.size} matches running)`);
    this.drain('update');
  }

  /** Graceful stop (SIGTERM, the launcher): drain, exit 0 when the last match is over and reported. An update never overrides it. */
  requestStop(): void {
    if (!this.stopRequested) this.log(`stop requested: draining (${this.rooms.size} matches running)`);
    this.stopRequested = true;
    this.drain('stop');
  }

  private maybeExit(): void {
    if (this.exited || this.stopped || (!this.stopRequested && this.updateTo === null && !this.refused)) return;
    if (this.rooms.size > 0) return; // the last room's onClosed calls again
    // Refused for good, a report, an upload or a verdict has no link to go out on, ever.
    if (!this.refused && (this.agent.backlog > 0 || this.verifying > 0)) {
      // A replay upload in flight, a report not acknowledged yet or a verification still running:
      // exiting now would lose it.
      if (!this.exitTimer) {
        this.exitTimer = setTimeout(() => {
          this.exitTimer = null;
          this.maybeExit();
        }, EXIT_POLL_MS);
      }
      return;
    }
    this.exited = true;
    // 0 is a stop for the launcher (no restart, whatever version it runs), 75 an update.
    const code = this.stopRequested || this.refused ? 0 : EXIT_UPDATE;
    this.log(code !== 0 ? `drained: exiting for the update to ${this.updateTo}` : this.refused ? 'drained: stopping (refused by the control plane)' : 'drained: stopping');
    this.opts.onExit?.(code);
  }

  // ---- egress -----------------------------------------------------------------------------

  private monthKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private egressGB(): number {
    if (this.egressMonth !== this.monthKey()) {
      this.egressMonth = this.monthKey();
      this.egressBytes = 0;
    }
    return this.egressBytes / 1e9;
  }

  private addEgress(bytes: number): void {
    this.egressGB();
    this.egressBytes += bytes;
    if (this.opts.dataDir) {
      void writeFile(join(this.opts.dataDir, 'egress.json'), JSON.stringify({ month: this.egressMonth, bytes: this.egressBytes })).catch(() => undefined);
    }
  }

  private async loadEgress(): Promise<void> {
    this.egressMonth = this.monthKey();
    if (!this.opts.dataDir) return;
    await mkdir(this.opts.dataDir, { recursive: true });
    try {
      const e = JSON.parse(await readFile(join(this.opts.dataDir, 'egress.json'), 'utf8')) as { month?: string; bytes?: number };
      if (e.month === this.egressMonth && typeof e.bytes === 'number') this.egressBytes = e.bytes;
    } catch {
      /* first run */
    }
  }
}
