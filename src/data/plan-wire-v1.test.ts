import { describe, expect, it } from "vitest";
import { toWire, fromWire } from "./plan-wire-v1";
import type { Plan } from "./plan";

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

  it("omits default-cost (1/1) entries from the wire", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([
      ["kept", { num: "0", denom: "1" }],
      ["dropped", { num: "1", denom: "1" }],
    ]);
    const wire = toWire(plan);
    expect(wire.recipeCosts).toBeDefined();
    expect(Object.keys(wire.recipeCosts!)).toEqual(["kept"]);
  });

  it("leaves recipeCosts undefined when absent", () => {
    const back = fromWire(toWire(basePlan()));
    expect(back.recipeCosts).toBeUndefined();
  });
});
