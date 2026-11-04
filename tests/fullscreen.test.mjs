// Full screen on the pitch (node --test tests/fullscreen.test.mjs): the pure decisions of
// src/ui/fullscreenModel.ts on every platform the game meets, and pins on the wiring that only a
// browser runs (src/ui/fullscreen.ts, Game.ts, TouchControls.ts, Settings > Game, the replay viewer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FS_IDLE, fullscreenPath, fullscreenOffered, entryStep, rejectedStep, enteredStep, gestureAsks, exitStep, leftPitchStep } = await import('../src/ui/fullscreenModel.ts');

/** Browsers as fullscreen.ts fullscreenEnv() reads them. */
const BASE = { coarse: false, orientationLock: true, elementFullscreen: true, fullscreen: false, standalone: false, keyboardLock: true, coversScreen: false, tv: false };
const PLATFORMS = {
  // Chromium on a computer: the keyboard lock keeps Esc the game's.
  desktopChrome: { ...BASE },
  // Firefox has screen.orientation.lock (it rejects) but no keyboard lock; Safari neither.
  firefox: { ...BASE, keyboardLock: false },
  macSafari: { ...BASE, orientationLock: false, keyboardLock: false },
  // A touch laptop / Chromebook: a fine primary pointer.
  touchLaptop: { ...BASE },
  androidPhone: { ...BASE, coarse: true, keyboardLock: false },
  iPhone: { ...BASE, coarse: true, orientationLock: false, elementFullscreen: false, keyboardLock: false },
  iPad: { ...BASE, coarse: true, orientationLock: false, keyboardLock: false },
  // TV Bro on an Android TV: no pointer at all (html.tg-tv).
  tv: { ...BASE, keyboardLock: false, tv: true },
  androidWebView: { ...BASE, coarse: true, elementFullscreen: false, keyboardLock: false },
  standalone: { ...BASE, standalone: true },
  // F11 / a kiosk: the window covers the screen already.
  f11: { ...BASE, coversScreen: true },
};

// ---- Where it applies ------------------------------------------------------------------------

test('path: a computer goes full screen on entering the pitch, Android keeps its tap, the rest get nothing', () => {
  for (const name of ['desktopChrome', 'firefox', 'macSafari', 'touchLaptop', 'f11']) assert.equal(fullscreenPath(PLATFORMS[name]), 'entry', name);
  assert.equal(fullscreenPath(PLATFORMS.androidPhone), 'tap');
  for (const name of ['iPhone', 'iPad', 'tv', 'androidWebView', 'standalone']) assert.equal(fullscreenPath(PLATFORMS[name]), 'none', name);
  for (const [name, env] of Object.entries(PLATFORMS)) assert.equal(fullscreenOffered(env), fullscreenPath(env) !== 'none', `${name}: the settings row where it applies`);
  assert.equal(fullscreenOffered(PLATFORMS.iPad), false, 'iPad: left out until tried on the device');
  assert.equal(fullscreenOffered(PLATFORMS.tv), false, 'TV: left out until tried on the device');
});

// ---- Entering the pitch ----------------------------------------------------------------------

const D = PLATFORMS.desktopChrome;

test('entry: with the press\'s activation it asks at once; without one it arms; a null activation (no API) tries', () => {
  assert.deepEqual(entryStep(FS_IDLE, D, true, 'local', true), { state: FS_IDLE, request: true }, 'PLAY clicked');
  assert.deepEqual(entryStep(FS_IDLE, D, true, 'local', false), { state: { ...FS_IDLE, armed: true }, request: false }, 'a pad\'s A');
  assert.deepEqual(entryStep(FS_IDLE, D, true, 'session', true), { state: FS_IDLE, request: true }, 'a quick rejoin');
  assert.deepEqual(entryStep(FS_IDLE, D, true, 'session', false), { state: { ...FS_IDLE, armed: true }, request: false }, 'a found match');
  const tried = entryStep(FS_IDLE, D, true, 'local', null);
  assert.equal(tried.request, true, 'no navigator.userActivation: try');
  assert.deepEqual(rejectedStep(tried.state), { ...FS_IDLE, armed: true }, 'refused: the first input in the match asks');
});

test('entry: a player who declined is not taken back by a session; a PLAY of their own asks again', () => {
  const declined = { ...FS_IDLE, declined: true };
  assert.deepEqual(entryStep(declined, D, true, 'session', true), { state: declined, request: false });
  assert.deepEqual(entryStep(declined, D, true, 'session', false), { state: declined, request: false }, 'nothing armed either');
  assert.deepEqual(entryStep(declined, D, true, 'local', true), { state: FS_IDLE, request: true }, 'declined cleared');
  assert.deepEqual(entryStep(declined, D, true, 'local', false), { state: { ...FS_IDLE, armed: true }, request: false });
  assert.deepEqual(rejectedStep(declined), declined, 'a late refusal arms nothing for a player who declined');
});

test('entry: nothing when the switch is off, it is full screen already, the window covers the screen, or on a tap / none device', () => {
  const cases = [
    ['switched off', D, false],
    ['already full screen', { ...D, fullscreen: true }, true],
    ['F11', PLATFORMS.f11, true],
    ['Android (its tap)', PLATFORMS.androidPhone, true],
    ['iPhone', PLATFORMS.iPhone, true],
    ['iPad', PLATFORMS.iPad, true],
    ['TV', PLATFORMS.tv, true],
  ];
  for (const [name, env, enabled] of cases) {
    for (const entry of ['local', 'session']) {
      for (const activation of [true, false, null]) {
        const r = entryStep({ ...FS_IDLE, armed: true, reenter: true }, env, enabled, entry, activation);
        assert.equal(r.request, false, `${name} ${entry} ${activation}`);
        assert.equal(r.state.armed, false, `${name}: nothing armed`);
        assert.equal(r.state.reenter, false, `${name}: an old re-entry goes`);
      }
    }
  }
  assert.equal(entryStep(FS_IDLE, PLATFORMS.firefox, true, 'local', true).request, true, 'Firefox enters too');
  assert.equal(entryStep(FS_IDLE, PLATFORMS.macSafari, true, 'local', null).request, true, 'Safari (no userActivation) tries');
});

test('entered: full screen on clears everything', () => {
  assert.deepEqual(enteredStep(), FS_IDLE);
});

// ---- The first input in the match ------------------------------------------------------------

const ARMED = { ...FS_IDLE, armed: true };
const live = (g) => ({ trusted: true, playing: true, fullscreen: false, activation: true, ...g });

test('gesture: a key, a mouse press, a finger lifted or a click fulfil an armed request while playing', () => {
  for (const code of ['KeyW', 'Enter', 'Space', 'ArrowUp', 'KeyA']) assert.equal(gestureAsks(ARMED, live({ type: 'keydown', code }), true), true, code);
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerdown', pointerType: 'mouse' }), true), true);
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerup', pointerType: 'touch' }), true), true);
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerup', pointerType: 'pen' }), true), true);
  assert.equal(gestureAsks(ARMED, live({ type: 'click' }), true), true);
  assert.equal(gestureAsks(ARMED, live({ type: 'keydown', code: 'KeyW', activation: null }), true), true, 'no userActivation API: try');
  assert.equal(gestureAsks({ ...FS_IDLE, reenter: true }, live({ type: 'keydown', code: 'KeyW' }), true), true, 'the re-entry after a resume');
});

test('gesture: Esc, the F keys, a modifier alone, volume and media keys, a virtual keyboard\'s empty code never ask', () => {
  for (const code of ['Escape', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft', 'MetaLeft', 'OSLeft', 'CapsLock', 'Fn', 'F11', 'F1', 'F12', 'AudioVolumeUp', 'MediaPlayPause', 'LaunchApp1', 'BrowserBack', '']) {
    assert.equal(gestureAsks(ARMED, live({ type: 'keydown', code }), true), false, code || "''");
  }
  assert.equal(gestureAsks(ARMED, live({ type: 'keydown' }), true), false, 'no code');
  assert.equal(gestureAsks(ARMED, live({ type: 'keydown', code: 'KeyF' }), true), true, 'F the letter is a key like any other');
});

test('gesture: never a script\'s event, in the menus or the pause, once full screen, without activation, with nothing armed or the switch off', () => {
  const key = { type: 'keydown', code: 'KeyW' };
  assert.equal(gestureAsks(ARMED, live({ ...key, trusted: false }), true), false, 'untrusted');
  assert.equal(gestureAsks(ARMED, live({ ...key, playing: false }), true), false, 'menus or paused');
  assert.equal(gestureAsks(ARMED, live({ ...key, fullscreen: true }), true), false, 'already full screen');
  assert.equal(gestureAsks(ARMED, live({ ...key, activation: false }), true), false, 'no activation (it would be refused)');
  assert.equal(gestureAsks(FS_IDLE, live(key), true), false, 'nothing armed');
  assert.equal(gestureAsks({ ...FS_IDLE, declined: true }, live(key), true), false, 'declined');
  assert.equal(gestureAsks(ARMED, live(key), false), false, 'switched off');
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerup', pointerType: 'mouse' }), true), false, 'a mouse asks on its pointerdown');
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerdown', pointerType: 'touch' }), true), false, 'a finger has no activation before its pointerup');
  assert.equal(gestureAsks(ARMED, live({ type: 'pointerdown', pointerType: 'pen' }), true), false);
});

// ---- Leaving ---------------------------------------------------------------------------------

test('exit: the game\'s own (the switch) changes nothing else; in the menus or paused it is declined, no pause', () => {
  assert.deepEqual(exitStep(ARMED, D, true, true), { state: FS_IDLE, pause: false }, 'by the game, even mid-match');
  assert.deepEqual(exitStep({ ...FS_IDLE, declined: true }, D, true, false), { state: { ...FS_IDLE, declined: true }, pause: false });
  for (const env of [D, PLATFORMS.firefox, PLATFORMS.androidPhone]) {
    assert.deepEqual(exitStep(FS_IDLE, env, false, false), { state: { ...FS_IDLE, declined: true }, pause: false }, 'menus or paused (a held Esc paused first)');
  }
});

test('exit mid-match: it pauses; with the keyboard lock the player chose, without it the first input after the resume asks', () => {
  assert.deepEqual(exitStep(FS_IDLE, D, false, true), { state: { ...FS_IDLE, declined: true }, pause: true }, 'Chromium: F11 or the browser\'s controls');
  assert.deepEqual(exitStep(FS_IDLE, PLATFORMS.firefox, false, true), { state: { ...FS_IDLE, reenter: true }, pause: true }, 'Firefox: Esc is the pause too');
  assert.deepEqual(exitStep(FS_IDLE, PLATFORMS.macSafari, false, true), { state: { ...FS_IDLE, reenter: true }, pause: true }, 'Safari');
  const android = exitStep(FS_IDLE, PLATFORMS.androidPhone, false, true);
  assert.equal(android.pause, true, 'Android\'s back gesture pauses (its RESUME tap goes full screen again)');
  assert.equal(android.state.reenter, false, 'the tap path re-enters by itself');
  // After a Firefox exit, the RESUME click asks again; once on, nothing waits.
  const after = exitStep(FS_IDLE, PLATFORMS.firefox, false, true).state;
  assert.equal(gestureAsks(after, live({ type: 'click' }), true), true);
  assert.deepEqual(enteredStep(), FS_IDLE);
});

test('back in the menus: full screen stays, a request still armed goes, a decline is kept', () => {
  assert.deepEqual(leftPitchStep({ armed: true, reenter: true, declined: false }), FS_IDLE);
  assert.deepEqual(leftPitchStep({ armed: false, reenter: false, declined: true }), { ...FS_IDLE, declined: true });
});

// ---- Pins on the browser's side ----------------------------------------------------------------

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SRC = new URL('../src/', import.meta.url);

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The body of a method or function `name` (balanced braces from the brace that opens the line). */
function body(src, name) {
  const at = src.search(new RegExp(`\\n\\s*(?:export )?(?:private |public )?(?:readonly )?(?:async )?(?:function )?${name}\\s*[(=]`));
  assert.ok(at >= 0, name);
  const open = src.slice(at).search(/\{\n/) + at;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

const fsSrc = read('src/ui/fullscreen.ts');
const game = read('src/game/Game.ts');

test('requestFullscreen is called in one place: src/ui/fullscreen.ts requestPageFullscreen', () => {
  const callers = tsFiles(fileURLToPath(SRC))
    .filter((f) => /\.requestFullscreen\(/.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'));
  assert.deepEqual(callers, ['src/ui/fullscreen.ts']);
  assert.equal(fsSrc.match(/\.requestFullscreen\(/g).length, 1);
  assert.match(body(fsSrc, 'requestPageFullscreen'), /\.requestFullscreen\(\{ navigationUI: 'hide' \}\)/);
});

test('fullscreen.ts: Esc is locked only once full screen is on, and unlocked when it goes; the gesture listeners are the bubble phase', () => {
  const req = body(fsSrc, 'requestPageFullscreen');
  assert.match(req, /requestFullscreen\([^)]*\)[\s\S]*\.then\(\s*\(\) => \{[\s\S]*\.lock\(\['Escape'\]\)/, 'keyboard.lock inside the request\'s then');
  assert.equal(fsSrc.match(/\.lock\(\['Escape'\]\)/g).length, 1);
  assert.match(body(fsSrc, 'onFullscreenChange'), /unlock/, 'unlocked in the fullscreenchange handler');
  assert.match(fsSrc, /document\.addEventListener\('fullscreenchange', onFullscreenChange\)/);
  assert.match(fsSrc, /const GESTURES = \['keydown', 'pointerdown', 'pointerup', 'click'\] as const/);
  assert.match(fsSrc, /window\.addEventListener\(type, this\.onGesture, \{ passive: true \}\)/, 'bubble phase, after the canvas asked for the pointer lock');
  assert.doesNotMatch(fsSrc, /capture: true/);
  assert.match(body(fsSrc, 'setEnabled'), /allowed = on;[\s\S]*!own[\s\S]*this\.exiting = true;[\s\S]*document\.exitFullscreen\(\)/, 'off leaves only the game\'s own full screen');
});

test('Esc locked: a short Esc resumes the pause and closes the replay viewer\'s menu on its release (pauseKeys.ts)', () => {
  assert.match(body(fsSrc, 'escLocked'), /^\s*return own && escLock && document\.fullscreenElement != null;\s*$/);
  assert.match(body(fsSrc, 'requestPageFullscreen'), /\.lock\(\['Escape'\]\)\.then\(\(\) => \{\s*escLock = own;\s*\}, noop\)/, 'locked once the lock resolved');
  assert.match(body(fsSrc, 'onFullscreenChange'), /escLock = false;/);
  const pa = body(game, 'processActions');
  assert.ok(pa.indexOf('const escUp = input.takeEscRelease();') >= 0 && pa.indexOf('const escUp = input.takeEscRelease();') < pa.indexOf('if (this.settingsCapturing)'), 'read every frame, before the branches');
  assert.match(pa, /const escArmed = this\.escResumeArmed;\s*this\.escResumeArmed = false;/);
  assert.match(pa, /const escOnRelease = a\.escape && !pa\.pause && !pa\.back && escLocked\(\);\s*const pk = pauseKeyAction\(a\.pause, a\.back, this\.paused, dropPause, escOnRelease\);/);
  assert.match(pa, /if \(pk === 'arm' \|\| escArmed\) \{[\s\S]*?const step = escArmStep\(escUp, escLocked\(\), this\.paused\);\s*if \(step === 'wait'\) this\.escResumeArmed = true;\s*else if \(step === 'resume'\) this\.resumeFromMenu\(\);/);
  const player = read('src/replay/player.ts');
  assert.match(player, /const act = escMenuAction\(menuOpen, e\.repeat, escLocked\(\)\);/);
  assert.doesNotMatch(player, /setMenu\(!menuOpen\)/, 'no toggle on every keydown (the repeats flipped it)');
  assert.match(player, /window\.addEventListener\('keyup', \(e\) => \{[\s\S]{0,200}escArmStep\(held, escLocked\(\), menuOpen\) === 'resume'\) setMenu\(false\);/);
});

test('Esc locked: the menus\' Esc Back comes on a short release, so the hold that leaves full screen goes back no screen', () => {
  const menu = read('src/ui/Menu.ts');
  const onKey = body(menu, 'onKey');
  assert.match(onKey, /case 'Escape': \{\s*e\.preventDefault\(\);[\s\S]*?const act = escBackAction\(e\.repeat, escLocked\(\)\);\s*if \(act === 'back'\) this\.backOrLeave\(\);\s*else if \(act === 'arm'\) this\.escArmedAt = performance\.now\(\);\s*return;/);
  assert.match(menu, /window\.addEventListener\('keyup', \(e\) => this\.onKeyUp\(e\)\);/);
  const up = body(menu, 'onKeyUp');
  assert.match(up, /this\.keysDown\.delete\(e\.code\);/, 'the keys the menus had are still forgotten');
  assert.match(up, /escArmStep\(held, escLocked\(\), this\.visibleNow && !this\.root\.hidden\) === 'resume'\) this\.backOrLeave\(\);/);
  assert.match(body(menu, 'hide'), /this\.escArmedAt = -1;/, 'into the match: the armed Back goes');
});

test('Game.ts: the three entries to the pitch, the menus keep full screen, a match paused when it goes', () => {
  assert.match(body(game, 'hideMenus'), /^\s*this\.fullscreen\?\.enter\(entry\);/, 'first, while the press still carries its activation');
  assert.equal(game.match(/this\.hideMenus\(/g).length, 3);
  assert.match(body(game, 'sessionMatchOnScreen'), /this\.hideMenus\('session'\)/);
  assert.match(body(game, 'startTraining'), /this\.hideMenus\('local'\)/);
  assert.match(body(game, 'beginLocalMatch'), /this\.hideMenus\('local'\)/);
  assert.match(body(game, 'showMenu'), /this\.fullscreen\?\.leftPitch\(\)/);
  assert.doesNotMatch(game, /exitFullscreen|requestFullscreen/, 'the menus never leave full screen; only fullscreen.ts asks for it');
  const exit = body(game, 'onFullscreenExit');
  assert.match(exit, /this\.time - this\.unlockPausedAt <= FULLSCREEN_EXIT_WINDOW/);
  assert.match(exit, /this\.setPaused\(true\);\s*this\.unlockPausedAt = this\.time;/);
  assert.doesNotMatch(exit, /touchMode|this\.touch\b/, 'every input pauses, not only touch mode');
  assert.match(game, /const FULLSCREEN_EXIT_WINDOW = 0\.5;/);
  assert.match(body(game, 'applySettings'), /this\.fullscreen\?\.setEnabled\(s\.ui\.fullscreen\)/);
  const start = body(game, 'start');
  assert.match(start, /this\.fullscreen\?\.install\(\{ playing: \(\) => this\.playing, left: \(byGame\) => this\.onFullscreenExit\(byGame\) \}\)/);
  assert.doesNotMatch(start, /fullscreenchange/, 'PageFullscreen listens, on every device');
  assert.match(body(game, 'stop'), /this\.fullscreen\?\.dispose\(\)/);
});

test('TouchControls: Android\'s tap asks through requestPageFullscreen, only while the switch is on', () => {
  const tc = read('src/input/TouchControls.ts');
  const auto = body(tc, 'autoFullscreen');
  assert.equal(auto.match(/fullscreenAllowed\(\)/g).length, 2, 'the pointerup and its click');
  assert.match(body(tc, 'requestLandscapeFullscreen'), /requestPageFullscreen\(\{ landscape: true \}\)/);
  assert.match(body(tc, 'platformEnv'), /return fullscreenEnv\(\);/);
});

test('Settings > Game: the switch after the interface size, only where full screen applies; RESTABLECER resets it', () => {
  const view = read('src/ui/screens/settings/view.ts');
  const g = body(view, 'buildGame');
  assert.match(g, /if \(fullscreenOffered\(fsEnv\)\) \{[\s\S]*toggleSwitch\(\s*'set-fullscreen'/);
  assert.ok(g.indexOf("'set-fullscreen'") > g.indexOf('page.append(this.uiSizeRow)'), 'after the interface size');
  assert.ok(g.indexOf("'set-fullscreen'") < g.indexOf("'set-motion'"), 'before reduced motion');
  assert.match(g, /Object\.assign\(st\.ui, DEFAULT_UI\)/);
});

test('the replay viewer: a button and the F key, by hand only', () => {
  const player = read('src/replay/player.ts');
  assert.match(player, /t\('replay\.fullscreen'\)/);
  assert.match(player, /fullscreenBtn\.addEventListener\('click', \(\) => togglePageFullscreen\(\)\)/);
  assert.match(player, /e\.code === 'KeyF'\) \{[\s\S]{0,160}togglePageFullscreen\(\);/);
  assert.equal(player.match(/togglePageFullscreen\(\)/g).length, 2, 'never on load');
});

test('the texts: Spanish (neutral tú) and English', async () => {
  const en = (await import('../src/locales/en.ts')).default;
  const es = (await import('../src/locales/es.ts')).default;
  assert.equal(es['settings.fullscreen'], 'Pantalla completa al jugar');
  assert.equal(en['settings.fullscreen'], 'Full screen when playing');
  assert.equal(es['settings.fullscreenHelp'], 'Al entrar a la cancha, el juego ocupa toda la pantalla. Para salir, mantén Esc.');
  assert.equal(en['settings.fullscreenHelp'], 'Entering the pitch fills the screen. To leave it, hold Esc.');
  assert.equal(es['settings.fullscreenHelpTap'], 'Un toque pone el juego en pantalla completa y en horizontal.');
  assert.equal(en['settings.fullscreenHelpTap'], 'A tap puts the game in full screen, in landscape.');
  assert.equal(es['replay.fullscreen'], 'Pantalla completa');
  assert.equal(en['replay.fullscreen'], 'Full screen');
  assert.match(es['replay.keys'], / · F: pantalla completa$/);
  assert.match(en['replay.keys'], / · F: full screen$/);
});
