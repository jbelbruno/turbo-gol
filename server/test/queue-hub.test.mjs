// The queue hub (the modes redesign's build spec §1, §2; server/src/MatchmakerDO.ts 'mm:SA' and the
// Worker's /api/queue, /api/leave, /api/population, /api/lobbies around it), on fakes
// (helpers/hub.mjs): Casual for accounts only, the client-version marker, the first answer at
// once, the pooled formats, the regions and their widening, the 5:00 solo match and the hidden
// tab, the dropped search that continues, the solo match nobody played, the global caps, where a
// match runs (a node only for SA, the location hints), the ranked widening and lock region, and
// the leave fan-out. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M, Q, accountToken, guestToken, hex64, makeHubWorld, pause, pid } from './helpers/hub.mjs';

const SEC = 1_000;
const MIN = 60_000;
const { outcomeCalls } = await import('../src/nodeOutcome.ts');

/**
 * Let `ms` pass while the waiters in `polls` ([id, joinOptions]) keep searching: each POSTs every
 * 20 s, as a client's long-poll does (a waiter silent for 40 s is dropped). Answers the last ones.
 */
async function hold(w, polls, ms) {
  let last = [];
  for (let left = ms; left > 0; left -= 20 * SEC) {
    w.advance(Math.min(20 * SEC, left));
    last = [];
    for (const [id, o] of polls) last.push(await w.join(id, o));
  }
  return last;
}

// ---- the Worker: the account gate, the client version, the first answer -----------------------------

test('Worker: a guest gets 403 account_required for server, p2p and ranked, with or without api, before any matchmaker or AccountsDO call', async () => {
  const w = await makeHubWorld();
  const token = await guestToken(pid());
  for (const kind of ['server', 'p2p', 'ranked', undefined]) {
    for (const api of [2, undefined]) {
      const r = await w.queue(token, { mode: '2v2', ...(kind ? { kind } : {}), ...(api ? { api } : {}) });
      assert.deepEqual([r.status, r.json.error], [403, 'account_required'], `${kind} ${api}`);
      assert.equal(r.json.message, kind === 'ranked' ? 'Inicia sesión para jugar Competitivo' : 'Inicia sesión para jugar Casual');
    }
  }
  assert.equal(w.mmCalls.length + w.accounts.calls.length, 0);
});

test('Worker: an account page without api >= 2 (cached before the deploy) gets 426 reload_required, whatever its kind', async () => {
  const w = await makeHubWorld();
  const token = await accountToken(pid());
  for (const body of [{ mode: '2v2' }, { mode: '2v2', kind: 'p2p', p2pProtocol: 5 }, { mode: '2v2', kind: 'ranked' }, { mode: '2v2', api: 1 }, { mode: '2v2', api: '2' }]) {
    const r = await w.queue(token, body);
    assert.deepEqual([r.status, r.json.error, r.json.message], [426, 'reload_required', 'Hay una versión nueva del juego: recarga la página'], JSON.stringify(body));
  }
  assert.equal(w.mmCalls.length, 0);
});

test('Worker: api 2 with an older kind p2p is pooled Casual; the hub gets home, prefer, local and visible; the first answer comes at once with its wait', async () => {
  const w = await makeHubWorld();
  const a = pid();
  const r = await w.queue(await accountToken(a), { api: 2, mode: '1v1', kind: 'p2p', p2pProtocol: 3, prefer: '3v3', local: 'bots', visible: false });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.status, r.json.region, r.json.waiting, 'fresh' in r.json], ['waiting', 'SA', 1, false], 'fresh is the Worker\'s, never the client\'s');
  assert.deepEqual(Object.keys(r.json.wait).sort(), ['botsInMs', 'busy', 'estimateKind', 'estimateMs', 'searching', 'searchingHere', 'waitedMs', 'widenInMs', 'widened']);
  assert.deepEqual([r.json.wait.waitedMs, r.json.wait.botsInMs, r.json.wait.estimateKind, r.json.wait.searching], [0, Q.SOLO_AFTER_MS, 'bots', 1]);
  assert.deepEqual(w.mmCalls.map((c) => [c.name, c.path]), [['mm:SA', '/join']], 'answered without a long-poll');
  const st = await w.stats();
  assert.equal(st.queues.casual, 1, 'one Casual pool');
  // The join the hub saw (its waiter): home normalized (no cf data here: the raw 'dev' is the hub's SA).
  const pop = (await w.call('/population?home=SA')).json;
  assert.deepEqual(pop.casual, { '1v1': 0, '2v2': 0, '3v3': 1 }, 'its prefer');
});

test('Worker: the next POST of a search long-polls (/poll after /join); a second account forms the match and that poll answers it', async () => {
  const w = await makeHubWorld();
  const [a, b] = [pid(), pid()];
  const ta = await accountToken(a);
  assert.equal((await w.queue(ta, { api: 2, mode: '2v2' })).json.status, 'waiting');
  const polling = w.queue(ta, { api: 2, mode: '2v2' });
  await pause(20);
  assert.deepEqual(w.mmCalls.slice(-2).map((c) => c.path), ['/join', '/poll'], 'not fresh: long-polls');
  const rb = await w.queue(await accountToken(b), { api: 2, mode: '2v2', region: 'SA' });
  const ra = await polling;
  assert.deepEqual([ra.json.status, rb.json.status, ra.json.matchId], ['matched', 'matched', rb.json.matchId]);
  assert.deepEqual([ra.json.mode, ra.json.host, ra.json.humans, ra.json.region], ['2v2', 'SA', 2, 'SA']);
  assert.match(ra.json.wsUrl, /^wss:\/\/turbo-gol\.com\/ws\//);
});

test('Worker: home is the pick (a REGIONS id) or the continent; anything else is SA; a bad pick is 400 bad_region', async () => {
  const w = await makeHubWorld();
  const t = await accountToken(pid());
  const eu = await w.queue(t, { api: 2, mode: '2v2', region: 'EU' });
  assert.deepEqual([eu.json.region, eu.json.wait.searchingHere], ['EU', 1]);
  assert.equal((await w.queue(await accountToken(pid()), { api: 2, mode: '2v2', region: 'AN' })).json.error, 'bad_region');
  assert.equal((await w.queue(await accountToken(pid()), { api: 2, mode: '2v2' })).json.region, 'SA', 'no cf continent (wrangler dev: dev): SA');
  assert.ok(w.mmCalls.every((c) => c.name === 'mm:SA'), 'every queue is in the hub');
});

// ---- Casual formation (§1.4) ------------------------------------------------------------------------

test('two SA humans form at once: a 2v2 with a bot each, rivals (blue h1 + bot, red h2 + bot), on a MatchDO near SA', async () => {
  const w = await makeHubWorld();
  const [a, b] = [pid(), pid()];
  assert.equal((await w.join(a)).json.status, 'waiting');
  const rb = await w.join(b);
  assert.deepEqual([rb.json.status, rb.json.mode, rb.json.humans, rb.json.host], ['matched', '2v2', 2, 'SA']);
  const create = w.created()[0];
  assert.deepEqual(create.body.roster.map((e) => [e.team, e.kind, e.playerId ?? null]), [[0, 'player', a], [0, 'bot', null], [1, 'player', b], [1, 'bot', null]]);
  assert.deepEqual(create.opts, { locationHint: 'sam' });
  assert.equal(create.body.region, 'SA', 'its release comes back to the hub');
  assert.equal(create.body.mode, '2v2');
});

test('an EU waiter at 4:30 and a fresh SA joiner form at once, hosted EU (the tie: the longest wait); nobody gets a solo match', async () => {
  const w = await makeHubWorld();
  const [eu, sa] = [pid(), pid()];
  assert.equal((await w.join(eu, { home: 'EU' })).json.status, 'waiting');
  await hold(w, [[eu, { home: 'EU' }]], 4.5 * MIN);
  const r = await w.join(sa, { home: 'SA' });
  assert.deepEqual([r.json.status, r.json.host, r.json.humans], ['matched', 'EU', 2]);
  assert.deepEqual(w.created()[0].opts, { locationHint: 'weur' });
  assert.equal(w.created().length, 1, 'one match, no solo');
});

test('a fresh SA joiner pairs with a waiting fresh SA first; the fresh EU waiter waits (nobody widened)', async () => {
  const w = await makeHubWorld();
  const [eu, s1, s2] = [pid(), pid(), pid()];
  await w.join(eu, { home: 'EU' });
  w.advance(10 * SEC);
  await w.join(s1, { home: 'SA' });
  w.advance(5 * SEC);
  const r = await w.join(s2, { home: 'SA' });
  assert.deepEqual([r.json.status, r.json.host, r.json.humans], ['matched', 'SA', 2]);
  const left = await w.join(eu, { home: 'EU' });
  assert.equal(left.json.status, 'waiting');
  assert.deepEqual([left.json.wait.searching, left.json.wait.searchingHere, left.json.wait.widened], [1, 1, false]);
});

test('SA and EU, both fresh: no match until the older passes 60 s; then they meet at its next POST (or the sweep)', async () => {
  const w = await makeHubWorld();
  const [sa, eu] = [pid(), pid()];
  await w.join(sa, { home: 'SA' });
  w.advance(20 * SEC);
  const r = await w.join(eu, { home: 'EU' });
  assert.equal(r.json.status, 'waiting');
  assert.deepEqual([r.json.wait.searching, r.json.wait.searchingHere], [2, 1], 'two searching, one in EU');
  assert.equal(r.json.wait.estimateKind, 'humans');
  assert.equal(r.json.wait.estimateMs, 60 * SEC, 'the SA one is widened in 40 s: rounded up to 60 s');
  const both = [[sa, { home: 'SA' }], [eu, { home: 'EU' }]];
  const [, at59] = await hold(w, both, 39 * SEC);
  assert.equal(at59.json.status, 'waiting');
  w.advance(1 * SEC);
  const met = await w.join(eu, { home: 'EU' });
  assert.deepEqual([met.json.status, met.json.host], ['matched', 'SA'], 'a tie: SA waited longer');
});

test('3 humans in one pass form a 2v2 (h1 + h3 blue, h2 + bot red); 5 a 3v3; the 7th of 7 stays with its own clock', async () => {
  const w = await makeHubWorld();
  const p = Array.from({ length: 7 }, () => pid());
  // Join without forming: each joins with another region's home first, then all at 60 s together.
  const homes = ['SA', 'NA', 'EU', 'AS', 'OC', 'AF', 'SA'];
  for (let i = 0; i < 6; i++) {
    assert.equal((await w.join(p[i], { home: homes[i] })).json.status, 'waiting', homes[i]);
    w.advance(10);
  }
  await hold(w, p.slice(0, 6).map((id, i) => [id, { home: homes[i] }]), Q.CASUAL_WIDEN_MS - 20 * SEC);
  w.advance(20 * SEC); // the oldest (SA) is widened now, still within its 40 s
  const r = await w.join(p[6], { home: 'SA' }); // the oldest 6 of every region form
  assert.equal(r.json.status, 'waiting', 'the 7th stays');
  const c = w.created()[0];
  assert.equal(c.body.mode, '3v3');
  assert.deepEqual(c.body.roster.filter((e) => e.kind === 'player').map((e) => e.playerId), [p[0], p[2], p[4], p[1], p[3], p[5]]);
  assert.equal(r.json.wait.waitedMs, 0, 'its own clock');
});

// ---- the 5:00 solo match (§1.4 step 3, §1.6) ----------------------------------------------------------

test('alone at 5:00 with the tab visible: a solo match in its prefer (it on blue, bots everywhere else); not before', async () => {
  const w = await makeHubWorld();
  const a = pid();
  assert.equal((await w.join(a, { prefer: '3v3' })).json.status, 'waiting');
  w.advance(Q.SOLO_AFTER_MS - 1);
  const before = await w.join(a, { prefer: '3v3' });
  assert.deepEqual([before.json.status, before.json.wait.botsInMs, before.json.wait.estimateKind], ['waiting', 1, 'bots']);
  w.advance(1);
  const r = await w.join(a, { prefer: '3v3' });
  assert.deepEqual([r.json.status, r.json.mode, r.json.humans], ['matched', '3v3', 1]);
  const roster = w.created()[0].body.roster;
  assert.deepEqual(roster.map((e) => [e.team, e.kind]), [[0, 'player'], [0, 'bot'], [0, 'bot'], [1, 'bot'], [1, 'bot'], [1, 'bot']]);
  assert.equal((await w.stats()).soloRooms, 1);
});

test('a hidden tab keeps its clock past 5:00 and gets no solo match; its first visible POST forms it at once', async () => {
  const w = await makeHubWorld();
  const a = pid();
  await w.join(a, { visible: false });
  w.advance(6 * MIN);
  const hidden = await w.join(a, { visible: false });
  assert.deepEqual([hidden.json.status, hidden.json.wait.waitedMs, hidden.json.wait.botsInMs], ['waiting', 6 * MIN, 0]);
  assert.equal(w.created().length, 0);
  const shown = await w.join(a, { visible: true });
  assert.deepEqual([shown.json.status, shown.json.humans], ['matched', 1]);
});

test('a prefer (or local, or visible) change updates the waiter in place: the clock goes on; a change of kind replaces it', async () => {
  const w = await makeHubWorld();
  const a = pid();
  await w.join(a, { prefer: '1v1' });
  w.advance(90 * SEC);
  const r = await w.join(a, { prefer: '3v3', local: 'training', modes: ['1v1', '3v3'] });
  assert.deepEqual([r.json.wait.waitedMs, r.json.wait.widened], [90 * SEC, true], 'the same search');
  assert.deepEqual((await w.call('/population?home=SA')).json.casual, { '1v1': 0, '2v2': 0, '3v3': 1 });
  const ranked = await w.join(a, { kind: 'ranked', mode: '2v2' });
  assert.equal(ranked.json.wait.waitedMs, 0, 'another kind: a new search');
  assert.equal((await w.stats()).queues.casual, 0);
});

test('a dropped search (no POST for 40 s) continues: a join within 10 min restores its clock and is no new search', async () => {
  const w = await makeHubWorld();
  const [a, b] = [pid(), pid()];
  await w.join(a, { home: 'EU' });
  w.advance(41 * SEC);
  await w.join(b, { home: 'SA' }); // its pass drops A (stale): A goes to `recent`
  assert.equal((await w.stats()).recent, 1);
  await w.leave(b);
  w.advance(4 * MIN);
  const back = await w.join(a, { home: 'EU' });
  assert.deepEqual([back.json.status, back.json.wait.waitedMs], ['waiting', 41 * SEC + 4 * MIN], 'the 5:00 clock went on');
  const day = (await w.daily(1)).days[0];
  assert.deepEqual(day.searches, { casual: 2, ranked: 0 }, 'A and B: the restored one is not counted again');
  assert.equal(day.dropped.casual, 0, 'back within 10 min: no drop');
  // Past 5:00 since its first join: the solo match at once.
  w.advance(20 * SEC);
  assert.equal((await w.join(a, { home: 'EU' })).json.humans, 1);
});

test('a solo match released 45 s after forming (nobody played it: a locked phone) puts its search back: the next join gets a new solo match at once', async () => {
  const w = await makeHubWorld();
  const a = pid();
  await w.join(a);
  w.advance(Q.SOLO_AFTER_MS);
  const first = await w.join(a);
  assert.equal(first.json.humans, 1);
  w.advance(45 * SEC);
  // The MatchDO's unused alarm shuts it down: its /release reaches the hub.
  await w.release(first.json.matchId, [a]);
  const again = await w.join(a);
  assert.deepEqual([again.json.status, again.json.humans], ['matched', 1]);
  assert.notEqual(again.json.matchId, first.json.matchId);
  // Played (released 2 minutes later): the next search starts from 0:00.
  w.advance(2 * MIN);
  await w.release(again.json.matchId, [a]);
  const fresh = await w.join(a);
  assert.deepEqual([fresh.json.status, fresh.json.wait.waitedMs], ['waiting', 0]);
});

test('an explicit quit of a solo match (leave with its id) is a played match: no restore', async () => {
  const w = await makeHubWorld();
  const a = pid();
  await w.join(a);
  w.advance(Q.SOLO_AFTER_MS);
  const m = await w.join(a);
  w.advance(10 * SEC);
  assert.equal((await w.leave(a, m.json.matchId)).json.released, true);
  await w.release(m.json.matchId, [a]);
  assert.equal((await w.join(a)).json.wait.waitedMs, 0);
});

// ---- the global caps (§1.9) ---------------------------------------------------------------------------

test('the caps are global in the hub: 15 non-ranked MatchDOs across every host region, then busy (no 503); ranked takes up to 20', async () => {
  const w = await makeHubWorld();
  const homes = ['SA', 'NA', 'EU', 'AS', 'OC', 'AF'];
  for (let i = 0; i < M.MAX_ACTIVE_ROOMS - M.RANKED_RESERVED_ROOMS; i++) {
    const home = homes[i % homes.length];
    await w.join(pid(), { home });
    assert.equal((await w.join(pid(), { home })).json.status, 'matched', `casual ${i} (${home})`);
  }
  const st = await w.stats();
  assert.equal(st.rooms, 15);
  assert.equal(Object.values(st.byHost).reduce((a, b) => a + b, 0), 15);
  assert.equal(st.byHost.EU, 3);
  await w.join(pid(), { home: 'EU' });
  const busy = await w.join(pid(), { home: 'EU' });
  assert.deepEqual([busy.status, busy.json.status, busy.json.wait.busy], [200, 'waiting', true]);
  for (let i = 0; i < M.RANKED_RESERVED_ROOMS; i++) {
    await w.join(pid(), { kind: 'ranked', mode: '1v1' });
    assert.equal((await w.join(pid(), { kind: 'ranked', mode: '1v1' })).json.status, 'matched', `ranked ${i}`);
  }
  await w.join(pid(), { kind: 'ranked', mode: '1v1' });
  const rbusy = await w.join(pid(), { kind: 'ranked', mode: '1v1' });
  assert.deepEqual([rbusy.json.status, rbusy.json.wait.busy, rbusy.json.wait.estimateKind, rbusy.json.wait.estimateMs], ['waiting', true, 'none', null], 'held by the cap: no estimate (A4)');
  assert.deepEqual([busy.json.wait.estimateKind, busy.json.wait.estimateMs], ['none', null], 'a Casual pair held by the cap: no "humans ~1 min" either');
  assert.equal(w.created().length, M.MAX_ACTIVE_ROOMS);
});

test('at most 5 solo MatchDO matches: a 6th lone 5:00 waiter waits busy and enters the moment one ends; pairs still form', async () => {
  const w = await makeHubWorld({ rooms: 5, solos: 5 });
  assert.equal((await w.stats()).soloRooms, 5);
  const a = pid();
  await w.join(a);
  w.advance(Q.SOLO_AFTER_MS);
  const busy = await w.join(a);
  assert.deepEqual([busy.json.status, busy.json.wait.busy, busy.json.wait.botsInMs], ['waiting', true, 0], 'the solo cap, not the room cap');
  // A pair is no solo match: the next joiner, of any region, forms with the widened waiter at once.
  const pair = await w.join(pid(), { home: 'NA' });
  assert.deepEqual([pair.json.status, pair.json.humans, pair.json.host], ['matched', 2, 'SA']);
  // Another lone waiter at 5:00: busy until a solo match ends, then in at once.
  const c = pid();
  await w.join(c);
  w.advance(Q.SOLO_AFTER_MS);
  assert.equal((await w.join(c)).json.wait.busy, true);
  await w.release('solo0', ['seed0']);
  const r = await w.join(c);
  assert.deepEqual([r.json.status, r.json.humans], ['matched', 1]);
  assert.equal((await w.stats()).soloRooms, 5);
});

// ---- where it runs (§1.8) -------------------------------------------------------------------------------

test('a node first only for a match hosted SA; an EU-hosted one goes to a MatchDO near Europe; the releases reach the hub', async () => {
  const w = await makeHubWorld({ flags: { nodes_on: '1' }, nodes: true });
  const [s1, s2, e1, e2] = [pid(), pid(), pid(), pid()];
  await w.join(s1);
  const sa = await w.join(s2);
  assert.deepEqual([sa.json.node, sa.json.host], [true, 'SA']);
  const place = w.control.of('/internal/place')[0].body;
  assert.equal(place.region, 'SA');
  await w.join(e1, { home: 'EU' });
  const eu = await w.join(e2, { home: 'EU' });
  assert.deepEqual([eu.json.node, eu.json.host], [undefined, 'EU']);
  assert.equal(w.control.of('/internal/place').length, 1, 'never a node for EU');
  assert.deepEqual(w.created()[0].opts, { locationHint: 'weur' });
  // The MatchDO releases to 'mm:' + its region (the hub's), a node match to 'mm:' + its assignment's region.
  assert.equal(w.created()[0].body.region, 'SA');
  const calls = outcomeCalls({ kind: 'void', ranked: false, reason: 'x', players: [], noShows: [] }, { region: place.region, mode: '2v2' }, [s1, s2]);
  assert.equal(calls.at(-1).target, 'mm:SA');
  assert.deepEqual((await w.release(sa.json.matchId, [s1, s2])).json, { ok: true, released: 2 });
  assert.equal((await w.stats()).nodeLocks, 0);
});

// ---- ranked (§1.7) -----------------------------------------------------------------------------------

test('ranked: own region first; across regions only once both have waited 120 s; humans only', async () => {
  const w = await makeHubWorld();
  const [a, b] = [pid(), pid()];
  const ra = { kind: 'ranked', mode: '1v1', home: 'SA' };
  const rb = { kind: 'ranked', mode: '1v1', home: 'EU' };
  await w.join(a, ra);
  w.advance(30 * SEC);
  let r = await w.join(b, rb);
  assert.equal(r.json.status, 'waiting');
  assert.deepEqual([r.json.wait.widenInMs, r.json.wait.estimateKind, r.json.wait.searching, r.json.wait.searchingHere], [120 * SEC, 'humans', 2, 1]);
  const [atA, atB] = await hold(w, [[a, ra], [b, rb]], 100 * SEC);
  assert.deepEqual([atA.json.status, atA.json.wait.widened, atB.json.wait.widened], ['waiting', true, false], 'A widened, B not yet: no match');
  w.advance(20 * SEC);
  r = await w.join(b, rb);
  assert.deepEqual([r.json.status, r.json.ranked, r.json.humans], ['matched', true, 2]);
  assert.deepEqual(w.created()[0].body.roster.map((e) => e.kind), ['player', 'player'], 'no bots');
  const lock = w.accounts.calls.find((c) => c.path === '/ranked-lock');
  assert.equal(lock.body.region, 'SA', 'every ranked lock carries the hub\'s region');
});

test('Worker: the ranked check compares the lock\'s region with the hub: SA goes on to the hub (its own 409), another region gets 409 at once', async () => {
  const id = hex64();
  const inHub = await makeHubWorld({ ranked: { banUntil: 0, active: { matchId: id, region: 'SA' }, ratings: { '2v2': { mu: 25, sigma: 8 } } } });
  const r1 = await inHub.queue(await accountToken(pid()), { api: 2, mode: '2v2', kind: 'ranked', region: 'EU' });
  assert.equal(r1.status, 200, 'on to the hub (no lock there: queued)');
  assert.equal(inHub.mmCalls[0].path, '/join');
  const old = await makeHubWorld({ ranked: { banUntil: 0, active: { matchId: id, region: 'NA' }, ratings: { '2v2': { mu: 25, sigma: 8 } } } });
  const r2 = await old.queue(await accountToken(pid()), { api: 2, mode: '2v2', kind: 'ranked' });
  assert.deepEqual([r2.status, r2.json.error, r2.json.region], [409, 'active_match', 'NA']);
  assert.equal(old.mmCalls.length, 0);
});

// ---- leave, population, lobbies -------------------------------------------------------------------------

test('Worker /api/leave: to the hub, then to the region\'s matchmaker when it is another one; released when either released', async () => {
  const w = await makeHubWorld();
  const a = pid();
  const t = await accountToken(a);
  assert.equal((await w.queue(t, { api: 2, mode: '2v2', region: 'EU' })).json.status, 'waiting');
  const r = await w.post('/api/leave', { region: 'EU' }, t);
  assert.deepEqual(r.json, { ok: true, left: true, released: false });
  assert.deepEqual(w.mmCalls.filter((c) => c.path === '/leave').map((c) => c.name), ['mm:SA', 'mm:EU']);
  // A lobby's P2P room lock in EU: freed there.
  const room = await w.call('/custom', { kind: 'p2p', mode: '1v1', members: [{ playerId: a, name: 'A', team: 0, guest: false }, { playerId: pid(), name: 'B', team: 1, guest: false }], matchLengthSeconds: 300 }, 'EU');
  assert.equal(room.status, 200);
  const r2 = await w.post('/api/leave', { region: 'EU' }, t);
  assert.deepEqual(r2.json, { ok: true, left: false, released: true }, 'the region released it');
  const sa = await w.post('/api/leave', { region: 'SA' }, t);
  assert.equal(w.mmCalls.filter((c) => c.path === '/leave').length, 5, 'the hub only, when the region is the hub');
  assert.equal(sa.status, 200);
});

test('Worker /api/population: the hub\'s numbers for the region and searching for every region', async () => {
  const w = await makeHubWorld();
  await w.join(pid(), { home: 'EU', prefer: '1v1' });
  await w.join(pid(), { home: 'NA' });
  await w.join(pid(), { kind: 'ranked', mode: '3v3', home: 'EU' });
  const r = await w.get('/api/population?region=EU');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { region: 'EU', casual: { '1v1': 1, '2v2': 0, '3v3': 0 }, ranked: { '1v1': 0, '2v2': 0, '3v3': 1 }, playing: 0, lobbies: 2, searching: { casual: 2, ranked: 1 } });
  assert.ok(w.mmCalls.some((c) => c.name === 'mm:SA' && c.path === '/population' && c.query.home === 'EU'));
});

test('Worker: POST /api/lobbies and /api/lobbies/join without api >= 2 answer 426 reload_required (guests and accounts), before any object call', async () => {
  const w = await makeHubWorld();
  for (const token of [await guestToken(pid()), await accountToken(pid())]) {
    const c = await w.post('/api/lobbies', { mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 180 }, token);
    assert.deepEqual([c.status, c.json.error, c.json.message], [426, 'reload_required', 'Hay una versión nueva del juego: recarga la página']);
    const j = await w.post('/api/lobbies/join', { code: 'ABCDEF' }, token);
    assert.deepEqual([j.status, j.json.error], [426, 'reload_required']);
  }
  const ok = await w.post('/api/lobbies', { api: 2, mode: '2v2', visibility: 'public', net: 'server', matchLengthSeconds: 180 }, await guestToken(pid()));
  assert.equal(ok.status, 200, 'with the marker: as before (net is read as P2P by the lobby)');
});

test('the old no-show 429 and the capacity 503 are gone from the queue: a join is refused only by its own lock (409)', async () => {
  const w = await makeHubWorld({ rooms: M.MAX_ACTIVE_ROOMS });
  const a = pid();
  const r = await w.join(a, { kind: 'p2p' });
  assert.deepEqual([r.status, r.json.status], [200, 'waiting']);
  assert.equal(M.P2P_FILL_WAIT, 15_000, 'kept, dormant');
});
