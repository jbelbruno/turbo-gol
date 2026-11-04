// Local play while a search runs (src/game/waitPlay.ts; the modes redesign, November 2026, spec
// §3.4, §3.5): bots or training start only while a search queues; the hand-off gives the match the
// search's kind; QUIT keeps the search; a search that died keeps the local activity (the bots match
// still unlimited) and offers SEARCH AGAIN; CANCEL SEARCH from the pause; the next pack level keeps
// the session; every exit puts the timed match back. Also OnlineSession.onFound: it fires from the
// queue's answer, with no frame (a hidden tab runs none), and the menus' "While you search" sheet's
// copy and its Game wiring.
//   node --test tests/wait-play.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const W = await import('../src/game/waitPlay.ts');
const { NetClient } = await import('../src/net/NetClient.ts');
const { OnlineSession } = await import('../src/game/OnlineSession.ts');

const BOTS = { play: 'bots', searching: true, ended: null };
const TRAINING = { play: 'training', searching: true, ended: null };

test('bots or training start only while a search queues; one local play to the other keeps the search', () => {
  assert.deepEqual(W.startWait(W.WAIT_OFF, 'bots', true), BOTS);
  assert.deepEqual(W.startWait(W.WAIT_OFF, 'training', true), TRAINING);
  assert.equal(W.startWait(W.WAIT_OFF, 'bots', false), null, 'no search queueing: nothing starts (a plain match does)');
  assert.deepEqual(W.startWait(TRAINING, 'bots', true), BOTS);
  assert.equal(W.startWait({ play: 'entering', searching: false, ended: null }, 'bots', true), null, 'its match is on the way');
  assert.equal(W.matchOf(BOTS), 'wait', "the bots match is the unlimited one");
  assert.equal(W.matchOf(TRAINING), 'timed');
  assert.equal(W.queueLocal(BOTS), 'bots', "the queue's `local` (the counters)");
  assert.equal(W.queueLocal(TRAINING), 'training');
  assert.equal(W.queueLocal(W.WAIT_OFF), null);
});

test("the hand-off: the search left its queue, local play ends (its score lost), the match kind is the search's, the match on its way", () => {
  const h = W.handOff(BOTS, 'ranked');
  assert.deepEqual(h, { state: { play: 'entering', searching: false, ended: null }, matchKind: 'ranked' });
  assert.deepEqual(W.handOff(TRAINING, 'casual').matchKind, 'casual');
  assert.equal(W.handOff(W.WAIT_OFF, 'casual'), null, 'nothing waits');
  assert.equal(W.handOff({ ...BOTS, searching: false }, 'casual'), null, 'a search that died finds no match');
  assert.equal(W.matchOf(h.state), 'timed', 'the timed match back');
  assert.equal(W.queueLocal(h.state), null);
  // On screen: off; a failed connect: off and the menus.
  assert.deepEqual(W.entered(h.state), W.WAIT_OFF);
  assert.deepEqual(W.enterFailed(h.state), { state: W.WAIT_OFF, menus: true });
  assert.deepEqual(W.enterFailed(BOTS), { state: BOTS, menus: false }, 'only a match on its way');
});

test('QUIT keeps a running search (back to the menus still searching); after it died, just the menus', () => {
  assert.deepEqual(W.quitWait(BOTS), { state: W.WAIT_OFF, keepSearch: true });
  assert.deepEqual(W.quitWait(TRAINING), { state: W.WAIT_OFF, keepSearch: true });
  assert.deepEqual(W.quitWait({ ...BOTS, searching: false }), { state: W.WAIT_OFF, keepSearch: false });
  assert.equal(W.matchOf(W.quitWait(BOTS).state), 'timed', 'the unlimited match goes with the quit');
});

test('a search that died keeps the local activity (the bots match still unlimited), says why, and offers SEARCH AGAIN', () => {
  const died = W.searchDied(BOTS, 'Matchmaking is paused, try again later');
  assert.deepEqual(died, { play: 'bots', searching: false, ended: 'Matchmaking is paused, try again later' });
  assert.equal(W.matchOf(died), 'wait', 'still unlimited');
  assert.equal(W.queueLocal(died), null, 'no search to tell');
  assert.equal(W.pauseSearchEntry(died), 'searchAgain');
  const again = W.searchAgain(died);
  assert.deepEqual(again, BOTS, 'the same request again, the play goes on');
  assert.equal(W.pauseSearchEntry(again), 'cancelSearch');
  assert.deepEqual(W.searchDied(W.WAIT_OFF, 'x'), W.WAIT_OFF, 'nothing local: nothing to keep');
  assert.deepEqual(W.searchAgain(BOTS), BOTS, 'still searching: no-op');
});

test('CANCEL SEARCH from the pause: the search goes, the local play stays, no reason to tell', () => {
  const cancelled = W.searchDied(TRAINING, null);
  assert.deepEqual(cancelled, { play: 'training', searching: false, ended: null });
  assert.equal(W.pauseSearchEntry(cancelled), 'searchAgain');
  assert.equal(W.pauseSearchEntry(TRAINING), 'cancelSearch');
  assert.equal(W.pauseSearchEntry(W.WAIT_OFF), null, 'the usual pause');
});

test('the next pack level keeps the session while it waits (and only then)', () => {
  assert.equal(W.nextLevelKeeps(TRAINING), true);
  assert.equal(W.nextLevelKeeps({ ...TRAINING, searching: false }), false);
  assert.equal(W.nextLevelKeeps(BOTS), false);
  assert.equal(W.nextLevelKeeps(W.WAIT_OFF), false);
});

test('every exit puts the timed match back: the hand-off, QUIT, on screen, a failed connect', () => {
  const exits = [W.handOff(BOTS, 'casual').state, W.quitWait(BOTS).state, W.entered({ play: 'entering', searching: false, ended: null }), W.enterFailed({ play: 'entering', searching: false, ended: null }).state];
  for (const s of exits) assert.equal(W.matchOf(s), 'timed', JSON.stringify(s));
});

// ---- OnlineSession.onFound: from the queue's answer, no frame -----------------------------------

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('OnlineSession.onFound fires as the queue answers with a match (no frame needed: a hidden tab runs none); wait / waitAt / retrying while it queues', async () => {
  let queued = 0;
  const client = new NetClient({
    storage: null,
    fetchFn: async (url) => {
      if (url === '/api/config') return jsonResponse(200, { turnstileSiteKey: null, protocol: 0 });
      if (url === '/api/guest') return jsonResponse(200, { playerId: 'p1', name: 'T', session: 's', expiresAt: Date.now() + 864e5 });
      if (url === '/api/queue') {
        queued++;
        if (queued === 1) return jsonResponse(200, { status: 'waiting', waiting: 1, region: 'SA', wait: { searching: 2, searchingHere: 1, waitedMs: 0, widened: false, widenInMs: 60_000, estimateMs: 30_000, estimateKind: 'humans', botsInMs: 300_000, busy: false } });
        return jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 't', wsUrl: '/ws/m1', mode: '2v2', host: 'SA', humans: 2 });
      }
      return jsonResponse(404, {});
    },
    webSocketFactory: () => ({ binaryType: 'blob', readyState: 0, protocol: '', onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }),
    pingIntervalMs: 1e9,
    visible: () => true,
  });
  const game = { sim: {}, hud: { netVisible: false }, restoreOfflineRoster() {}, onOnlineDisconnected() {} };
  const s = new OnlineSession(game, { client });
  const found = [];
  const waits = [];
  s.onFound = () => found.push(s.state);
  client.onTurnstile = null;
  const origQueue = client.queue.bind(client);
  client.queue = (mode, kind, onWaiting) =>
    origQueue(mode, kind, (n, w) => {
      waits.push({ n, w, wait: s.wait, at: s.waitAt, answers: s.waitingAnswers, retrying: s.retrying });
      onWaiting(n, w);
    });
  s.quickMatch('2v2', '', 'server');
  for (let i = 0; i < 20 && found.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(found, ['connecting'], 'once, as the state left the queue for the match');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].w.estimateKind, 'humans');
  assert.equal(waits[0].wait.searching, 2, "the session's wait while it queued");
  assert.equal(waits[0].answers, 1);
  assert.equal(waits[0].retrying, false);
  assert.deepEqual(client.lastMatched, { mode: '2v2', host: 'SA', humans: 2 }, "the found band's line");
  assert.equal(s.wait, null, 'no wait once it left the queue');
});

test("the Game's wiring (Game.ts cannot load under node): onFound plays the cue and sets the tab's title; the band stays in the frame", async () => {
  const game = await readFile(new URL('../src/game/Game.ts', import.meta.url), 'utf8');
  assert.match(game, /online\.onFound = \(\) => this\.foundNotify\(\);/);
  assert.match(game, /private foundNotify\(\): void \{\s*this\.foundCued = true;\s*this\.audio\.play\('matchFound'\);\s*this\.found\.tab\(\);/);
  assert.match(game, /if \(!this\.foundCued\) this\.audio\.play\('matchFound'\);/, 'matchFound() never plays the cue twice');
  // The hand-off from the socket callbacks too (a hidden tab), and the wait's MenuHost.
  assert.match(game, /applyOnlineRoster\(w: Welcome, cars\?: ReadonlyArray<CarId \| null> \| null\): void \{\s*\/\/[^\n]*\n\s*this\.waitToMatch\(true\);/);
  assert.match(game, /startTraining: \(id, opts\) => \{\s*\/\/[^\n]*\n\s*if \(game\.searchQueueing\(\)\) \{\s*game\.startWaitTraining\(id\);/);
  assert.match(game, /playFriendly: \(mode, difficulty\) => \{\s*\/\/[^\n]*\n\s*if \(game\.searchQueueing\(\)\) \{\s*game\.startWaitBots\(mode, difficulty\);/);
  assert.match(game, /private readonly waitMatch = new Match\(\{ lengthSeconds: 0 \}\);/, 'the unlimited match without touching Match.ts');
  const found = await readFile(new URL('../src/ui/screens/match/found.ts', import.meta.url), 'utf8');
  assert.match(found, /\n  tab\(\): void \{/);
});

// ---- round 2 ------------------------------------------------------------------------------------

const REGION_IDS = ['SA', 'NA', 'EU', 'AS', 'OC', 'AF'];
const isRegion = (v) => typeof v === 'string' && REGION_IDS.includes(v);

test("PARTIDO ENCONTRADO's line: the answer's format and host; without its format (a 409 rejoin, an older server) today's line with the search's formats", () => {
  const casual = { kind: 'casual', modes: ['2v2'], region: null };
  assert.deepEqual(W.foundParts(casual, { mode: '3v3', host: 'EU', humans: 5 }, 'SA', isRegion), { kind: 'casual', modes: ['3v3'], region: 'EU' }, 'Casual · 3v3 · Europa');
  assert.deepEqual(W.foundParts(casual, { mode: '2v2', host: 'node:sao-paulo-1' }, 'SA', isRegion), { kind: 'casual', modes: ['2v2'], region: 'SA' }, 'a host that is no region: the search\'s own');
  assert.deepEqual(W.foundParts(casual, {}, 'SA', isRegion), { kind: 'casual', modes: ['2v2'], region: 'SA' }, 'no mode: the formats, not a bare "Casual · Sudamérica"');
  assert.deepEqual(W.foundParts(casual, null, null, isRegion), { kind: 'casual', modes: ['2v2'], region: null });
  const ranked = { kind: 'ranked', modes: ['1v1', '3v3'], region: 'NA' };
  assert.deepEqual(W.foundParts(ranked, { host: 'EU' }, 'SA', isRegion), { kind: 'ranked', modes: ['1v1', '3v3'], region: 'NA' }, "today's line whole: the search's region too");
  assert.deepEqual(W.foundParts(ranked, { mode: '1v1', host: 'NA' }, 'SA', isRegion), { kind: 'ranked', modes: ['1v1'], region: 'NA' });
});

/** A method of Game.ts, from its signature to its closing brace. */
function method(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, signature);
  return src.slice(at, src.indexOf('\n  }\n', at));
}

test('every way out of the unlimited bots match puts the timed match back (useMatch(timedMatch)): QUIT, the menus, the hand-off, a new match', async () => {
  const game = await readFile(new URL('../src/game/Game.ts', import.meta.url), 'utf8');
  for (const sig of ['private quitWaitBots(): void {', 'private showMenu(keepSearch = false): void {', 'private waitToMatch(force = false): void {', 'startMatch(): void {']) {
    assert.match(method(game, sig), /this\.useMatch\(this\.timedMatch\);/, sig);
  }
  assert.match(method(game, 'private showMenu(keepSearch = false): void {'), /if \(this\.match === this\.waitMatch\) \{\s*this\.useMatch\(this\.timedMatch\);\s*this\.resetToKickoff\(\);/);
  assert.match(method(game, 'private useMatch(m: Match): void {'), /this\.match\.reset\(\);\s*this\.match = m;\s*m\.reset\(\);/, 'the other one reset');
});

test("the Game's round-2 wiring: no search over a busy other session, the sheet dropped once wait play starts, the clocks from the server, the band's line from foundParts", async () => {
  const game = await readFile(new URL('../src/game/Game.ts', import.meta.url), 'utf8');
  const search = method(game, 'private menuSearch(req: SearchRequest): void {');
  assert.match(search, /if \(this\.session !== null && this\.session\.busy\) this\.session\.cancel\(\);\s*\/\/[^\n]*\n\s*if \(this\.session !== null && this\.session !== online && this\.session\.state !== 'idle'\) return;/, "startOnline's guard, before anything is set");
  assert.ok(search.indexOf("this.session.state !== 'idle') return;") < search.indexOf('this.searchReq ='), 'nothing of the search is set when refused');
  assert.match(method(game, 'private setWait(next: WaitState): void {'), /if \(isLocal\(next\)\) this\.menu\.waitPlayStarted\(\);/);
  const menu = await readFile(new URL('../src/ui/Menu.ts', import.meta.url), 'utf8');
  assert.match(menu, /waitPlayStarted\(\): void \{\s*this\.waitSheetDue = false;/);
  assert.match(menu, /const step = waitSheetStep\(\{/, "Menu's rule is searchModel.ts' (tests/search-model.test.mjs)");
  // The clock: the menus' and the HUD's from the server's waitedMs once it came.
  // Final review: a search still at the terms sheet or the sign-in (no POST yet) shows 0:00, then counts from its first POST.
  assert.match(method(game, 'private searchClock(): number {'), /const queueing = online !== null && online\.state === 'queue';\s*return searchStart\(this\.searchSince, online\?\.wait \?\? null, online\?\.waitAt \?\? 0, online\?\.postedAt \?\? 0, queueing \? performance\.now\(\) : this\.searchSince\);/);
  assert.match(method(game, 'private menuSearchView(): SearchView {'), /since: this\.searchClock\(\),/);
  assert.match(method(game, 'private waitHudText(): { text: string | null; warn: boolean } {'), /since: this\.searchClock\(\)/);
  assert.match(method(game, 'private menuSearchView(): SearchView {'), /queueing: online !== null && online\.state === 'queue',\s*postedAt: online\?\.postedAt \?\? 0,\s*waitRegion: online\?\.waitRegion \?\? null,/);
  assert.match(method(game, 'matchFound(): void {'), /const p = foundParts\(req, extra, this\.menu\.regionId, isRegion\);/);
});
