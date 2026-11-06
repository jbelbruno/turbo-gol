/**
 * Rewards ledger (docs/RECOMPENSAS.md). Pure logic.
 *
 * Unit: one point per VERIFIED player-minute served. What counts is useful work proven by the
 * re-simulation, never hardware or money: a home PC and a rented VPS earn the same for the same
 * minutes. The minutes come from the verifier (each human slot's present ticks in the replay);
 * the node's own connected time can only lower them. Points are not money and cannot be transferred: they are spent in the hosts' shop
 * (control-plane/shop.ts) on new cars and other items that only people who share their machine
 * can get.
 *
 *   points = sum over counted players of minutes x weight
 *            x regionFactor   (0.5 .. 3: scarce regions pay more, oversupplied ones less; taken
 *                              when the match is placed, see ControlPlane.regionFactorAt)
 *            x quality        (0.5 / 1.0 from the node's tick lag and the players' underruns.
 *                              The node measures both itself, so they can only lower the points:
 *                              the 1.2 bonus waits for quality measured by the players' clients)
 *            x repeat         (1 / (1 + same group on the same operator in the last 24 h))
 *
 * Anti-farming:
 *   - only matches the matchmaker placed (a node cannot create matches) and that verified
 *   - the operator's own minutes never count (and they never play ranked on their own nodes)
 *   - guests and accounts younger than NEW_ACCOUNT_DAYS weigh 0.25
 *   - the same group of players on the same operator decays within 24 h
 *   - a failed verification is worth 0, suspends the node and freezes the operator's wallet
 *   With the options the NodeRegistryDO sets (the opening's rules, Prompt 2 A17):
 *   - playerRepeat: each counted player also weighs 1 / (1 + their matches on that operator's
 *     nodes in the last 24 h), so new combinations of the same accounts decay too
 *   - dailyCap: an operator earns at most that many points a UTC day; what goes over is recorded
 *     as 0 (`capped` says how much)
 *   - a match of one human against bots (soloBots, decided by the control plane from the roster)
 *     is recorded, worth 0
 *
 * Persistence (the NodeRegistryDO, server/src/nodeStore.ts): each entry is written with the match it
 * scores (MatchEntry.ledger, in the transaction that settles it), the group notes through onNote,
 * the all-time totals beside them; restore() reads them back at every start, so the 24 h repeat
 * decay, the 30-day leaderboard and the operators' summaries survive a deploy.
 */
import type { EndReason, GameMode } from '../shared/controlProtocol';

export interface LedgerPlayer {
  playerId: string;
  connectedMs: number;
  /** A registered account (false = guest). */
  account: boolean;
  accountAgeDays: number;
}

export interface CreditInput {
  matchId: string;
  nodeId: string;
  operatorId: string;
  region: string;
  mode: GameMode;
  ranked: boolean;
  verified: boolean;
  endReason: EndReason;
  players: LedgerPlayer[];
  tickLagP99Ms: number;
  /** Underruns / (ticks x humans), 0..1. */
  underrunRate: number;
  at: number;
  /**
   * The share of such matches that get verified (1 = every one). Casual matches of an active node
   * are verified by sample, and only verified matches earn: each one counts 1 / sampleRate, so the
   * operator earns the same on average.
   */
  sampleRate?: number;
  /** One human against bots (the control plane counts the roster's player seats): recorded, worth 0. */
  soloBots?: boolean;
}

export interface LedgerEntry extends CreditInput {
  points: number;
  playerMinutes: number;
  weightedMinutes: number;
  regionFactor: number;
  quality: number;
  repeat: number;
  /** The points over the operator's daily cap (LedgerOptions.dailyCap), recorded as 0; absent when none went over. */
  capped?: number;
}

export const WINDOW_DAYS = 30;
export const NEW_ACCOUNT_DAYS = 7;
export const LOW_WEIGHT = 0.25;
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Self-reported quality (tick lag, underruns measured by the node) never raises the points. */
export const SELF_REPORTED_QUALITY_CAP = 1.0;

/** 1.2 / 1.0 / 0.5 from the tick lag and the underrun rate (the 1.2 tier only with client-measured inputs). */
export function qualityFactor(tickLagP99Ms: number, underrunRate: number, selfReported = true): number {
  let q = 0.5;
  if (tickLagP99Ms <= 4 && underrunRate <= 0.01) q = 1.2;
  else if (tickLagP99Ms <= 12 && underrunRate <= 0.05) q = 1.0;
  return selfReported ? Math.min(SELF_REPORTED_QUALITY_CAP, q) : q;
}

/**
 * Region factor from demand (matches running or wanted in the region, the credited one included)
 * and supply (match slots the region's online hosts offer): 0.5 + demand / supply, clamped to
 * 0.5 .. 3. One node with one slot hosting one match at a time: 1.5.
 */
export function regionFactor(demandMatches: number, supplyMatchSlots: number): number {
  const f = 0.5 + demandMatches / Math.max(1, supplyMatchSlots);
  return Math.round(Math.max(0.5, Math.min(3, f)) * 100) / 100;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * A verified hosted match that counts as one (verifiedMatches, the free badge's
 * minVerifiedMatches): verified and worth points, so it served someone other than the operator. A
 * match the operator played alone on their own node (vs bots, or with a no-show) is verified all
 * the same but earns 0: it counts for nothing, as their own minutes. AccountsDO counts its
 * host_credits rows by the same rule (server/src/accountStore.ts verifiedHosted), the
 * NodeRegistryDO's ledger_totals too (server/src/nodeStore.ts).
 */
export function countsAsHosted(e: Pick<LedgerEntry, 'verified' | 'points'>): boolean {
  return e.verified && e.points > 0;
}

export interface OperatorSummary {
  operatorId: string;
  /** Points earned over the last WINDOW_DAYS (activity). */
  points30d: number;
  /** Points earned since the beginning (what the shop balance starts from). */
  earned: number;
  matches30d: number;
  playerMinutes30d: number;
  byNode: Record<string, { points: number; matches: number }>;
}

/** One more match of a group on an operator that earned nothing by itself (noteGroup): the repeat decay counts it. */
export interface GroupNote {
  operatorId: string;
  playerIds: string[];
  at: number;
}

/** An operator's all-time points and verified matches (countsAsHosted: what earned() and verifiedMatches() answer). */
export interface OperatorTotal {
  operatorId: string;
  earned: number;
  verified: number;
}

/** What a restart reads back: the window's entries, the notes of the repeat window and every operator's totals. */
export interface LedgerSnapshot {
  entries: readonly LedgerEntry[];
  notes: readonly GroupNote[];
  totals: readonly OperatorTotal[];
}

export interface LedgerOptions {
  /** A group note was taken (noteGroup): the store keeps it for the repeat window. */
  onNote?: (note: GroupNote) => void;
  /** The most points an operator earns in a UTC day; the rest of a match over it is recorded as 0. Absent: no cap. */
  dailyCap?: number;
  /** Each counted player also decays by their own matches on the operator in the repeat window. Absent: the exact group only. */
  playerRepeat?: boolean;
}

/** The repeat decay's key: the operator and the players it counts (everyone but the operator), sorted. */
function groupKey(operatorId: string, playerIds: readonly string[]): { key: string; counted: number } {
  const counted = playerIds.filter((p) => p !== operatorId).sort();
  return { key: operatorId + '|' + counted.join(','), counted: counted.length };
}

/** The UTC day a time falls in (the daily cap's). */
function dayOf(at: number): number {
  return Math.floor(at / DAY_MS);
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly groups = new Map<string, number[]>();
  /** The per-player decay (playerRepeat): operator + '|' + player -> their matches' times in the repeat window. */
  private readonly players = new Map<string, number[]>();
  private readonly totals = new Map<string, number>();
  private readonly verified = new Map<string, number>();
  private readonly onNote: ((note: GroupNote) => void) | null;
  private readonly dailyCap: number | null;
  private readonly playerRepeat: boolean;

  constructor(opts: LedgerOptions = {}) {
    this.onNote = opts.onNote ?? null;
    this.dailyCap = opts.dailyCap !== undefined && Number.isFinite(opts.dailyCap) && opts.dailyCap >= 0 ? opts.dailyCap : null;
    this.playerRepeat = opts.playerRepeat === true;
  }

  /** One more match of `playerId` on `operatorId`'s nodes at `at` (playerRepeat). */
  private notePlayer(operatorId: string, playerId: string, at: number): void {
    const k = operatorId + '|' + playerId;
    const times = (this.players.get(k) ?? []).filter((t) => at - t < REPEAT_WINDOW_MS);
    times.push(at);
    this.players.set(k, times);
  }

  /** `playerId`'s matches on `operatorId`'s nodes in the repeat window before `at`. */
  private playedRecently(operatorId: string, playerId: string, at: number): number {
    return (this.players.get(operatorId + '|' + playerId) ?? []).filter((t) => at - t < REPEAT_WINDOW_MS).length;
  }

  /**
   * Load what the store kept (a fresh ledger, at the start): the entries of the last WINDOW_DAYS in
   * time order, the repeat groups of the last 24 h rebuilt from them and from the notes exactly as
   * record() and noteGroup() build them, and the totals as written.
   */
  restore(s: LedgerSnapshot, now: number): void {
    this.entries.length = 0;
    this.groups.clear();
    this.players.clear();
    this.totals.clear();
    this.verified.clear();
    const since = now - WINDOW_DAYS * DAY_MS;
    this.entries.push(...s.entries.filter((e) => e.at >= since).sort((a, b) => a.at - b.at));
    const note = (map: Map<string, number[]>, key: string, at: number) => {
      if (now - at >= REPEAT_WINDOW_MS) return;
      const times = map.get(key);
      if (times) times.push(at);
      else map.set(key, [at]);
    };
    // The per-player decay from the same rows, in time order (each player's matches as record() and noteGroup() noted them).
    const players = (operatorId: string, ids: readonly string[], at: number) => {
      if (this.playerRepeat) for (const id of ids) if (id !== operatorId) note(this.players, operatorId + '|' + id, at);
    };
    for (const e of this.entries) {
      const ids = e.players.map((p) => p.playerId);
      note(this.groups, groupKey(e.operatorId, ids).key, e.at);
      players(e.operatorId, ids, e.at);
    }
    for (const n of [...s.notes].sort((a, b) => a.at - b.at)) {
      const g = groupKey(n.operatorId, n.playerIds);
      if (g.counted > 0) note(this.groups, g.key, n.at);
      players(n.operatorId, n.playerIds, n.at);
    }
    for (const t of s.totals) {
      this.totals.set(t.operatorId, round2(t.earned));
      if (t.verified > 0) this.verified.set(t.operatorId, t.verified);
    }
  }

  /** Score a match and append it. `regionFactorValue` comes from the control plane's demand / supply view. */
  record(input: CreditInput, regionFactorValue: number): LedgerEntry {
    this.prune(input.at);
    let playerMinutes = 0;
    let weighted = 0;
    const counted: string[] = [];
    for (const p of input.players) {
      const minutes = Math.max(0, p.connectedMs) / 60_000;
      playerMinutes += minutes;
      if (p.playerId === input.operatorId) continue;
      let w = p.account && p.accountAgeDays >= NEW_ACCOUNT_DAYS ? 1 : LOW_WEIGHT;
      // Its own decay too: two alternate accounts in ever new pairs are still the same two players.
      if (this.playerRepeat) w /= 1 + this.playedRecently(input.operatorId, p.playerId, input.at);
      weighted += minutes * w;
      counted.push(p.playerId);
    }
    const quality = qualityFactor(input.tickLagP99Ms, input.underrunRate);
    const key = groupKey(input.operatorId, counted).key;
    const times = (this.groups.get(key) ?? []).filter((t) => input.at - t < REPEAT_WINDOW_MS);
    const repeat = counted.length === 0 ? 0 : 1 / (1 + times.length);
    times.push(input.at);
    this.groups.set(key, times);
    if (this.playerRepeat) for (const id of counted) this.notePlayer(input.operatorId, id, input.at);
    const sample = input.sampleRate !== undefined && input.sampleRate > 0 && input.sampleRate <= 1 ? input.sampleRate : 1;
    let points = input.verified && input.soloBots !== true ? round2((weighted * regionFactorValue * quality * repeat) / sample) : 0;
    let capped = 0;
    if (this.dailyCap !== null && points > 0) {
      const room = Math.max(0, round2(this.dailyCap - this.pointsToday(input.operatorId, input.at)));
      if (points > room) {
        capped = round2(points - room);
        points = room;
      }
    }
    const entry: LedgerEntry = {
      ...input,
      points,
      playerMinutes: round2(playerMinutes),
      weightedMinutes: round2(weighted),
      regionFactor: regionFactorValue,
      quality,
      repeat,
      ...(capped > 0 ? { capped } : {}),
    };
    this.entries.push(entry);
    this.totals.set(input.operatorId, round2((this.totals.get(input.operatorId) ?? 0) + points));
    if (countsAsHosted(entry)) this.verified.set(input.operatorId, (this.verified.get(input.operatorId) ?? 0) + 1);
    return entry;
  }

  /**
   * One more match of this group on this operator that earns nothing by itself (a casual match
   * that was not sampled for verification). The repeat decay must still see it: the sampled ones
   * are worth 1 / rate, and without it a group farming one operator would earn more than if every
   * match were verified.
   */
  noteGroup(operatorId: string, playerIds: readonly string[], at: number): void {
    const { key, counted } = groupKey(operatorId, playerIds);
    if (counted === 0) return;
    const times = (this.groups.get(key) ?? []).filter((t) => at - t < REPEAT_WINDOW_MS);
    times.push(at);
    this.groups.set(key, times);
    if (this.playerRepeat) for (const id of playerIds) if (id !== operatorId) this.notePlayer(operatorId, id, at);
    this.onNote?.({ operatorId, playerIds: [...playerIds], at });
  }

  /**
   * Its operator's account was purged (Registry.forgetOperator): what the ledger holds of it goes
   * under `alias`, as its nodes do, so its points stay with them (its totals, its entries for the
   * ranking's 30 days, its repeat decay) and nothing links them back to the account: its own seat in
   * an entry of its nodes, too. The store re-keys its rows the same way (NodeStore.forgetOperator).
   * Its seats on other operators' nodes are a player's and stay as they are.
   */
  forgetOperator(operatorId: string, alias: string): void {
    for (const e of this.entries) {
      if (e.operatorId !== operatorId) continue;
      e.operatorId = alias;
      e.players = e.players.map((p) => (p.playerId === operatorId ? { ...p, playerId: alias } : p));
    }
    for (const map of [this.groups, this.players]) {
      for (const [key, times] of [...map]) {
        if (!key.startsWith(operatorId + '|')) continue;
        map.delete(key);
        map.set(alias + key.slice(operatorId.length), times);
      }
    }
    for (const map of [this.totals, this.verified]) {
      const v = map.get(operatorId);
      if (v === undefined) continue;
      map.delete(operatorId);
      map.set(alias, v);
    }
  }

  /** Drop entries older than the window and stale repeat groups (the totals stay). */
  private prune(now: number): void {
    const since = now - WINDOW_DAYS * DAY_MS;
    let k = 0;
    while (k < this.entries.length && this.entries[k].at < since) k++;
    if (k > 0) this.entries.splice(0, k);
    for (const map of [this.groups, this.players]) {
      if (map.size <= 1000) continue;
      for (const [key, times] of map) if (times.every((t) => now - t >= REPEAT_WINDOW_MS)) map.delete(key);
    }
  }

  /** The daily cap (LedgerOptions.dailyCap), or null when there is none. */
  capPerDay(): number | null {
    return this.dailyCap;
  }

  /** The points an operator earned in the UTC day of `now` (what the daily cap counts against). */
  pointsToday(operatorId: string, now: number): number {
    const day = dayOf(now);
    let sum = 0;
    for (const e of this.entries) if (e.operatorId === operatorId && dayOf(e.at) === day) sum += e.points;
    return round2(sum);
  }

  /**
   * How much of an operator's points over the window came from the `top` accounts that played the
   * most on its nodes (the maintainers' Operadores tab: one friend, or a few alternate accounts,
   * behind most of a host's points is what to look at). Each match's points are split among its
   * counted players by their weighted minutes. 0 when it earned nothing.
   */
  concentration(operatorId: string, now: number, top = 3, days = WINDOW_DAYS): { share: number; players: number } {
    const by = new Map<string, { minutes: number; points: number }>();
    let total = 0;
    for (const e of this.recent(now, days)) {
      if (e.operatorId !== operatorId) continue;
      total += e.points;
      const counted = e.players.filter((p) => p.playerId !== operatorId);
      const w = (p: LedgerPlayer) => (Math.max(0, p.connectedMs) / 60_000) * (p.account && p.accountAgeDays >= NEW_ACCOUNT_DAYS ? 1 : LOW_WEIGHT);
      const sum = counted.reduce((s, p) => s + w(p), 0);
      for (const p of counted) {
        const b = by.get(p.playerId) ?? { minutes: 0, points: 0 };
        b.minutes += Math.max(0, p.connectedMs) / 60_000;
        b.points += sum > 0 ? (e.points * w(p)) / sum : 0;
        by.set(p.playerId, b);
      }
    }
    const most = [...by.values()].sort((a, b) => b.minutes - a.minutes).slice(0, top);
    const share = total > 0 ? most.reduce((s, b) => s + b.points, 0) / total : 0;
    return { share: Math.round(Math.min(1, share) * 1000) / 1000, players: by.size };
  }

  /** All points an operator ever earned. */
  earned(operatorId: string): number {
    return this.totals.get(operatorId) ?? 0;
  }

  /** Verified matches an operator's nodes ever hosted for someone else (countsAsHosted). */
  verifiedMatches(operatorId: string): number {
    return this.verified.get(operatorId) ?? 0;
  }

  /** Entries of the last `days` days (newest last). */
  recent(now: number, days = WINDOW_DAYS): LedgerEntry[] {
    const since = now - days * DAY_MS;
    return this.entries.filter((e) => e.at >= since);
  }

  summary(operatorId: string, now: number, days = WINDOW_DAYS): OperatorSummary {
    const mine = this.recent(now, days).filter((e) => e.operatorId === operatorId);
    let points = 0;
    let minutes = 0;
    const byNode: Record<string, { points: number; matches: number }> = {};
    for (const e of mine) {
      points += e.points;
      minutes += e.playerMinutes;
      const b = (byNode[e.nodeId] ??= { points: 0, matches: 0 });
      b.points = round2(b.points + e.points);
      b.matches++;
    }
    return { operatorId, points30d: round2(points), earned: this.earned(operatorId), matches30d: mine.length, playerMinutes30d: round2(minutes), byNode };
  }

  /** Operators by points over the window (the public "Anfitriones" page). */
  leaderboard(now: number, days = WINDOW_DAYS, limit = 50): Array<{ operatorId: string; points: number }> {
    const sums = new Map<string, number>();
    for (const e of this.recent(now, days)) sums.set(e.operatorId, (sums.get(e.operatorId) ?? 0) + e.points);
    return [...sums.entries()]
      .map(([operatorId, p]) => ({ operatorId, points: round2(p) }))
      .filter((e) => e.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }
}
