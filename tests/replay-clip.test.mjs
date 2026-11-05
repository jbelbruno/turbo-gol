// Clips and links of the replay viewer (src/replay/clip.ts): the container the browser records, the
// range around a goal, the goal's link and its ?t=, the file name (no player names), the frame box,
// and the Spanish and English lines. The recording itself needs a browser (MediaRecorder).
// Run: node --test tests/replay-clip.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const C = await import('../src/replay/clip.ts');
const { TICK_RATE } = await import('../src/sim/types.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const ID = 'ab12cd34'.repeat(8);

test('the container: MP4 first (what every platform takes), WebM where only that records, null when none', () => {
  assert.equal(C.pickMime(() => true).ext, 'mp4');
  assert.equal(C.pickMime((m) => m.startsWith('video/webm')).ext, 'webm');
  assert.equal(C.pickMime((m) => m === 'video/mp4').mime, 'video/mp4');
  assert.equal(C.pickMime(() => false), null);
});

test('a goal clip keeps a lead and a tail, inside the match and never past the longest clip', () => {
  const end = 60 * TICK_RATE;
  const w = C.clipWindow(30 * TICK_RATE, end);
  assert.equal(w.start, (30 - C.CLIP_LEAD_SECONDS) * TICK_RATE);
  assert.equal(w.end, (30 + C.CLIP_TAIL_SECONDS) * TICK_RATE);
  // a goal in the first seconds starts at 0; one at the very end stops with the match
  assert.equal(C.clipWindow(TICK_RATE, end).start, 0);
  assert.ok(C.clipWindow(end - 10, end).end <= end);
  for (const g of [0, 1, 500, end - 1, end]) {
    const r = C.clipWindow(g, end);
    assert.ok(r.start >= 0 && r.end > r.start && r.end - r.start <= C.CLIP_MAX_SECONDS * TICK_RATE, `goal at ${g}`);
  }
});

test('a clip from here is CLIP_HERE_SECONDS long, or the last ones of the match', () => {
  const end = 100 * TICK_RATE;
  const a = C.clipFrom(20 * TICK_RATE, end);
  assert.equal(a.start, 20 * TICK_RATE);
  assert.equal(a.end - a.start, C.CLIP_HERE_SECONDS * TICK_RATE);
  const b = C.clipFrom(99 * TICK_RATE, end);
  assert.equal(b.end, end);
  assert.equal(b.end - b.start, C.CLIP_HERE_SECONDS * TICK_RATE);
  assert.equal(C.clipFrom(-5, end).start, 0);
});

test('a goal link is this page with the match and the tick, and replaces any other query', () => {
  const url = C.shareUrl('https://turbo-gol.com/replay?id=old&x=1#frag', ID, 1800.4);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://turbo-gol.com/replay');
  assert.equal(u.searchParams.get('id'), ID);
  assert.equal(u.searchParams.get('t'), '1800');
  assert.equal(u.searchParams.get('x'), null);
  assert.equal(u.hash, '');
  assert.equal(new URL(C.shareUrl('https://turbo-gol.com/replay.html', ID, -3)).searchParams.get('t'), '0');
});

test('?t= is a plain whole number of at most 8 digits: anything else is no tick', () => {
  assert.equal(C.parseStartTick('?id=x&t=1800'), 1800);
  assert.equal(C.parseStartTick('?t=0'), 0);
  for (const bad of ['', '?t=', '?t=-1', '?t=1.5', '?t=1e3', '?t=0x10', '?t=abc', '?t=123456789', '?t=%201', '?id=x']) assert.equal(C.parseStartTick(bad), null, bad);
});

test('the file name has the match and the time, never a player name', () => {
  assert.equal(C.clipFileName(ID, 75 * TICK_RATE, 'mp4'), 'turbogol-ab12cd34-1m15s.mp4');
  assert.equal(C.clipFileName(null, 9 * TICK_RATE, 'webm'), 'turbogol-0m09s.webm');
  // an id that is not 64 hex digits is not put in a file name
  assert.equal(C.clipFileName('../../etc/passwd', 0, 'mp4'), 'turbogol-0m00s.mp4');
});

test('the frame box is the largest of the clip shape that fits the window, centred', () => {
  const v = C.fitBox(1280, 720, 720, 1280);
  assert.equal(v.height, 720);
  assert.equal(v.width, 405);
  assert.equal(v.left, Math.floor((1280 - 405) / 2));
  assert.equal(v.top, 0);
  const phone = C.fitBox(390, 844, 720, 1280);
  assert.ok(phone.width <= 390 && phone.height <= 844);
  assert.ok(Math.abs(phone.width / phone.height - 9 / 16) < 0.01);
  const w = C.fitBox(390, 844, 1280, 720);
  assert.equal(w.width, 390);
  assert.ok(w.top > 0);
  for (const f of Object.values(C.CLIP_FORMATS)) assert.ok(f.w <= 1280 && f.h <= 1280 && f.w % 2 === 0 && f.h % 2 === 0, 'even sizes, 720p at most');
});

test('the quality sets the video size, the frame rate and the bit rate: standard 720p, high and max 1080p, even sizes', () => {
  assert.deepEqual(C.clipSize('vertical', 'standard'), { w: 720, h: 1280 });
  assert.deepEqual(C.clipSize('vertical', 'high'), { w: 1080, h: 1920 });
  assert.deepEqual(C.clipSize('wide', 'max'), { w: 1920, h: 1080 });
  assert.deepEqual(C.clipSize('square', 'high'), { w: 1080, h: 1080 });
  for (const f of Object.keys(C.CLIP_FORMATS)) for (const q of Object.keys(C.CLIP_QUALITIES)) {
    const z = C.clipSize(f, q);
    assert.ok(z.w % 2 === 0 && z.h % 2 === 0 && Math.max(z.w, z.h) <= 1920, `${f} ${q}`);
  }
  const { standard, high, max } = C.CLIP_QUALITIES;
  assert.ok(standard.bitrate < high.bitrate && high.bitrate < max.bitrate);
  assert.ok(standard.fps === 30 && high.fps === 30 && max.fps === 60);
});

test('the goal caption: drops in big and settles, pulses, bursts then fades out, never past its bounds', () => {
  const g0 = C.goalAnim(0);
  assert.ok(g0.scale > 2 && g0.alpha === 0, 'starts big and invisible');
  assert.ok(g0.shake === 1 && g0.flash > 0.3 && g0.punch > 1.05, 'the frame shakes, flashes and punches in at the goal');
  const settled = C.goalAnim(0.8);
  assert.ok(Math.abs(settled.scale - 1) < 0.06 && settled.alpha === 1 && settled.shake === 0 && settled.flash === 0, 'settled');
  assert.ok(settled.punch < 1.01);
  assert.ok(C.goalAnim(C.GOAL_CAPTION_SECONDS).alpha < 1e-9, 'gone at its end');
  assert.ok(C.goalAnim(C.GOAL_CAPTION_SECONDS - 0.2).alpha < 1 && C.goalAnim(C.GOAL_CAPTION_SECONDS - 0.2).alpha > 0, 'fading in its last 0.4 s');
  // the bounce: the word dips under its size before it settles
  let min = Infinity;
  for (let a = 0.2; a < 0.6; a += 0.01) min = Math.min(min, C.goalAnim(a).scale);
  assert.ok(min < 0.97, 'overshoots');
  for (let a = -1; a < 4; a += 0.05) {
    const g = C.goalAnim(a);
    for (const [k, v] of Object.entries(g)) assert.ok(Number.isFinite(v), `${k} at ${a}`);
    assert.ok(g.alpha >= 0 && g.alpha <= 1 && g.ringAlpha >= 0 && g.ringAlpha <= 1 && g.flash >= 0 && g.shake >= 0 && g.shake <= 1 && g.ring >= 0 && g.ring <= 1, `bounds at ${a}`);
  }
});

test('every clip line is in English and in Spanish, with the same placeholders', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('replay.clip'));
  assert.ok(keys.length >= 20, `${keys.length} clip lines`);
  const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of keys) {
    assert.equal(typeof es[k], 'string', `es ${k}`);
    assert.equal(slots(es[k]), slots(en[k]), `${k} placeholders`);
  }
  assert.ok(Object.keys(es).filter((k) => k.startsWith('replay.clip')).length === keys.length, 'no Spanish-only line');
});
