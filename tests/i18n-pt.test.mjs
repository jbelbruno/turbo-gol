// The Portuguese page (src/locales/pt.ts): a pt-BR browser gets the game in Portuguese, and the
// server's Spanish detail messages do not leak into it (src/i18n.ts serverText only keeps them for
// Spanish). Outside a browser the page is English (tests/i18n.test.mjs), so this file fakes a pt-BR
// browser before loading src/i18n.ts; node --test runs each test file in its own process.
// Run: node --test tests/i18n-pt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// A browser whose language is pt-BR, without storage: src/i18n.ts picks Portuguese when it loads.
globalThis.window = { navigator: { languages: ['pt-BR'], language: 'pt-BR' } };

const I = await import('../src/i18n.ts');

test('the page is Portuguese', () => {
  assert.equal(I.language(), 'pt');
  assert.equal(I.t('lang.title'), 'Idioma');
  assert.equal(I.t('menu.leaveGo'), 'SAIR');
  assert.equal(I.t('nav.garage'), 'GARAGEM');
});

test('the picker shows the endonym and Intl formats as pt-BR', () => {
  assert.equal(I.LOCALES.pt.name, 'Português (Brasil)');
  assert.equal(I.LOCALES.pt.tag, 'pt-BR');
  const minute = new Intl.NumberFormat('pt-BR', { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(1);
  assert.equal(I.duration(60_000), minute);
});

test('serverText: the client Portuguese text for a code the Spanish server details', () => {
  assert.equal(I.serverText('lobby', 'rate_limited', 'Creaste demasiadas salas, espera un minuto'), I.t('error.lobby.rate_limited'));
  assert.equal(I.serverText('lobby', 'no_such_code', 'Mensaje del servidor'), 'Mensaje del servidor');
});
