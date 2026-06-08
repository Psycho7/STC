import { describe, expect, it } from "vitest";
import { planToSolverArgs } from "./planToSolverArgs";
import type { Plan } from "../data/plan";

// Minimal Plan fixture: only the fields planToSolverArgs reads are set.
function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    version: 1,
    pack: { id: "test", schemaVersion: "0", submoduleSha: "abc" },
    title: "",
    targets: [
      { recipeId: "copper_powder", ratePerSec: { num: "2", denom: "4" } },
    ],
    ...overrides,
  };
}

describe("planToSolverArgs", () => {
  it("passes targets through by reference without transformation", () => {
    const plan = makePlan();
    const { targets } = planToSolverArgs(plan);
    // Same Target[] reference back, no transformation.
    expect(targets).toBe(plan.targets);
  });

  it("returns empty itemOverrides array when plan has none", () => {
    // The optional itemOverrides field is absent.
    const plan = makePlan();
    const { itemOverrides } = planToSolverArgs(plan);
    expect(Array.isArray(itemOverrides)).toBe(true);
    expect(itemOverrides.length).toBe(0);
  });

  it("passes through itemOverrides as-is when present", () => {
    const overrides = [{ itemId: "copper", plan: true as const }];
    const plan = makePlan({ itemOverrides: overrides });
    const { itemOverrides } = planToSolverArgs(plan);
    expect(itemOverrides).toBe(overrides);
  });

  it("returns undefined recipeCosts when plan has none", () => {
    // The optional recipeCosts field is absent.
    const plan = makePlan();
    const { recipeCosts } = planToSolverArgs(plan);
    expect(recipeCosts).toBeUndefined();
  });

  it("converts recipeCosts RationalString to number via Number(num)/Number(denom)", () => {
    const plan = makePlan({
      recipeCosts: new Map([
        ["copper_powder", { num: "3", denom: "4" }],
      ]),
    });
    const { recipeCosts } = planToSolverArgs(plan);
    expect(recipeCosts).toBeDefined();
    expect(recipeCosts!.get("copper_powder")).toBe(
      Number("3") / Number("4"),
    );
  });

  it("preserves multiple recipeCost entries", () => {
    const plan = makePlan({
      recipeCosts: new Map([
        ["r1", { num: "1", denom: "2" }],
        ["r2", { num: "5", denom: "1" }],
      ]),
    });
    const { recipeCosts } = planToSolverArgs(plan);
    expect(recipeCosts!.size).toBe(2);
    expect(recipeCosts!.get("r1")).toBe(0.5);
    expect(recipeCosts!.get("r2")).toBe(5);
  });

  // Known lossiness: rational strings not exactly representable in IEEE 754 lose
  // precision. The helper reproduces the same Number(num)/Number(denom) float as
  // the inline code, with no rounding or correction. 15/22 is a clean example
  // whose round-trip (result * 22) does not equal 15.
  it("reproduces the same IEEE 754 lossiness as inline Number(num)/Number(denom)", () => {
    const plan = makePlan({
      recipeCosts: new Map([["lossy", { num: "15", denom: "22" }]]),
    });
    const { recipeCosts } = planToSolverArgs(plan);
    const expected = Number("15") / Number("22"); // 0.6818181818181818
    expect(recipeCosts!.get("lossy")).toBe(expected);
    // Lossiness is observable: multiplying back does not recover 15.
    expect(expected * 22).not.toBe(15);
  });

  it("returns an ItemOverride array with supplyCap entries intact", () => {
    const overrides = [
      { itemId: "iron", ratePerSec: { num: "10", denom: "1" } },
    ];
    const plan = makePlan({ itemOverrides: overrides });
    const { itemOverrides } = planToSolverArgs(plan);
    expect(itemOverrides[0]!.ratePerSec).toEqual({
      num: "10",
      denom: "1",
    });
  });
});
