/**
 * Cloudflare's proxy in front of a community server (Terms, Annex B, point 6: a host may use for
 * its server the machine it rents, and give no one else the players' data). The proxy opens every
 * player's connection: it sees their IP address, their controls and the ticket, with their name and
 * account id. The project's own servers may sit behind it; a community server never does:
 *
 *   - install.sh takes --allow-proxied only for a name under the project's domain, which no
 *     community server may have (hostPolicy.ts RESERVED_HOST_DOMAIN), and without it refuses a
 *     name that resolves to these addresses;
 *   - the registry refuses a community registration whose name resolves to them, before the token
 *     is spent (registry.ts CommunityRules.behindProxy, the NodeRegistryDO's), and when the lookup
 *     fails too: the installer can be run again with the same code.
 *
 * The lookup is DNS over HTTPS (Cloudflare's resolver, JSON), through the object's fetch: a
 * Worker has no resolver of its own. Its answers are read for A and AAAA records only (a CNAME's
 * target comes with them). The address lists are install.sh's CLOUDFLARE_V4 and CLOUDFLARE_V6
 * (https://www.cloudflare.com/ips-v4/ and /ips-v6/), pinned equal by nodes/test/install-sh.test.mjs.
 */
import { ipv4Bytes, ipv6Words } from './nodeWatch';
import type { FetchFn } from './nodeAlerts';

/** Cloudflare's proxy addresses, IPv4 (install.sh CLOUDFLARE_V4). */
export const CLOUDFLARE_V4: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

/** Cloudflare's proxy addresses, IPv6 (install.sh CLOUDFLARE_V6). */
export const CLOUDFLARE_V6: readonly string[] = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

/** The resolver the object asks (DNS over HTTPS, its JSON form). */
export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
/** How long one lookup waits. */
export const DOH_TIMEOUT_MS = 5_000;

/** `ip` (dotted IPv4, or IPv6) is in `cidr` of the same version. */
function inNet(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const v4 = ipv4Bytes(ip);
  const nv4 = ipv4Bytes(base);
  if (v4 !== null || nv4 !== null) {
    if (v4 === null || nv4 === null) return false;
    const num = (b: number[]) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (num(v4) & mask) === (num(nv4) & mask);
  }
  const w = ipv6Words(ip);
  const nw = ipv6Words(base);
  if (w === null || nw === null) return false;
  for (let i = 0, left = bits; left > 0; i++, left -= 16) {
    const take = Math.min(16, left);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((w[i] & mask) !== (nw[i] & mask)) return false;
  }
  return true;
}

/** `ip` is one of Cloudflare's proxy addresses. */
export function inCloudflare(ip: string): boolean {
  const list = ip.includes(':') ? CLOUDFLARE_V6 : CLOUDFLARE_V4;
  return list.some((c) => inNet(ip, c));
}

/** The addresses DNS gives for `name` (A or AAAA; [] when it has none), or null when the lookup failed. */
export type DnsAnswers = (name: string, type: 'A' | 'AAAA') => Promise<string[] | null>;

/**
 * DnsAnswers over DNS over HTTPS (DOH_URL, through `fetchFn`): a NOERROR answer's records of that
 * type, none for a name that does not exist (NXDOMAIN), null for anything else (another status, an
 * answer that is not JSON, a network error, DOH_TIMEOUT_MS without one).
 */
export function dohAnswers(fetchFn: FetchFn, timeoutMs: number = DOH_TIMEOUT_MS): DnsAnswers {
  return async (name, type) => {
    try {
      const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetchFn(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const b = (await res.json()) as { Status?: unknown; Answer?: unknown };
      if (b.Status === 3) return [];
      if (b.Status !== 0) return null;
      const code = type === 'A' ? 1 : 28;
      const answers = Array.isArray(b.Answer) ? (b.Answer as Array<{ type?: unknown; data?: unknown }>) : [];
      return answers.filter((a) => a.type === code && typeof a.data === 'string').map((a) => a.data as string);
    } catch {
      return null;
    }
  };
}

/**
 * Whether `host` resolves to Cloudflare's proxy: true when any of its A or AAAA records is one of
 * its addresses, false when none is (a name with no records too: its probe will fail anyway), null
 * when either lookup failed.
 */
export async function behindCloudflare(host: string, answers: DnsAnswers): Promise<boolean | null> {
  const [a, aaaa] = await Promise.all([answers(host, 'A'), answers(host, 'AAAA')]);
  if (a === null || aaaa === null) return null;
  return [...a, ...aaaa].some(inCloudflare);
}
