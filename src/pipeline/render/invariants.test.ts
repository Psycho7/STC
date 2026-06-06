import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  checkEdgeEndpointIntegrity,
  checkBoundaryProductsJustified,
  checkInternalFlowConservation,
  checkConsumerInputsSatisfied,
  checkConsumerInputsNotOverfed,
  checkTargetOutputsSatisfied,
  checkNoOrphanUnits,
  checkRenderPlan,
  assertRenderInvariants,
} from "./invariants";
import type { RenderPlan } from "../types";
import type { RecipePack } from "@aef/schema";
import type { RationalString } from "../../data/targets";
import type { Target } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";

const RATE_ONE: RationalString = { num: "1", denom: "1" };

// Minimal RecipePack with items and recipes needed by the boundary checker.
function makeFullPack(
  items: Array<{ id: string; raw?: boolean }>,
  recipes: Array<{
    id: string;
    in: Array<{ item: string; qty: number }>;
    out: Array<{ item: string; qty: number }>;
  }>,
): RecipePack {
  return {
    schemaVersion: "0.2",
    source: {
      name: "test",
      sourceRepo: "test",
      sourceCommit: "test",
      gameVersion: "test",
      extractedAt: "test",
    },
    categories: [],
    locations: [],
    items: items.map((i) => ({
      id: i.id,
      name: i.id,
      category: "test",
      icon: "",
      row: 0,
      raw: i.raw ?? false,
      transportKind: "belt" as const,
    })),
    machines: [],
    transports: [],
    recipes: recipes.map((r) => ({
      id: r.id,
      name: r.id,
      category: "test",
      icon: "",
      row: 0,
      time: 1,
      producers: [],
      in: r.in.map((x) => ({ item: x.item, qty: x.qty })),
      out: r.out.map((x) => ({ item: x.item, qty: x.qty })),
    })),
  };
}

// Minimal RecipePack with just the items field needed by the checker.
function makePack(itemIds: string[]): RecipePack {
  return {
    schemaVersion: "0.2",
    source: {
      name: "test",
      sourceRepo: "test",
      sourceCommit: "test",
      gameVersion: "test",
      extractedAt: "test",
    },
    categories: [],
    locations: [],
    items: itemIds.map((id) => ({
      id,
      name: id,
      category: "test",
      icon: "",
      row: 0,
      raw: false,
      transportKind: "belt",
    })),
    machines: [],
    transports: [],
    recipes: [],
  };
}

const emptyRates: ReadonlyMap<string, Fraction> = new Map();

describe("checkEdgeEndpointIntegrity", () => {
  it("passes for a well-formed plan", () => {
    const plan: RenderPlan = {
      units: [
        {
          id: "u-recipe-1",
          kind: "recipe",
          recipeId: "recipe-iron-plate",
          count: 1,
          multiplicity: RATE_ONE,
        },
        {
          id: "u-input-1",
          kind: "inputProduct",
          itemId: "iron-ore",
          count: 1,
          rate: RATE_ONE,
        },
      ],
      edges: [
        {
          fromUnit: "u-input-1",
          toUnit: "u-recipe-1",
          item: "iron-ore",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkEdgeEndpointIntegrity({
      plan,
      rates: emptyRates,
      pack: makePack(["iron-ore"]),
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when toUnit is not in units", () => {
    const plan: RenderPlan = {
      units: [
        {
          id: "u-input-1",
          kind: "inputProduct",
          itemId: "iron-ore",
          count: 1,
          rate: RATE_ONE,
        },
      ],
      edges: [
        {
          fromUnit: "u-input-1",
          toUnit: "u-missing",
          item: "iron-ore",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkEdgeEndpointIntegrity({
      plan,
      rates: emptyRates,
      pack: makePack(["iron-ore"]),
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("u-missing");
  });

  it("fails when fromUnit is not in units", () => {
    const plan: RenderPlan = {
      units: [
        {
          id: "u-recipe-1",
          kind: "recipe",
          recipeId: "recipe-iron-plate",
          count: 1,
          multiplicity: RATE_ONE,
        },
      ],
      edges: [
        {
          fromUnit: "u-dangling",
          toUnit: "u-recipe-1",
          item: "iron-ore",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkEdgeEndpointIntegrity({
      plan,
      rates: emptyRates,
      pack: makePack(["iron-ore"]),
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("u-dangling");
  });

  it("fails when edge rate is zero", () => {
    const plan: RenderPlan = {
      units: [
        {
          id: "u-recipe-1",
          kind: "recipe",
          recipeId: "recipe-iron-plate",
          count: 1,
          multiplicity: RATE_ONE,
        },
        {
          id: "u-input-1",
          kind: "inputProduct",
          itemId: "iron-ore",
          count: 1,
          rate: RATE_ONE,
        },
      ],
      edges: [
        {
          fromUnit: "u-input-1",
          toUnit: "u-recipe-1",
          item: "iron-ore",
          rate: new Fraction(0),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkEdgeEndpointIntegrity({
      plan,
      rates: emptyRates,
      pack: makePack(["iron-ore"]),
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("fails when edge item is not in pack.items", () => {
    const plan: RenderPlan = {
      units: [
        {
          id: "u-recipe-1",
          kind: "recipe",
          recipeId: "recipe-iron-plate",
          count: 1,
          multiplicity: RATE_ONE,
        },
        {
          id: "u-input-1",
          kind: "inputProduct",
          itemId: "iron-ore",
          count: 1,
          rate: RATE_ONE,
        },
      ],
      edges: [
        {
          fromUnit: "u-input-1",
          toUnit: "u-recipe-1",
          item: "unknown-item",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkEdgeEndpointIntegrity({
      plan,
      rates: emptyRates,
      // Pack has no items at all -- "unknown-item" is absent.
      pack: makePack([]),
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("unknown-item");
  });
});

// ---------------------------------------------------------------------------
// checkBoundaryProductsJustified
// ---------------------------------------------------------------------------

describe("checkBoundaryProductsJustified", () => {
  // Case (a): input product for a genuine raw item that is consumed by a recipe.
  // R is raw -> effectiveSupply is Infinity. The recipe consumes R (consumption
  // > production = 0), so the inputProduct unit is justified.
  it("(a) passes for an input product backed by a raw item with recipe consumption", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }],
      [{ id: "recipe-R", in: [{ item: "R", qty: 1 }], out: [] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-R", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        {
          id: "u-input-R",
          kind: "inputProduct",
          itemId: "R",
          count: 1,
          rate: RATE_ONE,
        },
      ],
      edges: [],
      containers: [],
    };
    const targets: ReadonlyArray<Target> = [];
    const itemOverrides: ReadonlyArray<ItemOverride> = [];
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (b): output product flavor "target" for an item that is the primary
  // output of a target recipe.
  it("(b) passes for an output product (target flavor) matching a target recipe primary output", () => {
    const pack = makeFullPack(
      [{ id: "F" }],
      [{ id: "recipe-F", in: [], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-F", new Fraction(1)],
    ]);
    const plan: RenderPlan = {
      units: [
        {
          id: "u-out-F",
          kind: "outputProduct",
          itemId: "F",
          count: 1,
          rate: RATE_ONE,
          flavor: "target",
        },
      ],
      edges: [],
      containers: [],
    };
    const targets: ReadonlyArray<Target> = [
      { recipeId: "recipe-F", ratePerSec: { num: "1", denom: "1" } },
    ];
    const itemOverrides: ReadonlyArray<ItemOverride> = [];
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (c): output product flavor "surplus" for a genuine byproduct W.
  // Recipe: R -> F (primary) + W (byproduct). W has no consumers; nothing
  // demands W; production(W) > consumption(W) + demand(W). Justified.
  it("(c) passes for an output product (surplus flavor) with genuine overproduction", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "F" }, { id: "W" }],
      [
        {
          id: "recipe-main",
          in: [{ item: "R", qty: 1 }],
          out: [{ item: "F", qty: 1 }, { item: "W", qty: 1 }],
        },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-main", new Fraction(3)],
    ]);
    const plan: RenderPlan = {
      units: [
        {
          id: "u-out-W",
          kind: "outputProduct",
          itemId: "W",
          count: 1,
          rate: RATE_ONE,
          flavor: "surplus",
        },
      ],
      edges: [],
      containers: [],
    };
    const targets: ReadonlyArray<Target> = [
      { recipeId: "recipe-main", ratePerSec: { num: "1", denom: "1" } },
    ];
    const itemOverrides: ReadonlyArray<ItemOverride> = [];
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (d) RF-1: an intermediate item M that is internally balanced
  // (recipe-A produces M, recipe-B consumes the same amount), not a target,
  // not raw. An outputProduct flavor "surplus" for M is unjustified: the net
  // residual is ~0, not a genuine surplus.
  it("(d) fails for an output product (surplus flavor) on an internally balanced intermediate (RF-1)", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "M" }, { id: "F" }],
      [
        {
          id: "recipe-A",
          in: [{ item: "R", qty: 1 }],
          out: [{ item: "M", qty: 2 }],
        },
        {
          id: "recipe-B",
          in: [{ item: "M", qty: 2 }],
          out: [{ item: "F", qty: 1 }],
        },
      ],
    );
    // Both recipes run at rate 1: recipe-A produces 2 M/s, recipe-B consumes 2 M/s.
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-A", new Fraction(1)],
      ["recipe-B", new Fraction(1)],
    ]);
    const plan: RenderPlan = {
      units: [
        {
          id: "u-out-M",
          kind: "outputProduct",
          itemId: "M",
          count: 1,
          rate: RATE_ONE,
          // Phantom surplus: M is internally balanced but mislabeled as surplus.
          flavor: "surplus",
        },
      ],
      edges: [],
      containers: [],
    };
    const targets: ReadonlyArray<Target> = [
      { recipeId: "recipe-B", ratePerSec: { num: "1", denom: "1" } },
    ];
    const itemOverrides: ReadonlyArray<ItemOverride> = [];
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("M");
  });
});

// ---------------------------------------------------------------------------
// checkInternalFlowConservation
// ---------------------------------------------------------------------------

describe("checkInternalFlowConservation", () => {
  // Case (a): two recipe units connected by an internal edge carrying M at the
  // correct rate. recipe-b produces R->M at rate 2; recipe-a consumes M->F at
  // rate 2. The internal edge carries M at rate 2. Expect ok === true.
  it("(a) passes when internal edge is present and carries the correct rate", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "M" }, { id: "F" }],
      [
        { id: "recipe-b", in: [{ item: "R", qty: 1 }], out: [{ item: "M", qty: 1 }] },
        { id: "recipe-a", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-b", new Fraction(2)],
      ["recipe-a", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-b", kind: "recipe", recipeId: "recipe-b", count: 1, multiplicity: RATE_ONE },
        { id: "u-a", kind: "recipe", recipeId: "recipe-a", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-b",
          toUnit: "u-a",
          item: "M",
          rate: new Fraction(2),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkInternalFlowConservation({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (b) RF-1 dropped edge: same recipes and rates but the M edge is absent.
  // prodVisible(M) = 2, consVisible(M) = 2, expected = 2, internalSum(M) = 0.
  // Expect ok === false, violation mentions "M" and shows the shortfall.
  it("(b) fails when internal edge is absent (RF-1 dropped edge)", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "M" }, { id: "F" }],
      [
        { id: "recipe-b", in: [{ item: "R", qty: 1 }], out: [{ item: "M", qty: 1 }] },
        { id: "recipe-a", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-b", new Fraction(2)],
      ["recipe-a", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-b", kind: "recipe", recipeId: "recipe-b", count: 1, multiplicity: RATE_ONE },
        { id: "u-a", kind: "recipe", recipeId: "recipe-a", count: 1, multiplicity: RATE_ONE },
      ],
      // No edges: the M internal edge is missing.
      edges: [],
      containers: [],
    };
    const result = checkInternalFlowConservation({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("M");
    // Violation should indicate expected=2 and actual=0.
    expect(result.violations[0]).toMatch(/expected.*2/i);
    expect(result.violations[0]).toMatch(/actual.*0/i);
  });

  // Case (c) boundary-only, no false positive: recipe produces M but nothing
  // internally consumes it (only dumped as surplus). consVisible(M) = 0 so the
  // checker skips M entirely. Expect ok === true.
  it("(c) no false positive when item has internal production but zero internal consumption", () => {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "M" }],
      [
        { id: "recipe-b", in: [{ item: "R", qty: 1 }], out: [{ item: "M", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-b", new Fraction(3)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-b", kind: "recipe", recipeId: "recipe-b", count: 1, multiplicity: RATE_ONE },
        {
          id: "u-out-M",
          kind: "outputProduct",
          itemId: "M",
          count: 1,
          rate: RATE_ONE,
          flavor: "surplus",
        },
      ],
      edges: [],
      containers: [],
    };
    const result = checkInternalFlowConservation({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SCC / loop unit handling -- conservative false-negative bias
//
// When an SCC is collapsed into a single kind:"loop" unit the recipes inside it
// vanish from plan.units, so their recipe ids are NOT in renderedRecipeIds.
// checkInternalFlowConservation restricts visible production/consumption to
// renderedRecipeIds and folds loop netIO ports in; checkConsumerInputsSatisfied
// only attributes inflow to kind:"recipe" units.  Both choices bias toward
// false-negatives on loop-hidden flows rather than false-positives.
//
// Scenario: two cyclic recipes (cycA, cycB) share an internal item C.
//   cycA: R -> C + F_partial  (rate 1: produces 1 C, consumes 1 R, produces 1 F)
//   cycB: C -> F              (rate 1: consumes 1 C, produces 1 F)
// Net boundary crossing: R flows in, F flows out.  C is entirely internal.
// The RenderPlan represents the SCC as ONE loop unit with netIO = [{R, in}, {F, out}].
// There are NO recipe units for cycA/cycB.
// ---------------------------------------------------------------------------

describe("SCC/loop unit: no false positive on loop-internal flow", () => {
  // Build a pack with items R (raw), C (internal intermediate), F (final output)
  // and two cyclic recipes that together form a loop.
  //   cycA: 1 R -> 1 C + 1 F  (rate 1)
  //   cycB: 1 C -> 1 F         (rate 1)
  // rates contains BOTH recipes so productionByItem/consumptionByItem see C
  // produced and consumed.  Without the renderedRecipeIds restriction the
  // checker would compute prodVisible(C)=1, consVisible(C)=1, expected=1 and
  // flag a shortfall because no internal edge carries C.  With the restriction
  // renderedRecipeIds is empty (no recipe units), so C is invisible and there
  // is no false positive.

  function loopArgs(): Parameters<typeof checkInternalFlowConservation>[0] {
    const pack = makeFullPack(
      [{ id: "R", raw: true }, { id: "C" }, { id: "F" }],
      [
        // cycA: consumes R, produces C and F
        {
          id: "cycA",
          in: [{ item: "R", qty: 1 }],
          out: [{ item: "C", qty: 1 }, { item: "F", qty: 1 }],
        },
        // cycB: consumes C, produces F
        {
          id: "cycB",
          in: [{ item: "C", qty: 1 }],
          out: [{ item: "F", qty: 1 }],
        },
      ],
    );

    // Both recipes run at rate 1.  C is produced 1/s by cycA and consumed 1/s
    // by cycB -- entirely internal to the SCC.
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["cycA", new Fraction(1)],
      ["cycB", new Fraction(1)],
    ]);

    // The SCC is collapsed into a single loop unit.  netIO carries only the
    // boundary-crossing flows: R (in) and F (out, 2/s total from both recipes).
    // C does NOT appear in netIO because it is internal.
    const plan: RenderPlan = {
      units: [
        {
          id: "u:scc:1",
          kind: "loop",
          sccId: "1",
          count: 1,
          netIO: [
            { item: "R", direction: "in", rate: new Fraction(1) },
            { item: "F", direction: "out", rate: new Fraction(2) },
          ],
        },
        // Boundary input for the raw item R entering from outside.
        { id: "u-in-R", kind: "inputProduct", itemId: "R", count: 1, rate: RATE_ONE },
        // Boundary output for F.
        { id: "u-out-F", kind: "outputProduct", itemId: "F", count: 1, rate: RATE_ONE, flavor: "target" },
      ],
      edges: [
        // R flows in from the boundary to the loop unit.
        { fromUnit: "u-in-R", toUnit: "u:scc:1", item: "R", rate: new Fraction(1), transportKind: "belt" },
        // F flows out from the loop unit to the boundary.
        { fromUnit: "u:scc:1", toUnit: "u-out-F", item: "F", rate: new Fraction(2), transportKind: "belt" },
      ],
      containers: [],
    };

    return { plan, rates, pack, targets: [], itemOverrides: [] };
  }

  // KEY ASSERTION: loop-internal item C must NOT be flagged despite rates
  // showing it produced and consumed, because cycA/cycB have no recipe units
  // and are therefore excluded from renderedRecipeIds.
  // If the renderedRecipeIds restriction were removed, prodVisible(C)=1 and
  // consVisible(C)=1 would give expected=1, and the missing C-edge would
  // trigger a false-positive violation.
  it("checkInternalFlowConservation: no false positive for loop-internal item C", () => {
    const result = checkInternalFlowConservation(loopArgs());
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // SECONDARY ASSERTION: the loop unit is not a recipe consumer so
  // checkConsumerInputsSatisfied must also return ok without any violation,
  // even though the loop unit has an inbound R edge and the loop has no
  // recipe-unit representation.
  it("checkConsumerInputsSatisfied: loop unit not treated as recipe consumer, no false positive", () => {
    const result = checkConsumerInputsSatisfied(loopArgs());
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkConsumerInputsSatisfied
// ---------------------------------------------------------------------------

describe("checkConsumerInputsSatisfied", () => {
  // Case (a): recipe R consumes M at qty 1, rate(R)=2, one incoming edge for M
  // at rate 2 into the recipe unit. Expect ok === true.
  it("(a) passes when incoming edge satisfies the required input exactly", () => {
    const pack = makeFullPack(
      [{ id: "M" }, { id: "F" }],
      [{ id: "R", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["R", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-src", kind: "recipe", recipeId: "R-src", count: 1, multiplicity: RATE_ONE },
        { id: "u-R", kind: "recipe", recipeId: "R", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-src",
          toUnit: "u-R",
          item: "M",
          rate: new Fraction(2),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkConsumerInputsSatisfied({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (b) RF-1 no input: recipe R consumes M at qty 1, rate(R)=2, but NO
  // incoming edge for M. Expect ok === false, violation names R, M, expected 2,
  // actual 0.
  it("(b) fails when recipe unit has no incoming edge for a required input (RF-1)", () => {
    const pack = makeFullPack(
      [{ id: "M" }, { id: "F" }],
      [{ id: "R", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["R", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-R", kind: "recipe", recipeId: "R", count: 1, multiplicity: RATE_ONE },
      ],
      // No edges: M arrives from nowhere.
      edges: [],
      containers: [],
    };
    const result = checkConsumerInputsSatisfied({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("R");
    expect(result.violations[0]).toContain("M");
    // Should show expected=2 and actual=0.
    expect(result.violations[0]).toMatch(/expected.*2/i);
    expect(result.violations[0]).toMatch(/actual.*0/i);
  });

  // Case (c): recipe R consumes raw item Rraw at qty 1, rate(R)=1. An
  // inputProduct unit for Rraw feeds an edge into u-R at rate 1. Boundary edge
  // counts as inflow. Expect ok === true.
  it("(c) passes when input is fed by a boundary inputProduct edge", () => {
    const pack = makeFullPack(
      [{ id: "Rraw", raw: true }, { id: "F" }],
      [{ id: "R", in: [{ item: "Rraw", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["R", new Fraction(1)],
    ]);
    const plan: RenderPlan = {
      units: [
        {
          id: "u-input-Rraw",
          kind: "inputProduct",
          itemId: "Rraw",
          count: 1,
          rate: RATE_ONE,
        },
        { id: "u-R", kind: "recipe", recipeId: "R", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-input-Rraw",
          toUnit: "u-R",
          item: "Rraw",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkConsumerInputsSatisfied({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkConsumerInputsNotOverfed
// ---------------------------------------------------------------------------

describe("checkConsumerInputsNotOverfed", () => {
  // Case (a): recipe R consumes M at qty 1, rate(R)=2, one incoming edge for M
  // at rate 2 into the recipe unit -- exactly fed. Expect ok === true.
  it("(a) passes when incoming edge feeds the required input exactly", () => {
    const pack = makeFullPack(
      [{ id: "M" }, { id: "F" }],
      [{ id: "R", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["R", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-src", kind: "recipe", recipeId: "R-src", count: 1, multiplicity: RATE_ONE },
        { id: "u-R", kind: "recipe", recipeId: "R", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-src",
          toUnit: "u-R",
          item: "M",
          rate: new Fraction(2),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkConsumerInputsNotOverfed({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Case (b) over-connection: recipe R consumes M at qty 1, rate(R)=2 (expects 2
  // M/s), but TWO incoming edges for M each at rate 2 aggregate to 4 -- double
  // the required intake. Expect ok === false, violation names R, M, expected 2,
  // actual 4.
  it("(b) fails when aggregated inflow exceeds the required input (double-fed)", () => {
    const pack = makeFullPack(
      [{ id: "M" }, { id: "F" }],
      [{ id: "R", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["R", new Fraction(2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-src-1", kind: "recipe", recipeId: "R-src-1", count: 1, multiplicity: RATE_ONE },
        { id: "u-src-2", kind: "recipe", recipeId: "R-src-2", count: 1, multiplicity: RATE_ONE },
        { id: "u-R", kind: "recipe", recipeId: "R", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-src-1",
          toUnit: "u-R",
          item: "M",
          rate: new Fraction(2),
          transportKind: "belt",
        },
        {
          fromUnit: "u-src-2",
          toUnit: "u-R",
          item: "M",
          rate: new Fraction(2),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const result = checkConsumerInputsNotOverfed({
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("R");
    expect(result.violations[0]).toContain("M");
    // Should show expected=2 and actual=4.
    expect(result.violations[0]).toMatch(/expected.*2/i);
    expect(result.violations[0]).toMatch(/actual.*4/i);
  });
});

// ---------------------------------------------------------------------------
// checkNoOrphanUnits
// ---------------------------------------------------------------------------

describe("checkNoOrphanUnits", () => {
  // Case (a): recipe unit whose recipeId has NO entry in rates -> orphan.
  it("(a) fails for a recipe unit whose recipeId is absent from rates", () => {
    const pack = makeFullPack(
      [{ id: "M" }, { id: "F" }],
      [{ id: "recipe-A", in: [{ item: "M", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map(); // no entry for recipe-A
    const plan: RenderPlan = {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkNoOrphanUnits({ plan, rates, pack, targets: [], itemOverrides: [] });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("u-A");
    expect(result.violations[0]).toContain("recipe-A");
  });

  // Case: recipe unit with a zero rate is also an orphan.
  it("fails for a recipe unit whose rate is zero", () => {
    const pack = makeFullPack(
      [{ id: "F" }],
      [{ id: "recipe-A", in: [], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["recipe-A", new Fraction(0)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkNoOrphanUnits({ plan, rates, pack, targets: [], itemOverrides: [] });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("recipe-A");
  });

  // Case: non-recipe units (loop, inputProduct, outputProduct) are not checked.
  it("passes when only non-recipe units are present (loop and product units ignored)", () => {
    const pack = makeFullPack([{ id: "F", raw: true }], []);
    const rates: ReadonlyMap<string, Fraction> = new Map();
    const plan: RenderPlan = {
      units: [
        { id: "u-in", kind: "inputProduct", itemId: "F", count: 1, rate: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkNoOrphanUnits({ plan, rates, pack, targets: [], itemOverrides: [] });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("checkTargetOutputsSatisfied", () => {
  const pack = makeFullPack(
    [{ id: "R", raw: true }, { id: "F" }],
    [{ id: "recipe-A", in: [{ item: "R", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
  );
  const rates: ReadonlyMap<string, Fraction> = new Map([["recipe-A", new Fraction(1)]]);
  const targets: ReadonlyArray<Target> = [
    { recipeId: "recipe-A", ratePerSec: { num: "1", denom: "1" } },
  ];

  function planWithOutEdgeRate(rate: number): RenderPlan {
    return {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
        { id: "u:out:F", kind: "outputProduct", itemId: "F", count: 1, rate: RATE_ONE, flavor: "target" },
      ],
      edges:
        rate > 0
          ? [{ fromUnit: "u-A", toUnit: "u:out:F", item: "F", rate: new Fraction(rate), transportKind: "belt" }]
          : [],
      containers: [],
    };
  }

  it("passes when the target output unit is fed exactly the declared rate", () => {
    const result = checkTargetOutputsSatisfied({
      plan: planWithOutEdgeRate(1),
      rates,
      pack,
      targets,
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when the target output unit is fed below the declared rate", () => {
    const result = checkTargetOutputsSatisfied({
      plan: planWithOutEdgeRate(0.5),
      rates,
      pack,
      targets,
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("F");
  });

  it("fails when the target output unit receives no edge at all", () => {
    const result = checkTargetOutputsSatisfied({
      plan: planWithOutEdgeRate(0),
      rates,
      pack,
      targets,
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("F");
  });

  it("sums multiple producer edges into the same target output unit", () => {
    const plan: RenderPlan = {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
        { id: "u-B", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
        { id: "u:out:F", kind: "outputProduct", itemId: "F", count: 1, rate: RATE_ONE, flavor: "target" },
      ],
      edges: [
        { fromUnit: "u-A", toUnit: "u:out:F", item: "F", rate: new Fraction(1, 2), transportKind: "belt" },
        { fromUnit: "u-B", toUnit: "u:out:F", item: "F", rate: new Fraction(1, 2), transportKind: "belt" },
      ],
      containers: [],
    };
    const result = checkTargetOutputsSatisfied({ plan, rates, pack, targets, itemOverrides: [] });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkRenderPlan and assertRenderInvariants
// ---------------------------------------------------------------------------

// Shared factory for the minimal clean plan used by both describe blocks below.
// Plan: raw item R fed via inputProduct -> recipe-A (R->F) -> outputProduct(target).
// Returns fresh objects on each call so tests cannot interfere with each other.
function cleanPlanArgs(): {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<ItemOverride>;
} {
  const pack = makeFullPack(
    [{ id: "R", raw: true }, { id: "F" }],
    [{ id: "recipe-A", in: [{ item: "R", qty: 1 }], out: [{ item: "F", qty: 1 }] }],
  );
  const rates: ReadonlyMap<string, Fraction> = new Map([
    ["recipe-A", new Fraction(1)],
  ]);
  const plan: RenderPlan = {
    units: [
      { id: "u-in-R", kind: "inputProduct", itemId: "R", count: 1, rate: RATE_ONE },
      { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
      { id: "u:out:F", kind: "outputProduct", itemId: "F", count: 1, rate: RATE_ONE, flavor: "target" },
    ],
    edges: [
      { fromUnit: "u-in-R", toUnit: "u-A", item: "R", rate: new Fraction(1), transportKind: "belt" },
      { fromUnit: "u-A", toUnit: "u:out:F", item: "F", rate: new Fraction(1), transportKind: "belt" },
    ],
    containers: [],
  };
  const targets: ReadonlyArray<Target> = [
    { recipeId: "recipe-A", ratePerSec: { num: "1", denom: "1" } },
  ];
  return { plan, rates, pack, targets, itemOverrides: [] };
}

describe("checkRenderPlan", () => {
  // Case (b): a fully well-formed minimal plan -> all seven results ok === true.
  it("(b) returns seven ok results for a fully clean minimal plan", () => {
    const args = cleanPlanArgs();
    const results = checkRenderPlan(args);
    expect(results).toHaveLength(7);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.violations).toHaveLength(0);
    }
  });
});

describe("assertRenderInvariants", () => {
  // Case (b) continued: clean plan -> assertRenderInvariants does NOT throw.
  it("(b) does not throw for a fully clean minimal plan", () => {
    expect(() => assertRenderInvariants(cleanPlanArgs())).not.toThrow();
  });

  // Case (c): plan with one injected orphan unit -> assertRenderInvariants THROWS,
  // message contains the offending unit id and recipeId.
  it("(c) throws with aggregated message when plan has an orphan recipe unit", () => {
    const pack = makeFullPack(
      [{ id: "F" }],
      [{ id: "recipe-A", in: [], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map(); // recipe-A not in rates -> orphan
    const plan: RenderPlan = {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const args = { plan, rates, pack, targets: [] as ReadonlyArray<Target>, itemOverrides: [] as ReadonlyArray<ItemOverride> };
    expect(() => assertRenderInvariants(args)).toThrow(/recipe-A/);
  });

  // Case (c) variant: dangling edge endpoint -> assertRenderInvariants THROWS,
  // message contains the dangling unit id.
  it("(c) throws with aggregated message when plan has a dangling edge endpoint", () => {
    const pack = makeFullPack([{ id: "iron-ore" }], []);
    const rates: ReadonlyMap<string, Fraction> = new Map();
    const plan: RenderPlan = {
      units: [
        { id: "u-input-1", kind: "inputProduct", itemId: "iron-ore", count: 1, rate: RATE_ONE },
      ],
      edges: [
        {
          fromUnit: "u-input-1",
          toUnit: "u-missing",
          item: "iron-ore",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const args = { plan, rates, pack, targets: [] as ReadonlyArray<Target>, itemOverrides: [] as ReadonlyArray<ItemOverride> };
    expect(() => assertRenderInvariants(args)).toThrow(/u-missing/);
  });

  // Case (d): plan with TWO defects from different checkers.
  // Defect 1 (checkEdgeEndpointIntegrity): dangling edge to "u-dangling".
  // Defect 2 (checkNoOrphanUnits): recipe unit whose recipeId "recipe-orphan" is absent from rates.
  // assertRenderInvariants must throw with the aggregator prefix and both details present.
  it("(d) throws with violations from multiple checkers in a single error", () => {
    const pack = makeFullPack(
      [{ id: "iron-ore" }],
      [{ id: "recipe-orphan", in: [], out: [{ item: "iron-ore", qty: 1 }] }],
    );
    // rates is empty: recipe-orphan is absent -> orphan unit.
    const rates: ReadonlyMap<string, Fraction> = new Map();
    const plan: RenderPlan = {
      units: [
        // inputProduct provides the fromUnit for the dangling edge.
        { id: "u-input-1", kind: "inputProduct", itemId: "iron-ore", count: 1, rate: RATE_ONE },
        // recipe unit with no matching rate entry -> orphan.
        { id: "u-orphan", kind: "recipe", recipeId: "recipe-orphan", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        // toUnit "u-dangling" does not exist in units -> endpoint integrity violation.
        {
          fromUnit: "u-input-1",
          toUnit: "u-dangling",
          item: "iron-ore",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    };
    const args: Parameters<typeof assertRenderInvariants>[0] = {
      plan,
      rates,
      pack,
      targets: [],
      itemOverrides: [],
    };
    let thrown: unknown;
    try {
      assertRenderInvariants(args);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Aggregator prefix must be present.
    expect(msg).toContain("render invariants violated:");
    // Endpoint integrity violation: dangling unit id.
    expect(msg).toContain("u-dangling");
    // Orphan unit violation: orphan recipeId.
    expect(msg).toContain("recipe-orphan");
  });
});
