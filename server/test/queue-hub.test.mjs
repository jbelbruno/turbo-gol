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

test('Worker: first: true (the first POST of a client\'s search loop) answers at once even for a waiter the hub still holds (a page reloaded mid-search); later POSTs, and a first that is not true, long-poll', async () => {
  const w = await makeHubWorld();
  const t = await accountToken(pid());
  assert.equal((await w.queue(t, { api: 2, mode: '2v2', first: true })).json.status, 'waiting', 'a new search: at once');
  w.hub().pollTimeoutMs = 30; // the long-polls below answer 'waiting' after 30 ms
  // The page reloads mid-search: its new loop's first POST finds the old waiter (not fresh).
  w.advance(5 * SEC);
  w.mmCalls.length = 0;
  const reloaded = await w.queue(t, { api: 2, mode: '2v2', first: true });
  assert.deepEqual([reloaded.status, reloaded.json.status, reloaded.json.wait.waitedMs], [200, 'waiting', 5 * SEC]);
  assert.deepEqual(w.mmCalls.map((c) => c.path), ['/join'], 'answered at once: no long-poll');
  assert.equal('first' in reloaded.json || 'fresh' in reloaded.json, false);
  for (const first of [undefined, false, 'true', 1, {}]) {
    w.mmCalls.length = 0;
    const r = await w.queue(t, { api: 2, mode: '2v2', ...(first !== undefined ? { first } : {}) });
    assert.equal(r.json.status, 'waiting');
    assert.deepEqual(w.mmCalls.map((c) => c.path), ['/join', '/poll'], JSON.stringify(first) + ': long-polls');
  }
});

test('Worker and hub: an unknown kind is 400 bad_kind, and its message names every kind still read (p2p too)', async () => {
  const w = await makeHubWorld();
  const message = "kind must be 'server' | 'ranked' ('p2p', from an older page, is read as 'server')";
  const r = await w.queue(await accountToken(pid()), { api: 2, mode: '2v2', kind: 'lobby' });
  assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'bad_kind', message]);
  const h = await w.join(pid(), { kind: 'lobby' });
  assert.deepEqual([h.status, h.json.error, h.json.message], [400, 'bad_kind', message]);
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

test("the bots' level of a Casual MatchDO match: the KV flag bot_level (hard when unset or junk), pooled and solo alike; a ranked match carries none (RoomHost's medium for a leaver's car)", async () => {
  for (const [flags, want] of [[{}, 'hard'], [{ bot_level: 'easy' }, 'easy'], [{ bot_level: ' MEDIUM ' }, 'medium'], [{ bot_level: 'expert' }, 'hard'], [{ bot_level: '' }, 'hard']]) {
    const w = await makeHubWorld({ flags });
    await w.join(pid());
    assert.equal((await w.join(pid())).json.status, 'matched');
    assert.equal(w.created()[0].body.botDifficulty, want, JSON.stringify(flags));
  }
  const s = await makeHubWorld({ flags: { bot_level: 'medium' } });
  const a = pid();
  await s.join(a);
  s.advance(Q.SOLO_AFTER_MS);
  assert.equal((await s.join(a)).json.humans, 1, 'the 5:00 solo match');
  assert.equal(s.created()[0].body.botDifficulty, 'medium');
  // Ranked: no level whatever the flag says (a flip must never change how the counted mode plays).
  const r = await makeHubWorld({ flags: { bot_level: 'easy' } });
  await r.join(pid(), { kind: 'ranked', mode: '1v1' });
  assert.equal((await r.join(pid(), { kind: 'ranked', mode: '1v1' })).json.status, 'matched');
  const create = r.created()[0].body;
  assert.equal(create.ranked, true);
  assert.equal('botDifficulty' in create, false);
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

// ---- the hub's eviction (review round 2, A1-A2): a quiet hub leaves memory, its searches do not ----------

test('a dropped search outlives the hub\'s eviction: 150 s of silence (the hub evicted), the next join restores its clock; one write per drop and per restore, none per poll', async () => {
  const w = await makeHubWorld();
  const a = pid();
  const t0 = w.time();
  await w.join(a);
  await hold(w, [[a, {}]], 2 * MIN); // polls: no 'recent:' write
  assert.equal(w.storage().writes('recent:').length, 0, 'never one per poll');
  const lastPost = w.time();
  w.advance(41 * SEC);
  await w.hub().sweep(); // the phone is locked: its pass drops A
  assert.deepEqual(w.storage().map.get('recent:' + a), { joinedAt: t0, kind: 'server', home: 'SA', until: w.time() + Q.RECENT_MS, stale: true });
  await w.evict(); // nobody polls: the idle hub leaves memory
  w.advance(lastPost + 150 * SEC - w.time());
  const back = await w.join(a);
  assert.deepEqual([back.json.status, back.json.wait.waitedMs, back.json.wait.widened], ['waiting', 2 * MIN + 150 * SEC, true], 'the clock went on');
  assert.deepEqual(w.storage().writes('recent:'), [['put', 'recent:' + a], ['delete', 'recent:' + a]], 'one write when it dropped, one when it came back');
  await w.hub().sweep();
  const day = (await w.daily(1)).days[0];
  assert.deepEqual([day.searches.casual, day.dropped.casual], [1, 0], 'no new search, no drop');
  // Past 5:00 since its first join, visible: the solo match on its next POST.
  w.advance(Q.SOLO_AFTER_MS - (w.time() - t0));
  assert.equal((await w.join(a)).json.humans, 1);
});

test('an unplayed solo match outlives the evictions (MatchDO and node): released 45 s after it formed to an evicted hub, 150 s of silence, the next join gets a new solo match at once', async () => {
  for (const nodes of [false, true]) {
    const label = nodes ? 'node' : 'MatchDO';
    const w = await makeHubWorld(nodes ? { flags: { nodes_on: '1' }, nodes: true } : {});
    const a = pid();
    await w.join(a);
    w.advance(Q.SOLO_AFTER_MS);
    const first = await w.join(a);
    assert.deepEqual([first.json.humans, first.json.node === true], [1, nodes], label);
    if (nodes) assert.ok(w.storage().map.has('solo:' + first.json.matchId), 'a node solo match\'s record is written');
    await w.evict(); // the phone locked: nobody polls
    w.advance(45 * SEC);
    // The MatchDO's unused alarm (or the node's outcome) releases it: that request wakes a new hub.
    await w.release(first.json.matchId, [a]);
    assert.equal(w.storage().map.has('solo:' + first.json.matchId), false, label + ': its record is done');
    assert.equal(w.storage().map.get('recent:' + a)?.stale, false, label + ': the search is back in `recent`, not a drop');
    await w.evict();
    w.advance(150 * SEC);
    const again = await w.join(a);
    assert.deepEqual([again.json.status, again.json.humans], ['matched', 1], label + ': a new solo match at once');
    assert.notEqual(again.json.matchId, first.json.matchId);
  }
});

test('an unplayed solo match gives its search its clock back once: a second one unplayed in a row ends the search (MatchDO and node, across evictions and a drop in between)', async () => {
  for (const nodes of [false, true]) {
    const label = nodes ? 'node' : 'MatchDO';
    const w = await makeHubWorld(nodes ? { flags: { nodes_on: '1' }, nodes: true } : {});
    const a = pid();
    await w.join(a);
    w.advance(Q.SOLO_AFTER_MS);
    const first = await w.join(a);
    assert.equal(first.json.humans, 1, label);
    w.advance(45 * SEC);
    await w.release(first.json.matchId, [a]); // unplayed: the search is back, once
    await w.evict();
    // Back with the tab hidden (no solo match yet), then dropped again: the retry is kept across the drop.
    const hidden = await w.join(a, { visible: false });
    assert.deepEqual([hidden.json.status, hidden.json.wait.waitedMs > Q.SOLO_AFTER_MS], ['waiting', true], label + ': the clock is back');
    w.advance(41 * SEC);
    noSweep(w);
    await w.hub().sweep();
    noSweep(w);
    assert.equal(w.storage().map.get('recent:' + a)?.stale, true, label + ': dropped');
    await w.evict();
    const second = await w.join(a);
    assert.deepEqual([second.json.status, second.json.humans], ['matched', 1], label + ': the second solo match at once');
    await w.evict();
    w.advance(45 * SEC);
    await w.release(second.json.matchId, [a]); // unplayed again: the search ends
    assert.equal(w.storage().map.has('recent:' + a), false, label + ': not back in `recent`');
    await w.evict();
    w.advance(30 * SEC);
    const again = await w.join(a);
    assert.deepEqual([again.json.status, again.json.wait.waitedMs], ['waiting', 0], label + ': a new search from 0:00, no third solo match');
    noSweep(w);
    assert.equal((await w.daily(1)).days[0].searches.casual, 2, label + ': counted as a new search');
  }
});

test('a dropped search that expires while the hub is evicted: the alarm wakes it at its 10 min, forgets it and counts one drop (written: nothing stays past 10 min)', async () => {
  const w = await makeHubWorld();
  const a = pid();
  const t0 = w.time();
  await w.join(a);
  w.advance(41 * SEC);
  await w.hub().sweep(); // drops A; the counters are written (the first write) and the queues are empty
  await pause(5);
  assert.equal(w.storage().alarm, w.time() + Q.RECENT_MS, 'the idle hub arms its alarm at that search\'s 10 min');
  await w.evict();
  w.advance(Q.RECENT_MS);
  await w.hub().alarm();
  await pause(5);
  assert.equal(w.storage().map.has('recent:' + a), false, 'forgotten at 10 min');
  assert.equal(w.storage().map.get('stats:2026-11-04').dropped.casual, 1, 'counted and written');
  assert.equal(w.hub().alarmAt, t0 + Q.ARRIVALS_WINDOW_MS + 1, 'what is left: its arrival\'s hour (the arrivals row)');
  await w.evict();
  await w.hub().alarm();
  await pause(5);
  assert.equal((await w.daily(1)).days[0].dropped.casual, 1, 'counted once');
});

test('the estimate outlives an eviction: the arrivals ring is one row written with the counters (no id); 30 searches in the hour still read "humans ~2 min" after it', async () => {
  const w = await makeHubWorld();
  for (let i = 0; i < 15; i++) {
    await w.join(pid());
    w.advance(SEC);
    assert.equal((await w.join(pid())).json.status, 'matched', `pair ${i}`);
    w.advance(SEC);
  }
  await pause(5);
  // The first formation wrote the counters (and the ring with them); the other 14 waited for the minute.
  assert.equal(w.storage().writes('arrivals').length, 1, 'never per request');
  w.advance(60 * SEC);
  await w.hub().alarm(); // the end of the minute: the rest
  await pause(5);
  assert.equal(w.storage().writes('arrivals').length, 2, 'two writes for 30 searches');
  const row = w.storage().map.get('arrivals');
  assert.equal(row.a.length, 30 * 3);
  assert.doesNotMatch(JSON.stringify(row), /[0-9a-f]{16}/, 'no id');
  await w.evict();
  const b = await w.join(pid());
  assert.deepEqual([b.json.wait.estimateKind, b.json.wait.estimateMs], ['humans', 2 * MIN], '30 others in the hour: one every 2 min');
});

test('a cancelled search is no arrival: 14 searches cancelled (leaves, a change of kind, a dropped one left) read as nobody else, "bots 300000"; a search that formed still counts', async () => {
  const w = await makeHubWorld();
  const x = pid();
  for (let i = 0; i < 12; i++) {
    await w.join(x);
    await w.leave(x);
    w.advance(SEC);
  }
  await w.join(x);
  w.advance(SEC);
  await w.join(x, { kind: 'ranked', mode: '1v1' }); // a change of kind cancels the Casual search
  await w.leave(x); // and this one the ranked search
  const y = pid();
  await w.join(y, { home: 'EU' });
  w.advance(41 * SEC);
  noSweep(w);
  await w.hub().sweep(); // Y dropped (a locked phone) ...
  noSweep(w);
  await w.leave(y); // ... then cancelled
  const day = (await w.daily(1)).days[0];
  assert.deepEqual([day.searches.casual, day.cancelled.casual, day.cancelled.ranked], [14, 14, 1], 'every one counted as a search and as a cancel');
  const z = await w.join(pid());
  assert.deepEqual([z.json.wait.estimateKind, z.json.wait.estimateMs], ['bots', Q.SOLO_AFTER_MS], 'no other arrival in the hour');
  // A search that formed a match is a real arrival, and a waiting one too: the stored row, once
  // the minute is up, holds Z, the one it paired with and the newest waiter, nothing cancelled.
  assert.equal((await w.join(pid())).json.status, 'matched');
  assert.equal((await w.join(pid())).json.status, 'waiting');
  w.advance(MIN);
  noSweep(w);
  await w.hub().sweep();
  noSweep(w);
  await pause(5);
  assert.equal(w.storage().map.get('arrivals').a.length, 3 * 3);
});

test('the stored arrivals keep only the last hour: an idle hub writes the row again as its arrivals pass their hour, and deletes it after the last one (no new search needed)', async () => {
  const w = await makeHubWorld();
  const t0 = w.time();
  await w.join(pid());
  await w.join(pid()); // a pair: two arrivals; the first write (the row with them)
  w.advance(20 * MIN);
  await w.join(pid());
  await w.join(pid()); // two more, written with that pair's counts
  noSweep(w);
  await pause(5);
  const entries = () => (w.storage().map.get('arrivals')?.a.length ?? 0) / 3;
  assert.equal(entries(), 4);
  assert.equal(w.storage().alarm, t0 + Q.ARRIVALS_WINDOW_MS + 1, 'armed for the oldest arrival\'s hour');
  await w.evict(); // idle: nothing else wakes it
  w.advance(w.storage().alarm - w.time());
  await w.hub().alarm();
  await pause(5);
  assert.equal(entries(), 2, 'the first two are past their hour: the row is written without them');
  assert.equal(w.storage().alarm, t0 + 20 * MIN + Q.ARRIVALS_WINDOW_MS + 1, 'then for the next one\'s');
  await w.evict();
  w.advance(w.storage().alarm - w.time());
  await w.hub().alarm();
  await pause(5);
  assert.equal(w.storage().map.has('arrivals'), false, 'none left: the row is deleted');
  assert.equal(w.hub().alarmAt, null, 'nothing left to wake for');
  assert.equal((await w.daily(1)).days[0].formed.casual['2'], 2, 'the counters were written meanwhile');
  // With somebody queued the whole time (a ranked search past the hour), the sweep does it.
  const v = await makeHubWorld();
  await v.join(pid());
  await v.join(pid());
  v.advance(MIN);
  const r = pid();
  const ranked = { kind: 'ranked', mode: '1v1' };
  await v.join(r, ranked);
  v.advance(MIN);
  await v.hub().sweep(); // the minute is up: the row with all three
  await pause(5);
  assert.equal(v.storage().map.get('arrivals').a.length, 3 * 3);
  await hold(v, [[r, ranked]], 58 * MIN + 30 * SEC); // 60.5 min after the pair, 59.5 after the ranked search
  await v.hub().sweep();
  noSweep(v);
  await pause(5);
  assert.deepEqual(v.storage().map.get('arrivals').a, [0, 1, 0], 'only the ranked search is left (its kind 1, home SA)');
});

test('a leave or a release with nobody queued runs no pass: the idle alarm is armed by the request itself, and a regional room release reads no KV', async () => {
  const w = await makeHubWorld({ flags: { nodes_on: '1' }, nodes: true });
  await w.join(pid());
  await w.join(pid()); // formed: the first write of the counters
  await pause(5);
  const firstAt = w.time();
  w.advance(5 * SEC);
  const c = pid();
  await w.join(c);
  await w.leave(c);
  await pause(5); // well before any 500 ms sweep
  assert.equal(w.storage().alarm, firstAt + 60 * SEC, 'the leave armed it: the counts are written once the minute is up');
  noSweep(w); // the hub's own sweep (the joins scheduled it) is not what this counts
  const reads = [];
  const get = w.env.FLAGS.get;
  w.env.FLAGS.get = async (k, o) => (reads.push(k), get(k, o));
  for (let i = 0; i < 3; i++) {
    assert.equal((await w.call('/release', { matchId: hex64(), playerIds: [] }, 'EU')).status, 200);
    w.advance(11 * SEC);
  }
  await pause(700);
  assert.deepEqual(reads, [], 'a lobby room\'s release in mm:EU: no pass, so no nodes_on read');
});

test('a release with nobody queued arms the idle alarm itself: an unplayed solo match\'s search, back in `recent`, is forgotten on time at its 10 min', async () => {
  const w = await makeHubWorld();
  const a = pid();
  const t0 = w.time();
  await w.join(a);
  w.advance(Q.SOLO_AFTER_MS);
  const solo = await w.join(a); // the first formation writes the counters: nothing pending
  noSweep(w);
  await pause(5);
  assert.equal(solo.json.humans, 1);
  assert.equal(w.storage().alarm, t0 + Q.ARRIVALS_WINDOW_MS + 1, 'only its arrival\'s hour');
  w.advance(45 * SEC);
  await w.release(solo.json.matchId, [a]);
  await pause(5);
  assert.equal(w.storage().map.get('recent:' + a)?.stale, false, 'back in `recent`');
  assert.equal(w.storage().alarm, w.time() + Q.RECENT_MS, 'the release armed the alarm for that search\'s 10 min');
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

// ---- the passes (review round 2: A5, A6, A7, A11) ---------------------------------------------------------

/** No sweep in the way (it runs on a 500 ms real timer): the test drives every pass itself. */
function noSweep(w) {
  const h = w.hub();
  if (h.sweepTimer) clearTimeout(h.sweepTimer);
  h.sweepTimer = null;
}

/** MatchDO creates fail once (`fail`), or wait for `gate`. */
function matchCreates(w, { fail = false, gate = null } = {}) {
  const real = w.env.MATCH;
  let failing = fail;
  w.env.MATCH = {
    ...real,
    get: (id, opts) => {
      const stub = real.get(id, opts);
      return {
        fetch: async (url, init) => {
          if (new URL(url).pathname === '/internal/create') {
            if (failing) {
              failing = false;
              return new Response('boom', { status: 500 });
            }
            if (gate) await gate;
          }
          return stub.fetch(url, init);
        },
      };
    },
  };
}

test('A6: a waiter in its back-off (its formation just failed) holds nobody back: a fresh SA pair forms at once beside it', async () => {
  const w = await makeHubWorld();
  matchCreates(w, { fail: true });
  const old = pid();
  await w.join(old, { home: 'EU' });
  w.advance(Q.SOLO_AFTER_MS);
  const r = await w.join(old, { home: 'EU' }); // its solo match's create fails: a 5 s back-off
  assert.deepEqual([r.json.status, w.created().length], ['waiting', 0]);
  const [s1, s2] = [pid(), pid()];
  await w.join(s1);
  const pair = await w.join(s2);
  assert.deepEqual([pair.json.status, pair.json.humans, pair.json.host], ['matched', 2, 'SA'], 'the widened waiter in its back-off no longer takes them into its group');
  w.advance(5 * SEC);
  assert.equal((await w.join(old, { home: 'EU' })).json.humans, 1, 'its back-off over: its solo match');
});

test('A7: a join waits for its own formation only: a pass that starts another group\'s formation answers at once', async () => {
  const w = await makeHubWorld({ rooms: M.MAX_ACTIVE_ROOMS - M.RANKED_RESERVED_ROOMS });
  const [a, b] = [pid(), pid()];
  await w.join(a);
  assert.equal((await w.join(b)).json.wait.busy, true, 'held by the cap');
  let open;
  matchCreates(w, { gate: new Promise((r) => (open = r)) });
  const room = [...w.storage().map.keys()].find((k) => k.startsWith('room:')).slice('room:'.length);
  await w.release(room, []); // a slot frees: the next pass forms A and B (their MatchDO create waits)
  noSweep(w);
  const c = await Promise.race([w.join(pid(), { home: 'EU' }), pause(300).then(() => 'late')]);
  assert.notEqual(c, 'late', 'C\'s first answer does not wait for A and B\'s match');
  assert.deepEqual([c.json.status, c.json.wait.waitedMs], ['waiting', 0]);
  const pollA = w.call('/poll?playerId=' + a); // A's long-poll waits on its formation
  open();
  assert.deepEqual([(await pollA).json.status, (await w.join(b)).json.status], ['matched', 'matched']);
});

test('A5: a ranked pair held by the cap after a formation (no node free, no MatchDO slot) reads busy through its back-off, not busy-then-not', async () => {
  const w = await makeHubWorld({ flags: { nodes_on: '1' }, nodes: true, rooms: M.MAX_ACTIVE_ROOMS });
  w.control.place = () => ({ placement: null, hosts: 1 }); // a node, none free now
  const ro = { kind: 'ranked', mode: '1v1' };
  const [a, b] = [pid(), pid()];
  await w.join(a, ro);
  const rb = await w.join(b, ro);
  assert.deepEqual([rb.json.status, rb.json.wait.busy, rb.json.wait.estimateKind], ['waiting', true, 'none']);
  for (const step of [1, 2, 1.5]) {
    w.advance(step * SEC);
    for (const id of [a, b]) assert.equal((await w.join(id, ro)).json.wait.busy, true, `${id === a ? 'A' : 'B'} still busy in its back-off`);
  }
  assert.equal(w.control.of('/internal/place').length, 1, 'not asked again within the back-off');
});

test('A11: the long-poll\'s timer forms a due 5:00 solo match before it answers (no "waiting" with botsInMs 0 just before the match)', async () => {
  const w = await makeHubWorld();
  const a = pid();
  await w.join(a);
  w.hub().pollTimeoutMs = 50;
  w.advance(Q.SOLO_AFTER_MS - 1);
  assert.equal((await w.join(a)).json.status, 'waiting');
  const polling = w.call('/poll?playerId=' + a);
  await pause(10);
  noSweep(w); // the sweep would form it too: this test is about the poll's own timer
  w.advance(1); // the 5:00 is due while the long-poll waits
  const r = await polling;
  assert.deepEqual([r.json.status, r.json.humans], ['matched', 1]);
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
