// The public queues' plan (server/src/queuePlan.ts, the modes redesign's build spec §1.4, §1.8,
// §2.2), pure: the Casual formats by human count and their teams (MatchmakerDO buildRoster), the
// plan of every pass (widened first, then each region, then the lone 5:00 waiter), the host
// region of a match, the location hints, the home normalization and the wait estimate. Run from
// server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const Q = await import('../src/queuePlan.ts');
const M = await import('../src/MatchmakerDO.ts');
const { QUEUE_HUB, queueHubOf, publicQueueKind, hasClientApi } = await import('../src/env.ts');
const A = await import('../../src/net/account.ts');

const MIN = 60_000;
const NOW = 10_000_000;
/** A Casual waiter of `home` that joined `agoMs` ago. */
const w = (id, home, agoMs, o = {}) => ({ playerId: id, home, joinedAt: NOW - agoMs, prefer: '2v2', visible: true, ...o });
const ids = (groups) => groups.map((g) => [g.mode, g.solo, g.humans.map((h) => h.playerId).join(' ')]);

test('the constants of the spec (§2.5): widening 60 s / 120 s, the solo match at 5:00, drops kept 10 min, 5 solo rooms; the hub is SA', () => {
  assert.deepEqual([Q.CASUAL_WIDEN_MS, Q.RANKED_WIDEN_MS, Q.SOLO_AFTER_MS, Q.RECENT_MS, Q.SOLO_ROOMS_MAX, Q.SOLO_UNPLAYED_MS], [60_000, 120_000, 300_000, 600_000, 5, 90_000]);
  assert.equal(QUEUE_HUB, 'SA');
  assert.equal(queueHubOf({ REGION_OVERRIDE: '' }), 'SA');
  assert.equal(queueHubOf({ REGION_OVERRIDE: 'test' }), 'test', 'REGION_OVERRIDE wins (dev, tests)');
  assert.deepEqual([publicQueueKind(undefined), publicQueueKind('p2p'), publicQueueKind('server'), publicQueueKind('ranked')], ['server', 'server', 'server', 'ranked'], "'p2p' (an older page) is Casual");
  assert.deepEqual([hasClientApi({ api: 2 }, 2), hasClientApi({ api: 3 }, 2), hasClientApi({ api: 1 }, 2), hasClientApi({ api: '2' }, 2), hasClientApi({}, 2), hasClientApi(null, 2)], [true, true, false, false, false, false]);
});

test('casualFormat(1..7): 1 = its prefer, 2-4 = 2v2, 5 and more = 3v3', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => Q.casualFormat(n)), ['2v2', '2v2', '2v2', '2v2', '3v3', '3v3', '3v3']);
  assert.equal(Q.casualFormat(1, '1v1'), '1v1');
  assert.equal(Q.casualFormat(1, '3v3'), '3v3');
  assert.equal(Q.casualFormat(2, '1v1'), '2v2', 'with another human the prefer does not count');
});

test('the teams (buildRoster alternation): 2 humans are rivals with a bot each; 3 = two blue and one red with a bot; 5 = three blue, two red and a bot', () => {
  const humans = (n) => Array.from({ length: n }, (_, i) => ({ playerId: 'h' + (i + 1), name: 'H' + (i + 1) }));
  const teams = (n) => {
    const r = M.buildRoster(Q.casualFormat(n) === '3v3' ? 3 : 2, humans(n), 'player');
    return [0, 1].map((t) => r.filter((e) => e.team === t).map((e) => e.playerId ?? 'bot').join(' '));
  };
  assert.deepEqual(teams(2), ['h1 bot', 'h2 bot']);
  assert.deepEqual(teams(3), ['h1 h3', 'h2 bot']);
  assert.deepEqual(teams(4), ['h1 h3', 'h2 h4']);
  assert.deepEqual(teams(5), ['h1 h3 h5', 'h2 h4 bot']);
  assert.deepEqual(teams(6), ['h1 h3 h5', 'h2 h4 h6']);
});

test('planCasual: two humans of a region form at once; a fresh lone one waits; a hidden lone one waits past 5:00; a visible one gets its solo match in its prefer', () => {
  assert.deepEqual(ids(Q.planCasual([w('a', 'SA', 5_000), w('b', 'SA', 0)], NOW)), [['2v2', false, 'a b']]);
  assert.deepEqual(ids(Q.planCasual([w('a', 'SA', 4 * MIN)], NOW)), []);
  assert.deepEqual(ids(Q.planCasual([w('a', 'SA', 5 * MIN, { visible: false })], NOW)), [], 'a hidden tab never gets the solo match');
  assert.deepEqual(ids(Q.planCasual([w('a', 'SA', 5 * MIN, { prefer: '1v1' })], NOW)), [['1v1', true, 'a']]);
  assert.deepEqual(ids(Q.planCasual([w('a', 'SA', 5 * MIN, { prefer: '3v3' })], NOW)), [['3v3', true, 'a']]);
});

test('planCasual: an EU waiter at 4:30 and an SA player who joins now form at once (the oldest is widened); nobody plays bots', () => {
  const groups = Q.planCasual([w('eu', 'EU', 4.5 * MIN), w('sa', 'SA', 0)], NOW);
  assert.deepEqual(ids(groups), [['2v2', false, 'eu sa']]);
  assert.equal(Q.hostRegion(groups[0].humans), 'EU', 'a tie: the one who waited longest');
});

test('planCasual: two fresh players of different regions wait until the older passes 60 s; then they meet', () => {
  const sa = w('sa', 'SA', 59_000);
  const eu = w('eu', 'EU', 10_000);
  assert.deepEqual(ids(Q.planCasual([sa, eu], NOW)), []);
  assert.deepEqual(ids(Q.planCasual([sa, eu], NOW + 1_000)), [['2v2', false, 'sa eu']]);
});

test('planCasual: a fresh SA joiner pairs with a waiting fresh SA first (same region), not with the widened elsewhere ... unless the oldest is widened', () => {
  // The oldest (EU) is widened: it takes everyone, every region (up to 6).
  assert.deepEqual(ids(Q.planCasual([w('eu', 'EU', 2 * MIN), w('s1', 'SA', 10_000), w('s2', 'SA', 0)], NOW)), [['2v2', false, 'eu s1 s2']]);
  // Nobody widened: the two SA form, the EU one waits.
  assert.deepEqual(ids(Q.planCasual([w('eu', 'EU', 30_000), w('s1', 'SA', 10_000), w('s2', 'SA', 0)], NOW)), [['2v2', false, 's1 s2']]);
});

test('planCasual: 7 humans in one pass: the oldest 6 form a 3v3, the 7th waits with its own clock (or forms with the next ones)', () => {
  const seven = Array.from({ length: 7 }, (_, i) => w('p' + i, 'SA', 10_000 - i));
  assert.deepEqual(ids(Q.planCasual(seven, NOW)), [['3v3', false, 'p0 p1 p2 p3 p4 p5']]);
  const eight = [...seven, w('p7', 'SA', 0)];
  assert.deepEqual(ids(Q.planCasual(eight, NOW)), [['3v3', false, 'p0 p1 p2 p3 p4 p5'], ['2v2', false, 'p6 p7']]);
  const five = Array.from({ length: 5 }, (_, i) => w('q' + i, 'NA', 1_000 - i));
  assert.deepEqual(ids(Q.planCasual(five, NOW)), [['3v3', false, 'q0 q1 q2 q3 q4']]);
});

test('planCasual: several regions in one pass, each with two or more, form each on its own; the order is join order whatever the input order', () => {
  const list = [w('n2', 'NA', 1_000), w('s1', 'SA', 9_000), w('n1', 'NA', 8_000), w('s2', 'SA', 2_000), w('e1', 'EU', 500)];
  assert.deepEqual(ids(Q.planCasual(list, NOW)), [['2v2', false, 's1 s2'], ['2v2', false, 'n1 n2']]);
});

test('hostRegion: the majority; a tie goes to the region of the longest wait', () => {
  assert.equal(Q.hostRegion([w('a', 'SA', 1), w('b', 'EU', 2), w('c', 'EU', 0)]), 'EU');
  assert.equal(Q.hostRegion([w('a', 'SA', 1), w('b', 'EU', 2)]), 'EU');
  assert.equal(Q.hostRegion([w('a', 'SA', 9), w('b', 'EU', 2)]), 'SA');
  assert.equal(Q.hostRegion([w('a', 'NA', 9), w('b', 'SA', 5), w('c', 'SA', 0), w('d', 'EU', 7), w('e', 'EU', 1)]), 'EU', 'SA and EU tie; EU waited longer');
});

test('locationHintOf: total over the six ids (SA sam, as the NodeRegistryDO); anything else as the hub', () => {
  assert.deepEqual(['SA', 'NA', 'EU', 'AS', 'OC', 'AF'].map(Q.locationHintOf), ['sam', 'enam', 'weur', 'apac', 'oc', 'afr']);
  assert.equal(Q.locationHintOf('dev'), 'sam');
});

test('normalizeHome: a REGIONS id stays; the raw continents autoRegion gives (AN, T1, dev) and junk are the hub', () => {
  for (const id of ['SA', 'NA', 'EU', 'AS', 'OC', 'AF']) assert.equal(Q.normalizeHome(id), id);
  for (const raw of ['AN', 'T1', 'dev', '', undefined, null, 7, 'sa']) assert.equal(Q.normalizeHome(raw), 'SA', String(raw));
});

test('roundEstimate: 30 s steps below 5 minutes, 1 minute steps above, always up', () => {
  assert.deepEqual([0, 1, 30_000, 30_001, 299_999, 300_000, 300_001, 61 * MIN - 1].map(Q.roundEstimate), [0, 30_000, 30_000, 60_000, 300_000, 300_000, 360_000, 61 * MIN]);
});

const casual = (o) => Q.estimateWait({ kind: 'casual', waitedMs: 0, searching: 1, searchingHere: 1, arrivalsHere: 0, arrivalsAll: 0, othersWidenInMs: null, busy: false, ...o });

test('estimateWait (Casual): no arrival in the last hour -> the bots match at botsIn ("con bots en 3:37 como máximo")', () => {
  const e = casual({ waitedMs: 83_000 });
  assert.deepEqual(e, { searching: 1, searchingHere: 1, waitedMs: 83_000, busy: false, widened: true, widenInMs: 0, estimateMs: 217_000, estimateKind: 'bots', botsInMs: 217_000 });
  const fresh = casual({});
  assert.deepEqual([fresh.widened, fresh.widenInMs, fresh.botsInMs, fresh.estimateKind, fresh.estimateMs], [false, 60_000, 300_000, 'bots', 300_000]);
  assert.equal(casual({ waitedMs: 400_000 }).botsInMs, 0, 'due (hidden tab or full servers): 0');
});

test('estimateWait (Casual): an arrival here every 2 min -> humans in ~2 min; not widened, a lot elsewhere only counts once widened', () => {
  const here = casual({ arrivalsHere: 30, arrivalsAll: 30 }); // 60 min / 30 = 2 min
  assert.deepEqual([here.estimateKind, here.estimateMs], ['humans', 120_000]);
  // Few here, many elsewhere: the others count from the widening (60 s) on.
  const elsewhere = casual({ arrivalsHere: 0, arrivalsAll: 120 }); // 30 s per arrival anywhere
  assert.deepEqual([elsewhere.estimateKind, elsewhere.estimateMs], ['humans', 60_000], 'max(widenIn, 1/rateAll)');
  const widened = casual({ waitedMs: 70_000, arrivalsHere: 0, arrivalsAll: 120 });
  assert.deepEqual([widened.estimateKind, widened.estimateMs], ['humans', 30_000], 'widened: 1/rateAll');
});

test('estimateWait (Casual): another waiter elsewhere -> the min of both widen-ins (the two meet when either is widened)', () => {
  const e = casual({ waitedMs: 10_000, othersWidenInMs: 15_000 });
  assert.deepEqual([e.estimateKind, e.estimateMs, e.widenInMs], ['humans', 30_000, 50_000], '15 s, rounded up to 30 s');
  const mine = casual({ waitedMs: 40_000, othersWidenInMs: 55_000 });
  assert.deepEqual([mine.estimateKind, mine.estimateMs], ['humans', 30_000], 'mine first: 20 s');
});

test('estimateWait (Casual): never above botsIn; searchingHere never above searching', () => {
  const e = casual({ waitedMs: 290_000, arrivalsHere: 1, arrivalsAll: 1, searching: 3, searchingHere: 9 });
  assert.deepEqual([e.estimateKind, e.estimateMs, e.botsInMs, e.busy, e.searching, e.searchingHere], ['bots', 10_000, 10_000, false, 3, 3]);
});

test('estimateWait (Casual): a humans estimate that ROUNDS to botsIn or past it is the bots match (never "~5 min" next to "bots in 5:00")', () => {
  // A fresh waiter, 13 arrivals here in the last hour: one every 4:37, rounded up to 5:00 = botsIn (review-live:A, S3's W3).
  const fresh = casual({ arrivalsHere: 13, arrivalsAll: 13 });
  assert.equal(Q.roundEstimate(3_600_000 / 13), 300_000);
  assert.deepEqual([fresh.estimateKind, fresh.estimateMs, fresh.botsInMs], ['bots', 300_000, 300_000]);
  // At 0:50 (bots in 4:10): an arrival every 4:05 rounds up to 4:30, past the bots: bots; one every 3:50 rounds to 4:00: humans.
  const late = casual({ waitedMs: 50_000, arrivalsHere: 60 / (245 / 60), arrivalsAll: 60 / (245 / 60) });
  assert.deepEqual([late.estimateKind, late.estimateMs], ['bots', 250_000]);
  const early = casual({ waitedMs: 50_000, arrivalsHere: 60 / (230 / 60), arrivalsAll: 60 / (230 / 60) });
  assert.deepEqual([early.estimateKind, early.estimateMs, early.botsInMs], ['humans', 240_000, 250_000]);
});

test('estimateWait: a waiter held by a cap (busy) gets no estimate (none, null), Casual and ranked; Casual keeps its botsIn', () => {
  // Two SA waiters both there, held by the cap: no "humans ~1 min".
  const held = casual({ waitedMs: 10_000, searching: 2, searchingHere: 2, arrivalsHere: 30, arrivalsAll: 30, othersWidenInMs: 50_000, busy: true });
  assert.deepEqual([held.estimateKind, held.estimateMs, held.botsInMs, held.busy], ['none', null, 290_000, true]);
  const due = casual({ waitedMs: 400_000, busy: true });
  assert.deepEqual([due.estimateKind, due.estimateMs, due.botsInMs], ['none', null, 0], 'a solo match held by the solo cap: no estimate either');
  const r = ranked({ arrivalsHere: 20, arrivalsAll: 20, missingHere: 0, missingAll: 0, busy: true });
  assert.deepEqual([r.estimateKind, r.estimateMs, r.busy, r.botsInMs], ['none', null, true, undefined]);
});

test('encodeArrivals / decodeArrivals: one compact row (whole seconds, kind, home index, no id), the last hour, at most 2,000', () => {
  const homes = ['SA', 'NA', 'EU', 'AS', 'OC', 'AF'];
  assert.deepEqual(homes, A.REGIONS.map((r) => r.id), 'the index order is the REGIONS order');
  const list = [
    { at: NOW - 61 * MIN, kind: 'casual', home: 'SA' }, // out of the hour: dropped
    { at: NOW - 30 * MIN + 400, kind: 'casual', home: 'EU' },
    { at: NOW - 10_000, kind: 'ranked', home: 'AF' },
    { at: NOW, kind: 'casual', home: 'SA' },
  ];
  const row = Q.encodeArrivals(list, NOW);
  assert.deepEqual(Object.keys(row), ['v', 't0', 'a']);
  assert.equal(row.a.length, 9, 'three triples');
  assert.deepEqual(row.a.slice(0, 3), [0, 0, 2]);
  assert.doesNotMatch(JSON.stringify(row), /playerId|[0-9a-f]{16}/);
  const back = Q.decodeArrivals(structuredClone(row));
  assert.deepEqual(back.map((x) => [x.kind, x.home]), [['casual', 'EU'], ['ranked', 'AF'], ['casual', 'SA']]);
  assert.deepEqual(back.map((x) => x.at), list.slice(1).map((x) => Math.floor(x.at / 1000) * 1000), 'whole seconds');
  assert.deepEqual(Q.countArrivals(back, 'casual', 'SA', NOW, null), Q.countArrivals(list, 'casual', 'SA', NOW, null), 'the estimator reads the same');
  // At most ARRIVALS_MAX, the newest; a stored row of another shape reads as none.
  const many = Array.from({ length: Q.ARRIVALS_MAX + 50 }, (_, i) => ({ at: NOW - (Q.ARRIVALS_MAX + 50 - i) * 1000, kind: 'casual', home: 'NA' }));
  const big = Q.encodeArrivals(many, NOW);
  assert.equal(big.a.length, Q.ARRIVALS_MAX * 3);
  assert.ok(JSON.stringify(big).length < 32_000, 'well under a storage value: ' + JSON.stringify(big).length + ' B');
  assert.equal(Q.decodeArrivals(big)[0].at, many[50].at);
  for (const junk of [null, 7, {}, { v: 2, t0: 1, a: [] }, { v: 1, t0: 1, a: [1, 2] }]) assert.deepEqual(Q.decodeArrivals(junk), [], JSON.stringify(junk));
  assert.deepEqual(Q.decodeArrivals({ v: 1, t0: 100, a: [1, 0, 0, 2, 5, 0, 3, 1, 9] }), [{ at: 101_000, kind: 'casual', home: 'SA' }], 'a bad triple is skipped');
});

const ranked = (o) => Q.estimateWait({ kind: 'ranked', waitedMs: 0, searching: 1, searchingHere: 1, arrivalsHere: 0, arrivalsAll: 0, missingHere: 1, missingAll: 1, busy: false, ...o });

test('estimateWait (ranked): no arrival -> no estimate (null, none); k missing at the arrival rate; widened at 120 s; never a botsIn', () => {
  const none = ranked({});
  assert.deepEqual([none.estimateMs, none.estimateKind, none.botsInMs, none.widenInMs], [null, 'none', undefined, 120_000]);
  const two = ranked({ arrivalsHere: 20, arrivalsAll: 20, missingHere: 1, missingAll: 1 }); // 3 min per arrival
  assert.deepEqual([two.estimateMs, two.estimateKind], [180_000, 'humans']);
  const elsewhere = ranked({ arrivalsHere: 0, arrivalsAll: 60, missingHere: 3, missingAll: 3 }); // widenIn 120 s + 3 min
  assert.deepEqual([elsewhere.estimateMs, elsewhere.estimateKind], [300_000, 'humans']);
  const widened = ranked({ waitedMs: 130_000, arrivalsHere: 0, arrivalsAll: 60, missingAll: 3 });
  assert.deepEqual([widened.widened, widened.estimateMs], [true, 180_000]);
  assert.deepEqual([ranked({ arrivalsHere: 1, arrivalsAll: 1, missingHere: 5, missingAll: 5 }).estimateKind], ['none'], 'above an hour: no estimate');
  assert.equal(ranked({ missingHere: 0, missingAll: 0 }).estimateMs, 0, 'everyone is here: now');
});

test('countArrivals: other players of the kind in the last hour, here and everywhere; the asker\'s own arrival is taken out', () => {
  const arr = [
    { at: NOW - 10_000, kind: 'casual', home: 'SA' },
    { at: NOW - 20_000, kind: 'casual', home: 'EU' },
    { at: NOW - 61 * MIN, kind: 'casual', home: 'SA' },
    { at: NOW - 5_000, kind: 'ranked', home: 'SA' },
  ];
  assert.deepEqual(Q.countArrivals(arr, 'casual', 'SA', NOW, null), { here: 1, all: 2 });
  assert.deepEqual(Q.countArrivals(arr, 'casual', 'SA', NOW, NOW - 10_000), { here: 0, all: 1 });
  assert.deepEqual(Q.countArrivals(arr, 'casual', 'SA', NOW, NOW - 2 * 60 * MIN), { here: 1, all: 2 }, 'a clock older than the window: its arrival is gone already');
  assert.deepEqual(Q.countArrivals(arr, 'ranked', 'EU', NOW, null), { here: 0, all: 1 });
});

test('pickRegionalRankedGroup: own region first; another region only among the waiters of 120 s (both widened)', () => {
  const r = (id, home, agoMs, mu = 25) => ({ playerId: id, home, joinedAt: NOW - agoMs, mu });
  assert.equal(M.pickRegionalRankedGroup([r('a', 'SA', 119_000), r('b', 'EU', 200_000)], 2, NOW), null, 'one side not widened');
  assert.deepEqual(M.pickRegionalRankedGroup([r('a', 'SA', 120_000), r('b', 'EU', 200_000)], 2, NOW).map((x) => x.playerId), ['a', 'b'], 'both widened: any region');
  assert.deepEqual(M.pickRegionalRankedGroup([r('a', 'SA', 200_000), r('b', 'EU', 200_000), r('c', 'SA', 0)], 2, NOW).map((x) => x.playerId), ['a', 'c'], 'own region first');
  assert.equal(M.pickRegionalRankedGroup([r('a', 'SA', 130_000, 25), r('b', 'EU', 130_000, 60)], 2, NOW), null, 'the MMR windows still apply');
});

test('preferOf and localOf: a playlist prefer wins; else 2v2 when searched, else the first searched; local is bots or training', () => {
  assert.equal(M.preferOf('3v3', ['1v1']), '3v3');
  assert.equal(M.preferOf(undefined, ['1v1', '2v2']), '2v2');
  assert.equal(M.preferOf('4v4', ['3v3', '1v1']), '3v3');
  assert.deepEqual(['bots', 'training', 'lab', undefined].map(M.localOf), ['bots', 'training', undefined, undefined]);
});
