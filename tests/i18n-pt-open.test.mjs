// The Portuguese page once legal version (c) is in force: this process loads src/i18n.ts with
// PT_LEGAL_VERSION set (a load hook rewrites that one line of the source for this test only; the
// shipped constant stays null, tests/i18n-pt.test.mjs checks it). A pt-BR browser then gets the game
// in Portuguese, Intl formats as pt-BR, and the server's Spanish detail messages do not leak into
// it (serverText only keeps them for Spanish).
// Run: node --test tests/i18n-pt-open.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const I18N = new URL('../src/i18n.ts', import.meta.url).href;
const CLOSED = 'export const PT_LEGAL_VERSION: string | null = null;';
let opened = false;

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
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== I18N) return loaded;
    const src = String(loaded.source);
    opened = src.includes(CLOSED);
    return { ...loaded, source: src.replace(CLOSED, "export const PT_LEGAL_VERSION: string | null = 'test-c';") };
  },
});

// A browser whose language is pt-BR, without storage: src/i18n.ts picks Portuguese when it loads.
globalThis.window = { navigator: { languages: ['pt-BR'], language: 'pt-BR' } };
const root = { lang: '' };
globalThis.document = { documentElement: root };

const I = await import('../src/i18n.ts');

test('the hook opened the gate (the line it rewrites is still in src/i18n.ts)', () => {
  assert.ok(opened, `src/i18n.ts no longer has: ${CLOSED}`);
  assert.equal(I.PT_LEGAL_VERSION, 'test-c');
  assert.equal(I.portugueseOpen(), true);
});

test('the page is Portuguese', () => {
  assert.equal(I.language(), 'pt');
  assert.equal(I.systemLanguage(), 'pt');
  assert.equal(root.lang, 'pt-BR', "the page's lang attribute carries the region");
  assert.equal(I.t('lang.title'), 'Idioma');
  assert.equal(I.t('menu.leaveGo'), 'SAIR');
  assert.equal(I.t('nav.garage'), 'GARAGEM');
  assert.deepEqual(I.shownLanguages(), ['en', 'es', 'pt'], "Settings' list shows it");
});

test('the picker shows the endonym and Intl formats as pt-BR', () => {
  assert.equal(I.LOCALES.pt.name, 'Português (Brasil)');
  const minute = new Intl.NumberFormat('pt-BR', { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(1);
  assert.equal(I.duration(60_000), minute);
});

test('serverText: the client Portuguese text for a code the Spanish server details', () => {
  assert.equal(I.serverText('lobby', 'rate_limited', 'Creaste demasiadas salas, espera un minuto'), I.t('error.lobby.rate_limited'));
  assert.notEqual(I.t('error.lobby.rate_limited'), 'Creaste demasiadas salas, espera un minuto');
  assert.equal(I.serverText('lobby', 'no_such_code', 'Mensaje del servidor'), 'Mensaje del servidor');
});
