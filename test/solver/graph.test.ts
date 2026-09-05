import { describe, it, expect } from "vitest";
import type { Recipe, RecipePack } from "@aef/schema";
import { buildRecipeGraphMulti } from "../../src/solver/graph";
import type { ItemTarget } from "../../src/data/targets";

function makeRecipe(
  id: string,
  inItems: string[],
  outItems: string[],
  extras: Partial<Recipe> = {},
): Recipe {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    time: 1,
    in: inItems.map((item) => ({ item, qty: 1 })),
    out: outItems.map((item) => ({ item, qty: 1 })),
    producers: ["m1"],
    ...extras,
  } as Recipe;
}

function pack(recipes: Recipe[]): RecipePack {
  return {
    schemaVersion: "0.1",
    source: {
      name: "test",
      submodulePath: "",
      submoduleSha: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items: [],
    machines: [
      {
        id: "m1",
        name: "m1",
        icon: "m1",
        speed: 1,
        powerType: "electric",
        powerKw: 0,
        hideRate: false,
      },
    ],
    transports: [],
    recipes,
  } as unknown as RecipePack;
}

function tgt(itemId: string): ItemTarget {
  return { itemId, ratePerSec: { num: "1", denom: "1" } };
}

// Every leaf recipe here consumes a `feed` item no recipe produces, so the
// walk terminates on it. A leaf with an empty `in` would be an extraction
// recipe, which is excluded from the graph outright.
describe("buildRecipeGraphMulti", () => {
  it("returns a single-node graph for a target with no upstream", () => {
    const p = pack([makeRecipe("root", ["feed"], ["root_out"])]);
    const g = buildRecipeGraphMulti([tgt("root_out")], p);
    expect([...g.nodes.keys()]).toEqual(["root"]);
    expect(g.outgoing.get("root")).toEqual([]);
  });

  it("walks a linear chain upstream", () => {
    const p = pack([
      makeRecipe("a", ["feed"], ["x"]),
      makeRecipe("b", ["x"], ["y"]),
      makeRecipe("c", ["y"], ["z"]),
    ]);
    const g = buildRecipeGraphMulti([tgt("z")], p);
    expect([...g.nodes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(g.outgoing.get("a")?.map((e) => e.target)).toEqual(["b"]);
    expect(g.outgoing.get("b")?.map((e) => e.target)).toEqual(["c"]);
  });

  it("excludes cost === -1 producers of consumed items", () => {
    const p = pack([
      makeRecipe("clean_z", ["feed"], ["z"], { cost: -1 } as Partial<Recipe>),
      makeRecipe("normal_z", ["feed"], ["z"]),
      makeRecipe("consumer", ["z"], ["out"]),
    ]);
    const g = buildRecipeGraphMulti([tgt("out")], p);
    expect(g.nodes.has("normal_z")).toBe(true);
    expect(g.nodes.has("clean_z")).toBe(false);
  });

  it("never seeds an excluded producer of the target item", () => {
    const p = pack([
      makeRecipe("clean_z", ["feed"], ["z"], { cost: -1 } as Partial<Recipe>),
      makeRecipe("normal_z", ["feed"], ["z"]),
    ]);
    const g = buildRecipeGraphMulti([tgt("z")], p);
    expect(g.nodes.has("normal_z")).toBe(true);
    expect(g.nodes.has("clean_z")).toBe(false);
  });

  it("seeds nothing for a target item with no producer", () => {
    // The demand surfaces as an LP deficit instead of a graph-layer throw;
    // plan validation rejects unknown targets before they reach the solver.
    const p = pack([makeRecipe("a", ["feed"], ["x"])]);
    const g = buildRecipeGraphMulti([tgt("nonexistent")], p);
    expect(g.nodes.size).toBe(0);
  });
});
