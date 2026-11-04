// The legal draft's P12 (docs/legal/*.md; preguntas-abogado.md §3), dark until the owner publishes:
// /terminos, /privacidad, /terms and /privacy (legalPages.ts) are served only while TERMS_VERSION is
// set, else 404 as an unknown route (never the SPA fallback), each with its own CSP that allows only
// its hashed style and script; the renderer escapes the owner's Markdown and keeps only safe links;
// GET /api/config's legal tells the client; wrangler.jsonc keeps production dark. Through the real
// Worker (index.ts) in front of a real AccountsDO on node:sqlite, as news-consent.test.mjs runs them;
// the providers, the mail binding, Turnstile and the static assets are fakes: nothing leaves this
// machine.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
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

// ---- the fakes: the providers, Turnstile ---------------------------------------------------------
const identity = { google: { sub: 'g-default' }, discord: { id: 'd-default' } };
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token' || u === 'https://discord.com/api/v10/oauth2/token') return ok({ access_token: 'fake-access' });
  if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return ok(identity.google);
  if (u === 'https://discord.com/api/v10/users/@me') return ok(identity.discord);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const body = new URLSearchParams(await new Response(init?.body).text());
    return ok({ success: body.get('response') === 'good-token' });
  }
  throw new Error('BLOCKED network call in a test: ' + u);
};

const DO = await import('../src/AccountsDO.ts');
const { AccountsDO } = DO;
const A = await import('../src/accountRoutes.ts');
const ACC = await import('../../src/net/account.ts');
const AUTH = await import('../src/auth.ts');
const ENV = await import('../src/env.ts');
const NR = await import('../src/nodeRoutes.ts');
const L = await import('../src/limits.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'legal-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const TOK = { turnstileToken: 'good-token' };
const PW = 'la clave larga de prueba';
const KEY = await ACC.passwordKey(PW);
const DOCS = new URL('../../docs/legal/', import.meta.url);
const PAGES = { '/terminos': ['terminos.es.md', 'es'], '/privacidad': ['privacidad.es.md', 'es'], '/terms': ['terms.en.md', 'en'], '/privacy': ['privacy.en.md', 'en'] };

function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

function txOn(db) {
  let depth = 0;
  return (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
}

/** The Worker's env: a real AccountsDO, the game's index.html as the asset layer (it answers any path, as the SPA fallback does). */
function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  const outbox = [];
  const assets = [];
  const env = {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    TURNSTILE_DISABLED: '1',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    DISCORD_CLIENT_ID: 'did',
    DISCORD_CLIENT_SECRET: 'dsec',
    EMAIL: { send: async (m) => void outbox.push(m) },
    MAIL_LIVE: '1',
    MAIL_FROM: 'Turbogol <no-reply@turbo-gol.com>',
    MAIL_LINK_ORIGIN: ORIGIN,
    ASSETS: { fetch: async (r) => (assets.push(new URL(r.url).pathname), new Response('<!doctype html><title>Turbogol</title><div id="app"></div>', { headers: { 'content-type': 'text/html' } })) },
    ...extra,
  };
  let alarm = null;
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, outbox, assets, alarm: () => alarm };
}

let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.23.${base}.${i + 1}`;
};

const cookieOf = (r, name) => {
  for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean)) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c ?? '');
    if (m) return m[1];
  }
  return null;
};

async function req(env, method, path, { ip = '198.23.0.1', origin = ORIGIN, bearer, cookie, body, headers: extra = {} } = {}) {
  const headers = { 'CF-Connecting-IP': ip, ...extra };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json, location: res.headers.get('location'), raw: res };
}
const get = (env, path, o = {}) => req(env, 'GET', path, { origin: null, ...o });
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });

const sql = (obj, q, ...b) => obj.store.sql.exec(q, ...b).toArray();
const row = (obj, id) => sql(obj, 'SELECT * FROM users WHERE id = ?', id)[0];
const termsRows = (obj, id) => sql(obj, "SELECT version, granted, source FROM consents WHERE user_id = ? AND kind = 'terms' ORDER BY id", id);
const nowS = () => Math.floor(Date.now() / 1000);
const session = (id, name, extra) => AUTH.signJwt(SECRET, { typ: 's', sub: id, name, iat: nowS(), exp: nowS() + 600, acct: 1, ...extra });
const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;

/** An account made straight in the store: a current password (KEY), a verified address unless `email: null`, a Discord id. */
async function account(obj, name, { email = name.toLowerCase() + '@example.com', discord } = {}) {
  const rec = await A.newPasswordRecord(KEY, 2);
  const id = obj.store.register(name, rec, [], 'e'.repeat(63) + String(name.length % 10), Date.now()).userId;
  obj.store.sql.exec('DELETE FROM refresh WHERE user_id = ?', id);
  if (discord) obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ? WHERE id = ?', discord, Date.now(), id);
  if (email) assert.equal(obj.store.claimEmail(id, email, 'mail', Date.now()), 'ok');
  return id;
}

/** A whole email sign-up by code (§2.2); `acceptTerms` as the client sends it (absent: none). */
async function signUp(env, outbox, email, ip, acceptTerms) {
  const st = await post(env, '/api/auth/signup/start', { ip, body: { email, lang: 'es', ...TOK } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const code = codeIn(outbox.at(-1));
  const f = await post(env, '/api/auth/signup/finish', { ip, body: { attempt: st.json.attempt, code, username: 'Nueva' + Math.floor(Math.random() * 1e6), password: KEY, lang: 'es', tz: '', news: false, ...(acceptTerms === undefined ? {} : { acceptTerms }) } });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  return f.json;
}

async function oauth(env, provider, who, ip) {
  identity[provider] = who;
  const start = await req(env, 'GET', `/api/auth/oauth/${provider}/start`, { ip, origin: null });
  assert.equal(start.status, 302, JSON.stringify(start.json));
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const nonce = new URL(start.location).searchParams.get('state');
  const done = await req(env, 'GET', `/api/auth/oauth/${provider}/callback?code=x&state=${nonce}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { done, pend: cookieOf(done.raw, '__Host-tg_pend') };
}

const b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

// ---- P12: the pages ---------------------------------------------------------------------------------

test('P12: until TERMS_VERSION is set (unset, empty or malformed), /terminos, /privacidad, /terms and /privacy answer 404 not_found, no-store, for GET and HEAD; the game (its index.html) is never served there', async () => {
  for (const v of [undefined, '', '   ', 'Versión 1', 'x'.repeat(40), '-lead']) {
    const { env, assets } = makeEnv({ TERMS_VERSION: v });
    for (const path of Object.keys(PAGES)) {
      for (const method of ['GET', 'HEAD']) {
        const r = await req(env, method, path, { origin: null });
        assert.equal(r.status, 404, `${method} ${path} with ${JSON.stringify(v)}`);
        assert.equal(r.headers.get('cache-control'), 'no-store', 'the publish shows at once');
        if (method === 'GET') assert.equal(r.json?.error, 'not_found');
      }
    }
    assert.deepEqual(assets, [], 'the asset layer was never asked: no SPA fallback for these paths');
  }
  // Anything else still goes to the game, as before.
  const { env, assets } = makeEnv();
  assert.equal((await get(env, '/terminos-y-mas')).status, 200);
  assert.deepEqual(assets, ['/terminos-y-mas']);
});

test('P12: with TERMS_VERSION set, each page is its docs/legal text as HTML, in its language, with the contents, the other text, the other language and the version; HEAD has no body; the ETag answers 304; another method is a 404', async () => {
  const { env, assets } = makeEnv({ TERMS_VERSION: ' 2026-12-01 ' });
  for (const [path, [file, lang]] of Object.entries(PAGES)) {
    const md = readFileSync(new URL(file, DOCS), 'utf8');
    const r = await get(env, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('content-language'), lang);
    assert.match(r.text, new RegExp(`^<!doctype html>\\n<html lang="${lang}">`));
    const title = /^# (.+)$/m.exec(md)[1];
    assert.ok(r.text.includes(`<title>${title}</title>`), `${path}: its first heading is the title`);
    assert.ok(r.text.includes(`<h1 id=`), path);
    // Every second-level heading is a section, with an entry in the contents.
    const sections = md.split('\n').filter((l) => /^## /.test(l)).length;
    assert.equal((r.text.match(/<h2 id="(?!toc-h)/g) ?? []).length, sections, `${path}: every ## heading`);
    assert.equal((r.text.match(/<li><a href="#/g) ?? []).length, sections, `${path}: the contents`);
    assert.ok(r.text.includes(lang === 'es' ? 'Versión de los textos: 2026-12-01' : 'Version of the texts: 2026-12-01'), 'the version in force, trimmed');
    const other = lang === 'es' ? { '/terminos': '/terms', '/privacidad': '/privacy' }[path] : { '/terms': '/terminos', '/privacy': '/privacidad' }[path];
    assert.ok(r.text.includes(`href="${other}"`), `${path}: the other language`);
    assert.ok(r.text.includes('href="/"'), 'the way back to the game');
    // Nothing of the Markdown is left as text outside code (a ** or a table's pipe), and no raw HTML of the text gets through.
    const outsideCode = r.text.replace(/<code>[\s\S]*?<\/code>/g, '').replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(outsideCode, /\*\*|^\|/m, path);
    const head = await req(env, 'HEAD', path, { origin: null });
    assert.deepEqual([head.status, head.text, head.headers.get('etag')], [200, '', r.headers.get('etag')]);
    assert.equal((await get(env, path, { headers: { 'if-none-match': r.headers.get('etag') } })).status, 304);
    assert.equal((await req(env, 'POST', path, { origin: null })).status, 404);
  }
  assert.deepEqual(assets, [], 'served by the Worker, never the SPA');
});

test('P12: the pages run nothing they do not name: their CSP allows their one style and one script by SHA-256 (no unsafe-inline, no style attribute, no handler), nothing to frame, post or fetch elsewhere; the game\'s other headers too', async () => {
  const { env } = makeEnv({ TERMS_VERSION: 'v1' });
  for (const path of Object.keys(PAGES)) {
    const r = await get(env, path);
    const csp = r.headers.get('content-security-policy');
    const styles = [...r.text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const scripts = [...r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(styles.length, 1);
    assert.equal(scripts.length, 1);
    assert.ok(csp.includes(`style-src 'sha256-${b64(styles[0])}'`), 'the style by its hash');
    assert.ok(csp.includes(`'sha256-${b64(scripts[0])}'`), 'the script by its hash');
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    for (const d of ["default-src 'none'", "script-src-attr 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(d), d);
    // The zone's beacon and email decoder, as public/_headers allows them, so they never show a violation.
    assert.match(csp, /script-src 'self' 'sha256-[^']+' https:\/\/static\.cloudflareinsights\.com/);
    assert.doesNotMatch(r.text, /\sstyle="/, 'a style attribute would need unsafe-inline');
    assert.doesNotMatch(r.text, /\son[a-z]+="/i, 'no inline handler');
    assert.doesNotMatch(r.text, /<script src=|<link rel="stylesheet"|<img |<iframe/, 'nothing to load');
    for (const [h, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'strict-origin-when-cross-origin'], ['strict-transport-security', 'max-age=31536000; includeSubDomains']]) assert.equal(r.headers.get(h), v, h);
    assert.match(r.headers.get('permissions-policy'), /camera=\(\), microphone=\(\), geolocation=\(\)/);
  }
});

test('P12: the renderer escapes the text and keeps only safe links; headings get ids; lists nest; a table stacks on a phone with each cell\'s column name; the remote script walks links and scrolls', async () => {
  const LP = await import('../src/legalPages.ts');
  const r = LP.renderMarkdown(
    [
      '# Título <script>alert(1)</script>',
      '',
      'Un *énfasis*, **negrita**, `código <b>` y [un enlace](https://example.com/x?a=1&b=2), <https://auto.example/>.',
      '[malo](javascript:alert) y [otro](data:text/html,x) y [local](/privacidad) y "comillas" & más.',
      '',
      '## 1. Sección uno',
      '',
      '1. **Primero:**',
      '   - a',
      '   - b',
      '2. Segundo, en dos',
      '   líneas.',
      '',
      '> - citado',
      '>',
      '> texto',
      '',
      '| Qué | Para qué |',
      '|---|---|',
      '| `__Host-tg_rt` | La sesión \\| sigue |',
      '',
      '## 1. Sección uno',
      '---',
    ].join('\n'),
  );
  assert.equal(r.title, 'Título <script>alert(1)</script>', 'the title as words (the page escapes it)');
  assert.ok(r.html.includes('<h1 id="titulo-script-alert-1-script">Título &lt;script&gt;alert(1)&lt;/script&gt;</h1>'));
  assert.ok(!r.html.includes('<script>'));
  assert.ok(r.html.includes('<em>énfasis</em>') && r.html.includes('<strong>negrita</strong>') && r.html.includes('<code>código &lt;b&gt;</code>'));
  assert.ok(r.html.includes('<a href="https://example.com/x?a=1&amp;b=2" rel="noopener noreferrer">un enlace</a>'));
  assert.ok(r.html.includes('<a href="https://auto.example/" rel="noopener noreferrer">https://auto.example/</a>'));
  assert.ok(!/javascript:|data:text/.test(r.html), 'an unsafe link keeps only its text');
  assert.ok(r.html.includes('malo y otro y <a href="/privacidad">local</a> y &quot;comillas&quot; &amp; más.'));
  assert.ok(r.html.includes('<ol><li><strong>Primero:</strong>\n<ul><li>a</li><li>b</li></ul></li><li>Segundo, en dos\nlíneas.</li></ol>'), r.html);
  assert.ok(r.html.includes('<blockquote><ul><li>citado</li></ul>\n<p>texto</p></blockquote>'), r.html);
  assert.ok(r.html.includes('<td data-label="Qué"><code>__Host-tg_rt</code></td><td data-label="Para qué">La sesión | sigue</td>'), r.html);
  assert.deepEqual(r.toc, [{ id: '1-seccion-uno', text: '1. Sección uno' }, { id: '1-seccion-uno-2', text: '1. Sección uno' }], 'one id per heading');
  assert.ok(r.html.endsWith('<hr>'));
  assert.equal(LP.slugOf('12.4 Marcas de sanción'), '12-4-marcas-de-sancion');
  // The phone's stacked table reads the column's name from the cell (no style attribute anywhere).
  assert.match(LP.LEGAL_CSS, /@media \(max-width:600px\)\{[\s\S]*\.tbl td::before\{content:attr\(data-label\)/);
  // The remote: ▲ ▼ focus the next link in sight or scroll; Back (Escape, Backspace, Tizen 10009, webOS 461) goes back or to the game.
  for (const part of ["k==='ArrowDown'", "k==='ArrowUp'", 'c===10009', 'c===461', "k==='Backspace'", 'window.scrollBy(0,dir*Math.round(vh*0.6))', "location.href='/'", 'pick.focus()']) assert.ok(LP.LEGAL_JS.includes(part), part);
  // Every page of docs/legal renders without leaving a heading, a list or a table behind as text.
  for (const [, [file]] of Object.entries(PAGES)) {
    const out = LP.renderMarkdown(readFileSync(new URL(file, DOCS), 'utf8')).html;
    assert.doesNotMatch(out.replace(/<code>[\s\S]*?<\/code>/g, ''), /^(?:#{1,6} |[-*] |\d+\. |\||>)/m, file);
  }
});

test("P12: Cloudflare's Email Address Obfuscation (on for the zone) leaves the addresses alone: each one a page shows, and each mailto link whole, goes out between <!--email_off--> and <!--/email_off-->, never nested; the style, the script and their hashes stay as they are", async () => {
  const LP = await import('../src/legalPages.ts');
  const OFF = '<!--email_off-->';
  const ON = '<!--/email_off-->';
  assert.deepEqual([LP.EMAIL_OFF, LP.EMAIL_ON], [OFF, ON], "Cloudflare's own markers");
  // Every form the texts use: an autolink, a link with words, a bare address (in a sentence, in a
  // table, in a heading), one in code and in bold code.
  const r = LP.renderMarkdown(
    [
      '# Contacto',
      '',
      'Escríbenos a <mailto:privacy@turbo-gol.com>, o a [nuestro buzón](mailto:privacy@turbo-gol.com), o a privacy@turbo-gol.com. Desde `no-reply@turbo-gol.com` y **`no-reply@turbo-gol.com`**; <https://turbo-gol.com/x> no es un correo.',
      '',
      '| Qué | Dónde |',
      '|---|---|',
      '| **Domicilio** | Electrónico: privacy@turbo-gol.com |',
      '',
      '## 15. Contacto: privacy@turbo-gol.com',
    ].join('\n'),
  );
  assert.ok(r.html.includes(`a ${OFF}<a href="mailto:privacy@turbo-gol.com">privacy@turbo-gol.com</a>${ON}, o a`), r.html);
  assert.ok(r.html.includes(`${OFF}<a href="mailto:privacy@turbo-gol.com">nuestro buzón</a>${ON}`), 'a link with words: its href');
  assert.ok(r.html.includes(`o a ${OFF}privacy@turbo-gol.com${ON}. Desde`), "a bare address, the sentence's period outside");
  assert.ok(r.html.includes(`<code>${OFF}no-reply@turbo-gol.com${ON}</code> y <strong><code>${OFF}no-reply@turbo-gol.com${ON}</code></strong>`), 'in code');
  assert.ok(r.html.includes(`<td data-label="Dónde">Electrónico: ${OFF}privacy@turbo-gol.com${ON}</td>`), 'in a table');
  assert.ok(r.html.includes(`<h2 id="15-contacto-privacy-turbo-gol-com">15. Contacto: ${OFF}privacy@turbo-gol.com${ON}</h2>`), 'in a heading');
  assert.ok(r.html.includes('<a href="https://turbo-gol.com/x" rel="noopener noreferrer">https://turbo-gol.com/x</a>'), 'a web link as before');
  /** The page without its kept parts; each kept part holds no marker of its own (they do not nest). */
  const outside = (html) => {
    assert.equal(html.split(OFF).length, html.split(ON).length, 'as many ends as starts');
    return html.replace(/<!--email_off-->([\s\S]*?)<!--\/email_off-->/g, (_, inner) => {
      assert.ok(!inner.includes(OFF), 'never nested');
      return '';
    });
  };
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
  const left = outside(r.html);
  assert.doesNotMatch(left, EMAIL, left);
  assert.doesNotMatch(left, /mailto:/i);
  // The contents list the heading with its address kept too.
  const page = LP.legalDocument({ path: '/privacidad', lang: 'es', doc: 'privacy', source: ['# Política', '', '## 15. Contacto: privacy@turbo-gol.com', '', 'Texto.'].join('\n') }, 'v1');
  assert.ok(page.includes(`<li><a href="#15-contacto-privacy-turbo-gol-com">15. Contacto: ${OFF}privacy@turbo-gol.com${ON}</a></li>`));
  // Through the Worker, the four pages of docs/legal: no address and no mailto outside the markers;
  // the style and the script are the module's, untouched, and the policy hashes those.
  const { env } = makeEnv({ TERMS_VERSION: 'v1' });
  const csp = await LP.legalCsp();
  assert.ok(csp.includes(`style-src 'sha256-${b64(LP.LEGAL_CSS)}'`) && csp.includes(`'sha256-${b64(LP.LEGAL_JS)}'`));
  assert.ok(!LP.LEGAL_CSS.includes('email_off') && !LP.LEGAL_JS.includes('email_off'));
  for (const [path, [file]] of Object.entries(PAGES)) {
    const res = await get(env, path);
    assert.equal(res.headers.get('content-security-policy'), csp, path);
    assert.equal(/<style>([\s\S]*?)<\/style>/.exec(res.text)[1], LP.LEGAL_CSS, path);
    assert.equal(/<script>([\s\S]*?)<\/script>/.exec(res.text)[1], LP.LEGAL_JS, path);
    const rest = outside(res.text);
    assert.doesNotMatch(rest, EMAIL, path);
    assert.doesNotMatch(rest, /mailto:/i, path);
    if (EMAIL.test(readFileSync(new URL(file, DOCS), 'utf8'))) assert.ok(res.text.includes(OFF), `${path}: its addresses kept`);
  }
});

test('P12: GET /api/config says what is published: legal.terms (null until TERMS_VERSION is set), legal.deletion (DELETION_OPEN) and the days to cancel', async () => {
  const dark = makeEnv();
  assert.deepEqual((await get(dark.env, '/api/config')).json.legal, { terms: null, deletion: false, graceDays: 14 });
  const open = makeEnv({ TERMS_VERSION: '2026-12-01', DELETION_OPEN: '1', DELETE_GRACE: 7 });
  assert.deepEqual((await get(open.env, '/api/config')).json.legal, { terms: '2026-12-01', deletion: true, graceDays: 7 });
  for (const [v, want] of [[undefined, null], ['', null], [' V1 ', 'v1'], ['2026-12-01', '2026-12-01'], ['a b', null], ['x'.repeat(33), null]]) assert.equal(ENV.termsVersion({ TERMS_VERSION: v }), want, JSON.stringify(v));
});

test('P12: production is published: wrangler.jsonc routes the four paths to the Worker first, bundles docs/legal/*.md as text, sets TERMS_VERSION to the version in the four texts\' headers and opens DELETION_OPEN; no text keeps a [[token]] or a draft mark', () => {
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  for (const p of Object.keys(PAGES)) assert.ok(cfg.assets.run_worker_first.includes(p), p);
  assert.ok(cfg.rules.some((r) => r.type === 'Text' && r.globs.includes('**/*.md')));
  const version = cfg.vars.TERMS_VERSION;
  assert.match(version, /^[a-z0-9._-]{1,32}$/, 'published');
  assert.equal(cfg.vars.DELETION_OPEN, '1', 'open with the terms');
  for (const [file] of Object.values(PAGES)) {
    const text = readFileSync(new URL(file, DOCS), 'utf8');
    assert.match(text, new RegExp('^# .+\\n\\nVersi(?:ón|on) ' + version.replace(/\./g, '\\.') + '\\. '), file + ': the header says the version in force');
    assert.doesNotMatch(text, /\[\[|\[(?:CÓDIGO|ABOGADO|A CONFIRMAR|VERIFICAR)|BORRADOR/, file + ': no token or draft mark left');
  }
});
