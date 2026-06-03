import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  emitQuotientReplicas,
  emitQuotientEdges,
} from "../../../src/solver/bisim/quotient";
import type { ClassId, ReplicaEdge } from "../../../src/solver/bisim/types";
import type { Replica, ReplicaId } from "../../../src/solver/types";

function rep(
  id: string,
  recipeId: string,
  rate: Fraction,
  opts?: Partial<Replica>,
): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath: [],
    blueprintGroupId: "g",
    sharedAtArticulation: false,
    ...opts,
  };
}

describe("emitQuotientReplicas", () => {
  it("class of size 1 inherits everything but gets synthetic id", () => {
    // r:other must be in `replicas` so its class c:9 ends up in
    // classToQuotient and consumerPath translation produces a real id (not undefined).
    const replicas = [
      rep("r:a", "ra", new Fraction(2), {
        consumerPath: ["r:other"],
        blueprintGroupId: "target:x",
      }),
      rep("r:other", "other", new Fraction(1)),
    ];
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:a", "c:0" as ClassId],
      ["r:other", "c:9" as ClassId],
    ]);
    const { quotientReplicas, classToQuotient } = emitQuotientReplicas(
      replicas,
      classByReplicaId,
    );
    expect(quotientReplicas).toHaveLength(2);
    const q = quotientReplicas.find((r) => r.recipeId === "ra")!;
    expect(q.executionRate.equals(new Fraction(2))).toBe(true);
    expect(q.blueprintGroupId).toBe("target:x");
    const translated = classToQuotient.get("c:9" as ClassId);
    expect(translated).toBeDefined();
    expect(q.consumerPath).toEqual([translated]);
  });

  it("class of size > 1 aggregates rate, sets sharedAtArticulation=true and clears consumerPath", () => {
    const replicas = [
      rep("r:a", "ra", new Fraction(2)),
      rep("r:b", "ra", new Fraction(3)),
    ];
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:a", "c:0" as ClassId],
      ["r:b", "c:0" as ClassId],
    ]);
    const { quotientReplicas } = emitQuotientReplicas(
      replicas,
      classByReplicaId,
    );
    expect(quotientReplicas).toHaveLength(1);
    const q = quotientReplicas[0]!;
    expect(q.executionRate.equals(new Fraction(5))).toBe(true);
    expect(q.sharedAtArticulation).toBe(true);
    expect(q.consumerPath).toEqual([]);
  });

  it("cross-group merged class uses synthetic blueprintGroupId", () => {
    const replicas = [
      rep("r:a", "ra", new Fraction(1), { blueprintGroupId: "target:x" }),
      rep("r:b", "ra", new Fraction(1), { blueprintGroupId: "target:y" }),
    ];
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:a", "c:0" as ClassId],
      ["r:b", "c:0" as ClassId],
    ]);
    const { quotientReplicas } = emitQuotientReplicas(
      replicas,
      classByReplicaId,
    );
    expect(quotientReplicas[0]!.blueprintGroupId).toMatch(/^shared:ra#\d+$/);
  });

  // A split-replica's outgoingEdgeFilter must survive the quotient. Without
  // this, the deliverer class re-acquires all recipe-graph outgoing edges in
  // assembleLogicalGraph and routes its production back to the looper's
  // downstream instead of out via the synthetic target boundary edge; the
  // user-visible symptom is "no output from <SCC-self target>".
  it("preserves outgoingEdgeFilter from class members", () => {
    const filter = new Set(["seed|planter"]);
    const replicas = [
      rep("r:looper", "picker", new Fraction(1), {
        outgoingEdgeFilter: filter,
      }),
    ];
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:looper", "c:0" as ClassId],
    ]);
    const { quotientReplicas } = emitQuotientReplicas(
      replicas,
      classByReplicaId,
    );
    expect(quotientReplicas[0]!.outgoingEdgeFilter).toEqual(filter);
  });

  it("preserves empty outgoingEdgeFilter (deliverer with synthetic target only)", () => {
    const empty = new Set<string>();
    const replicas = [
      rep("r:deliverer", "picker", new Fraction(1), {
        outgoingEdgeFilter: empty,
      }),
    ];
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:deliverer", "c:0" as ClassId],
    ]);
    const { quotientReplicas } = emitQuotientReplicas(
      replicas,
      classByReplicaId,
    );
    expect(quotientReplicas[0]!.outgoingEdgeFilter).toBeDefined();
    expect(quotientReplicas[0]!.outgoingEdgeFilter!.size).toBe(0);
  });
});

describe("emitQuotientEdges", () => {
  it("collapses parallel underlying edges into one quotient edge with summed rate", () => {
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:a", "c:src" as ClassId],
      ["r:b", "c:src" as ClassId],
      ["r:c", "c:dst" as ClassId],
      ["r:d", "c:dst" as ClassId],
    ]);
    const edges: ReplicaEdge[] = [
      { source: "r:a", target: "r:c", item: "iron", rate: new Fraction(1) },
      { source: "r:b", target: "r:d", item: "iron", rate: new Fraction(2) },
    ];
    const result = emitQuotientEdges(edges, classByReplicaId);
    expect(result).toHaveLength(1);
    expect(result[0]!.rate.equals(new Fraction(3))).toBe(true);
  });

  it("distinct items between same class pair emit distinct edges", () => {
    const classByReplicaId = new Map<ReplicaId, ClassId>([
      ["r:a", "c:src" as ClassId],
      ["r:c", "c:dst" as ClassId],
    ]);
    const edges: ReplicaEdge[] = [
      { source: "r:a", target: "r:c", item: "iron", rate: new Fraction(1) },
      { source: "r:a", target: "r:c", item: "copper", rate: new Fraction(1) },
    ];
    const result = emitQuotientEdges(edges, classByReplicaId);
    expect(result).toHaveLength(2);
  });
});
