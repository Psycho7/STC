import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { pack } from "./load";
import { isSinkRecipe, producibleItemIds } from "./recipe-category";

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

describe("producibleItemIds", () => {
  const rec = (
    id: string,
    category: string,
    out: { item: string; qty: number }[],
  ): Recipe => ({ id, category, out, in: [] }) as unknown as Recipe;

  it("includes a raw item produced by a miner", () => {
    const ids = producibleItemIds([
      rec("mine_ore", "extraction", [{ item: "ore", qty: 1 }]),
    ]);
    expect(ids.has("ore")).toBe(true);
  });

  it("includes a byproduct-only item (positive qty in a non-primary slot)", () => {
    const ids = producibleItemIds([
      rec("smelt", "cat", [
        { item: "ingot", qty: 1 },
        { item: "slag", qty: 2 },
      ]),
    ]);
    expect(ids.has("slag")).toBe(true);
    expect(ids.has("ingot")).toBe(true);
  });

  it("excludes items only produced by __internal or __domain_transfer recipes", () => {
    const ids = producibleItemIds([
      rec("__raw_src", "__internal", [{ item: "synthetic", qty: 1 }]),
      rec("import_x", "__domain_transfer", [{ item: "imported", qty: 1 }]),
    ]);
    expect(ids.has("synthetic")).toBe(false);
    expect(ids.has("imported")).toBe(false);
  });

  it("excludes an item only ever output at zero qty", () => {
    const ids = producibleItemIds([
      rec("dud", "cat", [{ item: "nothing", qty: 0 }]),
    ]);
    expect(ids.has("nothing")).toBe(false);
  });

  it("marks the shipped default targets producible", () => {
    const ids = producibleItemIds(pack.recipes);
    for (const id of ["copper_bottle", "copper_powder", "iron_powder"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});
