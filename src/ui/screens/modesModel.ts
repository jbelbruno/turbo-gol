/**
 * MODOS' decisions, pure (no DOM, no texts: tests/modes.test.mjs): its four tabs and their order,
 * the formats a search is named by (1v1, 2v2, 3v3 or any of them, never "pairs"; Casual picks one,
 * the format of its online bots match: it pools every format), the 5:00 "bots join in" countdown
 * (Casual only), the threshold under which a count is not shown, and what the action zone offers on
 * each tab. src/ui/screens/modes.ts puts them on the page.
 *
 * Since the modes redesign (November 2026) Casual and Competitive need an account and always play
 * on a server: the connection picked under Advanced (auto, P2P, server) is gone.
 */
import type { GameMode } from '../../sim/constants';
import type { QueueWait } from '../../net/queueWait';

/** The vertical tabs, in their order on every device. */
export type ModeTab = 'casual' | 'ranked' | 'lobbies' | 'ai';
export const MODE_TABS: readonly ModeTab[] = ['casual', 'ranked', 'lobbies', 'ai'];

export function isModeTab(v: unknown): v is ModeTab {
  return typeof v === 'string' && (MODE_TABS as readonly string[]).includes(v);
}

/** The tab `d` places from `tab`, round (Q / E, LB / RB, LT / RT). */
export function stepTab(tab: ModeTab, d: -1 | 1): ModeTab {
  const i = MODE_TABS.indexOf(tab);
  return MODE_TABS[(i + d + MODE_TABS.length) % MODE_TABS.length];
}

/** A search's format: one playlist, or any of the three (whichever fills first: Competitive only). */
export type Format = GameMode | 'any';
export const FORMATS: readonly Format[] = ['1v1', '2v2', '3v3', 'any'];
/** Casual's grid: one format, the one its online bots match plays (no ANY: Casual pools every format). */
export const PREFER_FORMATS: readonly GameMode[] = ['1v1', '2v2', '3v3'];
const ALL: readonly GameMode[] = ['1v1', '2v2', '3v3'];

/** The formats a tab's grid shows. */
export function formatsOf(kind: 'casual' | 'ranked'): readonly Format[] {
  return kind === 'casual' ? PREFER_FORMATS : FORMATS;
}

/** The format of a stored playlist pick: one playlist is itself, anything else (an older pick of two) any. */
export function formatOf(modes: readonly GameMode[]): Format {
  return modes.length === 1 ? modes[0] : 'any';
}

/** The playlists a format searches. */
export function modesOf(f: Format): GameMode[] {
  return f === 'any' ? ALL.slice() : [f];
}

/** The online bots match comes after this long alone in Casual (GET /api/config queue.soloAfterMs; the hub's SOLO_AFTER_MS). */
export const SOLO_AFTER_MS = 300_000;

/** What decides the 5:00 countdown of a running search. */
export interface BotsInput {
  kind: 'casual' | 'ranked';
  /** performance.now() when the search started, and now. */
  since: number;
  now: number;
  /** The last waiting answer's `wait` (null: none yet, or an older server). */
  wait: QueueWait | null;
  /** performance.now() when that answer arrived. */
  waitAt: number;
  /** The config's queue.soloAfterMs (absent: SOLO_AFTER_MS). */
  soloAfterMs?: number;
}

/**
 * The countdown to Casual's online bots match, as `{ left, total }` ms (total: the 5:00), or null
 * when it would not be true: Competitive never plays bots, the servers are full (`busy`: the match
 * waits for a slot), and a wait that already ran out (the box goes rather than stand at 0:00). From
 * the server's `botsInMs` counted down locally since its answer, else (no answer yet) from the
 * search's start. Pure.
 */
export function botsCountdown(b: BotsInput): { left: number; total: number } | null {
  if (b.kind === 'ranked') return null;
  const total = b.soloAfterMs !== undefined && b.soloAfterMs > 0 ? b.soloAfterMs : SOLO_AFTER_MS;
  const w = b.wait;
  if (w !== null && w.busy) return null;
  const left = w !== null && typeof w.botsInMs === 'number' ? w.botsInMs - Math.max(0, b.now - b.waitAt) : total - Math.max(0, b.now - b.since);
  return left > 0 ? { left: Math.min(left, total), total } : null;
}

/** How many of `segments` the countdown's bar fills (the time left, rounded up). */
export function botsSegments(left: number, total: number, segments: number): number {
  if (!(total > 0)) return 0;
  return Math.min(segments, Math.max(0, Math.ceil((left / total) * segments)));
}

/** Below this many players a count is not shown (a small one reads as an empty game; shell/pills.ts PLAYING_SHOWN). */
export function countShown(n: number | null | undefined, threshold: number): boolean {
  return typeof n === 'number' && n >= threshold;
}

/** What the action zone offers on a tab. */
export type ActionKind = 'search' | 'searching' | 'signIn' | 'banned' | 'play' | 'lobbies';

export interface ActionInput {
  tab: ModeTab;
  signedIn: boolean;
  /** Competitive's abandon ban, ms left (0: none). */
  banLeft: number;
  /** The kind of the search running, null when none. */
  searching: 'casual' | 'ranked' | null;
}

/**
 * The action zone of `tab`: the searching panel on the tab of the running search; Casual and
 * Competitive ask a guest to sign in, Competitive tells a banned player why; VS AI plays, LOBBIES
 * makes a lobby; else FIND MATCH. Pure.
 */
export function actionKind(a: ActionInput): ActionKind {
  if (a.tab === 'ai') return 'play';
  if (a.tab === 'lobbies') return 'lobbies';
  if (a.searching === a.tab) return 'searching';
  if (!a.signedIn) return 'signIn';
  if (a.tab === 'ranked' && a.banLeft > 0) return 'banned';
  return 'search';
}
