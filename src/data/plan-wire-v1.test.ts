import { describe, expect, it } from "vitest";
import { toWire, fromWire } from "./plan-wire-v1";
import type { ItemOverride, Plan } from "./plan";
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

// Pins the designed wont-fix contract: encoding canonicalizes order for
// stable hashes, so user panel row order is not on the wire and decode
// yields sorted order regardless of input order.
describe("plan-wire-v1 canonical order", () => {
  it("decodes targets and itemOverrides in canonical sorted order", () => {
    const plan = basePlan();
    plan.targets = [
      { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
      { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
    ];
    plan.itemOverrides = [
      { itemId: "water", plan: true },
      { itemId: "ammonia", ratePerSec: { num: "3", denom: "1" } },
    ];
    const back = fromWire(toWire(plan));
    expect(back.targets.map((t) => t.itemId)).toEqual([
      "copper_bottle",
      "iron_powder",
    ]);
    expect(back.itemOverrides!.map((o) => o.itemId)).toEqual([
      "ammonia",
      "water",
    ]);
  });
});

// The wire boundary is where a plan is canonicalized. Element-level junk from a
// hand-crafted hash survives fromWire (validatePlan only checks the fields it
// knows), so encoding must rebuild each element instead of passing it through,
// otherwise the junk rides along into every link re-shared from that plan.
describe("plan-wire-v1 canonicalization", () => {
  it("drops an extra key on a target and on an item override", () => {
    const plan = basePlan();
    plan.targets = [
      {
        itemId: "iron_powder",
        ratePerSec: { num: "1", denom: "4" },
        junk: "payload",
      } as unknown as Plan["targets"][number],
    ];
    plan.itemOverrides = [
      {
        itemId: "water",
        plan: true,
        junk: "payload",
      } as unknown as ItemOverride,
    ];

    const wire = toWire(plan);
    expect(Object.keys(wire.targets[0]!)).toEqual(["itemId", "ratePerSec"]);
    expect(Object.keys(wire.itemOverrides![0]!)).toEqual(["itemId", "plan"]);

    const back = fromWire(wire);
    expect(back.targets[0]).toEqual({
      itemId: "iron_powder",
      ratePerSec: { num: "1", denom: "4" },
    });
    expect(back.itemOverrides![0]).toEqual({ itemId: "water", plan: true });
  });

  it("omits an empty title and restores it on decode", () => {
    const plan = basePlan();
    plan.title = "";
    const wire = toWire(plan);
    expect("title" in wire).toBe(false);
    expect(fromWire(wire).title).toBe("");
  });

  it("keeps a non-empty title on the wire", () => {
    const plan = basePlan();
    plan.title = "my plan";
    expect(fromWire(toWire(plan)).title).toBe("my plan");
  });
});
