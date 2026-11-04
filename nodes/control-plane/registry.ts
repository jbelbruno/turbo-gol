/**
 * Node registry: one-time registration tokens, node records and the status rules.
 *
 * Pure logic over in-memory maps. The reference control plane (devServer.ts) uses it as is; the
 * production NodeRegistryDO calls the same methods (see docs/INTEGRACION.md) with a `store` that
 * writes every durable change to its SQLite storage as it happens (persist.ts), and `restore`
 * loads the rows back after a restart. Heartbeats never write: what they carry comes back with
 * the next one.
 *
 * Lifecycle of a node (status):
 *   pending    registered with a valid token; not proven reachable yet -> no matches
 *   probation  reachable, casual matches only. Reachable means: a 'wss' node signed the nonce of
 *              GET <publicUrl>/healthz; an 'rtc' node passed its WebRTC self-test through a TURN
 *              relay (any player can reach it at worst through the relay). Without TURN (local
 *              development only) a plain self-test is accepted.
 *   active     PROBATION_MATCHES verified matches and no failed verification -> ranked too.
 *              A trusted node (run by the project, e.g. the Sao Paulo VPS) is active as soon as it
 *              is reachable.
 *   suspended  a failed verification (possible tampering or a build bug): until a maintainer
 *              looks, even if the node was already in a strike pause. Or MAX_STRIKES lost matches
 *              within STRIKE_WINDOW_MS (a home PC switched off mid-match): lifts by itself after
 *              STRIKE_COOLDOWN_MS, back to the previous status. Trusted nodes are never paused:
 *              a failed verification on one is a determinism bug and only raises an alert.
 *   banned     manual, permanent
 *
 * Beside the status (NodeStatus is the nodes' protocol, so these are fields of the record):
 *   retired        a maintainer took the node off the books (retire): it no longer counts toward its
 *                  operator's cap, takes no match and is refused at every login, like a banned one;
 *                  its record stays for the panel.
 *   trustRemovedAt its operator left the trusted operators (NODE_TRUSTED_OPERATORS) while the node
 *                  was trusted: restore() sent it back to probation, its 20 verified matches to earn.
 */
import { HEARTBEAT_TIMEOUT_MS } from '../shared/controlProtocol';
import type { BuildId, HeartbeatData, HelloData, NodeCapacity, NodeRole, NodeSpecs, NodeStatus, NodeTransport, RegisterRequest } from '../shared/controlProtocol';
import { isValidPublicKey, randomB64, randomHexId, sha256Hex } from '../shared/edcrypto';
import { nodeFromRow, rowWasTrusted, tokenFromRow } from './persist';
import type { NodeRow, RegistryStore, TokenRow } from './persist';

export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const TOKEN_PREFIX = 'tgn1_';
export const PROBATION_MATCHES = 20;
export const MAX_STRIKES = 3;
export const STRIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STRIKE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A second strike pause within this window sends an active node back to probation (20 verified matches again). */
export const REPEAT_PAUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_NODES_PER_OPERATOR = 10;
/**
 * The nodes a trusted operator (the project) may have: RegistryOptions.maxTrustedNodes, the Worker's
 * NODE_TRUSTED_MAX_NODES var, bounded by trustedNodeCap to TRUSTED_NODES_MIN..TRUSTED_NODES_MAX; this
 * many when it is not set, so a fork stays at the safe end. Each slot is a node with full trust:
 * active at once, verifying ranked matches (its own included), its no-shows and abandons taken at its
 * word, never paused. Minting its token takes the project account's password typed within the last
 * 15 minutes (the Worker's maintainer gate), so the cap is what a stolen password, or a level-2
 * session in the wrong hands, could add before anyone reads the ALERT lines: kept low on purpose.
 * A retired node takes no slot, and neither does a banned one of a trusted operator.
 */
export const MAX_TRUSTED_NODES_PER_OPERATOR = 2;
export const TRUSTED_NODES_MIN = 2;
export const TRUSTED_NODES_MAX = 8;
export const MAX_CAPACITY = 200;

/** A trusted operator's node cap from its setting (a var: text or a number): TRUSTED_NODES_MIN..MAX, MAX_TRUSTED_NODES_PER_OPERATOR when unset or unreadable. */
export function trustedNodeCap(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) return MAX_TRUSTED_NODES_PER_OPERATOR;
  return Math.min(TRUSTED_NODES_MAX, Math.max(TRUSTED_NODES_MIN, n));
}

/**
 * A DNS name a node may be pinned to (a token's publicHost), lower-cased, or null: install.sh's
 * is_dns_name (labels of letters, digits and inner hyphens, at least two, the last one starting
 * with a letter), at most 253 characters. So no scheme, no port, no path and no IP address (an
 * IPv4 one ends in digits, an IPv6 one has colons). Whether the name is a public one is the
 * Worker's to check (nodeWatch.ts probeTargetOk).
 */
export function validPublicHost(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 253) return null;
  const h = v.toLowerCase();
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h) ? h : null;
}

/** The host of a public URL as the URL parser reads it (lower case; an IPv6 one in brackets), or null. */
export function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

/**
 * The parsed host is an IP address. The parser of a special scheme (ws, wss, http, https) turns
 * every IPv4 form (hex, octal, fewer parts) into the dotted one, and keeps an IPv6 one in brackets.
 */
export function isIpHost(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** A node a maintainer retired: out of the cap, placement and counts, refused at every login. */
export function isRetired(n: Pick<NodeRecord, 'retiredAt'>): boolean {
  return n.retiredAt !== undefined && n.retiredAt !== null;
}

/** The short id the maintainers' panel names a token by: the start of its hash, never the token. */
export function tokenIdOf(t: Pick<TokenRecord, 'hash'>): string {
  return t.hash.slice(0, 12);
}

export type TokenState = 'unused' | 'used' | 'expired' | 'revoked';

/** Where a token stands at `now`. */
export function tokenState(t: TokenRecord, now: number): TokenState {
  if (t.usedBy !== null) return 'used';
  if (t.revokedAt !== undefined && t.revokedAt !== null) return 'revoked';
  return t.expiresAt < now ? 'expired' : 'unused';
}

export interface Operator {
  /** The operator's account id (the session `sub`): reputation and rewards attach to it. */
  id: string;
  name: string;
}

export interface TokenRecord {
  hash: string;
  operatorId: string;
  operatorName: string;
  region: string;
  name: string | null;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  /** The DNS name its node must register on, and keep (absent or null: any address). */
  publicHost?: string | null;
  /** The roles its node may register with (absent or null: whatever its operator may have). */
  roles?: NodeRole[] | null;
  /** A maintainer revoked it before it was used (POST /nodes/admin/tokens/revoke): it registers nothing. */
  revokedAt?: number | null;
}

export interface NodeCounters {
  assigned: number;
  verified: number;
  rankedVerified: number;
  failedVerification: number;
  lost: number;
  /** Lost matches inside the current STRIKE_WINDOW_MS. */
  strikes: number;
  /** Verified matches since the node last entered probation (promotion to active counts these). */
  probationVerified: number;
}

export interface NodeRecord {
  nodeId: string;
  operatorId: string;
  operatorName: string;
  name: string;
  region: string;
  publicKey: string;
  roles: NodeRole[];
  transports: NodeTransport[];
  publicUrl: string | null;
  status: NodeStatus;
  statusReason: string | null;
  /** A project-run machine: skips probation, its verification verdicts are final. */
  trusted: boolean;
  createdAt: number;
  /** When the control plane last proved publicUrl reaches this node (null = not yet / URL changed / its re-probes failed). */
  reachableAt: number | null;
  /** The node's last WebRTC self-test passed (through TURN when the control plane has TURN). */
  rtcReady: boolean;
  /** The node process of the last hello (a new one means it restarted). */
  bootId: string | null;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
  /** The largest capacity the node ever declared: the region's supply (lowering it later cannot raise the region factor). */
  capacityMax: number;
  egressCapGB: number | null;
  online: boolean;
  lastSeen: number;
  draining: boolean;
  active: number;
  tickLagP99Ms: number;
  egressGB: number;
  cpuLoad: number;
  counters: NodeCounters;
  strikeTimes: number[];
  /** When strike pauses started (REPEAT_PAUSE_WINDOW_MS): a repeated pause demotes the node. */
  pauseTimes: number[];
  /** Strike suspensions lift by themselves at this time (null: manual review). */
  suspendedUntil: number | null;
  statusBeforeSuspension: NodeStatus | null;
  /** The DNS name its token pinned (publicUrl stays on it), or null. Rows from before it: null (persist.ts). */
  publicHost?: string | null;
  /** When a maintainer retired it (isRetired), and why; null while it is not. */
  retiredAt?: number | null;
  retiredReason?: string | null;
  /** When it lost its operator's trust (restore), or null; cleared when the operator is trusted again. */
  trustRemovedAt?: number | null;
}

export type RegisterResult = { ok: true; node: NodeRecord } | { ok: false; code: string; message?: string };

export interface RegistryOptions {
  /** Accept ws:// public URLs and http control URLs (local development only). */
  allowInsecure?: boolean;
  /** Operators whose nodes are trusted (the project's own machines). */
  trustedOperators?: string[];
  /** Region ids the control plane knows (src/net/account.ts REGIONS). */
  regions?: string[];
  /** Where durable changes are written as they happen (none: memory only). */
  store?: RegistryStore;
  /** The control plane's log (default console.log); its ALERT lines are for the maintainers. */
  log?: (msg: string) => void;
  /** How many nodes a trusted operator may have (bounded by trustedNodeCap; MAX_TRUSTED_NODES_PER_OPERATOR when absent). */
  maxTrustedNodes?: number;
  /**
   * Refuse a wss publicUrl on an IP address (ip_not_supported), at registration and at a hello: the
   * reachability probe is a fetch of https://<host>/healthz, and a Worker's fetch cannot reach an IP
   * address, so such a node would stay pending. The NodeRegistryDO sets it (but on a loopback base,
   * wrangler dev); the reference server and the tests, which run on addresses, do not.
   */
  refuseIpUrls?: boolean;
}

function cleanName(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const t = s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32);
  return t.length >= 2 ? t : fallback;
}

export function validPublicUrl(u: unknown, allowInsecure: boolean): u is string {
  if (typeof u !== 'string' || u.length > 200) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:' && !(allowInsecure && url.protocol === 'ws:')) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  return url.search === '' && url.hash === '' && url.username === '' && url.password === '';
}

/** The ways players can reach `n` right now. */
export function usableTransports(n: NodeRecord): NodeTransport[] {
  const out: NodeTransport[] = [];
  if (n.transports.includes('wss') && n.publicUrl && n.reachableAt !== null) out.push('wss');
  if (n.transports.includes('rtc') && n.rtcReady) out.push('rtc');
  return out;
}

export class Registry {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly opts: RegistryOptions;
  private readonly trusted: Set<string>;
  private readonly log: (msg: string) => void;
  private readonly maxTrusted: number;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
    this.trusted = new Set(opts.trustedOperators ?? []);
    this.log = opts.log ?? ((m) => console.log(`[control] ${m}`));
    this.maxTrusted = trustedNodeCap(opts.maxTrustedNodes);
  }

  /**
   * Load the rows written through `store` (a fresh registry, after a restart). `trusted` comes
   * from this registry's trusted operators, not from the rows: a node written as trusted whose
   * operator is no longer one loses what that trust gave it (trustLost), once, with an ALERT.
   */
  restore(rows: { tokens: TokenRow[]; nodes: NodeRow[] }, now: number = Date.now()): void {
    this.tokens.clear();
    this.nodes.clear();
    for (const r of rows.tokens) this.tokens.set(r.hash, tokenFromRow(r));
    for (const r of rows.nodes) {
      const n = nodeFromRow(r, this.trusted);
      this.nodes.set(r.nodeId, n);
      const was = rowWasTrusted(r);
      if (!n.trusted && was) {
        this.trustLost(n, now);
      } else if (n.trusted && (!was || n.trustRemovedAt)) {
        // Trusted again, or newly: the row says so now, so a later removal is seen at its start.
        n.trustRemovedAt = null;
        this.save(n);
      }
    }
  }

  /**
   * A trusted node skipped probation, had its casual matches go unverified and its word taken on
   * no-shows; without the trust it must earn its PROBATION_MATCHES verified matches like any
   * community node, never stay active on the old trust. In service it goes back to probation; a
   * pending, suspended or banned node keeps its status (a pending one reaches probation when it is
   * proven reachable, never active). Written at once: the next start sees an untrusted row.
   */
  private trustLost(n: NodeRecord, now: number): void {
    const was = n.status;
    if (n.status === 'active' || n.status === 'probation') {
      n.status = 'probation';
      n.statusReason = 'trust_removed';
    }
    if (n.statusBeforeSuspension === 'active') n.statusBeforeSuspension = 'probation';
    n.counters.probationVerified = 0;
    n.trustRemovedAt = now;
    this.save(n);
    this.log(
      `ALERT node ${n.name} (${n.nodeId}) of ${n.operatorName} (${n.operatorId}) lost its trust (the operator is no longer in NODE_TRUSTED_OPERATORS): ${was} -> ${n.status}, 0 of ${PROBATION_MATCHES} verified matches`,
    );
  }

  private save(n: NodeRecord): void {
    this.opts.store?.node(n);
  }

  /** Mark an operator as the project (production: NODE_TRUSTED_OPERATORS in the Worker env). */
  addTrustedOperator(id: string): void {
    this.trusted.add(id);
    for (const n of this.nodes.values()) {
      if (n.operatorId !== id || n.trusted) continue;
      n.trusted = true;
      n.trustRemovedAt = null;
      this.save(n);
    }
  }

  isTrusted(operatorId: string): boolean {
    return this.trusted.has(operatorId);
  }

  // ---- tokens -----------------------------------------------------------------------------

  /**
   * A one-time token, valid TOKEN_TTL_MS, shown to the operator once (only its hash is kept).
   * `pin`: the DNS name its node must register on (validPublicHost; checked by the caller) and the
   * roles it may take.
   */
  async createToken(op: Operator, region: string, now: number, name?: string, pin: { publicHost?: string | null; roles?: NodeRole[] | null } = {}): Promise<{ token: string; expiresAt: number }> {
    if (this.opts.regions && !this.opts.regions.includes(region)) throw new Error('bad region');
    const token = TOKEN_PREFIX + randomB64(24);
    const rec: TokenRecord = {
      hash: await sha256Hex(token),
      operatorId: op.id,
      operatorName: op.name,
      region,
      name: name ? cleanName(name, '') || null : null,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
      usedBy: null,
      ...(pin.publicHost ? { publicHost: pin.publicHost } : {}),
      ...(pin.roles && pin.roles.length > 0 ? { roles: [...pin.roles] } : {}),
    };
    this.tokens.set(rec.hash, rec);
    const pruned: string[] = [];
    for (const [h, t] of this.tokens) {
      if (t.expiresAt < now - TOKEN_TTL_MS) {
        this.tokens.delete(h);
        pruned.push(h);
      }
    }
    this.opts.store?.tokens([rec]);
    if (pruned.length > 0) this.opts.store?.dropTokens(pruned);
    // Its node will be trusted: it verifies ranked matches, its own included. A token nobody on the
    // team asked for means the project account is in someone else's hands.
    if (this.trusted.has(op.id)) this.log(`ALERT registration token created for trusted operator ${op.name} (${op.id}), region ${region}${rec.publicHost ? ` for ${rec.publicHost}` : ''}`);
    return { token, expiresAt: rec.expiresAt };
  }

  /** Every token kept (unused, used, and expired ones until they are pruned). */
  tokenList(): TokenRecord[] {
    return [...this.tokens.values()];
  }

  /**
   * A maintainer revokes an unused token by its short id (tokenIdOf): from then on it registers
   * nothing. 'none' when no kept token has that id (or more than one: never a guess), 'used' when its
   * node registered already (retire the node instead), 'already' when it was revoked before.
   */
  revokeToken(id: string, now: number): { result: 'revoked' | 'already' | 'used' | 'none'; token?: TokenRecord } {
    const hits = id.length >= 8 ? this.tokenList().filter((t) => t.hash.startsWith(id)) : [];
    if (hits.length !== 1) return { result: 'none' };
    const t = hits[0];
    if (t.usedBy !== null) return { result: 'used', token: t };
    if (t.revokedAt !== undefined && t.revokedAt !== null) return { result: 'already', token: t };
    t.revokedAt = now;
    this.opts.store?.tokens([t]);
    return { result: 'revoked', token: t };
  }

  // ---- registration ---------------------------------------------------------------------------

  /** How many nodes this operator may have: fewer for a trusted one (maxTrustedNodes). */
  private nodeCap(operatorId: string): number {
    return this.trusted.has(operatorId) ? this.maxTrusted : MAX_NODES_PER_OPERATOR;
  }

  /**
   * The nodes that take a slot of their operator's cap: never a retired one; a banned one only for a
   * community operator (else its owner would register again), not for the project's, whose ban is
   * its own decision about a machine it no longer runs.
   */
  private takesSlot(n: NodeRecord): boolean {
    if (isRetired(n)) return false;
    return !(n.status === 'banned' && this.trusted.has(n.operatorId));
  }

  /** An operator's slots: the nodes that take one (takesSlot) and its cap. */
  slots(operatorId: string): { used: number; max: number } {
    return { used: this.byOperator(operatorId).filter((n) => this.takesSlot(n)).length, max: this.nodeCap(operatorId) };
  }

  /** The operator already has every node it may have. A trusted one at its cap gets an ALERT: a token nobody on the team used. */
  private atCap(tok: TokenRecord): boolean {
    const { used, max } = this.slots(tok.operatorId);
    if (used < max) return false;
    if (this.trusted.has(tok.operatorId)) this.log(`ALERT registration refused: trusted operator ${tok.operatorName} (${tok.operatorId}) already has its ${max} nodes`);
    return true;
  }

  /**
   * The name of a node registered with none (no --name, a token without one): its region and a
   * number, `sa-node-3`. Never its operator's name, which the public list (publicList.ts) would show
   * beside the "Anfitrión <n>" that hides it, nor the start of the operator's id (the name a token
   * carries when the account's could not be read). The number counts the region's records, which
   * are never deleted, and skips a name already taken, so two nodes never share one.
   */
  private unnamedName(region: string): string {
    const taken = new Set(this.list().map((n) => n.name));
    let k = this.list().filter((n) => n.region === region).length + 1;
    while (taken.has(`${region.toLowerCase()}-node-${k}`)) k++;
    return `${region.toLowerCase()}-node-${k}`;
  }

  async register(req: RegisterRequest, now: number): Promise<RegisterResult> {
    if (!req || typeof req.token !== 'string' || !req.token.startsWith(TOKEN_PREFIX) || req.token.length > 80) return { ok: false, code: 'bad_token' };
    const tok = this.tokens.get(await sha256Hex(req.token));
    if (!tok || tok.usedBy !== null) return { ok: false, code: 'bad_token', message: 'unknown or already used' };
    if (tok.revokedAt !== undefined && tok.revokedAt !== null) return { ok: false, code: 'token_revoked', message: 'a maintainer revoked this token: ask for a new one' };
    if (tok.expiresAt < now) return { ok: false, code: 'token_expired' };
    if (this.atCap(tok)) return { ok: false, code: 'too_many_nodes' };
    if (!(await isValidPublicKey(req.publicKey))) return { ok: false, code: 'bad_public_key' };
    for (const n of this.nodes.values()) if (n.publicKey === req.publicKey) return { ok: false, code: 'key_in_use' };
    const roles = Array.isArray(req.roles) ? [...new Set(req.roles)].filter((r): r is NodeRole => r === 'host' || r === 'verify') : [];
    if (roles.length === 0) return { ok: false, code: 'bad_roles' };
    // Verification is the project's job for now: a community verifier would never get a job, and
    // today's verdict could be answered from the replay alone without simulating (docs/PRODUCCION.md).
    if (roles.includes('verify') && !this.trusted.has(tok.operatorId)) {
      return { ok: false, code: 'verify_reserved', message: 'only project nodes verify matches for now; register with --roles host' };
    }
    if (tok.roles && roles.some((r) => !tok.roles?.includes(r))) return { ok: false, code: 'bad_roles', message: `this token is for --roles ${tok.roles.join(',')}` };
    const insecure = this.opts.allowInsecure === true;
    let transports: NodeTransport[] = [];
    if (roles.includes('host')) {
      const asked = Array.isArray(req.transports) ? req.transports : req.publicUrl ? ['wss'] : ['rtc'];
      transports = [...new Set(asked)].filter((t): t is NodeTransport => t === 'wss' || t === 'rtc');
      if (transports.length === 0) return { ok: false, code: 'bad_transports' };
      if (transports.includes('wss') && !validPublicUrl(req.publicUrl, insecure)) return { ok: false, code: 'bad_public_url', message: insecure ? 'ws(s)://host[:port]' : 'wss://host[:port]' };
    }
    // Before the token is spent: an installer run on the wrong machine or name can be run again.
    const host = transports.includes('wss') ? hostOf(req.publicUrl as string) : null;
    if (tok.publicHost && host !== tok.publicHost) return { ok: false, code: 'public_host_mismatch', message: `this token is for wss://${tok.publicHost}: run the installer with --public-host ${tok.publicHost}` };
    if (host !== null && this.opts.refuseIpUrls === true && isIpHost(host)) {
      return { ok: false, code: 'ip_not_supported', message: 'a wss node needs a DNS name (--public-host <name>): the control plane cannot probe an IP address' };
    }
    const b = req.build;
    if (!b || typeof b.version !== 'string' || typeof b.protocol !== 'number' || !/^[0-9a-f]{64}$/.test(String(b.wasmSha256))) return { ok: false, code: 'bad_build' };
    const c = req.capacity;
    if (!c || !Number.isInteger(c.matches) || c.matches < 1 || c.matches > MAX_CAPACITY) return { ok: false, code: 'bad_capacity' };

    const nodeId = randomHexId(8);
    const node: NodeRecord = {
      nodeId,
      operatorId: tok.operatorId,
      operatorName: tok.operatorName,
      name: cleanName(req.name ?? tok.name, this.unnamedName(tok.region)),
      region: tok.region,
      publicKey: req.publicKey,
      roles,
      transports,
      publicUrl: transports.includes('wss') ? (req.publicUrl as string).replace(/\/$/, '') : null,
      status: 'pending',
      statusReason: null,
      trusted: this.trusted.has(tok.operatorId),
      createdAt: now,
      reachableAt: null,
      rtcReady: false,
      bootId: null,
      build: { version: b.version, protocol: b.protocol, wasmSha256: b.wasmSha256 },
      specs: req.specs,
      capacity: c,
      capacityMax: c.matches,
      egressCapGB: null,
      online: false,
      lastSeen: 0,
      draining: false,
      active: 0,
      tickLagP99Ms: 0,
      egressGB: 0,
      cpuLoad: 0,
      counters: { assigned: 0, verified: 0, rankedVerified: 0, failedVerification: 0, lost: 0, strikes: 0, probationVerified: 0 },
      strikeTimes: [],
      pauseTimes: [],
      suspendedUntil: null,
      statusBeforeSuspension: null,
      publicHost: tok.publicHost ?? null,
      retiredAt: null,
      retiredReason: null,
      trustRemovedAt: null,
    };
    // A verify-only node needs no reachability: it only dials out.
    if (!roles.includes('host')) {
      node.reachableAt = now;
      node.status = node.trusted ? 'active' : 'probation';
    }
    // The awaits above let other registrations run their checks meanwhile: with this token, this
    // key or another token of this operator. Nothing yields from here until the token is spent, so
    // check again.
    if (tok.usedBy !== null) return { ok: false, code: 'bad_token', message: 'unknown or already used' };
    if (tok.revokedAt !== undefined && tok.revokedAt !== null) return { ok: false, code: 'token_revoked', message: 'a maintainer revoked this token: ask for a new one' };
    if (this.atCap(tok)) return { ok: false, code: 'too_many_nodes' };
    for (const n of this.nodes.values()) if (n.publicKey === req.publicKey) return { ok: false, code: 'key_in_use' };
    tok.usedBy = nodeId;
    this.nodes.set(nodeId, node);
    this.opts.store?.register(tok, node);
    if (node.trusted) {
      this.log(`ALERT trusted node ${node.name} (${nodeId}) registered for ${node.operatorName} (${node.operatorId}), roles ${roles.join('+')}${node.publicUrl ? ' at ' + node.publicUrl : ''}`);
    }
    return { ok: true, node };
  }

  // ---- queries ------------------------------------------------------------------------------

  node(id: string): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  list(): NodeRecord[] {
    return [...this.nodes.values()];
  }

  byOperator(operatorId: string): NodeRecord[] {
    return this.list().filter((n) => n.operatorId === operatorId);
  }

  // ---- live state ---------------------------------------------------------------------------

  /**
   * The node said hello (after every login and after a new WebRTC self-test). `hello` must come
   * from validate.parseHello. `requireRelay`: the control plane hands out TURN, so only a
   * self-test through the relay proves players can reach the node. Returns the new status when it
   * changed (an rtc node that just proved it is reachable).
   */
  connected(id: string, hello: HelloData, now: number, opts: { requireRelay?: boolean } = {}): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    n.online = true;
    n.lastSeen = now;
    n.build = hello.build;
    n.specs = hello.specs;
    n.draining = hello.draining;
    n.egressCapGB = hello.egressCapGB;
    n.bootId = hello.bootId ?? null;
    n.capacity = hello.capacity;
    n.capacityMax = Math.max(n.capacityMax ?? 0, hello.capacity.matches);
    const roles = hello.roles.filter((r): r is NodeRole => n.roles.includes(r));
    if (roles.length > 0) n.roles = roles;
    const transports = hello.transports.filter((t): t is NodeTransport => n.transports.includes(t));
    if (transports.length > 0) n.transports = transports;
    n.rtcReady = n.transports.includes('rtc') && hello.rtcReady === true && (opts.requireRelay !== true || hello.rtcRelay === true);
    const url = hello.publicUrl ? hello.publicUrl.replace(/\/$/, '') : null;
    if (n.transports.includes('wss') && url !== n.publicUrl) {
      if (url && validPublicUrl(url, this.opts.allowInsecure === true) && this.addressAllowed(n, url)) {
        n.publicUrl = url;
        n.reachableAt = null; // a new address must be proven again
      } else if (url) {
        this.log(`node ${n.name} (${n.nodeId}): a hello on another address (${url.slice(0, 120)}) kept ${n.publicUrl ?? 'none'}`);
      }
    }
    // An rtc-only host is reachable once its self-test passed.
    const changed = n.roles.includes('host') && !n.transports.includes('wss') && n.rtcReady ? this.reach(n, now) : null;
    this.save(n);
    return changed;
  }

  /** `hb` must come from validate.parseHeartbeat. */
  heartbeat(id: string, hb: HeartbeatData, now: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.online = true;
    n.lastSeen = now;
    n.active = Math.min(hb.active, n.capacity.matches);
    n.draining = hb.draining;
    n.tickLagP99Ms = hb.tickLagP99Ms;
    n.egressGB = hb.egressGB;
    n.egressCapGB = hb.egressCapGB;
    n.cpuLoad = hb.cpuLoad;
  }

  /**
   * The node's control socket outlived a restart of the control plane (a hibernation): it is live
   * as of `now`, so the heartbeat timeout covers it before its first heartbeat too. Not written,
   * like a heartbeat.
   */
  adopted(id: string, now: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.online = true;
    n.lastSeen = now;
  }

  disconnected(id: string): void {
    const n = this.nodes.get(id);
    if (n) n.online = false;
  }

  /**
   * A publicUrl `n` may move to: on its pinned host when it has one (publicHost: registration and
   * every hello), and never on an IP address where those are refused (refuseIpUrls).
   */
  addressAllowed(n: Pick<NodeRecord, 'publicHost'>, url: string): boolean {
    const host = hostOf(url);
    if (host === null) return false;
    if (n.publicHost && host !== n.publicHost) return false;
    return !(this.opts.refuseIpUrls === true && isIpHost(host));
  }

  /**
   * A maintainer takes a node off the books (POST /nodes/admin/retire): its slot is free, it takes no
   * match and every login of it is refused (the caller closes its socket). The record stays, with
   * when and why. Null when there is no such node or it was retired already.
   */
  retire(id: string, reason: string, now: number): NodeRecord | null {
    const n = this.nodes.get(id);
    if (!n || isRetired(n)) return null;
    n.retiredAt = now;
    n.retiredReason = reason;
    n.online = false;
    this.save(n);
    return n;
  }

  /**
   * Housekeeping: nodes whose heartbeats stopped go offline, which takes them out of placement (the
   * control plane closes their links and voids their matches later, if they stay silent); strike
   * suspensions whose cooldown passed are lifted (the node is told).
   */
  sweep(now: number): { offline: NodeRecord[]; restored: NodeRecord[] } {
    const offline: NodeRecord[] = [];
    const restored: NodeRecord[] = [];
    for (const n of this.nodes.values()) {
      if (n.online && now - n.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        n.online = false;
        offline.push(n);
      }
      if (n.status === 'suspended' && n.suspendedUntil !== null && now >= n.suspendedUntil) {
        n.status = n.statusBeforeSuspension ?? 'probation';
        n.statusReason = null;
        n.suspendedUntil = null;
        n.statusBeforeSuspension = null;
        // The strikes keep their own 7-day window: another one this week pauses the node again.
        n.strikeTimes = n.strikeTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
        n.counters.strikes = n.strikeTimes.length;
        this.save(n);
        restored.push(n);
      }
    }
    return { offline, restored };
  }

  // ---- status rules ---------------------------------------------------------------------------

  /** Reachability proven: pending -> probation (a trusted node -> active). Returns the new status when it changed. */
  markReachable(id: string, now: number): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const changed = this.reach(n, now);
    this.save(n);
    return changed;
  }

  /**
   * A proven wss host stopped answering its re-probes: no wss placements until a probe proves it
   * again. The status stays (a trusted node is still active): only the transport goes.
   */
  markUnreachable(id: string): void {
    const n = this.nodes.get(id);
    if (!n || n.reachableAt === null) return;
    n.reachableAt = null;
    this.save(n);
  }

  private reach(n: NodeRecord, now: number): NodeStatus | null {
    n.reachableAt = now;
    if (n.status === 'pending') {
      n.status = n.trusted ? 'active' : 'probation';
      n.statusReason = null;
      return n.status;
    }
    if (n.trusted && n.status === 'probation') {
      n.status = 'active';
      return n.status;
    }
    return null;
  }

  onAssigned(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.counters.assigned++;
    this.save(n);
  }

  /** A verification verdict for a match this node hosted. Returns the new status when it changed. */
  onVerified(id: string, ranked: boolean, ok: boolean): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    let changed: NodeStatus | null = null;
    if (!ok) {
      n.counters.failedVerification++;
      if (!n.trusted && n.status !== 'banned') {
        // Manual review, replacing any timed strike pause (which would otherwise lift by itself).
        n.status = 'suspended';
        n.statusReason = 'verification_failed';
        n.suspendedUntil = null;
        n.statusBeforeSuspension = null;
        changed = 'suspended'; // always told: the reason changed even when the status did not
      }
    } else {
      n.counters.verified++;
      n.counters.probationVerified = (n.counters.probationVerified ?? 0) + 1;
      if (ranked) n.counters.rankedVerified++;
      if (n.status === 'probation' && n.counters.probationVerified >= PROBATION_MATCHES && n.counters.failedVerification === 0) {
        changed = this.applyStatus(n, 'active', null);
      }
    }
    this.save(n);
    return changed;
  }

  /**
   * A match lost on this node (switched off, crashed, no replay). Strikes count inside
   * STRIKE_WINDOW_MS; MAX_STRIKES suspend the node for STRIKE_COOLDOWN_MS. Returns the new status
   * when it changed.
   */
  onLost(id: string, reason: string, now: number): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    n.counters.lost++;
    n.strikeTimes = n.strikeTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
    n.strikeTimes.push(now);
    n.counters.strikes = n.strikeTimes.length;
    let changed: NodeStatus | null = null;
    if (n.counters.strikes >= MAX_STRIKES && (n.status === 'probation' || n.status === 'active') && !n.trusted) {
      n.pauseTimes = (n.pauseTimes ?? []).filter((t) => now - t < REPEAT_PAUSE_WINDOW_MS);
      const repeated = n.pauseTimes.length > 0;
      n.pauseTimes.push(now);
      // A second pause within 30 days: back to probation, the 20 verified matches start over.
      n.statusBeforeSuspension = repeated ? 'probation' : n.status;
      if (repeated) n.counters.probationVerified = 0;
      n.status = 'suspended';
      n.statusReason = 'strikes:' + reason;
      n.suspendedUntil = now + STRIKE_COOLDOWN_MS;
      changed = n.status;
    }
    this.save(n);
    return changed;
  }

  /** Manual status change (admin) or a verification failure; clears any automatic cooldown. */
  setStatus(id: string, status: NodeStatus, reason: string | null): NodeStatus | null {
    const n = this.nodes.get(id);
    if (!n || n.status === status) return null;
    this.applyStatus(n, status, reason);
    this.save(n);
    return status;
  }

  private applyStatus(n: NodeRecord, status: NodeStatus, reason: string | null): NodeStatus {
    n.status = status;
    n.statusReason = reason;
    n.suspendedUntil = null;
    n.statusBeforeSuspension = null;
    if (status === 'probation' || status === 'active') {
      n.strikeTimes = [];
      n.counters.strikes = 0;
    }
    if (status === 'probation') n.counters.probationVerified = 0; // a maintainer's demotion: the 20 matches start over
    return status;
  }
}
