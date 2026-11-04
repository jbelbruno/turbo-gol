/**
 * Inicio's decisions, pure (no DOM, no texts: tests/home-hero.test.mjs): which state the hero
 * shows, the queue JUGAR AHORA repeats, when the game counts as offline, how the subtitle and a
 * two-line title are cut, and the rank on the player's plate. src/ui/screens/home.ts puts them on
 * the page.
 *
 * The hero shows the first state that applies (plan PR 5; the modes redesign, November 2026): a new
 * version (the server refused this page) > back to your match (a server match of this tab still
 * running after a reload or a lost connection: rejoinStore.ts) > back to the lobby > the running
 * search > offline (the Worker unreachable, or two population polls in a row failed: one slow poll
 * is no reason to swap the match for a bot game) > a guest's offline match against the bots (Casual
 * and Competitive need an account) > play (an account's last queue).
 *
 * Inicio by role and device (tileOrder): a guest's tiles start with VS AI and LOBBIES, Casual and
 * Competitive locked; a TV guest's with VS AI and SIGN IN WITH YOUR PHONE (Competitive left out,
 * LOBBIES locked until the anti-bot check is ready: roomsLocked); an account's are Casual, Lobbies,
 * VS AI, Competitive. After a guest's offline match the "next" card offers the lobbies or an
 * account (nextCard).
 */
import type { MenuPrefs } from '../prefs';
import type { Playlist, RegionId } from '../../net/account';
import type { GameMode } from '../../sim/constants';

/** A queue to search: what Menu.startSearch takes. Casual and Competitive always play on a server. */
export interface QueuePick {
  kind: 'casual' | 'ranked';
  /** Competitive: its playlists; Casual: its preferred format (one playlist: MenuPrefs.casualPrefer). */
  modes: GameMode[];
  /** null = automatic (the connection's continent). */
  region: RegionId | null;
}

/**
 * What JUGAR AHORA plays for an account: the kind searched last (MenuPrefs.lastQueue, Casual the
 * first time) with that kind's playlists (Casual: its preferred format) and the region.
 * Competitive only for a signed-in player without an abandon ban; anyone else gets Casual (a guest's
 * hero plays the bots instead: heroState). Pure.
 */
export function heroQueue(p: MenuPrefs, signedIn: boolean, rankedBanned: boolean): QueuePick {
  if (p.lastQueue === 'ranked' && signedIn && !rankedBanned) return { kind: 'ranked', modes: p.rankedModes, region: p.region };
  return { kind: 'casual', modes: [p.casualPrefer], region: p.region };
}

/**
 * Offline for the hero: the Worker answered nothing (`cfg.online` false), or `popFails` population
 * polls in a row failed, two or more. Still connecting (`cfg` null) is not offline. Pure.
 */
export function isOffline(cfg: { online: boolean } | null, popFails: number): boolean {
  return cfg !== null && (!cfg.online || popFails >= 2);
}

/** The running search. */
export interface HeroSearch {
  kind: 'casual' | 'ranked';
  modes: GameMode[];
  region: RegionId | null;
  /** performance.now() when it started. */
  since: number;
}

/** The lobby this player is in; `count` and `max` are null before its first state message. */
export interface HeroLobby {
  code: string;
  count: number | null;
  max: number | null;
}

/** A server match of this tab still running after a reload or a lost connection (PR 12: rejoinStore.ts). */
export interface HeroRejoin {
  kind: 'casual' | 'ranked' | 'lobby';
  modes: GameMode[];
  /** Its time left, ms. */
  leftMs: number;
}

export interface HeroInput {
  updateNeeded: boolean;
  rejoin: HeroRejoin | null;
  lobby: HeroLobby | null;
  search: HeroSearch | null;
  offline: boolean;
  /** No account: Casual and Competitive are locked, the hero plays the bots offline. */
  guest: boolean;
  /** heroQueue's pick, for the play state. */
  queue: QueuePick;
}

export type HeroKind = 'update' | 'rejoin' | 'lobby' | 'search' | 'offline' | 'bots' | 'play';

export type HeroState =
  | { kind: 'update' }
  | { kind: 'rejoin'; rejoin: HeroRejoin }
  | { kind: 'lobby'; lobby: HeroLobby }
  | { kind: 'search'; search: HeroSearch }
  | { kind: 'offline' }
  | { kind: 'bots' }
  | { kind: 'play'; queue: QueuePick };

/** The first state that applies, in the order above. Pure. */
export function heroState(i: HeroInput): HeroState {
  if (i.updateNeeded) return { kind: 'update' };
  if (i.rejoin !== null) return { kind: 'rejoin', rejoin: i.rejoin };
  if (i.lobby !== null) return { kind: 'lobby', lobby: i.lobby };
  if (i.search !== null) return { kind: 'search', search: i.search };
  if (i.offline) return { kind: 'offline' };
  if (i.guest) return { kind: 'bots' };
  return { kind: 'play', queue: i.queue };
}

/** Inicio's mode tiles (home.ts): `tvsign` is the TV guest's SIGN IN WITH YOUR PHONE. */
export type HomeTile = 'casual' | 'friends' | 'ai' | 'ranked' | 'tvsign';

/**
 * The tiles a role shows, in their order (the DOM's, for Tab and a screen reader; home.css draws
 * the same order with each role's grid template): a guest VS AI, LOBBIES, Casual (locked),
 * Competitive (locked); a TV guest VS AI, SIGN IN WITH YOUR PHONE, LOBBIES, Casual (locked), no
 * Competitive; an account (any device) Casual, Lobbies, VS AI, Competitive. Pure.
 */
export function tileOrder(r: { guest: boolean; tv: boolean }): HomeTile[] {
  if (!r.guest) return ['casual', 'friends', 'ai', 'ranked'];
  return r.tv ? ['ai', 'tvsign', 'friends', 'casual'] : ['ai', 'friends', 'casual', 'ranked'];
}

/**
 * The tiles box's children in the DOM's order, the drawn one (Tab, a screen reader; the pad's
 * arrows are spatial either way): the hero first where it is drawn first (at the left on a PC and
 * a TV, on top upright), last on a phone held sideways (`heroLast`: the rail, where it stands at
 * the right, by the thumb), the role's tiles in their order around it. Pure.
 */
export function homeDomOrder(r: { guest: boolean; tv: boolean; heroLast: boolean }): Array<HomeTile | 'hero'> {
  const tiles = tileOrder(r);
  return r.heroLast ? [...tiles, 'hero'] : ['hero', ...tiles];
}

/**
 * A TV guest's rooms wait for the anti-bot check (its remote may not pass one that asks): locked
 * until a guest session exists or a quiet check passed (NetClient.antiBotReady). Every other
 * player's rooms are open. Pure.
 */
export function roomsLocked(r: { tv: boolean; guest: boolean; antiBotReady: boolean }): boolean {
  return r.tv && r.guest && !r.antiBotReady;
}

/** What the "next" card offers after a guest's offline match. */
export interface NextCard {
  /** SEE LOBBIES (MODOS › LOBBIES); false on a TV whose rooms are locked (its sign-in opens them). */
  rooms: boolean;
  /** CREATE ACCOUNT: PERFIL's create; on a TV, SIGN IN WITH YOUR PHONE. */
  account: 'create' | 'tvSignIn';
}

/**
 * The card over Inicio's tiles once a guest's match against the AI reached its FINAL (not a quit),
 * once per page: "Now, with people?" with SEE LOBBIES and CREATE ACCOUNT; null when it does not
 * apply (an account, no such match yet, closed or used already). Pure.
 */
export function nextCard(i: { guest: boolean; aiMatchEnded: boolean; dismissed: boolean; tv: boolean; roomsOpen: boolean }): NextCard | null {
  if (!i.guest || !i.aiMatchEnded || i.dismissed) return null;
  return { rooms: i.roomsOpen, account: i.tv ? 'tvSignIn' : 'create' };
}

/**
 * The "next" card's line: "Join a public lobby, or make an account..." while it offers SEE LOBBIES;
 * a TV whose rooms are locked (no SEE LOBBIES, only the phone's sign-in, which opens them) says
 * that sign-in instead. Pure.
 */
export function nextLineKey(card: NextCard): 'home.nextLine' | 'home.nextLineTv' {
  return card.rooms ? 'home.nextLine' : 'home.nextLineTv';
}

/** The subtitle's separator, and a TV's before the region (the owner's TV artboard: "Casual · 2v2 - Sudamérica"). */
export const HERO_SEP = ' · ';
export const HERO_SEP_TV = ' - ';

/**
 * The subtitle's two parts: the queue ("Casual · 2v2", "Competitivo · 1v1 · 3v3") and the region's
 * name (`region`, null when none is known yet: then it is left out). `names`: the kinds' names in
 * the page's language (play.casualTitle, play.rankedTitle; a lobby's match: final.lobby). Pure.
 */
export function queueParts(kind: 'casual' | 'ranked' | 'lobby', modes: readonly GameMode[], region: string | null, names: { casual: string; ranked: string; lobby?: string }): { queue: string; region: string | null } {
  return { queue: [kind === 'ranked' ? names.ranked : kind === 'lobby' && names.lobby !== undefined ? names.lobby : names.casual, ...modes].join(HERO_SEP), region };
}

/**
 * A two-part subtitle ("Partido de 3 min · sin conexión") split at its last separator, set as a
 * queue and its region are (a phone's second line, the part a TV lets go); one part when it has
 * none. Pure.
 */
export function subParts(text: string): { queue: string; region: string | null } {
  const i = text.lastIndexOf(HERO_SEP);
  return i <= 0 ? { queue: text, region: null } : { queue: text.slice(0, i), region: text.slice(i + HERO_SEP.length) };
}

/**
 * A title's two-line form (fit.ts data-fit-alt): split at the space that balances the two lines
 * best ("JUGAR AHORA" -> "JUGAR\nAHORA"); a single word stays as it is. Pure.
 */
export function twoLines(s: string): string {
  let best = -1;
  let longest = Infinity;
  for (let i = s.indexOf(' '); i >= 0; i = s.indexOf(' ', i + 1)) {
    const m = Math.max(i, s.length - i - 1);
    if (m < longest) {
      longest = m;
      best = i;
    }
  }
  return best < 0 ? s : s.slice(0, best) + '\n' + s.slice(best + 1);
}

/** What plateRank reads of a rating (net/account.ts PlaylistRating). */
export interface PlateRating {
  playlist: Playlist;
  mmr: number;
  /** Tier id once placed, null during placement. */
  tier: string | null;
}

/** The plate's rank: the best placed rating by MMR (the account chip's rule), null when none. Pure. */
export function plateRank(me: { ratings: readonly PlateRating[] } | null): { tier: string; playlist: Playlist } | null {
  let best: PlateRating | null = null;
  for (const r of me?.ratings ?? []) if (r.tier !== null && (best === null || r.mmr > best.mmr)) best = r;
  return best !== null && best.tier !== null ? { tier: best.tier, playlist: best.playlist } : null;
}
