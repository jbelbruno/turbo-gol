/**
 * The community nodes as the game's pages see them, without a session (prompt 1, part B2): the
 * answers of /nodes/mine, /nodes/tokens and the maintainers' /nodes/admin/* (server/src/
 * nodeOverview.ts, NodeRegistryDO.ts; the history's events, matches and alert lines, PR 4), the
 * refusals in words (by code, never by message), and the
 * pure checks the panel and the wizard run before a request: the DNS name of a host, the token's
 * form, a node's state as a tone, an address masked. The calls themselves are AccountClient's
 * (nodesMine, nodes*), on its ownCall. PERFIL's CONTROL DE NODOS (screens/nodesAdmin.ts) and the
 * community's "add a server" of prompt 2 share all of it. Pure: node tests import it.
 */
import { MAX_CAPACITY, validPublicHost } from '../../nodes/control-plane/registry';
import { REGIONS, isRegion } from './account';
import type { MeInfo, MyNode, RegionId } from './account';
import type { Key } from '../i18n';

// ---- the answers --------------------------------------------------------------------------------

export type NodeStatus = MyNode['status'];
export type NodeRole = 'host' | 'verify';

export interface NodeCounters {
  assigned: number;
  verified: number;
  rankedVerified: number;
  failedVerification: number;
  lost: number;
  strikes: number;
  probationVerified: number;
}

/** GET /nodes/mine: one of the caller's nodes (nodeOverview.ts mineView). MyNode is the part PERFIL's MI SERVIDOR reads. */
export interface MineNode extends MyNode {
  name: string;
  roles: NodeRole[];
  transports: Array<'wss' | 'rtc'>;
  trusted: boolean;
  publicUrl: string | null;
  reachable: boolean;
  active: number;
  capacity: { matches: number; source?: string };
  tickLagP99Ms: number;
  egressGB: number;
  counters: NodeCounters;
  /**
   * The rest of GET /nodes/mine's node (Prompt 2, A11: nodeOverview.ts mineNodeView), from the
   * server of that change on: its dates and service state, its last probe, its progress to active,
   * its strikes in their window, its refusals and the matches placement lets it run.
   */
  createdAt?: number;
  lastSeen?: number | null;
  draining?: boolean;
  egressCapGB?: number | null;
  reachableAt?: number | null;
  lastProbe?: { at: number; ok: boolean; error: string | null } | null;
  needed?: number;
  strikes?: { count: number; max: number; windowDays: number };
  refused?: { count: number; rate: number; recent: number; of: number; outUntil: number | null };
  capacityEffective?: number;
}

/** A token of GET /nodes/mine: one of the caller's own, by its short id (nodeOverview.ts mineTokenViews). */
export interface MineToken {
  id: string;
  region: string;
  name: string | null;
  publicHost: string | null;
  createdAt: number;
  expiresAt: number;
  state: 'unused' | 'used' | 'expired' | 'revoked';
  /** The node it registered, once it did. */
  nodeId: string | null;
}

/** The ledger's view of an operator (nodes/control-plane/ledger.ts OperatorSummary). */
export interface Rewards {
  operatorId: string;
  points30d: number;
  earned: number;
  matches30d: number;
  playerMinutes30d: number;
  byNode: Record<string, { points: number; matches: number }>;
  /** Today's points (UTC) against the daily cap per host (A17a); the project's earn nothing and have no cap (null). From the A11 server on. */
  pointsToday?: number;
  capToday?: number | null;
}

/** GET /nodes/mine as AccountClient.nodesMine reads it: empty where the Worker has no nodes (a fork, local dev: 404). */
export interface MineAnswer {
  /** The caller and whether the control plane trusts it (the server's word, not /api/me's). Null when there are no nodes. */
  operator: { id: string; trusted: boolean } | null;
  nodes: MineNode[];
  rewards: Rewards | null;
  /**
   * The rest of "Mis servidores" (A11), from the server of that change on, each only when it came:
   * whether hosting is open for the caller (`reason` why not), what it still lacks (the token's
   * refusal codes, null while hosting is closed or the account cannot be read), the rules for hosts
   * of the terms in force (null likewise), its slots and code limits (null: no community cap, a
   * project account), its own codes, its name in the public list, and the release channel.
   */
  hosting?: { open: boolean; reason?: string };
  requirements?: { missing: string[]; daysLeft: number } | null;
  terms?: { version: string | null; accepted: boolean } | null;
  limits?: { nodes: number; maxNodes: number; tokensToday: number | null; tokensLeftToday: number | null; outstanding: number; maxOutstanding: number | null };
  tokens?: MineToken[];
  showPublic?: boolean;
  channel?: { stable: string; minimum: string } | null;
}

/**
 * The opening of hosting as the maintainers see it (GET /nodes/admin/overview `hosting`, Prompt 2
 * A1: nodeOverview.ts HostingView): the KV flag node_operators raw (a canary's account ids
 * included), its stage, whether the terms in force describe hosting (closed below
 * NODE_HOSTING_TERMS whatever the flag says), its latest changes and whether the community nodes'
 * staff-only channel has its webhook. Absent from a server of before the opening's flag.
 */
export interface HostingView {
  flag: string;
  raw: string | null;
  stage: 'closed' | 'canary' | 'all';
  terms: { inForce: boolean; version: string | null; needed: string | null };
  changes: Array<{ id: number; at: number; actor: string; flag: string; old: string | null; new: string | null; reason: string | null }>;
  communityWebhook: boolean;
}

/** A player's report reason (server/src/nodeStore.ts REPORT_REASONS, the same list): its car did not answer, lag only for them, a drop, something else. */
export const REPORT_REASONS = ['unresponsive', 'lag', 'disconnected', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** One community operator for the Operadores tab (GET /nodes/admin/operators: nodeOverview.ts operatorView). */
export interface OperatorView {
  operatorId: string;
  name: string | null;
  status: 'ok' | 'blocked';
  reason: string | null;
  actor: string | null;
  at: number | null;
  showPublic: boolean;
  nodes: Array<{ nodeId: string; name: string; region: string; status: NodeStatus; online: boolean; retired: boolean; capacity: number; capacityEffective: number; assigned: number; refused: number; seenContinent: string | null }>;
  refusalRate: number;
  tokens: { today: number; unused: number };
  running: { matches: number; max: number };
  points: { today: number; cap: number | null; d30: number; matches30d: number; earned: number; concentration: number };
  /** The players' reports of the last `days` (A16): never a sanction alone, several accounts about one server are the signal. */
  reports: {
    days: number;
    count: number;
    accounts: number;
    byReason: Record<ReportReason, number>;
    byNode: Array<{ nodeId: string; reports: number; accounts: number }>;
    recent: Array<{ at: number; reporterId: string; matchId: string; nodeId: string; reason: ReportReason; ping: number | null; corrections: number | null }>;
  };
}

/** GET /nodes/admin/operators's body, leniently: each operator with its lists there, a reason the client does not know counted as 'other'. */
export function operatorsOf(b: unknown): { at: number; operators: OperatorView[] } {
  const o = (b ?? {}) as { at?: unknown; operators?: unknown };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const operators = arr<Partial<OperatorView>>(o.operators)
    .filter((x) => typeof x?.operatorId === 'string')
    .map((x): OperatorView => {
      const r = (x.reports ?? {}) as Partial<OperatorView['reports']>;
      const byReason = Object.fromEntries(REPORT_REASONS.map((k) => [k, num((r.byReason as Record<string, unknown> | undefined)?.[k])])) as Record<ReportReason, number>;
      const p = (x.points ?? {}) as Partial<OperatorView['points']>;
      return {
        operatorId: x.operatorId as string,
        name: typeof x.name === 'string' ? x.name : null,
        status: x.status === 'blocked' ? 'blocked' : 'ok',
        reason: typeof x.reason === 'string' ? x.reason : null,
        actor: typeof x.actor === 'string' ? x.actor : null,
        at: typeof x.at === 'number' ? x.at : null,
        showPublic: x.showPublic === true,
        nodes: arr(x.nodes),
        refusalRate: num(x.refusalRate),
        tokens: { today: num(x.tokens?.today), unused: num(x.tokens?.unused) },
        running: { matches: num(x.running?.matches), max: num(x.running?.max) },
        points: { today: num(p.today), cap: typeof p.cap === 'number' ? p.cap : null, d30: num(p.d30), matches30d: num(p.matches30d), earned: num(p.earned), concentration: num(p.concentration) },
        reports: {
          days: num(r.days) || 7,
          count: num(r.count),
          accounts: num(r.accounts),
          byReason,
          byNode: arr(r.byNode),
          recent: arr<OperatorView['reports']['recent'][number]>(r.recent).map((e) => ({ ...e, reason: (REPORT_REASONS as readonly string[]).includes(e?.reason) ? e.reason : 'other' })),
        },
      };
    });
  return { at: num(o.at), operators };
}

/** A node in the overview (nodeOverview.ts overviewNode). */
export interface AdminNode extends MineNode {
  operator: { id: string; name: string };
  createdAt: number;
  lastSeen: number | null;
  draining: boolean;
  egressCapGB: number | null;
  cpuLoad: number;
  bootId: string | null;
  matches: number;
  build: { version: string; protocol: number; wasmSha256: string };
  specs: { cpus?: number; cpuModel?: string; memMB?: number; arch?: string; os?: string; node?: string } | null;
  capacityMax: number;
  reachableAt: number | null;
  lastProbe: { at: number; ok: boolean; error: string | null } | null;
  probeFailures: number;
  strikeTimes: number[];
  pauseTimes: number[];
  publicHost: string | null;
  retiredAt: number | null;
  retiredReason: string | null;
  trustRemovedAt: number | null;
  linkCuts: { count24h: number; lastAt: number | null };
  /** When it was last heard as of its last online / offline transition: what the server knows after a restart (lastSeen is memory only). */
  seenAt?: number | null;
}

export type TokenState = 'unused' | 'used' | 'expired' | 'revoked';

/** A token as the overview lists it: its short id, never the token (nodeOverview.ts TokenView). */
export interface TokenView {
  id: string;
  operatorId: string;
  operatorName: string;
  region: string;
  name: string | null;
  publicHost: string | null;
  roles: NodeRole[] | null;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  revokedAt: number | null;
  state: TokenState;
}

/** A region as the panel sees it (controlPlane.ts RegionView). */
export interface RegionView {
  region: string;
  hostsOnline: number;
  slots: number;
  active: number;
  matches: number;
  unplaced: number;
  regionFactor: number;
  rankedReady: boolean;
}

export type KvFlag = 'matchmaking_off' | 'do_disabled' | 'nodes_on' | 'vm_disabled' | 'nodes_off' | 'replays_off' | 'email_off' | 'turn_cf_disabled';

export interface FlagView {
  name: KvFlag;
  raw: string | null;
  set: boolean;
  /** What it does, in the server's English (the panel words the on / off itself). */
  meaning: string;
}

export type OverviewWarning =
  | { kind: 'verifier_node_versions'; version: string; nodes: Array<{ nodeId: string; name: string; node: string }> }
  | { kind: 'trusted_off_channel'; nodeId: string; name: string; version: string; stable: string }
  | { kind: 'no_webhook' }
  | { kind: 'trust_removed'; nodeId: string; name: string; at: number };

/** GET /nodes/admin/overview (nodeOverview.ts overviewOf): what the panel refreshes. */
export interface Overview {
  at: number;
  build: { version: string; protocol: number; wasmSha256: string };
  channel: { stable: string; minimum: string } | null;
  verifying: number;
  operator: { id: string; name: string; slotsUsed: number; slotsMax: number };
  nodes: AdminNode[];
  tokens: TokenView[];
  regions: RegionView[];
  verifiers: Array<{ nodeId: string; name: string; region: string; version: string; node: string; status: NodeStatus; online: boolean; verifying: number }>;
  verifyQueue: Array<{ version: string; protocol: number; wasmSha256: string; depth: number; oldestAt: number }>;
  outbox: { rows: number; byPath: Array<{ path: string; rows: number; oldestAt: number }> };
  points: Array<Rewards & { name: string | null }>;
  flags: FlagView[];
  alerts: { webhook: boolean };
  warnings: OverviewWarning[];
  /** The last 24 h's voids by node and reason (the history, PR 4); [] from a server without it. */
  voids24h: Array<{ nodeId: string; name: string | null; reason: string; count: number }>;
  /** The opening of hosting (Prompt 2, A1); absent from a server of before it. */
  hosting?: HostingView;
}

// ---- the history (PR 4: GET /nodes/admin/events, /history, /alerts, /matches, /replay) ------------

/** A seat of a match as the panel lists it: a bot's, or a human's (a name its player hides is null, as a purged account's name and id are). */
export interface MatchSeat {
  slot: number;
  team: 0 | 1;
  bot: boolean;
  name: string | null;
  id: string | null;
  /** Its player hides the name in the public replays (the panel says "Jugador N"). */
  hidden: boolean;
}

/** A settled match (server/src/nodeStore.ts MatchHistory, as GET /nodes/admin/history serves it). */
export interface HistoryMatch {
  matchId: string;
  nodeId: string;
  nodeName: string | null;
  region: string;
  mode: string;
  ranked: boolean;
  transport: string;
  placedAt: number;
  reportedAt: number | null;
  settledAt: number;
  result: 'rated' | 'unrated' | 'void';
  reason: string | null;
  score: { blue: number; red: number } | null;
  verified: boolean;
  verifiedBy: string | null;
  verifierName: string | null;
  verdict: { ok: boolean; code: string } | null;
  strike: string | null;
  replay: boolean;
  points: number | null;
  frozen: boolean;
  adminReason: string | null;
  seats: MatchSeat[];
  delistedAt: number | null;
  /** In the public replays' list; `published`: served there now (its hour released), replay.html?id= opens it. */
  listed: boolean;
  published: boolean;
}

/** A match the control plane holds and has not settled (GET /nodes/admin/matches). */
export interface OpenMatch {
  matchId: string;
  nodeId: string;
  nodeName: string | null;
  region: string;
  mode: string;
  ranked: boolean;
  transport: string;
  state: 'assigned' | 'reporting' | 'verifying';
  placedAt: number;
  deadline: number;
  started: boolean;
  reportedAt: number | null;
  queuedAt: number | null;
  /** A verifier has it now (verifierName). */
  verifying: boolean;
  verifierName: string | null;
  replay: boolean;
  leaves: number;
  seats: MatchSeat[];
}

/** 'unavailable': AccountsDO could not say whose names are hidden, so none is shown. */
export type NamesState = 'shown' | 'unavailable';

export interface HistoryPage {
  matches: HistoryMatch[];
  next: string | null;
  names: NamesState;
}

export interface OpenMatches {
  total: number;
  matches: OpenMatch[];
  names: NamesState;
}

/** What happened to a node (nodes/control-plane/registry.ts NodeEventKind). */
export type NodeEventKind =
  | 'registered'
  | 'token_used'
  | 'status_change'
  | 'strike'
  | 'pause'
  | 'verify_failed'
  | 'probe_failed'
  | 'unreachable'
  | 'reachable'
  | 'offline'
  | 'online'
  | 'drain'
  | 'retire'
  | 'trust_removed'
  | 'link_quiet'
  | 'link_back'
  | 'link_4408'
  | 'late_messages'
  | 'update_sent';

export const NODE_EVENT_KINDS: readonly NodeEventKind[] = ['registered', 'token_used', 'status_change', 'strike', 'pause', 'verify_failed', 'probe_failed', 'unreachable', 'reachable', 'offline', 'online', 'drain', 'retire', 'trust_removed', 'link_quiet', 'link_back', 'link_4408', 'late_messages', 'update_sent'];

export interface NodeEvent {
  id: number;
  nodeId: string;
  nodeName: string | null;
  at: number;
  kind: NodeEventKind;
  /** The server's line (English), shown beside the panel's words. */
  detail: string | null;
  /** The maintainer whose call it was ('name (account id)'), or null. */
  actor: string | null;
}

export interface EventsPage {
  events: NodeEvent[];
  next: string | null;
}

/** An ALERT line the object posted to the team's channel (or would have, without the webhook). */
export interface AlertLine {
  id: number;
  at: number;
  kind: 'alert' | 'audit';
  line: string;
}

export interface AlertsPage {
  alerts: AlertLine[];
  next: string | null;
  webhook: boolean;
}

const cursorOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const namesOf = (v: unknown): NamesState => (v === 'unavailable' ? 'unavailable' : 'shown');

/** GET /nodes/admin/history's body, leniently. */
export function historyPageOf(b: unknown): HistoryPage {
  const o = (b ?? {}) as { matches?: unknown; next?: unknown; names?: unknown };
  return { matches: arr<HistoryMatch>(o.matches).map((m) => ({ ...m, seats: arr<MatchSeat>(m.seats) })), next: cursorOf(o.next), names: namesOf(o.names) };
}

/** GET /nodes/admin/matches's body, leniently. */
export function openMatchesOf(b: unknown): OpenMatches {
  const o = (b ?? {}) as { total?: unknown; matches?: unknown; names?: unknown };
  const matches = arr<OpenMatch>(o.matches).map((m) => ({ ...m, seats: arr<MatchSeat>(m.seats) }));
  return { total: typeof o.total === 'number' ? o.total : matches.length, matches, names: namesOf(o.names) };
}

/** GET /nodes/admin/events's body, leniently (a kind this client does not know is left out). */
export function eventsPageOf(b: unknown): EventsPage {
  const o = (b ?? {}) as { events?: unknown; next?: unknown };
  return { events: arr<NodeEvent>(o.events).filter((e) => NODE_EVENT_KINDS.includes(e?.kind)), next: cursorOf(o.next) };
}

/** GET /nodes/admin/alerts's body, leniently. */
export function alertsPageOf(b: unknown): AlertsPage {
  const o = (b ?? {}) as { alerts?: unknown; next?: unknown; webhook?: unknown };
  return { alerts: arr<AlertLine>(o.alerts).filter((a) => typeof a?.line === 'string'), next: cursorOf(o.next), webhook: o.webhook !== false };
}

/** POST /nodes/tokens's answer: the token (shown once, never kept), when it dies and the install line, composed and checked by the server. */
export interface TokenAnswer {
  token: string;
  expiresAt: number;
  ttlMinutes: number;
  install: { linux: string };
}

/** GET /nodes/admin/wallet?account=: an account's wallet as AccountsDO keeps it. */
export interface AdminWallet {
  account: string;
  wallet: { earned: number; spent: number; balance: number; frozen: string | null } | null;
  items: string[];
  car: string | null;
}

/** GET /nodes/admin/frozen: the wallets frozen now, newest first. */
export interface FrozenList {
  frozen: Array<{ account: string; reason: string; at: number }>;
  more: boolean;
}

/**
 * POST /nodes/tokens's body. `name` left out: the server's default (`<region>-node-<k>`). A
 * community account's code also carries the acceptance of the rules for hosts of the terms in force
 * (Prompt 2, A3: `acceptHost`, its button) and the 18-or-older declaration (`adult`, its switch) until
 * it holds them for that version (GET /nodes/mine `terms.accepted`).
 */
export interface TokenAsk {
  region: RegionId;
  name?: string;
  publicHost?: string;
  roles?: NodeRole[];
  matches?: number | 'auto';
  egressCapGB?: number;
  acceptHost?: true;
  adult?: boolean;
}

// ---- reading an answer leniently ------------------------------------------------------------------

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** GET /nodes/mine's body, whatever a server of before sent (no operator, no rewards). */
export function mineAnswerOf(b: unknown): MineAnswer {
  const o = (b ?? {}) as Partial<Record<keyof MineAnswer, unknown>>;
  const op = o.operator as { id?: unknown; trusted?: unknown } | undefined;
  const obj = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    operator: op && typeof op.id === 'string' ? { id: op.id, trusted: op.trusted === true } : null,
    nodes: arr<MineNode>(o.nodes),
    rewards: o.rewards && typeof o.rewards === 'object' ? (o.rewards as Rewards) : null,
    // A11's fields, each only when it came (an older server, a fork: the answer as before).
    ...(obj(o.hosting) ? { hosting: o.hosting as MineAnswer['hosting'] } : {}),
    ...(o.requirements === null || obj(o.requirements) ? { requirements: o.requirements as MineAnswer['requirements'] } : {}),
    ...(o.terms === null || obj(o.terms) ? { terms: o.terms as MineAnswer['terms'] } : {}),
    ...(obj(o.limits) ? { limits: o.limits as MineAnswer['limits'] } : {}),
    ...(Array.isArray(o.tokens) ? { tokens: arr<MineToken>(o.tokens) } : {}),
    ...(typeof o.showPublic === 'boolean' ? { showPublic: o.showPublic } : {}),
    ...(o.channel === null || obj(o.channel) ? { channel: o.channel as MineAnswer['channel'] } : {}),
  };
}

/** An overview as the panel reads it: every list there, even from a server that sent fewer. */
export function overviewOf(b: unknown): Overview {
  const o = (b ?? {}) as Partial<Overview>;
  return {
    at: typeof o.at === 'number' ? o.at : Date.now(),
    build: o.build ?? { version: '', protocol: 0, wasmSha256: '' },
    channel: o.channel ?? null,
    verifying: typeof o.verifying === 'number' ? o.verifying : 0,
    operator: o.operator ?? { id: '', name: '', slotsUsed: 0, slotsMax: 0 },
    nodes: arr(o.nodes),
    tokens: arr(o.tokens),
    regions: arr(o.regions),
    verifiers: arr(o.verifiers),
    verifyQueue: arr(o.verifyQueue),
    outbox: o.outbox ?? { rows: 0, byPath: [] },
    points: arr(o.points),
    flags: arr(o.flags),
    alerts: o.alerts ?? { webhook: true },
    warnings: arr(o.warnings),
    voids24h: arr(o.voids24h),
    ...(typeof o.hosting === 'object' && o.hosting !== null && !Array.isArray(o.hosting) ? { hosting: { ...o.hosting, changes: arr(o.hosting.changes) } } : {}),
  };
}

// ---- refusals in words -----------------------------------------------------------------------------

/**
 * Every code the panel and the wizard can meet (the maintainer gate, the tokens, the nodes, the
 * points, the replays), each with its text under nodesShared.err.*: the panel says it in the
 * player's language whatever the server's message was (Spanish), and the code goes to the console.
 */
export const NODE_ERROR_CODES = [
  // the gate
  'not_trusted',
  'account_required',
  'tv_session',
  'reauth_required',
  'password_required',
  'unauthorized',
  'rate_limited',
  'nodes_off',
  'nodes_unavailable',
  'too_large',
  'bad_request',
  'not_found',
  'internal',
  'network',
  // tokens and registration
  'bad_region',
  'bad_name',
  'bad_public_host',
  'bad_roles',
  'bad_matches',
  'bad_egress_cap',
  'too_many_nodes',
  'verify_reserved',
  'ip_not_supported',
  'public_host_mismatch',
  'bad_token_id',
  'no_token',
  'token_used',
  // nodes
  'no_node',
  'bad_node_id',
  'bad_status',
  'not_reachable',
  'force_required',
  'reason_required',
  'retired',
  'already_retired',
  'not_retirable',
  'offline',
  'not_wss',
  // matches and the history
  'bad_match_id',
  'no_replay',
  'no_match',
  'already_settled',
  'not_verifying',
  'in_flight',
  'bad_cursor',
  // points
  'bad_account',
  'unknown_item',
  'no_user',
  // a community account's hosting (Prompt 2: the token's gate, A1 to A5, A13)
  'hosting_closed',
  'operator_blocked',
  'email_required',
  'deletion_pending',
  'account_too_new',
  'terms_required',
  'adult_required',
  'too_many_tokens',
  'name_taken',
  'rtc_not_available',
  'region_mismatch',
  'bad_public_url',
  // the owner's actions (A12) and the reports (A16)
  'trusted',
  'banned',
  'suspended',
  'project_server',
  'host_deleted',
  'already_reported',
  'too_many_reports',
  'bad_reason',
  'bad_numbers',
  // the opening's flag and the operators (A1, A4)
  'hosting_terms',
  'bad_flag',
  'bad_value',
  'flag_not_written',
  'bad_action',
] as const;

export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(NODE_ERROR_CODES);

/** The text key of a refusal's code; an unknown code reads as the server's trouble. */
export function nodeErrorKey(code: string): Key {
  return `nodesShared.err.${KNOWN_CODES.has(code) ? code : 'internal'}` as Key;
}

/**
 * What a refusal leaves the panel to do, apart from saying it: `reauth` the password sheet (never a
 * retry), `tv` nothing (a TV never gets in), `paused` nodes_off (try again in a minute), `limited`
 * slow down, `gone` the route is not there (a fork, the node settings absent), `denied` not the
 * project's account, `fail` anything else (the text, the data as they were).
 * outcome.ts reads reauth_required, tv_session, not_trusted and too_many_nodes as retries and
 * nodes_off as a wait: the panel decides by this instead.
 */
export type NodeFailure = 'reauth' | 'tv' | 'paused' | 'limited' | 'gone' | 'denied' | 'fail';

export function nodeFailure(e: { code?: string; status?: number } | null | undefined): NodeFailure {
  const code = e?.code ?? '';
  if (code === 'reauth_required' || code === 'password_required') return 'reauth';
  if (code === 'tv_session') return 'tv';
  if (code === 'nodes_off') return 'paused';
  if (code === 'rate_limited' || e?.status === 429) return 'limited';
  if (code === 'not_found' || code === 'nodes_unavailable' || e?.status === 404) return 'gone';
  if (code === 'not_trusted' || code === 'account_required' || code === 'unauthorized') return 'denied';
  return 'fail';
}

// ---- the wizard's checks -----------------------------------------------------------------------------

/** A node's name as the install line carries it (NodeRegistryDO.ts SHELL_NAME, the server's rule). */
export const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
/** The largest egress cap the server takes (NodeRegistryDO.ts EGRESS_CAP_MAX_GB), in GB a month. */
export const EGRESS_CAP_MAX_GB = 1_000_000;
/** The matches a node may declare: 'auto' (its benchmark) or 1 to the registry's MAX_CAPACITY. */
export { MAX_CAPACITY };

/** Why a typed host is not one a node can be pinned to, or null when it is. */
export type HostIssue = 'empty' | 'scheme' | 'port' | 'ip' | 'bad';

/**
 * A host as the wizard takes it: a public DNS name (install.sh is_dns_name, registry.ts
 * validPublicHost), with no scheme, port or path, never an IP address (a Worker cannot probe one).
 * The server checks it again (400 bad_public_host) and whether the name is a public one.
 */
export function hostIssue(raw: string): HostIssue | null {
  const v = raw.trim();
  if (v === '') return 'empty';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('/')) return 'scheme';
  if (v.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(v) || (v.match(/:/g) ?? []).length > 1) return 'ip';
  if (v.includes(':')) return 'port';
  return validPublicHost(v) === null ? 'bad' : null;
}

/** The wizard's form as typed. */
export interface TokenForm {
  region: RegionId | null;
  name: string;
  host: string;
  roles: 'host' | 'host,verify';
  /** 'auto' or a whole number, as typed. */
  matches: string;
  /** A whole number of GB a month, or '' for none. */
  egress: string;
}

export type FormIssue = 'region' | 'name' | 'host' | 'matches' | 'egress' | 'slots';

/**
 * Each field's problem (the first one per field), and no slot left; empty when the token may be
 * asked for. `nameOptional`: an empty name is the server's default (a community server's form,
 * "Mis servidores"); the project's wizard names every machine.
 */
export function tokenFormIssues(f: TokenForm, slots: { used: number; max: number } | null, nameOptional = false): Array<{ field: FormIssue; host?: HostIssue }> {
  const out: Array<{ field: FormIssue; host?: HostIssue }> = [];
  if (f.region === null || !isRegion(f.region)) out.push({ field: 'region' });
  const name = f.name.trim();
  if (!(nameOptional && name === '') && !NODE_NAME_RE.test(name)) out.push({ field: 'name' });
  const h = hostIssue(f.host);
  if (h !== null) out.push({ field: 'host', host: h });
  const m = f.matches.trim().toLowerCase();
  if (m !== 'auto' && !(/^\d{1,3}$/.test(m) && Number(m) >= 1 && Number(m) <= MAX_CAPACITY)) out.push({ field: 'matches' });
  const e = f.egress.trim();
  if (e !== '' && !(/^\d{1,7}$/.test(e) && Number(e) >= 1 && Number(e) <= EGRESS_CAP_MAX_GB)) out.push({ field: 'egress' });
  if (slots !== null && slots.used >= slots.max) out.push({ field: 'slots' });
  return out;
}

/** POST /nodes/tokens's body from a form with no issue: a wss host pinned to its name. */
export function tokenAskOf(f: TokenForm): TokenAsk {
  const m = f.matches.trim().toLowerCase();
  const e = f.egress.trim();
  const name = f.name.trim();
  return {
    region: f.region as RegionId,
    ...(name !== '' ? { name } : {}),
    publicHost: f.host.trim().toLowerCase(),
    roles: f.roles === 'host' ? ['host'] : ['host', 'verify'],
    matches: m === 'auto' ? 'auto' : Number(m),
    ...(e !== '' ? { egressCapGB: Number(e) } : {}),
  };
}

/** What an install line may hold beyond its spaces (NodeRegistryDO.ts SHELL_WORD) and the pipe between curl and bash. */
const LINE_WORD = /^[A-Za-z0-9._:/,|-]+$/;

/**
 * The server's install line carries what the wizard asked for, and nothing a shell would read as
 * anything but words: its flags with the asked values (--public-host, --roles, --transport wss,
 * --matches, --egress-cap-gb), every word made of the safe characters. The panel shows the line
 * only then (a server of before, or a mistake, gets the "ask again" line instead).
 */
export function installLineMatches(line: string, ask: TokenAsk): boolean {
  const words = line.trim().split(/ +/);
  if (!words.every((w) => LINE_WORD.test(w))) return false;
  if (words[0] !== 'curl' || !words.includes('bash')) return false;
  const value = (flag: string): string | null => {
    const i = words.indexOf(flag);
    return i >= 0 && i + 1 < words.length ? words[i + 1] : null;
  };
  if (value('--token') === null || value('--control') === null) return false;
  if (ask.publicHost !== undefined && (value('--public-host') !== ask.publicHost || value('--transport') !== 'wss')) return false;
  if (ask.roles !== undefined && value('--roles') !== ask.roles.join(',')) return false;
  if (ask.matches !== undefined && value('--matches') !== String(ask.matches)) return false;
  if (ask.egressCapGB !== undefined && value('--egress-cap-gb') !== String(ask.egressCapGB)) return false;
  if (ask.name !== undefined && ask.name !== '' && value('--name') !== ask.name) return false;
  return true;
}

// ---- states, presets, addresses ----------------------------------------------------------------------

/** A node's state as a colour: active ok, on trial warn, pending muted, suspended or banned bad (a retired one muted). */
export type Tone = 'ok' | 'warn' | 'muted' | 'bad';

export function statusTone(status: NodeStatus, retired = false): Tone {
  if (retired) return 'muted';
  if (status === 'active') return 'ok';
  if (status === 'probation') return 'warn';
  if (status === 'pending') return 'muted';
  return 'bad';
}

/**
 * The project's machines the wizard fills in (PROJECT_PRESETS): a name and a region only. Their DNS
 * names, providers and caps are the maintainer's private notes, never in this bundle (decision 9).
 */
export const PROJECT_PRESETS: ReadonlyArray<{ name: string; region: RegionId }> = [
  { name: 'frankfurt-1', region: 'EU' },
  { name: 'kuala-lumpur-1', region: 'AS' },
];

/** The project's default roles for its machines (PROJECT_DEFAULT_ROLES): hosts that verify. */
export const PROJECT_DEFAULT_ROLES: TokenForm['roles'] = 'host,verify';

/**
 * A node's address as the panel shows it until asked: its first character and its last label
 * ('wss://sao-paulo-1.example.com' -> 's•••.com'), no scheme, port or path; '' for nothing.
 */
export function maskAddress(v: string | null): string {
  if (v === null || v === '') return '';
  let host = v;
  try {
    host = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? new URL(v).hostname : v.split('/')[0].split(':')[0];
  } catch {
    host = v;
  }
  const labels = host.split('.').filter(Boolean);
  if (labels.length === 0) return '•••';
  const last = labels.length > 1 ? '.' + labels[labels.length - 1] : '';
  return `${labels[0].slice(0, 1)}•••${last}`;
}

/** The account is one of the project's maintainers (/api/me's maintainer, sent to them only and never to a TV). */
export function isMaintainer(me: MeInfo | null | undefined): boolean {
  return me?.maintainer !== undefined;
}

/** The ids of the game's regions, in the menu's order. */
export const REGION_IDS: readonly RegionId[] = REGIONS.map((r) => r.id);

/**
 * What a failed reachability probe most likely needs (the wizard's follow-up, the node's detail):
 * the DNS record, the ports 80 / 443, an earlier Caddyfile (or another server) answering on the
 * name, the certificate; null when the words say nothing the panel knows (probeFailure's, in
 * controlPlane.ts, and NodeRegistryDO.probeJson's).
 */
export type ProbeHint = 'dns' | 'ports' | 'caddy' | 'cert';

export function probeHint(error: string | null): ProbeHint | null {
  if (error === null || error === '') return null;
  const e = error.toLowerCase();
  if (/cert|tls|ssl|handshake|525|526/.test(e)) return 'cert';
  if (/dns|resolve|enotfound|getaddrinfo|not a public address|refused target/.test(e)) return 'dns';
  if (/timeout|timed out|abort|econnrefused|connection refused|unreachable|fetch failed|network/.test(e)) return 'ports';
  if (/bad json|bad answer|http \d|not json|html|ok: true|signed/.test(e)) return 'caddy';
  return null;
}

/** The match a node was suspended for: `verification_failed:<matchId>` (registry.ts), or null. */
export function verificationMatch(reason: string | null): string | null {
  const m = /^verification_failed:([0-9a-f]{64})$/.exec(reason ?? '');
  return m ? m[1] : null;
}

/** A public replay's viewer link (replay.html?id=) for a match id of 64 hex, else null: never a server text in an href unchecked. */
export function replayHref(matchId: string | null): string | null {
  return matchId !== null && /^[0-9a-f]{64}$/.test(matchId) ? `./replay.html?id=${encodeURIComponent(matchId)}` : null;
}

/**
 * A match id PARTIDAS looks up: its 64 hex alone, or the `id` of a replay link a player sends
 * (replay.html?id=<matchId>, whole or not), lower case; else null.
 */
export function matchIdOf(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  let id: string | null = null;
  try {
    id = new URL(v, 'https://replay.invalid/').searchParams.get('id');
  } catch {
    return null;
  }
  return id !== null && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/** An account id the points tab looks up: 16 hex, lower case. */
export function accountIdOf(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(v) ? v : null;
}
