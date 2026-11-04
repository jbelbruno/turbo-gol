/**
 * The public queues' plan (modes redesign, November 2026; the build spec's §1.4, §1.8 and §2.2),
 * pure so server/test/queue-plan.test.mjs runs it without workerd. The queue hub (MatchmakerDO
 * 'mm:SA') calls it on every join and every sweep:
 *
 *   casualFormat  how many humans play which format (1 = the lone player's own pick)
 *   planCasual    which casual waiters form together now: widened first, then each region, then
 *                 the lone 5:00 waiter (a solo match with bots, only while its tab is visible)
 *   hostRegion    where a formed match is played: the region of most of its humans (a tie: the
 *                 region of the one who waited longest)
 *   locationHintOf the Durable Object location hint of a host region
 *   estimateWait  the rough time to a match that a waiting answer shows (QueueWait)
 *   encodeArrivals / decodeArrivals  the estimator's arrivals ring as one compact storage row
 *
 * Nothing here reads a clock, storage or the network: every input is an argument.
 */
import type { GameModeId } from './env';
import { QUEUE_HUB } from './env';
import { isRegion } from '../../src/net/account';
import type { RegionId } from '../../src/net/account';
import type { QueueWait } from '../../src/net/queueWait';

/** A casual waiter's search reaches every region after this wait (decision 8). */
export const CASUAL_WIDEN_MS = 60_000;
/** ... a ranked waiter's after this one (both sides widened, like the MMR windows). */
export const RANKED_WIDEN_MS = 120_000;
/** A lone casual waiter plays an online match with bots after this wait (decision 5). */
export const SOLO_AFTER_MS = 300_000;
/** A dropped search (no POST for STALE_MS) is kept this long: a join within it continues the clock. */
export const RECENT_MS = 600_000;
/** At most this many solo bots MatchDO matches at once, in total (a cap, not a reservation). */
export const SOLO_ROOMS_MAX = 5;
/** A solo match released this soon after it formed was never played (no match ends that soon). */
export const SOLO_UNPLAYED_MS = 90_000;
/** The arrivals the estimator counts: new searches of the last hour, at most ARRIVALS_MAX rows. */
export const ARRIVALS_WINDOW_MS = 60 * 60_000;
export const ARRIVALS_MAX = 2_000;
/** The most humans one casual match takes (3v3); the rest stay queued with their own clocks. */
export const CASUAL_MAX_HUMANS = 6;
/** A ranked estimate above this is no estimate (null). */
const RANKED_ESTIMATE_MAX_MS = 60 * 60_000;

/**
 * A waiter's region as the hub keeps it: one of the six REGIONS ids. Anything else (the raw
 * continent of autoRegion: 'AN', 'T1', or 'dev' under wrangler dev) is the hub's own region.
 */
export function normalizeHome(v: unknown): RegionId {
  return isRegion(v) ? v : QUEUE_HUB;
}

/** The format a casual match of `humans` humans is played in: 1 = `prefer`, 2-4 = 2v2, 5 and more = 3v3. */
export function casualFormat(humans: number, prefer: GameModeId = '2v2'): GameModeId {
  if (humans <= 1) return prefer;
  return humans <= 4 ? '2v2' : '3v3';
}

/** What the plan needs of a casual waiter. */
export interface PlanWaiter {
  playerId: string;
  home: RegionId;
  prefer: GameModeId;
  joinedAt: number;
  /** The tab was visible at its last POST: only a visible waiter gets the solo match. */
  visible: boolean;
}

/** One casual match to form now: its humans in join order, its format, and whether it is the 5:00 solo match. */
export interface PlanGroup<T extends PlanWaiter> {
  humans: T[];
  mode: GameModeId;
  solo: boolean;
}

/** In join order (oldest first; a tie keeps the given order). */
function byJoin<T extends { joinedAt: number }>(list: readonly T[]): T[] {
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.joinedAt - b.w.joinedAt || a.i - b.i)
    .map((x) => x.w);
}

/**
 * The casual groups to form now, in the order to form them (§1.4):
 *   1. widened first: while 2 or more waiters are left and the oldest of them has waited
 *      CASUAL_WIDEN_MS, the oldest CASUAL_MAX_HUMANS of every region form;
 *   2. each region with 2 or more waiters left: its oldest CASUAL_MAX_HUMANS form (again while 2 are left);
 *   3. a waiter left alone that waited SOLO_AFTER_MS with its tab visible: its solo match.
 * A group the caller cannot form now (a cap) stays queued; the next pass plans again.
 */
export function planCasual<T extends PlanWaiter>(waiters: readonly T[], now: number, widenMs: number = CASUAL_WIDEN_MS, soloMs: number = SOLO_AFTER_MS): PlanGroup<T>[] {
  const left = byJoin(waiters);
  const groups: PlanGroup<T>[] = [];
  const take = (humans: T[], solo: boolean): void => {
    for (const h of humans) left.splice(left.indexOf(h), 1);
    groups.push({ humans, mode: casualFormat(humans.length, humans[0].prefer), solo });
  };
  while (left.length >= 2 && now - left[0].joinedAt >= widenMs) take(left.slice(0, CASUAL_MAX_HUMANS), false);
  for (;;) {
    const homes = new Map<RegionId, T[]>();
    for (const w of left) {
      const list = homes.get(w.home);
      if (list) list.push(w);
      else homes.set(w.home, [w]);
    }
    const ready = [...homes.values()].find((list) => list.length >= 2);
    if (ready === undefined) break;
    take(ready.slice(0, CASUAL_MAX_HUMANS), false);
  }
  for (const w of left.slice()) if (now - w.joinedAt >= soloMs && w.visible) take([w], true);
  return groups;
}

/**
 * Where a match of these humans is played: the region of most of them; on a tie, the tied region
 * whose oldest human waited longest. Pure.
 */
export function hostRegion(humans: readonly { home: RegionId; joinedAt: number }[]): RegionId {
  const count = new Map<RegionId, { n: number; oldest: number }>();
  for (const h of humans) {
    const c = count.get(h.home);
    if (c) {
      c.n++;
      c.oldest = Math.min(c.oldest, h.joinedAt);
    } else count.set(h.home, { n: 1, oldest: h.joinedAt });
  }
  let best: RegionId = QUEUE_HUB;
  let bestN = 0;
  let bestOldest = Infinity;
  for (const [home, c] of count) {
    if (c.n > bestN || (c.n === bestN && c.oldest < bestOldest)) {
      best = home;
      bestN = c.n;
      bestOldest = c.oldest;
    }
  }
  return best;
}

/** The Durable Object location hint of each region (best effort: only counts when an object is created). */
const LOCATION_HINTS: Readonly<Record<RegionId, DurableObjectLocationHint>> = { SA: 'sam', NA: 'enam', EU: 'weur', AS: 'apac', OC: 'oc', AF: 'afr' };

/** The location hint a MatchDO hosted in `region` is created with (total over the six ids; anything else as the hub's). */
export function locationHintOf(region: string): DurableObjectLocationHint {
  return LOCATION_HINTS[normalizeHome(region)];
}

/** One new search (never a restored one): the estimator's arrival rate. Memory only, no id. */
export interface Arrival {
  at: number;
  kind: 'casual' | 'ranked';
  home: RegionId;
}

/**
 * Other players' arrivals of `kind` in the last ARRIVALS_WINDOW_MS: of `home` and of every home.
 * `selfJoinedAt` (the asker's own search start) takes its own arrival out when it is in the window.
 */
export function countArrivals(arrivals: readonly Arrival[], kind: Arrival['kind'], home: RegionId, now: number, selfJoinedAt: number | null): { here: number; all: number } {
  let here = 0;
  let all = 0;
  for (const a of arrivals) {
    if (a.kind !== kind || now - a.at > ARRIVALS_WINDOW_MS || a.at > now) continue;
    all++;
    if (a.home === home) here++;
  }
  if (selfJoinedAt !== null && now - selfJoinedAt <= ARRIVALS_WINDOW_MS) {
    all = Math.max(0, all - 1);
    here = Math.max(0, here - 1);
  }
  return { here, all };
}

/** The estimate's rounding: up to 30 s steps below 5 minutes, 1 minute steps above. */
export function roundEstimate(ms: number): number {
  if (!(ms > 0)) return 0;
  const step = ms < 5 * 60_000 ? 30_000 : 60_000;
  return Math.ceil(ms / step) * step;
}

/** What estimateWait needs (the hub gathers it). */
export interface WaitInput {
  kind: 'casual' | 'ranked';
  waitedMs: number;
  /** Players searching this kind now, every region, the asker included (ranked: sharing a playlist with it) ... */
  searching: number;
  /** ... of its region. */
  searchingHere: number;
  /** Other players' new searches of this kind in the last hour, of the asker's region and of every region (countArrivals). */
  arrivalsHere: number;
  arrivalsAll: number;
  /** Casual: the widen-in of the oldest OTHER unmatched waiter (none: null). */
  othersWidenInMs?: number | null;
  /** Ranked: humans still missing in the asker's best playlist, counting the fitting waiters of its region / of every region. */
  missingHere?: number;
  missingAll?: number;
  /** A match could form but every server is full. */
  busy: boolean;
}

/** 1 / rate (ms per arrival); Infinity without arrivals. */
function perArrival(n: number): number {
  return n > 0 ? ARRIVALS_WINDOW_MS / n : Infinity;
}

/**
 * The waiting answer's `wait` (§2.2). Casual: the next arrival here, or anywhere once widened (an
 * arrival elsewhere pairs at the widening), or the moment either this waiter or the oldest other
 * one is widened; capped by the 5:00 bots match: kind 'bots' when that comes first, or when the
 * rounded estimate would reach it (never "~5 min" next to "bots in 5:00"). Ranked: the missing
 * humans at the arrival rate (here, or here then everywhere after the widening); none above an
 * hour. A waiter held by a cap (`busy`: its match could form, every server is full) gets no
 * estimate at all (kind 'none', null): nobody it waits for is missing, and the bots match needs a
 * server too; the client shows its busy line instead. Pure.
 */
export function estimateWait(input: WaitInput): QueueWait {
  const waited = Math.max(0, input.waitedMs);
  const base = { searching: Math.max(1, input.searching), searchingHere: Math.max(1, Math.min(input.searchingHere, Math.max(1, input.searching))), waitedMs: waited, busy: input.busy };
  if (input.kind === 'casual') {
    const widenInMs = Math.max(0, CASUAL_WIDEN_MS - waited);
    const widened = widenInMs === 0;
    const botsInMs = Math.max(0, SOLO_AFTER_MS - waited);
    if (input.busy) return { ...base, widened, widenInMs, estimateMs: null, estimateKind: 'none', botsInMs };
    const here = perArrival(input.arrivalsHere);
    const all = perArrival(input.arrivalsAll);
    let t = widened ? all : Math.min(here, Math.max(widenInMs, all));
    if (!widened && input.othersWidenInMs !== undefined && input.othersWidenInMs !== null) t = Math.min(t, widenInMs, Math.max(0, input.othersWidenInMs));
    const rounded = roundEstimate(t);
    if (t >= botsInMs || rounded >= botsInMs) return { ...base, widened, widenInMs, estimateMs: botsInMs, estimateKind: 'bots', botsInMs };
    return { ...base, widened, widenInMs, estimateMs: rounded, estimateKind: 'humans', botsInMs };
  }
  const widenInMs = Math.max(0, RANKED_WIDEN_MS - waited);
  const widened = widenInMs === 0;
  if (input.busy) return { ...base, widened, widenInMs, estimateMs: null, estimateKind: 'none' };
  const time = (k: number | undefined, n: number): number => (k === undefined ? Infinity : k <= 0 ? 0 : k * perArrival(n));
  const kAll = input.missingAll;
  const kHere = input.missingHere ?? kAll;
  const t = widened ? time(kAll, input.arrivalsAll) : Math.min(time(kHere, input.arrivalsHere), widenInMs + time(kAll, input.arrivalsAll));
  if (!Number.isFinite(t) || t > RANKED_ESTIMATE_MAX_MS) return { ...base, widened, widenInMs, estimateMs: null, estimateKind: 'none' };
  return { ...base, widened, widenInMs, estimateMs: roundEstimate(t), estimateKind: 'humans' };
}

/** The six homes in a fixed order: an arrival's home is stored as its index (encodeArrivals). */
const HOMES: readonly RegionId[] = ['SA', 'NA', 'EU', 'AS', 'OC', 'AF'];

/**
 * The arrivals ring as one storage row (the hub writes it with the daily counters, never per
 * request, so the estimate survives an eviction): `t0` the first kept arrival in whole seconds,
 * then one triple per arrival, oldest first: seconds after t0, kind (0 casual, 1 ranked), home
 * (an index of HOMES). Only the last ARRIVALS_WINDOW_MS before `now`, at most ARRIVALS_MAX (the
 * newest). No id: the same three fields as the ring itself. Pure.
 */
export interface ArrivalsRow {
  v: 1;
  t0: number;
  a: number[];
}

/** The ring as an ArrivalsRow at `now` (see above). Pure. */
export function encodeArrivals(list: readonly Arrival[], now: number): ArrivalsRow {
  const kept = list.filter((x) => now - x.at <= ARRIVALS_WINDOW_MS && x.at <= now).slice(-ARRIVALS_MAX);
  const t0 = kept.length > 0 ? Math.floor(kept[0].at / 1000) : 0;
  const a: number[] = [];
  for (const x of kept) a.push(Math.floor(x.at / 1000) - t0, x.kind === 'ranked' ? 1 : 0, Math.max(0, HOMES.indexOf(x.home)));
  return { v: 1, t0, a };
}

/** A stored ArrivalsRow back as the ring (oldest first, at most ARRIVALS_MAX); anything of another shape reads as none. Pure. */
export function decodeArrivals(v: unknown): Arrival[] {
  if (typeof v !== 'object' || v === null) return [];
  const row = v as Partial<ArrivalsRow>;
  if (row.v !== 1 || typeof row.t0 !== 'number' || !Number.isFinite(row.t0) || !Array.isArray(row.a) || row.a.length % 3 !== 0) return [];
  const out: Arrival[] = [];
  for (let i = 0; i < row.a.length; i += 3) {
    const [dt, k, h] = [row.a[i], row.a[i + 1], row.a[i + 2]];
    if (typeof dt !== 'number' || !Number.isFinite(dt) || (k !== 0 && k !== 1) || typeof h !== 'number' || HOMES[h] === undefined) continue;
    out.push({ at: (row.t0 + dt) * 1000, kind: k === 1 ? 'ranked' : 'casual', home: HOMES[h] });
  }
  return out.slice(-ARRIVALS_MAX);
}
