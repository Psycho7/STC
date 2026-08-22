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
): { plan: RenderPlan; rates: ReadonlyMap<string, Fraction> } {
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
  return { plan, rates: full.rates };
}

function inflow(plan: RenderPlan, toUnit: string, item: string): Fraction {
  let sum = new Fraction(0);
  for (const e of plan.edges) {
    if (e.toUnit === toUnit && e.item === item) sum = sum.add(e.rate);
  }
  return sum;
}

// The cap fixture used to be iron_ore, whose only producer is the miner. With
// no solution allowed to run one, capping iron_ore short leaves the target
// under-fed rather than splitting the demand, so the residual-split cases below
// all run on copper_ore, which copper_ore-liquid_water really does produce.
describe("itemOverride matrix on copper_nugget@1/s (copper_ore)", () => {
  const targets: ItemTarget[] = [
    {
      itemId: "copper_nugget",
      ratePerSec: { num: "1", denom: "1" },
    },
  ];
  const cases: Array<[string, ItemOverride[]]> = [
    ["none", []],
    ["plan:true", [{ itemId: "copper_ore", plan: true }]],
    ["cap 5 above demand", [{ itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } }]],
    ["cap 1 exact", [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } }]],
    ["cap 1/2 below demand", [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]],
    ["cap 0", [{ itemId: "copper_ore", ratePerSec: { num: "0", denom: "1" } }]],
  ];

  it.each(cases)("%s solves and renders clean under DEV", (_name, overrides) => {
    const { plan } = solveAndRender(targets, overrides);
    const consumerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "copper_nugget",
    )!;
    expect(inflow(plan, consumerUnit.id, "copper_ore").equals(1)).toBe(true);
  });

  it("cap 1/2 below demand: boundary covers 1/2, internal producer the rest", () => {
    const { plan, rates } = solveAndRender(targets, [
      { itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } },
    ]);
    expect(rates.get("copper_ore-liquid_water")?.equals(new Fraction(1, 2))).toBe(
      true,
    );
    const consumerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "copper_nugget",
    )!;
    const producerUnit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "copper_ore-liquid_water",
    )!;
    const boundary = plan.edges.find(
      (e) => e.fromUnit === "u:in:copper_ore" && e.toUnit === consumerUnit.id,
    );
    expect(boundary?.rate.equals(new Fraction(1, 2))).toBe(true);
    // Internal producer edge carries the residual half; together with the draw
    // the consumer sees exactly its demand of 1.
    const internal = plan.edges.find(
      (e) =>
        e.fromUnit === producerUnit.id &&
        e.toUnit === consumerUnit.id &&
        e.item === "copper_ore",
    );
    expect(internal?.rate.equals(new Fraction(1, 2))).toBe(true);
    expect(inflow(plan, consumerUnit.id, "copper_ore").equals(1)).toBe(true);

    // The producer's machine count derives from the reconciled residual rate
    // (time 3, 1 ore per run -> 1/3 per machine-sec, so LP rate 1/2 is 3/2
    // machines), not from the pre-cap full demand.
    if (!isRecipeUnit(producerUnit)) throw new Error("expected recipe unit");
    expect(producerUnit.multiplicity).toEqual({ num: "3", denom: "2" });

    // Input product chip shows the realized draw next to the cap.
    const input = plan.units.find(
      (u) => isInputProductUnit(u) && u.itemId === "copper_ore",
    );
    if (!input || !isInputProductUnit(input)) throw new Error("missing input");
    expect(input.rate).toEqual({ num: "1", denom: "2" });
    expect(input.rateCap).toEqual({ num: "1", denom: "2" });
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
