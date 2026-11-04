// MODOS' decisions (src/ui/screens/modesModel.ts, plan PR 6; the modes redesign, November 2026): the
// tabs' order and stepping, formats <-> playlists (Casual's one preferred format, no connection any
// more), the 5:00 countdown to Casual's online bots match from the search's answer, the counts'
// threshold and the action zone per tab (Casual signs a guest in).
// Run: node --test tests/modes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../src/ui/screens/modesModel.ts');

test('the tabs: CASUAL, COMPETITIVE, LOBBIES, VS AI; Q / E and LB / RB step them round', () => {
  assert.deepEqual(M.MODE_TABS, ['casual', 'ranked', 'lobbies', 'ai']);
  assert.equal(M.stepTab('casual', 1), 'ranked');
  assert.equal(M.stepTab('ai', 1), 'casual', 'round');
  assert.equal(M.stepTab('casual', -1), 'ai', 'round');
  assert.ok(M.isModeTab('lobbies'));
  assert.ok(!M.isModeTab('friendly'), "today's screen ids are no tabs");
});

test('formats: one playlist is itself, any is the three; an older pick of two reads as any', () => {
  assert.deepEqual(M.FORMATS, ['1v1', '2v2', '3v3', 'any']);
  assert.equal(M.formatOf(['2v2']), '2v2');
  assert.equal(M.formatOf(['1v1', '2v2', '3v3']), 'any');
  assert.equal(M.formatOf(['1v1', '3v3']), 'any');
  assert.deepEqual(M.modesOf('3v3'), ['3v3']);
  assert.deepEqual(M.modesOf('any'), ['1v1', '2v2', '3v3']);
  const a = M.modesOf('any');
  a.pop();
  assert.equal(M.modesOf('any').length, 3, 'a fresh list each time');
});

test('no connection to pick any more (Casual and Competitive always on a server); Casual picks one format, no ANY', () => {
  assert.equal('NET_PICKS' in M, false);
  assert.equal('queueNet' in M, false);
  assert.deepEqual(M.PREFER_FORMATS, ['1v1', '2v2', '3v3']);
  assert.deepEqual(M.formatsOf('casual'), ['1v1', '2v2', '3v3'], "Casual's grid: the format if you play bots");
  assert.deepEqual(M.formatsOf('ranked'), ['1v1', '2v2', '3v3', 'any'], 'Competitive keeps ANY');
});

const WAIT = { searching: 1, searchingHere: 1, waitedMs: 0, widened: false, widenInMs: 60_000, estimateMs: 300_000, estimateKind: 'bots', botsInMs: 300_000, busy: false };

test("the 5:00 box: Casual's online bots match, from the answer's botsInMs counted down locally, else from the start; never Competitive, nor busy", () => {
  const base = { kind: 'casual', since: 1000, now: 1000, wait: null, waitAt: 0 };
  assert.deepEqual(M.botsCountdown(base), { left: 300_000, total: 300_000 }, 'no answer yet: 5:00 from the start');
  assert.deepEqual(M.botsCountdown({ ...base, now: 61_000 }), { left: 240_000, total: 300_000 });
  assert.deepEqual(M.botsCountdown({ ...base, now: 61_000, soloAfterMs: 120_000 }), { left: 60_000, total: 120_000 }, "the config's soloAfterMs");
  // The answer's botsInMs, counted down from its arrival (kept across a drop of the search: the server's clock).
  const w = { ...WAIT, botsInMs: 217_000 };
  assert.deepEqual(M.botsCountdown({ ...base, wait: w, waitAt: 5000, now: 5000 }), { left: 217_000, total: 300_000 });
  assert.deepEqual(M.botsCountdown({ ...base, wait: w, waitAt: 5000, now: 15_000 }), { left: 207_000, total: 300_000 });
  assert.equal(M.botsCountdown({ ...base, wait: { ...w, botsInMs: 0 }, waitAt: 5000, now: 5000 }), null, 'due: the box goes, no 0:00');
  assert.equal(M.botsCountdown({ ...base, wait: { ...w, busy: true }, waitAt: 5000, now: 5000 }), null, 'the servers full: no promise');
  assert.equal(M.botsCountdown({ ...base, kind: 'ranked' }), null, 'Competitive has no bots');
  assert.equal(M.botsCountdown({ ...base, now: 302_000 }), null, 'run out without an answer');
  assert.deepEqual(M.botsCountdown({ ...base, now: 500 }), { left: 300_000, total: 300_000 }, 'a clock before the start counts 0');
});

test('the bar: segments for the time left, rounded up, within 0..n', () => {
  assert.equal(M.botsSegments(10_000, 10_000, 18), 18);
  assert.equal(M.botsSegments(1, 10_000, 18), 1);
  assert.equal(M.botsSegments(0, 10_000, 18), 0);
  assert.equal(M.botsSegments(12_000, 15_000, 18), 15);
  assert.equal(M.botsSegments(5, 0, 18), 0);
});

test('counts under the threshold are not shown', () => {
  assert.ok(!M.countShown(0, 5));
  assert.ok(!M.countShown(4, 5));
  assert.ok(M.countShown(5, 5));
  assert.ok(!M.countShown(null, 5));
});

test('the action zone per tab: search, the searching panel on its own tab, sign in (Casual too, for a guest), banned, play, lobbies', () => {
  const g = { tab: 'casual', signedIn: false, banLeft: 0, searching: null };
  assert.equal(M.actionKind(g), 'signIn', "a guest's Casual: SIGN IN (Casual needs an account)");
  assert.equal(M.actionKind({ ...g, tab: 'ai' }), 'play', 'a guest plays the AI');
  assert.equal(M.actionKind({ ...g, tab: 'lobbies' }), 'lobbies', "a guest's lobbies");
  const a = { tab: 'casual', signedIn: true, banLeft: 0, searching: null };
  assert.equal(M.actionKind(a), 'search', 'A on Casual searches');
  assert.equal(M.actionKind({ ...a, searching: 'casual' }), 'searching');
  assert.equal(M.actionKind({ ...a, searching: 'ranked' }), 'search', "another kind's search: this tab's own FIND MATCH");
  assert.equal(M.actionKind({ ...a, banLeft: 60_000 }), 'search', 'a ban locks Competitive only');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: false }), 'signIn', 'a guest');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true, banLeft: 60_000 }), 'banned');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true }), 'search');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true, searching: 'ranked' }), 'searching');
  assert.equal(M.actionKind({ ...a, tab: 'ai', searching: 'casual' }), 'play');
  assert.equal(M.actionKind({ ...a, tab: 'lobbies' }), 'lobbies');
});

test("round 2: the panel's '· 1 in {region}' is the answer's region; VS AI's line while searching shows on every layout; the wait's sheet; the HUD strip by the right edge, never over a touch card", async () => {
  const { readFile } = await import('node:fs/promises');
  const src = (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const modes = await src('../src/ui/screens/modes.ts');
  assert.match(modes, /const here = answerRegion\(v\.waitRegion\);\s*if \(wl\.people !== null\) setText\(sPeople, peopleText\(wl\.people, here !== null \? regionName\(here\) : null\)\);/, "the hub's home, never the client's region");
  assert.match(modes, /line\.classList\.toggle\('mn-act-line-wait', s === 'play' && running !== null\);/);
  const wait = await src('../src/ui/styles/screens/wait.css');
  assert.match(wait, /html\[data-shell='rail'\] \.mn-act-line\.mn-act-line-wait:not\(\[hidden\]\),\s*html\[data-shell='tv'\] \.mn-act-line\.mn-act-line-wait:not\(\[hidden\]\) \{\s*display: block;/, 'the rail and a TV hide the other lines (modes.css)');
  // "While you search": its lines in sentence case (not the buttons' capitals), no room for absent actions.
  assert.match(wait, /\.mn-wait-text small \{[^}]*text-transform: none;/);
  assert.match(wait, /\.mn-sheet-wait \.mn-sheet-actions \{\s*display: none;/);
  const sheet = await src('../src/ui/screens/waitSheet.ts');
  assert.match(sheet, /h\('span\.mn-wait-text', null, h\('b', null, t\(c\.title\)\), h\('small', null, t\(c\.sub\)\)\)/);
  assert.match(sheet, /actions: \[\]/, 'Back and STAY IN THE MENU are the way out');
  // The HUD strip: bounded by the right edge (never past it, a notch kept clear).
  const strip = /\.hud-search \{([^}]*)\}/.exec(wait)[1];
  assert.match(strip, /right: calc\(var\(--safe-right\) \+ clamp\(12px, 2\.2vw, 36px\)\);/);
  assert.match(strip, /width: fit-content;/);
  assert.doesNotMatch(strip, /max-width: calc\(100vw/);
  // A first match's touch card up (high in the middle, where the strip runs sideways): the card alone.
  const game = await src('../src/game/Game.ts');
  assert.match(game, /const card = this\.touch !== null && this\.touch\.cardsUp;\s*this\.hud\.setSearch\(this\.menuShown \|\| card \? null : h\.text, h\.warn\);/);
});
