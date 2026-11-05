/**
 * NodeStore: the NodeRegistryDO's tables on its SQLite storage (ctx.storage.sql);
 * server/test/nodeRegistry.test.mjs runs the same SQL on node:sqlite. The rows are persist.ts's:
 * the columns the object indexes plus a JSON `data` column with the rest. Synchronous like
 * AccountStore, and on purpose: the control plane writes a row before the message that depends on
 * it goes out, and a Durable Object holds its outgoing messages only for the writes issued before
 * the send.
 *
 * Tables
 *   meta          k -> v; 'state_version': the persist.ts STATE_VERSION the rows were written in;
 *                 'drains_asked': the node processes the object told to drain (NodeRegistryDO)
 *   node_tokens   registration tokens (only their hash), pruned an hour after they expire (at each
 *                 new token and on the cron: Registry.pruneTokens)
 *   nodes         every registered node
 *   node_matches  the matches the control plane keeps (settled ones until its retention ends)
 *   outbox        the calls of each settled match (nodeOutcome.ts), until each is delivered
 *   ledger_entries the rewards ledger (nodes/control-plane/ledger.ts): one row per scored match,
 *                 written with the match it settles; kept WINDOW_DAYS (the leaderboard, the summaries)
 *   ledger_totals every operator's all-time points and verified matches (countsAsHosted: one that
 *                 served someone else), updated in the same transaction as its entry
 *   ledger_notes  the repeat decay's notes of matches that earned nothing by themselves, kept 24 h
 *   replay_index  the public replay list (replayIndex.ts): one row per settled, not voided match
 *                 with a replay, written with the match it settles; kept as long as R2 keeps replays
 *                 (REPLAY_INDEX_DAYS: pruned with their R2 objects by the cron, nodes_off or not) and
 *                 served by whole settle hours (replayServedSpan): the matches of hour H from H + 2 h,
 *                 1 to 2 hours after each settled, until H + 30 days
 *   replay_players each listed match's human seats and their player ids (replayIndex.ts replaySeats),
 *                 never served: whose name a served row hides ('Jugador N', AccountsDO replay_names).
 *                 A row listed before this table has no seats (a legacy row): its names are looked up
 *                 by name instead (NodeRegistryDO)
 * Ledger.restore reads the three back at every start (ledgerSnapshot): a deploy keeps the decay,
 * the leaderboard and the summaries. The points themselves go to the operator's account (AccountsDO
 * host_credits, through the outbox), which keeps them for good.
 *
 * The maintainers' history (GET /nodes/admin/events, /history, /alerts), each kept HISTORY_DAYS, never
 * read past it, and pruned as it is written and by the cron, nodes_off or not (historyOldest):
 *   node_events   what happened to each node (registry.ts NodeEventKind): written through the sink
 *                 the Registry and the ControlPlane are given (NodeRegistryDO nodeEvent), with the
 *                 maintainer who made it happen when one did; at most NODE_EVENTS_MAX rows
 *   node_match_history every settled match, void ones included: its node, times, outcome, reason,
 *                 verdict, verifier, strike and whether it had a replay (MatchHistory), written in the
 *                 transaction that settles it; delisted_at once a maintainer delisted its replay
 *   node_match_players its human seats (name and player id, both for the maintainers only, ids never
 *                 served elsewhere): a purged account's are blanked (forgetPlayer, at
 *                 /internal/operator-deleted), a name its player hides is left out when read (NodeRegistryDO)
 *   node_forgotten the ids of those purged accounts (no name, nothing else), kept HISTORY_DAYS: a
 *                 match held when its player was purged settles later, and its seat is written blank
 *                 (AccountsDO tells the purge once). The open matches leave them out too (forgotten)
 *   node_alerts   the ALERT lines the object posts to the team's channel (log and audit), whether or
 *                 not a webhook is set, as the channel gets them (the same alert once in 10 minutes,
 *                 every audit line): a ring of ALERT_RING_MAX lines; the community nodes' too
 *
 * Hosting by the community (Prompt 2: A1, A2, A4, A14):
 *   operators     one row per operator outside the project a maintainer acted on or that chose to
 *                 show its name: its status (ok, blocked) with the reason, who set it and when, and
 *                 show_public (the opt-in: its name in the public list). No deadline, like the
 *                 nodes' records; when the account is purged a maintainer's row stays under an
 *                 opaque key (deleted:<hex>), with show_public 0, and an opt-in's goes (forgetOperator)
 *   admin_audit   every change of the KV flag node_operators (the opening): who, when, the value
 *                 before and after (the canary's account ids; a purged account's becomes 'deleted'),
 *                 the reason. ADMIN_AUDIT_DAYS
 *   operator_tokens one row per community node token minted (the operator, when): the day's cap
 *                 counts them across deploys. A day, then pruned; a purged account's go at once
 *   node_reports  a player's report of a community server it played on (Prompt 2, A16): the match,
 *                 the node and its operator, the reason picked from a closed list, the client's ping
 *                 and position corrections, and the account that reported (one row per match and
 *                 account). For the maintainers only (the Operadores tab), never its host's, and
 *                 never a sanction by itself. REPORT_DAYS, pruned as it is written, at the start and
 *                 by the cron; a purged account's go at once, and a purged operator's id in them
 *                 becomes its opaque key (forgetOperator); none about its servers is taken after the
 *                 purge (NodeRegistryDO report: 409 host_deleted), so its id never comes back
 */
import { STATE_VERSION, matchToRow, nodeToRow, tokenToRow } from '../../nodes/control-plane/persist';
import type { MatchRow, MatchStore, NodeRow, RegistryStore, TokenRow } from '../../nodes/control-plane/persist';
import type { MatchEntry, MatchOutcome, MatchState } from '../../nodes/control-plane/controlPlane';
import { REPEAT_WINDOW_MS, WINDOW_DAYS, countsAsHosted } from '../../nodes/control-plane/ledger';
import type { GroupNote, LedgerEntry, LedgerSnapshot } from '../../nodes/control-plane/ledger';
import { TOKEN_TTL_MS } from '../../nodes/control-plane/registry';
import type { NodeEventKind, NodeRecord, TokenRecord } from '../../nodes/control-plane/registry';
import type { GameMode, NodeTransport } from '../../nodes/shared/controlProtocol';
import type { SqlLike } from './accountStore';
import { outcomeCalls } from './nodeOutcome';
import type { OutcomeCall } from './nodeOutcome';
import { HOUR_MS, REPLAY_INDEX_DAYS, replayIndexItem, replayServedSpan, replaySeats } from './replayIndex';
import type { ReplayIndexRow, ReplaySeat } from './replayIndex';
import type { ReplayListItem } from '../../src/net/replays';

const DAY_MS = 24 * 60 * 60_000;
/** How long the maintainers' history keeps its rows (node_events, node_match_history, node_alerts): HISTORY_RETENTION. */
export const HISTORY_DAYS = 30;
/** The ALERT lines node_alerts keeps at most, the newest (ALERT_RING_MAX). */
export const ALERT_RING_MAX = 2000;
/** The node events kept at most, the newest: a node that reconnects all day must not grow the table without end. */
export const NODE_EVENTS_MAX = 100_000;
/** History rows a write prunes at most on its way (the cron's prune takes REPLAY_PRUNE_MAX). */
const HISTORY_PRUNE_ON_WRITE = 50;
/** Player ids one node_forgotten query asks for at most (a Durable Object's SQL binds 100 values a query). */
const FORGOTTEN_ASK_MAX = 50;
/** A row's settle hour in SQL (integer division: `at` is an INTEGER), the expression replay_index_hour indexes. */
const REPLAY_HOUR_SQL = `(at / ${HOUR_MS})`;
/** Rows one prune deletes at most (the cron's, every 5 minutes): bounded work on the object's thread. */
const REPLAY_PRUNE_MAX = 2000;
/** How long admin_audit keeps a change of the opening's flag (the owner's: a year, like the Discord channel's lines). */
export const ADMIN_AUDIT_DAYS = 365;
/** How long operator_tokens keeps a minted token's row: the day the cap counts. */
const OPERATOR_TOKENS_MS = DAY_MS;
/** How long node_reports keeps a player's report (the owner's retention: 30 days). */
export const REPORT_DAYS = 30;
/** The reasons a report picks from (A16): its car did not answer, lag only for the player, a drop, something else. */
export const REPORT_REASONS = ['unresponsive', 'lag', 'disconnected', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** A player's report of a community server (node_reports). */
export interface ReportRow {
  at: number;
  /** The account that reported. */
  reporterId: string;
  matchId: string;
  nodeId: string;
  /** The node's operator when it was reported (its opaque key once that account is purged). */
  operatorId: string;
  reason: ReportReason;
  /** The client's numbers, informative only (a modified client can say anything): its ping in ms, its position corrections. */
  ping: number | null;
  corrections: number | null;
}

/** An operator outside the project as the object keeps it (operators). */
export interface OperatorRow {
  operatorId: string;
  status: 'ok' | 'blocked';
  reason: string | null;
  /** The maintainer who set the status ('name (account id)'), null for a row only the opt-in wrote. */
  actor: string | null;
  /** When the status was set (or the row first written). */
  at: number;
  /** The operator chose to show its name in the public list. */
  showPublic: boolean;
}

/** One change of the opening's flag (admin_audit). */
export interface AdminAuditRow {
  id: number;
  at: number;
  actor: string;
  flag: string;
  old: string | null;
  new: string | null;
  reason: string | null;
}

/** The oldest time the maintainers' history keeps at `now` (HISTORY_DAYS): an older row is pruned, and never read before that. */
function historyOldest(now: number): number {
  return now - HISTORY_DAYS * DAY_MS;
}

/** A served row as the object reads it: the stored item and its human seats (null: a row from before replay_players). */
export interface ReplayRow {
  item: ReplayListItem;
  seats: ReplaySeat[] | null;
}

/** Where a page of the public list starts: after this row in the public order (its settle hour, then its id). */
export interface ReplayCursor {
  hour: number;
  matchId: string;
}

/** A note's player ids ([] when the row does not read). */
function playersOf(v: string): string[] {
  try {
    const o: unknown = JSON.parse(v);
    return Array.isArray(o) ? o.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** One settled match as the maintainers' history keeps it (node_match_history's data): never served outside the panel. */
export interface MatchHistory {
  matchId: string;
  nodeId: string;
  region: string;
  mode: GameMode;
  ranked: boolean;
  transport: NodeTransport;
  /** When it was placed, when its report came (null: none did) and when it settled. */
  placedAt: number;
  reportedAt: number | null;
  settledAt: number;
  result: MatchOutcome['kind'];
  /** A void's reason (admin_void for a maintainer's); else how it ended, the verdict's or, unverified, the node's word. */
  reason: string | null;
  /** The score of a rated or unrated match (a void's is nobody's). */
  score: { blue: number; red: number } | null;
  /** A verifier re-simulated it (a rated match always; a void one when its verdict voided it). */
  verified: boolean;
  /** The node (or 'control-plane') whose verdict it got, when it got one. */
  verifiedBy: string | null;
  verdict: { ok: boolean; code: string } | null;
  /** The node's fault it was void for (MatchEntry.strike), or null. */
  strike: string | null;
  /** The node uploaded its replay (what GET /nodes/admin/replay serves while R2 keeps it). */
  replay: boolean;
  /** The points its community operator earned for it, or null. */
  points: number | null;
  /** Its failed verification froze its operator's wallet. */
  frozen: boolean;
  /** A maintainer's reason when one voided it. */
  adminReason: string | null;
  /** Every seat: whose is in node_match_players (a human's), a bot's is only its slot and team. */
  seats: Array<{ slot: number; team: 0 | 1; bot: boolean }>;
}

/** A human seat of a history row: null name and id once its account was purged (forgetPlayer). */
export interface HistorySeat {
  slot: number;
  playerId: string | null;
  name: string | null;
}

/** A history row as the object reads it: whether its replay is in the public list, and served there now (replayServedSpan). */
export interface HistoryRow {
  match: MatchHistory;
  players: HistorySeat[];
  delistedAt: number | null;
  listed: boolean;
  published: boolean;
}

/** Where a page of the history starts: after this row, newest first (its settle time, then its id). */
export interface HistoryCursor {
  at: number;
  matchId: string;
}

export interface NodeEventRow {
  id: number;
  nodeId: string;
  at: number;
  kind: NodeEventKind;
  detail: string | null;
  /** The maintainer whose call it was ('name (account id)'), or null. */
  actor: string | null;
}

export interface AlertRow {
  id: number;
  at: number;
  /** 'alert': something the object saw go wrong (deduplicated on the channel); 'audit': what an account did (every one). */
  kind: 'alert' | 'audit';
  line: string;
}

/** A settled match's history row and its human seats (written by NodeStore.finished). */
export function matchHistoryOf(m: MatchEntry, o: MatchOutcome): { match: MatchHistory; players: HistorySeat[] } {
  const r = m.report;
  const ended = r?.kind === 'ended' ? r.result : null;
  const score = o.kind === 'void' ? null : { blue: o.blue, red: o.red };
  const reason = o.kind === 'void' ? o.reason : (m.verdict?.endReason ?? ended?.endReason ?? null);
  const verified = o.kind === 'rated' || (o.kind === 'unrated' ? o.verified : m.verdict !== null);
  return {
    match: {
      matchId: m.assign.matchId,
      nodeId: m.nodeId,
      region: m.assign.region,
      mode: m.assign.mode,
      ranked: m.assign.ranked,
      transport: m.transport,
      placedAt: m.assign.createdAt,
      reportedAt: m.reportedAt > 0 ? m.reportedAt : null,
      settledAt: m.doneAt,
      result: o.kind,
      reason,
      score,
      verified,
      verifiedBy: m.verdict ? m.verifiedBy : null,
      verdict: m.verdict ? { ok: m.verdict.ok, code: m.verdict.code } : null,
      strike: m.strike ?? null,
      replay: m.replaySha !== null,
      points: m.ledger ? m.ledger.points : null,
      frozen: m.freeze !== undefined,
      adminReason: m.adminReason ?? null,
      seats: m.assign.roster.map((e) => ({ slot: e.slot, team: e.team, bot: !(e.kind === 'player' && e.playerId) })),
    },
    players: m.assign.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => ({ slot: e.slot, playerId: e.playerId as string, name: e.name })),
  };
}

/** One undelivered call. */
export interface OutboxRow extends OutcomeCall {
  id: number;
  /** Failed deliveries so far. */
  attempts: number;
  createdAt: number;
}

export class NodeStore implements RegistryStore, MatchStore {
  private readonly sql: SqlLike;
  private readonly tx: <T>(fn: () => T) => T;
  /** Called after outbox rows were written: the object delivers them right away. */
  private readonly onOutbox: () => void;
  private readonly now: () => number;
  /** Each node's row as last written or read (node(): an unchanged one is not written again). */
  private readonly written = new Map<string, string>();

  constructor(sql: SqlLike, tx: <T>(fn: () => T) => T, onOutbox: () => void = () => undefined, now: () => number = () => Date.now()) {
    this.sql = sql;
    this.tx = tx;
    this.onOutbox = onOutbox;
    this.now = now;
  }

  /**
   * Create the tables (idempotent). Throws when the rows were written in another state version:
   * a newer one means a rollback below the build that wrote them, and reading them with this
   * build's meaning (or writing over them) would lose what they hold.
   */
  migrate(): void {
    const s = this.sql;
    s.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS node_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS node_matches (match_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, state TEXT NOT NULL, done_at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS node_matches_state ON node_matches (state, done_at)');
    s.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, target TEXT NOT NULL, path TEXT NOT NULL,
      body TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    s.exec('CREATE INDEX IF NOT EXISTS outbox_next ON outbox (next_at)');
    s.exec('CREATE TABLE IF NOT EXISTS ledger_entries (match_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS ledger_entries_at ON ledger_entries (at)');
    s.exec('CREATE TABLE IF NOT EXISTS ledger_totals (operator_id TEXT PRIMARY KEY, earned REAL NOT NULL, verified INTEGER NOT NULL)');
    s.exec('CREATE TABLE IF NOT EXISTS ledger_notes (operator_id TEXT NOT NULL, players TEXT NOT NULL, at INTEGER NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS ledger_notes_at ON ledger_notes (at)');
    s.exec('CREATE TABLE IF NOT EXISTS replay_index (match_id TEXT PRIMARY KEY, at INTEGER NOT NULL, sha TEXT NOT NULL, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS replay_index_at ON replay_index (at)');
    // The public order: the settle hour (what the list shows), then the match id, so nothing orders
    // the matches of one hour by their exact times.
    s.exec(`CREATE INDEX IF NOT EXISTS replay_index_hour ON replay_index (${REPLAY_HOUR_SQL}, match_id)`);
    s.exec('CREATE TABLE IF NOT EXISTS replay_players (match_id TEXT NOT NULL, slot INTEGER NOT NULL, player_id TEXT NOT NULL, PRIMARY KEY (match_id, slot))');
    s.exec('CREATE INDEX IF NOT EXISTS replay_players_player ON replay_players (player_id)');
    s.exec('CREATE TABLE IF NOT EXISTS replay_stars (match_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY (match_id, account_id))');
    s.exec('CREATE INDEX IF NOT EXISTS replay_stars_account ON replay_stars (account_id)');
    // The maintainers' history, added later like the replay tables: new tables, the state version unchanged.
    s.exec('CREATE TABLE IF NOT EXISTS node_events (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, actor TEXT)');
    s.exec('CREATE INDEX IF NOT EXISTS node_events_at ON node_events (at)');
    s.exec('CREATE INDEX IF NOT EXISTS node_events_node ON node_events (node_id, id)');
    s.exec('CREATE TABLE IF NOT EXISTS node_match_history (match_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL, reason TEXT, delisted_at INTEGER, data TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS node_match_history_at ON node_match_history (at, match_id)');
    s.exec('CREATE INDEX IF NOT EXISTS node_match_history_node ON node_match_history (node_id, at, match_id)');
    s.exec('CREATE TABLE IF NOT EXISTS node_match_players (match_id TEXT NOT NULL, slot INTEGER NOT NULL, player_id TEXT, name TEXT, PRIMARY KEY (match_id, slot))');
    s.exec('CREATE INDEX IF NOT EXISTS node_match_players_player ON node_match_players (player_id)');
    s.exec('CREATE TABLE IF NOT EXISTS node_forgotten (player_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS node_forgotten_at ON node_forgotten (at)');
    s.exec('CREATE TABLE IF NOT EXISTS node_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, line TEXT NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS node_alerts_at ON node_alerts (at)');
    // Hosting by the community: new tables again, the state version unchanged.
    s.exec("CREATE TABLE IF NOT EXISTS operators (operator_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok', reason TEXT, actor TEXT, at INTEGER NOT NULL, show_public INTEGER NOT NULL DEFAULT 0)");
    s.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, flag TEXT NOT NULL, old TEXT, new TEXT, reason TEXT)');
    s.exec('CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at)');
    s.exec('CREATE TABLE IF NOT EXISTS operator_tokens (operator_id TEXT NOT NULL, at INTEGER NOT NULL)');
    s.exec('CREATE INDEX IF NOT EXISTS operator_tokens_op ON operator_tokens (operator_id, at)');
    // The players' reports of community servers (A16): a new table again, the state version unchanged.
    s.exec(`CREATE TABLE IF NOT EXISTS node_reports (
      match_id TEXT NOT NULL, reporter_id TEXT NOT NULL, at INTEGER NOT NULL, node_id TEXT NOT NULL, operator_id TEXT NOT NULL,
      reason TEXT NOT NULL, ping INTEGER, corrections INTEGER, PRIMARY KEY (match_id, reporter_id))`);
    s.exec('CREATE INDEX IF NOT EXISTS node_reports_at ON node_reports (at)');
    s.exec('CREATE INDEX IF NOT EXISTS node_reports_reporter ON node_reports (reporter_id, at)');
    s.exec('CREATE INDEX IF NOT EXISTS node_reports_operator ON node_reports (operator_id, at)');
    const v = s.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'state_version'").toArray()[0]?.v;
    if (v === undefined) {
      s.exec("INSERT INTO meta (k, v) VALUES ('state_version', ?)", String(STATE_VERSION));
    } else if (Number(v) !== STATE_VERSION) {
      throw new Error(`the rows are in state version ${v} and this build reads version ${STATE_VERSION}${Number(v) > STATE_VERSION ? ': a newer build wrote them' : ''}`);
    }
  }

  /** Every row the Registry and the ControlPlane restore. Tokens are pruned as Registry.createToken prunes them. */
  load(now: number): { tokens: TokenRow[]; nodes: NodeRow[]; matches: MatchRow[] } {
    const s = this.sql;
    s.exec('DELETE FROM node_tokens WHERE expires_at < ?', now - TOKEN_TTL_MS);
    s.exec('DELETE FROM node_reports WHERE at < ?', now - REPORT_DAYS * DAY_MS);
    const tokens = s
      .exec<{ hash: string; expires_at: number; data: string }>('SELECT hash, expires_at, data FROM node_tokens')
      .toArray()
      .map((r) => ({ hash: r.hash, expiresAt: Number(r.expires_at), data: r.data }));
    const nodes = s
      .exec<{ node_id: string; operator_id: string; public_key: string; data: string }>('SELECT node_id, operator_id, public_key, data FROM nodes')
      .toArray()
      .map((r) => ({ nodeId: r.node_id, operatorId: r.operator_id, publicKey: r.public_key, data: r.data }));
    for (const n of nodes) this.written.set(n.nodeId, `${n.operatorId}\n${n.publicKey}\n${n.data}`);
    const matches = s
      .exec<{ match_id: string; node_id: string; state: string; done_at: number; data: string }>('SELECT match_id, node_id, state, done_at, data FROM node_matches')
      .toArray()
      .map((r) => ({ matchId: r.match_id, nodeId: r.node_id, state: r.state as MatchState, doneAt: Number(r.done_at), data: r.data }));
    return { tokens, nodes, matches };
  }

  /** A meta value of the object's own (not a control plane row), or null. */
  meta(k: string): string | null {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // ---- RegistryStore ------------------------------------------------------------------------

  /**
   * A node's row, written only when what it holds changed: the registry saves at every hello (and
   * its live fields, which the row leaves out, change at every heartbeat), and a node repeating the
   * same hello must not cost a row write each time.
   */
  node(n: NodeRecord): void {
    const r = nodeToRow(n);
    const row = `${r.operatorId}\n${r.publicKey}\n${r.data}`;
    if (this.written.get(r.nodeId) === row) return;
    this.sql.exec(
      'INSERT INTO nodes (node_id, operator_id, public_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET operator_id = excluded.operator_id, public_key = excluded.public_key, data = excluded.data',
      r.nodeId,
      r.operatorId,
      r.publicKey,
      r.data,
    );
    this.written.set(r.nodeId, row);
  }

  register(t: TokenRecord, n: NodeRecord): void {
    try {
      this.tx(() => {
        this.tokens([t]);
        this.node(n);
      });
    } catch (e) {
      this.written.delete(n.nodeId); // rolled back: the row is not what was last written
      throw e;
    }
  }

  tokens(ts: TokenRecord[]): void {
    for (const t of ts) {
      const r = tokenToRow(t);
      this.sql.exec('INSERT INTO node_tokens (hash, expires_at, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data', r.hash, r.expiresAt, r.data);
    }
  }

  dropTokens(hashes: string[]): void {
    for (const h of hashes) this.sql.exec('DELETE FROM node_tokens WHERE hash = ?', h);
  }

  // ---- MatchStore ---------------------------------------------------------------------------

  save(m: MatchEntry): void {
    const r = matchToRow(m);
    this.sql.exec(
      'INSERT INTO node_matches (match_id, node_id, state, done_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET node_id = excluded.node_id, state = excluded.state, done_at = excluded.done_at, data = excluded.data',
      r.matchId,
      r.nodeId,
      r.state,
      r.doneAt,
      r.data,
    );
  }

  /**
   * The settled row and the calls that deliver its outcome, in one transaction: a match is never
   * settled without them, nor delivered without being settled. The object is told afterwards.
   */
  finished(m: MatchEntry, o: MatchOutcome): void {
    const humans = m.assign.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
    const calls = outcomeCalls(o, m.assign, humans, m);
    const history = matchHistoryOf(m, o);
    const now = this.now();
    this.tx(() => {
      this.save(m);
      // Its points: the ledger's row and totals, and the operator's credit (an outbox row below).
      if (m.ledger) this.ledgerEntry(m.ledger, now);
      for (const c of calls) {
        this.sql.exec('INSERT INTO outbox (match_id, target, path, body, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)', c.matchId, c.target, c.path, c.body, now, now);
      }
      // The maintainers' history: never a settled match without its row.
      this.historyRow(history, now);
    });
    // Outside the settling transaction and never thrown: a row that fails only leaves the match unlisted.
    try {
      const listed = replayIndexItem(m, o);
      if (listed && m.replaySha) this.replayRow(listed, m.replaySha, replaySeats(m));
    } catch (e) {
      console.error(`replay index ${m.assign.matchId}: ${String(e)}`);
    }
    this.onOutbox();
  }

  // ---- the public replay index -------------------------------------------------------------

  private replayRow(item: ReplayListItem, sha: string, seats: readonly ReplaySeat[]): void {
    this.tx(() => {
      this.sql.exec('INSERT INTO replay_index (match_id, at, sha, data) VALUES (?, ?, ?, ?) ON CONFLICT(match_id) DO NOTHING', item.matchId, item.at, sha, JSON.stringify(item));
      for (const p of seats) this.sql.exec('INSERT INTO replay_players (match_id, slot, player_id) VALUES (?, ?, ?) ON CONFLICT(match_id, slot) DO NOTHING', item.matchId, p.slot, p.playerId);
    });
  }

  /** The rows past REPLAY_INDEX_DAYS go (the oldest `max`), with their seats. Returns their match ids: their R2 objects go too (NodeRegistryDO). */
  pruneReplays(now: number, max: number = REPLAY_PRUNE_MAX): string[] {
    const ids = this.sql
      .exec<{ match_id: string }>('SELECT match_id FROM replay_index WHERE at < ? ORDER BY at LIMIT ?', now - REPLAY_INDEX_DAYS * DAY_MS, max)
      .toArray()
      .map((r) => r.match_id);
    if (ids.length === 0) return [];
    this.tx(() => {
      for (const id of ids) {
        this.sql.exec('DELETE FROM replay_players WHERE match_id = ?', id);
        this.sql.exec('DELETE FROM replay_stars WHERE match_id = ?', id);
        this.sql.exec('DELETE FROM replay_index WHERE match_id = ?', id);
      }
    });
    return ids;
  }

  /**
   * The served rows (replayServedSpan: whole settle hours, released 1 to 2 hours after they settled,
   * gone before 30 days) in the public order, after `cursor` (null: from the newest), at most
   * `limit`, each with its seats.
   */
  replayList(cursor: ReplayCursor | null, limit: number): ReplayRow[] {
    const { newest, oldest } = replayServedSpan(this.now());
    const span = [newest, oldest];
    // `+at`: the time window is a filter, never the index, so SQLite walks replay_index_hour in order and
    // stops at `limit` (with replay_index_at it sorted the whole window: 0.1 ms against 300 ms for
    // 300,000 rows). The cursor's hour is the index's range; a row-value or an OR form would scan from the top.
    const order = `ORDER BY ${REPLAY_HOUR_SQL} DESC, match_id DESC LIMIT ?`;
    const rows = cursor
      ? this.sql
          .exec<{ data: string }>(`SELECT data FROM replay_index WHERE +at < ? AND +at >= ? AND ${REPLAY_HOUR_SQL} <= ? AND NOT (${REPLAY_HOUR_SQL} = ? AND match_id >= ?) ${order}`, ...span, cursor.hour, cursor.hour, cursor.matchId, limit)
          .toArray()
      : this.sql.exec<{ data: string }>(`SELECT data FROM replay_index WHERE +at < ? AND +at >= ? ${order}`, ...span, limit).toArray();
    return this.withSeatsAndStars(rows.map((r) => JSON.parse(r.data) as ReplayListItem));
  }

  /** Rows with their seats and star counts. */
  private withSeatsAndStars(items: ReplayListItem[]): ReplayRow[] {
    const ids = items.map((i) => i.matchId);
    const seats = this.seatsOf(ids);
    const stars = this.starCounts(ids);
    return items.map((item) => ({ item: { ...item, stars: stars.get(item.matchId) ?? 0 }, seats: seats.get(item.matchId) ?? null }));
  }

  /** How many accounts starred each of `matchIds` (0 is absent). */
  private starCounts(matchIds: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (matchIds.length === 0) return out;
    const marks = matchIds.map(() => '?').join(', ');
    for (const r of this.sql.exec<{ match_id: string; n: number }>(`SELECT match_id, COUNT(*) AS n FROM replay_stars WHERE match_id IN (${marks}) GROUP BY match_id`, ...matchIds).toArray()) out.set(r.match_id, Number(r.n));
    return out;
  }

  /** The served matches with the most stars (at least one), the newest among equals: at most `limit`. */
  replayTop(limit: number): ReplayRow[] {
    const { newest, oldest } = replayServedSpan(this.now());
    const rows = this.sql
      .exec<{ data: string }>(
        'SELECT i.data AS data FROM replay_index i JOIN (SELECT match_id, COUNT(*) AS n FROM replay_stars GROUP BY match_id) s ON s.match_id = i.match_id WHERE +i.at < ? AND +i.at >= ? ORDER BY s.n DESC, i.at DESC, i.match_id DESC LIMIT ?',
        newest,
        oldest,
        limit,
      )
      .toArray();
    return this.withSeatsAndStars(rows.map((r) => JSON.parse(r.data) as ReplayListItem));
  }

  /**
   * The served matches `accountId` played in, newest first, at most `limit`: by its seat, and, for a
   * row listed before the seats were kept (a legacy row: no seat at all, the first days of the
   * replays, gone within 30 days), by the account's name (`name`: its username, which no guest or
   * hidden name can be: those have a space). Both kinds in one list, once each.
   */
  replayMine(accountId: string, name: string, limit: number): ReplayRow[] {
    const { newest, oldest } = replayServedSpan(this.now());
    const bySeat = this.sql
      .exec<{ data: string }>(
        'SELECT i.data AS data FROM replay_players p JOIN replay_index i ON i.match_id = p.match_id WHERE p.player_id = ? AND +i.at < ? AND +i.at >= ? ORDER BY i.at DESC, i.match_id DESC LIMIT ?',
        accountId,
        newest,
        oldest,
        limit,
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as ReplayListItem);
    let legacy: ReplayListItem[] = [];
    if (name !== '' && !/\s/.test(name)) {
      // `instr` over the stored JSON, not LIKE: a username can hold '_'. The parse below is the check.
      legacy = this.sql
        .exec<{ data: string }>(
          'SELECT i.data AS data FROM replay_index i WHERE +i.at < ? AND +i.at >= ? AND NOT EXISTS (SELECT 1 FROM replay_players p WHERE p.match_id = i.match_id) AND instr(i.data, ?) > 0 ORDER BY i.at DESC, i.match_id DESC LIMIT ?',
          newest,
          oldest,
          JSON.stringify({ name }).slice(1, -1),
          limit,
        )
        .toArray()
        .map((r) => JSON.parse(r.data) as ReplayListItem)
        .filter((m) => m.players.some((p) => !p.bot && p.name === name));
    }
    const seen = new Set<string>();
    const items = [...bySeat, ...legacy]
      .filter((m) => (seen.has(m.matchId) ? false : (seen.add(m.matchId), true)))
      .sort((a, b) => b.at - a.at || (a.matchId < b.matchId ? 1 : -1))
      .slice(0, limit);
    return this.withSeatsAndStars(items);
  }

  /** The served matches `accountId` starred (at most `limit`). */
  replayStarredBy(accountId: string, limit: number): string[] {
    const { newest, oldest } = replayServedSpan(this.now());
    return this.sql
      .exec<{ match_id: string }>('SELECT s.match_id AS match_id FROM replay_stars s JOIN replay_index i ON i.match_id = s.match_id WHERE s.account_id = ? AND +i.at < ? AND +i.at >= ? LIMIT ?', accountId, newest, oldest, limit)
      .toArray()
      .map((r) => r.match_id);
  }

  /**
   * Star or unstar a served match for `accountId`. Null when the match is not served; 'full' when the
   * account holds `max` stars already; else the match's new count.
   */
  setReplayStar(accountId: string, matchId: string, on: boolean, max: number): number | 'full' | null {
    if (!this.replayEntry(matchId)) return null;
    if (on) {
      const held = Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM replay_stars WHERE account_id = ?', accountId).toArray()[0]?.n ?? 0);
      const has = this.sql.exec('SELECT 1 AS x FROM replay_stars WHERE match_id = ? AND account_id = ?', matchId, accountId).toArray().length > 0;
      if (!has && held >= max) return 'full';
      this.sql.exec('INSERT INTO replay_stars (match_id, account_id) VALUES (?, ?) ON CONFLICT(match_id, account_id) DO NOTHING', matchId, accountId);
    } else {
      this.sql.exec('DELETE FROM replay_stars WHERE match_id = ? AND account_id = ?', matchId, accountId);
    }
    return this.starCounts([matchId]).get(matchId) ?? 0;
  }

  /** The seats of each of `matchIds` that has any. */
  private seatsOf(matchIds: readonly string[]): Map<string, ReplaySeat[]> {
    const out = new Map<string, ReplaySeat[]>();
    if (matchIds.length === 0) return out;
    const marks = matchIds.map(() => '?').join(', ');
    for (const r of this.sql.exec<{ match_id: string; slot: number; player_id: string }>(`SELECT match_id, slot, player_id FROM replay_players WHERE match_id IN (${marks}) ORDER BY match_id, slot`, ...matchIds).toArray()) {
      const list = out.get(r.match_id) ?? [];
      list.push({ slot: Number(r.slot), playerId: r.player_id });
      out.set(r.match_id, list);
    }
    return out;
  }

  /** One served match (in replayList's window, replayServedSpan), its replay's SHA-256 and its seats, or null. */
  replayEntry(matchId: string): (ReplayIndexRow & { seats: ReplaySeat[] | null }) | null {
    const { newest, oldest } = replayServedSpan(this.now());
    const r = this.sql
      .exec<{ sha: string; data: string }>('SELECT sha, data FROM replay_index WHERE match_id = ? AND at < ? AND at >= ?', matchId, newest, oldest)
      .toArray()[0];
    return r ? { item: { ...(JSON.parse(r.data) as ReplayListItem), stars: this.starCounts([matchId]).get(matchId) ?? 0 }, sha: r.sha, seats: this.seatsOf([matchId]).get(matchId) ?? null } : null;
  }

  /**
   * A maintainer's delist (NodeRegistryDO adminDelist): the row and its seats go, whatever its age,
   * and its history row is marked (the raw download answers 404 from then on). True when there was a row.
   */
  delistReplay(matchId: string): boolean {
    const had = this.sql.exec('SELECT 1 AS x FROM replay_index WHERE match_id = ?', matchId).toArray().length > 0;
    this.tx(() => {
      this.sql.exec('DELETE FROM replay_players WHERE match_id = ?', matchId);
      this.sql.exec('DELETE FROM replay_stars WHERE match_id = ?', matchId);
      this.sql.exec('DELETE FROM replay_index WHERE match_id = ?', matchId);
      if (had) this.sql.exec('UPDATE node_match_history SET delisted_at = ? WHERE match_id = ? AND delisted_at IS NULL', this.now(), matchId);
    });
    return had;
  }

  // ---- the maintainers' history --------------------------------------------------------------

  /**
   * A settled match's row and seats (in finished()'s transaction), and the rows past HISTORY_DAYS that
   * a write prunes on its way. A seat of an account purged while the match was held is written blank.
   */
  private historyRow(h: { match: MatchHistory; players: HistorySeat[] }, now: number): void {
    const x = h.match;
    const gone = this.forgotten(h.players.flatMap((p) => (p.playerId === null ? [] : [p.playerId])));
    this.sql.exec('INSERT INTO node_match_history (match_id, node_id, at, result, reason, delisted_at, data) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(match_id) DO NOTHING', x.matchId, x.nodeId, x.settledAt, x.result, x.reason, JSON.stringify(x));
    for (const p of h.players) {
      const blank = p.playerId !== null && gone.has(p.playerId);
      this.sql.exec('INSERT INTO node_match_players (match_id, slot, player_id, name) VALUES (?, ?, ?, ?) ON CONFLICT(match_id, slot) DO NOTHING', x.matchId, p.slot, blank ? null : p.playerId, blank ? null : p.name);
    }
    this.pruneMatchHistory(now - HISTORY_DAYS * DAY_MS, HISTORY_PRUNE_ON_WRITE);
  }

  /** The oldest `max` history rows settled before `before`, with their seats. Returns how many went. */
  private pruneMatchHistory(before: number, max: number): number {
    const ids = this.sql
      .exec<{ match_id: string }>('SELECT match_id FROM node_match_history WHERE at < ? ORDER BY at LIMIT ?', before, max)
      .toArray()
      .map((r) => r.match_id);
    for (const id of ids) {
      this.sql.exec('DELETE FROM node_match_players WHERE match_id = ?', id);
      this.sql.exec('DELETE FROM node_match_history WHERE match_id = ?', id);
    }
    return ids.length;
  }

  /** One node event (NodeRegistryDO nodeEvent); the ones past HISTORY_DAYS, and past the newest NODE_EVENTS_MAX, go. */
  nodeEvent(e: Omit<NodeEventRow, 'id'>): void {
    this.sql.exec('INSERT INTO node_events (node_id, at, kind, detail, actor) VALUES (?, ?, ?, ?, ?)', e.nodeId, e.at, e.kind, e.detail, e.actor);
    this.sql.exec('DELETE FROM node_events WHERE at < ?', e.at - HISTORY_DAYS * DAY_MS);
    this.sql.exec('DELETE FROM node_events WHERE id <= (SELECT MAX(id) FROM node_events) - ?', NODE_EVENTS_MAX);
  }

  /** One ALERT line the object posted (or would have, without a webhook): the ring keeps the newest ALERT_RING_MAX, HISTORY_DAYS at most. */
  alertLine(at: number, kind: AlertRow['kind'], line: string): void {
    this.sql.exec('INSERT INTO node_alerts (at, kind, line) VALUES (?, ?, ?)', at, kind, line);
    this.sql.exec('DELETE FROM node_alerts WHERE id <= (SELECT MAX(id) FROM node_alerts) - ?', ALERT_RING_MAX);
    this.sql.exec('DELETE FROM node_alerts WHERE at < ?', at - HISTORY_DAYS * DAY_MS);
  }

  /**
   * Node events, newest first: of one node or of all, before the event `before` (null: from the
   * newest), at most `limit`; none past HISTORY_DAYS, pruned or not yet (`+at`: a filter, the order
   * stays the id's index).
   */
  eventList(q: { nodeId: string | null; before: number | null; limit: number }): NodeEventRow[] {
    const where: string[] = ['+at >= ?'];
    const args: Array<string | number> = [historyOldest(this.now())];
    if (q.nodeId !== null) {
      where.push('node_id = ?');
      args.push(q.nodeId);
    }
    if (q.before !== null) {
      where.push('id < ?');
      args.push(q.before);
    }
    return this.sql
      .exec<{ id: number; node_id: string; at: number; kind: string; detail: string | null; actor: string | null }>(
        `SELECT id, node_id, at, kind, detail, actor FROM node_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        ...args,
        q.limit,
      )
      .toArray()
      .map((r) => ({ id: Number(r.id), nodeId: r.node_id, at: Number(r.at), kind: r.kind as NodeEventKind, detail: r.detail ?? null, actor: r.actor ?? null }));
  }

  /** The ALERT lines, newest first, before the line `before` (null: from the newest), at most `limit`; none past HISTORY_DAYS, pruned or not yet. */
  alertList(q: { before: number | null; limit: number }): AlertRow[] {
    const oldest = historyOldest(this.now());
    const rows =
      q.before === null
        ? this.sql.exec<{ id: number; at: number; kind: string; line: string }>('SELECT id, at, kind, line FROM node_alerts WHERE +at >= ? ORDER BY id DESC LIMIT ?', oldest, q.limit).toArray()
        : this.sql.exec<{ id: number; at: number; kind: string; line: string }>('SELECT id, at, kind, line FROM node_alerts WHERE id < ? AND +at >= ? ORDER BY id DESC LIMIT ?', q.before, oldest, q.limit).toArray();
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), kind: r.kind === 'audit' ? 'audit' : 'alert', line: r.line }));
  }

  /**
   * Settled matches, newest first (settle time, then id): one (`matchId`), or a page of one node's or
   * of all, after `cursor` (null: from the newest), at most `limit`; each with its seats and whether
   * its replay is listed, and served now. None settled past HISTORY_DAYS, pruned or not yet.
   */
  historyList(q: { nodeId: string | null; matchId: string | null; cursor: HistoryCursor | null; limit: number }): HistoryRow[] {
    const where: string[] = ['at >= ?'];
    const args: Array<string | number> = [historyOldest(this.now())];
    if (q.matchId !== null) {
      where.push('match_id = ?');
      args.push(q.matchId);
    }
    if (q.nodeId !== null) {
      where.push('node_id = ?');
      args.push(q.nodeId);
    }
    if (q.cursor !== null) {
      where.push('at <= ? AND NOT (at = ? AND match_id >= ?)');
      args.push(q.cursor.at, q.cursor.at, q.cursor.matchId);
    }
    const rows = this.sql
      .exec<{ match_id: string; delisted_at: number | null; data: string }>(
        `SELECT match_id, delisted_at, data FROM node_match_history WHERE ${where.join(' AND ')} ORDER BY at DESC, match_id DESC LIMIT ?`,
        ...args,
        q.limit,
      )
      .toArray();
    const ids = rows.map((r) => r.match_id);
    const players = new Map<string, HistorySeat[]>();
    const listed = new Map<string, number>();
    if (ids.length > 0) {
      const marks = ids.map(() => '?').join(', ');
      for (const p of this.sql.exec<{ match_id: string; slot: number; player_id: string | null; name: string | null }>(`SELECT match_id, slot, player_id, name FROM node_match_players WHERE match_id IN (${marks}) ORDER BY match_id, slot`, ...ids).toArray()) {
        const list = players.get(p.match_id) ?? [];
        list.push({ slot: Number(p.slot), playerId: p.player_id ?? null, name: p.name ?? null });
        players.set(p.match_id, list);
      }
      for (const r of this.sql.exec<{ match_id: string; at: number }>(`SELECT match_id, at FROM replay_index WHERE match_id IN (${marks})`, ...ids).toArray()) listed.set(r.match_id, Number(r.at));
    }
    const { newest, oldest } = replayServedSpan(this.now());
    return rows.map((r) => {
      const at = listed.get(r.match_id);
      return {
        match: JSON.parse(r.data) as MatchHistory,
        players: players.get(r.match_id) ?? [],
        delistedAt: r.delisted_at === null || r.delisted_at === undefined ? null : Number(r.delisted_at),
        listed: at !== undefined,
        published: at !== undefined && at < newest && at >= oldest,
      };
    });
  }

  /** The voids settled since `since`, by node and reason (the overview's last 24 h), the most first. */
  voidsSince(since: number): Array<{ nodeId: string; reason: string; count: number }> {
    return this.sql
      .exec<{ node_id: string; reason: string | null; n: number }>("SELECT node_id, reason, COUNT(*) AS n FROM node_match_history WHERE at >= ? AND result = 'void' GROUP BY node_id, reason ORDER BY n DESC, node_id, reason LIMIT 100", since)
      .toArray()
      .map((r) => ({ nodeId: r.node_id, reason: r.reason ?? '', count: Number(r.n) }));
  }

  /**
   * A purged account (/internal/operator-deleted): its name and id leave every history seat it held,
   * and its id is kept (node_forgotten) so that a match it is still in settles with its seat blank:
   * AccountsDO tells a purge once, and a match can be held for hours after it (its verification).
   */
  forgetPlayer(playerId: string): void {
    const now = this.now();
    this.tx(() => {
      this.sql.exec('INSERT INTO node_forgotten (player_id, at) VALUES (?, ?) ON CONFLICT(player_id) DO NOTHING', playerId, now);
      this.sql.exec('UPDATE node_match_players SET player_id = NULL, name = NULL WHERE player_id = ?', playerId);
      this.sql.exec('DELETE FROM node_forgotten WHERE at < ?', now - HISTORY_DAYS * DAY_MS);
    });
  }

  /** Which of `playerIds` are purged accounts' (forgetPlayer), asked FORGOTTEN_ASK_MAX at a time (a query binds 100 values at most). */
  forgotten(playerIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    const ids = [...new Set(playerIds)];
    for (let i = 0; i < ids.length; i += FORGOTTEN_ASK_MAX) {
      const part = ids.slice(i, i + FORGOTTEN_ASK_MAX);
      const marks = part.map(() => '?').join(', ');
      for (const r of this.sql.exec<{ player_id: string }>(`SELECT player_id FROM node_forgotten WHERE player_id IN (${marks})`, ...part).toArray()) out.add(r.player_id);
    }
    return out;
  }

  /**
   * The cron's prune: the history past HISTORY_DAYS (the oldest `max` matches), the node events,
   * ALERT lines and purged ids past it; and the opening's rows past theirs (admin_audit,
   * operator_tokens, node_reports). Returns the matches pruned.
   */
  pruneHistory(now: number, max: number = REPLAY_PRUNE_MAX): number {
    const before = historyOldest(now);
    return this.tx(() => {
      this.sql.exec('DELETE FROM node_events WHERE at < ?', before);
      this.sql.exec('DELETE FROM node_alerts WHERE at < ?', before);
      this.sql.exec('DELETE FROM node_forgotten WHERE at < ?', before);
      this.sql.exec('DELETE FROM admin_audit WHERE at < ?', now - ADMIN_AUDIT_DAYS * DAY_MS);
      this.sql.exec('DELETE FROM operator_tokens WHERE at <= ?', now - OPERATOR_TOKENS_MS);
      this.sql.exec('DELETE FROM node_reports WHERE at < ?', now - REPORT_DAYS * DAY_MS);
      return this.pruneMatchHistory(before, max);
    });
  }

  // ---- hosting by the community --------------------------------------------------------------

  /** Every operators row (the object keeps them in memory: a hello reads the block). */
  operatorRows(): OperatorRow[] {
    return this.sql
      .exec<{ operator_id: string; status: string; reason: string | null; actor: string | null; at: number; show_public: number }>('SELECT operator_id, status, reason, actor, at, show_public FROM operators')
      .toArray()
      .map((r) => ({ operatorId: r.operator_id, status: r.status === 'blocked' ? 'blocked' : 'ok', reason: r.reason ?? null, actor: r.actor ?? null, at: Number(r.at), showPublic: Number(r.show_public) === 1 }));
  }

  /** A maintainer set an operator's status (POST /nodes/admin/operator): its row, its opt-in kept as it was. */
  setOperatorStatus(o: Pick<OperatorRow, 'operatorId' | 'status' | 'reason' | 'actor' | 'at'>): void {
    this.sql.exec(
      'INSERT INTO operators (operator_id, status, reason, actor, at, show_public) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(operator_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, actor = excluded.actor, at = excluded.at',
      o.operatorId,
      o.status,
      o.reason,
      o.actor,
      o.at,
    );
  }

  /** The operator's opt-in (POST /nodes/mine/public): its row, its status kept as it was. */
  setShowPublic(operatorId: string, show: boolean, at: number): void {
    this.sql.exec('INSERT INTO operators (operator_id, status, at, show_public) VALUES (?, ?, ?, ?) ON CONFLICT(operator_id) DO UPDATE SET show_public = excluded.show_public', operatorId, 'ok', at, show ? 1 : 0);
  }

  /**
   * A purged account (/internal/operator-deleted): the account id leaves this object's hosting rows
   * (decisions.md: the chosen name and the account id go with the account). Its name choice goes
   * for good, its token counts with it. A status a maintainer set stays, as its nodes' records do,
   * but under `alias` (an opaque key), with its status, reason, actor and date; a row only the
   * opt-in wrote goes. In admin_audit's values (a canary's ids) the id becomes 'deleted'. The
   * players' reports about its servers stay for their 30 days, under `alias` too; the object takes
   * no new one about them (node_forgotten has the id, its nodes the purge's ban).
   */
  forgetOperator(operatorId: string, alias: string): void {
    this.tx(() => {
      this.sql.exec('DELETE FROM operators WHERE operator_id = ? AND actor IS NULL', operatorId);
      this.sql.exec('UPDATE operators SET operator_id = ?, show_public = 0 WHERE operator_id = ?', alias, operatorId);
      this.sql.exec('DELETE FROM operator_tokens WHERE operator_id = ?', operatorId);
      this.sql.exec('UPDATE node_reports SET operator_id = ? WHERE operator_id = ?', alias, operatorId);
      const strip = (v: string | null) => (v === null ? null : v.split(',').map((x) => (x.trim() === operatorId ? 'deleted' : x)).join(','));
      const audits = this.sql.exec<{ id: number; old: string | null; new: string | null }>('SELECT id, old, new FROM admin_audit WHERE instr(old, ?) > 0 OR instr(new, ?) > 0', operatorId, operatorId).toArray();
      for (const r of audits) this.sql.exec('UPDATE admin_audit SET old = ?, new = ? WHERE id = ?', strip(r.old), strip(r.new), r.id);
    });
  }

  /** One change of the opening's flag; the ones past ADMIN_AUDIT_DAYS go. */
  adminAudit(r: Omit<AdminAuditRow, 'id'>): void {
    this.sql.exec('INSERT INTO admin_audit (at, actor, flag, old, new, reason) VALUES (?, ?, ?, ?, ?, ?)', r.at, r.actor, r.flag, r.old, r.new, r.reason);
    this.sql.exec('DELETE FROM admin_audit WHERE at < ?', r.at - ADMIN_AUDIT_DAYS * DAY_MS);
  }

  /** The newest changes of the opening's flag, at most `limit`, none past ADMIN_AUDIT_DAYS. */
  adminAuditList(limit: number): AdminAuditRow[] {
    return this.sql
      .exec<{ id: number; at: number; actor: string; flag: string; old: string | null; new: string | null; reason: string | null }>('SELECT id, at, actor, flag, old, new, reason FROM admin_audit WHERE at >= ? ORDER BY id DESC LIMIT ?', this.now() - ADMIN_AUDIT_DAYS * DAY_MS, limit)
      .toArray()
      .map((r) => ({ id: Number(r.id), at: Number(r.at), actor: r.actor, flag: r.flag, old: r.old ?? null, new: r.new ?? null, reason: r.reason ?? null }));
  }

  /** A community node token minted for `operatorId`; the rows past the day go. */
  tokenMinted(operatorId: string, at: number): void {
    this.sql.exec('INSERT INTO operator_tokens (operator_id, at) VALUES (?, ?)', operatorId, at);
    this.sql.exec('DELETE FROM operator_tokens WHERE at <= ?', at - OPERATOR_TOKENS_MS);
  }

  /** The community node tokens `operatorId` minted in the 24 hours before `now`. */
  tokensToday(operatorId: string, now: number): number {
    return Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operator_tokens WHERE operator_id = ? AND at > ?', operatorId, now - OPERATOR_TOKENS_MS).toArray()[0]?.n ?? 0);
  }

  // ---- the players' reports (A16) ------------------------------------------------------------

  /** A report, once per match and account (false: that account reported that match already); the rows past REPORT_DAYS go. */
  report(r: ReportRow): boolean {
    const had = this.sql.exec('SELECT 1 AS x FROM node_reports WHERE match_id = ? AND reporter_id = ?', r.matchId, r.reporterId).toArray().length > 0;
    if (had) return false;
    this.sql.exec(
      'INSERT INTO node_reports (match_id, reporter_id, at, node_id, operator_id, reason, ping, corrections) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.matchId,
      r.reporterId,
      r.at,
      r.nodeId,
      r.operatorId,
      r.reason,
      r.ping,
      r.corrections,
    );
    this.sql.exec('DELETE FROM node_reports WHERE at < ?', r.at - REPORT_DAYS * DAY_MS);
    return true;
  }

  /** The reports `reporterId` made in the 24 hours before `now` (its day's cap). */
  reportsBy(reporterId: string, now: number): number {
    return Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM node_reports WHERE reporter_id = ? AND at > ?', reporterId, now - DAY_MS).toArray()[0]?.n ?? 0);
  }

  /** The reports about `operatorId`'s servers since `since`, newest first, at most `limit`. */
  reportsAbout(operatorId: string, since: number, limit: number): ReportRow[] {
    return this.sql
      .exec<{ at: number; reporter_id: string; match_id: string; node_id: string; operator_id: string; reason: string; ping: number | null; corrections: number | null }>(
        'SELECT at, reporter_id, match_id, node_id, operator_id, reason, ping, corrections FROM node_reports WHERE operator_id = ? AND at >= ? ORDER BY at DESC, match_id DESC LIMIT ?',
        operatorId,
        since,
        limit,
      )
      .toArray()
      .map((r) => ({
        at: Number(r.at),
        reporterId: r.reporter_id,
        matchId: r.match_id,
        nodeId: r.node_id,
        operatorId: r.operator_id,
        reason: (REPORT_REASONS as readonly string[]).includes(r.reason) ? (r.reason as ReportReason) : 'other',
        ping: r.ping === null || r.ping === undefined ? null : Number(r.ping),
        corrections: r.corrections === null || r.corrections === undefined ? null : Number(r.corrections),
      }));
  }

  /** The operators some report is about (since `since`): the Operadores tab lists them with the rest. */
  reportedOperators(since: number): string[] {
    return this.sql
      .exec<{ operator_id: string }>('SELECT DISTINCT operator_id FROM node_reports WHERE at >= ?', since)
      .toArray()
      .map((r) => r.operator_id);
  }

  /** A purged account's reports go at once (its id is in them: the privacy policy's "se borran antes si se borra la cuenta"). */
  forgetReporter(reporterId: string): void {
    this.sql.exec('DELETE FROM node_reports WHERE reporter_id = ?', reporterId);
  }

  /**
   * The node of a settled match `playerId` had a seat in, from the maintainers' history
   * (node_match_players: void matches too, 30 days) or the public replays' seats (replay_players),
   * or null: what a report of a match no longer held by the control plane proves itself with.
   */
  seatNodeOf(matchId: string, playerId: string): string | null {
    const r = this.sql
      .exec<{ node_id: string }>(
        'SELECT h.node_id AS node_id FROM node_match_history h WHERE h.match_id = ? AND (EXISTS (SELECT 1 FROM node_match_players p WHERE p.match_id = h.match_id AND p.player_id = ?) OR EXISTS (SELECT 1 FROM replay_players q WHERE q.match_id = h.match_id AND q.player_id = ?))',
        matchId,
        playerId,
        playerId,
      )
      .toArray()[0];
    return r ? r.node_id : null;
  }

  drop(matchId: string): void {
    this.sql.exec('DELETE FROM node_matches WHERE match_id = ?', matchId);
  }

  // ---- the rewards ledger -------------------------------------------------------------------

  /** One scored match (once per match id) and its operator's totals; entries past the window go. */
  private ledgerEntry(e: LedgerEntry, now: number): void {
    if (this.sql.exec('SELECT 1 AS x FROM ledger_entries WHERE match_id = ?', e.matchId).toArray().length > 0) return;
    this.sql.exec('INSERT INTO ledger_entries (match_id, operator_id, at, data) VALUES (?, ?, ?, ?)', e.matchId, e.operatorId, e.at, JSON.stringify(e));
    this.sql.exec(
      'INSERT INTO ledger_totals (operator_id, earned, verified) VALUES (?, ?, ?) ON CONFLICT(operator_id) DO UPDATE SET earned = earned + excluded.earned, verified = verified + excluded.verified',
      e.operatorId,
      e.points,
      countsAsHosted(e) ? 1 : 0,
    );
    this.sql.exec('DELETE FROM ledger_entries WHERE at < ?', now - WINDOW_DAYS * DAY_MS);
  }

  /** The ledger's note of a match that earned nothing by itself (Ledger onNote); notes past the repeat window go. */
  ledgerNote(n: GroupNote): void {
    this.sql.exec('INSERT INTO ledger_notes (operator_id, players, at) VALUES (?, ?, ?)', n.operatorId, JSON.stringify(n.playerIds), n.at);
    this.sql.exec('DELETE FROM ledger_notes WHERE at <= ?', n.at - REPEAT_WINDOW_MS);
  }

  /** What Ledger.restore reads at the start: the window's entries, the repeat window's notes, every operator's totals. */
  ledgerSnapshot(now: number): LedgerSnapshot {
    const s = this.sql;
    s.exec('DELETE FROM ledger_entries WHERE at < ?', now - WINDOW_DAYS * DAY_MS);
    s.exec('DELETE FROM ledger_notes WHERE at <= ?', now - REPEAT_WINDOW_MS);
    const entries: LedgerEntry[] = [];
    for (const r of s.exec<{ data: string }>('SELECT data FROM ledger_entries ORDER BY at').toArray()) {
      try {
        entries.push(JSON.parse(r.data) as LedgerEntry);
      } catch {
        /* a row that does not read is skipped: its points are in the totals and the account already */
      }
    }
    const notes = s
      .exec<{ operator_id: string; players: string; at: number }>('SELECT operator_id, players, at FROM ledger_notes')
      .toArray()
      .map((r) => ({ operatorId: r.operator_id, playerIds: playersOf(r.players), at: Number(r.at) }));
    const totals = s
      .exec<{ operator_id: string; earned: number; verified: number }>('SELECT operator_id, earned, verified FROM ledger_totals')
      .toArray()
      .map((r) => ({ operatorId: r.operator_id, earned: Number(r.earned), verified: Number(r.verified) }));
    return { entries, notes, totals };
  }

  // ---- outbox -------------------------------------------------------------------------------

  /** Rows whose next try is due, oldest first. */
  due(now: number, limit: number): OutboxRow[] {
    return this.sql
      .exec<{ id: number; match_id: string; target: string; path: string; body: string; attempts: number; created_at: number }>(
        'SELECT id, match_id, target, path, body, attempts, created_at FROM outbox WHERE next_at <= ? ORDER BY id LIMIT ?',
        now,
        limit,
      )
      .toArray()
      .map((r) => ({ id: Number(r.id), matchId: r.match_id, target: r.target, path: r.path as OutcomeCall['path'], body: r.body, attempts: Number(r.attempts), createdAt: Number(r.created_at) }));
  }

  delivered(id: number): void {
    this.sql.exec('DELETE FROM outbox WHERE id = ?', id);
  }

  retryAt(id: number, attempts: number, nextAt: number): void {
    this.sql.exec('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?', attempts, nextAt, id);
  }

  outboxSize(): number {
    return Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').toArray()[0]?.n ?? 0);
  }

  /** The undelivered calls by path (/host-credit, /host-freeze, /release, ...): how many, and when the oldest was written. */
  outboxByPath(): Array<{ path: string; rows: number; oldestAt: number }> {
    return this.sql
      .exec<{ path: string; n: number; oldest: number }>('SELECT path, COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox GROUP BY path ORDER BY path')
      .toArray()
      .map((r) => ({ path: r.path, rows: Number(r.n), oldestAt: Number(r.oldest) }));
  }
}
