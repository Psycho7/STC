import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { refinePartition } from "../../../src/solver/bisim/refine";
import type { ReplicaEdge } from "../../../src/solver/bisim/types";
import type { Replica, ReplicaId } from "../../../src/solver/types";

function rep(id: string, recipeId: string, shared = false): Replica {
  return {
    id,
    recipeId,
    executionRate: new Fraction(1),
    consumerPath: [],
    blueprintGroupId: "g",
    sharedAtArticulation: shared,
  };
}

describe("refinePartition", () => {
  it("no-op: distinct recipes, each replica its own class", () => {
    const replicas = [rep("r:a", "ra"), rep("r:b", "rb")];
    const edges: ReplicaEdge[] = [];
    const pinned = new Set<ReplicaId>();
    const result = refinePartition(replicas, edges, pinned);
    expect(new Set(result.values()).size).toBe(2);
    expect(result.get("r:a")).not.toBe(result.get("r:b"));
  });

  it("pinned replicas are singleton classes from P0", () => {
    const replicas = [rep("r:a", "ra", true), rep("r:b", "ra", true)];
    const pinned = new Set<ReplicaId>(["r:a", "r:b"]);
    const result = refinePartition(replicas, [], pinned);
    expect(result.get("r:a")).not.toBe(result.get("r:b"));
  });

  it("merges two replicas of same recipe with identical neighbor multisets", () => {
    // Two iron-plate replicas fed by ONE shared pinned ore producer. Each
    // plate replica's sig is (plate, in={(ore, c:pinned:r:ore)}, out={}), so
    // they share an identical signature and must merge into one class.
    const replicas = [
      { ...rep("r:ore", "ore", true), id: "r:ore" },
      rep("r:p1", "plate"),
      rep("r:p2", "plate"),
    ];
    const pinned = new Set<ReplicaId>(["r:ore"]);
    const edges: ReplicaEdge[] = [
      { source: "r:ore", target: "r:p1", item: "ore", rate: new Fraction(1) },
      { source: "r:ore", target: "r:p2", item: "ore", rate: new Fraction(1) },
    ];
    const result = refinePartition(replicas, edges, pinned);
    // p1 and p2 have identical structural signature: same recipe, same
    // in-edge multiset { (ore, c:pinned:r:ore) }, no out-edges.
    expect(result.get("r:p1")).toBe(result.get("r:p2"));
    // ore stays a singleton class.
    expect(result.get("r:ore")).not.toBe(result.get("r:p1"));
  });

  it("does NOT merge same-recipe replicas with distinct neighbor classes", () => {
    const replicas = [
      { ...rep("r:o1", "ore", true), id: "r:o1" },
      { ...rep("r:o2", "ore", true), id: "r:o2" },
      rep("r:p1", "plate"),
      rep("r:p2", "plate"),
    ];
    const pinned = new Set<ReplicaId>(["r:o1", "r:o2"]);
    const edges: ReplicaEdge[] = [
      { source: "r:o1", target: "r:p1", item: "ore", rate: new Fraction(1) },
      { source: "r:o2", target: "r:p2", item: "ore", rate: new Fraction(1) },
    ];
    const result = refinePartition(replicas, edges, pinned);
    // p1 and p2 have DIFFERENT pinned producers in their sigs -> distinct classes.
    expect(result.get("r:p1")).not.toBe(result.get("r:p2"));
  });

  it("propagates split through multiple iterations", () => {
    // Two parallel chains A -> B -> C with distinct C neighbors:
    //   r:a1 -> r:b1 -> r:c (different consumers further down via pinning)
    //   r:a2 -> r:b2 -> r:c (same)
    // Without distinct downstream pins, a1/a2 and b1/b2 should merge.
    // Add a distinct downstream sink per chain to force separation.
    const replicas = [
      rep("r:a1", "a"),
      rep("r:a2", "a"),
      rep("r:b1", "b"),
      rep("r:b2", "b"),
      { ...rep("r:s1", "sink1", true), id: "r:s1" },
      { ...rep("r:s2", "sink2", true), id: "r:s2" },
    ];
    const pinned = new Set<ReplicaId>(["r:s1", "r:s2"]);
    const edges: ReplicaEdge[] = [
      { source: "r:a1", target: "r:b1", item: "x", rate: new Fraction(1) },
      { source: "r:a2", target: "r:b2", item: "x", rate: new Fraction(1) },
      { source: "r:b1", target: "r:s1", item: "y", rate: new Fraction(1) },
      { source: "r:b2", target: "r:s2", item: "y", rate: new Fraction(1) },
    ];
    const result = refinePartition(replicas, edges, pinned);
    // b1 and b2 differ because their out-neighbors (s1 vs s2) are distinct pinned classes.
    expect(result.get("r:b1")).not.toBe(result.get("r:b2"));
    // a1 and a2 differ because their out-neighbors (b1 vs b2) differ after b's split.
    expect(result.get("r:a1")).not.toBe(result.get("r:a2"));
  });
});
