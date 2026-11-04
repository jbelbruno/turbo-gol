/**
 * MODOS › SALAS' part (plan §6.4, PR 12; lobbyBrowser: screens/modes.ts, whose action zone has
 * CREATE PUBLIC LOBBY and CREATE PRIVATE LOBBY): the JOIN WITH CODE tile (mn-codecells in a sheet,
 * screens/lobby.ts), the region (mn-picker: the region sheet), and the public lobbies (every
 * region, the player's own first) in 56 px rows (name, format, players / places, a state slot: OPEN,
 * IN MATCH, FULL; a full or playing row stays focusable and its press says why), or "No public
 * lobbies right now" with CREATE PUBLIC LOBBY. Also the host's SETTINGS dialog (configureLobby) and
 * the labels the Sala shares. Lobbies are always P2P (the modes redesign, November 2026): no
 * connection to pick, none to show.
 *
 * A TV guest whose anti-bot check is not ready (homeModel.ts roomsLocked: a remote may not pass one
 * that asks) gets the phone's sign-in instead of a join: JOIN WITH CODE shows a lock, its press and a
 * row's open the sign-in, and the empty list offers nothing (MODOS' action zone says SIGN IN WITH
 * YOUR PHONE, once).
 *
 * Experimental rules (Settings > Experimental presets, src/game/physicsRules.ts): a signed-in host
 * with the switch on picks them in the settings ("Rules (experimental)": Standard, the built-ins,
 * the player's own presets; EDIT PRESETS opens Settings > Experimental and comes back with the
 * draft kept). The list tags such a lobby EXP (with a lock for a guest, who cannot join it) and the
 * Sala shows the rules line before the match. The server enforces all of it (LobbyDO, the
 * matchmaker, RoomDO).
 */
import { h, setChildren } from '../dom';
import { LOBBY_LENGTHS, PLAYLISTS, lobbyNameIssue } from '../../net/account';
import type { LobbySettings, LobbyState, LobbySummary, Playlist } from '../../net/account';
import { AccountError } from '../../net/AccountClient';
import { isStock, parseLobbyRules, sameValues, snapshotOf, type RulesSnapshot } from '../../game/physicsRules';
import type { ListedPreset } from '../../game/experimentalStore';
import { t } from '../../i18n';
import { lobbyRulesLine, presetName } from '../../render/rulesText';
import type { Menu } from '../Menu';
import { lobbyTitle, regionName } from '../names';
import { icon } from '../components/icons';
import { picker } from '../components/picker';
import { slot } from '../components/tile';
import { cycler, field, secondary } from './common';
import { createAndShare, joinFlow, openCodeEntry, salaTitle } from './lobby';
import { rowState } from './lobbyModel';
import type { RowState } from './lobbyModel';
import { roomsLocked } from './homeModel';

const REFRESH_MS = 5_000;

export function lengthLabel(s: number): string {
  return s === 0 ? t('custom.noLimit') : t('custom.minutes', { count: s / 60 });
}

/** A TV guest's rooms wait for the anti-bot check (homeModel.ts roomsLocked): its SIGN IN WITH YOUR PHONE then. */
export function tvRoomsLocked(menu: Menu): boolean {
  return roomsLocked({ tv: document.documentElement.classList.contains('tg-tv'), guest: !menu.host.accounts.signedIn, antiBotReady: menu.host.antiBotReady === true });
}

function errText(e: unknown): string {
  return e instanceof AccountError ? e.message : e instanceof Error ? e.message : String(e);
}

/** A lobby's experimental rules as the server sent them, checked as strictly as the server does (null: standard, or not readable here). */
export function lobbyRules(raw: unknown): RulesSnapshot | null {
  const r = parseLobbyRules(raw);
  return r === 'bad' ? null : r;
}

/**
 * The presets a lobby host may pick as experimental rules (ExperimentalStore.list(): the built-ins
 * first, then the player's own), null unless the player is signed in with Settings > Experimental
 * on (guests and players with the switch off never see the rules row).
 */
function lobbyPresets(menu: Menu): readonly ListedPreset[] | null {
  const exp = menu.host.experimental;
  return exp.unlocked ? exp.store.list() : null;
}

/** One option of the rules cycler: a preset's name and the snapshot a lobby gets of it (null = standard physics). */
interface RulesChoice {
  id: string;
  label: string;
  physics: RulesSnapshot | null;
}

function sameRules(a: RulesSnapshot | null, b: RulesSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && sameValues(a.values, b.values);
}

/**
 * The rules cycler's options: the presets the player may pick (built-ins first, null when the
 * player is not unlocked: then only Standard), plus the lobby's current rules when they are none of
 * them (a preset edited since, or a host that took over the lobby) and `keepId` (the preset picked
 * before EDIT PRESETS) is not one of them either. Null: no rules row at all (a player who is not
 * unlocked, in a lobby without rules).
 */
export function rulesChoices(presets: readonly ListedPreset[] | null, current: RulesSnapshot | null, keepId: string | null = null): RulesChoice[] | null {
  if (presets === null && current === null) return null;
  const out: RulesChoice[] = [];
  for (const p of presets ?? []) {
    const label = presetName(p);
    out.push({ id: p.id, label, physics: isStock(p.values, 'match') ? null : snapshotOf(label, p.values) });
  }
  if (!out.some((c) => c.physics === null)) out.unshift({ id: 'standard', label: t('rules.builtin.standard'), physics: null });
  const kept = keepId !== null && keepId !== 'lobby' && out.some((c) => c.id === keepId);
  if (!kept && current !== null && !out.some((c) => sameRules(c.physics, current))) out.push({ id: 'lobby', label: current.name, physics: current });
  return out;
}

/** The rules row of the host's settings, when it has one: what `settingsControls` needs. */
interface RulesControls {
  /** Settings > Experimental's presets (lobbyPresets: MenuHost.experimental), null when the player is not unlocked. */
  presets: readonly ListedPreset[] | null;
  /** EDIT PRESETS (unlocked players only): open Settings > Experimental, then come back with the draft. */
  onEdit: (() => void) | null;
  /**
   * The id picked in the rules cycler, kept by the screen across EDIT PRESETS: back from it the same
   * preset is picked again with the values it has NOW (an edit applies; a deleted one falls back to
   * the rules the draft holds), never a stale copy of it under the same name.
   */
  pick: { id: string | null };
}

const ROW_STATE: Record<RowState, 'lobby.rowOpen' | 'lobby.rowInMatch' | 'lobby.rowFull'> = { open: 'lobby.rowOpen', inMatch: 'lobby.rowInMatch', full: 'lobby.rowFull' };

/**
 * The SALAS tab's part: the JOIN WITH CODE tile and the region row, then the public list (loaded
 * every REFRESH_MS on the screen's tick while the tab is shown). `show` as the tab shows (the list
 * loads again), `tick` on the Menu's tick.
 */
export function lobbyBrowser(menu: Menu): { el: HTMLElement; show: () => void; tick: (now: number) => void } {
  const list = h('div.mn-lobbies');
  const status = h('p.mn-lobbies-status', { hidden: true });
  // A TV guest whose check is not ready: JOIN WITH CODE locked, its press the phone's sign-in (the
  // action zone's SIGN IN WITH YOUR PHONE says it once; the empty list says nothing more).
  const joinTile = h('button.mn-lobby-join', { type: 'button', 'data-nav': true, 'data-key': 'lobby-join-code', onclick: () => (tvRoomsLocked(menu) ? menu.tvSignIn() : openCodeEntry(menu)) });
  let joinLocked: boolean | null = null;
  const drawJoin = (): void => {
    const locked = tvRoomsLocked(menu);
    if (locked === joinLocked) return;
    joinLocked = locked;
    setChildren(joinTile, icon('code'), h('span.mn-lobby-join-text', null, h('b', null, t('lobby.joinCode')), h('small', null, t(locked ? 'modes.lobbiesTvLocked' : 'lobby.joinCodeSub'))), icon(locked ? 'lock' : 'next'));
  };
  drawJoin();
  const region = picker('lobbies-region', 'globe', t('common.region'), () => menu.openRegionSheet());
  let refreshAt = 0;
  let loading = false;
  const row = (l: LobbySummary): HTMLElement => {
    // Experimental rules: an EXP tag (a lock for a guest, who cannot join), the rules on hover.
    const exp = l.experimental === true;
    const guest = exp && !menu.host.accounts.signedIn;
    const rules = exp ? lobbyRules(l.physics) : null;
    const tag = exp ? h('span.mn-tag.mn-tag-exp', { title: rules !== null ? t('custom.rulesInfo', { summary: lobbyRulesLine(rules) }) : '' }, guest ? icon('lock') : null, t('custom.tagExperimental')) : null;
    const st = rowState(l);
    const press = (): void => {
      // A full or playing lobby says why; the server refuses a guest an experimental one anyway (403 account_required).
      if (st === 'full') menu.toast(t('lobby.whyFull'), 'info');
      else if (st === 'inMatch') menu.toast(t('lobby.whyInMatch'), 'info');
      else if (guest) menu.toast(t('error.lobby.account_required'), 'error');
      else if (tvRoomsLocked(menu)) menu.tvSignIn();
      else void joinFlow(menu, l.code, l.locked);
    };
    return h(
      `button.mn-lobby-row.mn-lobby-${st}` as 'button',
      { type: 'button', 'data-nav': true, 'data-code': l.code, 'data-key': 'lobby-' + l.code, onclick: press },
      h('span.mn-lobby-name', null, l.locked ? icon('lock') : null, h('span', null, lobbyTitle(l.name, l.host)), tag),
      h('span.mn-lobby-mode', null, l.mode),
      h('span.mn-lobby-players', null, `${l.players}/${l.max}`),
      h('span.mn-lobby-state', null, slot(t(ROW_STATE[st]), { ink: st === 'open' })),
    );
  };
  // The public list spans every region (the player's own first): no region in the empty line. A TV
  // guest whose check is not ready: the line alone (the action zone's button is the way in).
  const empty = (): HTMLElement =>
    h('div.mn-lobbies-empty', null, h('p', null, t('lobby.empty')), tvRoomsLocked(menu) ? null : secondary(t('lobby.createPublic'), () => void createAndShare(menu, 'public'), { 'data-key': 'lobby-create-public' }));
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    region.set(menu.regionLabel);
    try {
      const lobbies = await menu.host.lobby.list(menu.prefs.region);
      const focusedCode = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-code') ?? null;
      setChildren(list, ...(lobbies.length > 0 ? lobbies.map(row) : [empty()]));
      status.hidden = true;
      if (focusedCode) (list.querySelector(`[data-code="${focusedCode}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
      menu.refit();
    } catch (e) {
      status.hidden = false;
      status.textContent = errText(e);
    } finally {
      loading = false;
    }
  };
  const el = h('div.mn-custom', null, h('div.mn-lobby-tools', null, joinTile, region.el), h('span.mn-modes-label', null, t('lobby.public')), list, status);
  return {
    el,
    show: () => {
      refreshAt = 0;
      region.set(menu.regionLabel);
      setChildren(list, h('div.mn-empty', null, t('custom.loading')));
    },
    tick: (now) => {
      drawJoin(); // a TV guest's check warmed (or a session came): the code again
      if (now < refreshAt) return;
      refreshAt = now + REFRESH_MS;
      void load();
    },
  };
}

/**
 * The settings controls of the host's SETTINGS dialog (configureLobby). With `rules`, the
 * experimental rules row (lobbies are always P2P now: no connection row, the rules row always there
 * for an unlocked host). A stored `net` other than P2P is sent back as P2P (the server reads it so).
 */
function settingsControls(s: LobbySettings, rules: RulesControls | null = null): HTMLElement[] {
  s.net = 'p2p';
  const current = lobbyRules(s.physics ?? null);
  const choices = rules !== null ? rulesChoices(rules.presets, current, rules.pick.id) : null;
  let rulesRow: HTMLElement | null = null;
  if (rules !== null && choices !== null) {
    const kept = rules.pick.id !== null ? choices.find((c) => c.id === rules.pick.id) : undefined;
    let picked = (kept ?? choices.find((c) => sameRules(c.physics, current)) ?? choices[0]).id;
    rules.pick.id = picked;
    s.physics = kept !== undefined ? kept.physics : current;
    const note = h('div.mn-rules-note', null, t('custom.rulesNote'));
    const pick = cycler<string>(t('custom.settingRules'), choices.map((c) => ({ value: c.id, label: c.label })), () => picked, (id) => {
      picked = id;
      rules.pick.id = id;
      s.physics = choices.find((c) => c.id === id)?.physics ?? null;
      note.hidden = s.physics === null;
    });
    note.hidden = s.physics === null;
    const edit = rules.onEdit !== null ? secondary(t('custom.editPresets'), rules.onEdit) : null;
    rulesRow = h('div.mn-rules', null, pick.el, note, edit);
  }
  return [
    cycler<Playlist>(t('custom.settingMode'), PLAYLISTS.map((p) => ({ value: p, label: p })), () => s.mode, (v) => (s.mode = v)).el,
    cycler<'public' | 'private'>(t('custom.settingVisibility'), [{ value: 'public', label: t('custom.visibilityPublicListed') }, { value: 'private', label: t('custom.visibilityPrivateCode') }], () => s.visibility, (v) => (s.visibility = v)).el,
    cycler<number>(t('custom.settingLength'), LOBBY_LENGTHS.map((l) => ({ value: l, label: lengthLabel(l) })), () => s.matchLengthSeconds, (v) => (s.matchLengthSeconds = v)).el,
    ...(rulesRow !== null ? [rulesRow] : []),
  ];
}

/**
 * The host's SETTINGS dialog (the Sala's "…"): name, format, visibility, length, the
 * experimental rules row for an unlocked player, the password. `kept`: the draft (typed name, picked
 * rules) to reopen with, back from EDIT PRESETS. A format change is remembered for the next lobby.
 * The name field shows the title as the Sala does (names.ts lobbyTitle) and is sent only when it
 * changed; a guest host sees it read-only (the server never takes a guest's title), with why.
 */
export function configureLobby(menu: Menu, s: LobbyState, kept?: { draft: LobbySettings; name: string; pick: { id: string | null } }): void {
  const lobby = menu.host.lobby;
  const draft: LobbySettings = kept?.draft ?? { ...s.settings };
  const pick = kept?.pick ?? { id: null };
  const shown = salaTitle(s);
  const guestHost = s.members.find((m) => m.id === s.you)?.guest === true;
  const name = guestHost ? null : field(t('custom.nameField'), { maxLength: 24, value: kept?.name ?? shown });
  const title = name?.el ?? h('div.mn-field', null, h('span.mn-field-label', null, t('custom.nameField')), h('b', null, shown), h('p.mn-note', null, t('custom.guestTitle')));
  const pw = field(s.hasPassword ? t('custom.newPassword') : t('custom.passwordOptional'), { type: 'password', maxLength: 32 });
  const presets = lobbyPresets(menu);
  const onEdit =
    presets === null
      ? null
      : () => {
          close();
          menu.openSettings(() => {
            // The lobby may have gone, or started, while the settings were open.
            const now = lobby.state;
            if (now !== null && now.status === 'open' && lobby.isHost) configureLobby(menu, now, { draft, name: name?.input.value ?? shown, pick });
            else menu.refocus();
          }, { tab: 'experimental' });
        };
  const close = menu.modal({
    title: t('custom.configureTitle'),
    body: [title, ...settingsControls(draft, { presets, onEdit, pick }), pw.el],
    actions: [
      {
        label: t('custom.save'),
        primary: true,
        onClick: () => {
          // The title only when it changed (the server keeps the stored one, a guest's always).
          const n = name?.input.value.trim() ?? shown;
          if (name !== null && n !== shown) {
            if (n.length < 3) {
              name.error(t('custom.nameLength'));
              return false;
            }
            if (lobbyNameIssue(n) !== null) {
              name.error(t('error.lobby.name_reserved'));
              return false;
            }
          }
          const { name: _stored, ...rest } = draft;
          menu.prefs.lobbyMode = draft.mode;
          menu.savePrefs();
          lobby.updateSettings(name !== null && n !== shown ? { ...rest, name: n } : rest, pw.input.value.length > 0 ? pw.input.value : s.hasPassword ? null : undefined);
          return true;
        },
      },
      { label: t('custom.cancel'), onClick: () => true },
    ],
  });
}
