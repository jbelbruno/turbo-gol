// The legal draft's P4 (Ley 25.326 art. 16.2: a deletion asked by mail, done within 5 business
// days, its certificate within 72 hours): POST /api/admin/account-delete, behind the maintainer gate
// of /nodes/admin/* (a NODE_TRUSTED_OPERATORS account's own session, a password typed in the last
// 15 minutes), deletes a named account now, with no grace, a suspended one or one without an
// address too, through the alarm's purge (its sanction marks, its tombstone), and answers a
// certificate with a reference, the dates and a digest, nothing personal. Through the real Worker
// in front of a real AccountsDO on node:sqlite, as deletion.test.mjs runs them; nothing leaves this
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

// ---- P4: deletion on request -------------------------------------------------------------------------

const adminDelete = (env, bearer, body, ip, o = {}) => post(env, '/api/admin/account-delete', { ip, bearer, body, ...o });

test('P4: a maintainer deletes a named account now (no 14 days): every row of it goes through the alarm\'s purge, its tombstone stays, and the answer is a certificate with a reference, the dates and a digest, nothing personal', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto');
  env.NODE_TRUSTED_OPERATORS = project;
  const boss = await session(project, 'Proyecto', { aal: 2, aat: nowS() });
  const id = await account(obj, 'Mariana', { email: 'mariana@example.com', discord: 'd-mariana' });
  obj.store.sql.exec("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', 1, 'perfil', ?)", id, Date.now());
  const before = Date.now();
  const r = await adminDelete(env, boss, { account: 'mariana', confirm: 'Mariana', receivedAt: new Date(before).toISOString().slice(0, 10) }, ip(0));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const c = r.json.certificate;
  assert.deepEqual(Object.keys(c).sort(), ['deletedAt', 'digest', 'kind', 'receivedAt', 'ref', 'requestedAt', 'text', 'v']);
  assert.deepEqual([c.kind, c.v], ['turbogol-deletion', 1]);
  assert.match(c.ref, /^[0-9a-f]{16}$/);
  assert.ok(c.deletedAt >= before && c.deletedAt <= Date.now());
  assert.equal(c.requestedAt, c.deletedAt, 'asked by mail: the deletion is the request');
  assert.equal(c.receivedAt, Date.UTC(...new Date(before).toISOString().slice(0, 10).split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), 12));
  assert.equal(c.digest, await DO.deletionDigest(c.ref, id, c.deletedAt), 'the owner can tell which account it was from the tombstone');
  const flat = JSON.stringify(c);
  for (const personal of ['Mariana', 'mariana', 'example.com', 'd-mariana', id]) assert.ok(!flat.includes(personal), 'nothing personal: ' + personal);
  assert.match(c.text.es, /^Constancia de borrado de Turbogol \(referencia [0-9a-f]{16}\)\.\nPedido recibido: .+ UTC\.\nCuenta borrada: .+ UTC\.\nHuella: [0-9a-f]{64}\.\n/);
  assert.match(c.text.en, /^Turbogol deletion certificate/);
  // Gone: every row of it; the tombstone stays (its id never handed out again).
  assert.equal(row(obj, id), undefined);
  for (const t of ['refresh', 'consents', 'ratings']) assert.equal(sql(obj, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, id)[0].n, 0, t);
  assert.equal(obj.store.isDeleted(id), true);
  assert.equal(obj.store.accountIdOf('Mariana'), null);
  // Again: nobody by that name now.
  const again = await adminDelete(env, boss, { account: 'Mariana', confirm: 'Mariana' }, ip(0));
  assert.deepEqual([again.status, again.json.error], [404, 'no_user']);
});

test('P4: a suspended account, one without an address, and one already pending in PERFIL go too (its request date kept); a sanction in force leaves its marks; by id as well as by name', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto');
  env.NODE_TRUSTED_OPERATORS = project;
  const boss = await session(project, 'Proyecto', { aal: 2, aat: nowS() });
  const banned = await account(obj, 'Sancionada', { email: 'sancionada@example.com' });
  obj.store.sql.exec('UPDATE users SET banned = 1 WHERE id = ?', banned);
  const b = await adminDelete(env, boss, { account: 'Sancionada', confirm: 'sancionada' }, ip(0));
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(row(obj, banned), undefined);
  assert.ok(sql(obj, 'SELECT COUNT(*) AS n FROM sanction_marks')[0].n >= 1, 'the suspension outlives the purge as a mark');
  const bare = await account(obj, 'Sinmail', { email: null });
  const n = await adminDelete(env, boss, { account: bare, confirm: 'Sinmail' }, ip(0));
  assert.equal(n.status, 200, JSON.stringify(n.json));
  assert.equal(row(obj, bare), undefined);
  const pending = await account(obj, 'Pendiente');
  const asked = Date.now() - 3 * 86_400_000;
  obj.store.sql.exec('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?', asked, Date.now() + 11 * 86_400_000, pending);
  const p = await adminDelete(env, boss, { account: 'Pendiente', confirm: 'Pendiente' }, ip(0));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.certificate.requestedAt, asked, 'the player asked in PERFIL first: that date');
  assert.match(p.json.certificate.text.es, /Borrado pedido en el juego: /);
  assert.equal(p.json.certificate.receivedAt, null, 'no date given');
  assert.equal(row(obj, pending), undefined, 'the 11 days left are not waited');
});

test('P4: the maintainer gate: no session 401, a guest or another account 403, a TV 403 tv_session, a stale or level-1 proof 403 reauth_required { level: 2 }; the project\'s own account is never deleted; the name must be typed right; the Origin + JSON rule; its limit', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const project = await account(obj, 'Proyecto');
  const second = await account(obj, 'Segundo');
  const third = await account(obj, 'Tercero');
  env.NODE_TRUSTED_OPERATORS = `${project},${second},${third}`;
  const target = await account(obj, 'Blanco');
  const body = { account: 'Blanco', confirm: 'Blanco' };
  assert.equal((await adminDelete(env, undefined, body, ip(0))).status, 401);
  const guest = await post(env, '/api/guest', { ip: ip(0), body: {} });
  assert.equal((await adminDelete(env, guest.json.session, body, ip(0))).status, 403);
  const other = await account(obj, 'Otra');
  const o = await adminDelete(env, await session(other, 'Otra', { aal: 2, aat: nowS() }), body, ip(0));
  assert.deepEqual([o.status, o.json.error], [403, 'not_trusted']);
  const tv = await adminDelete(env, await session(project, 'Proyecto', { aal: 2, aat: nowS(), tv: 1 }), body, ip(0));
  assert.deepEqual([tv.status, tv.json.error], [403, 'tv_session']);
  for (const claims of [{}, { aal: 1, aat: nowS() }, { aal: 2, aat: nowS() - A.ADMIN_FRESH_S - 5 }]) {
    const r = await adminDelete(env, await session(project, 'Proyecto', claims), body, ip(0));
    assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], JSON.stringify(claims));
  }
  assert.equal(A.ADMIN_FRESH_S, NR.MAINTAINER_FRESH_S, "the maintainer gate's window, the same as /nodes/admin/*");
  // Another maintainer from here (the refusals above took Proyecto's minute: 10 a minute per account).
  const boss = await session(third, 'Tercero', { aal: 2, aat: nowS() });
  const self = await adminDelete(env, boss, { account: 'Segundo', confirm: 'Segundo' }, ip(0));
  assert.deepEqual([self.status, self.json.error], [409, 'maintainer_account']);
  assert.notEqual(row(obj, second), undefined, 'the project account is never deleted');
  const typo = await adminDelete(env, boss, { account: 'Blanco', confirm: 'Blanca' }, ip(0));
  assert.deepEqual([typo.status, typo.json.error], [400, 'bad_confirm']);
  for (const bad of [{}, { account: '', confirm: 'x' }, { account: 'Blanco' }, { account: 'x'.repeat(65), confirm: 'x' }]) assert.equal((await adminDelete(env, boss, bad, ip(0))).status, 400, JSON.stringify(bad));
  assert.equal((await adminDelete(env, boss, { account: 'Nadie', confirm: 'Nadie' }, ip(0))).json.error, 'no_user');
  assert.equal((await adminDelete(env, boss, body, ip(0), { origin: null })).json.error, 'bad_origin');
  assert.equal((await adminDelete(env, boss, body, ip(0), { origin: 'https://evil.example' })).json.error, 'bad_origin');
  assert.notEqual(row(obj, target), undefined, 'no refusal deleted anything');
  assert.deepEqual(L.accountGate('POST', '/api/admin/account-delete'), ['accountStats'], 'the maintainer routes\' 10 a minute per account');
  // It is open whatever DELETION_OPEN says: answering a request by mail is the law's, not the button's.
  assert.equal(env.DELETION_OPEN, undefined);
  assert.equal((await adminDelete(env, boss, body, ip(0))).status, 200);
  assert.equal(row(obj, target), undefined);
  // That was this minute's 10th: the 11th is over the limit, before the AccountsDO.
  const over = await adminDelete(env, boss, { account: 'Otra', confirm: 'Otra' }, ip(0));
  assert.deepEqual([over.status, over.json.error], [429, 'rate_limited']);
  assert.notEqual(row(obj, other), undefined);
});
