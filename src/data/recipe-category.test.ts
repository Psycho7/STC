import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { pack } from "./load";
import { hasPositivePrimaryQty, isSinkRecipe } from "./recipe-category";

// A target rate is undefined for a recipe that produces nothing, so the sink
// predicate must key on the output list, not the cost sentinel. The shipped
// pack has two flavors of no-output recipe: the cost === -1 liquid_cleaner
// waste sinks and the cost-less pure consumers below.
const PURE_CONSUMERS = [
  "sewage-treat",
  "power_originium_ore",
  "power_proc_battery_1",
  "power_proc_battery_2",
  "power_proc_battery_3",
  "power_proc_battery_4",
  "power_proc_battery_5",
];

describe("isSinkRecipe", () => {
  it("is true for every pack recipe with no outputs", () => {
    const noOut = pack.recipes.filter((r) => r.out.length === 0);
    const ids = noOut.map((r) => r.id);
    for (const id of PURE_CONSUMERS) {
      expect(ids, `pack shape: ${id} should have no outputs`).toContain(id);
    }
    for (const r of noOut) {
      expect(isSinkRecipe(r), r.id).toBe(true);
    }
  });

  it("is false for every pack recipe with outputs", () => {
    for (const r of pack.recipes.filter((x) => x.out.length > 0)) {
      expect(isSinkRecipe(r), r.id).toBe(false);
    }
  });
});

describe("hasPositivePrimaryQty", () => {
  const withOut = (out: { item: string; qty: number }[]): Recipe =>
    ({ id: "r", out, in: [] }) as unknown as Recipe;

  it("is true when the primary output qty is positive", () => {
    expect(hasPositivePrimaryQty(withOut([{ item: "X", qty: 2 }]))).toBe(true);
  });

  it("is false for a zero or negative primary qty", () => {
    expect(hasPositivePrimaryQty(withOut([{ item: "X", qty: 0 }]))).toBe(false);
    expect(hasPositivePrimaryQty(withOut([{ item: "X", qty: -1 }]))).toBe(false);
  });

  it("is false when there are no outputs", () => {
    expect(hasPositivePrimaryQty(withOut([]))).toBe(false);
  });

  it("is true for every shipped pack recipe with outputs", () => {
    for (const r of pack.recipes.filter((x) => x.out.length > 0)) {
      expect(hasPositivePrimaryQty(r), r.id).toBe(true);
    }
  });
});
