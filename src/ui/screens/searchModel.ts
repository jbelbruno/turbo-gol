/**
 * A running search's lines (the modes redesign, November 2026: spec §3.3), pure (no DOM, no texts:
 * tests/search-model.test.mjs), the same for every surface that shows them: MODOS' searching panel
 * (all five), Inicio's hero (the clock and the estimate), the HUD strip while the player plays
 * waiting (src/game/Game.ts: the clock and the estimate, or the override).
 *
 *   1. the clock, local, from the search's start (its first POST: searchStart);
 *   2. the estimate: "Match in ~2 min" (another player is expected first), "Bots in 3:37 at most"
 *      (Casual's online bots match comes first), "No estimate yet";
 *   3. the people: "Only you for now", "3 people searching" (+ " · 1 in South America" when they differ);
 *   4. the reach: "In 0:37 we also search other regions", then "Searching every region";
 *   5. an override: the servers full (`busy`), or the client retrying without a network.
 *
 * The server's numbers (POST /api/queue's `wait`, src/net/queueWait.ts) refresh at most every 25 s
 * (the long-poll); between answers the client counts estimateMs, botsInMs and widenInMs down
 * locally from the answer's arrival (`waitAt`). With no answer yet (`wait` null: the first round
 * trip, or an older server) lines 1 and 2 still show from local values: the clock, and for Casual
 * the 5:00 box and "Bots in {t} at most" from the start and GET /api/config's queue.soloAfterMs;
 * line 3 is hidden and line 4 counts from queue.widenMs. Times are ms; the screens format them.
 *
 * Also the clock's start once the server said it (searchStart: an answer's waitedMs), the region
 * line 3's "· 1 in South America" names (answerRegion: the answer's, never the client's guess),
 * and when Menu opens "While you search" (waitSheetStep).
 */
import type { QueueWait } from '../../net/queueWait';
import { isRegion } from '../../net/account';
import type { RegionId } from '../../net/account';
import { SOLO_AFTER_MS, botsCountdown } from './modesModel';
import type { Difficulty } from '../../ai/Bot';

/** "While you search" opens this long after the search's first POST left, answered or not (the hub may long-poll a reloaded page's first). */
export const WAIT_SHEET_AFTER_MS = 1_000;

/**
 * When the search started, for every clock that shows it: the server's (an answer's `waitedMs`,
 * counted back from when it arrived) once there is one, else when its first POST left (`postedAt`,
 * NetClient.queuePostedAt), else `now`: before that POST (the terms sheet or the sign-in still up)
 * the clock and the 5:00 box stand at 0:00 and 5:00 rather than count a wait the server has not
 * started. After a restored or restarted search (a reload, a long drop) the clock and the 5:00 box
 * then never disagree. `now` left out: the local start. Pure.
 */
export function searchStart(localSince: number, wait: QueueWait | null, waitAt: number, postedAt = 0, now = localSince): number {
  if (wait !== null) return waitAt - wait.waitedMs;
  if (postedAt > 0) return postedAt;
  return Math.max(localSince, now);
}

/** The region a waiting answer counts `searchingHere` in (the hub's normalized home), when it is one of ours. Pure. */
export function answerRegion(region: string | null | undefined): RegionId | null {
  return isRegion(region) ? region : null;
}

/** What Menu does about a due "While you search" sheet on this tick. */
export type WaitSheetStep = 'open' | 'drop' | 'wait';

/**
 * The sheet a search started from Inicio's hero or the FINAL owes (spec §3.4): dropped once the
 * search ended or matched, or MODOS (whose panel has the choice) is on top; opened over the menus
 * (none of their sheets up) on the first waiting answer, or once the first POST has been out
 * WAIT_SHEET_AFTER_MS while still queueing (after the terms and the session: that POST goes only
 * then); else it waits. Pure.
 */
export function waitSheetStep(s: { queueing: boolean; onModes: boolean; answers: number; postedAt: number; now: number; menusFree: boolean }): WaitSheetStep {
  if (!s.queueing || s.onModes) return 'drop';
  const due = s.answers > 0 || (s.postedAt > 0 && s.now - s.postedAt >= WAIT_SHEET_AFTER_MS);
  return due && s.menusFree ? 'open' : 'wait';
}

/** GET /api/config's `queue` (what the client reads of it), with the hub's defaults. */
export interface QueueTimes {
  soloAfterMs: number;
  widenMs: { casual: number; ranked: number };
  /** The bots' level of Casual's 5:00 solo match while its player picked none (the KV flag bot_level; absent from an older Worker): MODOS shows it picked. */
  botLevel?: Difficulty;
}

export const DEFAULT_QUEUE_TIMES: Readonly<QueueTimes> = { soloAfterMs: SOLO_AFTER_MS, widenMs: { casual: 60_000, ranked: 120_000 } };

/** What a search shows its lines from. */
export interface WaitView {
  kind: 'casual' | 'ranked';
  /** performance.now() when the search started. */
  since: number;
  /** The last waiting answer's `wait`, null before the first (or from an older server). */
  wait: QueueWait | null;
  /** performance.now() when that answer arrived. */
  waitAt: number;
  /** The queue's requests fail and are retried (NetClient.queueRetrying). */
  retrying: boolean;
  /** GET /api/config's queue times (null: the defaults). */
  times: QueueTimes | null;
}

export type EstimateLine = { kind: 'humans'; ms: number } | { kind: 'bots'; ms: number } | { kind: 'none' };
export type PeopleLine = { kind: 'alone' } | { kind: 'count'; count: number; here: number | null };
export type ReachLine = { kind: 'widenIn'; ms: number } | { kind: 'widened' };

export interface WaitLines {
  /** Line 1: ms since the search started. */
  elapsedMs: number;
  estimate: EstimateLine;
  /** null: hidden (no answer yet). */
  people: PeopleLine | null;
  reach: ReachLine;
  override: 'busy' | 'retrying' | null;
  /** The 5:00 box (Casual, not busy): ms left and its total. */
  bots: { left: number; total: number } | null;
}

/** An estimate counted down locally, shown in the server's steps: 30 s below 5 min, 1 min above, never under 30 s. */
export function roughMs(ms: number): number {
  const step = ms < 300_000 ? 30_000 : 60_000;
  return Math.max(30_000, Math.ceil(ms / step) * step);
}

/** The lines of a running search at `now`. Pure. */
export function waitLines(v: WaitView, now: number): WaitLines {
  const times = v.times ?? DEFAULT_QUEUE_TIMES;
  const w = v.wait;
  const age = w !== null ? Math.max(0, now - v.waitAt) : 0;
  const elapsed = Math.max(0, now - v.since);
  const bots = botsCountdown({ kind: v.kind, since: v.since, now, wait: w, waitAt: v.waitAt, soloAfterMs: times.soloAfterMs });
  // The online bots match's time left (Casual), counted with or without an answer; 0 once due.
  const botsLeft = (): number => {
    if (w !== null && typeof w.botsInMs === 'number') return Math.max(0, w.botsInMs - age);
    return Math.max(0, times.soloAfterMs - elapsed);
  };
  let estimate: EstimateLine;
  if (w === null) estimate = v.kind === 'casual' ? { kind: 'bots', ms: botsLeft() } : { kind: 'none' };
  else if (w.estimateKind === 'humans' && w.estimateMs !== null) {
    const ms = roughMs(Math.max(0, w.estimateMs - age));
    // Casual's estimate is never past its bots match: once it would be, the bots come first.
    estimate = v.kind === 'casual' && ms >= botsLeft() ? { kind: 'bots', ms: botsLeft() } : { kind: 'humans', ms };
  } else if (w.estimateKind === 'bots' && v.kind === 'casual') estimate = { kind: 'bots', ms: botsLeft() };
  else estimate = { kind: 'none' };
  let people: PeopleLine | null = null;
  if (w !== null) people = w.searching <= 1 ? { kind: 'alone' } : { kind: 'count', count: w.searching, here: w.searchingHere !== w.searching ? w.searchingHere : null };
  let reach: ReachLine;
  if (w !== null) {
    const left = w.widened ? 0 : w.widenInMs - age;
    reach = left > 0 ? { kind: 'widenIn', ms: left } : { kind: 'widened' };
  } else {
    const left = times.widenMs[v.kind] - elapsed;
    reach = left > 0 ? { kind: 'widenIn', ms: left } : { kind: 'widened' };
  }
  const override = v.retrying ? 'retrying' : w !== null && w.busy ? 'busy' : null;
  return { elapsedMs: elapsed, estimate, people, reach, override, bots };
}
