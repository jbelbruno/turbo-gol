/**
 * The public queues' anonymous daily counters (the build spec's §2.6), pure so
 * server/test/queue-stats.test.mjs runs them without workerd. The queue hub (MatchmakerDO 'mm:SA')
 * keeps today's row in memory, writes it to its own storage as 'stats:YYYY-MM-DD' (UTC) at most
 * every STATS_FLUSH_MS and at the day change, and deletes the rows older than STATS_KEEP_DAYS at
 * that day-change flush. GET /nodes/admin/queue-stats reads them (nodeRoutes.ts).
 *
 * Totals only: no id, no name, no address and no region split (only how many matches mixed
 * regions). On a day with one or two searchers a row still describes those few people, so the
 * texts say "sin tu cuenta, tu nombre ni tu IP", never "sin identificar a nadie".
 */

/** Rows kept, in days (today included). */
export const STATS_KEEP_DAYS = 90;
/** Today's row is written at most this often (and at the day change). */
export const STATS_FLUSH_MS = 60_000;
/** The storage key prefix of a day's row. */
export const STATS_PREFIX = 'stats:';

export type StatsKind = 'casual' | 'ranked';
/** What the player does locally while it waits (POST /api/queue `local`). */
export type LocalPlay = 'bots' | 'training';

/** The wait buckets: a wait counts in the first one it is at most. */
export const WAIT_BUCKETS: ReadonlyArray<readonly [WaitBucket, number]> = [
  ['15s', 15_000],
  ['30s', 30_000],
  ['1m', 60_000],
  ['2m', 120_000],
  ['3m', 180_000],
  ['5m', 300_000],
  ['10m', 600_000],
  ['30m', 1_800_000],
];
export type WaitBucket = '15s' | '30s' | '1m' | '2m' | '3m' | '5m' | '10m' | '30m' | 'more';
const BUCKET_NAMES: readonly WaitBucket[] = ['15s', '30s', '1m', '2m', '3m', '5m', '10m', '30m', 'more'];
const CASUAL_HUMANS = ['1', '2', '3', '4', '5', '6'] as const;
const RANKED_HUMANS = ['2', '4', '6'] as const;

/** One UTC day of counters. */
export interface QueueDay {
  date: string;
  /** New searches (a search restored within RECENT_MS is not counted again). */
  searches: Record<StatsKind, number>;
  /** Explicit leaves (CANCELAR). */
  cancelled: Record<StatsKind, number>;
  /** Searches that stopped polling and did not come back within RECENT_MS. */
  dropped: Record<StatsKind, number>;
  /** Matches formed, by human count ('1' = the 5:00 solo matches). */
  formed: { casual: Record<(typeof CASUAL_HUMANS)[number], number>; ranked: Record<(typeof RANKED_HUMANS)[number], number> };
  /** Matches whose humans came from more than one region. */
  crossRegion: number;
  /** Matches placed on a community node / on a MatchDO. */
  onNode: number;
  onCloud: number;
  /** One count per human of a formed match, by its wait. */
  waits: Record<StatsKind, Record<WaitBucket, number>>;
  /** A waiter's `local` changing into that value. */
  localStarts: Record<LocalPlay, number>;
  /** Matches with at least one human in local play when they formed. */
  formedWhileLocal: number;
}

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

/** An empty row for `date`. */
export function emptyDay(date: string): QueueDay {
  return {
    date,
    searches: { casual: 0, ranked: 0 },
    cancelled: { casual: 0, ranked: 0 },
    dropped: { casual: 0, ranked: 0 },
    formed: { casual: zeros(CASUAL_HUMANS), ranked: zeros(RANKED_HUMANS) },
    crossRegion: 0,
    onNode: 0,
    onCloud: 0,
    waits: { casual: zeros(BUCKET_NAMES), ranked: zeros(BUCKET_NAMES) },
    localStarts: { bots: 0, training: 0 },
    formedWhileLocal: 0,
  };
}

/** The UTC day of `ms` as YYYY-MM-DD. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `n` days before `date` (YYYY-MM-DD, UTC). */
export function daysBefore(date: string, n: number): string {
  return dayOf(Date.parse(date + 'T00:00:00Z') - n * 86_400_000);
}

/** A stored row older than the kept window (`today` included in it, STATS_KEEP_DAYS days). */
export function expiredDay(date: string, today: string, keepDays: number = STATS_KEEP_DAYS): boolean {
  return date < daysBefore(today, keepDays - 1);
}

/** The bucket a wait of `ms` counts in. */
export function bucketOf(ms: number): WaitBucket {
  for (const [name, max] of WAIT_BUCKETS) if (ms <= max) return name;
  return 'more';
}

/** What addFormed takes of a formed match. */
export interface FormedInfo {
  kind: StatsKind;
  /** Humans in it (1 = a solo match). */
  humans: number;
  /** Each human's wait. */
  waits: readonly number[];
  /** Its humans came from more than one region. */
  crossRegion: boolean;
  /** Placed on a community node (else a MatchDO). */
  onNode: boolean;
  /** At least one human was playing locally (bots or training). */
  whileLocal: boolean;
}

/** `day` with one formed match counted (in place; returned for chaining). */
export function addFormed(day: QueueDay, m: FormedInfo): QueueDay {
  const key = String(m.humans);
  const formed = day.formed[m.kind] as Record<string, number>;
  if (Object.hasOwn(formed, key)) formed[key]++;
  if (m.crossRegion) day.crossRegion++;
  if (m.onNode) day.onNode++;
  else day.onCloud++;
  for (const w of m.waits) day.waits[m.kind][bucketOf(w)]++;
  if (m.whileLocal) day.formedWhileLocal++;
  return day;
}

/** A non-negative integer, else 0 (a stored row of another shape counts nothing). */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function countsOf<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> {
  const out = zeros(keys);
  if (typeof v === 'object' && v !== null) for (const k of keys) out[k] = count((v as Record<string, unknown>)[k]);
  return out;
}

/** A stored row as a QueueDay of `date` (missing or junk fields read as 0). */
export function parseDay(v: unknown, date: string): QueueDay {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const formed = (typeof o.formed === 'object' && o.formed !== null ? o.formed : {}) as Record<string, unknown>;
  const waits = (typeof o.waits === 'object' && o.waits !== null ? o.waits : {}) as Record<string, unknown>;
  return {
    date,
    searches: countsOf(o.searches, ['casual', 'ranked'] as const),
    cancelled: countsOf(o.cancelled, ['casual', 'ranked'] as const),
    dropped: countsOf(o.dropped, ['casual', 'ranked'] as const),
    formed: { casual: countsOf(formed.casual, CASUAL_HUMANS), ranked: countsOf(formed.ranked, RANKED_HUMANS) },
    crossRegion: count(o.crossRegion),
    onNode: count(o.onNode),
    onCloud: count(o.onCloud),
    waits: { casual: countsOf(waits.casual, BUCKET_NAMES), ranked: countsOf(waits.ranked, BUCKET_NAMES) },
    localStarts: countsOf(o.localStarts, ['bots', 'training'] as const),
    formedWhileLocal: count(o.formedWhileLocal),
  };
}

/** Every count of `a` plus `b`'s, as a new row of `a`'s date (a flush: the stored row plus the memory's). */
export function mergeDays(a: QueueDay, b: QueueDay): QueueDay {
  const add = (x: unknown, y: unknown): unknown => {
    if (typeof x === 'number' && typeof y === 'number') return x + y;
    if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x)) out[k] = add((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  };
  return { ...(add(a, b) as QueueDay), date: a.date };
}

/** The row has no count at all (nothing to write). */
export function emptyRow(d: QueueDay): boolean {
  const any = (v: unknown): boolean => (typeof v === 'number' ? v > 0 : typeof v === 'object' && v !== null ? Object.values(v).some(any) : false);
  return !any({ ...d, date: undefined });
}

/** GET /daily-stats?days=: 1 to 90 (default 30); anything else is the default. */
export function statsDays(v: string | null): number {
  if (v === null || !/^\d{1,3}$/.test(v)) return 30;
  const n = Number(v);
  return n >= 1 && n <= STATS_KEEP_DAYS ? n : 30;
}
