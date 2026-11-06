/**
 * The lone host's local play while the lobby waits (the modes redesign, November 2026, step 2:
 * spec §3.8, §5.4), the pure transitions the Game follows (tests/room-play.test.mjs; Game.ts cannot
 * load under node):
 *
 *   off ──start (a lone host, the lobby open, no session up, no wait play)──▶ bots | training
 *   bots | training ──someone came in (2+ members), or the host is not the lone host any more──▶
 *                     off, back to the Sala ("{name} joined your lobby": newcomer)
 *   bots | training ──the lobby gone (closed, kicked, lost, left)──▶ off, the menus (its close text)
 *   bots | training ──the lobby socket reconnecting──▶ the same play (LobbyClient's own tries; one that
 *                     fails closes the lobby, which is the line above)
 *   bots | training ──BACK TO THE LOBBY (the pause)──▶ off, back to the Sala
 *
 * `bots` is the unlimited match against the bots (Game.waitMatch, a Match of length 0: no whistle,
 * so no FINAL), `training` free play. Whatever ends it puts the timed match back (matchOf). It is
 * separate from wait play (./waitPlay.ts) and a search wins over it: the Sala hides its buttons
 * while a session is up (a search queueing, a match connecting), and the Game never runs both.
 * The lobby socket stays open meanwhile (the page lives), so the lobby keeps existing and listed.
 */

export type RoomPlay = 'off' | 'bots' | 'training';

/** What room play reads of the lobby (LobbyClient: status, isHost, state). */
export interface RoomView {
  /** LobbyClient.status. */
  readonly status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** This player hosts the lobby (LobbyClient.isHost). */
  readonly host: boolean;
  /** Members in the lobby's last state (0 without one). */
  readonly members: number;
  /** The lobby's own state (open, or starting / playing its match); null before the first state. */
  readonly lobby: 'open' | 'starting' | 'in_game' | null;
}

/** What else holds the player: a session up (a search queueing, a match connecting or on), wait play. */
export interface RoomBusy {
  readonly session: boolean;
  readonly waitPlay: boolean;
}

/** The host is alone in a lobby that is open and connected (START waits for a second player). */
export function loneHost(room: RoomView): boolean {
  return room.status === 'open' && room.host && room.members === 1 && room.lobby === 'open';
}

/**
 * The Sala's "While you wait for someone to join: VS BOTS · TRAIN" shows: a lone host with nothing
 * else on (a running search wins: no buttons while one runs; nothing over wait play either).
 */
export function roomPlayOffered(s: RoomPlay, room: RoomView, busy: RoomBusy): boolean {
  return s === 'off' && !busy.session && !busy.waitPlay && loneHost(room);
}

/** Start `kind` from the Sala: only when it is offered (null: nothing starts). */
export function startRoom(s: RoomPlay, kind: 'bots' | 'training', room: RoomView, busy: RoomBusy): RoomPlay | null {
  return roomPlayOffered(s, room, busy) ? kind : null;
}

/** What the lobby's change means for the play: go on, back to the Sala, or the menus (the lobby went). */
export type RoomStep = 'stay' | 'back' | 'menus';

/**
 * The lobby moved while the host plays (its socket's callbacks, which a hidden tab runs too; the
 * frame as a backstop). A lobby socket away (reconnecting) is no reason to stop: its tries go on,
 * and the one that fails closes the lobby.
 */
export function roomStep(s: RoomPlay, room: RoomView): RoomStep {
  if (s === 'off') return 'stay';
  if (room.status === 'closed' || room.status === 'idle') return 'menus';
  if (room.status !== 'open') return 'stay';
  return loneHost(room) ? 'stay' : 'back';
}

/** Who came in: the newest member that is not this player (the toast's {name}), null when none. */
export function newcomer<M extends { readonly id: string }>(members: readonly M[], you: string): M | null {
  for (let i = members.length - 1; i >= 0; i--) if (members[i].id !== you) return members[i];
  return null;
}

/** Which offline match runs: the unlimited one for the bots, the timed one otherwise (every exit: off). */
export function matchOf(s: RoomPlay): 'wait' | 'timed' {
  return s === 'bots' ? 'wait' : 'timed';
}

/** The pause's way out while the host plays: BACK TO THE LOBBY in QUIT's place; null outside room play. */
export function pauseExit(s: RoomPlay): 'backToLobby' | null {
  return s === 'off' ? null : 'backToLobby';
}

/** The keys of the HUD's room strip (src/locales). */
export type RoomStripKey = 'lobby.hudWaiting' | 'lobby.reconnecting' | 'lobby.hudBack';

/**
 * The HUD's strip (and the training panel's line) while the host plays: "Lobby ABC 234 · waiting
 * for players · Pause: back to the lobby"; while its socket is away "Reconnecting to the lobby… ·
 * Pause: back to the lobby", as a warning. `code`: spaced ("ABC 234"); `tr`: the translator (i18n t).
 */
export function roomStrip(code: string, reconnecting: boolean, tr: (key: RoomStripKey, params?: Record<string, string>) => string): { text: string; warn: boolean } {
  const head = reconnecting ? tr('lobby.reconnecting') : tr('lobby.hudWaiting', { code });
  return { text: `${head} · ${tr('lobby.hudBack')}`, warn: reconnecting };
}
