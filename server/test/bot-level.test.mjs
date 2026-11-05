// The bots' level online (the owner's decisions of 2026-11-04): Casual's bots play hard unless the
// KV flag bot_level says otherwise (env.ts casualBotLevel, read once per formation: pooled and solo,
// on a MatchDO and on a node; queue-hub.test.mjs and nodeMatchmaker.test.mjs follow it through the
// hub), ranked sends none, and a lobby's P2P room runs the level its host picked (LobbyDO, the
// matchmaker's /custom, RoomDO: experimental-lobby.test.mjs and room.test.mjs cover the two ends).
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHubWorld, pid } from './helpers/hub.mjs';

const E = await import('../src/env.ts');

test('casualBotLevel: unset is hard; easy | medium | hard, case and spaces ignored; anything else, or a KV that throws, is hard; read edge-cached 60 s', async () => {
  const reads = [];
  const kv = (v) => ({ FLAGS: { get: async (k, opts) => (reads.push([k, opts?.cacheTtl]), v) } });
  assert.equal(E.CASUAL_BOT_LEVEL, 'hard');
  assert.deepEqual(E.BOT_LEVELS, ['easy', 'medium', 'hard']);
  assert.equal(await E.casualBotLevel(kv(null)), 'hard', 'unset');
  assert.equal(await E.casualBotLevel(kv('medium')), 'medium');
  assert.equal(await E.casualBotLevel(kv(' Easy ')), 'easy');
  assert.equal(await E.casualBotLevel(kv('HARD\n')), 'hard');
  for (const junk of ['insane', '', '1', 'med', 'normal']) assert.equal(await E.casualBotLevel(kv(junk)), 'hard', JSON.stringify(junk));
  assert.equal(await E.casualBotLevel({ FLAGS: { get: async () => { throw new Error('KV down'); } } }), 'hard', 'unreadable: the default, never an error');
  assert.ok(reads.every(([k, ttl]) => k === 'bot_level' && ttl === 60));
  for (const v of ['easy', 'medium', 'hard']) assert.equal(E.isBotLevel(v), true);
  for (const v of ['Hard', 'expert', 2, null, undefined, {}]) assert.equal(E.isBotLevel(v), false, String(v));
});

const members = () => [
  { playerId: pid(), name: 'Ana', team: 0, guest: false },
  { playerId: pid(), name: 'Beto', team: 1, guest: true },
];

test("the matchmaker's /custom: the lobby's level goes to the RoomDO (absent = hard, the lobby default); junk is 400 bad_bots before any room; the KV flag never reaches a lobby", async () => {
  const w = await makeHubWorld({ flags: { bot_level: 'easy' } });
  const roomCreates = () => w.room.calls.filter((c) => c.path === '/internal/create');
  for (const level of ['easy', 'medium', 'hard']) {
    const r = await w.call('/custom', { kind: 'p2p', mode: '2v2', members: members(), matchLengthSeconds: 300, physics: null, bots: level });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(roomCreates().at(-1).body.botDifficulty, level);
  }
  const absent = await w.call('/custom', { kind: 'p2p', mode: '1v1', members: members(), matchLengthSeconds: 300 });
  assert.equal(absent.status, 200);
  assert.equal(roomCreates().at(-1).body.botDifficulty, 'hard', "a lobby's default, not the Casual flag");
  const before = roomCreates().length;
  for (const bad of ['insane', 'Hard', 1, null]) {
    const r = await w.call('/custom', { kind: 'p2p', mode: '1v1', members: members(), matchLengthSeconds: 300, bots: bad });
    assert.deepEqual([r.status, r.json.error], [400, 'bad_bots'], JSON.stringify(bad));
  }
  assert.equal(roomCreates().length, before, 'no room for a refused start');
  assert.equal(w.created().length, 0, 'never a MatchDO');
});
