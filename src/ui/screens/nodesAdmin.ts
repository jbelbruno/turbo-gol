/**
 * CONTROL DE NODOS (prompt 1, part B4): the maintainers' panel of the community nodes, opened from
 * PERFIL › CUENTA DEL PROYECTO (profile.ts, decision 5) and stacked on PERFIL (sections.ts
 * SCREEN_SECTION: Back comes back there). Its logic is nodesAdminModel.ts; the calls are
 * AccountClient's, through the Worker's maintainer gate (a session that is not a TV's, of a
 * NODE_TRUSTED_OPERATORS account, its password typed in the last 15 minutes).
 *
 *   RESUMEN    the KPIs (nodes online by region, matches now, the verification queue, the outbox,
 *              the trusted slots), the channel, the warnings, the opening of hosting (Prompt 2, A1:
 *              the KV flag node_operators, closed / a canary of account ids / every account, behind
 *              a confirmation with its reason; refused by the server while the terms in force do not
 *              describe hosting), the eight KV flags (read only, with their wrangler commands),
 *              AGREGAR SERVIDOR DEL PROYECTO
 *   OPERADORES the community's hosts (Prompt 2, A4): status, opt-in, servers with their refusals and
 *              effective capacity, codes, matches against the cap, today's points against the cap,
 *              concentration and the week's reports (never a sanction alone); BLOQUEAR / DESBLOQUEAR,
 *              SUSPENDER TODOS behind a confirmation with a reason, BILLETERA (PUNTOS' lookup); asked
 *              when the tab opens and with ACTUALIZAR (an audited read), never by the refresh
 *   NODOS      one row per node; a press opens its detail (a sub-view Back closes): its machine,
 *              last probe, strikes, pauses, reason, and the actions behind a confirmation sheet
 *              (status with the server's guards, drain, re-probe, retire); a node suspended for a
 *              failed verification gets the manual review (its operator's freeze, unfreeze)
 *   TOKENS     the tokens by their short id and their state, REVOCAR for an unused one
 *   REGIONES   capacity against demand, ranked readiness, the verifiers and their queue
 *   RELEASE    the versions by node, REANUNCIAR CANAL (POST /nodes/admin/update), the CLI commands
 *   PUNTOS     an account's wallet and items by its id, the frozen wallets, grant / revoke / unfreeze
 *   CUENTAS Y COLAS  account-stats and queue-stats, asked when the tab opens and with ACTUALIZAR only
 *   PARTIDAS   the matches held and not settled, then the settled ones (the history, PR 4), and the
 *              voids of 24 h by node and reason; a press opens its detail (a sub-view Back closes):
 *              its times, outcome, verdict and verifier, strike, seats (a hidden name as "Jugador
 *              N"); VER LA REPETICIÓN (the public viewer, once published), DESCARGAR (the raw TGR1,
 *              every download posted to the team's channel), DESLISTAR, and for an open one ANULAR
 *              (with or without a strike) and VERIFICAR AHORA. A match id, or the replay link a
 *              player sent, opens its detail: one the history does not keep (listed before it was,
 *              or older than its 30 days) offers the viewer and DESLISTAR all the same
 *   HISTORIAL  the nodes' events, newest first; ALERTAS the ALERT lines of the team's channel. These
 *              three are asked when their tab opens, with ACTUALIZAR and MÁS, never by the refresh
 *
 * The overview is asked again every ADMIN_REFRESH_MS while the screen is on top, the menus are up
 * and the page is shown (the Menu's tick; nothing runs over a match). 403 reauth_required stops it,
 * opens "confirm it's you" once (accountLinks.ts confirmItsYou) and it goes on after the password;
 * cancelled, the last data stay with CONFIRMAR CON LA CONTRASEÑA. 503 nodes_off says the nodes are
 * paused and asks again once a minute. The wizard (AGREGAR SERVIDOR DEL PROYECTO) asks the form,
 * the checklist, the password (always, so its follow-up has its 15 minutes), then the token and the
 * server's install line (COPIAR), and follows the token and its node to active through the same
 * overview, keeping its state through a password sheet.
 * On a TV only a note: the server refuses a TV every maintainer route (403 tv_session).
 * Everything the server sends (names, reasons, probe errors, addresses, ids) is a text child,
 * never markup; addresses are masked until MOSTRAR DIRECCIONES. Nothing of it is stored.
 * In development (or a VITE_UI_FIT=1 build) window.__nodesAdmin(kind | null) shows a sample
 * (scripts/ui-fit.mjs).
 */
import { copyText, h, navButton, setChildren } from '../dom';
import type { Child } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { NodeAction } from '../../net/AccountClient';
import { REGIONS, isRegion } from '../../net/account';
import type { RegionId } from '../../net/account';
import {
  MAX_CAPACITY,
  PROJECT_DEFAULT_ROLES,
  PROJECT_PRESETS,
  accountIdOf,
  installLineMatches,
  maskAddress,
  matchIdOf,
  nodeErrorKey,
  nodeFailure,
  probeHint,
  replayHref,
  tokenAskOf,
  tokenFormIssues,
  verificationMatch,
} from '../../net/nodes';
import type { AdminNode, AdminWallet, AlertLine, FrozenList, HistoryMatch, HostingView, MatchSeat, NamesState, NodeEvent, NodeFailure, NodeStatus, OpenMatch, OpenMatches, OperatorView, Overview, TokenAsk, TokenForm, Tone } from '../../net/nodes';
import { REPORT_REASONS } from '../../net/nodes';
import { sha256Hex } from '../../../nodes/shared/edcrypto';
import { CATALOG } from '../../../nodes/control-plane/shop';
import {
  ADMIN_TABS,
  appendPage,
  checklistOf,
  CANARY_MAX,
  confirmNeeds,
  countRows,
  eventTone,
  flagChoiceOf,
  flagCommands,
  flagValueOf,
  followOf,
  hostSeesReason,
  kpisOf,
  matchActions,
  matchRows,
  matchTone,
  minutesLeft,
  nameTyped,
  nodeActions,
  nodeRows,
  queueDayRow,
  refreshAfter,
  refreshDue,
  refreshResume,
  refreshSent,
  refreshStart,
  regionRows,
  releaseRows,
  revocable,
  seatName,
} from './nodesAdminModel';
import type { AdminTab, ConfirmAction, FlagChoice, WizardStep } from './nodesAdminModel';
import type { Menu, Screen } from '../Menu';
import { field, primary, screenHead, secondary, section } from './common';
import type { Field } from './common';
import { onNavTo } from '../nav';
import { icon } from '../components/icons';
import { picker } from '../components/picker';
import { seg } from '../components/seg';
import { confirmItsYou } from './accountLinks';
import { formatPoints, regionName } from '../names';
import { duration, language, t } from '../../i18n';
import type { Key } from '../../i18n';

const TAB_KEY: Readonly<Record<AdminTab, Key>> = {
  summary: 'nodesAdmin.tab.summary',
  nodes: 'nodesAdmin.tab.nodes',
  operators: 'nodesAdmin.tab.operators',
  tokens: 'nodesAdmin.tab.tokens',
  regions: 'nodesAdmin.tab.regions',
  release: 'nodesAdmin.tab.release',
  points: 'nodesAdmin.tab.points',
  stats: 'nodesAdmin.tab.stats',
  matches: 'nodesAdmin.tab.matches',
  history: 'nodesAdmin.tab.history',
  alerts: 'nodesAdmin.tab.alerts',
};

const STATE_KEY: Readonly<Record<NodeStatus, Key>> = {
  pending: 'nodesShared.state.pending',
  probation: 'nodesShared.state.probation',
  active: 'nodesShared.state.active',
  suspended: 'nodesShared.state.suspended',
  banned: 'nodesShared.state.banned',
};

const ACT_KEY: Readonly<Record<NodeStatus, Key>> = {
  pending: 'nodesAdmin.act.probation',
  probation: 'nodesAdmin.act.probation',
  active: 'nodesAdmin.act.active',
  suspended: 'nodesAdmin.act.suspended',
  banned: 'nodesAdmin.act.banned',
};

/** A tag's class by tone (nodes.css): active ok, on trial warn, pending muted, suspended or banned bad. */
const TONE_TAG: Readonly<Record<Tone, string>> = { ok: 'mn-tag.mn-tag-live', warn: 'mn-tag.mn-tag-warn', muted: 'mn-tag', bad: 'mn-tag.mn-tag-bad' };

const tag = (tone: Tone, text: string): HTMLElement => h(`span.${TONE_TAG[tone]}` as 'span', null, text);

/**
 * A read-only block the arrows (and Tab) stop on, as the install line's .mn-cmd: the Menu scrolls the
 * focus into view, and a view with nothing to press below its last control (RESUMEN's flags, the
 * region and release cards, a used token, the queue days) or above its first (a node's facts) would
 * leave a pad or a keyboard short of it. With its own data-key, so a refresh keeps the focus on it;
 * its ring inside it (nodes.css).
 */
const readOnly = (key: string): Record<string, unknown> => ({ class: 'mn-na-read', 'data-nav': true, tabindex: '0', 'data-key': key });

/** A region by its name when it is one of the game's (a node's own label as it is otherwise). */
const regionLabel = (id: string): string => (isRegion(id) ? regionName(id) : id);

/** A time of day in the page's language. */
const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' });
/** A date and time in the page's language. */
const when = (ms: number): string => new Date(ms).toLocaleString(language(), { dateStyle: 'short', timeStyle: 'short' });
/** "5 min ago". */
const ago = (ms: number, now: number): string => t('nodesAdmin.ago', { time: duration(Math.max(0, now - ms)) });

/** A refusal in the panel's words, by its code (src/net/nodes.ts); the code itself to the console. */
function errText(e: unknown): string {
  const code = e instanceof AccountError ? e.code : 'network';
  if (e instanceof AccountError) console.warn(`nodes-admin: answered ${e.status} ${e.code}`);
  else console.warn('nodes-admin:', e);
  return t(nodeErrorKey(code === 'http' ? 'internal' : code));
}

const failureOf = (e: unknown): NodeFailure => nodeFailure(e instanceof AccountError ? e : null);

/** The history's tabs: their data are their own reads, not the overview's (PARTIDAS shows its voids of 24 h beside them); OPERADORES' too (GET /nodes/admin/operators). */
const HISTORY_TABS: ReadonlySet<AdminTab> = new Set(['matches', 'history', 'alerts', 'operators']);

const STAGE_KEY: Readonly<Record<FlagChoice, Key>> = { closed: 'nodesAdmin.open.stage.closed', canary: 'nodesAdmin.open.stage.canary', all: 'nodesAdmin.open.stage.all' };
/** The opening's control, as a seg (one word each). */
const PICK_KEY: Readonly<Record<FlagChoice, Key>> = { closed: 'nodesAdmin.open.pick.closed', canary: 'nodesAdmin.open.pick.canary', all: 'nodesAdmin.open.pick.all' };

/** The wizard as it stands: kept through Back and a password sheet until LISTO or a new account. */
interface Wizard {
  step: WizardStep;
  form: TokenForm;
  checks: Set<string>;
  token: { id: string; line: string; ask: TokenAsk; expiresAt: number; lineOk: boolean } | null;
}

const newForm = (): TokenForm => ({ region: null, name: '', host: '', roles: PROJECT_DEFAULT_ROLES, matches: 'auto', egress: '' });

export function nodesAdminScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const who = h('p.mn-note.mn-na-who');
  const status = h('div.mn-na-status');
  const body = h('div.mn-na-body');
  const el = h('div.mn-na', { 'data-tablero': true }, screenHead(t('nodesAdmin.title')), who, status, body);

  let tab: AdminTab = 'summary';
  let view: { kind: 'tabs' } | { kind: 'node'; nodeId: string } | { kind: 'match'; matchId: string } | { kind: 'wizard' } = { kind: 'tabs' };
  let data: Overview | null = null;
  /** The account the data are of: another one sees none of them. */
  let owner: string | null = null;
  let clock = refreshStart(0);
  let problem: { failure: NodeFailure; code: string } | null = null;
  /** The password sheet opened for this hold (once: the refresh never asks again by itself). */
  let asked = false;
  let reveal = false;
  let gen = 0;
  let wiz: Wizard | null = null;
  let lookup: { account: string; wallet: AdminWallet | null; error: string | null } | null = null;
  let frozen: FrozenList | null = null;
  let stats: { accounts: Record<string, unknown> | null; days: unknown[] | null; error: string | null; loading: boolean } | null = null;
  let sample: Overview | null = null;
  // The history (PR 4): asked when its tab opens, with ACTUALIZAR and MÁS, never by the 15 s refresh (its reads share the audit window).
  let matches: { open: OpenMatches | null; settled: HistoryMatch[]; next: string | null; names: NamesState; error: string | null; loading: boolean } | null = null;
  let events: { list: NodeEvent[]; next: string | null; error: string | null; loading: boolean } | null = null;
  let alertLines: { list: AlertLine[]; next: string | null; webhook: boolean; error: string | null; loading: boolean } | null = null;
  /** A match looked up by its id in PARTIDAS: its history row, or null when the history keeps none. */
  let found: { matchId: string; row: HistoryMatch | null; names: NamesState } | null = null;
  /** OPERADORES (Prompt 2, A4): asked when its tab opens and with ACTUALIZAR (an audited read), never by the refresh. */
  let operators: { list: OperatorView[]; error: string | null; loading: boolean } | null = null;
  /** RESUMEN's opening control as picked, before its confirmation (null: the flag's own stage). */
  let flagPick: { choice: FlagChoice; ids: string } | null = null;
  /** The wizard's countdown and follow-up, repainted by the tick and the refresh without touching its fields. */
  let followEl: HTMLElement | null = null;
  let slotsEl: HTMLElement | null = null;

  const tvHere = (): boolean => acc.account?.tv === true || document.documentElement.classList.contains('tg-tv');
  const passwordSheet = (): boolean => acc.me?.hasPassword === true;

  /** Forget everything of another account (a session that changed under the panel). */
  const reset = (): void => {
    data = null;
    owner = acc.account?.playerId ?? null;
    problem = null;
    wiz = null;
    lookup = null;
    frozen = null;
    stats = null;
    matches = null;
    events = null;
    alertLines = null;
    found = null;
    operators = null;
    flagPick = null;
    reveal = false;
    view = { kind: 'tabs' };
    tab = 'summary';
  };

  /** Repaint `fn`'s part with the focus kept on the same data-key (a refresh rebuilds the rows). */
  const keepFocus = (fn: () => void): void => {
    const a = document.activeElement as HTMLElement | null;
    const key = a !== null && el.contains(a) ? (a.closest('[data-key]')?.getAttribute('data-key') ?? null) : null;
    fn();
    if (key !== null) {
      const again = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (again !== null && again !== document.activeElement) again.focus({ preventScroll: true });
    }
    menu.refit();
    menu.refocus();
  };

  /**
   * "Confirm it's you" at level 2, always for an account with a password (the server decides by its
   * 403, never the client's own clock); then the refresh goes on and `then` runs (an action asked again).
   */
  const askPassword = (then?: () => void): void =>
    confirmItsYou(
      menu,
      () => {
        clock = refreshResume(clock, Date.now());
        problem = null;
        asked = false;
        then?.();
        paintStatus();
      },
      2,
      passwordSheet(),
    );

  // ---- the overview, every ADMIN_REFRESH_MS --------------------------------------------------------

  const load = async (): Promise<void> => {
    const mine = ++gen;
    const me = acc.account?.playerId ?? null;
    clock = refreshSent(clock);
    try {
      const o = await acc.nodesOverview();
      if (mine !== gen || me !== (acc.account?.playerId ?? null)) return;
      data = o;
      owner = me;
      problem = null;
      asked = false;
      clock = refreshAfter(clock, Date.now(), 'ok');
    } catch (e) {
      if (mine !== gen) return;
      const failure = failureOf(e);
      problem = { failure, code: e instanceof AccountError ? e.code : 'network' };
      clock = refreshAfter(clock, Date.now(), failure, e instanceof AccountError ? e.retryAfterMs : 0);
      errText(e);
      if (failure === 'reauth' && !asked) {
        asked = true;
        askPassword();
      }
    }
    if (!el.isConnected) return;
    paintStatus();
    if (view.kind === 'wizard') {
      paintFollow();
      paintSlots();
    } else if (view.kind === 'node' || (view.kind === 'tabs' && !HISTORY_TABS.has(tab) && tab !== 'points' && tab !== 'stats')) keepFocus(paintBody);
  };

  /** A POST of the panel, with "confirm it's you" and once more when the server asks for it. Resolves whether the sheet may close. */
  const act = async (run: () => Promise<unknown>, done: (r: unknown) => void): Promise<boolean> => {
    if (sample !== null) {
      menu.toast(t('nodesAdmin.done'), 'ok');
      return true;
    }
    try {
      done(await run());
      clock = refreshResume(clock, Date.now()); // the overview at once: the change shows
      return true;
    } catch (e) {
      if (failureOf(e) === 'reauth') {
        queueMicrotask(() => askPassword(() => void act(run, done)));
        return true;
      }
      menu.toast(errText(e), 'error');
      return false;
    }
  };

  // ---- the lines above the view ---------------------------------------------------------------------

  const paintStatus = (): void => {
    setChildren(who, acc.signedIn ? t('nodesAdmin.as', { name: acc.account?.name ?? '' }) : '');
    const p = problem;
    const line = (text: string, ...more: Child[]): HTMLElement => h('div.mn-na-alert', null, icon('warning'), h('p', null, text), ...more);
    if (sample !== null || p === null || tvHere()) return setChildren(status);
    if (p.failure === 'reauth') {
      const dev = !passwordSheet() ? h('p.mn-note', null, t('nodesAdmin.noPassword')) : null;
      return setChildren(status, line(t('nodesAdmin.reauthHeld'), secondary(t('profile.maintainerConfirm'), () => askPassword(), { 'data-key': 'na-confirm' }), dev));
    }
    if (p.failure === 'paused') return setChildren(status, line(t('nodesShared.paused')));
    if (data !== null) return setChildren(status, line(t(nodeErrorKey(p.code === 'http' ? 'internal' : p.code))));
    setChildren(status);
  };

  // ---- RESUMEN --------------------------------------------------------------------------------------

  const kpi = (value: string, label: string, sub?: string): HTMLElement => h('div.mn-kpi', null, h('b', null, value), h('span', null, label), sub ? h('small', null, sub) : null);

  const summaryView = (o: Overview): HTMLElement[] => {
    const k = kpisOf(o);
    const now = Date.now();
    const online = k.online.length > 0 ? k.online.map((r) => kpi(`${r.online}/${r.total}`, t('nodesAdmin.kpi.online'), regionLabel(r.region))) : [kpi('0', t('nodesAdmin.kpi.online'))];
    const kpis = h(
      'div.mn-kpis',
      null,
      ...online,
      kpi(String(k.running), t('nodesAdmin.kpi.running')),
      kpi(String(k.queue), t('nodesAdmin.kpi.queue'), k.verifying > 0 ? t('nodesAdmin.kpi.verifying', { count: k.verifying }) : undefined),
      kpi(String(k.outbox), t('nodesAdmin.kpi.outbox'), k.outboxOldestAt !== null ? ago(k.outboxOldestAt, now) : undefined),
      kpi(`${k.slots.used}/${k.slots.max}`, t('nodesAdmin.kpi.slots')),
    );
    const channel = h('p.mn-note', null, o.channel !== null ? t('nodesAdmin.channel', { stable: o.channel.stable, minimum: o.channel.minimum }) : t('nodesAdmin.noChannel'), ' · ', t('nodesAdmin.updatedAt', { time: clockTime(o.at) }));
    const warnings = o.warnings.map((w): HTMLElement => {
      const text =
        w.kind === 'verifier_node_versions'
          ? t('nodesAdmin.warn.verifierNode', { version: w.version, list: w.nodes.map((n) => `${n.name} ${n.node}`).join(', ') })
          : w.kind === 'trusted_off_channel'
            ? t('nodesAdmin.warn.offChannel', { name: w.name, version: w.version, stable: w.stable })
            : w.kind === 'no_webhook'
              ? t('nodesAdmin.warn.noWebhook')
              : t('nodesAdmin.warn.trustRemoved', { name: w.name, date: when(w.at) });
      const of = w.kind === 'trusted_off_channel' || w.kind === 'trust_removed' ? '-' + w.nodeId : w.kind === 'verifier_node_versions' ? '-' + w.version : '';
      return h('div.mn-na-alert', readOnly('na-warn-' + w.kind + of), icon('warning'), h('p', null, text));
    });
    const flags = o.flags.map((f) =>
      h(
        'div.mn-na-flag',
        readOnly('na-flag-' + f.name),
        h('code', null, f.name),
        tag(f.set ? 'warn' : 'muted', t(f.set ? 'nodesAdmin.flagOn' : 'nodesAdmin.flagOff')),
        f.raw !== null && f.raw !== '' ? h('code.mn-na-raw', null, f.raw.length > 40 ? f.raw.slice(0, 40) + '…' : f.raw) : null,
        h('p.mn-note', null, t(`nodesAdmin.flag.${f.name}` as Key)),
      ),
    );
    const cmds = flagCommands('<flag>');
    return [
      h('div.mn-na-tools', null, primary(t('nodesAdmin.wiz.open'), () => openWizard(), { 'data-key': 'na-wizard' })),
      kpis,
      channel,
      section(t('nodesAdmin.warnTitle'), ...(warnings.length > 0 ? warnings : [h('p.mn-note', null, t('nodesAdmin.noWarnings'))])),
      ...(o.hosting !== undefined ? [openingView(o.hosting)] : []),
      section(t('nodesAdmin.flagsTitle'), h('p.mn-note', null, t('nodesAdmin.flagsNote')), h('div.mn-cmd', readOnly('na-flag-set'), cmds.set), h('div.mn-cmd', readOnly('na-flag-clear'), cmds.clear), ...flags),
    ];
  };

  // ---- RESUMEN's opening of hosting (Prompt 2, A1: OPEN_FLAG, node_operators) ----------------------------

  /** Who may ask for a code, in words: closed, the canary's N accounts, everyone. */
  const stageText = (choice: FlagChoice, count: number): string => t(STAGE_KEY[choice], { count });

  /**
   * The opening (KV node_operators, the only flag the Worker writes): its stage now, whether the
   * terms in force describe hosting (below NODE_HOSTING_TERMS the server refuses every value, '0'
   * too: 409 hosting_terms), closed / canary (account ids) / every account, and CAMBIAR LA APERTURA
   * behind a confirmation with its reason (an audit row and an ALERT without the ids); its latest
   * changes. It lands within a minute or two (KV's edge cache).
   */
  const openingView = (hv: HostingView): HTMLElement => {
    const now = flagChoiceOf(hv.raw);
    const pick = flagPick ?? { choice: now.choice, ids: now.ids.join(', ') };
    const stage = seg<FlagChoice>(
      'na-open-stage',
      t('nodesAdmin.open.title'),
      (['closed', 'canary', 'all'] as const).map((c) => ({ value: c, label: t(PICK_KEY[c]) })),
      () => pick.choice,
      (v) => {
        flagPick = { choice: v, ids: pick.ids };
        keepFocus(paintBody);
      },
    );
    const ids = openIds;
    if (document.activeElement !== ids.input && ids.input.value !== pick.ids) ids.input.value = pick.ids;
    const set = (): void => {
      ids.error(null);
      const choice = flagPick?.choice ?? pick.choice;
      const value = flagValueOf(choice, flagPick?.ids ?? pick.ids);
      if (value === null) return ids.error(t('nodesAdmin.open.badIds', { max: CANARY_MAX }));
      const count = choice === 'canary' ? value.split(',').length : 0;
      const label = stageText(choice, count);
      confirmSheet('flag', label, t('nodesAdmin.open.set'), (reason) =>
        act(
          () => acc.nodesAction('flags', { name: hv.flag, value, reason }),
          () => {
            flagPick = null;
            menu.toast(t('nodesAdmin.open.done', { stage: label }), 'ok');
          },
        ),
      );
    };
    const changes = hv.changes.slice(0, 5).map((c) => h('p', readOnly('na-open-change-' + c.id), h('small', null, when(c.at)), ' ', h('span', null, c.actor), ' · ', h('code.mn-na-raw', null, `${c.old ?? '—'} → ${c.new ?? '—'}`), c.reason !== null ? h('span', null, ` · ${c.reason}`) : null));
    return section(
      t('nodesAdmin.open.title'),
      h('div.mn-na-flag', readOnly('na-open-now'), h('code', null, hv.flag), tag(now.choice === 'closed' ? 'muted' : 'warn', stageText(now.choice, now.ids.length)), h('p.mn-note', null, hv.terms.inForce ? t('nodesAdmin.open.termsOn', { version: hv.terms.version ?? '—' }) : t('nodesAdmin.open.termsOff', { version: hv.terms.version ?? '—', needed: hv.terms.needed ?? '—' }))),
      hv.communityWebhook ? null : h('div.mn-na-alert', readOnly('na-open-webhook'), icon('warning'), h('p', null, t('nodesAdmin.open.webhookOff'))),
      h('form.mn-form.mn-na-form', { onsubmit: (e: Event) => e.preventDefault() }, stage.el, pick.choice === 'canary' ? ids.el : null, secondary(t('nodesAdmin.open.set'), set, { 'data-key': 'na-open-set' })),
      ...(changes.length > 0 ? [h('h3.mn-field-label', null, t('nodesAdmin.open.changes')), ...changes] : []),
    );
  };

  // ---- OPERADORES (Prompt 2, A4, A8 bis, A16, A17) -----------------------------------------------------

  const loadOperators = async (): Promise<void> => {
    if (sample !== null) return;
    const me = acc.account?.playerId ?? null;
    operators = { list: operators?.list ?? [], error: null, loading: true };
    keepFocus(paintBody);
    try {
      const r = await acc.nodesOperators();
      if (me !== (acc.account?.playerId ?? null)) return;
      operators = { list: r.operators, error: null, loading: false };
    } catch (e) {
      if (me !== (acc.account?.playerId ?? null)) return;
      operators = { list: operators?.list ?? [], error: failureOf(e) === 'reauth' ? null : errText(e), loading: false };
      if (failureOf(e) === 'reauth') return askPassword(() => void loadOperators());
    }
    if (el.isConnected && tab === 'operators') keepFocus(paintBody);
  };

  /** An operator's card: its account, status and opt-in, its servers with their refusals and effective capacity, codes, matches against its cap, points and concentration, the week's reports (never a sanction alone), and the maintainer's three actions. */
  const operatorCard = (op: OperatorView): HTMLElement[] => {
    const pct = (x: number): string => `${Math.round(x * 100)} %`;
    const who = op.name ?? op.operatorId;
    const r = op.reports;
    const reasons = REPORT_REASONS.filter((k) => r.byReason[k] > 0).map((k) => `${t(`final.reason.${k}` as Key)}: ${r.byReason[k]}`).join(' · ');
    const card = h(
      'div.mn-prof-node',
      readOnly('na-op-' + op.operatorId),
      h('div.mn-prof-node-head', null, icon('profile', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, who), tag(op.status === 'blocked' ? 'bad' : 'ok', t(op.status === 'blocked' ? 'nodesAdmin.op.blocked' : 'nodesAdmin.op.ok')), op.showPublic ? tag('muted', t('nodesAdmin.op.public')) : null),
      h(
        'dl.mn-prof-node-facts',
        null,
        ...fact(t('nodesAdmin.op.account'), h('code.mn-na-raw', null, op.operatorId)),
        // The rules for hosts it holds (Terms 12.2): without those in force its servers get no new match.
        ...fact(t('nodesAdmin.op.rules'), op.rules.accepted === null ? t('nodesAdmin.op.rulesNone') : t(op.rules.held ? 'nodesAdmin.op.rulesHeld' : 'nodesAdmin.op.rulesOld', { version: op.rules.accepted })),
        ...(op.reason !== null ? fact(t('nodesAdmin.detail.reason'), h('span', null, op.reason), op.actor !== null ? h('span', null, ` · ${op.actor}`) : '') : []),
        ...fact(t('nodesAdmin.op.nodes'), op.nodes.length > 0 ? op.nodes.map((n) => `${n.name} (${regionLabel(n.region)}, ${t(STATE_KEY[n.status], { count: 0, total: 20 })}, ${n.capacityEffective}/${n.capacity}, ${n.refused}/${n.assigned + n.refused})`).join(' · ') : '—'),
        ...fact(t('nodesAdmin.op.refusals'), pct(op.refusalRate)),
        ...fact(t('nodesAdmin.op.tokens'), t('nodesAdmin.op.tokensOf', { today: op.tokens.today, unused: op.tokens.unused })),
        ...fact(t('nodesAdmin.op.running'), `${op.running.matches}/${op.running.max}`),
        ...fact(t('nodesAdmin.op.pointsToday'), op.points.cap !== null ? `${formatPoints(op.points.today)}/${formatPoints(op.points.cap)}` : formatPoints(op.points.today)),
        ...fact(t('nodesAdmin.op.points'), t('nodesAdmin.op.pointsOf', { d30: formatPoints(op.points.d30), earned: formatPoints(op.points.earned), matches: op.points.matches30d })),
        ...fact(t('nodesAdmin.op.concentration'), pct(op.points.concentration)),
        ...fact(t('nodesAdmin.op.reports', { days: r.days }), t('nodesAdmin.op.reportsOf', { count: r.count, accounts: r.accounts }), reasons !== '' ? h('span', null, ` · ${reasons}`) : ''),
      ),
    );
    const recent = r.recent.slice(0, 5).map((x, i) => h('p', readOnly(`na-op-report-${op.operatorId}-${i}`), h('small', null, when(x.at)), ' ', h('code.mn-na-raw', null, `${x.matchId.slice(0, 8)} · ${x.reporterId}`), ` · ${t(`final.reason.${x.reason}` as Key)}`, x.ping !== null ? ` · ${x.ping} ms` : ''));
    const blocked = op.status === 'blocked';
    const actions = h(
      'div.mn-na-actions',
      null,
      blocked
        ? secondary(t('nodesAdmin.op.unblock'), () => confirmSheet('unblock', who, t('nodesAdmin.op.unblock'), (reason) => act(() => acc.nodesAction('operator', { operatorId: op.operatorId, action: 'unblock', ...(reason ? { reason } : {}) }), () => void loadOperators())), { 'data-key': 'na-op-unblock-' + op.operatorId })
        : secondary(t('nodesAdmin.op.block'), () => confirmSheet('block', who, t('nodesAdmin.op.block'), (reason) => act(() => acc.nodesAction('operator', { operatorId: op.operatorId, action: 'block', reason }), () => void loadOperators())), { 'data-key': 'na-op-block-' + op.operatorId, class: 'mn-btn-cancel' }),
      secondary(t('nodesAdmin.op.suspendAll'), () => confirmSheet('suspendAll', who, t('nodesAdmin.op.suspendAll'), (reason) => act(() => acc.nodesAction('operator', { operatorId: op.operatorId, action: 'suspend_all', reason }), () => void loadOperators())), { 'data-key': 'na-op-suspend-' + op.operatorId, class: 'mn-btn-cancel' }),
      secondary(t('nodesAdmin.op.wallet'), () => ((tab = 'points'), (idField.input.value = op.operatorId), frozen === null ? void loadFrozen() : undefined, void lookUp(op.operatorId)), { 'data-key': 'na-op-wallet-' + op.operatorId }),
    );
    return [card, ...recent, actions];
  };

  const operatorsView = (): HTMLElement[] => {
    const s = operators;
    const list = s?.list ?? [];
    return [
      h('p.mn-note', null, t('nodesAdmin.op.note')),
      h('div.mn-na-tools', null, secondary(t('nodesAdmin.refresh'), () => void loadOperators(), { 'data-key': 'na-operators-refresh', 'aria-busy': s?.loading ? 'true' : undefined })),
      s?.error ? h('p.mn-field-error', null, s.error) : null,
      ...(list.length > 0 ? list.flatMap(operatorCard) : [h('p.mn-note', readOnly('na-op-none'), t(s === null || s.loading ? 'nodesAdmin.loading' : 'nodesAdmin.op.none'))]),
    ].filter((x): x is HTMLElement => x !== null);
  };

  // ---- NODOS ----------------------------------------------------------------------------------------

  const nodesView = (o: Overview): HTMLElement[] => {
    const now = Date.now();
    const rows = nodeRows(o).map((r) =>
      navButton(
        'mn-na-row',
        [
          h('b.mn-na-name', null, h('span.mn-dot', { class: r.online ? 'on' : '' }), h('span', null, r.name)),
          h('span.mn-na-c', null, regionLabel(r.region)),
          h('span.mn-na-tags', null, r.retired ? tag('muted', t('nodesAdmin.tagRetired')) : tag(r.tone, t(STATE_KEY[r.status], { count: 0, total: 20 })), r.trustLost ? tag('bad', t('nodesAdmin.tagTrustLost')) : null, r.draining ? tag('warn', t('nodesAdmin.tagDraining')) : null),
          h('span.mn-na-c', null, `${r.active}/${r.capacity}`),
          h('span.mn-na-c.mn-na-x', null, `${Math.round(r.lagMs)} ms`),
          h('span.mn-na-c.mn-na-x', null, r.egressCapGB !== null ? `${r.egressGB}/${r.egressCapGB} GB` : `${r.egressGB} GB`),
          h('span.mn-na-c.mn-na-x', null, r.version, ' ', r.compatible ? t('nodesAdmin.compatible') : t('nodesAdmin.update')),
          h('span.mn-na-c.mn-na-x', null, r.online ? t('nodesAdmin.seenNow') : r.lastSeen !== null ? ago(r.lastSeen, now) : '—'),
          h('span.mn-na-c', null, t(r.project ? 'nodesAdmin.tagProject' : 'nodesAdmin.tagCommunity')),
        ],
        () => openNode(r.nodeId),
        { 'data-key': 'na-node-' + r.key },
      ),
    );
    return [
      h('div.mn-na-tools', null, primary(t('nodesAdmin.wiz.open'), () => openWizard(), { 'data-key': 'na-wizard' })),
      h('div.mn-na-rows', { role: 'list' }, ...(rows.length > 0 ? rows : [h('p.mn-note', null, t('nodesAdmin.noNodes'))])),
    ];
  };

  const openNode = (nodeId: string): void => {
    view = { kind: 'node', nodeId };
    const n = data?.nodes.find((x) => x.nodeId === nodeId);
    // The manual review needs the operator's freeze (a community node suspended by a failed verification).
    if (n !== undefined && n.status === 'suspended' && n.statusReason === 'verification_failed' && frozen === null) void loadFrozen();
    paint();
  };

  /** One line of facts: a label and its value (a server's text as a text child). */
  const fact = (label: string, ...value: Child[]): Child[] => [h('dt', null, label), h('dd', null, ...value)];

  const address = (v: string | null): string => (v === null ? '—' : reveal ? v : maskAddress(v));

  const nodeDetail = (n: AdminNode): HTMLElement[] => {
    const now = Date.now();
    const a = nodeActions(n);
    const retired = n.retiredAt !== null;
    const state = retired ? tag('muted', t('nodesAdmin.tagRetired')) : tag(rowTone(n), t(STATE_KEY[n.status], { count: n.counters.probationVerified, total: 20 }));
    const probe = n.lastProbe;
    const hint = probe !== null && !probe.ok ? probeHint(probe.error) : null;
    const specs = n.specs;
    const facts = h(
      'dl.mn-prof-node-facts',
      null,
      ...fact(t('nodesAdmin.detail.region'), regionLabel(n.region)),
      ...fact(t('nodesAdmin.detail.operator'), n.operator.name, ' · ', t(n.trusted ? 'nodesAdmin.tagProject' : 'nodesAdmin.tagCommunity')),
      ...fact(t('nodesAdmin.detail.roles'), n.roles.join(', '), n.transports.length > 0 ? ` · ${n.transports.join(', ')}` : ''),
      ...fact(t('nodesAdmin.detail.address'), address(n.publicUrl)),
      ...fact(t('nodesAdmin.detail.pinned'), address(n.publicHost)),
      ...fact(t('nodesAdmin.detail.version'), n.version, ' ', n.compatible ? t('nodesAdmin.compatible') : t('nodesAdmin.update')),
      ...fact(t('nodesAdmin.detail.capacity'), t('nodesAdmin.detail.capacityOf', { now: n.capacity?.matches ?? 0, max: n.capacityMax, active: n.active })),
      ...fact(t('nodesAdmin.detail.egress'), n.egressCapGB !== null ? `${n.egressGB}/${n.egressCapGB} GB` : `${n.egressGB} GB`),
      ...fact(t('nodesAdmin.detail.specs'), specs ? [specs.cpuModel, specs.cpus !== undefined ? `${specs.cpus} CPU` : null, specs.memMB !== undefined ? `${specs.memMB} MB` : null, specs.os, specs.arch, specs.node ? `Node.js ${specs.node}` : null].filter(Boolean).join(' · ') : '—'),
      ...fact(t('nodesAdmin.detail.seen'), n.online ? t('nodesAdmin.seenNow') : n.lastSeen !== null ? ago(n.lastSeen, now) : '—'),
      ...fact(t('nodesAdmin.detail.probe'), probe === null ? t('nodesAdmin.detail.probeNone') : `${t(probe.ok ? 'nodesAdmin.detail.probeOk' : 'nodesAdmin.detail.probeFail')} · ${ago(probe.at, now)}`, probe !== null && probe.error !== null ? h('code.mn-na-raw', null, probe.error) : null),
      ...fact(t('nodesAdmin.detail.streak'), String(n.probeFailures)),
      ...fact(t('nodesAdmin.detail.strikes'), String(n.strikeTimes.length), n.strikeTimes.length > 0 ? ` · ${when(Math.max(...n.strikeTimes))}` : ''),
      ...fact(t('nodesAdmin.detail.pauses'), String(n.pauseTimes.length), n.pauseTimes.length > 0 ? ` · ${when(Math.max(...n.pauseTimes))}` : ''),
      ...fact(t('nodesAdmin.detail.linkCuts'), String(n.linkCuts.count24h), n.linkCuts.lastAt !== null ? ` · ${ago(n.linkCuts.lastAt, now)}` : ''),
      ...fact(t('nodesAdmin.detail.verified'), t('nodesAdmin.detail.verifiedOf', { verified: n.counters.verified, ranked: n.counters.rankedVerified, failed: n.counters.failedVerification })),
      ...(n.statusReason !== null ? fact(t('nodesAdmin.detail.reason'), h('span', null, n.statusReason)) : []),
      ...(n.suspendedUntil !== null ? fact(t('nodesAdmin.detail.until'), when(n.suspendedUntil)) : []),
      ...(n.trustRemovedAt !== null ? fact(t('nodesAdmin.tagTrustLost'), when(n.trustRemovedAt)) : []),
      ...(retired ? fact(t('nodesAdmin.tagRetired'), when(n.retiredAt as number), n.retiredReason !== null ? h('span', null, ` · ${n.retiredReason}`) : '') : []),
    );
    const actions = h(
      'div.mn-na-actions',
      null,
      ...a.status.map((s) =>
        secondary(
          t(ACT_KEY[s.to]),
          () => confirmSheet(s.to === 'banned' ? 'ban' : s.force ? 'force' : 'status', n.name, t(ACT_KEY[s.to]), (reason) => act(() => acc.nodesAction('status', { nodeId: n.nodeId, status: s.to, ...(reason ? { reason } : {}), ...(s.force ? { force: true } : {}) }), () => menu.toast(t('nodesAdmin.done'), 'ok'))),
          { 'data-key': 'na-act-' + s.to, class: s.to === 'banned' ? 'mn-btn-cancel' : undefined },
        ),
      ),
      a.drain ? secondary(t('nodesAdmin.act.drain'), () => confirmSheet('drain', n.name, t('nodesAdmin.act.drain'), (reason) => act(() => acc.nodesAction('drain', { nodeId: n.nodeId, reason }), () => menu.toast(t('nodesAdmin.drained'), 'ok'))), { 'data-key': 'na-act-drain' }) : null,
      a.reprobe ? secondary(t('nodesAdmin.act.reprobe'), () => void act(() => acc.nodesAction('reprobe', { nodeId: n.nodeId }), (r) => menu.toast(t((r as { reachable?: unknown })?.reachable === true ? 'nodesAdmin.reprobeOk' : 'nodesAdmin.reprobeFail'), 'info')), { 'data-key': 'na-act-reprobe' }) : null,
      a.retire ? secondary(t('nodesAdmin.act.retire'), () => confirmSheet('retire', n.name, t('nodesAdmin.act.retire'), (reason) => act(() => acc.nodesAction('retire', { nodeId: n.nodeId, reason }), () => menu.toast(t('nodesAdmin.done'), 'ok'))), { 'data-key': 'na-act-retire', class: 'mn-btn-cancel' }) : null,
    );
    const help = hint !== null ? h('p.mn-note', null, t(`nodesShared.hint.${hint}` as Key)) : null;
    // Its facts are a stop of their own: on a phone held sideways they are taller than the stage.
    const card = h('div.mn-prof-node', readOnly('na-detail-' + n.nodeId), h('div.mn-prof-node-head', null, icon('server', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, n.name), state), facts, help);
    const revealButton = secondary(t(reveal ? 'nodesAdmin.hideAddresses' : 'nodesAdmin.showAddresses'), () => ((reveal = !reveal), keepFocus(paintBody)), { 'data-key': 'na-reveal', 'aria-pressed': String(reveal) });
    // ▼ from the facts: MOSTRAR DIRECCIONES under them (the pick from a box that wide takes the action nearest its middle).
    onNavTo(card, 'down', () => revealButton);
    return [
      card,
      h('div.mn-na-tools', null, revealButton),
      retired ? h('p.mn-note', null, t('nodesAdmin.retiredNote')) : actions,
      n.status === 'suspended' && n.statusReason === 'verification_failed' ? reviewView(n) : null,
    ].filter((x): x is HTMLElement => x !== null);
  };

  const rowTone = (n: AdminNode): Tone => (n.retiredAt !== null ? 'muted' : n.status === 'active' ? 'ok' : n.status === 'probation' ? 'warn' : n.status === 'pending' ? 'muted' : 'bad');

  /** A community node suspended by a failed verification (registry.ts): the match, its operator's freeze, and the review's two ways out. */
  const reviewView = (n: AdminNode): HTMLElement => {
    const f = frozen?.frozen.find((x) => x.account === n.operator.id) ?? null;
    const match = verificationMatch(f?.reason ?? null);
    const href = replayHref(match);
    return section(
      t('nodesAdmin.review.title'),
      h('p.mn-note', null, t('nodesAdmin.review.note')),
      frozen === null ? h('p.mn-note', null, t('nodesAdmin.loading')) : h('p', null, t(f !== null ? 'nodesAdmin.review.frozen' : 'nodesAdmin.review.notFrozen'), f !== null ? h('code.mn-na-raw', null, f.reason) : null),
      href !== null ? h('a.mn-btn', { href, target: '_blank', rel: 'noopener', 'data-nav': true, 'data-key': 'na-review-replay' }, t('nodesAdmin.review.replay')) : null,
      f !== null ? secondary(t('nodesAdmin.points.unfreeze'), () => confirmSheet('unfreeze', n.operator.name, t('nodesAdmin.points.unfreeze'), (reason) => act(() => acc.nodesAction('unfreeze', { account: n.operator.id, reason }), () => ((frozen = null), void loadFrozen()))), { 'data-key': 'na-review-unfreeze' }) : null,
    );
  };

  /**
   * The confirmation of an action (B6): its note, a reason when it needs one, the node's name typed
   * for a retirement, a ban and a drain; the action in --danger, CANCELAR focused first.
   */
  const confirmSheet = (a: ConfirmAction, name: string, label: string, run: (reason: string | null) => Promise<boolean>): void => {
    const needs = confirmNeeds(a);
    const reason = field(t('nodesAdmin.confirm.reason'), { maxLength: 200, keypad: 'text', enterkeyhint: needs.typeName ? 'next' : 'done', hint: needs.reason ? undefined : t('nodesAdmin.confirm.optional') });
    const typed: Field | null = needs.typeName ? field(t('nodesAdmin.confirm.typeName', { name }), { maxLength: 40, keypad: 'text', enterkeyhint: 'done' }) : null;
    const note = a === 'drain' ? 'nodesAdmin.confirm.drainNote' : a === 'retire' ? 'nodesAdmin.confirm.retireNote' : a === 'ban' ? 'nodesAdmin.confirm.banNote' : a === 'force' ? 'nodesAdmin.confirm.forceNote' : a === 'update' ? 'nodesAdmin.confirm.updateNote' : a === 'unfreeze' ? 'nodesAdmin.confirm.unfreezeNote' : a === 'delist' ? 'nodesAdmin.confirm.delistNote' : a === 'voidMatch' ? 'nodesAdmin.confirm.voidNote' : a === 'voidStrike' ? 'nodesAdmin.confirm.voidStrikeNote' : a === 'download' ? 'nodesAdmin.confirm.downloadNote' : a === 'flag' ? 'nodesAdmin.confirm.flagNote' : a === 'block' ? 'nodesAdmin.confirm.blockNote' : a === 'unblock' ? 'nodesAdmin.confirm.unblockNote' : a === 'suspendAll' ? 'nodesAdmin.confirm.suspendAllNote' : 'nodesAdmin.confirm.note';
    menu.modal({
      title: t('nodesAdmin.confirm.title', { action: label, name }),
      body: [
        h('p.mn-note', null, t(note as Key)),
        a === 'update' || a === 'revokeToken' || a === 'download' ? null : reason.el,
        // Under the reason, when its host reads it too (hostSeesReason): never a player's name there.
        hostSeesReason(a) ? h('p.mn-note', null, t('nodesAdmin.confirm.hostSees')) : null,
        typed?.el ?? null,
      ],
      actions: [
        {
          label,
          danger: true,
          onClick: async () => {
            reason.error(null);
            typed?.error(null);
            const why = reason.input.value.trim();
            if (needs.reason && why === '') {
              reason.error(t('nodesAdmin.confirm.needReason'));
              return false;
            }
            if (typed !== null && !nameTyped(typed.input.value, name)) {
              typed.error(t('nodesAdmin.confirm.badName'));
              return false;
            }
            return run(why === '' ? null : why);
          },
        },
        { label: t('profile.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  // ---- TOKENS ---------------------------------------------------------------------------------------

  const tokensView = (o: Overview): HTMLElement[] => {
    const now = Date.now();
    const STATE_TONE: Record<string, Tone> = { unused: 'warn', used: 'ok', expired: 'muted', revoked: 'bad' };
    // A row with REVOCAR is reached by its button; one without (used, expired, revoked) by itself.
    const rows = o.tokens.map((tk) =>
      h(
        'div.mn-na-token',
        revocable(tk, now) ? { 'data-key': 'na-token-' + tk.id } : readOnly('na-token-' + tk.id),
        h('code', null, tk.id),
        h('b', null, tk.name ?? '—'),
        h('span', null, regionLabel(tk.region)),
        tag(STATE_TONE[tk.state] ?? 'muted', t(`nodesAdmin.token.${tk.state}` as Key)),
        h('span', null, tk.publicHost !== null ? address(tk.publicHost) : ''),
        h('small', null, tk.state === 'unused' ? t('nodesShared.expiresIn', { minutes: minutesLeft(tk.expiresAt, now) }) : when(tk.createdAt)),
        revocable(tk, now) ? secondary(t('nodesAdmin.act.revoke'), () => confirmSheet('revokeToken', tk.name ?? tk.id, t('nodesAdmin.act.revoke'), () => act(() => acc.nodesAction('tokens/revoke', { id: tk.id }), () => menu.toast(t('nodesAdmin.done'), 'ok'))), { 'data-key': 'na-revoke-' + tk.id }) : null,
      ),
    );
    return [h('section.mn-section.mn-na-rows', null, ...(rows.length > 0 ? rows : [h('p.mn-note', null, t('nodesAdmin.noTokens'))]))];
  };

  // ---- REGIONES -------------------------------------------------------------------------------------

  const regionsView = (o: Overview): HTMLElement[] => {
    const now = Date.now();
    const cards = regionRows(o).map((r) =>
      h(
        'div.mn-prof-node',
        readOnly('na-region-' + r.region),
        h('div.mn-prof-node-head', null, icon('globe', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, regionLabel(r.region)), r.empty ? null : tag(r.rankedReady ? 'ok' : 'muted', t(r.rankedReady ? 'nodesAdmin.region.ranked' : 'nodesAdmin.region.noRanked'))),
        r.empty
          ? h('p.mn-note', null, t('nodesAdmin.region.empty'))
          : h(
              'dl.mn-prof-node-facts',
              null,
              ...fact(t('nodesAdmin.region.hosts'), String(r.hostsOnline)),
              ...fact(t('nodesAdmin.region.slots'), `${r.active}/${r.slots}`),
              ...fact(t('nodesAdmin.region.matches'), String(r.matches)),
              ...fact(t('nodesAdmin.region.unplaced'), String(r.unplaced)),
              ...fact(t('nodesAdmin.region.factor'), r.regionFactor.toFixed(2)),
              ...fact(t('nodesAdmin.region.verifiers'), r.verifiers.length > 0 ? r.verifiers.join(', ') : '—'),
            ),
      ),
    );
    const queue = o.verifyQueue.map((q) => h('p', readOnly(`na-queue-${q.version}-${q.wasmSha256.slice(0, 8)}`), h('code', null, `${q.version} · ${q.wasmSha256.slice(0, 8)}`), ' ', t('nodesAdmin.queueLine', { depth: q.depth, time: ago(q.oldestAt, now) })));
    const verifiers = o.verifiers.map((v) => h('p', readOnly('na-verifier-' + v.nodeId), h('span.mn-dot', { class: v.online ? 'on' : '' }), ' ', h('b', null, v.name), ` · ${regionLabel(v.region)} · ${v.version}${v.node ? ` · Node.js ${v.node}` : ''}`, v.verifying > 0 ? ` · ${t('nodesAdmin.kpi.verifying', { count: v.verifying })}` : ''));
    return [
      h('div.mn-na-grid', null, ...cards),
      section(t('nodesAdmin.verifiersTitle'), ...(verifiers.length > 0 ? verifiers : [h('p.mn-note', readOnly('na-verifiers-none'), t('nodesAdmin.noVerifiers'))]), ...(queue.length > 0 ? queue : [h('p.mn-note', readOnly('na-queue-none'), t('nodesAdmin.queueEmpty'))])),
    ];
  };

  // ---- RELEASE --------------------------------------------------------------------------------------

  const releaseView = (o: Overview): HTMLElement[] => {
    const rows = releaseRows(o).map((r) =>
      h('div.mn-prof-node', readOnly('na-release-' + r.version), h('div.mn-prof-node-head', null, h('b.mn-prof-node-name', null, r.version), r.stable ? tag('ok', t('nodesAdmin.release.stable')) : null), h('p', null, r.nodes.map((n) => n.name).join(', '))),
    );
    return [
      h('p.mn-note', null, o.channel !== null ? t('nodesAdmin.channel', { stable: o.channel.stable, minimum: o.channel.minimum }) : t('nodesAdmin.noChannel'), ' · ', t('nodesAdmin.release.build', { version: o.build.version })),
      h('div.mn-na-grid', null, ...rows),
      h('div.mn-na-tools', null, secondary(t('nodesAdmin.act.update'), () => confirmSheet('update', '', t('nodesAdmin.act.update'), () => act(() => acc.nodesAction('update', {}), () => menu.toast(t('nodesAdmin.release.updated'), 'ok'))), { 'data-key': 'na-update' })),
      section(t('nodesAdmin.release.cliTitle'), h('p.mn-note', null, t('nodesAdmin.release.cliNote')), h('div.mn-cmd', readOnly('na-cli-show'), 'node nodes/scripts/channel.mjs --show'), h('div.mn-cmd', readOnly('na-cli-stable'), 'node nodes/scripts/channel.mjs --stable X.Y.Z'), h('div.mn-cmd', readOnly('na-cli-rollback'), 'node nodes/scripts/channel.mjs --rollback')),
    ];
  };

  // ---- PUNTOS ---------------------------------------------------------------------------------------

  const loadFrozen = async (): Promise<void> => {
    if (sample !== null) return;
    try {
      frozen = await acc.nodesFrozen();
    } catch (e) {
      if (failureOf(e) === 'reauth') return askPassword(() => void loadFrozen());
      menu.toast(errText(e), 'error');
      frozen = { frozen: [], more: false };
    }
    if (el.isConnected && (tab === 'points' || view.kind === 'node')) keepFocus(paintBody);
  };

  const lookUp = async (account: string): Promise<void> => {
    lookup = { account, wallet: null, error: null };
    keepFocus(paintBody);
    if (sample !== null) return;
    try {
      const w = await acc.nodesWallet(account);
      if (lookup?.account === account) lookup = { account, wallet: w, error: null };
    } catch (e) {
      if (failureOf(e) === 'reauth') return askPassword(() => void lookUp(account));
      if (lookup?.account === account) lookup = { account, wallet: null, error: errText(e) };
    }
    if (el.isConnected && tab === 'points') keepFocus(paintBody);
  };

  // The canary's ids (RESUMEN's opening): one field for the screen, so a refresh keeps what is typed and its focus.
  const openIds = field(t('nodesAdmin.open.ids'), { maxLength: 1200, keypad: 'text', enterkeyhint: 'done' });
  openIds.input.addEventListener('input', () => (flagPick = { choice: flagPick?.choice ?? 'canary', ids: openIds.input.value }));

  const idField = field(t('nodesAdmin.points.lookup'), { maxLength: 16, keypad: 'text', enterkeyhint: 'go', placeholder: '0123456789abcdef' });
  const goLookup = (): void => {
    idField.error(null);
    const id = accountIdOf(idField.input.value);
    if (id === null) return idField.error(t('nodesAdmin.points.badId'));
    void lookUp(id);
  };
  idField.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.defaultPrevented) goLookup();
  });

  /** An item to grant (the catalog) or to take back (what the account owns), in a sheet of its own. */
  const pickItem = (what: 'grant' | 'revoke', account: string, owned: readonly string[]): void => {
    const items = what === 'grant' ? CATALOG.map((i) => i.id) : owned.filter((id) => CATALOG.some((i) => i.id === id));
    if (items.length === 0) return menu.toast(t('nodesAdmin.points.noItems'), 'info');
    const close = menu.modal({
      title: t(what === 'grant' ? 'nodesAdmin.points.grant' : 'nodesAdmin.points.revoke'),
      body: [h('p.mn-note', null, t('nodesAdmin.points.badgeNote')), h('div.mn-na-items', null, ...items.map((id) => navButton('mn-btn', id, () => (close(), queueMicrotask(() => confirmSheet(what, account, t(what === 'grant' ? 'nodesAdmin.points.grant' : 'nodesAdmin.points.revoke'), (reason) => act(() => acc.nodesAction(what, { account, item: id, reason }), () => void lookUp(account))))), { 'data-key': 'na-item-' + id })))],
      actions: [{ label: t('profile.cancel'), onClick: () => true }],
    });
  };

  const pointsView = (): HTMLElement[] => {
    const l = lookup;
    const w = l?.wallet ?? null;
    const card =
      l === null
        ? null
        : h(
            'div.mn-prof-node',
            { 'data-key': 'na-wallet' },
            h('div.mn-prof-node-head', null, icon('points', 'mn-mtile-icon'), h('code.mn-prof-node-name', null, l.account)),
            l.error !== null
              ? h('p.mn-field-error', null, l.error)
              : w === null
                ? h('p.mn-note', null, t('nodesAdmin.loading'))
                : h(
                    'dl.mn-prof-node-facts',
                    readOnly('na-wallet-facts'),
                    ...fact(t('nodesAdmin.points.balance'), w.wallet !== null ? formatPoints(w.wallet.balance) : '—'),
                    ...fact(t('nodesAdmin.points.earned'), w.wallet !== null ? formatPoints(w.wallet.earned) : '—'),
                    ...fact(t('nodesAdmin.points.spent'), w.wallet !== null ? formatPoints(w.wallet.spent) : '—'),
                    ...fact(t('nodesAdmin.points.frozen'), w.wallet?.frozen ? h('code.mn-na-raw', null, w.wallet.frozen) : t('nodesAdmin.points.notFrozen')),
                    ...fact(t('nodesAdmin.points.items'), w.items.length > 0 ? w.items.join(', ') : t('nodesAdmin.points.none')),
                  ),
            w !== null
              ? h(
                  'div.mn-na-actions',
                  null,
                  secondary(t('nodesAdmin.points.grant'), () => pickItem('grant', l.account, w.items), { 'data-key': 'na-grant' }),
                  secondary(t('nodesAdmin.points.revoke'), () => pickItem('revoke', l.account, w.items), { 'data-key': 'na-revoke-item' }),
                  w.wallet?.frozen ? secondary(t('nodesAdmin.points.unfreeze'), () => confirmSheet('unfreeze', l.account, t('nodesAdmin.points.unfreeze'), (reason) => act(() => acc.nodesAction('unfreeze', { account: l.account, reason }), () => ((frozen = null), void loadFrozen(), void lookUp(l.account)))), { 'data-key': 'na-unfreeze' }) : null,
                )
              : null,
          );
    const list = frozen === null ? [h('p.mn-note', null, t('nodesAdmin.loading'))] : frozen.frozen.length === 0 ? [h('p.mn-note', null, t('nodesAdmin.points.frozenEmpty'))] : frozen.frozen.map((f) => navButton('mn-na-row', [h('code.mn-na-name', null, f.account), h('code.mn-na-raw', null, f.reason), h('span.mn-na-c', null, when(f.at))], () => ((idField.input.value = f.account), void lookUp(f.account)), { 'data-key': 'na-frozen-' + f.account }));
    return [
      h('form.mn-form.mn-na-lookup', { onsubmit: (e: Event) => e.preventDefault() }, idField.el, secondary(t('nodesAdmin.points.find'), goLookup, { 'data-key': 'na-find' })),
      ...(card !== null ? [card] : []),
      section(t('nodesAdmin.points.frozenTitle'), h('div.mn-na-tools', null, secondary(t('nodesAdmin.refresh'), () => ((frozen = null), keepFocus(paintBody), void loadFrozen()), { 'data-key': 'na-frozen-refresh' })), ...list, frozen?.more ? h('p.mn-note', readOnly('na-frozen-more'), t('nodesAdmin.points.more')) : null),
    ];
  };

  // ---- CUENTAS Y COLAS ------------------------------------------------------------------------------

  /** account-stats and queue-stats: asked here only (they share 10 a minute with the deletions on request), never by the refresh. */
  const loadStats = async (): Promise<void> => {
    if (sample !== null) return;
    stats = { accounts: stats?.accounts ?? null, days: stats?.days ?? null, error: null, loading: true };
    keepFocus(paintBody);
    try {
      const [accounts, days] = await Promise.all([acc.accountStats(), acc.queueStats(30)]);
      stats = { accounts, days, error: null, loading: false };
    } catch (e) {
      if (failureOf(e) === 'reauth') {
        stats = { ...stats, loading: false };
        return askPassword(() => void loadStats());
      }
      stats = { accounts: stats?.accounts ?? null, days: stats?.days ?? null, error: errText(e), loading: false };
    }
    if (el.isConnected && tab === 'stats') keepFocus(paintBody);
  };

  const statsView = (): HTMLElement[] => {
    const s = stats;
    const counts = countRows(s?.accounts ?? null).filter(([k]) => !k.startsWith('trusted'));
    const days = (s?.days ?? []).map(queueDayRow).filter((d): d is NonNullable<ReturnType<typeof queueDayRow>> => d !== null);
    const head = h('div.mn-na-day.mn-na-head', null, ...(['day', 'searches', 'formed', 'onNode', 'onCloud', 'cancelled', 'dropped'] as const).map((c) => h('span', null, t(`nodesAdmin.stats.${c}` as Key))));
    return [
      h('p.mn-note', null, t('nodesAdmin.stats.note')),
      h('div.mn-na-tools', null, secondary(t('nodesAdmin.refresh'), () => void loadStats(), { 'data-key': 'na-stats-refresh', 'aria-busy': s?.loading ? 'true' : undefined })),
      s?.error ? h('p.mn-field-error', null, s.error) : null,
      section(t('nodesAdmin.stats.accounts'), counts.length > 0 ? h('dl.mn-prof-node-facts', readOnly('na-stats-accounts'), ...counts.flatMap(([k, v]) => fact(k, String(v)))) : h('p.mn-note', null, t(s?.loading ? 'nodesAdmin.loading' : 'nodesAdmin.stats.none'))),
      section(t('nodesAdmin.stats.queues'), days.length > 0 ? h('div.mn-na-days', null, head, ...days.map((d) => h('div.mn-na-day', readOnly('na-day-' + d.date), h('span', null, d.date), h('span', null, String(d.searches)), h('span', null, String(d.formed)), h('span', null, String(d.onNode)), h('span', null, String(d.onCloud)), h('span', null, String(d.cancelled)), h('span', null, String(d.dropped))))) : h('p.mn-note', null, t(s?.loading ? 'nodesAdmin.loading' : 'nodesAdmin.stats.none'))),
    ].filter((x): x is HTMLElement => x !== null);
  };

  // ---- PARTIDAS, HISTORIAL, ALERTAS (the history, PR 4) ----------------------------------------------
  // Their reads are asked when the tab opens, with ACTUALIZAR and MÁS (the next page), never by the
  // refresh: each one is a maintainer's read of the audit window, and the open matches ask AccountsDO
  // whose names are hidden. A session that changed meanwhile keeps nothing of the answer.

  const loadMatches = async (more = false): Promise<void> => {
    if (sample !== null) return;
    const me = acc.account?.playerId ?? null;
    const was = matches;
    const before = more ? (was?.next ?? null) : null;
    matches = { open: was?.open ?? null, settled: was?.settled ?? [], next: was?.next ?? null, names: was?.names ?? 'shown', error: null, loading: true };
    keepFocus(paintBody);
    try {
      const [open, page] = await Promise.all([more && was?.open ? Promise.resolve(was.open) : acc.nodesMatches(), acc.nodesHistory(before !== null ? { before } : {})]);
      if (me !== (acc.account?.playerId ?? null)) return;
      const settled = more ? appendPage(was?.settled ?? [], page.matches, (m) => m.matchId) : page.matches;
      matches = { open, settled, next: page.next, names: open.names === 'unavailable' || page.names === 'unavailable' ? 'unavailable' : 'shown', error: null, loading: false };
    } catch (e) {
      if (me !== (acc.account?.playerId ?? null)) return;
      matches = { open: was?.open ?? null, settled: was?.settled ?? [], next: was?.next ?? null, names: was?.names ?? 'shown', error: failureOf(e) === 'reauth' ? null : errText(e), loading: false };
      if (failureOf(e) === 'reauth') return askPassword(() => void loadMatches(more));
    }
    if (el.isConnected && (tab === 'matches' || view.kind === 'match')) keepFocus(paintBody);
  };

  const loadEvents = async (more = false): Promise<void> => {
    if (sample !== null) return;
    const me = acc.account?.playerId ?? null;
    const was = events;
    const before = more ? (was?.next ?? null) : null;
    events = { list: was?.list ?? [], next: was?.next ?? null, error: null, loading: true };
    keepFocus(paintBody);
    try {
      const page = await acc.nodesEvents(before !== null ? { before } : {});
      if (me !== (acc.account?.playerId ?? null)) return;
      events = { list: more ? appendPage(was?.list ?? [], page.events, (x) => x.id) : page.events, next: page.next, error: null, loading: false };
    } catch (e) {
      if (me !== (acc.account?.playerId ?? null)) return;
      events = { list: was?.list ?? [], next: was?.next ?? null, error: failureOf(e) === 'reauth' ? null : errText(e), loading: false };
      if (failureOf(e) === 'reauth') return askPassword(() => void loadEvents(more));
    }
    if (el.isConnected && tab === 'history') keepFocus(paintBody);
  };

  const loadAlerts = async (more = false): Promise<void> => {
    if (sample !== null) return;
    const me = acc.account?.playerId ?? null;
    const was = alertLines;
    const before = more ? (was?.next ?? null) : null;
    alertLines = { list: was?.list ?? [], next: was?.next ?? null, webhook: was?.webhook ?? true, error: null, loading: true };
    keepFocus(paintBody);
    try {
      const page = await acc.nodesAlerts(before !== null ? { before } : {});
      if (me !== (acc.account?.playerId ?? null)) return;
      alertLines = { list: more ? appendPage(was?.list ?? [], page.alerts, (x) => x.id) : page.alerts, next: page.next, webhook: page.webhook, error: null, loading: false };
    } catch (e) {
      if (me !== (acc.account?.playerId ?? null)) return;
      alertLines = { list: was?.list ?? [], next: was?.next ?? null, webhook: was?.webhook ?? true, error: failureOf(e) === 'reauth' ? null : errText(e), loading: false };
      if (failureOf(e) === 'reauth') return askPassword(() => void loadAlerts(more));
    }
    if (el.isConnected && tab === 'alerts') keepFocus(paintBody);
  };

  /** A tab's REFRESH, its error and its MÁS (the next page), around its rows: buttons of their own (PARTIDAS), or lines in a box (HISTORIAL, ALERTAS, as TOKENS). */
  const historyTab = (note: Key, refresh: () => void, s: { error: string | null; loading: boolean; next: string | null } | null, rows: HTMLElement[], more: () => void, key: string, extra: Array<HTMLElement | null> = [], lines = false): HTMLElement[] =>
    [
      h('p.mn-note', null, t(note)),
      h('div.mn-na-tools', null, secondary(t('nodesAdmin.refresh'), refresh, { 'data-key': `na-${key}-refresh`, 'aria-busy': s?.loading ? 'true' : undefined })),
      s?.error ? h('p.mn-field-error', null, s.error) : null,
      ...extra,
      h(lines ? 'section.mn-section.mn-na-rows' : 'div.mn-na-rows', { role: 'list' }, ...(rows.length > 0 ? rows : [h('p.mn-note', null, t(s === null || s.loading ? 'nodesAdmin.loading' : 'nodesAdmin.history.none'))])),
      s?.next ? secondary(t('nodesAdmin.more'), more, { 'data-key': `na-${key}-more` }) : null,
    ].filter((x): x is HTMLElement => x !== null);

  /**
   * One match of the history by its id (GET /nodes/admin/history?match=): its row, or null when the
   * history keeps none. `then` opens its detail (a lookup); else its detail, if shown, repaints (after an action).
   */
  const askMatch = async (matchId: string, then: boolean): Promise<void> => {
    const me = acc.account?.playerId ?? null;
    try {
      const page = await acc.nodesHistory({ match: matchId });
      if (me !== (acc.account?.playerId ?? null)) return;
      found = { matchId, row: page.matches.find((x) => x.matchId === matchId) ?? null, names: page.names };
    } catch (e) {
      if (me !== (acc.account?.playerId ?? null)) return;
      if (failureOf(e) === 'reauth') return askPassword(() => void askMatch(matchId, then));
      if (then) matchField.error(errText(e));
      return;
    }
    if (!el.isConnected) return;
    if (then) openMatch(matchId);
    else if (view.kind === 'match' && view.matchId === matchId) keepFocus(paintBody);
  };

  // A match id or the replay link a player sent (replay.html?id=): the pages need not be walked with MÁS.
  const matchField = field(t('nodesAdmin.match.lookup'), { maxLength: 200, keypad: 'text', enterkeyhint: 'go' });
  const goFind = (): void => {
    matchField.error(null);
    const id = matchIdOf(matchField.input.value);
    if (id === null) return matchField.error(t('nodesAdmin.match.badId'));
    if (matchRows(matches?.open ?? null, matches?.settled ?? []).some((r) => r.matchId === id)) return openMatch(id);
    if (sample !== null) {
      found = { matchId: id, row: null, names: 'shown' };
      return openMatch(id);
    }
    void askMatch(id, true);
  };
  matchField.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.defaultPrevented) goFind();
  });

  const matchesView = (o: Overview): HTMLElement[] => {
    const m = matches;
    const now = Date.now();
    const rows = matchRows(m?.open ?? null, m?.settled ?? []).map((r) =>
      navButton(
        'mn-na-row mn-na-match',
        [
          h('b.mn-na-name', null, h('span.mn-dot', { class: r.open ? 'on' : '' }), h('code', null, r.matchId.slice(0, 8))),
          h('span.mn-na-c', null, r.nodeName),
          h('span.mn-na-c.mn-na-x', null, regionLabel(r.region)),
          h('span.mn-na-c', null, r.mode, r.ranked ? ` · ${t('nodesAdmin.match.ranked')}` : ''),
          h('span.mn-na-tags', null, tag(r.tone, t(`nodesAdmin.match.state.${r.state}` as Key))),
          h('span.mn-na-c.mn-na-x', null, ago(r.at, now)),
        ],
        () => openMatch(r.matchId),
        { 'data-key': 'na-match-' + r.key },
      ),
    );
    const voids = o.voids24h.map((v, i) => h('p', { 'data-key': 'na-void-' + i }, h('b', null, v.name ?? v.nodeId), ' · ', h('code.mn-na-raw', null, v.reason), ` · ${v.count}`));
    return historyTab('nodesAdmin.match.note', () => void loadMatches(), m, rows, () => void loadMatches(true), 'matches', [
      h('form.mn-form.mn-na-lookup', { onsubmit: (e: Event) => e.preventDefault() }, matchField.el, secondary(t('nodesAdmin.match.find'), goFind, { 'data-key': 'na-match-find' })),
      m?.names === 'unavailable' ? h('p.mn-note', null, t('nodesAdmin.match.namesUnavailable')) : null,
      section(t('nodesAdmin.match.voidsTitle'), ...(voids.length > 0 ? voids : [h('p.mn-note', null, t('nodesAdmin.match.noVoids'))])),
    ]);
  };

  const openMatch = (matchId: string): void => {
    view = { kind: 'match', matchId };
    paint();
  };

  /** A seat as the detail lists it: its team, its name ("Jugador N" for a name its player hides, a purged account said so) and, for the maintainers, its player id. */
  const seatLine = (s: MatchSeat): HTMLElement => {
    const n = seatName(s);
    const name = n.kind === 'name' ? h('b', null, n.name) : h('span', null, t(n.kind === 'bot' ? 'nodesAdmin.match.bot' : n.kind === 'gone' ? 'nodesAdmin.match.gone' : 'nodesAdmin.match.hidden', { n: n.n }));
    return h('p', { 'data-key': 'na-seat-' + s.slot }, tag(s.team === 0 ? 'ok' : 'bad', t(s.team === 0 ? 'nodesAdmin.match.blue' : 'nodesAdmin.match.red')), ' ', name, s.id !== null ? ' ' : null, s.id !== null ? h('code.mn-na-raw', null, s.id) : null);
  };

  /** What only a settled match has: when, how, the verdict and its verifier, the strike, the points, the delist. */
  const settledFacts = (x: HistoryMatch): Child[] => [
    ...fact(t('nodesAdmin.match.settled'), when(x.settledAt)),
    ...(x.reason !== null ? fact(t('nodesAdmin.detail.reason'), h('code.mn-na-raw', null, x.reason)) : []),
    ...(x.score !== null ? fact(t('nodesAdmin.match.score'), `${x.score.blue} - ${x.score.red}`) : []),
    ...fact(t('nodesAdmin.match.verified'), t(x.verified ? 'nodesAdmin.match.yes' : 'nodesAdmin.match.no'), x.verifierName !== null || x.verifiedBy !== null ? h('span', null, ` · ${x.verifierName ?? x.verifiedBy}`) : ''),
    ...(x.verdict !== null ? fact(t('nodesAdmin.match.verdict'), h('code.mn-na-raw', null, x.verdict.code)) : []),
    ...(x.strike !== null ? fact(t('nodesAdmin.match.strike'), h('code.mn-na-raw', null, x.strike)) : []),
    ...(x.points !== null ? fact(t('nodesAdmin.points.earned'), formatPoints(x.points)) : []),
    ...(x.frozen ? fact(t('nodesAdmin.points.frozen'), t('nodesAdmin.match.yes')) : []),
    ...(x.adminReason !== null ? fact(t('nodesAdmin.match.adminReason'), h('span', null, x.adminReason)) : []),
    ...fact(t('nodesAdmin.match.public'), t(x.delistedAt !== null ? 'nodesAdmin.match.delistedAt' : x.published ? 'nodesAdmin.match.published' : x.listed ? 'nodesAdmin.match.listed' : 'nodesAdmin.match.notListed'), x.delistedAt !== null ? ` · ${when(x.delistedAt)}` : ''),
  ];

  const matchDetail = (matchId: string): HTMLElement[] | null => {
    const open = matches?.open?.matches.find((x) => x.matchId === matchId) ?? null;
    const lookedUp = found !== null && found.matchId === matchId ? found : null;
    const settled = open === null ? (matches?.settled.find((x) => x.matchId === matchId) ?? lookedUp?.row ?? null) : null;
    const base: OpenMatch | HistoryMatch | null = open ?? settled;
    // A match looked up by its id that the history does not keep: only its id, the viewer and DESLISTAR.
    if (base === null && lookedUp === null) return null;
    const a = open !== null ? matchActions({ open: true, match: open }) : matchActions({ open: false, match: settled });
    const short = matchId.slice(0, 8);
    const done = (key: Key) => (): void => {
      menu.toast(t(key), 'ok');
      void loadMatches();
      if (found?.matchId === matchId) void askMatch(matchId, false);
    };
    // The public viewer's link: built from the match id once checked (64 hex), never from a server's text.
    const href = a.viewer ? replayHref(matchId) : null;
    const actions = h(
      'div.mn-na-actions',
      null,
      href !== null ? h('a.mn-btn', { href, target: '_blank', rel: 'noopener', 'data-nav': true, 'data-key': 'na-match-viewer' }, t('nodesAdmin.match.viewer')) : null,
      a.download ? secondary(t('nodesAdmin.match.download'), () => confirmSheet('download', short, t('nodesAdmin.match.download'), () => download(matchId)), { 'data-key': 'na-match-download' }) : null,
      a.verify ? secondary(t('nodesAdmin.match.verify'), () => void act(() => acc.nodesAction('match/verify', { matchId }), done('nodesAdmin.match.verifyAsked')), { 'data-key': 'na-match-verify' }) : null,
      a.delist ? secondary(t('nodesAdmin.match.delist'), () => confirmSheet('delist', short, t('nodesAdmin.match.delist'), (reason) => act(() => acc.nodesAction('delist', { matchId, reason }), done('nodesAdmin.match.delisted'))), { 'data-key': 'na-match-delist', class: 'mn-btn-cancel' }) : null,
      a.void ? secondary(t('nodesAdmin.match.void'), () => confirmSheet('voidMatch', short, t('nodesAdmin.match.void'), (reason) => act(() => acc.nodesAction('match/void', { matchId, reason }), done('nodesAdmin.match.voided'))), { 'data-key': 'na-match-void', class: 'mn-btn-cancel' }) : null,
      a.void ? secondary(t('nodesAdmin.match.voidStrike'), () => confirmSheet('voidStrike', short, t('nodesAdmin.match.voidStrike'), (reason) => act(() => acc.nodesAction('match/void', { matchId, reason, strike: true }), done('nodesAdmin.match.voided'))), { 'data-key': 'na-match-void-strike', class: 'mn-btn-cancel' }) : null,
    );
    if (base === null) {
      return [h('div.mn-prof-node', null, h('div.mn-prof-node-head', null, icon('ball', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, short)), h('dl.mn-prof-node-facts', null, ...fact(t('nodesAdmin.match.id'), h('code.mn-na-raw', null, matchId))), h('p.mn-note', null, t('nodesAdmin.match.noRow'))), actions];
    }
    const now = Date.now();
    const state = open !== null ? open.state : (settled as HistoryMatch).result;
    // A looked-up row's names were checked with it, a listed one's with its page.
    const names = open === null && lookedUp !== null && lookedUp.row === settled ? lookedUp.names : matches?.names;
    const facts = h(
      'dl.mn-prof-node-facts',
      null,
      ...fact(t('nodesAdmin.match.id'), h('code.mn-na-raw', null, base.matchId)),
      ...fact(t('nodesAdmin.match.node'), base.nodeName ?? base.nodeId),
      ...fact(t('nodesAdmin.detail.region'), regionLabel(base.region)),
      ...fact(t('nodesAdmin.match.mode'), base.mode, base.ranked ? ` · ${t('nodesAdmin.match.ranked')}` : '', ` · ${base.transport}`),
      ...fact(t('nodesAdmin.match.placed'), when(base.placedAt)),
      ...(base.reportedAt !== null ? fact(t('nodesAdmin.match.reported'), when(base.reportedAt)) : []),
      ...(open !== null
        ? [
            ...fact(t('nodesAdmin.match.started'), t(open.started ? 'nodesAdmin.match.yes' : 'nodesAdmin.match.no')),
            ...(open.queuedAt !== null ? fact(t('nodesAdmin.match.queued'), ago(open.queuedAt, now)) : []),
            ...(open.verifierName !== null ? fact(t('nodesAdmin.match.verifier'), open.verifierName) : []),
            ...fact(t('nodesAdmin.match.leaves'), String(open.leaves)),
          ]
        : settledFacts(settled as HistoryMatch)),
      ...fact(t('nodesAdmin.match.replay'), t(base.replay ? 'nodesAdmin.match.yes' : 'nodesAdmin.match.no')),
    );
    return [
      h('div.mn-prof-node', null, h('div.mn-prof-node-head', null, icon('ball', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, short), tag(matchTone(state), t(`nodesAdmin.match.state.${state}` as Key))), facts),
      actions,
      section(t('nodesAdmin.match.seats'), ...(names === 'unavailable' ? [h('p.mn-note', null, t('nodesAdmin.match.namesUnavailable'))] : []), ...base.seats.map(seatLine)),
    ];
  };

  /**
   * The raw replay, saved as <matchId>.tgr for `verify <file>` by hand (the server posts every
   * download to the team's channel): the bytes go into a blob of this page, never a server's text in a link.
   */
  const download = async (matchId: string): Promise<boolean> => {
    if (!/^[0-9a-f]{64}$/.test(matchId)) return false;
    if (sample !== null) {
      menu.toast(t('nodesAdmin.done'), 'ok');
      return true;
    }
    try {
      const bytes = await acc.nodesReplay(matchId);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${matchId}.tgr`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      menu.toast(t('nodesAdmin.match.downloaded'), 'ok');
      return true;
    } catch (e) {
      if (failureOf(e) === 'reauth') {
        queueMicrotask(() => askPassword(() => void download(matchId)));
        return true;
      }
      const text = errText(e);
      menu.toast(e instanceof AccountError && e.code === 'no_replay' ? t('nodesAdmin.match.noRaw') : text, 'error');
      return false;
    }
  };

  const eventsView = (): HTMLElement[] => {
    const rows = (events?.list ?? []).map((x) =>
      h(
        'div.mn-na-token',
        { 'data-key': 'na-event-' + x.id },
        h('small', null, when(x.at)),
        h('b', null, x.nodeName ?? x.nodeId),
        tag(eventTone(x.kind), t(`nodesAdmin.event.${x.kind}` as Key)),
        x.detail !== null ? h('code.mn-na-raw', null, x.detail) : null,
        x.actor !== null ? h('small', null, t('nodesAdmin.event.by'), ' ', h('span', null, x.actor)) : null,
      ),
    );
    return historyTab('nodesAdmin.history.note', () => void loadEvents(), events, rows, () => void loadEvents(true), 'events', [], true);
  };

  const alertsView = (): HTMLElement[] => {
    const a = alertLines;
    const rows = (a?.list ?? []).map((x) => h('div.mn-na-token', { 'data-key': 'na-alert-' + x.id }, h('small', null, when(x.at)), tag(x.kind === 'audit' ? 'muted' : 'warn', t(x.kind === 'audit' ? 'nodesAdmin.alerts.audit' : 'nodesAdmin.alerts.alert')), h('code.mn-na-raw', null, x.line)));
    return historyTab('nodesAdmin.alerts.note', () => void loadAlerts(), a, rows, () => void loadAlerts(true), 'alerts', [a !== null && !a.webhook ? h('div.mn-na-alert', null, icon('warning'), h('p', null, t('nodesAdmin.warn.noWebhook'))) : null], true);
  };

  // ---- the wizard: AGREGAR SERVIDOR DEL PROYECTO --------------------------------------------------------

  const openWizard = (): void => {
    wiz ??= { step: 'form', form: newForm(), checks: new Set(), token: null };
    view = { kind: 'wizard' };
    paint();
  };

  const slotsText = (): string => (data !== null ? t('nodesAdmin.wiz.slots', { used: data.operator.slotsUsed, max: data.operator.slotsMax }) : t('nodesAdmin.loading'));
  const paintSlots = (): void => {
    if (slotsEl === null) return;
    const full = data !== null && data.operator.slotsUsed >= data.operator.slotsMax;
    setChildren(slotsEl, slotsText(), full ? h('span.mn-field-error', null, ' ', t('nodesAdmin.wiz.noSlot')) : '');
  };

  const regionSheet = (w: Wizard, set: () => void): void => {
    const close = menu.modal({
      title: t('nodesAdmin.wiz.region'),
      body: h(
        'div.mn-na-items',
        null,
        ...REGIONS.map((r) =>
          navButton(
            `mn-btn${w.form.region === r.id ? ' mn-btn-primary' : ''}`,
            regionName(r.id),
            () => {
              w.form.region = r.id;
              close();
              set();
            },
            { 'data-key': 'na-wiz-region-' + r.id, 'aria-pressed': String(w.form.region === r.id), 'data-autofocus': w.form.region === r.id ? true : undefined },
          ),
        ),
      ),
      actions: [{ label: t('profile.cancel'), onClick: () => true }],
    });
  };

  const formStep = (w: Wizard): HTMLElement[] => {
    const f = w.form;
    const region = picker('na-wiz-region', 'globe', t('nodesAdmin.wiz.region'), () => regionSheet(w, () => region.set(f.region !== null ? regionName(f.region) : '—')));
    region.set(f.region !== null ? regionName(f.region) : '—');
    const name = field(t('nodesAdmin.wiz.name'), { maxLength: 32, value: f.name, keypad: 'text', enterkeyhint: 'next' });
    const host = field(t('nodesAdmin.wiz.host'), { maxLength: 253, value: f.host, keypad: 'email', inputmode: 'email', enterkeyhint: 'next', hint: t('nodesAdmin.wiz.hostHint') });
    const matches = field(t('nodesAdmin.wiz.matches'), { maxLength: 4, value: f.matches, keypad: 'text', enterkeyhint: 'next', hint: t('nodesAdmin.wiz.matchesHint', { max: MAX_CAPACITY }) });
    const egress = field(t('nodesAdmin.wiz.egress'), { maxLength: 7, value: f.egress, keypad: 'digits', inputmode: 'numeric', enterkeyhint: 'done', hint: t('nodesAdmin.wiz.egressHint') });
    name.input.addEventListener('input', () => (f.name = name.input.value));
    host.input.addEventListener('input', () => (f.host = host.input.value));
    matches.input.addEventListener('input', () => (f.matches = matches.input.value));
    egress.input.addEventListener('input', () => (f.egress = egress.input.value));
    const preset = seg(
      'na-wiz-preset',
      t('nodesAdmin.wiz.preset'),
      PROJECT_PRESETS.map((p) => ({ value: p.name, label: `${p.name} · ${regionName(p.region)}` })),
      () => PROJECT_PRESETS.find((p) => p.name === f.name.trim() && p.region === f.region)?.name ?? '',
      (v) => {
        const p = PROJECT_PRESETS.find((x) => x.name === v);
        if (p === undefined) return;
        f.name = p.name;
        f.region = p.region;
        name.input.value = p.name;
        region.set(regionName(p.region));
      },
    );
    const roles = seg('na-wiz-roles', t('nodesAdmin.wiz.roles'), [{ value: 'host,verify' as const, label: t('nodesAdmin.wiz.rolesHostVerify') }, { value: 'host' as const, label: t('nodesAdmin.wiz.rolesHost') }], () => f.roles, (v) => (f.roles = v));
    const regionErr = h('p.mn-field-error', { hidden: true });
    slotsEl = h('p.mn-note');
    paintSlots();
    const next = (): void => {
      for (const x of [name, host, matches, egress]) x.error(null);
      regionErr.hidden = true;
      const issues = tokenFormIssues(f, data !== null ? { used: data.operator.slotsUsed, max: data.operator.slotsMax } : null);
      for (const i of issues) {
        if (i.field === 'region') ((regionErr.hidden = false), (regionErr.textContent = t('nodesAdmin.wiz.badRegion')));
        if (i.field === 'name') name.error(t('nodesAdmin.wiz.badName'));
        if (i.field === 'host') host.error(t(`nodesShared.host.${i.host ?? 'bad'}` as Key));
        if (i.field === 'matches') matches.error(t('nodesAdmin.wiz.badMatches', { max: MAX_CAPACITY }));
        if (i.field === 'egress') egress.error(t('nodesAdmin.wiz.badEgress'));
        if (i.field === 'slots') menu.toast(t('nodesAdmin.wiz.noSlot'), 'error');
      }
      if (issues.length > 0) return;
      w.step = 'checklist';
      paint();
    };
    return [
      h('div.mn-na-alert', null, icon('warning'), h('p', null, t('nodesAdmin.wiz.warn'))),
      h('form.mn-form.mn-na-form', { onsubmit: (e: Event) => e.preventDefault() }, h('span.mn-field-label', null, t('nodesAdmin.wiz.preset')), preset.el, region.el, regionErr, name.el, host.el, h('span.mn-field-label', null, t('nodesAdmin.wiz.roles')), roles.el, matches.el, egress.el, slotsEl, primary(t('nodesAdmin.wiz.next'), next, { 'data-key': 'na-wiz-next' })),
    ];
  };

  /** The token, after the password: the server's install line, its id (the start of its hash, as the overview lists it). */
  const mint = async (w: Wizard): Promise<void> => {
    const ask = tokenAskOf(w.form);
    try {
      const r = await acc.nodesToken(ask);
      const id = (await sha256Hex(r.token)).slice(0, 12);
      w.token = { id, line: r.install.linux, ask, expiresAt: r.expiresAt, lineOk: installLineMatches(r.install.linux, ask) };
      w.step = 'token';
      clock = refreshResume(clock, Date.now());
    } catch (e) {
      if (failureOf(e) === 'reauth') return askPassword(() => void mint(w));
      menu.toast(errText(e), 'error');
      if (e instanceof AccountError && (e.code === 'too_many_nodes' || e.code.startsWith('bad_') || e.code === 'verify_reserved')) w.step = 'form';
    }
    if (el.isConnected && view.kind === 'wizard') paint();
  };

  const checklistStep = (w: Wizard): HTMLElement[] => {
    const lines = checklistOf(w.form.roles === 'host,verify');
    const all = (): boolean => lines.every((l) => w.checks.has(l));
    const items = lines.map((l) => {
      const b: HTMLButtonElement = navButton(
        'mn-na-check',
        [icon(w.checks.has(l) ? 'check' : 'next'), h('span', null, t(`nodesAdmin.check.${l}` as Key))],
        () => {
          if (w.checks.has(l)) w.checks.delete(l);
          else w.checks.add(l);
          keepFocus(paintBody);
        },
        { 'data-key': 'na-check-' + l, 'aria-pressed': String(w.checks.has(l)) },
      );
      return b;
    });
    const go = (): void => {
      if (!all()) return menu.toast(t('nodesAdmin.wiz.tickAll'), 'error');
      // Always the sheet (CONFIRMAR CON LA CONTRASEÑA's rule): the follow-up gets its 15 minutes whole.
      confirmItsYou(menu, () => void mint(w), 2, passwordSheet());
    };
    const out: Array<HTMLElement | null> = [
      h('p.mn-note', null, t('nodesAdmin.wiz.checkNote', { name: w.form.name.trim(), region: w.form.region !== null ? regionName(w.form.region) : '—' })),
      h('div.mn-na-checks', null, ...items),
      w.form.roles === 'host,verify' ? h('p.mn-note', null, t('nodesAdmin.check.verifyWhy')) : null,
      passwordSheet() ? null : h('p.mn-note', null, t('nodesAdmin.noPassword')),
      h('div.mn-na-actions', null, primary(t('nodesAdmin.wiz.token'), go, { 'data-key': 'na-wiz-token' }), secondary(t('nodesAdmin.wiz.edit'), () => ((w.step = 'form'), paint()), { 'data-key': 'na-wiz-edit' })),
    ];
    return out.filter((x): x is HTMLElement => x !== null);
  };

  /** The follow-up of the wizard's token and its node (the overview's, each refresh), and its countdown (each tick). */
  const paintFollow = (): void => {
    const w = wiz;
    if (followEl === null || w === null || w.token === null) return;
    const now = Date.now();
    const lines: Child[] = [];
    const left = minutesLeft(w.token.expiresAt, now);
    const f = data !== null ? followOf(data, w.token.id, now) : null;
    if (f === null) lines.push(h('p.mn-note', null, t('nodesAdmin.loading')));
    else {
      const step = f.step === 'waiting' && left === 0 ? 'expired' : f.step;
      lines.push(h('p.mn-na-follow', { 'data-step': step }, icon(step === 'active' || step === 'probation' ? 'check' : step === 'expired' || step === 'revoked' || step === 'stopped' ? 'warning' : 'refresh'), h('span', null, t(`nodesAdmin.follow.${step}` as Key, { name: f.node?.name ?? w.token.ask.name ?? '' }))));
      if (step === 'waiting') lines.push(h('p.mn-note', null, t('nodesShared.expiresIn', { minutes: left }), ' · ', t('nodesShared.oneUse')));
      if (step === 'expired' || step === 'gone') lines.push(h('p.mn-note', null, t('nodesAdmin.follow.expiredHelp')));
      const probe = f.node?.lastProbe ?? null;
      if (step === 'pending' && probe !== null && !probe.ok) {
        const hint = probeHint(probe.error);
        lines.push(h('p', null, h('code.mn-na-raw', null, probe.error ?? '')), h('p.mn-note', null, t(hint !== null ? (`nodesShared.hint.${hint}` as Key) : 'nodesShared.hint.unknown')));
      }
      if (step === 'stopped' && f.node?.statusReason) lines.push(h('p', null, h('code.mn-na-raw', null, f.node.statusReason)));
    }
    setChildren(followEl, ...lines);
  };

  const tokenStep = (w: Wizard): HTMLElement[] => {
    const tk = w.token;
    if (tk === null) return [];
    followEl = h('div.mn-na-followbox', { 'aria-live': 'polite' });
    paintFollow();
    const line = h('div.mn-cmd', readOnly('na-wiz-cmd'), tk.line);
    const copy = secondary(t('nodesShared.copy'), () => void copyText(tk.line).then((ok) => menu.toast(t(ok ? 'nodesShared.copied' : 'nodesShared.copyFailed'), ok ? 'ok' : 'error')), { 'data-key': 'na-wiz-copy', 'data-autofocus': true });
    // ▼ from the line: COPIAR under it (the pick from a box that wide takes LISTO).
    onNavTo(line, 'down', () => copy);
    const cmd = tk.lineOk ? h('div.mn-na-cmdbox', null, line, copy) : h('p.mn-field-error', null, t('nodesAdmin.wiz.badLine'));
    return [
      h('p.mn-note', null, t('nodesAdmin.wiz.cmdTitle')),
      cmd,
      followEl,
      section(t('nodesAdmin.wiz.afterTitle'), h('p.mn-note', null, t('nodesAdmin.wiz.after'))),
      h(
        'div.mn-na-actions',
        null,
        secondary(t('nodesAdmin.wiz.again'), () => ((w.step = 'form'), (w.token = null), (w.checks = new Set()), paint()), { 'data-key': 'na-wiz-again' }),
        secondary(t('nodesAdmin.wiz.done'), () => ((wiz = null), (view = { kind: 'tabs' }), (tab = 'nodes'), paint()), { 'data-key': 'na-wiz-done' }),
      ),
    ];
  };

  const wizardView = (): HTMLElement[] => {
    const w = wiz;
    if (w === null) return [];
    followEl = null;
    slotsEl = null;
    const head = h('h2.mn-section-title', null, t('nodesAdmin.wiz.open'));
    return [head, ...(w.step === 'form' ? formStep(w) : w.step === 'checklist' ? checklistStep(w) : tokenStep(w))];
  };

  // ---- the views --------------------------------------------------------------------------------------

  const tabsStrip = (): HTMLElement =>
    h(
      'div.mn-tabs.mn-na-tabs',
      { role: 'tablist', 'aria-label': t('nodesAdmin.title'), 'data-nav-row': true },
      ...ADMIN_TABS.map((id) =>
        h(
          `button.mn-tab${tab === id ? '.mn-tab-on' : ''}` as 'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(tab === id),
            'data-nav': true,
            'data-key': 'na-tab-' + id,
            onclick: () => {
              if (tab === id) return;
              tab = id;
              if (id === 'points' && frozen === null) void loadFrozen();
              if (id === 'stats' && stats === null) void loadStats();
              if (id === 'matches' && matches === null) void loadMatches();
              if (id === 'history' && events === null) void loadEvents();
              if (id === 'alerts' && alertLines === null) void loadAlerts();
              if (id === 'operators' && operators === null) void loadOperators();
              keepFocus(paintBody);
            },
          },
          t(TAB_KEY[id]),
        ),
      ),
    );

  const paintBody = (): void => {
    if (tvHere()) return setChildren(body, h('div.mn-prof-node', null, icon('tv', 'mn-mtile-icon'), h('p', null, t('nodesShared.tvNote'))));
    if (!acc.signedIn && sample === null) return setChildren(body, h('p.mn-note', null, t('nodesAdmin.signIn')));
    const p = problem;
    if (data === null) {
      if (p !== null && (p.failure === 'denied' || p.failure === 'gone' || p.failure === 'fail' || p.failure === 'limited')) return setChildren(body, h('p.mn-note', null, t(nodeErrorKey(p.code === 'http' ? 'internal' : p.code))));
      if (p !== null && p.failure === 'paused') return setChildren(body, h('p.mn-note', null, t('nodesAdmin.pausedNote')));
      if (p !== null && p.failure === 'reauth') return setChildren(body);
      return setChildren(body, h('p.mn-note', null, t('nodesAdmin.loading')));
    }
    const o = data;
    if (view.kind === 'wizard') return setChildren(body, ...wizardView());
    if (view.kind === 'node') {
      const nodeId = view.nodeId;
      const n = o.nodes.find((x) => x.nodeId === nodeId);
      if (n !== undefined) return setChildren(body, ...nodeDetail(n));
      view = { kind: 'tabs' };
    }
    if (view.kind === 'match') {
      const d = matchDetail(view.matchId);
      if (d !== null) return setChildren(body, ...d);
      view = { kind: 'tabs' };
    }
    const content =
      tab === 'summary'
        ? summaryView(o)
        : tab === 'nodes'
          ? nodesView(o)
          : tab === 'tokens'
            ? tokensView(o)
            : tab === 'regions'
              ? regionsView(o)
              : tab === 'release'
                ? releaseView(o)
                : tab === 'points'
                  ? pointsView()
                  : tab === 'stats'
                    ? statsView()
                    : tab === 'operators'
                      ? operatorsView()
                      : tab === 'matches'
                      ? matchesView(o)
                      : tab === 'history'
                        ? eventsView()
                        : alertsView();
    setChildren(body, tabsStrip(), ...content);
  };

  const paint = (): void => {
    paintStatus();
    paintBody();
    menu.refit();
    menu.refocus();
  };

  // A session that changes while the panel is up (signed out, another account in another tab): nothing of the first stays.
  acc.subscribe(() => {
    if ((acc.account?.playerId ?? null) === owner || sample !== null) return;
    reset();
    gen++;
    clock = refreshStart(Date.now());
    if (el.isConnected) paint();
  });

  // The samples exist in development and in a VITE_UI_FIT=1 build only (read here: node tests import this module).
  if (import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1') {
    (window as unknown as { __nodesAdmin: (kind: string | null) => void }).__nodesAdmin = (kind) => {
      if (kind === null) {
        sample = null;
        reset();
        clock = refreshStart(Date.now());
        return paint();
      }
      sample = sampleOverview();
      data = sample;
      problem = null;
      found = null;
      view = { kind: 'tabs' };
      tab = (ADMIN_TABS as readonly string[]).includes(kind) ? (kind as AdminTab) : 'summary';
      if (kind === 'points') {
        frozen = { frozen: [{ account: '0a1b2c3d4e5f6071', reason: 'verification_failed:' + 'c'.repeat(64), at: Date.now() - 3_600_000 }], more: false };
        lookup = { account: '0a1b2c3d4e5f6071', wallet: { account: '0a1b2c3d4e5f6071', wallet: { earned: 12500, spent: 3000, balance: 9500, frozen: 'verification_failed:' + 'c'.repeat(64) }, items: ['badge-host', 'pampero'], car: 'pampero' }, error: null };
      }
      if (kind === 'stats') stats = { accounts: { total: 18342, banned: 3, verifiedEmail: 9120, emailHint: 410, active30d: 5230, operators: 12, byWays: { password: 6000, 'password+google': 4100, discord: 2200 }, passwordOnly: { total: 1200, active30d: 90 } }, days: sampleDays(), error: null, loading: false };
      if (kind === 'operators') operators = { list: sampleOperators(sample), error: null, loading: false };
      if (kind === 'detail') view = { kind: 'node', nodeId: sample.nodes[2].nodeId };
      if (kind === 'review') view = { kind: 'node', nodeId: sample.nodes[3].nodeId };
      if (kind === 'review') frozen = { frozen: [{ account: sample.nodes[3].operator.id, reason: 'verification_failed:' + 'c'.repeat(64), at: Date.now() - 3_600_000 }], more: false };
      if (kind === 'matches' || kind === 'match' || kind === 'lone' || kind === 'history' || kind === 'alerts') {
        const x = sampleHistory(sample);
        matches = { open: x.open, settled: x.settled, next: 'more', names: 'shown', error: null, loading: false };
        events = { list: x.events, next: 'more', error: null, loading: false };
        alertLines = { list: x.alerts, next: null, webhook: false, error: null, loading: false };
        if (kind === 'match') ((tab = 'matches'), (view = { kind: 'match', matchId: x.settled[0].matchId }));
        // A replay listed before the history was kept, looked up by its link: no row, the viewer and DESLISTAR.
        if (kind === 'lone') ((tab = 'matches'), (found = { matchId: '9'.repeat(64), row: null, names: 'shown' }), (view = { kind: 'match', matchId: '9'.repeat(64) }));
      }
      if (kind === 'wizard' || kind === 'checklist' || kind === 'token') {
        wiz = { step: kind === 'wizard' ? 'form' : kind === 'checklist' ? 'checklist' : 'token', form: { region: 'EU', name: 'frankfurt-1', host: 'node-1.example.com', roles: 'host,verify', matches: '12', egress: '2000' }, checks: new Set(), token: null };
        if (kind === 'token') {
          const ask = tokenAskOf(wiz.form);
          const line = `curl -fsSL https://example.com/nodes/releases/install.sh | sudo bash -s -- --control https://example.com --token tgn1_SAMPLEsampleSAMPLEsampleSAMPLE00 --name frankfurt-1 --roles host,verify --transport wss --public-host node-1.example.com --matches 12 --egress-cap-gb 2000`;
          wiz.token = { id: sample.tokens[0].id, line, ask, expiresAt: Date.now() + 52 * 60_000, lineOk: installLineMatches(line, ask) };
        }
        view = { kind: 'wizard' };
      }
      paint();
    };
  }

  return {
    id: 'nodes-admin',
    title: t('nodesAdmin.title'),
    el,
    show: (anew) => {
      if ((acc.account?.playerId ?? null) !== owner && sample === null) reset();
      if (anew && (view.kind === 'node' || view.kind === 'match')) view = { kind: 'tabs' };
      // Every visit asks at once (its read is audited once per account per 30 minutes, not per visit).
      gen++;
      asked = false;
      clock = refreshStart(Date.now());
      paint();
    },
    tick: () => {
      if (sample !== null || tvHere() || !acc.signedIn) return;
      if (refreshDue(clock, Date.now(), document.hidden)) void load();
      if (view.kind === 'wizard' && wiz?.step === 'token') paintFollow();
    },
    // A sub-view (a node's detail, the wizard) closes first; the wizard keeps its state for the next open.
    back: () => {
      if (view.kind === 'tabs') return false;
      view = { kind: 'tabs' };
      keepFocus(paint);
      return true;
    },
  };
}

/** The sample overview (window.__nodesAdmin): four nodes of every kind, tokens, every region, the flags and warnings. */
function sampleOverview(): Overview {
  const now = Date.now();
  const counters = { assigned: 412, verified: 398, rankedVerified: 120, failedVerification: 0, lost: 2, strikes: 0, probationVerified: 20 };
  const node = (i: number, name: string, region: RegionId, status: NodeStatus, o: Partial<AdminNode> = {}): AdminNode => ({
    nodeId: String(i).repeat(16).slice(0, 16),
    name,
    region,
    status,
    statusReason: null,
    suspendedUntil: null,
    online: true,
    roles: ['host', 'verify'],
    transports: ['wss'],
    trusted: true,
    publicUrl: `wss://${name}.example.com`,
    reachable: true,
    active: 3,
    capacity: { matches: 12, source: 'bench' },
    tickLagP99Ms: 4.2,
    egressGB: 812.4,
    counters,
    version: '0.3.0',
    compatible: true,
    operator: { id: 'f0e1d2c3b4a59687', name: 'Turbogol' },
    createdAt: now - 20 * 86_400_000,
    lastSeen: now - 4000,
    draining: false,
    egressCapGB: 2000,
    cpuLoad: 0.3,
    bootId: 'boot',
    matches: 3,
    build: { version: '0.3.0', protocol: 3, wasmSha256: 'a'.repeat(64) },
    specs: { cpus: 4, cpuModel: 'AMD EPYC', memMB: 8192, arch: 'x64', os: 'linux', node: 'v22.11.0' },
    capacityMax: 12,
    reachableAt: now - 86_400_000,
    lastProbe: { at: now - 120_000, ok: true, error: null },
    probeFailures: 0,
    strikeTimes: [],
    pauseTimes: [],
    publicHost: `${name}.example.com`,
    retiredAt: null,
    retiredReason: null,
    trustRemovedAt: null,
    linkCuts: { count24h: 1, lastAt: now - 7_200_000 },
    ...o,
  });
  const nodes = [
    node(1, 'sao-paulo-1', 'SA', 'active'),
    node(2, 'Ubuntu', 'SA', 'banned', { online: false, active: 0, matches: 0, lastSeen: now - 30 * 86_400_000, statusReason: 'a bad first install', retiredAt: now - 86_400_000, retiredReason: 'replaced' }),
    node(3, 'frankfurt-1', 'EU', 'pending', { active: 0, matches: 0, reachable: false, reachableAt: null, lastProbe: { at: now - 30_000, ok: false, error: 'timeout' }, probeFailures: 3, counters: { ...counters, verified: 0, probationVerified: 0 } }),
    node(4, 'casa-de-ana-muy-largo', 'SA', 'suspended', { trusted: false, roles: ['host'], statusReason: 'verification_failed', online: false, lastSeen: now - 3_600_000, operator: { id: '0a1b2c3d4e5f6071', name: 'ana' }, strikeTimes: [now - 86_400_000], egressCapGB: null }),
  ];
  return {
    at: now,
    build: { version: '0.3.0', protocol: 3, wasmSha256: 'a'.repeat(64) },
    channel: { stable: '0.3.0', minimum: '0.3.0' },
    verifying: 1,
    operator: { id: 'f0e1d2c3b4a59687', name: 'Turbogol', slotsUsed: 2, slotsMax: 4 },
    nodes,
    tokens: [
      { id: '3f9a1c2b7d4e', operatorId: 'f0e1d2c3b4a59687', operatorName: 'Turbogol', region: 'EU', name: 'frankfurt-1', publicHost: 'frankfurt-1.example.com', roles: ['host', 'verify'], createdAt: now - 8 * 60_000, expiresAt: now + 52 * 60_000, usedBy: null, revokedAt: null, state: 'unused' },
      { id: '8e7d6c5b4a39', operatorId: 'f0e1d2c3b4a59687', operatorName: 'Turbogol', region: 'SA', name: 'sao-paulo-1', publicHost: null, roles: null, createdAt: now - 20 * 86_400_000, expiresAt: now - 20 * 86_400_000 + 3_600_000, usedBy: nodes[0].nodeId, revokedAt: null, state: 'used' },
    ],
    regions: REGIONS.map((r) => ({ region: r.id, hostsOnline: r.id === 'SA' ? 1 : 0, slots: r.id === 'SA' ? 12 : 0, active: r.id === 'SA' ? 3 : 0, matches: r.id === 'SA' ? 3 : 0, unplaced: r.id === 'EU' ? 14 : 0, regionFactor: r.id === 'EU' ? 1.5 : 1, rankedReady: r.id === 'SA' })),
    verifiers: [{ nodeId: nodes[0].nodeId, name: 'sao-paulo-1', region: 'SA', version: '0.3.0', node: 'v22.11.0', status: 'active', online: true, verifying: 1 }],
    verifyQueue: [{ version: '0.3.0', protocol: 3, wasmSha256: 'a'.repeat(64), depth: 2, oldestAt: now - 40_000 }],
    outbox: { rows: 1, byPath: [{ path: '/host-credit', rows: 1, oldestAt: now - 5000 }] },
    points: [],
    flags: (['matchmaking_off', 'do_disabled', 'nodes_on', 'vm_disabled', 'nodes_off', 'replays_off', 'email_off', 'turn_cf_disabled'] as const).map((name) => ({ name, raw: name === 'nodes_on' ? '1' : null, set: name === 'nodes_on', meaning: '' })),
    alerts: { webhook: false },
    warnings: [{ kind: 'no_webhook' }, { kind: 'trusted_off_channel', nodeId: nodes[2].nodeId, name: 'frankfurt-1', version: '0.2.9', stable: '0.3.0' }],
    hosting: {
      flag: 'node_operators',
      raw: '0a1b2c3d4e5f6071,1b2c3d4e5f607182',
      stage: 'canary',
      terms: { inForce: true, version: '2026-11-13', needed: '2026-11-13' },
      changes: [{ id: 2, at: now - 3_600_000, actor: 'Turbogol (f0e1d2c3b4a59687)', flag: 'node_operators', old: '0', new: '0a1b2c3d4e5f6071,1b2c3d4e5f607182', reason: 'the canary of the first two hosts' }],
      communityWebhook: false,
    },
    voids24h: [
      { nodeId: nodes[0].nodeId, name: 'sao-paulo-1', reason: 'node_offline', count: 2 },
      { nodeId: nodes[3].nodeId, name: 'casa-de-ana-muy-largo', reason: 'verification_failed:report_mismatch', count: 1 },
    ],
  };
}

/** The history's samples (window.__nodesAdmin('matches' | 'match' | 'lone' | 'history' | 'alerts')): an open match, settled ones of every kind, events and alert lines. */
function sampleHistory(o: Overview): { open: OpenMatches; settled: HistoryMatch[]; events: NodeEvent[]; alerts: AlertLine[] } {
  const now = Date.now();
  const sp = o.nodes[0];
  const ana = o.nodes[3];
  const id = (c: string): string => c.repeat(64);
  const seats = (hidden: boolean): MatchSeat[] => [
    { slot: 0, team: 0, bot: false, name: 'tero_veloz', id: 'a1a1a1a1a1a1a1a1', hidden: false },
    { slot: 1, team: 0, bot: true, name: null, id: null, hidden: false },
    { slot: 2, team: 1, bot: false, name: hidden ? null : 'Invitado 4821', id: 'b2b2b2b2b2b2b2b2', hidden },
    { slot: 3, team: 1, bot: false, name: null, id: null, hidden: false },
  ];
  const settled = (c: string, at: number, x: Partial<HistoryMatch>): HistoryMatch => ({
    matchId: id(c),
    nodeId: sp.nodeId,
    nodeName: sp.name,
    region: 'SA',
    mode: '2v2',
    ranked: true,
    transport: 'wss',
    placedAt: at - 400_000,
    reportedAt: at - 2000,
    settledAt: at,
    result: 'rated',
    reason: 'rules',
    score: { blue: 3, red: 2 },
    verified: true,
    verifiedBy: sp.nodeId,
    verifierName: sp.name,
    verdict: { ok: true, code: 'ok' },
    strike: null,
    replay: true,
    points: null,
    frozen: false,
    adminReason: null,
    seats: seats(true),
    delistedAt: null,
    listed: true,
    published: true,
    ...x,
  });
  return {
    open: {
      total: 1,
      names: 'shown',
      matches: [{ matchId: id('d'), nodeId: sp.nodeId, nodeName: sp.name, region: 'SA', mode: '1v1', ranked: false, transport: 'wss', state: 'verifying', placedAt: now - 420_000, deadline: now + 900_000, started: true, reportedAt: now - 30_000, queuedAt: now - 29_000, verifying: false, verifierName: null, replay: true, leaves: 0, seats: seats(false).filter((s) => s.slot === 0 || s.slot === 2) }],
    },
    settled: [
      settled('e', now - 3_600_000, {}),
      settled('f', now - 5_400_000, { result: 'void', reason: 'node_offline', score: null, verified: false, verifiedBy: null, verifierName: null, verdict: null, strike: 'node_offline', listed: false, published: false, ranked: false, mode: '3v3' }),
      settled('a', now - 9_000_000, { nodeId: ana.nodeId, nodeName: ana.name, result: 'void', reason: 'verification_failed:report_mismatch', score: null, verdict: { ok: true, code: 'ok' }, frozen: true, listed: false, published: false }),
      settled('b', now - 86_400_000, { result: 'unrated', ranked: false, reason: 'ttl', verified: false, verifiedBy: null, verifierName: null, verdict: null, delistedAt: now - 80_000_000, listed: false, published: false }),
    ],
    events: [
      { id: 6, nodeId: ana.nodeId, nodeName: ana.name, at: now - 9_000_000, kind: 'status_change', detail: 'active -> suspended: verification_failed', actor: null },
      { id: 5, nodeId: ana.nodeId, nodeName: ana.name, at: now - 9_000_001, kind: 'verify_failed', detail: `match ${id('a')}: report_mismatch`, actor: null },
      { id: 4, nodeId: sp.nodeId, nodeName: sp.name, at: now - 20_000_000, kind: 'drain', detail: 'moving to a bigger plan', actor: 'Turbogol (f0e1d2c3b4a59687)' },
      { id: 3, nodeId: sp.nodeId, nodeName: sp.name, at: now - 30_000_000, kind: 'link_4408', detail: 'silent 31 s', actor: null },
      { id: 2, nodeId: o.nodes[2].nodeId, nodeName: o.nodes[2].name, at: now - 40_000_000, kind: 'probe_failed', detail: 'timeout', actor: null },
      { id: 1, nodeId: o.nodes[2].nodeId, nodeName: o.nodes[2].name, at: now - 40_100_000, kind: 'registered', detail: 'pending, roles host+verify, transports wss, trusted', actor: null },
    ],
    alerts: [
      { id: 3, at: now - 60_000, kind: 'audit', line: "ALERT admin Turbogol (f0e1d2c3b4a59687): read the match history (a maintainer's reads come here once per 30 min, every one is in the logs)" },
      { id: 2, at: now - 9_000_000, kind: 'alert', line: `ALERT match ${id('a')} on casa-de-ana-muy-largo: verification report_mismatch` },
      { id: 1, at: now - 30_000_000, kind: 'alert', line: 'ALERT trusted node sao-paulo-1 (1111111111111111) offline for 2 min (last heartbeat 03:12:09 UTC): no match goes to it' },
    ],
  };
}

/** The Operadores tab's samples (window.__nodesAdmin('operators')): a host with a server on probation and reports, a blocked one. */
function sampleOperators(o: Overview): OperatorView[] {
  const now = Date.now();
  const ana = o.nodes[3];
  const base = (id: string, name: string, x: Partial<OperatorView> = {}): OperatorView => ({
    operatorId: id,
    name,
    status: 'ok',
    reason: null,
    actor: null,
    at: null,
    showPublic: false,
    rules: { accepted: '2026-11-13', held: true },
    nodes: [],
    refusalRate: 0,
    tokens: { today: 0, unused: 0 },
    running: { matches: 0, max: 32 },
    points: { today: 0, cap: 300, d30: 0, matches30d: 0, earned: 0, concentration: 0 },
    reports: { days: 7, count: 0, accounts: 0, byReason: { unresponsive: 0, lag: 0, disconnected: 0, other: 0 }, byNode: [], recent: [] },
    ...x,
  });
  return [
    base(ana.operator.id, ana.operator.name, {
      showPublic: true,
      nodes: [{ nodeId: ana.nodeId, name: ana.name, region: 'SA', status: 'probation', online: true, retired: false, capacity: 12, capacityEffective: 4, assigned: 41, refused: 3, seenContinent: 'SA' }],
      refusalRate: 0.068,
      tokens: { today: 1, unused: 1 },
      running: { matches: 3, max: 32 },
      points: { today: 212, cap: 300, d30: 3120, matches30d: 64, earned: 4100, concentration: 0.42 },
      reports: { days: 7, count: 3, accounts: 2, byReason: { unresponsive: 0, lag: 2, disconnected: 1, other: 0 }, byNode: [{ nodeId: ana.nodeId, reports: 3, accounts: 2 }], recent: [{ at: now - 600_000, reporterId: 'b2b2b2b2b2b2b2b2', matchId: 'a'.repeat(64), nodeId: ana.nodeId, reason: 'lag', ping: 182, corrections: 40 }] },
    }),
    base('1b2c3d4e5f607182', 'Constantinopla_9', { status: 'blocked', reason: 'a modified node program', actor: 'Turbogol (f0e1d2c3b4a59687)', at: now - 86_400_000, rules: { accepted: '2026-11-05', held: false } }),
  ];
}

/** Thirty sample queue days (window.__nodesAdmin('stats')). */
function sampleDays(): unknown[] {
  const today = Date.now();
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(today - i * 86_400_000).toISOString().slice(0, 10),
    searches: { casual: 300 + i, ranked: 120 },
    cancelled: { casual: 20, ranked: 8 },
    dropped: { casual: 4, ranked: 1 },
    formed: { casual: { 1: 30, 2: 80 }, ranked: { 2: 40 } },
    onNode: 60,
    onCloud: 90,
    crossRegion: 3,
  }));
}
