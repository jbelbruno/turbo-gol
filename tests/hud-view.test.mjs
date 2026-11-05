// Settings > HUD (src/render/hudView.ts, node --test tests/hud-view.test.mjs): the owner's "que sea
// configurable desde el menú, qué quiero ver" (2026-11-05). Who gets a name tag under each choice,
// who gets a boost meter (a rival never, under any setting: the fairness rule), the HUD root's
// classes for each field and their rules in style.css, the feed's chips by kind, the rows touch
// mode leaves out; then pins on the wiring only a browser runs: the tab's page and its reset
// (view.ts), the live apply (Game.ts applySettings and the per-frame reads), the Hud's setView and
// feed, the replay viewer left as it was, and the texts in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const V = await import('../src/render/hudView.ts');
const { DEFAULT_HUD, NAME_TAG_MODES } = await import('../src/settings.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

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

const FLAGS = Object.keys(DEFAULT_HUD).filter((k) => typeof DEFAULT_HUD[k] === 'boolean');

test('name tags: the full matrix of the four choices for a teammate and a rival (the own car is nameTags.ts\')', () => {
  const want = {
    all: { mate: true, rival: true },
    rivals: { mate: false, rival: true },
    team: { mate: true, rival: false },
    none: { mate: false, rival: false },
  };
  assert.deepEqual(Object.keys(want), [...NAME_TAG_MODES]);
  for (const mode of NAME_TAG_MODES) {
    assert.equal(V.tagShown(mode, true), want[mode].mate, `${mode} teammate`);
    assert.equal(V.tagShown(mode, false), want[mode].rival, `${mode} rival`);
  }
  assert.equal(V.tagShown('garbage', true), false, 'anything else shows nothing');
});

test("fairness: a rival never gets a boost meter, under any setting; a teammate's follows its tag and the switch", () => {
  for (const mode of NAME_TAG_MODES) {
    for (const teamBoost of [true, false]) {
      assert.equal(V.boostBarShown(mode, teamBoost, false), false, `rival, ${mode}, teamBoost ${teamBoost}`);
      assert.equal(V.boostBarShown(mode, teamBoost, true), teamBoost && V.tagShown(mode, true), `teammate, ${mode}, teamBoost ${teamBoost}`);
    }
  }
  assert.equal(V.boostBarShown('all', true, true), true, 'the default: TODOS with the meter');
  assert.equal(V.boostBarShown('team', true, true), true);
  assert.equal(V.boostBarShown('rivals', true, true), false, 'no tag, no meter');
  assert.equal(V.boostBarShown('none', true, true), false);
  // The row of the switch: listed only while the names include the teammates.
  assert.deepEqual(NAME_TAG_MODES.map((m) => V.teamBoostOffered(m)), [true, false, true, false]);
});

test('the root\'s classes: none by default, one per field the player changed, every one of them in the list setView clears', () => {
  assert.deepEqual(V.hudClasses(DEFAULT_HUD), [], "today's HUD: no class at all");
  const want = { scorebug: 'hud-no-score', boost: 'hud-no-boost', camera: 'hud-no-cam', netBars: 'hud-no-bars', controls: 'hud-no-controls', goal: 'hud-sr-goal', fps: 'hud-show-fps', speed: 'hud-show-speed' };
  // The rest is not a class: the Game reads them (the ball's arrow and ring), the feed and the tags.
  const elsewhere = ['teamBoost', 'ballIndicator', 'ballMarker', 'players', 'demos'];
  assert.deepEqual([...Object.keys(want), ...elsewhere].sort(), [...FLAGS].sort());
  for (const k of FLAGS) {
    const got = V.hudClasses({ ...DEFAULT_HUD, [k]: !DEFAULT_HUD[k] });
    assert.deepEqual(got, k in want ? [want[k]] : [], k);
  }
  for (const names of NAME_TAG_MODES) assert.deepEqual(V.hudClasses({ ...DEFAULT_HUD, names }), [], `names ${names}: the tags' own`);
  const flipped = Object.fromEntries(FLAGS.map((k) => [k, !DEFAULT_HUD[k]]));
  assert.deepEqual(V.hudClasses({ ...DEFAULT_HUD, ...flipped }).sort(), [...V.HUD_VIEW_CLASSES].sort(), 'all of them, and only the listed ones');
  // Each class has its rule (the display guard is tests/css-budget.test.mjs').
  const style = read('src/style.css');
  for (const c of V.HUD_VIEW_CLASSES) assert.match(style, new RegExp(`\\.hud-root\\.${c}[ :]`), c);
  assert.ok(!V.HUD_VIEW_CLASSES.includes('hud-debug'), 'F3 stays its own');
});

test('the feed: the players\' chips (joined, left, a bot takes over) and DEMOLISHED, each by its switch', () => {
  for (const players of [true, false]) {
    for (const demos of [true, false]) {
      const h = { players, demos };
      for (const kind of ['join', 'leave', 'bot']) assert.equal(V.feedShown(h, kind), players, `${kind} ${players} ${demos}`);
      assert.equal(V.feedShown(h, 'demo'), demos);
    }
  }
});

test('touch mode lists no row its own buttons make pointless: the boost plate, the camera pill, the control hints', () => {
  assert.deepEqual([...V.HUD_TOUCH_HIDDEN].sort(), ['boost', 'camera', 'controls']);
  for (const k of Object.keys(DEFAULT_HUD)) {
    assert.equal(V.hudRowShown(k, false), true, `${k} off touch`);
    assert.equal(V.hudRowShown(k, true), !V.HUD_TOUCH_HIDDEN.includes(k), `${k} in touch mode`);
  }
});

test('the signal bars\' row is listed while the scorebug shows: the bars sit in it, and its class hides them along', () => {
  assert.equal(V.netBarsOffered(true), true);
  assert.equal(V.netBarsOffered(false), false);
  // In the scorebug's box: the bars by the clock, the clock in the board, the board in .hud-top.
  const hud = read('src/render/Hud.ts');
  const build = hud.slice(hud.indexOf("const top = el('div', 'hud-top');"), hud.indexOf('this.root.appendChild(top);'));
  assert.match(build, /this\.netBarsEl = el\('span', 'hud-bars'\);/);
  assert.match(build, /clockBox\.append\(this\.clock, this\.netBarsEl\);/);
  assert.match(build, /board\.append\([^\n]*clockBox[^\n]*\);/);
  assert.match(build, /top\.append\(board, /);
});

test('Ajustes > HUD: after JUEGO, its two groups in the owner\'s order, a row for every field, its reset covers settings.hud', () => {
  const view = read('src/ui/screens/settings/view.ts');
  const build = body(view, 'build');
  assert.match(build, /game: \(\) => this\.buildGame\(\),\s*hud: \(\) => this\.buildHud\(\),/);
  assert.match(body(view, 'subtitle'), /case 'hud':\s*return t\('settings\.hudNote'\);/);
  const hud = body(view, 'buildHud');
  // EN EL PARTIDO: the scorebug, the names' seg, then the table's switches; RENDIMIENTO after.
  const order = ['settings.groupMatch', "'scorebug'", "'set-hud-names'", 'HUD_ROWS.match', 'settings.groupPerformance', 'HUD_ROWS.performance'];
  let at = -1;
  for (const s of order) {
    const i = hud.indexOf(s);
    assert.ok(i > at, s);
    at = i;
  }
  assert.match(hud, /NAME_TAG_MODES\.map\(\(v\) => \(\{ value: v, label: t\(NAME_TAG_LABELS\[v\]\) \}\)\)/);
  assert.match(hud, /st\.hud\.names = v;\s*this\.changed\(\);\s*\/\/[^\n]*\n\s*this\.refreshHudRows\(\);/, "a names pick lists or drops the teammates' boost at once");
  // Each control shows the saved value (the live settings; the defaults only without them).
  assert.match(hud, /const hud = \(\): Readonly<HudSettings> => this\.live\?\.hud \?\? DEFAULT_HUD;/);
  assert.match(hud, /toggleSwitch\(\s*'set-hud-' \+ r\.key,\s*t\(r\.label\),\s*\(\) => hud\(\)\[r\.key\],/);
  assert.match(hud, /'set-hud-names',\s*t\('settings\.hudNames'\),\s*NAME_TAG_MODES\.map[^\n]*\n\s*\(\) => hud\(\)\.names,/);
  assert.match(hud, /const row = setRow\(t\(label\), ctl\.el, t\(help\)\);/);
  assert.match(hud, /st\.hud\[r\.key\] = v;\s*this\.changed\(\);/, 'saved and applied on every change');
  assert.match(hud, /st\.hud\[r\.key\] = v;\s*this\.changed\(\);\s*\/\/[^\n]*\n\s*if \(r\.key === 'scorebug'\) this\.refreshHudRows\(\);/, 'the scorebug lists or drops the signal bars at once');
  // Each row says what it toggles: its label and help are the field's own (a swap toggles another part).
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const labels = /const NAME_TAG_LABELS[^=]*= \{([\s\S]*?)\n\};/.exec(view)[1];
  assert.deepEqual(Object.fromEntries([...labels.matchAll(/(\w+): '([\w.]+)'/g)].map((m) => [m[1], m[2]])), Object.fromEntries(NAME_TAG_MODES.map((m) => [m, `settings.hudNames${cap(m)}`])));
  const entry = /\{ key: '(\w+)', label: '([\w.]+)', help: '([\w.]+)' \}/g;
  const entries = [.../const HUD_ROWS[^=]*= \{([\s\S]*?)\n\};/.exec(view)[1].matchAll(entry), ...hud.matchAll(entry)];
  assert.equal(entries.length, 13, 'the 12 of HUD_ROWS and the scorebug');
  for (const [, key, label, help] of entries) {
    assert.equal(label, `settings.hud${cap(key)}`, key);
    assert.equal(help, `${label}Help`, key);
  }
  assert.match(hud, /add\('names', 'settings\.hudNames', names, 'settings\.hudNamesHelp'\);/);
  const reset = /this\.actionButton\('reset-hud', t\('settings\.resetHud'\), \(\) => \{([\s\S]*?)\}\);/.exec(hud);
  assert.ok(reset, 'the head action');
  assert.match(reset[1], /Object\.assign\(st\.hud, DEFAULT_HUD\);\s*this\.refreshAll\(\);\s*this\.changed\(\);/);
  assert.doesNotMatch(reset[1], /st\.(?:controls|ui|camera|audio|touch)/, 'nothing but the tab');
  // Every field has its row, the names' and the scorebug's included, in the table's order.
  const rows = /const HUD_ROWS[^=]*= \{([\s\S]*?)\n\};/.exec(view)[1];
  const keys = ['scorebug', 'names', ...[...rows.matchAll(/key: '(\w+)'/g)].map((m) => m[1])];
  assert.deepEqual(keys, ['scorebug', 'names', 'teamBoost', 'boost', 'ballIndicator', 'ballMarker', 'camera', 'goal', 'players', 'demos', 'controls', 'netBars', 'fps', 'speed']);
  assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_HUD).sort());
  assert.ok(rows.indexOf('performance:') > rows.indexOf("key: 'controls'") && rows.indexOf('performance:') < rows.indexOf("key: 'netBars'"), 'RENDIMIENTO: the signal, the fps, the speed');
  // Listed by the device and the names (the timer reads touch mode again), the focus put back.
  const refresh = body(view, 'refreshHudRows');
  assert.match(refresh, /const hud = this\.live\?\.hud \?\? DEFAULT_HUD;/);
  assert.match(refresh, /!hudRowShown\(key, touch\) \|\| \(key === 'teamBoost' && !teamBoostOffered\(hud\.names\)\) \|\| \(key === 'netBars' && !netBarsOffered\(hud\.scorebug\)\)/);
  assert.match(refresh, /this\.hooks\.refocus\(\)/);
  // The scorebug's help by the device: the held key or button, or a tap in touch mode.
  assert.match(hud, /this\.hudScoreHelp = this\.hudRows\.get\('scorebug'\)\?\.querySelector<HTMLElement>\('\.mn-set-row-help'\) \?\? null;/);
  assert.match(read('src/ui/components/rows.ts'), /h\('span\.mn-set-row-help', null, help\)/);
  assert.match(refresh, /setText\(this\.hudScoreHelp, t\(touch \? 'settings\.hudScorebugHelpTap' : 'settings\.hudScorebugHelp'\)\);/);
  assert.match(body(view, 'refreshAll'), /this\.refreshHudRows\(\);/);
  assert.match(body(view, 'tick'), /if \(this\.tab === 'hud'\) this\.refreshHudRows\(\);/);
});

test('live apply: the Game pushes Settings > HUD after building the Hud and on every change; the rest reads it each frame', () => {
  const game = read('src/game/Game.ts');
  assert.match(game, /this\.hud = new Hud\(opts\.hudContainer\);\s*\/\/[^\n]*\n\s*this\.hud\.setView\(settings\.hud\);/, 'from the first frame');
  const apply = body(game, 'applySettings');
  assert.match(apply, /saveSettings\(s\);/, 'saved (per device: localStorage)');
  assert.match(apply, /this\.hud\.setView\(s\.hud\);/);
  assert.match(apply, /this\.ball\.setGroundMarker\(s\.hud\.ballMarker\);/);
  // A rebuilt ball (a quality switch) keeps the choice.
  assert.match(body(game, 'buildViews'), /this\.ball = new BallView\(scene, q\);\s*this\.ball\.setGroundMarker\(this\.settings\.hud\.ballMarker\);/);
  // The ball's arrow: no work at all while it is off, and the one up goes.
  assert.match(game, /if \(this\.settings\.hud\.ballIndicator\) this\.updateBallIndicator\(camera, cur\);\s*else this\.hud\.setBallIndicator\(false\);/);
  // The controls card and the click hint: off with the control hints (the card's plan still counts).
  const card = body(game, 'updateControlsCard');
  assert.match(card, /const view = inMenu \|\| !this\.playing \|\| touchMode \|\| !this\.settings\.hud\.controls \? 'off' : plan\.view;/);
  assert.ok(card.indexOf('plan.tick(') < card.indexOf('this.settings.hud.controls'), 'the plan ticks before');
  assert.match(body(game, 'frameLogic'), /hud\.showHint\([^\n]*&& settings\.hud\.controls && usesMouseButton\(settings\.bindings\.kbm\) \? POINTER_LOCK_HINT : null\);/);
});

test('the Hud: setView puts the classes on its root and keeps F3 apart; the feed drops a hidden kind; the scorebug hidden keeps its tap box', () => {
  const hud = read('src/render/Hud.ts');
  const set = body(hud, 'setView');
  assert.match(set, /const on = hudClasses\(h\);\s*for \(const c of HUD_VIEW_CLASSES\) this\.root\.classList\.toggle\(c, on\.includes\(c\)\);/);
  // What the Hud reads itself: the feed's two switches and the scorebug (feed, measurePlates).
  assert.match(set, /const v = this\.view;/);
  for (const k of ['players', 'demos', 'scorebug']) assert.match(set, new RegExp(`v\\.${k} = h\\.${k};`), k);
  assert.doesNotMatch(set, /\.hidden\b|style\./, 'the scorebug keeps its box: classes only');
  assert.doesNotMatch(set, /debug/, 'F3 is its own: setDebug, the key handler');
  assert.match(set, /this\.indRectsKey = '';/, 'the ball indicator measures the plates again');
  assert.match(body(hud, 'feed'), /^\s*if \(!feedShown\(this\.view, kind\)\) return;/, 'first thing: nothing built for a dropped chip');
  const plates = body(hud, 'measurePlates');
  assert.match(plates, /e === this\.scoreBox && !this\.view\.scorebug/);
  // Nothing to keep clear of (the scorebug hidden on a phone) is a measure kept too: no layout read
  // each frame; training and touch mode, which hide plates of their own, measure again.
  assert.match(plates, /if \(key === this\.indRectsKey && layout === this\.indLayout\) return;/);
  assert.doesNotMatch(plates, /indRects\.length > 0/);
  assert.match(plates, /const box = this\.root\.parentElement\?\.classList;\s*const layout = [^\n]*box\?\.contains\('trn-on'\)[^\n]*box\?\.contains\('tc-on'\)/);
  assert.match(read('src/render/TrainingHud.ts'), /this\.container\.classList\.add\('trn-on'\);/);
  assert.match(read('src/input/TouchControls.ts'), /const container = hudRoot\.parentElement \?\? hudRoot;[\s\S]*this\.container\.classList\.toggle\('tc-on', hudLayout\);/);
  assert.match(plates, /this\.indRectsKey = o\.width > 0 \? key : '';/, 'a root not laid out yet measures again');
  // F3 unchanged: the key toggles .hud-debug, nothing else.
  assert.match(hud, /if \(e\.code === 'F3'\) this\.setDebug\(!this\.debug\);/);
  assert.match(body(hud, 'setDebug'), /this\.root\.classList\.toggle\('hud-debug', on\);/);
  // The goal banner stays a status with its label (a screen reader speaks it however it shows).
  assert.match(hud, /this\.goal\.setAttribute\('role', 'status'\);/);
  assert.match(body(hud, 'showGoal'), /this\.goal\.setAttribute\('aria-label',/);
  // The touch tap target is the scorebug's box (visibility keeps it: css-budget's guard).
  assert.match(read('src/input/TouchControls.ts'), /this\.scoreBug = hudRoot\.querySelector\('\.hud-top'\);/);
  // The ball: the ring goes at once, and stays gone.
  const ball = read('src/render/Ball.ts');
  assert.match(body(ball, 'setGroundMarker'), /this\.markerOn = on;\s*if \(!on\) this\.marker\.visible = false;/);
  assert.match(ball, /if \(this\.markerOn && k > 0\.01\) \{/);
});

test('the replay viewer is left as it was: no setView, no ground marker switch, tags with no view', () => {
  const player = read('src/replay/player.ts');
  assert.doesNotMatch(player, /setView|setGroundMarker|settings\.hud/);
  assert.match(player, /const tags = new NameTags\(o\.tagsRoot\);/);
});

test('the texts: the owner\'s labels in Spanish (neutral tú), each with its English and a help line', () => {
  const labels = {
    'settings.tabHud': 'HUD',
    'settings.groupMatch': 'En el partido',
    'settings.groupPerformance': 'Rendimiento',
    'settings.hudScorebug': 'Marcador',
    'settings.hudNames': 'Nombres sobre los autos',
    'settings.hudTeamBoost': 'Boost de tu equipo',
    'settings.hudBoost': 'Medidor de boost',
    'settings.hudBallIndicator': 'Pelota fuera de pantalla',
    'settings.hudBallMarker': 'Marca bajo la pelota',
    'settings.hudCamera': 'Indicador de cámara',
    'settings.hudGoal': 'Cartel de gol',
    'settings.hudPlayers': 'Avisos de jugadores',
    'settings.hudDemos': 'Aviso de demolición',
    'settings.hudControls': 'Ayudas de controles',
    'settings.hudNetBars': 'Señal de conexión',
    'settings.hudFps': 'Mostrar FPS',
    'settings.hudSpeed': 'Velocímetro',
    'settings.hudNamesAll': 'TODOS',
    'settings.hudNamesRivals': 'RIVALES',
    'settings.hudNamesTeam': 'EQUIPO',
    'settings.hudNamesNone': 'NINGUNO',
    'settings.resetHud': 'RESTABLECER HUD',
  };
  for (const [k, v] of Object.entries(labels)) {
    assert.equal(es[k], v, k);
    assert.equal(typeof en[k], 'string', `${k} en`);
    assert.ok(en[k].length > 0, `${k} en`);
  }
  for (const k of Object.keys(labels).filter((k) => /^settings\.hud(?!Names[A-Z])/.test(k))) {
    assert.equal(typeof en[`${k}Help`], 'string', `${k}Help en`);
    assert.equal(typeof es[`${k}Help`], 'string', `${k}Help es`);
  }
  assert.equal(en['settings.hudNamesAll'], 'ALL');
  assert.equal(en['settings.hudNamesNone'], 'NONE');
  assert.match(es['settings.hudTeamBoostHelp'], /rival nunca/);
  assert.match(en['settings.hudTeamBoostHelp'], /rival's boost never shows/);
  // Hidden, the scorebug's score and clock are one key or button away, or a tap in touch mode
  // (each device reads its own line: view.ts refreshHudRows).
  assert.match(es['settings.hudScorebugHelp'], /mantén la tecla o el botón del marcador/);
  assert.match(en['settings.hudScorebugHelp'], /hold the scoreboard key or button/);
  assert.match(es['settings.hudScorebugHelpTap'], /toca arriba a la izquierda/);
  assert.match(en['settings.hudScorebugHelpTap'], /tap the top left corner/);
  assert.doesNotMatch(es['settings.hudScorebugHelp'], /toca/);
  assert.doesNotMatch(es['settings.hudScorebugHelpTap'], /tecla|botón/);
  // "Cuenta" is the account everywhere else in this app.
  assert.doesNotMatch(es['settings.hudDemosHelp'], /cuenta/i);
  // One short line each, as the other tabs' help (the upright phone's strip, the narrow rail).
  for (const k of Object.keys(es).filter((k) => /^settings\.hud\w*Help(?:Tap)?$/.test(k))) {
    assert.ok(es[k].length <= 80, `${k} es: ${es[k].length}`);
    assert.ok(en[k].length <= 80, `${k} en: ${en[k].length}`);
  }
  // The whole file's check is tests/i18n-es.test.mjs; these are the verbs this tab would use.
  const voseo = /(?<!\p{L})(?:podés|tenés|querés|mantené|tocá|elegí|ocultá|mirá|vos)(?!\p{L})/iu;
  for (const k of Object.keys(es).filter((k) => k.startsWith('settings.hud') || k === 'settings.resetHud')) assert.doesNotMatch(es[k], voseo, k);
});
