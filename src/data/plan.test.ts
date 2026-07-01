import { describe, expect, it } from "vitest";
import { pack } from "./load";
import {
  defaultPlan,
  describePlanLoadError,
  validatePlan,
  loadPlan,
  encodePlan,
  type Plan,
} from "./plan";
import { gzipBytes } from "./encoding/gzip";
import { bytesToBase64url } from "./encoding/base64url";
import { makePack } from "../solver/closed-form-fixtures";

// defaultPlan carries valid targets and a matching schemaVersion, the clean
// baseline each malformed-rational case mutates one field of.
function basePlan(): Plan {
  return defaultPlan(pack);
}

// Encode an arbitrary JSON value as a well-formed v1 hash so loadPlan's
// decode step succeeds and the payload's shape reaches the trust boundary.
async function hashFor(json: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const payload = bytesToBase64url(await gzipBytes(bytes));
  return `#v1.${payload}`;
}

function packTuple(): [string, string, string] {
  return [pack.source.name, pack.schemaVersion, pack.source.sourceCommit];
}

// B1L1-d trust boundary: a hash that decodes cleanly but carries the wrong
// JSON shape must come back as a typed LoadOutcome, never a raw TypeError.
describe("loadPlan - malformed but well-encoded wire payloads", () => {
  it.each([
    { name: "a primitive payload", wire: 5 },
    { name: "an empty object (missing pack tuple)", wire: {} },
    {
      name: "a non-array targets field",
      wire: { pack: null, title: "", targets: 7 },
    },
    {
      name: "a null targets element",
      wire: { pack: null, title: "", targets: [null] },
    },
    {
      name: "a null itemOverrides element",
      wire: { pack: null, title: "", targets: [], itemOverrides: [null] },
    },
  ])("returns malformed-hash for $name", async ({ wire }) => {
    const json =
      typeof wire === "object" && wire !== null && "pack" in wire
        ? { ...wire, pack: packTuple() }
        : wire;
    const outcome = await loadPlan(await hashFor(json), pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("malformed-hash");
      expect(typeof describePlanLoadError(outcome.error)).toBe("string");
    }
  });
});

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

  // A recipe with outputs but a zero-qty primary produces none of the item the
  // target names. The real pack carries no such recipe, so use a synthetic one.
  it("rejects a target whose recipe primary output has zero qty", () => {
    const malformed = makePack(
      [{ id: "rZero", time: 1, in: { R: 1 }, out: { X: 0 } }],
      [{ id: "R", raw: true }, { id: "X" }],
    );
    const plan = defaultPlan(malformed);
    plan.targets = [{ recipeId: "rZero", ratePerSec: { num: "1", denom: "1" } }];
    const error = validatePlan(plan, malformed);
    expect(error?.kind).toBe("target-primary-zero-qty");
    expect(error && describePlanLoadError(error)).toContain("X");
  });

  it("rejects a sink recipe as a target", () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: "liquid_cleaner_1-sewage", ratePerSec: { num: "1", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("target-not-a-producer");
  });

  // No-output pure consumers carry no cost sentinel, so the gate must key on
  // the empty output list; a target rate is undefined for such a recipe.
  it.each([
    "sewage-treat",
    "power_originium_ore",
    "power_proc_battery_1",
    "power_proc_battery_2",
    "power_proc_battery_3",
    "power_proc_battery_4",
    "power_proc_battery_5",
  ])("rejects no-output recipe %s as a target", (recipeId) => {
    const plan = basePlan();
    plan.targets = [{ recipeId, ratePerSec: { num: "1", denom: "1" } }];
    expect(validatePlan(plan, pack)?.kind).toBe("target-not-a-producer");
  });

  it("rejects a wire payload targeting a no-output recipe end-to-end", async () => {
    const plan = basePlan();
    plan.targets = [
      { recipeId: "sewage-treat", ratePerSec: { num: "1", denom: "1" } },
    ];
    const hash = await encodePlan(plan);
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("target-not-a-producer");
    }
  });

  it("rejects a wire payload with a null target rational and describes it", async () => {
    const hash = await hashFor({
      pack: packTuple(),
      title: "",
      targets: [{ recipeId: "copper_powder", ratePerSec: null }],
    });
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("invalid-rational");
      expect(typeof describePlanLoadError(outcome.error)).toBe("string");
    }
  });

  it("rejects a wire payload with a null recipeCost rational and describes it", async () => {
    const hash = await hashFor({
      pack: packTuple(),
      title: "",
      targets: [],
      recipeCosts: { copper_powder: null },
    });
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("invalid-rational");
      expect(typeof describePlanLoadError(outcome.error)).toBe("string");
    }
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
