// A lone host plays while the lobby waits (src/game/roomPlay.ts; the modes redesign, step 2, spec
// §3.8, §5.4): VS BOTS · TRAIN start only for a lone host with nothing else on; someone coming in
// brings the Sala back with "{name} joined your lobby"; the lobby gone goes to the menus; a running
// search hides the buttons (and the Game never runs both); a lobby socket reconnecting does not end
// it (on a real LobbyClient over fake sockets); every way out puts the timed match back; the Sala's
// sticky foot keeps the lines in sight on a short screen. The Game's and the Sala's wiring is
// pinned in their sources (Game.ts cannot load under node).
//   node --test tests/room-play.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const R = await import('../src/game/roomPlay.ts');
const { LobbyClient } = await import('../src/net/LobbyClient.ts');
const { t } = await import('../src/i18n.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const src = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');
/** A method of a class source, from its signature to its closing brace. */
function method(text, signature) {
  const at = text.indexOf(signature);
  assert.ok(at >= 0, signature);
  return text.slice(at, text.indexOf('\n  }\n', at));
}

const LONE = { status: 'open', host: true, members: 1, lobby: 'open' };
const FREE = { session: false, waitPlay: false };

test('VS BOTS · TRAIN start only for a lone host in an open, connected lobby, with nothing else on', () => {
  assert.equal(R.roomPlayOffered('off', LONE, FREE), true);
  assert.equal(R.startRoom('off', 'bots', LONE, FREE), 'bots');
  assert.equal(R.startRoom('off', 'training', LONE, FREE), 'training');
  const no = [
    [{ ...LONE, host: false }, 'a member that does not host'],
    [{ ...LONE, members: 2 }, 'somebody is there: START, not local play'],
    [{ ...LONE, status: 'reconnecting' }, 'the lobby socket away'],
    [{ ...LONE, status: 'connecting', members: 0, lobby: null }, 'no state yet'],
    [{ ...LONE, status: 'closed' }, 'the lobby went'],
    [{ ...LONE, lobby: 'starting' }, 'the lobby starting its match'],
    [{ ...LONE, lobby: 'in_game' }, 'the lobby playing its match'],
  ];
  for (const [room, why] of no) {
    assert.equal(R.roomPlayOffered('off', room, FREE), false, why);
    assert.equal(R.startRoom('off', 'bots', room, FREE), null, why);
  }
  assert.equal(R.startRoom('bots', 'training', LONE, FREE), null, 'already playing');
  assert.equal(R.startRoom('off', 'bots', LONE, { session: false, waitPlay: true }), null, 'over wait play: never');
});

test('a running search hides the buttons and nothing starts (it wins; the Game never runs both)', async () => {
  const searching = { session: true, waitPlay: false };
  assert.equal(R.roomPlayOffered('off', LONE, searching), false);
  assert.equal(R.startRoom('off', 'bots', LONE, searching), null);
  assert.equal(R.startRoom('off', 'training', LONE, searching), null);
  const game = await src('src/game/Game.ts');
  // Any session up counts (a search queueing, a match connecting or on).
  assert.match(method(game, 'private roomBusy(): RoomBusy {'), /session: s !== null && s\.state !== 'idle', waitPlay: this\.wait\.play !== 'off'/);
  // A search that starts anyway ends the room play first (back to the Sala), before the search is set.
  const search = method(game, 'private menuSearch(req: SearchRequest): void {');
  assert.match(search, /if \(this\.roomPlay !== 'off'\) this\.leaveRoomPlay\(\);/);
  assert.ok(search.indexOf('this.leaveRoomPlay();') < search.indexOf('this.searchReq ='));
  // A session taking the loop (the search's, a lobby's match) ends it too.
  assert.match(method(game, 'setSession(s: GameSession | null): void {'), /if \(s !== null\) this\.endRoomPlay\(\);/);
  // The Sala: the row follows offered() on every render, and on the menus' tick (a search started or ended elsewhere).
  const lobby = await src('src/ui/screens/lobby.ts');
  assert.match(lobby, /waitRow\.hidden = !playOffered\(\);/);
  assert.match(lobby, /tick: \(\) => \{\s*if \(shown && state\(\) !== null && waitRow\.hidden === playOffered\(\)\) render\(\);/);
  assert.match(lobby, /const playOffered = \(\): boolean => roomPlay !== null && roomPlay\.offered\(\);/);
  assert.match(game, /offered: \(\) => roomPlayOffered\(this\.roomPlay, this\.roomView\(\), this\.roomBusy\(\)\),/);
});

test('someone came in: back to the Sala, with "{name} joined your lobby" for the newest member', async () => {
  assert.equal(R.roomStep('bots', { ...LONE, members: 2 }), 'back');
  assert.equal(R.roomStep('training', { ...LONE, members: 3 }), 'back');
  assert.equal(R.roomStep('bots', { ...LONE, host: false }), 'back', 'not the lone host any more');
  assert.equal(R.roomStep('bots', LONE), 'stay', 'still alone: it goes on');
  assert.equal(R.roomStep('off', { ...LONE, members: 2 }), 'stay', 'nothing local: nothing to do');
  const members = [{ id: 'm1', name: 'Ana' }, { id: 'm2', name: 'Beto' }, { id: 'm3', name: 'Caro' }];
  assert.equal(R.newcomer(members, 'm1').name, 'Caro', 'the newest that is not this player');
  assert.equal(R.newcomer(members, 'm3').name, 'Beto');
  assert.equal(R.newcomer([{ id: 'm1', name: 'Ana' }], 'm1'), null);
  assert.equal(t('lobby.joinedBack', { name: 'Caro' }), 'Caro joined your lobby');
  assert.equal(es['lobby.joinedBack'], '{name} entró a tu sala');
  const game = await src('src/game/Game.ts');
  // The cue at once, the tab's title when hidden (the lobby callback runs there), the Sala, the toast.
  const joined = method(game, 'private roomJoined(): void {');
  assert.match(joined, /const who = st !== null \? newcomer\(st\.members, st\.you\) : null;/);
  assert.match(joined, /this\.audio\.play\('matchFound'\);\s*if \(document\.hidden\) this\.found\.tab\(\);\s*this\.leaveRoomPlay\(\);/);
  assert.match(joined, /this\.roomToast\(t\('lobby\.joinedBack', \{ name: playerName\(who\.name\) \}\), 'info'\);/);
  assert.match(method(game, 'private leaveRoomPlay(): void {'), /this\.showMenu\(\);\s*if \(this\.lobby\.inLobby && this\.menu\.top\(\)\?\.id !== 'lobby'\) this\.menu\.open\('lobby'\);/);
  // A hidden tab's toast waits for the tab to be seen.
  assert.match(method(game, 'private roomToast(text: string, kind: \'info\' | \'error\'): void {'), /document\.hidden\) this\.roomNotice = \{ text, kind \};\s*else this\.menu\.toast\(text, kind\);/);
  assert.match(game, /const notice = this\.roomNotice;\s*if \(!document\.hidden && notice !== null\) \{\s*this\.roomNotice = null;\s*this\.menu\.toast\(notice\.text, notice\.kind\);/);
  // The watch runs on the lobby's own callbacks (a hidden tab runs no frames), before the Sala renders.
  const lobby = await src('src/ui/screens/lobby.ts');
  assert.match(lobby, /roomPlay\?\.changed\(\);\s*if \(shown\) render\(\);\s*\};\s*lobby\.onStatus/);
  assert.match(game, /changed: \(\) => this\.watchRoomPlay\(\),/);
});

test('the lobby gone (closed, kicked, lost, left): the menus, on the list, with the lobby\'s close text', async () => {
  assert.equal(R.roomStep('bots', { ...LONE, status: 'closed' }), 'menus');
  assert.equal(R.roomStep('training', { ...LONE, status: 'idle', members: 0, lobby: null }), 'menus', 'left without a close');
  const game = await src('src/game/Game.ts');
  assert.match(method(game, 'private roomLobbyClosed(reason: string): boolean {'), /if \(this\.roomPlay === 'off'\) return false;\s*this\.roomGone\(lobbyCloseText\(reason\), reason === 'kicked' \? 'error' : 'info'\);\s*return true;/);
  assert.match(method(game, 'private roomGone(text: string | null, kind: \'info\' | \'error\'): void {'), /this\.showMenu\(\);\s*toList\(this\.menu\);\s*if \(text !== null\) this\.roomToast\(text, kind\);/);
  // lobby.ts lets the Game take it while the host played (no second toast).
  const lobby = await src('src/ui/screens/lobby.ts');
  assert.match(lobby, /lobby\.onClosed = \(reason\) => \{\s*\/\/[^\n]*\n\s*if \(roomPlay !== null && roomPlay\.closed\(reason\)\) return;\s*menu\.toast\(lobbyCloseText\(reason\)/);
  // A lobby left with no callback at all: the frame catches it.
  assert.match(game, /if \(this\.roomPlay !== 'off' && !this\.lobby\.inLobby\) this\.watchRoomPlay\(\);/);
});

// ---- a real LobbyClient: reconnecting does not end it --------------------------------------------

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ANSWER = { lobbyId: 'L', code: 'ABC234', ticket: 'T', wsUrl: 'ws://x/lobby/L' };
const HOST = { id: 'm1', name: 'Ana', team: 0, host: true, guest: true, inGame: false };
const STATE = { code: 'ABC234', settings: { mode: '2v2' }, hasPassword: false, region: 'SA', members: [HOST], you: 'm1', status: 'open' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeWs {
  constructor() {
    this.sent = [];
    this.readyState = 0;
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Game.roomView, on a LobbyClient (pinned below). */
const view = (lc) => ({ status: lc.status, host: lc.isHost, members: lc.state?.members.length ?? 0, lobby: lc.state?.status ?? null });

test('the lobby socket reconnecting does not end it; someone in after the reconnection brings the Sala back; a reconnection that fails goes to the menus', async () => {
  const sockets = [];
  let refuse = false;
  const lc = new LobbyClient({
    fetchFn: async (url) => (url === '/api/lobbies/join' ? (refuse ? res(404, { error: 'no_lobby', message: 'x' }) : res(200, ANSWER)) : res(404, {})),
    webSocketFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    bearer: async () => 'b',
    events: null,
    reconnectDelaysMs: [5],
    reconnectWindowMs: 1_000,
  });
  try {
    // The Game's watch, as lobby.ts wires it: on every state and status, and on the close.
    let play = 'bots';
    const steps = [];
    const watch = () => {
      const step = R.roomStep(play, view(lc));
      steps.push(`${lc.status}:${step}`);
      if (step !== 'stay') play = 'off';
    };
    lc.onState = watch;
    lc.onStatus = watch;
    lc.onClosed = watch;
    await lc.join('ABC234', null);
    sockets[0].open();
    sockets[0].receive({ t: 'state', lobby: STATE });
    assert.equal(R.roomPlayOffered('off', view(lc), FREE), true, 'a lone host: the buttons');
    // The socket drops: reconnecting, the play goes on (and nothing is offered meanwhile).
    sockets[0].drop(1006);
    assert.equal(lc.status, 'reconnecting');
    assert.equal(play, 'bots');
    assert.equal(R.roomPlayOffered('off', view(lc), FREE), false);
    await tick(10);
    sockets[1].open();
    assert.equal(play, 'bots', 'back open with the same state: it goes on');
    sockets[1].receive({ t: 'state', lobby: STATE });
    assert.equal(play, 'bots');
    // Someone came in meanwhile: back to the Sala.
    sockets[1].receive({ t: 'state', lobby: { ...STATE, members: [HOST, { ...HOST, id: 'm2', name: 'Beto', host: false }] } });
    assert.equal(play, 'off');
    assert.equal(R.newcomer(lc.state.members, lc.state.you).name, 'Beto');
    assert.deepEqual(steps, ['open:stay', 'reconnecting:stay', 'open:stay', 'open:stay', 'open:back']);

    // Playing again (alone again), then a drop whose reconnection is refused: the lobby is gone.
    sockets[1].receive({ t: 'state', lobby: STATE });
    play = 'training';
    steps.length = 0;
    refuse = true;
    sockets[1].drop(1006);
    assert.equal(play, 'training', 'reconnecting: still playing');
    await tick(20);
    assert.equal(lc.status, 'closed');
    assert.equal(play, 'off');
    assert.deepEqual(steps, ['reconnecting:stay', 'closed:menus']);
  } finally {
    lc.leave();
  }
  const game = await src('src/game/Game.ts');
  assert.match(method(game, 'private roomView(): RoomView {'), /return \{ status: l\.status, host: l\.isHost, members: l\.state\?\.members\.length \?\? 0, lobby: l\.state\?\.status \?\? null \};/);
});

// ---- the strip, the pause, the timed match ----------------------------------------------------

test('the HUD strip says the lobby waits and how to go back; while reconnecting, that, as a warning', async () => {
  assert.deepEqual(R.roomStrip('ABC 234', false, t), { text: 'Lobby ABC 234 · waiting for players · Pause: back to the lobby', warn: false });
  assert.deepEqual(R.roomStrip('ABC 234', true, t), { text: 'Reconnecting to the lobby… · Pause: back to the lobby', warn: true });
  assert.equal(en['lobby.hudBack'], 'Pause: back to the lobby');
  assert.equal(es['lobby.hudBack'], 'Pausa: volver a la sala');
  const fake = (key, p) => es[key].replace('{code}', p?.code ?? '');
  assert.equal(R.roomStrip('ABC 234', false, fake).text, 'Sala ABC 234 · esperando jugadores · Pausa: volver a la sala');
  const game = await src('src/game/Game.ts');
  const hud = method(game, 'private updateRoomHud(): void {');
  assert.match(hud, /const strip = roomStrip\(code !== null \? spacedCode\(code\) : '', this\.lobby\.reconnecting, t\);/);
  assert.match(hud, /this\.trainingHud\?\.setSearch\(strip\.text\);/, "free play: the training panel's line");
  assert.match(hud, /this\.hud\.setSearch\(this\.menuShown \|\| card \? null : strip\.text, strip\.warn, 'room'\);/);
  assert.match(game, /else if \(this\.roomPlay !== 'off'\) this\.updateRoomHud\(\);/);
  // The Hud's room variant: the same strip, its kind on it.
  const hudSrc = await src('src/render/Hud.ts');
  assert.match(hudSrc, /setSearch\(text: string \| null, warn = false, kind: 'search' \| 'room' = 'search'\): void \{/);
  assert.match(hudSrc, /this\.searchStrip\.dataset\.kind = kind;/);
});

test("the pause: RESUME, SETTINGS, BACK TO THE LOBBY (QUIT's place; free play keeps its row); QUIT and training's quit go back to the Sala", async () => {
  assert.equal(R.pauseExit('bots'), 'backToLobby');
  assert.equal(R.pauseExit('training'), 'backToLobby');
  assert.equal(R.pauseExit('off'), null);
  assert.equal(en['pause.backToLobby'], 'BACK TO THE LOBBY');
  assert.equal(es['pause.backToLobby'], 'VOLVER A LA SALA');
  const game = await src('src/game/Game.ts');
  const entries = method(game, 'private pauseEntries(): PauseEntry[] {');
  assert.match(entries, /const roomBack = pauseExit\(this\.roomPlay\) !== null \? \{ id: 'back-to-lobby', kind: 'quit' as const, label: \(\) => t\('pause\.backToLobby'\), select: \(\) => this\.leaveRoomPlay\(\) \} : null;/);
  assert.match(entries, /if \(roomBack !== null\) return \[resume, settings, \{ \.\.\.roomBack, hold: true \}\];/);
  assert.match(entries, /if \(roomBack !== null\) return \[resume, \.\.\.extras, settings, roomBack\];/);
  assert.match(method(game, 'quitToMenu(): void {'), /if \(this\.roomPlay === 'bots'\) \{\s*this\.leaveRoomPlay\(\);\s*return;/);
  assert.match(method(game, 'stopTraining(): void {'), /if \(this\.roomPlay === 'training'\) \{\s*this\.leaveRoomPlay\(\);\s*return;/);
  // The Sala's buttons: a TV without a controller asks for one first (Menu.beforeMatch), then the Game.
  const lobby = await src('src/ui/screens/lobby.ts');
  assert.match(lobby, /onclick: \(\) => menu\.beforeMatch\(\(\) => roomPlay\?\.start\(kind\)\)/);
  assert.match(lobby, /h\('span\.mn-act-wait-label', null, t\('lobby\.waitLine'\)\), playBtn\('bots'\), playBtn\('training'\)\);/);
  assert.match(lobby, /t\(kind === 'bots' \? 'search\.waitBots' : 'search\.waitTraining'\)/);
});

/** Every innermost rule of a stylesheet, comments out: [{ selector, body }]. */
const cssBlocks = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

test("the Sala's foot: the need line, the bar and VS BOTS · TRAIN stay in sight on a short screen (a phone held sideways), the teams scroll under them", async () => {
  // One foot holds the three, last in the Sala: nothing sits after it, below the fold.
  const lobby = await src('src/ui/screens/lobby.ts');
  assert.match(lobby, /const foot = h\('div\.mn-sala-foot', null, need, bar, waitRow\);/);
  assert.match(lobby, /\n {4}teams,\n {4}foot,\n {2}\);/);
  // The foot is the sticky one (the bar alone sticking left the lines under it or after it).
  const css = cssBlocks(await src('src/ui/styles/screens/lobby.css'));
  const foot = css.find((b) => b.selector === '.mn-sala-foot');
  assert.ok(foot, '.mn-sala-foot');
  assert.match(foot.body, /position:\s*sticky;/);
  assert.match(foot.body, /bottom:\s*0;/);
  assert.match(foot.body, /background:\s*var\(--surface-0\);/, 'opaque: the teams go under it');
  for (const b of css.filter((x) => x.selector.includes('.mn-sala-bar'))) assert.doesNotMatch(b.body, /sticky/, b.selector);
  // A row the arrows focus (a TV) scrolls in above the foot, not under it: the foot's height on the Sala while it shows.
  assert.match(css.find((b) => b.selector === '.mn-sala-teams [data-nav]')?.body ?? '', /scroll-margin-bottom:\s*calc\(var\(--mn-sala-foot, 0px\) \+ 1rem\);/);
  assert.match(lobby, /new ResizeObserver\(\(\) => el\.style\.setProperty\('--mn-sala-foot', `\$\{foot\.offsetHeight\}px`\)\)/);
  assert.match(lobby, /shown = true;\s*footSize\?\.observe\(foot\);/);
  assert.match(lobby, /shown = false;\s*footSize\?\.disconnect\(\);/);
});

test('every way out puts the timed match back: back to the Sala, the menus, a session, a new match, the lobby\'s match', async () => {
  assert.equal(R.matchOf('bots'), 'wait', 'the bots match is the unlimited one');
  assert.equal(R.matchOf('training'), 'timed');
  assert.equal(R.matchOf('off'), 'timed');
  const game = await src('src/game/Game.ts');
  // The start: the unlimited match for the bots, the timed one under free play.
  const start = method(game, "private startRoomPlay(kind: 'bots' | 'training'): void {");
  assert.match(start, /this\.useMatch\(this\.waitMatch\);\s*this\.setMode\(mode\);/);
  assert.match(start, /this\.useMatch\(this\.timedMatch\);\s*this\.startTraining\(FREEPLAY_ID\);/);
  // The one way off: training ends, or the timed match back at kickoff.
  const end = method(game, 'private endRoomPlay(): boolean {');
  assert.match(end, /this\.roomPlay = 'off';\s*if \(this\.training !== null\) this\.endTraining\(\);\s*else \{\s*this\.useMatch\(this\.timedMatch\);/);
  assert.match(end, /this\.resetToKickoff\(\);/);
  for (const sig of ['private leaveRoomPlay(): void {', 'private roomGone(text: string | null, kind: \'info\' | \'error\'): void {']) {
    assert.match(method(game, sig), /if \(!this\.endRoomPlay\(\)\) return;/, sig);
  }
  // The menus (any way there), a new match, a session, the lobby's own match.
  assert.match(method(game, 'private showMenu(keepSearch = false): void {'), /this\.endRoomPlay\(\);\s*if \(this\.match === this\.waitMatch\) \{/);
  assert.match(method(game, 'startMatch(): void {'), /this\.roomPlay = 'off';\s*this\.useMatch\(this\.timedMatch\);/);
  assert.match(method(game, 'private playLobbyMatch(r: QueueResult | QueueResultP2p): void {'), /this\.waitToMatch\(true\);\s*this\.endRoomPlay\(\);/);
});
