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
import { readdirSync, readFileSync } from 'node:fs';
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
    assert.equal(notice.textContent, 'By pressing "PLAY AS GUEST" you accept the Terms and consent to your data being kept outside Argentina, mainly in the United States, Brazil, Germany, Malaysia, South Africa and Australia. Turbogol is free and offered as is. We use your IP address and the match data, and in lobbies, which are played P2P, the other players can see your IP. Read the Privacy policy.');
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
    assert.ok(menu.sheet.textContent.includes('By pressing "ACCEPT AND PLAY" you accept the Terms and consent to your data being kept outside Argentina, mainly in the United States, Brazil, Germany, Malaysia, South Africa and Australia. Turbogol is free and offered as is.'));
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
    assert.ok(lit.el.textContent.startsWith('By pressing "CREATE ACCOUNT" you accept the Terms and consent to your data being kept outside Argentina, mainly in the United States, Brazil, Germany, Malaysia, South Africa and Australia. Turbogol is free and offered as is.'));
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

test('P12 on the home page: Inicio\'s footer links the terms and the privacy policy once published (the config the menus already read, no other request), on its own line on an upright phone; nothing while dark', async () => {
  // NetClient's config (GET /api/config, once per page): legal.terms only once a valid version is in
  // force; unpublished, the parsed config is exactly as before (no `terms` key at all).
  const { parseServerConfig } = await import('../src/net/NetClient.ts');
  assert.equal(parseServerConfig({ legal: { terms: '2026-12-01', deletion: false } }).terms, '2026-12-01');
  for (const legal of [undefined, null, {}, { terms: null }, { terms: '' }, { terms: 'Not A Version' }, { terms: 7 }, 'x']) {
    assert.equal('terms' in parseServerConfig(legal === undefined ? {} : { legal }), false, JSON.stringify(legal));
  }
  // The Game hands it to the Menu, whose config load gives it to the hint bar (every page, the TV's too).
  assert.match(GAME, /botFillMs: c\.botFillMs \?\? null, terms: c\.terms \?\? null \}/);
  const load = MENU.slice(MENU.indexOf('private loadConfig(): void {'), MENU.indexOf('private onRegionPill(): void {'));
  assert.match(load, /\.then\(\(c\) => \{\s*this\.cfg = c;[^}]*this\.hintBar\.legal\(c\.terms \?\? null\);/);
  assert.doesNotMatch(load, /legalState|authConfig/, 'no second GET /api/config at load');
  // The bar itself: nothing until a version, then Terms · Privacy after About, once.
  const { HintBar } = await import('../src/ui/shell/hintbar.ts');
  await withDom(async () => {
    const bar = new HintBar(() => undefined);
    const keys = () => bar.el.all().map((e) => e.getAttribute('data-key')).filter(Boolean);
    assert.deepEqual(keys(), ['source', 'about']);
    assert.equal(bar.legal(null), false);
    assert.deepEqual(keys(), ['source', 'about'], 'unpublished: the bar as before');
    assert.equal(bar.el.classList.contains('mn-hint-legal'), false);
    assert.equal(bar.legal('v2'), true);
    assert.deepEqual(keys(), ['source', 'about', 'legal-terms', 'legal-privacy']);
    const group = bar.el.all().find((e) => e.className === 'mn-links-legal');
    assert.ok(group, 'one group (shell.css: Inicio only, its own line upright)');
    assert.deepEqual(links(group), [['/terms', 'Terms'], ['/privacy', 'Privacy']]);
    const as = group.all().filter((e) => e.tagName === 'A');
    assert.deepEqual(as.map((a) => [a.title, a.target, a.rel, a.getAttribute('data-nav')]), [['Terms of use', '_blank', 'noopener', ''], ['Privacy policy', '_blank', 'noopener', '']]);
    assert.equal(group.children.filter((e) => e.className === 'mn-link-sep').length, 2, 'a separator before each');
    assert.equal(bar.el.classList.contains('mn-hint-legal'), true);
    assert.equal(bar.legal('v2'), false, 'once');
    assert.equal(bar.el.all().filter((e) => e.className === 'mn-links-legal').length, 1);
    // A TV opens them in this tab (Back returns to the game).
    document.documentElement.classList.add('tg-tv');
    const tv = new HintBar(() => undefined);
    tv.legal('v2');
    assert.deepEqual(tv.el.all().filter((e) => e.tagName === 'A' && e.getAttribute('data-key')?.startsWith('legal-')).map((a) => a.target), [undefined, undefined]);
  });
  // Inicio only (About lists them everywhere); upright, a second line of their own: one line has no
  // room for four links in Spanish at 360 px.
  const shell = src('../src/ui/styles/shell.css');
  assert.match(shell, /\.mn-links-legal \{\s*display: contents;\s*\}/);
  assert.match(shell, /\.mn:not\(\[data-screen='home'\]\) \.mn-links-legal \{\s*display: none;\s*\}/);
  assert.match(shell, /html\[data-layout='portrait'\] \.mn\[data-screen='home'\] \.mn-hint-legal \{\s*height: 4rem;\s*\}/);
  assert.match(shell, /html\[data-layout='portrait'\] \.mn\[data-screen='home'\] \.mn-links-legal \{\s*display: flex;\s*flex-basis: 100%;/);
  assert.equal(es['legal.termsLink'], 'Términos');
  assert.equal(es['legal.privacyShort'], 'Privacidad');
  assert.equal(en['legal.privacyShort'], 'Privacy');
});

test('the copy, in both languages (Spanish with tú, D31\'s notice as the lawyer drew it)', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('legal.'));
  assert.ok(keys.length >= 14);
  for (const k of keys) assert.equal(typeof es[k], 'string', k);
  // The notice is also the express consent to the transfers the privacy policy's section 5 relies on
  // (Argentina: Decreto 1558/2001, art. 12): the press accepts that the data is kept in the United
  // States (Cloudflare) and in the countries of the project's servers (Brazil, Germany and Malaysia;
  // for now South Africa, Australia and the United States too), so every one of them is named in the
  // sentence the button's label is in.
  assert.equal(es['legal.notice'],'Al tocar «{button}» aceptas los {terms} y das tu consentimiento para que tus datos se guarden fuera de Argentina, sobre todo en Estados Unidos, Brasil, Alemania, Malasia, Sudáfrica y Australia. Turbogol es gratis y se ofrece tal como está. Usamos tu dirección IP y los datos de la partida, y en las salas, que se juegan P2P, los demás jugadores pueden ver tu IP. Lee la {privacy}.');
  assert.equal(en['legal.notice'], 'By pressing "{button}" you accept the {terms} and consent to your data being kept outside Argentina, mainly in the United States, Brazil, Germany, Malaysia, South Africa and Australia. Turbogol is free and offered as is. We use your IP address and the match data, and in lobbies, which are played P2P, the other players can see your IP. Read the {privacy}.');
  // ... and section 5 of the privacy policy names no country of a project server the notice leaves
  // out: each row of its table that hosts the project's servers is a country the notice names.
  for (const [file, notice, rows] of [
    ['privacidad.es.md', es['legal.notice'], ['Brasil', 'Alemania', 'Malasia', 'Sudáfrica, Australia y Estados Unidos (Google Cloud)']],
    ['privacy.en.md', en['legal.notice'], ['Brazil', 'Germany', 'Malaysia', 'South Africa, Australia and the United States (Google Cloud)']],
  ]) {
    const policy = readFileSync(new URL(`../docs/legal/${file}`, import.meta.url), 'utf8');
    const s5 = policy.slice(policy.search(/^## 5\. /m), policy.search(/^## 6\. /m));
    const hosted = s5.split('\n').filter((l) => /^\| \*\*/.test(l) && /servidor(?:es)? del proyecto|project's servers?/.test(l)).map((l) => /^\| \*\*([^*]+)\*\*/.exec(l)[1]);
    assert.deepEqual(hosted, rows, `${file}: section 5's rows of the project's servers`);
    for (const country of rows.flatMap((r) => r.replace(/ \(Google Cloud\)$/, '').split(/, | y | and (?:the )?/))) assert.ok(notice.includes(country), `${file}: the notice names ${country}`);
  }
  // After a change, the account accepts the Terms of use (the privacy policy is informed, not accepted).
  assert.equal(es['legal.changedNote'], 'Hay una versión nueva de los Términos de uso y de la Política de privacidad. Para seguir jugando online con tu cuenta, acepta los Términos de uso.');
  assert.equal(en['legal.changedNote'], 'There is a new version of the Terms of use and the Privacy policy. To keep playing online with your account, accept the Terms of use.');
  assert.equal(es['legal.playAsGuest'], 'JUGAR COMO INVITADO');
  assert.equal(es['legal.terms'], 'Términos de uso');
  assert.equal(es['legal.privacy'], 'Política de privacidad');
  const voseo = /\b(?:tenés|podés|querés|sabés|aceptá|leé|tocá|elegí|jugá|vos)\b/i;
  for (const k of keys) {
    assert.doesNotMatch(es[k], voseo, k);
    for (const text of [es[k], en[k]]) assert.doesNotMatch(text, /rocket\s*league/i, k);
  }
});

// The notices of a change to the texts (docs/legal/avisos, docs/legal/README.md): `<version>.md` is
// the official one, in Spanish ("## Mensaje 1", "## Mensaje 2"), in the repository; `<version>.en.md`
// is its English translation ("## Message 1", "## Message 2"), the only one posted on Discord,
// because the Discord server is English-only (the owner's decision of 2026-11-04). Both are written
// to paste into Discord as they are, so both pass the same checks.
const AVISOS = new URL('../docs/legal/avisos/', import.meta.url);
// Who posts a notice and how, in the same words in docs/legal/README.md and in both prefaces.
const NOTICE_POSTED_EN = "the maintainer posts it, by hand from Raw or with the project's Discord bot";
const NOTICE_POSTED_ES = 'Lo publica quien mantiene el proyecto, a mano desde «Raw» o con el bot de Discord del proyecto';
// Another account of how it goes out (the bot alone) would contradict them.
const NOTICE_POSTED_OTHER = /\bbot (?:posted|posts)\b|\bposted by the bot\b|\bel bot (?:lo )?public/i;
// A notice's preface: what comes before "## Mensaje 1" / "## Message 1", without the H1, on one line.
const noticePreface = (file) => readFileSync(new URL(file, AVISOS), 'utf8').split(/^## /m)[0].replace(/^# .*\n/, '').replace(/\s+/g, ' ').trim();
function noticeMessages(file, heading) {
  const version = file.replace(/(?:\.en)?\.md$/, '');
  const parts = readFileSync(new URL(file, AVISOS), 'utf8').split(new RegExp(`^## ${heading} \\d\\n`, 'm'));
  assert.equal(parts.length, 3, `${file}: a preface, then ${heading} 1 and ${heading} 2`);
  const msgs = parts.slice(1).map((m) => m.trim());
  for (const [i, m] of msgs.entries()) {
    const at = `${file}, message ${i + 1}`;
    // Discord counts every character and shows every newline: no hard wraps (a line that goes on,
    // indented or not; only a list's bullets follow each other), no headings, and less than a plain
    // message's 2,000 (4,000 is Nitro's).
    assert.ok(m.length < 2000, `${at}: ${m.length} characters`);
    const lines = m.split('\n');
    for (let j = 1; j < lines.length; j++)
      if (lines[j - 1] !== '' && lines[j] !== '')
        assert.ok(lines[j - 1].startsWith('- ') && lines[j].startsWith('- '), `${at}: a bullet or paragraph broken over two lines (${JSON.stringify(lines[j])})`);
    assert.doesNotMatch(m, /^#/m, `${at}: Discord's own headings are not ours`);
    assert.doesNotMatch(m, /rocket\s*league/i, at);
    // Read alone, each message still names the version the players are asked to accept.
    assert.ok(m.includes(version), `${at}: the version ${version}`);
  }
  // The links in < > (no embed), the only contact the public one.
  const all = msgs.join('\n');
  assert.doesNotMatch(all, /(?<!<)https?:\/\//, `${file}: every link between < and >`);
  assert.ok(all.includes('privacy@turbo-gol.com'), `${file}: the contact`);
  for (const m of all.matchAll(/[\w.+-]+@[\w.-]+/g)) assert.equal(m[0], 'privacy@turbo-gol.com', file);
  return msgs;
}
// Line by line: blank, paragraph or bullet, and whether it opens in bold ("p*", "-*", "-", "").
const noticeShape = (m) => m.split('\n').map((l) => (l === '' ? '' : (l.startsWith('- ') ? '-' : 'p') + (/^(?:- )?\*\*/.test(l) ? '*' : '')));
const noticeNumbers = (m) => m.match(/\d+(?:[.-]\d+)*/g);
const noticeLinks = (m) => [...m.matchAll(/<(https:\/\/[^>]+)>/g)].map((x) => x[1]);

test('every notice in docs/legal/avisos has its English translation, and both paste into Discord as they are: two messages under 2,000 characters, no hard wraps, no headings, links in < >, the version, only the public contact; the translation says the same as the official one, and the prefaces say which is which and how it is posted', () => {
  const files = readdirSync(AVISOS);
  const notices = files.filter((f) => f.endsWith('.md') && !f.endsWith('.en.md'));
  assert.ok(notices.includes('2026-11-04-2.md'));
  for (const f of files) assert.match(f, /^\d{4}-\d{2}-\d{2}(?:-\d+)?(?:\.en)?\.md$/, `docs/legal/avisos/${f}: <version>.md or <version>.en.md`);
  for (const es of notices) {
    const en = es.replace(/\.md$/, '.en.md');
    assert.ok(files.includes(en), `${es}: its English translation, ${en}`);
    const msgsEs = noticeMessages(es, 'Mensaje');
    const msgsEn = noticeMessages(en, 'Message');
    for (const m of msgsEs) assert.doesNotMatch(m, /\b(?:tenés|podés|querés|recargá|creá|aceptá|jugá|vos)\b/i, es);
    // A translation, not another notice: the same paragraphs and bullets, each opening in bold where
    // the Spanish one does, the same numbers in the same order (dates, minutes, days, sections) and
    // the same links, message by message.
    for (const i of [0, 1]) {
      const at = `${en}, message ${i + 1}`;
      assert.deepEqual(noticeShape(msgsEn[i]), noticeShape(msgsEs[i]), `${at}: the paragraphs, bullets and bold leads of ${es}`);
      assert.deepEqual(noticeNumbers(msgsEn[i]), noticeNumbers(msgsEs[i]), `${at}: the numbers of ${es}`);
      assert.deepEqual(noticeLinks(msgsEn[i]), noticeLinks(msgsEs[i]), `${at}: the links of ${es}`);
    }
    // The prefaces: the Spanish notice is the official text, and the Discord post is its English
    // translation; both say who posts it and how, as docs/legal/README.md does.
    const prefaceEs = noticePreface(es);
    const prefaceEn = noticePreface(en);
    assert.ok(prefaceEs.startsWith('Texto oficial del aviso de la versión '), `${es}: its preface says it is the official text`);
    assert.ok(prefaceEs.includes(`lo que se publica ahí es su traducción al inglés, [${en}](${en})`), `${es}: its preface says the Discord post is its English translation`);
    assert.ok(prefaceEn.startsWith('English translation of the notice of version '), `${en}: its preface says it is the translation`);
    assert.ok(prefaceEn.includes(`The official notice is the Spanish one, [${es}](${es}); this translation is informative.`), `${en}: its preface says which text is the official one`);
    assert.ok(prefaceEs.includes(NOTICE_POSTED_ES), `${es}: who posts it and how`);
    assert.ok(prefaceEn.toLowerCase().includes(NOTICE_POSTED_EN.toLowerCase()), `${en}: who posts it and how`);
    for (const [f, p] of [[es, prefaceEs], [en, prefaceEn]]) assert.doesNotMatch(p, NOTICE_POSTED_OTHER, `${f}: the same account of how it is posted as the README`);
  }
});

test('docs/legal/README.md says where a notice goes (Discord in English, the official Spanish text in the repository), who posts it and how, and lists every notice; Términos 18.2 says the same since version 2026-11-05, with 7 days of notice, in both languages, and so do the summary, 16.5 and the policy\'s section 14', () => {
  const readme = readFileSync(new URL('../docs/legal/README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(readme.includes('**Discord in English, the official text in the repository.** The Discord server is English-only, so the post on Discord is the English translation, `<version>.en.md`, and only that. The official notice is the Spanish file in the repository, `<version>.md`'));
  assert.ok(readme.toLowerCase().includes(NOTICE_POSTED_EN.toLowerCase()), 'who posts it and how, as the prefaces say');
  assert.doesNotMatch(readme, NOTICE_POSTED_OTHER);
  // Every notice in avisos/ has its two rows in the README's table.
  for (const f of readdirSync(AVISOS).filter((x) => x.endsWith('.en.md'))) {
    assert.ok(readme.includes(`| \`avisos/${f}\` | Its English translation: the text posted on Discord |`), f);
    assert.ok(readme.includes(`| \`avisos/${f.replace(/\.en\.md$/, '.md')}\` | The notice of version \``), f);
  }
  assert.ok(readme.includes('announcing it 7 days ahead when it is an important change (Términos 18.2'));
  assert.ok(readme.includes('On the day the notice is posted (7 days ahead, or the deploy day when a change skips that):'));
  // The owner's decision of 4 November 2026: 18.2 says what the notices do (Spanish, the official
  // text, in the repository; its English translation on Discord), and 7 days instead of 30.
  const legal = (f) => readFileSync(new URL(`../docs/legal/${f}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const es = legal('terminos.es.md');
  const en = legal('terms.en.md');
  assert.ok(es.includes('2. **Si el cambio es importante, te avisamos al menos 7 días antes.** Publicamos el aviso, con el texto nuevo y la fecha desde la que vale, en el repositorio del proyecto (<https://github.com/DonJaimeHash/turbo-gol/tree/main/docs/legal>), en español, que es el texto oficial, y su traducción al inglés en nuestro servidor de Discord, que es en inglés.'));
  assert.ok(en.includes('2. **If the change is important, we tell you at least 7 days ahead.** We post the notice, with the new text and the date from which it applies, in the project\'s repository (<https://github.com/DonJaimeHash/turbo-gol/tree/main/docs/legal>), in Spanish, which is the official text, and its English translation on our Discord server, which is in English.'));
  assert.ok(es.includes('- Si cambiamos algo importante, te avisamos al menos 7 días antes (publicamos el aviso en el repositorio del proyecto y su traducción al inglés en nuestro servidor de Discord)'), 'the summary');
  assert.ok(en.includes('- If we change something important, we tell you at least 7 days ahead (we post the notice in the project\'s repository, and its English translation on our Discord server)'), 'the summary');
  assert.ok(es.includes('como los avisos de 30 días (secciones 11.7 y 15) y el de 7 días (sección 18.2)'), '16.5');
  assert.ok(en.includes('such as the 30-day notices (sections 11.7 and 15) and the 7-day one (section 18.2)'), '16.5');
  // 18.2's period is 7 days wherever a text restates it; the other 30-day notices (points, closing,
  // a new owner) only borrow 18.2's way of posting it.
  for (const t of [es, en]) assert.doesNotMatch(t, /en español, con el texto nuevo|in Spanish, with the new text|30 días \(secciones 11\.7, 15 y 18\.2\)|sections 11\.7, 15 and 18\.2|30 días antes, como dice la sección 18\.2|30 days ahead, as section 18\.2 says/);
  assert.ok(legal('privacidad.es.md').includes('- Si cambiamos algo importante, publicamos un aviso al menos 7 días antes: en español, el texto oficial, en el repositorio del proyecto'), 'the policy, 14');
  assert.ok(legal('privacy.en.md').includes('- If we change something important, we publish a notice at least 7 days ahead: in Spanish, the official text, in the project\'s repository'), 'the policy, 14');
});

test("the deploy day's notice (docs/legal/avisos/2026-11-04-2.md, the official text) and its English translation (2026-11-04-2.en.md, the text the Discord server shows)", () => {
  const es = noticeMessages('2026-11-04-2.md', 'Mensaje');
  const en = noticeMessages('2026-11-04-2.en.md', 'Message');
  assert.ok(es[0].startsWith('**Cambian los modos de juego y los Términos (versión 2026-11-04-2)**\n'), 'the title is its first line, in bold');
  assert.ok(en[0].startsWith('**Game modes and the Terms are changing (version 2026-11-04-2)**\n'), 'the title is its first line, in bold');
  // Each bullet's bold lead, in both (the last two bullets have none), and the "why" after them.
  const leads = (m) => m.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.match(/^- (\*\*[^*]+\*\*)/)?.[1] ?? null);
  assert.deepEqual(leads(es[0]), [
    '**CASUAL y COMPETITIVO necesitan una cuenta**',
    '**CASUAL arma la partida apenas hay 2 o más personas buscando**',
    '**Mientras esperas**',
    '**Buscamos primero en tu región**',
    '**Más partidas de CASUAL se juegan en el servidor de São Paulo:**',
    '**Las salas se juegan siempre P2P**',
    null,
    null,
  ]);
  assert.deepEqual(leads(en[0]), [
    '**CASUAL and COMPETITIVE need an account**',
    '**CASUAL starts a match as soon as 2 or more people are searching**',
    '**While you wait**',
    '**We search your region first**',
    '**More CASUAL matches are played on the São Paulo server:**',
    '**Lobbies are always P2P**',
    null,
    null,
  ]);
  assert.match(es[0], /\n\*\*Por qué:\*\* con pocos jugadores conectados, /);
  assert.match(en[0], /\n\*\*Why:\*\* with few players online, /);
  // Discord got the English translation only (docs/legal/README.md), and both prefaces say so.
  assert.ok(noticePreface('2026-11-04-2.md').includes('por esa misma decisión este aviso se publicó en Discord solo en inglés'));
  assert.ok(noticePreface('2026-11-04-2.en.md').includes('this is the text posted there on 4 November 2026, and the only one'));
  // What the code does: São Paulo takes the match when it has room (MatchmakerDO formMatch).
  assert.match(es[0], /todas las que tienen mayoría de jugadores de Sudamérica, cuando hay lugar,/);
  assert.match(en[0], /all those with a majority of players from South America, when there is room,/);
  // A lobby open at the deploy closes (its old page's rejoin gets 426 reload_required): say so.
  assert.match(es[0], /Las salas que estaban abiertas en el momento de la actualización se cierran: después de recargar, crea la sala de nuevo\./);
  assert.match(en[0], /Lobbies that were open at the moment of the update are closed: after reloading, create your lobby again\./);
  // The full texts, last; in English, after saying which ones are official.
  assert.match(es[1], /\nTextos completos: <https:\/\/github\.com\/DonJaimeHash\/turbo-gol\/tree\/main\/docs\/legal>$/);
  assert.match(en[1], /\nThe Spanish texts are the official ones; the English translations are informative\. Full texts: <https:\/\/github\.com\/DonJaimeHash\/turbo-gol\/tree\/main\/docs\/legal>$/);
});

// Version 2026-11-05 (the owner's decisions of 4 November 2026): the project's servers in six
// countries, verification across countries, the public list of PR 3, and 18.2 at 7 days, in force
// on its deploy day. If that day moves, the version moves with it (the PR lists every string).
const VERSION_A = '2026-11-05';
test(`the notice of version ${VERSION_A} (the official text) and its English translation (the Discord post): the countries, the cross-country verification, the list, the 7 days, the same-day effect and the apology`, () => {
  const es = noticeMessages(`${VERSION_A}.md`, 'Mensaje');
  const en = noticeMessages(`${VERSION_A}.en.md`, 'Message');
  assert.ok(es[0].startsWith(`**Servidores del proyecto en seis países, y cambian los Términos (versión ${VERSION_A})**\n`), 'the title is its first line, in bold');
  assert.ok(en[0].startsWith(`**Project servers in six countries, and the Terms are changing (version ${VERSION_A})**\n`), 'the title is its first line, in bold');
  // The six countries with their regions, the temporary three said to be for now, and where the list is.
  assert.match(es[0], /Brasil \(Sudamérica\), Alemania \(Europa\), Malasia \(Asia\) y, por ahora, Sudáfrica \(África\), Australia \(Oceanía\) y Estados Unidos \(Norteamérica\)\./);
  assert.match(en[0], /Brazil \(South America\), Germany \(Europe\), Malaysia \(Asia\) and, for now, South Africa \(Africa\), Australia \(Oceania\) and the United States \(North America\)\./);
  for (const m of [es[0], en[0]]) assert.ok(m.includes('<https://turbo-gol.com/nodes/status>'), 'the list of the servers in service');
  // What the code does: the verifiers are the three Hostinger servers, any of them for any match
  // (nodes/control-plane/scheduler.ts pickVerifier: no region filter), and they get the replay, not the IP.
  assert.match(es[0], /\*\*Una partida de COMPETITIVO puede verificarse en otro país,\*\* en el servidor de Brasil, Alemania o Malasia\. El verificador recibe la repetición \(tu nombre, tu identificador, tu equipo y tus controles\), no tu IP\./);
  assert.match(en[0], /\*\*A COMPETITIVE match may be verified in another country,\*\* on the server in Brazil, Germany or Malaysia\. The verifier receives the replay \(your name, your identifier, your team and your controls\), not your IP\./);
  // The public list as feat/nodes-public-list builds it (publicList.ts).
  assert.ok(es[0].includes('se ve como «Anfitrión» y un número'));
  assert.ok(en[0].includes('shows as "Anfitrión" and a number'));
  // Message 2: the 7 days, the same-day effect, the apology again, then the full texts.
  assert.ok(es[1].includes('Esta versión acorta el aviso de los cambios importantes de 30 a 7 días (Términos, sección 18.2)'));
  // The promise this version skips is the 30 days of the version before it (2026-11-04-2's 18.2).
  assert.ok(es[1].includes('sin los 30 días de aviso que prometía la versión anterior, ni siquiera los 7 nuevos: te pedimos disculpas otra vez.'));
  assert.ok(en[1].includes('This version shortens the notice of important changes from 30 to 7 days (Terms, section 18.2)'));
  assert.ok(en[1].includes('without the 30 days of notice the previous version promised, or even the new 7: we apologize again.'));
  assert.match(es[1], /\nTextos completos: <https:\/\/github\.com\/DonJaimeHash\/turbo-gol\/tree\/main\/docs\/legal>$/);
  assert.match(en[1], /\nThe Spanish texts are the official ones; the English translations are informative\. Full texts: <https:\/\/github\.com\/DonJaimeHash\/turbo-gol\/tree\/main\/docs\/legal>$/);
  // The prefaces say it took effect the day it was posted, by the owner's decision.
  assert.ok(noticePreface(`${VERSION_A}.md`).includes('publicado en este repositorio el 5 de noviembre de 2026, el mismo día en que empieza a valer'));
  assert.ok(noticePreface(`${VERSION_A}.en.md`).includes('this is the text posted there on 5 November 2026, the day the version takes effect'));
});

test(`version ${VERSION_A} of the texts: the six countries, the providers, the verification across countries, the public list of PR 3 and the history, in both languages; never a city of the new machines`, () => {
  const read = (f) => readFileSync(new URL(`../docs/legal/${f}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const [tes, ten, pes, pen] = ['terminos.es.md', 'terms.en.md', 'privacidad.es.md', 'privacy.en.md'].map(read);
  // Terms 7.6: the six servers, the in-service list, the region's own server or Cloudflare, never
  // another region's but in an emergency (MatchmakerDO formMatch, PR #103).
  assert.ok(tes.includes('Hoy los únicos servidores de la comunidad son los del proyecto, en São Paulo (Brasil), Alemania y Malasia y, por ahora, también en Sudáfrica, Australia y Estados Unidos.'));
  assert.ok(ten.includes("Today the only community servers are the project's own, in São Paulo (Brazil), Germany and Malaysia and, for now, also in South Africa, Australia and the United States."));
  assert.ok(tes.includes('Nunca va al servidor del proyecto de otra región, salvo en una emergencia'));
  assert.ok(ten.includes('It never goes to the project server of another region, except in an emergency'));
  // The policy's summary keeps the temporary three "for now", as 7.6, 4.1, 4.4 and 5 do: the text
  // stays true when one of them is switched off (the owner's decision of 4 November 2026).
  assert.ok(pes.includes('en los servidores del proyecto que están en servicio (en Brasil, Alemania y Malasia y, por ahora, en Sudáfrica, Australia y Estados Unidos)'));
  assert.ok(pen.includes("on the project's servers that are in service (in Brazil, Germany and Malaysia and, for now, in South Africa, Australia and the United States)"));
  // ... and the policy's 4.4 says the same, with the same exception.
  assert.ok(pes.includes('nunca en el servidor del proyecto de otra región, salvo en una emergencia: si apagamos las partidas en servidores de Cloudflare'));
  assert.ok(pen.includes('never on the project server of another region, except in an emergency: if we turn off matches on Cloudflare servers'));
  // Terms 12.4.1 and the policy's 4.5: the list of PR 3 (only probation or active, "Anfitrión" and a
  // number for any host that is not the project, compatible, the unnamed node's region and number).
  for (const t of [tes, pes]) assert.ok(t.includes('«Anfitrión» y un número'));
  for (const t of [ten, pen]) assert.ok(t.includes('"Anfitrión"'));
  assert.ok(tes.includes('Un servidor pendiente, suspendido, bloqueado o retirado no aparece.'));
  assert.ok(ten.includes('A pending, suspended, blocked or retired server does not appear.'));
  assert.ok(tes.includes('si es compatible con la versión actual del juego') && ten.includes("whether it is compatible with the game's current version"));
  assert.ok(tes.includes('se llama con su región y un número (por ejemplo, «sa-node-3»)') && ten.includes('it is called by its region and a number (for example, "sa-node-3")'));
  for (const t of [tes, ten, pes, pen]) assert.doesNotMatch(t, /su nombre lleva tu nombre de usuario|its name includes your username|lleva su nombre de usuario|carries their username/, 'the old default name');
  // The providers and the countries (policy 4.1 and 5), the verification across countries (4.4).
  assert.ok(pes.includes('| **Hostinger** | Brasil, Alemania y Malasia |') && pes.includes('| **Google Cloud** | Sudáfrica, Australia y Estados Unidos |'));
  assert.ok(pen.includes('| **Hostinger** | Brazil, Germany and Malaysia |') && pen.includes('| **Google Cloud** | South Africa, Australia and the United States |'));
  assert.ok(pes.includes('los servidores de Sudáfrica, Australia y Estados Unidos nunca verifican partidas'));
  assert.ok(pen.includes('the servers in South Africa, Australia and the United States never verify matches'));
  // The history (feat/nodes-history: HISTORY_DAYS 30, ALERT_RING_MAX 2000).
  assert.ok(pes.includes('30 días. De las líneas de aviso, las últimas 2.000 como mucho.'));
  assert.ok(pen.includes('30 days. Of the alert lines, the last 2,000 at most.'));
  // The bots' level a player picks for the 5:00 match (PR #108) in the search's row.
  assert.ok(pes.includes('en CASUAL la dificultad de los bots que elegiste para tu partida contra bots'));
  assert.ok(pen.includes("in CASUAL the bots' difficulty you chose for your bots match"));
  // Only the country of the machines outside São Paulo (and never a site the node's name suggests).
  for (const t of [tes, ten, pes, pen]) assert.doesNotMatch(t, /frankfurt|kuala|johannesburg|joburg|sydney|melbourne|ashburn|virginia|iowa|oregon|council bluffs/i);
});