/**
 * The menus' own preferences, in localStorage `turbogol.menu.v1` (Menu.ts loads and saves them):
 * the region, Casual's preferred format (the format of its online bots match; Casual pools every
 * format, so with other people searching the format follows how many they are) and that match's
 * bots level (hard unless the player picks another; other people's matches play the server's), the playlists
 * picked for Competitive, the leaderboard's playlist, the kind of the last search started
 * anywhere, which JUGAR AHORA plays again in one press (screens/homeModel.ts heroQueue), the format
 * of the last lobby the player had (CREATE PUBLIC / PRIVATE LOBBY's: screens/lobbyModel.ts
 * lobbyFormat) and the last pick of "While you search" (screens/waitSheet.ts). Pure, no DOM: node
 * tests import it.
 *
 * Casual's connection (MODOS › Advanced: auto, P2P or server) is gone with the modes redesign
 * (November 2026: Casual is always on a server); an older object's `net` is dropped, and its
 * `casualModes` of one playlist becomes `casualPrefer`.
 */
import { isRegion } from '../net/account';
import type { RegionId } from '../net/account';
import type { GameMode } from '../sim/constants';
import type { Difficulty } from '../ai/Bot';
import { STORAGE_PREFIX } from '../brand';

/** What a search's "While you search" sheet offers (focused on the last pick). */
export type WaitChoice = 'bots' | 'training' | 'menu';

export interface MenuPrefs {
  region: RegionId | null;
  /** Casual's format when it plays bots online (the 5-minute match), and its search's `prefer`. */
  casualPrefer: GameMode;
  /** The bots' level of that match (the search's `bots`); a match with other people plays the server's level. */
  casualBots: Difficulty;
  rankedModes: GameMode[];
  leaderboardPlaylist: GameMode;
  /** The kind of the last search started anywhere (hero, Casual, Competitive): what JUGAR AHORA repeats. */
  lastQueue: 'casual' | 'ranked';
  /** The format of the last lobby this player created or set (null: none yet). */
  lobbyMode: GameMode | null;
  /** The last pick of "While you search" (the sheet's focus). */
  waitChoice: WaitChoice;
}

/** The same key as before: an older object reads with these defaults for what it lacks, no migration step. */
export const PREFS_KEY = STORAGE_PREFIX + 'menu.v1';

/** A first visit: Casual preferring 2v2 against hard bots in the automatic region (the connection's continent), bots while waiting. */
export const DEFAULT_PREFS: Readonly<MenuPrefs> = { region: null, casualPrefer: '2v2', casualBots: 'hard', rankedModes: ['2v2'], leaderboardPlaylist: '2v2', lastQueue: 'casual', lobbyMode: null, waitChoice: 'bots' };

const isMode = (v: unknown): v is GameMode => v === '1v1' || v === '2v2' || v === '3v3';
const isLevel = (v: unknown): v is Difficulty => v === 'easy' || v === 'medium' || v === 'hard';

/** The prefs stored as `raw` (null when none); anything unreadable takes its default. Pure. */
export function parsePrefs(raw: string | null): MenuPrefs {
  const d: MenuPrefs = { ...DEFAULT_PREFS, rankedModes: DEFAULT_PREFS.rankedModes.slice() };
  if (!raw) return d;
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return d;
    o = v as Record<string, unknown>;
  } catch {
    return d;
  }
  const modes = (v: unknown): GameMode[] | null => (Array.isArray(v) && v.length > 0 && v.every(isMode) ? (v as GameMode[]) : null);
  // An older page's Casual pick: one playlist is the preferred format, several (ANY) the default.
  const oldCasual = modes(o.casualModes);
  const prefer = isMode(o.casualPrefer) ? o.casualPrefer : oldCasual !== null && oldCasual.length === 1 ? oldCasual[0] : d.casualPrefer;
  return {
    region: isRegion(o.region) ? o.region : null,
    casualPrefer: prefer,
    casualBots: isLevel(o.casualBots) ? o.casualBots : d.casualBots,
    rankedModes: modes(o.rankedModes) ?? d.rankedModes,
    leaderboardPlaylist: o.leaderboardPlaylist === '1v1' || o.leaderboardPlaylist === '3v3' ? o.leaderboardPlaylist : '2v2',
    lastQueue: o.lastQueue === 'ranked' ? 'ranked' : 'casual',
    lobbyMode: isMode(o.lobbyMode) ? o.lobbyMode : null,
    waitChoice: o.waitChoice === 'training' || o.waitChoice === 'menu' ? o.waitChoice : 'bots',
  };
}
