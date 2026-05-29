import Fraction from "fraction.js";
import type { ClassId, QuotientEdge, ReplicaEdge } from "./types";
import type { Replica, ReplicaId } from "../types";

const ZERO = new Fraction(0);

export type EmitReplicasResult = {
  quotientReplicas: Replica[];
  /** ClassId -> quotient replica id ("q:<classIndex>"). */
  classToQuotient: Map<ClassId, ReplicaId>;
};

/**
 * Emit one quotient Replica per equivalence class. Each field is derived from
 * the class members as follows:
 *  - executionRate = sum of the members' rates.
 *  - blueprintGroupId = "shared:<recipeId>#<classIndex>" when the members span
 *    more than one group, otherwise their common groupId. The "#<index>" suffix
 *    is required because two distinct merged classes can share the same producer
 *    recipe (their structural signatures differ over different neighbor sets),
 *    and the group container layer keys on this id. On the parser side,
 *    labelForGroup in assemble.ts strips the "#<digits>" suffix to recover the
 *    recipeId.
 *  - sharedAtArticulation = true for merged classes (K > 1) and for classes
 *    inherited from pinned singletons (every member pinned); false otherwise.
 *  - consumerPath: for K=1, translate the single member's consumerPath through
 *    classByReplicaId; for K>1, the empty array (fan-out happens in
 *    assembleLogicalGraph's shared branch).
 *  - id = "q:<classIndex>", synthetic and stable per class.
 */
export function emitQuotientReplicas(
  replicas: ReadonlyArray<Replica>,
  classByReplicaId: ReadonlyMap<ReplicaId, ClassId>,
): EmitReplicasResult {
  const membersByClass = new Map<ClassId, Replica[]>();
  for (const r of replicas) {
    const cid = classByReplicaId.get(r.id);
    if (!cid) continue;
    const arr = membersByClass.get(cid) ?? [];
    arr.push(r);
    membersByClass.set(cid, arr);
  }

  const sortedClassIds = [...membersByClass.keys()].sort();
  const classToQuotient = new Map<ClassId, ReplicaId>();
  const classIndex = new Map<ClassId, number>();
  sortedClassIds.forEach((cid, idx) => {
    classToQuotient.set(cid, `q:${idx}`);
    classIndex.set(cid, idx);
  });

  const quotientReplicas: Replica[] = [];
  for (const cid of sortedClassIds) {
    const members = membersByClass.get(cid)!;
    const recipeId = members[0]!.recipeId;
    const aggregateRate = members.reduce(
      (acc, m) => acc.add(m.executionRate),
      ZERO,
    );
    const allPinned = members.every((m) => m.sharedAtArticulation);
    const isMerge = members.length > 1;

    const distinctGroups = new Set(members.map((m) => m.blueprintGroupId));
    let blueprintGroupId: string;
    if (distinctGroups.size > 1) {
      blueprintGroupId = `shared:${recipeId}#${classIndex.get(cid)!}`;
    } else {
      blueprintGroupId = members[0]!.blueprintGroupId;
    }

    let consumerPath: ReadonlyArray<ReplicaId> = [];
    if (!isMerge) {
      consumerPath = members[0]!.consumerPath.map((origId) => {
        // Every consumerPath entry points at another replica in the same bisim
        // input (the replicatePerConsumer invariant), so both lookups have to
        // succeed. A miss means that invariant has broken, so throw instead of
        // emitting a stale pre-quotient id that would silently orphan the
        // producer in assembleLogicalGraph.
        const c = classByReplicaId.get(origId);
        if (!c) {
          throw new Error(
            `bisim: consumerPath entry ${origId} missing from classByReplicaId; bisim input is incomplete`,
          );
        }
        const q = classToQuotient.get(c);
        if (!q) {
          throw new Error(
            `bisim: class ${c} missing from classToQuotient; partition emission is inconsistent`,
          );
        }
        return q;
      });
    }

    // A split replica's outgoingEdgeFilter has to survive into the quotient,
    // otherwise assembleLogicalGraph will re-emit the edges the filter was meant
    // to block: the deliverer class would route its production back into the SCC
    // interior instead of leaving spare for the synthetic target output edge
    // that deriveBoundaryProducts adds. Class members are bisim-equivalent, so
    // the first member's filter stands in for all of them; carry it through
    // verbatim. An empty Set is meaningful (a deliverer with only the synthetic
    // target) and is preserved as-is.
    const outgoingEdgeFilter = members[0]!.outgoingEdgeFilter;

    const replica: Replica = {
      id: classToQuotient.get(cid)!,
      recipeId,
      executionRate: aggregateRate,
      consumerPath,
      blueprintGroupId,
      sharedAtArticulation: isMerge || allPinned,
    };
    if (outgoingEdgeFilter !== undefined) {
      replica.outgoingEdgeFilter = outgoingEdgeFilter;
    }
    quotientReplicas.push(replica);
  }
  return { quotientReplicas, classToQuotient };
}

/**
 * Emit one QuotientEdge per (sourceClass, targetClass, item) triple. Its rate
 * is the sum of the underlying ReplicaEdge rates flowing on that channel.
 */
export function emitQuotientEdges(
  edges: ReadonlyArray<ReplicaEdge>,
  classByReplicaId: ReadonlyMap<ReplicaId, ClassId>,
): QuotientEdge[] {
  type Key = string;
  const accum = new Map<Key, QuotientEdge>();
  for (const e of edges) {
    const sc = classByReplicaId.get(e.source);
    const tc = classByReplicaId.get(e.target);
    if (!sc || !tc) continue;
    const key: Key = `${sc}\x1F${tc}\x1F${e.item}`;
    const existing = accum.get(key);
    if (existing) {
      existing.rate = existing.rate.add(e.rate);
    } else {
      accum.set(key, {
        sourceClass: sc,
        targetClass: tc,
        item: e.item,
        rate: e.rate,
      });
    }
  }
  return [...accum.values()].sort((a, b) => {
    if (a.sourceClass !== b.sourceClass)
      return a.sourceClass < b.sourceClass ? -1 : 1;
    if (a.targetClass !== b.targetClass)
      return a.targetClass < b.targetClass ? -1 : 1;
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    return 0;
  });
}
