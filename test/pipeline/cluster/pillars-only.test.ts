import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { PillarsOnly } from "../../../src/pipeline/cluster";
import type {
  Condensation,
  RecipeId,
  Replica,
  ReplicaId,
  Scc,
  SccId,
} from "../../../src/solver/types";
import type { LogicalGraph } from "../../../src/canvas/layout";

function mkReplica(args: {
  id: ReplicaId;
  recipeId: RecipeId;
  blueprintGroupId: string;
  shared?: boolean;
  rate?: number;
}): Replica {
  return {
    id: args.id,
    recipeId: args.recipeId,
    executionRate: new Fraction(args.rate ?? 1),
    consumerPath: [],
    blueprintGroupId: args.blueprintGroupId,
    sharedAtArticulation: args.shared ?? false,
  };
}

function mkCondensation(sccs: Scc[]): Condensation {
  const sccOfRecipe = new Map<RecipeId, SccId>();
  for (const s of sccs) {
    for (const rid of s.recipeIds) sccOfRecipe.set(rid, s.id);
  }
  return {
    sccs,
    sccOfRecipe,
    outgoing: new Map(),
    incoming: new Map(),
  };
}

const EMPTY_LOGICAL: LogicalGraph = { nodes: [], edges: [] };

describe("PillarsOnly: empty graph", () => {
  it("yields an empty container set", () => {
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas: [],
      condensation: mkCondensation([]),
    });
    expect(out.containers).toEqual([]);
    expect(out.containerByMember.size).toBe(0);
  });
});

describe("PillarsOnly: one acyclic chain of three recipes", () => {
  it("emits no containers (per-target blueprint-groups disabled)", () => {
    const groupId = "target:r:end";
    const replicas: Replica[] = [
      mkReplica({ id: "rep:a", recipeId: "r:a", blueprintGroupId: groupId }),
      mkReplica({ id: "rep:b", recipeId: "r:b", blueprintGroupId: groupId }),
      mkReplica({ id: "rep:c", recipeId: "r:end", blueprintGroupId: groupId }),
    ];
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation: mkCondensation([]),
    });
    expect(out.containers).toEqual([]);
    expect(out.containerByMember.size).toBe(0);
  });
});

describe("PillarsOnly: two disjoint chains", () => {
  it("emits no containers (per-target blueprint-groups disabled)", () => {
    const g1 = "target:r:end1";
    const g2 = "target:r:end2";
    const replicas: Replica[] = [
      mkReplica({ id: "rep:a1", recipeId: "r:a", blueprintGroupId: g1 }),
      mkReplica({ id: "rep:b1", recipeId: "r:end1", blueprintGroupId: g1 }),
      mkReplica({ id: "rep:a2", recipeId: "r:a", blueprintGroupId: g2 }),
      mkReplica({ id: "rep:b2", recipeId: "r:end2", blueprintGroupId: g2 }),
    ];
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation: mkCondensation([]),
    });
    expect(out.containers).toEqual([]);
    expect(out.containerByMember.size).toBe(0);
  });
});

describe("PillarsOnly: chain feeding a shared utility", () => {
  it("emits no containers (per-target blueprint-groups disabled)", () => {
    const target = "target:r:end";
    const shared = "shared:r:acid";
    const replicas: Replica[] = [
      mkReplica({ id: "rep:a", recipeId: "r:a", blueprintGroupId: target }),
      mkReplica({ id: "rep:b", recipeId: "r:end", blueprintGroupId: target }),
      mkReplica({
        id: "rep:acid",
        recipeId: "r:acid",
        blueprintGroupId: shared,
        shared: true,
      }),
    ];
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation: mkCondensation([]),
    });
    expect(out.containers).toEqual([]);
    expect(out.containerByMember.size).toBe(0);
  });
});

describe("PillarsOnly: one non-trivial SCC", () => {
  it("emits a loop-box for the SCC; non-SCC replicas remain top-level", () => {
    const target = "target:r:end";
    const sccGroup = "scc:s1";
    const replicas: Replica[] = [
      mkReplica({
        id: "rep:feed",
        recipeId: "r:feed",
        blueprintGroupId: target,
      }),
      mkReplica({ id: "rep:end", recipeId: "r:end", blueprintGroupId: target }),
      mkReplica({
        id: "rep:loop-x",
        recipeId: "r:x",
        blueprintGroupId: sccGroup,
        shared: true,
      }),
      mkReplica({
        id: "rep:loop-y",
        recipeId: "r:y",
        blueprintGroupId: sccGroup,
        shared: true,
      }),
    ];
    const condensation = mkCondensation([
      { id: "s1", recipeIds: ["r:x", "r:y"] },
    ]);
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation,
    });
    expect(out.containers).toHaveLength(1);
    const loop = out.containers[0]!;
    expect(loop.kind).toBe("loop-box");
    expect(loop.id).toBe("loop:s1");
    if (loop.kind === "loop-box") expect(loop.sccId).toBe("s1");
    expect([...loop.members].sort()).toEqual(["rep:loop-x", "rep:loop-y"]);
    expect(out.containerByMember.get("rep:loop-x")).toBe("loop:s1");
    expect(out.containerByMember.get("rep:loop-y")).toBe("loop:s1");
    // non-SCC replicas are not assigned any container
    expect(out.containerByMember.has("rep:feed")).toBe(false);
    expect(out.containerByMember.has("rep:end")).toBe(false);
  });

  it("ignores trivial (singleton) SCCs", () => {
    const target = "target:r:end";
    const replicas: Replica[] = [
      mkReplica({ id: "rep:a", recipeId: "r:a", blueprintGroupId: target }),
      mkReplica({ id: "rep:end", recipeId: "r:end", blueprintGroupId: target }),
    ];
    const condensation = mkCondensation([
      { id: "s-a", recipeIds: ["r:a"] },
      { id: "s-end", recipeIds: ["r:end"] },
    ]);
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation,
    });
    expect(out.containers).toEqual([]);
  });
});

describe("PillarsOnly: regression guard against rejected fold layers", () => {
  it("only ever emits loop-box containers (blueprint-group is no longer emitted)", () => {
    const replicas: Replica[] = [
      mkReplica({
        id: "rep:a",
        recipeId: "r:a",
        blueprintGroupId: "target:r:end1",
      }),
      mkReplica({
        id: "rep:b",
        recipeId: "r:b",
        blueprintGroupId: "target:r:end1",
      }),
      mkReplica({
        id: "rep:c",
        recipeId: "r:c",
        blueprintGroupId: "target:r:end2",
      }),
      mkReplica({
        id: "rep:d",
        recipeId: "r:d",
        blueprintGroupId: "target:r:end2",
      }),
      mkReplica({
        id: "rep:shared",
        recipeId: "r:s",
        blueprintGroupId: "shared:r:s",
        shared: true,
      }),
      mkReplica({
        id: "rep:lx",
        recipeId: "r:x",
        blueprintGroupId: "scc:s1",
        shared: true,
      }),
      mkReplica({
        id: "rep:ly",
        recipeId: "r:y",
        blueprintGroupId: "scc:s1",
        shared: true,
      }),
    ];
    const condensation = mkCondensation([
      { id: "s1", recipeIds: ["r:x", "r:y"] },
    ]);
    const out = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation,
    });
    for (const c of out.containers) {
      expect(c.kind).toBe("loop-box");
    }
    // explicit denylist for the rejected design's container kinds:
    for (const c of out.containers) {
      expect(c.kind).not.toBe("GCD-fold");
      expect(c.kind).not.toBe("densest-sub-cluster");
      expect(c.kind).not.toBe(">=2-consumers");
      expect(c.kind).not.toBe("blueprint-group");
    }
  });

  it("is deterministic: same input yields the same output", () => {
    const replicas: Replica[] = [
      mkReplica({
        id: "rep:b",
        recipeId: "r:b",
        blueprintGroupId: "target:r:zz",
      }),
      mkReplica({
        id: "rep:a",
        recipeId: "r:a",
        blueprintGroupId: "target:r:aa",
      }),
      mkReplica({
        id: "rep:c",
        recipeId: "r:c",
        blueprintGroupId: "target:r:zz",
      }),
    ];
    const a = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation: mkCondensation([]),
    });
    const b = PillarsOnly({
      logical: EMPTY_LOGICAL,
      replicas,
      condensation: mkCondensation([]),
    });
    expect(a.containers.map((c) => c.id)).toEqual(
      b.containers.map((c) => c.id),
    );
    expect(a.containers.map((c) => [...c.members])).toEqual(
      b.containers.map((c) => [...c.members]),
    );
    expect(a.containers).toEqual([]);
  });
});
