// The legal draft's P1, P2 and P33 (the acceptance of the terms), dark until the owner publishes:
// signup/finish's and the OAuth confirm step's acceptTerms are recorded as a consents row of kind
// 'terms' only for the version in force (TERMS_VERSION); POST /api/me/consent { kind: 'terms',
// version } is the re-accept after a change (a TV's session too); /api/me says the version accepted.
// Through the real Worker in front of a real AccountsDO on node:sqlite, as news-consent.test.mjs
// runs them; the providers, the mail binding and Turnstile are fakes: nothing leaves this machine.
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

// ---- P1, P2, P33: the acceptance ---------------------------------------------------------------------

test('P1, P2: signup/finish records acceptTerms as a consents row of kind terms (source signup) only when it is the version in force; unpublished, stale or junk: no row', async () => {
  const dark = makeEnv();
  const ip = ips();
  const a = await signUp(dark.env, dark.outbox, 'sin.terminos@example.com', ip(0), 'v1');
  assert.deepEqual(termsRows(dark.obj, a.playerId), [], 'unpublished: nothing recorded, whatever a page sends');
  const { env, obj, outbox } = makeEnv({ TERMS_VERSION: 'v2' });
  const stale = await signUp(env, outbox, 'vieja@example.com', ip(1), 'v1');
  assert.deepEqual(termsRows(obj, stale.playerId), [], 'a page of before the change: the re-accept sheet will ask');
  const junk = await signUp(env, outbox, 'basura@example.com', ip(2), { v: 'v2' });
  assert.deepEqual(termsRows(obj, junk.playerId), []);
  const none = await signUp(env, outbox, 'nada@example.com', ip(3));
  assert.deepEqual(termsRows(obj, none.playerId), []);
  const ok = await signUp(env, outbox, 'acepta@example.com', ip(4), 'v2');
  assert.deepEqual(termsRows(obj, ok.playerId), [{ version: 'v2', granted: 1, source: 'signup' }]);
  const me = await get(env, '/api/me', { bearer: ok.session, ip: ip(4) });
  assert.equal(me.json.terms, 'v2', '/api/me says the version it accepted');
  assert.equal((await get(env, '/api/me', { bearer: stale.session, ip: ip(1) })).json.terms, null);
});

test('P1, P2: the OAuth confirm step\'s create records acceptTerms (source oauth_signup) for the version in force only', async () => {
  const { env, obj } = makeEnv({ TERMS_VERSION: 'v2' });
  const ip = ips();
  const a = await oauth(env, 'discord', { id: 'd-acepta' }, ip(0));
  assert.equal(a.done.location, '/#auth=confirm');
  const made = await post(env, '/api/auth/pending/create', { ip: ip(0), cookie: '__Host-tg_pend=' + a.pend, body: { username: 'Acepta', news: false, lang: 'es', tz: '', acceptTerms: 'v2', ...TOK } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(termsRows(obj, made.json.playerId), [{ version: 'v2', granted: 1, source: 'oauth_signup' }]);
  const b = await oauth(env, 'discord', { id: 'd-vieja' }, ip(1));
  const old = await post(env, '/api/auth/pending/create', { ip: ip(1), cookie: '__Host-tg_pend=' + b.pend, body: { username: 'Vieja', news: false, lang: 'es', tz: '', acceptTerms: 'v1', ...TOK } });
  assert.equal(old.status, 200, JSON.stringify(old.json));
  assert.deepEqual(termsRows(obj, old.json.playerId), []);
});

test('P33: the re-accept: POST /api/me/consent { kind: "terms", version } writes a "reaccept" row for the version in force, once per version; another version is 409 terms_changed with the one in force; a TV accepts on its own screen; unpublished it is refused as before (400 bad_consent); a deletion pending writes nothing', async () => {
  const { env, obj } = makeEnv({ TERMS_VERSION: 'v2' });
  const ip = ips();
  const id = await account(obj, 'Vuelve');
  const s = await session(id, 'Vuelve');
  const accept = (bearer, version, i = 0) => post(env, '/api/me/consent', { ip: ip(i), bearer, body: { kind: 'terms', version } });
  assert.equal((await get(env, '/api/me', { bearer: s, ip: ip(0) })).json.terms, null, 'an account of before: none accepted');
  const r = await accept(s, 'v2');
  assert.deepEqual([r.status, r.json], [200, { news: false, terms: 'v2' }]);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await accept(s, 'v2')).json, { news: false, terms: 'v2' });
  assert.deepEqual(termsRows(obj, id), [{ version: 'v2', granted: 1, source: 'reaccept' }], 'a second press writes nothing');
  assert.equal((await get(env, '/api/me', { bearer: s, ip: ip(0) })).json.terms, 'v2');
  const changed = await accept(s, 'v1');
  assert.deepEqual([changed.status, changed.json.error, changed.json.version], [409, 'terms_changed', 'v2']);
  for (const body of [{ kind: 'terms' }, { kind: 'terms', version: '' }, { kind: 'terms', version: 'x'.repeat(65) }, { kind: 'terms', version: 2 }]) {
    const bad = await post(env, '/api/me/consent', { ip: ip(0), bearer: s, body });
    assert.deepEqual([bad.status, bad.json.error], [400, 'bad_consent'], JSON.stringify(body));
  }
  // A TV signed in with the phone: accepting the terms changes no credential.
  const tvId = await account(obj, 'Tele');
  const tv = await accept(await session(tvId, 'Tele', { tv: 1 }), 'v2', 1);
  assert.deepEqual([tv.status, tv.json.terms], [200, 'v2']);
  // The news kind stays a full session's.
  assert.equal((await post(env, '/api/me/consent', { ip: ip(1), bearer: await session(tvId, 'Tele', { tv: 1 }), body: { kind: 'news', granted: false } })).json.error, 'tv_session');
  // A guest, or no session: refused.
  const guest = await post(env, '/api/guest', { ip: ip(2), body: {} });
  assert.equal((await accept(guest.json.session, 'v2', 2)).status, 403);
  assert.equal((await post(env, '/api/me/consent', { ip: ip(2), body: { kind: 'terms', version: 'v2' } })).status, 401);
  // Its Origin + JSON rule (R1), as the news kind's.
  assert.equal((await post(env, '/api/me/consent', { ip: ip(0), origin: null, bearer: s, body: { kind: 'terms', version: 'v2' } })).json.error, 'bad_origin');
  // A deletion pending: nothing written.
  const goneId = await account(obj, 'Seva');
  obj.store.sql.exec('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?', Date.now(), Date.now() + 86_400_000, goneId);
  const pend = await accept(await session(goneId, 'Seva'), 'v2', 3);
  assert.deepEqual([pend.status, pend.json.error], [409, 'deletion_pending']);
  assert.deepEqual(termsRows(obj, goneId), []);
  // Unpublished: the answer of before the kind existed.
  const dark = makeEnv();
  const did = await account(dark.obj, 'Oscura');
  const off = await post(dark.env, '/api/me/consent', { ip: ip(4), bearer: await session(did, 'Oscura'), body: { kind: 'terms', version: 'v2' } });
  assert.deepEqual([off.status, off.json.error], [400, 'bad_consent']);
  assert.deepEqual(termsRows(dark.obj, did), []);
});
