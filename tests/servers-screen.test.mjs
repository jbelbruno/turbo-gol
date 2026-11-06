// "Mis servidores" and the rest of the community's hosting in the game (Prompt 2, P2-3) without a
// browser: the one gate (GET /api/config `hosting`, owner's decision 1: deployed dark, nothing shown or
// sent until it says hosting is open), the screen's pure model (screens/serversModel.ts: its views,
// what a host lacks, the acceptance's body, a code's follow-up, a server's facts and its owner's
// actions, #servers), the acceptance strings of PR 2A verbatim, the community server's mark in PARTIDO
// ENCONTRADO and the FINAL (never a project server's) and REPORTAR SERVIDOR (a community server's
// only), both by the Worker's mark and never the config, "Solo servidores del proyecto" (its row once
// open or while on, sent whenever on), PERFIL's and GARAJE's entries, the TV's QR, the
// panel's opening control and Operadores tab, AccountClient's new calls on a fake fetch, and the
// screen's source rules (text only, nothing stored, never a TV's action).
//   node --test tests/servers-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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
});

const SM = await import('../src/ui/screens/serversModel.ts');
const N = await import('../src/net/nodes.ts');
const NC = await import('../src/net/NetClient.ts');
const FM = await import('../src/ui/screens/match/finalModel.ts');
const AM = await import('../src/ui/screens/nodesAdminModel.ts');
const AC = await import('../src/net/AccountClient.ts');
const L = await import('../src/ui/screens/accountLinksModel.ts');
const CP = await import('../nodes/control-plane/controlPlane.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SERVERS = src('src/ui/screens/servers.ts');
const GAME = src('src/game/Game.ts');
const FINAL = src('src/ui/screens/match/final.ts');
const SETTINGS = src('src/ui/screens/settings/view.ts');
const ADMIN = src('src/ui/screens/nodesAdmin.ts');
const MENU = src('src/ui/Menu.ts');
const BACK = src('src/ui/backGuard.ts');
const PROFILE = src('src/ui/screens/profile.ts');

/** The body of `name`'s arrow or function in `text`, up to the next declaration at its indent. */
const fnOf = (text, name) => {
  const m = new RegExp(`\\n( *)(?:export )?(?:async )?(?:const|function) ${name}\\b`).exec(text);
  assert.ok(m, name);
  const rest = text.slice(m.index + 1);
  const next = rest.slice(1).search(new RegExp(`\\n${m[1]}(?:/\\*\\*|//|(?:export )?(?:async )?(?:const|function|let) )`));
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const mineAnswer = (o = {}) => ({
  operator: { id: '0a1b2c3d4e5f6071', trusted: false },
  nodes: [],
  rewards: null,
  hosting: { open: true },
  requirements: { missing: [], daysLeft: 0 },
  terms: { version: '2026-11-13', accepted: true },
  limits: { nodes: 0, maxNodes: 3, tokensToday: 0, tokensLeftToday: 3, outstanding: 0, maxOutstanding: 2 },
  tokens: [],
  showPublic: false,
  channel: { stable: '0.3.1', minimum: '0.3.0' },
  ...o,
});
const node = (o = {}) => ({ nodeId: 'a'.repeat(16), name: 'juan-1', region: 'SA', status: 'active', statusReason: null, suspendedUntil: null, online: true, roles: ['host'], transports: ['wss'], trusted: false, publicUrl: 'wss://j1.example.com', reachable: true, active: 2, capacity: { matches: 40 }, tickLagP99Ms: 4.4, egressGB: 12, counters: { assigned: 30, verified: 25, rankedVerified: 0, failedVerification: 0, lost: 0, strikes: 1, probationVerified: 20 }, version: '0.3.1', compatible: true, ...o });

// ---- the gate: dark until GET /api/config says hosting is open --------------------------------------------

test('dark (decision 1): without `hosting.open` from GET /api/config nothing of hosting is shown, sent or opened', async () => {
  for (const cfg of [null, undefined, {}, { hosting: null }, { hosting: { open: false, stage: 'closed' } }, { hosting: { open: 'true' } }, { hosting: { open: 1 } }]) {
    const open = SM.hostingOpen(cfg);
    assert.equal(open, false, JSON.stringify(cfg));
    assert.equal(SM.serversViewOf({ open, signedIn: true, mine: mineAnswer(), failed: false }), 'dark', 'the screen draws nothing');
    assert.equal(SM.hostEntry(open), 'guide', "PERFIL's and GARAJE's entries keep the guide");
    assert.equal(SM.serversLinkTarget(open), 'profile', '#servers resolves to PERFIL (no new text)');
    assert.equal(SM.projectOnlyShown(open, false), false, 'no "Solo servidores del proyecto" row: before any opening it cannot be on');
  }
  // The choice is off until its row is shown: before any opening the search's body has no projectOnly
  // (tests/net-hardening.test.mjs pins the body), whatever a stored object says but `true`.
  const P = await import('../src/ui/prefs.ts');
  assert.equal(P.DEFAULT_PREFS.projectOnly, false);
  assert.equal(P.parsePrefs(null).projectOnly, false);
  // The mark and REPORTAR SERVIDOR are dark by what arrives, never by the config (P2-2's rule: the
  // flag closed again, or its read failed, while community servers still host): before an opening no
  // community server exists, so no mark says `community: true`; a project server's says false (none
  // at all before the terms describe hosting).
  for (const server of [null, undefined, { name: 'sao-paulo-1', community: false }]) {
    assert.equal(SM.communityMarked(server), false, 'no mark: ' + JSON.stringify(server));
    assert.equal(SM.reportOffered({ server, signedIn: true, matchId: 'e'.repeat(64), reported: false }), false, 'no REPORTAR SERVIDOR');
    assert.equal(FM.finalServerLine({ node: 'sao-paulo-1', server }).community, false, "the FINAL's slot neither");
  }
  for (const stage of ['canary', 'all']) {
    const cfg = { hosting: { open: true, stage } };
    assert.equal(SM.hostingOpen(cfg), true);
    assert.equal(SM.hostEntry(true), 'servers');
    assert.equal(SM.serversLinkTarget(true), 'servers');
  }
});

test('GET /api/config: `hosting` read only as it is (open with a canary or every account); an older Worker, junk or a closed stage is closed, and no field at all without one', () => {
  assert.equal('hosting' in NC.parseServerConfig({}), false, 'the config of before, byte for byte');
  assert.deepEqual(NC.parseServerConfig({ hosting: { open: true, stage: 'canary' } }).hosting, { open: true, stage: 'canary' });
  assert.deepEqual(NC.parseServerConfig({ hosting: { open: true, stage: 'all' } }).hosting, { open: true, stage: 'all' });
  assert.deepEqual(NC.parseServerConfig({ hosting: { open: false, stage: 'closed' } }).hosting, { open: false, stage: 'closed' });
  assert.deepEqual(NC.parseServerConfig({ hosting: { open: true, stage: 'closed' } }).hosting, { open: false, stage: 'closed' }, 'open only with a stage that is open');
  assert.deepEqual(NC.parseServerConfig({ hosting: { open: 'yes', stage: 'all' } }).hosting, { open: false, stage: 'all' });
  assert.equal('hosting' in NC.parseServerConfig({ hosting: 'open' }), false);
  // The Game hands it to the Menu as it came.
  assert.match(GAME, /terms: c\.terms \?\? null, hosting: c\.hosting \?\? null \}/);
});

test('dark at the screen: show() draws nothing, asks nothing and goes back; the refresh and the load ask only once open; #servers opens PERFIL before', () => {
  const show = SERVERS.slice(SERVERS.indexOf("    id: 'servers',"), SERVERS.indexOf('    tick: () => {'));
  assert.match(show, /if \(sample === null && !hostingOpen\(menu\.cfg\)\) \{\s*drawn = 'dark';\s*setChildren\(status\);\s*setChildren\(body\);\s*if \(menu\.cfg !== null\) queueMicrotask\(\(\) => \(menu\.top\(\)\?\.id === 'servers' \? menu\.back\(\) : undefined\)\);\s*return;\s*\}/);
  assert.ok(show.indexOf('drawn = \'dark\'') < show.indexOf('paint()'), 'returns before any paint');
  assert.match(fnOf(SERVERS, 'load'), /if \(who === null \|\| !hostingOpen\(menu\.cfg\)\) return; \/\/ dark: nothing is asked/);
  assert.match(SERVERS, /tick: \(\) => \{\s*if \(sample !== null \|\| !hostingOpen\(menu\.cfg\) \|\| !acc\.signedIn\) return;/);
  // GET /nodes/mine only from load (behind the gate), POST /nodes/tokens only from mint (a press on PEDIR CÓDIGO).
  assert.equal([...SERVERS.matchAll(/acc\.nodesMine\(\)/g)].length, 1);
  assert.equal([...SERVERS.matchAll(/acc\.nodesToken\(/g)].length, 1);
  assert.match(fnOf(SERVERS, 'installServersLink'), /menu\.open\(serversLinkTarget\(hostingOpen\(menu\.cfg\)\)\);/);
  assert.match(fnOf(SERVERS, 'installServersLink'), /if \(!menu\.visible \|\| menu\.modalOpen \|\| menu\.cfg === null\)/, 'waits for the config, the menus and no sheet');
  // PERFIL's MI SERVIDOR and COMUNIDAD: the gate first.
  assert.match(PROFILE, /const open = hostingOpen\(menu\.cfg\);\s*const toServers = open && v\.hostOpen === true \?/);
});

test('#servers: a bare flag, alone or among others, cleared on its own (the other flags stay); a hashchange to it is a navigation, never a Back; in its turn of the URL arbiter', () => {
  for (const h of ['#servers', 'servers', '#tv&servers', '#servers&tv']) assert.equal(SM.hasServersLink(h), true, h);
  for (const h of ['', '#', '#serversx', '#servers=1', '#sala=ABC234', '#auth=linked', '#ui=servers']) assert.equal(SM.hasServersLink(h), false, h);
  assert.equal(SM.withoutServersLink('#servers'), '');
  assert.equal(SM.withoutServersLink('#tv&servers'), '#tv');
  assert.equal(SM.withoutServersLink('#servers&tv&lowgpu'), '#tv&lowgpu');
  assert.match(BACK, /if \(typeof location !== 'undefined' && \/\(\?:\^#\|&\)servers\(\?:&\|\$\)\/\.test\(location\.hash\)\) return;/);
  assert.match(fnOf(SERVERS, 'installServersLink'), /history\.replaceState\(history\.state, '', location\.pathname \+ location\.search \+ withoutServersLink\(location\.hash\)\);/);
  // Read on load and on a later hashchange (B1): a #servers typed or opened in this tab opens too.
  assert.match(fnOf(SERVERS, 'installServersLink'), /pending = take\(\);\s*window\.addEventListener\('hashchange', \(\) => \{\s*if \(!take\(\)\) return;\s*pending = true;\s*tryOpen\(\);\s*\}\);/);
  assert.match(GAME, /new UrlSheets\(\['auth', 'account', 'servers', 'tv'\] as const\)/);
  // A provider's round trip clears the hash: a guest's SIGN IN comes back by the Detour instead.
  const at = 1_000_000;
  assert.deepEqual(L.detourOf(JSON.stringify({ screen: 'servers', at }), at), { screen: 'servers' });
  assert.match(SERVERS, /keepDetour\(\{ screen: 'servers' \}\);\s*menu\.open\('profile', false, undefined, true\);/);
});

// ---- the screen's views and its add flow ------------------------------------------------------------------

test("the views: a guest signs in first; loading and failure; a project account's servers are the panel's; open but not for this account; a host", () => {
  const v = (o) => SM.serversViewOf({ open: true, signedIn: true, mine: null, failed: false, ...o });
  assert.equal(v({ signedIn: false }), 'guest');
  assert.equal(v({}), 'loading');
  assert.equal(v({ failed: true }), 'error');
  assert.equal(v({ mine: mineAnswer({ operator: { id: 'x', trusted: true } }) }), 'project');
  assert.equal(v({ mine: mineAnswer({ hosting: { open: false, reason: 'hosting_closed' } }) }), 'closed', 'a canary it is not in');
  assert.equal(v({ mine: mineAnswer({ hosting: undefined }) }), 'closed', 'an older server: closed');
  assert.equal(v({ mine: mineAnswer() }), 'host');
  // The closed view's words by the config's stage: "only invited people" during a canary alone; open
  // to everyone (the Worker's and the object's reads apart, a failed read) or unknown, a neutral line
  // and a retry.
  assert.equal(SM.closedKeyOf('canary'), 'servers.closed');
  for (const stage of ['all', 'closed', undefined, null, 'x']) assert.equal(SM.closedKeyOf(stage), 'servers.closedNow', String(stage));
  assert.doesNotMatch(es['servers.closedNow'], /invitad/i);
  assert.doesNotMatch(en['servers.closedNow'], /invited/i);
  const closed = fnOf(SERVERS, 'closedView');
  assert.match(closed, /const key = closedKeyOf\(sample !== null \? 'canary' : menu\.cfg\?\.hosting\?\.stage\);/);
  assert.match(closed, /h\('p', null, t\(key\)\)/);
  assert.match(closed, /key === 'servers\.closedNow' \? h\('div\.mn-na-tools', null, secondary\(t\('garage\.retry'\), \(\) => \(\(clock = refreshResume\(clock, Date\.now\(\)\)\), void load\(\)\)/);
});

test('what a host lacks, in the server\'s order and only the codes this client knows; the acceptance step while the account holds none for the terms in force', () => {
  assert.deepEqual(SM.requirementsOf(mineAnswer({ requirements: { missing: ['operator_blocked', 'email_required', 'something_new', 'account_too_new', 'terms_required'], daysLeft: 3 } })), ['operator_blocked', 'email_required', 'account_too_new', 'terms_required']);
  assert.deepEqual(SM.requirementsOf(mineAnswer({ requirements: null })), []);
  assert.deepEqual(SM.requirementsOf(null), []);
  assert.equal(SM.acceptanceNeeded(mineAnswer()), false);
  assert.equal(SM.acceptanceNeeded(mineAnswer({ terms: { version: '2026-11-13', accepted: false } })), true);
  assert.equal(SM.acceptanceNeeded(mineAnswer({ terms: null })), true, 'unknown: the request carries it');
  assert.equal(SM.acceptanceNeeded(null), true);
  // Every requirement has its words, the days left as a plural.
  for (const r of ['operator_blocked', 'email_required', 'deletion_pending', 'terms_required']) for (const m of [es, en]) assert.equal(typeof m[`servers.req.${r}`], 'string', r);
  assert.equal(typeof es['servers.req.account_too_new'].one, 'string');
  assert.equal(typeof en['servers.req.account_too_new'].other, 'string');
  // Its fix: the email by PERFIL's own dialog (exported from profile.ts, never a copy), the terms by their re-accept sheet.
  assert.match(SERVERS, /emailDialog\(menu, mode === 'change' \? 'add' : mode\)/);
  assert.match(PROFILE, /export function emailDialog\(menu: Menu, mode: 'add' \| 'change' \| 'confirm', direct = false\): void \{/);
  assert.match(SERVERS, /void reacceptTerms\(menu\)/);
  // With the mail off (GET /api/config auth.email false), PERFIL's line instead of the dialog, whose code could never arrive.
  const req = fnOf(SERVERS, 'requirementLine');
  assert.match(SERVERS, /const mailOn = \(\): boolean => authCfg\?\.email !== false;/);
  assert.match(PROFILE, /const mailOn = \(\): boolean => authCfg\?\.email !== false;/, "PERFIL's own rule");
  assert.match(req, /const mailOff = r === 'email_required' && sample === null && !mailOn\(\);/);
  assert.match(req, /r === 'email_required' && !mailOff\s*\? secondary\(/);
  assert.match(req, /mailOff \? h\('p\.mn-note', null, mailOffText\(menu\)\) : null\);/);
  assert.match(fnOf(SERVERS, 'paintAdd'), /\$\{reqs\.includes\('email_required'\) \? mailOn\(\) : ''\}/, 'the config arriving redraws the line');
});

test("the code's body (A3, PR 2A): a host only, by wss, pinned to its DNS name; while needed the button sends acceptHost and the switch adult; never verify; an empty name is the server's default", () => {
  const form = { region: 'SA', name: '', host: ' Srv1.Example.com ', roles: 'host,verify', matches: 'auto', egress: '' };
  assert.deepEqual(SM.communityAsk(form, { needed: true, adult: true }), { region: 'SA', publicHost: 'srv1.example.com', roles: ['host'], matches: 'auto', acceptHost: true, adult: true });
  assert.deepEqual(SM.communityAsk(form, { needed: true, adult: false }), { region: 'SA', publicHost: 'srv1.example.com', roles: ['host'], matches: 'auto', acceptHost: true, adult: false }, 'the switch off: the server answers adult_required (the screen says it first)');
  assert.deepEqual(SM.communityAsk({ ...form, name: 'juan-1', egress: '500' }, { needed: false, adult: true }), { region: 'SA', name: 'juan-1', publicHost: 'srv1.example.com', roles: ['host'], matches: 'auto', egressCapGB: 500 }, 'held already: no acceptance, no declaration');
  assert.deepEqual(N.tokenFormIssues(form, { used: 0, max: 3 }, true), [], 'the name is optional here');
  assert.deepEqual(N.tokenFormIssues(form, { used: 0, max: 3 }).map((i) => i.field), ['name'], "the project's wizard names every machine");
  assert.deepEqual(N.tokenFormIssues({ ...form, host: '203.0.113.7' }, { used: 3, max: 3 }, true).map((i) => i.field), ['host', 'slots']);
  // The screen refuses the switch off locally and sends nothing; the 403 of reauth_required opens "confirm it's you" and asks again.
  const mint = fnOf(SERVERS, 'mint');
  // `needed` is the answer's (acceptanceNeeded), never a constant: acceptHost and adult go while the account holds no acceptance.
  assert.match(mint, /const m = answer\(\);\s*const needed = acceptanceNeeded\(m\);\s*const ask = communityAsk\(w\.form, \{ needed, adult: w\.adult \}\);/);
  assert.match(mint, /if \(code === 'reauth_required' \|\| code === 'password_required'\) return confirmItsYou\(menu, \(\) => void mint\(w\), 2, true\);/);
  assert.doesNotMatch(SERVERS, /acc\.fresh\(/, 'the 403 decides, never the client clock');
  assert.match(fnOf(SERVERS, 'checklistStep'), /if \(needed && !w\.adult\) \{\s*adultErr\.textContent = t\('nodesShared\.err\.adult_required'\);/);
});

test('the acceptance step uses PR 2A\'s screen strings verbatim (es and en), the switch above the line above PEDIR CÓDIGO, its links to Terms §12, Annex B and the privacy policy', () => {
  const verbatim = {
    'servers.adult': ['Tengo 18 años o más', 'I am 18 or older'],
    'servers.adultHint': ['Lo declaras tú: no lo comprobamos.', 'You declare it: we do not check it.'],
    'servers.acceptLine': [
      'Al tocar «{button}» aceptas las {rules} (sección 12 de los Términos) y el {annex}, y declaras tener 18 años o más. Guardamos que lo aceptaste, con la versión y la fecha. Lee también la {privacy}.',
      'By pressing "{button}" you accept the {rules} (section 12 of the Terms) and {annex}, and declare that you are 18 or older. We keep that you accepted, with the version and the date. Also read the {privacy}.',
    ],
    'servers.acceptRules': ['reglas para anfitriones', 'rules for hosts'],
    'servers.acceptAnnex': ['Anexo B', 'Annex B'],
    'servers.getCode': ['PEDIR CÓDIGO', 'GET CODE'],
    'servers.acceptSummary': [
      'Para alojar un servidor de la comunidad aceptas las reglas para anfitriones: usar solo el programa oficial, cuidar los datos de los jugadores (los recibes por encargo nuestro y no los guardas después de la partida, salvo los registros técnicos de tu máquina con direcciones IP, 7 días como máximo), no manipular partidas y cuidar tu máquina. Por ahora tu servidor no recibe partidas de COMPETITIVO, y los puntos de servidor tienen un tope por día.',
      "To host a community server you accept the rules for hosts: use only the official program, look after the players' data (you get it on our behalf and do not keep it after the match, except your machine's technical logs with IP addresses, 7 days at most), do not tamper with matches and look after your machine. For now your server gets no COMPETITIVE matches, and server points have a cap per day.",
    ],
    'servers.title': ['MIS SERVIDORES', 'MY SERVERS'],
    'settings.projectOnly': ['Solo servidores del proyecto', 'Project servers only'],
  };
  for (const [k, [want, wantEn]] of Object.entries(verbatim)) {
    assert.equal(es[k], want, 'es ' + k);
    assert.equal(en[k], wantEn, 'en ' + k);
  }
  assert.equal(SM.hostRulesHref('es'), '/terminos#12-anfitriones-de-servidores-de-la-comunidad');
  assert.equal(SM.annexHref('es'), '/terminos#anexo-b-clausulas-para-quien-aloja-un-servidor-de-la-comunidad');
  assert.equal(SM.hostRulesHref('en'), '/terms#12-community-server-hosts');
  assert.equal(SM.annexHref('en'), '/terms#annex-b-clauses-for-whoever-hosts-a-community-server');
  // {button} is the button's label as shown; the switch, then the line, then the button.
  const step = fnOf(SERVERS, 'checklistStep');
  assert.match(step, /const button = t\('servers\.getCode'\);/);
  // Shown exactly while the account holds no acceptance for the terms in force (acceptanceNeeded of the answer).
  assert.match(step, /const m = answer\(\);\s*const needed = acceptanceNeeded\(m\);/);
  assert.match(step, /\.\.\.\(needed \? \[h\('p', readOnly\('srv-accept-summary'\), t\('servers\.acceptSummary'\)\), setRow\(t\('servers\.adult'\)/);
  assert.match(step, /setRow\(t\('servers\.adult'\), adult\.el, t\('servers\.adultHint'\)\), adultErr, acceptLine\(button\)\] : \[\]\),\s*h\('div\.mn-na-actions', null, primary\(button, go/);
  const line = fnOf(SERVERS, 'acceptLine');
  assert.match(line, /t\('servers\.acceptLine', \{ button \}\)\.split\(\/\(\\\{rules\\\}\|\\\{annex\\\}\|\\\{privacy\\\}\)\/\)/);
  assert.match(line, /outLink\(hostRulesHref\(lang\), t\('servers\.acceptRules'\)/);
  assert.match(line, /outLink\(annexHref\(lang\), t\('servers\.acceptAnnex'\)/);
  assert.match(line, /outLink\(legalPaths\(lang\)\.privacy, t\('legal\.privacyLink'\)/);
});

test("a code's follow-up from /nodes/mine alone: waiting, expired, revoked, then its server to active; gone when no longer listed", () => {
  const now = 1_000_000;
  const tk = (o = {}) => ({ id: 'abcdef123456', region: 'SA', name: 'juan-1', publicHost: 'j1.example.com', createdAt: now - 1, expiresAt: now + 60_000, state: 'unused', nodeId: null, ...o });
  assert.equal(SM.followMine(mineAnswer({ tokens: [tk()] }), 'abcdef123456', now).step, 'waiting');
  assert.equal(SM.followMine(mineAnswer({ tokens: [tk({ expiresAt: now - 1 })] }), 'abcdef123456', now).step, 'expired');
  assert.equal(SM.followMine(mineAnswer({ tokens: [tk({ state: 'revoked' })] }), 'abcdef123456', now).step, 'revoked');
  const used = tk({ state: 'used', nodeId: 'a'.repeat(16) });
  assert.equal(SM.followMine(mineAnswer({ tokens: [used] }), 'abcdef123456', now).step, 'pending', 'registered, not listed yet');
  for (const status of ['pending', 'probation', 'active']) assert.equal(SM.followMine(mineAnswer({ tokens: [used], nodes: [node({ status })] }), 'abcdef123456', now).step, status);
  for (const status of ['suspended', 'banned']) assert.equal(SM.followMine(mineAnswer({ tokens: [used], nodes: [node({ status })] }), 'abcdef123456', now).step, 'stopped');
  assert.equal(SM.followMine(mineAnswer(), 'abcdef123456', now).step, 'gone');
  // Every step has its words; an expired code's help names the installer's refusals and their fixes.
  for (const s of ['waiting', 'expired', 'revoked', 'pending', 'probation', 'active', 'stopped', 'gone']) for (const m of [es, en]) assert.equal(typeof m[`servers.follow.${s}`], 'string', s);
  assert.deepEqual([...SM.INSTALL_ERRORS], ['region_mismatch', 'rtc_not_available', 'ip_not_supported', 'public_host_mismatch', 'behind_proxy']);
  for (const c of SM.INSTALL_ERRORS) for (const m of [es, en]) assert.equal(typeof m[`servers.fix.${c}`], 'string', c);
});

test("a server's card: load against the matches placement lets it run, the version against the channel's minimum, strikes in their window, refusals; its owner's actions as the server's guards answer", () => {
  const f = SM.nodeFacts(node({ capacityEffective: 16, strikes: { count: 1, max: 3, windowDays: 7 }, refused: { count: 3, rate: 0.091, recent: 1, of: 10, outUntil: null } }), { minimum: '0.3.0' });
  assert.deepEqual([f.tone, f.live, f.load, f.version, f.seen, f.refusalRate], ['ok', true, { active: 2, capacity: 16 }, 'compatible', 'now', 0.091]);
  assert.equal(SM.nodeFacts(node(), { minimum: '0.3.0' }).load.capacity, 40, 'an older server: its declared capacity');
  assert.equal(SM.nodeFacts(node({ version: '0.2.9' }), { minimum: '0.3.0' }).version, 'update', 'below the minimum');
  assert.equal(SM.nodeFacts(node({ version: '0.3.1', compatible: false }), null).version, 'update', 'another build than the network');
  assert.equal(SM.nodeFacts(node({ version: '0.3.10' }), { minimum: '0.3.9' }).version, 'compatible', 'numbers, not text');
  assert.equal(SM.nodeFacts(node({ online: false, lastSeen: 5 }), null).seen, 5);
  const o = { tv: false, open: true, blocked: false };
  assert.deepEqual(SM.ownerActions(node(), o), { drain: true, rename: true, retire: false }, 'serving: drain first');
  assert.deepEqual(SM.ownerActions(node({ draining: true, active: 0 }), o), { drain: false, rename: true, retire: true });
  assert.deepEqual(SM.ownerActions(node({ online: false }), o), { drain: false, rename: true, retire: true });
  assert.deepEqual(SM.ownerActions(node({ status: 'suspended', online: false }), o), { drain: false, rename: true, retire: false }, '409 suspended');
  assert.deepEqual(SM.ownerActions(node({ status: 'banned' }), o), { drain: false, rename: false, retire: false }, '409 banned');
  assert.deepEqual(SM.ownerActions(node(), { ...o, blocked: true }).rename, false, '403 operator_blocked');
  assert.deepEqual(SM.ownerActions(node(), { ...o, open: false }).rename, false, '403 hosting_closed');
  assert.deepEqual(SM.ownerActions(node({ online: false }), { ...o, tv: true }), { drain: false, rename: false, retire: false }, 'never on a TV');
  assert.equal(SM.ownRevocable({ state: 'unused', expiresAt: 10 }, 5), true);
  assert.equal(SM.ownRevocable({ state: 'unused', expiresAt: 4 }, 5), false);
  assert.equal(SM.ownRevocable({ state: 'used', expiresAt: 10 }, 5), false);
  // The ways back: a drain's restart on the machine, a retirement's uninstall (install.sh's header).
  assert.equal(SM.RESTART_LINE, 'sudo systemctl restart turbogol-node');
  assert.match(src('nodes/install/install.sh'), /systemctl disable --now turbogol-node.*rm -rf \/opt\/turbogol-node\s*\n#\s+\/var\/lib\/turbogol-node \/etc\/systemd\/system\/turbogol-node\.service; userdel turbogol;/);
  assert.deepEqual([...SM.UNINSTALL_LINES], ['sudo systemctl disable --now turbogol-node', 'sudo rm -rf /opt/turbogol-node /var/lib/turbogol-node /etc/systemd/system/turbogol-node.service', 'sudo userdel turbogol']);
  // RETIRAR is held to confirm, as GARAJE's redeem.
  assert.match(fnOf(SERVERS, 'retireSheet'), /hold: \{ ms: 700, held: \(\) => menu\.host\.acceptHeld\?\.\(\) \?\? false \}/);
});

test("the capacity caps the form names are the control plane's (PROBATION_CAPACITY_MAX, COMMUNITY_CAPACITY_MAX); the refresh is every 10 s on the panel's clock, slower after a 429", () => {
  assert.equal(SM.PROBATION_CAPACITY_MAX, CP.PROBATION_CAPACITY_MAX);
  assert.equal(SM.COMMUNITY_CAPACITY_MAX, CP.COMMUNITY_CAPACITY_MAX);
  assert.equal(SM.MINE_REFRESH_MS, 10_000);
  const s = AM.refreshAfter(AM.refreshSent(AM.refreshStart(0)), 100, 'ok', 0, SM.MINE_REFRESH_MS);
  assert.equal(s.dueAt, 10_100);
  assert.ok(AM.refreshAfter(s, 100, 'limited', 0, SM.MINE_REFRESH_MS).dueAt >= 30_100, 'a 429 backs off');
  assert.equal(AM.refreshDue(s, 20_000, true), false, 'a hidden page waits');
  assert.equal(AM.refreshAfter(AM.refreshStart(0), 0, 'ok').dueAt, AM.ADMIN_REFRESH_MS, "the panel's own pace unchanged");
});

// ---- the TV ----------------------------------------------------------------------------------------------------

test('a TV (decision 7): the servers listed, nothing added or changed; "Hazlo en tu teléfono o en tu PC" and a QR to /#servers instead; no code revoked, no switch', () => {
  assert.match(SERVERS, /const tv = \(\): boolean => sample\?\.kind === 'tv' \|\| acc\.account\?\.tv === true \|\| html\.classList\.contains\('tg-tv'\);/);
  const add = fnOf(SERVERS, 'paintAdd');
  assert.match(add, /if \(tv\(\)\) \{\s*const url = `\$\{typeof location !== 'undefined' \? location\.origin : ''\}\/#servers`;\s*return \[h\('div\.mn-gar-guide', readOnly\('srv-tv'\), qrSvg\(url, t\('servers\.title'\)\), h\('div\.mn-gar-guide-text', null, h\('p', null, t\('nodesShared\.tvNote'\)\)/);
  assert.ok(add.indexOf('if (tv())') < add.indexOf('reqs.length > 0'), 'before the form or the requirements');
  assert.match(fnOf(SERVERS, 'nodeCard'), /ownerActions\(n, \{ tv: tv\(\),/);
  assert.match(fnOf(SERVERS, 'paintCodes'), /ownRevocable\(tk, now\) && !tv\(\)\s*\? secondary\(t\('nodesAdmin\.act\.revoke'\)/);
  assert.match(fnOf(SERVERS, 'paintPublic'), /if \(tv\(\)\) return \[h\('p\.mn-note', readOnly\('srv-public-tv'\)/);
  assert.equal(es['nodesShared.tvNote'], 'Hazlo en tu teléfono o en tu PC.');
  // No link leaves a TV's game tab: the help says where the rules are and shows the guide's QR; the
  // closed view's guide is its QR too; the acceptance's links are drawn only past the TV's QR above.
  const help = fnOf(SERVERS, 'helpView');
  assert.match(help, /tv\(\)\s*\? h\('p\.mn-note', readOnly\('srv-help-rules'\), t\('servers\.helpRulesTv'\)\)\s*: h\('div\.mn-na-tools', null, outLink\(hostRulesHref/);
  assert.match(help, /tv\(\) \? guide\(\) : null,/);
  assert.match(fnOf(SERVERS, 'guide'), /if \(!tv\(\)\) return h\('div\.mn-na-tools', null, outLink\(url/);
  assert.match(fnOf(SERVERS, 'closedView'), /guide\(\),\s*\];/);
  assert.equal([...SERVERS.matchAll(/outLink\(/g)].length, 6, 'the guide (off a TV), the help\'s two (off a TV), the acceptance line\'s three (never on a TV)');
});

// ---- PARTIDO ENCONTRADO, the FINAL, REPORTAR SERVIDOR --------------------------------------------------------

test("the mark (decision 6): only a community server's, by the Worker's mark alone (never GET /api/config); a project server is never marked (before, every node was); its name the Worker's first; one wording", () => {
  assert.deepEqual(FM.finalServerLine({ node: 'sao-paulo-1', server: { name: 'sao-paulo-1', community: false } }), { name: 'sao-paulo-1', community: false });
  assert.deepEqual(FM.finalServerLine({ node: 'sao-paulo-1', server: null }), { name: 'sao-paulo-1', community: false }, 'a node with no mark: unmarked, never the community slot');
  assert.deepEqual(FM.finalServerLine({ node: 'sao-paulo-1' }), { name: 'sao-paulo-1', community: false });
  assert.deepEqual(FM.finalServerLine({ node: 'what-the-node-says', server: { name: 'casa-de-ana', community: true } }), { name: 'casa-de-ana', community: true }, "the Worker's name, not the Welcome's");
  assert.equal(FM.finalServerLine({ node: null, server: null }), null, 'a MatchDO: no line');
  assert.equal(SM.communityMarked({ name: 'x', community: false }), false);
  assert.equal(SM.communityMarked(null), false);
  assert.equal(SM.communityMarked(undefined), false);
  assert.equal(SM.communityMarked({ name: 'x', community: true }), true, 'whatever GET /api/config says: the flag closed again or its read failed while it hosts (Terms 7.6, Privacy 4.4)');
  // The FINAL draws the slot by finalServerLine, PARTIDO ENCONTRADO by communityMarked: neither reads the config.
  assert.match(FINAL, /const line = finalServerLine\(v\);/);
  assert.match(FINAL, /line\.community \? slot\(t\('final\.community'\)\) : null,/);
  assert.doesNotMatch(FINAL, /slot\(t\('final\.community'\)\), h\('span\.mn-final-rules'/, 'no longer on every node');
  assert.doesNotMatch(FINAL, /hostingOpen|menu\.cfg/, "the FINAL never reads the opening's config");
  assert.match(GAME, /const community = communityMarked\(extra\?\.server\) \? t\('found\.community'\) : null;/);
  assert.doesNotMatch(GAME, /communityMarked\([^)]*hostingOpen/);
  assert.match(GAME, /server: onServer \? online\.client\.serverMarkOf\(online\.client\.matchId\) : null,/, "the Worker's mark, by its match");
  // One name in both places, (b)'s and the prompt's: "servidor de la comunidad".
  assert.equal(es['found.community'], 'Servidor de la comunidad');
  assert.equal(es['final.community'], 'SERVIDOR DE LA COMUNIDAD');
  for (const m of [es, en]) assert.equal(m['final.community'], m['found.community'].toUpperCase());
});

test('REPORTAR SERVIDOR (A16): only at the end of a match on a community server (its mark, never the config), for an account, with the match known, once per match; the four reasons; the numbers whole; in the type scale', () => {
  const base = { server: { name: 'casa', community: true }, signedIn: true, matchId: 'e'.repeat(64), reported: false };
  assert.equal(SM.reportOffered(base), true, 'whatever GET /api/config says (Terms 12.6.2)');
  assert.equal(SM.reportOffered({ ...base, server: { name: 'sao-paulo-1', community: false } }), false, 'a project server: never');
  assert.equal(SM.reportOffered({ ...base, server: null }), false, 'a MatchDO or no mark: never');
  assert.equal(SM.reportOffered({ ...base, signedIn: false }), false, 'a guest: the route takes no guest');
  assert.equal(SM.reportOffered({ ...base, matchId: null }), false);
  assert.equal(SM.reportOffered({ ...base, matchId: 'm1' }), false, 'only a 64-hex match id');
  assert.equal(SM.reportOffered({ ...base, reported: true }), false, 'once per match');
  assert.deepEqual([...N.REPORT_REASONS], ['unresponsive', 'lag', 'disconnected', 'other']);
  assert.deepEqual([...N.REPORT_REASONS], src('server/src/nodeStore.ts').match(/export const REPORT_REASONS = \[([^\]]+)\]/)[1].split(',').map((x) => x.trim().replace(/'/g, '')), "the server's list");
  for (const r of N.REPORT_REASONS) for (const m of [es, en]) assert.equal(typeof m[`final.reason.${r}`], 'string', r);
  assert.deepEqual(SM.reportNumbers(84.6, 12), { ping: 85, corrections: 12 });
  assert.deepEqual(SM.reportNumbers(0, -1), {}, 'no numbers: none sent');
  assert.deepEqual(SM.reportNumbers(90_000, 2_000_000), { ping: 60_000, corrections: 1_000_000 }, "the server's ranges");
  assert.deepEqual(SM.reportNumbers(Number.NaN, Infinity), {});
  // The FINAL's button: by reportOffered, and its sheet sends one report and keeps the match reported.
  assert.match(FINAL, /const canReport = reportOffered\(\{ server: v\.server, signedIn: sampleKind !== null \|\| menu\.host\.accounts\.signedIn, matchId: v\.matchId \?\? null, reported:/);
  assert.match(FINAL, /canReport \? h\('button\.mn-btn\.mn-final-report', \{ type: 'button', 'data-nav': true, 'data-key': 'final-report', onclick: \(\) => openReport\(v, line\.name\) \}, t\('final\.report'\)\) : null,/);
  const report = fnOf(FINAL, 'openReport');
  assert.match(report, /menu\.host\.accounts\.nodesReport\(\{ matchId, reason, \.\.\.reportNumbers\(v\.net\?\.ping \?\? 0, v\.net\?\.corrections \?\? -1\) \}\)/);
  // Once per match: a report sent takes the button away (and so does the server's already_reported).
  assert.match(report, /\.then\(\s*\(\) => \{\s*reported\.add\(matchId\);\s*close\(\);/);
  assert.match(report, /if \(code === 'already_reported'\) reported\.add\(matchId\);/);
  // The button in the type scale and a finger's 44 px (a .mn-btn-small's 12 px failed a phone's and a
  // TV's floor), its line wrapping in every shell (the upright tabs' too).
  assert.doesNotMatch(FINAL, /mn-btn-small/);
  const css = src('src/ui/styles/screens/final.css');
  assert.match(css, /\.mn-final-report \{\s*flex: none;\s*min-height: 2\.75rem;\s*padding: 0 1rem;\s*font-size: var\(--t-small\);\s*\}/);
  assert.match(css, /\.mn-final-node \{\s*display: flex;\s*flex-wrap: wrap;/);
  assert.match(css, /html\[data-shell='rail'\] \.mn-final-node,\s*html\[data-shell='tabs'\] \.mn-final-node \{\s*padding: 0\.5rem 1rem;\s*\}/);
  assert.match(GAME, /matchId: onServer \? online\.client\.matchId : null,/);
});

// ---- "Solo servidores del proyecto" ---------------------------------------------------------------------------

test('"Solo servidores del proyecto" (A15): in Ajustes › JUEGO once hosting is open and while it is on, kept with the menus\' prefs, sent with the search (both kinds) whenever it is on, never keyed on the config, and carried by a running one', () => {
  assert.equal(SM.projectOnlyShown(true, false), true, 'open: the row');
  assert.equal(SM.projectOnlyShown(true, true), true);
  assert.equal(SM.projectOnlyShown(false, false), false, 'dark: no row');
  assert.equal(SM.projectOnlyShown(false, true), true, 'on, and GET /api/config says closed (the flag closed again, a failed read): the row stays, so it can be turned off');
  // The Game: the option by projectOnlyShown; the search's body from the choice alone. A choice made
  // is still sent when GET /api/config says closed: since P2-2 the Worker and the hub keep it from the
  // terms on, whatever the flag says, and dropping it here would send the group to a community server.
  assert.match(GAME, /\.\.\.\(projectOnlyShown\(hostingOpen\(this\.menu\.cfg\), this\.menu\.prefs\.projectOnly\)\s*\? \{\s*projectOnly: \{/);
  assert.match(GAME, /client\.queueProjectOnly = this\.menu\.prefs\.projectOnly;/);
  assert.doesNotMatch(GAME, /queueProjectOnly = [^;\n]*hostingOpen/, 'never keyed on the config');
  // The switch stores the choice with the menus' prefs, and a running search carries it at once.
  assert.match(GAME, /set: \(on: boolean\) => \{\s*this\.menu\.prefs\.projectOnly = on;\s*this\.menu\.savePrefs\(\);\s*if \(this\.searchReq !== null && this\.online !== null\) this\.online\.client\.queueProjectOnly = on;/);
  assert.match(GAME, /projectOnly: \{\s*get: \(\) => this\.menu\.prefs\.projectOnly,/);
  // Ajustes: the switch reads and writes the options; built hidden, shown only while the options carry it.
  assert.match(SETTINGS, /toggleSwitch\('set-project-only', onlyText, \(\) => this\.opts\?\.projectOnly\?\.get\(\) \?\? false, \(v\) => this\.opts\?\.projectOnly\?\.set\(v\)\)/);
  assert.match(SETTINGS, /this\.refreshers\.push\(only\.refresh\);/);
  assert.match(SETTINGS, /this\.projectOnlyRow = h\('div\.mn-set-projectonly', \{ hidden: true \}, this\.group\(t\('settings\.groupServers'\)\), setRow\(onlyText, only\.el, t\('settings\.projectOnlyHelp'\)\)\);/);
  assert.match(SETTINGS, /if \(this\.projectOnlyRow !== null\) this\.projectOnlyRow\.hidden = this\.opts\?\.projectOnly === undefined;/);
  assert.match(SETTINGS, /const page = h\('div\.mn-set-game', null, \.\.\.CONTROL_ROWS\.game\.map\(\(r\) => this\.controlRow\(r\.key, r\.label\)\), this\.projectOnlyRow,/, 'in JUEGO');
});

// ---- the panel: the opening's flag and OPERADORES --------------------------------------------------------------

test("the panel's opening control (A1): closed '0', every account '1', a canary of ids (16 hex, deduplicated, 50 at most), behind a confirmation with its reason; never a KV write of its own", () => {
  assert.equal(AM.flagValueOf('closed', 'anything'), '0');
  assert.equal(AM.flagValueOf('all', ''), '1');
  assert.equal(AM.flagValueOf('canary', ' 0A1B2C3D4E5F6071, 0a1b2c3d4e5f6071;1b2c3d4e5f607182 '), '0a1b2c3d4e5f6071,1b2c3d4e5f607182');
  assert.equal(AM.flagValueOf('canary', ''), null);
  assert.equal(AM.flagValueOf('canary', '0a1b2c3d4e5f607'), null);
  assert.equal(AM.flagValueOf('canary', Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(16, '0')).join(',')), null, 'more than the server takes');
  assert.equal(AM.CANARY_MAX, 50);
  assert.deepEqual(AM.flagChoiceOf(null), { choice: 'closed', ids: [] });
  assert.deepEqual(AM.flagChoiceOf('0'), { choice: 'closed', ids: [] });
  assert.deepEqual(AM.flagChoiceOf('1'), { choice: 'all', ids: [] });
  assert.deepEqual(AM.flagChoiceOf('0a1b2c3d4e5f6071,junk'), { choice: 'canary', ids: ['0a1b2c3d4e5f6071'] });
  assert.deepEqual(AM.confirmNeeds('flag'), { reason: true, typeName: false });
  assert.deepEqual(AM.confirmNeeds('block'), { reason: true, typeName: false });
  assert.deepEqual(AM.confirmNeeds('suspendAll'), { reason: true, typeName: false });
  assert.deepEqual(AM.confirmNeeds('unblock'), { reason: false, typeName: false });
  const opening = fnOf(ADMIN, 'openingView');
  assert.match(opening, /confirmSheet\('flag', label, t\('nodesAdmin\.open\.set'\), \(reason\) =>\s*act\(\s*\(\) => acc\.nodesAction\('flags', \{ name: hv\.flag, value, reason \}\),/);
  assert.match(opening, /hv\.terms\.inForce \? t\('nodesAdmin\.open\.termsOn'/, 'says when the server refuses every value (409 hosting_terms)');
  assert.match(ADMIN, /\.\.\.\(o\.hosting !== undefined \? \[openingView\(o\.hosting\)\] : \[\]\),/, 'only from a server with the opening');
  assert.match(ADMIN, /: a === 'flag' \? 'nodesAdmin\.confirm\.flagNote'/);
});

test('OPERADORES (A4): its tab, read when it opens and with ACTUALIZAR (never by the refresh), each operator with its block, unblock and suspend-all behind a confirmation; the answer read leniently', () => {
  assert.ok(AM.ADMIN_TABS.includes('operators'));
  assert.match(ADMIN, /const HISTORY_TABS: ReadonlySet<AdminTab> = new Set\(\['matches', 'history', 'alerts', 'operators'\]\);/);
  assert.match(ADMIN, /if \(id === 'operators' && operators === null\) void loadOperators\(\);/);
  const card = fnOf(ADMIN, 'operatorCard');
  assert.match(card, /acc\.nodesAction\('operator', \{ operatorId: op\.operatorId, action: 'block', reason \}\)/);
  assert.match(card, /acc\.nodesAction\('operator', \{ operatorId: op\.operatorId, action: 'unblock',/);
  assert.match(card, /acc\.nodesAction\('operator', \{ operatorId: op\.operatorId, action: 'suspend_all', reason \}\)/);
  const r = N.operatorsOf({ at: 5, operators: [{ operatorId: '0a1b2c3d4e5f6071', status: 'blocked', points: { today: 7, cap: 300 }, reports: { count: 2, byReason: { lag: 2, weird: 9 }, recent: [{ reason: 'new_one', matchId: 'x' }] } }, { nope: 1 }, null] });
  assert.equal(r.at, 5);
  assert.equal(r.operators.length, 1, 'an operator without its id is left out');
  const op = r.operators[0];
  assert.deepEqual([op.status, op.points.today, op.points.cap, op.points.d30, op.nodes, op.tokens], ['blocked', 7, 300, 0, [], { today: 0, unused: 0 }]);
  assert.deepEqual(op.reports.byReason, { unresponsive: 0, lag: 2, disconnected: 0, other: 0 });
  assert.equal(op.reports.recent[0].reason, 'other', 'a reason this client does not know');
  assert.deepEqual(N.operatorsOf(null), { at: 0, operators: [] });
  assert.deepEqual(N.overviewOf({ hosting: { flag: 'node_operators', raw: null, stage: 'closed', terms: { inForce: false, version: '2026-11-05', needed: null }, changes: 'x', communityWebhook: false } }).hosting.changes, []);
  assert.equal('hosting' in N.overviewOf({}), false, 'a server of before');
  // Every new refusal has its words in both languages, the Spanish translated.
  for (const code of ['hosting_closed', 'operator_blocked', 'email_required', 'deletion_pending', 'account_too_new', 'terms_required', 'adult_required', 'too_many_tokens', 'name_taken', 'rtc_not_available', 'region_mismatch', 'trusted', 'banned', 'suspended', 'project_server', 'host_deleted', 'already_reported', 'too_many_reports', 'hosting_terms']) {
    assert.ok(N.NODE_ERROR_CODES.includes(code), code);
    assert.notEqual(es[`nodesShared.err.${code}`], en[`nodesShared.err.${code}`], code);
  }
});

// ---- AccountClient's new calls -----------------------------------------------------------------------------------

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function client(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    const h = handlers[path.split('?')[0]];
    return h ? h(init, path) : res(404, { error: 'not_found' });
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const a = new AC.AccountClient({ fetchFn, storage });
  a.account = { kind: 'account', playerId: '0a1b2c3d4e5f6071', name: 'Juan', session: 'jwt-1', expiresAt: Date.now() + 3_600_000 };
  return { a, calls };
}

test("AccountClient: the owner's actions, a code's revoke, the public switch, a report and the operators on ownCall; a code's refusal carries its days left and its version", async () => {
  const c = client({
    '/nodes/mine/drain': () => res(200, { nodeId: 'n', draining: true }),
    '/nodes/mine/rename': () => res(409, { error: 'name_taken', message: 'x' }),
    '/nodes/tokens/revoke': () => res(200, { id: 'abc', revoked: true }),
    '/nodes/mine/public': () => res(200, { showPublic: true }),
    '/nodes/report': () => res(200, { reported: true }),
    '/nodes/admin/operators': () => res(200, { at: 9, operators: [{ operatorId: '0a1b2c3d4e5f6071' }] }),
    '/nodes/tokens': () => res(403, { error: 'account_too_new', message: 'too new', daysLeft: 3 }),
  });
  assert.equal((await c.a.nodesMineAction('drain', { nodeId: 'n' })).draining, true);
  assert.deepEqual(c.calls.at(-1), { path: '/nodes/mine/drain', method: 'POST', body: { nodeId: 'n' }, auth: 'Bearer jwt-1' });
  await assert.rejects(c.a.nodesMineAction('rename', { nodeId: 'n', name: 'x2' }), (e) => e instanceof AC.AccountError && e.code === 'name_taken');
  await c.a.nodesRevokeOwn('abc');
  assert.deepEqual(c.calls.at(-1).body, { id: 'abc' });
  assert.equal(await c.a.nodesShowPublic(true), true);
  await c.a.nodesReport({ matchId: 'e'.repeat(64), reason: 'lag', ping: 80 });
  assert.deepEqual(c.calls.at(-1), { path: '/nodes/report', method: 'POST', body: { matchId: 'e'.repeat(64), reason: 'lag', ping: 80 }, auth: 'Bearer jwt-1' });
  assert.equal((await c.a.nodesOperators()).operators.length, 1);
  await assert.rejects(c.a.nodesToken({ region: 'SA', publicHost: 'a.example.com', acceptHost: true, adult: true }), (e) => e instanceof AC.AccountError && e.code === 'account_too_new' && e.detail.daysLeft === 3);
  assert.deepEqual(c.calls.at(-1).body, { region: 'SA', publicHost: 'a.example.com', acceptHost: true, adult: true });
  const d = client({ '/nodes/tokens': () => res(403, { error: 'terms_required', version: '2026-11-13' }) });
  await assert.rejects(d.a.nodesToken({ region: 'SA' }), (e) => e.code === 'terms_required' && e.detail.version === '2026-11-13');
  for (const x of c.calls) assert.ok(x.path.startsWith('/nodes/'), 'same origin, /nodes/* only: ' + x.path);
});

// ---- the screen's source rules ---------------------------------------------------------------------------------

test("the screen paints server text as text only, keeps nothing, names only example machines, and reuses the panel's and PERFIL's pieces (one rule of its own: its buttons in the type scale)", () => {
  assert.doesNotMatch(SERVERS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(SERVERS, /localStorage|sessionStorage|indexedDB/);
  for (const m of SERVERS.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|ar|io|dev|cloud|xyz|br|de|my)\b/g)) assert.match(m[0], /(?:^|\.)example\.com$/, m[0]);
  // Its links: the guide, the rules, Annex B and the privacy policy, all from checked paths, never a server's text.
  assert.equal([...SERVERS.matchAll(/h\(`a\.\$\{cls\}`/g)].length, 1, 'one link maker');
  assert.match(SERVERS, /const el = h\('div\.mn-na\.mn-srv', \{ 'data-tablero': true \}, screenHead\(t\('servers\.title'\)\), status, body\);/);
  assert.doesNotMatch(src('src/ui/styles/index.css'), /servers/, 'no stylesheet of its own');
  // Its buttons and links in the Heading role, as PERFIL's (a .mn-btn's 15 px is under a TV's floor:
  // the panel shows a TV only a note, this screen its buttons).
  assert.match(src('src/ui/styles/screens/nodes.css'), /\.mn-srv \.mn-btn \{\s*font-size: var\(--t-heading\);\s*\}/);
  // Registered, in the points pill's screens, and the community entries of PERFIL and GARAJE open it.
  assert.match(src('src/ui/index.ts'), /m\.register\('servers', serversScreen\);/);
  assert.match(MENU, /const show = this\.visibleNow && \(id === 'garage' \|\| id === 'profile' \|\| id === 'servers'\);/);
  // A guest's sign-in comes back here, as GARAJE's.
  assert.match(SERVERS, /if \(waitSignIn && acc\.signedIn\) \{\s*waitSignIn = false;\s*dropDetour\(\);\s*if \(menu\.top\(\)\?\.id === 'profile'\) menu\.backTo\('servers'\);/);
});

test('every new text exists in Spanish and English, Spanish in tú and its own words', () => {
  const keys = Object.keys(en).filter((k) => /^(?:servers\.|nodesAdmin\.(?:open|op)\.|final\.(?:report|reason)|found\.community|settings\.(?:projectOnly|groupServers)|profile\.(?:myServers|hostServerOpen)|garage\.\w+Open|points\.onlyOpen)/.test(k));
  assert.ok(keys.length > 150, String(keys.length));
  for (const k of keys) {
    assert.ok(k in es, 'es ' + k);
    assert.equal(typeof es[k], typeof en[k], k);
  }
  const same = keys.filter((k) => typeof en[k] === 'string' && es[k] === en[k] && !/^(?:servers\.compatible|servers\.fact\.lag)$/.test(k));
  assert.deepEqual(same, [], 'translated');
});

// ---- the pre-opening change: the (b) texts made true -----------------------------------------------------

test("MIS SERVIDORES says the system's measures (Terms 9.2 of (b): seen here): a failed verification, a strike pause and its way back to probation, the hour out after refusals; the team's own reason as written; the faltas and when the oldest goes", () => {
  const now = 1_000_000;
  const m = (o) => SM.measuresOf(node(o), now);
  assert.deepEqual(m({}), []);
  assert.deepEqual(m({ status: 'suspended', statusReason: 'verification_failed' }), [{ kind: 'verification' }]);
  assert.deepEqual(m({ status: 'suspended', statusReason: 'strikes:node_offline', suspendedUntil: now + 5, afterPause: 'active', pauses: { count: 1, windowDays: 30 } }), [{ kind: 'strikes', until: now + 5, probation: false, days: 30 }]);
  assert.deepEqual(m({ status: 'suspended', statusReason: 'strikes:lost', suspendedUntil: now + 5, afterPause: 'probation', pauses: { count: 1, windowDays: 30 } }), [{ kind: 'strikes', until: now + 5, probation: false, days: 30 }], 'a first pause of a server on probation: back where it was');
  assert.deepEqual(m({ status: 'suspended', statusReason: 'strikes:lost', suspendedUntil: now + 5, afterPause: 'probation', pauses: { count: 2, windowDays: 30 } }), [{ kind: 'strikes', until: now + 5, probation: true, days: 30 }], 'the second: its verified matches start over');
  assert.deepEqual(m({ status: 'suspended', statusReason: 'strikes:lost', suspendedUntil: now + 5, afterPause: 'probation', pauses: { count: 3, windowDays: 30 } }), [{ kind: 'strikes', until: now + 5, probation: true, days: 30 }], 'a third too');
  assert.deepEqual(m({ status: 'suspended', statusReason: 'strikes:lost', suspendedUntil: now - 1 }), [], 'lifted (the next sweep says so)');
  assert.deepEqual(m({ refused: { count: 9, rate: 0.5, recent: 6, of: 10, outUntil: now + 60 } }), [{ kind: 'refusals', until: now + 60 }]);
  assert.deepEqual(m({ refused: { count: 9, rate: 0.5, recent: 6, of: 10, outUntil: now } }), []);
  assert.deepEqual(m({ status: 'suspended', statusReason: 'review by the team' }), [], "the team's suspension is not the system's");
  for (const r of ['verification_failed', 'strikes:node_offline']) assert.equal(SM.automaticReason(r), true, r);
  for (const r of [null, 'review by the team', 'verification_failed later', 'strike:x']) assert.equal(SM.automaticReason(r), false, String(r));
  // The faltas: the server's live count and when the oldest leaves the window; an older server's counter, none.
  assert.deepEqual(SM.nodeFacts(node({ strikes: { count: 2, max: 3, windowDays: 7, nextExpiry: now + 9 } }), null).strikes, { count: 2, max: 3, windowDays: 7, nextExpiry: now + 9 });
  assert.deepEqual(SM.nodeFacts(node(), null).strikes, { count: 1, max: 3, windowDays: 7, nextExpiry: null });
  // The card: each measure in words, the raw code never; the team's reason as it wrote it.
  const card = fnOf(SERVERS, 'nodeCard');
  assert.match(card, /\.\.\.measuresOf\(n, now\)\.map\(\(x\) => h\('p\.mn-prof-node-reason', null, measureText\(x\)\)\),/);
  assert.match(card, /n\.statusReason !== null && !automaticReason\(n\.statusReason\) && \(n\.status === 'suspended' \|\| n\.status === 'banned'\) \? h\('p\.mn-prof-node-reason', null, n\.statusReason\)/);
  assert.match(card, /t\('servers\.strikesNext', \{ time: when\(f\.strikes\.nextExpiry\) \}\)/);
  assert.match(SERVERS, /\['states', 'what', 'few', 'points', 'measures', 'data'\]/);
  for (const k of ['servers.measure.verification', 'servers.measure.strikes', 'servers.measure.strikesAgain', 'servers.measure.refusals', 'servers.strikesNext', 'servers.help.measures']) for (const l of [es, en]) assert.equal(typeof l[k], 'string', k);
  assert.match(es['servers.measure.strikes'], /\{time\}/);
  assert.match(es['servers.measure.strikesAgain'], /^No es su primera pausa en \{days\} días: /, 'no ordinal: a third pause in the window demotes it too (Registry.onLost)');
  assert.match(en['servers.measure.strikesAgain'], /^It is not its first pause in \{days\} days: /);
  // Terms 9.1 and 12.6.1: only a refusal "sin motivo" counts (connected, with room, not draining, under its traffic cap).
  for (const k of ['servers.measure.refusals', 'servers.help.measures']) {
    assert.match(es[k], /rechaz[óa] sin motivo demasiadas de las últimas partidas que le asignamos/, k);
    assert.match(en[k], /refuse[sd] with no reason too many of the latest matches we assign/, k);
  }
  // The Terms name no thresholds (12.6.1): neither does the help.
  assert.doesNotMatch(es['servers.help.measures'], /\b3\b|24 horas|30 días/);
});

test("the game's strings say what the (b) texts say: the preference lives in this browser or TV; a review is asked by email; a report gets no promise of one; the 7 days of the machine's logs; the opening's words; no Discord", () => {
  // Terms 7.6: "La opción se guarda solo en ese navegador o esa TV, no en tu cuenta: actívala en cada uno donde juegues, y otra vez si borras los datos del sitio."
  assert.match(es['settings.projectOnlyHelp'], /La opción se guarda solo en este navegador o esta TV, no en tu cuenta: actívala en cada uno donde juegues, y otra vez si borras los datos del sitio\./);
  assert.match(en['settings.projectOnlyHelp'], /The option is kept only in this browser or on this TV, not in your account: turn it on in each one you play on, and again if you clear the site's data\./);
  assert.match(es['settings.projectOnlyHelp'], /^Las partidas que buscas desde este navegador o esta TV nunca van/);
  // Terms 12.1.2: no "la red sigue cerrada" any more; during a canary only the invited register.
  assert.doesNotMatch(es['servers.closed'], /sigue cerrada|Discord/);
  assert.doesNotMatch(en['servers.closed'], /stays closed|Discord/);
  assert.match(es['servers.closed'], /solo las personas que invitamos/);
  // Terms 9.3: by email only.
  for (const k of ['servers.frozenNote', 'servers.req.operator_blocked']) {
    assert.match(es[k], /por correo a privacy@turbo-gol\.com/, k);
    assert.match(en[k], /by email at privacy@turbo-gol\.com/, k);
    assert.doesNotMatch(es[k] + en[k], /Discord/, k);
  }
  // A report: received, no review promised (Terms 12.6.2: "Ningún reporte te sanciona por sí solo").
  assert.equal(es['final.reported'], 'Gracias: lo recibimos.');
  assert.equal(en['final.reported'], 'Thanks: we got it.');
  assert.match(es['final.reportNote'], /ningún reporte lo sanciona por sí solo/);
  assert.doesNotMatch(es['final.reportNote'], /un reporte solo/);
  // Terms 12.3.2 and Annex B, point 9: the machine's own logs, 7 days at most unless the law asks more; the
  // installer caps journald alone, so the other logs are the host's to check (rsyslog's on Ubuntu).
  assert.match(es['servers.help.data'], /La única excepción son los registros técnicos de tu máquina que tengan direcciones IP \(del sistema, del firewall o de Caddy\): haz que se borren a los 7 días como máximo, salvo que la ley te obligue a más\. El instalador oficial deja el diario del sistema \(journald\) en 7 días y saca esos datos de los registros de Caddy\. Revisa los otros registros de tu máquina, como \/var\/log\/syslog y \/var\/log\/ufw\.log en Ubuntu\.$/);
  assert.match(en['servers.help.data'], /have them deleted after 7 days at most, unless the law requires you to keep them longer\. The official installer keeps the system journal \(journald\) for 7 days .*\/var\/log\/ufw\.log on Ubuntu\.$/);
  assert.doesNotMatch(es['servers.help.data'] + en['servers.help.data'], /registro del sistema en 7|system log for 7/, 'journald only: the installer leaves rsyslog alone');
  // The summary above the acceptance says the same exception (Annex B, point 9).
  assert.match(es['servers.acceptSummary'], /no los guardas después de la partida, salvo los registros técnicos de tu máquina con direcciones IP, 7 días como máximo\)/);
  // Terms 12.5.2: COMPETITIVE never reaches a server that is not the project's (the project's are community servers too).
  assert.match(es['servers.help.what'], /no llega a los servidores que no son del proyecto/);
  // Annex B, point 6: never behind Cloudflare's proxy; the installer's refusals have their words and their fix.
  for (const c of ['behind_proxy', 'dns_unavailable']) {
    assert.ok(N.NODE_ERROR_CODES.includes(c), c);
    for (const l of [es, en]) assert.equal(typeof l[`nodesShared.err.${c}`], 'string', c);
  }
  assert.match(es['servers.hostHint'], /DNS only \(sin el proxy de Cloudflare\)/);
  assert.equal(typeof es['servers.fix.behind_proxy'], 'string');
  // Nothing of the game's hosting words sends a review or a report to Discord.
  const hosting = Object.keys(es).filter((k) => /^(?:servers\.|final\.report|settings\.projectOnly)/.test(k));
  for (const k of hosting) if (typeof es[k] === 'string') assert.doesNotMatch(es[k], /Discord/, k);
});
