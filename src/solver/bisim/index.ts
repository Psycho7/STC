import { refinePartition } from "./refine";
import { emitQuotientEdges, emitQuotientReplicas } from "./quotient";
import type { ClassId, QuotientEdge, ReplicaEdge } from "./types";
import type { Replica, ReplicaId } from "../types";

export type { ClassId, QuotientEdge, ReplicaEdge };
export { deriveReplicaEdges } from "./derive-edges";

export type BisimQuotientInput = {
  replicas: ReadonlyArray<Replica>;
  edges: ReadonlyArray<ReplicaEdge>;
  pinnedReplicaIds: ReadonlySet<ReplicaId>;
};

export type BisimQuotientOutput = {
  quotientReplicas: Replica[];
  quotientEdges: QuotientEdge[];
  classByReplicaId: Map<ReplicaId, ClassId>;
  /** Maps a ClassId to its quotient replica id ("q:N"). Exposed so idempotence
   *  tests and downstream code can translate edge endpoints into the quotient
   *  namespace.
   */
  classToQuotient: Map<ClassId, ReplicaId>;
};

/**
 * Refine the replica graph to its coarsest strong-bisimulation partition, then
 * emit the resulting quotient graph.
 */
export function bisimQuotient(input: BisimQuotientInput): BisimQuotientOutput {
  const { replicas, edges, pinnedReplicaIds } = input;
  const classByReplicaId = refinePartition(replicas, edges, pinnedReplicaIds);
  const { quotientReplicas, classToQuotient } = emitQuotientReplicas(
    replicas,
    classByReplicaId,
  );
  const quotientEdges = emitQuotientEdges(edges, classByReplicaId);
  return { quotientReplicas, quotientEdges, classByReplicaId, classToQuotient };
}
