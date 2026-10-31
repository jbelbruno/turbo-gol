/**
 * The terms of service and the privacy policy in the browser (the legal draft's P1, P2, P12, P33):
 * which version is in force, whether this player accepted it, and where the pages are. No DOM here
 * (node tests import it); the sheets are src/ui/screens/terms.ts.
 *
 * GET /api/config's `legal.terms` (AccountClient.authConfig) is the version in force, null until the
 * owner publishes: then nothing of the terms shows anywhere, as before this module. Once it is set:
 *   - a guest accepts by pressing JUGAR COMO INVITADO under the notice, before its first online
 *     session (NetClient.beforeSession); the version is kept in this browser (localStorage
 *     'turbogol.terms': { v, at }), so the next session asks only after a change;
 *   - an account accepts by pressing CREAR CUENTA under the notice (signup/finish and the OAuth
 *     confirm step's create carry the version: a consents row of kind 'terms'), and after a change
 *     on the re-accept sheet before its next online play (POST /api/me/consent { kind: 'terms',
 *     version }); /api/me's `terms` is the version it accepted last.
 */
import { STORAGE_PREFIX } from '../brand';
import type { StorageLike } from './NetClient';

/** A terms version (server/src/env.ts TERMS_VERSION_RE, the same rule). */
export const TERMS_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** localStorage: the version a guest of this browser accepted, and when. */
export const GUEST_TERMS_KEY = STORAGE_PREFIX + 'terms';

/** The pages (server/src/legalPages.ts): Spanish is the official text, English its translation. */
export const LEGAL_PATHS = {
  es: { terms: '/terminos', privacy: '/privacidad' },
  en: { terms: '/terms', privacy: '/privacy' },
} as const;

/** The pages in the player's language. */
export function legalPaths(lang: string): { terms: string; privacy: string } {
  return lang === 'es' ? LEGAL_PATHS.es : LEGAL_PATHS.en;
}

/** `current` is in force and `accepted` is not it: the notice and the button come first. */
export function termsNeeded(current: string | null, accepted: string | null | undefined): boolean {
  return current !== null && accepted !== current;
}

/** The version a guest of this browser accepted (null: none, or storage off or unreadable). */
export function readGuestTerms(storage: Pick<StorageLike, 'getItem'> | null): string | null {
  try {
    const raw = storage?.getItem(GUEST_TERMS_KEY);
    if (raw === null || raw === undefined) return null;
    const o = JSON.parse(raw) as { v?: unknown };
    return typeof o.v === 'string' && TERMS_VERSION_RE.test(o.v) ? o.v : null;
  } catch {
    return null;
  }
}

/** A guest pressed JUGAR COMO INVITADO under the notice of `version` (storage off: it lasts the page, see GuestTerms). */
export function keepGuestTerms(storage: Pick<StorageLike, 'setItem'> | null, version: string, now: number): void {
  try {
    storage?.setItem(GUEST_TERMS_KEY, JSON.stringify({ v: version, at: now }));
  } catch {
    /* storage off: this page remembers it (GuestTerms.accepted) */
  }
}

/** This browser's localStorage, null where it is off or absent (node, a locked-down profile). */
function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** A guest's acceptance in this browser: its storage, and this page's own copy for a browser that keeps nothing. */
export class GuestTerms {
  private pageCopy: string | null = null;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  constructor(storage?: StorageLike | null, now: () => number = Date.now) {
    this.storage = storage === undefined ? browserStorage() : storage;
    this.now = now;
  }

  /** The version this guest accepted (this page's press when the storage keeps nothing). */
  accepted(): string | null {
    return readGuestTerms(this.storage) ?? this.pageCopy;
  }

  accept(version: string): void {
    this.pageCopy = version;
    keepGuestTerms(this.storage, version, this.now());
  }
}

/** What the menus read of GET /api/config's `legal` (AccountClient.authConfig). */
export interface LegalState {
  terms: string | null;
  deletion: boolean;
  graceDays: number;
}

/**
 * GET /api/config's `legal` through `accounts.authConfig` (one request per page), or nothing of it
 * (no terms, no deletion) when it cannot be read: offline, an older server, a host without it. Never
 * throws, so a screen that asks never breaks on it.
 */
export async function legalState(accounts: { authConfig?: () => Promise<{ terms?: unknown; deletion?: unknown; graceDays?: unknown }> }): Promise<LegalState> {
  try {
    const c = typeof accounts.authConfig === 'function' ? await accounts.authConfig() : null;
    const days = c?.graceDays;
    return { terms: typeof c?.terms === 'string' && TERMS_VERSION_RE.test(c.terms) ? c.terms : null, deletion: c?.deletion === true, graceDays: typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 60 ? days : 14 };
  } catch {
    return { terms: null, deletion: false, graceDays: 14 };
  }
}

/** The body field that says which version a sign-up accepted (`acceptTerms`), none when no notice showed. */
export function termsField(version: string | null | undefined): { acceptTerms?: string } {
  return typeof version === 'string' && TERMS_VERSION_RE.test(version) ? { acceptTerms: version } : {};
}
