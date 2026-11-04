// The public queues' anonymous daily counters (the modes redesign's build spec §2.6;
// server/src/queueStats.ts and the queue hub's 'stats:YYYY-MM-DD' rows): the pure parts, every
// counter from the events of a day, the write throttle, the 90-day sweep at the day change, the
// hub's GET /daily-stats, and GET /nodes/admin/queue-stats through the Worker: the maintainer gate
// (the same cases as account-stats.test.mjs), its limit, no-store, and that it answers with
// nodes_off set and without the node settings. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Q, S, accountToken, guestToken, makeHubWorld, pid, signJwt, worker, SECRET, ORIGIN } from './helpers/hub.mjs';

const { accountGate } = await import('../src/limits.ts');
const SEC = 1_000;
const MIN = 60_000;
const DAY = 86_400_000;

// ---- pure ------------------------------------------------------------------------------------------

test('bucketOf: a wait counts in the first bucket it is at most', () => {
  assert.deepEqual([0, 15_000, 15_001, 30_000, 59_000, 60_000, 61_000, 3 * MIN, 5 * MIN, 9 * MIN, 30 * MIN, 31 * MIN].map(S.bucketOf), ['15s', '15s', '30s', '30s', '1m', '1m', '2m', '3m', '5m', '10m', '30m', 'more']);
});

test('emptyDay / addFormed / mergeDays / parseDay: the row of the spec, counts only', () => {
  const d = S.emptyDay('2026-11-04');
  assert.deepEqual(Object.keys(d), ['date', 'searches', 'cancelled', 'dropped', 'formed', 'crossRegion', 'onNode', 'onCloud', 'waits', 'localStarts', 'formedWhileLocal']);
  assert.deepEqual(d.formed, { casual: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, ranked: { 2: 0, 4: 0, 6: 0 } });
  assert.deepEqual(Object.keys(d.waits.casual), ['15s', '30s', '1m', '2m', '3m', '5m', '10m', '30m', 'more']);
  S.addFormed(d, { kind: 'casual', humans: 2, waits: [10_000, 70_000], crossRegion: true, onNode: false, whileLocal: true });
  S.addFormed(d, { kind: 'casual', humans: 1, waits: [Q.SOLO_AFTER_MS], crossRegion: false, onNode: true, whileLocal: false });
  S.addFormed(d, { kind: 'ranked', humans: 4, waits: [1, 2, 3, 200_000], crossRegion: false, onNode: true, whileLocal: false });
  assert.deepEqual([d.formed.casual['2'], d.formed.casual['1'], d.formed.ranked['4'], d.crossRegion, d.onNode, d.onCloud, d.formedWhileLocal], [1, 1, 1, 1, 2, 1, 1]);
  assert.deepEqual([d.waits.casual['15s'], d.waits.casual['2m'], d.waits.casual['5m'], d.waits.ranked['15s'], d.waits.ranked['5m']], [1, 1, 1, 3, 1]);
  const m = S.mergeDays(d, d);
  assert.deepEqual([m.date, m.formed.casual['2'], m.onNode, m.waits.ranked['15s']], ['2026-11-04', 2, 4, 6]);
  assert.deepEqual(S.parseDay({ searches: { casual: 3, ranked: 'x' }, onNode: -1, formed: { casual: { 2: 1.5 } } }, '2026-11-01').searches, { casual: 3, ranked: 0 }, 'junk reads as 0');
  assert.equal(S.parseDay(null, '2026-11-01').onNode, 0);
  assert.equal(S.emptyRow(S.emptyDay('2026-11-04')), true);
  assert.equal(S.emptyRow(d), false);
});

test('the days: UTC dates, the 90-day window (today included), the days= parameter', () => {
  assert.equal(S.dayOf(Date.UTC(2026, 10, 4, 23, 59)), '2026-11-04');
  assert.equal(S.daysBefore('2026-11-04', 89), '2026-08-07');
  assert.equal(S.expiredDay('2026-08-07', '2026-11-04'), false, 'the 90th day is kept');
  assert.equal(S.expiredDay('2026-08-06', '2026-11-04'), true);
  assert.deepEqual(['1', '90', '30', null, '0', '91', 'abc', '7.5'].map(S.statsDays), [1, 90, 30, 30, 30, 30, 30, 30]);
  assert.deepEqual([S.STATS_KEEP_DAYS, S.STATS_FLUSH_MS], [90, 60_000]);
});

// ---- the hub's counters ----------------------------------------------------------------------------

test('every counter from a day of events: searches (new only), cancelled, dropped, formed by humans, waits, regions, node or cloud, local play', async () => {
  const w = await makeHubWorld({ flags: { nodes_on: '1' }, nodes: true });
  const [a, b, c, d, e] = [pid(), pid(), pid(), pid(), pid()];
  // A (bots locally) and B (EU) meet at 60 s: a cross-region pair hosted SA (the tie: A waited longer), on the node.
  await w.join(a, { local: 'bots' });
  w.advance(10 * SEC);
  await w.join(b, { home: 'EU', local: 'training' });
  w.advance(20 * SEC);
  await w.join(a, { local: 'bots' }); // the same local play: no new start
  await w.join(b, { home: 'EU', local: 'bots' }); // training -> bots: one more start
  w.advance(30 * SEC);
  const ab = await w.join(b, { home: 'EU', local: 'bots' });
  assert.deepEqual([ab.json.status, ab.json.node, ab.json.host], ['matched', true, 'SA']);
  // C cancels; D drops (no POST) and never comes back; E plays its solo match on a MatchDO (EU: no node).
  await w.join(c);
  await w.leave(c);
  await w.join(d, { home: 'NA' });
  w.advance(41 * SEC);
  await w.join(e, { home: 'EU' }); // its pass drops D
  w.advance(Q.SOLO_AFTER_MS);
  const solo = await w.join(e, { home: 'EU' });
  assert.deepEqual([solo.json.humans, solo.json.node], [1, undefined]);
  w.advance(Q.RECENT_MS);
  await w.join(pid(), { kind: 'ranked', mode: '1v1' }); // a later join prunes D's search: dropped
  const day = (await w.daily(1)).days[0];
  assert.equal(day.date, '2026-11-04');
  assert.deepEqual(day.searches, { casual: 5, ranked: 1 });
  assert.deepEqual(day.cancelled, { casual: 1, ranked: 0 });
  assert.deepEqual(day.dropped, { casual: 1, ranked: 0 });
  assert.deepEqual(day.formed.casual, { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 });
  assert.deepEqual([day.crossRegion, day.onNode, day.onCloud, day.formedWhileLocal], [1, 1, 1, 1]);
  assert.deepEqual(day.localStarts, { bots: 2, training: 1 });
  assert.deepEqual([day.waits.casual['1m'], day.waits.casual['5m'], day.waits.casual['2m']], [2, 1, 0], 'B 50 s and A 60 s (at most 1 minute), E 5:00');
  assert.doesNotMatch(JSON.stringify(day), /[0-9a-f]{16}/, 'no id anywhere');
});

test('the writes: the first count at the first formation, then at most every 60 s; the rest from memory in /daily-stats; once more when the queues empty', async () => {
  const w = await makeHubWorld();
  const key = 'stats:2026-11-04';
  const stored = () => w.hub().ctx.storage.map.get(key);
  await w.join(pid());
  assert.equal(stored(), undefined, 'a search alone writes nothing yet');
  await w.join(pid());
  await pause(5);
  assert.equal(stored().formed.casual['2'], 1, 'the first formation writes');
  w.advance(10 * SEC);
  await w.join(pid());
  await w.join(pid());
  await pause(5);
  assert.equal(stored().formed.casual['2'], 1, 'within 60 s: not written');
  assert.equal((await w.daily()).days[0].formed.casual['2'], 2, 'but answered (stored + memory)');
  w.advance(S.STATS_FLUSH_MS);
  await w.join(pid());
  await w.join(pid());
  await pause(5);
  assert.equal(stored().formed.casual['2'], 3, '60 s later: written');
  assert.equal(stored().searches.casual, 6);
  // A last search, cancelled: the sweep that finds the queues empty writes it at once.
  const last = pid();
  await w.join(last);
  await w.leave(last);
  await pause(5);
  assert.deepEqual([stored().searches.casual, stored().cancelled.casual], [6, 0], 'within 60 s: not written yet');
  await w.hub().sweep();
  await pause(5);
  assert.deepEqual([stored().searches.casual, stored().cancelled.casual], [7, 1]);
});

test('the 90-day sweep: at the first count after a start, and at the day change (which writes the day before); a day with no search writes nothing', async () => {
  const w = await makeHubWorld();
  await w.call('/stats'); // the hub exists (its storage too)
  const storage = w.hub().ctx.storage;
  for (const date of ['2026-08-01', '2026-08-06', '2026-08-07', '2026-11-03']) storage.map.set('stats:' + date, { ...S.emptyDay(date), searches: { casual: 1, ranked: 0 } });
  await w.join(pid());
  await pause(5);
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith('stats:')).sort(), ['stats:2026-08-07', 'stats:2026-11-03'], 'older than 90 days: gone');
  // The next day: the first count writes today's (2026-11-04) and sweeps again from 2026-11-05.
  w.advance(DAY);
  await w.join(pid());
  await pause(5);
  const keys = [...storage.map.keys()].filter((k) => k.startsWith('stats:')).sort();
  assert.deepEqual(keys, ['stats:2026-11-03', 'stats:2026-11-04'], 'the day before written; 2026-08-07 out of the window that ends 2026-11-05 (its 90th day back is 2026-08-08)');
});

test('/daily-stats?days=N: newest first, today included even with no count, the stored rows of the window only', async () => {
  const w = await makeHubWorld();
  await w.call('/stats');
  const storage = w.hub().ctx.storage;
  for (const date of ['2026-10-01', '2026-11-01', '2026-11-03']) storage.map.set('stats:' + date, { ...S.emptyDay(date), searches: { casual: 2, ranked: 1 } });
  const all = await w.daily(90);
  assert.deepEqual(all.days.map((d) => d.date), ['2026-11-04', '2026-11-03', '2026-11-01', '2026-10-01']);
  assert.deepEqual((await w.daily()).days.map((d) => d.date), ['2026-11-04', '2026-11-03', '2026-11-01'], 'the default: 30 days');
  assert.deepEqual(all.days[0].searches, { casual: 0, ranked: 0 });
  assert.deepEqual((await w.daily(3)).days.map((d) => d.date), ['2026-11-04', '2026-11-03']);
  assert.deepEqual((await w.daily(1)).days.map((d) => d.date), ['2026-11-04']);
});

// ---- GET /nodes/admin/queue-stats ------------------------------------------------------------------

const nowS = () => Math.floor(Date.now() / 1000);
const maintainer = (sub, { aat = nowS(), aal = 2, tv = false } = {}) => signJwt(SECRET, { sub, name: 'Proyecto', iat: nowS(), exp: nowS() + 3600, acct: 1, ...(aat === null ? {} : { aat }), ...(aal === null ? {} : { aal }), ...(tv ? { tv: 1 } : {}) });
async function adminGet(w, path, bearer, ip = '198.51.100.' + Math.floor(Math.random() * 200 + 1)) {
  const res = await worker.fetch(new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': ip, Origin: ORIGIN, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) } }), w.env);
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test('the gate: no session 401, a guest, another account, a TV of the project and a stale project session 403, before the hub is asked', async () => {
  const w = await makeHubWorld();
  const project = pid();
  w.env.NODE_TRUSTED_OPERATORS = project;
  const stale = nowS() - 16 * 60;
  const cases = [
    [null, 401, 'unauthorized'],
    [await guestToken(project), 403, 'account_required'],
    [await accountToken(pid()), 403, 'not_trusted'],
    [await maintainer(project, { tv: true }), 403, 'tv_session'],
    [await maintainer(project, { aat: stale }), 403, 'reauth_required'],
    [await maintainer(project, { aat: null }), 403, 'reauth_required'],
    [await maintainer(project, { aal: 1 }), 403, 'reauth_required'],
    [await maintainer(project, { aal: null }), 403, 'reauth_required'],
  ];
  for (const [bearer, status, code] of cases) {
    const r = await adminGet(w, '/nodes/admin/queue-stats', bearer);
    assert.deepEqual([r.status, r.json.error], [status, code], code);
  }
  assert.equal(w.mmCalls.length, 0, 'the hub was never asked');
  const ok = await adminGet(w, '/nodes/admin/queue-stats?days=7', await maintainer(project, { aat: nowS() - 14 * 60 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('access-control-allow-origin'), null, 'no CORS');
  assert.deepEqual(ok.json.days.map((d) => d.date), [S.dayOf(w.time())], 'today, even with no count');
  assert.deepEqual(w.mmCalls.map((c) => [c.name, c.path, c.query.days]), [['mm:SA', '/daily-stats', '7']]);
});

test('its limit is the account counts\' (accountStats: 10 a minute per account, one count for both routes)', async () => {
  assert.deepEqual(accountGate('GET', '/nodes/admin/queue-stats'), ['accountStats']);
  const w = await makeHubWorld();
  const project = pid();
  w.env.NODE_TRUSTED_OPERATORS = project;
  const bearer = await maintainer(project);
  for (let i = 0; i < 10; i++) assert.equal((await adminGet(w, '/nodes/admin/queue-stats', bearer)).status, 200, `#${i + 1}`);
  const over = await adminGet(w, '/nodes/admin/queue-stats', bearer);
  assert.deepEqual([over.status, over.json.error], [429, 'rate_limited']);
});

test('it answers with nodes_off set (that flag stops only the routes reaching the NodeRegistryDO) and on a fork without nodes', async () => {
  const off = await makeHubWorld({ flags: { nodes_off: '1', nodes_on: '1' }, nodes: true });
  const project = pid();
  off.env.NODE_TRUSTED_OPERATORS = project;
  await off.join(pid());
  const r = await adminGet(off, '/nodes/admin/queue-stats?days=1', await maintainer(project));
  assert.equal(r.status, 200);
  assert.equal(r.json.days[0].searches.casual, 1);
  assert.equal(off.control.calls.length, 0, 'the control plane is never asked');
  const fork = await makeHubWorld();
  fork.env.NODE_TRUSTED_OPERATORS = project;
  assert.equal((await adminGet(fork, '/nodes/admin/queue-stats', await maintainer(project))).status, 200);
  assert.equal((await adminGet(fork, '/nodes/admin/nodes', await maintainer(project))).status, 404, 'the other admin routes stay 404 there');
});

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
