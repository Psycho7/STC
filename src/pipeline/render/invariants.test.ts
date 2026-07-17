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
  checkUnitOutflowVsProduction,
  checkProductUnitRates,
  checkRenderPlan,
  assertRenderInvariants,
} from "./invariants";
import { CLOSED_FORM_FIXTURES } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import { renderPlanFromSolve } from "../driver";
import { pack as fullPack } from "../../data/load";
import type { RenderPlan, RenderUnit, RenderEdge } from "../types";
import {
  isInputProductUnit,
  isOutputProductUnit,
  isRecipeUnit,
} from "../types";
import type { RecipePack } from "@aef/schema";
import type { RationalString, ItemTarget } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";

const RATE_ONE: RationalString = { num: "1", denom: "1" };

// Minimal RecipePack with the items and recipes the boundary checker needs.
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
      // Pack has no items, so "unknown-item" is absent.
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
  // Case (a): inputProduct for a raw item consumed by a recipe. R is raw so
  // effectiveSupply is Infinity, the recipe consumes R, the unit is justified.
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
    const targets: ReadonlyArray<ItemTarget> = [];
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

  // Case (b): outputProduct flavor "target" for the primary output of a target
  // recipe.
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
    const targets: ReadonlyArray<ItemTarget> = [
      { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
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

  // Case (c): outputProduct flavor "surplus" for a genuine byproduct W.
  // Recipe R -> F (primary) + W (byproduct). W has no consumers and nothing
  // demands it, so production(W) > consumption(W) + demand(W). Justified.
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
    const targets: ReadonlyArray<ItemTarget> = [
      { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
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

  // Case (d): intermediate M that is internally balanced (recipe-A produces M,
  // recipe-B consumes the same amount), not a target and not raw. An
  // outputProduct flavor "surplus" for M is unjustified because the net residual
  // is ~0.
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
          // Phantom surplus: M is balanced but mislabeled as surplus.
          flavor: "surplus",
        },
      ],
      edges: [],
      containers: [],
    };
    const targets: ReadonlyArray<ItemTarget> = [
      { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
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

  // Raw-also-target with cons < prod: prod 1 is fully claimed by the declared
  // target draw 1, so the consumer's 0.5 must come from the boundary and the
  // u:in unit is justified even though cons - prod = -0.5.
  it("justifies an inputProduct for a raw-also-target item whose production is target-claimed", () => {
    const pack = makeFullPack(
      [{ id: "W", raw: true }, { id: "F" }],
      [
        { id: "w_extract", in: [], out: [{ item: "W", qty: 1 }] },
        { id: "w_consumer", in: [{ item: "W", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["w_extract", new Fraction(1)],
      ["w_consumer", new Fraction(1, 2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-in-W", kind: "inputProduct", itemId: "W", count: 1, rate: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets: [{ itemId: "W", ratePerSec: RATE_ONE }],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Over-produced raw-also-target: prod 3 minus declared draw 1 leaves 2,
  // which fully covers cons 1, so nothing draws from outside and the u:in
  // unit is still unjustified. Guards the relaxation against over-subtracting.
  it("still flags an inputProduct when post-target production covers consumption", () => {
    const pack = makeFullPack(
      [{ id: "W", raw: true }, { id: "F" }],
      [
        { id: "w_extract", in: [], out: [{ item: "W", qty: 1 }] },
        { id: "w_consumer", in: [{ item: "W", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["w_extract", new Fraction(3)],
      ["w_consumer", new Fraction(1)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-in-W", kind: "inputProduct", itemId: "W", count: 1, rate: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkBoundaryProductsJustified({
      plan,
      rates,
      pack,
      targets: [{ itemId: "W", ratePerSec: RATE_ONE }],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("W");
  });
});

// ---------------------------------------------------------------------------
// checkInternalFlowConservation
// ---------------------------------------------------------------------------

describe("checkInternalFlowConservation", () => {
  // Case (b) dropped edge: same recipes and rates but the M edge is absent.
  // prodVisible(M)=2, consVisible(M)=2, expected=2, internalSum(M)=0.
  // Expect failure, violation mentions M and the shortfall.
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
      // The M internal edge is missing.
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
    // Violation should show expected=2 and actual=0.
    expect(result.violations[0]).toMatch(/expected.*2/i);
    expect(result.violations[0]).toMatch(/actual.*0/i);
  });

  // Case (c): recipe produces M but nothing internally consumes it (dumped as
  // surplus). consVisible(M)=0 so the checker skips M. No false positive.
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

  // Raw-also-target: w_extract produces W at exactly the declared target rate,
  // so no production is left for internal routing. The consumer draws from the
  // boundary; zero internal flow is the only valid render.
  it("expects zero internal flow when production is fully target-claimed", () => {
    const pack = makeFullPack(
      [{ id: "W", raw: true }, { id: "F" }],
      [
        { id: "w_extract", in: [], out: [{ item: "W", qty: 1 }] },
        { id: "w_consumer", in: [{ item: "W", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["w_extract", new Fraction(1)],
      ["w_consumer", new Fraction(1, 2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-x", kind: "recipe", recipeId: "w_extract", count: 1, multiplicity: RATE_ONE },
        { id: "u-c", kind: "recipe", recipeId: "w_consumer", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkInternalFlowConservation({
      plan,
      rates,
      pack,
      targets: [{ itemId: "W", ratePerSec: RATE_ONE }],
      itemOverrides: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // Over-produced target: prod 3, declared 1 -> 2 is genuinely routable; with
  // cons 0.5 the checker must still demand 0.5 of internal flow.
  it("still demands the routable surplus when production exceeds the target draw", () => {
    const pack = makeFullPack(
      [{ id: "W", raw: true }, { id: "F" }],
      [
        { id: "w_extract", in: [], out: [{ item: "W", qty: 1 }] },
        { id: "w_consumer", in: [{ item: "W", qty: 1 }], out: [{ item: "F", qty: 1 }] },
      ],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["w_extract", new Fraction(3)],
      ["w_consumer", new Fraction(1, 2)],
    ]);
    const plan: RenderPlan = {
      units: [
        { id: "u-x", kind: "recipe", recipeId: "w_extract", count: 1, multiplicity: RATE_ONE },
        { id: "u-c", kind: "recipe", recipeId: "w_consumer", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const result = checkInternalFlowConservation({
      plan,
      rates,
      pack,
      targets: [{ itemId: "W", ratePerSec: RATE_ONE }],
      itemOverrides: [],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("W");
    expect(result.violations[0]).toMatch(/expected.*0\.5/i);
  });
});

// ---------------------------------------------------------------------------
// SCC / loop unit handling. Biased toward false-negatives.
//
// When an SCC collapses into a single kind:"loop" unit, its recipes vanish from
// plan.units so their ids are not in renderedRecipeIds.
// checkInternalFlowConservation restricts visible production/consumption to
// renderedRecipeIds and folds loop netIO ports in; checkConsumerInputsSatisfied
// only attributes inflow to kind:"recipe" units. Both choices favor
// false-negatives on loop-hidden flows over false-positives.
//
// Scenario: two cyclic recipes (cycA, cycB) share an internal item C.
//   cycA: R -> C + F_partial  (rate 1: produces 1 C, consumes 1 R, produces 1 F)
//   cycB: C -> F              (rate 1: consumes 1 C, produces 1 F)
// R flows in, F flows out, C is entirely internal. The RenderPlan is ONE loop
// unit with netIO = [{R, in}, {F, out}] and no recipe units for cycA/cycB.
// ---------------------------------------------------------------------------

describe("SCC/loop unit: no false positive on loop-internal flow", () => {
  // Pack: R (raw), C (internal intermediate), F (final output) and two cyclic
  // recipes forming a loop.
  //   cycA: 1 R -> 1 C + 1 F  (rate 1)
  //   cycB: 1 C -> 1 F         (rate 1)
  // rates holds both recipes so C reads as produced and consumed. Without the
  // renderedRecipeIds restriction the checker would get prodVisible(C)=1,
  // consVisible(C)=1, expected=1 and flag a shortfall (no edge carries C). With
  // the restriction renderedRecipeIds is empty, C is invisible, no false
  // positive.

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

    // Both recipes run at rate 1. C is produced 1/s by cycA and consumed 1/s
    // by cycB, entirely internal to the SCC.
    const rates: ReadonlyMap<string, Fraction> = new Map([
      ["cycA", new Fraction(1)],
      ["cycB", new Fraction(1)],
    ]);

    // The SCC collapses into one loop unit. netIO carries only the
    // boundary-crossing flows: R (in) and F (out, 2/s total from both recipes).
    // C does not appear in netIO because it is internal.
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
        // Boundary input for raw R.
        { id: "u-in-R", kind: "inputProduct", itemId: "R", count: 1, rate: RATE_ONE },
        // Boundary output for F.
        { id: "u-out-F", kind: "outputProduct", itemId: "F", count: 1, rate: RATE_ONE, flavor: "target" },
      ],
      edges: [
        // R flows in to the loop unit.
        { fromUnit: "u-in-R", toUnit: "u:scc:1", item: "R", rate: new Fraction(1), transportKind: "belt" },
        // F flows out from the loop unit.
        { fromUnit: "u:scc:1", toUnit: "u-out-F", item: "F", rate: new Fraction(2), transportKind: "belt" },
      ],
      containers: [],
    };

    return { plan, rates, pack, targets: [], itemOverrides: [] };
  }

  // Loop-internal item C must not be flagged despite rates showing it produced
  // and consumed, because cycA/cycB have no recipe units and so are excluded
  // from renderedRecipeIds. Drop that restriction and prodVisible(C)=1,
  // consVisible(C)=1 give expected=1, and the missing C-edge would false-trip.
  it("checkInternalFlowConservation: no false positive for loop-internal item C", () => {
    const result = checkInternalFlowConservation(loopArgs());
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // The loop unit is not a recipe consumer, so checkConsumerInputsSatisfied
  // must also pass, even though it has an inbound R edge and no recipe-unit
  // representation.
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
  // Case (b) no input: recipe R consumes M at qty 1, rate(R)=2, but no incoming
  // M edge. Expect failure, violation names R, M, expected 2, actual 0.
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
      // M arrives from nowhere.
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

  // Case (c): recipe R consumes raw Rraw at qty 1, rate(R)=1. An inputProduct
  // unit for Rraw feeds u-R at rate 1, and the boundary edge counts as inflow.
  // Expect ok.
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
  // Case (b) over-connection: recipe R consumes M at qty 1, rate(R)=2 (expects 2
  // M/s), but two incoming M edges at rate 2 each aggregate to 4, double the
  // intake. Expect failure, violation names R, M, expected 2, actual 4.
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
  // Case (a): recipe unit whose recipeId has no entry in rates is an orphan.
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
  const targets: ReadonlyArray<ItemTarget> = [
    { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
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

// Minimal clean plan shared by both describe blocks below:
// raw R via inputProduct -> recipe-A (R->F) -> outputProduct(target).
// Returns fresh objects each call so tests cannot interfere.
function cleanPlanArgs(): {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<ItemTarget>;
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
  const targets: ReadonlyArray<ItemTarget> = [
    { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
  ];
  return { plan, rates, pack, targets, itemOverrides: [] };
}

describe("checkRenderPlan", () => {
  // Case (b): a well-formed minimal plan gives all nine results ok.
  it("(b) returns nine ok results for a fully clean minimal plan", () => {
    const args = cleanPlanArgs();
    const results = checkRenderPlan(args);
    expect(results).toHaveLength(9);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.violations).toHaveLength(0);
    }
  });

  // The aggregate must surface a checkUnitOutflowVsProduction violation. This
  // plan over-bills the F producer (recipe-A makes 1 F/sec, the outgoing edge
  // ships 2) which trips ONLY checkUnitOutflowVsProduction: the target output is
  // shortfall-only on delivery, the over-feed checker only inspects edges into
  // recipe units, and the boundary checker accepts the justified target. If the
  // checker is not in the aggregate list, checkRenderPlan reports it clean.
  it("surfaces a unit-outflow over-bill through the aggregate", () => {
    const args = cleanPlanArgs();
    for (const e of args.plan.edges) {
      if (e.fromUnit === "u-A") e.rate = new Fraction(2);
    }

    const results = checkRenderPlan(args);
    const allViolations = results.flatMap((r) => r.violations);
    expect(
      allViolations.some((v) => v.includes("over-billed producer edge")),
    ).toBe(true);
  });
});

describe("assertRenderInvariants", () => {
  // Case (c): one injected orphan unit, assertRenderInvariants throws with the
  // offending unit id and recipeId in the message.
  it("(c) throws with aggregated message when plan has an orphan recipe unit", () => {
    const pack = makeFullPack(
      [{ id: "F" }],
      [{ id: "recipe-A", in: [], out: [{ item: "F", qty: 1 }] }],
    );
    const rates: ReadonlyMap<string, Fraction> = new Map(); // recipe-A not in rates: orphan
    const plan: RenderPlan = {
      units: [
        { id: "u-A", kind: "recipe", recipeId: "recipe-A", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [],
      containers: [],
    };
    const args = { plan, rates, pack, targets: [] as ReadonlyArray<ItemTarget>, itemOverrides: [] as ReadonlyArray<ItemOverride> };
    expect(() => assertRenderInvariants(args)).toThrow(/recipe-A/);
  });

  // Case (c) variant: dangling edge endpoint, assertRenderInvariants throws with
  // the dangling unit id in the message.
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
    const args = { plan, rates, pack, targets: [] as ReadonlyArray<ItemTarget>, itemOverrides: [] as ReadonlyArray<ItemOverride> };
    expect(() => assertRenderInvariants(args)).toThrow(/u-missing/);
  });

  // Case (d): two defects from different checkers.
  // checkEdgeEndpointIntegrity: dangling edge to "u-dangling".
  // checkNoOrphanUnits: recipe unit whose "recipe-orphan" is absent from rates.
  // assertRenderInvariants must throw with the aggregator prefix and both details.
  it("(d) throws with violations from multiple checkers in a single error", () => {
    const pack = makeFullPack(
      [{ id: "iron-ore" }],
      [{ id: "recipe-orphan", in: [], out: [{ item: "iron-ore", qty: 1 }] }],
    );
    // rates is empty, so recipe-orphan is an orphan unit.
    const rates: ReadonlyMap<string, Fraction> = new Map();
    const plan: RenderPlan = {
      units: [
        // inputProduct provides the fromUnit for the dangling edge.
        { id: "u-input-1", kind: "inputProduct", itemId: "iron-ore", count: 1, rate: RATE_ONE },
        // recipe unit with no matching rate entry: orphan.
        { id: "u-orphan", kind: "recipe", recipeId: "recipe-orphan", count: 1, multiplicity: RATE_ONE },
      ],
      edges: [
        // toUnit "u-dangling" is not in units: endpoint integrity violation.
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
    // Aggregator prefix.
    expect(msg).toContain("render invariants violated:");
    // Endpoint integrity: dangling unit id.
    expect(msg).toContain("u-dangling");
    // Orphan unit: orphan recipeId.
    expect(msg).toContain("recipe-orphan");
  });
});

// ---------------------------------------------------------------------------
// checkUnitOutflowVsProduction
//
// The seven checkers above all aggregate consumer INFLOW by recipeId or item;
// none compares a render unit's OUTFLOW against the item it actually produces.
// This checker derives per-unit production from RenderUnitRecipe.multiplicity
// (multiplicity * machine speed / recipe time * out.qty, validated to match the
// LP execution rate) and flags:
//   (a) a unit shipping more of an item than it produces (a co-product edge
//       missing from a sibling so the surviving edge over-bills its producer),
//   (b) per item, production that vanishes off the graph without a compensating
//       over-bill (total production != total outgoing edge rate from recipe
//       units; edges into surplus and target output nodes count as shipment).
// The defects it targets pass all seven existing checkers, so these tests build
// the offending plans from the real pack via the full pipeline.
// ---------------------------------------------------------------------------

describe("checkUnitOutflowVsProduction", () => {
  // The four feasible closed-form micro-fixtures must report zero violations:
  // every unit ships at most what it produces and unshipped production lands in
  // a surplus output.
  const FEASIBLE_FIXTURES = CLOSED_FORM_FIXTURES.filter(
    (f) => f.expected.softFeasible,
  );

  for (const fixture of FEASIBLE_FIXTURES) {
    it(`feasible fixture "${fixture.name}" reports no violations`, () => {
      const full = solvePlanWithIntermediates(
        fixture.targets,
        fixture.pack,
        defaultTransportConfig,
        fixture.itemOverrides ?? [],
      );
      const { plan } = renderPlanFromSolve(
        full,
        fixture.pack,
        fixture.targets,
        fixture.itemOverrides ?? [],
      );
      const result = checkUnitOutflowVsProduction({
        plan,
        rates: full.rates,
        pack: fixture.pack,
        targets: fixture.targets,
        itemOverrides: fixture.itemOverrides ?? [],
      });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  // Build a full-pipeline RenderInvariantArgs from real-pack targets at 1/sec.
  function fullPipelineArgs(recipeIds: string[]): {
    plan: RenderPlan;
    rates: ReadonlyMap<string, Fraction>;
    pack: RecipePack;
    targets: ReadonlyArray<ItemTarget>;
    itemOverrides: ReadonlyArray<ItemOverride>;
  } {
    const targets: ItemTarget[] = recipeIds.map((recipeId) => ({
      itemId: fullPack.recipes.find((r) => r.id === recipeId)!.out[0]!.item,
      ratePerSec: { num: "1", denom: "1" },
    }));
    const full = solvePlanWithIntermediates(
      targets,
      fullPack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, fullPack, targets, []);
    return { plan, rates: full.rates, pack: fullPack, targets, itemOverrides: [] };
  }

  // P6: a sibling replica's co-product edge used to be dropped, so the surviving
  // edge was billed past its producer's capacity (clause (a) caught the
  // over-ship). The co-product sibling-fanning fix in assignSplitRoles now wires
  // every live split sibling for the co-product, so P6 reports zero violations.
  // REGRESSION LOCK: was a pre-fix baseline asserting the bug present; inverted
  // when the fix landed.
  it("P6 (xiranite_enr_powder + proc_battery_5) reports no violations", () => {
    const result = checkUnitOutflowVsProduction(
      fullPipelineArgs([
        "jinlong_coupon-xiranite_enr_powder",
        "jinlong_coupon-proc_battery_5",
      ]),
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // P7: a phantom target edge from a unit with zero true spare. The target pass
  // aggregated spare per machine vertex and clamped the negative half of a folded
  // unit's offsetting stamp residuals, inflating its apparent spare so the split
  // gave it a target edge it could not back. Aggregating spare per render unit
  // before the split clears it.
  // REGRESSION LOCK: was a pre-fix baseline asserting the bug present; inverted
  // when the target-pass unit-level spare aggregation fix landed.
  it("P7 (plant_moss_seed_3 + plant_moss_powder_3) reports no violations", () => {
    const result = checkUnitOutflowVsProduction(
      fullPipelineArgs(["plant_moss_seed_3", "plant_moss_powder_3"]),
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Real-pack negative controls: two structurally simple single-chain plans
  // probe-verified clean at baseline (zero violations from this checker AND the
  // seven existing checkers AND no solver mass-balance residual). They keep this
  // checker honest on plans the burn-down fixes must not regress.
  it("clean control plant glass_bottle reports no violations", () => {
    const result = checkUnitOutflowVsProduction(fullPipelineArgs(["glass_bottle"]));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("clean control plant iron_cmpt reports no violations", () => {
    const result = checkUnitOutflowVsProduction(fullPipelineArgs(["iron_cmpt"]));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Checker blind-spot regressions (B5L5-c, B5L5-d)
// ---------------------------------------------------------------------------

// Full-pipeline args for the mutation tests below: solve real-pack targets at
// 1/sec and clone the plan so mutations never leak between tests.
function mutableArgs(recipeIds: string[]): {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<ItemTarget>;
  itemOverrides: ReadonlyArray<ItemOverride>;
} {
  const targets: ItemTarget[] = recipeIds.map((recipeId) => ({
    itemId: fullPack.recipes.find((r) => r.id === recipeId)!.out[0]!.item,
    ratePerSec: { num: "1", denom: "1" },
  }));
  const full = solvePlanWithIntermediates(
    targets,
    fullPack,
    defaultTransportConfig,
    [],
  );
  const { plan } = renderPlanFromSolve(full, fullPack, targets, []);
  const cloned: RenderPlan = {
    units: plan.units.map((u) => ({ ...u })) as RenderUnit[],
    edges: plan.edges.map((e) => ({ ...e })) as RenderEdge[],
    containers: plan.containers,
  };
  return {
    plan: cloned,
    rates: full.rates,
    pack: fullPack,
    targets,
    itemOverrides: [],
  };
}

function scaleRational(
  rate: RationalString,
  factor: number,
): RationalString {
  const f = new Fraction(`${rate.num}/${rate.denom}`).mul(factor);
  return { num: f.n.toString(), denom: f.d.toString() };
}

describe("checkUnitOutflowVsProduction clause (c): multiplicity anchored on LP rates", () => {
  // B5L5-c: clauses (a)/(b) reconstruct production from unit.multiplicity, so a
  // plan whose multiplicity AND outgoing edges are inflated by the same factor
  // is render-vs-render coherent and was invisible to the checker (the live
  // B5L5-a defect shipped exactly this shape: iron_ore unit at multiplicity 3
  // and edge 1/s against LP production 3/4). Clause (c) compares the
  // multiplicity-derived rate sum per recipe against args.rates.
  it("fires on a coherently inflated unit (multiplicity and edges x2)", () => {
    const args = mutableArgs(["copper_nugget"]);
    const unit = args.plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "copper_nugget",
    );
    if (!unit || !isRecipeUnit(unit)) throw new Error("missing unit");
    (unit as { multiplicity: RationalString }).multiplicity = scaleRational(
      unit.multiplicity,
      2,
    );
    for (const e of args.plan.edges) {
      if (e.fromUnit === unit.id) e.rate = e.rate.mul(2);
    }
    const result = checkUnitOutflowVsProduction(args);
    expect(
      result.violations.some((v) => v.includes("multiplicity-derived rate")),
    ).toBe(true);
  });

  it("clean baseline reports no violations", () => {
    const result = checkUnitOutflowVsProduction(mutableArgs(["copper_nugget"]));
    expect(result.violations).toEqual([]);
  });
});

describe("checkProductUnitRates: boundary-unit chips and inputProduct edges", () => {
  // B5L5-d: the displayed rate chips on input/surplus/target product units and
  // the inputProduct->inputProduct aggregate wiring were validated by no
  // checker; the corruption classes below all passed the previous eight.

  it("clean single-bucket plan reports no violations", () => {
    const result = checkProductUnitRates(mutableArgs(["copper_nugget"]));
    expect(result.violations).toEqual([]);
  });

  it("fires on an inflated inputProduct rate chip", () => {
    const args = mutableArgs(["copper_nugget"]);
    const unit = args.plan.units.find((u) => isInputProductUnit(u));
    if (!unit || !isInputProductUnit(unit)) throw new Error("missing input");
    (unit as { rate: RationalString }).rate = scaleRational(unit.rate, 10);
    const result = checkProductUnitRates(args);
    expect(result.violations.some((v) => v.includes("rate chip"))).toBe(true);
  });

  it("fires on an inflated surplus outputProduct rate chip", () => {
    const args = mutableArgs(["copper_nugget"]);
    const unit = args.plan.units.find(
      (u) => isOutputProductUnit(u) && u.flavor === "surplus",
    );
    if (!unit || !isOutputProductUnit(unit)) throw new Error("missing surplus");
    (unit as { rate: RationalString }).rate = scaleRational(unit.rate, 10);
    const result = checkProductUnitRates(args);
    expect(
      result.violations.some((v) => v.includes("outputProduct (surplus)")),
    ).toBe(true);
  });

  it("fires on an inflated target outputProduct rate chip", () => {
    const args = mutableArgs(["copper_nugget"]);
    const unit = args.plan.units.find(
      (u) => isOutputProductUnit(u) && u.flavor === "target",
    );
    if (!unit || !isOutputProductUnit(unit)) throw new Error("missing target");
    (unit as { rate: RationalString }).rate = scaleRational(unit.rate, 10);
    const result = checkProductUnitRates(args);
    expect(
      result.violations.some((v) => v.includes("outputProduct (target)")),
    ).toBe(true);
  });

  // The aggregate-input plan: liquid_water fans out u:in:liquid_water ->
  // per-container slices. Both aggregate-edge corruption classes passed every
  // checker before.
  it("clean aggregate plan reports no violations", () => {
    const result = checkProductUnitRates(mutableArgs(["xiranite_enr_powder"]));
    expect(result.violations).toEqual([]);
  });

  it("fires on a corrupted aggregate->fanout edge (x10)", () => {
    const args = mutableArgs(["xiranite_enr_powder"]);
    const inputIds = new Set(
      args.plan.units.filter((u) => isInputProductUnit(u)).map((u) => u.id),
    );
    const edge = args.plan.edges.find(
      (e) => e.fromUnit === "u:in:liquid_water" && inputIds.has(e.toUnit),
    );
    if (!edge) throw new Error("missing aggregate->fanout edge");
    edge.rate = edge.rate.mul(10);
    const result = checkProductUnitRates(args);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("fires on a dropped aggregate->fanout edge", () => {
    const args = mutableArgs(["xiranite_enr_powder"]);
    const inputIds = new Set(
      args.plan.units.filter((u) => isInputProductUnit(u)).map((u) => u.id),
    );
    const idx = args.plan.edges.findIndex(
      (e) => e.fromUnit === "u:in:liquid_water" && inputIds.has(e.toUnit),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    (args.plan.edges as RenderEdge[]).splice(idx, 1);
    const result = checkProductUnitRates(args);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("fires on a spurious boundary edge into a non-consumer", () => {
    const args = mutableArgs(["xiranite_enr_powder"]);
    const recipeById = new Map(fullPack.recipes.map((r) => [r.id, r]));
    const inU = args.plan.units.find(
      (u) => isInputProductUnit(u) && !u.isAggregate,
    );
    if (!inU || !isInputProductUnit(inU)) throw new Error("missing input");
    const victim = args.plan.units.find((u) => {
      if (!isRecipeUnit(u)) return false;
      const rec = recipeById.get(u.recipeId);
      return rec !== undefined && !rec.in.some((s) => s.item === inU.itemId);
    });
    if (!victim) throw new Error("missing victim");
    (args.plan.edges as RenderEdge[]).push({
      fromUnit: inU.id,
      toUnit: victim.id,
      item: inU.itemId,
      rate: new Fraction(7),
      transportKind: fullPack.items.find((i) => i.id === inU.itemId)!
        .transportKind,
    });
    const result = checkProductUnitRates(args);
    expect(
      result.violations.some((v) => v.includes("does not consume")),
    ).toBe(true);
  });
});
