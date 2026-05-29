import {
  canonicalEncodeNeighbors,
  type ClassId,
  type NeighborTag,
  type ReplicaEdge,
} from "./types";
import type { Replica, ReplicaId } from "../types";

/**
 * Refine a strong-bisimulation partition to a fixed point and return the
 * ReplicaId -> ClassId assignment. Pinned replicas (articulation-shared
 * producers and non-trivial SCC members) start as singleton classes and never
 * merge or split.
 *
 * The initial partition gives each pinned replica its own class and groups the
 * remaining replicas by recipeId. Each pass then freezes the current class
 * assignment, recomputes every non-pinned replica's signature against that
 * frozen snapshot, and splits any class whose members no longer agree. Passes
 * repeat until a full pass makes no split.
 *
 * Computing signatures against the frozen snapshot rather than the live map is
 * what keeps the result deterministic: the outcome does not depend on the order
 * in which classes happen to be visited within a pass.
 */
export function refinePartition(
  replicas: ReadonlyArray<Replica>,
  edges: ReadonlyArray<ReplicaEdge>,
  pinnedReplicaIds: ReadonlySet<ReplicaId>,
): Map<ReplicaId, ClassId> {
  // Index edges by source and by target so signature computation can find a
  // replica's incident edges directly.
  const outBySource = new Map<ReplicaId, ReplicaEdge[]>();
  const inByTarget = new Map<ReplicaId, ReplicaEdge[]>();
  for (const e of edges) {
    const o = outBySource.get(e.source) ?? [];
    o.push(e);
    outBySource.set(e.source, o);
    const i = inByTarget.get(e.target) ?? [];
    i.push(e);
    inByTarget.set(e.target, i);
  }
  // Index replicas by id so signature lookups inside the refinement loop are
  // O(1) rather than a linear scan over `replicas`.
  const replicaById = new Map<ReplicaId, Replica>();
  for (const r of replicas) replicaById.set(r.id, r);

  // Build the initial partition.
  const classByReplicaId = new Map<ReplicaId, ClassId>();
  let nextClassIndex = 0;
  const allocClassId = (): ClassId => `c:${nextClassIndex++}` as ClassId;

  // Pinned replicas each get their own singleton class, keyed by replicaId so
  // the ids are deterministic.
  for (const r of replicas) {
    if (pinnedReplicaIds.has(r.id)) {
      classByReplicaId.set(r.id, `c:pinned:${r.id}` as ClassId);
    }
  }
  // Group the remaining replicas by recipeId.
  const recipeGroups = new Map<string, ReplicaId[]>();
  for (const r of replicas) {
    if (pinnedReplicaIds.has(r.id)) continue;
    const arr = recipeGroups.get(r.recipeId) ?? [];
    arr.push(r.id);
    recipeGroups.set(r.recipeId, arr);
  }
  // Walk recipeIds in sorted order so the initial class ids are deterministic.
  for (const recipeId of [...recipeGroups.keys()].sort()) {
    const ids = recipeGroups.get(recipeId)!;
    const cid = allocClassId();
    for (const id of ids) classByReplicaId.set(id, cid);
  }

  // Refinement converges in at most |V| passes; the early exit on
  // `!splitHappened` stops as soon as a pass produces no split.
  for (let iter = 0; iter < replicas.length; iter++) {
    const snapshot = new Map(classByReplicaId);

    // Regroup each non-pinned class by signature, reading from the snapshot.
    const newAssignments = new Map<ReplicaId, ClassId>();
    let splitHappened = false;

    // Collect the non-pinned classes out of the snapshot.
    const membersByClass = new Map<ClassId, ReplicaId[]>();
    for (const [rid, cid] of snapshot) {
      if (pinnedReplicaIds.has(rid)) continue;
      const arr = membersByClass.get(cid) ?? [];
      arr.push(rid);
      membersByClass.set(cid, arr);
    }

    for (const [cid, members] of membersByClass) {
      if (members.length === 1) {
        newAssignments.set(members[0]!, cid);
        continue;
      }
      // Compute each member's signature.
      const sigByMember = new Map<ReplicaId, string>();
      for (const m of members) {
        const inTags: NeighborTag[] = (inByTarget.get(m) ?? []).map((e) => ({
          item: e.item,
          classId: snapshot.get(e.source)!,
        }));
        const outTags: NeighborTag[] = (outBySource.get(m) ?? []).map((e) => ({
          item: e.item,
          classId: snapshot.get(e.target)!,
        }));
        const replica = replicaById.get(m)!;
        // Separate the three top-level fields with \x1D (Group Separator) so it
        // can never collide with canonicalEncodeNeighbors' inner separators
        // (\x1F for fields, \x1E for records). This keeps the encoding injective
        // even if a later change widens the inner separator set.
        const sig = `${replica.recipeId}\x1D${canonicalEncodeNeighbors(inTags)}\x1D${canonicalEncodeNeighbors(outTags)}`;
        sigByMember.set(m, sig);
      }
      const uniqueSigs = new Set(sigByMember.values());
      if (uniqueSigs.size === 1) {
        for (const m of members) newAssignments.set(m, cid);
        continue;
      }
      // Members disagree, so split them: one fresh class id per distinct
      // signature, allocated in sorted order to stay deterministic.
      splitHappened = true;
      const sigToClass = new Map<string, ClassId>();
      const sortedSigs = [...uniqueSigs].sort();
      for (const sig of sortedSigs) sigToClass.set(sig, allocClassId());
      for (const m of members) {
        newAssignments.set(m, sigToClass.get(sigByMember.get(m)!)!);
      }
    }

    // Carry the pinned classes through unchanged.
    for (const [rid, cid] of snapshot) {
      if (pinnedReplicaIds.has(rid)) newAssignments.set(rid, cid);
    }

    // Commit this pass's assignments.
    classByReplicaId.clear();
    for (const [rid, cid] of newAssignments) classByReplicaId.set(rid, cid);

    if (!splitHappened) break;
  }

  return classByReplicaId;
}
