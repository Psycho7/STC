import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import { deriveReplicaEdges } from "../../../src/solver/bisim/derive-edges";
import type { RecipeGraph, Replica } from "../../../src/solver/types";

const recipeIron = {
  id: "iron",
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "iron", qty: 1 }],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;
const recipePlate = {
  id: "plate",
  in: [{ item: "iron", qty: 2 }],
  out: [{ item: "plate", qty: 1 }],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;

function makeGraph(): RecipeGraph {
  const nodes = new Map<string, Recipe>([
    ["iron", recipeIron],
    ["plate", recipePlate],
  ]);
  const outgoing = new Map<
    string,
    { id: string; source: string; target: string; item: string }[]
  >();
  const incoming = new Map<
    string,
    { id: string; source: string; target: string; item: string }[]
  >();
  outgoing.set("iron", [
    { id: "iron:iron->plate", source: "iron", target: "plate", item: "iron" },
  ]);
  outgoing.set("plate", []);
  incoming.set("plate", [
    { id: "iron:iron->plate", source: "iron", target: "plate", item: "iron" },
  ]);
  incoming.set("iron", []);
  return {
    nodes,
    outgoing,
    incoming,
    depthToItem: new Map(),
    depthToRecipe: new Map(),
  };
}

function rep(
  id: string,
  recipeId: string,
  rate: Fraction,
  consumerPath: string[] = [],
): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath,
    blueprintGroupId: "g",
    sharedAtArticulation: false,
  };
}

describe("deriveReplicaEdges", () => {
  it("emits one edge per per-consumer producer-consumer pair (consumer-side rate)", () => {
    const replicas = [
      rep("r:plate#0", "plate", new Fraction(3)),
      rep("r:iron#1", "iron", new Fraction(6), ["r:plate#0"]),
    ];
    const edges = deriveReplicaEdges(makeGraph(), replicas);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: "r:iron#1",
      target: "r:plate#0",
      item: "iron",
    });
    // Consumer-side demand: plate rate * in.qty = 3 * 2 = 6 items/sec
    expect(edges[0]!.rate.equals(new Fraction(6))).toBe(true);
  });

  it("articulation-shared producer fans out to every consumer", () => {
    const replicas = [
      rep("r:plate#0", "plate", new Fraction(3)),
      rep("r:plate#1", "plate", new Fraction(2)),
      {
        ...rep("r:iron#shared", "iron", new Fraction(10)),
        sharedAtArticulation: true,
      },
    ];
    const edges = deriveReplicaEdges(makeGraph(), replicas);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.source === "r:iron#shared")).toBe(true);
    const targets = edges.map((e) => e.target).sort();
    expect(targets).toEqual(["r:plate#0", "r:plate#1"]);
  });
});
