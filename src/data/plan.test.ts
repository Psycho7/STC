import { describe, expect, it } from "vitest";
import { pack } from "./load";
import {
  defaultPlan,
  validatePlan,
  loadPlan,
  encodePlan,
  type Plan,
} from "./plan";

// defaultPlan carries valid targets and a matching schemaVersion, the clean
// baseline each malformed-rational case mutates one field of.
function basePlan(): Plan {
  return defaultPlan(pack);
}

describe("validatePlan - rational wire fields", () => {
  it("accepts the default plan", () => {
    expect(validatePlan(basePlan(), pack)).toBeNull();
  });

  it("accepts a well-formed recipeCost override", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([
      [plan.targets[0]!.recipeId, { num: "5", denom: "2" }],
    ]);
    expect(validatePlan(plan, pack)).toBeNull();
  });

  // Each row mutates one field of a clean basePlan() to carry one malformed
  // rational; all must fail validation with kind "invalid-rational".
  it.each([
    {
      name: "a target rate with a zero denominator",
      mutate: (plan: Plan) => {
        plan.targets = [
          { recipeId: plan.targets[0]!.recipeId, ratePerSec: { num: "1", denom: "0" } },
        ];
      },
    },
    {
      name: "a target rate with a non-numeric numerator",
      mutate: (plan: Plan) => {
        plan.targets = [
          { recipeId: plan.targets[0]!.recipeId, ratePerSec: { num: "abc", denom: "1" } },
        ];
      },
    },
    {
      name: "a negative target rate",
      mutate: (plan: Plan) => {
        plan.targets = [
          { recipeId: plan.targets[0]!.recipeId, ratePerSec: { num: "-5", denom: "2" } },
        ];
      },
    },
    {
      name: "an item-override cap with a negative denominator",
      mutate: (plan: Plan) => {
        plan.itemOverrides = [
          { itemId: pack.items[0]!.id, ratePerSec: { num: "1", denom: "-2" } },
        ];
      },
    },
    {
      name: "an item-override cap with a zero denominator",
      mutate: (plan: Plan) => {
        plan.itemOverrides = [
          { itemId: pack.items[0]!.id, ratePerSec: { num: "1", denom: "0" } },
        ];
      },
    },
    {
      name: "a recipeCost with a zero denominator",
      mutate: (plan: Plan) => {
        plan.recipeCosts = new Map([
          [plan.targets[0]!.recipeId, { num: "1", denom: "0" }],
        ]);
      },
    },
  ])("rejects $name", ({ mutate }) => {
    const plan = basePlan();
    mutate(plan);
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
  });

  it("rejects a target referencing an unknown recipe", () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: "no_such_recipe", ratePerSec: { num: "1", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("unknown-target-recipe");
  });

  it("rejects a recipeCost referencing an unknown recipe", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([["no_such_recipe", { num: "5", denom: "2" }]]);
    expect(validatePlan(plan, pack)?.kind).toBe("unknown-recipe-cost");
  });

  it("rejects a sink recipe as a target", () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: "liquid_cleaner_1-sewage", ratePerSec: { num: "1", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("target-not-a-producer");
  });

  it("rejects a malformed rational end-to-end through loadPlan", async () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: plan.targets[0]!.recipeId, ratePerSec: { num: "5", denom: "0" } },
    ];
    const hash = await encodePlan(plan);
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("invalid-rational");
    }
  });
});
