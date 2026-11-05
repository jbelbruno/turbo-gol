/**
 * MIS SERVIDORES (Prompt 2, Part B: id 'servers'): where an account outside the project adds a
 * community server (a Linux VPS with a DNS name, by wss, hosting only), follows it to active and
 * looks after it. Its logic is serversModel.ts; the calls are AccountClient's (GET /nodes/mine,
 * POST /nodes/tokens, the owner's /nodes/mine/* and /nodes/tokens/revoke, /nodes/mine/public), the
 * balance the garage's (GET /api/me/shop).
 *
 * Dark until GET /api/config says hosting is open (owner's decision 1): before, the screen shows
 * nothing and goes back, asks nothing, and no entry leads here (PERFIL and GARAJE keep the guide;
 * `#servers` opens PERFIL). It is stacked on the section shown (shell/sections.ts EVERY_SECTION:
 * Back returns there). The views, decided in show() since the screen is cached (serversViewOf):
 *
 *   guest    INICIAR SESIÓN opens PERFIL as a detour and comes back here once signed in (as GARAJE,
 *            across a provider's round trip too: accountLinksModel.ts Detour 'servers')
 *   closed   open, but not for this account (a canary it is not in; with every account let in, a
 *            neutral line and a retry): what a community server is, no date, the guide
 *   project  a project account: its servers are CONTROL DE NODOS' (listed, nothing to do here)
 *   host     the wallet's pause when there is one (its reason, the review); AGREGAR UN SERVIDOR: what
 *            the account still lacks with its fix (the email: PERFIL's own dialog, profile.ts
 *            emailDialog, or its "mail is off" line; the terms in force: their re-accept sheet), else the form (region, never
 *            changed after; name; DNS name; matches; egress cap), the checklist, the acceptance
 *            (Terms §12 and Annex B with the 18-or-older switch, the strings of PR 2A verbatim,
 *            right above PEDIR CÓDIGO: the switch sends `adult`, the button `acceptHost`), then
 *            the code's install line with COPIAR, its hour and its follow-up to active; on a TV
 *            "Hazlo en tu teléfono o en tu PC" and a QR to /#servers instead (decision 7); TUS
 *            SERVIDORES (state, load against the effective capacity, egress, version against the
 *            channel, last seen, strikes, refusals; DRENAR, RENOMBRAR, RETIRAR held to confirm, never
 *            on a TV); TUS CÓDIGOS (REVOCAR an unused one); PUNTOS DE SERVIDOR (today against the
 *            cap, 30 days, all time, the balance and CANJEAR EN GARAJE); the public list's switch; a
 *            short help (on a TV, where the rules are and the guide's QR: no link leaves the game's tab)
 *
 * GET /nodes/mine is asked again every MINE_REFRESH_MS on the Menu's tick while the screen is on top
 * and the page shown (slower after a 429); it needs no freshness, so the follow-up never stops at the
 * 15 minutes. A code's 403 reauth_required opens "confirm it's you" (accountLinks.ts confirmItsYou:
 * the password or a mailed code) and asks again: the server decides, never this browser's clock.
 * Everything the server sends (names, reasons, probe errors, codes) is a text child, never markup.
 * Nothing of it is stored. In development (or a VITE_UI_FIT=1 build) window.__servers(kind | null)
 * shows a sample (scripts/ui-fit.mjs).
 */
import { copyText, h, navButton, setChildren } from '../dom';
import type { Child } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { AuthConfig } from '../../net/AccountClient';
import { REGIONS, isRegion } from '../../net/account';
import type { RegionId } from '../../net/account';
import { MAX_CAPACITY, NODE_NAME_RE, installLineMatches, nodeErrorKey, nodeFailure, probeHint, statusTone, tokenFormIssues } from '../../net/nodes';
import type { MineAnswer, MineNode, MineToken, NodeFailure, NodeStatus, TokenAsk, TokenForm, Tone } from '../../net/nodes';
import { sha256Hex } from '../../../nodes/shared/edcrypto';
import { legalPaths } from '../../net/terms';
import { SOURCE_URL } from '../../brand';
import type { Menu, Screen } from '../Menu';
import { field, primary, screenHead, secondary, section } from './common';
import { onNavTo } from '../nav';
import { icon } from '../components/icons';
import { picker } from '../components/picker';
import { qrSvg } from '../components/qr';
import { setRow, toggleSwitch } from '../components/rows';
import { confirmItsYou, mailOffText } from './accountLinks';
import { dropDetour, keepDetour } from './accountLinksModel';
import { emailDialog, emailModeOf } from './profile';
import { reacceptTerms } from './terms';
import { refreshAfter, refreshDue, refreshResume, refreshSent, refreshStart } from './nodesAdminModel';
import {
  COMMUNITY_CAPACITY_MAX,
  COMMUNITY_CHECKS,
  INSTALL_ERRORS,
  MINE_REFRESH_MS,
  PROBATION_CAPACITY_MAX,
  RESTART_LINE,
  UNINSTALL_LINES,
  acceptanceNeeded,
  annexHref,
  closedKeyOf,
  communityAsk,
  followMine,
  hasServersLink,
  hostRulesHref,
  hostingOpen,
  nodeFacts,
  ownRevocable,
  ownerActions,
  requirementsOf,
  serversLinkTarget,
  serversViewOf,
  withoutServersLink,
} from './serversModel';
import type { CommunityCheck, FollowStep, Requirement, ServersView } from './serversModel';
import { duration, language, t } from '../../i18n';
import type { Key } from '../../i18n';
import { formatPoints, regionName } from '../names';

const STATE_KEY: Readonly<Record<NodeStatus, Key>> = {
  pending: 'nodesShared.state.pending',
  probation: 'nodesShared.state.probation',
  active: 'nodesShared.state.active',
  suspended: 'nodesShared.state.suspended',
  banned: 'nodesShared.state.banned',
};

/** A tag's class by tone (nodes.css): active ok, on trial warn, pending muted, suspended or banned bad. */
const TONE_TAG: Readonly<Record<Tone, string>> = { ok: 'mn-tag.mn-tag-live', warn: 'mn-tag.mn-tag-warn', muted: 'mn-tag', bad: 'mn-tag.mn-tag-bad' };
const tag = (tone: Tone, text: string): HTMLElement => h(`span.${TONE_TAG[tone]}` as 'span', null, text);

/** A read-only block the arrows (and Tab) stop on (nodesAdmin.ts readOnly: the panel's rule, its ring inside it). */
const readOnly = (key: string): Record<string, unknown> => ({ class: 'mn-na-read', 'data-nav': true, tabindex: '0', 'data-key': key });

/** One line of facts: a label and its value (a server's text as a text child). */
const fact = (label: string, ...value: Child[]): Child[] => [h('dt', null, label), h('dd', null, ...value)];

const regionLabel = (id: string): string => (isRegion(id) ? regionName(id) : id);
const when = (ms: number): string => new Date(ms).toLocaleString(language(), { dateStyle: 'short', timeStyle: 'short' });
const ago = (ms: number, now: number): string => t('nodesAdmin.ago', { time: duration(Math.max(0, now - ms)) });

/** The community guide (the nodes' README, in Spanish for Spanish). */
const guideUrl = (): string => `${SOURCE_URL}/blob/main/nodes/${language() === 'es' ? 'README.es.md' : 'README.md'}`;

/**
 * A link that opens in a new tab. Never drawn on a TV (a remote's press there may never come back to
 * the game): the screen shows a QR (guide) or a read-only line instead; were one drawn, this tab.
 */
const outLink =(href: string, text: string, key: string, cls = 'mn-btn.mn-prof-link'): HTMLAnchorElement =>
  h(`a.${cls}` as 'a', { href, target: document.documentElement.classList.contains('tg-tv') ? undefined : '_blank', rel: 'noopener', 'data-nav': true, 'data-key': key }, text);

/** A refusal's code as AccountClient hands it ('network' for a request that never got an answer). */
const codeOf = (e: unknown): string => (e instanceof AccountError ? (e.code === 'http' ? 'internal' : e.code) : 'network');

/** A refusal in the screen's words, by its code (src/net/nodes.ts); the code itself to the console. */
function errText(e: unknown): string {
  const code = codeOf(e);
  if (e instanceof AccountError) console.warn(`servers: answered ${e.status} ${e.code}`);
  else console.warn('servers:', e);
  if (code === 'account_too_new' && e instanceof AccountError && e.detail.daysLeft !== undefined) return t('servers.req.account_too_new', { count: e.detail.daysLeft });
  return t(nodeErrorKey(code));
}

/** The add flow as it stands: kept through Back, a password sheet and the refresh until LISTO or another account. */
interface Wizard {
  step: 'form' | 'checklist' | 'token';
  form: TokenForm;
  checks: Set<CommunityCheck>;
  adult: boolean;
  token: { id: string; line: string; ask: TokenAsk; expiresAt: number; lineOk: boolean } | null;
}

/** Sample kinds (window.__servers, scripts/ui-fit.mjs): the views and the add flow's steps. */
type SampleKind = 'closed' | 'requirements' | 'terms' | 'operator' | 'token' | 'tv' | 'project' | 'guest';

/** `window.__servers` exists in development and in a VITE_UI_FIT=1 build only (scripts/ui-fit.mjs). */
const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';
/** The sample window.__servers asked for (null: the real screen), and the screen's redraw once it is built. */
let sampleWanted: SampleKind | null = null;
let redraw: (() => void) | null = null;

/**
 * window.__servers(kind | null): "Mis servidores" with sample data (a sample draws whatever GET
 * /api/config says, so the layout check sees every view of a dark build); nothing in a release build.
 * Installed at the Game's start (the screen itself is built on its first open).
 */
export function installServersSample(menu: Menu): void {
  if (!UI_FIT) return;
  (window as unknown as { __servers: (kind: SampleKind | null) => void }).__servers = (kind) => {
    sampleWanted = kind;
    if (menu.visible && menu.top()?.id === 'servers' && redraw !== null) redraw();
    else if (kind !== null) menu.open('servers');
  };
}

export function serversScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const html = document.documentElement;
  const status = h('div.mn-na-status');
  const body = h('div.mn-na-body');
  const el = h('div.mn-na.mn-srv', { 'data-tablero': true }, screenHead(t('servers.title')), status, body);

  let mine: { who: string; answer: MineAnswer } | null = null;
  let problem: { failure: NodeFailure; code: string } | null = null;
  let clock = refreshStart(0);
  let gen = 0;
  let wiz: Wizard | null = null;
  let sample: { kind: SampleKind; answer: MineAnswer | null } | null = null;
  /** The public switch as pressed, until the server's answer settles it. */
  let showPick: boolean | null = null;
  /** GET /api/config's auth (AccountClient.authConfig: one read a page, PERFIL's), null until it comes: meanwhile mail is taken to go, as PERFIL does. */
  let authCfg: AuthConfig | null = null;
  const mailOn = (): boolean => authCfg?.email !== false;
  /** SIGN IN opened PERFIL: a sign-in there comes back here. */
  let waitSignIn = false;
  /** The view drawn last (a change rebuilds the body; a refresh of the same one repaints its parts). */
  let drawn: ServersView | null = null;
  /** The host view's parts, repainted on their own so a refresh never touches the form under the player's fingers. */
  const parts = {
    frozen: h('div.mn-srv-frozen'),
    add: h('div.mn-srv-add'),
    nodes: h('div.mn-na-rows'),
    codes: h('div.mn-na-rows'),
    points: h('div.mn-srv-points'),
    pub: h('div.mn-srv-public'),
  };
  /** The token step's follow-up and the form's limits line, repainted by the refresh and the tick. */
  let followEl: HTMLElement | null = null;
  let limitsEl: HTMLElement | null = null;

  const tv = (): boolean => sample?.kind === 'tv' || acc.account?.tv === true || html.classList.contains('tg-tv');
  const answer = (): MineAnswer | null => (sample !== null ? sample.answer : mine !== null && mine.who === (acc.account?.playerId ?? '') ? mine.answer : null);
  const open = (): boolean => sample !== null || hostingOpen(menu.cfg);
  const signedIn = (): boolean => (sample !== null ? sample.kind !== 'guest' : acc.signedIn);
  const viewNow = (): ServersView => serversViewOf({ open: open(), signedIn: signedIn(), mine: answer(), failed: problem !== null });

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

  /** Rebuild `box` only when what it shows changed (`key`): a focused field inside it keeps its text and focus. */
  const draw = (box: HTMLElement, key: string, build: () => Child[]): void => {
    if (box.dataset.drawn === key) return;
    box.dataset.drawn = key;
    setChildren(box, ...build());
  };

  // ---- GET /nodes/mine, every MINE_REFRESH_MS -------------------------------------------------------

  const load = async (): Promise<void> => {
    const who = acc.account?.playerId ?? null;
    if (who === null || !hostingOpen(menu.cfg)) return; // dark: nothing is asked
    const g = ++gen;
    clock = refreshSent(clock);
    try {
      const m = await acc.nodesMine();
      if (g !== gen || who !== (acc.account?.playerId ?? null)) return;
      mine = { who, answer: m };
      problem = null;
      clock = refreshAfter(clock, Date.now(), 'ok', 0, MINE_REFRESH_MS);
    } catch (e) {
      if (g !== gen) return;
      const failure = nodeFailure(e instanceof AccountError ? e : null);
      problem = { failure, code: codeOf(e) };
      // /nodes/mine asks no freshness: a reauth here is the server's trouble, retried like any failure.
      clock = refreshAfter(clock, Date.now(), failure === 'reauth' ? 'fail' : failure, e instanceof AccountError ? e.retryAfterMs : 0, MINE_REFRESH_MS);
      errText(e);
    }
    if (el.isConnected) paint();
  };

  /** The account's wallet as the garage read it last (GET /api/me/shop), read once more when it has none yet. */
  const wallet = (): { balance: number; frozen: string | null } | null => {
    if (sample !== null) return sample.kind === 'operator' ? { balance: 1800, frozen: null } : sample.kind === 'token' ? { balance: 600, frozen: 'verification_failed:' + 'c'.repeat(64) } : null;
    const w = menu.host.garage.store.shop?.wallet ?? null;
    return w !== null ? { balance: w.balance, frozen: w.frozen } : null;
  };

  // ---- the lines above the view -------------------------------------------------------------------------

  const paintStatus = (): void => {
    const p = problem;
    const line = (text: string): HTMLElement => h('div.mn-na-alert', null, icon('warning'), h('p', null, text));
    if (sample !== null || p === null || answer() === null) return setChildren(status);
    if (p.failure === 'paused') return setChildren(status, line(t('nodesShared.err.nodes_off')));
    setChildren(status, line(t(nodeErrorKey(p.code))));
  };

  // ---- the views other than a host's -------------------------------------------------------------------

  const signIn = (): void => {
    waitSignIn = true;
    // Kept across a provider's round trip too (accountLinksModel.ts keepDetour): the sign-in comes back here.
    keepDetour({ screen: 'servers' });
    menu.open('profile', false, undefined, true);
  };

  /** The guide: a link to it, or on a TV its QR (a phone opens it). */
  const guide = (): HTMLElement => {
    const url = guideUrl();
    if (!tv()) return h('div.mn-na-tools', null, outLink(url, t('profile.hostServer'), 'srv-guide'));
    return h('div.mn-gar-guide', readOnly('srv-guide-qr'), qrSvg(url, t('profile.hostServer')), h('div.mn-gar-guide-text', null, h('p', null, t('profile.hostServer')), h('p.mn-gar-redeem-note', null, t('garage.guideScan'))));
  };

  const guestView = (): Child[] => [h('p.mn-note', null, t('servers.signIn')), h('div.mn-na-tools', null, primary(t('garage.signIn'), signIn, { 'data-key': 'srv-signin', 'data-autofocus': true }))];

  /**
   * Open, but not for this account: during a canary, only invited people may register a server
   * (Terms 12.1.2); open to everyone (the reads of the flag apart for a minute, or the server's read
   * failed) or anything else, a neutral line and a retry (closedKeyOf). A sample shows the canary's.
   */
  const closedView = (): Child[] => {
    const key = closedKeyOf(sample !== null ? 'canary' : menu.cfg?.hosting?.stage);
    return [
      h('div.mn-prof-node', readOnly('srv-closed'), h('div.mn-prof-node-head', null, icon('server', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, t('servers.closedTitle'))), h('p', null, t(key)), h('p.mn-note', null, t('servers.what'))),
      key === 'servers.closedNow' ? h('div.mn-na-tools', null, secondary(t('garage.retry'), () => ((clock = refreshResume(clock, Date.now())), void load()), { 'data-key': 'srv-retry' })) : null,
      guide(),
    ];
  };

  const projectView = (m: MineAnswer): Child[] => [
    h('p.mn-note', null, t('servers.project')),
    acc.me?.maintainer !== undefined && !tv() ? h('div.mn-na-tools', null, secondary(t('nodesAdmin.entry'), () => menu.open('nodes-admin'), { 'data-key': 'srv-panel' })) : null,
    h('div.mn-na-rows', null, ...m.nodes.map((n) => nodeCard(m, n, false))),
  ];

  // ---- a host's: the wallet's pause ---------------------------------------------------------------------

  const paintFrozen = (): void => {
    const w = wallet();
    draw(parts.frozen, w?.frozen ?? '', () =>
      w?.frozen
        ? [h('div.mn-na-alert', readOnly('srv-frozen'), icon('warning'), h('div', null, h('p', null, h('b', null, t('servers.frozenTitle'))), h('p', null, h('code.mn-na-raw', null, w.frozen)), h('p', null, t('servers.frozenNote'))))]
        : [],
    );
  };

  // ---- a host's: AGREGAR UN SERVIDOR -------------------------------------------------------------------

  /** What a requirement needs done, and its button when the game can do it from here. */
  const requirementLine = (r: Requirement, m: MineAnswer): HTMLElement => {
    const text = r === 'account_too_new' ? t('servers.req.account_too_new', { count: m.requirements?.daysLeft ?? 7 }) : t(`servers.req.${r}` as Key);
    const me = acc.me;
    const mode = emailModeOf(me);
    const inSample = (go: () => void) => (): void => (sample !== null ? menu.toast(t('nodesAdmin.done'), 'ok') : go());
    // The email: PERFIL's own dialog (profile.ts emailDialog, never a copy), while mail goes; with the
    // mail off (GET /api/config auth.email false), PERFIL's line instead: its code could never arrive.
    // The terms in force: their re-accept sheet.
    const mailOff = r === 'email_required' && sample === null && !mailOn();
    const button =
      r === 'email_required' && !mailOff
        ? secondary(t(mode === 'confirm' ? 'profile.emailConfirmBtn' : 'profile.emailAddBtn'), inSample(() => emailDialog(menu, mode === 'change' ? 'add' : mode)), { 'data-key': 'srv-req-email' })
        : r === 'terms_required'
          ? secondary(t('servers.termsBtn'), inSample(() => void reacceptTerms(menu).then(() => ((clock = refreshResume(clock, Date.now())), void acc.fetchMe().catch(() => undefined)), () => undefined)), { 'data-key': 'srv-req-terms' })
          : null;
    return h('div.mn-prof-device', null, h('p', button === null ? readOnly('srv-req-' + r) : null, icon(r === 'operator_blocked' ? 'lock' : 'warning'), ' ', text), button, mailOff ? h('p.mn-note', null, mailOffText(menu)) : null);
  };

  const regionSheet = (w: Wizard, set: () => void): void => {
    const close = menu.modal({
      title: t('servers.region'),
      body: [
        h('p.mn-note', null, t('servers.regionNote')),
        h(
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
              { 'data-key': 'srv-region-' + r.id, 'aria-pressed': String(w.form.region === r.id), 'data-autofocus': w.form.region === r.id ? true : undefined },
            ),
          ),
        ),
      ],
      actions: [{ label: t('profile.cancel'), onClick: () => true }],
    });
  };

  /** "Códigos hoy: te quedan 2 · Sin usar: 1 de 2 · Servidores: 1 de 3" (the server's caps, Terms 12.2.3: the screen says how many are left). */
  const limitsText = (m: MineAnswer | null): string => {
    const l = m?.limits;
    if (l === undefined || l.tokensLeftToday === null || l.maxOutstanding === null) return '';
    return t('servers.limits', { left: l.tokensLeftToday, outstanding: l.outstanding, maxOutstanding: l.maxOutstanding, nodes: l.nodes, maxNodes: l.maxNodes });
  };
  const paintLimits = (): void => {
    if (limitsEl !== null) setChildren(limitsEl, limitsText(answer()));
  };

  const formStep = (w: Wizard): HTMLElement[] => {
    const f = w.form;
    const region = picker('srv-region', 'globe', t('servers.region'), () => regionSheet(w, () => region.set(f.region !== null ? regionName(f.region) : '—')));
    region.set(f.region !== null ? regionName(f.region) : '—');
    const name = field(t('servers.name'), { maxLength: 32, value: f.name, keypad: 'text', enterkeyhint: 'next', hint: t('servers.nameHint') });
    const host = field(t('servers.host'), { maxLength: 253, value: f.host, keypad: 'email', inputmode: 'email', enterkeyhint: 'next', hint: t('servers.hostHint') });
    const matches = field(t('servers.matches'), { maxLength: 4, value: f.matches, keypad: 'text', enterkeyhint: 'next', hint: t('servers.matchesHint', { probation: PROBATION_CAPACITY_MAX, active: COMMUNITY_CAPACITY_MAX }) });
    const egress = field(t('servers.egress'), { maxLength: 7, value: f.egress, keypad: 'digits', inputmode: 'numeric', enterkeyhint: 'done', hint: t('servers.egressHint') });
    name.input.addEventListener('input', () => (f.name = name.input.value));
    host.input.addEventListener('input', () => (f.host = host.input.value));
    matches.input.addEventListener('input', () => (f.matches = matches.input.value));
    egress.input.addEventListener('input', () => (f.egress = egress.input.value));
    const regionErr = h('p.mn-field-error', { hidden: true });
    limitsEl = h('p.mn-note', null, limitsText(answer()));
    const next = (): void => {
      for (const x of [name, host, matches, egress]) x.error(null);
      regionErr.hidden = true;
      const l = answer()?.limits;
      const issues = tokenFormIssues(f, l !== undefined ? { used: l.nodes, max: l.maxNodes } : null, true);
      for (const i of issues) {
        if (i.field === 'region') ((regionErr.hidden = false), (regionErr.textContent = t('nodesAdmin.wiz.badRegion')));
        if (i.field === 'name') name.error(t('nodesAdmin.wiz.badName'));
        if (i.field === 'host') host.error(t(`nodesShared.host.${i.host ?? 'bad'}` as Key));
        if (i.field === 'matches') matches.error(t('nodesAdmin.wiz.badMatches', { max: MAX_CAPACITY }));
        if (i.field === 'egress') egress.error(t('nodesAdmin.wiz.badEgress'));
        if (i.field === 'slots') menu.toast(t('nodesShared.err.too_many_nodes'), 'error');
      }
      if (issues.length > 0) return;
      w.step = 'checklist';
      paintAdd(true);
    };
    return [
      h('p.mn-note', null, t('servers.formNote')),
      h('form.mn-form.mn-na-form', { onsubmit: (e: Event) => e.preventDefault() }, region.el, regionErr, name.el, host.el, matches.el, egress.el, h('p.mn-note', readOnly('srv-fixed'), t('servers.fixed')), limitsEl, primary(t('nodesAdmin.wiz.next'), next, { 'data-key': 'srv-next' })),
    ];
  };

  /** The acceptance line above PEDIR CÓDIGO (PR 2A's string verbatim), its {rules}, {annex} and {privacy} as links to the texts in force. */
  const acceptLine = (button: string): HTMLElement => {
    const lang = language();
    const out: Child[] = [];
    for (const part of t('servers.acceptLine', { button }).split(/(\{rules\}|\{annex\}|\{privacy\})/)) {
      if (part === '{rules}') out.push(outLink(hostRulesHref(lang), t('servers.acceptRules'), 'srv-rules', 'mn-legal-link'));
      else if (part === '{annex}') out.push(outLink(annexHref(lang), t('servers.acceptAnnex'), 'srv-annex', 'mn-legal-link'));
      else if (part === '{privacy}') out.push(outLink(legalPaths(lang).privacy, t('legal.privacyLink'), 'srv-privacy', 'mn-legal-link'));
      else if (part !== '') out.push(part);
    }
    return h('p.mn-note.mn-legal-notice', null, ...out);
  };

  const checklistStep = (w: Wizard): HTMLElement[] => {
    const m = answer();
    const needed = acceptanceNeeded(m);
    const items = COMMUNITY_CHECKS.map((l) =>
      navButton(
        'mn-na-check',
        [icon(w.checks.has(l) ? 'check' : 'next'), h('span', null, t(`servers.check.${l}` as Key))],
        () => {
          if (w.checks.has(l)) w.checks.delete(l);
          else w.checks.add(l);
          keepFocus(() => paintAdd(true));
        },
        { 'data-key': 'srv-check-' + l, 'aria-pressed': String(w.checks.has(l)) },
      ),
    );
    const adultErr = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
    const adult = toggleSwitch('srv-adult', t('servers.adult'), () => w.adult, (v) => {
      w.adult = v;
      adultErr.hidden = true;
    });
    const button = t('servers.getCode');
    const go = (): void => {
      if (!COMMUNITY_CHECKS.every((l) => w.checks.has(l))) return menu.toast(t('nodesAdmin.wiz.tickAll'), 'error');
      if (needed && !w.adult) {
        adultErr.textContent = t('nodesShared.err.adult_required');
        adultErr.hidden = false;
        return;
      }
      void mint(w);
    };
    return [
      h('p.mn-note', null, t('servers.checkNote')),
      h('div.mn-na-checks', null, ...items),
      // The acceptance (PR 2A): the summary, the switch and the line right above the button, in this order.
      ...(needed ? [h('p', readOnly('srv-accept-summary'), t('servers.acceptSummary')), setRow(t('servers.adult'), adult.el, t('servers.adultHint')), adultErr, acceptLine(button)] : []),
      h('div.mn-na-actions', null, primary(button, go, { 'data-key': 'srv-get-code' }), secondary(t('nodesAdmin.wiz.edit'), () => ((w.step = 'form'), paintAdd(true)), { 'data-key': 'srv-edit' })),
    ];
  };

  /** The code (POST /nodes/tokens): the server's install line, its short id (the start of its hash, as /nodes/mine lists it). */
  const mint = async (w: Wizard): Promise<void> => {
    const m = answer();
    const needed = acceptanceNeeded(m);
    const ask = communityAsk(w.form, { needed, adult: w.adult });
    if (sample !== null) {
      menu.toast(t('nodesAdmin.done'), 'ok');
      return;
    }
    try {
      const r = await acc.nodesToken(ask);
      const id = (await sha256Hex(r.token)).slice(0, 12);
      w.token = { id, line: r.install.linux, ask, expiresAt: r.expiresAt, lineOk: installLineMatches(r.install.linux, ask) };
      w.step = 'token';
      // The acceptance is written with the code: the server says so on its next answer, asked now.
      clock = refreshResume(clock, Date.now());
    } catch (e) {
      const code = codeOf(e);
      // "Confirm it's you" (decision 7): the password or a mailed code, then the same request again. The 403 decides.
      if (code === 'reauth_required' || code === 'password_required') return confirmItsYou(menu, () => void mint(w), 2, true);
      if (code === 'terms_required' && e instanceof AccountError) {
        // The general terms first (their re-accept sheet), else the rules for hosts: the acceptance step again.
        if (e.detail.version !== undefined && acc.me?.terms !== e.detail.version) {
          void reacceptTerms(menu).then(() => void mint(w), () => undefined);
          return;
        }
        if (mine !== null && mine.answer.terms) mine = { ...mine, answer: { ...mine.answer, terms: { ...mine.answer.terms, accepted: false } } };
      }
      menu.toast(errText(e), 'error');
      if (code.startsWith('bad_') || code === 'name_taken' || code === 'verify_reserved' || code === 'too_many_nodes') w.step = 'form';
      if (code === 'tv_session' || code === 'hosting_closed' || code === 'operator_blocked' || code.endsWith('_required') || code === 'account_too_new' || code === 'deletion_pending') clock = refreshResume(clock, Date.now());
    }
    if (el.isConnected) paintAdd(true);
  };

  /** The follow-up of the code and its server (each refresh), and its countdown (each tick). */
  const paintFollow = (): void => {
    const w = wiz;
    if (followEl === null || w === null || w.token === null) return;
    const now = Date.now();
    const left = Math.max(0, Math.ceil((w.token.expiresAt - now) / 60_000));
    const f = followMine(answer(), w.token.id, now);
    const step: FollowStep = f.step === 'waiting' && left === 0 ? 'expired' : f.step;
    const lines: Child[] = [
      h('p.mn-na-follow', { 'data-step': step }, icon(step === 'active' || step === 'probation' ? 'check' : step === 'expired' || step === 'revoked' || step === 'stopped' ? 'warning' : 'refresh'), h('span', null, t(`servers.follow.${step}` as Key, { name: f.node?.name ?? w.token.ask.name ?? '', count: f.node?.counters.probationVerified ?? 0, total: f.node?.needed ?? 20 }))),
    ];
    if (step === 'waiting') lines.push(h('p.mn-note', null, t('nodesShared.expiresIn', { minutes: left }), ' · ', t('nodesShared.oneUse')));
    const probe = f.node?.lastProbe ?? null;
    if (step === 'pending' && probe !== null && !probe.ok) {
      const hint = probeHint(probe.error);
      lines.push(h('p', null, h('code.mn-na-raw', null, probe.error ?? '')), h('p.mn-note', null, t(hint !== null ? (`nodesShared.hint.${hint}` as Key) : 'nodesShared.hint.unknown')));
    }
    if (step === 'stopped' && f.node?.statusReason) lines.push(h('p', null, h('code.mn-na-raw', null, f.node.statusReason)));
    if (step === 'expired' || step === 'gone') lines.push(h('p.mn-note', null, t('servers.expiredHelp')), ...INSTALL_ERRORS.map((c) => h('p.mn-note', null, h('b', null, t(nodeErrorKey(c))), ' ', t(`servers.fix.${c}` as Key))));
    setChildren(followEl, ...lines);
  };

  const tokenStep = (w: Wizard): HTMLElement[] => {
    const tk = w.token;
    if (tk === null) return [];
    followEl = h('div.mn-na-followbox', { 'aria-live': 'polite' });
    paintFollow();
    const line = h('div.mn-cmd', readOnly('srv-cmd'), tk.line);
    const copy = secondary(t('nodesShared.copy'), () => void copyText(tk.line).then((ok) => menu.toast(t(ok ? 'nodesShared.copied' : 'nodesShared.copyFailed'), ok ? 'ok' : 'error')), { 'data-key': 'srv-copy', 'data-autofocus': true });
    onNavTo(line, 'down', () => copy);
    const cmd = tk.lineOk ? h('div.mn-na-cmdbox', null, line, copy) : h('p.mn-field-error', null, t('nodesAdmin.wiz.badLine'));
    limitsEl = h('p.mn-note', null, limitsText(answer()));
    return [
      h('p.mn-note', null, t('servers.cmdTitle')),
      cmd,
      limitsEl,
      followEl,
      h(
        'div.mn-na-actions',
        null,
        secondary(t('servers.again'), () => ((w.step = 'form'), (w.token = null), (w.checks = new Set()), paintAdd(true)), { 'data-key': 'srv-again' }),
        secondary(t('servers.done'), () => ((wiz = null), paintAdd(true)), { 'data-key': 'srv-done' }),
      ),
    ];
  };

  const newWizard = (): Wizard => {
    const own = menu.regionId ?? (isRegion(menu.cfg?.autoRegion) ? (menu.cfg?.autoRegion as RegionId) : null);
    return { step: 'form', form: { region: own, name: '', host: '', roles: 'host', matches: 'auto', egress: '' }, checks: new Set(), adult: false, token: null };
  };

  /**
   * AGREGAR UN SERVIDOR: on a TV the QR to /#servers (nothing is added from a TV); what the account
   * lacks; else the add flow's step. Rebuilt only when its gate or step changes (`force`: a step of
   * its own), so the refresh never resets a field being typed in.
   */
  const paintAdd = (force = false): void => {
    const m = answer();
    if (m === null) return;
    const reqs = requirementsOf(m);
    const w = wiz;
    const key = `${tv()}|${reqs.join(',')}|${reqs.includes('email_required') ? mailOn() : ''}|${acceptanceNeeded(m)}|${w?.step ?? 'none'}|${w?.token?.id ?? ''}`;
    if (force) delete parts.add.dataset.drawn;
    draw(parts.add, key, (): Child[] => {
      // Rebuilt: the follow-up and the limits line are the new step's (formStep and tokenStep set them).
      followEl = null;
      limitsEl = null;
      if (tv()) {
        const url = `${typeof location !== 'undefined' ? location.origin : ''}/#servers`;
        return [h('div.mn-gar-guide', readOnly('srv-tv'), qrSvg(url, t('servers.title')), h('div.mn-gar-guide-text', null, h('p', null, t('nodesShared.tvNote')), h('p.mn-gar-redeem-note', null, t('servers.tvScan'))))];
      }
      if (reqs.length > 0) return [h('p.mn-note', null, t('servers.reqTitle')), ...reqs.map((r) => requirementLine(r, m))];
      if (w === null) return [h('p.mn-note', null, t('servers.addNote')), h('div.mn-na-tools', null, primary(t('servers.add'), () => ((wiz = newWizard()), paintAdd(true)), { 'data-key': 'srv-add' }))];
      return w.step === 'form' ? formStep(w) : w.step === 'checklist' ? checklistStep(w) : tokenStep(w);
    });
    if (force) {
      menu.refit();
      menu.refocus();
    }
  };

  // ---- a host's: TUS SERVIDORES -----------------------------------------------------------------------

  /** A server's card (its facts a stop of the arrows) and, but on a TV, its owner's actions under it. */
  const nodeCard = (m: MineAnswer, n: MineNode, actions = true): HTMLElement => {
    const now = Date.now();
    const f = nodeFacts(n, m.channel);
    const a = ownerActions(n, { tv: tv(), open: m.hosting?.open === true, blocked: requirementsOf(m).includes('operator_blocked') });
    const state = h('span.mn-prof-node-state', { 'data-ok': f.live ? 'true' : 'false' }, h('span.mn-dot'), t(STATE_KEY[n.status]), n.status === 'probation' ? ` · ${t('servers.probation', { count: f.probation.verified, total: f.probation.needed })}` : '', n.online ? '' : ` · ${t('profile.nodeOffline')}`);
    const probe = n.lastProbe ?? null;
    const hint = n.status === 'pending' && probe !== null && !probe.ok ? probeHint(probe.error) : null;
    const points = m.rewards?.byNode[n.nodeId];
    const card = h(
      'div.mn-prof-node',
      readOnly('srv-node-' + n.nodeId),
      h('div.mn-prof-node-head', null, icon('server', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, n.name), h('span.mn-prof-node-region', null, regionLabel(n.region)), tag(statusTone(n.status), t(STATE_KEY[n.status]))),
      state,
      n.statusReason !== null && (n.status === 'suspended' || n.status === 'banned') ? h('p.mn-prof-node-reason', null, n.statusReason) : null,
      n.status === 'pending' && probe !== null && !probe.ok ? h('p', null, h('code.mn-na-raw', null, probe.error ?? ''), ' ', t(hint !== null ? (`nodesShared.hint.${hint}` as Key) : 'nodesShared.hint.unknown')) : null,
      h(
        'dl.mn-prof-node-facts',
        null,
        ...fact(t('servers.fact.load'), `${f.load.active}/${f.load.capacity}`),
        ...fact(t('servers.fact.lag'), `${Math.round(f.lagMs)} ms`),
        ...fact(t('servers.fact.egress'), f.egress.cap !== null ? `${f.egress.used}/${f.egress.cap} GB` : `${f.egress.used} GB`),
        ...fact(t('servers.fact.version'), n.version, ' · ', t(f.version === 'compatible' ? 'servers.compatible' : 'servers.update')),
        ...fact(t('servers.fact.seen'), f.seen === 'now' ? t('nodesAdmin.seenNow') : f.seen !== null ? ago(f.seen, now) : '—'),
        ...fact(t('servers.fact.strikes'), t('servers.strikes', { count: f.strikes.count, max: f.strikes.max, days: f.strikes.windowDays })),
        ...fact(t('servers.fact.refused'), `${Math.round(f.refusalRate * 100)} %`, f.outUntil !== null && f.outUntil > now ? ` · ${t('servers.outUntil', { time: when(f.outUntil) })}` : ''),
        ...(n.suspendedUntil !== null ? fact(t('nodesAdmin.detail.until'), when(n.suspendedUntil)) : []),
        ...(points !== undefined ? fact(t('servers.fact.points'), t('servers.pointsOf', { points: formatPoints(points.points), matches: points.matches })) : []),
      ),
    );
    if (!actions || (!a.drain && !a.rename && !a.retire)) return card;
    return h(
      'div',
      null,
      card,
      h(
        'div.mn-na-actions',
        null,
        a.drain ? secondary(t('servers.drain'), () => drainSheet(n), { 'data-key': 'srv-drain-' + n.nodeId }) : null,
        a.rename ? secondary(t('servers.rename'), () => renameSheet(n), { 'data-key': 'srv-rename-' + n.nodeId }) : null,
        a.retire ? secondary(t('servers.retire'), () => retireSheet(n), { 'data-key': 'srv-retire-' + n.nodeId, class: 'mn-btn-cancel' }) : null,
      ),
    );
  };

  /** An owner's POST: the answer, or the refusal said (a refusal keeps its sheet up). */
  const own = async (run: () => Promise<unknown>, done: (r: unknown) => void): Promise<boolean> => {
    if (sample !== null) {
      menu.toast(t('nodesAdmin.done'), 'ok');
      return true;
    }
    try {
      done(await run());
      clock = refreshResume(clock, Date.now()); // /nodes/mine at once: the change shows
      return true;
    } catch (e) {
      menu.toast(errText(e), 'error');
      return false;
    }
  };

  /** DRENAR: one-way (a drain the control plane asked for has no way back from here), its way back on the machine. */
  const drainSheet = (n: MineNode): void => {
    menu.modal({
      title: t('servers.drainTitle', { name: n.name }),
      body: [h('p.mn-note', null, t('servers.drainNote')), h('div.mn-cmd', readOnly('srv-restart'), RESTART_LINE)],
      actions: [
        { label: t('servers.drain'), danger: true, onClick: () => own(() => acc.nodesMineAction('drain', { nodeId: n.nodeId }), () => menu.toast(t('servers.drained'), 'ok')) },
        { label: t('profile.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  /** RENOMBRAR: a --name's characters, free in its region and never a project server's (the server says name_taken). */
  const renameSheet = (n: MineNode): void => {
    const name = field(t('servers.newName'), { maxLength: 32, value: n.name, keypad: 'text', enterkeyhint: 'done', hint: t('servers.renameNote') });
    name.input.setAttribute('data-autofocus', '');
    menu.modal({
      title: t('servers.renameTitle', { name: n.name }),
      body: name.el,
      actions: [
        {
          label: t('servers.rename'),
          primary: true,
          onClick: async () => {
            name.error(null);
            const v = name.input.value.trim();
            if (!NODE_NAME_RE.test(v)) {
              name.error(t('nodesAdmin.wiz.badName'));
              return false;
            }
            return own(() => acc.nodesMineAction('rename', { nodeId: n.nodeId, name: v }), () => menu.toast(t('servers.renamed', { name: v }), 'ok'));
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };

  /** RETIRAR: the server's name, MANTÉN PARA CONFIRMAR (as GARAJE's redeem), then how to take the program off the machine. */
  const retireSheet = (n: MineNode): void => {
    menu.modal({
      title: t('servers.retireTitle', { name: n.name }),
      body: h('p.mn-note', null, t('servers.retireNote')),
      actions: [
        { label: t('profile.cancel'), autofocus: true, onClick: () => true },
        {
          label: t('garage.hold'),
          primary: true,
          hold: { ms: 700, held: () => menu.host.acceptHeld?.() ?? false },
          onClick: async () => {
            const ok = await own(() => acc.nodesMineAction('retire', { nodeId: n.nodeId }), () => undefined);
            if (ok) queueMicrotask(() => retiredSheet(n.name));
            return ok;
          },
        },
      ],
    });
  };

  const retiredSheet = (name: string): void => {
    menu.modal({
      title: t('servers.retiredTitle', { name }),
      body: [h('p.mn-note', null, t('servers.retired')), ...UNINSTALL_LINES.map((l, i) => h('div.mn-cmd', readOnly('srv-uninstall-' + i), l))],
      actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }],
    });
  };

  const paintNodes = (m: MineAnswer): void => {
    keepFocus(() => setChildren(parts.nodes, ...(m.nodes.length > 0 ? m.nodes.map((n) => nodeCard(m, n)) : [h('p.mn-note', readOnly('srv-no-nodes'), t('servers.noNodes'))])));
  };

  // ---- a host's: TUS CÓDIGOS, PUNTOS, the public list ---------------------------------------------------

  const paintCodes = (m: MineAnswer): void => {
    const now = Date.now();
    const STATE_TONE: Record<MineToken['state'], Tone> = { unused: 'warn', used: 'ok', expired: 'muted', revoked: 'bad' };
    const rows = (m.tokens ?? []).map((tk) =>
      h(
        'div.mn-na-token',
        ownRevocable(tk, now) && !tv() ? { 'data-key': 'srv-token-' + tk.id } : readOnly('srv-token-' + tk.id),
        h('code', null, tk.id),
        h('b', null, tk.name ?? '—'),
        h('span', null, regionLabel(tk.region)),
        tag(STATE_TONE[tk.state] ?? 'muted', t(`nodesAdmin.token.${tk.state}` as Key)),
        h('span', null, tk.publicHost ?? ''),
        h('small', null, tk.state === 'unused' ? t('nodesShared.expiresIn', { minutes: Math.max(0, Math.ceil((tk.expiresAt - now) / 60_000)) }) : when(tk.createdAt)),
        ownRevocable(tk, now) && !tv()
          ? secondary(t('nodesAdmin.act.revoke'), () => void own(() => acc.nodesRevokeOwn(tk.id), () => menu.toast(t('servers.revoked'), 'ok')), { 'data-key': 'srv-revoke-' + tk.id })
          : null,
      ),
    );
    keepFocus(() => setChildren(parts.codes, ...(rows.length > 0 ? rows : [h('p.mn-note', readOnly('srv-no-codes'), t('servers.noCodes'))])));
  };

  const kpi = (value: string, label: string, sub?: string): HTMLElement => h('div.mn-kpi', null, h('b', null, value), h('span', null, label), sub ? h('small', null, sub) : null);

  /** Today's points against the cap (Terms 12.5.3), 30 days, all time (the operator's), and the account's balance with CANJEAR EN GARAJE. */
  const paintPoints = (m: MineAnswer): void => {
    const r = m.rewards;
    const w = wallet();
    const today = r?.pointsToday ?? 0;
    const cap = r?.capToday ?? null;
    setChildren(
      parts.points,
      h(
        'div.mn-kpis',
        readOnly('srv-points'),
        kpi(cap !== null ? `${formatPoints(today)}/${formatPoints(cap)}` : formatPoints(today), t('servers.kpi.today'), cap !== null ? t('servers.kpi.cap') : undefined),
        kpi(formatPoints(r?.points30d ?? 0), t('servers.kpi.d30'), t('servers.kpi.matches', { count: r?.matches30d ?? 0 })),
        kpi(formatPoints(r?.earned ?? 0), t('servers.kpi.earned')),
        kpi(w !== null ? formatPoints(w.balance) : '—', t('servers.kpi.balance'), w?.frozen ? t('garage.needFrozen') : undefined),
      ),
      h('div.mn-na-tools', null, secondary(t('servers.garage'), () => menu.open('garage'), { 'data-key': 'srv-garage' })),
    );
  };

  /** The operator's name in the public list (its consent, A14; "Anfitrión" and a number otherwise), withdrawn with the same switch; never from a TV. */
  const paintPublic = (m: MineAnswer): void => {
    draw(parts.pub, `${tv()}`, () => {
      if (tv()) return [h('p.mn-note', readOnly('srv-public-tv'), t(m.showPublic === true ? 'servers.publicOn' : 'servers.publicOff'))];
      const sw = toggleSwitch('srv-public', t('servers.publicLabel'), () => showPick ?? answer()?.showPublic === true, (on) => {
        showPick = on;
        if (sample !== null) return;
        void acc.nodesShowPublic(on).then(
          (v) => {
            showPick = null;
            if (mine !== null) mine = { ...mine, answer: { ...mine.answer, showPublic: v } };
            sw.refresh();
          },
          (e: unknown) => {
            showPick = null;
            sw.refresh();
            menu.toast(errText(e), 'error');
          },
        );
      });
      publicSwitch = sw;
      return [setRow(t('servers.publicLabel'), sw.el, t('servers.publicHelp'))];
    });
    publicSwitch?.refresh();
  };
  let publicSwitch: { refresh(): void } | null = null;

  /**
   * The short help (B5): the states, what reaches the server, why few, how points are counted, the
   * players' data, then the rules for hosts and the guide; on a TV no link (a remote's press would
   * take the game's tab away): where the rules are, read-only, and the guide's QR.
   */
  const helpView = (): HTMLElement =>
    section(
      t('servers.helpTitle'),
      ...(['states', 'what', 'few', 'points', 'data'] as const).map((k) => h('p', readOnly('srv-help-' + k), t(`servers.help.${k}` as Key))),
      tv()
        ? h('p.mn-note', readOnly('srv-help-rules'), t('servers.helpRulesTv'))
        : h('div.mn-na-tools', null, outLink(hostRulesHref(language()), t('servers.helpRules'), 'srv-help-rules'), outLink(guideUrl(), t('profile.hostServer'), 'srv-help-guide')),
      tv() ? guide() : null,
    );

  const hostView = (): Child[] => [
    parts.frozen,
    section(t('servers.addTitle'), parts.add),
    section(t('servers.mineTitle'), parts.nodes),
    section(t('servers.codesTitle'), parts.codes),
    section(t('servers.pointsTitle'), parts.points),
    section(t('servers.publicTitle'), parts.pub),
    helpView(),
  ];

  // ---- painting -----------------------------------------------------------------------------------------

  const paint = (): void => {
    const v = viewNow();
    paintStatus();
    if (v !== drawn) {
      drawn = v;
      for (const p of Object.values(parts)) delete p.dataset.drawn;
      const m = answer();
      const content: Child[] =
        v === 'dark'
          ? []
          : v === 'guest'
            ? guestView()
            : v === 'loading'
              ? [h('p.mn-note', null, t('nodesAdmin.loading'))]
              : v === 'error'
                ? [h('p.mn-note', null, problem !== null ? t(nodeErrorKey(problem.code)) : ''), h('div.mn-na-tools', null, secondary(t('garage.retry'), () => ((clock = refreshResume(clock, Date.now())), void load()), { 'data-key': 'srv-retry' }))]
                : v === 'closed'
                  ? closedView()
                  : v === 'project' && m !== null
                    ? projectView(m)
                    : hostView();
      setChildren(body, ...content);
    } else if (v === 'project') {
      const m = answer();
      if (m !== null) keepFocus(() => setChildren(body, ...projectView(m)));
    }
    const m = answer();
    if (v === 'host' && m !== null) {
      paintFrozen();
      paintAdd();
      paintFollow();
      paintLimits();
      paintNodes(m);
      paintCodes(m);
      paintPoints(m);
      paintPublic(m);
    }
    menu.refit();
    menu.refocus();
  };

  // A session that changes under the screen (signed out, another account in another tab): nothing of the first stays.
  let owner = acc.account?.playerId ?? null;
  acc.subscribe(() => {
    const who = acc.account?.playerId ?? null;
    if (waitSignIn && acc.signedIn) {
      waitSignIn = false;
      dropDetour();
      if (menu.top()?.id === 'profile') menu.backTo('servers');
    }
    if (who === owner || sample !== null) return;
    owner = who;
    mine = null;
    wiz = null;
    problem = null;
    showPick = null;
    gen++;
    clock = refreshStart(Date.now());
    drawn = null;
    if (el.isConnected) paint();
  });

  /** window.__servers' sample as asked (installServersSample), applied on the next show or at once (redraw). */
  const applySample = (): void => {
    const kind = sampleWanted;
    if ((sample?.kind ?? null) === kind) return;
    sample = kind === null ? null : { kind, answer: sampleMine(kind) };
    drawn = null;
    wiz = null;
    if (kind === 'terms' || kind === 'token') {
      wiz = { step: kind === 'terms' ? 'checklist' : 'token', form: { region: 'SA', name: 'juan-vps-buenos-aires', host: 'srv1.example.com', roles: 'host', matches: 'auto', egress: '2000' }, checks: new Set(COMMUNITY_CHECKS), adult: false, token: null };
      if (kind === 'token') {
        const ask = communityAsk(wiz.form, { needed: false, adult: false });
        const line = 'curl -fsSL https://example.com/nodes/releases/install.sh | sudo bash -s -- --control https://example.com --token tgn1_SAMPLEsampleSAMPLEsampleSAMPLE00 --name juan-vps-buenos-aires --roles host --transport wss --public-host srv1.example.com --matches auto --egress-cap-gb 2000';
        wiz.token = { id: 'abcdef123456', line, ask, expiresAt: Date.now() + 52 * 60_000, lineOk: installLineMatches(line, ask) };
      }
    }
  };
  if (UI_FIT)
    redraw = () => {
      applySample();
      paint();
    };

  return {
    id: 'servers',
    title: t('servers.title'),
    el,
    show: () => {
      if (UI_FIT) applySample();
      waitSignIn = false;
      dropDetour();
      // Dark (decision 1): nothing new is drawn and nothing is asked; with the config read, back where the player was.
      if (sample === null && !hostingOpen(menu.cfg)) {
        drawn = 'dark';
        setChildren(status);
        setChildren(body);
        if (menu.cfg !== null) queueMicrotask(() => (menu.top()?.id === 'servers' ? menu.back() : undefined));
        return;
      }
      if ((acc.account?.playerId ?? null) !== owner && sample === null) {
        owner = acc.account?.playerId ?? null;
        mine = null;
        wiz = null;
      }
      drawn = null;
      gen++;
      clock = refreshStart(Date.now());
      // The balance (PUNTOS DE SERVIDOR): the garage's shop, read once when it has none.
      const g = menu.host.garage.store;
      if (sample === null && g.signedIn && g.shop === null && !g.loading) void g.refresh().then(() => (el.isConnected && answer() !== null ? paint() : undefined));
      // Whether mail goes (the email requirement's button, as PERFIL's Correo row), read once.
      if (sample === null && authCfg === null)
        void acc.authConfig().then((c) => {
          authCfg = c;
          if (el.isConnected && answer() !== null) paint();
        });
      paint();
    },
    tick: () => {
      if (sample !== null || !hostingOpen(menu.cfg) || !acc.signedIn) return;
      if (refreshDue(clock, Date.now(), document.hidden)) void load();
      if (wiz?.step === 'token') paintFollow();
    },
    // The add flow's step closes first (the checklist back to the form); the flow keeps its state for the next open.
    back: () => {
      if (wiz !== null && wiz.step === 'checklist') {
        wiz.step = 'form';
        paintAdd(true);
        return true;
      }
      return false;
    },
  };
}

/**
 * `#servers` (the installer's last line: install.sh; a TV's QR), on this load or a later
 * hashchange: its word leaves the address at once (replaceState: a reload does not ask again; the
 * other flags stay), and the screen opens in the arbiter's turn (Game.ts urlSheets: after the OAuth
 * result and the mail's sheets, so the account is restored) with the menus up, no sheet and the
 * config read: "Mis servidores" once hosting is open, PERFIL before (serversLinkTarget: dark, so no
 * new text, and the link always resolves). Resolves once the first link (if any) is scheduled.
 */
export async function installServersLink(menu: Menu, turn: () => Promise<void> = () => Promise.resolve()): Promise<void> {
  let pending = false;
  let timer = 0;
  let ready = false;
  const take = (): boolean => {
    if (!hasServersLink(location.hash)) return false;
    history.replaceState(history.state, '', location.pathname + location.search + withoutServersLink(location.hash));
    return true;
  };
  const tryOpen = (): void => {
    window.clearTimeout(timer);
    if (!pending || !ready) return;
    if (!menu.visible || menu.modalOpen || menu.cfg === null) {
      timer = window.setTimeout(tryOpen, 400);
      return;
    }
    pending = false;
    menu.open(serversLinkTarget(hostingOpen(menu.cfg)));
  };
  pending = take();
  window.addEventListener('hashchange', () => {
    if (!take()) return;
    pending = true;
    tryOpen();
  });
  await turn();
  ready = true;
  tryOpen();
}

/** Sample answers (window.__servers): long names, every state of a server, the caps, a code. */
function sampleMine(kind: SampleKind): MineAnswer | null {
  if (kind === 'guest') return null;
  const now = Date.now();
  const node = (i: number, name: string, status: NodeStatus, o: Partial<MineNode> = {}): MineNode => ({
    nodeId: String(i).repeat(16).slice(0, 16),
    name,
    region: 'SA',
    status,
    statusReason: null,
    suspendedUntil: null,
    online: true,
    roles: ['host'],
    transports: ['wss'],
    trusted: kind === 'project',
    publicUrl: `wss://${name}.example.com`,
    reachable: status !== 'pending',
    active: status === 'active' ? 7 : status === 'probation' ? 2 : 0,
    capacity: { matches: 12, source: 'bench' },
    tickLagP99Ms: 3.8,
    egressGB: 214.6,
    counters: { assigned: 64, verified: 61, rankedVerified: 0, failedVerification: 0, lost: 1, strikes: status === 'suspended' ? 1 : 0, probationVerified: status === 'active' ? 20 : 12 },
    version: '0.3.1',
    compatible: true,
    createdAt: now - 9 * 86_400_000,
    lastSeen: now - 4000,
    draining: false,
    egressCapGB: 2000,
    reachableAt: status === 'pending' ? null : now - 86_400_000,
    lastProbe: status === 'pending' ? { at: now - 30_000, ok: false, error: 'timeout' } : { at: now - 120_000, ok: true, error: null },
    needed: 20,
    strikes: { count: status === 'suspended' ? 1 : 0, max: 3, windowDays: 7 },
    refused: { count: 2, rate: 0.03, recent: 0, of: 10, outUntil: null },
    capacityEffective: status === 'active' ? 12 : 4,
    ...o,
  });
  const nodes =
    kind === 'operator' || kind === 'token' || kind === 'tv' || kind === 'project'
      ? [node(1, 'juan-vps-buenos-aires-largo', 'active'), node(2, 'juan-2', 'probation'), node(3, 'juan-3', 'pending', { online: false, lastSeen: now - 3_600_000 })]
      : [];
  const open = kind !== 'closed';
  return {
    operator: { id: '0a1b2c3d4e5f6071', trusted: kind === 'project' },
    nodes,
    rewards: { operatorId: '0a1b2c3d4e5f6071', points30d: 3120, earned: 4100, matches30d: 64, playerMinutes30d: 5200, byNode: Object.fromEntries(nodes.map((n) => [n.nodeId, { points: 1040, matches: 21 }])), pointsToday: 212, capToday: 300 },
    hosting: open ? { open: true } : { open: false, reason: 'hosting_closed' },
    requirements: kind === 'requirements' ? { missing: ['email_required', 'account_too_new'], daysLeft: 3 } : open ? { missing: [], daysLeft: 0 } : null,
    terms: kind === 'terms' ? { version: '2026-11-13', accepted: false } : open ? { version: '2026-11-13', accepted: true } : null,
    limits: { nodes: nodes.length, maxNodes: 3, tokensToday: 1, tokensLeftToday: 2, outstanding: kind === 'token' ? 1 : 0, maxOutstanding: 2 },
    tokens: kind === 'token' ? [{ id: 'abcdef123456', region: 'SA', name: 'juan-vps-buenos-aires', publicHost: 'srv1.example.com', createdAt: now - 8 * 60_000, expiresAt: now + 52 * 60_000, state: 'unused', nodeId: null }] : [],
    showPublic: false,
    channel: { stable: '0.3.1', minimum: '0.3.0' },
  };
}
