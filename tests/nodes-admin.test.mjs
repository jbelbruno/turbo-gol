// CONTROL DE NODOS (prompt 1, part B: PERFIL › CUENTA DEL PROYECTO's panel of the community nodes)
// without a browser: src/net/nodes.ts (the answers read leniently, the refusals by code, the DNS
// name and the token form the wizard checks, the server's install line checked, masks, hints), the
// panel's pure model (screens/nodesAdminModel.ts: the refresh's clock, the KPIs, the rows, what a
// node may be asked, the confirmations, the wizard's follow-up), AccountClient's /nodes/* calls on
// a fake fetch, and the screen's source rules (server text never as markup, nothing stored, never
// on a TV, the refresh never asks for the password by itself, presets without DNS names).
//   node --test tests/nodes-admin.test.mjs
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

const N = await import('../src/net/nodes.ts');
const M = await import('../src/ui/screens/nodesAdminModel.ts');
const AC = await import('../src/net/AccountClient.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const SCREEN = readFileSync(new URL('../src/ui/screens/nodesAdmin.ts', import.meta.url), 'utf8');
const NODES = readFileSync(new URL('../src/net/nodes.ts', import.meta.url), 'utf8');
const NODES_CSS = readFileSync(new URL('../src/ui/styles/screens/nodes.css', import.meta.url), 'utf8');

// ---- src/net/nodes.ts --------------------------------------------------------------------------------

test('every refusal code has a text of its own in both languages (Spanish translated), an unknown one reads as the server\'s trouble', () => {
  for (const code of N.NODE_ERROR_CODES) {
    const key = N.nodeErrorKey(code);
    assert.equal(key, `nodesShared.err.${code}`);
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof es[key], 'string', key);
    assert.notEqual(es[key], en[key], `${key} is translated`);
  }
  assert.equal(N.nodeErrorKey('something_new'), 'nodesShared.err.internal');
  // The prompt's list, whole.
  for (const c of ['not_trusted', 'account_required', 'tv_session', 'reauth_required', 'password_required', 'unauthorized', 'rate_limited', 'nodes_off', 'nodes_unavailable', 'too_large', 'bad_request', 'not_found', 'internal', 'bad_region', 'too_many_nodes', 'verify_reserved', 'ip_not_supported', 'public_host_mismatch', 'bad_public_host', 'no_node', 'bad_node_id', 'bad_status', 'not_reachable', 'offline', 'not_wss', 'bad_match_id', 'no_replay', 'bad_account', 'unknown_item', 'no_user']) assert.ok(N.NODE_ERROR_CODES.includes(c), c);
});

test('what a refusal leaves the panel to do: the password for reauth_required (never a retry), nothing for a TV, a minute for nodes_off, by the code and not outcome.ts', () => {
  assert.equal(N.nodeFailure({ code: 'reauth_required', status: 403 }), 'reauth');
  assert.equal(N.nodeFailure({ code: 'password_required', status: 403 }), 'reauth');
  assert.equal(N.nodeFailure({ code: 'tv_session', status: 403 }), 'tv');
  assert.equal(N.nodeFailure({ code: 'nodes_off', status: 503 }), 'paused');
  assert.equal(N.nodeFailure({ code: 'rate_limited', status: 429 }), 'limited');
  assert.equal(N.nodeFailure({ code: 'http', status: 429 }), 'limited');
  assert.equal(N.nodeFailure({ code: 'not_found', status: 404 }), 'gone');
  assert.equal(N.nodeFailure({ code: 'not_trusted', status: 403 }), 'denied');
  assert.equal(N.nodeFailure({ code: 'too_many_nodes', status: 409 }), 'fail');
  assert.equal(N.nodeFailure({ code: 'network', status: 0 }), 'fail');
  assert.equal(N.nodeFailure(null), 'fail');
});

test('the wizard\'s host: a public DNS name alone; an IP address, a port, a scheme or a path refused before any request', () => {
  assert.equal(N.hostIssue('node-1.example.com'), null);
  assert.equal(N.hostIssue('  Node-1.Example.COM '), null);
  assert.equal(N.hostIssue(''), 'empty');
  assert.equal(N.hostIssue('https://node-1.example.com'), 'scheme');
  assert.equal(N.hostIssue('node-1.example.com/healthz'), 'scheme');
  assert.equal(N.hostIssue('node-1.example.com:8443'), 'port');
  assert.equal(N.hostIssue('203.0.113.7'), 'ip');
  assert.equal(N.hostIssue('203.0.113.7:443'), 'ip');
  assert.equal(N.hostIssue('[2001:db8::1]'), 'ip');
  assert.equal(N.hostIssue('2001:db8::1'), 'ip');
  assert.equal(N.hostIssue('localhost'), 'bad', 'one label is no public name');
  assert.equal(N.hostIssue('bad_name.example.com'), 'bad');
  assert.equal(N.hostIssue('example.123'), 'bad', 'the last label starts with a letter (install.sh is_dns_name)');
});

test('the token form: each field checked as the server does, no token without a free slot; the body pins the host and asks wss', () => {
  const ok = { region: 'EU', name: 'frankfurt-1', host: 'node-1.example.com', roles: 'host,verify', matches: 'auto', egress: '' };
  assert.deepEqual(N.tokenFormIssues(ok, { used: 1, max: 4 }), []);
  assert.deepEqual(N.tokenFormIssues(ok, null), [], 'the slots unknown yet: the server refuses at the cap (409 too_many_nodes)');
  assert.deepEqual(N.tokenFormIssues(ok, { used: 4, max: 4 }).map((i) => i.field), ['slots']);
  const bad = N.tokenFormIssues({ region: null, name: '-x', host: '203.0.113.7', roles: 'host', matches: '201', egress: '0' }, { used: 0, max: 2 });
  assert.deepEqual(bad.map((i) => i.field), ['region', 'name', 'host', 'matches', 'egress']);
  assert.equal(bad.find((i) => i.field === 'host').host, 'ip');
  assert.deepEqual(N.tokenFormIssues({ ...ok, matches: String(N.MAX_CAPACITY) }, null), []);
  assert.deepEqual(N.tokenFormIssues({ ...ok, matches: '0' }, null).map((i) => i.field), ['matches']);
  assert.deepEqual(N.tokenAskOf({ ...ok, host: ' Node-1.Example.com ', matches: '12', egress: '2000' }), { region: 'EU', name: 'frankfurt-1', publicHost: 'node-1.example.com', roles: ['host', 'verify'], matches: 12, egressCapGB: 2000 });
  assert.deepEqual(N.tokenAskOf({ ...ok, roles: 'host' }), { region: 'EU', name: 'frankfurt-1', publicHost: 'node-1.example.com', roles: ['host'], matches: 'auto' });
});

/** The install line as NodeRegistryDO.ts installLine composes it. */
const line = (ask, token = 'tgn1_AbC-dEf_0123456789abcdefghij') =>
  `curl -fsSL https://turbo.example.com/nodes/releases/install.sh | sudo bash -s -- --control https://turbo.example.com --token ${token} --name ${ask.name} --roles ${ask.roles.join(',')} --transport wss --public-host ${ask.publicHost} --matches ${ask.matches}${ask.egressCapGB !== undefined ? ` --egress-cap-gb ${ask.egressCapGB}` : ''}`;

test('the server\'s install line is shown only when it carries what was asked and nothing a shell reads as more than words', () => {
  const ask = N.tokenAskOf({ region: 'EU', name: 'frankfurt-1', host: 'node-1.example.com', roles: 'host,verify', matches: '12', egress: '2000' });
  const good = line(ask);
  assert.equal(N.installLineMatches(good, ask), true);
  assert.match(good, /--public-host node-1\.example\.com --matches 12 --egress-cap-gb 2000$/);
  assert.match(good, /--roles host,verify --transport wss/);
  assert.equal(N.installLineMatches(good.replace('--public-host node-1.example.com', '--public-host other.example.com'), ask), false, 'another host');
  assert.equal(N.installLineMatches(good.replace('--roles host,verify', '--roles host'), ask), false, 'other roles');
  assert.equal(N.installLineMatches(good.replace('--matches 12', '--matches 13'), ask), false);
  assert.equal(N.installLineMatches(good + '; rm -rf /', ask), false, 'a command after it');
  assert.equal(N.installLineMatches(good.replace('frankfurt-1', '$(id)'), ask), false, 'an expansion');
  assert.equal(N.installLineMatches(good.replace('--token tgn1_AbC-dEf_0123456789abcdefghij', ''), ask), false, 'no token');
  assert.equal(N.installLineMatches(`curl -fsSL https://x.example.com/i.sh | sudo bash -s -- --control https://x.example.com --token t --name frankfurt-1 --roles host,verify --public-host node-1.example.com --matches 12 --egress-cap-gb 2000`, ask), false, 'no --transport wss');
});

test('a node\'s state as a tone: active ok, trial warn, pending muted, suspended and banned bad, retired muted', () => {
  assert.equal(N.statusTone('active'), 'ok');
  assert.equal(N.statusTone('probation'), 'warn');
  assert.equal(N.statusTone('pending'), 'muted');
  assert.equal(N.statusTone('suspended'), 'bad');
  assert.equal(N.statusTone('banned'), 'bad');
  assert.equal(N.statusTone('active', true), 'muted');
});

test('addresses masked until asked: the first character and the last label, no scheme, port or path', () => {
  assert.equal(N.maskAddress('wss://sao-paulo-1.example.com'), 's•••.com');
  assert.equal(N.maskAddress('node-1.example.com'), 'n•••.com');
  assert.equal(N.maskAddress('wss://node.example.com:8443/x'), 'n•••.com');
  assert.equal(N.maskAddress(null), '');
  assert.equal(N.maskAddress(''), '');
});

test('a failed probe\'s words to what it most likely needs: DNS, the ports, an earlier Caddyfile, the certificate', () => {
  assert.equal(N.probeHint('timeout'), 'ports');
  assert.equal(N.probeHint('TypeError: fetch failed'), 'ports');
  assert.equal(N.probeHint('Error: refused target (not a public address)'), 'dns');
  assert.equal(N.probeHint('getaddrinfo ENOTFOUND node.example.com'), 'dns');
  assert.equal(N.probeHint('bad json'), 'caddy');
  assert.equal(N.probeHint('bad answer'), 'caddy');
  assert.equal(N.probeHint('HTTP 526: the TLS handshake or the certificate was refused'), 'cert');
  assert.equal(N.probeHint('something else'), null);
  assert.equal(N.probeHint(null), null);
});

test('the review of a failed verification: the match from the freeze\'s reason, the viewer\'s link only for an id of 64 hex', () => {
  const id = 'ab'.repeat(32);
  assert.equal(N.verificationMatch(`verification_failed:${id}`), id);
  assert.equal(N.verificationMatch('verification_failed'), null);
  assert.equal(N.verificationMatch('verification_failed:"><script>'), null);
  assert.equal(N.replayHref(id), `./replay.html?id=${id}`);
  assert.equal(N.replayHref('javascript:alert(1)'), null);
  assert.equal(N.replayHref(null), null);
  assert.equal(N.accountIdOf(' 0A1B2C3D4E5F6071 '), '0a1b2c3d4e5f6071');
  assert.equal(N.accountIdOf('0a1b2c3d4e5f607'), null);
});

test('the project\'s presets carry a name and a region only: no DNS name of the project\'s machines in the bundle (decision 9)', () => {
  assert.deepEqual(N.PROJECT_PRESETS, [
    { name: 'frankfurt-1', region: 'EU' },
    { name: 'kuala-lumpur-1', region: 'AS' },
  ]);
  for (const p of N.PROJECT_PRESETS) assert.deepEqual(Object.keys(p).sort(), ['name', 'region']);
  assert.equal(N.PROJECT_DEFAULT_ROLES, 'host,verify');
  // Only example names in the panel's code and its sample (RFC 2606 example.com).
  for (const [name, src] of [['nodesAdmin.ts', SCREEN], ['nodes.ts', NODES]]) {
    for (const m of src.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|ar|io|dev|cloud|xyz|br|de|my)\b/g)) assert.match(m[0], /(?:^|\.)example\.com$/, `${name}: ${m[0]}`);
  }
});

test('mineAnswerOf and overviewOf read a server of before leniently: every list there', () => {
  assert.deepEqual(N.mineAnswerOf({ nodes: [{ nodeId: 'x' }] }), { operator: null, nodes: [{ nodeId: 'x' }], rewards: null });
  assert.deepEqual(N.mineAnswerOf({ operator: { id: 'a', trusted: true }, nodes: [], rewards: { points30d: 1 } }).operator, { id: 'a', trusted: true });
  const o = N.overviewOf({ at: 5 });
  for (const k of ['nodes', 'tokens', 'regions', 'verifiers', 'verifyQueue', 'points', 'flags', 'warnings']) assert.deepEqual(o[k], [], k);
  assert.equal(o.at, 5);
  assert.deepEqual(o.operator, { id: '', name: '', slotsUsed: 0, slotsMax: 0 });
});

test("mineAnswerOf keeps A11's fields when they came (null for requirements, terms and channel too), drops junk, and adds none for a server of before", () => {
  const full = {
    operator: { id: 'a', trusted: false },
    nodes: [],
    rewards: { points30d: 1, pointsToday: 0, capToday: 300 },
    hosting: { open: false, reason: 'hosting_closed' },
    requirements: { missing: ['email_required'], daysLeft: 3 },
    terms: { version: '2026-11-16', accepted: false },
    limits: { nodes: 1, maxNodes: 3, tokensToday: 0, tokensLeftToday: 3, outstanding: 1, maxOutstanding: 2 },
    tokens: [{ id: 'abcdef123456', region: 'SA', name: 'juan-2', publicHost: 'j2.example.com', createdAt: 1, expiresAt: 2, state: 'unused', nodeId: null }],
    showPublic: true,
    channel: { stable: '0.2.0', minimum: '0.2.0' },
  };
  assert.deepEqual(N.mineAnswerOf(full), full, 'every field as it came');
  const closed = N.mineAnswerOf({ ...full, requirements: null, terms: null, channel: null, showPublic: false });
  assert.deepEqual([closed.requirements, closed.terms, closed.channel, closed.showPublic], [null, null, null, false], 'null and false are answers too');
  const junk = N.mineAnswerOf({ nodes: [], hosting: 'open', requirements: 'none', terms: 1, limits: [], tokens: 'x', showPublic: 'yes', channel: 'stable' });
  for (const k of ['hosting', 'requirements', 'terms', 'limits', 'tokens', 'showPublic', 'channel']) assert.equal(k in junk, false, k);
  const before = N.mineAnswerOf({ operator: { id: 'a', trusted: true }, nodes: [], rewards: { points30d: 1 } });
  assert.deepEqual(Object.keys(before).sort(), ['nodes', 'operator', 'rewards'], 'an older server: the answer as before');
});

// ---- the panel's model ---------------------------------------------------------------------------

test('the refresh: every 15 s; held by reauth_required until the password (never retried), a minute apart while paused, slower after each 429; a hidden page waits', () => {
  let s = M.refreshStart(1000);
  assert.equal(M.refreshDue(s, 1000, false), true);
  assert.equal(M.refreshDue(s, 1000, true), false, 'a hidden page asks nothing');
  s = M.refreshSent(s);
  assert.equal(M.refreshDue(s, 99_000, false), false, 'one in flight at a time');
  s = M.refreshAfter(s, 2000, 'ok');
  assert.equal(s.dueAt, 2000 + M.ADMIN_REFRESH_MS);
  assert.equal(M.ADMIN_REFRESH_MS, 15_000);
  assert.equal(M.refreshDue(s, 2000 + 14_999, false), false);
  assert.equal(M.refreshDue(s, 2000 + 15_000, false), true);
  // reauth_required: held, whatever the time.
  let r = M.refreshAfter(M.refreshSent(s), 3000, 'reauth');
  assert.equal(r.held, 'reauth');
  assert.equal(M.refreshDue(r, 10 ** 9, false), false);
  r = M.refreshResume(r, 5000);
  assert.equal(r.held, null);
  assert.equal(M.refreshDue(r, 5000, false), true, 'the password confirmed: at once');
  // nodes_off: once a minute.
  const p = M.refreshAfter(M.refreshSent(s), 3000, 'paused');
  assert.equal(p.dueAt, 3000 + 60_000);
  // 429: 30 s, 60 s, 120 s, 120 s; a retry-after above it wins; an answer resets it.
  let l = s;
  const waits = [];
  for (let i = 0; i < 4; i++) {
    l = M.refreshAfter(M.refreshSent(l), 0, 'limited');
    waits.push(l.dueAt);
  }
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 120_000]);
  assert.equal(M.refreshAfter(M.refreshSent(s), 0, 'limited', 90_000).dueAt, 90_000);
  assert.equal(M.refreshAfter(M.refreshSent(l), 0, 'ok').limited, 0);
  // A TV, another account, a Worker without the routes: held.
  for (const f of ['tv', 'denied', 'gone']) assert.equal(M.refreshAfter(M.refreshSent(s), 0, f).held, f);
  assert.equal(M.refreshAfter(M.refreshSent(s), 0, 'fail').dueAt, M.FAIL_RETRY_MS);
});

/** A node of the overview, as nodeOverview.ts sends it. */
const node = (o = {}) => ({
  nodeId: 'a'.repeat(16),
  name: 'sao-paulo-1',
  region: 'SA',
  status: 'active',
  statusReason: null,
  suspendedUntil: null,
  online: true,
  roles: ['host', 'verify'],
  transports: ['wss'],
  trusted: true,
  publicUrl: 'wss://sao-paulo-1.example.com',
  reachable: true,
  active: 2,
  capacity: { matches: 8 },
  tickLagP99Ms: 3,
  egressGB: 10,
  counters: { assigned: 0, verified: 0, rankedVerified: 0, failedVerification: 0, lost: 0, strikes: 0, probationVerified: 0 },
  version: '0.3.0',
  compatible: true,
  operator: { id: 'f'.repeat(16), name: 'Turbogol' },
  createdAt: 0,
  lastSeen: 1,
  draining: false,
  egressCapGB: null,
  cpuLoad: 0,
  bootId: null,
  matches: 2,
  build: { version: '0.3.0', protocol: 3, wasmSha256: 'a'.repeat(64) },
  specs: null,
  capacityMax: 8,
  reachableAt: 1,
  lastProbe: null,
  probeFailures: 0,
  strikeTimes: [],
  pauseTimes: [],
  publicHost: null,
  retiredAt: null,
  retiredReason: null,
  trustRemovedAt: null,
  linkCuts: { count24h: 0, lastAt: null },
  ...o,
});

const overview = (o = {}) => N.overviewOf({ at: 0, operator: { id: 'f'.repeat(16), name: 'Turbogol', slotsUsed: 1, slotsMax: 4 }, outbox: { rows: 0, byPath: [] }, ...o });

test('RESUMEN\'s figures: nodes online by region (retired ones left out), matches now, the queue, the outbox, the slots', () => {
  const o = overview({
    nodes: [node(), node({ nodeId: 'b'.repeat(16), region: 'EU', online: false }), node({ nodeId: 'c'.repeat(16), retiredAt: 5, online: false })],
    regions: [{ region: 'SA', hostsOnline: 1, slots: 8, active: 2, matches: 2, unplaced: 0, regionFactor: 1, rankedReady: true }, { region: 'EU', hostsOnline: 0, slots: 0, active: 0, matches: 0, unplaced: 3, regionFactor: 1.5, rankedReady: false }],
    verifyQueue: [{ version: '0.3.0', protocol: 3, wasmSha256: 'x', depth: 2, oldestAt: 0 }],
    verifying: 1,
    outbox: { rows: 3, byPath: [{ path: '/release', rows: 2, oldestAt: 50 }, { path: '/host-credit', rows: 1, oldestAt: 40 }] },
  });
  const k = M.kpisOf(o);
  assert.deepEqual(k.online, [{ region: 'SA', online: 1, total: 1 }, { region: 'EU', online: 0, total: 1 }]);
  assert.equal(k.running, 2);
  assert.equal(k.queue, 2);
  assert.equal(k.verifying, 1);
  assert.equal(k.outbox, 3);
  assert.equal(k.outboxOldestAt, 40);
  assert.deepEqual(k.slots, { used: 1, max: 4 });
  assert.deepEqual(M.flagCommands('nodes_on'), { set: 'npx wrangler kv key put nodes_on 1 --binding FLAGS --remote', clear: 'npx wrangler kv key delete nodes_on --binding FLAGS --remote' });
});

test('NODOS: on the books first, by region in the menu\'s order and name, the retired ones last; each row with its tone, marks and project or community', () => {
  const o = overview({ nodes: [node({ nodeId: '1'.repeat(16), name: 'z', region: 'EU' }), node({ nodeId: '2'.repeat(16), name: 'Ubuntu', status: 'banned', retiredAt: 9 }), node({ nodeId: '3'.repeat(16), name: 'b', region: 'SA', status: 'probation', trusted: false, trustRemovedAt: 4 }), node({ nodeId: '4'.repeat(16), name: 'a', region: 'SA', status: 'pending' })] });
  const rows = M.nodeRows(o);
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'z', 'Ubuntu']);
  assert.deepEqual(rows.map((r) => r.tone), ['muted', 'warn', 'ok', 'muted']);
  assert.equal(rows[1].trustLost, true);
  assert.equal(rows[1].project, false);
  assert.equal(rows[3].retired, true);
  assert.equal(rows[0].key, '4'.repeat(16), 'a stable data-key: the node id');
});

test('what a node may be asked mirrors the server\'s guards: nothing retired; into service only once proven; active forced for a node not trusted; drain online; retire offline or drained with no match', () => {
  const to = (n) => M.nodeActions(n).status.map((s) => s.to + (s.force ? '!' : ''));
  assert.deepEqual(M.nodeActions(node({ retiredAt: 1 })), { status: [], drain: false, reprobe: false, retire: false });
  assert.deepEqual(to(node({ status: 'pending', reachableAt: null })), ['suspended', 'banned'], 'pending: it moves on by itself once its probe passes');
  assert.deepEqual(to(node({ status: 'banned', reachableAt: null })), ['suspended'], 'a host banned before its probe passed: suspended first');
  assert.deepEqual(to(node({ status: 'banned', reachableAt: 5 })), ['probation', 'active', 'suspended']);
  assert.deepEqual(to(node({ status: 'probation', trusted: false })), ['active!', 'suspended', 'banned'], 'a community node: active only forced');
  assert.deepEqual(to(node({ status: 'active', reachableAt: null })), ['probation', 'suspended', 'banned'], 'in service already: between probation and active');
  const a = M.nodeActions(node({ online: true, draining: false, matches: 2 }));
  assert.equal(a.drain, true);
  assert.equal(a.retire, false, 'online with matches: drain it first');
  assert.equal(M.nodeActions(node({ online: true, draining: true, matches: 0 })).retire, true);
  assert.equal(M.nodeActions(node({ online: false })).retire, true);
  assert.equal(M.nodeActions(node({ online: false })).drain, false);
  assert.equal(M.nodeActions(node({ transports: [], publicUrl: null, roles: ['verify'] })).reprobe, false, 'only a wss host has a probe');
});

test('the confirmations: a reason for a retirement, a ban, a drain, a delist, a forced active and the points; the node\'s name typed for a retirement, a ban and a drain', () => {
  for (const a of ['retire', 'ban', 'drain']) assert.deepEqual(M.confirmNeeds(a), { reason: true, typeName: true }, a);
  for (const a of ['delist', 'force', 'grant', 'revoke', 'unfreeze']) assert.deepEqual(M.confirmNeeds(a), { reason: true, typeName: false }, a);
  for (const a of ['status', 'reprobe', 'revokeToken', 'update']) assert.deepEqual(M.confirmNeeds(a), { reason: false, typeName: false }, a);
  assert.equal(M.nameTyped(' frankfurt-1 ', 'frankfurt-1'), true);
  assert.equal(M.nameTyped('Frankfurt-1', 'frankfurt-1'), false);
});

test('the wizard\'s follow-up: its token by the short id, then its node by usedBy, to active; expired, revoked, stopped and gone said apart', () => {
  const tk = (o = {}) => ({ id: '3f9a1c2b7d4e', operatorId: 'f', operatorName: 'T', region: 'EU', name: 'frankfurt-1', publicHost: 'node-1.example.com', roles: ['host', 'verify'], createdAt: 0, expiresAt: 3_600_000, usedBy: null, revokedAt: null, state: 'unused', ...o });
  const at = (tokens, nodes = []) => M.followOf(overview({ tokens, nodes }), '3f9a1c2b7d4e', 1000).step;
  assert.equal(at([tk()]), 'waiting');
  assert.equal(at([tk({ state: 'expired', expiresAt: 0 })]), 'expired');
  assert.equal(at([tk({ state: 'revoked', revokedAt: 5 })]), 'revoked');
  assert.equal(at([]), 'gone');
  const used = tk({ usedBy: 'n'.repeat(16), state: 'used' });
  assert.equal(at([used]), 'pending', 'used, its node not in this overview yet');
  assert.equal(at([used], [node({ nodeId: 'n'.repeat(16), status: 'pending' })]), 'pending');
  assert.equal(at([used], [node({ nodeId: 'n'.repeat(16), status: 'active' })]), 'active');
  assert.equal(at([used], [node({ nodeId: 'n'.repeat(16), status: 'banned' })]), 'stopped');
  assert.equal(at([used], [node({ nodeId: 'n'.repeat(16), status: 'active', retiredAt: 3 })]), 'stopped');
  assert.deepEqual(M.checklistOf(false), ['country', 'dns', 'firewall', 'os', 'ntp']);
  assert.deepEqual(M.checklistOf(true), ['country', 'dns', 'firewall', 'os', 'ntp', 'node', 'xmachine', 'release']);
  for (const l of M.checklistOf(true)) assert.equal(typeof es[`nodesAdmin.check.${l}`], 'string', l);
  assert.equal(M.minutesLeft(3_600_000, 0), 60);
  assert.equal(M.minutesLeft(0, 5), 0);
});

test('REGIONES and RELEASE: a region with no host says where its matches go; versions newest first, the stable one marked', () => {
  const o = overview({
    regions: [{ region: 'SA', hostsOnline: 1, slots: 8, active: 1, matches: 1, unplaced: 0, regionFactor: 1, rankedReady: true }, { region: 'NA', hostsOnline: 0, slots: 0, active: 0, matches: 0, unplaced: 0, regionFactor: 1, rankedReady: false }],
    verifiers: [{ nodeId: 'a', name: 'sao-paulo-1', region: 'SA', version: '0.3.0', node: 'v22', status: 'active', online: true, verifying: 0 }],
    nodes: [node(), node({ nodeId: 'b'.repeat(16), name: 'old', version: '0.2.10' }), node({ nodeId: 'c'.repeat(16), name: 'r', version: '0.4.0', retiredAt: 1 })],
    channel: { stable: '0.3.0', minimum: '0.3.0' },
  });
  const r = M.regionRows(o);
  assert.equal(r[0].empty, false);
  assert.deepEqual(r[0].verifiers, ['sao-paulo-1']);
  assert.equal(r[1].empty, true);
  assert.match(en['nodesAdmin.region.empty'], /Cloudflare/);
  assert.equal(es['nodesAdmin.region.empty'], 'Sin nodos: sus partidas van a servidores de Cloudflare.');
  assert.deepEqual(M.releaseRows(o).map((x) => [x.version, x.stable]), [['0.3.0', true], ['0.2.10', false]]);
});

test('CUENTAS Y COLAS: counts as numbers only (ids, lists and booleans left out), a queue day as one row of totals', () => {
  assert.deepEqual(M.countRows({ total: 3, byWays: { password: 2, 'password+google': 1 }, trusted: [{ found: true }], operators: null, name: 'x' }), [['total', 3], ['byWays.password', 2], ['byWays.password+google', 1]]);
  assert.deepEqual(M.queueDayRow({ date: '2026-11-04', searches: { casual: 3, ranked: 1 }, cancelled: { casual: 1 }, dropped: {}, formed: { casual: { 1: 2, 2: 1 }, ranked: { 2: 1 } }, onNode: 2, onCloud: 2, crossRegion: 1 }), { date: '2026-11-04', searches: 4, cancelled: 1, dropped: 0, formed: 4, onNode: 2, onCloud: 2, crossRegion: 1 });
  assert.equal(M.queueDayRow({ searches: {} }), null);
  assert.deepEqual(M.ADMIN_TABS, ['summary', 'nodes', 'operators', 'tokens', 'regions', 'release', 'points', 'stats', 'matches', 'history', 'alerts']);
});

// ---- AccountClient's /nodes/* calls ---------------------------------------------------------------

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const SESSION = (playerId, session) => ({ kind: 'account', playerId, name: 'Proyecto', session, expiresAt: Date.now() + 3_600_000 });

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
  a.account = SESSION('abcdef0123456789', 'jwt-1');
  return { a, calls };
}

test('nodesMine: GET /nodes/mine on ownCall (operator, nodes, rewards); a 404 or a page that is not JSON is empty; nodes_off rejects with its code', async () => {
  let c = client({ '/nodes/mine': () => res(200, { operator: { id: 'abcdef0123456789', trusted: true }, nodes: [{ nodeId: 'n1', name: 'x', status: 'active' }], rewards: { points30d: 5, earned: 9, matches30d: 1, playerMinutes30d: 2, byNode: {} } }) });
  const m = await c.a.nodesMine();
  assert.deepEqual(m.operator, { id: 'abcdef0123456789', trusted: true });
  assert.equal(m.nodes.length, 1);
  assert.equal(m.rewards.earned, 9);
  assert.equal(c.calls[0].method, 'GET');
  assert.equal(c.calls[0].auth, 'Bearer jwt-1');
  c = client({});
  assert.deepEqual(await c.a.nodesMine(), { operator: null, nodes: [], rewards: null }, 'a fork, local dev: 404');
  c = client({ '/nodes/mine': () => ({ ok: true, status: 200, json: async () => JSON.parse('<!doctype html>'), text: async () => '<!doctype html>' }) });
  assert.deepEqual(await c.a.nodesMine(), { operator: null, nodes: [], rewards: null }, "the dev server's page");
  c = client({ '/nodes/mine': () => res(503, { error: 'nodes_off' }) });
  await assert.rejects(c.a.nodesMine(), (e) => e instanceof AC.AccountError && e.code === 'nodes_off' && e.status === 503);
});

test('nodesMine: a 401 refreshes once and asks again; a refresh that hands back another account rejects (the cookie is shared by the tabs)', async () => {
  let n = 0;
  let c = client({
    '/nodes/mine': (init) => (init.headers.authorization === 'Bearer jwt-2' ? res(200, { nodes: [] }) : (n++, res(401, { error: 'unauthorized' }))),
    '/api/auth/refresh': () => res(200, SESSION('abcdef0123456789', 'jwt-2')),
  });
  assert.deepEqual((await c.a.nodesMine()).nodes, []);
  assert.equal(n, 1);
  c = client({ '/nodes/mine': () => res(401, { error: 'unauthorized' }), '/api/auth/refresh': () => res(200, SESSION('9999999999999999', 'jwt-other')) });
  await assert.rejects(c.a.nodesMine(), (e) => e instanceof AC.AccountError && e.code === 'unauthorized');
  assert.ok(!c.calls.some((x) => x.auth === 'Bearer jwt-other'), "another account's session never asks");
});

test('the admin calls: the overview, a wallet, the frozen list, the actions and the token on ownCall; reauth_required rejects with its level', async () => {
  const c = client({
    '/nodes/admin/overview': () => res(200, { at: 7, nodes: [] }),
    '/nodes/admin/wallet': (_, path) => res(200, { account: path.split('=')[1], wallet: { earned: 1, spent: 0, balance: 1, frozen: null }, items: ['badge-host'], car: null }),
    '/nodes/admin/frozen': () => res(200, { frozen: [{ account: 'a', reason: 'verification_failed:x', at: 1 }], more: false }),
    '/nodes/admin/retire': () => res(200, { nodeId: 'n', retiredAt: 1 }),
    '/nodes/admin/status': () => res(403, { error: 'reauth_required', level: 2 }),
    '/nodes/tokens': () => res(200, { token: 'tgn1_x', expiresAt: 99, ttlMinutes: 60, install: { linux: 'curl …' } }),
    '/nodes/admin/account-stats': () => res(200, { total: 3 }),
  });
  assert.equal((await c.a.nodesOverview()).at, 7);
  assert.equal((await c.a.nodesWallet('0a1b2c3d4e5f6071')).account, '0a1b2c3d4e5f6071');
  assert.equal(c.calls.at(-1).path, '/nodes/admin/wallet?account=0a1b2c3d4e5f6071');
  assert.equal((await c.a.nodesFrozen()).frozen.length, 1);
  await c.a.nodesAction('retire', { nodeId: 'n', reason: 'old' });
  assert.deepEqual(c.calls.at(-1), { path: '/nodes/admin/retire', method: 'POST', body: { nodeId: 'n', reason: 'old' }, auth: 'Bearer jwt-1' });
  await assert.rejects(c.a.nodesAction('status', { nodeId: 'n', status: 'active' }), (e) => e instanceof AC.AccountError && e.code === 'reauth_required' && e.level === 2);
  const ask = { region: 'EU', name: 'frankfurt-1', publicHost: 'node-1.example.com', roles: ['host', 'verify'], matches: 'auto' };
  const tk = await c.a.nodesToken(ask);
  assert.equal(tk.token, 'tgn1_x');
  assert.deepEqual(c.calls.at(-1).body, ask);
  assert.deepEqual(await c.a.accountStats(), { total: 3 });
  for (const x of c.calls) assert.ok(x.path.startsWith('/nodes/'), 'same origin, /nodes/* only: ' + x.path);
});

// ---- the screen's source rules -------------------------------------------------------------------------

test('the panel paints server text as text only: no innerHTML, no outerHTML, no insertAdjacentHTML; the only href is the viewer\'s, from a checked id', () => {
  assert.doesNotMatch(SCREEN, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.equal([...SCREEN.matchAll(/h\('a\./g)].length, 2, "two links, both the public viewer's: the review's and a match's (PARTIDAS)");
  assert.match(SCREEN, /const href = replayHref\(match\);/);
  assert.match(SCREEN, /const href = a\.viewer \? replayHref\(matchId\) : null;/);
  // The raw replay is saved from a blob of its bytes: the one other href, a link made, clicked and removed, never painted.
  assert.equal([...SCREEN.matchAll(/\.href = /g)].length, 1);
  assert.match(SCREEN, /link\.href = url;\s*link\.download = `\$\{matchId\}\.tgr`;/);
  assert.match(SCREEN, /if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(matchId\)\) return false;/, 'a checked id names the file');
  assert.match(SCREEN, /h\('a\.mn-btn', \{ href, target: '_blank', rel: 'noopener'/);
  assert.doesNotMatch(SCREEN, /href: /);
});

test('a pad or a keyboard reaches every read-only block: RESUMEN\'s warnings, commands and flags, a used token, the region and release cards, the verifiers and the queue, the counts and the queue days, a node\'s facts and a wallet\'s are stops of their own', () => {
  // The Menu scrolls only a focused [data-nav] into view: what has none below a view's last control is out of reach.
  assert.match(SCREEN, /const readOnly = \(key: string\): Record<string, unknown> => \(\{ class: 'mn-na-read', 'data-nav': true, tabindex: '0', 'data-key': key \}\);/);
  for (const re of [
    /h\('div\.mn-na-alert', readOnly\('na-warn-' \+ w\.kind \+ of\)/,
    /h\('div\.mn-cmd', readOnly\('na-flag-set'\), cmds\.set\), h\('div\.mn-cmd', readOnly\('na-flag-clear'\), cmds\.clear\)/,
    /'div\.mn-na-flag',\s*readOnly\('na-flag-' \+ f\.name\)/,
    /revocable\(tk, now\) \? \{ 'data-key': 'na-token-' \+ tk\.id \} : readOnly\('na-token-' \+ tk\.id\)/,
    /'div\.mn-prof-node',\s*readOnly\('na-region-' \+ r\.region\)/,
    /h\('p', readOnly\('na-verifier-' \+ v\.nodeId\)/,
    /h\('p', readOnly\(`na-queue-\$\{q\.version\}-\$\{q\.wasmSha256\.slice\(0, 8\)\}`\)/,
    /h\('p\.mn-note', readOnly\('na-verifiers-none'\)/,
    /h\('p\.mn-note', readOnly\('na-queue-none'\)/,
    /h\('div\.mn-prof-node', readOnly\('na-release-' \+ r\.version\)/,
    /h\('div\.mn-cmd', readOnly\('na-cli-show'\)/,
    /h\('div\.mn-cmd', readOnly\('na-cli-rollback'\)/,
    /h\('dl\.mn-prof-node-facts', readOnly\('na-stats-accounts'\)/,
    /h\('div\.mn-na-day', readOnly\('na-day-' \+ d\.date\)/,
    /h\('div\.mn-prof-node', readOnly\('na-detail-' \+ n\.nodeId\)/,
    /'dl\.mn-prof-node-facts',\s*readOnly\('na-wallet-facts'\)/,
    /h\('div\.mn-cmd', readOnly\('na-wiz-cmd'\), tk\.line\)/,
  ])
    assert.match(SCREEN, re);
  // Every command line is one (the install line, the flags', the channel's), and no flag or queue day is left out.
  assert.equal([...SCREEN.matchAll(/h\('div\.mn-cmd', /g)].length, [...SCREEN.matchAll(/h\('div\.mn-cmd', readOnly\(/g)].length);
  assert.doesNotMatch(SCREEN, /'div\.mn-na-flag',\s*null|h\('div\.mn-na-day', null/);
  // ▼ from a block that wide goes to its own control under it, not to the one nearest its middle.
  assert.match(SCREEN, /onNavTo\(card, 'down', \(\) => revealButton\);/);
  assert.match(SCREEN, /onNavTo\(line, 'down', \(\) => copy\);/);
  // Their ring inside them and no heel, as the board's rows: they stack closer than the heel's 15 px.
  assert.match(NODES_CSS, /\.mn-na-read \{\s*--ring-offset: calc\(-1 \* var\(--focus-w\)\);\s*--ring-shadow: inset 0 0 0 calc\(var\(--focus-w\) \+ var\(--focus-gap\)\) var\(--ink\);\s*--ring-heel: none;\s*\}/);
});

test('a tablet\'s node rows drop the four extra columns as a phone\'s do (a state\'s tag never runs into the next cell); a frozen wallet\'s reason gets a line of its own', () => {
  // 820 x 1180, up to 130 %: nine columns there cut the region and spilled "Suspendido" over 3/12.
  for (const [sel, decl] of [['.mn-na-row', 'grid-template-columns: auto minmax\\(0, 1fr\\) auto;'], ['.mn-na-name', 'grid-column: span 2;'], ['.mn-na-x', 'display: none;']]) {
    const list = ['phone', 'portrait', 'tablet'].map((l) => `html\\[data-layout='${l}'\\] \\${sel}`).join(',\\s*');
    assert.match(NODES_CSS, new RegExp(`(?:^|\\})\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)?${list}\\s*\\{\\s*${decl}\\s*\\}`), sel);
  }
  // The frozen list's row (account, reason, date): the reason, as long as a match id, under the other two.
  assert.match(SCREEN, /navButton\('mn-na-row', \[h\('code\.mn-na-name', null, f\.account\), h\('code\.mn-na-raw', null, f\.reason\), h\('span\.mn-na-c', null, when\(f\.at\)\)\]/);
  assert.match(NODES_CSS, /\.mn-na-row > \.mn-na-raw \{\s*grid-column: 1 \/ -1;\s*order: 1;\s*\}/);
});

test('nothing of the admin is kept: no localStorage, sessionStorage or IndexedDB in the panel or src/net/nodes.ts', () => {
  for (const src of [SCREEN, NODES]) assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
});

test('never on a TV: the screen shows the note and calls nothing; the refresh asks for the password only on a 403, once, never by acc.fresh', () => {
  assert.match(SCREEN, /const tvHere = \(\): boolean => acc\.account\?\.tv === true \|\| document\.documentElement\.classList\.contains\('tg-tv'\);/);
  assert.match(SCREEN, /tick: \(\) => \{\s*if \(sample !== null \|\| tvHere\(\) \|\| !acc\.signedIn\) return;/);
  assert.match(SCREEN, /if \(tvHere\(\)\) return setChildren\(body, h\('div\.mn-prof-node', null, icon\('tv', 'mn-mtile-icon'\), h\('p', null, t\('nodesShared\.tvNote'\)\)\)\);/);
  assert.match(SCREEN, /if \(failure === 'reauth' && !asked\) \{\s*asked = true;\s*askPassword\(\);/);
  assert.doesNotMatch(SCREEN, /acc\.fresh\(/, 'the 403 decides, never the client clock');
  assert.equal(es['nodesShared.tvNote'], 'Hazlo en tu teléfono o en tu PC.');
  // account-stats and queue-stats only from their tab (the 10 a minute they share).
  const tick = SCREEN.slice(SCREEN.indexOf('const load = async'), SCREEN.indexOf('/** A POST of the panel'));
  assert.doesNotMatch(tick, /accountStats|queueStats/);
});

test('the wizard: the password first, always for an account with one, then the token; the command shown only when it matches', () => {
  assert.match(SCREEN, /confirmItsYou\(menu, \(\) => void mint\(w\), 2, passwordSheet\(\)\);/);
  assert.match(SCREEN, /const passwordSheet = \(\): boolean => acc\.me\?\.hasPassword === true;/);
  assert.match(SCREEN, /lineOk: installLineMatches\(r\.install\.linux, ask\)/);
  assert.match(SCREEN, /const id = \(await sha256Hex\(r\.token\)\)\.slice\(0, 12\);/, "the overview's short id of the token (registry.ts tokenIdOf)");
  assert.equal(es['nodesAdmin.wiz.warn'], 'Solo para máquinas del proyecto: un token de esta cuenta da confianza total. El servidor de otra persona va por Mis servidores, nunca por aquí.');
});

// ---- PARTIDAS, HISTORIAL, ALERTAS (the history, PR 4) -------------------------------------------------

const HID = (c) => c.repeat(64);
const seat = (slot, team, o = {}) => ({ slot, team, bot: false, name: 'P' + slot, id: String(slot).repeat(16), hidden: false, ...o });
const settledMatch = (c, at, o = {}) => ({ matchId: HID(c), nodeId: 'n'.repeat(16), nodeName: 'sp1', region: 'SA', mode: '2v2', ranked: true, transport: 'wss', placedAt: at - 1000, reportedAt: at - 10, settledAt: at, result: 'rated', reason: 'rules', score: { blue: 1, red: 0 }, verified: true, verifiedBy: 'v', verifierName: 'sp1', verdict: { ok: true, code: 'ok' }, strike: null, replay: true, points: null, frozen: false, adminReason: null, seats: [seat(0, 0), seat(1, 1)], delistedAt: null, listed: true, published: true, ...o });
const openMatch = (c, at, o = {}) => ({ matchId: HID(c), nodeId: 'n'.repeat(16), nodeName: null, region: 'EU', mode: '1v1', ranked: false, transport: 'wss', state: 'assigned', placedAt: at, deadline: at + 1, started: false, reportedAt: null, queuedAt: null, verifying: false, verifierName: null, replay: false, leaves: 0, seats: [], ...o });

test('the history read leniently: pages with their cursor, names unavailable said apart, an event kind this client does not know left out; the overview\'s voids of 24 h', () => {
  assert.deepEqual(N.historyPageOf(null), { matches: [], next: null, names: 'shown' });
  const h = N.historyPageOf({ matches: [{ matchId: 'x' }], next: '12.' + HID('a'), names: 'unavailable' });
  assert.deepEqual([h.matches[0].seats, h.next, h.names], [[], '12.' + HID('a'), 'unavailable']);
  assert.deepEqual(N.openMatchesOf({ matches: [{ matchId: 'x' }] }), { total: 1, matches: [{ matchId: 'x', seats: [] }], names: 'shown' });
  const e = N.eventsPageOf({ events: [{ id: 2, kind: 'online' }, { id: 1, kind: 'something_new' }], next: '' });
  assert.deepEqual([e.events.map((x) => x.id), e.next], [[2], null]);
  assert.deepEqual(N.alertsPageOf({ alerts: [{ id: 1, line: 'ALERT x', kind: 'alert' }, { id: 2 }], webhook: false }), { alerts: [{ id: 1, line: 'ALERT x', kind: 'alert' }], next: null, webhook: false });
  assert.deepEqual(N.overviewOf({}).voids24h, [], 'a server of before');
  assert.deepEqual(N.NODE_EVENT_KINDS.length, 19);
});

test('PARTIDAS: the open matches first, newest first, then the settled ones as their pages came, each once; tones by state', () => {
  const rows = M.matchRows({ total: 2, names: 'shown', matches: [openMatch('a', 10), openMatch('b', 20, { state: 'verifying' })] }, [settledMatch('c', 30), settledMatch('a', 5), settledMatch('d', 3, { result: 'void' })]);
  assert.deepEqual(
    rows.map((r) => [r.matchId[0], r.open, r.state, r.tone, r.at]),
    [
      ['b', true, 'verifying', 'warn', 20],
      ['a', true, 'assigned', 'muted', 10],
      ['c', false, 'rated', 'ok', 30],
      ['d', false, 'void', 'bad', 3],
    ],
  );
  assert.equal(rows[1].nodeName, 'n'.repeat(16), 'a node without a name by its id');
  assert.deepEqual(M.matchRows(null, []), []);
});

test("a match's detail offers what the server would take: void (with or without a strike) and verify now for an open one; the viewer once published, delist while listed, the raw download while kept, for a settled one", () => {
  assert.deepEqual(M.matchActions({ open: true, match: openMatch('a', 1) }), { viewer: false, delist: false, download: false, void: true, verify: false });
  assert.deepEqual(M.matchActions({ open: true, match: openMatch('a', 1, { state: 'verifying', replay: true }) }), { viewer: false, delist: false, download: true, void: true, verify: true });
  assert.equal(M.matchActions({ open: true, match: openMatch('a', 1, { state: 'verifying', verifying: true }) }).verify, false, 'a verifier has it');
  assert.deepEqual(M.matchActions({ open: false, match: settledMatch('a', 1) }), { viewer: true, delist: true, download: true, void: false, verify: false });
  assert.deepEqual(M.matchActions({ open: false, match: settledMatch('a', 1, { published: false }) }), { viewer: false, delist: true, download: true, void: false, verify: false }, 'listed, its hour not released yet');
  assert.deepEqual(M.matchActions({ open: false, match: settledMatch('a', 1, { delistedAt: 5, listed: false, published: false }) }), { viewer: false, delist: false, download: false, void: false, verify: false }, 'delisted: nothing (the server answers 404 to the download too)');
  assert.deepEqual(M.matchActions({ open: false, match: settledMatch('a', 1, { result: 'void', listed: false, published: false, replay: false }) }), { viewer: false, delist: false, download: false, void: false, verify: false });
  for (const a of ['voidMatch', 'voidStrike']) assert.deepEqual(M.confirmNeeds(a), { reason: true, typeName: false }, a);
  assert.deepEqual(M.confirmNeeds('download'), { reason: false, typeName: false });
});

test('a seat named as the public replays name it: a hidden name as "Jugador N" (its slot + 1), a purged account said so, a bot, else the name', () => {
  assert.deepEqual(M.seatName(seat(0, 0)), { kind: 'name', name: 'P0', n: 1 });
  assert.deepEqual(M.seatName(seat(2, 1, { name: null, hidden: true })), { kind: 'hidden', name: '', n: 3 });
  assert.deepEqual(M.seatName(seat(3, 1, { name: null, id: null })), { kind: 'gone', name: '', n: 4 });
  assert.equal(M.seatName(seat(1, 0, { bot: true, name: null, id: null })).kind, 'bot');
  assert.equal(M.seatName(seat(1, 0, { name: null })).kind, 'hidden', 'names unavailable: its id stays, its name does not');
  assert.equal(es['nodesAdmin.match.hidden'].replace('{n}', '3'), 'Jugador 3');
});

test('HISTORIAL and ALERTAS: every event kind and match state has its words in both languages (Spanish translated), a tone each; a page appended once', () => {
  for (const k of N.NODE_EVENT_KINDS) {
    const key = `nodesAdmin.event.${k}`;
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof es[key], 'string', key);
    assert.notEqual(es[key], en[key], key);
    assert.ok(['ok', 'warn', 'muted', 'bad'].includes(M.eventTone(k)), k);
  }
  assert.equal(M.eventTone('strike'), 'bad');
  assert.equal(M.eventTone('online'), 'ok');
  for (const s of ['assigned', 'reporting', 'verifying', 'rated', 'unrated', 'void']) assert.equal(typeof es[`nodesAdmin.match.state.${s}`], 'string', s);
  for (const t of ['matches', 'history', 'alerts']) assert.equal(typeof es[`nodesAdmin.tab.${t}`], 'string', t);
  assert.deepEqual(es['nodesAdmin.tab.matches'] + es['nodesAdmin.tab.history'] + es['nodesAdmin.tab.alerts'], 'PartidasHistorialAlertas');
  assert.deepEqual(M.appendPage([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }], (x) => x.id), [{ id: 3 }, { id: 2 }, { id: 1 }]);
});

test('the history calls on ownCall: events, history, alerts and matches with their query (only what is given, encoded); the raw replay as bytes, its 404 with its code', async () => {
  const bytes = new Uint8Array([0x54, 0x47, 0x52, 0x31]);
  const c = client({
    '/nodes/admin/events': (_, path) => res(200, { events: [{ id: 1, kind: 'online', nodeId: 'n', at: 1 }], next: '1', path }),
    '/nodes/admin/history': () => res(200, { matches: [], next: null }),
    '/nodes/admin/alerts': () => res(200, { alerts: [], next: null, webhook: true }),
    '/nodes/admin/matches': () => res(200, { total: 0, matches: [] }),
    '/nodes/admin/replay': (_, path) => (path.endsWith(HID('a')) ? { ...res(200, null), arrayBuffer: async () => bytes.buffer.slice(0) } : res(404, { error: 'no_replay' })),
    '/nodes/admin/match/void': () => res(200, { voided: true }),
  });
  assert.equal((await c.a.nodesEvents({ node: 'abababababababab', before: '9' })).events.length, 1);
  assert.equal(c.calls.at(-1).path, '/nodes/admin/events?node=abababababababab&before=9');
  await c.a.nodesHistory({ match: HID('a') });
  assert.equal(c.calls.at(-1).path, '/nodes/admin/history?match=' + HID('a'));
  await c.a.nodesHistory({ before: '12.' + HID('b'), node: undefined });
  assert.equal(c.calls.at(-1).path, '/nodes/admin/history?before=12.' + HID('b'));
  await c.a.nodesAlerts();
  assert.equal(c.calls.at(-1).path, '/nodes/admin/alerts');
  assert.equal((await c.a.nodesMatches()).total, 0);
  assert.deepEqual(await c.a.nodesReplay(HID('a')), bytes);
  assert.deepEqual([c.calls.at(-1).method, c.calls.at(-1).auth], ['GET', 'Bearer jwt-1']);
  await assert.rejects(c.a.nodesReplay(HID('b')), (e) => e instanceof AC.AccountError && e.code === 'no_replay' && e.status === 404);
  await c.a.nodesAction('match/void', { matchId: HID('a'), reason: 'x', strike: true });
  assert.deepEqual(c.calls.at(-1).body, { matchId: HID('a'), reason: 'x', strike: true });
  for (const x of c.calls) assert.ok(x.path.startsWith('/nodes/admin/'), x.path);
});

test("the history's reads are their tab's (opened, ACTUALIZAR, MÁS), never the 15 s refresh's; the download is confirmed first", () => {
  const tick = SCREEN.slice(SCREEN.indexOf('const load = async'), SCREEN.indexOf('/** A POST of the panel'));
  assert.doesNotMatch(tick, /nodesHistory|nodesEvents|nodesAlerts|nodesMatches|nodesReplay/);
  assert.match(SCREEN, /if \(id === 'matches' && matches === null\) void loadMatches\(\);/);
  assert.match(SCREEN, /confirmSheet\('download', short, t\('nodesAdmin\.match\.download'\), \(\) => download\(matchId\)\)/);
  assert.match(SCREEN, /confirmSheet\('delist', short, t\('nodesAdmin\.match\.delist'\), \(reason\) => act\(\(\) => acc\.nodesAction\('delist', \{ matchId, reason \}\)/);
});

test("PARTIDAS' lookup: a match id or the replay link a player sent opens its detail; one the history does not keep still offers the viewer and DESLISTAR, never the raw download", () => {
  const id = HID('c');
  assert.equal(N.matchIdOf(id), id);
  assert.equal(N.matchIdOf('  ' + id.toUpperCase() + ' '), id, 'trimmed, lower case');
  assert.equal(N.matchIdOf('https://turbo-gol.com/replay.html?id=' + id), id);
  assert.equal(N.matchIdOf('replay.html?id=' + id + '&t=12'), id, 'a link without its origin, with more after it');
  for (const bad of ['', id.slice(1), id + 'a', 'replay.html?id=' + id.slice(2), 'replay.html?match=' + id, 'g'.repeat(64), 'http://[::1', 'javascript:alert(1)//?id=x']) assert.equal(N.matchIdOf(bad), null, bad);
  // Not kept by the history (listed before it was, or past its 30 days): what a listed replay takes.
  assert.deepEqual(M.matchActions({ open: false, match: null }), { viewer: true, delist: true, download: false, void: false, verify: false });
  // The screen: the field asks the history for that one match (never the refresh), and the detail without a row keeps DESLISTAR.
  assert.match(SCREEN, /const id = matchIdOf\(matchField\.input\.value\);/);
  assert.match(SCREEN, /const page = await acc\.nodesHistory\(\{ match: matchId \}\);/);
  assert.match(SCREEN, /if \(base === null && lookedUp === null\) return null;/);
  assert.match(SCREEN, /matchActions\(\{ open: false, match: settled \}\)/);
  const tick = SCREEN.slice(SCREEN.indexOf('const load = async'), SCREEN.indexOf('/** A POST of the panel'));
  assert.doesNotMatch(tick, /askMatch|matchIdOf/);
  for (const k of ['lookup', 'find', 'badId', 'noRow']) {
    const key = 'nodesAdmin.match.' + k;
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof es[key], 'string', key);
    assert.notEqual(es[key], en[key], key);
  }
});
