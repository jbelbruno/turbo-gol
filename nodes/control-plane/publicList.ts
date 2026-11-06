/**
 * The public list of nodes, GET /nodes/status (the "Anfitriones" page): what anyone may read about
 * the nodes, built the same way by the production NodeRegistryDO and by the reference server
 * (devServer.ts). The privacy policy and the terms describe this list as it is here, so a change
 * to what it shows is a change to those texts first (docs/legal/README.md).
 *
 * Which nodes: the ones in service, probation or active, and never a retired one, nor one of an
 * operator a maintainer blocked (`blocked`: Terms 12.4.1, "Un servidor pendiente, suspendido,
 * bloqueado o retirado no aparece"; a block is of all its servers, 12.6.2). A pending node never
 * proved it can be reached, a suspended or banned one hosts nothing, a blocked operator's ones are
 * refused at every login, and a retired one is off the books: none of them is a server a player
 * could be sent to.
 *
 * What it never carries: an address (publicUrl, publicHost), a node id, an operator id or its start,
 * specs, a bootId. Who runs a node is said by publicOperatorNames, and only there: the project's
 * accounts by their name, every other operator as "Anfitrión <n>" unless it chose to show its name
 * (the opt-in, `shows`: the NodeRegistryDO's operators.show_public), the same in the nodes and in
 * the hosts' ranking. A name is always the account's as it is now (`current`: the NodeRegistryDO
 * asks AccountsDO), never the one a record kept from its token: after a rename, someone else may
 * hold the old one.
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

/** A node in service that is not retired: what the public list shows of its operator's, unless a maintainer blocked it (shownPublicly). */
export function listedPublicly(n: NodeRecord): boolean {
  return (n.status === 'probation' || n.status === 'active') && !isRetired(n);
}

/** A node the public list shows (see the header): listedPublicly, and its operator not blocked (`blocked`; none: not asked). */
export function shownPublicly(n: NodeRecord, blocked?: (operatorId: string) => boolean): boolean {
  return listedPublicly(n) && blocked?.(n.operatorId) !== true;
}

/**
 * An operator's account name as it is now: the name, null when the account has none any more (it
 * is gone), undefined when it is not known (not asked, or AccountsDO did not answer).
 */
export type CurrentName = (operatorId: string) => string | null | undefined;

/** Who the public list names, and whose servers it leaves out (publicStatus). */
export interface PublicNames {
  /** The operators outside the project that chose to show their name (the opt-in). */
  shows?: (operatorId: string) => boolean;
  /** The account names as they are now (CurrentName): without it, only the project is named, by its records. */
  current?: CurrentName;
  /** The operators a maintainer blocked: their servers leave the list. */
  blocked?: (operatorId: string) => boolean;
}

/**
 * The name each operator goes by in the public list. A project account (`isTrusted`) shows its
 * name: the account's as it is now (`current`), or, when that is not known, the one on its newest
 * node: the last one `current` gave (the NodeRegistryDO writes it on the account's records,
 * Registry.renameOperator), or the account's name when it last asked for a token. So does an
 * operator that chose to (`shows`: its consent, withdrawn with the same switch, and gone with its
 * account), by its name
 * as it is now and only then: never a record's, which another account may hold after a rename (no
 * `current`, or not known: a number). Any other operator is PUBLIC_HOST_LABEL and a number, never
 * its name and never its id: its name is personal data the operator has not chosen to publish, and
 * an id is how the other servers know the account. A name that is the start of its own id, or the
 * label itself (the token's fallbacks when the account's name could not be read, NodeRegistryDO
 * token), gets a number too.
 *
 * Every operator has its number, named or not, in the order it first registered a node, over every
 * record kept (retired, banned and pending ones too: records are never deleted), so a number stays
 * with its operator while its nodes come and go from the list, and while it shows its name or not
 * (a project account with a name of its own is not counted). An operator in `more` (the ranking's)
 * with no record comes after them, in id order.
 */
export function publicOperatorNames(
  nodes: readonly NodeRecord[],
  isTrusted: (operatorId: string) => boolean,
  more: readonly string[] = [],
  shows: (operatorId: string) => boolean = () => false,
  current?: CurrentName,
): (operatorId: string) => string {
  const first = new Map<string, number>();
  const newest = new Map<string, NodeRecord>();
  for (const n of nodes) {
    first.set(n.operatorId, Math.min(first.get(n.operatorId) ?? Infinity, n.createdAt));
    const was = newest.get(n.operatorId);
    if (!was || n.createdAt >= was.createdAt) newest.set(n.operatorId, n);
  }
  const usable = (id: string, name: string | null | undefined): string | null => {
    const t = typeof name === 'string' ? name.trim() : '';
    return t.length > 0 && t !== id.slice(0, 6) && t !== PUBLIC_HOST_LABEL ? t : null;
  };
  const named = new Map<string, string>();
  for (const id of new Set([...first.keys(), ...more])) {
    const now = current?.(id);
    // A project account is never deleted (the NodeRegistryDO's operatorDeleted: 409 trusted), and its
    // records take each name of now (Registry.renameOperator): without one, theirs is its last known.
    const name = isTrusted(id) ? usable(id, now ?? newest.get(id)?.operatorName) : shows(id) ? usable(id, now) : null;
    if (name !== null) named.set(id, name);
  }
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const counted = (id: string): boolean => !(isTrusted(id) && named.has(id));
  const recorded = [...first.keys()].filter(counted).sort((a, b) => (first.get(a) as number) - (first.get(b) as number) || byId(a, b));
  const unrecorded = [...new Set(more)].filter((id) => !first.has(id) && counted(id)).sort(byId);
  const numbers = new Map([...recorded, ...unrecorded].map((id, i) => [id, i + 1]));
  return (id) => named.get(id) ?? (numbers.has(id) ? `${PUBLIC_HOST_LABEL} ${numbers.get(id)}` : PUBLIC_HOST_LABEL);
}

/**
 * The operators whose names the public list may show right now (a project account, or one that
 * chose to): those of a listed node or in the ranking. What the NodeRegistryDO asks AccountsDO for.
 */
export function publicNamesWanted(cp: Pick<ControlPlane, 'registry' | 'ledger'>, now: number, o: Omit<PublicNames, 'current'> = {}): string[] {
  const ids = new Set([...cp.registry.list().filter((n) => shownPublicly(n, o.blocked)).map((n) => n.operatorId), ...cp.ledger.leaderboard(now).map((e) => e.operatorId)]);
  return [...ids].filter((id) => cp.registry.isTrusted(id) || o.shows?.(id) === true);
}

/** GET /nodes/status: the nodes in service and the hosts' ranking, as the header says (PublicNames: the opt-in, the names as they are now, the blocks). */
export function publicStatus(cp: Pick<ControlPlane, 'registry' | 'ledger' | 'currentBuild' | 'sameBuildAs'>, now: number, o: PublicNames = {}): PublicStatus {
  const all = cp.registry.list();
  const ranking = cp.ledger.leaderboard(now);
  const nameOf = publicOperatorNames(
    all,
    (id) => cp.registry.isTrusted(id),
    ranking.map((e) => e.operatorId),
    o.shows,
    o.current,
  );
  return {
    build: cp.currentBuild,
    nodes: all.filter((n) => shownPublicly(n, o.blocked)).map((n) => ({
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
