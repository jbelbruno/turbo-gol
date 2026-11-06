// Portuguese (src/locales/pt.ts) ships complete but hidden until legal version (c) is in force
// (src/i18n.ts PT_LEGAL_VERSION, null until then). This file fakes a pt-BR browser with 'pt' saved
// before loading src/i18n.ts: while the gate is closed it gets what it got before pt.ts existed
// (English), and Settings' list leaves Portuguese out. With the gate open (the `open` arguments of
// the helpers) the same browser picks Portuguese, and pt.ts has every English key with its
// placeholders. The gate never runs ahead of the legal version in force (server/wrangler.jsonc
// TERMS_VERSION), and Settings' sheet is the only list of languages. tests/i18n-pt-open.test.mjs
// loads the whole page with the gate open; node --test runs each test file in its own process.
// Run: node --test tests/i18n-pt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

// A browser whose language is pt-BR and whose saved choice ('turbogol.lang') is Portuguese.
const stored = new Map([['turbogol.lang', 'pt']]);
const storage = { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) };
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
globalThis.window = { navigator: { languages: ['pt-BR', 'pt'], language: 'pt-BR' }, localStorage: storage };
const root = { lang: '' };
globalThis.document = { documentElement: root };

const I = await import('../src/i18n.ts');
const en = (await import('../src/locales/en.ts')).default;
const pt = I.LOCALES.pt.messages;
const say = (key, params) => I.textIn(pt, I.LOCALES.pt.tag, key, params);

test('closed: PT_LEGAL_VERSION is null until legal version (c) is in force', () => {
  assert.equal(I.PT_LEGAL_VERSION, null);
  assert.equal(I.portugueseOpen(), false);
});

/** server/src/env.ts compareTermsVersions: runs of digits as numbers, the rest as text (2026-11-05 < 2026-11-05-2 < 2026-11-13). */
function compareVersions(a, b) {
  const x = a.match(/\d+|\D+/g) ?? [];
  const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    const [p, q] = [x[i], y[i]];
    if (/^\d/.test(p) && /^\d/.test(q)) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The gate would open Portuguese before its legal version is in force (`terms`: TERMS_VERSION, '' when none is). */
function aheadOfTerms(version, terms) {
  if (version === null) return false;
  return terms === '' || compareVersions(version.toLowerCase(), terms) > 0;
}

test('the gate never runs ahead of the legal version in force: PT_LEGAL_VERSION is null or not newer than TERMS_VERSION in server/wrangler.jsonc', () => {
  // The game is deployed with the Worker, from one commit (server/wrangler.jsonc assets.directory
  // ../dist): a PT_LEGAL_VERSION newer than the TERMS_VERSION beside it would show Portuguese before
  // its legal texts are in force. So it is set with or after the change that puts that version in force.
  const wrangler = readFileSync(new URL('../server/wrangler.jsonc', import.meta.url), 'utf8');
  const m = /\n\s*"TERMS_VERSION": "([^"]*)"/.exec(wrangler);
  assert.ok(m, 'server/wrangler.jsonc sets TERMS_VERSION');
  const terms = m[1].trim().toLowerCase();
  assert.ok(!aheadOfTerms(I.PT_LEGAL_VERSION, terms), `PT_LEGAL_VERSION ${I.PT_LEGAL_VERSION} is newer than TERMS_VERSION ${terms || '(none)'}`);
  if (I.PT_LEGAL_VERSION !== null) assert.match(I.PT_LEGAL_VERSION, /^[a-z0-9][a-z0-9._-]{0,31}$/, 'a terms version (env.ts TERMS_VERSION_RE)');
  // The rule itself.
  assert.equal(aheadOfTerms(null, '2026-11-13'), false);
  assert.equal(aheadOfTerms(null, ''), false);
  assert.equal(aheadOfTerms('2026-12-01', '2026-11-13'), true, 'set before (c) is in force');
  assert.equal(aheadOfTerms('2026-11-13-2', '2026-11-13'), true);
  assert.equal(aheadOfTerms('2026-12-01', ''), true, 'no terms in force at all');
  assert.equal(aheadOfTerms('2026-12-01', '2026-12-01'), false, 'the same change, or the deploy that puts it in force');
  assert.equal(aheadOfTerms('2026-12-01', '2027-01-10'), false, 'a later version keeps it open');
});

test("the only list of languages is Settings' sheet, built from shownLanguages(): nothing else in src/ walks LOCALES", () => {
  const src = new URL('../src/', import.meta.url);
  const sheet = readFileSync(new URL('ui/components/language.ts', src), 'utf8');
  assert.match(sheet, /const codes = shownLanguages\(\);/);
  assert.match(sheet, /\.\.\.codes\.map\(\(c\) => option\(c, LOCALES\[c\]\.name\)\)/, 'its options are those codes');
  const walk = /Object\.(?:keys|entries|values|getOwnPropertyNames)\(\s*LOCALES\b|\b(?:in|of)\s+LOCALES\b|\.\.\.\s*LOCALES\b/;
  const files = readdirSync(src, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).filter((f) => /\.ts$/.test(f) && f !== 'i18n.ts');
  assert.ok(files.includes('ui/components/language.ts'), 'the walk reads src/');
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, src), 'utf8'), walk, `src/${f} walks LOCALES: list shownLanguages() instead`);
});

test('closed: a pt-BR browser with pt saved gets the English page, as before pt.ts', () => {
  assert.equal(I.language(), 'en');
  assert.equal(root.lang, 'en', "the page's lang attribute");
  assert.equal(I.systemLanguage(), 'en', 'the picker\'s "Automatic (...)" entry names English');
  assert.equal(I.savedLanguage(), null, 'the saved pt is ignored: the picker marks Automatic');
  assert.equal(I.t('lang.title'), en['lang.title']);
  assert.equal(I.duration(60_000), new Intl.NumberFormat('en', { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(1));
  assert.equal(I.serverText('lobby', 'rate_limited', 'Creaste demasiadas salas, espera un minuto'), en['error.lobby.rate_limited']);
});

test("closed: Settings' language list has no Portuguese", () => {
  assert.deepEqual(I.shownLanguages(), ['en', 'es']);
  assert.ok(!I.shownLanguages().some((c) => I.LOCALES[c].name.startsWith('Português')));
});

test('open (the helpers): the same browser picks Portuguese and the list shows it', () => {
  assert.equal(I.savedLanguage(true), 'pt', 'the saved choice counts once open');
  assert.equal(I.pickLanguage(storage.getItem('turbogol.lang'), window.navigator.languages, true), 'pt');
  assert.equal(I.pickLanguage(null, ['pt-BR'], true), 'pt');
  assert.deepEqual(I.shownLanguages(true), ['en', 'es', 'pt']);
});

test('pt.ts loads: the endonym, the pt-BR tag and the texts', () => {
  assert.equal(I.LOCALES.pt.name, 'Português (Brasil)');
  assert.equal(I.LOCALES.pt.tag, 'pt-BR');
  assert.equal(say('lang.title'), 'Idioma');
  assert.equal(say('menu.leaveGo'), 'SAIR');
  assert.equal(say('nav.garage'), 'GARAGEM');
  assert.equal(say('search.searching', { count: 1 }), '1 pessoa buscando');
  assert.equal(say('search.searching', { count: 3 }), '3 pessoas buscando');
  // A new host's MY SERVERS card (servers.ts passes matches30d ?? 0): 0 takes the plural.
  assert.equal(say('servers.kpi.matches', { count: 0 }), '0 partidas');
  assert.equal(say('final.goals', { count: 0 }), '0 gols');
  assert.equal(say('final.goals', { count: 1 }), '1 gol');
});

const placeholders = (v) => [...new Set([...(typeof v === 'string' ? [v] : Object.values(v)).join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('pt.ts has every key of en.ts, in its order, with the same kind of value and the same placeholders', () => {
  assert.deepEqual(Object.keys(pt), Object.keys(en), 'the keys of en.ts, in en.ts order, and no others');
  for (const [key, value] of Object.entries(en)) {
    const p = pt[key];
    assert.equal(typeof p, typeof value, `${key}: a ${typeof value === 'string' ? 'text' : 'plural'} in English`);
    assert.ok((typeof p === 'string' ? p : p.other).trim().length > 0, `${key}: empty`);
    assert.deepEqual(placeholders(p), placeholders(value), `${key}: the placeholders of en.ts`);
  }
});
