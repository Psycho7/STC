import type {
  ContainerId,
  ContainerSet,
  LoopBoxContainer,
  Container,
  ClusteringPolicy,
  ClusteringPolicyInput,
} from "../types";
import type { ReplicaId, Scc } from "../../solver/types";

export type { ClusteringPolicy };

/**
 * The simplest clustering policy we run today. It boxes up loops and nothing
 * else: one loop-box container for each non-trivial SCC (the ones with more than
 * one recipe). It does not make a blueprint-group container per target, so
 * target recipes just render as plain nodes on the rightmost layer next to
 * everything else. Shared utilities and any recipe that isn't part of an SCC
 * stay at the top level.
 */
export const PillarsOnly: ClusteringPolicy = (
  input: ClusteringPolicyInput,
): ContainerSet => {
  const { replicas, condensation } = input;

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
    const arr = loopMembers.get(sccId) ?? [];
    arr.push(r.id);
    loopMembers.set(sccId, arr);
  }

  const containers: Container[] = [];
  const containerByMember = new Map<ReplicaId, ContainerId>();
  const sccIds = [...loopMembers.keys()].sort();
  for (const sccId of sccIds) {
    const members = (loopMembers.get(sccId) ?? []).slice().sort();
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
