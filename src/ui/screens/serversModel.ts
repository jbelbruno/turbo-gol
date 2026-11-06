/**
 * "Mis servidores" and the rest of the community's hosting in the game (Prompt 2, Part B: the
 * screen is screens/servers.ts), pure so node tests read it (tests/servers-screen.test.mjs): the
 * screens' gate, GET /api/config's `hosting` (owner's decision 1: deployed dark, nothing shown or
 * sent until it says hosting is open), what `#servers` opens, which view the screen draws from GET
 * /nodes/mine, what a host still lacks, a code's follow-up, a server's facts and its owner's actions
 * (the server's own guards, so a button that would only be refused is not offered), and the players'
 * three of decision 6: the community server's mark in PARTIDO ENCONTRADO and the FINAL, REPORTAR
 * SERVIDOR and "Solo servidores del proyecto". Those three never read the flag (P2-2's rule: the
 * flag can be closed again, or its read fail, while community servers keep hosting): the mark and
 * the report follow the Worker's mark, the preference the player's choice. Dark all the same: no
 * community server exists before an opening, and the choice can only be made once one was shown.
 * No DOM; Menu and Screen are not imported.
 */
import { statusTone, tokenAskOf } from '../../net/nodes';
import type { MineAnswer, MineNode, MineToken, Tone, TokenAsk, TokenForm } from '../../net/nodes';
import type { ServerMark } from '../../net/queueWait';

// ---- the gate ----------------------------------------------------------------------------------------

/**
 * Hosting is open (GET /api/config `hosting.open`: the terms in force describe it and the KV flag
 * node_operators opened it, to a canary or to everyone). Absent (an older Worker, the config not
 * read yet, offline) or anything else: closed, and the game shows none of the screens: "Mis
 * servidores" and its entries, and JUEGO's "Solo servidores del proyecto" row unless the player
 * already turned it on (projectOnlyShown). The mark and REPORTAR SERVIDOR do not read it.
 */
export function hostingOpen(cfg: { readonly hosting?: { readonly open?: unknown } | null } | null | undefined): boolean {
  return cfg?.hosting?.open === true;
}

/** Where PERFIL's and GARAJE's hosting entries lead: the screen once hosting is open, the guide before (its copy pinned by tests/garage-screen.test.mjs). */
export function hostEntry(open: boolean): 'servers' | 'guide' {
  return open ? 'servers' : 'guide';
}

/**
 * What `#servers` opens (the installer's last line, a TV's QR): the screen once hosting is open;
 * before, PERFIL (dark: no new text, and a project operator's MI SERVIDOR is there), so the link
 * always resolves (decision 8: the release before the canary needs it to).
 */
export function serversLinkTarget(open: boolean): 'servers' | 'profile' {
  return open ? 'servers' : 'profile';
}

// ---- #servers --------------------------------------------------------------------------------------

/** The hash's word (a bare flag, alone or among others: `#servers`, `#tv&servers`). */
export const SERVERS_HASH = 'servers';

/** The hash carries `servers` (bare: `servers=` with a value is not the link). */
export function hasServersLink(hash: string): boolean {
  return hash
    .replace(/^#/, '')
    .split('&')
    .some((p) => p === SERVERS_HASH);
}

/** The hash without `servers` ('' or '#...'): the other flags stay (installJoinLink's rule). */
export function withoutServersLink(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p !== '' && p !== SERVERS_HASH);
  return rest.length > 0 ? '#' + rest.join('&') : '';
}

// ---- the screen's views -------------------------------------------------------------------------------

/** How often the screen asks GET /nodes/mine again (B4: 10 s; the route takes 30 a minute per account). */
export const MINE_REFRESH_MS = 10_000;

/**
 * A community server's matches at a time on probation and once active (nodes/control-plane/
 * controlPlane.ts PROBATION_CAPACITY_MAX, COMMUNITY_CAPACITY_MAX: the same numbers, pinned by a
 * test; the SPA does not bundle the control plane).
 */
export const PROBATION_CAPACITY_MAX = 4;
export const COMMUNITY_CAPACITY_MAX = 16;

/**
 * Which view "Mis servidores" draws: 'dark' while hosting is closed (nothing: the screen goes
 * back), 'guest' (sign in first), 'loading' / 'error' (GET /nodes/mine not answered), 'project' (a
 * project account: its servers are the panel's, the owner's routes answer it 409 trusted),
 * 'closed' (open, but not for this account: a canary it is not in), 'host' (it may host).
 */
export type ServersView = 'dark' | 'guest' | 'loading' | 'error' | 'closed' | 'project' | 'host';

export function serversViewOf(s: { open: boolean; signedIn: boolean; mine: MineAnswer | null; failed: boolean }): ServersView {
  if (!s.open) return 'dark';
  if (!s.signedIn) return 'guest';
  if (s.mine === null) return s.failed ? 'error' : 'loading';
  if (s.mine.operator?.trusted === true) return 'project';
  if (s.mine.hosting?.open !== true) return 'closed';
  return 'host';
}

/**
 * The 'closed' view's words, by GET /api/config's stage: a canary says only invited people may
 * register a server (Terms 12.1.2 of (b)); open to everyone (the Worker's and the object's reads of
 * the flag apart for a minute, or the object's read failed), or anything else, a neutral line with a
 * retry, never "only invited people".
 */
export function closedKeyOf(stage: unknown): 'servers.closed' | 'servers.closedNow' {
  return stage === 'canary' ? 'servers.closed' : 'servers.closedNow';
}

/**
 * What a host may still lack (GET /nodes/mine `requirements.missing`, the token's refusals in their
 * order): last, the rules for hosts of a new terms version to accept again (Terms 12.2).
 */
export type Requirement = 'operator_blocked' | 'email_required' | 'deletion_pending' | 'account_too_new' | 'terms_required' | 'reaccept_required';

const REQUIREMENTS: readonly Requirement[] = ['operator_blocked', 'email_required', 'deletion_pending', 'account_too_new', 'terms_required', 'reaccept_required'];

/** The requirements the account lacks, the ones this client knows, in the server's order. */
export function requirementsOf(mine: MineAnswer | null): Requirement[] {
  const missing = mine?.requirements?.missing ?? [];
  return missing.filter((m): m is Requirement => (REQUIREMENTS as readonly string[]).includes(m));
}

/**
 * The acceptance step shows (the rules for hosts of the terms in force and the 18-or-older
 * declaration, above PEDIR CÓDIGO): the account holds no acceptance for that version, or the server
 * could not say (null: the request then carries it, and the server writes it once). Never for a host
 * that accepts them again (`again`): that one is VOLVER A ACEPTAR's, before any code (acceptAgainPending).
 */
export function acceptanceNeeded(mine: MineAnswer | null): boolean {
  return mine?.terms?.accepted !== true && mine?.terms?.again !== true;
}

/**
 * The banner of a new terms version (Terms 12.2, last paragraph): the host accepted the rules of an
 * earlier one (or has a server without any) and accepts them again in this screen, with the first
 * code's acceptance and VOLVER A ACEPTAR (POST /nodes/mine/accept); until then its servers may get no
 * new match and it asks for no code. Not for a blocked host: its servers are out of the network anyway.
 */
export function acceptAgainPending(mine: MineAnswer | null): boolean {
  return mine?.terms?.again === true && !requirementsOf(mine).includes('operator_blocked');
}

/**
 * The words of that banner, its sheet and its requirement line. A host that accepted the rules of an
 * earlier version: the Terms have a new one, VOLVER A ACEPTAR. One with servers that never accepted
 * any (`acceptedVersion` null: an account that left the project's): nothing changed version for it,
 * so it is only told to accept them, ACEPTAR.
 */
export function acceptAgainWords(mine: MineAnswer | null): {
  title: 'servers.againTitle' | 'servers.rulesTitle';
  note: 'servers.againNote' | 'servers.rulesNote';
  req: 'servers.req.reaccept_required' | 'servers.rulesReq';
  button: 'servers.againBtn' | 'servers.rulesBtn';
} {
  return mine?.terms?.acceptedVersion === null
    ? { title: 'servers.rulesTitle', note: 'servers.rulesNote', req: 'servers.rulesReq', button: 'servers.rulesBtn' }
    : { title: 'servers.againTitle', note: 'servers.againNote', req: 'servers.req.reaccept_required', button: 'servers.againBtn' };
}

/**
 * POST /nodes/tokens's body for a community server: the form's, a host only by wss (never `verify`,
 * which the server refuses a community account: 403 verify_reserved), and, while the acceptance is
 * needed, `acceptHost: true` (its button) with `adult` (its switch); none once the account holds it.
 */
export function communityAsk(f: TokenForm, accept: { needed: boolean; adult: boolean }): TokenAsk {
  const ask = tokenAskOf({ ...f, roles: 'host' });
  return accept.needed ? { ...ask, acceptHost: true, adult: accept.adult } : ask;
}

/**
 * The acceptance line's links (PR 2A: the ids are server/src/legalPages.ts slugOf of the headings):
 * Terms §12, the rules for hosts, and Annex B, in the page's language (Spanish is the official text).
 */
export function hostRulesHref(lang: string): string {
  return lang === 'es' ? '/terminos#12-anfitriones-de-servidores-de-la-comunidad' : '/terms#12-community-server-hosts';
}

export function annexHref(lang: string): string {
  return lang === 'es' ? '/terminos#anexo-b-clausulas-para-quien-aloja-un-servidor-de-la-comunidad' : '/terms#annex-b-clauses-for-whoever-hosts-a-community-server';
}

/** The checklist's lines before a code (B3 step 2): the system, the ports, the DNS record, the clock. */
export const COMMUNITY_CHECKS = ['os', 'ports', 'dns', 'ntp'] as const;
export type CommunityCheck = (typeof COMMUNITY_CHECKS)[number];

/**
 * Where a code of the screen stands (B3 step 5), from GET /nodes/mine alone (no freshness: the
 * follow-up never stops at the 15 minutes): 'waiting' (unused, in its hour), 'expired', 'revoked',
 * then its node: 'pending' (its probe not passed: the probe's error, if any), 'probation' (X of 20
 * verified), 'active', or 'stopped' (suspended, banned); 'gone' when /nodes/mine no longer lists it.
 */
export type FollowStep = 'waiting' | 'expired' | 'revoked' | 'pending' | 'probation' | 'active' | 'stopped' | 'gone';

export function followMine(mine: MineAnswer | null, tokenId: string, now: number): { step: FollowStep; token: MineToken | null; node: MineNode | null } {
  const token = mine?.tokens?.find((t) => t.id === tokenId) ?? null;
  if (token === null) return { step: 'gone', token: null, node: null };
  if (token.nodeId === null) {
    if (token.state === 'revoked') return { step: 'revoked', token, node: null };
    return { step: token.state === 'expired' || token.expiresAt < now ? 'expired' : 'waiting', token, node: null };
  }
  const node = mine?.nodes.find((n) => n.nodeId === token.nodeId) ?? null;
  if (node === null) return { step: 'pending', token, node: null };
  if (node.status === 'pending' || node.status === 'probation' || node.status === 'active') return { step: node.status, token, node };
  return { step: 'stopped', token, node };
}

/** A version older than another (X.Y.Z): the release channel's `minimum` against a node's. */
function older(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/** A server's card (B4): its tone, load against the matches placement lets it run, egress, version, history, refusals. */
export interface NodeFacts {
  tone: Tone;
  live: boolean;
  load: { active: number; capacity: number };
  lagMs: number;
  egress: { used: number; cap: number | null };
  /** "compatible", or "actualización pendiente" (below the channel's minimum, or another build than the network's). */
  version: 'compatible' | 'update';
  seen: 'now' | number | null;
  strikes: { count: number; max: number; windowDays: number };
  /** The share of its assignments it refused, 0 to 1. */
  refusalRate: number;
  /** Out of placement for its refusals until then (A8 bis's hour), null when it is not. */
  outUntil: number | null;
  probation: { verified: number; needed: number };
}

export function nodeFacts(n: MineNode, channel: { minimum: string } | null | undefined): NodeFacts {
  const minimum = channel?.minimum ?? null;
  return {
    tone: statusTone(n.status),
    live: n.online && (n.status === 'active' || n.status === 'probation'),
    load: { active: n.active, capacity: n.capacityEffective ?? n.capacity?.matches ?? 0 },
    lagMs: n.tickLagP99Ms,
    egress: { used: n.egressGB, cap: n.egressCapGB ?? null },
    version: n.compatible && !(minimum !== null && older(n.version, minimum)) ? 'compatible' : 'update',
    seen: n.online ? 'now' : (n.lastSeen ?? null),
    strikes: n.strikes ?? { count: n.counters.strikes, max: 3, windowDays: 7 },
    refusalRate: n.refused?.rate ?? 0,
    outUntil: n.refused?.outUntil ?? null,
    probation: { verified: n.counters.probationVerified, needed: n.needed ?? 20 },
  };
}

/**
 * What its owner may ask of a server (A12), as the server's guards would answer: nothing on a TV
 * (tv_session) nor for a banned one (409 banned); a drain to one online that is not draining (409
 * offline otherwise); a retire to one that is not suspended (409 suspended), offline or drained with
 * no match running (409 not_retirable); a rename while hosting is open for the account and it is not
 * blocked (403 hosting_closed, operator_blocked).
 */
export function ownerActions(n: MineNode, o: { tv: boolean; open: boolean; blocked: boolean }): { drain: boolean; rename: boolean; retire: boolean } {
  if (o.tv || n.status === 'banned') return { drain: false, rename: false, retire: false };
  return {
    drain: n.online && n.draining !== true,
    rename: o.open && !o.blocked,
    retire: n.status !== 'suspended' && (!n.online || (n.draining === true && n.active === 0)),
  };
}

/** One of the account's own codes it may still revoke (unused and in its hour). */
export function ownRevocable(t: MineToken, now: number): boolean {
  return t.state === 'unused' && t.expiresAt >= now;
}

/** How to take the program off the machine once its server is retired (nodes/install/install.sh's header: Uninstall). */
export const UNINSTALL_LINES: readonly string[] = [
  'sudo systemctl disable --now turbogol-node',
  'sudo rm -rf /opt/turbogol-node /var/lib/turbogol-node /etc/systemd/system/turbogol-node.service',
  'sudo userdel turbogol',
];

/** How a drained server comes back (its drain is one-way: nodes/node/runtime.ts). */
export const RESTART_LINE = 'sudo systemctl restart turbogol-node';

/** The installer's refusals the help after an expired code explains (each with its text under nodesShared.err.*). */
export const INSTALL_ERRORS = ['region_mismatch', 'rtc_not_available', 'ip_not_supported', 'public_host_mismatch'] as const;

// ---- PARTIDO ENCONTRADO, the FINAL, REPORTAR SERVIDOR, the preference -------------------------------

/**
 * The match is marked as one on a community server (decision 6; Terms 7.6, Privacy 4.4): by the
 * Worker's mark of a server whose host is not the project (`community`), never the node's own
 * Welcome, and never by GET /api/config (P2-2: the flag closed again, or its read failed, while
 * community servers still host must not hide it). Dark by itself: a community server exists only
 * after an opening, and a project server is `community: false` (before the terms describe hosting
 * it carries no mark at all). A project server, a MatchDO, or no mark: unmarked.
 */
export function communityMarked(server: ServerMark | null | undefined): boolean {
  return server?.community === true;
}

/**
 * REPORTAR SERVIDOR at the end of a match (A16, Terms 12.6.2): a community server's (its mark, as
 * communityMarked: never the flag), for an account (the route takes no guest; a TV's session is one:
 * its player played the match), with the match's id known, and once per match (`reported`: sent
 * already).
 */
export function reportOffered(o: { server: ServerMark | null | undefined; signedIn: boolean; matchId: string | null; reported: boolean }): boolean {
  return communityMarked(o.server) && o.signedIn && o.matchId !== null && /^[0-9a-f]{64}$/.test(o.matchId) && !o.reported;
}

/**
 * JUEGO's "Solo servidores del proyecto" row shows once hosting is open, and stays while the player
 * has it on whatever GET /api/config says, so it can always be turned off. The search sends the
 * choice as it is (Game.menuSearch: `projectOnly: true` whenever it is on, never keyed on the flag,
 * as the Worker's and the hub's guards are not since P2-2): before any opening it cannot be on, so
 * the queue's body is the one of before.
 */
export function projectOnlyShown(open: boolean, chosen: boolean): boolean {
  return open || chosen;
}

/** The report's numbers as whole ones in the server's ranges (ping up to 60,000 ms, corrections up to 1,000,000), or none. */
export function reportNumbers(ping: number, corrections: number): { ping?: number; corrections?: number } {
  const whole = (v: number, max: number): number | undefined => (Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : undefined);
  const p = whole(ping, 60_000);
  const c = whole(corrections, 1_000_000);
  return { ...(p !== undefined && p > 0 ? { ping: p } : {}), ...(c !== undefined ? { corrections: c } : {}) };
}
