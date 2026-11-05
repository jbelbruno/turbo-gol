// The name tags over the cars (src/render/nameTags.ts, node --test tests/name-tags.test.mjs): the
// distance steps and their hysteresis, the boost meter on teammates only (judged from the viewer's
// team, never from blue) and on every car for a replay's spectator, the viewer's own car never
// tagged, the edge tag's side (mirrored behind the camera, held by its band) and its clamp into the
// safe rect, the fade over the ball, the classes; then the DOM layer on a minimal fake document, as
// the Game and the replay viewer drive it (a quiet frame writes and measures nothing); then crowds
// (the declutter pass: tags pinned to one edge, a bunch far away, an order that holds, no move for a
// tag apart, no jumping up and down as cars side by side wobble, the fade over the ball where the
// pass put a tag); then pins on the sheet (nametags.css) and on the wiring only a browser runs
// (Game.ts, player.ts, replay.html).
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

const THREE = await import('three/webgpu');
const N = await import('../src/render/nameTags.ts');
const { CARS_OFFSET, CAR_STRIDE, C_BOOST, C_IS_DEMOED, STATE_BUFFER_FLOATS } = await import('../src/sim/types.ts');
const { BALL } = await import('../src/sim/constants.ts');
const { TAG_MID_AT, TAG_FAR_AT, TAG_HYSTERESIS: H, TAG_OPACITY, TAG_OVER_BALL_OPACITY, TAG_EDGE_BAND, TAG_GAP, TAG_STACK_HOLD, TAG_ORDER_HYSTERESIS, tagBucket, tagShown, tagHasMeter, isBotRow, boostPct, tagAnchor, clampTag, orderTags, declutterTags, overBall, tagOpacity, tagKey, tagClass } = N;

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('distance steps: three of them, each change only past the band round its line (no flicker on the line)', () => {
  assert.equal(tagBucket(0, 0), 0);
  // Base to mid only past the line plus the band; inside the band each keeps the step it had.
  assert.equal(tagBucket(TAG_MID_AT + H - 1, 0), 0);
  assert.equal(tagBucket(TAG_MID_AT + H + 1, 0), 1);
  assert.equal(tagBucket(TAG_MID_AT, 0), 0);
  assert.equal(tagBucket(TAG_MID_AT, 1), 1);
  assert.equal(tagBucket(TAG_MID_AT - H + 1, 1), 1);
  assert.equal(tagBucket(TAG_MID_AT - H - 1, 1), 0);
  assert.equal(tagBucket(TAG_FAR_AT, 1), 1);
  assert.equal(tagBucket(TAG_FAR_AT, 2), 2);
  assert.equal(tagBucket(TAG_FAR_AT + H + 1, 1), 2);
  assert.equal(tagBucket(TAG_FAR_AT - H - 1, 2), 1);
  // A jump goes all the way at once, either way (a respawn, a camera cut).
  assert.equal(tagBucket(20000, 0), 2);
  assert.equal(tagBucket(10, 2), 0);
  // A car walking back and forth over the mid line by less than the band never changes step.
  let b = 1;
  for (const d of [TAG_MID_AT - H / 2, TAG_MID_AT + H / 2, TAG_MID_AT - H / 2, TAG_MID_AT + H / 2]) {
    b = tagBucket(d, b);
    assert.equal(b, 1, String(d));
  }
});

test('the viewer\'s own car never has a tag (in a replay, the followed car); a demolished one neither', () => {
  for (let self = 0; self < 6; self++) for (let i = 0; i < 6; i++) assert.equal(tagShown(i, self, false), i !== self, `${i} / ${self}`);
  assert.equal(tagShown(2, -1, false), true, 'a replay\'s broadcast camera: every car');
  assert.equal(tagShown(2, -1, true), false, 'demolished: until it respawns');
});

test('the boost meter: teammates only, never a rival, judged from the viewer\'s team (not from blue); a spectator sees every car\'s', () => {
  assert.equal(tagHasMeter(0, 0), true);
  assert.equal(tagHasMeter(1, 0), false);
  // Playing red: the reds are the teammates, the blues the rivals.
  assert.equal(tagHasMeter(1, 1), true);
  assert.equal(tagHasMeter(0, 1), false);
  assert.equal(tagHasMeter(0, null), true);
  assert.equal(tagHasMeter(1, null), true);
});

test('bots: every car but the player\'s own and a human\'s (the scoreboard rows\' default)', () => {
  assert.equal(isBotRow({ name: 'Bot 1', team: 1, you: false }), true);
  assert.equal(isBotRow({ name: 'Ana', team: 1, you: false, bot: false }), false);
  assert.equal(isBotRow({ name: 'Bot 2', team: 0, you: false, bot: true }), true);
  assert.equal(isBotRow({ name: 'You', team: 0, you: true }), false);
});

test('the meter\'s number: whole, 0 to 100', () => {
  assert.equal(boostPct(33.4), 33);
  assert.equal(boostPct(99.6), 100);
  assert.equal(boostPct(120), 100);
  assert.equal(boostPct(-3), 0);
  assert.equal(boostPct(Number.NaN), 0);
});

test('anchor: over the point on screen; off any edge, at the left or right edge with its arrow', () => {
  const out = { x: 0, y: 0, side: 0 };
  assert.equal(tagAnchor(0, 0, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 800, y: 450, side: 0 });
  assert.equal(tagAnchor(0.5, -0.5, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1200, y: 675, side: 0 });
  // Off the right: pinned to the right edge where the way from the centre crosses it.
  assert.equal(tagAnchor(2, 1, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1600, y: 225, side: 1 });
  assert.equal(tagAnchor(-3, 0, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 0, y: 450, side: -1 });
  // Above or below the picture within its width: pinned too, to that edge's corner on the car's side.
  assert.equal(tagAnchor(0.2, 1.6, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1600, y: 0, side: 1 });
  assert.equal(tagAnchor(-0.5, -1.6, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 0, y: 900, side: -1 });
  // Near straight above, a pinned tag keeps its side instead of flipping as the car crosses the middle.
  assert.equal(tagAnchor(-0.1, 1.6, 0.5, 1, 1600, 900, out), true);
  assert.equal(out.side, 1);
  assert.equal(tagAnchor(-0.6, 1.6, 0.5, 1, 1600, 900, out), true);
  assert.equal(out.side, -1, 'well to one side it follows the car');
  // Inside the near plane: no tag.
  assert.equal(tagAnchor(0, 0, -1.2, 0, 1600, 900, out), false);
});

test('anchor at the edge: pinned past it, back over the car only the band inside it (no flicker along the edge)', () => {
  const out = { x: 0, y: 0, side: 0 };
  assert.ok(TAG_EDGE_BAND > 0 && TAG_EDGE_BAND < 0.1);
  // On screen up to the edge itself; pinned just past it.
  assert.equal(tagAnchor(1, 0, 0.5, 0, 1600, 900, out), true);
  assert.equal(out.side, 0);
  assert.equal(tagAnchor(1.01, 0, 0.5, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1600, y: 450, side: 1 });
  // A car alongside at the edge going back and forth by less than the band stays pinned.
  let side = 1;
  for (const nx of [1 - TAG_EDGE_BAND / 2, 1.01, 1 - TAG_EDGE_BAND / 2, 0.999]) {
    assert.equal(tagAnchor(nx, 0, 0.5, side, 1600, 900, out), true);
    side = out.side;
    assert.equal(side, 1, String(nx));
    assert.equal(out.x, 1600);
  }
  // Past the band it is back over the car.
  assert.equal(tagAnchor(1 - TAG_EDGE_BAND - 0.01, 0, 0.5, 1, 1600, 900, out), true);
  assert.equal(out.side, 0);
  assert.ok(Math.abs(out.x - (2 - TAG_EDGE_BAND - 0.01) * 800) < 1e-6, String(out.x));
  // The same at the top and on the left.
  assert.equal(tagAnchor(0.3, 1 - TAG_EDGE_BAND / 2, 0.5, 1, 1600, 900, out), true);
  assert.equal(out.side, 1);
  assert.equal(tagAnchor(-1 + TAG_EDGE_BAND / 2, 0.2, 0.5, -1, 1600, 900, out), true);
  assert.equal(out.side, -1);
  assert.equal(tagAnchor(-1 + TAG_EDGE_BAND / 2, 0.2, 0.5, 0, 1600, 900, out), true);
  assert.equal(out.side, 0, 'a tag that was on screen stays until the edge itself');
});

test('anchor behind the camera: mirrored back (a car behind on the left points left, one behind and below sits low), to the bottom straight behind, its side kept near the middle', () => {
  const out = { x: 0, y: 0, side: 0 };
  // Projected through the eye, a car behind on the left lands on the right, and one below lands above: the mirror puts both back.
  assert.equal(tagAnchor(0.4, 0.1, 1.3, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 0, y: 562.5, side: -1 });
  assert.equal(tagAnchor(-0.4, -0.1, 1.3, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1600, y: 337.5, side: 1 });
  // Straight behind: the bottom.
  assert.equal(tagAnchor(0, 0, 1.3, 0, 1600, 900, out), true);
  assert.equal(out.y, 900);
  // Near straight behind the arrow keeps its side instead of flipping every frame.
  assert.equal(tagAnchor(0.01, 0.5, 1.3, 1, 1600, 900, out), true);
  assert.equal(out.side, 1);
  assert.equal(tagAnchor(-0.01, 0.5, 1.3, -1, 1600, 900, out), true);
  assert.equal(out.side, -1);
  assert.equal(tagAnchor(0.4, 0.5, 1.3, -1, 1600, 900, out), true);
  assert.equal(out.side, -1, 'well to one side it follows the car');
  // Behind, a point inside the picture's frame is still pinned (no band to come back through).
  assert.equal(tagAnchor(0.3, 0.3, 1.3, 1, 1600, 900, out), true);
  assert.notEqual(out.side, 0);
});

test('clamp: hung by its bottom centre, kept inside the safe rect, an edge tag\'s arrow too', () => {
  const safe = { left: 12, top: 12, right: 1588, bottom: 888 };
  const box = { w: 100, h: 20, ovl: 0, ovr: 0 };
  const at = { x: 0, y: 0 };
  clampTag(800, 450, box, safe, at);
  assert.deepEqual(at, { x: 750, y: 430 });
  // Off the right with an arrow reaching 15 px past the box: the arrow stays inside too.
  clampTag(1600, 450, { ...box, ovr: 15 }, safe, at);
  assert.deepEqual(at, { x: 1588 - 100 - 15, y: 430 });
  clampTag(0, 450, { ...box, ovl: 15 }, safe, at);
  assert.deepEqual(at, { x: 12 + 15, y: 430 });
  // Off the top and the bottom.
  clampTag(800, -300, box, safe, at);
  assert.equal(at.y, 12);
  clampTag(800, 2000, box, safe, at);
  assert.equal(at.y, 888 - 20);
  // A tag wider than the room: its left edge at the safe left.
  clampTag(50, 450, { w: 2000, h: 20, ovl: 0, ovr: 0 }, safe, at);
  assert.equal(at.x, 12);
});

test('over the ball: a box touching its circle fades to 35 %, else its step\'s opacity (an edge tag at full)', () => {
  assert.equal(overBall(100, 100, 50, 20, 125, 110, 5), true);
  assert.equal(overBall(100, 100, 50, 20, 170, 110, 25), true);
  assert.equal(overBall(100, 100, 50, 20, 180, 110, 25), false);
  assert.equal(overBall(100, 100, 50, 20, 165, 135, 20), false, 'the corner is farther than the radius');
  assert.equal(TAG_OVER_BALL_OPACITY, 0.35);
  assert.deepEqual([0, 1, 2].map((b) => tagOpacity(b, 0, false)), [...TAG_OPACITY]);
  assert.deepEqual([...TAG_OPACITY], [1, 0.86, 0.72]);
  // The mockup's edge tag (.tg-neon--off) has no step and is not dimmed, whatever the car's distance.
  for (const b of [0, 1, 2]) for (const s of [-1, 1]) assert.equal(tagOpacity(b, s, false), 1);
  for (const b of [0, 1, 2]) for (const s of [-1, 0, 1]) assert.equal(tagOpacity(b, s, true), TAG_OVER_BALL_OPACITY);
});

test('classes: team, meter, bot, the step or the edge with its side; the key changes exactly when the class does', () => {
  assert.equal(tagClass(0, true, false, 0, 0), 'tg-neon tg-neon--blue tg-neon--meter');
  assert.equal(tagClass(1, false, true, 1, 0), 'tg-neon tg-neon--red tg-neon--isbot tg-neon--mid');
  assert.equal(tagClass(1, false, false, 2, 0), 'tg-neon tg-neon--red tg-neon--far');
  assert.equal(tagClass(1, false, false, 2, 1), 'tg-neon tg-neon--red tg-neon--off tg-neon--offr');
  assert.equal(tagClass(0, true, false, 1, -1), 'tg-neon tg-neon--blue tg-neon--meter tg-neon--off tg-neon--offl');
  const seen = new Map();
  for (const team of [0, 1]) for (const meter of [false, true]) for (const bot of [false, true]) for (const bucket of [0, 1, 2]) for (const side of [-1, 0, 1]) {
    const k = tagKey(team, meter, bot, bucket, side);
    const c = tagClass(team, meter, bot, bucket, side);
    if (seen.has(k)) assert.equal(seen.get(k), c, `key ${k}`);
    seen.set(k, c);
  }
  assert.equal(new Set(seen.values()).size, seen.size, 'two classes never share a key');
});

test('the projection end to end: in front on screen, behind on the right pinned right, behind on the left pinned left, both low (they are below the camera)', () => {
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 10, 40000);
  cam.position.set(0, 300, 1500);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const out = { x: 0, y: 0, side: 0 };
  const v = new THREE.Vector3();
  v.set(-600, 157, 0).project(cam);
  assert.equal(tagAnchor(v.x, v.y, v.z, 0, 1600, 900, out), true);
  assert.equal(out.side, 0);
  assert.ok(out.x > 0 && out.x < 800);
  v.set(700, 157, 4000).project(cam);
  assert.ok(v.z > 1, 'behind');
  assert.equal(tagAnchor(v.x, v.y, v.z, 0, 1600, 900, out), true);
  assert.equal(out.side, 1);
  assert.ok(out.y > 450, `behind and below: the lower half (${out.y})`);
  v.set(-700, 157, 4000).project(cam);
  assert.equal(tagAnchor(v.x, v.y, v.z, 0, 1600, 900, out), true);
  assert.equal(out.side, -1);
  assert.ok(out.y > 450, `behind and below: the lower half (${out.y})`);
  // High above the picture, in front: pinned at a top corner.
  v.set(200, 3000, 0).project(cam);
  assert.ok(v.y > 1 && Math.abs(v.x) <= 1);
  assert.equal(tagAnchor(v.x, v.y, v.z, 0, 1600, 900, out), true);
  assert.deepEqual(out, { x: 1600, y: 0, side: 1 });
});

// ---- the DOM layer, on a fake document ----------------------------------------------------------

/** Every DOM write (a class, the text, hidden, a style) and box read the layer makes: a quiet frame makes none. */
const io = { writes: 0, reads: 0 };

function countedStyle() {
  return new Proxy(
    {},
    {
      set(o, k, v) {
        io.writes++;
        o[k] = v;
        return true;
      },
    },
  );
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this._className = '';
    this._hidden = false;
    this._text = '';
    this._cw = 0;
    this._ch = 0;
    this.style = countedStyle();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.classList = {
      add: (c) => {
        if (!this.has(c)) this.className = `${this.className} ${c}`.trim();
      },
    };
  }
  has(c) {
    return this._className.split(' ').includes(c);
  }
  get className() {
    return this._className;
  }
  set className(v) {
    io.writes++;
    this._className = v;
  }
  get hidden() {
    return this._hidden;
  }
  set hidden(v) {
    io.writes++;
    this._hidden = v;
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    io.writes++;
    this._text = v;
  }
  append(...cs) {
    for (const c of cs) {
      c.parent = this;
      this.children.push(c);
    }
  }
  remove() {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  set clientWidth(v) {
    this._cw = v;
  }
  get clientWidth() {
    io.reads++;
    return this._cw;
  }
  set clientHeight(v) {
    this._ch = v;
  }
  get clientHeight() {
    io.reads++;
    return this._ch;
  }
  /**
   * A tag measures 100 x 20; an edge tag's arrow 14 wide, reaching 15 px past its side (the
   * sheet's right: -1em / left: -0.95em); nothing else has a box (the probe falls back to the bare inset).
   */
  get offsetWidth() {
    io.reads++;
    if (this.has('tg-neon')) return 100;
    return this.has('tg-neon-arrow') && this.parent?.has('tg-neon--off') ? 14 : 0;
  }
  get offsetHeight() {
    io.reads++;
    return this.has('tg-neon') ? 20 : 0;
  }
  get offsetLeft() {
    io.reads++;
    if (!this.has('tg-neon-arrow') || this.parent === null) return 0;
    return this.parent.has('tg-neon--offr') ? 101 : this.parent.has('tg-neon--offl') ? -15 : 0;
  }
  get offsetTop() {
    io.reads++;
    return 0;
  }
}

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: (tag) => new FakeEl(tag) };

/** A 2v2 on the screen of a camera behind the blue half: four cars, their state and the ball far away. */
function scene() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 10, 40000);
  camera.position.set(0, 300, 1500);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const cars = [new THREE.Vector3(0, 17, 1200), new THREE.Vector3(-600, 17, 0), new THREE.Vector3(500, 17, -500), new THREE.Vector3(-200, 17, -900)].map((position) => ({ position }));
  const offsets = cars.map((_c, i) => CARS_OFFSET + i * CAR_STRIDE);
  const state = new Float32Array(STATE_BUFFER_FLOATS);
  state[offsets[1] + C_BOOST] = 42.4;
  state[offsets[2] + C_BOOST] = 88;
  state[offsets[3] + C_BOOST] = 12;
  const root = new FakeEl('div');
  root.clientWidth = 1600;
  root.clientHeight = 900;
  return { camera, cars, offsets, state, root, ball: new THREE.Vector3(0, 93, -30000) };
}

/** Puts car `i` where its tag's point projects to (`nx`, `ny`) at NDC depth `nz` (0.99: about 2000 uu away). */
function placeAt(s, i, nx, ny, nz = 0.99) {
  const p = new THREE.Vector3(nx, ny, nz).unproject(s.camera);
  s.cars[i].position.set(p.x, p.y - N.TAG_HEIGHT, p.z);
}

/** Car i's tag: its element, name text, meter fill and arrow (the probe is the layer's first child). */
function tagOf(root, i) {
  const el = root.children[1 + i];
  return { el, name: el.children[0].children[1], fill: el.children[3].children[0], arrow: el.children[4], classes: el.className.split(' ') };
}

/** The x a tag was last moved to. */
const xOf = (t) => Number(/translate3d\((-?[\d.]+)px/.exec(t.el.style.transform)[1]);

test('the Game\'s layer: no tag on the player\'s own car, the lime meter on its teammate only, the rivals without it', () => {
  const s = scene();
  const tags = new N.NameTags(s.root);
  assert.equal(s.root.hidden, true, 'hidden until a match is on screen');
  assert.equal(s.root.attrs['aria-hidden'], 'true');
  assert.ok(s.root.has('tg-tags'), 'the layer\'s box (nametags.css .tg-tags: the replay\'s #tags has no rule of its own)');
  assert.equal(s.root.children[0].className, 'tg-tags-safe');
  tags.setVisible(true);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Jv_77_B', team: 1, you: false, bot: false },
    { name: '<b>Lucho</b>', team: 1, you: false, bot: false },
  ];
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(tagOf(s.root, 0).el.hidden, true, 'the own car');
  const mate = tagOf(s.root, 1);
  assert.equal(mate.el.hidden, false);
  assert.ok(mate.classes.includes('tg-neon--blue') && mate.classes.includes('tg-neon--meter') && mate.classes.includes('tg-neon--isbot'), mate.el.className);
  assert.equal(mate.fill.style.transform, 'scaleX(0.42)');
  assert.equal(mate.name.textContent, 'Bot 1');
  for (const i of [2, 3]) {
    const rival = tagOf(s.root, i);
    assert.equal(rival.el.hidden, false);
    assert.ok(rival.classes.includes('tg-neon--red') && !rival.classes.includes('tg-neon--meter') && !rival.classes.includes('tg-neon--isbot'), rival.el.className);
    assert.equal(rival.fill.style.transform, undefined, 'a rival\'s boost is never written');
    assert.match(rival.el.style.transform, /^translate3d\(-?[\d.]+px, -?[\d.]+px, 0\)$/);
    assert.equal(rival.el.style.opacity, '1');
  }
  assert.equal(tagOf(s.root, 3).name.textContent, '<b>Lucho</b>', 'a name is text, never markup');
  // A boost that changes by less than a whole number writes nothing (the fill keeps what was there); a whole one does.
  mate.fill.style.transform = 'untouched';
  s.state[s.offsets[1] + C_BOOST] = 42.2;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(mate.fill.style.transform, 'untouched');
  s.state[s.offsets[1] + C_BOOST] = 100;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(mate.fill.style.transform, 'scaleX(1)');
  // A human who leaves: the bot that takes the seat over shows as one at once.
  rows[2].bot = true;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(tagOf(s.root, 2).classes.includes('tg-neon--isbot'));
  // Demolished: hidden until it respawns.
  s.state[s.offsets[3] + C_IS_DEMOED] = 1;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(tagOf(s.root, 3).el.hidden, true);
  s.state[s.offsets[3] + C_IS_DEMOED] = 0;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(tagOf(s.root, 3).el.hidden, false);
  // The menus: the whole layer goes.
  tags.setVisible(false);
  assert.equal(s.root.hidden, true);
});

test('playing red: the red teammate gets the meter, the blues none', () => {
  const s = scene();
  const tags = new N.NameTags(s.root);
  tags.setVisible(true);
  const rows = [
    { name: 'Ana', team: 0, you: false, bot: false },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'You', team: 1, you: true },
    { name: 'Mariana', team: 1, you: false, bot: false },
  ];
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 2, 1);
  assert.equal(tagOf(s.root, 2).el.hidden, true);
  for (const i of [0, 1]) assert.ok(!tagOf(s.root, i).classes.includes('tg-neon--meter'), `blue ${i}`);
  const mate = tagOf(s.root, 3);
  assert.ok(mate.classes.includes('tg-neon--red') && mate.classes.includes('tg-neon--meter'), mate.el.className);
  assert.equal(mate.fill.style.transform, 'scaleX(0.12)');
});

test('Settings > HUD through the Game\'s getter, read on every update: RIVALES, EQUIPO, NINGUNO, the teammates\' boost; a rival\'s meter never', () => {
  const s = scene();
  const view = { names: 'all', teamBoost: true };
  const tags = new N.NameTags(s.root, () => view);
  tags.setVisible(true);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Jv_77_B', team: 1, you: false, bot: false },
    { name: 'Lucho', team: 1, you: false, bot: false },
  ];
  const frame = () => {
    tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
    return [1, 2, 3].map((i) => tagOf(s.root, i));
  };
  const shown = (ts) => ts.map((x) => !x.el.hidden);
  // A hidden tag keeps the classes it last had: only a shown one counts.
  const meters = (ts) => ts.map((x) => !x.el.hidden && x.classes.includes('tg-neon--meter'));
  assert.deepEqual(shown(frame()), [true, true, true], 'TODOS');
  assert.deepEqual(meters(frame()), [true, false, false]);
  view.names = 'rivals';
  let ts = frame();
  assert.deepEqual(shown(ts), [false, true, true], 'RIVALES: the teammate goes, at once');
  assert.deepEqual(meters(ts), [false, false, false]);
  view.names = 'team';
  ts = frame();
  assert.deepEqual(shown(ts), [true, false, false], 'EQUIPO');
  assert.deepEqual(meters(ts), [true, false, false]);
  view.teamBoost = false;
  ts = frame();
  assert.deepEqual(shown(ts), [true, false, false]);
  assert.deepEqual(meters(ts), [false, false, false], "the teammates' boost off: the name stays");
  view.names = 'none';
  assert.deepEqual(shown(frame()), [false, false, false], 'NINGUNO');
  // Every choice, for a rival: no meter, and its boost never written.
  for (const names of ['all', 'rivals', 'team', 'none']) {
    for (const teamBoost of [true, false]) {
      view.names = names;
      view.teamBoost = teamBoost;
      ts = frame();
      for (const r of [ts[1], ts[2]]) {
        assert.ok(!r.classes.includes('tg-neon--meter'), `${names} ${teamBoost}`);
        assert.equal(r.fill.style.transform, undefined, `${names} ${teamBoost}`);
      }
    }
  }
  // Back to TODOS: every tag back over its car.
  view.names = 'all';
  view.teamBoost = true;
  ts = frame();
  assert.deepEqual(shown(ts), [true, true, true]);
  assert.deepEqual(meters(ts), [true, false, false]);
  assert.equal(tagOf(s.root, 0).el.hidden, true, 'never the own car');
});

test('the replay\'s layer: every car shows its boost, the followed car has no tag, a tag over the ball fades', () => {
  const s = scene();
  const tags = new N.NameTags(s.root);
  tags.setVisible(true);
  const rows = ['Mariana', 'Jugador 2', 'Invitado 4821', 'Bot'].map((name, i) => ({ name, team: i < 2 ? 0 : 1, you: false, bot: i === 3 }));
  // The broadcast camera: no car followed.
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, -1, null);
  for (let i = 0; i < 4; i++) {
    const t = tagOf(s.root, i);
    assert.equal(t.el.hidden, false, `car ${i}`);
    assert.ok(t.classes.includes('tg-neon--meter'), t.el.className);
  }
  assert.equal(tagOf(s.root, 2).fill.style.transform, 'scaleX(0.88)');
  // A car's camera: that car has none.
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 1, null);
  assert.equal(tagOf(s.root, 1).el.hidden, true);
  assert.equal(tagOf(s.root, 0).el.hidden, false);
  // The ball right where car 2's tag hangs: that tag fades, the others do not.
  s.ball.set(s.cars[2].position.x, s.cars[2].position.y + N.TAG_HEIGHT, s.cars[2].position.z);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 1, null);
  assert.equal(tagOf(s.root, 2).el.style.opacity, String(TAG_OVER_BALL_OPACITY));
  assert.notEqual(tagOf(s.root, 0).el.style.opacity, String(TAG_OVER_BALL_OPACITY));
});

test('off screen: pinned inside the safe inset at the edge, the arrow towards the car and inside the inset too, at full opacity', () => {
  const s = scene();
  const tags = new N.NameTags(s.root);
  tags.setVisible(true);
  s.cars[2].position.set(20000, 17, 0);
  s.cars[3].position.set(-700, 17, 4000);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Lucho_10', team: 1, you: false, bot: false },
    { name: 'Bot 3', team: 1, you: false },
  ];
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  const right = tagOf(s.root, 2);
  assert.ok(right.classes.includes('tg-neon--off') && right.classes.includes('tg-neon--offr'), right.el.className);
  assert.equal(right.arrow.textContent, '››');
  // The arrow reaches 15 px past the tag's right side: the tag moves in by that much.
  assert.equal(xOf(right), 1600 - 12 - 100 - 15, 'against the right edge, its arrow inside the inset');
  assert.equal(right.el.style.opacity, '1');
  const left = tagOf(s.root, 3);
  assert.ok(left.classes.includes('tg-neon--offl'), left.el.className);
  assert.equal(left.arrow.textContent, '‹‹');
  assert.equal(xOf(left), 12 + 15, 'against the left edge, its arrow inside the inset');
  assert.equal(left.el.style.opacity, '1');
  // Back on screen: no arrow, no overhang.
  s.cars[2].position.set(500, 17, -500);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(!tagOf(s.root, 2).classes.includes('tg-neon--off'));
  assert.equal(right.arrow.textContent, '');
});

test('the layer keeps each tag\'s step and edge: past a band it changes, inside it holds (no flicker on a line)', () => {
  const s = scene();
  s.ball.set(0, 93, 30000); // behind the camera: no fade
  const tags = new N.NameTags(s.root);
  tags.setVisible(true);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Lucho_10', team: 1, you: false, bot: false },
    { name: 'Bot 3', team: 1, you: false },
  ];
  /** Car 2's tag point straight ahead at the eye's height, `d` uu from the camera. */
  const at = (d) => {
    s.cars[2].position.set(0, 300 - N.TAG_HEIGHT, 1500 - d);
    tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
    return tagOf(s.root, 2);
  };
  let t = at(TAG_MID_AT + H + 100);
  assert.ok(t.classes.includes('tg-neon--mid'), t.el.className);
  assert.equal(t.el.style.opacity, String(TAG_OPACITY[1]));
  t = at(TAG_MID_AT - H / 2);
  assert.ok(t.classes.includes('tg-neon--mid'), 'inside the band: still the middle step');
  t = at(TAG_MID_AT - H - 100);
  assert.ok(!t.classes.includes('tg-neon--mid') && !t.classes.includes('tg-neon--far'), t.el.className);
  assert.equal(t.el.style.opacity, '1');
  t = at(TAG_FAR_AT + H + 100);
  assert.ok(t.classes.includes('tg-neon--far'), t.el.className);
  t = at(TAG_FAR_AT - H / 2);
  assert.ok(t.classes.includes('tg-neon--far'), 'inside the band: still the far step');
  assert.equal(t.el.style.opacity, String(TAG_OPACITY[2]));
  // At the right edge: pinned just past it, still pinned the band's half inside, back over the car past it.
  placeAt(s, 2, 1.02, 0);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(t.el.className.includes('tg-neon--offr'), t.el.className);
  placeAt(s, 2, 1 - TAG_EDGE_BAND / 2, 0);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(t.el.className.includes('tg-neon--offr'), 'inside the band: still pinned');
  placeAt(s, 2, 1 - 2 * TAG_EDGE_BAND, 0);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(!t.el.className.includes('tg-neon--off'), t.el.className);
});

test('a quiet frame writes nothing and measures nothing, though the Game shows the layer every frame', () => {
  const s = scene();
  const tags = new N.NameTags(s.root);
  // An edge tag (with its arrow) and a teammate's meter in the picture too.
  s.cars[3].position.set(-700, 17, 4000);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Jv_77_B', team: 1, you: false, bot: false },
    { name: 'Bot 3', team: 1, you: false },
  ];
  tags.setVisible(true);
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.ok(tagOf(s.root, 3).classes.includes('tg-neon--off'));
  assert.ok(tagOf(s.root, 1).classes.includes('tg-neon--meter'));
  for (let frame = 0; frame < 3; frame++) {
    io.writes = 0;
    io.reads = 0;
    tags.setVisible(true);
    tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
    assert.equal(io.writes, 0, `frame ${frame}: DOM writes`);
    assert.equal(io.reads, 0, `frame ${frame}: box reads (a layout)`);
  }
  // A whole number of boost writes the fill alone; a resize measures again.
  s.state[s.offsets[1] + C_BOOST] = 43;
  io.writes = 0;
  tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0);
  assert.equal(io.writes, 1);
  assert.equal(io.reads, 0);
});

// ---- crowds: the declutter pass ------------------------------------------------------------------

/** A 3v3 at 800 x 450 (the window the pile-up was read in): scene()'s four cars and two more, the player's own car 0. */
function scene6() {
  const s = scene();
  s.root.clientWidth = 800;
  s.root.clientHeight = 450;
  for (const x of [300, -300]) s.cars.push({ position: new THREE.Vector3(x, 17, -200) });
  s.offsets.push(CARS_OFFSET + 4 * CAR_STRIDE, CARS_OFFSET + 5 * CAR_STRIDE);
  s.ball.set(0, 93, 30000); // behind the camera: no fade
  const tags = new N.NameTags(s.root);
  tags.setVisible(true);
  const rows = [
    { name: 'You', team: 0, you: true },
    { name: 'Bot 1', team: 0, you: false },
    { name: 'Bot 2', team: 0, you: false },
    { name: 'Bot 3', team: 1, you: false },
    { name: 'Bot 4', team: 1, you: false },
    { name: 'Bot 5', team: 1, you: false },
  ];
  return { ...s, frame: () => tags.update(s.camera, rows, s.cars, s.offsets, s.state, s.ball, 0, 0) };
}

/** The 800 x 450 layer's safe rect (the fake's probe has no box: the bare 12 px inset). */
const SAFE6 = { left: 12, top: 12, right: 788, bottom: 438 };

/** The y a tag was last moved to. */
const yOf = (t) => Number(/translate3d\(-?[\d.]+px, (-?[\d.]+)px/.exec(t.el.style.transform)[1]);

/** Car i's tag as drawn: the fake's 100 x 20 box where the layer last moved it, with an edge tag's arrow (15 px past its side). */
function drawn(root, i) {
  const t = tagOf(root, i);
  const x = xOf(t);
  const y = yOf(t);
  return { i, x, y, left: x - (t.classes.includes('tg-neon--offl') ? 15 : 0), right: x + 100 + (t.classes.includes('tg-neon--offr') ? 15 : 0), top: y, bottom: y + 20 };
}

/** Every one of these tags inside the safe rect, and no two nearer than TAG_GAP. */
function assertClear(ps) {
  for (const p of ps) assert.ok(p.left >= SAFE6.left && p.right <= SAFE6.right && p.top >= SAFE6.top && p.bottom <= SAFE6.bottom, `tag ${p.i} outside the inset: ${JSON.stringify(p)}`);
  for (const a of ps) {
    for (const b of ps) {
      if (a.i >= b.i) continue;
      const apart = a.right + TAG_GAP <= b.left || b.right + TAG_GAP <= a.left || a.bottom + TAG_GAP <= b.top || b.bottom + TAG_GAP <= a.top;
      assert.ok(apart, `tags ${a.i} and ${b.i} overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
  }
}

/** Where a tag whose point projects to (nx, ny) hangs with no other about: tagAnchor, clampTag, the half pixel. */
function hangs(nx, ny) {
  const a = { x: 0, y: 0, side: 0 };
  tagAnchor(nx, ny, 0.99, 0, 800, 450, a);
  const at = { x: 0, y: 0 };
  clampTag(a.x, a.y, { w: 100, h: 20, ovl: a.side < 0 ? 15 : 0, ovr: a.side > 0 ? 15 : 0 }, SAFE6, at);
  return { x: Math.round(at.x * 2) / 2, y: Math.round(at.y * 2) / 2 };
}

/** Within the half pixel the layer rounds to (placeAt's round trip through the camera is not exact). */
const near = (a, b) => Math.abs(a - b) <= 0.5;

test('crowded edges: tags pinned to one edge never cover each other (the pile-up read at 800 x 450: two blues at y 178 and 180, three reds at 196 to 201), moved along it and kept inside the inset', () => {
  const s = scene6();
  // Two teammates off the left at nearly one bearing, three rivals off the right; nearest of each: cars 1 and 3.
  const left = [
    [1, -1.6, 0.06, 0.99],
    [2, -1.7, 0.07, 0.994],
  ];
  const right = [
    [3, 1.5, -0.2, 0.99],
    [4, 1.6, -0.23, 0.993],
    [5, 1.55, -0.21, 0.996],
  ];
  for (const [i, nx, ny, nz] of [...left, ...right]) placeAt(s, i, nx, ny, nz);
  s.frame();
  const l = left.map(([i]) => drawn(s.root, i));
  const r = right.map(([i]) => drawn(s.root, i));
  for (const p of l) assert.equal(p.x, 12 + 15, `tag ${p.i}: still against the left edge`);
  for (const p of r) assert.equal(p.x, 800 - 12 - 100 - 15, `tag ${p.i}: still against the right edge`);
  assertClear([...l, ...r]);
  // The nearest stays where its car's bearing puts it; the others make a column round it, one tag and the gap apart.
  assert.ok(near(l[0].y, hangs(-1.6, 0.06).y), String(l[0].y));
  assert.ok(near(r[0].y, hangs(1.5, -0.2).y), String(r[0].y));
  const step = 20 + TAG_GAP;
  const ys = (ps) => ps.map((p) => p.y).sort((a, b) => a - b);
  assert.deepEqual(ys(r), [r[0].y - step, r[0].y, r[0].y + step], 'the rivals: one went up, one down (each the nearer way)');
  assert.equal(Math.abs(l[1].y - l[0].y), step);
  // In a corner the column has one way to go and stays inside: rivals below the picture (the bottom right) go up, teammates above it (the top left) down.
  for (const [i, nx, ny, nz] of [
    [3, 1.2, -3, 0.99],
    [4, 1.3, -3.2, 0.993],
    [5, 1.25, -3.1, 0.996],
    [1, -1.2, 3, 0.99],
    [2, -1.3, 3.1, 0.994],
  ]) {
    placeAt(s, i, nx, ny, nz);
  }
  s.frame();
  assertClear([1, 2, 3, 4, 5].map((i) => drawn(s.root, i)));
  assert.deepEqual(ys([3, 4, 5].map((i) => drawn(s.root, i))), [438 - 20 - 2 * step, 438 - 20 - step, 438 - 20]);
  assert.deepEqual(ys([1, 2].map((i) => drawn(s.root, i))), [12, 12 + step]);
});

test('a crowd far away (cars bunched at the far goal): no tag covers another, the nearest car\'s stays over it, each farther one lifted over the nearer ones (down only with no room up)', () => {
  const s = scene6();
  // Four cars within a car's width of each other on screen at four distances: 3 the nearest, then 4, 2 and 5; car 1 well apart.
  const crowd = [
    [3, 0.02, 0.3, 0.993],
    [4, 0.05, 0.31, 0.995],
    [2, 0, 0.32, 0.996],
    [5, -0.03, 0.29, 0.997],
  ];
  for (const [i, nx, ny, nz] of crowd) placeAt(s, i, nx, ny, nz);
  placeAt(s, 1, -0.6, -0.3, 0.98);
  s.frame();
  const ps = crowd.map(([i]) => drawn(s.root, i));
  assertClear([...ps, drawn(s.root, 1)]);
  const own = hangs(0.02, 0.3);
  assert.ok(near(ps[0].x, own.x) && near(ps[0].y, own.y), `the nearest stays over its car: ${JSON.stringify(ps[0])}`);
  for (let j = 1; j < ps.length; j++) {
    const [i, nx, ny] = crowd[j];
    assert.ok(near(ps[j].x, hangs(nx, ny).x), `tag ${i}: straight up, never sideways`);
    assert.ok(ps[j].y < hangs(nx, ny).y, `tag ${i}: lifted`);
    assert.ok(ps[j].bottom + TAG_GAP <= ps[j - 1].top, `tag ${i}: over the nearer car's tag, never down over the nearer car`);
  }
  const apart = drawn(s.root, 1);
  assert.ok(near(apart.y, hangs(-0.6, -0.3).y) && near(apart.x, hangs(-0.6, -0.3).x), 'the car apart: where it hangs');
  // The same bunch against the top of the picture: no room up, so the column goes down from the nearest, inside the inset.
  for (const [i, nx, ny, nz] of crowd) placeAt(s, i, nx, ny + 0.62, nz);
  s.frame();
  const top = crowd.map(([i]) => drawn(s.root, i));
  assertClear(top);
  assert.equal(top[0].y, 12, 'the nearest against the safe top');
  for (let j = 1; j < top.length; j++) assert.ok(top[j].top >= top[j - 1].bottom + TAG_GAP, `tag ${top[j].i}: under the nearer ones`);
});

test('the order holds from frame to frame: two cars side by side trading which is a little nearer keep their tags\' places (and write nothing), one clearly nearer takes its own', () => {
  // The model: one passes the one before it only when nearer by more than TAG_ORDER_HYSTERESIS.
  const a = { dist: 3000 };
  const b = { dist: 3100 };
  const order = [a, b];
  for (const [da, db] of [
    [3000, 3100],
    [3100, 3000],
    [3200, 3000],
    [3000, 3000 - TAG_ORDER_HYSTERESIS],
  ]) {
    a.dist = da;
    b.dist = db;
    orderTags(order, 2);
    assert.ok(order[0] === a && order[1] === b, `${da} / ${db}: the order it had`);
  }
  b.dist = 3000 - TAG_ORDER_HYSTERESIS - 1;
  orderTags(order, 2);
  assert.ok(order[0] === b && order[1] === a, 'clearly nearer: it passes');
  // A car with no tag (Infinity) never holds one back.
  const none = { dist: Infinity };
  const far = { dist: 9000 };
  const two = [none, far];
  orderTags(two, 2);
  assert.ok(two[0] === far);

  // The layer: cars 3 and 4 one over the other on screen, 60 to 180 uu apart in depth, trading which is nearer;
  // at the right edge, car 2's bearing a little above nearer car 5's, then a little below, and back.
  const s = scene6();
  const nzAt = (d) => new THREE.Vector3(0, 0, -d).applyMatrix4(s.camera.projectionMatrix).z;
  placeAt(s, 1, -0.6, -0.3, 0.98);
  placeAt(s, 5, 1.5, 0, 0.99);
  let first = null;
  for (const [d3, d4, ny2] of [
    [3500, 3560, 0.02],
    [3560, 3500, -0.02],
    [3480, 3540, 0.02],
    [3600, 3420, -0.02],
  ]) {
    placeAt(s, 3, 0.1, 0, nzAt(d3));
    placeAt(s, 4, 0.12, 0.01, nzAt(d4));
    placeAt(s, 2, 1.5, ny2, 0.996);
    io.writes = 0;
    s.frame();
    const now = [2, 3, 4, 5].map((i) => drawn(s.root, i));
    assertClear(now);
    if (first === null) {
      first = now;
      continue;
    }
    assert.deepEqual(now, first, `${d3} / ${d4}: the same places`);
    assert.equal(io.writes, 0, `${d3} / ${d4}: nothing written`);
  }
  assert.ok(first[2].y < first[1].y, 'car 4 (the farther at first) over car 3');
  assert.ok(first[0].y < first[3].y, 'car 2 over car 5 at the edge, where its bearing put it first');
  // Car 4 clearly nearer: its tag over its car, car 3's lifted over it.
  placeAt(s, 4, 0.12, 0.01, nzAt(3500 - TAG_ORDER_HYSTERESIS - 200));
  s.frame();
  assert.ok(near(drawn(s.root, 4).y, hangs(0.12, 0.01).y), String(drawn(s.root, 4).y));
  assert.ok(drawn(s.root, 3).bottom + TAG_GAP <= drawn(s.root, 4).top);
});

/** Tags for the pass, nearer car first, as [left, top, side]: 100 x 20 (an edge tag's arrow 15 px past its side), their ids in that order, never moved before. */
const places = (...ps) => ps.map(([left, top, side = 0], id) => ({ id, left, top, box: { w: 100, h: 20, ovl: side < 0 ? 15 : 0, ovr: side > 0 ? 15 : 0 }, side, stack: 0, held: 0 }));

test('the pass moves only a tag that crowds another: tags apart stay where they hang, right at TAG_GAP too; a pixel nearer, the later one moves', () => {
  const apart = places(
    [100, 200],
    [100 + 100 + TAG_GAP, 200], // side by side, the gap between
    [100, 200 - 20 - TAG_GAP], // right over the first
    [400, 300],
    [673, 200, 1], // an edge's column, the gap between
    [673, 200 + 20 + TAG_GAP, 1],
    [27, 100, -1],
  );
  const tops = apart.map((p) => p.top);
  declutterTags(apart, apart.length, SAFE6);
  assert.deepEqual(apart.map((p) => p.top), tops);
  for (const p of apart) assert.deepEqual([p.stack, p.held], [0, 0]);
  // A pixel nearer than the gap: the later one moves, the first never (on screen up; along an edge the nearer way).
  const pair = places([100, 200], [150, 200 - 20 - TAG_GAP + 1]);
  declutterTags(pair, 2, SAFE6);
  assert.deepEqual(pair.map((p) => [p.top, p.stack, p.held]), [[200, 0, 0], [200 - 20 - TAG_GAP, -1, 0b1]]);
  const edge = places([673, 200, 1], [673, 219, 1]);
  declutterTags(edge, 2, SAFE6);
  assert.deepEqual(edge.map((p) => [p.top, p.stack, p.held]), [[200, 0, 0], [200 + 20 + TAG_GAP, 1, 0b1]]);

  // The layer: three tags apart and an edge tag exactly where they hang; of the pair that overlaps, only the farther one moves.
  const s = scene6();
  const alone = [
    [1, -0.5, -0.4, 0.98],
    [2, 0.5, -0.4, 0.985],
    [5, -1.5, 0.5, 0.99],
    [3, -0.2, 0.3, 0.99],
  ];
  for (const [i, nx, ny, nz] of alone) placeAt(s, i, nx, ny, nz);
  placeAt(s, 4, -0.17, 0.31, 0.995);
  s.frame();
  for (const [i, nx, ny] of alone) {
    const p = drawn(s.root, i);
    const want = hangs(nx, ny);
    assert.ok(near(p.x, want.x) && near(p.y, want.y), `tag ${i}: ${JSON.stringify(p)} / ${JSON.stringify(want)}`);
  }
  assert.ok(drawn(s.root, 4).bottom + TAG_GAP <= drawn(s.root, 3).top, 'the farther of the pair lifted over the nearer');
});

/** The NDC of the point (x, y) px of the 800 x 450 layer. */
const ndcAt = (x, y) => [x / 400 - 1, 1 - y / 225];

/**
 * scene6 with car 4's tag point at (403, 157.5) px, so its tag hangs from x 353, top 137.5, beside nearer car 3's,
 * which `swerve(x)` puts at x (its tag from x - 50) before drawing a frame; cars 1, 2 and 5 well apart.
 */
function sideBySide() {
  const s = scene6();
  placeAt(s, 1, -0.6, -0.3, 0.98);
  placeAt(s, 2, 0.6, -0.5, 0.98);
  placeAt(s, 5, -0.6, 0.6, 0.99);
  placeAt(s, 4, ...ndcAt(403, 157.5), 0.995);
  return {
    ...s,
    swerve(x) {
      placeAt(s, 3, ...ndcAt(x, 157.5), 0.99);
      s.frame();
    },
  };
}

test('cars side by side: a tag lifted off another stays lifted while the gap across wobbles round TAG_GAP, and drops back only TAG_STACK_HOLD clear (the layer writes nothing for it)', () => {
  // The model: the farther tag a pixel inside the gap across, then a pixel outside it, frame after frame.
  const lifted = 200 - 20 - TAG_GAP;
  const pair = places([100, 200], [0, 200]);
  const frame = (gap) => {
    pair[1].left = 100 + 100 + gap;
    pair[1].top = 200; // where it hangs, every frame
    declutterTags(pair, 2, SAFE6);
    return pair[1].top;
  };
  assert.equal(frame(TAG_GAP - 1), lifted);
  for (let f = 0; f < 20; f++) assert.equal(frame(TAG_GAP + (f % 2 ? -1 : 1)), lifted, `frame ${f}`);
  assert.ok(TAG_STACK_HOLD >= 4 && TAG_STACK_HOLD <= 12, String(TAG_STACK_HOLD));
  assert.equal(frame(TAG_GAP + TAG_STACK_HOLD - 1), lifted, 'inside the hold: still lifted');
  assert.equal(frame(TAG_GAP + TAG_STACK_HOLD), 200, 'clearly apart: back where it hangs');
  assert.equal(frame(TAG_GAP + 1), 200, 'held no more: lifted again only inside TAG_GAP');
  assert.equal(frame(TAG_GAP - 1), lifted);

  // The layer: car 4's tag lifted over nearer car 3's, car 3 swerving 2 px either way across that line: car 3's tag alone is written.
  const s = sideBySide();
  s.swerve(302); // car 3's tag to x 352: TAG_GAP - 1 from car 4's
  const up = drawn(s.root, 4);
  assert.deepEqual([up.x, up.y], [353, 137.5 - 20 - TAG_GAP], 'lifted');
  for (let f = 0; f < 10; f++) {
    io.writes = 0;
    s.swerve(f % 2 ? 302 : 300);
    assert.deepEqual(drawn(s.root, 4), up, `frame ${f}: car 4's tag where it was`);
    assert.equal(io.writes, 1, `frame ${f}: car 3's transform, nothing else`);
  }
  s.swerve(300 - TAG_STACK_HOLD);
  assert.equal(drawn(s.root, 4).y, 137.5, 'clearly apart: back over its car');
});

test('a tag lifted from just under the nearer one stays over it while it wobbles round the gap below, and drops back only TAG_STACK_HOLD under it; held off that tag alone', () => {
  const lifted = 200 - 20 - TAG_GAP;
  const under = 200 + 20 + TAG_GAP; // the top of a tag right under the nearer one, the gap between
  const pair = places([300, 200], [320, under]);
  const frame = (top) => {
    pair[1].top = top;
    declutterTags(pair, 2, SAFE6);
    return pair[1].top;
  };
  assert.equal(frame(under), under, 'right at the gap under it: where it hangs');
  assert.equal(frame(under - 0.5), lifted, 'half a pixel nearer: over it');
  for (let f = 0; f < 20; f++) assert.equal(frame(under + (f % 2 ? -0.5 : 0.5)), lifted, `frame ${f}`);
  assert.equal(frame(under + TAG_STACK_HOLD - 0.5), lifted, 'inside the hold: still over it');
  assert.equal(frame(under + TAG_STACK_HOLD), under + TAG_STACK_HOLD, 'clearly under: back where it hangs');
  assert.equal(frame(under + 0.5), under + 0.5, 'held no more: lifted again only inside TAG_GAP');
  // Held off the tag it was moved off alone: lifted over the first beside a third TAG_GAP + 4 px across, it stays right over the first.
  const three = places([300, 200], [420 + TAG_GAP + 4, 170], [320, 200]);
  for (let f = 0; f < 3; f++) {
    three[2].top = 200;
    declutterTags(three, 3, SAFE6);
    assert.deepEqual([three[2].top, three[2].stack, three[2].held], [lifted, -1, 0b1], `frame ${f}`);
  }
});

test('at the safe top: a tag the top sent under the nearer one stays there while that one wobbles, and goes back only with room (on screen its own height; on an edge, TAG_STACK_HOLD clear)', () => {
  // On screen: the nearer tag's top round safe.top + 20 + TAG_GAP; half a pixel higher, no room over it for the farther one.
  const t0 = SAFE6.top + 20 + TAG_GAP;
  const pair = places([300, t0], [320, 40]);
  const frame = (top) => {
    pair[0].top = top;
    pair[1].top = 40; // where the farther one hangs, in the nearer one's way
    declutterTags(pair, 2, SAFE6);
    return [pair[1].top, pair[1].stack];
  };
  assert.deepEqual(frame(t0), [SAFE6.top, -1], 'room up, just: over it');
  assert.deepEqual(frame(t0 - 0.5), [t0 - 0.5 + 20 + TAG_GAP, 1], 'none: under it');
  for (let f = 0; f < 20; f++) {
    const top = t0 - (f % 2 ? 0.5 : 0);
    assert.deepEqual(frame(top), [top + 20 + TAG_GAP, 1], `frame ${f}: still under it`);
  }
  assert.deepEqual(frame(t0 + 19.5), [t0 + 19.5 + 20 + TAG_GAP, 1], 'under its height of room up: still under');
  assert.deepEqual(frame(t0 + 20), [SAFE6.top + 20, -1], 'its height of room: back over it');
  // On an edge: the farther tag hangs at the safe top (its car above the picture), the nearer one's right under it.
  const col = places([27, t0, -1], [27, SAFE6.top, -1]);
  const edge = (top) => {
    col[0].top = top;
    col[1].top = SAFE6.top;
    declutterTags(col, 2, SAFE6);
    return [col[1].top, col[1].stack];
  };
  assert.deepEqual(edge(t0), [SAFE6.top, 0], 'right at the gap: where it hangs');
  assert.deepEqual(edge(t0 - 0.5), [t0 - 0.5 + 20 + TAG_GAP, 1], 'too near, no room up: under it');
  for (let f = 0; f < 20; f++) {
    const top = t0 - (f % 2 ? 0.5 : 0);
    assert.deepEqual(edge(top), [top + 20 + TAG_GAP, 1], `frame ${f}: still under it`);
  }
  assert.deepEqual(edge(t0 + TAG_STACK_HOLD - 0.5), [t0 + TAG_STACK_HOLD - 0.5 + 20 + TAG_GAP, 1], 'inside the hold: still under it');
  assert.deepEqual(edge(t0 + TAG_STACK_HOLD), [SAFE6.top, 0], 'clearly apart: back where it hangs');
});

test('over the ball: the fade goes by where the pass put a tag, not where it hung', () => {
  const s = sideBySide();
  /** The ball's centre at (x, y) px about 5700 uu away, and its radius on screen (as the layer works it out). */
  const ballAt = (x, y) => {
    s.ball.copy(new THREE.Vector3(...ndcAt(x, y), 0.997).unproject(s.camera));
    const depth = -s.ball.clone().applyMatrix4(s.camera.matrixWorldInverse).z;
    return ((BALL.radius * s.camera.projectionMatrix.elements[5]) / depth) * 450 * 0.5;
  };
  // Car 4's tag lifted from 353, 137.5 to 353, 115.5 (100 x 20); car 3's from 252, 137.5.
  const r = ballAt(430, 120);
  assert.ok(overBall(353, 115.5, 100, 20, 430, 120, r) && !overBall(353, 137.5, 100, 20, 430, 120, r) && !overBall(252, 137.5, 100, 20, 430, 120, r), String(r));
  s.swerve(302);
  assert.equal(drawn(s.root, 4).y, 115.5);
  assert.equal(tagOf(s.root, 4).el.style.opacity, String(TAG_OVER_BALL_OPACITY), 'the ball under where it was lifted to: faded');
  assert.equal(tagOf(s.root, 3).el.style.opacity, '1');
  // The ball where it hung, clear of where it went: not faded (its step's, the middle one, about 3600 uu away).
  const r2 = ballAt(430, 152);
  assert.ok(!overBall(353, 115.5, 100, 20, 430, 152, r2) && overBall(353, 137.5, 100, 20, 430, 152, r2) && !overBall(252, 137.5, 100, 20, 430, 152, r2), String(r2));
  s.frame();
  assert.equal(drawn(s.root, 4).y, 115.5);
  assert.equal(tagOf(s.root, 4).el.style.opacity, String(TAG_OPACITY[1]));
  assert.equal(tagOf(s.root, 3).el.style.opacity, '1');
});

// ---- the sheet and the wiring (what only a browser runs) ----------------------------------------

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the rule for `selector` alone, else of the first selector list that holds it (nametags.css). */
function rule(css, selector) {
  const all = [...stripComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ list: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
  const hit = all.find((r) => r.list.length === 1 && r.list[0] === selector) ?? all.find((r) => r.list.includes(selector));
  assert.ok(hit, `no rule for ${selector}`);
  return hit.body;
}

test('the sheet: each team\'s post on its goal\'s side and the meter filled from it, on its own layer; super low\'s hard outline; the layer\'s box and its safe rect', () => {
  const css = read('src/ui/styles/nametags.css');
  // Blue's post on the left; red's on the right.
  assert.match(rule(css, '.tg-neon-post'), /(?:^|;)\s*left:\s*0\.5em/);
  assert.doesNotMatch(rule(css, '.tg-neon-post'), /(?:^|;)\s*right:/);
  const redPost = rule(css, '.tg-neon--red .tg-neon-post');
  assert.match(redPost, /left:\s*auto/);
  assert.match(redPost, /right:\s*0\.5em/);
  // The meter: only on .tg-neon--meter, filled from the post's side, rescaled on the compositor.
  assert.match(rule(css, '.tg-neon-boost'), /display:\s*none/);
  assert.match(rule(css, '.tg-neon--meter .tg-neon-boost'), /display:\s*block/);
  const fill = rule(css, '.tg-neon-boost-fill');
  assert.match(fill, /transform-origin:\s*0 50%/);
  assert.match(fill, /will-change:\s*transform/);
  assert.match(rule(css, '.tg-neon--red .tg-neon-boost-fill'), /transform-origin:\s*100% 50%/);
  // Super low (style.css drops every shadow): the name and the arrow keep the hard outline, white.
  const lite = rule(css, 'html.tg-superlow .tg-neon .tg-neon-name');
  assert.match(lite, /text-shadow:\s*var\(--tg-ol\) !important/);
  assert.match(lite, /color:\s*var\(--text\)/);
  assert.match(rule(css, 'html.tg-superlow .tg-neon .tg-neon-arrow'), /text-shadow:\s*var\(--tg-ol\) !important/);
  assert.match(rule(css, 'html.tg-superlow .tg-neon-line'), /outline:\s*1px solid var\(--ink\)/);
  // The layer covers the picture and never takes a click; its safe rect clears a page's own bars.
  const layer = rule(css, '.tg-tags');
  for (const d of [/position:\s*absolute/, /inset:\s*0/, /overflow:\s*hidden/, /pointer-events:\s*none/]) assert.match(layer, d);
  const safe = rule(css, '.tg-tags-safe');
  assert.match(safe, /top:\s*calc\(max\(var\(--safe-top\), var\(--tags-inset-top, 0px\)\) \+ var\(--sp-3\)\)/);
  assert.match(safe, /bottom:\s*calc\(max\(var\(--safe-bottom\), var\(--tags-inset-bottom, 0px\)\) \+ var\(--sp-3\)\)/);
});

test('the sheet draws the approved mockup\'s glows (Opción 4, "Neón de arena"): each rule its own value', () => {
  const css = read('src/ui/styles/nametags.css');
  const tokens = stripComments(read('src/ui/styles/tokens.css'));
  const token = (n) => {
    const m = new RegExp(`--${n}:\\s*([^;]+);`).exec(tokens);
    assert.ok(m, n);
    return m[1].trim();
  };
  const want = {
    'tag-blue-neon': 'rgba(58, 155, 255, 0.9)',
    'tag-blue-haze': 'rgba(58, 155, 255, 0.5)',
    'tag-blue-haze-mid': 'rgba(58, 155, 255, 0.4)',
    'tag-blue-far': 'rgba(58, 155, 255, 0.85)',
    'tag-blue-dim': 'rgba(58, 155, 255, 0.7)',
    'tag-blue-glow-wide': 'rgba(58, 155, 255, 0.6)',
    'tag-blue-arrow': 'rgba(58, 155, 255, 0.95)',
    blue: '#3a9bff',
    'tag-red-neon': 'rgba(255, 46, 78, 0.9)',
    'tag-red-haze': 'rgba(212, 32, 57, 0.55)',
    'tag-red-haze-mid': 'rgba(212, 32, 57, 0.45)',
    'tag-red-far': 'rgba(255, 46, 78, 0.85)',
    'tag-red-dim': 'rgba(255, 46, 78, 0.7)',
    'tag-red-glow': '#ff2e4e',
    'tag-red-glow-wide': 'rgba(212, 32, 57, 0.65)',
    'tag-red-arrow': 'rgba(255, 46, 78, 0.95)',
    'tag-rim': 'rgba(5, 7, 13, 0.6)',
    'tag-rim-bot': 'rgba(5, 7, 13, 0.7)',
    'r-tag-bot': '0.12em',
  };
  for (const [n, v] of Object.entries(want)) assert.equal(token(n), v, n);
  assert.match(rule(css, '.tg-neon--blue'), /--tg-glow:\s*var\(--blue\)/);
  assert.match(rule(css, '.tg-neon--red'), /--tg-glow:\s*var\(--tag-red-glow\)/);
  assert.match(rule(css, '.tg-neon-name'), /text-shadow:\s*var\(--tg-ol\), 0 0 6px var\(--tg-neon\), 0 0 14px var\(--tg-haze\)/);
  assert.match(css, /\.tg-neon-line,\s*\.tg-neon-post \{[^}]*box-shadow:\s*0 0 0 1px var\(--tag-rim\), 0 0 4px var\(--tg-glow\), 0 0 10px var\(--tg-glow-wide\)/);
  assert.match(rule(css, '.tg-neon--mid .tg-neon-name'), /0 0 5px var\(--tg-neon\), 0 0 10px var\(--tg-haze-mid\)/);
  assert.match(rule(css, '.tg-neon--far .tg-neon-name'), /text-shadow:\s*var\(--tg-ol\), 0 0 4px var\(--tg-far\);?\s*$/);
  assert.match(rule(css, '.tg-neon--isbot .tg-neon-name'), /0 0 5px var\(--tg-dim\)/);
  const bot = rule(css, '.tg-neon-bot');
  assert.match(bot, /border-radius:\s*var\(--r-tag-bot\)/);
  assert.match(bot, /box-shadow:\s*0 0 0 1px var\(--tag-rim-bot\), 0 0 5px var\(--tg-far\)/);
  assert.match(rule(css, '.tg-neon-arrow'), /text-shadow:\s*var\(--tg-ol\), 0 0 6px var\(--tg-arrow\)/);
});

test('the wiring: the Game tags every car but the player\'s own, teammates by its team, none in the menus, the showroom or training', () => {
  const game = read('src/game/Game.ts');
  assert.match(game, /opts\.hudContainer\.prepend\(tagsRoot\);\s*this\.nameTags = new NameTags\(tagsRoot, \(\) => settings\.hud\);/, 'first in the HUD\'s container: under every plate; the player\'s choice (Settings > HUD) read live');
  assert.match(
    game,
    /const tagsOn = !inMenu && this\.showroom === null && this\.training === null && this\.settings\.hud\.names !== 'none';\s*tags\.setVisible\(tagsOn\);\s*if \(tagsOn\) tags\.update\(camera, this\.sbRows, cars, offs, cur, this\.ball\.position, this\.playerIndex, this\.sbRows\[this\.playerIndex\]\?\.team \?\? 0\);/,
    'names on NINGUNO: the layer is off, nothing projected',
  );
  assert.equal(game.match(/\.nameTags\b/g).length, 2, 'built once, driven from render only');
  // After the frame is drawn, on its camera.
  assert.ok(game.indexOf('tags.update(camera, this.sbRows') > game.lastIndexOf('renderer.render(frameTime);'));
});

test('the wiring: the replay tags every car but the followed one, every meter shown, names as the page shows them, under the HUD and clear of its bars', () => {
  const player = read('src/replay/player.ts');
  assert.match(player, /new NameTags\([^,()]+\)/, 'no view: Settings > HUD never reaches the replay viewer');
  assert.match(player, /tags\.update\(renderer\.camera, tagRows, cars, offsets, cur, ball\.position, camIndex >= CAM_CAR0 \? camIndex - CAM_CAR0 : -1, null\);/);
  assert.match(player, /const tagRows = roster\.map\(\(e, i\) => \(\{ name: shownName\[i\], team: e\.team, you: false, bot: e\.kind === 'bot' \}\)\);/);
  assert.match(player, /for \(let i = 0; i < tagRows\.length; i\+\+\) tagRows\[i\]\.bot = !run\.host\.isHumanSlot\(slots\[i\]\);/);
  assert.match(player, /renderer\.render\(performance\.now\(\)\);\s*placeTags\(\);/, 'after the frame is drawn');
  assert.match(player, /o\.tagsRoot\.style\.setProperty\('--tags-inset-top', `\$\{exitBtn\.offsetTop \+ exitBtn\.offsetHeight\}px`\)/);
  assert.match(player, /o\.tagsRoot\.style\.setProperty\('--tags-inset-bottom', `\$\{o\.bar\.offsetHeight\}px`\)/);
  assert.match(player, /insets\.observe\(exitBtn\);\s*insets\.observe\(o\.bar\);/);
  const html = read('replay.html');
  const at = (s) => {
    const i = html.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at('<canvas id="game-canvas"></canvas>') < at('<div id="tags"></div>'));
  assert.ok(at('<div id="tags"></div>') < at('<div id="hud"></div>'), 'under the HUD: the scorebug and the goal banners draw over an edge tag');
  assert.doesNotMatch(html, /rp-tag/, 'the old pills are gone');
});
