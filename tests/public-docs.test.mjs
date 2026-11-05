// The public docs are not a targeting guide for the project's own machines (the audit's repo-5):
// no routable IP address anywhere, and the trusted node's manual (nodes/docs/VPS-SAO-PAULO.md)
// and plan (PRODUCCION.md) give placeholders, not its provider and plan, SSH key file, test user
// or the traffic and match budgets an abuser would need to push it out of rotation. Those live in
// the maintainer's notes. Reads the tracked .md and .txt files.
//   node --test tests/public-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const r = spawnSync('git', ['ls-files', '--', '*.md', '*.txt'], { cwd: ROOT, encoding: 'utf8' });
const docs = r.stdout.split('\n').filter(Boolean);
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** An IPv4 address nobody may route to on the internet: loopback, private, link-local, CGNAT, documentation, unspecified. */
function reservedV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

test('the docs are found', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(docs.includes('nodes/docs/VPS-SAO-PAULO.md'));
  assert.ok(docs.includes('nodes/docs/VPS-PROYECTO.md'));
});

test('no doc names a routable IP address (examples use the documentation ranges)', () => {
  const hits = [];
  for (const f of docs) {
    const text = read(f);
    // IPv4, not part of a longer dotted version (1.2.3.4.5) nor a version string (v1.2.3.4, x@1.2.3.4).
    for (const m of text.matchAll(/(?<![\w.@])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g)) {
      const ip = m[1];
      if (ip.split('.').every((o) => Number(o) <= 255) && !reservedV4(ip)) hits.push(`${f}: ${ip}`);
    }
    // IPv6 global unicast (2000::/3), outside 2001:db8::/32.
    for (const m of text.matchAll(/(?<![\w:])([23][0-9a-f]{3}:[0-9a-f]{0,4}:[0-9a-f:]*[0-9a-f])(?![\w:])/gi))
      if (!/^2001:0?db8:/i.test(m[1])) hits.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(hits, []);
});

test("the trusted node's manual and plan give placeholders, not its provider, keys or budgets", () => {
  const hits = [];
  for (const f of ['nodes/docs/VPS-SAO-PAULO.md', 'nodes/docs/VPS-PROYECTO.md', 'nodes/docs/PRODUCCION.md']) {
    const text = read(f);
    for (const [what, re] of [
      ['the provider', /hostinger/i],
      ['the plan', /\bKVM ?\d/i],
      ['the site', /campinas/i],
      ['an SSH key file', /\.ssh[\\/](?!<)[\w.-]+/],
      ['the test user', /\btgtest\b/],
      ['a traffic cap', /--egress-cap-gb[ =]\d/],
      ['a declared capacity', /--matches[ =]\d/],
      ['the plan transfer', /\d+ ?TB\b/],
    ])
      if (re.test(text)) hits.push(`${f}: ${what} (${re.exec(text)[0]})`);
  }
  for (const f of docs) if (/\bKVM ?2\b|campinas/i.test(read(f))) hits.push(`${f}: the node's plan or site`);
  assert.deepEqual(hits, []);
});

test("the legal texts and their notices name the project's providers and countries, never a machine's plan, host name, cloud region or machine type, or a cap", () => {
  // The privacy policy has to name each provider and country (docs/legal/README.md), so Hostinger
  // and Google Cloud may appear there. What would point an abuser at a machine may not: a name under
  // turbo-gol.com other than the site and its mailboxes, a cloud region or zone id, a machine type,
  // a provider's plan, a declared capacity or a traffic cap.
  const hits = [];
  for (const f of docs.filter((d) => d.startsWith('docs/legal/'))) {
    const text = read(f);
    for (const [what, re] of [
      ['a host name under turbo-gol.com', /(?<![@\w.-])(?:[a-z0-9-]+\.)+turbo-gol\.com\b/i],
      ['a cloud region or zone', /\b(?:africa|asia|australia|europe|me|northamerica|southamerica|us)-(?:central|east|west|north|south|southeast|northeast)\d(?:-[a-c])?\b/i],
      ['a machine type', /\b(?:e2|n1|n2|n2d|n4|c2|c2d|c3|c3d|c4|t2a|t2d)-(?:micro|small|medium|standard|highcpu|highmem)\b/i],
      ['a plan', /\bKVM ?\d/i],
      ['a declared capacity or a traffic cap', /--matches\b|--egress-cap-gb\b|egressCapGB/],
    ])
      if (re.test(text)) hits.push(`${f}: ${what} (${re.exec(text)[0]})`);
  }
  assert.deepEqual(hits, []);
});

test("a doc names only the project's public mailboxes (the legal texts' privacy address and the mail sender), never the maintainer account's own", () => {
  // The maintainer account's sign-in address stays out of every public page: knowing it is half of
  // a password-guessing or a phishing run against the account that registers trusted nodes.
  const PUBLIC = new Set(['privacy', 'privacidad', 'no-reply']);
  const hits = [];
  for (const f of docs) for (const m of read(f).matchAll(/([A-Za-z0-9._%+-]+)@turbo-gol\.com\b/gi)) if (!PUBLIC.has(m[1].toLowerCase())) hits.push(`${f}: ${m[1]}@…`);
  assert.deepEqual(hits, []);
});
