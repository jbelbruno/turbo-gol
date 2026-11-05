/**
 * The public list of nodes, GET /nodes/status (the "Anfitriones" page): what anyone may read about
 * the nodes, built the same way by the production NodeRegistryDO and by the reference server
 * (devServer.ts). The privacy policy and the terms describe this list as it is here, so a change
 * to what it shows is a change to those texts first (docs/legal/README.md).
 *
 * Which nodes: the ones in service, probation or active, and never a retired one. A pending node
 * never proved it can be reached, a suspended or banned one hosts nothing, and a retired one is off
 * the books: none of them is a server a player could be sent to.
 *
 * What it never carries: an address (publicUrl, publicHost), a node id, an operator id or its start,
 * specs, a bootId. Who runs a node is said by publicOperatorNames, and only there: the project's
 * accounts by their name, every other operator as "Anfitrión <n>" unless it chose to show its name
 * (the opt-in, `shows`: the NodeRegistryDO's operators.show_public), the same in the nodes and in
 * the hosts' ranking.
 */
import type { BuildId, NodeRole, NodeTransport } from '../shared/controlProtocol';
import type { ControlPlane } from './controlPlane';
import { isRetired } from './registry';
import type { NodeRecord } from './registry';

/** What an operator that is not the project is called in the public list, before its number. */
export const PUBLIC_HOST_LABEL = 'Anfitrión';

export interface PublicNode {
  name: string;
  operator: string;
  region: string;
  status: 'probation' | 'active';
  online: boolean;
  roles: NodeRole[];
  transports: NodeTransport[];
  active: number;
  capacity: number;
  tickLagP99Ms: number;
  version: string;
  compatible: boolean;
  /** A project node (the project/community mark). */
  trusted: boolean;
}

export interface PublicStatus {
  build: BuildId;
  nodes: PublicNode[];
  /** The 30-day points ranking of the operators (Ledger.leaderboard), by their public name. */
  hosts: Array<{ name: string; points: number }>;
}

/** A node the public list shows (see the header). */
export function listedPublicly(n: NodeRecord): boolean {
  return (n.status === 'probation' || n.status === 'active') && !isRetired(n);
}

/**
 * The name each operator goes by in the public list. A project account (`isTrusted`) shows its
 * name: the one on its newest node, which is the account's name when it last asked for a token.
 * So does an operator that chose to (`shows`: its consent, withdrawn with the same switch, and gone
 * with its account). Any other operator is PUBLIC_HOST_LABEL and a number, never its name and never
 * its id: its name is personal data the operator has not chosen to publish, and an id is how the
 * other servers know the account. A name that is the start of its own id, or the label itself (the
 * token's fallbacks when the account's name could not be read, NodeRegistryDO token), gets a
 * number too.
 *
 * The numbers count the operators that show no name in the order they first registered a node,
 * over every record kept (retired, banned and pending ones too: records are never deleted), so a
 * number stays with its operator while its nodes come and go from the list. An operator in `more`
 * (the ranking's) with no record comes after them, in id order.
 */
export function publicOperatorNames(
  nodes: readonly NodeRecord[],
  isTrusted: (operatorId: string) => boolean,
  more: readonly string[] = [],
  shows: (operatorId: string) => boolean = () => false,
): (operatorId: string) => string {
  const first = new Map<string, number>();
  const newest = new Map<string, NodeRecord>();
  for (const n of nodes) {
    first.set(n.operatorId, Math.min(first.get(n.operatorId) ?? Infinity, n.createdAt));
    const was = newest.get(n.operatorId);
    if (!was || n.createdAt >= was.createdAt) newest.set(n.operatorId, n);
  }
  const named = new Map<string, string>();
  for (const [id, n] of newest) {
    const name = n.operatorName.trim();
    if ((isTrusted(id) || shows(id)) && name.length > 0 && name !== id.slice(0, 6) && name !== PUBLIC_HOST_LABEL) named.set(id, name);
  }
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const recorded = [...first.keys()].filter((id) => !named.has(id)).sort((a, b) => (first.get(a) as number) - (first.get(b) as number) || byId(a, b));
  const unrecorded = [...new Set(more)].filter((id) => !first.has(id)).sort(byId);
  const numbers = new Map([...recorded, ...unrecorded].map((id, i) => [id, i + 1]));
  return (id) => named.get(id) ?? (numbers.has(id) ? `${PUBLIC_HOST_LABEL} ${numbers.get(id)}` : PUBLIC_HOST_LABEL);
}

/** GET /nodes/status: the nodes in service and the hosts' ranking, as the header says (`shows`: the operators that chose to show their name). */
export function publicStatus(cp: Pick<ControlPlane, 'registry' | 'ledger' | 'currentBuild' | 'sameBuildAs'>, now: number, shows?: (operatorId: string) => boolean): PublicStatus {
  const all = cp.registry.list();
  const ranking = cp.ledger.leaderboard(now);
  const nameOf = publicOperatorNames(
    all,
    (id) => cp.registry.isTrusted(id),
    ranking.map((e) => e.operatorId),
    shows,
  );
  return {
    build: cp.currentBuild,
    nodes: all.filter(listedPublicly).map((n) => ({
      name: n.name,
      operator: nameOf(n.operatorId),
      region: n.region,
      status: n.status as PublicNode['status'],
      online: n.online,
      roles: n.roles,
      transports: n.transports,
      active: n.active,
      capacity: n.capacity.matches,
      tickLagP99Ms: n.tickLagP99Ms,
      version: n.build.version,
      compatible: cp.sameBuildAs(n.build),
      trusted: n.trusted,
    })),
    hosts: ranking.map((e) => ({ name: nameOf(e.operatorId), points: e.points })),
  };
}
