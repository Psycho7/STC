import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { bisimQuotient } from "../../../src/solver/bisim";
import type { Replica, ReplicaId } from "../../../src/solver/types";
import type { ReplicaEdge } from "../../../src/solver/bisim/types";

function rep(
  id: string,
  recipeId: string,
  rate: Fraction,
  shared = false,
): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath: [],
    blueprintGroupId: "g",
    sharedAtArticulation: shared,
  };
}

describe("bisimQuotient (orchestrator)", () => {
  it("no-op: distinct recipes, output matches input shape", () => {
    const replicas = [
      rep("r:a", "ra", new Fraction(1)),
      rep("r:b", "rb", new Fraction(2)),
    ];
    const edges: ReplicaEdge[] = [];
    const result = bisimQuotient({
      replicas,
      edges,
      pinnedReplicaIds: new Set(),
    });
    expect(result.quotientReplicas).toHaveLength(2);
    expect(result.quotientEdges).toHaveLength(0);
    expect(result.classByReplicaId.size).toBe(2);
  });

  it("mass conservation: sum of quotient edge rates equals sum of input edge rates", () => {
    const replicas = [
      { ...rep("r:ore", "ore", new Fraction(10), true), id: "r:ore" },
      rep("r:p1", "plate", new Fraction(1)),
      rep("r:p2", "plate", new Fraction(2)),
    ];
    const edges: ReplicaEdge[] = [
      { source: "r:ore", target: "r:p1", item: "ore", rate: new Fraction(1) },
      { source: "r:ore", target: "r:p2", item: "ore", rate: new Fraction(2) },
    ];
    const result = bisimQuotient({
      replicas,
      edges,
      pinnedReplicaIds: new Set<ReplicaId>(["r:ore"]),
    });
    const inputTotal = edges.reduce((a, e) => a.add(e.rate), new Fraction(0));
    const outputTotal = result.quotientEdges.reduce(
      (a, e) => a.add(e.rate),
      new Fraction(0),
    );
    expect(inputTotal.equals(outputTotal)).toBe(true);
  });

  it("idempotence: feeding quotient output back yields the same partition (no further merges)", () => {
    const replicas = [
      { ...rep("r:ore", "ore", new Fraction(10), true), id: "r:ore" },
      rep("r:p1", "plate", new Fraction(1)),
      rep("r:p2", "plate", new Fraction(2)),
    ];
    const edges: ReplicaEdge[] = [
      { source: "r:ore", target: "r:p1", item: "ore", rate: new Fraction(1) },
      { source: "r:ore", target: "r:p2", item: "ore", rate: new Fraction(2) },
    ];
    const r1 = bisimQuotient({
      replicas,
      edges,
      pinnedReplicaIds: new Set(["r:ore"]),
    });
    // Coerce QuotientEdge -> ReplicaEdge by translating class endpoints through
    // classToQuotient so the second pass's edge endpoints match its replica ids.
    const replicas2 = r1.quotientReplicas;
    const edges2: ReplicaEdge[] = r1.quotientEdges.map((e) => ({
      source: r1.classToQuotient.get(e.sourceClass)!,
      target: r1.classToQuotient.get(e.targetClass)!,
      item: e.item,
      rate: e.rate,
    }));
    // Pin the quotient replicas inherited from pinned inputs.
    const pinned2 = new Set<ReplicaId>(
      replicas2.filter((r) => r.sharedAtArticulation).map((r) => r.id),
    );
    const r2 = bisimQuotient({
      replicas: replicas2,
      edges: edges2,
      pinnedReplicaIds: pinned2,
    });
    // Partition stability: second pass yields one class per input replica
    // (every class is a singleton) AND the number of quotient replicas does
    // not change.
    expect(r2.quotientReplicas.length).toBe(replicas2.length);
    const distinctClasses = new Set(r2.classByReplicaId.values());
    expect(distinctClasses.size).toBe(replicas2.length);
  });

  it("aggregated executionRate equals sum of class members'", () => {
    const replicas = [
      rep("r:a", "ra", new Fraction(2)),
      rep("r:b", "ra", new Fraction(3)),
    ];
    const result = bisimQuotient({
      replicas,
      edges: [],
      pinnedReplicaIds: new Set(),
    });
    expect(result.quotientReplicas).toHaveLength(1);
    expect(
      result.quotientReplicas[0]!.executionRate.equals(new Fraction(5)),
    ).toBe(true);
  });
});
