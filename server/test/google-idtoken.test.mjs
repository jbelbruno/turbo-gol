// Sign-in PR 11 (the design's PR 11 "Google", §2.7, §3.8, R6, I1): Google is read from the id_token
// of its token answer, not from a userinfo endpoint. The start sends the scope "openid email" and an
// OpenID Connect nonce kept in the state cookie; the callback checks iss, aud, exp and nonce (the
// token came from Google's token endpoint over TLS, so no signature is checked: OIDC Core 3.1.3.7),
// reads sub, email, email_verified and hd, and sets the trust: 'auth' for a Gmail address without hd
// (it claims the canon), 'asserted' for any other verified address, 'none' otherwise. Google proves
// level 1 at most (a press on its account chooser): its prompt takes only none, consent and
// select_account, max_age is not documented and auth_time is not in the id_token unless asked for, so
// every Google flow asks for select_account and an id_token with a fresh auth_time raises nothing.
// Through the real Worker (index.ts) in front of a real AccountsDO on node:sqlite; Google is a fake
// token endpoint and the userinfo endpoint is BLOCKED (nothing leaves this machine).
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { googleTokenAnswer, idToken, googleClaims, watchGoogleStarts } from './helpers/google.mjs';
import { makeAccount } from './helpers/accounts.mjs';

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
});

// ---- the fake token endpoints ------------------------------------------------------------------------
/** What the fake Google token endpoint answers next (a function of nothing: the test sets it), and every request it got. */
const fakeGoogle = { answer: () => new Response('{}', { status: 500 }), requests: [] };
const fakeDiscord = { user: { id: 'd-default' } };
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  const ok = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') {
    fakeGoogle.requests.push(new URLSearchParams(String(init?.body)));
    return fakeGoogle.answer();
  }
  if (u === 'https://discord.com/api/v10/oauth2/token') return ok({ access_token: 'fake-discord-access' });
  if (u === 'https://discord.com/api/v10/users/@me') return ok(fakeDiscord.user);
  // Includes https://openidconnect.googleapis.com/v1/userinfo: the callback must not call it any more.
  throw new Error('BLOCKED network call in a test: ' + u);
};

const { AccountsDO } = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const AUTH = await import('../src/auth.ts');
const worker = watchGoogleStarts((await import('../src/index.ts')).default);

const SECRET = 'google-idtoken-test-secret';
const ORIGIN = 'https://turbo-gol.com';

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

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  const env = {
    JWT_SECRET: SECRET,
    VITE_ORIGINS: ORIGIN,
    FLAGS: { get: async () => null },
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsec',
    DISCORD_CLIENT_ID: 'did',
    DISCORD_CLIENT_SECRET: 'dsec',
    TURNSTILE_DISABLED: '1',
    ...extra,
  };
  let alarm = null;
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, db };
}

// Every test speaks from networks of its own: the Worker's per-network pre-filters live for the file.
let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.30.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieLine = (r, name) => setCookies(r).find((c) => c.startsWith(name + '=')) ?? null;
const cookieOf = (r, name) => {
  const line = cookieLine(r, name);
  const v = line === null ? null : /^[^=]+=([^;]*)/.exec(line)[1];
  return v === '' ? null : v;
};
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
const users = (obj) => obj.store.sql.exec('SELECT * FROM users ORDER BY created_at, id').toArray();
const nowS = () => Math.floor(Date.now() / 1000);

async function req(env, method, path, { ip = '198.30.0.1', origin = ORIGIN, bearer, cookie, body } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
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
    json = text;
  }
  return { status: res.status, headers: res.headers, json, location: res.headers.get('location'), raw: res };
}
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });

/**
 * Google's round trip. The start (with "query" and the browser's "cookie"), then the fake token
 * endpoint answers "who" as claims (the nonce of that very start filled in, "over" on top, or the
 * whole token answer by "answer"), then the callback with the state cookie and "pend".
 */
async function google(env, who, { query = '', cookie, pend, ip = '198.30.250.1', over = {}, answer, code = 'the-code' } = {}) {
  const start = await req(env, 'GET', `/api/auth/oauth/google/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const q = new URL(start.location).searchParams;
  fakeGoogle.answer = () => new Response(JSON.stringify(answer ? answer({ nonce: q.get('nonce'), state: claims(state) }) : googleTokenAnswer(who, over)), { status: 200, headers: { 'content-type': 'application/json' } });
  const jar = ['__Host-tg_oa=' + state, ...(pend ? ['__Host-tg_pend=' + pend] : [])].join('; ');
  const done = await req(env, 'GET', `/api/auth/oauth/google/callback?code=${code}&state=${q.get('state')}`, { ip, cookie: jar, origin: null });
  return { start, done, st: claims(state), q, rt: cookieOf(done.raw, '__Host-tg_rt'), pend: cookieOf(done.raw, '__Host-tg_pend') };
}

/** The sign-up of a Google identity nobody owns: the callback, the confirm sheet's CREAR. */
async function signUp(env, who, name, ip, over = {}) {
  const r = await google(env, who, { ip, over });
  assert.equal(r.done.location, '/#auth=confirm', JSON.stringify(r.done.json));
  const made = await post(env, '/api/auth/pending/create', { ip, cookie: '__Host-tg_pend=' + r.pend, body: { username: name } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  return { id: made.json.playerId, rt: cookieOf(made.raw, '__Host-tg_rt'), made };
}

const refresh = (env, rt, ip) => post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });

// ---- the start ---------------------------------------------------------------------------------------

test('the start: scope "openid email", an OpenID Connect nonce kept in the state cookie (apart from the state), prompt=select_account at level 1, and nothing else asked of Google', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const s = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(0), origin: null });
  assert.equal(s.status, 302);
  const loc = new URL(s.location);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = loc.searchParams;
  assert.deepEqual(
    [q.get('client_id'), q.get('redirect_uri'), q.get('response_type'), q.get('scope'), q.get('prompt'), q.get('code_challenge_method'), q.get('max_age')],
    ['gid', 'https://turbo-gol.com/api/auth/oauth/google/callback', 'code', 'openid email', 'select_account', 'S256', null],
  );
  assert.match(q.get('state'), /^[A-Za-z0-9_-]{16,}$/);
  assert.match(q.get('nonce'), /^[A-Za-z0-9_-]{16,}$/);
  assert.notEqual(q.get('nonce'), q.get('state'), 'the nonce is not the state');
  assert.ok(!/profile/.test(q.get('scope')), 'never the profile scope');
  const st = claims(cookieOf(s.raw, '__Host-tg_oa'));
  assert.equal(st.nc, q.get('nonce'), 'the nonce travels in the signed state cookie');
  assert.equal(st.n, q.get('state'));
  assert.equal(st.lvl, 1);
  assert.equal(st.iat, undefined, 'no time is kept: nothing reads an auth_time');
  // Another start, another nonce.
  const s2 = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(1), origin: null });
  assert.notEqual(new URL(s2.location).searchParams.get('nonce'), q.get('nonce'));
  // A link and the confirm sheet's "I already have one" ask for the account chooser too, with a nonce.
  const pend = await req(env, 'GET', '/api/auth/oauth/google/start?pend=1', { ip: ip(2), origin: null });
  assert.equal(new URL(pend.location).searchParams.get('prompt'), 'select_account');
  assert.ok(new URL(pend.location).searchParams.get('nonce'));
});

test('the start: EVERY Google flow asks for prompt=select_account (a press on the account chooser), never prompt=login or max_age, whatever lvl says; the state carries level 1 and no time; Discord is untouched', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const { id, rt } = await signUp(env, { sub: 'g-ana' }, 'Ana', ip(0));
  const cookie = '__Host-tg_rt=' + rt;
  // [flow, query]: a sign-in, a link, the confirm sheet's "I already have one", cancelDel and the re-authentications, each with and without a stray lvl.
  const flows = [
    ['sign-in', ''],
    ['sign-in, lvl=2', '?lvl=2'],
    ['link', '?link=1'],
    ['link, lvl=2', '?link=1&lvl=2'],
    ['pend', '?pend=1'],
    ['pend, lvl=2', '?pend=1&lvl=2'],
    ['cancelDel', '?cancelDel=1'],
    ['reauth', '?reauth=1'],
    ['reauth, lvl=2', '?reauth=1&lvl=2'],
    ['reauth, lvl=2 first', '?lvl=2&reauth=1'],
    ['reauth, lvl=2 then link', '?reauth=1&lvl=2&then=link:discord'],
    ['reauth, lvl=1 / 3 / empty / junk', '?reauth=1&lvl=1&lvl=3&lvl=&lvl=login'],
    ['reauth, prompt=login in the query', '?reauth=1&lvl=2&prompt=login&max_age=0&auth_time=1'],
  ];
  let i = 0;
  for (const [flow, query] of flows) {
    const r = await req(env, 'GET', '/api/auth/oauth/google/start' + query, { ip: ip(1 + (i++ % 15)), cookie, origin: null });
    assert.equal(r.status, 302, flow);
    const loc = new URL(r.location);
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth', flow);
    const q = loc.searchParams;
    assert.deepEqual(
      [q.get('client_id'), q.get('redirect_uri'), q.get('response_type'), q.get('scope'), q.get('prompt'), q.get('max_age'), q.get('code_challenge_method')],
      ['gid', 'https://turbo-gol.com/api/auth/oauth/google/callback', 'code', 'openid email', 'select_account', null, 'S256'],
      flow,
    );
    assert.deepEqual(q.getAll('prompt'), ['select_account'], flow + ': one prompt');
    assert.match(q.get('state'), /^[A-Za-z0-9_-]{16,}$/, flow);
    assert.match(q.get('nonce'), /^[A-Za-z0-9_-]{16,}$/, flow);
    assert.notEqual(q.get('nonce'), q.get('state'), flow + ': the nonce is not the state');
    for (const k of q.keys()) assert.ok(['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt'].includes(k), flow + ': unexpected parameter ' + k);
    const st = claims(cookieOf(r.raw, '__Host-tg_oa'));
    assert.deepEqual([st.lvl, st.nc, st.n, st.iat, st.sil], [1, q.get('nonce'), q.get('state'), undefined, undefined], flow);
    assert.equal(st.exp - nowS() <= 600 && st.exp - nowS() > 590, true, flow + ': ten minutes');
    // The flags are the plain ones: only a re-authentication carries the account, only a link carries it as the link.
    assert.deepEqual([st.re === id, st.link === id], [query.includes('reauth=1'), query.includes('link=1')], flow);
  }
  // Another start, another nonce; the nonce never repeats across a hundred.
  const nonces = new Set();
  for (let k = 0; k < 30; k++) nonces.add(new URL((await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(16 + (k % 4)), origin: null })).location).searchParams.get('nonce'));
  assert.equal(nonces.size, 30);
  // Discord is untouched: no nonce, prompt=consent, level 1, whatever lvl says.
  const d = await req(env, 'GET', '/api/auth/oauth/discord/start?reauth=1&lvl=2', { ip: ip(20), cookie, origin: null });
  const dq = new URL(d.location).searchParams;
  assert.deepEqual([new URL(d.location).origin, dq.get('prompt'), dq.get('max_age'), dq.get('nonce'), dq.get('scope')], ['https://discord.com', 'consent', null, null, 'identify email']);
  const dst = claims(cookieOf(d.raw, '__Host-tg_oa'));
  assert.deepEqual([dst.lvl, dst.nc, dst.iat], [1, undefined, undefined]);
});

test('the state of a Google start made before this build (no nonce) is refused as bad_state before our secret goes to Google; Discord states need no nonce', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const start = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(0), origin: null });
  const q = new URL(start.location).searchParams;
  // The state cookie the previous build made: the same fields, no `nc`, no `iat`.
  const { nc, ...old } = claims(cookieOf(start.raw, '__Host-tg_oa'));
  assert.ok(nc);
  const oldCookie = await (await import('../src/auth.ts')).signJwt(SECRET, old);
  fakeGoogle.requests.length = 0;
  fakeGoogle.answer = () => new Response(JSON.stringify(googleTokenAnswer({ sub: 'g-vieja' }, { nonce: q.get('nonce') })), { status: 200 });
  const cb = await req(env, 'GET', `/api/auth/oauth/google/callback?code=x&state=${q.get('state')}`, { ip: ip(0), cookie: '__Host-tg_oa=' + oldCookie, origin: null });
  assert.equal(cb.location, '/#auth=error:bad_state');
  assert.equal(fakeGoogle.requests.length, 0, 'Google was not asked');
  assert.match(cookieLine(cb.raw, '__Host-tg_oa'), /Max-Age=0/);
  assert.equal(users(obj).length, 0);
  // A new start works at once.
  const again = await google(env, { sub: 'g-vieja' }, { ip: ip(1) });
  assert.equal(again.done.location, '/#auth=confirm');
  // Discord's state never had a nonce and still signs in.
  fakeDiscord.user = { id: 'd-sin-nonce' };
  const ds = await req(env, 'GET', '/api/auth/oauth/discord/start', { ip: ip(2), origin: null });
  assert.equal(claims(cookieOf(ds.raw, '__Host-tg_oa')).nc, undefined);
  const dcb = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=x&state=${new URL(ds.location).searchParams.get('state')}`, { ip: ip(2), cookie: '__Host-tg_oa=' + cookieOf(ds.raw, '__Host-tg_oa'), origin: null });
  assert.equal(dcb.location, '/#auth=confirm');
});

test('without both secrets Google stays off: no entry in GET /api/config, the start answers 404 provider_disabled and the callback fails', async () => {
  const { env } = makeEnv({ GOOGLE_CLIENT_SECRET: undefined });
  const ip = ips();
  assert.deepEqual((await req(env, 'GET', '/api/config', { ip: ip(0) })).json.oauth, ['discord']);
  const s = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(0), origin: null });
  assert.deepEqual([s.status, s.json.error], [404, 'provider_disabled']);
  const cb = await req(env, 'GET', '/api/auth/oauth/google/callback?code=x&state=y', { ip: ip(0), origin: null });
  assert.equal(cb.location, '/#auth=error:provider_disabled');
  const both = makeEnv();
  assert.deepEqual((await req(both.env, 'GET', '/api/config', { ip: ip(1) })).json.oauth, ['google', 'discord']);
  assert.deepEqual(A.enabledProviders({ GOOGLE_CLIENT_ID: 'x' }), []);
  assert.deepEqual(A.enabledProviders({ GOOGLE_CLIENT_SECRET: 'x' }), []);
});

// ---- the trust of an address ---------------------------------------------------------------------------

test('trust: a Gmail address without hd is auth (googlemail.com too, read as gmail.com); an hd address and an outside domain are asserted; unverified or missing is none', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const cases = [
    // [who, trust, the address the pending cookie keeps]
    [{ sub: 'g-1', email: 'Ana.Perez@Gmail.com', email_verified: true }, 'auth', 'ana.perez@gmail.com'],
    [{ sub: 'g-2', email: 'ana.perez@googlemail.com', email_verified: true }, 'auth', 'ana.perez@googlemail.com'],
    [{ sub: 'g-3', email: 'ana+juego@gmail.com', email_verified: 'true' }, 'auth', 'ana+juego@gmail.com'],
    [{ sub: 'g-4', email: 'ana@miescuela.edu.ar', email_verified: true, hd: 'miescuela.edu.ar' }, 'asserted', 'ana@miescuela.edu.ar'],
    [{ sub: 'g-5', email: 'ana@gmail.com', email_verified: true, hd: 'gmail.com' }, 'asserted', 'ana@gmail.com'],
    [{ sub: 'g-6', email: 'ana@gmail.com', email_verified: true, hd: '' }, 'asserted', 'ana@gmail.com'],
    [{ sub: 'g-7', email: 'ana@outlook.com', email_verified: true }, 'asserted', 'ana@outlook.com'],
    [{ sub: 'g-8', email: 'ana@gmail.com.example.org', email_verified: true }, 'asserted', 'ana@gmail.com.example.org'],
    [{ sub: 'g-9', email: 'ana@notgmail.com', email_verified: true }, 'asserted', 'ana@notgmail.com'],
    [{ sub: 'g-10', email: 'ana@gmail.com', email_verified: false }, 'none', null],
    [{ sub: 'g-11', email: 'ana@gmail.com', email_verified: 'false' }, 'none', null],
    [{ sub: 'g-12', email: 'ana@gmail.com' }, 'none', null],
    [{ sub: 'g-13', email_verified: true }, 'none', null],
    [{ sub: 'g-14', email: 'not an address', email_verified: true }, 'none', null],
  ];
  let i = 0;
  for (const [who, trust, email] of cases) {
    const r = await google(env, who, { ip: ip(i++) });
    assert.equal(r.done.location, '/#auth=confirm', JSON.stringify(who));
    const pc = claims(r.pend);
    assert.deepEqual([pc.p, pc.id, pc.trust, pc.email], ['google', who.sub, trust, email], JSON.stringify(who));
    const info = await post(env, '/api/auth/pending', { ip: ip(i), cookie: '__Host-tg_pend=' + r.pend });
    assert.deepEqual([info.json.trust, info.json.email], [trust, email]);
  }
  assert.equal(users(obj).length, 0, 'the callback creates nothing (I3)');
  // The profile claims of the id_token never leave the callback: no name, no picture in the cookie or the table.
  const prof = await google(env, { sub: 'g-prof', email: 'pilar@gmail.com', email_verified: true, name: 'Pilar Núñez', given_name: 'Pilar', family_name: 'Núñez', picture: 'https://lh3.googleusercontent.com/a/pilar', locale: 'es' }, { ip: ip(i++) });
  assert.doesNotMatch(Buffer.from(prof.pend.split('.')[1], 'base64url').toString(), /Pilar|googleusercontent|locale/);
  const made = await post(env, '/api/auth/pending/create', { ip: ip(i), cookie: '__Host-tg_pend=' + prof.pend, body: { username: 'Pilarcita' } });
  assert.equal(made.status, 200);
  assert.doesNotMatch(JSON.stringify(users(obj)), /Pilar N|googleusercontent|"es"/);
  assert.equal(row(obj, made.json.playerId).username, 'Pilarcita');
});

test('trust: the claim and the hint follow it: auth claims the canon at CREAR (email_proof google, other hints of it gone), asserted becomes the hint, none leaves no email', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const auth = await signUp(env, { sub: 'g-auth', email: 'A.na@gmail.com', email_verified: true }, 'Ana', ip(0));
  const a = row(obj, auth.id);
  assert.deepEqual([a.email, a.email_canon, a.email_proof, a.email_hint, a.email_verified_at > 0], ['a.na@gmail.com', 'ana@gmail.com', 'google', null, true]);
  // A hint of that canon is a match (via 'hint'), so CREAR refuses it; an owner who signs in and claims the canon clears it.
  const other = makeAccount(obj.store, 'Otra');
  assert.equal(obj.store.setEmailHint(other.userId, 'tomi@gmail.com', 'discord'), 'ok');
  const hinted = await google(env, { sub: 'g-tomi', email: 'tomi@gmail.com', email_verified: true }, { ip: ip(5) });
  const hm = await post(env, '/api/auth/pending/create', { ip: ip(5), cookie: '__Host-tg_pend=' + hinted.pend, body: { username: 'Tomi' } });
  assert.deepEqual([hm.status, hm.json.error], [409, 'email_has_account']);
  const tomi = makeAccount(obj.store, 'Tomi');
  const claim = await google(env, { sub: 'g-Tomi', email: 'tomi@gmail.com', email_verified: true }, { ip: ip(6) });
  assert.equal(claim.done.location, '/#auth=ok');
  assert.deepEqual([row(obj, tomi.userId).email_canon, row(obj, tomi.userId).email_proof], ['tomi@gmail.com', 'google']);
  assert.equal(row(obj, other.userId).email_hint, null, 'a hint never points at a claimed address');
  const asserted = await signUp(env, { sub: 'g-asserted', email: 'bea@escuela.edu.ar', email_verified: true, hd: 'escuela.edu.ar' }, 'Bea', ip(1));
  const b = row(obj, asserted.id);
  assert.deepEqual([b.email, b.email_canon, b.email_hint, b.email_hint_from], [null, null, 'bea@escuela.edu.ar', 'google']);
  const none = await signUp(env, { sub: 'g-none', email: 'cleo@gmail.com', email_verified: false }, 'Cleo', ip(2));
  const c = row(obj, none.id);
  assert.deepEqual([c.email, c.email_canon, c.email_hint], [null, null, null]);
  // The same Gmail with a dot or a +tag is the same canon.
  const again = await google(env, { sub: 'g-auth-2', email: 'ana+otra@googlemail.com', email_verified: true }, { ip: ip(3) });
  const info = await post(env, '/api/auth/pending', { ip: ip(3), cookie: '__Host-tg_pend=' + again.pend });
  assert.deepEqual([info.json.match.name, info.json.match.via], ['Ana', 'email'], 'one email, one account');
});

// ---- a claimed or held canon is a match, not a claim ------------------------------------------------------

test('a Gmail address (auth) whose canon another account claimed turns into a match: the confirm sheet sends the person to that account, CREAR is 409 email_has_account, nothing is claimed or created', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const owner = makeAccount(obj.store, 'Duena', { email: 'ana@gmail.com' });
  const before = users(obj).length;
  const r = await google(env, { sub: 'g-intruso', email: 'a.n.a+x@gmail.com', email_verified: true }, { ip: ip(0) });
  assert.equal(r.done.location, '/#auth=confirm');
  assert.equal(claims(r.pend).trust, 'auth');
  const info = await post(env, '/api/auth/pending', { ip: ip(0), cookie: '__Host-tg_pend=' + r.pend });
  assert.deepEqual([info.json.match.name, info.json.match.via, info.json.match.methods], ['Duena', 'email', ['google']]);
  const made = await post(env, '/api/auth/pending/create', { ip: ip(0), cookie: '__Host-tg_pend=' + r.pend, body: { username: 'Intruso' } });
  assert.deepEqual([made.status, made.json.error], [409, 'email_has_account']);
  assert.equal(users(obj).length, before, 'no account made');
  assert.deepEqual([row(obj, owner.userId).email_canon, row(obj, owner.userId).google_sub], ['ana@gmail.com', 'g-Duena'], 'the owner is untouched');
  // An account that signs in by its own Google id and has no address does not take a claimed canon either.
  const lonely = makeAccount(obj.store, 'Sola');
  const s = await google(env, { sub: 'g-Sola', email: 'ana@gmail.com', email_verified: true }, { ip: ip(1) });
  assert.equal(s.done.location, '/#auth=ok');
  assert.deepEqual([row(obj, lonely.userId).email, row(obj, lonely.userId).email_canon, row(obj, lonely.userId).email_hint], [null, null, null]);
  assert.equal(row(obj, owner.userId).email_canon, 'ana@gmail.com');
});

test('a Gmail address (auth) whose canon an email change holds for its undo is a match too (held), never a claim', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const mover = makeAccount(obj.store, 'Mudada', { email: 'vieja@gmail.com' });
  // The 7-day hold of the old canon (accountStore.ts email_holds), as an email change leaves it.
  obj.store.sql.exec("UPDATE users SET email = 'nueva@example.org', email_canon = 'nueva@example.org' WHERE id = ?", mover.userId);
  obj.store.sql.exec('INSERT INTO email_holds (canon, user_id, email, until) VALUES (?, ?, ?, ?)', 'vieja@gmail.com', mover.userId, 'vieja@gmail.com', Date.now() + 5 * 86_400_000);
  const r = await google(env, { sub: 'g-ladron', email: 'vieja@gmail.com', email_verified: true }, { ip: ip(0) });
  assert.equal(r.done.location, '/#auth=confirm');
  const info = await post(env, '/api/auth/pending', { ip: ip(0), cookie: '__Host-tg_pend=' + r.pend });
  assert.deepEqual([info.json.match.name, info.json.match.via], ['Mudada', 'email']);
  const made = await post(env, '/api/auth/pending/create', { ip: ip(0), cookie: '__Host-tg_pend=' + r.pend, body: { username: 'Ladron' } });
  assert.deepEqual([made.status, made.json.error], [409, 'email_has_account']);
  assert.equal(users(obj).length, 1);
  // An account without an address does not take the held canon either (the store refuses the claim).
  const sola = makeAccount(obj.store, 'Linkeo');
  const hold = obj.store.canonState('vieja@gmail.com', Date.now());
  assert.equal(hold.kind, 'held');
  assert.equal(obj.store.claimEmail(sola.userId, 'vieja@gmail.com', 'google', Date.now()), 'taken', 'the store refuses the claim of a held canon');
});

test('accounts are found by google_sub, never by email: another Google with the owner\'s address is not the owner, and the owner with another address is', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = makeAccount(obj.store, 'Ana', { email: 'ana@gmail.com' });
  // Same address, another sub: no sign-in as Ana (the confirm sheet, with Ana as the match).
  const imp = await google(env, { sub: 'g-impostor', email: 'ana@gmail.com', email_verified: true }, { ip: ip(0) });
  assert.equal(imp.done.location, '/#auth=confirm');
  assert.equal(imp.rt, null, 'no session');
  assert.equal(users(obj).length, 1);
  // Ana's own sub with a different, verified address: Ana signs in, her address is hers and does not follow Google.
  const own = await google(env, { sub: 'g-Ana', email: 'otra.direccion@gmail.com', email_verified: true }, { ip: ip(1) });
  assert.equal(own.done.location, '/#auth=ok');
  assert.ok(own.rt);
  assert.deepEqual([row(obj, ana.userId).email, row(obj, ana.userId).email_hint], ['ana@gmail.com', null]);
  // Ana's sub with no address at all: still Ana.
  const bare = await google(env, { sub: 'g-Ana' }, { ip: ip(2) });
  assert.equal(bare.done.location, '/#auth=ok');
});

test('an owner without a verified address takes the Gmail address (auth) at sign-in with the canon free, and an asserted one as its hint', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const luis = makeAccount(obj.store, 'Luis');
  const r = await google(env, { sub: 'g-Luis', email: 'Luis.Mi@gmail.com', email_verified: true }, { ip: ip(0) });
  assert.equal(r.done.location, '/#auth=ok');
  const u = row(obj, luis.userId);
  assert.deepEqual([u.email, u.email_canon, u.email_proof], ['luis.mi@gmail.com', 'luismi@gmail.com', 'google']);
  const eva = makeAccount(obj.store, 'Eva');
  await google(env, { sub: 'g-Eva', email: 'eva@empresa.com', email_verified: true, hd: 'empresa.com' }, { ip: ip(1) });
  const e = row(obj, eva.userId);
  assert.deepEqual([e.email_canon, e.email_hint, e.email_hint_from], [null, 'eva@empresa.com', 'google']);
});

test('a sanction in force on the Gmail canon (a purged account\'s mark) comes back on the account that claims it, untold; a held or claimed canon never reaches it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const canon = 'castigada@gmail.com';
  const key = [...(await obj.markKeys([['e', canon]])).values()][0];
  const until = Date.now() + 3 * 3_600_000;
  obj.store.sql.exec('INSERT INTO sanction_marks (key, until, ban_until, lock_until, abandons, at) VALUES (?, ?, ?, ?, ?, ?)', key, until, until, 0, 2, Date.now() - 1000);
  const made = await signUp(env, { sub: 'g-nueva', email: 'Castigada@gmail.com', email_verified: true }, 'Renacida', ip(0));
  assert.equal(row(obj, made.id).email_canon, canon);
  assert.equal(obj.store.banUntil(made.id, Date.now()), until, 'the queue ban, to its end');
  assert.equal(obj.store.sql.exec("SELECT COUNT(*) AS n FROM abandons WHERE user_id = ? AND match_id LIKE 'mark:%'", made.id).toArray()[0].n, 2);
  assert.doesNotMatch(JSON.stringify(made.made.json), /mark|sanction|ban/i, 'nobody is told');
  // An asserted address claims nothing: its canon's mark does not apply to a hint.
  const asserted = await signUp(env, { sub: 'g-hint', email: 'castigada@outlook.com', email_verified: true }, 'Otra', ip(1));
  assert.equal(obj.store.banUntil(asserted.id, Date.now()), 0);
});

// ---- the refusals ----------------------------------------------------------------------------------------

test('refused with the failed sign-in redirect (/#auth=error:provider_error, the state cookie cleared, no session, no pending cookie, no account): a wrong aud, iss, nonce, an expired exp, a missing or broken id_token', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const good = { sub: 'g-ok', email: 'ok@gmail.com', email_verified: true };
  const now = nowS();
  const bad = [
    ['aud of another client', { over: { aud: 'other-client-id', azp: 'other-client-id' } }],
    ['aud as a list without ours', { over: { aud: ['x', 'y'] } }],
    ['aud empty', { over: { aud: '' } }],
    ['aud missing', { over: { strip: ['aud'] } }],
    ['aud ours among several without azp', { over: { aud: ['gid', 'other'], strip: ['azp'] } }],
    ['azp of another client', { over: { azp: 'other-client-id' } }],
    ['azp of another client beside our aud list', { over: { aud: ['gid'], azp: 'other-client-id' } }],
    ['azp empty', { over: { azp: '' } }],
    ['iss of another issuer', { over: { iss: 'https://evil.example.com' } }],
    ['iss that only starts like Google', { over: { iss: 'https://accounts.google.com.evil.example' } }],
    ['iss missing', { over: { strip: ['iss'] } }],
    ['nonce of another start', { over: { nonce: 'a-nonce-from-another-start' } }],
    ['nonce missing', { over: { strip: ['nonce'] } }],
    ['nonce empty', { over: { nonce: '' } }],
    ['expired', { over: { exp: now - 10 } }],
    ['expires right now', { over: { exp: now } }],
    ['exp missing', { over: { strip: ['exp'] } }],
    ['exp as a string', { over: { exp: String(now + 3600) } }],
    ['sub missing', { over: { strip: ['sub'] } }],
    ['sub empty', { over: { sub: '' } }],
    ['sub a number', { over: { sub: 12345 } }],
    ['sub too long', { over: { sub: 'x'.repeat(129) } }],
    ['no id_token', { answer: () => ({ access_token: 'only-an-access-token', token_type: 'Bearer' }) }],
    ['id_token empty', { answer: () => ({ access_token: 'a', id_token: '' }) }],
    ['id_token not a JWT', { answer: () => ({ access_token: 'a', id_token: 'not-a-jwt' }) }],
    ['id_token of two parts', { answer: () => ({ access_token: 'a', id_token: 'aGVhZGVy.cGF5bG9hZA' }) }],
    ['id_token payload not base64url', { answer: () => ({ access_token: 'a', id_token: 'aGVhZGVy.@@@.c2ln' }) }],
    ['id_token payload not JSON', { answer: () => ({ access_token: 'a', id_token: 'aGVhZGVy.' + Buffer.from('plain text').toString('base64url') + '.c2ln' }) }],
    ['id_token payload a list', { answer: () => ({ access_token: 'a', id_token: 'aGVhZGVy.' + Buffer.from('[1,2]').toString('base64url') + '.c2ln' }) }],
    ['id_token a number', { answer: () => ({ access_token: 'a', id_token: 12345 }) }],
    ['id_token huge', { answer: () => ({ access_token: 'a', id_token: 'h.' + Buffer.from(JSON.stringify({ pad: 'x'.repeat(20_000) })).toString('base64url') + '.s' }) }],
  ];
  let i = 0;
  for (const [why, o] of bad) {
    const r = await google(env, good, { ip: ip(i++ % 20), ...o });
    assert.equal(r.done.location, '/#auth=error:provider_error', why);
    assert.equal(r.rt, null, why + ': no session');
    assert.equal(r.pend, null, why + ': no pending identity');
    assert.match(cookieLine(r.done.raw, '__Host-tg_oa'), /Max-Age=0/, why + ': the state cookie is cleared');
  }
  assert.equal(users(obj).length, 0);
  // The same redirect as the token endpoint refusing, and as a good answer would not give.
  fakeGoogle.answer = () => new Response('{"error":"invalid_grant"}', { status: 400 });
  const start = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(0), origin: null });
  const st = cookieOf(start.raw, '__Host-tg_oa');
  const failed = await req(env, 'GET', `/api/auth/oauth/google/callback?code=x&state=${new URL(start.location).searchParams.get('state')}`, { ip: ip(0), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.equal(failed.location, '/#auth=error:provider_error');
  // And a good one for contrast, with its aud as a list that carries azp.
  const fine = await google(env, good, { ip: ip(0), over: { aud: ['gid'] } });
  assert.equal(fine.done.location, '/#auth=confirm');
  const fine2 = await google(env, { ...good, sub: 'g-ok2' }, { ip: ip(1), over: { iss: 'accounts.google.com' } });
  assert.equal(fine2.done.location, '/#auth=confirm', 'Google also writes its issuer without the scheme');
});

test('a token for another start is refused: the nonce of an earlier start does not fit this state, and a state is good for one exchange', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const first = await google(env, { sub: 'g-ana', email: 'ana@gmail.com', email_verified: true }, { ip: ip(0) });
  const nonce1 = first.q.get('nonce');
  // A second start whose token carries the first start's nonce (an id_token captured from another login).
  const swapped = await google(env, { sub: 'g-ana', email: 'ana@gmail.com', email_verified: true }, { ip: ip(1), over: { nonce: nonce1 } });
  assert.equal(swapped.done.location, '/#auth=error:provider_error');
  // The state replayed after a good exchange is refused before our secret goes to Google again.
  const start = await req(env, 'GET', '/api/auth/oauth/google/start', { ip: ip(2), origin: null });
  const st = cookieOf(start.raw, '__Host-tg_oa');
  const state = new URL(start.location).searchParams.get('state');
  const nonce = new URL(start.location).searchParams.get('nonce');
  fakeGoogle.answer = () => new Response(JSON.stringify(googleTokenAnswer({ sub: 'g-bea' }, { nonce })), { status: 200 });
  const go = () => req(env, 'GET', `/api/auth/oauth/google/callback?code=x&state=${state}`, { ip: ip(2), cookie: '__Host-tg_oa=' + st, origin: null });
  assert.equal((await go()).location, '/#auth=confirm');
  const calls = fakeGoogle.requests.length;
  assert.equal((await go()).location, '/#auth=error:bad_state');
  assert.equal(fakeGoogle.requests.length, calls, 'the replay never reached Google');
  assert.equal(users(obj).length, 0);
});

test('the callback asks Google for the token only: the code, our client id and secret, the PKCE verifier; the userinfo endpoint is never called (the fake blocks it)', async () => {
  const { env } = makeEnv();
  const ip = ips();
  fakeGoogle.requests.length = 0;
  const r = await google(env, { sub: 'g-1' }, { ip: ip(0), code: 'CODE-123' });
  assert.equal(r.done.location, '/#auth=confirm');
  assert.equal(fakeGoogle.requests.length, 1);
  const form = fakeGoogle.requests[0];
  assert.deepEqual([form.get('grant_type'), form.get('code'), form.get('client_id'), form.get('client_secret'), form.get('redirect_uri')], ['authorization_code', 'CODE-123', 'gid', 'gsec', 'https://turbo-gol.com/api/auth/oauth/google/callback']);
  assert.equal(form.get('code_verifier'), r.st.v);
  assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  // The challenge in the start's URL is that verifier's S256.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.st.v));
  assert.equal(r.q.get('code_challenge'), Buffer.from(digest).toString('base64url'));
  assert.doesNotMatch(readFileSync(new URL('../src/accountRoutes.ts', import.meta.url), 'utf8'), /openidconnect\.googleapis\.com|\/userinfo/, 'no userinfo endpoint in the code');
});

// ---- Google proves level 1 at most ------------------------------------------------------------------------
// The design's first idea was a forced login (prompt=login&max_age=0) that counts as level 2 when the id_token
// carries a fresh auth_time. Google documents neither: its prompt takes only none, consent and select_account,
// max_age is not documented, and auth_time is not in the id_token unless the claims parameter asks for it and it
// is enabled in settings (the discovery document's claims_supported does not list it). So Google is a press on its
// account chooser, level 1, and these tests pin the opposite of the forced login.

/** Discord's round trip, for the accounts that have both providers. */
async function discord(env, user, { query = '', cookie, ip = '198.30.250.2' } = {}) {
  fakeDiscord.user = user;
  const start = await req(env, 'GET', `/api/auth/oauth/discord/start${query}`, { ip, cookie, origin: null });
  if (start.status !== 302) return { start, done: null };
  const state = cookieOf(start.raw, '__Host-tg_oa');
  const done = await req(env, 'GET', `/api/auth/oauth/discord/callback?code=the-code&state=${new URL(start.location).searchParams.get('state')}`, { ip, cookie: '__Host-tg_oa=' + state, origin: null });
  return { start, done, rt: cookieOf(done.raw, '__Host-tg_rt'), pend: cookieOf(done.raw, '__Host-tg_pend') };
}

/** The session claims of a refresh token, and the token that replaces it. */
async function sessionOf(env, rt, ip) {
  const s = await refresh(env, rt, ip);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  return { ...claims(s.json.session), session: s.json.session, rt: cookieOf(s.raw, '__Host-tg_rt') };
}

test('levels: an id_token WITH a fresh auth_time never raises the level above 1: a sign-in, a re-authentication with or without lvl=2, whatever the auth_time says; a refresh keeps the level', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const ana = await signUp(env, { sub: 'g-ana', email: 'ana@gmail.com', email_verified: true }, 'Ana', ip(0));
  const created = await sessionOf(env, ana.rt, ip(0));
  assert.equal(created.aal, 1, 'the account made by a Google press is level 1');
  let rt = created.rt;
  const cases = [
    ['fresh, after the start', () => ({ auth_time: nowS() + 2 })],
    ['exactly now', () => ({ auth_time: nowS() })],
    ['a minute before', () => ({ auth_time: nowS() - 60 })],
    ['in the future', () => ({ auth_time: nowS() + 3600 })],
    ['as a string', () => ({ auth_time: String(nowS()) })],
    ['missing', () => ({ strip: ['auth_time'] })],
  ];
  let i = 1;
  for (const query of ['?reauth=1', '?reauth=1&lvl=2']) {
    for (const [why, over] of cases) {
      const at = ip(1 + (i++ % 15));
      const r = await google(env, { sub: 'g-ana', email: 'ana@gmail.com', email_verified: true }, { query, cookie: '__Host-tg_rt=' + rt, ip: at, over: over() });
      assert.equal(r.done.location, '/#auth=reauth', `${query} ${why}`);
      const s = await sessionOf(env, r.rt, at);
      assert.equal(s.aal, 1, `${query} ${why}: level 1, never 2`);
      assert.ok(Math.abs(s.aat - nowS()) <= 3, `${query} ${why}: the proof is from now`);
      rt = s.rt;
    }
  }
  // The same on a plain sign-in: the press is level 1.
  const si = await google(env, { sub: 'g-ana' }, { ip: ip(2), over: { auth_time: nowS() + 1 } });
  assert.equal(si.done.location, '/#auth=ok');
  assert.equal((await sessionOf(env, si.rt, ip(2))).aal, 1);
  // A refresh keeps the level and never raises it.
  const again = await sessionOf(env, rt, ip(1));
  assert.equal(again.aal, 1);
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0].n, 1);
});

test('levels: a Google link and the chain "confirm it\'s you" -> link stay level 1 whatever the id_token says, and the family of a link keeps its press', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // A Discord-only account links Google with a fresh auth_time in the id_token.
  const bea = makeAccount(obj.store, 'Bea', { provider: 'discord' });
  const di = await discord(env, { id: 'd-Bea' }, { ip: ip(0) });
  assert.equal(di.done.location, '/#auth=ok');
  const link = await google(env, { sub: 'g-bea-link' }, { query: '?link=1', cookie: '__Host-tg_rt=' + di.rt, ip: ip(0), over: { auth_time: nowS() + 1 } });
  assert.equal(link.done.location, '/#auth=linked');
  assert.equal(row(obj, bea.userId).google_sub, 'g-bea-link');
  const s = await sessionOf(env, link.rt, ip(0));
  assert.equal(s.aal, 1);
  // The chain: Google re-authentication (lvl=2 ignored) that goes straight on to linking Discord's other account is level 1 too.
  const chain = await google(env, { sub: 'g-bea-link' }, { query: '?reauth=1&lvl=2&then=link:discord', cookie: '__Host-tg_rt=' + s.rt, ip: ip(1), over: { auth_time: nowS() + 1 } });
  assert.equal(new URL(chain.done.location).origin, 'https://discord.com', 'on to the link of Discord, a press on its page');
  assert.equal(new URL(chain.done.location).searchParams.get('prompt'), 'consent');
  const next = await sessionOf(env, cookieOf(chain.done.raw, '__Host-tg_rt'), ip(1));
  assert.equal(next.aal, 1);
});

test('levels: a Google-and-Discord account with no password and no verified email behaves exactly as on main (Google adds nothing to its ceiling): its ceiling is 1, so an unlink that leaves one way in asks for level 1 and gets it from a press; an account with a verified address still needs 2, which a Google press never gives', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // No password, no address (Google gave none): Discord first, then Google linked by a press with a fresh auth_time.
  const bea = makeAccount(obj.store, 'Bea', { provider: 'discord' });
  const di = await discord(env, { id: 'd-Bea' }, { ip: ip(0) });
  const gl = await google(env, { sub: 'g-bea' }, { query: '?link=1', cookie: '__Host-tg_rt=' + di.rt, ip: ip(0), over: { auth_time: nowS() + 1 } });
  assert.equal(gl.done.location, '/#auth=linked');
  const u = row(obj, bea.userId);
  assert.deepEqual([u.google_sub, u.discord_id, u.pw_hash ?? null, u.email_canon ?? null], ['g-bea', 'd-Bea', null, null]);
  // A forced-login attempt changes nothing: level 1, and level 1 is this account's ceiling.
  const re = await google(env, { sub: 'g-bea' }, { query: '?reauth=1&lvl=2', cookie: '__Host-tg_rt=' + gl.rt, ip: ip(1), over: { auth_time: nowS() + 1 } });
  const s = await sessionOf(env, re.rt, ip(1));
  assert.equal(s.aal, 1);
  const un = await post(env, '/api/auth/unlink', { ip: ip(1), bearer: s.session, body: { provider: 'google' } });
  assert.equal(un.status, 200, JSON.stringify(un.json));
  assert.equal(row(obj, bea.userId).google_sub, null);
  assert.equal(row(obj, bea.userId).discord_id, 'd-Bea');
  // The last way in stays, as ever.
  assert.equal((await post(env, '/api/auth/unlink', { ip: ip(1), bearer: s.session, body: { provider: 'discord' } })).json.error, 'last_method');

  // The same two providers with a verified address (a mailbox code reaches 2): one way in left asks for level 2, and a Google press never gives it.
  const cleo = makeAccount(obj.store, 'Cleo', { email: 'cleo@example.org' });
  const cg = await google(env, { sub: 'g-Cleo' }, { ip: ip(3), over: { auth_time: nowS() + 1 } });
  assert.equal(cg.done.location, '/#auth=ok');
  const dl = await discord(env, { id: 'd-Cleo' }, { query: '?link=1', cookie: '__Host-tg_rt=' + cg.rt, ip: ip(3) });
  assert.equal(dl.done.location, '/#auth=linked');
  assert.equal(row(obj, cleo.userId).discord_id, 'd-Cleo');
  const cs = await sessionOf(env, dl.rt, ip(3));
  assert.equal(cs.aal, 1);
  const low = await post(env, '/api/auth/unlink', { ip: ip(3), bearer: cs.session, body: { provider: 'google' } });
  assert.deepEqual([low.status, low.json.error, low.json.level], [403, 'reauth_required', 2]);
  const forced = await google(env, { sub: 'g-Cleo' }, { query: '?reauth=1&lvl=2', cookie: '__Host-tg_rt=' + cs.rt, ip: ip(4), over: { auth_time: nowS() + 1 } });
  const cs2 = await sessionOf(env, forced.rt, ip(4));
  assert.equal(cs2.aal, 1);
  const still = await post(env, '/api/auth/unlink', { ip: ip(4), bearer: cs2.session, body: { provider: 'google' } });
  assert.deepEqual([still.status, still.json.error, still.json.level], [403, 'reauth_required', 2], 'a Google press with a fresh auth_time is still not level 2');
  assert.equal(row(obj, cleo.userId).google_sub, 'g-Cleo');
});

test('levels: a maintainer cannot pass a maintainer route with a Google sign-in or a Google re-authentication (403 reauth_required, level 2), with or without lvl=2 and a fresh auth_time; it posts the sign-in ALERT and none for the re-authentication', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  env.NODES = { idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response('{"ok":true,"operators":[]}', { headers: { 'content-type': 'application/json' } }) }) };
  Object.assign(env, { NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'k', NODE_CONTROL_PUBLIC_KEY: 'k', NODES_PUBLIC_BASE: ORIGIN });
  const proy = makeAccount(obj.store, 'Proyecto');
  env.NODE_TRUSTED_OPERATORS = proy.userId;
  const routes = [['GET', '/nodes/admin/nodes'], ['GET', '/nodes/admin/account-stats'], ['POST', '/nodes/tokens']];
  const ask = (bearer, i) => Promise.all(routes.map(([m, p]) => req(env, m, p, { ip: ip(i), bearer, body: m === 'POST' ? { region: 'SA' } : undefined })));
  const refused = async (bearer, why, i) => {
    for (const r of await ask(bearer, i)) assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], why);
  };
  const logged = [];
  const log = console.log;
  console.log = (...a) => void logged.push(a.join(' '));
  let si;
  let s1;
  try {
    // The sign-in: a press, level 1.
    si = await google(env, { sub: 'g-Proyecto' }, { ip: ip(0), over: { auth_time: nowS() + 1 } });
    assert.equal(si.done.location, '/#auth=ok');
    const afterSignIn = logged.filter((l) => /ALERT maintainer/.test(l)).length;
    assert.equal(afterSignIn, 1);
    s1 = await sessionOf(env, si.rt, ip(0));
    assert.equal(s1.aal, 1);
    await refused(s1.session, 'a Google sign-in', 1);
    // "Confirm it's you" with Google, asking for a level 2 and carrying a fresh auth_time: still level 1.
    const re = await google(env, { sub: 'g-Proyecto' }, { query: '?reauth=1&lvl=2', cookie: '__Host-tg_rt=' + s1.rt, ip: ip(2), over: { auth_time: nowS() + 1 } });
    assert.equal(re.done.location, '/#auth=reauth');
    const s2 = await sessionOf(env, re.rt, ip(2));
    assert.equal(s2.aal, 1);
    await refused(s2.session, 'a Google re-authentication with lvl=2 and a fresh auth_time', 3);
    const plain = await google(env, { sub: 'g-Proyecto' }, { query: '?reauth=1', cookie: '__Host-tg_rt=' + s2.rt, ip: ip(4), over: { auth_time: nowS() + 1 } });
    await refused((await sessionOf(env, plain.rt, ip(4))).session, 'a plain Google re-authentication', 5);
    assert.equal(logged.filter((l) => /ALERT maintainer/.test(l)).length, afterSignIn, 'the re-authentications at level 1 post no ALERT');
  } finally {
    console.log = log;
  }
  const alerts = logged.filter((l) => /ALERT maintainer/.test(l));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Proyecto \(.*\) signed in with Google, from /);
  assert.doesNotMatch(alerts.join('\n'), /@|198\.30|proyecto@|asking for its password/);
  // The gate itself still takes a level-2 session (a password's), so the refusals above are the level and not a broken route.
  const level2 = await AUTH.signJwt(SECRET, { typ: 's', sub: proy.userId, name: 'Proyecto', iat: nowS(), exp: nowS() + 600, acct: 1, aat: nowS(), aal: 2 });
  for (const r of await ask(level2, 6)) assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('levels: the Google re-authentication of another Google account is reauth_mismatch and raises nothing; a plain sign-in with a fresh auth_time stays level 1', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const ana = await signUp(env, { sub: 'g-ana' }, 'Ana', ip(0));
  await signUp(env, { sub: 'g-bea' }, 'Bea', ip(1));
  const wrong = await google(env, { sub: 'g-bea' }, { query: '?reauth=1&lvl=2', cookie: '__Host-tg_rt=' + ana.rt, ip: ip(2), over: { auth_time: nowS() + 1 } });
  assert.equal(wrong.done.location, '/#auth=error:reauth_mismatch');
  assert.equal(wrong.rt, null);
  const plain = await google(env, { sub: 'g-bea' }, { ip: ip(3), over: { auth_time: nowS() + 1 } });
  assert.equal(plain.done.location, '/#auth=ok');
  assert.equal((await sessionOf(env, plain.rt, ip(3))).aal, 1, 'a sign-in is a press: level 1');
});

test('the address a Google Gmail claims is the account\'s own: it stays when Google is unlinked and linked again, and a second account cannot take it', async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  // The one-time real check of docs/online/ACCOUNTS.md, with a fake Google: a Gmail test user signs in, links, unlinks.
  const ana = makeAccount(obj.store, 'Ana', { provider: 'discord' });
  const di = await discord(env, { id: 'd-Ana' }, { ip: ip(0) });
  const link = await google(env, { sub: 'g-prueba', email: 'Prueba.Gmail@gmail.com', email_verified: true }, { query: '?link=1', cookie: '__Host-tg_rt=' + di.rt, ip: ip(0) });
  assert.equal(link.done.location, '/#auth=linked');
  let u = row(obj, ana.userId);
  assert.deepEqual([u.email, u.email_canon, u.email_proof, u.email_hint, u.google_sub], ['prueba.gmail@gmail.com', 'pruebagmail@gmail.com', 'google', null, 'g-prueba'], 'the address was claimed at the link');
  assert.ok(u.email_verified_at > 0);
  // Unlinking Google leaves one way in and the account now has a mailbox: level 2 is asked, a Google press cannot give it.
  const s = await sessionOf(env, link.rt, ip(0));
  const un = await post(env, '/api/auth/unlink', { ip: ip(0), bearer: s.session, body: { provider: 'google' } });
  assert.deepEqual([un.status, un.json.error, un.json.level], [403, 'reauth_required', 2]);
  assert.equal(obj.store.unlink(ana.userId, 'google', 2), 'ok', 'at level 2 (a code to that mailbox) it goes');
  u = row(obj, ana.userId);
  assert.deepEqual([u.google_sub, u.email, u.email_canon, u.email_proof], [null, 'prueba.gmail@gmail.com', 'pruebagmail@gmail.com', 'google'], 'the claimed address does not follow the provider');
  // Another Google identity with the same Gmail (dots and +tag fold) does not take it: it is a match for Ana.
  const other = await google(env, { sub: 'g-otra', email: 'p.r.u.e.b.a.gmail+x@gmail.com', email_verified: true }, { ip: ip(1) });
  assert.equal(other.done.location, '/#auth=confirm');
  const info = await post(env, '/api/auth/pending', { ip: ip(1), cookie: '__Host-tg_pend=' + other.pend });
  assert.equal(info.json.match.name, 'Ana');
  // Linking the same Google again keeps the address as it was.
  const back = await google(env, { sub: 'g-prueba', email: 'prueba.gmail@gmail.com', email_verified: true }, { query: '?link=1', cookie: '__Host-tg_rt=' + s.rt, ip: ip(2) });
  assert.equal(back.done.location, '/#auth=linked');
  u = row(obj, ana.userId);
  assert.deepEqual([u.google_sub, u.email, u.email_proof], ['g-prueba', 'prueba.gmail@gmail.com', 'google']);
});

// ---- nothing of Google's answer is logged ------------------------------------------------------------------

test('the callback logs nothing from Google\'s answer: not the id_token, the sub, the address, the nonce, the code or the access token, in a success or in any refusal', async () => {
  const { env } = makeEnv();
  const ip = ips();
  const seen = [];
  const keep = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    keep[level] = console[level];
    console[level] = (...a) => void seen.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  }
  let tokens = [];
  try {
    const who = { sub: 'g-sub-secreto-9876', email: 'persona.privada@gmail.com', email_verified: true, name: 'Nombre Privado', picture: 'https://example.org/foto.png' };
    const run = async (o) => {
      const r = await google(env, who, { ip: ip(seen.length % 20), code: 'CODIGO-SECRETO-555', ...o });
      tokens.push(fakeGoogle.lastToken);
      return r;
    };
    const wrap = (answer) => (ctx) => {
      const a = answer(ctx);
      fakeGoogle.lastToken = a.id_token;
      return a;
    };
    await run({ answer: wrap((c) => googleTokenAnswer(who, { nonce: c.nonce })) });
    await run({ answer: wrap((c) => googleTokenAnswer(who, { nonce: c.nonce, aud: 'otro' })) });
    await run({ answer: wrap((c) => googleTokenAnswer(who, { nonce: 'otro-nonce' })) });
    await run({ answer: wrap((c) => googleTokenAnswer(who, { nonce: c.nonce, iss: 'https://evil.example' })) });
    await run({ answer: wrap((c) => googleTokenAnswer(who, { nonce: c.nonce, exp: nowS() - 5 })) });
    await run({ answer: wrap(() => ({ access_token: 'ACCESS-TOKEN-SECRETO', id_token: 'basura.basura.basura' })) });
  } finally {
    for (const level of Object.keys(keep)) console[level] = keep[level];
  }
  const out = seen.join('\n');
  assert.ok(seen.length >= 4, 'refusals do log a line (their reason, a closed word)');
  for (const secret of ['g-sub-secreto-9876', 'persona.privada', 'Nombre Privado', 'foto.png', 'CODIGO-SECRETO-555', 'ACCESS-TOKEN-SECRETO', 'fake-google-access-token', 'basura', 'gsec']) assert.ok(!out.includes(secret), secret);
  for (const t of tokens.filter(Boolean)) assert.ok(!out.includes(t), 'no id_token in a log line');
  assert.match(out, /oauth google: id_token (aud|nonce|iss|exp|malformed)/);
});

// ---- the code names no profile field ---------------------------------------------------------------------

test('the code reads the claims it needs and no name: oauthIdentity, readIdToken and googleIdentity name no profile field', () => {
  const src = readFileSync(new URL('../src/accountRoutes.ts', import.meta.url), 'utf8');
  const from = src.indexOf('function readIdToken');
  const to = src.indexOf('export async function oauthIdentity');
  const end = src.indexOf('\n}\n', to);
  assert.ok(from > 0 && to > from && end > to);
  const code = src.slice(from, end).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /given_name|family_name|\bname\b|picture|locale|nickname|global_name|username|profile/);
  for (const claim of ['sub', 'iss', 'aud', 'azp', 'exp', 'nonce']) assert.ok(code.includes(claim), claim);
  assert.doesNotMatch(code, /auth_time|authTime/, 'the auth_time is not read');
  // Google's trust function reads email, email_verified and hd, which providerTrust takes by name.
  assert.deepEqual(A.providerTrust('google', { email: 'a@gmail.com', email_verified: true, hd: undefined, name: 'x' }), { email: 'a@gmail.com', trust: 'auth' });
});

test("nothing of Google's forced login is left in the code: no prompt=login, no max_age, no auth_time, no level 2 from Google, no reauthGoogle ALERT, no lvl query read, the ceiling as it was", () => {
  const src = readFileSync(new URL('../src/accountRoutes.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /max_age|auth_time|authTime|forcedLogin|FORCED_LOGIN|reauthGoogle|prompt=login|'login'/);
  assert.doesNotMatch(code, /searchParams\.get\('lvl'\)/, 'the start reads no lvl');
  assert.ok(code.includes("q.set('prompt', silent ? 'none' : asked.prompt);"), 'one prompt for every flow');
  assert.ok(code.includes('const lvl = st.lvl === 1 ? 1 : 0;'), 'the callback never says 2');
  const store = readFileSync(new URL('../src/accountStore.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /googleLevel2|setGoogleLevel2/, 'Google does not move the ceiling');
  assert.ok(store.includes('return (u.pw_hash !== null && u.pw_hash !== undefined) || (u.email_canon !== null && u.email_canon !== undefined) ? 2 : 1;'), 'the ceiling is the password or the verified address, as it was');
  const dobj = readFileSync(new URL('../src/AccountsDO.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(dobj, /reauthLevel|setGoogleLevel2/, 'the AccountsDO takes a press (1) from an OAuth re-authentication, never 2');
});

test('idToken fixtures: header.payload.signature, the signature unchecked (a fake one is accepted)', () => {
  const t = idToken(googleClaims({ sub: 's' }, { nonce: 'n' }));
  assert.equal(t.split('.').length, 3);
  assert.equal(claims(t).sub, 's');
  assert.equal(claims(t).iss, 'https://accounts.google.com');
});
