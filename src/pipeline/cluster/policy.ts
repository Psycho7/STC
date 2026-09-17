import type {
  ContainerId,
  ContainerSet,
  LoopBoxContainer,
  Container,
  ClusteringPolicy,
  ClusteringPolicyInput,
} from "../types";
import type {
  RecipeEdge,
  RecipeGraph,
  ReplicaId,
  Scc,
} from "../../solver/types";
import type { LogicalGraph } from "../../canvas/layout";
import { logicalNodeIdForReplica } from "../../solver/replicate";
import { tarjanScc } from "../../solver/scc";
import { itemOfPort } from "../render/port-ids";
import { pushInto } from "../../util/multimap";

export type { ClusteringPolicy };

/**
 * The simplest clustering policy we run today. It boxes up loops and nothing
 * else: one loop-box container for each non-trivial SCC (the ones with more than
 * one recipe) whose surviving replicas still induce a directed cycle in the
 * SOLVED logical graph. The static condensation alone is not enough: it is
 * built on the candidate graph, where every producer of every consumed item is
 * attached, and the LP routinely zeroes the recipes that closed the cycle. What
 * is left can be a lone survivor, or several survivors that share no edge at
 * all, and boxing either draws a "loop" that has no back edge inside it. It
 * does not make a blueprint-group container per target, so target recipes just
 * render as plain nodes on the rightmost layer next to everything else. Shared
 * utilities and any recipe that isn't part of an SCC stay at the top level.
 */
export const PillarsOnly: ClusteringPolicy = (
  input: ClusteringPolicyInput,
): ContainerSet => {
  const { logical, replicas, condensation } = input;

  const nonTrivialSccs: Scc[] = condensation.sccs.filter(
    (s) => s.recipeIds.length > 1,
  );
  const recipeToSccId = new Map<string, string>();
  for (const scc of nonTrivialSccs) {
    for (const rid of scc.recipeIds) recipeToSccId.set(rid, scc.id);
  }

  const loopMembers = new Map<string, ReplicaId[]>();
  for (const r of replicas) {
    const sccId = recipeToSccId.get(r.recipeId);
    if (sccId === undefined) continue;
    pushInto(loopMembers, sccId, r.id);
  }

  const containers: Container[] = [];
  const containerByMember = new Map<ReplicaId, ContainerId>();
  const sccIds = [...loopMembers.keys()].sort();
  for (const sccId of sccIds) {
    const members = cyclicMembers(logical, loopMembers.get(sccId) ?? []);
    if (members.length === 0) continue;

    const id = `loop:${sccId}`;
    const container: LoopBoxContainer = {
      kind: "loop-box",
      id,
      members,
      sccId,
    };
    containers.push(container);
    for (const m of members) containerByMember.set(m, id);
  }

  return { containers, containerByMember };
};

/**
 * The surviving replicas of one SCC that belong in its loop box, sorted, or an
 * empty list when the survivors induce no cycle in the solved graph.
 *
 * Only edges with both ends among the survivors count (the subgraph the box
 * would enclose). Tarjan on that subgraph returns its cyclic cores as the
 * components of more than one node; everything the cores still feed inside the
 * subgraph is drawn in too, so a member's downstream consumer does not sit
 * outside the box its producer is in. A survivor with no intra-SCC edge, or one
 * that only feeds the cycle from outside it, is not a member.
 */
function cyclicMembers(
  logical: LogicalGraph,
  survivors: ReadonlyArray<ReplicaId>,
): ReplicaId[] {
  const replicaByNodeId = new Map<string, ReplicaId>();
  for (const id of survivors) {
    replicaByNodeId.set(logicalNodeIdForReplica(id), id);
  }

  const outgoing = new Map<string, RecipeEdge[]>();
  for (const nodeId of replicaByNodeId.keys()) outgoing.set(nodeId, []);
  for (const e of logical.edges) {
    if (!replicaByNodeId.has(e.source)) continue;
    if (!replicaByNodeId.has(e.target)) continue;
    outgoing.get(e.source)!.push({
      id: e.id,
      source: e.source,
      target: e.target,
      item: itemOfPort(e.sourcePort, ["out"]),
    });
  }

  // tarjanScc reads `outgoing` only; the other two fields are there for the type.
  const induced: RecipeGraph = {
    nodes: new Map(),
    outgoing,
    incoming: new Map(),
  };
  const cores = tarjanScc(induced).filter((c) => c.recipeIds.length > 1);
  if (cores.length === 0) return [];

  const reached = new Set<string>();
  const queue: string[] = [];
  for (const core of cores) {
    for (const nodeId of core.recipeIds) {
      if (reached.has(nodeId)) continue;
      reached.add(nodeId);
      queue.push(nodeId);
    }
  }
  while (queue.length) {
    const nodeId = queue.pop()!;
    for (const e of outgoing.get(nodeId) ?? []) {
      if (reached.has(e.target)) continue;
      reached.add(e.target);
      queue.push(e.target);
    }
  }

  return [...reached].map((nodeId) => replicaByNodeId.get(nodeId)!).sort();
}
