// Pure rules: registry lifecycle, placement, rewards ledger and node tickets.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const R = await import('../control-plane/registry.ts');
const { Registry, PROBATION_MATCHES, MAX_STRIKES, TOKEN_TTL_MS, STRIKE_WINDOW_MS, STRIKE_COOLDOWN_MS, validPublicUrl, usableTransports } = R;
const { pickNode, ineligibility, pickVerifier, transportFor } = await import('../control-plane/scheduler.ts');
const { Ledger, qualityFactor, regionFactor, LOW_WEIGHT } = await import('../control-plane/ledger.ts');
const { generateEd25519, importPrivateKey, importPublicKey } = await import('../shared/edcrypto.ts');
const { createNodeTicket, verifyNodeTicket } = await import('../shared/nodeTickets.ts');

const BUILD = { version: '0.1.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };

async function regNode(reg, op, now, extra = {}) {
  const { token } = await reg.createToken(op, extra.region ?? 'SA', now);
  const keys = await generateEd25519();
  const r = await reg.register(
    { token, publicKey: keys.publicKey, roles: extra.roles ?? ['host'], transports: extra.transports, publicUrl: extra.publicUrl === undefined ? 'wss://203.0.113.7' : extra.publicUrl, build: BUILD, specs: SPECS, capacity: CAP },
    now,
  );
  assert.ok(r.ok, JSON.stringify(r));
  return r.node;
}

function online(n, now, patch = {}) {
  Object.assign(n, { online: true, lastSeen: now, reachableAt: now, status: 'active', ...patch });
  return n;
}

// Trusted operators' tokens and nodes log ALERT lines: keep the test output clean.
const quiet = { log: () => undefined };

const hello = (patch = {}) => ({ build: BUILD, roles: ['host'], transports: ['rtc'], publicUrl: null, rtcReady: true, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...patch });

test('registration tokens: single use, expiry, URL rules, transports', async () => {
  const reg = new Registry(quiet);
  const op = { id: 'op1', name: 'Juan' };
  const now = 1_000_000;
  const { token } = await reg.createToken(op, 'SA', now);
  const keys = await generateEd25519();
  const req = { token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.7', build: BUILD, specs: SPECS, capacity: CAP };
  assert.equal((await reg.register(req, now + TOKEN_TTL_MS + 1)).code, 'token_expired');
  const ok = await reg.register(req, now);
  assert.ok(ok.ok);
  assert.equal(ok.node.status, 'pending');
  assert.deepEqual(ok.node.transports, ['wss'], 'a public URL means wss by default');
  assert.equal((await reg.register(req, now)).code, 'bad_token');
  const t2 = (await reg.createToken(op, 'SA', now)).token;
  assert.equal((await reg.register({ ...req, token: t2 }, now)).code, 'key_in_use');
  const t3 = (await reg.createToken(op, 'SA', now)).token;
  const k3 = await generateEd25519();
  assert.equal((await reg.register({ ...req, token: t3, publicKey: k3.publicKey, publicUrl: 'ws://203.0.113.7' }, now)).code, 'bad_public_url');
  assert.ok(validPublicUrl('wss://203.0.113.7:8443', false));
  assert.ok(!validPublicUrl('wss://203.0.113.7/path', false));
  // A home PC: no public URL at all, WebRTC.
  const home = await regNode(reg, op, now, { publicUrl: null });
  assert.deepEqual(home.transports, ['rtc']);
  assert.equal(home.publicUrl, null);
  // Verifying is reserved to the project's nodes for now; a project verifier needs no reachability.
  const t4 = (await reg.createToken(op, 'SA', now)).token;
  const k4 = await generateEd25519();
  for (const roles of [['verify'], ['host', 'verify']]) {
    assert.equal((await reg.register({ ...req, token: t4, publicKey: k4.publicKey, roles }, now)).code, 'verify_reserved');
  }
  reg.addTrustedOperator('project');
  const v = await regNode(reg, { id: 'project', name: 'Proyecto' }, now, { roles: ['verify'], publicUrl: null });
  assert.equal(v.status, 'active');
});

test('a trusted operator registers at most two nodes by default, tokens minted before included, and the refusal raises an ALERT', async () => {
  const lines = [];
  const reg = new Registry({ trustedOperators: ['project'], log: (m) => lines.push(m) });
  const project = { id: 'project', name: 'Proyecto' };
  const tokens = [];
  for (let i = 0; i < 3; i++) tokens.push((await reg.createToken(project, 'SA', 0)).token);
  const req = async (token) => ({ token, publicKey: (await generateEd25519()).publicKey, roles: ['host', 'verify'], publicUrl: 'wss://sp1.example.org', build: BUILD, specs: SPECS, capacity: CAP });
  assert.ok((await reg.register(await req(tokens[0]), 0)).ok);
  assert.ok((await reg.register(await req(tokens[1]), 0)).ok, 'the VPS and its replacement');
  lines.length = 0;
  assert.equal(R.MAX_TRUSTED_NODES_PER_OPERATOR, 2);
  assert.deepEqual(reg.slots('project'), { used: 2, max: 2 });
  assert.equal((await reg.register(await req(tokens[2]), 0)).code, 'too_many_nodes');
  assert.deepEqual(lines, ['ALERT registration refused: trusted operator Proyecto (project) already has its 2 nodes']);
  assert.equal(reg.byOperator('project').length, 2);
  assert.equal(reg.tokenList().filter((t) => t.usedBy === null).length, 1, 'the refused token is not spent');
  // A community operator keeps the general cap, and reaching it alerts nobody.
  const op = { id: 'op1', name: 'Juan' };
  for (let i = 0; i < R.MAX_NODES_PER_OPERATOR; i++) await regNode(reg, op, 0);
  lines.length = 0;
  const { token } = await reg.createToken(op, 'SA', 0);
  assert.equal((await reg.register(await req(token), 0)).code, 'too_many_nodes');
  assert.deepEqual(lines, []);
});

test('the trusted cap: maxTrustedNodes, bounded to 2..8; a retired node takes no slot, a banned one none of a trusted operator but still one of a community operator', async () => {
  assert.deepEqual([R.TRUSTED_NODES_MIN, R.TRUSTED_NODES_MAX], [2, 8]);
  for (const [v, cap] of [[undefined, 2], [null, 2], ['', 2], ['abc', 2], ['4', 4], [' 4 ', 4], [4, 4], ['1', 2], [0, 2], ['20', 8], [9, 8], ['4.5', 2], [4.5, 2], ['-3', 2]]) assert.equal(R.trustedNodeCap(v), cap, String(v));
  const lines = [];
  const reg = new Registry({ trustedOperators: ['project'], maxTrustedNodes: 4, log: (m) => lines.push(m) });
  const project = { id: 'project', name: 'Proyecto' };
  const nodes = [];
  for (let i = 0; i < 4; i++) nodes.push(await regNode(reg, project, 0, { roles: ['host', 'verify'], publicUrl: `wss://n${i}.example.org` }));
  assert.deepEqual(reg.slots('project'), { used: 4, max: 4 });
  const { token } = await reg.createToken(project, 'SA', 0);
  const req = async () => ({ token, publicKey: (await generateEd25519()).publicKey, roles: ['host'], publicUrl: 'wss://n9.example.org', build: BUILD, specs: SPECS, capacity: CAP });
  assert.equal((await reg.register(await req(), 0)).code, 'too_many_nodes');
  assert.ok(lines.includes('ALERT registration refused: trusted operator Proyecto (project) already has its 4 nodes'));
  // The old "Ubuntu" registration: banned, it takes no slot of the project's.
  reg.setStatus(nodes[0].nodeId, 'banned', 'a bad first install');
  assert.deepEqual(reg.slots('project'), { used: 3, max: 4 });
  assert.equal(reg.retire(nodes[1].nodeId, 'replaced', 5)?.retiredReason, 'replaced');
  assert.equal(reg.retire(nodes[1].nodeId, 'again', 6), null, 'once');
  assert.ok(R.isRetired(reg.node(nodes[1].nodeId)));
  assert.deepEqual(reg.slots('project'), { used: 2, max: 4 });
  assert.ok((await reg.register(await req(), 0)).ok, 'the token minted at the cap registers once a slot is free');
  // A community operator: a banned node still counts (else its owner registers again), a retired one does not.
  const reg2 = new Registry(quiet);
  const op = { id: 'op1', name: 'Juan' };
  const own = [];
  for (let i = 0; i < R.MAX_NODES_PER_OPERATOR; i++) own.push(await regNode(reg2, op, 0));
  reg2.setStatus(own[0].nodeId, 'banned', 'cheating');
  assert.deepEqual(reg2.slots('op1'), { used: R.MAX_NODES_PER_OPERATOR, max: R.MAX_NODES_PER_OPERATOR });
  reg2.retire(own[1].nodeId, 'gone', 1);
  assert.deepEqual(reg2.slots('op1'), { used: R.MAX_NODES_PER_OPERATOR - 1, max: R.MAX_NODES_PER_OPERATOR });
});

test('a retired node takes no match and verifies none', async () => {
  const reg = new Registry({ trustedOperators: ['project'], log: () => undefined });
  const host = online(await regNode(reg, { id: 'op1', name: 'Juan' }, 0), 0);
  const v1 = online(await regNode(reg, { id: 'project', name: 'Proyecto' }, 0, { roles: ['verify'], publicUrl: null }), 0);
  const req = { region: 'SA', mode: '1v1', ranked: false, playerIds: ['x'], build: BUILD, transports: ['wss'], now: 0 };
  assert.equal(ineligibility(host, req), null);
  assert.equal(pickVerifier(reg.list(), host, BUILD, 0, () => 0)?.nodeId, v1.nodeId);
  reg.retire(host.nodeId, 'gone', 1);
  reg.retire(v1.nodeId, 'gone', 1);
  assert.equal(ineligibility(host, req), 'retired');
  assert.equal(pickVerifier(reg.list(), reg.node(host.nodeId), BUILD, 0, () => 0), null);
});

test('a trusted host is verified by another free verifier of the same simulation when there is one, by itself only when there is not', async () => {
  const reg = new Registry({ trustedOperators: ['project'], log: () => undefined });
  const project = { id: 'project', name: 'Proyecto' };
  const sp = online(await regNode(reg, project, 0, { roles: ['host', 'verify'], publicUrl: 'wss://sp.example.org' }), 0);
  const de = online(await regNode(reg, project, 0, { roles: ['host', 'verify'], publicUrl: 'wss://de.example.org' }), 0);
  const busy = new Map();
  const pick = () => pickVerifier(reg.list(), sp, BUILD, 0, (id) => busy.get(id) ?? 0, { rand: () => 0.99 })?.nodeId;
  for (let i = 0; i < 5; i++) assert.equal(pick(), de.nodeId, 'the other machine');
  busy.set(de.nodeId, 1);
  assert.equal(pick(), sp.nodeId, 'the other one is busy: itself');
  busy.set(sp.nodeId, 2);
  assert.equal(pick(), de.nodeId, 'both busy: the least busy');
  de.build = { ...BUILD, version: '0.2.0' };
  busy.clear();
  assert.equal(pick(), sp.nodeId, 'another simulation never verifies it');
});

test('validPublicHost: a DNS name as install.sh is_dns_name reads one, lower-cased; no scheme, port, path or IP address', () => {
  for (const ok of ['sp1.turbo-gol.com', 'A1.Example.ORG', 'xn--80ak6aa92e.com', 'a.b.c.d.e', 'n-1.de']) assert.equal(R.validPublicHost(ok), ok.toLowerCase(), ok);
  for (const bad of ['', 'localhost', 'turbo-gol', '203.0.113.7', '1.2.3', '::1', '[2001:db8::1]', '2001:db8::1', 'wss://sp1.example.org', 'sp1.example.org:443', 'sp1.example.org/', 'sp1.example.org.', '-a.example.org', 'a-.example.org', 'a..example.org', 'a.example.1x', 'a b.example.org', 'sp1.example.org\n', 'a.' + 'b'.repeat(64) + '.org', `${'a'.repeat(63)}.`.repeat(4) + 'org', 7, null]) {
    assert.equal(R.validPublicHost(bad), null, String(bad));
  }
  assert.ok(R.isIpHost(new URL('wss://203.0.113.7').hostname));
  assert.ok(R.isIpHost(new URL('wss://0xcb.0.113.7').hostname), 'every IPv4 form reads as the dotted one');
  assert.ok(R.isIpHost(new URL('wss://[2001:db8::7]:8443').hostname));
  assert.ok(!R.isIpHost(new URL('wss://sp1.example.org').hostname));
});

test('a token pins its host and roles: another host, an IP address (refuseIpUrls) or another role is refused before the token is spent; a hello stays on the pinned host; a revoked token registers nothing', async () => {
  const lines = [];
  const reg = new Registry({ trustedOperators: ['project'], refuseIpUrls: true, maxTrustedNodes: 4, log: (m) => lines.push(m) });
  const project = { id: 'project', name: 'Proyecto' };
  const { token } = await reg.createToken(project, 'EU', 0, 'frankfurt-1', { publicHost: 'de1.example.org', roles: ['host', 'verify'] });
  const t = reg.tokenList()[0];
  assert.deepEqual([t.publicHost, t.roles, R.tokenState(t, 0), R.tokenIdOf(t)], ['de1.example.org', ['host', 'verify'], 'unused', t.hash.slice(0, 12)]);
  assert.ok(lines.at(-1).endsWith('region EU for de1.example.org'), lines.at(-1));
  const keys = await generateEd25519();
  const req = (over) => ({ token, publicKey: keys.publicKey, roles: ['host', 'verify'], publicUrl: 'wss://de1.example.org', build: BUILD, specs: SPECS, capacity: CAP, ...over });
  assert.equal((await reg.register(req({ publicUrl: 'wss://de2.example.org' }), 1)).code, 'public_host_mismatch');
  assert.equal((await reg.register(req({ publicUrl: 'wss://203.0.113.7' }), 1)).code, 'public_host_mismatch');
  assert.equal((await reg.register(req({ roles: ['verify'], publicUrl: undefined }), 1)).code, 'public_host_mismatch', 'a pinned token is for a wss host');
  assert.equal(R.tokenState(reg.tokenList()[0], 1), 'unused', 'none of them spent it');
  const n = await reg.register(req(), 1);
  assert.ok(n.ok, JSON.stringify(n));
  assert.deepEqual([n.node.publicHost, n.node.publicUrl, n.node.retiredAt, n.node.trustRemovedAt], ['de1.example.org', 'wss://de1.example.org', null, null]);
  assert.equal(reg.addressAllowed(n.node, 'wss://DE1.example.org:443'), true, 'the host as the URL parser reads it: lower case');
  // A hello on another host keeps the pinned address.
  reg.connected(n.node.nodeId, { ...hello({ roles: ['host', 'verify'], transports: ['wss'] }), publicUrl: 'wss://evil.example.org' }, 2);
  assert.equal(reg.node(n.node.nodeId).publicUrl, 'wss://de1.example.org');
  assert.ok(lines.some((l) => l.includes('a hello on another address (wss://evil.example.org) kept wss://de1.example.org')));
  reg.connected(n.node.nodeId, { ...hello({ roles: ['host', 'verify'], transports: ['wss'] }), publicUrl: 'wss://de1.example.org:8443' }, 3);
  assert.equal(reg.node(n.node.nodeId).publicUrl, 'wss://de1.example.org:8443', 'another port on the pinned host is its own business');
  // Without a pin, an IP address is refused for every registration and every hello (refuseIpUrls).
  const free = (await reg.createToken(project, 'SA', 0)).token;
  const k2 = await generateEd25519();
  assert.equal((await reg.register({ ...req({ publicUrl: 'wss://203.0.113.7' }), token: free, publicKey: k2.publicKey }, 1)).code, 'ip_not_supported');
  assert.equal((await reg.register({ ...req({ publicUrl: 'wss://[2001:db8::7]' }), token: free, publicKey: k2.publicKey }, 1)).code, 'ip_not_supported');
  const sp = await reg.register({ ...req({ publicUrl: 'wss://sp1.example.org' }), token: free, publicKey: k2.publicKey }, 1);
  assert.ok(sp.ok);
  reg.connected(sp.node.nodeId, { ...hello({ roles: ['host', 'verify'], transports: ['wss'] }), publicUrl: 'wss://203.0.113.9' }, 2);
  assert.equal(reg.node(sp.node.nodeId).publicUrl, 'wss://sp1.example.org');
  assert.equal(reg.addressAllowed(reg.node(sp.node.nodeId), 'wss://sp2.example.org'), true, 'an unpinned node may move to another name');
  // Roles: a host-only token registers no verifier.
  const hostOnly = (await reg.createToken(project, 'SA', 0, undefined, { roles: ['host'] })).token;
  const k3 = await generateEd25519();
  assert.equal((await reg.register({ ...req({ publicUrl: 'wss://sp3.example.org' }), token: hostOnly, publicKey: k3.publicKey }, 1)).code, 'bad_roles');
  // A revoked token: refused, never spent; a used one cannot be revoked; ids are never guessed.
  const id = R.tokenIdOf(reg.tokenList().find((x) => x.roles?.length === 1));
  assert.deepEqual(reg.revokeToken(id, 5).result, 'revoked');
  assert.deepEqual(reg.revokeToken(id, 6).result, 'already');
  assert.equal((await reg.register({ ...req({ publicUrl: 'wss://sp3.example.org', roles: ['host'] }), token: hostOnly, publicKey: k3.publicKey }, 7)).code, 'token_revoked');
  assert.equal(R.tokenState(reg.tokenList().find((x) => R.tokenIdOf(x) === id), 7), 'revoked');
  assert.equal(reg.revokeToken(R.tokenIdOf(t), 8).result, 'used');
  assert.equal(reg.revokeToken('ffffffffffff', 8).result, 'none');
  assert.equal(reg.revokeToken('', 8).result, 'none', 'a prefix that matches every token');
  // The reference server and the tests (no refuseIpUrls) still register on addresses.
  assert.ok((await regNode(new Registry(quiet), { id: 'op1', name: 'Juan' }, 0)).publicUrl.includes('203.0.113.7'));
});

test('reachability: wss by probe, rtc by its self-test; trusted nodes skip probation', async () => {
  const reg = new Registry(quiet);
  const op = { id: 'op1', name: 'Juan' };
  const wss = await regNode(reg, op, 0);
  assert.equal(reg.markReachable(wss.nodeId, 1), 'probation');
  const home = await regNode(reg, op, 0, { publicUrl: null });
  assert.equal(reg.connected(home.nodeId, hello({ rtcReady: false }), 5), null, 'self-test not passed yet');
  assert.deepEqual(usableTransports(home), []);
  assert.equal(reg.connected(home.nodeId, hello(), 6), 'probation');
  assert.deepEqual(usableTransports(home), ['rtc']);
  // The project's Sao Paulo VPS: active as soon as it is reachable.
  reg.addTrustedOperator('project');
  const sp = await regNode(reg, { id: 'project', name: 'Proyecto' }, 0, { roles: ['host', 'verify'] });
  assert.equal(sp.trusted, true);
  assert.equal(reg.markReachable(sp.nodeId, 1), 'active');
  const spv = await regNode(reg, { id: 'project', name: 'Proyecto' }, 0, { roles: ['verify'], publicUrl: null });
  assert.equal(spv.status, 'active');
});

test('status rules: verified matches -> active, failure -> suspended for review', async () => {
  const reg = new Registry(quiet);
  const n = await regNode(reg, { id: 'op1', name: 'Juan' }, 0);
  reg.markReachable(n.nodeId, 1);
  for (let i = 0; i < PROBATION_MATCHES - 1; i++) assert.equal(reg.onVerified(n.nodeId, false, true), null);
  assert.equal(reg.onVerified(n.nodeId, false, true), 'active');
  assert.equal(reg.onVerified(n.nodeId, true, false), 'suspended');
  assert.equal(reg.node(n.nodeId).statusReason, 'verification_failed');
  assert.equal(reg.node(n.nodeId).suspendedUntil, null, 'a failed verification waits for a maintainer');
  assert.deepEqual(reg.sweep(10 * STRIKE_COOLDOWN_MS).restored, [], 'never lifts by itself');
});

test('strikes: they expire after a week; three in a week suspend for a day, then the node is back', async () => {
  const reg = new Registry(quiet);
  const n = await regNode(reg, { id: 'op1', name: 'Juan' }, 0, { publicUrl: null });
  reg.connected(n.nodeId, hello(), 1);
  reg.setStatus(n.nodeId, 'active', null);
  const day = 24 * 60 * 60 * 1000;
  // Two losses, then a third more than a week after the first: no suspension.
  assert.equal(reg.onLost(n.nodeId, 'offline', 0), null);
  assert.equal(reg.onLost(n.nodeId, 'offline', 2 * day), null);
  assert.equal(reg.onLost(n.nodeId, 'offline', STRIKE_WINDOW_MS + day), null);
  assert.equal(reg.node(n.nodeId).counters.strikes, 2);
  // The third within the window suspends, with a cooldown.
  const t = STRIKE_WINDOW_MS + 1.5 * day; // the strike at day 2 is still inside the window
  assert.equal(reg.onLost(n.nodeId, 'offline', t), 'suspended');
  assert.equal(reg.node(n.nodeId).counters.strikes, MAX_STRIKES);
  assert.equal(reg.node(n.nodeId).suspendedUntil, t + STRIKE_COOLDOWN_MS);
  assert.deepEqual(reg.sweep(t + STRIKE_COOLDOWN_MS - 1).restored, []);
  const back = reg.sweep(t + STRIKE_COOLDOWN_MS).restored;
  assert.equal(back.length, 1);
  assert.equal(reg.node(n.nodeId).status, 'active', 'back to where it was');
  assert.equal(reg.node(n.nodeId).counters.strikes, 2, 'the pause lifts, the strikes keep their 7-day window (days 8 and 8.5)');
  // Trusted nodes are never suspended by strikes.
  reg.addTrustedOperator('project');
  const sp = await regNode(reg, { id: 'project', name: 'Proyecto' }, 0);
  reg.markReachable(sp.nodeId, 0);
  for (let i = 0; i < 5; i++) assert.equal(reg.onLost(sp.nodeId, 'crash', i), null);
});

test('placement: every eligibility rule, transports, least-loaded quarter, random spread', async () => {
  const reg = new Registry(quiet);
  const now = 50_000;
  const a = online(await regNode(reg, { id: 'opA', name: 'A' }, 0), now);
  const b = online(await regNode(reg, { id: 'opB', name: 'B' }, 0), now);
  const req = { region: 'SA', mode: '1v1', ranked: true, playerIds: ['p1', 'p2'], build: BUILD, transports: ['wss', 'rtc'], now };
  assert.equal(ineligibility(a, req), null);
  assert.equal(ineligibility({ ...a, online: false }, req), 'offline');
  assert.equal(ineligibility({ ...a, lastSeen: now - 20_000 }, req), 'offline');
  assert.equal(ineligibility({ ...a, reachableAt: null }, req), 'unreachable');
  assert.equal(ineligibility({ ...a, status: 'probation' }, req), 'status:probation');
  assert.equal(ineligibility({ ...a, status: 'probation' }, { ...req, ranked: false }), null);
  assert.equal(ineligibility({ ...a, build: { ...BUILD, wasmSha256: 'b'.repeat(64) } }, req), 'build');
  assert.equal(ineligibility({ ...a, draining: true }, req), 'draining');
  assert.equal(ineligibility({ ...a, active: 4 }, req), 'full');
  assert.equal(ineligibility({ ...a, egressCapGB: 100, egressGB: 99 }, req), 'egress_cap');
  assert.equal(ineligibility({ ...a, region: 'EU' }, req), 'region');
  assert.equal(ineligibility(a, { ...req, playerIds: ['opA', 'p2'] }), 'operator_plays');
  assert.equal(ineligibility(a, { ...req, ranked: false, playerIds: ['opA', 'p2'] }), null, 'casual on your own node is fine');
  // A home PC is only for clients with the WebRTC adapter.
  const home = online(await regNode(reg, { id: 'opH', name: 'H' }, 0, { publicUrl: null }), now, { rtcReady: true, reachableAt: null });
  assert.equal(ineligibility(home, req), null);
  assert.equal(transportFor(home, req.transports), 'rtc');
  assert.equal(ineligibility(home, { ...req, transports: ['wss'] }), 'transport');
  assert.equal(ineligibility({ ...home, rtcReady: false }, req), 'unreachable');
  assert.equal(transportFor(a, req.transports), 'wss', 'a public node is reached by WebSocket when the client can');
  // Least loaded wins; ties are random.
  home.online = false;
  a.active = 3;
  b.active = 0;
  assert.equal(pickNode([a, b, home], req, () => 0.99).nodeId, b.nodeId);
  a.active = 0;
  const seen = new Set();
  for (const r of [0, 0.49, 0.5, 0.99]) seen.add(pickNode([a, b], req, () => r).nodeId);
  assert.equal(seen.size, 2);
  assert.equal(pickNode([], req), null);
});

test('verifiers: trusted only, same simulation, never the community host, its operator or an operator who played; random among the least busy', async () => {
  const reg = new Registry(quiet);
  const now = 50_000;
  const a = online(await regNode(reg, { id: 'opA', name: 'A' }, 0), now);
  // A community verifier cannot register any more; one from before the rule is still never picked.
  const v = online(await regNode(reg, { id: 'opV', name: 'V' }, 0), now, { roles: ['verify'] });
  assert.equal(pickVerifier([a, v], a, BUILD, now, () => 0), null, 'not trusted');
  reg.addTrustedOperator('project');
  const sp = online(await regNode(reg, { id: 'project', name: 'Proyecto' }, 0, { roles: ['host', 'verify'] }), now);
  assert.equal(pickVerifier([a, v, sp], a, BUILD, now, () => 0).nodeId, sp.nodeId);
  assert.equal(pickVerifier([a, v, sp], sp, BUILD, now, () => 0).nodeId, sp.nodeId, 'the project VPS re-simulates its own matches too');
  const mine = online(await regNode(reg, { id: 'opA', name: 'A' }, 0), now, { roles: ['verify'], trusted: true });
  assert.notEqual(pickVerifier([mine], a, BUILD, now, () => 0)?.nodeId, mine.nodeId, 'same operator as the community host');
  // Same wasm and protocol but another node release: its JavaScript may simulate differently.
  assert.equal(pickVerifier([sp], a, { ...BUILD, version: '0.2.0' }, now, () => 0), null, 'another release');
  // The project's operator played in the match: another project verifier if there is one, else the same one.
  assert.equal(pickVerifier([sp], a, BUILD, now, () => 0, { playerIds: ['project'] }).nodeId, sp.nodeId, 'never left unverified');
  reg.addTrustedOperator('project2');
  const other = online(await regNode(reg, { id: 'project2', name: 'Proyecto 2' }, 0, { roles: ['verify'], publicUrl: null }), now);
  assert.equal(pickVerifier([sp, other], a, BUILD, now, () => 0, { playerIds: ['project'], rand: () => 0 }).nodeId, other.nodeId, 'one whose operator did not play first');
  // Two equally busy verifiers: the pick follows the random draw; a busier one is skipped.
  const sp2 = online(await regNode(reg, { id: 'project', name: 'Proyecto' }, 0, { roles: ['verify'], publicUrl: null }), now);
  assert.equal(pickVerifier([sp, sp2], a, BUILD, now, () => 0, { rand: () => 0 }).nodeId, sp.nodeId);
  assert.equal(pickVerifier([sp, sp2], a, BUILD, now, () => 0, { rand: () => 0.99 }).nodeId, sp2.nodeId);
  assert.equal(pickVerifier([sp, sp2], a, BUILD, now, (id) => (id === sp.nodeId ? 1 : 0), { rand: () => 0 }).nodeId, sp2.nodeId);
});

test('ledger: verified minutes, weights, operator excluded, repeat decay, factors, totals', () => {
  const L = new Ledger();
  const base = { matchId: 'm1', nodeId: 'n1', operatorId: 'op', region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', tickLagP99Ms: 2, underrunRate: 0, at: 1_000 };
  const five = 5 * 60_000;
  const e1 = L.record({ ...base, players: [{ playerId: 'p1', connectedMs: five, account: true, accountAgeDays: 30 }, { playerId: 'p2', connectedMs: five, account: true, accountAgeDays: 30 }] }, 1);
  assert.equal(e1.playerMinutes, 10);
  assert.equal(e1.quality, 1, 'self-reported quality never raises the points');
  assert.equal(e1.points, 10);
  const e2 = L.record({ ...base, matchId: 'm2', at: 2_000, players: [{ playerId: 'p2', connectedMs: five, account: true, accountAgeDays: 30 }, { playerId: 'p1', connectedMs: five, account: true, accountAgeDays: 30 }] }, 1);
  assert.equal(e2.repeat, 0.5);
  assert.equal(e2.points, 5);
  const e3 = L.record({ ...base, matchId: 'm3', at: 3_000, players: [{ playerId: 'op', connectedMs: five, account: true, accountAgeDays: 400 }, { playerId: 'g', connectedMs: five, account: false, accountAgeDays: 0 }] }, 2);
  assert.equal(e3.weightedMinutes, 5 * LOW_WEIGHT);
  assert.equal(e3.points, Math.round(5 * LOW_WEIGHT * 2 * 1 * 100) / 100);
  assert.equal(L.record({ ...base, matchId: 'm4', verified: false, players: [{ playerId: 'z', connectedMs: five, account: true, accountAgeDays: 30 }] }, 1).points, 0);
  assert.equal(L.earned('op'), 10 + 5 + e3.points);
  assert.equal(L.verifiedMatches('op'), 3);
  assert.equal(qualityFactor(10, 0.03), 1);
  assert.equal(qualityFactor(2, 0), 1, 'capped while the node measures it');
  assert.equal(qualityFactor(2, 0, false), 1.2, 'client-measured quality may earn the bonus');
  assert.equal(qualityFactor(30, 0), 0.5);
  assert.equal(regionFactor(0, 100), 0.5);
  assert.equal(regionFactor(50, 100), 1);
  assert.equal(regionFactor(1000, 10), 3);
  const s = L.summary('op', 10_000);
  assert.equal(s.matches30d, 4);
  assert.equal(s.earned, L.earned('op'));
  assert.equal(L.leaderboard(10_000)[0].operatorId, 'op');
});

test('node tickets: audience, match, expiry, wrong key', async () => {
  const k = await generateEd25519();
  const other = await generateEd25519();
  const priv = await importPrivateKey(k.privateKey);
  const pub = await importPublicKey(k.publicKey);
  const now = Date.now();
  const t = await createNodeTicket(priv, { sub: 'p'.repeat(16), mid: 'm'.repeat(32), team: 1, slot: 1, name: 'Ana', nodeId: 'nodeA' }, now);
  const c = await verifyNodeTicket(pub, t, 'm'.repeat(32), 'nodeA', now);
  assert.equal(c.slot, 1);
  assert.equal(c.aud, 'node:nodeA');
  assert.equal(await verifyNodeTicket(pub, t, 'm'.repeat(32), 'nodeB', now), null, 'another node');
  assert.equal(await verifyNodeTicket(pub, t, 'x'.repeat(32), 'nodeA', now), null, 'another match');
  assert.equal(await verifyNodeTicket(pub, t, 'm'.repeat(32), 'nodeA', now + 91_000), null, 'expired');
  assert.equal(await verifyNodeTicket(await importPublicKey(other.publicKey), t, 'm'.repeat(32), 'nodeA', now), null, 'wrong key');
  const parts = t.split('.');
  const forged = parts[0] + '.' + Buffer.from(JSON.stringify({ ...c, slot: 0 })).toString('base64url') + '.' + parts[2];
  assert.equal(await verifyNodeTicket(pub, forged, 'm'.repeat(32), 'nodeA', now), null, 'tampered claims');
});

test('ledger restore: what the store kept (entries, notes, totals) rebuilds the same ledger: totals, leaderboard, summaries and the 24 h repeat decay', () => {
  const notes = [];
  const L = new Ledger({ onNote: (n) => notes.push(n) });
  const five = 5 * 60_000;
  const p = (id) => ({ playerId: id, connectedMs: five, account: true, accountAgeDays: 30 });
  const base = { nodeId: 'n1', operatorId: 'op', region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', tickLagP99Ms: 2, underrunRate: 0 };
  const DAY = 24 * 60 * 60_000;
  const t0 = 100 * DAY;
  const old = L.record({ ...base, matchId: 'old', at: t0 - 31 * DAY, players: [p('x'), p('y')] }, 1);
  const e1 = L.record({ ...base, matchId: 'm1', at: t0, players: [p('p1'), p('p2')] }, 1.5);
  L.noteGroup('op', ['p2', 'p1', 'op'], t0 + 1);
  L.noteGroup('op', ['op'], t0 + 2); // nobody counted: no note
  assert.deepEqual(notes, [{ operatorId: 'op', playerIds: ['p2', 'p1', 'op'], at: t0 + 1 }]);
  const R = new Ledger();
  R.restore({ entries: [e1, old], notes, totals: [{ operatorId: 'op', earned: L.earned('op'), verified: L.verifiedMatches('op') }] }, t0 + 10);
  assert.equal(R.earned('op'), L.earned('op'));
  assert.equal(R.verifiedMatches('op'), 2);
  assert.deepEqual(R.leaderboard(t0 + 10), L.leaderboard(t0 + 10));
  assert.deepEqual(R.summary('op', t0 + 10), L.summary('op', t0 + 10));
  assert.deepEqual(R.recent(t0 + 10).map((e) => e.matchId), ['m1'], 'past the window: dropped (its points stay in the totals)');
  const next = { ...base, matchId: 'm2', at: t0 + 20, players: [p('p1'), p('p2')] };
  assert.equal(R.record(next, 1).repeat, L.record(next, 1).repeat, 'the same decay');
  assert.equal(R.record({ ...next, matchId: 'm3', at: t0 + 30 }, 1).repeat, 1 / 4);
  assert.equal(R.record({ ...next, matchId: 'm4', at: t0 + DAY + 25 }, 1).repeat, 1 / 2, 'a day after the first ones only m3 is still in the window');
});
