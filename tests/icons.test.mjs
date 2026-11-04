// The UI's own icon sprite (src/ui/components/icons.ts): small, well formed, importable in node (no
// DOM at import: the menu screens that node tests load import it).
// Run: node --test tests/icons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ICON_PATHS, ICON_NAMES, spriteMarkup, iconId, SPRITE_ID } = await import('../src/ui/components/icons.ts');

test('about thirty icons, one sprite of at most 6 KB', () => {
  assert.ok(ICON_NAMES.length >= 30, String(ICON_NAMES.length));
  const bytes = Buffer.byteLength(spriteMarkup(), 'utf8');
  assert.ok(bytes <= 6 * 1024, `${bytes} B`);
});

test('every icon is one path on the 24 grid, with a symbol of its own', () => {
  const markup = spriteMarkup();
  assert.ok(markup.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" id="${SPRITE_ID}"`));
  for (const name of ICON_NAMES) {
    const d = ICON_PATHS[name];
    assert.match(d, /^M[-0-9MmLlHhVvCcSsQqAaZz .,]+$/, name);
    // Absolute coordinates stay on the grid (relative ones are deltas).
    for (const n of d.match(/-?\d*\.?\d+/g)) assert.ok(Math.abs(Number(n)) <= 24, `${name}: ${n}`);
    assert.equal(markup.split(`<symbol id="${iconId(name)}" viewBox="0 0 24 24">`).length, 2, name);
  }
  assert.equal(new Set(ICON_NAMES.map(iconId)).size, ICON_NAMES.length);
});

// The top bar's gear: the owner read the old circle of rays as odd (a sun); a cog says Settings.
test('settings is a cog: one closed outline of eight teeth round a hole', () => {
  const d = ICON_PATHS.settings;
  const subpaths = d.split('M').filter(Boolean);
  assert.equal(subpaths.length, 2, d);
  assert.ok(subpaths[0].endsWith('z'), 'the outline closes');
  // Walk the outline (M absolute, then relative l and a): each corner's distance from the centre.
  const tokens = subpaths[0].match(/[a-zA-Z]|-?\d*\.?\d+/g);
  let x = 0;
  let y = 0;
  let cmd = '';
  const radii = [];
  for (let i = 0; i < tokens.length; ) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'z') break;
    const take = cmd === 'a' ? 7 : 2;
    const n = tokens.slice(i, i + take).map(Number);
    i += take;
    if (cmd === '') [x, y] = n;
    else [x, y] = [x + n[take - 2], y + n[take - 1]];
    if (cmd !== '') radii.push(Math.hypot(x - 12, y - 12));
  }
  const tips = radii.filter((r) => r > 9.5);
  const roots = radii.filter((r) => r < 7.6);
  assert.equal(tips.length, 16, 'two corners on the tip of each of eight teeth');
  assert.equal(roots.length, 16, 'and two at its root');
  assert.equal(tips.length + roots.length, radii.length, 'no corner between the two circles');
  assert.ok(Math.max(...radii) + 1 <= 12, 'the 2-unit stroke stays in the box');
  const [x0, y0] = tokens.slice(0, 2).map(Number);
  assert.ok(Math.hypot(x - x0, y - y0) < 1e-9, `the last tooth ends where the first starts (z adds no edge): ${x}, ${y}`);
  assert.equal(subpaths[1], '12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6', 'a whole centre hole of radius 3');
});

test('the sections, the devices and the common actions have an icon', () => {
  for (const n of ['play', 'training', 'garage', 'leaderboard', 'profile', 'settings', 'back', 'close', 'check', 'lock', 'server', 'pad', 'keyboard', 'touch', 'tv', 'lab', 'code', 'share', 'boost']) assert.ok(n in ICON_PATHS, n);
});
