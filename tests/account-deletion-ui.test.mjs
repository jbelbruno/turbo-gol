// The account deletion's screens (the legal draft's P5; the API is sign-in PR 12's, tested in
// tests/account-deletion.test.mjs and server/test/deletion.test.mjs): PERFIL's BORRAR CUENTA (the
// username typed, "confirm it's you" at the level the server asks, the receipt on screen), the
// deletion_pending sheet of a sign-in (CONSERVAR MI CUENTA signs in again with cancelDeletion, or with
// the provider's cancelDel=1) and M9's /account#keep= sheet, every one only while GET /api/config
// says the server takes deletions (legal.deletion, DELETION_OPEN: "0" in production). Against a fake
// DOM and a fake menu, as tests/news-consent.test.mjs.
//   node --test tests/account-deletion-ui.test.mjs
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
  load(url, context, nextLoad) {
    if (url.endsWith('/package.json') && context.importAttributes?.type !== 'json') {
      const { version } = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', shortCircuit: true, source: `export const version = ${JSON.stringify(version)}; export default { version: ${JSON.stringify(version)} };` };
    }
    return nextLoad(url, context);
  },
});

const AC = await import('../src/net/AccountClient.ts');
const SHEET = await import('../src/ui/components/sheet.ts');
const D = await import('../src/ui/screens/deletion.ts');
const L = await import('../src/ui/screens/accountLinks.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PROFILE = src('../src/ui/screens/profile.ts');
const LINKS = src('../src/ui/screens/accountLinks.ts');
const GAME = src('../src/game/Game.ts');

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.text = '';
    this.dataset = {};
    this.classList = { add: () => undefined, remove: () => undefined, contains: () => false };
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
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  click() {
    if (this.disabled === true) return;
    for (const fn of this.listeners.get('click') ?? []) fn({ type: 'click', target: this, preventDefault() {} });
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
  const before = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { createElement: (tag) => new FakeEl(tag), createTextNode: (t) => ({ textContent: String(t) }), documentElement: new FakeEl('html') };
  globalThis.window = { location: { href: 'https://turbo-gol.com/' } };
  try {
    return await fn();
  } finally {
    globalThis.document = before.document;
    globalThis.window = before.window;
  }
};

function sheetMenu(accounts) {
  const m = { visible: true, sheet: null, spec: null, closer: null, opened: 0, toasts: [], host: { accounts } };
  Object.defineProperty(m, 'modalOpen', { get: () => m.sheet !== null });
  m.toast = (text, kind) => m.toasts.push([kind, text]);
  m.refit = () => undefined;
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
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (menu, label) => menu.sheet?.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) ?? null;
const DAY = 86_400_000;
const PURGE = Date.UTC(2026, 10, 14, 12);

test('pendingSheet: "This account is being deleted" with its day; KEEP MY ACCOUNT runs the sign-in again (cancelDeletion), a refusal stays in the sheet; CANCEL keeps nothing', async () => {
  await withDom(async () => {
    const menu = sheetMenu({});
    let tries = 0;
    let p = D.pendingSheet(menu, PURGE, async () => {
      tries++;
      if (tries === 1) throw new AC.AccountError(en['error.network'], 0, 'network');
    });
    assert.equal(menu.spec.title, 'This account is being deleted');
    assert.ok(menu.sheet.textContent.includes(`You asked to delete this account. It is deleted on ${D.dayText(PURGE)}. Do you want to keep it?`));
    assert.equal(button(menu, 'KEEP MY ACCOUNT').dataset.autofocus, 'true');
    button(menu, 'KEEP MY ACCOUNT').click();
    await settle();
    assert.ok(menu.sheet.textContent.includes(en['error.network']), 'the refusal, the sheet up');
    button(menu, 'KEEP MY ACCOUNT').click();
    assert.equal(await p, true);
    assert.equal(tries, 2);
    p = D.pendingSheet(menu, 0, async () => assert.fail('not pressed'));
    assert.ok(menu.sheet.textContent.includes(en['delete.pendingNoteNoDate']), 'no day known (a provider\'s callback)');
    button(menu, 'CANCEL').click();
    assert.equal(await p, false);
  });
});

test('/account#keep=<token> (M9): closed (DELETION_OPEN "0"), not valid here as before; open, nothing changes until KEEP MY ACCOUNT, then "Your account stays"; a dead link says so', async () => {
  await withDom(async () => {
    const calls = [];
    let deletion = false;
    let dead = false;
    const acc = {
      authConfig: async () => ({ terms: null, deletion }),
      keepPendingLink: (l) => calls.push(['keep', l]),
      cancelDeletion: async (token) => {
        calls.push(['cancel', token]);
        if (dead) throw new AC.AccountError('x', 410, 'link_invalid');
      },
    };
    const T = 'K'.repeat(43);
    const closed = sheetMenu(acc);
    await L.openAccountLink(closed, { kind: 'keep', token: T });
    assert.deepEqual(closed.toasts, [['error', en['error.account.link_invalid']]]);
    assert.equal(closed.opened, 0);
    assert.deepEqual(calls, [['keep', null]]);
    deletion = true;
    calls.length = 0;
    const menu = sheetMenu(acc);
    await L.openAccountLink(menu, { kind: 'keep', token: T });
    assert.equal(menu.spec.title, 'Keep your account?');
    assert.ok(menu.sheet.textContent.includes(en['delete.keepNote']));
    assert.deepEqual(calls, [], "opening the link changes nothing (a mail scanner's visit)");
    button(menu, 'KEEP MY ACCOUNT').click();
    await settle();
    assert.deepEqual(calls.filter((c) => c[0] === 'cancel'), [['cancel', T]]);
    assert.equal(menu.spec.title, 'Your account stays');
    assert.ok(menu.sheet.textContent.includes(en['delete.kept']));
    dead = true;
    D.openKeepSheet(menu, T);
    await settle();
    button(menu, 'KEEP MY ACCOUNT').click();
    await settle();
    assert.ok(menu.sheet.textContent.includes(en['error.account.link_invalid']));
    button(menu, 'CANCEL').click();
    assert.ok(calls.some((c) => c[0] === 'keep' && c[1] === null), 'closed: the kept link is forgotten');
  });
  assert.match(LINKS, /return openKeepSheet\(menu, link\.token\);/);
});

test('back from a provider with deletion_pending: with the screens open and the provider this tab started, KEEP MY ACCOUNT signs in with it again (cancelDel=1); else the error as before', async () => {
  await withDom(async () => {
    let deletion = true;
    const started = [];
    const acc = { authConfig: async () => ({ deletion }), providerStarted: (p) => started.push(p), oauthUrl: (p, mode) => `/api/auth/oauth/${p}/start?${mode}` };
    assert.equal(await D.pendingFromProvider(sheetMenu(acc), null), false, 'no provider known: the toast');
    deletion = false;
    assert.equal(await D.pendingFromProvider(sheetMenu(acc), 'discord'), false, 'closed: the toast');
    deletion = true;
    const menu = sheetMenu(acc);
    assert.equal(await D.pendingFromProvider(menu, 'discord'), true);
    button(menu, 'KEEP MY ACCOUNT').click();
    await settle();
    assert.equal(window.location.href, '/api/auth/oauth/discord/start?cancelDel');
    assert.deepEqual(started, ['discord'], '"continue as" learns it when it comes back');
  });
  // The provider is read before its mark goes (an error's round trip forgets it).
  const restore = GAME.slice(GAME.indexOf('private async restoreAccount'), GAME.indexOf('// ---- experimental features'));
  assert.ok(restore.indexOf('this.accounts.startedProvider()') < restore.indexOf('this.accounts.providerAbandoned()'));
  assert.match(restore, /if \(!\(auth\.code === 'deletion_pending' && \(await pendingFromProvider\(this\.menu, keepWith\)\)\)\) this\.menu\.toast\(oauthErrorText\(auth\.code\), 'error'\);/);
});

test('AccountClient.startedProvider: the provider this tab pressed in the last 10 minutes, null after or without one', () => {
  const session = new Map();
  let now = 1_800_000_000_000;
  const acc = new AC.AccountClient({ storage: null, session: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: (k) => session.delete(k) }, fetchFn: async () => assert.fail('no request'), now: () => now });
  assert.equal(acc.startedProvider(), null);
  acc.providerStarted('discord');
  assert.equal(acc.startedProvider(), 'discord');
  now += 10 * 60_000;
  assert.equal(acc.startedProvider(), null);
});

test('deletionDone: the day it goes, the cancel mail only for an account with an address, and the receipt on screen with the request\'s time for every account', async () => {
  await withDom(async () => {
    const menu = sheetMenu({});
    const at = Date.UTC(2026, 9, 31, 15, 30);
    D.deletionDone(menu, 'Mariana', PURGE, true, at);
    assert.equal(menu.spec.title, 'Deletion requested');
    assert.ok(menu.sheet.textContent.includes(`The account Mariana is deleted on ${D.dayText(PURGE)}.`));
    assert.ok(menu.sheet.textContent.includes(en['delete.doneMail']));
    assert.ok(menu.sheet.textContent.includes(`Receipt: deletion of the account Mariana requested on ${D.dayTimeText(at)}. It is deleted on ${D.dayText(PURGE)}.`));
    D.deletionDone(menu, 'Sinmail', PURGE, false, at);
    assert.ok(!menu.sheet.textContent.includes(en['delete.doneMail']), 'no address: no mail promised');
    assert.ok(menu.sheet.textContent.includes('Receipt: deletion of the account Sinmail'));
  });
});

test("PERFIL's BORRAR CUENTA: in CUENTA Y SEGURIDAD only while the server takes deletions, never for the project's account nor on a TV; the name typed as the server compares it; reauth_required asks that level and sends the same request again; then the receipt", () => {
  const view = PROFILE.slice(PROFILE.indexOf('const accountView = '), PROFILE.indexOf('/** ACERCA DE, under either view'));
  assert.match(view, /deletionOn\(\) && me\?\.maintainer === undefined && sample === null \? secondary\(t\('delete\.button'\), \(\) => deleteDialog\(\), \{ 'data-key': 'profile-delete', class: 'mn-btn-cancel' \}\) : null,/);
  // In the fold's full branch, after SIGN OUT ON EVERY DEVICE; a TV's branch has its sign-out only.
  const tvBranch = view.slice(view.indexOf('if (tvScope)'), view.indexOf('else setChildren('));
  assert.ok(!tvBranch.includes('deleteDialog'), 'not on a TV');
  assert.ok(view.indexOf("t('profile.signOutAll')") < view.indexOf("t('delete.button')"));
  assert.match(PROFILE, /const deletionOn = \(\): boolean => authCfg\?\.deletion === true;/);
  const dialog = PROFILE.slice(PROFILE.indexOf('const deleteDialog = '), PROFILE.indexOf('/** Sign out on every device'));
  assert.match(dialog, /t\('delete\.note', \{ days: authCfg\?\.graceDays \?\? 14 \}\)/);
  assert.match(dialog, /if \(name === '' \|\| usernameKey\(confirm\.trim\(\)\) !== usernameKey\(name\)\) \{\s*typedName\.error\(t\('delete\.badName'\)\);\s*return false;/);
  assert.match(dialog, /label: t\('delete\.confirm'\),\s*danger: true,/);
  assert.match(dialog, /\{ label: t\('profile\.cancel'\), autofocus: true, onClick: \(\) => true \}/, 'CANCEL takes the first focus');
  const request = PROFILE.slice(PROFILE.indexOf('const requestDeletion = '), PROFILE.indexOf('const deleteDialog = '));
  assert.match(request, /const purgeAt = await acc\.deleteAccount\(confirm\);\s*queueMicrotask\(\(\) => deletionDone\(menu, name, purgeAt, mailed\)\);/);
  assert.match(request, /e\.code === 'reauth_required' && f !== null\) \{\s*queueMicrotask\(\(\) => fresh\(\(\) => void requestDeletion\(confirm, null\), e\.level === 2 \? 2 : 1, true\)\);/);
  // The sign-in: deletion_pending after the right password offers to keep it, while the screens are open.
  const login = PROFILE.slice(PROFILE.indexOf('const loginForm = '), PROFILE.indexOf('const signupEmailForm = '));
  assert.match(login, /if \(e instanceof AccountError && e\.code === 'deletion_pending' && deletionOn\(\)\) \{\s*void pendingSheet\(menu, e\.detail\.purgeAt \?\? 0, \(\) => signIn\(true\)\);/);
  // The config it reads redraws PERFIL when it opens the screens.
  assert.match(PROFILE, /c\.deletion === true \|\| typeof c\.terms === 'string'/);
});

test('the copy, in both languages (Spanish with tú)', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('delete.'));
  assert.ok(keys.length >= 18);
  const voseo = /\b(?:tenés|podés|querés|pedís|escribí|entrá|volvé|confirmá|vos)\b/i;
  for (const k of keys) {
    assert.equal(typeof es[k], 'string', k);
    assert.doesNotMatch(es[k], voseo, k);
  }
  assert.equal(es['delete.button'], 'BORRAR CUENTA');
  assert.equal(es['delete.keepBtn'], 'CONSERVAR MI CUENTA');
  assert.match(es['delete.receipt'], /^Constancia: /);
});
