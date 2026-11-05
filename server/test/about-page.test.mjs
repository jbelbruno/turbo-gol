// The about page, the home page of the OAuth consent screen (Google's brand verification reads it):
// /about (docs/about/about.en.md) and /acerca (docs/about/about.es.md), served by legalPages.ts in the
// legal pages' shell as static HTML, while TERMS_VERSION is set and 404 before, as the legal pages
// (legal-pages.test.mjs). It names the app, links the privacy policy at the address the consent
// screen gives, the terms and the game, says what Sign in with Google asks for (the scopes of
// accountRoutes.ts providerConfig, so a scope change fails here), who offers the game and how to
// reach them. Through the real Worker (index.ts); the static assets are a fake that records what it
// is asked, and any network call throws: nothing leaves this machine.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = () => { throw new Error("no wasm in this test"); };';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    if (specifier === './wasm' && context.parentURL !== undefined && context.parentURL.endsWith('/server/src/MatchDO.ts')) return { url: WASM_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
  // wrangler.jsonc's Text rule: a .md import is its text.
  load(url, context, nextLoad) {
    if (url.endsWith('.md')) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')) };
    return nextLoad(url, context);
  },
});

globalThis.fetch = async (url) => {
  throw new Error('BLOCKED network call in a test: ' + String(url instanceof Request ? url.url : url));
};

const A = await import('../src/accountRoutes.ts');
const LP = await import('../src/legalPages.ts');
const worker = (await import('../src/index.ts')).default;

const ORIGIN = 'https://turbo-gol.com';
const DOCS = new URL('../../docs/about/', import.meta.url);
const PAGES = { '/about': ['about.en.md', 'en', '/acerca'], '/acerca': ['about.es.md', 'es', '/about'] };
const LEGAL = ['/terminos', '/privacidad', '/terms', '/privacy'];

/** The Worker's env: the game's index.html as the asset layer (it answers any path, as the SPA fallback does). */
function makeEnv(extra = {}) {
  const assets = [];
  const env = {
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    ASSETS: { fetch: async (r) => (assets.push(new URL(r.url).pathname), new Response('<!doctype html><title>Turbogol</title><div id="app"></div>', { headers: { 'content-type': 'text/html' } })) },
    ...extra,
  };
  return { env, assets };
}

async function req(env, method, path, headers = {}) {
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'CF-Connecting-IP': '198.23.9.1', ...headers } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const get = (env, path, headers) => req(env, 'GET', path, headers);

const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const md = (file) => readFileSync(new URL(file, DOCS), 'utf8').replace(/\r\n?/g, '\n');
/** The page's words on one line, without its style and script. */
const flat = (html) => html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ');
/** The scopes as a sentence names them: `a`, `a and b`, `a, b and c`. */
const listOf = (items, and) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`);

test('about: until TERMS_VERSION is set (unset, empty or malformed), /about and /acerca answer 404 not_found, no-store, for GET and HEAD; the game (its index.html) is never served there', async () => {
  for (const v of [undefined, '', '   ', 'Versión 1', '-lead']) {
    const { env, assets } = makeEnv({ TERMS_VERSION: v });
    for (const path of Object.keys(PAGES)) {
      for (const method of ['GET', 'HEAD']) {
        const r = await req(env, method, path);
        assert.equal(r.status, 404, `${method} ${path} with ${JSON.stringify(v)}`);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        if (method === 'GET') assert.equal(JSON.parse(r.text).error, 'not_found');
      }
    }
    assert.deepEqual(assets, [], 'the asset layer was never asked: no SPA fallback for these paths');
  }
});

test('about: with TERMS_VERSION set, each page is its docs/about text as static HTML in its language, with the legal pages\' policy and headers; HEAD has no body; the ETag answers 304; another method is a 404', async () => {
  const { env, assets } = makeEnv({ TERMS_VERSION: '2026-11-05' });
  const csp = await LP.legalCsp();
  for (const [path, [, lang]] of Object.entries(PAGES)) {
    const r = await get(env, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('content-language'), lang);
    assert.equal(r.headers.get('content-security-policy'), csp, 'the legal pages\' policy');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    for (const [h, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'strict-origin-when-cross-origin'], ['strict-transport-security', 'max-age=31536000; includeSubDomains']]) assert.equal(r.headers.get(h), v, h);
    // The style and the script are the legal pages' ones, and the policy hashes them; nothing else runs or loads.
    assert.equal(/<style>([\s\S]*?)<\/style>/.exec(r.text)[1], LP.LEGAL_CSS);
    assert.equal(/<script>([\s\S]*?)<\/script>/.exec(r.text)[1], LP.LEGAL_JS);
    assert.ok(csp.includes(`style-src 'sha256-${b64(LP.LEGAL_CSS)}'`) && csp.includes(`'sha256-${b64(LP.LEGAL_JS)}'`));
    assert.equal(r.text.match(/<script/g).length, 1);
    assert.doesNotMatch(r.text, /<script src=|<link rel="stylesheet"|<img |<iframe|\sstyle="|\son[a-z]+="/i);
    const head = await req(env, 'HEAD', path);
    assert.deepEqual([head.status, head.text, head.headers.get('etag')], [200, '', r.headers.get('etag')]);
    assert.equal((await get(env, path, { 'if-none-match': r.headers.get('etag') })).status, 304);
    assert.equal((await req(env, 'POST', path)).status, 404);
  }
  assert.deepEqual(assets, [], 'served by the Worker, never the SPA');
});

test('about: the head names Turbogol, describes it (the text\'s first paragraph), gives its canonical address and the other language\'s, and never asks search engines to skip it', async () => {
  const { env } = makeEnv({ TERMS_VERSION: 'v1' });
  for (const [path, [file, lang, other]] of Object.entries(PAGES)) {
    const r = await get(env, path);
    assert.match(r.text, new RegExp(`^<!doctype html>\\n<html lang="${lang}">\\n<head>\\n`));
    assert.ok(r.text.includes('<title>Turbogol</title>'), 'the title is the app name');
    assert.ok(r.text.includes('<main id="texto">\n<h1 id="turbogol">Turbogol</h1>\n<p>'), 'its first heading, then the description, in the HTML: no script needed');
    assert.equal(/^# (.+)$/m.exec(md(file))[1], 'Turbogol');
    const lead = md(file).split(/\n\n/)[1].replace(/\s+/g, ' ');
    assert.ok(lead.startsWith('Turbogol '), file);
    assert.ok(r.text.includes(`<meta name="description" content="${LP.escapeHtml(lead)}">`), `${path}: the first paragraph is the description`);
    assert.ok(r.text.includes(`<link rel="canonical" href="${ORIGIN}${path}">`));
    assert.ok(r.text.includes(`<link rel="alternate" hreflang="${lang}" href="${ORIGIN}${path}">`));
    assert.ok(r.text.includes(`<link rel="alternate" hreflang="${PAGES[other][1]}" href="${ORIGIN}${other}">`));
    assert.doesNotMatch(r.text, /noindex|nofollow|name="robots"/i);
    assert.equal(r.headers.get('x-robots-tag'), null);
  }
});

test('about: the title and the description are the text\'s words escaped, whatever they hold: no markup, no way out of the attribute, no other script', () => {
  const html = LP.aboutDocument({ path: '/about', lang: 'en', source: '# A "<b>"\n\nLead "><script>x</script> & \'q\'\n\n[l](javascript:alert(1))\n' });
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)[1], 'A &quot;&lt;b&gt;&quot;');
  assert.equal(/<meta name="description" content="([^"]*)">/.exec(html)[1], 'Lead &quot;&gt;&lt;script&gt;x&lt;/script&gt; &amp; &#39;q&#39;');
  assert.doesNotMatch(html, /"><script>|<b>|javascript:/);
  assert.equal(html.match(/<script/g).length, 1);
});

test('about: the page links the game, the privacy policy at the consent screen\'s address (and, in Spanish, the official text), the terms, the source code and privacy@turbo-gol.com; its bar goes to the game and the other language only, with no version and no contents', async () => {
  const { env } = makeEnv({ TERMS_VERSION: '2026-11-05' });
  const LINKS = {
    '/about': [['https://turbo-gol.com/', 'Play'], ['https://turbo-gol.com/privacy', 'Privacy Policy'], ['https://turbo-gol.com/terms', 'Terms of use']],
    '/acerca': [['https://turbo-gol.com/', 'Jugar'], ['https://turbo-gol.com/privacidad', 'Política de privacidad'], ['https://turbo-gol.com/privacy', 'Privacy Policy'], ['https://turbo-gol.com/terminos', 'Términos de uso'], ['https://turbo-gol.com/terms', 'Terms of use']],
  };
  for (const [path, [, lang, other]] of Object.entries(PAGES)) {
    const r = await get(env, path);
    const main = /<main id="texto">([\s\S]*?)<\/main>/.exec(r.text)[1];
    for (const [href, words] of LINKS[path]) assert.ok(main.includes(`<a href="${href}" rel="noopener noreferrer">${words}</a>`), `${path}: ${words}`);
    // The privacy policy right under the description, before any section.
    assert.ok(main.indexOf('href="https://turbo-gol.com/privacy"') < main.indexOf('<h2 '), `${path}: the privacy policy near the top`);
    assert.ok(main.includes('<a href="https://github.com/DonJaimeHash/turbo-gol" rel="noopener noreferrer">'), 'the source code');
    assert.ok(main.includes('<!--email_off--><a href="mailto:privacy@turbo-gol.com">privacy@turbo-gol.com</a><!--/email_off-->'), 'the contact, kept from the zone\'s obfuscation');
    assert.ok(main.includes('Helianova'), 'who offers it, as the privacy policy\'s section 1 says');
    // No address outside the markers, and none but the privacy one.
    const rest = r.text.replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, '');
    assert.doesNotMatch(rest, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}|mailto:/i);
    assert.deepEqual([...new Set([...r.text.matchAll(/[A-Za-z0-9._%+-]+@turbo-gol\.com/g)].map((m) => m[0]))], ['privacy@turbo-gol.com']);
    // The bar and the footer: the game and the other language; no terms <-> privacy switch, no version line, no contents.
    const bar = /<header class="bar">([\s\S]*?)<\/header>/.exec(r.text)[1];
    assert.deepEqual([...bar.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]), ['/', other]);
    assert.ok(bar.includes(`hreflang="${PAGES[other][1]}" lang="${PAGES[other][1]}"`));
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(r.text)[1];
    assert.deepEqual([...footer.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]), [other]);
    assert.doesNotMatch(r.text, /Versi(?:ón|on) (?:de los textos|of the texts)|2026-11-05|class="toc"/);
    assert.ok(bar.startsWith(`<a href="/">${lang === 'es' ? 'Jugar' : 'Play'}</a>`), 'the way to the game first');
  }
});

test("about: the sign-in with Google section names exactly the scopes accountRoutes.ts asks Google for (openid email: the account's id and its address, never the name or the picture), what they are for, what is kept, how to unlink or delete, and points to the privacy policy", async () => {
  const google = A.providerConfig({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' }, 'google');
  assert.equal(google.scope, 'openid email', 'a new scope needs the about page (and the privacy policy) to say what it reads first');
  const scopes = google.scope.split(' ').map((s) => `<code>${s}</code>`);
  const { env } = makeEnv({ TERMS_VERSION: 'v1' });
  const en = flat((await get(env, '/about')).text);
  const es = flat((await get(env, '/acerca')).text);
  assert.ok(en.includes('<h2 id="sign-in-with-google">Sign in with Google</h2>'));
  assert.ok(es.includes('<h2 id="entrar-con-google">Entrar con Google</h2>'));
  assert.ok(en.includes(`we ask Google only for the ${listOf(scopes, 'and')} scopes.`), 'the scope sentence, in English');
  assert.ok(es.includes(`solo le pedimos a Google los permisos (scopes) ${listOf(scopes, 'y')}.`), 'the scope sentence, in Spanish');
  // Each page's code words are the scopes and nothing else.
  for (const page of [en, es]) assert.deepEqual([...page.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => `<code>${m[1]}</code>`), scopes);
  // What they give, what it is for, what is not asked for, the Limited Use statement, unlink and delete.
  for (const words of [
    'only for your Turbogol account: to create it, to sign you in to it (also when you confirm it is you before an important change) and to send you its emails.',
    'Google gives us your Google account identifier and your email address',
    'We do not ask for your name, your picture, your contacts, your Gmail, your Drive or any other Google data.',
    'it identifies your account, and the game sends your account&#39;s emails to it',
    'we do not sell your data or share it for advertising',
    'including the Limited Use requirements',
    'in PROFILE you can unlink Google',
    'or delete your account (DELETE ACCOUNT, with 14 days to cancel the deletion)',
  ])
    assert.ok(en.includes(words), words);
  for (const words of [
    'solo para tu cuenta de Turbogol: para crearla, para que entres en ella (también cuando confirmas que eres tú antes de un cambio importante) y para mandarte sus correos.',
    'Google nos da el identificador de tu cuenta de Google y tu dirección de correo',
    'No pedimos tu nombre, tu foto, tus contactos, tu Gmail, tu Drive ni ningún otro dato de Google.',
    'identifica tu cuenta, y es adonde el juego manda los correos de tu cuenta',
    'no vendemos tus datos ni los compartimos para publicidad',
    'incluidos los requisitos de uso limitado',
    'en PERFIL puedes desvincular Google',
    'o borrar tu cuenta (BORRAR CUENTA, con 14 días para cancelar el borrado)',
  ])
    assert.ok(es.includes(words), words);
  assert.ok(en.includes('The details are in the <a href="https://turbo-gol.com/privacy" rel="noopener noreferrer">Privacy Policy</a>'));
  assert.ok(es.includes('Los detalles están en la <a href="https://turbo-gol.com/privacidad" rel="noopener noreferrer">Política de privacidad</a>'));
  // The privacy policy says the same of the scopes (its section 4.2, in both languages).
  const legal = (f) => readFileSync(new URL(`../../docs/legal/${f}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(legal('privacy.en.md').includes('From Google ("openid" and "email" permissions)'));
  assert.ok(legal('privacidad.es.md').includes('De Google (permisos «openid» y «email»)'));
  // The UI words the page names are the game's (PROFILE's buttons, the sign-in button).
  const locale = (f) => readFileSync(new URL(`../../src/locales/${f}`, import.meta.url), 'utf8');
  for (const [f, words] of [['en.ts', ["'nav.profile': 'PROFILE'", "'delete.button': 'DELETE ACCOUNT'", "'profile.signInWith': 'Sign in with {provider}'"]], ['es.ts', ["'nav.profile': 'PERFIL'", "'delete.button': 'BORRAR CUENTA'", "'profile.signInWith': 'Entrar con {provider}'"]]])
    for (const w of words) assert.ok(locale(f).includes(w), `${f}: ${w}`);
});

test('about: the Spanish text is the English one translated: the same headings, paragraphs, items, links and code; neutral Spanish (tú, no voseo)', () => {
  const shape = (text) => {
    const r = LP.renderMarkdown(text);
    return ['<h1 ', '<h2 ', '<p>', '<li>', '<strong>', '<a href=', '<code>', 'mailto:'].map((tag) => r.html.split(tag).length - 1);
  };
  assert.deepEqual(shape(md('about.es.md')), shape(md('about.en.md')));
  const hrefs = (text) => [...LP.renderMarkdown(text).html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1].replace('/privacidad', '/privacy').replace('/terminos', '/terms')).sort();
  assert.deepEqual(hrefs(md('about.es.md')), hrefs(md('about.en.md')), 'the same links, each language its own text first');
  // Voseo: present tense in -ás / -és / -ís and imperatives in -á / -é / -í (tests/i18n-es.test.mjs), the standard words allowed.
  const allowed = new Set(['está', 'más', 'también', 'qué', 'así', 'aquí', 'ahí', 'sí', 'después', 'según', 'aún', 'atrás', 'país', 'inglés']);
  const es = md('about.es.md');
  const bad = [...es.matchAll(/(?<![\p{L}])(\p{L}+(?:á|é|í|ás|és|ís))(?![\p{L}])/gu)].map((m) => m[1]).filter((w) => !allowed.has(w.toLowerCase()));
  bad.push(...[...es.matchAll(/(?<![\p{L}])(vos|sos)(?![\p{L}])/giu)].map((m) => m[1]));
  assert.deepEqual(bad, []);
});

test('about: wrangler.jsonc routes /about and /acerca to the Worker before the asset layer and bundles docs/about/*.md as text; index.ts sends them to legalPages.ts', () => {
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  for (const p of [...Object.keys(PAGES), ...LEGAL]) assert.ok(cfg.assets.run_worker_first.includes(p), p);
  assert.ok(cfg.rules.some((r) => r.type === 'Text' && r.globs.includes('**/*.md')), 'docs/about/*.md too');
  assert.match(cfg.vars.TERMS_VERSION, /^[a-z0-9._-]{1,32}$/, 'production serves them');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /path === '\/about' \|\| path === '\/acerca'\) return \(await import\('\.\/legalPages'\)\)\.legalPage\(request, env\);/);
  assert.deepEqual(Object.keys(LP.ABOUT_PAGES), Object.keys(PAGES));
});

test('about: the four legal pages keep their own shell: the contents, the other text, the other language and the version, with nothing of the about page (no description, no canonical address, no link to /about or /acerca)', async () => {
  const { env } = makeEnv({ TERMS_VERSION: 'v1' });
  const sibling = { '/terminos': '/privacidad', '/privacidad': '/terminos', '/terms': '/privacy', '/privacy': '/terms' };
  for (const path of LEGAL) {
    const r = await get(env, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.text, LP.legalDocument(LP.LEGAL_PAGES[path], 'v1'), `${path}: the legal shell, as before`);
    const bar = /<header class="bar">([\s\S]*?)<\/header>/.exec(r.text)[1];
    assert.equal([...bar.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])[1], sibling[path], `${path}: the other text`);
    assert.ok(r.text.includes('<nav class="toc"'), `${path}: the contents`);
    assert.match(r.text, /<footer><p>Versi(?:ón de los textos|on of the texts): v1<\/p>/);
    assert.doesNotMatch(r.text, /name="description"|rel="canonical"|href="\/about"|href="\/acerca"/, path);
  }
});
