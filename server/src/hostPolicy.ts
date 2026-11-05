/**
 * What an account outside the project must meet to host a community node (Prompt 2: A2, A3, A5),
 * checked by the NodeRegistryDO when it is asked for a node token (POST /nodes/tokens), once the
 * opening's policy let the account through (env.ts hostingMode: the terms in force and the KV flag
 * node_operators). Pure: the object hands in the account as AccountsDO's GET /me answers it. The
 * project's accounts (NODE_TRUSTED_OPERATORS) meet none of it: their tokens pass the maintainer
 * gate alone, as before.
 *
 *   email_required    no verified address: an extra account costs one more verified address
 *   deletion_pending  the account asked to be deleted (its nodes are banned at the purge)
 *   account_too_new   younger than MIN_ACCOUNT_AGE_DAYS (daysLeft says how long), or of no known age
 *   terms_required    the terms in force not accepted; or, at the token, the rules for hosts of that
 *                     version (a 'host' consents row) neither held nor accepted with the request
 *   adult_required    the rules accepted without declaring 18 or older: never a 'host' row then
 *
 * Then the caps (COMMUNITY_TOKENS_PER_DAY, COMMUNITY_OUTSTANDING, the registry's community node
 * cap), and the token's host: a DNS name, never one under RESERVED_HOST_DOMAIN.
 */
import { hostingModeOf } from './env';

/** The youngest account that may host, in days (the ledger's NEW_ACCOUNT_DAYS: its minutes weigh 1 from then). */
export const MIN_ACCOUNT_AGE_DAYS = 7;
/** Community node tokens one account may mint in any 24 hours (counted in SQLite: a deploy does not reset it). */
export const COMMUNITY_TOKENS_PER_DAY = 3;
/** A community account's tokens not used yet, at most at once. */
export const COMMUNITY_OUTSTANDING = 2;
/** The project's domain: no community node is named under it (nor is the token's host). */
export const RESERVED_HOST_DOMAIN = 'turbo-gol.com';
/** How long the object keeps an account's GET /me answer for these checks. */
export const HOST_ACCOUNT_TTL_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** The parts of AccountsDO's GET /me (accountStore.ts me) the checks read. */
export interface HostAccount {
  /** When the account was made (ms); 0 when unknown (an account of before the column). */
  createdAt: number;
  emailVerified: boolean;
  /** The terms version accepted last, or null. */
  terms: string | null;
  /** The version of the newest 'host' consents row (the rules for hosts and the 18-or-older declaration), or null. */
  hostTerms: string | null;
  /** The purge's time while a deletion is pending; 0 otherwise. */
  deletionAt: number;
}

/** GET /me's answer as a HostAccount, or null when it does not read as one. */
export function hostAccountOf(v: unknown): HostAccount | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const text = (x: unknown) => (typeof x === 'string' ? x : null);
  return { createdAt: num(o.createdAt), emailVerified: o.emailVerified === true, terms: text(o.terms), hostTerms: text(o.hostTerms), deletionAt: num(o.deletionAt) };
}

export type HostRequirement = 'email_required' | 'deletion_pending' | 'account_too_new' | 'terms_required';

/**
 * What the account still lacks, in the order the refusal names them (the first one), and the whole
 * days until it is old enough (0 when it is). Its age is the younger of its creation time and the
 * session's `since` (seconds; null when the session carries none): no age known at all is too new.
 */
export function hostRequirements(a: HostAccount, o: { now: number; since: number | null; terms: string }): { missing: HostRequirement[]; daysLeft: number } {
  const missing: HostRequirement[] = [];
  if (!a.emailVerified) missing.push('email_required');
  if (a.deletionAt > 0) missing.push('deletion_pending');
  const born = Math.max(a.createdAt > 0 ? a.createdAt : 0, o.since !== null && o.since > 0 ? o.since * 1000 : 0);
  const old = born > 0 ? o.now - born : 0;
  const daysLeft = born > 0 ? Math.max(0, Math.ceil((MIN_ACCOUNT_AGE_DAYS * DAY_MS - old) / DAY_MS)) : MIN_ACCOUNT_AGE_DAYS;
  if (daysLeft > 0) missing.push('account_too_new');
  if (a.terms !== o.terms) missing.push('terms_required');
  return { missing, daysLeft };
}

/** `host` is RESERVED_HOST_DOMAIN or a name under it. */
export function underReservedDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === RESERVED_HOST_DOMAIN || h.endsWith('.' + RESERVED_HOST_DOMAIN);
}

/** HOSTING_FLAG's value in an audit line and the Discord channel: how many accounts it opens to, never their ids. */
export function hostingWords(raw: string | null): string {
  const m = hostingModeOf(raw);
  if (m === 'closed') return 'closed';
  if (m === 'all') return 'open to every account';
  return `open to a canary of ${m.size} account${m.size === 1 ? '' : 's'}`;
}
