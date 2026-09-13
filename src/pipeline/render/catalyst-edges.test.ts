// Catalyst rows draw from the item's boundary input node, so the render plan
// carries one edge per (recipe unit, catalyst item) marked `toPortKind:
// "catalyst"`, and the boundary node's rate covers ordinary consumption plus
// the cycled draw. The draw is boundary supply no matter what the item is:
// raw or not, produced in-plan or not, capped or not.
//
// vitest runs with import.meta.env.DEV = true, so the render driver's
// invariant hook runs on every solve below; completing without a throw is
// itself an assertion that the checkers accept the catalyst edges.
import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";

import { pack } from "../../data/load";
import { solveForRender } from "../solveForRender";
import { checkRenderPlan } from "./invariants";
import { rationalFromString } from "./rational";
import { isInputProductUnit, isRecipeUnit } from "../types";
import type { RenderPlan, RenderEdge } from "../types";
import type { ItemTarget } from "../../data/targets";

const GAS_XIRANITE = "gas_xiranite";
const LIQUID_XIRANITE = "liquid_xiranite";

function assertClean(
  plan: RenderPlan,
  rates: ReadonlyMap<string, Fraction>,
  targets: ItemTarget[],
): void {
  const violations = checkRenderPlan({
    plan,
    rates,
    pack,
    targets,
    itemOverrides: [],
  }).flatMap((r) => r.violations);
  expect(violations).toEqual([]);
}

function catalystEdgesInto(plan: RenderPlan, unitId: string): RenderEdge[] {
  return plan.edges.filter(
    (e) => e.toUnit === unitId && e.toPortKind === "catalyst",
  );
}

function unitRate(plan: RenderPlan, unitId: string): Fraction {
  const unit = plan.units.find((u) => u.id === unitId);
  expect(unit, `no unit ${unitId}`).toBeDefined();
  expect(isInputProductUnit(unit!)).toBe(true);
  return rationalFromString(
    (unit as { rate: import("../types").RationalString }).rate,
  );
}

describe("catalyst supply edges", () => {
  // The worked example: gas_xiranite feeds equipment scripts as an ordinary
  // raw AND is cycled by every solid-gas transmuter the plan runs. The boundary
  // node has to read the sum, 390/min ordinary + 78/min cycled = 468/min.
  it("adds the catalyst draw to the boundary node rate on the worked example", () => {
    const targets: ItemTarget[] = [
      { itemId: "equip_script_4_3", ratePerSec: { num: "1", denom: "5" } },
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "2", denom: "5" } },
    ];
    const { full, plan } = solveForRender({ targets });
    assertClean(plan, full.rates, targets);

    expect(
      unitRate(plan, `u:in:${GAS_XIRANITE}`).equals(new Fraction(468, 60)),
    ).toBe(true);

    // Every solid-gas transmuter unit draws its cycled charge over an edge.
    const transmuters = plan.units.filter(
      (u) => isRecipeUnit(u) && u.recipeId.startsWith("phase_trans_2-"),
    );
    expect(transmuters.length).toBeGreaterThan(0);
    for (const u of transmuters) {
      const cat = catalystEdgesInto(plan, u.id);
      expect(
        cat.map((e) => e.item),
        `unit ${u.id}`,
      ).toEqual([GAS_XIRANITE]);
      expect(cat[0]!.fromUnit).toBe(`u:in:${GAS_XIRANITE}`);
    }
  }, 60000);

  // A catalyst rate is `executionRate * qty` summed over the unit's machines,
  // whatever the item's cap or in-plan production says.
  it("sizes each catalyst edge at the unit's aggregate draw", () => {
    const targets: ItemTarget[] = [
      { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { full, plan } = solveForRender({ targets });
    assertClean(plan, full.rates, targets);

    const recipeId = "phase_trans_1-liquid_copper";
    const unit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === recipeId,
    );
    expect(unit).toBeDefined();
    const cat = catalystEdgesInto(plan, unit!.id);
    expect(cat).toHaveLength(1);
    // 1 liquid_copper/s over a 2s cycle at 1 out/cycle is 1 execution/s, and
    // the recipe cycles 0.2 liquid_xiranite per execution.
    const expected = full.rates.get(recipeId)!.mul(new Fraction(1, 5));
    expect(cat[0]!.rate.equals(expected)).toBe(true);
    expect(cat[0]!.item).toBe(LIQUID_XIRANITE);
    // The consumer sits in a loop container, so it taps that container's
    // bucket card rather than the bare aggregate.
    const source = plan.units.find((u) => u.id === cat[0]!.fromUnit);
    expect(source && isInputProductUnit(source) && source.itemId).toBe(
      LIQUID_XIRANITE,
    );
  }, 60000);

  // liquid_xiranite is not raw and the plan builds it; the catalyst charge is
  // still boundary supply, so it gets a `u:in:` node of its own justified by
  // nothing but the draw.
  it("imports a non-raw self-catalyst the plan also produces", () => {
    const targets: ItemTarget[] = [
      { itemId: LIQUID_XIRANITE, ratePerSec: { num: "1", denom: "1" } },
    ];
    const { full, plan } = solveForRender({ targets });
    assertClean(plan, full.rates, targets);

    const producer = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_1-liquid_xiranite",
    );
    expect(
      producer,
      "premise: the plan runs the self-cycling producer",
    ).toBeDefined();

    const cat = catalystEdgesInto(plan, producer!.id);
    expect(cat).toHaveLength(1);
    expect(cat[0]!.item).toBe(LIQUID_XIRANITE);
    expect(cat[0]!.fromUnit).toBe(`u:in:${LIQUID_XIRANITE}`);
    expect(unitRate(plan, `u:in:${LIQUID_XIRANITE}`).equals(cat[0]!.rate)).toBe(
      true,
    );
  }, 60000);

  // phase_trans_2-xiranite_powder lists gas_xiranite as both a consumed input
  // and a cycled catalyst: two edges from the same boundary node, one per port
  // kind.
  it("draws two edges for a card carrying one item as in and catalyst", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    // Steer the LP onto the transmuter route; the carbon routes are otherwise
    // cheaper and never touch a catalyst.
    const recipeCosts = new Map<string, number>(
      pack.recipes
        .filter(
          (r) =>
            r.out[0]?.item === "xiranite_powder" &&
            r.id !== "phase_trans_2-xiranite_powder",
        )
        .map((r) => [r.id, 1000]),
    );
    const { full, plan } = solveForRender({ targets, recipeCosts });
    assertClean(plan, full.rates, targets);

    const unit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_2-xiranite_powder",
    );
    expect(
      unit,
      "premise: the steer picked the transmuter route",
    ).toBeDefined();

    const inbound = plan.edges.filter(
      (e) => e.toUnit === unit!.id && e.item === GAS_XIRANITE,
    );
    expect(inbound).toHaveLength(2);
    expect(inbound.every((e) => e.fromUnit === `u:in:${GAS_XIRANITE}`)).toBe(
      true,
    );
    expect(inbound.filter((e) => e.toPortKind === "catalyst")).toHaveLength(1);
    expect(inbound.filter((e) => e.toPortKind === undefined)).toHaveLength(1);
    // The node rate is the whole of both: 1 execution/s draws 1 in and cycles
    // 0.2 on top.
    const rate = full.rates.get("phase_trans_2-xiranite_powder")!;
    expect(
      unitRate(plan, `u:in:${GAS_XIRANITE}`).equals(
        rate.mul(new Fraction(6, 5)),
      ),
    ).toBe(true);
  }, 60000);
});
