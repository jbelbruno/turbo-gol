/**
 * MODOS (plan §1.4 "Modos", §1.4.1, PR 6; the owner's artboard): the screen Inicio's four tiles open,
 * stacked on JUGAR (crumbs JUGAR › MODOS), with vertical tabs CASUAL · COMPETITIVO · SALAS · CONTRA LA
 * IA (the tile that opened it says which: Menu.open's tab, Screen.setTab). Three columns on a PC:
 * the tabs, the tab's own content, and the action zone aligned at the bottom.
 *
 * - CASUAL: FORMAT IF YOU PLAY BOTS, 1v1, 2v2 and 3v3 (Casual pools every format: with other
 *   people the format follows how many they are, as the note under the grid says); its pick is the
 *   search's `prefer` and, while Casual searches, changes the running search in place (no restart:
 *   MenuHost.setQueuePrefer). COMPETITIVO: FORMAT as a 2 x 2 grid, 1v1, 2v2, 3v3 and ANY, whose
 *   pick restarts a running search, as its note says. A format's press picks it and searches (from
 *   Inicio a search of a chosen format is two presses). Then Region (the region sheet). Both always
 *   play on a server (the modes redesign, November 2026: no connection to pick). The action zone:
 *   the queue, one line, FIND MATCH (focused on a first visit); a guest's Casual and Competitive are
 *   SIGN IN (PERFIL as a detour: a sign-in there comes back here, FIND MATCH focused), a banned
 *   player's Competitive says why and for how long (duration()) and offers PLAY CASUAL.
 * - The searching panel: FINDING A MATCH, UNRANKED (or RANKED), the clock, the queue, where, the
 *   estimate, how many search (and in your region), the widening, what is wrong when something is
 *   (the servers full, no network: screens/searchModel.ts waitLines), Casual's 5:00 box to its
 *   online bots match (modesModel.ts botsCountdown, from the answer's botsInMs), CANCEL SEARCH
 *   (keyboard X, pad Y, the pill's ✕ too) and "While you wait: VS BOTS · TRAIN" (MenuHost.waitPlay).
 * - SALAS (PR 12): JOIN WITH CODE, the region and the public list (custom.ts lobbyBrowser) in the
 *   tab; the action is CREATE PUBLIC LOBBY, then CREATE PRIVATE LOBBY (screens/lobby.ts
 *   createAndShare), BACK TO LOBBY ABC 234 while the player is in one (kept with KEEP THE LOBBY: the
 *   screen no longer comes back by itself). A TV guest whose anti-bot check is not ready gets SIGN
 *   IN WITH YOUR PHONE instead (homeModel.ts roomsLocked; the check is warmed every 4 minutes there).
 * - CONTRA LA IA: mode and difficulty as mn-seg, the Stadium row (components/stadium.ts' sheet: the
 *   theme of every match and of the menus' stage), PLAY (while a search runs: its unlimited match
 *   against the bots, which the match found ends).
 *
 * Shortcuts (Screen.command): Q / E (keyboard), LB / RB and LT / RT (pad) step the tabs, round: on
 * a stacked screen the section bar is not there (plan §1.5); the hint bar calls them "Modes"
 * (tabsVerb). A tab switches on its press, not on its focus (a remote walks ▲ ▼ over them, OK
 * picks). Written on a change only (the Menu's tick: 4 Hz, 1 Hz on super low).
 */
import { h, clock, setChildren } from '../dom';
import { duration, t } from '../../i18n';
import type { Key } from '../../i18n';
import { PLAYLISTS } from '../../net/account';
import type { RegionId } from '../../net/account';
import { MODES } from '../../sim/constants';
import type { GameMode } from '../../sim/constants';
import { DIFFICULTIES } from '../../render/Hud';
import type { Difficulty } from '../../render/Hud';
import { regionName, themeName, tierName, difficultyName } from '../names';
import { tierById } from '../badges';
import type { Menu, MenuCommand, Screen, SearchView } from '../Menu';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { glyph } from '../components/glyphs';
import { slot } from '../components/tile';
import { seg } from '../components/seg';
import { picker } from '../components/picker';
import { openStadiumPicker } from '../components/stadium';
import { lobbyBrowser, tvRoomsLocked } from './custom';
import { createAndShare } from './lobby';
import { spacedCode } from './lobbyModel';
import { FORMATS, MODE_TABS, actionKind, botsCountdown, botsSegments, formatOf, formatsOf, isModeTab, modesOf, stepTab } from './modesModel';
import type { ActionKind, Format, ModeTab } from './modesModel';
import { waitLines } from './searchModel';
import { estimateText, overrideText, peopleText, reachText } from './searchText';
import { dropDetour, keepDetour } from './accountLinksModel';

/** The bots countdown's bar (as drawn). */
const SEGMENTS = 18;
/** A TV guest's anti-bot check is warmed again this often while SALAS is up (its token lasts 270 s). */
const REWARM_MS = 240_000;

const TAB_ICON: Record<ModeTab, IconName> = { casual: 'ball', ranked: 'rank', lobbies: 'friends', ai: 'bot' };
const TAB_TITLE: Record<ModeTab, Key> = { casual: 'modes.casual', ranked: 'modes.ranked', lobbies: 'modes.lobbies', ai: 'modes.vsAi' };
const TAB_INTRO: Record<ModeTab, Key> = { casual: 'modes.casualSub', ranked: 'modes.rankedIntro', lobbies: 'custom.subtitle', ai: 'friendly.intro' };

const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};
const setHidden = (el: HTMLElement, hidden: boolean): void => {
  if (el.hidden !== hidden) el.hidden = hidden;
};

/** A format's name: '2v2', or ANY. */
const formatName = (f: Format): string => (f === 'any' ? t('format.any') : f);
/** A format inside a sentence: '2v2', or '1v1, 2v2 or 3v3'. */
const formatWords = (f: Format): string => (f === 'any' ? t('format.anySub') : f);

/** The two teams of a format, drawn as the artboard does (blue bars, VS, red bars). */
function teams(m: GameMode): HTMLElement {
  const bars = (cls: string): HTMLElement[] => Array.from({ length: MODES[m] }, () => h(`span.mn-format-car.${cls}` as 'span'));
  return h('span.mn-format-teams', { 'aria-hidden': 'true' }, ...bars('mn-format-blue'), h('span.mn-format-vs', null, 'VS'), ...bars('mn-format-red'));
}

export function modesScreen(menu: Menu): Screen {
  const host = menu.host;
  const acc = host.accounts;
  const touch = (): boolean => document.documentElement.classList.contains('tg-touch');
  let tab: ModeTab = 'casual';
  /** Competitive's SIGN IN opened PERFIL: a sign-in there comes back here. */
  let waitSignIn = false;
  let aiMode: GameMode = host.mode;
  let aiDifficulty: Difficulty = host.difficulty;
  let shown = false;

  // ---- the tabs ----
  const tabEls = new Map<ModeTab, { el: HTMLButtonElement; sub: HTMLElement; end: HTMLElement }>();
  for (const id of MODE_TABS) {
    const sub = h('small.mn-mtab-sub');
    const end = h('span.mn-mtab-end');
    const el = h(
      'button.mn-tab.mn-mtab',
      { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': true, 'data-key': 'tab-' + id, onclick: () => pick(id) },
      icon(TAB_ICON[id]),
      h('span.mn-mtab-text', null, h('b.mn-mtab-name', { 'data-fit': '14' }, t(TAB_TITLE[id])), sub),
      end,
      h('span.mn-mtab-mark', { 'aria-hidden': 'true' }),
    );
    tabEls.set(id, { el, sub, end });
  }
  const tabList = h('div.mn-tabs.mn-mtabs', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('nav.modes') }, ...[...tabEls.values()].map((x) => x.el));
  const keys = h('span.mn-modes-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-q'), glyph('key-e')), h('span.mn-keys-pad', null, glyph('pad-lb'), glyph('pad-rb')));
  const side = h('div.mn-modes-side', null, h('div.mn-modes-head', null, h('span.mn-modes-label', null, t('nav.modes')), keys), tabList);

  // ---- the center: title, intro, and the tab's own part ----
  const title = h('h1.mn-modes-title', { 'data-fit': '20' });
  const intro = h('p.mn-modes-intro');
  const formatEls = new Map<Format, { el: HTMLButtonElement; tag: HTMLElement; sub: HTMLElement }>();
  for (const f of FORMATS) {
    const tag = h('span.mn-format-tag');
    const sub = h('span.mn-format-sub');
    const el = h(
      'button.mn-format',
      { type: 'button', 'data-nav': true, 'data-key': 'format-' + f, 'aria-pressed': 'false', onclick: () => pickFormat(f) },
      h('span.mn-format-top', null, f === 'any' ? icon('ball') : teams(f), tag),
      h('span.mn-format-text', null, h('span.mn-format-name', null, formatName(f)), sub),
    );
    formatEls.set(f, { el, tag, sub });
  }
  const formats = h('div.mn-formats', null, ...[...formatEls.values()].map((x) => x.el));
  // Competitive: a pick restarts its running search; Casual: the format of its bots match, the
  // pool takes every format (its own note, always).
  const noteText = h('span');
  const note = h('p.mn-modes-note', { hidden: true }, icon('info'), noteText);
  const formatLabel = h('span.mn-modes-label');
  const region = picker('modes-region', 'globe', t('common.region'), () => menu.openRegionSheet());
  const queuePart = h('div.mn-modes-queue', null, formatLabel, formats, note, h('div.mn-modes-rows', null, region.el));
  const lobbies = lobbyBrowser(menu);
  const lobbiesPart = h('div.mn-modes-lobbies', { hidden: true }, lobbies.el);
  const modeSeg = seg<GameMode>('ai-mode', t('friendly.mode'), PLAYLISTS.map((p) => ({ value: p, label: p })), () => aiMode, (v) => (aiMode = v));
  const diffSeg = seg<Difficulty>('ai-diff', t('friendly.difficulty'), DIFFICULTIES.map((d) => ({ value: d, label: difficultyName(d) })), () => aiDifficulty, (v) => (aiDifficulty = v));
  const stadium = picker('ai-stadium', 'stadium', t('friendly.theme'), () => openStadiumPicker(menu, () => stadium.set(themeName(host.theme))));
  const aiPart = h(
    'div.mn-modes-ai',
    { hidden: true },
    h('div.mn-modes-field', null, h('span.mn-modes-label', null, t('friendly.mode')), modeSeg.el),
    h('div.mn-modes-field', null, h('span.mn-modes-label', null, t('friendly.difficulty')), diffSeg.el),
    h('div.mn-modes-rows', null, stadium.el),
  );
  const main = h('div.mn-modes-main', null, title, intro, queuePart, lobbiesPart, aiPart);

  // ---- the action zone: idle (summary, line, the primary) or the searching panel ----
  const summary = h('div.mn-act-summary', { 'data-fit': '16' });
  const line = h('p.mn-act-line');
  const go = h('button.mn-btn.mn-btn-primary.mn-act-go', { type: 'button', 'data-nav': true, 'data-key': 'modes-go', 'data-autofocus': true, onclick: () => primary() }, h('span.mn-act-go-label'), icon('next'));
  const goLabel = go.firstElementChild as HTMLElement;
  // SALAS' second: CREATE PRIVATE LOBBY (the primary is CREATE PUBLIC LOBBY).
  const go2 = h('button.mn-btn.mn-act-go2', { type: 'button', 'data-nav': true, 'data-key': 'modes-go2', hidden: true, onclick: () => void createAndShare(menu, 'private') }, h('span', null, t('lobby.createPrivate')));
  const idle = h('div.mn-act-idle', null, summary, line, go, go2);
  const sTag = h('span.mn-act-tag');
  const sClock = h('div.mn-act-clock');
  const sQueue = h('div.mn-act-queue');
  const sWhere = h('div.mn-act-where');
  // The estimate (always), how many search, the widening, and what is wrong (searchModel.ts).
  const sEstimate = h('div.mn-act-est');
  const sPeople = h('div.mn-act-where.mn-act-people');
  const sReach = h('div.mn-act-where.mn-act-reach');
  const sWarn = h('div.mn-act-est.mn-act-warn', { hidden: true });
  const botsTime = h('b.mn-act-bots-time');
  const botsBar = h('span.mn-act-bar', { 'aria-hidden': 'true' }, ...Array.from({ length: SEGMENTS }, () => h('span')));
  const bots = h('div.mn-act-bots', { hidden: true }, h('div.mn-act-bots-row', null, icon('bot'), h('span', null, t('search.bots')), botsTime), botsBar, h('p.mn-act-always', null, t('search.always')));
  const cancel = h(
    'button.mn-btn.mn-act-cancel',
    {
      type: 'button',
      'data-nav': true,
      'data-key': 'modes-cancel',
      'data-autofocus': true, // a first visit while searching (the pill, the hero): FIND MATCH is hidden
      onclick: () => {
        menu.cancelSearch();
        render(performance.now());
        if (!touch()) go.focus({ preventScroll: true });
      },
    },
    icon('close'),
    h('span', null, t('search.cancel')),
    h('span.mn-act-keys', { 'aria-hidden': 'true' }, h('span.mn-keys-kb', null, glyph('key-x')), h('span.mn-keys-pad', null, glyph('pad-y'))),
  );
  // "While you wait: VS BOTS · TRAIN": local play with the search alive (the match found ends it).
  const waitBtn = (kind: 'bots' | 'training', ic: IconName, label: Key): HTMLButtonElement =>
    h('button.mn-act-practice', { type: 'button', 'data-nav': true, 'data-key': 'modes-wait-' + kind, onclick: () => host.waitPlay(kind) }, icon(ic), h('u', null, t(label)));
  const practice = h('div.mn-act-wait', { 'data-nav-row': true }, h('span.mn-act-wait-label', null, t('search.whileWaiting')), waitBtn('bots', 'bot', 'search.waitBots'), waitBtn('training', 'training', 'search.waitTraining'));
  const searching = h(
    'div.mn-act-search',
    { hidden: true, role: 'status' },
    h('div.mn-act-head', null, h('span.mn-act-title', null, h('span.mn-spinner'), t('search.title')), sTag),
    sClock,
    sQueue,
    sWhere,
    sEstimate,
    sPeople,
    sReach,
    sWarn,
    bots,
    cancel,
    practice,
    h('span.mn-act-stripe', { 'aria-hidden': 'true' }, h('span.mn-busy')),
  );
  const act = h('section.mn-act', null, idle, searching);
  const el = h('section.mn-modes', { 'data-tablero': true }, side, main, h('div.mn-modes-act', null, act));

  // ---- state ----
  const kindOf = (x: ModeTab): 'casual' | 'ranked' => (x === 'ranked' ? 'ranked' : 'casual');
  const banLeft = (): number => (acc.signedIn ? (acc.me?.rankedBanUntil ?? 0) - Date.now() : 0);
  /** Competitive's playlists, Casual's preferred format. */
  const modesFor = (kind: 'casual' | 'ranked'): GameMode[] => (kind === 'ranked' ? menu.prefs.rankedModes : [menu.prefs.casualPrefer]);
  let warmAt = 0;
  const tvGuest = (): boolean => document.documentElement.classList.contains('tg-tv') && !acc.signedIn;
  /** A region's name: the queue's own, else the automatic one; "Automatic" before the server said which. */
  const regionText = (id: RegionId | null): string => {
    const r = id ?? menu.regionId;
    return r !== null ? regionName(r) : t('common.regionAuto');
  };
  const kindName = (kind: 'casual' | 'ranked'): string => t(kind === 'ranked' ? 'modes.ranked' : 'modes.casual');
  const searchView = (): SearchView => host.searchView();
  const runningKind = (v: SearchView): 'casual' | 'ranked' | null => (v.active ? v.kind : null);
  const state = (): ActionKind => actionKind({ tab, signedIn: acc.signedIn, banLeft: banLeft(), searching: runningKind(searchView()) });

  /** Search `kind` with its playlists (a running one of another queue is replaced: Game.menuSearch). */
  const search = (kind: 'casual' | 'ranked'): void => {
    const modes = modesOf(formatOf(modesFor(kind)));
    menu.beforeMatch(() => menu.startSearch({ kind, modes, region: menu.prefs.region }));
  };

  const pickFormat = (f: Format): void => {
    const kind = kindOf(tab);
    if (kind === 'casual' && f === 'any') return;
    const modes = modesOf(f);
    if (kind === 'ranked') menu.prefs.rankedModes = modes;
    else menu.prefs.casualPrefer = modes[0];
    menu.savePrefs();
    const s = state();
    if (s === 'signIn' || s === 'banned') return render(performance.now());
    const v = searchView();
    // Casual searching: the pick changes the running search in place (its `prefer`), no restart.
    if (kind === 'casual' && v.active && v.kind === 'casual') {
      host.setQueuePrefer(modes[0]);
      return render(performance.now());
    }
    // The same format searching already: nothing to restart.
    if (v.active && v.kind === kind && formatOf(v.modes) === f) return render(performance.now());
    search(kind);
    render(performance.now());
  };

  const primary = (): void => {
    switch (state()) {
      case 'search':
        search(kindOf(tab));
        break;
      case 'signIn':
        waitSignIn = true;
        // Kept across a provider's round trip too (sessionStorage): the sign-in comes back to this tab.
        keepDetour({ screen: 'modes', tab });
        menu.open('profile');
        return;
      case 'banned':
        tab = 'casual';
        search('casual');
        break;
      case 'play':
        // While a search runs: its unlimited match against the bots (MenuHost.playFriendly keeps the search).
        menu.beforeMatch(() => host.playFriendly(aiMode, aiDifficulty));
        return;
      case 'lobbies':
        // In a lobby: its screen; a TV guest whose check is not ready: the phone's sign-in.
        if (!host.lobby.inLobby && tvRoomsLocked(menu)) menu.tvSignIn();
        else void createAndShare(menu, 'public');
        return;
      case 'searching':
        break;
    }
    render(performance.now());
  };

  /** Switch to `id` (a tab's press, Q / E, LB / RB). The focus follows to the new tab when it was on the tabs, else to its action. */
  const pick = (id: ModeTab): void => {
    const onTabs = tabList.contains(document.activeElement);
    const changed = id !== tab;
    tab = id;
    render(performance.now());
    if (changed) {
      if (tab === 'lobbies') lobbies.show();
      menu.refit();
    }
    if (touch()) return;
    if (onTabs) tabEls.get(id)?.el.focus({ preventScroll: true });
    else if (changed) go.focus({ preventScroll: true });
  };

  // ---- render: only what changed ----
  let lastTab: ModeTab | null = null;
  let lastState: ActionKind | null = null;
  const render = (now: number): void => {
    const v = searchView();
    const running = runningKind(v);
    const s = state();
    const casualLike = tab === 'casual' || tab === 'ranked';
    if (tab !== lastTab) {
      lastTab = tab;
      for (const [id, x] of tabEls) {
        const on = id === tab;
        x.el.classList.toggle('mn-tab-on', on);
        x.el.setAttribute('aria-selected', String(on));
      }
      el.dataset.tab = tab;
      setText(title, t(TAB_TITLE[tab]));
      setHidden(queuePart, !casualLike);
      setHidden(lobbiesPart, tab !== 'lobbies');
      setHidden(aiPart, tab !== 'ai');
      if (casualLike) {
        // Casual's grid has no ANY (it pools every format).
        const shown = formatsOf(kindOf(tab));
        for (const [f, x] of formatEls) setHidden(x.el, !shown.includes(f));
        setText(formatLabel, t(tab === 'casual' ? 'modes.formatPrefer' : 'modes.format'));
      }
    }
    // VS AI's intro while a search runs: its PLAY is the wait's unlimited match.
    setText(intro, t(tab === 'ai' && running !== null ? 'friendly.introWaiting' : TAB_INTRO[tab]));
    // A TV guest's rooms: the check warmed again every 4 minutes while SALAS is up (its buttons
    // unlock with it; a warm token is renewed before it goes, so they lock again only if that fails).
    if (tab === 'lobbies' && tvGuest() && now - warmAt >= REWARM_MS) {
      warmAt = now;
      host.prewarmAntiBot?.();
    }
    // The tabs' second lines: Casual's and Competitive's lock for a guest, a ban's time; the searching tab's clock.
    for (const [id, x] of tabEls) {
      const lockText = (id === 'ranked' || id === 'casual') && !acc.signedIn ? t('modes.rankedLocked') : '';
      const subKey: Key = id === 'casual' ? 'modes.casualSubShort' : id === 'ranked' ? 'modes.rankedSubShort' : id === 'lobbies' ? 'modes.tabLobbiesSub' : 'modes.tabAiSub';
      setText(x.sub, lockText !== '' ? lockText : t(subKey));
      const busy = running !== null && running === id;
      const endKey = busy ? 'busy' : lockText !== '' || (id === 'ranked' && banLeft() > 0) ? 'lock' : '';
      if (x.end.dataset.kind !== endKey) {
        x.end.dataset.kind = endKey;
        setChildren(x.end, endKey === 'busy' ? h('span.mn-spinner') : null, endKey === 'busy' ? h('span.mn-mtab-clock') : endKey === 'lock' ? icon('lock') : null);
      }
      if (busy) setText(x.end.lastElementChild as HTMLElement, clock(now - v.since));
    }
    if (casualLike) {
      const kind = kindOf(tab);
      const picked = formatOf(modesFor(kind));
      const searchingHere = running === kind;
      const searchingFormat = searchingHere ? formatOf(v.modes) : null;
      for (const [f, x] of formatEls) {
        const pressed = String(f === picked);
        if (x.el.getAttribute('aria-pressed') !== pressed) x.el.setAttribute('aria-pressed', pressed);
        const tagKey = f === searchingFormat ? 'busy' : f === 'any' ? 'any' : '';
        if (x.tag.dataset.kind !== tagKey) {
          x.tag.dataset.kind = tagKey;
          setChildren(x.tag, tagKey === 'busy' ? slot(t('home.searching'), { ink: true }) : tagKey === 'any' ? slot(t('format.fastest'), { drop: true }) : null);
        }
        let sub = f === 'any' ? t('format.anySub') : '';
        if (kind === 'ranked' && f !== 'any') {
          const r = acc.me?.ratings.find((x2) => x2.playlist === f);
          const tier = r ? tierById(r.tier) : null;
          sub = r ? (r.placementLeft > 0 ? t('play.placement', { games: r.games, total: r.games + r.placementLeft }) : tier ? tierName(tier) : '') : '';
        }
        setText(x.sub, sub);
        setHidden(x.sub, sub === '');
      }
      // Casual's note always (the format of its bots match); Competitive's while it searches (a pick restarts it).
      setText(noteText, t(kind === 'casual' ? 'modes.formatPreferNote' : 'search.formatRestarts'));
      setHidden(note, kind === 'ranked' && !searchingHere);
      region.set(menu.regionLabel);
    }
    if (tab === 'ai') {
      modeSeg.refresh();
      diffSeg.refresh();
      stadium.set(themeName(host.theme));
    }
    // The action zone.
    const isSearching = s === 'searching';
    if (s !== lastState) {
      lastState = s;
      const lost = act.contains(document.activeElement) && (document.activeElement as HTMLElement).closest('[hidden]') === null;
      setHidden(idle, isSearching);
      setHidden(searching, !isSearching);
      act.classList.toggle('mn-act-on', isSearching);
      // The focus that was in the zone stays in it (FIND MATCH <-> CANCEL SEARCH).
      if (lost && !touch()) (isSearching ? cancel : go).focus({ preventScroll: true });
      menu.refit();
    }
    if (isSearching) {
      const kind = v.kind ?? 'casual';
      const f = formatOf(v.modes);
      if (sTag.dataset.kind !== kind) {
        sTag.dataset.kind = kind;
        setChildren(sTag, slot(t(kind === 'ranked' ? 'search.rankedTag' : 'search.unranked')));
      }
      setText(sClock, clock(now - v.since));
      // Casual pools every format: its name and its region; Competitive its playlists.
      setText(sQueue, kind === 'ranked' ? `${kindName(kind)} · ${formatName(f)}` : kindName(kind));
      setText(sWhere, kind === 'ranked' ? t('search.where', { format: formatWords(f), region: regionText(v.region) }) : t('search.whereCasual', { region: regionText(v.region) }));
      // The estimate, the people (exact counts, the owner's "how many are searching"), the reach, what is wrong.
      const wl = waitLines({ kind, since: v.since, wait: v.wait ?? null, waitAt: v.waitAt ?? 0, retrying: v.retrying === true, times: menu.cfg?.queue ?? null }, now);
      setText(sEstimate, estimateText(wl.estimate));
      setHidden(sPeople, wl.people === null);
      if (wl.people !== null) setText(sPeople, peopleText(wl.people, regionText(v.region)));
      setText(sReach, reachText(wl.reach));
      const warn = overrideText(wl.override);
      setHidden(sWarn, warn === null);
      if (warn !== null) setText(sWarn, warn);
      const left = botsCountdown({ kind, since: v.since, now, wait: v.wait ?? null, waitAt: v.waitAt ?? 0, soloAfterMs: menu.cfg?.queue?.soloAfterMs });
      setHidden(bots, left === null);
      if (left !== null) {
        setText(botsTime, clock(left.left + 999));
        const on = botsSegments(left.left, left.total, SEGMENTS);
        botsBar.childNodes.forEach((n, i) => (n as HTMLElement).classList.toggle('on', i < on));
      }
    } else {
      let sum: string;
      let lineText: string;
      let label: string;
      const kind = kindOf(tab);
      // Casual pools every format: its queue is its name and region.
      const queue = kind === 'ranked' ? `${kindName(kind)} · ${formatName(formatOf(modesFor(kind)))} · ${regionText(menu.prefs.region)}` : `${kindName(kind)} · ${regionText(menu.prefs.region)}`;
      let second = false;
      switch (s) {
        case 'signIn':
          sum = t(kind === 'casual' ? 'search.casualNeedsAccount' : 'search.needsAccount');
          lineText = '';
          label = t('search.signIn');
          break;
        case 'banned':
          sum = t('search.banned', { time: duration(banLeft()) });
          lineText = t('search.bannedLine');
          label = t('search.playCasual');
          break;
        case 'play':
          sum = `${t('modes.vsAi')} · ${aiMode} · ${difficultyName(aiDifficulty)}`;
          lineText = t('modes.vsAiSub');
          label = t('friendly.play');
          break;
        case 'lobbies': {
          const code = host.lobby.inLobby ? (host.lobby.state?.code ?? host.lobby.code) : null;
          const tvLocked = code === null && tvRoomsLocked(menu);
          sum = t('modes.lobbies');
          // CREATE PUBLIC LOBBY, then CREATE PRIVATE LOBBY; a TV guest whose check is not ready: the phone's sign-in.
          lineText = code !== null ? '' : t(tvLocked ? 'modes.lobbiesTvLocked' : 'modes.lobbiesAction');
          label = code !== null ? t('lobby.backTo', { code: spacedCode(code) }) : t(tvLocked ? 'tvsign.tile' : 'lobby.createPublic');
          second = code === null && !tvLocked;
          break;
        }
        default:
          sum = queue;
          lineText = kind === 'ranked' ? t('modes.rankedSub') : t('search.always');
          label = t('search.find');
      }
      setText(summary, sum);
      setText(line, lineText);
      setHidden(line, lineText === '');
      setText(goLabel, label);
      if (go2.hidden === second) {
        // Its focus goes back to the primary, never to the page's body.
        if (!second && document.activeElement === go2 && !touch()) go.focus({ preventScroll: true });
        setHidden(go2, !second);
        menu.refit();
      }
    }
  };

  // A sign-in on PERFIL (Competitive's SIGN IN): back here, FIND MATCH focused (the same control, data-key).
  acc.subscribe(() => {
    if (!waitSignIn || !acc.signedIn) return;
    waitSignIn = false;
    dropDetour();
    if (menu.top()?.id === 'profile') menu.back();
  });

  const command = (c: MenuCommand): boolean => {
    if (c !== 'prev' && c !== 'next' && c !== 'tabPrev' && c !== 'tabNext') return false;
    pick(stepTab(tab, c === 'prev' || c === 'tabPrev' ? -1 : 1));
    return true;
  };

  return {
    id: 'modes',
    title: t('nav.modes'),
    el,
    tabsVerb: 'nav.tabsModes',
    setTab: (id) => {
      if (isModeTab(id)) tab = id;
    },
    show: () => {
      shown = true;
      // Back here (from PERFIL, or the sign-in's return): no detour waits any more.
      dropDetour();
      aiMode = host.mode;
      aiDifficulty = host.difficulty;
      lastTab = null;
      lastState = null;
      warmAt = 0;
      if (tab === 'lobbies') lobbies.show();
      if (acc.signedIn) void acc.fetchMe().then(() => shown && render(performance.now()), () => undefined);
      render(performance.now());
    },
    hide: () => {
      shown = false;
    },
    tick: (now) => {
      render(now);
      if (tab === 'lobbies') lobbies.tick(now);
    },
    command,
  };
}
