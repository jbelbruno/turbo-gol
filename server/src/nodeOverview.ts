/**
 * What the maintainers' panel reads of the control plane (GET /nodes/admin/overview, refreshed every
 * 15 s, and GET /nodes/admin/nodes): built from the NodeRegistryDO's ControlPlane through its public
 * getters only, plus the few things the object itself holds (the channel, the outbox, the KV flags,
 * whether the ALERT webhook is set). Maintainers only: it carries the nodes' addresses, the operators'
 * account ids and the tokens' short ids (never a token), none of which goes into /nodes/status.
 */
import type { ControlPlane, ProbeResult, RegionView } from '../../nodes/control-plane/controlPlane';
import { isRetired, tokenIdOf, tokenState } from '../../nodes/control-plane/registry';
import type { NodeRecord, TokenState } from '../../nodes/control-plane/registry';
import type { BuildId, NodeRole } from '../../nodes/shared/controlProtocol';
import { REGIONS } from '../../src/net/account';
import { KV_FLAGS } from './env';
import type { KvFlag } from './env';

/** GET /nodes/mine: one of the operator's own nodes, its address and counters included. */
export function mineView(cp: ControlPlane, n: NodeRecord) {
  return {
    nodeId: n.nodeId,
    name: n.name,
    region: n.region,
    status: n.status,
    statusReason: n.statusReason,
    suspendedUntil: n.suspendedUntil,
    online: n.online,
    roles: n.roles,
    transports: n.transports,
    trusted: n.trusted,
    publicUrl: n.publicUrl,
    reachable: n.reachableAt !== null,
    active: n.active,
    capacity: n.capacity,
    tickLagP99Ms: n.tickLagP99Ms,
    egressGB: Math.round(n.egressGB * 100) / 100,
    counters: n.counters,
    version: n.build.version,
    compatible: cp.sameBuildAs(n.build),
  };
}

/** The matches the control plane holds open (not settled) per node, and how many wait for their verification. */
export function openMatches(cp: ControlPlane): { open: Map<string, number>; verifying: number } {
  const open = new Map<string, number>();
  let verifying = 0;
  for (const m of cp.matches.values()) {
    if (m.state === 'done') continue;
    open.set(m.nodeId, (open.get(m.nodeId) ?? 0) + 1);
    if (m.state === 'verifying') verifying++;
  }
  return { open, verifying };
}

/** GET /nodes/admin/nodes: every node with its address, counters and live state, and the matches held for it. */
export function adminNodeView(cp: ControlPlane, n: NodeRecord, open: ReadonlyMap<string, number>) {
  return {
    ...mineView(cp, n),
    operator: { id: n.operatorId, name: n.operatorName },
    createdAt: n.createdAt,
    lastSeen: n.lastSeen > 0 ? n.lastSeen : null,
    // When it was last heard as of its last online / offline transition: what a restart still knows (lastSeen is memory only).
    seenAt: n.seenAt ?? null,
    draining: n.draining,
    egressCapGB: n.egressCapGB,
    cpuLoad: n.cpuLoad,
    bootId: n.bootId,
    matches: open.get(n.nodeId) ?? 0,
  };
}

/** A node in the overview: the list's view and what the panel's detail shows (specs, probes, strikes, pauses, the link). */
export function overviewNode(cp: ControlPlane, n: NodeRecord, open: ReadonlyMap<string, number>) {
  const probe: ProbeResult | null = cp.probeOf(n.nodeId);
  return {
    ...adminNodeView(cp, n, open),
    build: n.build,
    specs: n.specs,
    capacityMax: n.capacityMax,
    reachableAt: n.reachableAt,
    lastProbe: probe ? { at: probe.at, ok: probe.ok, error: probe.error } : null,
    probeFailures: cp.probeStreak(n.nodeId),
    strikeTimes: n.strikeTimes,
    pauseTimes: n.pauseTimes,
    publicHost: n.publicHost ?? null,
    retiredAt: n.retiredAt ?? null,
    retiredReason: n.retiredReason ?? null,
    trustRemovedAt: n.trustRemovedAt ?? null,
    linkCuts: cp.linkCutsOf(n.nodeId),
  };
}

/** A token as the panel lists it: its short id (the start of its hash), never the token itself. */
export interface TokenView {
  id: string;
  operatorId: string;
  operatorName: string;
  region: string;
  name: string | null;
  publicHost: string | null;
  roles: NodeRole[] | null;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  revokedAt: number | null;
  state: TokenState;
}

export function tokenViews(cp: ControlPlane, now: number): TokenView[] {
  return cp.registry
    .tokenList()
    .map((t) => ({
      id: tokenIdOf(t),
      operatorId: t.operatorId,
      operatorName: t.operatorName,
      region: t.region,
      name: t.name,
      publicHost: t.publicHost ?? null,
      roles: t.roles ?? null,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      usedBy: t.usedBy,
      revokedAt: t.revokedAt ?? null,
      state: tokenState(t, now),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** A KV flag as the panel shows it: the raw value, whether it is on, and what that does (English; the panel words it itself). */
export interface FlagView {
  name: KvFlag;
  raw: string | null;
  set: boolean;
  meaning: string;
}

const FLAG_ON: Record<Exclude<KvFlag, 'nodes_on'>, string> = {
  matchmaking_off: 'no new match, room or lobby (POST /api/queue and /api/lobbies answer 503)',
  do_disabled: "no new match or socket on the Worker's own servers; with the nodes on, searches wait for a node",
  vm_disabled: 'no new match goes to a community node, whatever nodes_on says',
  nodes_off: 'every /nodes/* route that reaches the control plane answers 503, the cron calls nothing',
  replays_off: 'the public replay list and viewer answer 404',
  email_off: 'no mail goes out on any lane (sign-up, reset, codes)',
  turn_cf_disabled: 'no TURN credential is minted (STUN only)',
};

/** What `raw` (the KV value) does for flag `name`, as env.ts reads it (flag(), nodesMode()). */
export function flagView(name: KvFlag, raw: string | null): FlagView {
  if (name === 'nodes_on') {
    const v = raw?.trim() ?? null;
    if (v === null || v === '' || v === '0') return { name, raw, set: false, meaning: 'off: no match goes to a community node' };
    if (v === '1') return { name, raw, set: true, meaning: 'every player: their Casual and ranked matches may go to a node' };
    const ids = new Set(v.split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{16}$/.test(s)));
    return ids.size > 0
      ? { name, raw, set: true, meaning: `a canary of ${ids.size} account${ids.size === 1 ? '' : 's'}: only their matches may go to a node` }
      : { name, raw, set: false, meaning: 'unreadable, so off (a mistyped flag fails closed)' };
  }
  const set = raw === '1' || raw === 'true' || raw === 'on';
  return { name, raw, set, meaning: set ? FLAG_ON[name] : 'off' };
}

export function flagViews(values: ReadonlyMap<string, string | null>): FlagView[] {
  return KV_FLAGS.map((name) => flagView(name, values.get(name) ?? null));
}

/** Something the panel puts above everything else. */
export type OverviewWarning =
  | { kind: 'verifier_node_versions'; version: string; nodes: Array<{ nodeId: string; name: string; node: string }> }
  | { kind: 'trusted_off_channel'; nodeId: string; name: string; version: string; stable: string }
  | { kind: 'no_webhook' }
  | { kind: 'trust_removed'; nodeId: string; name: string; at: number };

/**
 * The warnings: trusted verifiers of one release on different Node.js versions (Node.js is not part
 * of BuildId, so the same release may simulate differently: a determinism risk); a trusted node on
 * another release than the stable channel's (its ranked matches go only where a verifier of that
 * release is online, and it stops verifying everyone else's); no ALERT webhook (no audit line nor
 * ALERT leaves the logs); nodes that lost their trust.
 */
export function warningsOf(nodes: readonly NodeRecord[], channel: { stable: string } | null, webhook: boolean): OverviewWarning[] {
  const out: OverviewWarning[] = [];
  const live = nodes.filter((n) => !isRetired(n) && n.status !== 'banned');
  const byRelease = new Map<string, NodeRecord[]>();
  for (const n of live) if (n.trusted && n.roles.includes('verify')) byRelease.set(n.build.version, [...(byRelease.get(n.build.version) ?? []), n]);
  for (const [version, vs] of byRelease) {
    if (new Set(vs.map((v) => v.specs?.node ?? '')).size > 1) out.push({ kind: 'verifier_node_versions', version, nodes: vs.map((v) => ({ nodeId: v.nodeId, name: v.name, node: String(v.specs?.node ?? '') })) });
  }
  if (channel) for (const n of live) if (n.trusted && n.build.version !== channel.stable) out.push({ kind: 'trusted_off_channel', nodeId: n.nodeId, name: n.name, version: n.build.version, stable: channel.stable });
  if (!webhook) out.push({ kind: 'no_webhook' });
  for (const n of nodes) if (!isRetired(n) && n.trustRemovedAt) out.push({ kind: 'trust_removed', nodeId: n.nodeId, name: n.name, at: n.trustRemovedAt });
  return out;
}

/** What the object hands in beside its control plane. */
export interface OverviewInput {
  now: number;
  build: BuildId;
  channel: { stable: string; minimum: string } | null;
  /** The caller (a trusted operator): its slots. */
  operator: { id: string; name: string };
  outbox: Array<{ path: string; rows: number; oldestAt: number }>;
  flags: ReadonlyMap<string, string | null>;
  webhook: boolean;
  /** The voids of the last 24 h by node and reason (the history, NodeStore.voidsSince); none before it existed. */
  voids?: Array<{ nodeId: string; reason: string; count: number }>;
}

/** GET /nodes/admin/overview. */
export function overviewOf(cp: ControlPlane, i: OverviewInput) {
  const { open, verifying } = openMatches(cp);
  const nodes = cp.registry.list();
  const names = new Map(nodes.map((n) => [n.operatorId, n.operatorName]));
  const slots = cp.registry.slots(i.operator.id);
  // The verification queue, by the build each match was played on.
  const queue = new Map<string, { build: BuildId; depth: number; oldestAt: number }>();
  for (const m of cp.matches.values()) {
    if (m.state !== 'verifying') continue;
    const k = `${m.build.version}|${m.build.protocol}|${m.build.wasmSha256}`;
    const q = queue.get(k) ?? { build: m.build, depth: 0, oldestAt: m.queuedAt };
    q.depth++;
    q.oldestAt = Math.min(q.oldestAt, m.queuedAt);
    queue.set(k, q);
  }
  const regions: RegionView[] = REGIONS.map((r) => cp.regionView(r.id));
  return {
    at: i.now,
    build: i.build,
    channel: i.channel,
    verifying,
    operator: { id: i.operator.id, name: i.operator.name, slotsUsed: slots.used, slotsMax: slots.max },
    nodes: nodes.map((n) => overviewNode(cp, n, open)),
    tokens: tokenViews(cp, i.now),
    regions,
    verifiers: nodes
      .filter((n) => n.trusted && n.roles.includes('verify') && !isRetired(n))
      .map((n) => ({ nodeId: n.nodeId, name: n.name, region: n.region, version: n.build.version, node: String(n.specs?.node ?? ''), status: n.status, online: cp.isOnline(n.nodeId), verifying: cp.verifyingOn(n.nodeId) })),
    verifyQueue: [...queue.values()].map((q) => ({ version: q.build.version, protocol: q.build.protocol, wasmSha256: q.build.wasmSha256, depth: q.depth, oldestAt: q.oldestAt })),
    outbox: { rows: i.outbox.reduce((s, r) => s + r.rows, 0), byPath: i.outbox },
    // The ledger's view of each operator that earned in the window (30 days; all time as `earned`).
    points: cp.ledger.leaderboard(i.now).map((e) => ({ ...cp.ledger.summary(e.operatorId, i.now), name: names.get(e.operatorId) ?? null })),
    flags: flagViews(i.flags),
    alerts: { webhook: i.webhook },
    warnings: warningsOf(nodes, i.channel, i.webhook),
    // node_offline, empty, unverified, a strike's lost:*...: which node's matches went void, and why.
    voids24h: (i.voids ?? []).map((v) => ({ ...v, name: nodes.find((n) => n.nodeId === v.nodeId)?.name ?? null })),
  };
}
