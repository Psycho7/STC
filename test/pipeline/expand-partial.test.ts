import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, Machine, Recipe } from "@aef/schema";
import { expandMultipliers } from "../../src/pipeline/expand";
import type { LogicalGraph } from "../../src/canvas/layout";
import type { MachineRecipeVertex } from "../../src/pipeline/types";
import type { Replica } from "../../src/solver/types";

const itemById = new Map<string, Item>([
  [
    "x",
    {
      id: "x",
      name: "x",
      transportKind: "belt",
      raw: false,
    } as unknown as Item,
  ],
]);

// LogicalRecipeNode.id is the safeId of the replica id; the lookup inside
// expandMultipliers does `replicaByLogicalId.get(n.id)` where the map is
// keyed by safeId(replica.id). Using "r1" as both logical-node id and
// replica id ensures the new idealCount path actually fires in the test.
function logicalWithMultiplier(mult: number): LogicalGraph {
  return {
    nodes: [
      {
        kind: "recipe",
        id: "r1",
        recipe: {
          id: "r1",
          in: [],
          out: [{ item: "x", qty: 1 }],
          producers: ["m"],
          time: 1,
        } as unknown as Recipe,
        multiplier: mult,
        expanded: false,
      },
    ],
    edges: [],
  };
}

function replica(id: string, rate: Fraction): Replica {
  return {
    id,
    recipeId: "r1",
    executionRate: rate,
    consumerPath: [],
    blueprintGroupId: "g",
    sharedAtArticulation: false,
  };
}

describe("expandMultipliers with idealCount", () => {
  it("integer idealCount: emits N_full stamps with no partial", () => {
    const logical = logicalWithMultiplier(3);
    const replicas = [replica("r1", new Fraction(3))];
    const idealCount = new Map<string, Fraction>([["r1", new Fraction(3)]]);
    const result = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: new Map(),
      itemById,
      idealCount,
      machineById: new Map<string, Machine>([
        ["m", { id: "m", speed: 1 } as unknown as Machine],
      ]),
    });
    const stamps = result.vertices.filter((v) => v.kind === "machine");
    expect(stamps).toHaveLength(3);
    expect(
      stamps.every((v) => v.kind === "machine" && v.partial !== true),
    ).toBe(true);
  });

  it("idealCount 2.5: emits 2 full stamps + 1 partial stamp at 0.5x speed", () => {
    const logical = logicalWithMultiplier(3);
    const replicas = [replica("r1", new Fraction(5, 2))];
    const idealCount = new Map<string, Fraction>([["r1", new Fraction(5, 2)]]);
    const result = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: new Map(),
      itemById,
      idealCount,
      machineById: new Map<string, Machine>([
        ["m", { id: "m", speed: 1 } as unknown as Machine],
      ]),
    });
    const stamps = result.vertices.filter(
      (v): v is MachineRecipeVertex => v.kind === "machine",
    );
    expect(stamps).toHaveLength(3);
    const fulls = stamps.filter((v) => !v.partial);
    const partials = stamps.filter((v) => v.partial === true);
    expect(fulls).toHaveLength(2);
    expect(partials).toHaveLength(1);
    expect(fulls[0]!.executionRate.equals(new Fraction(1))).toBe(true);
    expect(partials[0]!.executionRate.equals(new Fraction(1, 2))).toBe(true);
  });
});
