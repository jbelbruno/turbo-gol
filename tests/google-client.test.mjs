// Sign-in PR 11, the client parts without a browser (the server side: server/test/google-idtoken.test.mjs):
// Google never proves level 2 (it cannot be asked for its password again), so no start URL carries a level
// and the level-2 sheet of PERFIL offers no provider, Google included; the in-app browsers (Discord,
// Instagram, Facebook, TikTok, Line) hide Google with the note that says to open the page in a browser,
// and VINCULAR / the sign-in buttons / "confirm it's you" never offer Google there.
//   node --test tests/google-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  // The screens import package.json as Vite does (no `with { type: 'json' }`): its version, as a module.
  load(url, context, nextLoad) {
    if (url.endsWith('/package.json') && context.importAttributes?.type !== 'json') {
      const { version } = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', shortCircuit: true, source: `export const version = ${JSON.stringify(version)}; export default { version: ${JSON.stringify(version)} };` };
    }
    return nextLoad(url, context);
  },
});

const AC = await import('../src/net/AccountClient.ts');
const E = await import('../src/net/emailAuth.ts');
const L = await import('../src/ui/screens/accountLinks.ts');
const es = (await import('../src/locales/es.ts')).default;
const en = (await import('../src/locales/en.ts')).default;

test('oauthUrl: no start URL carries a level (Google cannot be asked for its password again): a sign-in, a link, a re-authentication, the pend sheet and cancelDel are as they were', () => {
  const none = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const acc = new AC.AccountClient({ fetchFn: async () => new Response('{}'), storage: none, session: none });
  assert.equal(acc.oauthUrl.length <= 3, true, 'no level parameter');
  assert.equal(acc.oauthUrl('google', 'reauth'), '/api/auth/oauth/google/start?reauth=1');
  assert.equal(acc.oauthUrl('google', 'reauth', 'discord'), '/api/auth/oauth/google/start?reauth=1&then=link:discord');
  assert.equal(acc.oauthUrl('discord', 'reauth'), '/api/auth/oauth/discord/start?reauth=1');
  assert.equal(acc.oauthUrl('google', true), '/api/auth/oauth/google/start?link=1');
  assert.equal(acc.oauthUrl('google', 'pend'), '/api/auth/oauth/google/start?pend=1');
  assert.equal(acc.oauthUrl('google', 'cancelDel'), '/api/auth/oauth/google/start?cancelDel=1');
  assert.equal(acc.oauthUrl('google'), '/api/auth/oauth/google/start');
  // Whatever extra argument a caller passes, the URL never says lvl.
  for (const provider of ['google', 'discord']) for (const mode of [false, true, 'link', 'reauth', 'pend', 'cancelDel']) assert.doesNotMatch(acc.oauthUrl(provider, mode, 'discord', 2), /lvl|level/);
});

test('inAppBrowser: Discord, Instagram, Facebook, TikTok and Line apps are in-app browsers (the way each writes its name); the usual browsers are not', () => {
  const inApp = [
    // Discord's own browser (desktop and mobile).
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9040 Chrome/120.0.0.0 Electron/28.2.10 Safari/537.36 Discord/1.0.9040',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Discord/278.0',
    // Instagram writes "Instagram 312.0.0.34.111" with a space.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.34.111 (iPhone14,5; iOS 17_2; es_AR; es; scale=3.00; 1170x2532; 548495619)',
    'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android (34/14; 480dpi; 1080x2340; samsung; SM-S911B)',
    'Mozilla/5.0 (Linux; Android 14) Instagram/312.0',
    // Facebook.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/557233567;FBDV/iPhone14,5]',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]',
    // TikTok.
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 musical_ly_2023402030 JsSdk/2.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/34.2.3 BytedanceWebview/d8a21c6',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok 34.2.0 (iPhone14,5)',
    // Line.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.17.0',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Line/13.17.0/IAB',
  ];
  for (const ua of inApp) assert.equal(E.inAppBrowser(ua), true, ua.slice(-60));
  const browsers = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15 Baseline/1.0',
    '',
  ];
  for (const ua of browsers) assert.equal(E.inAppBrowser(ua), false, ua.slice(-60));
});

/** `fn` with navigator.userAgent set (Node has a global navigator; a page has its own). */
function withUserAgent(ua, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

test('the sign-in buttons and the link buttons: Google is configured but hidden inside another app\'s browser (googleHidden says why), and shown in a normal one', () => {
  const menu = { cfg: { oauth: ['google', 'discord'] } };
  const insta = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Mobile/15E148 Instagram 312.0.0.34.111 (iPhone14,5)';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
  withUserAgent(insta, () => {
    assert.deepEqual(L.emailProviders(menu), ['discord']);
    assert.equal(L.googleHidden(menu), true);
    assert.equal(L.providersLine(menu), 'Discord');
  });
  withUserAgent(edge, () => {
    assert.deepEqual(L.emailProviders(menu), ['google', 'discord']);
    assert.equal(L.googleHidden(menu), false);
  });
  // Google not configured (no secrets yet): nothing to hide and nothing to show, in any browser.
  const off = { cfg: { oauth: ['discord'] } };
  withUserAgent(insta, () => {
    assert.deepEqual(L.emailProviders(off), ['discord']);
    assert.equal(L.googleHidden(off), false, 'no note about a button that was never there');
  });
  withUserAgent(edge, () => assert.deepEqual(L.emailProviders(off), ['discord']));
  withUserAgent(edge, () => assert.deepEqual(L.emailProviders({ cfg: { oauth: [] } }), []));
});

test('PERFIL: VINCULAR and "confirm it\'s you" use the providers this browser can sign in with; the level-2 sheet offers none (Google neither) and its note names them all; the in-app note says why Google is missing', () => {
  const profile = readFileSync(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
  const has = (code, why) => assert.ok(profile.includes(code), why + ': ' + code);
  has('const linkable = emailProviders(menu).filter((p) => me && !me.providers.includes(p));', 'VINCULAR never offers Google inside another app');
  has('const own = configured.filter((p) => emailProviders(menu).includes(p));', 'neither does "confirm it is you"');
  has('const offered = level === 1 ? own : [];', 'level 2 offers no provider, as before: a press is level 1');
  has("const ownNames = configured.map((p) => PROVIDER_NAMES[p]).join(` ${t('profile.or')} `);", 'the note names every provider the sheet does not offer at level 2, Google included');
  has('const notEnough = level === 2 && configured.length > 0', 'and shows at level 2');
  has("acc.oauthUrl(p, 'reauth')", 'the provider round trip asks for no level');
  assert.doesNotMatch(profile, /oauthUrl\([^)]*(?:level|lvl)/, 'no screen passes a level to a start');
  has("const inAppNote = level === 1 && configured.includes('google') && googleHidden(menu)", 'the sheet says why Google is missing');
  has("const googleNote = me && !me.providers.includes('google') && googleHidden(menu)", 'and so does the account section');
  // The sign-in tab: the same note beside the buttons that are left.
  has("const note = googleHidden(menu) ? h('p.mn-note', null, t('auth.inAppGoogle'", 'the sign-in tab');
});

test('the in-app note reads "Open turbo-gol.com in your browser to sign in with Google." / "Abre turbo-gol.com en tu navegador para entrar con Google." (neutral tu, no voseo)', () => {
  const fill = (s) => s.replace('{site}', 'turbo-gol.com');
  assert.equal(fill(en['auth.inAppGoogle']), 'Open turbo-gol.com in your browser to sign in with Google.');
  assert.equal(fill(es['auth.inAppGoogle']), 'Abre turbo-gol.com en tu navegador para entrar con Google.');
  assert.equal(es['profile.reauthWith'], 'ENTRAR CON {provider}');
  assert.equal(es['profile.reauthPasswordOrCode'], 'Para esto no alcanza con {providers}: usa tu contraseña o un código por correo.');
  assert.equal(en['profile.reauthPasswordOrCode'], "{providers} isn't enough for this: use your password or a code by email.");
});
