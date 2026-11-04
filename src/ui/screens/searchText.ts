/**
 * The words of a running search's lines (screens/searchModel.ts waitLines gives the numbers): the
 * estimate, the people, the reach and an override, for MODOS' searching panel, Inicio's hero and
 * the HUD's strip while the player plays waiting (src/game/Game.ts). A countdown in m:ss rounds up
 * (3:37 left reads 3:37 until the second is over); "about" times go by duration() ("2 min").
 */
import { clock } from '../dom';
import { duration, t } from '../../i18n';
import type { EstimateLine, PeopleLine, ReachLine, WaitLines } from './searchModel';

/** A countdown in m:ss, rounded up. */
const down = (ms: number): string => clock(Math.max(0, ms) + 999);

/** Line 2: "Match in ~2 min", "Bots in 3:37 at most", "No estimate yet". */
export function estimateText(e: EstimateLine): string {
  if (e.kind === 'humans') return t('search.estimate', { time: duration(e.ms) });
  if (e.kind === 'bots') return t('search.estimateBots', { time: down(e.ms) });
  return t('search.estimateNone');
}

/** Line 3: "Only you for now", "3 people searching · 1 in South America" (`region`: the search's region name). */
export function peopleText(p: PeopleLine, region: string | null): string {
  if (p.kind === 'alone') return t('search.searchingAlone');
  const all = t('search.searching', { count: p.count });
  return p.here !== null && region !== null ? `${all} · ${t('search.searchingHere', { count: p.here, region })}` : all;
}

/** Line 4: "In 0:37 we also search other regions", "Searching every region". */
export function reachText(r: ReachLine): string {
  return r.kind === 'widenIn' ? t('search.widenIn', { time: down(r.ms) }) : t('search.widened');
}

/** Line 5: the servers full, the network away; null when neither. */
export function overrideText(o: WaitLines['override']): string | null {
  return o === 'retrying' ? t('search.retrying') : o === 'busy' ? t('search.busy') : null;
}

/**
 * The HUD's strip while the player plays waiting: "Finding CASUAL · 1:23 · Bots in 3:37 at most ·
 * Pause: cancel" (lines 1 and 2, or line 5 when it applies, and always the way to cancel).
 */
export function hudSearchLine(kind: 'casual' | 'ranked', lines: WaitLines): string {
  const head = t('search.hudLine', { kind: t(kind === 'ranked' ? 'menu.searchRanked' : 'menu.searchCasual'), time: clock(lines.elapsedMs) });
  return [head, overrideText(lines.override) ?? estimateText(lines.estimate), t('search.hudCancel')].join(' · ');
}
