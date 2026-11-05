/**
 * Full screen on the pitch (the owner, November 2026: "que se ponga la pantalla completa cuando se
 * entra a la cancha"): the decisions, pure (no DOM: tests/fullscreen.test.mjs drives them). The
 * browser's side, the only call of requestFullscreen and the listeners are ./fullscreen.ts.
 *
 * - Where it applies (`fullscreenPath`): a computer ('entry': desktop, touch laptop) goes full
 *   screen as a match, training or session takes the screen; an Android phone or tablet keeps its
 *   tap ('tap': src/input/TouchControls.ts autoFullscreen); an iPhone, an iPad, a TV, a WebView
 *   without element fullscreen and a page launched from the home screen get nothing ('none'), and
 *   Settings > Game hides its row there (`fullscreenOffered`).
 * - Entering the pitch (`entryStep`): with the user activation of a click, Enter or tap there (a
 *   'local' entry: PLAY, training) the request goes at once; without one (a found match, a lobby
 *   joiner, a rejoin that took a while, a pad's A) it is armed, and the first key, mouse press,
 *   finger lift or click in the match fulfils it (`gestureAsks`). A 'session' entry respects a
 *   player who left full screen on purpose (`declined`); a 'local' one is a new PLAY and asks again.
 * - Leaving (`exitStep`): the game's own exit (the setting turned off) changes nothing else; a
 *   player who leaves in the menus or while paused declined it; mid-match it pauses, and without
 *   the keyboard lock (Firefox, Safari: Esc is both the pause and the way out) it comes back at the
 *   first input after the resume. With the lock a short Esc reaches the game (the pause) and only a
 *   held Esc, F11 or the browser's own controls leave: the player's choice, kept.
 * - Back in the menus (`leftPitchStep`) it stays full screen; only the request is dropped.
 */
import type { PlatformEnv } from '../input/touchMode';

/** What the decisions read (fullscreen.ts fullscreenEnv() fills it from the browser). */
export interface FullscreenEnv extends PlatformEnv {
  /** navigator.keyboard.lock exists, with a fine pointer (Chromium on a computer): Esc can stay the game's. */
  keyboardLock: boolean;
  /** The window already covers the screen (F11, a kiosk, macOS's own full screen): nothing to ask. */
  coversScreen: boolean;
  /** A TV (html.tg-tv, src/ui/device.ts): left out until tried on the real device. */
  tv: boolean;
}

export type FullscreenPath = 'entry' | 'tap' | 'none';

/** How this device goes full screen: on entering the pitch (a computer), Android's tap, or not at all. */
export function fullscreenPath(env: Readonly<FullscreenEnv>): FullscreenPath {
  if (!env.elementFullscreen || env.standalone || env.tv) return 'none';
  if (env.coarse) return env.orientationLock ? 'tap' : 'none';
  return 'entry';
}

/** Settings > Game lists "Full screen when playing" here. */
export function fullscreenOffered(env: Readonly<FullscreenEnv>): boolean {
  return fullscreenPath(env) !== 'none';
}

/** How the pitch was entered: by the player's own press ('local': PLAY, training) or by a session ('session': a found match, a lobby start, a rejoin). */
export type PitchEntry = 'local' | 'session';

export interface FsState {
  /** A request waits for the first input in the match (the entry had no user activation, or its request was refused). */
  readonly armed: boolean;
  /** Full screen was left mid-match without the keyboard lock: the first input after the resume asks again. */
  readonly reenter: boolean;
  /** The player left full screen on purpose: no session entry asks again (a PLAY does). */
  readonly declined: boolean;
}

export const FS_IDLE: FsState = { armed: false, reenter: false, declined: false };

/**
 * The pitch is entered. `activation`: navigator.userActivation.isActive at that moment, null when
 * the browser has no such API (then the request is tried). Nothing when the setting is off, this
 * is no 'entry' device, it is full screen already or the window covers the screen, or the player
 * declined it (a 'local' entry clears that first).
 */
export function entryStep(s: FsState, env: Readonly<FullscreenEnv>, enabled: boolean, entry: PitchEntry, activation: boolean | null): { state: FsState; request: boolean } {
  const declined = entry === 'local' ? false : s.declined;
  const idle: FsState = { armed: false, reenter: false, declined };
  if (!enabled || fullscreenPath(env) !== 'entry' || env.fullscreen || env.coversScreen || declined) return { state: idle, request: false };
  if (activation === false) return { state: { ...idle, armed: true }, request: false };
  return { state: idle, request: true };
}

/** The entry's request was refused (no activation after all): the first input in the match asks. */
export function rejectedStep(s: FsState): FsState {
  return s.declined ? s : { ...s, armed: true };
}

/** Full screen came on (only the game asks for it): nothing waits, nothing was declined. */
export function enteredStep(): FsState {
  return FS_IDLE;
}

/** An input event as gestureAsks reads it. */
export interface FsGesture {
  type: 'keydown' | 'pointerdown' | 'pointerup' | 'click';
  /** KeyboardEvent.code (keydown). */
  code?: string;
  /** PointerEvent.pointerType (pointerdown, pointerup). */
  pointerType?: string;
  /** Event.isTrusted: a real input, not a script's. */
  trusted: boolean;
  /** A match is on screen and taking input (Game.playing: not the menus, not paused). */
  playing: boolean;
  /** Something is full screen already. */
  fullscreen: boolean;
  /** navigator.userActivation.isActive in that event; null without the API. */
  activation: boolean | null;
}

/**
 * Keys that carry no user activation or are the browser's: Esc (the pause, and the way out), the
 * F keys (F11 is the browser's own full screen), a modifier alone (Shift is boost), volume, media,
 * launcher and browser keys.
 */
const SILENT_KEYS = /^(Escape|F\d{1,2}|Shift|Control|Alt|Meta|OS|CapsLock|Fn|Media|Audio|Launch|Browser)/;

/**
 * An input in the match fulfils an armed request (or the re-entry after a resume): a key other
 * than SILENT_KEYS, a mouse press, a finger or pen lifted (a touch's activation comes on its
 * pointerup), a click. Only a real input, while playing, not full screen yet, with the setting on
 * and the event's activation not known to be missing.
 */
export function gestureAsks(s: FsState, g: Readonly<FsGesture>, enabled: boolean): boolean {
  if (!enabled || !(s.armed || s.reenter) || !g.trusted || !g.playing || g.fullscreen || g.activation === false) return false;
  switch (g.type) {
    case 'keydown':
      return typeof g.code === 'string' && g.code !== '' && !SILENT_KEYS.test(g.code);
    case 'pointerdown':
      return g.pointerType === 'mouse';
    case 'pointerup':
      return g.pointerType === 'touch' || g.pointerType === 'pen';
    case 'click':
      return true;
    default:
      return false;
  }
}

/**
 * Full screen was left. `byGame`: the game's own exit (the setting turned off). `playing`: a match
 * was being played (or the same Esc paused it a moment before). Mid-match it pauses; without the
 * keyboard lock it comes back at the first input after the resume, with it the player chose.
 */
export function exitStep(s: FsState, env: Readonly<FullscreenEnv>, byGame: boolean, playing: boolean): { state: FsState; pause: boolean } {
  if (byGame) return { state: { ...s, armed: false, reenter: false }, pause: false };
  if (!playing) return { state: { armed: false, reenter: false, declined: true }, pause: false };
  const reenter = fullscreenPath(env) === 'entry' && !env.keyboardLock;
  return { state: { armed: false, reenter, declined: !reenter }, pause: true };
}

/** Back in the menus (the FINAL too): full screen stays; a request still waiting goes. */
export function leftPitchStep(s: FsState): FsState {
  return { armed: false, reenter: false, declined: s.declined };
}
