import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { walkAndSolve } from "../../src/solver/walk";
import { buildRecipeGraph } from "../../src/solver/graph";
import { tarjanScc, condense } from "../../src/solver/scc";
import { topologicalOrder } from "../../src/solver/topo";
import type { ItemOverride } from "../../src/data/plan";
import type { Target } from "../../src/data/targets";

// Synthetic three-recipe pack:
//   raw_a -> recipe_a (out: item_a)
//   item_a -> recipe_b (out: item_b)
//   item_b -> recipe_target (out: item_target)
// item_b is non-raw; we cap it via itemOverrides to exercise Layer 2
// pre-subtraction in walkAndSolve's size-1-SCC demand loop.

function mkItem(id: string, raw: boolean): Item {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    raw,
    transportKind: "belt",
  } as Item;
}

function mkRecipe(
  id: string,
  inSpecs: { item: string; qty: number }[],
  outSpecs: { item: string; qty: number }[],
): Recipe {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    time: 1,
    in: inSpecs,
    out: outSpecs,
    producers: ["m1"],
  } as Recipe;
}

function mkPack(items: Item[], recipes: Recipe[]): RecipePack {
  return {
    schemaVersion: "0.2",
    source: {
      name: "test",
      submodulePath: "",
      submoduleSha: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items,
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

function chainPack(): RecipePack {
  const items = [
    mkItem("raw_a", true),
    mkItem("item_a", false),
    mkItem("item_b", false),
    mkItem("item_target", false),
  ];
  const recipes = [
    mkRecipe(
      "recipe_a",
      [{ item: "raw_a", qty: 1 }],
      [{ item: "item_a", qty: 1 }],
    ),
    mkRecipe(
      "recipe_b",
      [{ item: "item_a", qty: 1 }],
      [{ item: "item_b", qty: 1 }],
    ),
    mkRecipe(
      "recipe_target",
      [{ item: "item_b", qty: 1 }],
      [{ item: "item_target", qty: 1 }],
    ),
  ];
  return mkPack(items, recipes);
}

function tgt(recipeId: string, num: string, denom: string): Target {
  return { recipeId, ratePerSec: { num, denom } };
}

function solveWith(
  pack: RecipePack,
  targets: Target[],
  itemOverrides?: ItemOverride[],
) {
  const g = buildRecipeGraph(targets, pack, itemOverrides);
  const sccs = tarjanScc(g);
  const c = condense(g, sccs);
  const topo = topologicalOrder(c);
  const args = { g, condensation: c, topo, targets, pack };
  return walkAndSolve(
    itemOverrides === undefined ? args : { ...args, itemOverrides },
  );
}

describe("walkAndSolve cap subtraction (Layer 2 non-SCC)", () => {
  it("(a) finite cap ABOVE demand on a non-raw item -> producer rate drops to zero", () => {
    // target demands item_b at rate 1/s. Cap item_b supply at 5/s (> demand).
    // recipe_b's only output is fully covered; its rate must collapse to 0.
    // recipe_a, in turn, sees zero downstream demand for item_a -> rate 0.
    const overrides: ItemOverride[] = [
      { itemId: "item_b", ratePerSec: { num: "5", denom: "1" } },
    ];
    const result = solveWith(
      chainPack(),
      [tgt("recipe_target", "1", "1")],
      overrides,
    );
    const bRate = result.rates.get("recipe_b");
    expect(bRate).toBeDefined();
    expect(bRate!.equals(new Fraction(0))).toBe(true);
    // recipe_a has no demand once recipe_b is zero-rate.
    const aRate = result.rates.get("recipe_a");
    expect(aRate).toBeDefined();
    expect(aRate!.equals(new Fraction(0))).toBe(true);
    // The target itself is pinned, untouched.
    expect(result.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
  });

  it("(b) finite cap BELOW demand -> producer rate reduces by the cap", () => {
    // target demands item_b at 1/s. Cap supply at 1/4 /s.
    // residual internal demand = 1 - 1/4 = 3/4; recipe_b rate = 3/4 (qty 1).
    // recipe_a follows recipe_b's downstream demand of 3/4 of item_a.
    const overrides: ItemOverride[] = [
      { itemId: "item_b", ratePerSec: { num: "1", denom: "4" } },
    ];
    const result = solveWith(
      chainPack(),
      [tgt("recipe_target", "1", "1")],
      overrides,
    );
    const bRate = result.rates.get("recipe_b");
    expect(bRate).toBeDefined();
    expect(bRate!.equals(new Fraction(3, 4))).toBe(true);
    const aRate = result.rates.get("recipe_a");
    expect(aRate).toBeDefined();
    expect(aRate!.equals(new Fraction(3, 4))).toBe(true);
  });

  it("(c) no override on a raw item -> rates identical to no-override baseline", () => {
    // Regression guard: with no itemOverrides, raw_a is Infinity (terminates
    // walk in graph builder) and item_a/item_b have no override so
    // effectiveSupply returns Fraction(0). The subtraction must be a no-op
    // and produce the same rates as today's no-cap math.
    const targets = [tgt("recipe_target", "1", "1")];
    const baseline = solveWith(chainPack(), targets);
    const withEmpty = solveWith(chainPack(), targets, []);
    for (const [rid, val] of baseline.rates) {
      const other = withEmpty.rates.get(rid);
      expect(other).toBeDefined();
      expect(other!.equals(val)).toBe(true);
    }
    // And explicit expected values: full 1-per-sec chain.
    expect(baseline.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
    expect(baseline.rates.get("recipe_b")!.equals(new Fraction(1))).toBe(true);
    expect(baseline.rates.get("recipe_a")!.equals(new Fraction(1))).toBe(true);
  });
});
