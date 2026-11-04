// The pause keys (src/game/pauseKeys.ts, node --test tests/pause-keys.test.mjs): Esc / Start toggle
// the pause, a bare back edge (pad B, Backspace) resumes it, and nothing a key does ever quits the
// match (only the pause menu's QUIT button, with its second press online); the key line under PAUSED
// names the keys that resume, in English and Spanish, and no quit key. In the game's own full screen
// with Esc locked to the page, a held Esc is the browser's way out: from the pause (and the replay
// viewer's menu) a short Esc resumes on its release, and the hold that leaves never resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const { pauseKeyAction, pauseResumeKeys, escArmStep, escMenuAction, ESC_RELEASE_MAX_MS } = await import('../src/game/pauseKeys.ts');
const { t } = await import('../src/i18n.ts');
const es = (await import('../src/locales/es.ts')).default;
const { Input } = await import('../src/input/Input.ts');
const { defaultSettings } = await import('../src/settings.ts');
const { emptyControls } = await import('../src/sim/types.ts');

// Input's edges per key: Esc / Start carry `pause` and `back`; pad B and Backspace only `back`.
const ESC = [true, true];
const B = [false, true];
const NONE = [false, false];

test('playing: Esc / Start pause; B (boost) and Backspace (reset ball) do nothing to the pause', () => {
  assert.equal(pauseKeyAction(...ESC, false, false), 'toggle');
  assert.equal(pauseKeyAction(...B, false, false), null);
  assert.equal(pauseKeyAction(...NONE, false, false), null);
});

test('paused: Esc / Start, pad B and Backspace all resume; no key quits', () => {
  assert.equal(pauseKeyAction(...ESC, true, false), 'toggle');
  assert.equal(pauseKeyAction(...B, true, false), 'resume');
  assert.equal(pauseKeyAction(...NONE, true, false), 'menu', 'the menu edges (focus, accept)');
  // The Escape of a pointer-lock release that already paused: neither resumes nor toggles.
  assert.equal(pauseKeyAction(...ESC, true, true), 'menu');
  for (const pause of [false, true]) {
    for (const back of [false, true]) {
      for (const paused of [false, true]) {
        for (const drop of [false, true]) {
          const r = pauseKeyAction(pause, back, paused, drop);
          assert.ok(r === 'toggle' || r === 'resume' || r === 'menu' || r === null, String(r));
          if (paused && back) assert.notEqual(r, null, 'a back key while paused is never ignored into a quit path');
        }
      }
    }
  }
});

// ---- Full screen with Esc locked: a short Esc resumes on its release ----------------------------

test('Esc locked: mid-match Esc still pauses on the press; from the pause the Esc press only arms', () => {
  assert.equal(pauseKeyAction(...ESC, false, false, true), 'toggle', 'mid-match: paused at once, before the browser leaves');
  assert.equal(pauseKeyAction(...ESC, true, false, true), 'arm', 'paused: no resume on the press');
  assert.equal(pauseKeyAction(...B, true, false, true), 'arm', 'the pause bound elsewhere: Esc is a bare back edge, armed too');
  assert.equal(pauseKeyAction(...ESC, true, true, true), 'menu', 'the dropped Escape of a pointer-lock release arms nothing');
  assert.equal(pauseKeyAction(...ESC, true, false, false), 'toggle', 'Esc not locked (windowed, Firefox): on the press as before');
  assert.equal(pauseKeyAction(...B, true, false, false), 'resume', 'pad B, Backspace: at once');
});

test('Esc locked: the armed resume waits while Esc is down, comes on a short release, never on a hold', () => {
  assert.equal(escArmStep(-1, true, true), 'wait');
  assert.equal(escArmStep(0, true, true), 'resume', 'a tap: down and up in one frame');
  assert.equal(escArmStep(300, true, true), 'resume');
  assert.equal(escArmStep(ESC_RELEASE_MAX_MS - 1, true, true), 'resume');
  assert.equal(escArmStep(ESC_RELEASE_MAX_MS, true, true), 'drop', 'held this long: the browser\'s hold, not a press');
  assert.equal(escArmStep(-1, false, true), 'drop', 'full screen went during the hold');
  assert.equal(escArmStep(200, false, true), 'drop', 'released after full screen went');
  assert.equal(escArmStep(200, true, false), 'drop', 'the pause already went (a click on RESUME, pad Start)');
  assert.ok(ESC_RELEASE_MAX_MS >= 500 && ESC_RELEASE_MAX_MS <= 1000, 'well over a tap, well under Chromium\'s 1.5 s');
});

test('the replay viewer\'s menu: Esc opens it on the press, closes it on the release when locked, and a repeat does nothing', () => {
  for (const locked of [false, true]) assert.equal(escMenuAction(false, false, locked), 'open');
  assert.equal(escMenuAction(true, false, false), 'close', 'not locked: on the press');
  assert.equal(escMenuAction(true, false, true), 'arm');
  for (const open of [false, true]) for (const locked of [false, true]) assert.equal(escMenuAction(open, true, locked), null, 'a held key\'s repeat');
});

class KeyTarget extends EventTarget {
  down(code, repeat = false) {
    this.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, repeat }));
  }
  up(code) {
    this.dispatchEvent(Object.assign(new Event('keyup'), { code }));
  }
}

if (typeof navigator.getGamepads !== 'function') navigator.getGamepads = () => [];

/**
 * Game.processActions's pause keys frame by frame (one every 16 ms) on the real Input, with Esc
 * locked while `locked(now)`: a script of key events at their times, the paused flag per frame.
 */
function playPause(events, { until, locked = () => true, paused = false }) {
  let now = 0;
  const target = new KeyTarget();
  const input = new Input(target, defaultSettings(), { document: null, now: () => now });
  const out = emptyControls();
  let armed = false;
  const trace = [];
  const queue = [...events].sort((x, y) => x.at - y.at);
  for (; now <= until; now += 16) {
    while (queue.length > 0 && queue[0].at <= now) {
      const e = queue.shift();
      if (e.up) target.up(e.code ?? 'Escape');
      else target.down(e.code ?? 'Escape', e.repeat === true);
    }
    input.sample(out);
    const a = input.actions;
    const pa = input.padActions;
    const escUp = input.takeEscRelease();
    const escArmed = armed;
    armed = false;
    const lock = locked(now);
    const pk = pauseKeyAction(a.pause, a.back, paused, false, a.escape && !pa.pause && !pa.back && lock);
    if (pk === 'toggle') paused = !paused;
    else if (pk === 'resume') paused = false;
    if (pk === 'arm' || escArmed) {
      const step = escArmStep(escUp, lock, paused);
      if (step === 'wait') armed = true;
      else if (step === 'resume') paused = false;
    }
    input.consumeActions();
    trace.push({ now, paused });
  }
  input.dispose?.();
  return trace;
}

/** An Esc held from `at` for `ms`, with the autorepeat every 33 ms. */
const hold = (at, ms) => [{ at }, ...Array.from({ length: Math.floor(ms / 33) }, (_, i) => ({ at: at + 33 * (i + 1), repeat: true })), { at: at + ms, up: true }];
const pausedAt = (trace, now) => trace.findLast((f) => f.now <= now).paused;

test('Esc locked, on the real Input: a short Esc from the pause resumes on its release, not on its press', () => {
  const trace = playPause([{ at: 0 }, { at: 100, up: true }, { at: 1000 }, { at: 1300, up: true }], { until: 1600 });
  assert.equal(pausedAt(trace, 20), true, 'mid-match: paused on the press');
  assert.equal(pausedAt(trace, 1290), true, 'the second press from the pause: still paused while it is down');
  assert.equal(pausedAt(trace, 1320), false, 'resumed on its release');
  // A tap (down and up before the frame) resumes too.
  const tap = playPause([{ at: 0 }, { at: 1, up: true }, { at: 500 }, { at: 501, up: true }], { until: 700 });
  assert.equal(pausedAt(tap, 400), true);
  assert.equal(pausedAt(tap, 520), false);
});

test('Esc locked, on the real Input: a press held until full screen exits stays paused, and so does a long one', () => {
  // Paused first (a short Esc), then the help's "hold Esc": Chromium leaves 1.5 s in.
  const events = [{ at: 0 }, { at: 100, up: true }, ...hold(1000, 2600)];
  const trace = playPause(events, { until: 4000, locked: (now) => now < 2500 });
  assert.ok(trace.filter((f) => f.now >= 20).every((f) => f.paused), 'never resumed: not on the press, the repeats, the exit or the release');
  // Held past the limit but let go before the browser left: still paused, still full screen.
  const long = playPause([{ at: 0 }, { at: 100, up: true }, ...hold(1000, ESC_RELEASE_MAX_MS + 200)], { until: 2500 });
  assert.ok(long.filter((f) => f.now >= 20).every((f) => f.paused));
  // Mid-match, the hold pauses on its first keydown and stays paused.
  const mid = playPause(hold(0, 2600), { until: 3000, locked: (now) => now < 1500 });
  assert.ok(mid.every((f) => f.paused));
});

test('Esc not locked (windowed, Firefox, Safari): Esc from the pause resumes on the press as before', () => {
  const trace = playPause([{ at: 0 }, { at: 100, up: true }, { at: 1000 }, { at: 1300, up: true }], { until: 1600, locked: () => false });
  assert.equal(pausedAt(trace, 20), true);
  assert.equal(pausedAt(trace, 1020), false, 'on the press');
  // Backspace (a bare back edge) resumes on the press even with Esc locked.
  const bs = playPause([{ at: 0 }, { at: 100, up: true }, { at: 1000, code: 'Backspace' }, { at: 1300, code: 'Backspace', up: true }], { until: 1600 });
  assert.equal(pausedAt(bs, 1020), false);
});

test('Input.takeEscRelease: the held time once, not for a repeat, forgotten by a newer press or a lost focus', () => {
  let now = 0;
  const target = new KeyTarget();
  const input = new Input(target, defaultSettings(), { document: null, now: () => now });
  assert.equal(input.takeEscRelease(), -1, 'nothing yet');
  target.down('Escape');
  assert.equal(input.actions.escape, true, 'the press itself');
  now = 50;
  target.down('Escape', true);
  assert.equal(input.takeEscRelease(), -1, 'still down');
  now = 240;
  target.up('Escape');
  assert.equal(input.takeEscRelease(), 240);
  assert.equal(input.takeEscRelease(), -1, 'read once');
  input.consumeActions();
  assert.equal(input.actions.escape, false);
  target.down('Escape', true);
  assert.equal(input.actions.escape, false, 'a repeat is no press');
  target.down('Backspace');
  assert.equal(input.actions.escape, false, 'Backspace is a back edge, not Esc');
  assert.equal(input.actions.back, true);
  // A release not read yet belongs to the older press: a new press forgets it.
  now = 300;
  target.down('Escape');
  now = 400;
  target.up('Escape');
  now = 500;
  target.down('Escape');
  assert.equal(input.takeEscRelease(), -1);
  // Focus lost with Esc down: no release to read.
  target.dispatchEvent(new Event('blur'));
  now = 900;
  target.up('Escape');
  assert.equal(input.takeEscRelease(), -1);
  input.dispose?.();
});

test('the key line: the pause bindings and the back keys that resume, each once, no quit key', () => {
  assert.equal(pauseResumeKeys('Esc', 'Start'), 'Esc / Start / B');
  assert.equal(pauseResumeKeys('P', 'Start'), 'P / Esc / Start / B', 'Esc resumes whatever the pause binding');
  assert.equal(pauseResumeKeys('Esc', 'B'), 'Esc / B');
  assert.equal(pauseResumeKeys('—', 'Start'), 'Esc / Start / B');
  const en = t('pause.hint', { resumeKeys: pauseResumeKeys('Esc', 'Start') });
  assert.equal(en, 'Esc / Start / B or click to resume');
  assert.equal(t('pause.hintDefault', { resumeKeys: pauseResumeKeys('Esc', 'Start') }), 'Esc / Start / B to resume');
  for (const line of [en, es['pause.hint'], es['pause.hintDefault'], t('pause.hintDefault', { resumeKeys: 'x' })]) {
    assert.ok(!/quit|salir|Backspace|\{quitKeys\}/i.test(line), line);
  }
});
