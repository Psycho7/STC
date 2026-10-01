// Finite supply-cap rendering end to end: the LP's bounded boundary draw must
// thread through replicate (replica rates / machine counts), computeEdgeRates
// (residual producer billing), and deriveBoundaryProducts (boundary import
// sized by the realized draw, zero-draw caps emit nothing). vitest runs with
// import.meta.env.DEV = true, so solvePlanWithIntermediates and
// renderPlanFromSolve both run their invariant hooks; completing without a
// throw is itself an assertion.
import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import { pack } from "../../data/load";
import { solvePlanWithIntermediates } from "../../solver/index";
import type { SolvePlanFull } from "../../solver/index";
import { solveForRender, solveFromPlan } from "../solveForRender";
import { checkRenderPlan, targetOutputShortfalls } from "./invariants";
import { makePack } from "../../solver/closed-form-fixtures";
import {
  isInputProductUnit,
  isOutputProductUnit,
  isRecipeUnit,
} from "../types";
import type { RenderPlan } from "../types";
import type { ItemTarget } from "../../data/targets";
import { defaultPlan, type ItemOverride } from "../../data/plan";
import { rationalFromString } from "./rational";

function solveAndRender(
  targets: ItemTarget[],
  overrides: ItemOverride[],
  fixturePack = pack,
): {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  catalystAccount: SolvePlanFull["catalystAccount"];
  softFeasible: boolean;
} {
  const { full, plan } = solveForRender({
    targets,
    pack: fixturePack,
    itemOverrides: overrides,
  });
  const violations = checkRenderPlan({
    plan,
    rates: full.rates,
    pack: fixturePack,
    targets,
    itemOverrides: overrides,
    catalystAccount: full.catalystAccount,
  }).flatMap((r) => r.violations);
  expect(violations).toEqual([]);
  return {
    plan,
    rates: full.rates,
    catalystAccount: full.catalystAccount,
    softFeasible: full.feasibility.softFeasible,
  };
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
    [
      "cap 5 above demand",
      [{ itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } }],
    ],
    [
      "cap 1 exact",
      [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } }],
    ],
  ];

  it.each(covered)(
    "%s solves and renders clean under DEV",
    (_name, overrides) => {
      const { plan } = solveAndRender(targets, overrides);
      const consumerUnit = plan.units.find(
        (u) => isRecipeUnit(u) && u.recipeId === "copper_nugget",
      )!;
      expect(inflow(plan, consumerUnit.id, "copper_ore").equals(1)).toBe(true);
    },
  );

  // plan:true asks for copper_ore to be built rather than imported, and the
  // only recipe that makes it is the hydro miner, so the request seeds nothing.
  const short: Array<[string, ItemOverride[]]> = [
    ["plan:true", [{ itemId: "copper_ore", plan: true }]],
    [
      "cap 1/2 below demand",
      [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }],
    ],
    ["cap 0", [{ itemId: "copper_ore", ratePerSec: { num: "0", denom: "1" } }]],
  ];

  // Solver-level only. A plan that goes short still violates the DEV render
  // invariants (a target delivered below its declared rate, a consumer fed
  // from nothing), which is true of every shortfall plan and not of this ban -
  // capping iron_ore short has always thrown the same way.
  it.each(short)(
    "%s reports the shortfall and mines nothing",
    (_name, overrides) => {
      const full = solvePlanWithIntermediates(targets, pack, overrides);
      expect(full.rates.has("copper_ore-liquid_water")).toBe(false);
      expect(full.feasibility.softFeasible).toBe(false);
    },
  );

  it("cap 5 above demand: the draw feeds everything, no phantom surplus unit", () => {
    const { plan, rates } = solveAndRender(targets, [
      { itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } },
    ]);
    // The free draw beats the costed producer recipe; no internal producer.
    expect(rates.has("copper_ore-liquid_water")).toBe(false);
    const surplus = plan.units.filter(
      (u) =>
        isOutputProductUnit(u) &&
        u.flavor === "surplus" &&
        u.itemId === "copper_ore",
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
});

// The xiranite a phase transmuter cycles is a catalyst: it stays out of mass
// balance, and since the charge is per machine rather than per cycle the LP
// does not see it either. A cap on the item therefore throttles nothing, and
// the account reports what the cap cannot hold instead.
describe("catalyst against a shipped-pack cap", () => {
  it("does not throttle the transmuter and bills the overshoot to the account", () => {
    const { plan, rates, catalystAccount, softFeasible } = solveAndRender(
      [{ itemId: "gas_copper", ratePerSec: { num: "1", denom: "1" } }],
      [{ itemId: "gas_xiranite", ratePerSec: { num: "1", denom: "10" } }],
    );
    expect(softFeasible).toBe(true);
    // Nothing consumes gas_xiranite here, so the 1/10 cap leaves the solve
    // untouched: phase_trans_2-gas_copper covers the whole 1/s target on its
    // own and the liquid route it used to share with is never funded.
    expect(rates.get("phase_trans_2-gas_copper")?.equals(1)).toBe(true);
    expect(rates.has("phase_trans_1-gas_copper")).toBe(false);
    // Rate 1 on a 2 s cycle is 2 machines, each holding 0.2/2 = 1/10 per
    // second. No catalyst row exists, so pool G pays out of its typed cap -
    // untouched by any ordinary draw, hence the full 1/10 - and the other
    // 1/10 is reported unmet without disturbing the plan.
    const account = catalystAccount.get("gas_xiranite")!;
    expect(account.need.equals(new Fraction(1, 5))).toBe(true);
    expect(account.fromCatalyst.equals(0)).toBe(true);
    expect(account.fromGeneral.equals(new Fraction(1, 10))).toBe(true);
    expect(account.unmet.equals(new Fraction(1, 10))).toBe(true);
    // The cycled charge is boundary supply drawn from the item's own catalyst
    // node: one card carrying the whole need beside its cap, and one catalyst
    // edge into the transmuter. Nothing consumes gas_xiranite as a reagent
    // here, so no ordinary card exists.
    const importCard = plan.units.find(
      (u) => isInputProductUnit(u) && u.itemId === "gas_xiranite",
    );
    expect(importCard).toBeDefined();
    expect(importCard!.id).toBe("u:cat:gas_xiranite");
    expect((importCard as { rate: unknown }).rate).toEqual({
      num: "1",
      denom: "5",
    });
    const xiraniteEdges = plan.edges.filter((e) => e.item === "gas_xiranite");
    expect(xiraniteEdges.map((e) => e.fromUnit)).toEqual([
      "u:cat:gas_xiranite",
    ]);
    expect(xiraniteEdges.map((e) => e.toPortKind)).toEqual(["catalyst"]);
    expect(xiraniteEdges[0]!.rate.equals(new Fraction(1, 5))).toBe(true);
    expect(rates.has("phase_trans_2-gas_xiranite")).toBe(false);
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

// A target item that is also an in-plan input, short because a cap starves its
// producer. coupon-web: copper_jar is a 30/min target and a filter_core input,
// and copper_jar eats gas_inert. The LP bills the whole deficit to the item's
// row; the render bills it to the target, so the in-plan consumer is fed and
// the target card, the strip and `delivered` all read the LP's shortfall.
describe("short target that is also an in-plan input", () => {
  const COUPON_WEB: ItemTarget[] = [
    { itemId: "jinlong_coupon", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "filter_core", ratePerSec: { num: "1", denom: "4" } },
    { itemId: "copper_jar", ratePerSec: { num: "1", denom: "2" } },
  ];
  const DECLARED = new Fraction(1, 2);
  const capped = (perMin: number) =>
    solveFromPlan({
      ...defaultPlan(pack),
      targets: COUPON_WEB,
      itemOverrides: [
        {
          itemId: "gas_inert",
          ratePerSec: { num: String(perMin), denom: "60" },
        },
      ],
    });

  it.each([
    [30, new Fraction(3, 8)],
    [20, new Fraction(5, 24)],
  ])(
    "gas_inert %i/min feeds filter_core and delivers the LP's %s",
    (perMin, lpDelivered) => {
      vi.stubEnv("DEV", false);
      try {
        const out = capped(perMin);
        const deficit = out.full.feasibility.deficits.get("copper_jar");
        expect(deficit?.equals(DECLARED.sub(lpDelivered))).toBe(true);

        // The consumer gets its whole LP demand.
        const filterCore = out.plan.units.filter(
          (u) => isRecipeUnit(u) && u.recipeId === "filter_core",
        );
        expect(filterCore.length).toBeGreaterThan(0);
        const fed = filterCore.reduce(
          (acc, u) => acc.add(inflow(out.plan, u.id, "copper_jar")),
          new Fraction(0),
        );
        expect(fed.equals(out.full.rates.get("filter_core")!)).toBe(true);

        // The target takes declared minus the LP deficit, and every reader of
        // the shortfall agrees on it.
        const delivered = inflow(out.plan, "u:out:copper_jar", "copper_jar");
        expect(delivered.equals(lpDelivered)).toBe(true);
        const card = out.plan.units.find((u) => u.id === "u:out:copper_jar");
        if (!card || !isOutputProductUnit(card)) throw new Error("no card");
        expect(card.delivered).toBeDefined();
        expect(rationalFromString(card.delivered!).equals(lpDelivered)).toBe(
          true,
        );
        expect(out.underDelivered).toEqual(["copper_jar"]);
        expect(out.cappedAtLimit).toEqual(["gas_inert"]);
        const shortfalls = targetOutputShortfalls(out.plan, out.targets);
        expect(shortfalls.map((s) => s.item)).toEqual(["copper_jar"]);
        expect(shortfalls[0]!.actual).toBeCloseTo(lpDelivered.valueOf(), 12);

        const violations = checkRenderPlan({
          plan: out.plan,
          rates: out.full.rates,
          pack,
          targets: out.targets,
          itemOverrides: out.itemOverrides,
          catalystAccount: out.full.catalystAccount,
        }).flatMap((r) => r.violations);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatch(/^target output "copper_jar"/);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([30, 20])(
    "gas_inert %i/min trips only the target assert under DEV",
    (perMin) => {
      vi.stubEnv("DEV", true);
      try {
        expect(() => capped(perMin)).toThrow(
          /^render invariants violated:\ntarget output "copper_jar"[^\n]*$/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
