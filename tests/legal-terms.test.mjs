// The terms of service and the privacy policy in the browser (the legal draft's P1, P2, P12, P33),
// dark until GET /api/config names a version (legal.terms): src/net/terms.ts (the version in force,
// a guest's acceptance kept in this browser, the pages' paths), AccountClient (legal read from the
// config, acceptTerms on the two sign-ups, the re-accept POST), NetClient.beforeSession (asked before
// any online session, a guest's or an account's) and src/ui/screens/terms.ts (the notice with its two
// links above the button that accepts, the guest sheet, the re-accept sheet, the links in the About
// sheet and PERFIL). Against a fake fetch and a small fake DOM, as tests/news-consent.test.mjs. The
// server's side: server/test/legal.test.mjs.
//   node --test tests/legal-terms.test.mjs
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

const TERMS = await import('../src/net/terms.ts');
const AC = await import('../src/net/AccountClient.ts');
const { NetClient, NetError } = await import('../src/net/NetClient.ts');
const SHEET = await import('../src/ui/components/sheet.ts');
const UI = await import('../src/ui/screens/terms.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LINKS = src('../src/ui/screens/accountLinks.ts');
const PROFILE = src('../src/ui/screens/profile.ts');
const GAME = src('../src/game/Game.ts');
const MENU = src('../src/ui/Menu.ts');

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    const h = handlers[path.split('?')[0]];
    if (!h) return res(404, { error: 'not_found' });
    return h(body, init.headers, calls);
  };
  return { fetchFn, calls };
}

const NOW = 1_800_000_000_000;
const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Mariana', session: 'jwt-m', expiresAt: NOW + 3_600_000, authAt: NOW, authLvl: 2, ...extra });
const ME = (extra = {}) => ({ playerId: 'abcdef0123456789', name: 'Mariana', createdAt: 0, providers: ['password'], hasPassword: true, renameAt: 0, ratings: [], rankedBanUntil: 0, abandons24h: 0, season: 1, experimental: false, email: 'mariana@example.com', emailVerified: true, news: false, terms: null, deletionAt: 0, ...extra });

function client(handlers) {
  const srv = fakeServer(handlers);
  const acc = new AC.AccountClient({ storage: memStorage(), session: memStorage(), fetchFn: srv.fetchFn, now: () => NOW, sleep: async () => undefined, antiBot: async () => 'tok' });
  return { acc, calls: srv.calls };
}

// ---- src/net/terms.ts ----------------------------------------------------------------------------

test('terms.ts: a version is in force only when the config names one; the guest\'s acceptance is kept in this browser (or for the page when storage is off); the pages by language; the sign-ups\' field', async () => {
  assert.equal(TERMS.termsNeeded(null, null), false, 'unpublished: nothing to accept, ever');
  assert.equal(TERMS.termsNeeded(null, 'v1'), false);
  assert.equal(TERMS.termsNeeded('v2', null), true);
  assert.equal(TERMS.termsNeeded('v2', 'v1'), true, 'a change asks again');
  assert.equal(TERMS.termsNeeded('v2', 'v2'), false);
  const st = memStorage();
  const g = new TERMS.GuestTerms(st, () => NOW);
  assert.equal(g.accepted(), null);
  g.accept('v2');
  assert.deepEqual(JSON.parse(st.getItem(TERMS.GUEST_TERMS_KEY)), { v: 'v2', at: NOW });
  assert.equal(TERMS.GUEST_TERMS_KEY, 'turbogol.terms');
  assert.equal(new TERMS.GuestTerms(st).accepted(), 'v2', 'a reload keeps it');
  st.setItem(TERMS.GUEST_TERMS_KEY, '{"v":"Not A Version"}');
  assert.equal(TERMS.readGuestTerms(st), null);
  st.setItem(TERMS.GUEST_TERMS_KEY, '{nope');
  assert.equal(TERMS.readGuestTerms(st), null);
  const off = new TERMS.GuestTerms({ getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); }, removeItem: () => undefined });
  off.accept('v3');
  assert.equal(off.accepted(), 'v3', 'storage off: this page remembers the press');
  assert.equal(new TERMS.GuestTerms(null).accepted(), null);
  assert.deepEqual(TERMS.legalPaths('es'), { terms: '/terminos', privacy: '/privacidad' });
  assert.deepEqual(TERMS.legalPaths('en'), { terms: '/terms', privacy: '/privacy' });
  assert.deepEqual(TERMS.termsField('v2'), { acceptTerms: 'v2' });
  for (const v of [null, undefined, '', 'Bad Version']) assert.deepEqual(TERMS.termsField(v), {}, String(v));
  // The config read never throws (a host without it, offline): nothing of the terms then.
  assert.deepEqual(await TERMS.legalState({}), { terms: null, deletion: false, graceDays: 14 });
  assert.deepEqual(await TERMS.legalState({ authConfig: async () => { throw new Error('offline'); } }), { terms: null, deletion: false, graceDays: 14 });
  assert.deepEqual(await TERMS.legalState({ authConfig: async () => ({ terms: 'v2', deletion: true, graceDays: 7 }) }), { terms: 'v2', deletion: true, graceDays: 7 });
  // The same rule as the server's TERMS_VERSION.
  assert.equal(TERMS.TERMS_VERSION_RE.source, /^[a-z0-9][a-z0-9._-]{0,31}$/.source);
  assert.ok(src('../server/src/env.ts').includes('export const TERMS_VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;'));
});

// ---- AccountClient --------------------------------------------------------------------------------

test('AccountClient: authConfig reads legal (the terms version, the deletion switch, its days); the sign-up and the OAuth create send acceptTerms only with a version shown; acceptTerms posts kind terms and keeps it in the MeInfo', async () => {
  const { acc, calls } = client({
    '/api/config': () => res(200, { auth: { email: true }, legal: { terms: '2026-12-01', deletion: true, graceDays: 14 } }),
    '/api/auth/pending/create': () => res(200, SESSION()),
    '/api/auth/signup/finish': () => res(200, SESSION()),
    '/api/auth/signin': () => res(200, SESSION()),
    '/api/me': () => res(200, ME()),
    '/api/me/consent': (b, h) => (h.authorization === 'Bearer jwt-m' && b.kind === 'terms' ? res(200, { news: false, terms: b.version }) : res(400, { error: 'bad_consent' })),
  });
  const c = await acc.authConfig();
  assert.deepEqual([c.terms, c.deletion, c.graceDays], ['2026-12-01', true, 14]);
  const junk = client({ '/api/config': () => res(200, { legal: { terms: 'NOT valid', deletion: 'yes', graceDays: 900 } }) });
  assert.deepEqual(await junk.acc.authConfig().then((x) => [x.terms, x.deletion, x.graceDays]), [null, false, 14]);
  await acc.createAccount('Mariana', { news: false, lang: 'es', tz: '', terms: '2026-12-01' });
  assert.equal(calls.find((x) => x.path === '/api/auth/pending/create').body.acceptTerms, '2026-12-01');
  await acc.createAccount('Mariana', { news: false, lang: 'es', tz: '' });
  assert.equal('acceptTerms' in calls.filter((x) => x.path === '/api/auth/pending/create')[1].body, false, 'no notice shown: none sent');
  await acc.signupFinish({ attempt: 'A'.repeat(43), code: '123456' }, { username: 'Mariana', password: 'una clave larga de prueba', news: false, email: 'mariana@example.com', terms: '2026-12-01' });
  assert.equal(calls.find((x) => x.path === '/api/auth/signup/finish').body.acceptTerms, '2026-12-01');
  await acc.fetchMe();
  const me = acc.me;
  assert.equal(await acc.acceptTerms('2026-12-01'), '2026-12-01');
  const sent = calls.at(-1);
  assert.deepEqual([sent.path, sent.body, sent.headers['content-type']], ['/api/me/consent', { kind: 'terms', version: '2026-12-01' }, 'application/json']);
  assert.equal(acc.me, me, 'the same MeInfo, kept in place');
  assert.equal(acc.me.terms, '2026-12-01');
});

// ---- NetClient.beforeSession -------------------------------------------------------------------------

test('NetClient.beforeSession: asked before a guest\'s session is made or used and before an account\'s; a refusal stops the online step before any session request', async () => {
  const calls = [];
  const GUEST = { playerId: 'p1', name: 'Invitado 0001', session: 'jwt-guest', expiresAt: Date.now() + 24 * 3600_000 };
  const net = new NetClient({
    storage: memStorage(),
    fetchFn: async (url) => {
      calls.push(url);
      if (url === '/api/config') return res(200, { turnstileSiteKey: null, protocol: 0, version: '', region: '' });
      if (url === '/api/guest') return res(200, GUEST);
      return res(404, {});
    },
  });
  const asked = [];
  let answer = () => Promise.reject(new UI.TermsDeclined());
  net.beforeSession = (account) => (asked.push(account), answer());
  await assert.rejects(net.ensureGuest(), (e) => e instanceof NetError && e.code === 'cancelled', 'a quiet cancel, as a cancelled search');
  assert.deepEqual(asked, [false]);
  assert.deepEqual(calls, [], 'no guest session asked for before the terms');
  answer = () => Promise.resolve();
  assert.equal((await net.ensureGuest()).session, 'jwt-guest');
  assert.ok(calls.includes('/api/guest'));
  // A stored guest session is asked about too (made before the terms were published).
  answer = () => Promise.reject(new UI.TermsDeclined());
  await assert.rejects(net.ensureGuest());
  // An account's session: asked with account = true.
  net.sessionProvider = async () => ({ ...GUEST, playerId: 'acc1', session: 'jwt-acc' });
  asked.length = 0;
  await assert.rejects(net.ensureGuest());
  assert.deepEqual(asked, [true]);
  answer = () => Promise.resolve();
  assert.equal((await net.ensureGuest()).session, 'jwt-acc');
  // The Game wires it to the sheets; a lobby says why when the sheet was closed.
  assert.match(GAME, /online\.client\.beforeSession = \(account, signal\) => termsGate\(this\.menu, guestTerms, account, signal\);/);
  assert.match(GAME, /e instanceof TermsDeclined \? new AccountError\(t\('legal\.declined'\), 0, 'terms_declined'\) : e/);
});

// ---- the sheets (src/ui/screens/terms.ts) -----------------------------------------------------------

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.text = '';
    this.dataset = {};
    this.classList = {
      add: (c) => (this.className = [...new Set([...this.className.split(' ').filter(Boolean), c])].join(' ')),
      remove: (c) => (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  appendChild(c) {
    this.children.push(c);
    if (c instanceof FakeEl) c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  click() {
    if (this.disabled === true) return;
    const e = { type: 'click', target: this, preventDefault() {} };
    for (const fn of this.listeners.get('click') ?? []) fn(e);
  }
  get isConnected() {
    return true;
  }
  set textContent(v) {
    this.text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent ?? '').join('');
  }
  all() {
    return [this, ...this.children.filter((c) => c instanceof FakeEl).flatMap((c) => c.all())];
  }
}

const withDom = async (fn) => {
  const before = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), createTextNode: (t) => ({ textContent: String(t) }), documentElement: new FakeEl('html') };
  try {
    return await fn();
  } finally {
    globalThis.document = before;
  }
};

function sheetMenu(accounts) {
  const m = { visible: true, sheet: null, spec: null, closer: null, opened: 0, toasts: [], refits: 0, host: { accounts } };
  Object.defineProperty(m, 'modalOpen', { get: () => m.sheet !== null });
  m.toast = (text, kind) => m.toasts.push([kind, text]);
  m.refit = () => void m.refits++;
  m.modal = (spec) => {
    m.closer?.();
    let up = true;
    const close = () => {
      if (!up) return;
      up = false;
      if (m.closer === close) {
        m.sheet = null;
        m.spec = null;
        m.closer = null;
      }
      spec.onClose?.();
    };
    m.closer = close;
    m.spec = spec;
    m.opened++;
    m.sheet = SHEET.sheetBox(spec, close);
    return close;
  };
  return m;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const button = (menu, label) => menu.sheet?.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) ?? null;
const links = (el) => el.all().filter((e) => e.tagName === 'A').map((a) => [a.href, a.textContent]);

test('the guest sheet: nothing while unpublished; else "Before you play", the notice with its two links above PLAY AS GUEST; the press accepts (kept), CANCEL refuses quietly; the next session asks nothing; a change asks again', async () => {
  await withDom(async () => {
    let terms = null;
    const accounts = { authConfig: async () => ({ terms, deletion: false }), me: null, account: null };
    const menu = sheetMenu(accounts);
    const st = memStorage();
    const guest = new TERMS.GuestTerms(st, () => NOW);
    await UI.termsGate(menu, guest, false);
    assert.equal(menu.opened, 0, 'unpublished: no sheet, the game as before');
    terms = 'v2';
    let done = UI.termsGate(menu, guest, false);
    await settle();
    assert.equal(menu.spec.title, 'Before you play');
    const notice = menu.sheet.all().find((e) => e.className.includes('mn-legal-notice'));
    assert.equal(notice.getAttribute('data-terms'), 'v2');
    assert.equal(notice.textContent, 'By pressing "PLAY AS GUEST" you accept the Terms. We use your IP address and the match data, and in P2P matches the other players can see your IP. Read the Privacy policy.');
    assert.deepEqual(links(notice), [['/terms', 'Terms'], ['/privacy', 'Privacy policy']]);
    assert.ok(notice.all().filter((e) => e.tagName === 'A').every((a) => a.target === '_blank' && a.rel === 'noopener' && a.getAttribute('data-nav') === ''), 'a new tab, reachable with the arrows');
    const play = button(menu, 'PLAY AS GUEST');
    assert.ok(play.className.includes('mn-btn-primary'));
    assert.equal(play.dataset.autofocus, 'true', 'the remote lands on it');
    // Two callers at once (a lobby and a queue): one sheet.
    const second = UI.termsGate(menu, guest, false);
    await settle();
    assert.equal(menu.opened, 1);
    play.click();
    await settle();
    await done;
    await second;
    assert.equal(guest.accepted(), 'v2');
    assert.equal(JSON.parse(st.getItem('turbogol.terms')).v, 'v2');
    await UI.termsGate(menu, guest, false);
    assert.equal(menu.opened, 1, 'accepted: nothing asked again');
    // A new version: asked again; CANCEL refuses (a NetError 'cancelled': the search stops quietly).
    terms = 'v3';
    done = UI.termsGate(menu, guest, false);
    await settle();
    assert.equal(menu.opened, 2);
    button(menu, 'CANCEL').click();
    await assert.rejects(done, (e) => e instanceof UI.TermsDeclined && e instanceof NetError && e.code === 'cancelled');
    assert.equal(guest.accepted(), 'v2', 'nothing kept');
    // An aborted search closes nothing but stops waiting.
    const ctrl = new AbortController();
    done = UI.termsGate(menu, guest, false, ctrl.signal);
    await settle();
    ctrl.abort();
    await assert.rejects(done, (e) => e instanceof UI.TermsDeclined);
    assert.notEqual(menu.sheet, null, 'the sheet stays for whoever else waits');
    button(menu, 'CANCEL').click();
    await settle();
  });
});

test('the re-accept sheet: an account whose /api/me terms is the version in force plays on; one of before ("Before you play") or after a change ("The terms have changed") accepts with ACCEPT AND PLAY (POST /api/me/consent), a refusal keeps the sheet and says why; where PERFIL deletes, the note says so', async () => {
  await withDom(async () => {
    const sent = [];
    let fail = null;
    const accounts = {
      authConfig: async () => ({ terms: 'v2', deletion: true }),
      account: { playerId: 'abcdef0123456789' },
      me: ME({ terms: 'v2' }),
      fetchMe: async () => accounts.me,
      acceptTerms: async (v) => {
        sent.push(v);
        if (fail !== null) throw fail;
        accounts.me.terms = v;
        return v;
      },
    };
    const menu = sheetMenu(accounts);
    const guest = new TERMS.GuestTerms(memStorage());
    await UI.termsGate(menu, guest, true);
    assert.equal(menu.opened, 0, 'accepted this version: no sheet');
    accounts.me = ME({ terms: 'v1' });
    let done = UI.termsGate(menu, guest, true);
    await settle();
    await settle();
    assert.equal(menu.spec.title, 'The terms have changed');
    assert.ok(menu.sheet.textContent.includes(en['legal.changedNote'] + ' ' + en['legal.orDelete']));
    assert.ok(menu.sheet.textContent.includes('By pressing "ACCEPT AND PLAY" you accept the Terms.'));
    fail = new AC.AccountError('Los términos cambiaron', 409, 'terms_changed');
    button(menu, 'ACCEPT AND PLAY').click();
    await settle();
    await settle();
    assert.ok(menu.sheet !== null && menu.sheet.textContent.includes('Los términos cambiaron'), 'the refusal in the sheet, which stays');
    fail = null;
    button(menu, 'ACCEPT AND PLAY').click();
    await done;
    assert.deepEqual(sent, ['v2', 'v2']);
    // An account of before the terms (none accepted): "Before you play".
    accounts.me = ME({ terms: null });
    done = UI.termsGate(menu, guest, true);
    await settle();
    await settle();
    assert.equal(menu.spec.title, 'Before you play');
    assert.ok(menu.sheet.textContent.includes(en['legal.accountNote']));
    button(menu, 'CANCEL').click();
    await assert.rejects(done, (e) => e instanceof UI.TermsDeclined);
    // A server of before the terms (no `terms` in /api/me): nothing asked.
    accounts.me = ME();
    delete accounts.me.terms;
    await UI.termsGate(menu, guest, true);
  });
});

test('the notice above CREATE ACCOUNT (PERFIL\'s sign-up and the mailed link\'s finish) and NO, CREATE MY ACCOUNT (the OAuth confirm step): hidden until a version is in force, and the press sends the version it showed', async () => {
  await withDom(async () => {
    let terms = null;
    const menu = sheetMenu({ authConfig: async () => ({ terms }) });
    const dark = UI.termsNotice(menu, 'CREATE ACCOUNT');
    await settle();
    assert.equal(dark.el.hidden, true);
    assert.equal(dark.version(), null, 'nothing shown: nothing accepted');
    assert.equal(dark.el.children.length, 0);
    terms = 'v2';
    const lit = UI.termsNotice(menu, 'CREATE ACCOUNT');
    await settle();
    assert.equal(lit.el.hidden, false);
    assert.equal(lit.version(), 'v2');
    assert.ok(lit.el.textContent.startsWith('By pressing "CREATE ACCOUNT" you accept the Terms.'));
    assert.deepEqual(links(lit.el), [['/terms', 'Terms'], ['/privacy', 'Privacy policy']]);
    // On a TV a link stays in this tab.
    document.documentElement.classList.add('tg-tv');
    assert.equal(UI.legalLink('terms', 'x').target, undefined);
  });
  // Where they go: the finish's last node is the notice (both callers put CREAR CUENTA right after its nodes); the confirm sheet's body ends with it.
  const finish = LINKS.slice(LINKS.indexOf('export function signupFinishFields'), LINKS.indexOf('export function welcome'));
  assert.match(finish, /const notice = termsNotice\(menu, t\('profile\.createAccount'\)\);/);
  assert.match(finish, /acc\.signupFinish\(proof, \{ username, password, news, email, terms: notice\.version\(\) \}\)/);
  assert.match(finish, /nodes: \[name\.el, \.\.\.pw\.nodes, setRow\(t\('auth\.signupNews'\), newsSwitch\.el\), notice\.el\]/);
  assert.match(PROFILE, /\.\.\.fields\.nodes,\s*create,/, "PERFIL's CREAR CUENTA right under the notice");
  assert.match(LINKS, /body: \[h\('p\.mn-prof-ok', null, t\('auth\.linkOk', \{ email \}\)\), other, \.\.\.fields\.nodes, err\],\s*actions: \[\s*\{ label: t\('profile\.createAccount'\)/, "the mailed link's finish");
  const confirm = LINKS.slice(LINKS.indexOf('function confirmSheet'), LINKS.indexOf('function matchSheet'));
  assert.match(confirm, /const notice = termsNotice\(menu, t\('auth\.create'\)\);/);
  assert.match(confirm, /acc\.createAccount\(username, \{ news, lang: language\(\), tz: timeZone\(\), terms: notice\.version\(\) \}\)/);
  assert.match(confirm, /forgot,\s*notice\.el,\s*\],\s*actions: \[create, haveOne\]/);
});

test('P12: the links to the pages, only once published: the About sheet (every screen\'s footer, Inicio\'s too) and PERFIL\'s ABOUT', async () => {
  await withDom(async () => {
    let terms = null;
    const menu = sheetMenu({ authConfig: async () => ({ terms }) });
    const into = new FakeEl('div');
    UI.legalLinks(menu, into);
    await settle();
    assert.equal(into.children.length, 0);
    terms = 'v2';
    UI.legalLinks(menu, into);
    await settle();
    assert.deepEqual(links(into), [['/terms', 'Terms of use'], ['/privacy', 'Privacy policy']]);
  });
  const about = MENU.slice(MENU.indexOf('private openAbout(): void {'), MENU.indexOf('openSearchScreen(): void {'));
  assert.match(about, /void legalState\(this\.host\.accounts\)\.then\(\(c\) => \{\s*if \(c\.terms === null \|\| !list\.isConnected\) return;/);
  assert.match(about, /list\.appendChild\(link\(paths\.terms, t\('legal\.terms'\)\)\);\s*list\.appendChild\(link\(paths\.privacy, t\('legal\.privacy'\)\)\);/);
  assert.match(PROFILE, /aboutLinks\.appendChild\(legal\(paths\.terms, t\('legal\.terms'\), 'profile-terms'\)\);/);
  assert.match(PROFILE, /void legalState\(acc\)\.then\(\(c\) => \{\s*if \(c\.terms === null\) return;/);
});

test('the copy, in both languages (Spanish with tú, D31\'s notice as the lawyer drew it)', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('legal.'));
  assert.ok(keys.length >= 14);
  for (const k of keys) assert.equal(typeof es[k], 'string', k);
  assert.equal(es['legal.notice'], 'Al tocar «{button}» aceptas los {terms}. Usamos tu dirección IP y los datos de la partida, y en partidas P2P los demás jugadores pueden ver tu IP. Lee la {privacy}.');
  assert.equal(es['legal.playAsGuest'], 'JUGAR COMO INVITADO');
  assert.equal(es['legal.terms'], 'Términos de uso');
  assert.equal(es['legal.privacy'], 'Política de privacidad');
  const voseo = /\b(?:tenés|podés|querés|sabés|aceptá|leé|tocá|elegí|jugá|vos)\b/i;
  for (const k of keys) {
    assert.doesNotMatch(es[k], voseo, k);
    for (const text of [es[k], en[k]]) assert.doesNotMatch(text, /rocket\s*league/i, k);
  }
});
