import { describe, it, expect } from "vitest";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { buildRecipeGraph } from "../../src/solver/graph";
import type { ItemOverride } from "../../src/data/plan";
import type { Target } from "../../src/data/targets";

// Synthetic helpers: build small packs that exercise the raw-termination
// path without depending on the committed AEF pack.

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

function tgt(recipeId: string): Target {
  return { recipeId, ratePerSec: { num: "1", denom: "1" } };
}

describe("buildRecipeGraph raw termination (B1)", () => {
  it("terminates at a raw input even when a producer recipe exists for it", () => {
    // copper_nugget consumes copper_ore (raw). copper_ore-liquid_water can
    // produce copper_ore (consumes liquid_water, also raw), and a synthetic
    // liquid_water producer recipe also exists. Walk must stop at copper_ore.
    const items = [
      mkItem("copper_ore", true),
      mkItem("copper_nugget", false),
      mkItem("liquid_water", true),
    ];
    const recipes = [
      mkRecipe("copper_nugget", ["copper_ore"], ["copper_nugget"]),
      mkRecipe("copper_ore-liquid_water", ["liquid_water"], ["copper_ore"]),
      mkRecipe("liquid_water", [], ["liquid_water"]),
    ];
    const g = buildRecipeGraph([tgt("copper_nugget")], mkPack(items, recipes));
    expect([...g.nodes.keys()].sort()).toEqual(["copper_nugget"]);
    expect(g.nodes.has("copper_ore-liquid_water")).toBe(false);
    expect(g.nodes.has("liquid_water")).toBe(false);
  });

  it("targeting a raw item produces a single-node graph (target is raw)", () => {
    // liquid_water item is raw, but the liquid_water recipe still exists and
    // is selected as the target. With no inputs, no upstream walk happens.
    const items = [mkItem("liquid_water", true)];
    const recipes = [mkRecipe("liquid_water", [], ["liquid_water"])];
    const g = buildRecipeGraph([tgt("liquid_water")], mkPack(items, recipes));
    expect([...g.nodes.keys()]).toEqual(["liquid_water"]);
    expect(g.outgoing.get("liquid_water")).toEqual([]);
  });

  it("non-raw mid-pipeline target walks through intermediates and stops at raw inputs", () => {
    // copper_bottle <- copper_nugget <- copper_ore (raw).
    const items = [
      mkItem("copper_ore", true),
      mkItem("copper_nugget", false),
      mkItem("copper_bottle", false),
    ];
    const recipes = [
      mkRecipe("copper_bottle", ["copper_nugget"], ["copper_bottle"]),
      mkRecipe("copper_nugget", ["copper_ore"], ["copper_nugget"]),
      mkRecipe("copper_ore-mine", [], ["copper_ore"]),
    ];
    const g = buildRecipeGraph([tgt("copper_bottle")], mkPack(items, recipes));
    expect([...g.nodes.keys()].sort()).toEqual([
      "copper_bottle",
      "copper_nugget",
    ]);
    expect(g.nodes.has("copper_ore-mine")).toBe(false);
  });

  it("falls through to producer search when the item is not flagged raw", () => {
    // No raw flags: existing behavior preserved (walk reaches every producer).
    const items = [mkItem("x", false), mkItem("y", false), mkItem("z", false)];
    const recipes = [
      mkRecipe("a", [], ["x"]),
      mkRecipe("b", ["x"], ["y"]),
      mkRecipe("c", ["y"], ["z"]),
    ];
    const g = buildRecipeGraph([tgt("c")], mkPack(items, recipes));
    expect([...g.nodes.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("buildRecipeGraph itemOverrides (B5)", () => {
  function fullPack() {
    const items = [
      mkItem("copper_ore", true),
      mkItem("copper_nugget", false),
      mkItem("liquid_water", true),
    ];
    const recipes = [
      mkRecipe("copper_nugget", ["copper_ore"], ["copper_nugget"]),
      mkRecipe("copper_ore-liquid_water", ["liquid_water"], ["copper_ore"]),
      mkRecipe("liquid_water", [], ["liquid_water"]),
    ];
    return mkPack(items, recipes);
  }

  it("plan: true on a raw item lets the walk continue through it; the next raw input becomes the boundary", () => {
    const overrides: ItemOverride[] = [{ itemId: "copper_ore", plan: true }];
    const g = buildRecipeGraph([tgt("copper_nugget")], fullPack(), overrides);
    expect([...g.nodes.keys()].sort()).toEqual([
      "copper_nugget",
      "copper_ore-liquid_water",
    ]);
    // liquid_water is raw and not overridden; the walk stops at it.
    expect(g.nodes.has("liquid_water")).toBe(false);
  });

  it("raw item with finite ratePerSec cap walks through to producers (cap is finite, deficit may need building)", () => {
    // Matrix row 3: raw + ratePerSec > 0. effectiveSupply returns a finite
    // Fraction, not Infinity, so the walk no longer terminates and producers
    // for copper_ore must be reached.
    const overrides: ItemOverride[] = [
      { itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } },
    ];
    const g = buildRecipeGraph([tgt("copper_nugget")], fullPack(), overrides);
    expect([...g.nodes.keys()].sort()).toEqual([
      "copper_nugget",
      "copper_ore-liquid_water",
    ]);
    // liquid_water remains raw with no override -> walk stops there.
    expect(g.nodes.has("liquid_water")).toBe(false);
    // The override remains addressable on the plan-side input; the render
    // pipeline reads itemOverrides directly off the plan in Stage C, so we
    // assert the input survives as a referenceable handle rather than being
    // mutated or stripped.
    expect(overrides[0]?.ratePerSec).toEqual({ num: "1", denom: "2" });
  });

  it("override with no fields beyond itemId is equivalent to no override", () => {
    const overrides: ItemOverride[] = [{ itemId: "copper_ore" }];
    const g = buildRecipeGraph([tgt("copper_nugget")], fullPack(), overrides);
    expect([...g.nodes.keys()].sort()).toEqual(["copper_nugget"]);
  });

  it("plan: true cascades only one hop; downstream raw items still terminate", () => {
    // Two raw items in a row; only the first is overridden.
    const items = [mkItem("a", true), mkItem("b", true), mkItem("c", false)];
    const recipes = [
      mkRecipe("c", ["a"], ["c"]),
      mkRecipe("a-from-b", ["b"], ["a"]),
      mkRecipe("b-mine", [], ["b"]),
    ];
    const g = buildRecipeGraph([tgt("c")], mkPack(items, recipes), [
      { itemId: "a", plan: true },
    ]);
    expect([...g.nodes.keys()].sort()).toEqual(["a-from-b", "c"]);
    expect(g.nodes.has("b-mine")).toBe(false);
  });
});

describe("buildRecipeGraph effectiveSupply termination matrix", () => {
  // Pack with a non-raw intermediate `mid` that has an in-pack producer.
  //   sink <- mid <- mid-recipe (no inputs).
  function nonRawPack() {
    const items = [mkItem("mid", false), mkItem("sink", false)];
    const recipes = [
      mkRecipe("sink", ["mid"], ["sink"]),
      mkRecipe("mid-recipe", [], ["mid"]),
    ];
    return mkPack(items, recipes);
  }

  it("matrix row 5: non-raw item with ratePerSec > 0 still continues walk (producers remain in graph)", () => {
    // Layer 2 will subtract the finite cap from demand; until then the walk
    // must keep producers reachable.
    const overrides: ItemOverride[] = [
      { itemId: "mid", ratePerSec: { num: "1", denom: "4" } },
    ];
    const g = buildRecipeGraph([tgt("sink")], nonRawPack(), overrides);
    expect([...g.nodes.keys()].sort()).toEqual(["mid-recipe", "sink"]);
  });

  it("matrix row 6: non-raw item with override but no plan and no rate terminates the walk", () => {
    // A bare-itemId override on a non-raw item is the user's declared
    // boundary marker: effectiveSupply returns Infinity, and producers are
    // pruned from the graph.
    const overrides: ItemOverride[] = [{ itemId: "mid" }];
    const g = buildRecipeGraph([tgt("sink")], nonRawPack(), overrides);
    expect([...g.nodes.keys()].sort()).toEqual(["sink"]);
    expect(g.nodes.has("mid-recipe")).toBe(false);
  });

  it("matrix row 7: raw item with plan and ratePerSec co-present continues walk (cap wins)", () => {
    // The validator would reject this co-presence, but the graph walk itself
    // must treat the finite cap as authoritative: effectiveSupply returns a
    // parsed Fraction, so producers must be reached.
    const items = [
      mkItem("copper_ore", true),
      mkItem("copper_nugget", false),
      mkItem("liquid_water", true),
    ];
    const recipes = [
      mkRecipe("copper_nugget", ["copper_ore"], ["copper_nugget"]),
      mkRecipe("copper_ore-liquid_water", ["liquid_water"], ["copper_ore"]),
      mkRecipe("liquid_water", [], ["liquid_water"]),
    ];
    const overrides: ItemOverride[] = [
      {
        itemId: "copper_ore",
        plan: true,
        ratePerSec: { num: "1", denom: "2" },
      },
    ];
    const g = buildRecipeGraph(
      [tgt("copper_nugget")],
      mkPack(items, recipes),
      overrides,
    );
    expect([...g.nodes.keys()].sort()).toEqual([
      "copper_nugget",
      "copper_ore-liquid_water",
    ]);
    expect(g.nodes.has("liquid_water")).toBe(false);
  });
});
