/**
 * Full screen, the browser's side (the decisions are ./fullscreenModel.ts, pure):
 *
 * - `fullscreenEnv()`: what the decisions read (the phone platform's fields, src/input/touchMode.ts,
 *   plus the keyboard lock, a window that covers the screen already and the TV class).
 * - `requestPageFullscreen()`: the ONE call of requestFullscreen in src/ (tests/fullscreen.test.mjs
 *   pins it): <html> full screen without the navigation bar, so the menus, the HUD, the toasts and
 *   the sheets stay in the picture. Once it is on, Esc is locked to the page where the browser can
 *   (navigator.keyboard.lock: Chromium on a computer), so a short Esc stays the game's pause and a
 *   held one leaves; Android's tap also locks landscape. It must run inside an input event's own
 *   listener or a click / key handler (the user activation), and it consumes that activation:
 *   whatever else the same press needs (the pointer lock, the clipboard) asks first.
 * - `escLocked()`: that Esc lock holds now, so a press that resumes or closes waits for its release
 *   (the hold that leaves full screen begins with a keydown the page gets).
 * - `PageFullscreen`, the Game's: `enter` as the pitch takes the screen (Game.hideMenus), the
 *   window listeners of an armed request (keydown, pointerdown, pointerup, click: the BUBBLE phase,
 *   so the canvas has asked for the pointer lock first; measured in Edge, full screen first breaks
 *   the lock), `exited` when it goes (the Game pauses a match), `leftPitch` with the menus (it stays
 *   full screen), `setEnabled` from Settings > Game (off leaves the game's own full screen at once,
 *   and stops Android's tap: `fullscreenAllowed`).
 * The replay viewer has its own button and F key (`togglePageFullscreen`), never automatic.
 */
import { FS_IDLE, enteredStep, entryStep, exitStep, gestureAsks, leftPitchStep, rejectedStep, type FsGesture, type FsState, type FullscreenEnv, type PitchEntry } from './fullscreenModel';

/** The Keyboard Lock API (Chromium; not in TypeScript's DOM types). */
interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboard(): Partial<KeyboardLock> | undefined {
  return (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
}

function mediaMatches(query: string): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

const noop = (): void => undefined;

/** The browser's side of the full screen decisions (and of the phone platform's: TouchControls.platformEnv). */
export function fullscreenEnv(): FullscreenEnv {
  // Typed as always there; Safari before 16.4 lacks it.
  const orientation: ScreenOrientation | undefined = screen.orientation;
  const root = document.documentElement;
  return {
    coarse: mediaMatches('(pointer: coarse)'),
    orientationLock: orientation !== undefined && typeof orientation.lock === 'function',
    elementFullscreen: document.fullscreenEnabled === true && typeof root.requestFullscreen === 'function',
    fullscreen: document.fullscreenElement != null,
    standalone: mediaMatches('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    keyboardLock: mediaMatches('(pointer: fine)') && typeof keyboard()?.lock === 'function',
    // F11, a kiosk, macOS's own full screen: the page fills the screen already (a page zoom there misses it: then it asks, harmless).
    coversScreen: Math.abs(screen.width - window.innerWidth) <= 1 && Math.abs(screen.height - window.innerHeight) <= 1,
    tv: root.classList.contains('tg-tv'),
  };
}

/** The user activation of the event being handled; null when the browser has no navigator.userActivation. */
function activationNow(): boolean | null {
  const a: UserActivation | undefined = navigator.userActivation;
  return a === undefined ? null : a.isActive;
}

/** The game's own full screen is on (requestPageFullscreen's): only that one is left by the setting. */
let own = false;
/** The Esc lock (navigator.keyboard) resolved for the game's own full screen: Esc reaches the page. */
let escLock = false;
/** Settings > Game's "Full screen when playing" (PageFullscreen.setEnabled): Android's tap reads it. */
let allowed = true;
/** A request on its way: a second press in the same gesture (no userActivation API) waits for it. */
let pending: Promise<boolean> | null = null;
let watching = false;

/** The setting is on: Android's tap may go full screen (TouchControls.autoFullscreen). */
export function fullscreenAllowed(): boolean {
  return allowed;
}

/**
 * Esc reaches the page in the game's own full screen (the keyboard lock resolved, full screen still
 * on). There a short Esc is the game's and a held one the browser's way out (Chromium leaves after
 * about 1.5 s of it, with the first keydown already delivered), so whatever an Esc press resumes or
 * closes acts on its release instead (src/game/pauseKeys.ts escArmStep): the pause, the replay
 * viewer's menu, the menus' Back. Pausing stays on the press.
 */
export function escLocked(): boolean {
  return own && escLock && document.fullscreenElement != null;
}

/** Full screen left, however: the Esc lock goes with it (a later F11 keeps the browser's Esc) and so does `own`. */
function onFullscreenChange(): void {
  if (document.fullscreenElement != null) return;
  own = false;
  escLock = false;
  keyboard()?.unlock?.();
}

/**
 * <html> full screen (see the module doc). Resolves true once it is on, false when the browser
 * refused it (no user activation, no support); never throws. `landscape`: also lock the
 * orientation (Android's tap).
 */
export function requestPageFullscreen(opts: { landscape?: boolean } = {}): Promise<boolean> {
  if (pending !== null) return pending;
  const root = document.documentElement;
  if (typeof root.requestFullscreen !== 'function') return Promise.resolve(false);
  if (!watching) {
    watching = true;
    document.addEventListener('fullscreenchange', onFullscreenChange);
  }
  const lockKeys = fullscreenEnv().keyboardLock;
  let asked: Promise<void>;
  try {
    asked = root.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return Promise.resolve(false);
  }
  const done = Promise.resolve(asked)
    .then(
      () => {
        own = true;
        const kb = keyboard();
        if (lockKeys && kb !== undefined && typeof kb.lock === 'function') {
          kb.lock(['Escape']).then(() => {
            escLock = own;
          }, noop);
        }
        const orientation: ScreenOrientation | undefined = screen.orientation;
        if (opts.landscape === true && orientation !== undefined && typeof orientation.lock === 'function') orientation.lock('landscape').catch(noop);
        return true;
      },
      () => false,
    )
    .finally(() => {
      pending = null;
    });
  pending = done;
  return done;
}

/** The replay viewer's button and F key: full screen on, or off when it is (any element's). Call it from the press itself. */
export function togglePageFullscreen(): void {
  if (document.fullscreenElement != null) void document.exitFullscreen().catch(noop);
  else void requestPageFullscreen();
}

/** What PageFullscreen asks the Game. */
export interface FullscreenHooks {
  /** A match is on screen and taking input (Game.playing). */
  playing(): boolean;
  /** Full screen went; `byGame`: the setting turned it off (Game.onFullscreenExit). */
  left(byGame: boolean): void;
}

/** The input events that may fulfil an armed request: window listeners, bubble phase, passive. */
const GESTURES = ['keydown', 'pointerdown', 'pointerup', 'click'] as const;

/** The Game's full screen on the pitch (see the module doc and fullscreenModel.ts). */
export class PageFullscreen {
  private state: FsState = FS_IDLE;
  /** The setting's own exitFullscreen is on its way: that change is the game's. */
  private exiting = false;
  private hooks: FullscreenHooks | null = null;

  /** `enabled`: the player's settings.ui.fullscreen, read live. */
  constructor(private readonly enabled: () => boolean) {}

  install(hooks: FullscreenHooks): void {
    this.hooks = hooks;
    document.addEventListener('fullscreenchange', this.onChange);
    for (const type of GESTURES) window.addEventListener(type, this.onGesture, { passive: true });
  }

  dispose(): void {
    document.removeEventListener('fullscreenchange', this.onChange);
    for (const type of GESTURES) window.removeEventListener(type, this.onGesture);
    this.hooks = null;
  }

  /** The pitch takes the screen (Game.hideMenus): ask now with the press's activation, or arm for the first input. */
  enter(entry: PitchEntry): void {
    const step = entryStep(this.state, fullscreenEnv(), this.enabled(), entry, activationNow());
    this.state = step.state;
    if (step.request) this.request();
  }

  /** Full screen went (the Game's `left` hook): the new state; true when a match being played should pause. */
  exited(byGame: boolean, playing: boolean): boolean {
    const step = exitStep(this.state, fullscreenEnv(), byGame, playing);
    this.state = step.state;
    return step.pause;
  }

  /** The menus are back (Game.showMenu): full screen stays, a request still armed goes. */
  leftPitch(): void {
    this.state = leftPitchStep(this.state);
  }

  /** Settings > Game's switch: off leaves the game's own full screen now, and Android's tap stops asking. */
  setEnabled(on: boolean): void {
    allowed = on;
    if (on || !own || document.fullscreenElement == null) return;
    this.exiting = true;
    document.exitFullscreen().catch(() => {
      this.exiting = false;
    });
  }

  private request(): void {
    void requestPageFullscreen().then((ok) => {
      if (!ok) this.state = rejectedStep(this.state);
    });
  }

  private readonly onChange = (): void => {
    if (document.fullscreenElement != null) {
      this.state = enteredStep();
      return;
    }
    const byGame = this.exiting;
    this.exiting = false;
    this.hooks?.left(byGame);
  };

  /** keydown, pointerdown, pointerup, click on window (bubble phase): an armed request asks inside the event. */
  private readonly onGesture = (e: Event): void => {
    const hooks = this.hooks;
    if (hooks === null || !(this.state.armed || this.state.reenter)) return;
    const g: FsGesture = {
      type: e.type as FsGesture['type'],
      code: e instanceof KeyboardEvent ? e.code : undefined,
      pointerType: e instanceof PointerEvent ? e.pointerType : undefined,
      trusted: e.isTrusted,
      playing: hooks.playing(),
      fullscreen: document.fullscreenElement != null,
      activation: activationNow(),
    };
    if (gestureAsks(this.state, g, this.enabled())) this.request();
  };
}
