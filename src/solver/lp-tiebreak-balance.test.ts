import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solvePlanWithIntermediates, type SolvePlanFull } from "./index";
import { planToSolverArgs } from "./planToSolverArgs";
import { pack } from "../data/load";
import { defaultPlan, type Plan } from "../data/plan";
import {
  latestArea,
  unavailableCauses,
  unavailableRecipeIds,
} from "../data/availability";

// The boundary and lex tie-break passes carry a cost_cap row whose right-hand
// side is dominated by the 1e9 deficit weight, so the engine can land them a
// few ulps off a mass-balance row without paying any deficit. Under tundra the
// default plan used to come out with iron_powder at 41666/166665 per second,
// which the extraction then reported as a 1/666660 deficit against a 1/4
// demand that pass 1 met exactly. A tie-break pass that breaks a balance row
// beyond the extraction's own tolerance is now rejected in favour of the
// earlier pass, so iron_powder is delivered at exactly 1/4.

function solveIn(plan: Plan, area: string): SolvePlanFull {
  const { targets, itemOverrides, recipeCosts } = planToSolverArgs(plan);
  const unavailable = unavailableRecipeIds(
    unavailableCauses(pack, { eventOverrides: {}, area }),
  );
  return solvePlanWithIntermediates(
    targets,
    pack,
    itemOverrides,
    recipeCosts,
    unavailable,
  );
}

// Net production of one item over the solved recipe rates, on the netted
// stoichiometry the LP saw.
function netRate(full: SolvePlanFull, item: string): Fraction {
  let net = new Fraction(0);
  for (const [recipeId, rate] of full.rates) {
    const recipe = full.nettedRecipeById.get(recipeId)!;
    for (const o of recipe.out) {
      if (o.item === item) net = net.add(rate.mul(o.qty));
    }
    for (const i of recipe.in) {
      if (i.item === item) net = net.sub(rate.mul(i.qty));
    }
  }
  return net;
}

function deficitFractions(full: SolvePlanFull): Map<string, string> {
  return new Map(
    [...full.feasibility.deficits].map(([item, rate]) => [
      item,
      rate.toFraction(),
    ]),
  );
}

// The default plan with copper_ore capped at 1 per minute, as the share link
// that first showed the phantom iron_powder shortfall in the browser.
function cappedCopperOrePlan(): Plan {
  return {
    ...defaultPlan(pack),
    itemOverrides: [
      { itemId: "copper_ore", ratePerSec: { num: "1", denom: "60" } },
    ],
  };
}

describe("tie-break passes keep mass balance", () => {
  it("delivers the tundra default plan's iron_powder at exactly 1/4", () => {
    const full = solveIn(defaultPlan(pack), "tundra");

    expect(netRate(full, "iron_powder").toFraction()).toBe("1/4");
    expect(deficitFractions(full)).toEqual(
      new Map([
        ["copper_bottle", "2"],
        ["copper_powder", "1/2"],
      ]),
    );
  });

  it("delivers iron_powder at exactly 1/4 with copper_ore capped at 1/min", () => {
    for (const area of ["tundra", latestArea(pack)]) {
      const full = solveIn(cappedCopperOrePlan(), area);

      expect(netRate(full, "iron_powder").toFraction()).toBe("1/4");
      expect(full.feasibility.deficits.has("iron_powder")).toBe(false);
    }
  });
});
