import { describe, expect, it } from "vitest";
import { pack } from "./load";
import {
  defaultPlan,
  validatePlan,
  loadPlan,
  encodePlan,
  type Plan,
} from "./plan";

// defaultPlan carries valid targets and a matching schemaVersion, so it is the
// clean baseline every malformed-rational case mutates one field of.
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

  it("rejects a target rate with a zero denominator", () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: plan.targets[0]!.recipeId, ratePerSec: { num: "1", denom: "0" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
  });

  it("rejects a target rate with a non-numeric numerator", () => {
    const plan = basePlan();
    plan.targets = [
      {
        recipeId: plan.targets[0]!.recipeId,
        ratePerSec: { num: "abc", denom: "1" },
      },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
  });

  it("rejects an item-override cap with a zero denominator", () => {
    const plan = basePlan();
    plan.itemOverrides = [
      { itemId: pack.items[0]!.id, ratePerSec: { num: "1", denom: "0" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
  });

  it("rejects a recipeCost with a zero denominator", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([
      [plan.targets[0]!.recipeId, { num: "1", denom: "0" }],
    ]);
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
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
