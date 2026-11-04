/**
 * The pause keys (the UX audit's C1), pure so node tests pin them (tests/pause-keys.test.mjs):
 * what Esc / Start / Backspace / pad B do in a match (Game.processActions) and the key line under
 * PAUSED (Hud). Nothing here quits: B is boost and "close this" on a controller, Backspace is free
 * play's reset ball, and a reflex press used to leave the match at once (online, in Competitive
 * too: an abandon and a ban). Only the pause menu's QUIT button leaves, with its second press online.
 */

/**
 * 'toggle' pause on / off, 'resume' the paused match, 'arm' a resume on the release of this Esc
 * (escArmStep), 'menu' the pause menu's own edges (focus, accept), null nothing.
 */
export type PauseKeyAction = 'toggle' | 'resume' | 'arm' | 'menu' | null;

/**
 * This frame's pause decision from Input's edges: `pause` the pause binding's edge (Esc / Start;
 * it carries `back` too), `back` a back edge (Esc, Backspace, pad B), `paused` the match is paused,
 * `dropPause` this pause edge is the Escape of a pointer-lock release that already paused the game
 * (Game: UNLOCK_PAUSE_WINDOW; never a pad Start). A bare back edge resumes, like the pause key.
 * `escOnRelease`: these edges are the Esc key's own press with Esc locked to the page in the game's
 * full screen (src/ui/fullscreen.ts escLocked). There the browser's hold to leave full screen starts
 * with this same keydown, so from the pause it only arms the resume ('arm'), which its release
 * makes if it was short; mid-match it pauses on the press as ever.
 */
export function pauseKeyAction(pause: boolean, back: boolean, paused: boolean, dropPause: boolean, escOnRelease = false): PauseKeyAction {
  if (pause && !dropPause) return paused && escOnRelease ? 'arm' : 'toggle';
  // The dropped Escape still has `pause` set: it does not resume either.
  if (back && !pause && paused) return escOnRelease ? 'arm' : 'resume';
  return paused ? 'menu' : null;
}

/**
 * An Esc held this long (ms) with Esc locked is the browser's hold to leave full screen, not a press:
 * its release resumes nothing. Chromium leaves after about 1.5 s of it (Edge 156: 1.5 s), so this
 * stays well under that and well over a tap.
 */
export const ESC_RELEASE_MAX_MS = 800;

/** What an armed Esc does now: 'wait' for its release, 'resume' (or close the menu), or 'drop' it. */
export type EscArmStep = 'wait' | 'resume' | 'drop';

/**
 * A resume (or a menu's close) armed by an Esc press with Esc locked (pauseKeyAction 'arm',
 * escMenuAction 'arm'), at each frame or key event. `releasedMs`: how long that Esc was down when it
 * was let go (-1: still down). `escLocked`: the game's full screen is still on with Esc locked.
 * `pending`: the pause (or the menu) is still there. A press let go under ESC_RELEASE_MAX_MS
 * resumes; a longer one, a hold that took full screen away, or a pause already gone drops it.
 */
export function escArmStep(releasedMs: number, escLocked: boolean, pending: boolean): EscArmStep {
  if (!pending || !escLocked) return 'drop';
  if (releasedMs < 0) return 'wait';
  return releasedMs < ESC_RELEASE_MAX_MS ? 'resume' : 'drop';
}

/**
 * A menu that Esc opens and closes (the replay viewer's, src/replay/player.ts), on an Esc keydown:
 * 'open' it (playback paused), 'close' it, 'arm' its close on this Esc's release (Esc locked: see
 * pauseKeyAction), or null for a held key's repeat (it toggled the menu on every one).
 */
export function escMenuAction(menuOpen: boolean, repeat: boolean, escLocked: boolean): 'open' | 'close' | 'arm' | null {
  if (repeat) return null;
  if (!menuOpen) return 'open';
  return escLocked ? 'arm' : 'close';
}

/**
 * The resume keys for the pause menu's key line: the pause bindings and the fixed back keys that
 * resume too (Esc, pad B; Backspace as well, left out of the line), each once: 'Esc / Start / B'.
 * An unbound label ('—') is skipped.
 */
export function pauseResumeKeys(kbmPause: string, padPause: string): string {
  const keys: string[] = [];
  for (const k of [kbmPause, 'Esc', padPause, 'B']) if (k !== '—' && !keys.includes(k)) keys.push(k);
  return keys.join(' / ');
}
