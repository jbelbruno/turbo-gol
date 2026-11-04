/**
 * CONTROL DE NODOS' logic (screens/nodesAdmin.ts), pure so it is tested without a DOM
 * (tests/nodes-admin.test.mjs): the tabs, the refresh's clock (every ADMIN_REFRESH_MS, paused by
 * a hidden page, held by reauth_required until the password, a minute apart while the nodes are
 * paused, slower after a 429), the KPIs of RESUMEN, the rows of NODOS, TOKENS and REGIONES, what
 * each node may be asked (the server's guards, so a button that would only be refused is not
 * offered), what a confirmation asks for, the wizard's follow-up of its token and its node, and the
 * history's rows (PARTIDAS: what a match offers; HISTORIAL and ALERTAS: tones, pages).
 * Menu and Screen are types only here: Menu.ts imports CSS.
 */
import { REGION_IDS, statusTone } from '../../net/nodes';
import type { AdminNode, HistoryMatch, MatchSeat, NodeEventKind, NodeFailure, NodeStatus, OpenMatch, OpenMatches, Overview, RegionView, Tone, TokenView } from '../../net/nodes';

export type AdminTab = 'summary' | 'nodes' | 'tokens' | 'regions' | 'release' | 'points' | 'stats' | 'matches' | 'history' | 'alerts';
/** The panel's tabs in their order (Partidas, Historial and Alertas: the history, PR 4). */
export const ADMIN_TABS: readonly AdminTab[] = ['summary', 'nodes', 'tokens', 'regions', 'release', 'points', 'stats', 'matches', 'history', 'alerts'];

/** The overview is asked again this often (ADMIN_REFRESH): under the 30 a minute of the maintainer routes, with room for the actions. */
export const ADMIN_REFRESH_MS = 15_000;
/** With the nodes paused (503 nodes_off) the panel asks again once a minute. */
export const PAUSED_RETRY_MS = 60_000;
/** After a failure that says nothing more (a network error, a 500). */
export const FAIL_RETRY_MS = 30_000;
/** After a 429: each one in a row waits longer, up to the last. */
export const LIMITED_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000];

/**
 * The refresh's clock. `held`: no request until something changes it (the password confirmed, a
 * new visit): reauth_required (never retried: the sheet asks once), a TV, an account that is not
 * the project's, a Worker without the routes.
 */
export interface RefreshState {
  readonly dueAt: number;
  readonly held: null | 'reauth' | 'tv' | 'denied' | 'gone';
  readonly limited: number;
  readonly inFlight: boolean;
}

/** A visit's first request: now. */
export function refreshStart(now: number): RefreshState {
  return { dueAt: now, held: null, limited: 0, inFlight: false };
}

/** The overview is to be asked now: not held, none in flight, the page shown, its time come. */
export function refreshDue(s: RefreshState, now: number, hidden: boolean): boolean {
  return s.held === null && !s.inFlight && !hidden && now >= s.dueAt;
}

export function refreshSent(s: RefreshState): RefreshState {
  return { ...s, inFlight: true };
}

/** After an answer: `ok`, or how it failed (src/net/nodes.ts nodeFailure), with a 429's retry-after. */
export function refreshAfter(s: RefreshState, now: number, outcome: 'ok' | NodeFailure, retryAfterMs = 0): RefreshState {
  const base = { ...s, inFlight: false };
  switch (outcome) {
    case 'ok':
      return { ...base, dueAt: now + ADMIN_REFRESH_MS, limited: 0, held: null };
    case 'paused':
      return { ...base, dueAt: now + PAUSED_RETRY_MS, limited: 0 };
    case 'limited': {
      const wait = LIMITED_BACKOFF_MS[Math.min(s.limited, LIMITED_BACKOFF_MS.length - 1)];
      return { ...base, dueAt: now + Math.max(wait, retryAfterMs), limited: s.limited + 1 };
    }
    case 'reauth':
      return { ...base, held: 'reauth' };
    case 'tv':
    case 'denied':
    case 'gone':
      return { ...base, held: outcome };
    default:
      return { ...base, dueAt: now + FAIL_RETRY_MS };
  }
}

/** The password confirmed (or a new visit): the overview at once, the rest as it was. */
export function refreshResume(s: RefreshState, now: number): RefreshState {
  return { ...s, held: null, dueAt: now };
}

// ---- RESUMEN ----------------------------------------------------------------------------------------

export interface Kpis {
  /** Nodes online (retired ones left out) and the region's total, for every region with a node. */
  online: Array<{ region: string; online: number; total: number }>;
  /** Matches running on the nodes now. */
  running: number;
  /** Matches waiting for their verification, and verifications running now. */
  queue: number;
  verifying: number;
  /** Outbox rows not delivered yet, and the oldest one's time. */
  outbox: number;
  outboxOldestAt: number | null;
  slots: { used: number; max: number };
}

export function kpisOf(o: Overview): Kpis {
  const byRegion = new Map<string, { online: number; total: number }>();
  for (const n of o.nodes) {
    if (n.retiredAt !== null) continue;
    const r = byRegion.get(n.region) ?? { online: 0, total: 0 };
    r.total++;
    if (n.online) r.online++;
    byRegion.set(n.region, r);
  }
  const order = (r: string): number => (REGION_IDS.indexOf(r as never) + 100) % 100;
  const oldest = o.outbox.byPath.reduce<number | null>((m, p) => (m === null || p.oldestAt < m ? p.oldestAt : m), null);
  return {
    online: [...byRegion].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([region, v]) => ({ region, ...v })),
    running: o.regions.reduce((s, r) => s + r.active, 0),
    queue: o.verifyQueue.reduce((s, q) => s + q.depth, 0),
    verifying: o.verifying,
    outbox: o.outbox.rows,
    outboxOldestAt: o.outbox.rows > 0 ? oldest : null,
    slots: { used: o.operator.slotsUsed, max: o.operator.slotsMax },
  };
}

/** The commands a flag is set and cleared with (server/README.md, "Kill switches"), for the panel's help: the flags are read only here. */
export function flagCommands(name: string): { set: string; clear: string } {
  return { set: `npx wrangler kv key put ${name} 1 --binding FLAGS --remote`, clear: `npx wrangler kv key delete ${name} --binding FLAGS --remote` };
}

// ---- NODOS ------------------------------------------------------------------------------------------

export interface NodeRow {
  key: string;
  nodeId: string;
  name: string;
  region: string;
  online: boolean;
  status: NodeStatus;
  tone: Tone;
  retired: boolean;
  trustLost: boolean;
  /** A node of the project (a trusted operator's), or of the community. */
  project: boolean;
  draining: boolean;
  active: number;
  capacity: number;
  lagMs: number;
  egressGB: number;
  egressCapGB: number | null;
  version: string;
  compatible: boolean;
  lastSeen: number | null;
}

/** The nodes as NODOS lists them: the ones on the books first, by region (the menu's order) and name; the retired ones last. */
export function nodeRows(o: Overview): NodeRow[] {
  const order = (r: string): number => {
    const i = REGION_IDS.indexOf(r as never);
    return i < 0 ? REGION_IDS.length : i;
  };
  return [...o.nodes]
    .sort((a, b) => Number(a.retiredAt !== null) - Number(b.retiredAt !== null) || order(a.region) - order(b.region) || a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId))
    .map((n) => ({
      key: n.nodeId,
      nodeId: n.nodeId,
      name: n.name,
      region: n.region,
      online: n.online,
      status: n.status,
      tone: statusTone(n.status, n.retiredAt !== null),
      retired: n.retiredAt !== null,
      trustLost: n.trustRemovedAt !== null,
      project: n.trusted,
      draining: n.draining,
      active: n.active,
      capacity: n.capacity?.matches ?? 0,
      lagMs: n.tickLagP99Ms,
      egressGB: n.egressGB,
      egressCapGB: n.egressCapGB,
      version: n.version,
      compatible: n.compatible,
      lastSeen: n.lastSeen,
    }));
}

/** The statuses a maintainer sets (NodeRegistryDO.ts ADMIN_STATUSES). */
export const ADMIN_STATUSES: readonly NodeStatus[] = ['probation', 'active', 'suspended', 'banned'];

export interface NodeActions {
  /** The statuses it may be set to, each with whether the server wants { force: true, reason } (active without its verified matches). */
  status: Array<{ to: NodeStatus; force: boolean }>;
  drain: boolean;
  reprobe: boolean;
  retire: boolean;
}

/**
 * What a node may be asked, as the server's guards would answer it (NodeRegistryDO.ts adminStatus,
 * adminRetire, adminDrain, adminReprobe): nothing for a retired one; into service only once its
 * probe passed (never a pending one, nor a host out of service that was never proven reachable);
 * active for a node that is not trusted only forced, with a reason; a drain to a node online that
 * is not draining; a re-probe to a wss host; a retirement to a node offline, or drained with no
 * open match. The server checks every one again (the trusted cap of an unban too).
 */
export function nodeActions(n: AdminNode): NodeActions {
  if (n.retiredAt !== null) return { status: [], drain: false, reprobe: false, retire: false };
  const inService = (s: NodeStatus): boolean => s === 'probation' || s === 'active';
  const unproven = n.status === 'pending' || (n.roles.includes('host') && n.reachableAt === null);
  const status = ADMIN_STATUSES.filter((to) => to !== n.status && !(inService(to) && !inService(n.status) && unproven)).map((to) => ({ to, force: to === 'active' && !n.trusted }));
  return {
    status,
    drain: n.online && !n.draining,
    reprobe: n.roles.includes('host') && n.transports.includes('wss') && n.publicUrl !== null,
    retire: !n.online || (n.draining && n.matches === 0),
  };
}

export type ConfirmAction = 'status' | 'ban' | 'force' | 'drain' | 'reprobe' | 'retire' | 'revokeToken' | 'update' | 'grant' | 'revoke' | 'unfreeze' | 'delist' | 'voidMatch' | 'voidStrike' | 'download';

/**
 * What a confirmation sheet asks for (prompt 1, B6): a reason for a retirement, a ban, a drain, a
 * delist, a match voided (with or without a strike), an active forced past its verified matches and
 * every points action; the node's name typed for a retirement, a ban and a drain. A raw replay's
 * download asks for nothing: its sheet only says it is posted to the team's channel.
 */
export function confirmNeeds(a: ConfirmAction): { reason: boolean; typeName: boolean } {
  const typeName = a === 'retire' || a === 'ban' || a === 'drain';
  const reason = typeName || a === 'delist' || a === 'voidMatch' || a === 'voidStrike' || a === 'force' || a === 'grant' || a === 'revoke' || a === 'unfreeze';
  return { reason, typeName };
}

/** The name typed matches the node's (trimmed, as written: names are a-z, A-Z, digits, '.', '_' and '-'). */
export function nameTyped(typed: string, name: string): boolean {
  return typed.trim() === name;
}

// ---- TOKENS -----------------------------------------------------------------------------------------

/** Whole minutes left of a token's hour (0 once past it). */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/** A token the panel may still revoke (unused and in its hour). */
export function revocable(t: TokenView, now: number): boolean {
  return t.state === 'unused' && t.expiresAt >= now;
}

// ---- REGIONES ---------------------------------------------------------------------------------------

export interface RegionRow extends RegionView {
  /** No host there: its matches go to Cloudflare's servers. */
  empty: boolean;
  /** The trusted verifiers of the region online. */
  verifiers: string[];
}

export function regionRows(o: Overview): RegionRow[] {
  return o.regions.map((r) => ({
    ...r,
    empty: r.hostsOnline === 0,
    verifiers: o.verifiers.filter((v) => v.region === r.region && v.online).map((v) => v.name),
  }));
}

// ---- RELEASE ----------------------------------------------------------------------------------------

/** The nodes by the release they run, the newest first, each with whether it is the stable channel's. */
export function releaseRows(o: Overview): Array<{ version: string; stable: boolean; nodes: Array<{ nodeId: string; name: string; compatible: boolean; online: boolean }> }> {
  const by = new Map<string, Array<{ nodeId: string; name: string; compatible: boolean; online: boolean }>>();
  for (const n of o.nodes) {
    if (n.retiredAt !== null) continue;
    by.set(n.version, [...(by.get(n.version) ?? []), { nodeId: n.nodeId, name: n.name, compatible: n.compatible, online: n.online }]);
  }
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  };
  return [...by].sort((a, b) => cmp(a[0], b[0])).map(([version, nodes]) => ({ version, stable: o.channel?.stable === version, nodes }));
}

// ---- the wizard's follow-up ---------------------------------------------------------------------------

/**
 * Where the wizard's token stands, read from the overview: `waiting` (unused, in its hour),
 * `expired`, `revoked`, then its node by the token's `usedBy`: `pending` (its probe not passed yet:
 * the probe's error, if any), `probation` or `active` (done), or another status (suspended, banned,
 * retired) as `stopped`. `gone`: the overview no longer lists the token (pruned after two hours).
 */
export type FollowStep = 'waiting' | 'expired' | 'revoked' | 'pending' | 'probation' | 'active' | 'stopped' | 'gone';

export function followOf(o: Overview, tokenId: string, now: number): { step: FollowStep; token: TokenView | null; node: AdminNode | null } {
  const token = o.tokens.find((t) => t.id === tokenId) ?? null;
  if (token === null) return { step: 'gone', token: null, node: null };
  if (token.usedBy === null) {
    if (token.state === 'revoked') return { step: 'revoked', token, node: null };
    return { step: token.expiresAt < now || token.state === 'expired' ? 'expired' : 'waiting', token, node: null };
  }
  const node = o.nodes.find((n) => n.nodeId === token.usedBy) ?? null;
  if (node === null) return { step: 'pending', token, node: null };
  if (node.retiredAt !== null) return { step: 'stopped', token, node };
  if (node.status === 'pending' || node.status === 'probation' || node.status === 'active') return { step: node.status, token, node };
  return { step: 'stopped', token, node };
}

/** The wizard's step: the form, the checklist, the token and its command with the follow-up. */
export type WizardStep = 'form' | 'checklist' | 'token';

/** The checklist's lines before a token (prompt 1, B5 step 3); `verify` adds the verifier's lines. */
export function checklistOf(verify: boolean): Array<'country' | 'dns' | 'firewall' | 'os' | 'ntp' | 'node' | 'xmachine' | 'release'> {
  return ['country', 'dns', 'firewall', 'os', 'ntp', ...(verify ? (['node', 'xmachine', 'release'] as const) : [])];
}

// ---- CUENTAS Y COLAS ----------------------------------------------------------------------------------

/** A record of counts as rows of [path, number], nested ones by their dotted path; anything else (booleans, lists, ids) left out. */
export function countRows(v: unknown, prefix = ''): Array<[string, number]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
  const out: Array<[string, number]> = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (typeof x === 'number' && Number.isFinite(x)) out.push([key, x]);
    else if (typeof x === 'object' && x !== null && !Array.isArray(x)) out.push(...countRows(x, key));
  }
  return out;
}

/** The sum of every count in a record (nested ones too): a day's searches over all kinds. */
export function countSum(v: unknown): number {
  return countRows(v).reduce((s, [, n]) => s + n, 0);
}

/** A queue day (server/src/queueStats.ts QueueDay) as one row of totals. */
export function queueDayRow(d: unknown): { date: string; searches: number; cancelled: number; dropped: number; formed: number; onNode: number; onCloud: number; crossRegion: number } | null {
  if (typeof d !== 'object' || d === null) return null;
  const o = d as Record<string, unknown>;
  if (typeof o.date !== 'string') return null;
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { date: o.date, searches: countSum(o.searches), cancelled: countSum(o.cancelled), dropped: countSum(o.dropped), formed: countSum(o.formed), onNode: num(o.onNode), onCloud: num(o.onCloud), crossRegion: num(o.crossRegion) };
}

// ---- PARTIDAS, HISTORIAL, ALERTAS (the history, PR 4) ---------------------------------------------------

/** Where a match stands: held and not settled (assigned, reporting, verifying), or how it settled. */
export type MatchState = OpenMatch['state'] | HistoryMatch['result'];

/** A match's state as a colour: rated ok, being verified warn, void bad, the rest muted. */
export function matchTone(state: MatchState): Tone {
  if (state === 'rated') return 'ok';
  if (state === 'verifying') return 'warn';
  if (state === 'void') return 'bad';
  return 'muted';
}

export interface MatchRow {
  key: string;
  matchId: string;
  open: boolean;
  nodeName: string;
  region: string;
  mode: string;
  ranked: boolean;
  state: MatchState;
  tone: Tone;
  /** When it was placed (an open one) or settled. */
  at: number;
}

/** PARTIDAS' rows: the open matches first (newest first), then the settled ones as the history pages came (newest first), each once. */
export function matchRows(open: OpenMatches | null, settled: readonly HistoryMatch[]): MatchRow[] {
  const seen = new Set<string>();
  const out: MatchRow[] = [];
  const add = (m: OpenMatch | HistoryMatch, isOpen: boolean): void => {
    if (seen.has(m.matchId)) return;
    seen.add(m.matchId);
    const state: MatchState = isOpen ? (m as OpenMatch).state : (m as HistoryMatch).result;
    out.push({ key: m.matchId, matchId: m.matchId, open: isOpen, nodeName: m.nodeName ?? m.nodeId, region: m.region, mode: m.mode, ranked: m.ranked, state, tone: matchTone(state), at: isOpen ? (m as OpenMatch).placedAt : (m as HistoryMatch).settledAt });
  };
  for (const m of [...(open?.matches ?? [])].sort((a, b) => b.placedAt - a.placedAt)) add(m, true);
  for (const m of settled) add(m, false);
  return out;
}

/**
 * What a match's detail offers, as the server would answer it: an open one may be voided (with or
 * without a strike) and, waiting for its verification with no verifier on it, verified now; a
 * settled one's replay opens in the public viewer once published, is delisted while listed, and
 * downloads raw (audited) while one was uploaded and no delist took it.
 */
export function matchActions(m: { open: true; match: OpenMatch } | { open: false; match: HistoryMatch }): { viewer: boolean; delist: boolean; download: boolean; void: boolean; verify: boolean } {
  if (m.open) {
    const x = m.match;
    return { viewer: false, delist: false, download: x.replay, void: true, verify: x.state === 'verifying' && !x.verifying };
  }
  const x = m.match;
  const kept = x.delistedAt === null;
  return { viewer: x.published && kept, delist: x.listed && kept, download: x.replay && kept, void: false, verify: false };
}

/** How a seat is named: a bot, a name its player hides ('Jugador N', its slot + 1), a purged account, or its name. */
export function seatName(s: MatchSeat): { kind: 'bot' | 'hidden' | 'gone' | 'name'; name: string; n: number } {
  const n = s.slot + 1;
  if (s.bot) return { kind: 'bot', name: '', n };
  if (s.name !== null) return { kind: 'name', name: s.name, n };
  return { kind: s.id === null && !s.hidden ? 'gone' : 'hidden', name: '', n };
}

/** A node event's colour: what went wrong bad, what took it out of play for a while warn, its way back ok, the rest muted. */
export function eventTone(kind: NodeEventKind): Tone {
  switch (kind) {
    case 'strike':
    case 'pause':
    case 'verify_failed':
    case 'probe_failed':
    case 'unreachable':
    case 'trust_removed':
    case 'link_4408':
      return 'bad';
    case 'offline':
    case 'link_quiet':
    case 'late_messages':
    case 'drain':
    case 'retire':
    case 'update_sent':
      return 'warn';
    case 'online':
    case 'reachable':
    case 'link_back':
    case 'registered':
      return 'ok';
    default:
      return 'muted';
  }
}

/** A page appended to the ones before (MÁS), each item once by its key. */
export function appendPage<T>(before: readonly T[], page: readonly T[], key: (x: T) => string | number): T[] {
  const seen = new Set(before.map(key));
  return [...before, ...page.filter((x) => !seen.has(key(x)))];
}
