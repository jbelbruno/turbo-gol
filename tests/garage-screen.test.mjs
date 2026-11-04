// GARAJE's decisions (src/ui/screens/garageModel.ts, plan §1.4.2 and PR 8): a row's state line, the
// detail card's button and what its press does (never lime out of reach, the reason beside it),
// the points card, which card is lime and the redeem sheet's balance; the cars' outlines
// (src/ui/components/carSilhouettes.ts). Read over src/game/garage.ts's garageView.
// Run: node --test tests/garage-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const M = await import('../src/ui/screens/garageModel.ts');
const { garageView } = await import('../src/game/garage.ts');
const { CAR_IDS, CARS } = await import('../src/game/cosmetics.ts');
const { SILHOUETTES } = await import('../src/ui/components/carSilhouettes.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

/** A shop answer: `balance` points, `owned` cars, every other car claimable when the balance covers it, else `blocked`. */
function shop(balance, { owned = [], blocked = 'insufficient', frozen = null } = {}) {
  const items = CARS.filter((c) => c.price > 0).map((c) => {
    const own = owned.includes(c.id);
    const claimable = !own && frozen === null && balance >= c.price;
    return { id: c.id, kind: 'car', name: c.id, description: '', cost: c.price, status: 'available', owned: own, claimable, ...(own || claimable ? {} : { blocked: frozen !== null ? 'frozen' : blocked }) };
  });
  return { items, wallet: { earned: balance, spent: 0, balance, frozen } };
}
const guest = (selected = null) => garageView({ signedIn: false, equipped: 'dune', owned: [], shop: null, selected });
const account = (s, selected = null, equipped = 'dune') => garageView({ signedIn: true, equipped, owned: s.items.filter((i) => i.owned).map((i) => i.id), shop: s, selected });

test('a row says its state: Equipado · Gratis for the free car, Tuyo, Canjeable / Bloqueado with the price', () => {
  const v = account(shop(2100, { owned: ['pampero'] }));
  const by = Object.fromEntries(v.cars.map((c) => [c.id, M.rowLine(c)]));
  assert.deepEqual(by.dune, { key: 'garage.stateEquippedFree' });
  assert.deepEqual(by.pampero, { key: 'garage.stateOwned' });
  assert.deepEqual(by.carpincho, { key: 'garage.stateClaimable', params: { points: 1500 } });
  const poor = account(shop(0));
  assert.deepEqual(M.rowLine(poor.cars[1]), { key: 'garage.stateLocked', params: { points: 1500 } });
  const drivesPampero = account(shop(0, { owned: ['pampero'] }), null, 'pampero');
  assert.deepEqual(M.rowLine(drivesPampero.cars.find((c) => c.id === 'pampero')), { key: 'garage.stateEquipped' }, 'a car with a price is not "Gratis"');
});

test('a guest: CANJEAR is never lime, says to sign in, and its press opens the sign-in', () => {
  const v = guest('pampero');
  const d = M.detailView(v.selected, v);
  assert.equal(d.button, 'redeem');
  assert.equal(d.lime, false);
  assert.equal(d.press, 'signIn');
  assert.deepEqual(d.reason, { key: 'garage.needSignIn' });
  const p = M.pointsCard(v, { signedIn: false, loading: false, error: null });
  assert.deepEqual(p, { kind: 'guest', points: 0, paused: false });
});

test('0 points: CANJEAR says how many are missing, is never lime, and explains how points are earned', () => {
  for (const balance of [0, 600]) {
    const v = account(shop(balance), 'carpincho');
    const d = M.detailView(v.selected, v);
    assert.equal(d.lime, false, `${balance} pts`);
    assert.equal(d.press, 'earn');
    assert.deepEqual(d.reason, { key: 'garage.missing', params: { have: balance, missing: 1500 - balance } });
    assert.equal(d.tone, 'lock');
  }
});

test('enough points: CANJEAR is the lime action and opens the redeem sheet; GANA PUNTOS steps back from lime', () => {
  const v = account(shop(2100), 'condor');
  const d = M.detailView(v.selected, v);
  assert.deepEqual([d.button, d.lime, d.press, d.reason], ['redeem', true, 'redeem', null]);
  assert.equal(M.earnIsLime(v), false);
  assert.equal(M.earnIsLime(account(shop(0))), true);
  assert.equal(M.earnIsLime(guest()), true);
  assert.deepEqual(M.redeemBalance(1500, 2100), { from: 2100, to: 600 });
  assert.deepEqual(M.redeemBalance(1500, 900.7), { from: 900, to: 0 }, 'whole points, never below 0');
});

test('owned: EQUIPAR (lime); driven: no button, "Lo usas en tu próximo partido"; paused: --warn and PERFIL', () => {
  const v = account(shop(0, { owned: ['tero'] }), 'tero');
  assert.deepEqual(M.detailView(v.selected, v), { button: 'equip', lime: true, press: 'equip', reason: null, tone: 'plain' });
  const driven = M.detailView(v.cars[0], v);
  assert.equal(driven.button, null);
  assert.deepEqual(driven.reason, { key: 'garage.inUse' });
  const paused = account(shop(1800, { frozen: 'review' }), 'pampero');
  const d = M.detailView(paused.selected, paused);
  assert.deepEqual([d.lime, d.press, d.tone], [false, 'profile', 'warn']);
  assert.equal(M.pointsCard(paused, { signedIn: true, loading: false, error: null }).paused, true);
});

test('the points card waits for the shop, then shows its balance', () => {
  const none = garageView({ signedIn: true, equipped: 'dune', owned: [], shop: null, selected: null });
  assert.equal(M.pointsCard(none, { signedIn: true, loading: true, error: null }).kind, 'loading');
  assert.equal(M.pointsCard(none, { signedIn: true, loading: false, error: 'down' }).kind, 'error');
  assert.deepEqual(M.pointsCard(account(shop(2100)), { signedIn: true, loading: false, error: null }), { kind: 'account', points: 2100, paused: false });
  const s = M.detailView(none.cars[1], none);
  assert.deepEqual([s.lime, s.press], [false, null], 'the shop has not answered: nothing to press yet');
});

test('revealDelta: the row picked comes wholly into the list as block nearest would (a phone held sideways)', () => {
  // 844 x 390, Pampero tapped: the detail grew from 38 to 100 px, the list shrank to 178..268 and
  // the row slid down to 252..310 (16 px of it in sight). Scroll padding 8 px.
  const list = { top: 178, bottom: 268 };
  assert.equal(M.revealDelta({ top: 252, bottom: 310 }, list, 8), 50, 'down until its bottom clears the padding');
  assert.equal(M.revealDelta({ top: 186, bottom: 244 }, list, 8), 0, 'already in view: nothing moves');
  assert.equal(M.revealDelta({ top: 120, bottom: 178 }, list, 8), -66, 'above the view: up to its top');
  // 667 x 375: a view of 59 px for a 58 px row, the row cut by the fold.
  assert.equal(M.revealDelta({ top: 252, bottom: 310 }, { top: 178, bottom: 253 }, 8), 65);
  // A row taller than the view shows its top.
  assert.equal(M.revealDelta({ top: 260, bottom: 400 }, list, 8), 74);
});

test('the preview rests 300 ms; redeeming is held 700 ms (plan §1.4.2, §1.7)', () => {
  assert.equal(M.PREVIEW_MS, 300);
  assert.equal(M.REDEEM_HOLD_MS, 700);
});

test('every row and detail key exists in English and Spanish', () => {
  const keys = new Set(['garage.stateEquippedFree', 'garage.stateEquipped', 'garage.stateOwned', 'garage.stateClaimable', 'garage.stateLocked', 'garage.stateSoon', 'garage.inUse', 'garage.needSignIn', 'garage.missing', 'garage.needFrozen', 'garage.needMatches', 'garage.needLoading', 'garage.needUnavailable', 'garage.soonText']);
  for (const k of keys) {
    assert.equal(typeof en[k], 'string', 'en ' + k);
    assert.equal(typeof es[k], 'string', 'es ' + k);
  }
  assert.equal(es['points.only'], 'Solo se ganan alojando un servidor comunitario. Hoy nadie los gana. Nunca se venden.', "the owner's words as drawn, and what the terms say of today");
  assert.equal(es['garage.missing'], 'Tienes {have} pts: te faltan {missing}');
});

test('how points are earned, as the terms say it (Términos 11.1 and 12.1.2): only by hosting a community server, and today only the project has servers and nobody can register one, so no text invites a player to host one, and none sets a date', () => {
  const copy = {
    'garage.earn': ['ALOJAR UN SERVIDOR DA PUNTOS: AÚN NO ABIERTO', 'HOSTING A SERVER EARNS POINTS: NOT OPEN YET'],
    'garage.earnSub': ['Cómo funciona · ver la guía', 'How it works · see the guide'],
    'garage.earnShort': ['Cómo se ganan', 'How they are earned'],
    'garage.guideTitle': ['Cómo se ganan los puntos de servidor', 'How server points are earned'],
    'garage.guideText': ['Se ganan solo alojando un servidor comunitario, nunca jugando. Hoy solo el proyecto tiene servidores: aún no puedes registrar uno.', 'Earned only by hosting a community server, never by playing. Today only the project runs servers: you cannot register one yet.'],
    'points.only': ['Solo se ganan alojando un servidor comunitario. Hoy nadie los gana. Nunca se venden.', 'Earned only by hosting a community server. Nobody earns them yet. Never sold.'],
    'profile.hostServer': ['Guía de servidores', 'Server guide'],
  };
  for (const [k, [want, wantEn]] of Object.entries(copy)) {
    assert.equal(es[k], want, 'es ' + k);
    assert.equal(en[k], wantEn, 'en ' + k);
    // No call to host (Aloja, Pon un servidor, Gana puntos; Host a, Earn points), no machine to host it
    // on, and nothing that promises when.
    assert.doesNotMatch(es[k], /\b(?:aloja|pon un servidor|gana puntos|vps|tu pc|próximamente|pronto)\b/i, 'es ' + k);
    assert.doesNotMatch(en[k], /\b(?:host a|earn points|vps|your pc|coming soon|soon)\b/i, 'en ' + k);
  }
  // The card says it even where its second line is hidden (a short screen, a TV: garage.css).
  assert.match(es['garage.earn'], /AÚN NO/);
  assert.match(en['garage.earn'], /NOT OPEN YET/);
  // The layout keeps its room: the card's title and the links' words about as long as before.
  assert.ok(es['garage.earn'].length <= 48 && en['garage.earn'].length <= 46);
  assert.ok(es['profile.hostServer'].length <= 20 && en['profile.hostServer'].length <= 16);
});

test('one outline per car, on the 72 x 36 grid, the wheels on the ground', () => {
  assert.deepEqual(Object.keys(SILHOUETTES).sort(), [...CAR_IDS].sort());
  const bodies = new Set();
  for (const id of CAR_IDS) {
    const s = SILHOUETTES[id];
    assert.match(s.body, /^M[\d.\sMLHVQZ-]+Z$/, id);
    bodies.add(s.body);
    for (const n of s.body.match(/-?\d+(?:\.\d+)?/g).map(Number)) assert.ok(n >= 0 && n <= 72, `${id}: ${n}`);
    for (const [x, r] of s.wheels) {
      assert.ok(x - r >= 0 && x + r <= 72, `${id}: wheel at ${x}`);
      assert.ok(r >= 4 && r <= 8, `${id}: radius ${r}`);
    }
  }
  assert.equal(bodies.size, CAR_IDS.length, 'five different drawings');
});
