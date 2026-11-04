/**
 * JUGAR's root, Inicio (plan §1.4 "JUGAR (Inicio)", PR 5; the owner's artboards; the modes
 * redesign, November 2026): the player plate (who you are · GARAJE · Dune), then a row of tiles
 * anchored at the bottom over the live stadium: the hero, JUGAR AHORA (JUGAR on a TV), and the mode
 * tiles, each opening MODOS on its tab (screens/modes.ts). By role and device (homeModel.ts
 * tileOrder): an account sees CASUAL, SALAS, CONTRA LA IA, COMPETITIVO, its hero repeats the last
 * queue (Casual the first time); a guest sees CONTRA LA IA, SALAS, CASUAL and COMPETITIVO locked
 * ("Iniciar sesión"), its hero plays an offline match against the bots at once (AL INSTANTE: no
 * terms, no anti-bot check, no network); a TV guest sees CONTRA LA IA, INICIAR SESIÓN CON EL
 * TELÉFONO, SALAS (locked until the anti-bot check is ready: homeModel.ts roomsLocked, the check
 * warmed again every 4 minutes while Inicio is up) and CASUAL locked. `data-role` on the tiles and
 * html.tg-tv pick the grid template that draws them in that order (styles/screens/home.css); the
 * DOM follows the same order (Tab, a screen reader). The hero at the left on a PC and a TV, at the
 * right on a phone held sideways (the thumb; last in the DOM there too: homeModel.ts homeDomOrder),
 * on top upright. A TV guest's locked SALAS shows the lock in its slot and "Sign in with your
 * phone" as its line.
 *
 * After a guest's match against the AI reached its FINAL, a card over the tiles offers the next
 * step once per page (homeModel.ts nextCard): SEE LOBBIES and CREATE ACCOUNT (a TV: SIGN IN WITH
 * YOUR PHONE), and a close; ▲ from the hero goes to it.
 *
 * The hero follows the player (homeModel.ts heroState): RELOAD NOW after a refused version, back
 * to your match (PR 12), back to the lobby, the running search (its clock, the estimate and ✕
 * CANCEL: screens/searchModel.ts), VS AI when offline, a guest's match against the bots, else
 * JUGAR AHORA (SIEMPRE HAY PARTIDO for Casual only: Competitive plays no bots). A TV without a
 * controller says so in the hero's slot, and a match's start asks for one first (Menu.beforeMatch);
 * so does "How will you play?" on a new PC. A search started here opens "While you search" on its
 * first answer (Menu.startSearch `sheet`). The hero renders on a change only (the tick builds a key:
 * 4 Hz, 1 Hz on super low; the Menu ticks it at once when a search starts or ends), its clock on a
 * new second and its ticking estimate in place (never a rebuild: the busy stripe sweeps on; a TV
 * keeps the estimate, its queue gives way first), its name for a screen reader on a state change,
 * never with the clock. The plate and
 * the locks follow the account on their own keys; the profile is fetched as the screen shows (the
 * plate's rank, the ban, the chip's rank), and once more when a session restored after that.
 *
 * In development (or a VITE_UI_FIT=1 build) window.__homeHero(kind | null, { pad, ranked }) forces
 * a hero state with sample data for the layout check (scripts/ui-fit.mjs).
 */
import { h, clock, setChildren } from '../dom';
import { t } from '../../i18n';
import { PLAYLISTS, isRegion } from '../../net/account';
import type { RegionId } from '../../net/account';
import { MODES } from '../../sim/constants';
import { rejoinLeftMs } from '../../game/rejoinStore';
import type { GameMode } from '../../sim/constants';
import type { Menu, Screen } from '../Menu';
import { heroTile, modeTile, slot } from '../components/tile';
import type { HeroSub, HeroView } from '../components/tile';
import { icon } from '../components/icons';
import { plate as createPlate } from '../components/plate';
import { rankBadge, tierById } from '../badges';
import { carName, playerName, regionName, tierName } from '../names';
import { HERO_SEP, HERO_SEP_TV, heroQueue, heroState, homeDomOrder, nextCard, nextLineKey, plateRank, queueParts, roomsLocked, subParts } from './homeModel';
import type { HeroInput, HeroKind, HeroState, HomeTile, QueuePick } from './homeModel';
import { waitLines } from './searchModel';
import { estimateText } from './searchText';
import { openProfileTab } from './profile';
import { onNavTo } from '../nav';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

/** A TV guest's anti-bot check is warmed again this often while Inicio is up (NetClient.WARM_MS keeps a token 270 s). */
const REWARM_MS = 240_000;

/** The "next" card was closed or used on this page (once per page). */
let nextDismissed = false;

export function homeScreen(menu: Menu): Screen {
  const host = menu.host;
  const acc = host.accounts;
  const html = document.documentElement;
  // Fixed for the page: device.ts sets tg-tv and the Game tg-superlow before the menus first show.
  const tv = html.classList.contains('tg-tv');
  const lines = !html.classList.contains('tg-superlow');
  const touch = (): boolean => html.classList.contains('tg-touch');
  const guest = (): boolean => !acc.signedIn;
  const locked = (): boolean => roomsLocked({ tv, guest: guest(), antiBotReady: host.antiBotReady === true });
  const plate = createPlate({ profile: () => menu.open('profile'), garage: () => menu.open('garage') });
  // A TV's pills by the plate (Screen.pillSlot), fitted as the hint bar fits them there.
  const pills = h('div.mn-home-pills', { 'data-fit': '16' });
  const hero = heroTile({
    lines,
    oneLine: tv,
    press: () => press(),
    cancel: () => {
      menu.cancelSearch();
      if (!touch()) hero.main.focus({ preventScroll: true });
    },
  });
  const ranked = modeTile({ cls: 'mn-mtile-ranked', key: 'mode-ranked', icon: 'rank', slot: null, title: t('modes.ranked'), sub: t('modes.rankedSub'), short: t('modes.rankedSubShort'), open: () => menu.open('modes', false, 'ranked') });
  const casual = modeTile({ cls: 'mn-mtile-casual', key: 'mode-casual', icon: 'ball', slot: null, title: t('modes.casual'), sub: t('modes.casualSub'), short: t('modes.casualSubShort'), open: () => menu.open('modes', false, 'casual') });
  // SALAS: public or by code (a TV has no link to share: a code; PR 14 types it on the phone). A TV
  // guest's whose check is not ready opens the phone's sign-in instead.
  const friends = modeTile({
    cls: 'mn-mtile-friends',
    key: 'mode-friends',
    icon: 'friends',
    slot: null,
    title: t('modes.friends'),
    sub: t('modes.friendsSub'),
    short: t(tv ? 'modes.friendsSubTv' : 'modes.friendsSubShort'),
    open: () => (locked() ? menu.tvSignIn() : menu.open('modes', false, 'lobbies')),
  });
  const ai = modeTile({ cls: 'mn-mtile-ai', key: 'mode-ai', icon: 'bot', slot: slot(t('modes.vsAiSlot'), { drop: true }), title: t('modes.vsAi'), sub: t('modes.vsAiSub'), short: t('modes.vsAiSubShort'), open: () => menu.open('modes', false, 'ai') });
  const tvsign = modeTile({ cls: 'mn-mtile-tvsign', key: 'mode-tvsign', icon: 'tv', slot: null, title: t('tvsign.tile'), sub: t('tvsign.tileSub'), short: t('tvsign.tileSub'), open: () => menu.tvSignIn() });
  const tileEls: Record<HomeTile, HTMLElement> = { casual: casual.el, friends: friends.el, ai: ai.el, ranked: ranked.el, tvsign: tvsign.el };
  const tilesBox = h('div.mn-tiles', null, hero.el);
  // "Now, with people?" after a guest's offline match (once per page).
  const nextBox = h('div.mn-home-next', { hidden: true, 'data-nav-row': true });
  // ▲ from the hero: that card, drawn right over the tiles (the hero's row) when it shows; the
  // spatial pick would pass it for the plate over the hero's left part (its buttons sit at the right).
  onNavTo(hero.main, 'up', () => (nextBox.hidden ? null : nextBox.querySelector<HTMLElement>('[data-nav]')));
  const el = h('section.mn-home', { 'data-tablero': true }, h('div.mn-home-top', { 'data-nav-row': true }, plate.el, pills), nextBox, tilesBox);

  let state: HeroState = { kind: 'play', queue: heroQueue(menu.prefs, false, false) };
  let heroKey = '';
  let clockText = '';
  let estText = '';
  let plateKey = '';
  let lockKey = '';
  let roleKey = '';
  let nextKey = '';
  let banText = '';
  let warmAt = 0;
  /** The profile was fetched for this session (the plate, the ban): signed in after the screen showed, it is fetched once more. */
  let fetchedFor = '';
  let forced: HeroState | null = null;
  let forcePad = false;

  const banLeft = (): number => (acc.me?.rankedBanUntil ?? 0) - Date.now();
  /** A region's name: the queue's own, else the automatic one (the connection's continent); null when none is known yet. */
  const regionOf = (id: RegionId | null): string | null => {
    const auto = menu.cfg?.autoRegion;
    const r = id ?? (isRegion(auto) ? auto : null);
    return r === null ? null : regionName(r);
  };
  const names = { casual: t('play.casualTitle'), ranked: t('play.rankedTitle'), lobby: t('final.lobby') };

  /** The server match this tab may join again (rejoinStore.ts), while no search runs (a rejoin under way is one). */
  const rejoinOf = (searching: boolean): HeroInput['rejoin'] => {
    const r = searching ? null : host.rejoinable();
    return r === null ? null : { kind: r.kind, modes: r.modes, leftMs: rejoinLeftMs(r) };
  };

  const input = (): HeroInput => {
    const v = host.searchView();
    const lobby = host.lobby;
    const st = lobby.state;
    return {
      updateNeeded: menu.updateNeeded,
      rejoin: rejoinOf(v.active),
      lobby: !lobby.inLobby ? null : st !== null ? { code: st.code, count: st.members.length, max: MODES[st.settings.mode] * 2 } : { code: lobby.code ?? '', count: null, max: null },
      search: v.active && v.kind !== null ? { kind: v.kind, modes: v.modes, region: v.region, since: v.since } : null,
      offline: menu.offline,
      guest: guest(),
      queue: heroQueue(menu.prefs, acc.signedIn, banLeft() > 0),
    };
  };

  /** What the hero shows for state `s` (plan PR 5's table); `key` changes with any text but the clock and the estimate's (est: its kind only). */
  const heroView = (s: HeroState, needPad: boolean, now: number): HeroView & { key: string } => {
    const padSlot: HeroView['slot'] = { text: t('tv.needPad'), icon: 'pad' };
    const dot = tv ? HERO_SEP_TV : HERO_SEP;
    // Casual pools every format: its subtitle names the queue and the region only.
    const queueSub = (kind: 'casual' | 'ranked', modes: readonly GameMode[], region: RegionId | null): { sub: HeroSub; text: string } => {
      const p = queueParts(kind, kind === 'ranked' ? modes : [], regionOf(region), names);
      return { sub: { queue: p.queue, dot, region: p.region }, text: p.region === null ? p.queue : p.queue + dot + p.region };
    };
    let icon_: HeroView['icon'] = 'play';
    let tag: HeroView['slot'] = null;
    let title = '';
    let sub: HeroSub = '';
    let subText = '';
    /** The screen reader's name when it differs from the subtitle (a ticking estimate is never part of it). */
    let label: string | null = null;
    let clockNow: string | null = null;
    /** Searching: the estimate's text (in place) and its kind (in the key). */
    let est: string | null = null;
    let estKind = '';
    const kind: HeroKind = s.kind;
    switch (s.kind) {
      case 'play': {
        const q = queueSub(s.queue.kind, s.queue.modes, s.queue.region);
        // SIEMPRE HAY PARTIDO: Casual only (Competitive plays no bots and has no cap).
        tag = needPad ? padSlot : s.queue.kind === 'casual' ? { text: t('home.alwaysMatch') } : null;
        title = t(tv ? 'home.playNowTv' : 'home.playNow');
        sub = q.sub;
        subText = q.text;
        break;
      }
      case 'bots': {
        // A guest's: the offline match against the bots, at once.
        subText = t(tv ? 'modes.vsAiSubShort' : 'modes.vsAiSub');
        const p = subParts(subText);
        icon_ = 'bot';
        tag = needPad ? padSlot : { text: t('home.instant') };
        title = t(tv ? 'home.playNowTv' : 'home.playNow');
        sub = { queue: p.queue, dot: HERO_SEP, region: p.region };
        break;
      }
      case 'search': {
        // BUSCANDO, the clock, then the queue and the estimate ("Casual · Con bots en 3:37 como
        // máximo"). The estimate ticks: written in place (est), only its kind is in the key, so the
        // hero is not rebuilt (nor its busy stripe restarted) every second.
        const v = host.searchView();
        const lines2 = waitLines({ kind: s.search.kind, since: s.search.since, wait: v.wait ?? null, waitAt: v.waitAt ?? 0, retrying: v.retrying === true, times: menu.cfg?.queue ?? null }, now);
        const queue = queueParts(s.search.kind, s.search.kind === 'ranked' ? s.search.modes : [], null, names).queue;
        est = lines2.override === 'retrying' ? t('search.retrying') : lines2.override === 'busy' ? t('search.busy') : estimateText(lines2.estimate);
        estKind = lines2.override ?? lines2.estimate.kind;
        icon_ = 'search';
        tag = needPad ? padSlot : null;
        title = t('home.searching');
        clockNow = clock(now - s.search.since);
        sub = { queue, dot, region: null };
        subText = queue;
        label = title + '. ' + queue;
        break;
      }
      case 'offline': {
        // In two parts, as a queue and its region: "sin conexión" on its own line on a phone, the
        // part that steps aside on a TV (whose short form is the CONTRA LA IA tile's there).
        subText = t(tv ? 'modes.vsAiSubShort' : 'modes.vsAiSub');
        const p = subParts(subText);
        icon_ = 'bot';
        tag = needPad ? padSlot : { text: t('pill.offline') };
        title = t('modes.vsAi');
        sub = { queue: p.queue, dot: HERO_SEP, region: p.region };
        break;
      }
      case 'lobby':
        icon_ = 'friends';
        title = t('home.backToLobby');
        sub = subText = t('home.lobbySub', { code: s.lobby.code, count: s.lobby.count ?? '—', max: s.lobby.max ?? '—' });
        break;
      case 'update':
        icon_ = 'refresh';
        title = t('update.reload');
        sub = subText = t('update.title');
        break;
      case 'rejoin': {
        const q = queueParts(s.rejoin.kind, s.rejoin.modes, null, names).queue;
        tag = needPad ? padSlot : null;
        title = t('home.rejoin');
        subText = t('home.rejoinSub', { queue: q, time: clock(s.rejoin.leftMs) });
        const p = subParts(subText); // the time left as the offline hero's second part
        sub = { queue: p.queue, dot: HERO_SEP, region: p.region };
        break;
      }
    }
    const pad = tag !== null && needPad;
    return { kind, icon: icon_, slot: tag, title, clock: clockNow, sub, est, needPad: pad, label: label ?? title + '. ' + subText, key: [kind, title, subText, estKind, tag?.text ?? '', pad].join('|') };
  };

  /** The plate, on a change of who and which rank (true when it was written). */
  const renderPlate = (): boolean => {
    const signed = acc.signedIn && acc.account !== null;
    const name = signed && acc.account !== null ? acc.account.name : playerName(host.guestName());
    const best = signed ? plateRank(acc.me) : null;
    // GARAJE · the car driven (an equip, a sign-in that brings the account's car).
    const car = carName(host.garage.store.equipped);
    const key = [signed, name, best?.tier ?? '', best?.playlist ?? '', car].join('|');
    if (key === plateKey) return false;
    plateKey = key;
    const tier = best !== null ? tierById(best.tier) : null;
    const rank = best !== null && tier !== null ? `${tierName(tier)}${HERO_SEP}${best.playlist}` : t('home.unranked');
    const carLine = t('home.carLine', { car });
    plate.set({
      avatar: signed ? rankBadge(tier, 44) : h('span.mn-plate-avatar', { 'aria-hidden': 'true' }, '?'),
      name,
      line: tv ? rank + HERO_SEP + carLine : signed ? rank : t('home.guestRank'),
      carName: car,
      profileLabel: t('home.plateProfile', { name, rank }) + (tv ? '. ' + carLine : ''),
      garageLabel: t('home.plateGarage', { car }),
    });
    return true;
  };

  /** A guest's "Iniciar sesión" lock (its short form in a narrow tile: a phone, a tablet, before the lock would stand alone). */
  const signInLock = (): HTMLElement => slot(t('menu.guestSignIn'), { icon: 'lock', body: true, short: t('modes.signInShort'), drop: true });

  /**
   * The tiles' slots by role: COMPETITIVO's lock (a guest's "Sign in", a banned player's lock
   * alone, the time left as its description), CASUAL's for a guest (its formats for an account),
   * SALAS' PÚBLICAS, or a TV guest's lock with "Sign in with your phone" as its line. True when a
   * slot was rebuilt.
   */
  const renderLocks = (): boolean => {
    const left = acc.signedIn ? banLeft() : 0;
    const g = guest();
    const rankedKey = g ? 'guest' : left > 0 ? 'ban' : '';
    const text = left > 0 ? t('play.rankedBan', { time: clock(left) }) : '';
    if (text !== banText) {
      banText = text;
      if (text !== '') ranked.el.title = text;
      else ranked.el.removeAttribute('title');
    }
    const rooms = locked();
    const key = [rankedKey, g, rooms].join('|');
    if (key === lockKey) return false;
    lockKey = key;
    ranked.setSlot(rankedKey === 'guest' ? signInLock() : rankedKey === 'ban' ? slot('', { icon: 'lock' }) : null);
    casual.setSlot(g ? signInLock() : slot(PLAYLISTS.join(HERO_SEP), { drop: true }));
    // A TV guest's locked rooms: the lock in the slot, and how to open them as the tile's line (a
    // slot's text would give way to the title on a TV: the lock alone told nothing).
    friends.setSlot(rooms ? slot('', { icon: 'lock' }) : slot(t('home.lobbiesSlot'), { drop: true }));
    if (rooms) friends.setSub(t('modes.lobbiesTvLocked'), t('modes.lobbiesTvLocked'));
    else friends.setSub(t('modes.friendsSub'), t(tv ? 'modes.friendsSubTv' : 'modes.friendsSubShort'));
    return true;
  };

  /**
   * The tiles in the role's order and the hero where it is drawn (homeModel.ts homeDomOrder: the
   * DOM's, for Tab and a screen reader; the grid template draws the same, the hero last on a phone
   * held sideways, which can turn while Inicio is up). True when they moved.
   */
  const renderRole = (): boolean => {
    const g = guest();
    const heroLast = html.dataset.shell === 'rail';
    const key = `${g ? 'guest' : 'account'}|${heroLast}`;
    if (key === roleKey) return false;
    roleKey = key;
    tilesBox.dataset.role = g ? 'guest' : 'account';
    const order = homeDomOrder({ guest: g, tv, heroLast });
    const had = tilesBox.contains(document.activeElement);
    for (const id of Object.keys(tileEls) as HomeTile[]) if (!order.includes(id)) tileEls[id].remove();
    for (const id of order) tilesBox.appendChild(id === 'hero' ? hero.el : tileEls[id]);
    if (had && !tilesBox.contains(document.activeElement)) menu.refocus();
    return true;
  };

  /** The "next" card after a guest's offline match: its buttons by device, or nothing. True when it changed. */
  const renderNext = (): boolean => {
    const card = nextCard({ guest: guest(), aiMatchEnded: host.aiMatchEnded === true, dismissed: nextDismissed, tv, roomsOpen: !locked() });
    const key = card === null ? '' : `${card.rooms}|${card.account}`;
    if (key === nextKey) return false;
    nextKey = key;
    nextBox.hidden = card === null;
    if (card === null) {
      if (nextBox.contains(document.activeElement)) menu.refocus();
      setChildren(nextBox);
      return true;
    }
    const drop = (): void => {
      nextDismissed = true;
      render(performance.now());
    };
    const rooms = card.rooms
      ? h('button.mn-btn.mn-btn-primary.mn-home-next-go', { type: 'button', 'data-nav': true, 'data-key': 'next-rooms', onclick: () => (drop(), menu.open('modes', false, 'lobbies')) }, icon('friends'), h('span', null, t('home.nextRooms')))
      : null;
    const account = h(
      `button.mn-btn${card.rooms ? '' : '.mn-btn-primary'}.mn-home-next-go` as 'button',
      { type: 'button', 'data-nav': true, 'data-key': 'next-account', onclick: () => (drop(), card.account === 'tvSignIn' ? menu.tvSignIn() : openProfileTab(menu, 'register', null)) },
      icon(card.account === 'tvSignIn' ? 'tv' : 'profile'),
      h('span', null, t(card.account === 'tvSignIn' ? 'tvsign.tile' : 'home.nextAccount')),
    );
    const x = h('button.mn-btn.mn-home-next-x', { type: 'button', 'data-nav': true, 'data-key': 'next-close', 'aria-label': t('home.nextClose'), title: t('home.nextClose'), onclick: () => drop() }, icon('close'));
    setChildren(nextBox, h('div.mn-home-next-text', null, h('b', null, t('home.nextTitle')), h('span', null, t(nextLineKey(card)))), h('div.mn-home-next-acts', null, rooms, account, x));
    return true;
  };

  const fetchMe = (): void => {
    if (!acc.signedIn) return;
    fetchedFor = acc.account?.name ?? '?';
    void acc.fetchMe().then(() => render(performance.now()), () => undefined);
  };

  /** A TV guest's rooms open once the anti-bot check is warm: warmed again before its token goes (WARM_MS). */
  const rewarm = (now: number): void => {
    if (!tv || !guest() || now - warmAt < REWARM_MS) return;
    warmAt = now;
    host.prewarmAntiBot?.();
  };

  /** Everything that changed, then one fit (`fit`: false as the screen shows: the mount fits right after). */
  const render = (now: number, fit = true): void => {
    state = forced ?? heroState(input());
    const needPad = tv && !forcePad && !host.padConnected();
    const view = heroView(state, needPad, now);
    let changed = false;
    if (view.key !== heroKey) {
      heroKey = view.key;
      clockText = view.clock ?? '';
      estText = view.est ?? '';
      hero.set(view);
      changed = true;
    } else {
      if (view.clock !== null && view.clock !== clockText) {
        clockText = view.clock;
        hero.setClock(view.clock);
      }
      // The estimate ticks in place; a text of another length is fitted again (its digits keep their width).
      if (view.est != null && view.est !== estText) {
        if (view.est.length !== estText.length) changed = true;
        estText = view.est;
        hero.setEst(view.est);
      }
    }
    // A session restored after the screen showed: its profile once (the plate's rank, the ban).
    if (acc.signedIn && acc.me === null && fetchedFor !== (acc.account?.name ?? '?')) fetchMe();
    if (renderPlate()) changed = true;
    if (renderRole()) changed = true;
    if (renderLocks()) changed = true;
    if (renderNext()) changed = true;
    rewarm(now);
    if (changed && fit) menu.refit();
  };

  /** The hero's press, for the state it shows now. */
  const press = (): void => {
    render(performance.now());
    const s = state;
    switch (s.kind) {
      case 'play':
        // "While you search" opens on the search's first answer.
        menu.beforeMatch(() => menu.startSearch({ kind: s.queue.kind, modes: s.queue.modes, region: s.queue.region }, { sheet: true }));
        return;
      case 'search':
        menu.openSearchScreen();
        return;
      case 'offline':
      case 'bots':
        menu.beforeMatch(() => host.playFriendly(host.mode, host.difficulty));
        return;
      case 'lobby':
        menu.open('lobby');
        return;
      case 'update':
        location.reload();
        return;
      case 'rejoin':
        menu.beforeMatch(() => menu.rejoin());
        return;
    }
  };

  if (UI_FIT) {
    // `ranked`: the samples' queue is Competitive in every format (the longest subtitle).
    (window as unknown as { __homeHero: (kind: HeroKind | null, opts?: { pad?: boolean; ranked?: boolean }) => void }).__homeHero = (kind, opts) => {
      const now = performance.now();
      const q: QueuePick = opts?.ranked === true ? { kind: 'ranked', modes: [...PLAYLISTS], region: null } : heroQueue(menu.prefs, false, false);
      const sample: Record<HeroKind, HeroState> = {
        play: { kind: 'play', queue: q },
        search: { kind: 'search', search: { kind: q.kind, modes: q.modes, region: q.region, since: now - 42_000 } },
        offline: { kind: 'offline' },
        bots: { kind: 'bots' },
        lobby: { kind: 'lobby', lobby: { code: 'ABC234', count: 2, max: 4 } },
        update: { kind: 'update' },
        rejoin: { kind: 'rejoin', rejoin: { kind: q.kind, modes: q.modes, leftMs: 192_000 } },
      };
      forced = kind === null ? null : sample[kind];
      forcePad = opts?.pad === true;
      render(now);
    };
  }

  return {
    id: 'home',
    title: t('home.title'),
    el,
    pillSlot: pills,
    show: () => {
      heroKey = clockText = estText = plateKey = lockKey = nextKey = '';
      fetchMe();
      warmAt = performance.now();
      menu.host.prewarmAntiBot?.(); // a guest's first room rarely waits for the anti-bot check (a TV guest's rooms open with it)
      render(performance.now(), false);
    },
    tick: render,
  };
}
