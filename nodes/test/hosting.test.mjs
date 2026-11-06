// Hosting by the community (Prompt 2, PR 1): the rules a node outside the project registers and is
// placed under, and the ledger's anti-farming. The registry's CommunityRules (A5 wss on 443 behind a
// DNS name, A6 the continent, A13 a name of its own, A4 a blocked operator), the control plane's
// CommunityPolicy (A7 no ranked, A8 effective capacity and the operator's matches, A8 bis refusals,
// A9 the verification queue's order and brake, A17e the lone player's match), the ledger's options
// (A17a the daily cap, A17b each player's own decay) and the public list's opt-in (A14). None of it
// ever touches a project node, and without the options everything is as before.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { human, setup, wait } from './fakeNode.mjs';

const R = await import('../control-plane/registry.ts');
const { Registry } = R;
const C = await import('../control-plane/controlPlane.ts');
const { ControlPlane, COMMUNITY_POLICY } = C;
const { ineligibility } = await import('../control-plane/scheduler.ts');
const { Ledger, countsAsHosted } = await import('../control-plane/ledger.ts');
const { publicNamesWanted, publicOperatorNames, publicStatus } = await import('../control-plane/publicList.ts');
const { nodeFromRow, nodeToRow } = await import('../control-plane/persist.ts');
const { generateEd25519, importPrivateKey, sign } = await import('../shared/edcrypto.ts');
const { authMessage, reachMessage } = await import('../shared/controlProtocol.ts');

const BUILD = { version: '0.1.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
const RULES = { reservedDomains: ['turbo-gol.com'], regionCheck: true };
const quiet = () => undefined;

// ---- the registry: CommunityRules -----------------------------------------------------------------

/** A registration request for `token` (a fresh key), wss on `publicUrl` unless `extra` says otherwise. */
async function request(token, publicUrl, extra = {}) {
  return { token, publicKey: (await generateEd25519()).publicKey, roles: ['host'], publicUrl, build: BUILD, specs: SPECS, capacity: CAP, ...extra };
}

test('a community node registers only as a VPS by wss on 443 behind a DNS name, in its token continent; each refusal leaves the token good', async () => {
  assert.equal(R.MAX_NODES_PER_OPERATOR, 3, 'COMMUNITY_MAX_NODES');
  const reg = new Registry({ trustedOperators: ['project'], maxTrustedNodes: 8, log: quiet, community: RULES });
  const juan = { id: 'op1', name: 'Juan' };
  const { token } = await reg.createToken(juan, 'SA', 0);
  const seen = { continent: 'SA' };
  const refusals = [
    [await request(token, null), seen, 'rtc_not_available'],
    [await request(token, 'wss://juan.example.org', { transports: ['wss', 'rtc'] }), seen, 'rtc_not_available'],
    [await request(token, 'wss://juan.example.org:8443'), seen, 'bad_public_url'],
    [await request(token, 'wss://srv.turbo-gol.com'), seen, 'bad_public_url'],
    [await request(token, 'wss://turbo-gol.com'), seen, 'bad_public_url'],
    [await request(token, 'wss://juan.example.org'), undefined, 'region_mismatch'],
    [await request(token, 'wss://juan.example.org'), { continent: '' }, 'region_mismatch'],
    [await request(token, 'wss://juan.example.org'), { continent: 'EU' }, 'region_mismatch'],
    [await request(token, 'wss://juan.example.org'), { continent: 'AN' }, 'region_mismatch'],
    [await request(token, 'wss://juan.example.org'), { continent: 'T1' }, 'region_mismatch'],
  ];
  for (const [req, where, code] of refusals) {
    const r = await reg.register(req, 0, where);
    assert.equal(r.code, code, `${req.publicUrl} from ${JSON.stringify(where)}`);
    assert.equal(reg.tokenList()[0].usedBy, null, 'the token is not spent');
  }
  // Port 443 said out loud is port 443; a name that only ends like the project's is not under it.
  const ok = await reg.register(await request(token, 'wss://juan.example.org:443'), 0, seen);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.node.seenContinent, 'SA', 'kept on the node');
  const t2 = (await reg.createToken(juan, 'SA', 0)).token;
  assert.ok((await reg.register(await request(t2, 'wss://turbo-gol.com.example.org'), 0, seen)).ok);
  // The project registers as before: a home PC, another port, no continent at all.
  const project = { id: 'project', name: 'Proyecto' };
  for (const [url, extra] of [[null, {}], ['wss://sp9.example.org:8443', {}], ['wss://a.turbo-gol.com', {}]]) {
    const t = (await reg.createToken(project, 'SA', 0)).token;
    const r = await reg.register(await request(t, url, extra), 0);
    assert.ok(r.ok, `${url}: ${JSON.stringify(r)}`);
    assert.equal(r.node.seenContinent, null, 'nobody said');
  }
  // Without the rules (the reference server, the tests): a community home PC still registers.
  const plain = new Registry({ log: quiet });
  const t3 = (await plain.createToken(juan, 'SA', 0)).token;
  assert.ok((await plain.register(await request(t3, null), 0)).ok);
});

/** A hello of `node` on `publicUrl` (validate.parseHello's shape). */
const hello = (publicUrl) => ({ bootId: 'b', build: BUILD, roles: ['host'], transports: ['wss'], publicUrl, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null });

test('a community node stays on port 443 of its pinned host at every hello, as at its registration; a project node moves', async () => {
  const reg = new Registry({ trustedOperators: ['project'], log: quiet, community: RULES });
  const { token } = await reg.createToken({ id: 'op1', name: 'Juan' }, 'SA', 0, undefined, { publicHost: 'juan.example.org' });
  const n = (await reg.register(await request(token, 'wss://juan.example.org'), 0, { continent: 'SA' })).node;
  for (const url of ['wss://juan.example.org:8443', 'wss://other.example.org']) {
    assert.equal(reg.addressAllowed(n, url), false, url);
    reg.connected(n.nodeId, hello(url), 1);
    assert.equal(reg.node(n.nodeId).publicUrl, 'wss://juan.example.org', `${url}: kept`);
  }
  assert.equal(reg.addressRefusal(n, 'wss://juan.example.org:8443'), 'a community server is on port 443 only');
  assert.equal(reg.addressAllowed(n, 'wss://juan.example.org:443'), true, '443 said out loud');
  const p = (await reg.createToken({ id: 'project', name: 'Proyecto' }, 'SA', 0, undefined, { publicHost: 'sp1.example.org' })).token;
  const sp = (await reg.register(await request(p, 'wss://sp1.example.org'), 0)).node;
  reg.connected(sp.nodeId, hello('wss://sp1.example.org:8443'), 1);
  assert.equal(reg.node(sp.nodeId).publicUrl, 'wss://sp1.example.org:8443', "the project's node, on its pinned host");
});

test('a community node name is its own in its region, whatever the case, and never a project node name', async () => {
  const reg = new Registry({ trustedOperators: ['project'], maxTrustedNodes: 8, log: quiet, community: RULES });
  const regNode = async (op, region, name, url) => {
    const { token } = await reg.createToken(op, region, 0, name);
    return reg.register(await request(token, url), 0, { continent: region });
  };
  const project = { id: 'project', name: 'Proyecto' };
  assert.ok((await regNode(project, 'SA', 'sao-paulo-1', 'wss://sp1.example.org')).ok);
  assert.ok((await regNode(project, 'SA', 'sao-paulo-1', 'wss://sp2.example.org')).ok, 'the project names its own nodes as it likes');
  assert.equal((await regNode({ id: 'op1', name: 'Juan' }, 'EU', 'SAO-PAULO-1', 'wss://j.example.org')).code, 'name_taken', 'a project name, in any region');
  const juan = await regNode({ id: 'op1', name: 'Juan' }, 'SA', 'juan-1', 'wss://j.example.org');
  assert.ok(juan.ok);
  assert.equal((await regNode({ id: 'op2', name: 'Ana' }, 'SA', 'JUAN-1', 'wss://a.example.org')).code, 'name_taken');
  assert.ok((await regNode({ id: 'op2', name: 'Ana' }, 'EU', 'juan-1', 'wss://a.example.org')).ok, 'another region');
  // The installer's --name is the one that counts, over the token's.
  const { token } = await reg.createToken({ id: 'op3', name: 'Eva' }, 'SA', 0, 'eva-1');
  assert.equal((await reg.register(await request(token, 'wss://e.example.org', { name: 'Juan-1' }), 0, { continent: 'SA' })).code, 'name_taken');
  assert.equal(reg.nameTaken('SA', 'JuAn-1'), true);
  reg.retire(juan.node.nodeId, 'gone', 1);
  assert.equal(reg.nameTaken('SA', 'juan-1'), false, 'a retired node gives its name back');
  // A node with no name gets its region and a number, unique whatever the case: a project node
  // elsewhere already holds the first one in capitals.
  assert.ok((await regNode(project, 'EU', 'AS-NODE-1', 'wss://sp3.example.org')).ok);
  const { token: t } = await reg.createToken({ id: 'op4', name: 'Leo' }, 'AS', 0);
  const n = await reg.register(await request(t, 'wss://l.example.org'), 0, { continent: 'AS' });
  assert.ok(n.ok, JSON.stringify(n));
  assert.equal(n.node.name, 'as-node-2');
});

test('a blocked operator registers nothing, its token kept; the project is never asked', async () => {
  const blocked = new Set(['op1', 'project']);
  const reg = new Registry({ trustedOperators: ['project'], log: quiet, community: RULES, operatorBlocked: (id) => blocked.has(id) });
  const { token } = await reg.createToken({ id: 'op1', name: 'Juan' }, 'SA', 0);
  assert.equal((await reg.register(await request(token, 'wss://j.example.org'), 0, { continent: 'SA' })).code, 'operator_blocked');
  blocked.delete('op1');
  assert.ok((await reg.register(await request(token, 'wss://j.example.org'), 0, { continent: 'SA' })).ok);
  const p = (await reg.createToken({ id: 'project', name: 'Proyecto' }, 'SA', 0)).token;
  assert.ok((await reg.register(await request(p, 'wss://sp.example.org'), 0)).ok);
});

test("a community node is never registered behind Cloudflare's proxy (Annex B, point 6): asked last, a failed lookup refuses too, the token kept either way; the project is never asked", async () => {
  const answers = new Map([['proxied.example.org', true], ['direct.example.org', false], ['broken.example.org', null]]);
  const asked = [];
  const reg = new Registry({
    trustedOperators: ['project'],
    log: quiet,
    community: { ...RULES, behindProxy: async (host) => (asked.push(host), answers.has(host) ? answers.get(host) : false) },
  });
  const { token } = await reg.createToken({ id: 'op1', name: 'Juan' }, 'SA', 0);
  const seen = { continent: 'SA' };
  const proxied = await reg.register(await request(token, 'wss://proxied.example.org'), 0, seen);
  assert.deepEqual([proxied.ok, proxied.code], [false, 'behind_proxy']);
  assert.match(proxied.message, /resolves to Cloudflare's proxy: a community server is reached by its players directly\. Set its DNS record to 'DNS only'/);
  const broken = await reg.register(await request(token, 'wss://broken.example.org'), 0, seen);
  assert.deepEqual([broken.ok, broken.code], [false, 'dns_unavailable']);
  assert.match(broken.message, /the token was not used/);
  assert.equal(reg.tokenList()[0].usedBy, null, 'the token is not spent');
  // The other rules come first: a lookup is never asked for what they refuse.
  asked.length = 0;
  assert.equal((await reg.register(await request(token, 'wss://proxied.example.org:8443'), 0, seen)).code, 'bad_public_url');
  assert.equal((await reg.register(await request(token, 'wss://proxied.example.org'), 0, { continent: 'EU' })).code, 'region_mismatch');
  assert.deepEqual(asked, []);
  const ok = await reg.register(await request(token, 'wss://direct.example.org'), 0, seen);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(asked, ['direct.example.org']);
  // The project's servers may sit behind the proxy: never asked.
  const p = (await reg.createToken({ id: 'project', name: 'Proyecto' }, 'SA', 0)).token;
  assert.ok((await reg.register(await request(p, 'wss://proxied.example.org'), 0)).ok);
  assert.deepEqual(asked, ['direct.example.org']);
});

test("a purged operator's records go under an opaque key with no name: its nodes (banned, retired, pending), its tokens and its ledger, its points kept with them", async () => {
  const written = { nodes: [], tokens: [] };
  const store = { node: (n) => written.nodes.push({ ...n }), register: () => undefined, tokens: (ts) => written.tokens.push(...ts.map((t) => ({ ...t }))), dropTokens: () => undefined };
  const reg = new Registry({ trustedOperators: ['project'], log: quiet, store });
  const juan = { id: 'op1', name: 'Juan' };
  const nodes = [];
  for (const status of ['active', 'banned', 'pending']) {
    const { token } = await reg.createToken(juan, 'SA', 0);
    const n = (await reg.register(await request(token, 'wss://j.example.org'), 0)).node;
    n.status = status;
    nodes.push(n);
  }
  reg.retire(nodes[2].nodeId, 'gone', 1);
  await reg.createToken(juan, 'SA', 0); // unused
  const ana = (await reg.register(await request((await reg.createToken({ id: 'op2', name: 'Ana' }, 'SA', 0)).token, 'wss://a.example.org'), 0)).node;
  const ledger = new Ledger({ playerRepeat: true });
  // Juan's own node, Juan playing on it too; Juan playing on Ana's.
  ledger.record(credit('op1', NOON, [player('a'), player('b'), { ...player('x'), playerId: 'op1' }], { nodeId: nodes[0].nodeId }), 1);
  ledger.record(credit('op2', NOON, [player('c'), { ...player('x'), playerId: 'op1' }], { nodeId: ana.nodeId }), 1);
  const before = { earned: ledger.earned('op1'), verified: ledger.verifiedMatches('op1'), d30: ledger.summary('op1', NOON).points30d };
  assert.ok(before.earned > 0);
  written.nodes.length = 0;
  written.tokens.length = 0;
  const alias = R.DELETED_OPERATOR_PREFIX + 'abcdef012345';
  assert.equal(reg.forgetOperator('op1', alias), 3);
  ledger.forgetOperator('op1', alias);
  assert.equal(R.isDeletedOperator(alias), true);
  assert.equal(R.isDeletedOperator('op1'), false);
  // Every node of it, its status and counters as they were, under the alias, with no name; written.
  assert.deepEqual(reg.byOperator('op1'), []);
  assert.deepEqual(reg.byOperator(alias).map((n) => [n.status, n.operatorName, R.isRetired(n)]), [['active', '', false], ['banned', '', false], ['pending', '', true]]);
  assert.deepEqual(written.nodes.map((n) => [n.operatorId, n.operatorName]), [[alias, ''], [alias, ''], [alias, '']]);
  assert.ok(reg.tokenList().filter((t) => t.operatorId !== 'op2').every((t) => t.operatorId === alias && t.operatorName === ''));
  assert.equal(written.tokens.length, 4);
  assert.equal(reg.node(ana.nodeId).operatorId, 'op2', "another operator's untouched");
  // Its points stay with its nodes, under the alias; nothing of the ledger keeps its id but its seat on Ana's node.
  assert.deepEqual({ earned: ledger.earned(alias), verified: ledger.verifiedMatches(alias), d30: ledger.summary(alias, NOON).points30d }, before);
  assert.deepEqual([ledger.earned('op1'), ledger.summary('op1', NOON).matches30d], [0, 0]);
  assert.deepEqual(ledger.leaderboard(NOON).map((e) => e.operatorId).sort(), [alias, 'op2'].sort());
  const mine = ledger.recent(NOON).find((e) => e.operatorId === alias);
  assert.deepEqual(mine.players.map((p) => p.playerId).filter((id) => id === 'op1' || id === alias), [alias], 'its own seat too');
  assert.ok(ledger.recent(NOON).find((e) => e.operatorId === 'op2').players.some((p) => p.playerId === 'op1'), "a player's seat on another's node stays");
  // The repeat decay follows: the same group again on its nodes is still decayed.
  const again = ledger.record(credit(alias, NOON + 1, [player('a'), player('b')], { nodeId: nodes[0].nodeId }), 1);
  assert.ok(again.repeat < 1, JSON.stringify(again));
  // A second call finds nothing under the id.
  assert.equal(reg.forgetOperator('op1', R.DELETED_OPERATOR_PREFIX + 'ffffffffffff'), 0);
});

test("a project account's records take its account's name as it is now (the public list's fallback is never a name it left): nodes and tokens, only what differs written, another's untouched", async () => {
  const written = { nodes: [], tokens: [] };
  const store = { node: (n) => written.nodes.push({ ...n }), register: () => undefined, tokens: (ts) => written.tokens.push(...ts.map((t) => ({ ...t }))), dropTokens: () => undefined };
  const reg = new Registry({ trustedOperators: ['project'], log: quiet, store });
  const project = { id: 'project', name: 'Turbogol' };
  const n = (await reg.register(await request((await reg.createToken(project, 'SA', 0)).token, 'wss://p.example.org'), 0)).node;
  await reg.createToken(project, 'SA', 0); // unused
  const ana = (await reg.register(await request((await reg.createToken({ id: 'op2', name: 'Ana' }, 'SA', 0)).token, 'wss://a.example.org'), 0)).node;
  written.nodes.length = 0;
  written.tokens.length = 0;
  assert.equal(reg.renameOperator('project', 'TurbogolOficial'), 3);
  assert.equal(reg.node(n.nodeId).operatorName, 'TurbogolOficial');
  assert.deepEqual(written.nodes.map((x) => [x.nodeId, x.operatorName]), [[n.nodeId, 'TurbogolOficial']]);
  assert.ok(reg.tokenList().filter((t) => t.operatorId === 'project').every((t) => t.operatorName === 'TurbogolOficial'));
  assert.equal(written.tokens.length, 2);
  assert.equal(reg.node(ana.nodeId).operatorName, 'Ana');
  // The same name again: nothing written.
  assert.equal(reg.renameOperator('project', 'TurbogolOficial'), 0);
  assert.deepEqual([written.nodes.length, written.tokens.length], [1, 2]);
  // The public list without the name of now: the one its records took.
  const cp = { registry: reg, ledger: new Ledger(), currentBuild: BUILD, sameBuildAs: () => true };
  reg.node(n.nodeId).status = 'active';
  assert.deepEqual(publicStatus(cp, NOON, { current: () => undefined }).nodes.map((x) => x.operator), ['TurbogolOficial'], "Ana's is pending: not listed");
});

test('rows of before load with no continent and no refusal; a refusal is counted and written', async () => {
  const reg = new Registry({ log: quiet });
  const { token } = await reg.createToken({ id: 'op1', name: 'Juan' }, 'SA', 0);
  const n = (await reg.register(await request(token, 'wss://j.example.org'), 0)).node;
  const row = nodeToRow(n);
  const old = JSON.parse(row.data);
  delete old.seenContinent;
  delete old.counters.refused;
  const back = nodeFromRow({ ...row, data: JSON.stringify(old) }, new Set());
  assert.deepEqual([back.seenContinent, back.counters.refused], [null, 0]);
  reg.onRefused(n.nodeId);
  reg.onRefused(n.nodeId);
  assert.equal(JSON.parse(nodeToRow(reg.node(n.nodeId)).data).counters.refused, 2);
});

test('ranked only on a project node while communityRanked is false: a community node is out by rule, never for load', () => {
  const node = (trusted) => ({ ...{ nodeId: 'n', operatorId: trusted ? 'project' : 'op1', trusted, roles: ['host'], transports: ['wss'], publicUrl: 'wss://x.example.org', reachableAt: 1, rtcReady: false }, online: true, lastSeen: 0, status: 'active', build: BUILD, draining: false, active: 0, capacity: CAP, egressCapGB: null, egressGB: 0, region: 'SA', retiredAt: null });
  const req = { region: 'SA', mode: '1v1', ranked: true, playerIds: ['x'], build: BUILD, transports: ['wss'], now: 0 };
  assert.equal(ineligibility(node(false), { ...req, communityRanked: false }), 'community_ranked');
  assert.equal(ineligibility(node(true), { ...req, communityRanked: false }), null);
  assert.equal(ineligibility(node(false), req), null, 'no policy: as before');
  assert.equal(ineligibility(node(false), { ...req, ranked: false, communityRanked: false }), null, 'Casual stays');
});

// ---- the control plane: CommunityPolicy -------------------------------------------------------------

/**
 * A control plane with `specs` nodes, each logged in on a fake link, said hello and proven reachable
 * (spec: op, capacity, status). `policy`: its community policy (lines about community nodes go to
 * `community`, the rest to `team`). A node answers 'assign' with its URL, as a real one refuses it
 * ('full') once it took as many as it declares, refuses it while `refuse` is true, drops its link
 * while it is 'drop', and while it is 'flip' says it drains just for its refusal (a modified node).
 */
async function world(specs, policy) {
  let clock = 1_800_000_000_000;
  const ctl = await generateEd25519();
  const keys = new Map();
  const team = [];
  const community = [];
  const registry = new Registry({ allowInsecure: true, trustedOperators: ['project'], log: (m) => team.push(m) });
  const cp = new ControlPlane({
    controlPrivateKey: ctl.privateKey,
    controlPublicKey: ctl.publicKey,
    controlUrl: 'ws://cp/nodes/connect',
    httpBase: 'http://cp',
    build: () => BUILD,
    channel: () => ({ stable: BUILD.version, minimum: '0.0.0' }),
    registry,
    ledger: new Ledger(),
    replays: { put: async () => undefined, get: async () => null },
    // A probation node's matches can be verified (placement asks): nothing is verified here.
    inlineVerify: async () => ({ ok: true, code: 'ok' }),
    fetchJson: async (url) => {
      const u = new URL(url);
      const k = keys.get(u.host);
      return { nodeId: k.nodeId, sig: await sign(k.key, reachMessage(k.nodeId, u.searchParams.get('nonce'))) };
    },
    now: () => clock,
    log: (m) => team.push(m),
    ...(policy ? { community: { ...policy, log: (m) => community.push(m) } } : {}),
  });
  const nodes = [];
  for (const [i, s] of specs.entries()) {
    const k = await generateEd25519();
    const key = await importPrivateKey(k.privateKey);
    const host = `n${i}.example.org:7350`;
    const publicUrl = `ws://${host}`;
    const capacity = { ...CAP, matches: s.capacity ?? 4 };
    const { token } = await registry.createToken({ id: s.op ?? 'op1', name: 'Op' }, 'SA', clock);
    const r = await registry.register({ token, publicKey: k.publicKey, roles: ['host'], publicUrl, build: BUILD, specs: SPECS, capacity }, clock);
    assert.ok(r.ok, JSON.stringify(r));
    const nodeId = r.node.nodeId;
    keys.set(host, { nodeId, key });
    const node = { nodeId, refuse: false, session: null, taken: 0 };
    const reply = (m) => cp.onMessage(node.session, JSON.stringify(m));
    const later = (m) => setTimeout(() => void reply(m), 0);
    const beat = (draining = false) => ({ active: 0, capacity: capacity.matches, draining, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [] });
    node.beat = () => reply({ t: 'heartbeat', data: beat() });
    node.session = cp.open({
      send(m) {
        if (m.t === 'challenge') void sign(key, authMessage(nodeId, m.nonce)).then((sig) => later({ t: 'auth', nodeId, sig }));
        if (m.t === 'welcome')
          setTimeout(async () => {
            await reply({ t: 'hello', data: { bootId: 'b', build: BUILD, roles: ['host'], transports: ['wss'], publicUrl, rtcReady: false, specs: SPECS, capacity, draining: false, egressCapGB: null } });
            await reply({ t: 'heartbeat', data: beat() });
          }, 0);
        if (m.t === 'assign') {
          if (node.refuse === 'drop') return cp.onClose(node.session);
          if (node.refuse === 'flip') {
            later({ t: 'heartbeat', data: beat(true) });
            later({ t: 'reply', rid: m.rid, ok: false, code: 'draining' });
            return later({ t: 'heartbeat', data: beat() });
          }
          if (node.refuse || node.taken >= capacity.matches) return later({ t: 'reply', rid: m.rid, ok: false, code: node.refuse ? 'busy' : 'full' });
          node.taken++;
          later({ t: 'reply', rid: m.rid, ok: true, data: { wsUrl: `${publicUrl}/m/${m.match.matchId}` } });
        }
      },
      close() {},
    });
    await wait(() => ['probation', 'active'].includes(registry.node(nodeId).status), 'reachable');
    if (s.status) registry.setStatus(nodeId, s.status, null);
    nodes.push(node);
  }
  let k = 0;
  const place = (extra = {}) => cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [{ playerId: (++k).toString(16).padStart(16, 'b'), name: 'P' + k, account: true, accountAgeDays: 30 }], matchLengthSeconds: 10, ...extra });
  const advance = (ms) => {
    clock += ms;
    for (const n of nodes) if (!n.session.closed) void n.beat();
  };
  return { cp, registry, nodes, team, community, place, advance, now: () => clock };
}

test('effective capacity: a community node gets at most 4 matches on probation and 16 active, whatever it declares; the project node all it declares', async () => {
  const w = await world([{ capacity: 200 }, { op: 'project', capacity: 200 }], { ...COMMUNITY_POLICY, ranked: false });
  const [juan, project] = w.nodes.map((n) => w.registry.node(n.nodeId));
  assert.deepEqual([juan.status, w.cp.effectiveCapacity(juan), w.cp.effectiveCapacity(project)], ['probation', C.PROBATION_CAPACITY_MAX, 200]);
  w.registry.setStatus(juan.nodeId, 'active', null);
  assert.equal(w.cp.effectiveCapacity(juan), C.COMMUNITY_CAPACITY_MAX);
  assert.deepEqual([C.PROBATION_CAPACITY_MAX, C.COMMUNITY_CAPACITY_MAX, C.OPERATOR_MATCHES_MAX], [4, 16, 32]);
  // The region's slots and supply count 16 for it, not 200: declaring more lowers nobody's factor.
  assert.equal(w.cp.regionView('SA').slots, 16 + 200);
  w.registry.retire(project.nodeId, 'out of this check', w.now());
  assert.equal(w.cp.regionFactorAt('SA'), 0.56, '0.5 + 1 / 16');
  // Its capacityMax floor stays capped too: declaring 200 once and 2 now is still 16 of supply.
  await w.cp.onMessage(w.nodes[0].session, JSON.stringify({ t: 'hello', data: { bootId: 'b2', build: BUILD, roles: ['host'], transports: ['wss'], publicUrl: juan.publicUrl, rtcReady: false, specs: SPECS, capacity: { ...CAP, matches: 2 }, draining: false, egressCapGB: null } }));
  assert.deepEqual([juan.capacity.matches, juan.capacityMax, w.cp.regionFactorAt('SA')], [2, 200, 0.56]);
  // On probation it offers 4.
  const p = await world([{ capacity: 200 }], { ...COMMUNITY_POLICY, ranked: false });
  assert.deepEqual([p.cp.regionView('SA').slots, p.cp.regionFactorAt('SA')], [4, 0.75], '0.5 + 1 / 4');
  // Without the policy: as before, the 200 it declared.
  const plain = await world([{ capacity: 200, status: 'active' }]);
  assert.equal(plain.cp.effectiveCapacity(plain.registry.node(plain.nodes[0].nodeId)), 200);
  assert.ok(plain.cp.regionFactorAt('SA') < 0.52);
});

test('placement: a full community node by its effective capacity; its operator at OPERATOR_MATCHES_MAX; the project node never capped', async () => {
  // Under the default OPERATOR_MATCHES_MAX (32, far above): each node full at its own cap, whatever it declares.
  const capped = { ...COMMUNITY_POLICY, ranked: false, activeCapacity: 3 };
  const w = await world([{ capacity: 200 }], capped);
  for (let i = 0; i < 4; i++) assert.equal((await w.place())?.nodeId, w.nodes[0].nodeId, `match ${i + 1} on probation`);
  assert.equal(await w.place(), null, 'the fifth: full at 4 on probation');
  const act = await world([{ capacity: 200, status: 'active' }, { capacity: 200, status: 'active' }], capped);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await act.place())?.nodeId ?? null);
  assert.deepEqual(
    act.nodes.map((n) => ids.filter((id) => id === n.nodeId).length),
    [3, 3],
    'three each',
  );
  assert.equal(ids[6], null, 'the seventh: both full');
  // Two active nodes of one operator, 3 each: 4 matches at a time in all.
  const policy = { ...capped, operatorMatches: 4 };
  const two = await world([{ capacity: 200, status: 'active' }, { capacity: 200, status: 'active' }, { op: 'project', capacity: 1 }], policy);
  const on = [];
  for (let i = 0; i < 5; i++) on.push((await two.place())?.nodeId);
  assert.equal(on.filter((id) => id === two.nodes[0].nodeId || id === two.nodes[1].nodeId).length, 4, 'four on the operator');
  assert.equal(on.filter((id) => id === two.nodes[2].nodeId).length, 1, 'the rest on the project node');
  assert.equal(two.cp.operatorRunning('op1'), 4);
  assert.equal(await two.place(), null, 'the project node is full at the 1 it declares, the operator at its 4');
});

test('a burst of placements at once never passes a community node or operator cap, and the ones not sent are no refusals', async () => {
  // The hub forms each Casual group without waiting for the last: place() calls overlap.
  const burst = async (w, n) => (await Promise.all(Array.from({ length: n }, () => w.place()))).map((p) => p?.nodeId ?? null);
  const policy = { ...COMMUNITY_POLICY, ranked: false };
  // An honest node on probation that declares its 4: it refuses a fifth as full, so none may be sent.
  const w = await world([{ capacity: 4 }], policy);
  const [id] = w.nodes.map((n) => n.nodeId);
  const got = await burst(w, 8);
  assert.deepEqual([got.filter(Boolean).length, w.nodes[0].taken], [4, 4], 'four sent, four taken');
  assert.deepEqual([w.registry.node(id).counters.refused, w.cp.refusalsOf(id)], [0, { recent: 0, of: 4, outUntil: null }]);
  assert.equal(await w.place(), null, 'still full');
  assert.equal(w.cp.regionView('SA').active, 4);
  // Two nodes of one operator: OPERATOR_MATCHES_MAX over both.
  const two = await world([{ capacity: 200, status: 'active' }, { capacity: 200, status: 'active' }], { ...policy, operatorMatches: 5 });
  assert.equal((await burst(two, 12)).filter(Boolean).length, 5);
  assert.equal(two.cp.operatorRunning('op1'), 5);
  // A project node is placed as before: what it declares (its own refusal of the third), never counted.
  const p = await world([{ op: 'project', capacity: 2 }], policy);
  assert.equal((await burst(p, 3)).filter(Boolean).length, 2);
  assert.equal(p.registry.node(p.nodes[0].nodeId).counters.refused, 0);
});

test('ranked: never on a community node under the policy, also when it is the only one; regionView agrees', async () => {
  const w = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false });
  const players = [human('a'), human('b')];
  assert.equal(await w.place({ ranked: true, humans: players }), null);
  assert.equal(w.cp.regionView('SA').rankedReady, false);
  assert.ok(await w.place(), 'Casual goes on');
  const project = await world([{ op: 'project' }], { ...COMMUNITY_POLICY, ranked: false });
  assert.ok(await project.place({ ranked: true, humans: players }), "the project's");
  assert.equal(project.cp.regionView('SA').rankedReady, true);
  const allowed = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: true });
  assert.ok(await allowed.place({ ranked: true, humans: players }), 'NODE_COMMUNITY_RANKED=1');
});

test('refusals: 3 unexcused among its last 10 assignments take a community node out for an hour, counted and alerted on the community log only; excused only as it was at the send', async () => {
  const w = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false });
  const [n] = w.nodes;
  const rec = () => w.registry.node(n.nodeId);
  n.refuse = true;
  assert.equal(await w.place(), null);
  assert.equal(await w.place(), null);
  n.refuse = false;
  assert.ok(await w.place(), 'it takes one');
  assert.deepEqual(w.cp.refusalsOf(n.nodeId), { recent: 2, of: 3, outUntil: null });
  n.refuse = true;
  assert.equal(await w.place(), null);
  assert.equal(rec().counters.refused, 3);
  assert.equal(w.cp.refusalsOf(n.nodeId).outUntil, w.now() + C.REFUSAL_OUT_MS);
  assert.ok(w.community.some((l) => /^ALERT node .* refused 3 of its last 4 assignments with no reason: out of placement for 60 min$/.test(l)), w.community.join('\n'));
  assert.ok(!w.team.some((l) => l.includes('out of placement')), "never on the team's log");
  n.refuse = false;
  assert.equal(await w.place(), null, 'out, even taking matches again');
  w.advance(C.REFUSAL_OUT_MS + 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(await w.place(), 'back after the hour');
  // What a node says while the assign is out excuses nothing: draining just for its refusal (a
  // heartbeat before it, another after), or its link dropped with the assign out.
  const f = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false });
  const [fid] = f.nodes.map((x) => x.nodeId);
  f.nodes[0].refuse = 'flip';
  for (let i = 0; i < 3; i++) {
    assert.equal(await f.place(), null);
    await new Promise((r) => setTimeout(r, 0)); // its "not draining" heartbeat
    assert.equal(f.registry.node(fid).draining, false);
  }
  assert.deepEqual([f.registry.node(fid).counters.refused, f.cp.refusalsOf(fid).outUntil], [3, f.now() + C.REFUSAL_OUT_MS]);
  f.nodes[0].refuse = false;
  assert.equal(await f.place(), null, 'out for the hour');
  const d = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false });
  d.nodes[0].refuse = 'drop';
  assert.equal(await d.place(), null);
  assert.equal(d.registry.node(d.nodes[0].nodeId).counters.refused, 1, 'a dropped link counts');
  // Draining as the control plane saw it when the assign went out (its heartbeat before): no new
  // match goes there at all, so nothing is sent and nothing counted.
  const e = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false });
  await e.cp.onMessage(e.nodes[0].session, JSON.stringify({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: true, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [] } }));
  assert.equal(await e.place(), null);
  assert.deepEqual([e.nodes[0].taken, e.registry.node(e.nodes[0].nodeId).counters.refused], [0, 0]);
  // A project node's refusals never count; without the policy nobody's do.
  const p = await world([{ op: 'project' }], { ...COMMUNITY_POLICY, ranked: false });
  const plain = await world([{ status: 'active' }]);
  for (const x of [p, plain]) {
    x.nodes[0].refuse = true;
    for (let i = 0; i < 4; i++) assert.equal(await x.place(), null);
    assert.equal(x.registry.node(x.nodes[0].nodeId).counters.refused, 0);
    x.nodes[0].refuse = false;
    assert.ok(await x.place());
  }
});

test('a blocked operator: none of its nodes is placed', async () => {
  const blocked = new Set();
  const w = await world([{ status: 'active' }], { ...COMMUNITY_POLICY, ranked: false, blocked: (id) => blocked.has(id) });
  assert.ok(await w.place());
  blocked.add('op1');
  assert.equal(await w.place(), null);
});

/** A match waiting for its verification, as the queue holds it (only what pump and the brake read). */
const queued = (id, over = {}) => ({ assign: { matchId: id.padStart(64, '0'), region: 'SA', ranked: false }, nodeId: 'x', state: 'verifying', build: BUILD, queuedAt: 0, verifyRate: 1, inFlight: false, lastTry: 0, ...over });

test('the verification queue: ranked first, then probation samples, then the 20 % ones, the oldest first; past 20 or 10 minutes it brakes placement on community nodes on probation of its build', async () => {
  const w = await world([{}, { status: 'active' }, { op: 'project' }], { ...COMMUNITY_POLICY, ranked: false });
  const now = w.now();
  const order = [];
  w.cp.tryVerify = async (m) => void order.push(m.assign.matchId.replace(/^0+/, ''));
  for (const [id, over] of [['1', { verifyRate: 0.2, queuedAt: now - 5 }], ['2', { queuedAt: now - 4 }], ['3', { assign: { matchId: '3'.padStart(64, '0'), region: 'SA', ranked: true }, queuedAt: now - 3 }], ['4', { verifyRate: 0.2, queuedAt: now - 9 }], ['5', { queuedAt: now - 1 }]]) w.cp.matches.set(id, queued(id, over));
  w.cp.pump(true);
  assert.deepEqual(order, ['3', '2', '5', '4', '1']);
  // The brake: none of these is past it; 21 waiting, or the oldest 11 minutes old, are.
  assert.equal(w.cp.verifyBraked(BUILD), false);
  for (let i = 10; i < 26; i++) w.cp.matches.set(String(i), queued(String(i), { queuedAt: now }));
  assert.equal(w.cp.verifyBraked(BUILD), true);
  const [probation, active, project] = w.nodes.map((n) => n.nodeId);
  const got = [];
  for (let i = 0; i < 6; i++) got.push((await w.place())?.nodeId);
  assert.ok(!got.includes(probation), 'none on the community node on probation');
  assert.ok(got.includes(active) && got.includes(project), 'the active one and the project one go on');
  const old = await world([{}], { ...COMMUNITY_POLICY, ranked: false });
  old.cp.matches.set('9', queued('9', { queuedAt: old.now() - C.VERIFY_BRAKE_AGE_MS - 1 }));
  assert.equal(old.cp.verifyBraked(BUILD), true);
  assert.equal(await old.place(), null);
  assert.equal(old.cp.verifyBraked({ ...BUILD, version: '0.0.9' }), false, 'another build is not braked');
  const plain = await world([{}]);
  plain.cp.matches.set('9', queued('9', { queuedAt: plain.now() - C.VERIFY_BRAKE_AGE_MS - 1 }));
  assert.ok(await plain.place(), 'without the policy, no brake');
});

test('a lone player against bots earns its community host 0 points, recorded; a ranked match settled void credits nothing', async () => {
  const policy = { ...COMMUNITY_POLICY, ranked: true };
  const env = await setup({ community: policy });
  const solo = await env.finish(await env.place([human('a')]));
  assert.equal(solo.entry.outcome.kind, 'unrated');
  assert.deepEqual([solo.entry.ledger.points, solo.entry.ledger.soloBots, countsAsHosted(solo.entry.ledger)], [0, true, false]);
  const pair = await env.finish(await env.place([human('b'), human('c')]));
  assert.ok(pair.entry.ledger.points > 0, 'two players earn');
  // Ranked on a community node (NODE_COMMUNITY_RANKED=1 here), every human gone: void, and no ledger entry.
  const ranked = await setup({ status: 'active', community: policy });
  const r = await ranked.finish(await ranked.place([human('d'), human('e')], { ranked: true }));
  assert.equal(r.entry.outcome.kind, 'void');
  assert.equal(r.entry.ledger, null, 'a void credits nothing');
  await wait(() => ranked.outcomes.length > 0);
});

// ---- the ledger: the daily cap and each player's own decay ---------------------------------------

const DAY = 24 * 60 * 60_000;
const NOON = Date.UTC(2026, 10, 20, 12);
const player = (id, minutes = 10) => ({ playerId: id.repeat(16), connectedMs: minutes * 60_000, account: true, accountAgeDays: 30 });
const credit = (op, at, players, extra = {}) => ({ matchId: String(at).padStart(64, '0'), nodeId: 'n1', operatorId: op, region: 'SA', mode: '2v2', ranked: false, verified: true, endReason: 'rules', players, tickLagP99Ms: 2, underrunRate: 0, at, ...extra });

test('the daily cap: an operator earns at most that much a UTC day, the rest recorded as 0; it holds through a restart and starts again the next day', () => {
  const L = new Ledger({ dailyCap: 30 });
  assert.equal(L.capPerDay(), 30);
  assert.equal(L.record(credit('op1', NOON, [player('a'), player('b')]), 1).points, 20);
  const over = L.record(credit('op1', NOON + 1, [player('c'), player('d')]), 1);
  assert.deepEqual([over.points, over.capped], [10, 10]);
  const nothing = L.record(credit('op1', NOON + 2, [player('e'), player('f')]), 1);
  assert.deepEqual([nothing.points, nothing.capped, countsAsHosted(nothing)], [0, 20, false]);
  assert.equal(L.pointsToday('op1', NOON + 3), 30);
  assert.equal(L.record(credit('op2', NOON + 3, [player('g'), player('h')]), 1).points, 20, 'per operator');
  const back = new Ledger({ dailyCap: 30 });
  back.restore({ entries: L.recent(NOON + 4), notes: [], totals: [] }, NOON + 4);
  assert.equal(back.record(credit('op1', NOON + 5, [player('i'), player('j')]), 1).points, 0, 'through a deploy');
  assert.equal(back.record(credit('op1', NOON + DAY, [player('k'), player('l')]), 1).points, 20, 'the next day');
  assert.equal(new Ledger().capPerDay(), null, 'none by default');
});

test("each player's own decay: an alternate account in a new pair still decays, its unsampled matches count, and a restart rebuilds it", () => {
  const L = new Ledger({ playerRepeat: true });
  const plain = new Ledger();
  for (const l of [L, plain]) l.record(credit('op1', NOON, [player('a'), player('b')]), 1);
  // A again, with a new partner: the exact group is new, A's own second match weighs 1/2.
  assert.equal(plain.record(credit('op1', NOON + 1, [player('a'), player('c')]), 1).points, 20);
  assert.equal(L.record(credit('op1', NOON + 1, [player('a'), player('c')]), 1).points, 15);
  L.noteGroup('op1', ['a'.repeat(16), 'e'.repeat(16)], NOON + 2); // an unsampled match
  assert.equal(L.record(credit('op1', NOON + 3, [player('a'), player('f')]), 1).points, 12.5, 'its fourth match in a day: 1/4');
  // The operator's own minutes never count, and another operator's decay is its own.
  assert.equal(L.record(credit('op2', NOON + 4, [player('a'), player('g')]), 1).points, 20);
  const back = new Ledger({ playerRepeat: true });
  back.restore({ entries: L.recent(NOON + 5), notes: [{ operatorId: 'op1', playerIds: ['a'.repeat(16), 'e'.repeat(16)], at: NOON + 2 }], totals: [] }, NOON + 5);
  assert.equal(back.record(credit('op1', NOON + 6, [player('a'), player('h')]), 1).points, 12, 'the same 1/5 after the restart');
  assert.equal(L.record(credit('op1', NOON + DAY + 10, [player('a'), player('i')]), 1).points, 20, 'gone after 24 h');
});

test('a lone player against bots: recorded, 0 points; concentration: the share of the 3 accounts that played most', () => {
  const L = new Ledger();
  const solo = L.record(credit('op1', NOON, [player('a')], { soloBots: true }), 1);
  assert.deepEqual([solo.points, countsAsHosted(solo), L.summary('op1', NOON).matches30d], [0, false, 1]);
  const C2 = new Ledger();
  C2.record(credit('op1', NOON, [player('a', 30), player('b', 20)]), 1);
  C2.record(credit('op1', NOON + 1, [player('c', 10), player('d', 5)]), 1);
  assert.deepEqual(C2.concentration('op1', NOON + 2), { share: 0.923, players: 4 });
  assert.deepEqual(C2.concentration('op9', NOON + 2), { share: 0, players: 0 });
});

// ---- the public list: the opt-in --------------------------------------------------------------------

test('the public list names an operator outside the project only when it chose to, in the nodes and the hosts', async () => {
  const reg = new Registry({ trustedOperators: ['project'], log: quiet });
  const regNode = async (op) => {
    const { token } = await reg.createToken(op, 'SA', 0);
    const r = await reg.register(await request(token, 'wss://x.example.org'), 0);
    r.node.status = 'active';
    return r.node;
  };
  await regNode({ id: 'op1', name: 'Juan' });
  await regNode({ id: 'op2', name: 'Anfitrión' });
  const ledger = new Ledger();
  ledger.record(credit('op1', NOON, [player('a'), player('b')]), 1);
  const cp = { registry: reg, ledger, currentBuild: BUILD, sameBuildAs: () => true };
  const shows = (id) => id === 'op1' || id === 'op2';
  // The accounts' names as they are now (the NodeRegistryDO asks AccountsDO for them).
  const current = (id) => ({ op1: 'Juan', op2: 'Anfitrión' })[id];
  assert.deepEqual(publicStatus(cp, NOON).nodes.map((n) => n.operator), ['Anfitrión 1', 'Anfitrión 2']);
  const s = publicStatus(cp, NOON, { shows, current });
  assert.deepEqual(s.nodes.map((n) => n.operator), ['Juan', 'Anfitrión 2'], 'a name that is the label itself gets its number, the one it had');
  assert.deepEqual(s.hosts, [{ name: 'Juan', points: 20 }]);
  assert.equal(publicOperatorNames(reg.list(), () => false, [], shows, current)('op1'), 'Juan');
  // Never the name its records kept: without the account's name of now, its number.
  assert.deepEqual(publicStatus(cp, NOON, { shows }).nodes.map((n) => n.operator), ['Anfitrión 1', 'Anfitrión 2']);
});

test('the public list follows the host: its name as it is now (a rename, never the old name someone else may take), its switch, a block of the host; a number that stays with its operator', async () => {
  const reg = new Registry({ trustedOperators: ['project'], log: quiet });
  const regNode = async (op, status = 'active') => {
    const { token } = await reg.createToken(op, 'SA', 0);
    const r = await reg.register(await request(token, 'wss://x.example.org'), 0);
    r.node.status = status;
    return r.node;
  };
  await regNode({ id: 'op1', name: 'Juan' });
  await regNode({ id: 'project', name: 'Proyecto' });
  await regNode({ id: 'op2', name: 'Ana' });
  await regNode({ id: 'op3', name: 'Beto' });
  const ledger = new Ledger();
  ledger.record(credit('op3', NOON, [player('a'), player('b')]), 1);
  const cp = { registry: reg, ledger, currentBuild: BUILD, sameBuildAs: () => true };
  let showing = new Set(['op1', 'op3']);
  let names = { op1: 'Juan', op2: 'Ana', op3: 'Beto', project: 'Proyecto' };
  const blocked = new Set();
  const list = () => {
    const s = publicStatus(cp, NOON, { shows: (id) => showing.has(id), current: (id) => names[id], blocked: (id) => blocked.has(id) });
    return { nodes: s.nodes.map((n) => n.operator), hosts: s.hosts.map((h) => h.name) };
  };
  assert.deepEqual(list(), { nodes: ['Juan', 'Proyecto', 'Anfitrión 2', 'Beto'], hosts: ['Beto'] });
  // Juan renames his account to Juanito and Pedro takes "Juan": the list says Juanito, never Juan.
  names = { ...names, op1: 'Juanito', pedro: 'Juan' };
  assert.deepEqual(list().nodes, ['Juanito', 'Proyecto', 'Anfitrión 2', 'Beto']);
  // The account's name not known (AccountsDO did not answer): a number, never the record's "Juan".
  names = { ...names, op1: undefined };
  assert.deepEqual(list().nodes, ['Anfitrión 1', 'Proyecto', 'Anfitrión 2', 'Beto']);
  // A project account goes by its name of now too, by its record's when it is not known.
  names = { ...names, op1: 'Juanito', project: 'Turbogol' };
  assert.deepEqual(list().nodes, ['Juanito', 'Turbogol', 'Anfitrión 2', 'Beto']);
  names = { ...names, project: undefined };
  assert.equal(list().nodes[1], 'Proyecto');
  // Beto turns the switch off: his number, in the nodes and in the ranking; Ana's stays 2 throughout.
  showing = new Set(['op1']);
  assert.deepEqual(list(), { nodes: ['Juanito', 'Proyecto', 'Anfitrión 2', 'Anfitrión 3'], hosts: ['Anfitrión 3'] });
  // A maintainer blocks Beto as a host: his servers leave the list (Terms 12.4.1), his points stay in the ranking.
  blocked.add('op3');
  assert.deepEqual(list(), { nodes: ['Juanito', 'Proyecto', 'Anfitrión 2'], hosts: ['Anfitrión 3'] });
  assert.deepEqual(publicNamesWanted(cp, NOON, { shows: (id) => showing.has(id), blocked: (id) => blocked.has(id) }).sort(), ['op1', 'project'], 'what the object asks AccountsDO for: the named ones it shows');
  showing = new Set(['op1', 'op3']);
  assert.deepEqual(publicNamesWanted(cp, NOON, { shows: (id) => showing.has(id), blocked: (id) => blocked.has(id) }).sort(), ['op1', 'op3', 'project'], "a blocked host's name in the ranking");
  // The reference server's list (no names, no blocks): the project by its records, every other host by its number.
  assert.deepEqual(publicStatus(cp, NOON).nodes.map((n) => n.operator), ['Anfitrión 1', 'Proyecto', 'Anfitrión 2', 'Anfitrión 3']);
});

// ---- Prompt 2, PR 2: the project-only preference, the server's trust, an operator's rename -----------

test("a project-only match goes to a project node, never a community one: none free is null, no unmet demand, nothing sent to the community; the placement says whose node it is; the project's hosts apart", async () => {
  const policy = { ...COMMUNITY_POLICY, ranked: false };
  const w = await world([{ capacity: 4 }, { op: 'project', capacity: 1 }], policy);
  const [juan, project] = w.nodes.map((n) => n.nodeId);
  const first = await w.place({ projectOnly: true });
  assert.deepEqual([first?.nodeId, first?.trusted], [project, true]);
  assert.equal(await w.place({ projectOnly: true }), null, "the project's node is full at its 1");
  assert.equal(w.nodes[0].taken, 0, 'the community node was never sent one');
  assert.equal(w.cp.regionView('SA').unplaced, 0, 'a match the community could never take is no demand of its factor');
  const any = await w.place();
  assert.deepEqual([any?.nodeId, any?.trusted], [juan, false], 'without the preference, the community node');
  assert.deepEqual([w.cp.hostsOnline('SA'), w.cp.hostsOnline('SA', true)], [2, 1]);
  // Every node of the region full: a project-only match no node took is still no demand, an open one is.
  const f = await world([{ capacity: 1 }, { op: 'project', capacity: 1 }], policy);
  assert.equal((await f.place({ projectOnly: true }))?.trusted, true);
  assert.equal((await f.place())?.trusted, false);
  assert.equal(await f.place({ projectOnly: true }), null);
  assert.equal(f.cp.regionView('SA').unplaced, 0, 'project-only: not counted');
  assert.equal(await f.place(), null);
  assert.equal(f.cp.regionView('SA').unplaced, 1, 'an open one: unmet demand, as before');
  // A region with community nodes only: a project-only match finds none, and its hosts are 0.
  const c = await world([{ capacity: 4 }], policy);
  assert.equal(await c.place({ projectOnly: true }), null);
  assert.deepEqual([c.nodes[0].taken, c.cp.hostsOnline('SA'), c.cp.hostsOnline('SA', true), c.cp.regionView('SA').unplaced], [0, 1, 0, 0]);
  // Ranked too (with the community allowed ranked one day: the preference still wins).
  const r = await world([{ status: 'active' }], { ...policy, ranked: true });
  assert.equal(await r.place({ ranked: true, humans: [human('a'), human('b')], projectOnly: true }), null);
  assert.ok(await r.place({ ranked: true, humans: [human('a'), human('b')] }));
});

test("an operator renames its node: cleaned like a --name, never another server's of its region nor a project server's, whatever the case, its own case change allowed; written; a retired node not", async () => {
  const saved = [];
  const store = { node: (n) => saved.push(n.name), tokens() {}, register() {}, dropTokens() {} };
  const reg = new Registry({ trustedOperators: ['project'], maxTrustedNodes: 8, log: quiet, community: RULES, store });
  const regNode = async (op, region, name, url) => {
    const { token } = await reg.createToken(op, region, 0, name);
    const r = await reg.register(await request(token, url), 0, { continent: region });
    assert.ok(r.ok, JSON.stringify(r));
    return r.node;
  };
  await regNode({ id: 'project', name: 'Proyecto' }, 'EU', 'frankfurt-1', 'wss://f.example.org');
  const juan = await regNode({ id: 'op1', name: 'Juan' }, 'SA', 'juan-1', 'wss://j.example.org');
  await regNode({ id: 'op2', name: 'Ana' }, 'SA', 'ana-1', 'wss://a.example.org');
  assert.deepEqual(reg.rename(juan.nodeId, 'FRANKFURT-1'), { ok: false, code: 'name_taken' }, "a project server's, in any region");
  assert.deepEqual(reg.rename(juan.nodeId, 'Ana-1'), { ok: false, code: 'name_taken' }, 'another of its region');
  assert.deepEqual(reg.rename(juan.nodeId, '!!'), { ok: false, code: 'bad_name' });
  saved.length = 0;
  const r = reg.rename(juan.nodeId, 'JUAN-1');
  assert.deepEqual([r.ok, r.was, reg.node(juan.nodeId).name, saved], [true, 'juan-1', 'JUAN-1', ['JUAN-1']], 'its own name in another case, written');
  assert.equal(reg.rename(juan.nodeId, 'casa-de-juan').node.name, 'casa-de-juan');
  assert.equal(reg.nameTaken('SA', 'juan-1'), false, 'its old name is free again');
  reg.retire(juan.nodeId, 'gone', 1);
  assert.equal(reg.rename(juan.nodeId, 'otra'), null);
  assert.equal(reg.rename('nope', 'otra'), null);
});
