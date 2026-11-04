// The public list (GET /nodes/status, control-plane/publicList.ts): which nodes it shows and the name
// each operator goes by, the same for the production object and the reference server.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Registry } = await import('../control-plane/registry.ts');
const { Ledger } = await import('../control-plane/ledger.ts');
const { PUBLIC_HOST_LABEL, listedPublicly, publicOperatorNames, publicStatus } = await import('../control-plane/publicList.ts');
const { generateEd25519 } = await import('../shared/edcrypto.ts');

const BUILD = { version: '0.1.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
const PROJECT = { id: 'a1b2c3d4e5f60718', name: 'Proyecto' };
const JUAN = { id: '0123456789abcdef', name: 'Juan' };
const ANA = { id: 'fedcba9876543210', name: 'Ana' };

async function regNode(reg, op, now, name, status) {
  const { token } = await reg.createToken(op, 'SA', now, name);
  const keys = await generateEd25519();
  const r = await reg.register({ token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.7', build: BUILD, specs: SPECS, capacity: CAP }, now);
  assert.ok(r.ok, JSON.stringify(r));
  if (status) r.node.status = status;
  return r.node;
}

const cpOf = (reg, ledger = new Ledger()) => ({ registry: reg, ledger, currentBuild: BUILD, sameBuildAs: (b) => b.version === BUILD.version });

const score = (ledger, op, at, k) =>
  ledger.record(
    // Players of their own per match: no repeat decay between these.
    { matchId: k.repeat(64), nodeId: 'n1', operatorId: op.id, region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', players: [k.repeat(16), (k + '0').repeat(8)].map((p) => ({ playerId: p, connectedMs: 5 * 60_000, account: true, accountAgeDays: 30 })), tickLagP99Ms: 2, underrunRate: 0, at },
    1,
  );

test('only probation and active nodes are listed, never a retired one', async () => {
  const reg = new Registry({ trustedOperators: [PROJECT.id], maxTrustedNodes: 8, log: () => undefined });
  const now = 1_000_000;
  for (const s of ['pending', 'probation', 'active', 'suspended', 'banned']) await regNode(reg, PROJECT, now, s, s);
  const retired = await regNode(reg, PROJECT, now, 'retired', 'active');
  retired.retiredAt = now;
  retired.retiredReason = 'gone';
  assert.deepEqual(reg.list().filter(listedPublicly).map((n) => n.name), ['probation', 'active']);
  const s = publicStatus(cpOf(reg), now);
  assert.deepEqual(s.nodes.map((n) => [n.name, n.status]), [['probation', 'probation'], ['active', 'active']]);
  assert.deepEqual(Object.keys(s.nodes[0]).sort(), ['active', 'capacity', 'compatible', 'name', 'online', 'operator', 'region', 'roles', 'status', 'tickLagP99Ms', 'transports', 'trusted', 'version']);
  assert.ok(!JSON.stringify(s).includes('203.0.113.7'), 'no address');
});

test('the project by its name; any other operator as "Anfitrión <n>", numbered by its first registration, in the nodes and in the hosts', async () => {
  const reg = new Registry({ trustedOperators: [PROJECT.id], log: () => undefined });
  const ledger = new Ledger();
  let now = 1_000_000;
  const ana = await regNode(reg, ANA, now, 'ana-1', 'active'); // first community operator to register
  now += 1000;
  await regNode(reg, PROJECT, now, 'sao-paulo-1', 'active');
  now += 1000;
  await regNode(reg, JUAN, now, 'juan-1', 'probation');
  score(ledger, JUAN, now, '1');
  score(ledger, ANA, now, '2');
  score(ledger, ANA, now, '3');
  let s = publicStatus(cpOf(reg, ledger), now);
  assert.equal(PUBLIC_HOST_LABEL, 'Anfitrión');
  assert.deepEqual(s.nodes.map((n) => [n.name, n.operator, n.trusted]), [
    ['ana-1', 'Anfitrión 1', false],
    ['sao-paulo-1', 'Proyecto', true],
    ['juan-1', 'Anfitrión 2', false],
  ]);
  assert.deepEqual(s.hosts.map((h) => h.name), ['Anfitrión 1', 'Anfitrión 2'], 'by points, with the numbers of the nodes');
  const text = JSON.stringify(s);
  for (const op of [ANA, JUAN, PROJECT]) assert.ok(!text.includes(op.id.slice(0, 6)), 'never an id, nor its start');
  assert.ok(!text.includes('Juan') && !text.includes('Ana'), "a community operator's name is never shown");
  // Ana's node leaves the list (banned): Juan keeps his number, and Ana hers in the ranking.
  ana.status = 'banned';
  s = publicStatus(cpOf(reg, ledger), now);
  assert.deepEqual(s.nodes.map((n) => n.operator), ['Proyecto', 'Anfitrión 2']);
  assert.deepEqual(s.hosts.map((h) => h.name), ['Anfitrión 1', 'Anfitrión 2']);
});

test("an operator's name: the project's newest one, a number for the token's id fallback, and one after every record for a ranked operator with none", async () => {
  const reg = new Registry({ trustedOperators: [PROJECT.id, 'b1b2c3d4e5f60718'], log: () => undefined });
  await regNode(reg, { id: PROJECT.id, name: 'Viejo' }, 1000, 'n1', 'active');
  await regNode(reg, PROJECT, 2000, 'n2', 'active');
  // NodeRegistryDO's token: the start of the id when the account's name could not be read.
  await regNode(reg, { id: 'b1b2c3d4e5f60718', name: 'b1b2c3' }, 3000, 'n3', 'active');
  await regNode(reg, JUAN, 4000, 'n4', 'active');
  const nameOf = publicOperatorNames(reg.list(), (id) => reg.isTrusted(id), ['99999999aaaaaaaa', JUAN.id]);
  assert.deepEqual([PROJECT.id, 'b1b2c3d4e5f60718', JUAN.id, '99999999aaaaaaaa'].map(nameOf), ['Proyecto', 'Anfitrión 1', 'Anfitrión 2', 'Anfitrión 3']);
});

test("a node registered with no name is named by its region and a number, never by its operator: not its name, not the start of its id", async () => {
  const reg = new Registry({ trustedOperators: [PROJECT.id], maxTrustedNodes: 8, log: () => undefined });
  // NodeRegistryDO's token: the start of the id when the account's name could not be read.
  const NAMELESS = { id: '5e5e5e5e5e5e5e5e', name: '5e5e5e' };
  const unnamed = async (op, region, now) => {
    const { token } = await reg.createToken(op, region, now);
    const keys = await generateEd25519();
    const r = await reg.register({ token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.7', build: BUILD, specs: SPECS, capacity: CAP }, now);
    assert.ok(r.ok, JSON.stringify(r));
    r.node.status = 'active';
    return r.node;
  };
  const names = [];
  names.push((await unnamed(JUAN, 'SA', 1000)).name);
  names.push((await unnamed(NAMELESS, 'SA', 2000)).name);
  names.push((await unnamed(PROJECT, 'EU', 3000)).name);
  // A name someone chose that looks like one of these is never given twice.
  await regNode(reg, ANA, 4000, 'sa-node-4', 'active');
  names.push((await unnamed(JUAN, 'SA', 5000)).name);
  assert.deepEqual(names, ['sa-node-1', 'sa-node-2', 'eu-node-1', 'sa-node-5']);
  const text = JSON.stringify(publicStatus(cpOf(reg), 6000)).toLowerCase();
  assert.ok(!text.includes('juan') && !text.includes('proyecto-') && !text.includes('5e5e5e'), text);
  assert.deepEqual(
    publicStatus(cpOf(reg), 6000).nodes.map((n) => [n.name, n.operator]),
    [['sa-node-1', 'Anfitrión 1'], ['sa-node-2', 'Anfitrión 2'], ['eu-node-1', 'Proyecto'], ['sa-node-4', 'Anfitrión 3'], ['sa-node-5', 'Anfitrión 1']],
  );
});

test('an empty registry: a valid answer all the same (the deploy check asks for a 200)', () => {
  const reg = new Registry({ log: () => undefined });
  assert.deepEqual(publicStatus(cpOf(reg), 1), { build: BUILD, nodes: [], hosts: [] });
});
