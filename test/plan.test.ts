import { describe, it, expect } from "vitest";
import { pack } from "../src/data/load";
import {
  defaultPlan,
  encodePlan,
  loadPlan,
  validatePlan,
} from "../src/data/plan";
import type { Plan } from "../src/data/plan";

function freshPlan(): Plan {
  return defaultPlan(pack);
}

describe("defaultPlan", () => {
  it("populates pack provenance from the recipe pack", () => {
    const plan = defaultPlan(pack);
    expect(plan.version).toBe(1);
    expect(plan.pack.id).toBe(pack.source.name);
    expect(plan.pack.schemaVersion).toBe(pack.schemaVersion);
    expect(plan.pack.submoduleSha).toBe(pack.source.sourceCommit);
  });

  it("title defaults to the empty string", () => {
    expect(defaultPlan(pack).title).toBe("");
  });

  it("seeds the demo targets so the canvas isn't blank on first visit", () => {
    expect(defaultPlan(pack).targets.length).toBeGreaterThan(0);
  });
});

describe("validatePlan", () => {
  it("returns null for the default plan", () => {
    expect(validatePlan(freshPlan(), pack)).toBeNull();
  });

  it("schema-version-mismatch on a stale pack schemaVersion", () => {
    const plan: Plan = {
      ...freshPlan(),
      pack: { ...freshPlan().pack, schemaVersion: "9.9" },
    };
    expect(validatePlan(plan, pack)).toEqual({
      kind: "schema-version-mismatch",
      planSchema: "9.9",
      packSchema: pack.schemaVersion,
    });
  });

  it("duplicate-target on repeated recipeId", () => {
    const plan: Plan = {
      ...freshPlan(),
      targets: [
        { recipeId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
      ],
    };
    expect(validatePlan(plan, pack)).toEqual({
      kind: "duplicate-target",
      recipeId: "copper_bottle",
    });
  });

  it("target-not-a-producer on an input-supply recipe", () => {
    const plan: Plan = {
      ...freshPlan(),
      targets: [
        {
          recipeId: "transfer_tundra_bottled_food_1",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
    };
    expect(validatePlan(plan, pack)).toEqual({
      kind: "target-not-a-producer",
      recipeId: "transfer_tundra_bottled_food_1",
    });
  });

  it("unknown-item-override on an item not in the pack", () => {
    const plan: Plan = {
      ...freshPlan(),
      itemOverrides: [{ itemId: "unobtainium", plan: true }],
    };
    expect(validatePlan(plan, pack)).toEqual({
      kind: "unknown-item-override",
      itemId: "unobtainium",
    });
  });

  it("duplicate-item-override on a repeated itemId", () => {
    const realItem = pack.items[0]!.id;
    const plan: Plan = {
      ...freshPlan(),
      itemOverrides: [
        { itemId: realItem, plan: true },
        { itemId: realItem, plan: true },
      ],
    };
    expect(validatePlan(plan, pack)).toEqual({
      kind: "duplicate-item-override",
      itemId: realItem,
    });
  });

  it("invalid-item-override-plan-flag when plan is not literal true", () => {
    const realItem = pack.items[0]!.id;
    const plan: Plan = {
      ...freshPlan(),
      itemOverrides: [
        { itemId: realItem, plan: false as unknown as true },
      ],
    };
    const error = validatePlan(plan, pack);
    expect(error?.kind).toBe("invalid-item-override-plan-flag");
  });
});

describe("loadPlan / encodePlan", () => {
  it("round-trips a non-default plan with item overrides", async () => {
    const realItem = pack.items[0]!.id;
    const plan: Plan = {
      ...freshPlan(),
      title: "test plan",
      itemOverrides: [
        { itemId: realItem, ratePerSec: { num: "5", denom: "2" } },
      ],
    };
    const outcome = await loadPlan("#" + (await encodePlan(plan)), pack);
    expect(outcome.kind).toBe("loaded");
    if (outcome.kind === "loaded") {
      expect(outcome.plan.title).toBe("test plan");
      expect(outcome.plan.itemOverrides).toEqual(plan.itemOverrides);
    }
  });

  it("surfaces validation failures as error outcomes", async () => {
    const plan: Plan = {
      ...freshPlan(),
      targets: [
        {
          recipeId: "transfer_tundra_bottled_food_1",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
    };
    const outcome = await loadPlan("#" + (await encodePlan(plan)), pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("target-not-a-producer");
    }
  });

  it("encoded plan is deterministic across re-encodes of equal plans", async () => {
    const a = await encodePlan(freshPlan());
    const b = await encodePlan(freshPlan());
    expect(a).toBe(b);
  });

  it("targets and itemOverrides are sorted in the wire form", async () => {
    const realA = pack.items[0]!.id;
    const realB = pack.items[Math.min(5, pack.items.length - 1)]!.id;
    const sorted = [realA, realB].sort();
    const plan: Plan = {
      ...freshPlan(),
      itemOverrides: [
        { itemId: sorted[1]!, plan: true },
        { itemId: sorted[0]!, plan: true },
      ],
    };
    const outcome = await loadPlan("#" + (await encodePlan(plan)), pack);
    expect(outcome.kind).toBe("loaded");
    if (outcome.kind === "loaded") {
      expect(outcome.plan.itemOverrides?.map((o) => o.itemId)).toEqual(sorted);
    }
  });
});
