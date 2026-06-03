import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { walkAndSolve } from "../../src/solver/walk";
import { buildRecipeGraph } from "../../src/solver/graph";
import { tarjanScc, condense } from "../../src/solver/scc";
import { topologicalOrder } from "../../src/solver/topo";
import { MultiProducerSccCapError } from "../../src/solver/types";
import type { ItemOverride } from "../../src/data/plan";
import type { Target } from "../../src/data/targets";

// Synthetic SCC fixture. Two-recipe cycle A <-> B sharing items x and y.
// B also produces an external item z consumed by recipe_target. Capping z
// (an SCC output with external consumers) exercises Layer 2 SCC subtraction.
//
//   raw_a -> A (in: raw_a, y; out: x)
//   x     -> B (in: x;        out: y, z)
//   z     -> recipe_target (in: z; out: item_target)
//
// SCC = {A, B}. Without overrides, target demand of 1/s for item_target makes
// z external demand = 1/s, B = 1/s, A = 1/s.

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

function sccPack(): RecipePack {
  const items = [
    mkItem("raw_a", true),
    mkItem("x", false),
    mkItem("y", false),
    mkItem("z", false),
    mkItem("item_target", false),
  ];
  const recipes = [
    mkRecipe(
      "A",
      [
        { item: "raw_a", qty: 1 },
        { item: "y", qty: 1 },
      ],
      [{ item: "x", qty: 1 }],
    ),
    mkRecipe(
      "B",
      [{ item: "x", qty: 1 }],
      [
        { item: "y", qty: 1 },
        { item: "z", qty: 1 },
      ],
    ),
    mkRecipe(
      "recipe_target",
      [{ item: "z", qty: 1 }],
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

describe("walkAndSolve SCC cap subtraction (Layer 2 SCC branch)", () => {
  it("(a) cap on SCC output WITH external consumers reduces external delivery", () => {
    // Cap z at 1/4. external demand of z drops from 1 to 3/4. SCC rates scale
    // proportionally: B = 3/4, A = 3/4.
    const overrides: ItemOverride[] = [
      { itemId: "z", ratePerSec: { num: "1", denom: "4" } },
    ];
    const result = solveWith(
      sccPack(),
      [tgt("recipe_target", "1", "1")],
      overrides,
    );
    expect(result.rates.get("A")!.equals(new Fraction(3, 4))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(3, 4))).toBe(true);
    expect(result.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
  });

  it("(b) cap on SCC item WITHOUT external consumers has no effect on the linear system", () => {
    // x is consumed only by B (internal). A cap on x must not influence the
    // SCC's rates; B and A stay at the baseline 1/s.
    const overrides: ItemOverride[] = [
      { itemId: "x", ratePerSec: { num: "2", denom: "1" } },
    ];
    const result = solveWith(
      sccPack(),
      [tgt("recipe_target", "1", "1")],
      overrides,
    );
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
  });

  it("(c) cap above all external demand drops external delivery to zero", () => {
    // Cap z at 5/s (above the 1/s demand). consumedSupplyForExternal = 1, RHS
    // for B's z output drops to 0. The SCC collapses to A = B = 0.
    const overrides: ItemOverride[] = [
      { itemId: "z", ratePerSec: { num: "5", denom: "1" } },
    ];
    const result = solveWith(
      sccPack(),
      [tgt("recipe_target", "1", "1")],
      overrides,
    );
    expect(result.rates.get("A")!.equals(new Fraction(0))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(0))).toBe(true);
    expect(result.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
  });

  it("baseline: no overrides -> SCC rates 1/s end-to-end (regression)", () => {
    const result = solveWith(sccPack(), [tgt("recipe_target", "1", "1")]);
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("recipe_target")!.equals(new Fraction(1))).toBe(
      true,
    );
  });
});

// Fixture: two-recipe SCC where BOTH internal members produce the same SCC
// output item `z`, and `z` has at least one external consumer. AEF has zero
// such SCCs (audited by scripts/audit-scc-multi-producer.ts), so the Layer 2
// SCC pre-subtraction cap model in walk.ts is single-producer-per-item. This
// test pins that assumption: applying an override to such an SCC must throw
// MultiProducerSccCapError instead of silently double-subtracting in flow.ts.
//
//   raw_a -> A  (in: raw_a, y; out: x, z)
//   x     -> B  (in: x;        out: y, z)
//   z     -> recipe_target (in: z; out: item_target)
//
// SCC = {A, B}. Both produce z; recipe_target externally consumes z.

function multiProducerSccPack(): RecipePack {
  const items = [
    mkItem("raw_a", true),
    mkItem("x", false),
    mkItem("y", false),
    mkItem("z", false),
    mkItem("item_target", false),
  ];
  const recipes = [
    mkRecipe(
      "A",
      [
        { item: "raw_a", qty: 1 },
        { item: "y", qty: 1 },
      ],
      [
        { item: "x", qty: 1 },
        { item: "z", qty: 1 },
      ],
    ),
    mkRecipe(
      "B",
      [{ item: "x", qty: 1 }],
      [
        { item: "y", qty: 1 },
        { item: "z", qty: 1 },
      ],
    ),
    mkRecipe(
      "recipe_target",
      [{ item: "z", qty: 1 }],
      [{ item: "item_target", qty: 1 }],
    ),
  ];
  return mkPack(items, recipes);
}

describe("walkAndSolve SCC multi-producer assertion (Layer 2 invariant)", () => {
  it("throws MultiProducerSccCapError when override applies to an SCC output with multiple internal producers", () => {
    const overrides: ItemOverride[] = [
      { itemId: "z", ratePerSec: { num: "1", denom: "4" } },
    ];
    expect(() =>
      solveWith(
        multiProducerSccPack(),
        [tgt("recipe_target", "1", "1")],
        overrides,
      ),
    ).toThrow(MultiProducerSccCapError);
  });

  it("does NOT throw when no override is set (baseline path unaffected)", () => {
    // Without an override z has Infinity supply, so the cap branch is never
    // entered and the assertion stays silent. We don't assert on rates here:
    // this fixture's linear system is ill-conditioned (both producers emit
    // z externally), so solveSccFlow may throw Singular/Inconsistent. The
    // point is purely that the multi-producer assertion does not fire.
    try {
      solveWith(multiProducerSccPack(), [tgt("recipe_target", "1", "1")]);
    } catch (err) {
      expect(err).not.toBeInstanceOf(MultiProducerSccCapError);
    }
  });
});
