/**
 * Translations. English (src/locales/en.ts) is the source of truth and the fallback for every
 * missing text; the other files in src/locales translate it (CONTRIBUTING.md, "Translating").
 *
 *   t(key, params)   the text in the current language, `{name}` placeholders filled from params;
 *                    a plural text picks its form with Intl.PluralRules from params.count
 *   duration(ms)     "5 min", "30 sec" ("30 s" in Spanish)... in the current language (Intl.NumberFormat units)
 *   serverText(...)  a server error by its machine code, or the server's own message
 *                    (hasServerText: the client has a text for that code)
 *   setLanguage(c)   save the choice (null = follow the system) and reload the page
 *
 * The language is fixed for the page's lifetime: a saved choice (localStorage), else the first
 * of navigator.languages we ship (exact tag, then its base: es-AR -> es), else English. Menu
 * screens are built once and cached, so a change reloads the page instead of re-rendering.
 * Portuguese ships hidden until legal version (c) is in force (PT_LEGAL_VERSION below).
 *
 * Shared with the Cloudflare Worker: src/net/account.ts, rating.ts, protocol.ts, p2p/protocol.ts,
 * game/Match.ts, ai/* and sim/* must never import this module (no DOM there).
 * The locale files may only `import type`: a runtime import would create a cycle at startup.
 */
import en from './locales/en';
import es from './locales/es';
import pt from './locales/pt';
import { STORAGE_PREFIX } from './brand';

/** A text with plural forms: `other` always, the categories the language uses (Intl.PluralRules) optionally. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Messages = Record<string, string | Plural>;
export type Key = keyof typeof en;
/** A locale file: any subset of the English keys (the rest falls back to English), same kind of value. */
export type Translation = { [K in Key]?: (typeof en)[K] extends string ? string : Plural };
export type Params = Record<string, string | number>;

interface Locale {
  /** The language's own name (endonym), shown in the language picker. */
  name: string;
  /**
   * The BCP 47 tag its Intl calls and the page's lang attribute use. The key is the lowercase
   * language code the picker and the saved choice use; the tag adds the region when it matters
   * (pt-BR speaks Brazilian Portuguese, not the European one).
   */
  tag: string;
  messages: Translation;
}

/** Every shipped language, one line each (a new locale file is registered here). */
export const LOCALES = {
  en: { name: 'English', tag: 'en', messages: en },
  es: { name: 'Español', tag: 'es', messages: es },
  pt: { name: 'Português (Brasil)', tag: 'pt-BR', messages: pt },
} satisfies Record<string, Locale>;

export type LanguageCode = keyof typeof LOCALES;

/**
 * Portuguese (Brazil) ships complete but HIDDEN until legal version (c) is in force (the owner,
 * 6 Nov 2026), together with informative Portuguese translations of the legal texts. While this is
 * null, Portuguese does not exist for a player: Settings' language list leaves it out, a pt, pt-BR
 * or pt-PT browser gets what it got before pt.ts existed (the next language of its list we ship,
 * else English) and a saved 'turbogol.lang' = 'pt' is ignored. pt.ts still loads (the tests read
 * it, and check the open gate through the `open` arguments below).
 *
 * It opens when this is set to that version, and never ahead of it: tests/i18n-pt.test.mjs fails
 * while it is newer than the TERMS_VERSION of server/wrangler.jsonc (the game is deployed with the
 * Worker, from the same commit), so it can only be set with or after the change that puts (c) in
 * force. Which change sets it is the owner's call. A constant in the code, not the version
 * GET /api/config reports: the language is picked when this module loads, before any request.
 * Never an env var, a KV flag or a storage key: that would be a way around the legal gate.
 */
export const PT_LEGAL_VERSION: string | null = null;

/** Portuguese can be shown: the legal version that opens it is set (by default PT_LEGAL_VERSION). */
export function portugueseOpen(version: string | null = PT_LEGAL_VERSION): boolean {
  return version !== null;
}

const DEFAULT_LANGUAGE: LanguageCode = 'en';
const LANG_KEY = STORAGE_PREFIX + 'lang';

function isLanguage(code: string): code is LanguageCode {
  return Object.prototype.hasOwnProperty.call(LOCALES, code);
}

/** A shipped language a player can get: every one, Portuguese only once it is open. */
function isShown(code: string, open: boolean): code is LanguageCode {
  return isLanguage(code) && (code !== 'pt' || open);
}

/** The languages Settings' list offers, in LOCALES order (Portuguese only once it is open). */
export function shownLanguages(open: boolean = portugueseOpen()): LanguageCode[] {
  return (Object.keys(LOCALES) as LanguageCode[]).filter((code) => isShown(code, open));
}

/**
 * The language to use: `saved` when it is a shipped one, else the first entry of `wanted` (a
 * navigator.languages list) shipped as is or by its base language, else English. Case-insensitive.
 * While Portuguese is closed (`open`, by default portugueseOpen()) it counts as not shipped.
 */
export function pickLanguage(saved: string | null, wanted: readonly string[], open: boolean = portugueseOpen()): LanguageCode {
  if (saved !== null) {
    const s = saved.toLowerCase();
    if (isShown(s, open)) return s;
  }
  for (const tag of wanted) {
    const t = tag.toLowerCase();
    if (isShown(t, open)) return t;
    const base = t.split('-')[0];
    if (isShown(base, open)) return base;
  }
  return DEFAULT_LANGUAGE;
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null; // storage blocked
  }
}

function systemLanguages(): readonly string[] {
  const nav = window.navigator;
  return nav.languages !== undefined && nav.languages.length > 0 ? nav.languages : [nav.language];
}

/** Outside a browser (node tests, which share the OS locale through navigator) it is always English. */
function detect(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return pickLanguage(readSaved(), systemLanguages());
  } catch {
    return DEFAULT_LANGUAGE; // never leave the page blank over a language
  }
}

const current: LanguageCode = detect();
if (typeof document !== 'undefined') {
  try {
    document.documentElement.lang = LOCALES[current].tag;
  } catch {
    /* no root element */
  }
}

/** The language of this page load. */
export function language(): LanguageCode {
  return current;
}

/** The language the system would get with no saved choice (the picker's "Automatic (...)" entry). */
export function systemLanguage(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return pickLanguage(null, systemLanguages());
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** The saved choice, or null when the language follows the system (a saved 'pt' while Portuguese is closed too). */
export function savedLanguage(open: boolean = portugueseOpen()): LanguageCode | null {
  const s = readSaved();
  return s !== null && isShown(s, open) ? s : null;
}

/** Save the choice (null = follow the system again) and reload: the menus are built once per page. */
export function setLanguage(code: LanguageCode | null): void {
  try {
    if (code === null) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, code);
  } catch {
    /* storage blocked: the reload keeps the detected language */
  }
  location.reload();
}

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Fill a message for `locale`: a plural picks the form for params.count (falling back to
 * `other`), then each `{name}` takes String(params.name). An unknown placeholder stays visible.
 * Portuguese counts 0 as `other`: CLDR puts 0 in pt's `one` (with 1), but a Brazilian UI writes
 * "0 partidas", never "0 partida".
 */
export function formatMessage(message: string | Plural, params: Params | undefined, locale: string): string {
  let text: string;
  if (typeof message === 'string') text = message;
  else {
    let rules = pluralRules.get(locale);
    if (rules === undefined) {
      rules = new Intl.PluralRules(locale);
      pluralRules.set(locale, rules);
    }
    const n = Number(params?.count ?? 0);
    const form = n === 0 && /^pt(?:-|$)/i.test(locale) ? 'other' : rules.select(n);
    text = message[form] ?? message.other;
  }
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

/** The text for `key` from `messages` (English when they lack it), formatted for `locale`. */
export function textIn(messages: Translation, locale: string, key: Key, params?: Params): string {
  const message = (messages[key] ?? en[key]) as string | Plural;
  return formatMessage(message, params, locale);
}

/** The text for `key` in the current language (English when this language lacks it). */
export function t(key: Key, params?: Params): string {
  return textIn(LOCALES[current].messages, LOCALES[current].tag, key, params);
}

/** A wait or a ban length, rounded up to whole seconds, minutes or hours: "45 sec", "5 min", "24 hr" ("45 s", "24 h" in Spanish). */
export function duration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const unit = s < 60 ? 'second' : s < 3600 ? 'minute' : 'hour';
  const value = unit === 'second' ? s : unit === 'minute' ? Math.ceil(s / 60) : Math.ceil(s / 3600);
  return new Intl.NumberFormat(LOCALES[current].tag, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
}

/**
 * Server error codes whose server message carries details the translations cannot (Spanish servers
 * only): one code, several server texts (which limit was hit, which name rule failed, the player
 * still in a match...), so the client's text for them is a generic one. Also matchmaking_off: the
 * lobby routes send it bare and Spanish keeps the generic text it had there (LobbyClient's fallback,
 * 'Error del servidor (503)'); a bare one on the queue (no fallback) still gets its error.queue text.
 */
const SERVER_DETAIL_CODES: ReadonlySet<string> = new Set(['bad_password', 'busy', 'not_host', 'member_busy', 'rate_limited', 'bad_username', 'bad_name', 'matchmaking_off']);

/** Where a server error is shown: the account forms, the custom lobbies, the matchmaking searches. */
export type ServerSurface = 'account' | 'lobby' | 'queue';

/** The client has a text for the server's `code` on `surface` (an error.<surface>.<code> key). */
export function hasServerText(surface: ServerSurface, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(en, `error.${surface}.${code}`);
}

/**
 * A server error for the player: the `error.<surface>.<code>` text when the client has one, else
 * the server's own message. The server writes its messages in Spanish, so for the few codes it
 * fills with details (SERVER_DETAIL_CODES) Spanish players keep the server's message.
 */
export function serverText(surface: ServerSurface, code: string, fallback: string, params?: Params): string {
  if (!hasServerText(surface, code)) return fallback;
  if (current === 'es' && SERVER_DETAIL_CODES.has(code) && fallback.length > 0) return fallback;
  return t(`error.${surface}.${code}` as Key, params);
}
