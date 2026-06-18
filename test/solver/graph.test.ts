import { describe, it, expect } from "vitest";
import type { Recipe, RecipePack } from "@aef/schema";
import { buildRecipeGraph } from "../../src/solver/graph";
import { UnknownRecipeError } from "../../src/solver/types";
import type { Target } from "../../src/data/targets";

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

function tgt(recipeId: string): Target {
  return { recipeId, ratePerSec: { num: "1", denom: "1" } };
}

describe("buildRecipeGraph", () => {
  it("returns a single-node graph for a target with no upstream", () => {
    const p = pack([makeRecipe("root", [], ["root_out"])]);
    const g = buildRecipeGraph([tgt("root")], p);
    expect([...g.nodes.keys()]).toEqual(["root"]);
    expect(g.outgoing.get("root")).toEqual([]);
  });

  it("walks a linear chain upstream", () => {
    const p = pack([
      makeRecipe("a", [], ["x"]),
      makeRecipe("b", ["x"], ["y"]),
      makeRecipe("c", ["y"], ["z"]),
    ]);
    const g = buildRecipeGraph([tgt("c")], p);
    expect([...g.nodes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(g.outgoing.get("a")?.map((e) => e.target)).toEqual(["b"]);
    expect(g.outgoing.get("b")?.map((e) => e.target)).toEqual(["c"]);
  });

  it("selects multi-producer item by lex-min recipeId", () => {
    const p = pack([
      makeRecipe("alt_z", [], ["z"]),
      makeRecipe("aaa_z", [], ["z"]),
      makeRecipe("consumer", ["z"], ["out"]),
    ]);
    const g = buildRecipeGraph([tgt("consumer")], p);
    expect(g.nodes.has("aaa_z")).toBe(true);
    expect(g.nodes.has("alt_z")).toBe(false);
  });

  it("excludes cost === -1 producers unless they are the target", () => {
    const p = pack([
      makeRecipe("clean_z", [], ["z"], { cost: -1 } as Partial<Recipe>),
      makeRecipe("normal_z", [], ["z"]),
      makeRecipe("consumer", ["z"], ["out"]),
    ]);
    const g = buildRecipeGraph([tgt("consumer")], p);
    expect(g.nodes.has("normal_z")).toBe(true);
    expect(g.nodes.has("clean_z")).toBe(false);
  });

  it("permits cost === -1 when it IS the target", () => {
    const p = pack([
      makeRecipe("sink", ["w"], [], { cost: -1 } as Partial<Recipe>),
      makeRecipe("waste_producer", [], ["w"]),
    ]);
    const g = buildRecipeGraph([tgt("sink")], p);
    expect(g.nodes.has("sink")).toBe(true);
  });

  it("throws UnknownRecipeError for unresolved target id", () => {
    const p = pack([makeRecipe("a", [], ["x"])]);
    expect(() => buildRecipeGraph([tgt("nonexistent")], p)).toThrow(
      UnknownRecipeError,
    );
  });
});
