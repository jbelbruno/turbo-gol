// The shell installers parse (bash -n), and install.sh writes a Caddyfile fit for its public
// address: a DNS name gets the default certificate, an IP address the short-lived profile, and
// both keep WebSockets open across a reload and turn HTTP/3 off. install.sh is sourced with
// TGN_INSTALL_LIB=1, which defines its functions and runs nothing. Then the whole script runs as
// root on a fake machine: a first install, re-runs, --restore, --node-version, and every check that
// must stop it before the one-time token is spent (a new wss host on no name, or on an IP address
// without --allow-ip, before anything is installed).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = (name) => fileURLToPath(new URL(`../install/${name}`, import.meta.url)).replace(/\\/g, '/');
const INSTALL_SH = installer('install.sh');

/** A bash that runs (Git for Windows' on a Windows machine without one on the PATH), or null. */
function findBash() {
  const candidates = ['bash', ...(process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'] : [])];
  for (const bash of candidates) {
    const r = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return bash;
  }
  return null;
}
const BASH = findBash();
const skip = BASH ? false : 'no bash on this machine';

/** Run `script` in bash after sourcing install.sh as a library; returns its stdout. */
function withInstaller(script) {
  const r = spawnSync(BASH, ['-c', `. "$INSTALL_SH"\n${script}`], { encoding: 'utf8', env: { ...process.env, TGN_INSTALL_LIB: '1', INSTALL_SH } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The Caddyfile without its comments and blank lines, one trimmed line each. */
const directives = (caddyfile) =>
  caddyfile
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

test('the shell installers parse', { skip }, () => {
  for (const name of ['install.sh', 'install-desktop.sh']) {
    const r = spawnSync(BASH, ['-n', installer(name)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
  assert.equal(withInstaller('echo sourced'), 'sourced\n', 'sourcing it as a library runs nothing');
});

test('Caddyfile for a DNS name: default certificate, WebSockets kept across reloads, no HTTP/3', { skip }, () => {
  const text = withInstaller('caddyfile sp1.turbo-gol.com 7350');
  assert.deepEqual(directives(text), [
    '{',
    'servers {',
    'protocols h1 h2',
    '}',
    '}',
    'sp1.turbo-gol.com {',
    'reverse_proxy 127.0.0.1:7350 {',
    'stream_close_delay 30m',
    '}',
    '}',
  ]);
  assert.doesNotMatch(text, /shortlived|cert_issuer/);
});

test('Caddyfile for an IP address: the short-lived certificate profile; IPv6 in brackets', { skip }, () => {
  const v4 = directives(withInstaller('caddyfile 203.0.113.7 7350'));
  assert.deepEqual(v4, [
    '{',
    'servers {',
    'protocols h1 h2',
    '}',
    'cert_issuer acme {',
    'profile shortlived',
    '}',
    '}',
    '203.0.113.7 {',
    'reverse_proxy 127.0.0.1:7350 {',
    'stream_close_delay 30m',
    '}',
    '}',
  ]);
  const v6 = directives(withInstaller('caddyfile 2001:db8::7 7350'));
  assert.ok(v6.includes('profile shortlived'));
  assert.ok(v6.includes('[2001:db8::7] {'), v6.join('\n'));
});

test('install.sh helpers: what is an IP address or a DNS name, which Caddy is new enough', { skip }, () => {
  const out = withInstaller(`
    for h in 203.0.113.7 256.1.1.1 2001:db8::7 sp1.turbo-gol.com localhost 'a b.com' 1.2.3.4:443 sp1.turbo-gol.com:443 '{x}.com'; do
      kind=-
      if is_ip "$h"; then kind=ip; elif is_dns_name "$h"; then kind=name; fi
      echo "$h=$kind"
    done
    for v in 'v2.10.2 h1:abc' 'v2.9.1 h1:abc' 'v2.6.2' 'v3.0.0' '(devel)' ''; do
      if version_at_least "$v" 2 10; then echo "[$v]=ok"; else echo "[$v]=old"; fi
    done
    canon_ipv6 2001:0DB8:0:0:0:0:0:7
  `);
  assert.deepEqual(out.trim().split('\n'), [
    '203.0.113.7=ip',
    '256.1.1.1=-',
    '2001:db8::7=ip',
    'sp1.turbo-gol.com=name',
    'localhost=-',
    'a b.com=-',
    '1.2.3.4:443=-',
    'sp1.turbo-gol.com:443=-',
    '{x}.com=-',
    '[v2.10.2 h1:abc]=ok',
    '[v2.9.1 h1:abc]=old',
    '[v2.6.2]=old',
    '[v3.0.0]=ok',
    '[(devel)]=ok',
    '[]=ok',
    '2001:db8::7',
  ]);
});

test('install.sh helpers: which Node.js --node-version asks for, and which NodeSource package gives it', { skip }, () => {
  const out = withInstaller(`
    # "-": no Node.js here.
    for c in '24.14.0 24' '24.14.0 24.14' '24.14.0 24.14.0' '24.14.0 24.1' '24.14.0 2' '24.14.0 25' '24.14.10 24.14.1' '- 24'; do
      set -- $c
      have=$1; [ "$have" != - ] || have=""
      if node_is "$have" "$2"; then echo "[$c]=yes"; else echo "[$c]=no"; fi
    done
    # The order apt-cache madison gives is not the version order (24.9 is older than 24.14).
    apt-cache() { for v in 24.9.1-1nodesource1 24.14.0-1nodesource1 24.14.0+dfsg-1ubuntu1 24.9.0-1nodesource1 25.0.0-1nodesource1 24.1.2-1nodesource1; do echo " nodejs | $v | https://example.org/repo nodistro/main amd64 Packages"; done; }
    for v in 24 24.9 24.14.0 24.1 24.2 26; do echo "$v=$(nodesource_package "$v")"; done
  `);
  assert.deepEqual(out.trim().split('\n'), [
    '[24.14.0 24]=yes',
    '[24.14.0 24.14]=yes',
    '[24.14.0 24.14.0]=yes',
    '[24.14.0 24.1]=no',
    '[24.14.0 2]=no',
    '[24.14.0 25]=no',
    '[24.14.10 24.14.1]=no',
    '[- 24]=no',
    '24=24.14.0-1nodesource1',
    '24.9=24.9.1-1nodesource1',
    '24.14.0=24.14.0-1nodesource1',
    '24.1=24.1.2-1nodesource1',
    '24.2=',
    '26=',
  ]);
});

test('is_ip agrees with Node.js (and so with Go, which Caddy is written in) on what an address is', { skip }, () => {
  // A typo taken for an address would reach Caddy as a host name and the control plane as the
  // node's URL: the token spent on an address that can never get a certificate.
  const cases = [
    '0.0.0.0', '203.0.113.7', '255.255.255.255', '256.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.04', '010.0.0.1', '01.2.3.4',
    '::', '::1', '1::', '2001:db8::7', '2001:DB8:0:0:0:0:0:7', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8',
    '1:2:3', ':::', '2001:db8:7', ':1::2', '1::2:', '1::2::3', '12345::1', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8', '1:2', ':',
  ];
  const out = withInstaller(`for h in ${cases.map((c) => `'${c}'`).join(' ')}; do if is_ip "$h"; then echo "$h=ip"; else echo "$h=-"; fi; done`);
  assert.deepEqual(out.trim().split('\n'), cases.map((c) => `${c}=${net.isIP(c) ? 'ip' : '-'}`));
  assert.equal(withInstaller(`is_ip ::ffff:1.2.3.4 && echo ip || echo -`).trim(), '-', 'no dotted IPv4 tail (Node.js takes it; a public address never has one)');
});

test('DNS preflight: a name must lead to this machine; Cloudflare\'s proxy only with --allow-proxied', { skip }, () => {
  const out = withInstaller(`
    for a in 104.16.0.1 172.67.10.10 131.0.75.1 1.2.3.4 104.32.0.1 2606:4700::6810:84e5 2a06:98c7:ffff::1 2a06:98c8::1 2001:db8::1; do
      if is_cloudflare "$a"; then echo "$a=cloudflare"; else echo "$a=-"; fi
    done
    leads() { if why=$(dns_leads_here "$1" "$2" "$3"); then echo "ok"; else echo "no: $why"; fi; }
    leads '203.0.113.7' 203.0.113.7 0
    leads '' 203.0.113.7 0
    leads '198.51.100.1' 203.0.113.7 0
    leads '203.0.113.7 198.51.100.1' 203.0.113.7 0
    leads '104.16.0.1 104.16.0.2' 203.0.113.7 0
    leads '104.16.0.1 104.16.0.2' 203.0.113.7 1
    leads '104.16.0.1 198.51.100.1' 203.0.113.7 1
    leads '203.0.113.8' '203.0.113.7 203.0.113.8' 0
    leads '198.51.100.1' '203.0.113.7 203.0.113.8' 0
    leads '2001:db8::9' '' 0
    leads '2606:4700::6810:84e5' '' 1
  `);
  const lines = out.trim().split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    '104.16.0.1=cloudflare',
    '172.67.10.10=cloudflare',
    '131.0.75.1=cloudflare',
    '1.2.3.4=-',
    '104.32.0.1=-',
    '2606:4700::6810:84e5=cloudflare',
    '2a06:98c7:ffff::1=cloudflare',
    '2a06:98c8::1=-',
    '2001:db8::1=-',
  ]);
  const leads = lines.slice(9);
  assert.equal(leads[0], 'ok');
  assert.match(leads[1], /^no: it has no IPv4 address/);
  assert.equal(leads[2], 'no: it resolves to 198.51.100.1, not to this machine (203.0.113.7)');
  assert.equal(leads[3], 'no: it resolves to 198.51.100.1, not to this machine (203.0.113.7)', 'every address must be this machine');
  assert.match(leads[4], /^no: it resolves to Cloudflare's proxy \(104\.16\.0\.1 104\.16\.0\.2\), .*--allow-proxied/);
  assert.equal(leads[5], 'ok', '--allow-proxied');
  assert.match(leads[6], /^no: it resolves to 198\.51\.100\.1,/, '--allow-proxied accepts only Cloudflare');
  assert.equal(leads[7], 'ok', 'any of this machine\'s addresses');
  assert.equal(leads[8], 'no: it resolves to 198.51.100.1, not to this machine (203.0.113.7, 203.0.113.8)');
  assert.equal(leads[9], 'no: it resolves to 2001:db8::9, and this machine has no public address of that IP version');
  assert.equal(leads[10], 'ok', 'a proxied AAAA record');
  assert.equal(leads.length, 11);
});

// ---- the whole script on a fake machine ---------------------------------------------------------
//
// install.sh runs as root on a fresh server, so here it runs with every system path it uses moved
// under a temporary root, and with stubs first on the PATH for each command that would touch the
// machine (packages, services, users, the network, Caddy). The stubs log their arguments to $LOG,
// and FAKE_* variables say what they answer.

/** The system paths install.sh may name as they are; every other one must be under a moved prefix. */
const KEPT_PATHS = new Set(['/dev/null', '/usr/sbin/nologin']);
const MOVED = /^\/(etc|var|opt|usr\/share|usr\/bin)\//;
const PATH_IN_CODE = /(?:^|[\s"'=(>])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)*)/g;

const STUBS = {
  // An install of nodejs=<version>, or of nodejs (NodeSource's 26), leaves that Node.js at
  // /usr/bin/node for its stub below; FAKE_NODE_STUCK: it leaves the one that was there.
  'apt-get': [
    'echo "apt-get $*" >> "$LOG"',
    '[ -z "${FAKE_NODE_STUCK:-}" ] || exit 0',
    'for a in "$@"; do case "$a" in nodejs=*) v=${a#nodejs=}; echo "${v%%[-+]*}" > "$ROOT/node-version" ;; nodejs) echo 26.14.0 > "$ROOT/node-version" ;; esac; done',
  ],
  'apt-mark': ['echo "apt-mark $*" >> "$LOG"'],
  // FAKE_MADISON: the nodejs package versions the repositories have.
  'apt-cache': ['[ "$1" != madison ] || for v in ${FAKE_MADISON:-}; do echo " nodejs | $v | https://deb.nodesource.com/node_${v%%.*}.x nodistro/main amd64 Packages"; done'],
  // The Node.js the service runs (the installer's NODE_BIN, moved under the fake root): its version
  // is the one the last apt-get install of nodejs left, else FAKE_NODE. Anything else runs the real
  // Node.js (TGN_NODE). The `node` on the PATH is the real one.
  'usr/bin/node': [
    'if [ "$*" = "-p process.versions.node" ]; then',
    '  if [ -f "$ROOT/node-version" ]; then cat "$ROOT/node-version"; exit 0; fi',
    '  if [ -n "${FAKE_NODE:-}" ]; then echo "$FAKE_NODE"; exit 0; fi',
    'fi',
    'exec "$TGN_NODE" "$@"',
  ],
  chown: ['echo "chown $*" >> "$LOG"'],
  useradd: ['echo "useradd $*" >> "$LOG"'],
  gpg: ['cat > /dev/null'],
  openssl: ['exit 0'],
  id: ['[ "${1:-}" != -u ] || echo 0'],
  ss: ['printf \'%s\' "${FAKE_SS:-}"'],
  ufw: ['echo "ufw $*" >> "$LOG"', '[ "$1" != status ] || echo "Status: inactive"'],
  systemctl: ['echo "systemctl $*" >> "$LOG"', 'if [ "$1" = is-active ]; then case " ${FAKE_ACTIVE:-} " in *" ${!#} "*) exit 0 ;; *) exit 3 ;; esac; fi'],
  caddy: ['case "$1" in', '  version) echo "${FAKE_CADDY_VERSION:-v2.10.2 h1:abc}" ;;', '  validate) echo "caddy $*" >> "$LOG"; echo "Valid configuration" ;;', 'esac'],
  curl: [
    'url=""; out=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; http*) url=$1; shift ;; *) shift ;; esac; done',
    'echo "curl $url" >> "$LOG"',
    'case "$url" in',
    '  */nodes/whoami) [ -n "${FAKE_IP:-}" ] || exit 7; body="{\\"ip\\":\\"$FAKE_IP\\"}" ;;',
    '  */launcher.mjs) body="launcher ${FAKE_LAUNCHER:-1}" ;;',
    '  */launcher.mjs.sig) body=AAAA ;;',
    '  https://deb.nodesource.com/setup_*.x) body=true ;;',
    '  *) exit 22 ;;',
    'esac',
    'if [ -n "$out" ]; then printf \'%s\' "$body" > "$out"; else printf \'%s\' "$body"; fi',
  ],
  // -s dns: FAKE_A / FAKE_AAAA. With no AAAA record, ahostsv6 (AI_V4MAPPED) gives the A records
  // mapped, as glibc's does. Without -s: the system's lookup, /etc/hosts first (FAKE_HOSTS).
  getent: [
    'echo "getent $*" >> "$LOG"',
    'list=""',
    'if [ "$1" = -s ]; then',
    '  case "$3" in',
    '    ahostsv4) list=${FAKE_A:-} ;;',
    '    ahostsv6) list=${FAKE_AAAA:-}; if [ -z "$list" ]; then for a in ${FAKE_A:-}; do list="$list ::ffff:$a"; done; fi ;;',
    '  esac',
    'else list=${FAKE_HOSTS:-}; fi',
    '[ -n "${list// /}" ] || exit 2',
    'for a in $list; do echo "$a       STREAM ${!#}"; echo "$a       DGRAM"; done',
  ],
  ip: [
    'if [ "$1" = -4 ]; then for a in ${FAKE_ADDR4:-}; do echo "2: eth0    inet $a/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever"; done',
    'else for a in ${FAKE_ADDR6:-}; do echo "2: eth0    inet6 $a/64 scope global \\       valid_lft forever preferred_lft forever"; done; fi',
  ],
  // The checksum dpkg keeps for the Caddy package's example Caddyfile (FAKE_CADDY_MD5).
  'dpkg-query': ['[ -n "${FAKE_CADDY_MD5:-}" ] || exit 1', 'printf \'\\n %s %s\\n\' "$ROOT/etc/caddy/Caddyfile" "$FAKE_CADDY_MD5"'],
  install: [
    'echo "install $*" >> "$LOG"',
    'if [ -n "${FAKE_INSTALL_FAIL:-}" ] && [[ "$*" == *"$FAKE_INSTALL_FAIL"* ]]; then echo "install: cannot create regular file: No space left on device" >&2; exit 1; fi',
    'args=(); while [ $# -gt 0 ]; do case "$1" in -m | -o | -g) shift 2 ;; *) args+=("$1"); shift ;; esac; done',
    'cp "${args[0]}" "${args[1]}"',
  ],
  // runuser -u turbogol -- node <launcher.mjs> register ...: the fake registration below.
  runuser: ['echo "runuser $*" >> "$LOG"', 'shift 5', 'exec node "$FAKE_REGISTER" "$@"'],
};

/** What `launcher.mjs register` leaves: node.json, as node/main.ts writes it (FAKE_REGISTER_EXIT: it fails with that code instead). */
const FAKE_REGISTER = `import { writeFileSync } from 'node:fs';
const a = process.argv.slice(3);
const get = (k) => (a.includes('--' + k) ? a[a.indexOf('--' + k) + 1] : undefined);
const code = Number(process.env.FAKE_REGISTER_EXIT || 0);
if (code) {
  console.error('fake register: exit ' + code);
  process.exit(code);
}
const roles = get('roles').split(',');
const transports = roles.includes('host') ? [get('transport')] : [];
writeFileSync(get('data') + '/node.json', JSON.stringify({ nodeId: 'n_fake1', privateKey: 'k', roles, transports, publicUrl: get('public-url') ?? null }));
`;

const md5 = (text) => createHash('md5').update(text).digest('hex');

/**
 * A fake Ubuntu machine with Node.js and Caddy present. run(args, env) runs install.sh as root on
 * it and resolves with { code, out, err, log } (log: the stub calls of that run, one per line).
 */
async function fakeMachine() {
  const root = (await mkdtemp(join(tmpdir(), 'tgn-install-'))).replace(/\\/g, '/');
  assert.doesNotMatch(root, /\s/, 'the fake root goes unquoted into the script');
  for (const d of ['bin', 'etc/caddy', 'etc/systemd/system', 'etc/apt/sources.list.d', 'opt', 'usr/bin', 'usr/share/keyrings', 'var/lib']) await mkdir(join(root, d), { recursive: true });
  // As Ubuntu writes it: NAME and VERSION are shell variables the installer must not pick up.
  await writeFile(join(root, 'etc/os-release'), 'PRETTY_NAME="Ubuntu 26.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="26.04"\nVERSION="26.04.1 LTS (Resolute Raccoon)"\nID=ubuntu\nID_LIKE=debian\n');
  // A stub named by a path goes there under the fake root; the others go first on the PATH.
  for (const [name, lines] of Object.entries(STUBS)) {
    const file = name.includes('/') ? join(root, name) : join(root, 'bin', name);
    await writeFile(file, ['#!/usr/bin/env bash', ...lines, ''].join('\n'));
    await chmod(file, 0o755);
  }
  await writeFile(join(root, 'fake-register.mjs'), FAKE_REGISTER);
  const script = (await readFile(INSTALL_SH, 'utf8'))
    .replace(/(^|[\s"'=(>])\/(etc|var|opt|usr\/share|usr\/bin)\//gm, (_, pre, dir) => `${pre}${root}/${dir}/`)
    .replace(/__RELEASE_PUBLIC_KEY_B64URL__/g, 'A'.repeat(43))
    .replace(/__RELEASE_PUBLIC_KEY_PEM__/g, 'TEST-PEM');
  await writeFile(join(root, 'install.sh'), script);
  const read = (p) => readFile(join(root, p), 'utf8').catch(() => null);
  return {
    root,
    data: `${root}/var/lib/turbogol-node`,
    read,
    write: async (p, text) => {
      await mkdir(join(root, p, '..'), { recursive: true });
      await writeFile(join(root, p), text);
    },
    async run(args, env = {}) {
      const before = (await read('log')) ?? '';
      // The stubs go first on the PATH in bash's own form of it (C:/... is no PATH entry for Git Bash).
      const p = spawn(BASH, ['-c', 'PATH="$(cd "$TGN_STUBS" && pwd):$PATH"; exec "$BASH" "$TGN_SCRIPT" "$@"', 'install.sh', ...args], {
        env: {
          ...process.env,
          TGN_STUBS: `${root}/bin`,
          TGN_SCRIPT: `${root}/install.sh`,
          LOG: `${root}/log`,
          ROOT: root,
          FAKE_REGISTER: `${root}/fake-register.mjs`,
          TGN_NODE: process.execPath.replace(/\\/g, '/'),
          FAKE_IP: '203.0.113.7',
          FAKE_ADDR4: '10.0.0.5',
          FAKE_NODE: '26.14.0',
          ...env,
        },
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const code = await new Promise((resolve) => p.on('close', resolve));
      const log = ((await read('log')) ?? '').slice(before.length).split('\n').filter(Boolean);
      return { code, out, err, log };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const TOKEN = ['--control', 'https://turbo-gol.com', '--token', 'tgn1_abcdefghijklmnopqrstuvwxyz'];
const RERUN = ['--control', 'https://turbo-gol.com'];
/** A first install on a DNS name, as every new wss host is now. */
const NAMED = [...TOKEN, '--public-host', 'sp1.turbo-gol.com'];
/** Its A record leads here: to the address whoami sees (FAKE_IP). */
const HERE = { FAKE_A: '203.0.113.7' };
const CADDY_ON_443 = 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=811,fd=7))';
const show = (r) => `exit ${r.code}\n${r.out}\n${r.err}\n${r.log.join('\n')}`;
const registered = (r) => r.log.some((l) => l.startsWith('runuser '));
const restarted = (r) => r.log.includes('systemctl restart --no-block turbogol-node');
const execStart = async (m) => ((await m.read('etc/systemd/system/turbogol-node.service')) ?? '').split('\n').find((l) => l.startsWith('ExecStart='));

/** A run that must stop before the token is spent: non-zero, the reason in stderr, no registration, no node.json. */
async function refused(m, r, why) {
  assert.notEqual(r.code, 0, show(r));
  assert.match(r.err, why, show(r));
  assert.ok(!registered(r), `the token was spent:\n${show(r)}`);
  assert.equal(await m.read('var/lib/turbogol-node/node.json'), null);
}

test('the fake machine moves every system path install.sh uses', { skip }, async () => {
  const paths = new Set();
  for (const line of (await readFile(INSTALL_SH, 'utf8')).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(PATH_IN_CODE)) paths.add(m[1]);
  }
  const unmoved = [...paths].filter((p) => !MOVED.test(p) && !KEPT_PATHS.has(p));
  assert.deepEqual(unmoved, [], 'a new system path: move it in fakeMachine() (or list it in KEPT_PATHS if nothing is written there)');
  assert.ok(paths.has('/var/lib/turbogol-node') && paths.has('/etc/caddy/Caddyfile'));
});

test('root never writes into the node\'s data directory through a redirect', { skip }, async () => {
  // $DATA belongs to the node's user: a redirect into it as root follows a link planted there by
  // a compromised node (to /etc/passwd, say). install(1) unlinks its destination first.
  const code = (await readFile(INSTALL_SH, 'utf8')).split('\n').filter((l) => !/^\s*#/.test(l));
  assert.deepEqual(code.filter((l) => />>?\s*"?\$\{?DATA\b/.test(l)), []);
});

describe('install.sh on a fake machine', { skip, concurrency: true }, () => {
  test('a first install on an IP address only with --allow-ip, then re-runs without it: nothing changed restarts nothing, --matches changes or drops, a failed write stops it; every run ends with the node\'s page and the guide', async () => {
    const m = await fakeMachine();
    try {
      // What the installer of 0.1.0 wrote: its own, so it is replaced.
      await m.write('etc/caddy/Caddyfile', '# Generated by the Turbogol node installer.\n{\n}\n\n203.0.113.7 {\n\treverse_proxy 127.0.0.1:7350\n}\n');
      const first = await m.run([...TOKEN, '--public-host', '203.0.113.7', '--allow-ip'], { FAKE_SS: CADDY_ON_443 });
      assert.equal(first.code, 0, show(first));
      const reg = first.log.filter((l) => l.startsWith('runuser '));
      assert.equal(reg.length, 1, show(first));
      assert.match(reg[0], / register --control https:\/\/turbo-gol\.com --data \S+ --token tgn1_\S+ --roles host --transport wss --public-url wss:\/\/203\.0\.113\.7$/);
      assert.ok(directives(await m.read('etc/caddy/Caddyfile')).includes('203.0.113.7 {'));
      assert.match(await execStart(m), / -- --port 7350 --listen 127\.0\.0\.1$/);
      assert.ok(first.log.includes('systemctl start turbogol-node'), show(first));
      const key = first.log.find((l) => / \S+\/release-key\.pub$/.test(l) && l.startsWith('install '));
      assert.ok(key && !key.split(' ').at(-2).startsWith(m.data), `the release key is written outside the data directory first: ${key}`);
      assert.equal(await m.read('var/lib/turbogol-node/release-key.pub'), 'A'.repeat(43));
      // The game's own link to the guide (src/ui/screens/garage.ts, guideUrl), and the page that follows the node.
      const source = /SOURCE_URL = '([^']+)'/.exec(await readFile(new URL('../../src/brand.ts', import.meta.url), 'utf8'))[1];
      assert.match(first.out, /Status on the website, in 'Mis servidores': https:\/\/turbo-gol\.com\/#servers\n/);
      assert.ok(first.out.endsWith(`==> Operator guide: ${source}/blob/main/nodes/README.md\n`), show(first));

      const running = { FAKE_ACTIVE: 'caddy turbogol-node', FAKE_SS: CADDY_ON_443 };
      const five = await m.run([...RERUN, '--matches', '5'], running);
      assert.equal(five.code, 0, show(five));
      assert.ok(!registered(five));
      assert.match(await execStart(m), / --matches 5$/);
      assert.ok(restarted(five), show(five));
      assert.match(five.out, /restarts with the new Node\.js, launcher or settings once its running matches end/);

      const same = await m.run(RERUN, running);
      assert.equal(same.code, 0, show(same));
      assert.match(same.out, /keeping --matches 5/);
      assert.match(same.out, /nothing changed: not restarted/);
      assert.match(same.out, /'Mis servidores': \S+\/#servers\n==> Operator guide: /);
      assert.ok(!restarted(same) && !same.log.some((l) => l.includes('reload-or-restart caddy')), show(same));

      // A re-run keeps the identity's address, an IP address too: --allow-ip is no hint for it.
      const typo = await m.run([...RERUN, '--public-host', '203.0.113.7:443'], running);
      assert.notEqual(typo.code, 0, show(typo));
      assert.match(typo.err, /--public-host: a DNS name or an IP address, with no port or scheme/);
      assert.doesNotMatch(typo.err, /--allow-ip/);
      assert.deepEqual(typo.log, [], show(typo));

      const auto = await m.run([...RERUN, '--matches', 'auto'], running);
      assert.equal(auto.code, 0, show(auto));
      assert.doesNotMatch(await execStart(m), /--matches/, 'back to the benchmark');
      assert.ok(restarted(auto), show(auto));

      const full = await m.run([...RERUN, '--matches', '7'], { ...running, FAKE_INSTALL_FAIL: 'turbogol-node.service' });
      assert.notEqual(full.code, 0, show(full));
      assert.match(full.err, /could not write \S+turbogol-node\.service/);
      assert.ok(!restarted(full) && !full.out.includes('done.'), show(full));
      assert.doesNotMatch(await execStart(m), /--matches/, 'the unit as it was');
    } finally {
      await m.cleanup();
    }
  });

  test('--name reaches the registration, though /etc/os-release defines NAME too', async () => {
    const m = await fakeMachine();
    try {
      const r = await m.run([...NAMED, '--name', 'sao-paulo-1'], { ...HERE, FAKE_SS: CADDY_ON_443 });
      assert.equal(r.code, 0, show(r));
      const reg = r.log.filter((l) => l.startsWith('runuser '));
      assert.equal(reg.length, 1, show(r));
      assert.match(reg[0], / --name sao-paulo-1( |$)/);
      assert.doesNotMatch(reg[0], /Ubuntu/);
    } finally {
      await m.cleanup();
    }
  });

  test('--restore: never over another identity, never an IP identity on another address, an IP identity on its own one with no --allow-ip; an older node.json is read as the node reads it', async () => {
    const backup = (publicUrl, extra = {}) => JSON.stringify({ nodeId: 'n_old1', privateKey: 'k', roles: ['host'], publicUrl, ...extra });
    const [other, moved, kept, older] = await Promise.all([fakeMachine(), fakeMachine(), fakeMachine(), fakeMachine()]);
    try {
      await other.write('var/lib/turbogol-node/node.json', backup('wss://203.0.113.7', { nodeId: 'n_here' }));
      await other.write('backup.json', backup('wss://203.0.113.7', { transports: ['wss'] }));
      await moved.write('backup.json', backup('wss://203.0.113.7', { transports: ['wss'] }));
      await kept.write('backup.json', backup('wss://203.0.113.7', { transports: ['wss'] }));
      // No transports: a node.json from before they were written (transportsOf: wss with a public URL).
      await older.write('backup.json', backup('wss://sp1.turbo-gol.com'));
      const [rOther, rMoved, rKept, rOlder] = await Promise.all([
        other.run([...RERUN, '--restore', `${other.root}/backup.json`]),
        moved.run([...RERUN, '--restore', `${moved.root}/backup.json`], { FAKE_IP: '198.51.100.9', FAKE_ADDR4: '198.51.100.9' }),
        kept.run([...RERUN, '--restore', `${kept.root}/backup.json`]),
        older.run([...RERUN, '--restore', `${older.root}/backup.json`, '--transport', 'wss'], HERE),
      ]);

      assert.notEqual(rOther.code, 0, show(rOther));
      assert.match(rOther.err, /node\.json exists and is a different identity/);
      assert.match(await other.read('var/lib/turbogol-node/node.json'), /n_here/);

      assert.notEqual(rMoved.code, 0, show(rMoved));
      assert.match(rMoved.err, /identity is bound to 203\.0\.113\.7, and this machine is 198\.51\.100\.9: .*Register this machine again/);
      assert.equal(await moved.read('var/lib/turbogol-node/node.json'), null);
      assert.equal(await moved.read('etc/caddy/Caddyfile'), null);

      // Registered on an IP address before names were required: it keeps working where it is.
      assert.equal(rKept.code, 0, show(rKept));
      assert.ok(!registered(rKept));
      assert.match(await kept.read('var/lib/turbogol-node/node.json'), /n_old1/);
      assert.ok(directives(await kept.read('etc/caddy/Caddyfile')).includes('203.0.113.7 {'));

      assert.equal(rOlder.code, 0, show(rOlder));
      assert.ok(!registered(rOlder));
      assert.match(await older.read('var/lib/turbogol-node/node.json'), /n_old1/);
      assert.ok(directives(await older.read('etc/caddy/Caddyfile')).includes('sp1.turbo-gol.com {'));

      // The address was fixed at registration.
      const moving = await older.run([...RERUN, '--public-host', 'sp2.turbo-gol.com'], HERE);
      assert.notEqual(moving.code, 0, show(moving));
      assert.match(moving.err, /the public address was fixed at registration: \S+ says wss:\/\/sp1\.turbo-gol\.com/);
    } finally {
      await Promise.all([other.cleanup(), moved.cleanup(), kept.cleanup(), older.cleanup()]);
    }
  });

  test('every check that stops a first install does so before the token is spent, the address and --node-version ones before anything is installed', async () => {
    const name = NAMED;
    const blog = 'blog.example.org {\n\troot * /srv/blog\n\tfile_server\n}\n';
    const cases = [
      { why: /sp1\.turbo-gol\.com does not lead here: it resolves to 198\.51\.100\.1, not to this machine \(203\.0\.113\.7\)/, args: name, env: { FAKE_A: '198.51.100.1' } },
      { why: /over IPv6 \(its AAAA record\): it resolves to 2001:db8::9, and this machine has no public address.*Delete the AAAA record/, args: name, env: { FAKE_A: '203.0.113.7', FAKE_AAAA: '2001:db8::9' } },
      { why: /over IPv6 .*it resolves to 2001:db8::9, not to this machine \(2001:db8::7\)/, args: name, env: { FAKE_A: '203.0.113.7', FAKE_AAAA: '2001:db8::9', FAKE_ADDR6: '2001:db8::7 fd00::7' } },
      // Only /etc/hosts knows the name (Debian maps its own name to 127.0.1.1 there).
      { why: /it has no IPv4 address \(A record\) in DNS/, args: name, env: { FAKE_HOSTS: '203.0.113.7' } },
      { why: /--public-host 198\.51\.100\.20 is not an address of this machine \(203\.0\.113\.7\)/, args: [...TOKEN, '--public-host', '198.51.100.20', '--allow-ip'] },
      { why: /--public-host: a DNS name \(an IP address only with --allow-ip\), with no port or scheme/, args: [...TOKEN, '--public-host', '2001:db8:7'], early: true },
      { why: /ports 80\/443 are in use by another program/, args: name, env: { ...HERE, FAKE_SS: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=700,fd=6))' } },
      { why: /Caddyfile was not written by this installer .*move that file away/, args: name, caddyfile: blog, env: { ...HERE, FAKE_SS: CADDY_ON_443, FAKE_CADDY_MD5: md5('# the package example\n') } },
      { why: /could not be prepared \(see above\)\. The token was not used/, args: name, env: { ...HERE, FAKE_REGISTER_EXIT: '3' } },
      { why: /registration failed \(see above\)\. If the control plane refused the token/, args: name, env: { ...HERE, FAKE_REGISTER_EXIT: '2' } },
      // No name: this machine's IPv4 is no longer the default, the control plane would refuse it.
      { why: /--public-host <name> is required: players reach this server over wss under a DNS name/, args: TOKEN, early: true },
      { why: /--public-host <name> is required/, args: [...TOKEN, '--roles', 'host,verify', '--transport', 'wss'], early: true },
      { why: /--public-host 203\.0\.113\.7 is an IP address, .*only under a DNS name.*--allow-ip is only for a development control plane/, args: [...TOKEN, '--public-host', '203.0.113.7'], early: true },
      { why: /--public-host 2001:db8::7 is an IP address/, args: [...TOKEN, '--public-host', '[2001:db8::7]'], env: { FAKE_ADDR6: '2001:db8::7' }, early: true },
      // Nothing but a version reaches the NodeSource URL and the apt-get arguments.
      ...['22', 'v24.14.0', '26.014', '26.14.0.1', '26.x', '26;id', '$(id)', '26.14.0-1'].map((v) => ({ why: /--node-version: Node\.js 26 or newer/, args: [...name, '--node-version', v], env: HERE, early: true })),
      // In the major here: NodeSource's repository stays the one it was.
      { why: /Node\.js 26\.99\.0 is not in NodeSource's repository for this system/, not: /repository is now/, args: [...name, '--node-version', '26.99.0'], env: { ...HERE, FAKE_MADISON: '26.14.0-1nodesource1 26.9.1-1nodesource1' } },
      { why: /Node\.js 27\.99\.0 is not in NodeSource's repository .*This machine's NodeSource repository is now the one for Node\.js 27, and an apt upgrade would move Node\.js 26\.14\.0 to it unless nodejs is held: .* or with --node-version 26\.14\.0, which holds the one here/, args: [...name, '--node-version', '27.99.0'], env: { ...HERE, FAKE_MADISON: '27.1.0-1nodesource1' } },
      // The package went in, but /usr/bin/node, which the service runs, is still another Node.js.
      { why: /NodeSource's nodejs 26\.9\.1-1nodesource1 is installed, but \S+\/usr\/bin\/node, the Node\.js the service runs, is Node\.js 26\.14\.0: something other than that package provides it/, args: [...name, '--node-version', '26.9'], env: { ...HERE, FAKE_MADISON: '26.9.1-1nodesource1', FAKE_NODE_STUCK: '1' } },
      { why: /NodeSource's nodejs is installed, but \S+\/usr\/bin\/node, the Node\.js the service runs, is Node\.js 22\.11\.0:/, args: name, env: { ...HERE, FAKE_NODE: '22.11.0', FAKE_NODE_STUCK: '1' } },
    ];
    const machines = await Promise.all(cases.map(() => fakeMachine()));
    try {
      await Promise.all(cases.map((c, i) => (c.caddyfile ? machines[i].write('etc/caddy/Caddyfile', c.caddyfile) : null)));
      const runs = await Promise.all(cases.map((c, i) => machines[i].run(c.args, c.env)));
      for (const [i, c] of cases.entries()) {
        if (c.env?.FAKE_REGISTER_EXIT) {
          // The registration ran and failed: what matters is what the operator is told.
          assert.notEqual(runs[i].code, 0, show(runs[i]));
          assert.match(runs[i].err, c.why, show(runs[i]));
          continue;
        }
        await refused(machines[i], runs[i], c.why);
        if (c.not) assert.doesNotMatch(runs[i].err, c.not, show(runs[i]));
        if (c.caddyfile) assert.equal(await machines[i].read('etc/caddy/Caddyfile'), c.caddyfile, 'the other sites stay');
        if (c.early) assert.deepEqual(runs[i].log, [], `it stops before installing anything:\n${show(runs[i])}`);
      }
      assert.ok(!runs[3].log.some((l) => l.startsWith('getent ') && !l.startsWith('getent -s dns ')), 'DNS only, never /etc/hosts');
    } finally {
      await Promise.all(machines.map((m) => m.cleanup()));
    }
  });

  test('a host over rtc and a verifier that does not host register with no name', async () => {
    const [rtc, verifier] = await Promise.all([fakeMachine(), fakeMachine()]);
    try {
      const [rRtc, rVerifier] = await Promise.all([rtc.run([...TOKEN, '--transport', 'rtc']), verifier.run([...TOKEN, '--roles', 'verify'])]);
      for (const [m, r, tail] of [[rtc, rRtc, / --roles host --transport rtc$/], [verifier, rVerifier, / --roles verify$/]]) {
        assert.equal(r.code, 0, show(r));
        const reg = r.log.filter((l) => l.startsWith('runuser '));
        assert.equal(reg.length, 1, show(r));
        assert.match(reg[0], tail);
        assert.equal(await m.read('etc/caddy/Caddyfile'), null, 'no Caddy without wss');
      }
    } finally {
      await Promise.all([rtc.cleanup(), verifier.cleanup()]);
    }
  });

  test('--node-version: kept when it matches, else the newest NodeSource package that fits, over a newer or held one, then held unless it is a major alone; a re-run that changes Node.js restarts the node', async () => {
    const m = await fakeMachine();
    try {
      // apt-cache madison's order, not the version order; a distribution package is never taken.
      const node = { ...HERE, FAKE_NODE: '26.14.0', FAKE_MADISON: '26.9.0-1nodesource1 26.14.0-1nodesource1 26.9.1-1nodesource1 26.9.2+dfsg-1ubuntu1' };
      const nodesource = (r) => r.log.filter((l) => l.includes('nodesource') || l.includes('nodejs'));
      const kept = await m.run([...NAMED, '--node-version', '26'], node);
      assert.equal(kept.code, 0, show(kept));
      assert.match(kept.out, /==> Node\.js 26\.14\.0 \(--node-version 26\)\n/);
      assert.deepEqual(nodesource(kept), [], show(kept));
      assert.ok(registered(kept));
      assert.match(kept.log.find((l) => l.startsWith('runuser ')), /^runuser -u turbogol -- \S+\/usr\/bin\/node \S+\/launcher\.mjs register /, 'it registers on the Node.js the service runs');
      assert.match(await execStart(m), /^ExecStart=\S+\/usr\/bin\/node \S+\/launcher\.mjs run /);

      const running = { ...node, FAKE_ACTIVE: 'caddy turbogol-node' };
      const older = await m.run([...RERUN, '--node-version', '26.9'], running);
      assert.equal(older.code, 0, show(older));
      assert.deepEqual(nodesource(older), [
        'curl https://deb.nodesource.com/setup_26.x',
        'apt-get -o DPkg::Lock::Timeout=600 install -y -qq --allow-downgrades --allow-change-held-packages nodejs=26.9.1-1nodesource1',
        'apt-mark hold nodejs',
      ]);
      assert.match(older.out, /==> Node\.js 26\.9\.1 \(--node-version 26\.9; held with apt-mark hold\)\n/);
      assert.ok(restarted(older), `the node restarts on the new Node.js:\n${show(older)}`);
      assert.match(older.out, /restarts with the new Node\.js, launcher or settings/);

      // Already there: nothing installed, but held all the same (an apt upgrade would move it).
      const same = await m.run([...RERUN, '--node-version', '26.9.1'], running);
      assert.equal(same.code, 0, show(same));
      assert.deepEqual(nodesource(same), ['apt-mark hold nodejs'], show(same));
      assert.match(same.out, /nothing changed: not restarted/);

      // Another major: its own repository, and a major alone is not held.
      const next = await m.run([...RERUN, '--node-version', '27'], { ...running, FAKE_MADISON: '27.0.0-1nodesource1 27.1.0-1nodesource1' });
      assert.equal(next.code, 0, show(next));
      assert.deepEqual(nodesource(next), [
        'curl https://deb.nodesource.com/setup_27.x',
        'apt-get -o DPkg::Lock::Timeout=600 install -y -qq --allow-downgrades --allow-change-held-packages nodejs=27.1.0-1nodesource1',
      ]);
      assert.match(next.out, /==> Node\.js 27\.1\.0 \(--node-version 27\)\n/);
      assert.ok(restarted(next), show(next));
    } finally {
      await m.cleanup();
    }
  });

  test('no --node-version: a Node.js older than 26 becomes NodeSource\'s 26, and a re-run restarts the node on it', async () => {
    const m = await fakeMachine();
    try {
      const nodesource = (r) => r.log.filter((l) => l.includes('nodesource') || l.includes('nodejs'));
      const first = await m.run(NAMED, HERE);
      assert.equal(first.code, 0, show(first));
      assert.deepEqual(nodesource(first), [], 'Node.js 26.14.0 is kept');

      const running = { ...HERE, FAKE_ACTIVE: 'caddy turbogol-node' };
      const old = await m.run(RERUN, { ...running, FAKE_NODE: '22.11.0' });
      assert.equal(old.code, 0, show(old));
      assert.deepEqual(nodesource(old), ['curl https://deb.nodesource.com/setup_26.x', 'apt-get -o DPkg::Lock::Timeout=600 install -y -qq nodejs'], 'and never held');
      assert.ok(restarted(old), `the node restarts on Node.js 26:\n${show(old)}`);
      assert.match(old.out, /restarts with the new Node\.js, launcher or settings/);

      const again = await m.run(RERUN, { ...running, FAKE_NODE: '22.11.0' });
      assert.equal(again.code, 0, show(again));
      assert.deepEqual(nodesource(again), [], show(again));
      assert.match(again.out, /nothing changed: not restarted/);
    } finally {
      await m.cleanup();
    }
  });

  test('a name may lead to any public address of this machine, over IPv4 and IPv6; the Caddy package\'s example is replaced', async () => {
    const example = '# The Caddyfile is an easy way to configure your Caddy web server.\n:80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n';
    const [failover, plain] = await Promise.all([fakeMachine(), fakeMachine()]);
    try {
      await plain.write('etc/caddy/Caddyfile', example);
      const name = [...TOKEN, '--public-host', 'sp1.turbo-gol.com'];
      const [rFailover, rPlain] = await Promise.all([
        // whoami sees 203.0.113.7; the record names 203.0.113.8, a second address of this machine.
        failover.run(name, { FAKE_A: '203.0.113.8', FAKE_ADDR4: '10.0.0.5 203.0.113.8', FAKE_AAAA: '2001:db8::7', FAKE_ADDR6: '2001:db8::7' }),
        // No AAAA record: glibc answers ahostsv6 with the A record mapped, which is no AAAA record.
        plain.run(name, { FAKE_A: '203.0.113.7', FAKE_CADDY_MD5: md5(example), FAKE_SS: 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=811,fd=7))' }),
      ]);
      for (const [m, r] of [[failover, rFailover], [plain, rPlain]]) {
        assert.equal(r.code, 0, show(r));
        assert.ok(r.log.some((l) => / --public-url wss:\/\/sp1\.turbo-gol\.com$/.test(l) && l.startsWith('runuser ')), show(r));
        assert.ok(directives(await m.read('etc/caddy/Caddyfile')).includes('sp1.turbo-gol.com {'));
      }
      assert.ok(rPlain.log.includes('getent -s dns ahostsv6 sp1.turbo-gol.com'), show(rPlain));
    } finally {
      await Promise.all([failover.cleanup(), plain.cleanup()]);
    }
  });
});
