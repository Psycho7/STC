// Finite supply-cap rendering end to end: the LP's bounded boundary draw must
// thread through replicate (replica rates / machine counts), computeEdgeRates
// (residual producer billing), and deriveBoundaryProducts (boundary import
// sized by the realized draw, zero-draw caps emit nothing). vitest runs with
// import.meta.env.DEV = true, so solvePlanWithIntermediates and
// renderPlanFromSolve both run their invariant hooks; completing without a
// throw is itself an assertion.
import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { pack } from "../../data/load";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import { renderPlanFromSolve } from "../driver";
import { checkRenderPlan } from "./invariants";
import { makePack } from "../../solver/closed-form-fixtures";
import { isInputProductUnit, isOutputProductUnit, isRecipeUnit } from "../types";
import type { RenderPlan } from "../types";
import type { ItemTarget } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";

function solveAndRender(
  targets: ItemTarget[],
  overrides: ItemOverride[],
  fixturePack = pack,
): {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  softFeasible: boolean;
} {
  const full = solvePlanWithIntermediates(
    targets,
    fixturePack,
    defaultTransportConfig,
    overrides,
  );
  const { plan } = renderPlanFromSolve(full, fixturePack, targets, overrides);
  const violations = checkRenderPlan({
    plan,
    rates: full.rates,
    pack: fixturePack,
    targets,
    itemOverrides: overrides,
  }).flatMap((r) => r.violations);
  expect(violations).toEqual([]);
  return { plan, rates: full.rates, softFeasible: full.feasibility.softFeasible };
}

function inflow(plan: RenderPlan, toUnit: string, item: string): Fraction {
  let sum = new Fraction(0);
  for (const e of plan.edges) {
    if (e.toUnit === toUnit && e.item === item) sum = sum.add(e.rate);
  }
  return sum;
}

// Every producer of copper_ore is an extractor, so a plan can only import it
// over the boundary: capping it short leaves the target under-fed instead of
// splitting the demand. The matrix keeps copper_ore for the rows the boundary
// covers on its own and asserts a deficit on the rows it cannot; the
// residual-split cases that need a raw item with a real producer run on a
// synthetic pack below.
describe("itemOverride matrix on copper_nugget@1/s (copper_ore)", () => {
  const targets: ItemTarget[] = [
    {
      itemId: "copper_nugget",
      ratePerSec: { num: "1", denom: "1" },
    },
  ];
  const covered: Array<[string, ItemOverride[]]> = [
    ["none", []],
    ["cap 5 above demand", [{ itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } }]],
    ["cap 1 exact", [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } }]],
  ];

  it.each(covered)("%s solves and renders clean under DEV", (_name, overrides) => {
    const { plan } = solveAndRender(targets, overrides);
    const consumerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "copper_nugget",
    )!;
    expect(inflow(plan, consumerUnit.id, "copper_ore").equals(1)).toBe(true);
  });

  // plan:true asks for copper_ore to be built rather than imported, and the
  // only recipe that makes it is the hydro miner, so the request seeds nothing.
  const short: Array<[string, ItemOverride[]]> = [
    ["plan:true", [{ itemId: "copper_ore", plan: true }]],
    ["cap 1/2 below demand", [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]],
    ["cap 0", [{ itemId: "copper_ore", ratePerSec: { num: "0", denom: "1" } }]],
  ];

  // Solver-level only. A plan that goes short still violates the DEV render
  // invariants (a target delivered below its declared rate, a consumer fed
  // from nothing), which is true of every shortfall plan and not of this ban -
  // capping iron_ore short has always thrown the same way.
  it.each(short)("%s reports the shortfall and mines nothing", (_name, overrides) => {
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      overrides,
    );
    expect(full.rates.has("copper_ore-liquid_water")).toBe(false);
    expect(full.feasibility.softFeasible).toBe(false);
  });

  it("cap 5 above demand: the draw feeds everything, no phantom surplus unit", () => {
    const { plan, rates } = solveAndRender(targets, [
      { itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } },
    ]);
    // The free draw beats the costed producer recipe; no internal producer.
    expect(rates.has("copper_ore-liquid_water")).toBe(false);
    const surplus = plan.units.filter(
      (u) =>
        isOutputProductUnit(u) && u.flavor === "surplus" && u.itemId === "copper_ore",
    );
    expect(surplus).toEqual([]);
    const input = plan.units.find(
      (u) => isInputProductUnit(u) && u.itemId === "copper_ore",
    );
    if (!input || !isInputProductUnit(input)) throw new Error("missing input");
    expect(input.rate).toEqual({ num: "1", denom: "1" });
  });
});

// A capped raw item whose demand a real producer can top up. The shipped pack
// has no such item left - every raw one is extractor-only - so the split runs
// on a synthetic pack: mkM makes the capped item m from the free raw z, taking
// 3s per unit so the reconciled machine count is a fraction worth reading.
describe("residual split on a capped raw item with a real producer", () => {
  const fixturePack = makePack(
    [
      { id: "mkM", time: 3, in: { z: 1 }, out: { m: 1 } },
      { id: "useM", time: 1, in: { m: 1 }, out: { f: 1 } },
    ],
    [{ id: "z", raw: true }, { id: "m", raw: true }, { id: "f" }],
  );
  const targets: ItemTarget[] = [
    { itemId: "f", ratePerSec: { num: "1", denom: "1" } },
  ];

  it("cap 1/2 below demand: boundary covers 1/2, internal producer the rest", () => {
    const { plan, rates } = solveAndRender(
      targets,
      [{ itemId: "m", ratePerSec: { num: "1", denom: "2" } }],
      fixturePack,
    );
    expect(rates.get("mkM")?.equals(new Fraction(1, 2))).toBe(true);
    const consumerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "useM",
    )!;
    const producerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "mkM",
    )!;
    const boundary = plan.edges.find(
      (e) => e.fromUnit === "u:in:m" && e.toUnit === consumerUnit.id,
    );
    expect(boundary?.rate.equals(new Fraction(1, 2))).toBe(true);
    // Internal producer edge carries the residual half; together with the draw
    // the consumer sees exactly its demand of 1.
    const internal = plan.edges.find(
      (e) =>
        e.fromUnit === producerUnit.id &&
        e.toUnit === consumerUnit.id &&
        e.item === "m",
    );
    expect(internal?.rate.equals(new Fraction(1, 2))).toBe(true);
    expect(inflow(plan, consumerUnit.id, "m").equals(1)).toBe(true);

    // The producer's machine count derives from the reconciled residual rate
    // (time 3, 1 m per run -> 1/3 per machine-sec, so LP rate 1/2 is 3/2
    // machines), not from the pre-cap full demand.
    if (!isRecipeUnit(producerUnit)) throw new Error("expected recipe unit");
    expect(producerUnit.multiplicity).toEqual({ num: "3", denom: "2" });

    // Input product chip shows the realized draw next to the cap.
    const input = plan.units.find(
      (u) => isInputProductUnit(u) && u.itemId === "m",
    );
    if (!input || !isInputProductUnit(input)) throw new Error("missing input");
    expect(input.rate).toEqual({ num: "1", denom: "2" });
    expect(input.rateCap).toEqual({ num: "1", denom: "2" });
  });

  // The same split on the shipped pack, where the capped item is a gas the
  // phase-transition recipe can make: gas_xiranite capped at 1/10 is drawn in
  // full and phase_trans_2-gas_xiranite covers the rest.
  it("splits a shipped-pack cap between the boundary and a real producer", () => {
    const { plan, rates, softFeasible } = solveAndRender(
      [{ itemId: "gas_copper", ratePerSec: { num: "1", denom: "1" } }],
      [{ itemId: "gas_xiranite", ratePerSec: { num: "1", denom: "10" } }],
    );
    expect(softFeasible).toBe(true);
    expect(rates.get("phase_trans_2-gas_xiranite")?.gt(0)).toBe(true);
    const input = plan.units.find(
      (u) => isInputProductUnit(u) && u.itemId === "gas_xiranite",
    );
    if (!input || !isInputProductUnit(input)) throw new Error("missing input");
    expect(input.rate).toEqual({ num: "1", denom: "10" });
    const producerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_2-gas_xiranite",
    );
    expect(producerUnit).toBeDefined();
    // Both reaches into the gas_xiranite consumers exist: the boundary draw and
    // the internal producer.
    expect(
      plan.edges.some((e) => e.fromUnit === input.id && e.item === "gas_xiranite"),
    ).toBe(true);
    expect(
      plan.edges.some(
        (e) => e.fromUnit === producerUnit!.id && e.item === "gas_xiranite",
      ),
    ).toBe(true);
  });
});

describe("forced-byproduct zero-draw cap", () => {
  // A finite cap whose realized LP draw is 0: the target's co-product fully
  // covers the capped item's consumption, and drawing would push the byproduct
  // into costed surplus, so the LP keeps draw 0. The boundary input product
  // must not be emitted at all (skip-emission, not checker relaxation).
  const fixturePack = makePack(
    [
      { id: "tP", time: 1, in: { x: 1 }, out: { p: 1, c: 1 } },
      { id: "uR", time: 1, in: { c: 1 }, out: { r: 1 } },
    ],
    [{ id: "x", raw: true }, { id: "p" }, { id: "c" }, { id: "r" }],
  );
  const targets: ItemTarget[] = [
    { itemId: "p", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "r", ratePerSec: { num: "1", denom: "1" } },
  ];
  const overrides: ItemOverride[] = [
    { itemId: "c", ratePerSec: { num: "10", denom: "1" } },
  ];

  it("renders clean under DEV and emits no input product for the unused cap", () => {
    const { plan } = solveAndRender(targets, overrides, fixturePack);
    const inputsForC = plan.units.filter(
      (u) => isInputProductUnit(u) && u.itemId === "c",
    );
    expect(inputsForC).toEqual([]);
    // The byproduct feeds the consumer through the internal edge at full
    // demand; no boundary edge exists for c.
    const consumerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "uR",
    )!;
    expect(inflow(plan, consumerUnit.id, "c").equals(1)).toBe(true);
    expect(plan.edges.some((e) => e.fromUnit.startsWith("u:in:c"))).toBe(false);
  });
});
