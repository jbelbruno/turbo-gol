// The smoke scripts' target (server/test/helpers/smokeTarget.mjs): --api=<url> or API, never a
// default. Before review round 2 smoke.mjs, smoke-p2p.mjs, smoke-accounts.mjs and hardening.mjs
// fell back to http://127.0.0.1:8787, a developer's own `npm run dev`. Each script started with no
// target now prints how to give one and exits 2 before any request. No network. Run from server/:
// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NO_TARGET, smokeTarget } from './helpers/smokeTarget.mjs';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = ['smoke.mjs', 'smoke-p2p.mjs', 'smoke-accounts.mjs', 'hardening.mjs'];

test('smokeTarget: --api wins over API; the trailing slash goes; nothing, blank or a non-http value is an error, never a default', () => {
  assert.deepEqual(smokeTarget(['--api=http://127.0.0.1:8931/'], {}), { api: 'http://127.0.0.1:8931' });
  assert.deepEqual(smokeTarget([], { API: 'https://turbo-gol.com' }), { api: 'https://turbo-gol.com' });
  assert.deepEqual(smokeTarget(['--duration=5', '--api=http://127.0.0.1:9000'], { API: 'http://127.0.0.1:1' }), { api: 'http://127.0.0.1:9000' });
  for (const [argv, env] of [[[], {}], [[], { API: '' }], [[], { API: '  ' }], [['--api='], { API: 'http://x' }]]) assert.deepEqual(smokeTarget(argv, env), { error: NO_TARGET }, JSON.stringify([argv, env]));
  for (const bad of ['127.0.0.1:8787', 'ws://127.0.0.1:1', 'http://', 'ftp://x']) assert.match(smokeTarget([], { API: bad }).error, /must be an http\(s\) URL/, bad);
  assert.match(NO_TARGET, /--api=/);
  assert.match(NO_TARGET, /--local-upstream/);
});

test('every smoke script started without a target exits 2 with the message, before any request', () => {
  const env = { ...process.env };
  delete env.API;
  for (const script of SCRIPTS) {
    // Never spawn a script that could reach a network before its target check (a regression would
    // otherwise send this test's requests to whatever listens on a default port).
    const src = readFileSync(TEST_DIR + script, 'utf8');
    const check = src.indexOf('const API = smokeApiOrExit();');
    assert.ok(check > 0, script + ': takes its target from smokeApiOrExit()');
    for (const io of ['fetch(', 'new WebSocket(', "?? 'http"]) {
      const at = src.indexOf(io);
      assert.ok(at === -1 || at > check, `${script}: '${io}' comes after the target check`);
    }
    const r = spawnSync(process.execPath, [TEST_DIR + script], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `${script}: exit ${r.status} ${r.stderr}`);
    assert.ok(r.stderr.includes('No target: pass --api=<base url> or set API'), script + ': ' + r.stderr);
    assert.equal(r.stdout.trim(), '', script + ': it printed nothing else, so it checked nothing yet');
  }
});
