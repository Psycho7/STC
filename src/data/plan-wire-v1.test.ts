import { describe, expect, it } from "vitest";
import { toWire, fromWire } from "./plan-wire-v1";
import type { Plan } from "./plan";
import { pack } from "./load";
import { recipeCostWeight } from "../solver/lp";
import { planToSolverArgs } from "../solver/planToSolverArgs";

function basePlan(): Plan {
  return {
    version: 1,
    pack: { id: "aef", schemaVersion: "0.2", submoduleSha: "abc" },
    title: "t",
    targets: [],
  };
}

describe("plan-wire-v1 recipeCosts", () => {
  it("round-trips recipeCosts sorted by recipe id", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([
      ["zeta_recipe", { num: "5", denom: "2" }],
      ["alpha_recipe", { num: "0", denom: "1" }],
    ]);
    const back = fromWire(toWire(plan));
    expect(back.recipeCosts).toBeInstanceOf(Map);
    expect([...back.recipeCosts!.keys()]).toEqual([
      "alpha_recipe",
      "zeta_recipe",
    ]);
    expect(back.recipeCosts!.get("zeta_recipe")).toEqual({
      num: "5",
      denom: "2",
    });
  });

  it("keeps 1/1 entries on the wire (default cost is not uniformly 1)", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([
      ["zero_cost", { num: "0", denom: "1" }],
      ["unit_cost", { num: "1", denom: "1" }],
    ]);
    const wire = toWire(plan);
    expect(wire.recipeCosts).toBeDefined();
    expect(Object.keys(wire.recipeCosts!)).toEqual(["unit_cost", "zero_cost"]);
  });

  it("leaves recipeCosts undefined when absent", () => {
    const back = fromWire(toWire(basePlan()));
    expect(back.recipeCosts).toBeUndefined();
  });

  // Big-M recipes (target-only / excluded producers) default to 1e6, not 1,
  // so a deliberate 1/1 override is load-bearing and must survive the wire.
  it("round-trips a 1/1 override on a big-M recipe with the same solve weight", () => {
    const recipeId = "transfer_tundra_bottled_food_1";
    const recipe = pack.recipes.find((r) => r.id === recipeId)!;
    expect(recipe).toBeDefined();
    expect(recipeCostWeight(recipe, undefined)).toBe(1e6);

    const plan = basePlan();
    plan.recipeCosts = new Map([[recipeId, { num: "1", denom: "1" }]]);
    const weightBefore = recipeCostWeight(
      recipe,
      planToSolverArgs(plan).recipeCosts,
    );
    expect(weightBefore).toBe(1);

    const back = fromWire(toWire(plan));
    const weightAfter = recipeCostWeight(
      recipe,
      planToSolverArgs(back).recipeCosts,
    );
    expect(weightAfter).toBe(1);
  });
});
