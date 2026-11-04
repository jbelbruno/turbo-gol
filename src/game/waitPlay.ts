/**
 * Local play while a search runs (the modes redesign, November 2026: spec §3.4, §3.5), the pure
 * transitions the Game follows (tests/wait-play.test.mjs; Game.ts cannot load under node):
 *
 *   off ──start (only while a search queues)──▶ bots | training
 *   bots | training ──the search left its queue for a match (handOff)──▶ entering ──on screen──▶ off
 *                                                                        └─a failed connect──▶ off (menus)
 *   bots | training ──the search died (searchDied: cancelled, refused, a final error)──▶ the same
 *                     play, `searching` false (the bots match stays unlimited; SEARCH AGAIN: searchAgain)
 *   bots | training ──QUIT (quitWait)──▶ off, back to the menus still searching (when it still runs)
 *
 * `bots` is an unlimited match against the bots (Game.waitMatch, a Match of length 0: no whistle, so
 * no FINAL), `training` free play or a pack with the session kept. Whatever ends local play puts the
 * timed match back (matchOf). The Game's match kind stays the search's while waiting, never 'ai'.
 */

export type WaitPlay = 'off' | 'bots' | 'training' | 'entering';

export interface WaitState {
  readonly play: WaitPlay;
  /** The search this play waits for still queues. */
  readonly searching: boolean;
  /** Why it ended while the player played ('search.ended' on the HUD); null when it did not, or the player cancelled it. */
  readonly ended: string | null;
}

export const WAIT_OFF: WaitState = { play: 'off', searching: false, ended: null };

/** The player is playing locally (bots or training), with or without the search. */
export function isLocal(s: WaitState): boolean {
  return s.play === 'bots' || s.play === 'training';
}

/**
 * Start local play `kind` over a search: only while one queues (null: nothing starts; the Game
 * then plays as it would without a search). From one local play to the other the search goes on.
 */
export function startWait(s: WaitState, kind: 'bots' | 'training', queueing: boolean): WaitState | null {
  if (!queueing || s.play === 'entering') return null;
  return { play: kind, searching: true, ended: null };
}

/**
 * The search left its queue (a match was issued): local play ends at once (its score is lost), the
 * match kind is the search's, and the match is on its way (`entering`). Null when nothing waits.
 */
export function handOff<K extends string>(s: WaitState, searchKind: K): { state: WaitState; matchKind: K } | null {
  if (!isLocal(s) || !s.searching) return null;
  return { state: { play: 'entering', searching: false, ended: null }, matchKind: searchKind };
}

/** The match is on screen (or a lobby's took over): nothing waits any more. */
export function entered(s: WaitState): WaitState {
  return s.play === 'entering' ? WAIT_OFF : s;
}

/** The found match never came (its connection failed): back to the menus, which say why. */
export function enterFailed(s: WaitState): { state: WaitState; menus: boolean } {
  return s.play === 'entering' ? { state: WAIT_OFF, menus: true } : { state: s, menus: false };
}

/**
 * The search died while the player played (`reason`: why, for the HUD and the menus; null: the
 * player cancelled it, nothing to tell): the local activity goes on, the bots match still unlimited.
 */
export function searchDied(s: WaitState, reason: string | null): WaitState {
  if (!isLocal(s) || !s.searching) return s;
  return { play: s.play, searching: false, ended: reason };
}

/** SEARCH AGAIN (the pause menu, once the search died): the same request again, local play goes on. */
export function searchAgain(s: WaitState): WaitState {
  if (!isLocal(s) || s.searching) return s;
  return { play: s.play, searching: true, ended: null };
}

/** QUIT: back to the menus, still searching when the search still runs (`keepSearch`). */
export function quitWait(s: WaitState): { state: WaitState; keepSearch: boolean } {
  return { state: WAIT_OFF, keepSearch: isLocal(s) && s.searching };
}

/** Training's NEXT LEVEL keeps the session while it waits for a search. */
export function nextLevelKeeps(s: WaitState): boolean {
  return s.play === 'training' && s.searching;
}

/** Which match runs: the unlimited one only for the bots match while waiting, else the timed one. */
export function matchOf(s: WaitState): 'wait' | 'timed' {
  return s.play === 'bots' ? 'wait' : 'timed';
}

/** What the queue's requests say the player does locally (NetClient.queueLocal: the daily counters only). */
export function queueLocal(s: WaitState): 'bots' | 'training' | null {
  return s.searching && (s.play === 'bots' || s.play === 'training') ? s.play : null;
}

/**
 * The search entry of the pause menu while playing locally: CANCEL SEARCH while it runs, SEARCH
 * AGAIN once it died; null outside local play (the usual pause).
 */
export function pauseSearchEntry(s: WaitState): 'cancelSearch' | 'searchAgain' | null {
  if (!isLocal(s)) return null;
  return s.searching ? 'cancelSearch' : 'searchAgain';
}

/**
 * PARTIDO ENCONTRADO's line, in parts (Game.matchFound joins them: "Casual · 2v2 · Sudamérica"): the
 * matched answer's format and host region (`extra`: the hub's `mode` / `host`) when it says the
 * format; else today's line (spec §3.5), the search's own formats and region (`autoRegion`: the
 * connection's when it picked none), for the 409 rejoin path or an older server. `isRegion` tells a
 * region id. Pure.
 */
export function foundParts<M extends string, R extends string>(
  req: { kind: 'casual' | 'ranked'; modes: readonly M[]; region: R | null },
  extra: { mode?: M; host?: string } | null,
  autoRegion: R | null,
  isRegion: (v: unknown) => v is R,
): { kind: 'casual' | 'ranked'; modes: M[]; region: R | null } {
  const own = req.region ?? autoRegion;
  if (extra === null || extra.mode === undefined) return { kind: req.kind, modes: req.modes.slice(), region: own };
  return { kind: req.kind, modes: [extra.mode], region: isRegion(extra.host) ? extra.host : own };
}
