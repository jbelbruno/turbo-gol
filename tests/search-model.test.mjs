// A running search's lines (src/ui/screens/searchModel.ts waitLines; the modes redesign, November
// 2026, spec §3.3): the clock, the estimate (humans / bots / none), the people, the widening before
// and after, the overrides (the servers full, no network), the local countdown from the answer's
// arrival, and the first round trip without an answer (the clock and the 5:00 box from the start and
// GET /api/config's queue times).
//   node --test tests/search-model.test.mjs
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

const S = await import('../src/ui/screens/searchModel.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

/** A waiting answer's `wait` (src/net/queueWait.ts). */
const wait = (o = {}) => ({ searching: 1, searchingHere: 1, waitedMs: 0, widened: false, widenInMs: 60_000, estimateMs: 300_000, estimateKind: 'bots', botsInMs: 300_000, busy: false, ...o });
const view = (o = {}) => ({ kind: 'casual', since: 1000, wait: null, waitAt: 0, retrying: false, times: null, ...o });

test('no answer yet (the first round trip, an older server): the clock and Casual\'s bots time from the start, no people, the widening from the config', () => {
  const l = S.waitLines(view(), 1000 + 23_000);
  assert.equal(l.elapsedMs, 23_000, 'the clock, local');
  assert.deepEqual(l.estimate, { kind: 'bots', ms: 277_000 }, 'Con bots en 4:37 como máximo');
  assert.equal(l.people, null, 'hidden');
  assert.deepEqual(l.reach, { kind: 'widenIn', ms: 37_000 });
  assert.deepEqual(l.bots, { left: 277_000, total: 300_000 }, 'the 5:00 box');
  assert.equal(l.override, null);
  // The config's times; absent: the hub's (300 s, 60 s / 120 s).
  const c = S.waitLines(view({ times: { soloAfterMs: 120_000, widenMs: { casual: 30_000, ranked: 90_000 } } }), 1000 + 20_000);
  assert.deepEqual(c.estimate, { kind: 'bots', ms: 100_000 });
  assert.deepEqual(c.reach, { kind: 'widenIn', ms: 10_000 });
  assert.deepEqual(c.bots, { left: 100_000, total: 120_000 });
  // Ranked without an answer: no estimate, no bots box, its own widening.
  const r = S.waitLines(view({ kind: 'ranked' }), 1000 + 20_000);
  assert.deepEqual(r.estimate, { kind: 'none' }, 'Sin estimación todavía');
  assert.equal(r.bots, null);
  assert.deepEqual(r.reach, { kind: 'widenIn', ms: 100_000 });
  // Past the widening: every region.
  assert.deepEqual(S.waitLines(view(), 1000 + 61_000).reach, { kind: 'widened' });
  assert.deepEqual(S.DEFAULT_QUEUE_TIMES, { soloAfterMs: 300_000, widenMs: { casual: 60_000, ranked: 120_000 } });
});

test("humans expected first: 'Match in ~2 min', counted down locally from the answer's arrival, in the server's steps", () => {
  const w = wait({ estimateKind: 'humans', estimateMs: 120_000, botsInMs: 250_000 });
  const at = 50_000;
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: at }), at).estimate, { kind: 'humans', ms: 120_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: at }), at + 20_000).estimate, { kind: 'humans', ms: 120_000 }, '100 s left rounds up to 2 min');
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: at }), at + 45_000).estimate, { kind: 'humans', ms: 90_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: at }), at + 200_000).estimate, { kind: 'humans', ms: 30_000 }, 'never under 30 s');
  assert.equal(S.roughMs(0), 30_000);
  assert.equal(S.roughMs(31_000), 60_000);
  assert.equal(S.roughMs(301_000), 360_000, '1 min steps above 5 min');
  // Casual's estimate never past its bots match: then the bots come first.
  const late = wait({ estimateKind: 'humans', estimateMs: 200_000, botsInMs: 150_000 });
  assert.deepEqual(S.waitLines(view({ wait: late, waitAt: at }), at).estimate, { kind: 'bots', ms: 150_000 });
  // Ranked: humans or none, never bots.
  const r = wait({ estimateKind: 'humans', estimateMs: 600_000, botsInMs: undefined });
  assert.deepEqual(S.waitLines(view({ kind: 'ranked', wait: r, waitAt: at }), at).estimate, { kind: 'humans', ms: 600_000 });
  assert.deepEqual(S.waitLines(view({ kind: 'ranked', wait: { ...r, estimateKind: 'none', estimateMs: null }, waitAt: at }), at).estimate, { kind: 'none' });
});

test("bots first: 'Bots in 3:37 at most', the 5:00 box from botsInMs counted down locally", () => {
  const w = wait({ botsInMs: 217_000, estimateMs: 217_000 });
  const l = S.waitLines(view({ wait: w, waitAt: 10_000 }), 10_000);
  assert.deepEqual(l.estimate, { kind: 'bots', ms: 217_000 });
  assert.deepEqual(l.bots, { left: 217_000, total: 300_000 });
  const later = S.waitLines(view({ wait: w, waitAt: 10_000 }), 25_000);
  assert.deepEqual(later.estimate, { kind: 'bots', ms: 202_000 });
  assert.deepEqual(later.bots, { left: 202_000, total: 300_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: 10_000 }), 400_000).estimate, { kind: 'bots', ms: 0 }, 'due (a hidden tab waits for its first visible POST)');
});

test('the people: only you, or how many search (exactly: no threshold) and how many of them in your region when they differ', () => {
  const at = 5000;
  assert.deepEqual(S.waitLines(view({ wait: wait({ searching: 1, searchingHere: 1 }), waitAt: at }), at).people, { kind: 'alone' });
  assert.deepEqual(S.waitLines(view({ wait: wait({ searching: 3, searchingHere: 3 }), waitAt: at }), at).people, { kind: 'count', count: 3, here: null });
  assert.deepEqual(S.waitLines(view({ wait: wait({ searching: 3, searchingHere: 1 }), waitAt: at }), at).people, { kind: 'count', count: 3, here: 1 });
  assert.deepEqual(S.waitLines(view({ wait: wait({ searching: 2, searchingHere: 1 }), waitAt: at }), at).people, { kind: 'count', count: 2, here: 1 }, 'two is shown (the owner asked for how many search)');
});

test('the widening: before it, its countdown from the answer; after it, every region', () => {
  const w = wait({ widenInMs: 37_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: 1000 }), 1000).reach, { kind: 'widenIn', ms: 37_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: 1000 }), 21_000).reach, { kind: 'widenIn', ms: 17_000 });
  assert.deepEqual(S.waitLines(view({ wait: w, waitAt: 1000 }), 40_000).reach, { kind: 'widened' }, 'the local count ran out');
  assert.deepEqual(S.waitLines(view({ wait: wait({ widened: true, widenInMs: 0 }), waitAt: 1000 }), 1000).reach, { kind: 'widened' });
});

test('the overrides: the servers full (busy: no 5:00 box either), the client retrying (it wins)', () => {
  const busy = S.waitLines(view({ wait: wait({ busy: true, botsInMs: 0 }), waitAt: 1000 }), 1000);
  assert.equal(busy.override, 'busy');
  assert.equal(busy.bots, null, 'no promise of 5:00 while the servers are full');
  assert.equal(S.waitLines(view({ retrying: true }), 2000).override, 'retrying');
  assert.equal(S.waitLines(view({ retrying: true, wait: wait({ busy: true }), waitAt: 1000 }), 2000).override, 'retrying', 'offline says more than busy');
  assert.equal(S.waitLines(view({ wait: wait(), waitAt: 1000 }), 2000).override, null);
});

test('the texts of the lines exist in both languages, as the owner wrote them (es: neutral tú)', () => {
  const keys = ['search.estimate', 'search.estimateBots', 'search.estimateNone', 'search.searching', 'search.searchingAlone', 'search.searchingHere', 'search.widenIn', 'search.widened', 'search.busy', 'search.retrying', 'search.ended', 'search.hudLine', 'search.hudCancel', 'search.whereCasual'];
  for (const k of keys) {
    assert.ok(en[k] !== undefined, 'en ' + k);
    assert.ok(es[k] !== undefined, 'es ' + k);
  }
  assert.equal(es['search.estimate'], 'Partido en ~{time}');
  assert.equal(es['search.estimateBots'], 'Con bots en {time} como máximo');
  assert.equal(es['search.estimateNone'], 'Sin estimación todavía');
  assert.deepEqual(es['search.searching'], { one: '{count} persona buscando', other: '{count} personas buscando' });
  assert.equal(es['search.searchingAlone'], 'Por ahora solo tú');
  assert.equal(es['search.widenIn'], 'En {time} también buscamos en otras regiones');
  assert.equal(es['search.busy'], 'Los servidores están llenos: sigues en la cola');
  assert.equal(es['search.retrying'], 'Sin conexión: la búsqueda sigue cuando vuelva la red');
  assert.equal(es['search.hudLine'], 'Buscando {kind} · {time}');
  assert.equal(es['search.hudCancel'], 'Pausa: cancelar');
  assert.equal(es['wait.title'], 'Mientras buscas');
  assert.equal(es['wait.menu'], 'QUEDARME EN EL MENÚ');
});

test("the clock from the server once it said so: the answer's waitedMs counted back from its arrival (a restored search), else the local start; the clock and the 5:00 box then agree", () => {
  assert.equal(S.searchStart(1000, null, 0), 1000, 'no answer yet: the local start');
  // A reload 80 s into a search: the hub restored it, its answer came at 50_000.
  const w = wait({ waitedMs: 80_000, botsInMs: 220_000 });
  const since = S.searchStart(49_000, w, 50_000);
  assert.equal(since, -30_000);
  const l = S.waitLines(view({ since, wait: w, waitAt: 50_000 }), 60_000);
  assert.equal(l.elapsedMs, 90_000, '1:30 on the clock');
  assert.equal(l.bots.left, 210_000, '3:30 in the box: the two add up to 5:00');
  assert.equal(l.elapsedMs + l.bots.left, 300_000);
  // A search the hub restarted (an eviction, a long drop): the clock starts again with it.
  assert.equal(S.searchStart(1000, wait({ waitedMs: 0 }), 200_000), 200_000);
});

test("'· 1 in South America' names the answer's region (the hub's normalized home), never the client's guess; an unknown one names none", () => {
  assert.equal(S.answerRegion('EU'), 'EU');
  assert.equal(S.answerRegion('SA'), 'SA');
  assert.equal(S.answerRegion('AN'), null, 'not one of ours: no name rather than a wrong one');
  assert.equal(S.answerRegion(null), null);
  assert.equal(S.answerRegion(undefined), null);
});

test('"While you search": on the first waiting answer, or ~1 s after the first POST left without one; dropped when the search ended or matched, or on MODOS; held under a sheet', () => {
  const s = { queueing: true, onModes: false, answers: 0, postedAt: 0, now: 10_000, menusFree: true };
  assert.equal(S.WAIT_SHEET_AFTER_MS, 1_000);
  assert.equal(S.waitSheetStep(s), 'wait', 'the first POST has not left (the terms, the session)');
  assert.equal(S.waitSheetStep({ ...s, postedAt: 9_500 }), 'wait', 'half a second: its answer may still come');
  assert.equal(S.waitSheetStep({ ...s, postedAt: 9_000 }), 'open', 'a second without an answer (a reloaded page: the hub long-polls it)');
  assert.equal(S.waitSheetStep({ ...s, answers: 1 }), 'open', 'the first answer');
  assert.equal(S.waitSheetStep({ ...s, answers: 1, menusFree: false }), 'wait', 'a sheet up (the terms): after it');
  assert.equal(S.waitSheetStep({ ...s, answers: 1, queueing: false }), 'drop', 'matched or ended first: none');
  assert.equal(S.waitSheetStep({ ...s, postedAt: 1, queueing: false }), 'drop');
  assert.equal(S.waitSheetStep({ ...s, answers: 1, onModes: true }), 'drop', "MODOS' panel has the choice");
});
