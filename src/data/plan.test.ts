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
import { parsePerMinToRatePerSec } from "./rate-format";

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

// The rate input and the loader share one digit cap. Without the parser half,
// a pasted long decimal commits, writes the hash, and only fails on the next
// load, taking the plan with it.
describe("rate input honours the loader's digit cap", () => {
  it("parses a rate whose denominator lands inside the cap", () => {
    expect(parsePerMinToRatePerSec("0." + "1".repeat(200))).toBeDefined();
  });

  it("refuses a rate whose denominator would exceed the cap", () => {
    expect(parsePerMinToRatePerSec("0." + "1".repeat(500))).toBeUndefined();
  });
});

describe("validatePlan - rational wire fields", () => {
  it("accepts the default plan", () => {
    expect(validatePlan(basePlan(), pack)).toBeNull();
  });

  it("accepts a well-formed recipeCost override", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([["copper_bottle", { num: "5", denom: "2" }]]);
    expect(validatePlan(plan, pack)).toBeNull();
  });

  // Each row mutates one field of a clean basePlan() to carry one malformed
  // rational; all must fail validation with kind "invalid-rational".
  it.each([
    {
      name: "a target rate with a zero denominator",
      mutate: (plan: Plan) => {
        plan.targets = [
          { itemId: plan.targets[0]!.itemId, ratePerSec: { num: "1", denom: "0" } },
        ];
      },
    },
    {
      name: "a target rate with a non-numeric numerator",
      mutate: (plan: Plan) => {
        plan.targets = [
          { itemId: plan.targets[0]!.itemId, ratePerSec: { num: "abc", denom: "1" } },
        ];
      },
    },
    {
      name: "a negative target rate",
      mutate: (plan: Plan) => {
        plan.targets = [
          { itemId: plan.targets[0]!.itemId, ratePerSec: { num: "-5", denom: "2" } },
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
        plan.recipeCosts = new Map([["copper_bottle", { num: "1", denom: "0" }]]);
      },
    },
    // The quotient check alone accepts this: Number() of a 1e5-digit string is
    // Infinity and 1/Infinity is a finite 0. The digit cap is what rejects it,
    // before the solver and the label formatter parse it as BigInt.
    {
      name: "a target rate with a 100k-digit denominator",
      mutate: (plan: Plan) => {
        plan.targets = [
          {
            itemId: plan.targets[0]!.itemId,
            ratePerSec: { num: "1", denom: "9".repeat(100_000) },
          },
        ];
      },
    },
  ])("rejects $name", ({ mutate }) => {
    const plan = basePlan();
    mutate(plan);
    expect(validatePlan(plan, pack)?.kind).toBe("invalid-rational");
  });

  it("rejects a duplicate target item", () => {
    const plan = basePlan();
    plan.targets = [
      { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("duplicate-target");
  });

  it("rejects a target referencing an unknown item", () => {
    const plan = basePlan();
    plan.targets = [
      { itemId: "no_such_item", ratePerSec: { num: "1", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("unknown-target-item");
  });

  it("rejects a recipeCost referencing an unknown recipe", () => {
    const plan = basePlan();
    plan.recipeCosts = new Map([["no_such_recipe", { num: "5", denom: "2" }]]);
    expect(validatePlan(plan, pack)?.kind).toBe("unknown-recipe-cost");
  });

  // An item only ever output at zero qty has no real producer, so it is not
  // producible. The real pack carries no such item, so use a synthetic pack.
  it("rejects a target on an item only produced at zero qty", () => {
    const malformed = makePack(
      [{ id: "rZero", time: 1, in: { R: 1 }, out: { X: 0 } }],
      [{ id: "R", raw: true }, { id: "X" }],
    );
    const plan = defaultPlan(malformed);
    plan.targets = [{ itemId: "X", ratePerSec: { num: "1", denom: "1" } }];
    const error = validatePlan(plan, malformed);
    expect(error?.kind).toBe("target-not-producible");
    expect(error && describePlanLoadError(error)).toContain("X");
  });

  // The real pack's one non-producible item comes only from a
  // __domain_transfer (input-supply) recipe, so it can never be net-exported.
  it("rejects an item produced only by an input-supply recipe", () => {
    const plan = basePlan();
    plan.targets = [
      { itemId: "domain_key_tundra", ratePerSec: { num: "1", denom: "1" } },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("target-not-producible");
  });

  it("rejects a wire payload targeting a non-producible item end-to-end", async () => {
    const plan = basePlan();
    plan.targets = [
      { itemId: "domain_key_tundra", ratePerSec: { num: "1", denom: "1" } },
    ];
    const hash = await encodePlan(plan);
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("target-not-producible");
    }
  });

  // No migration for legacy wires: a v1 payload whose targets still carry the
  // old recipe shape ({recipeId, ratePerSec}) has no itemId, so it must fail
  // validation as a structured error - and the message must not render the
  // missing id as literal "undefined".
  it("rejects a legacy recipe-form wire payload as unknown-target-item", async () => {
    const hash = await hashFor({
      pack: packTuple(),
      title: "",
      targets: [
        { recipeId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
      ],
    });
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("unknown-target-item");
      const msg = describePlanLoadError(outcome.error);
      expect(msg).toContain("(missing)");
      expect(msg).not.toContain("undefined");
    }
  });

  it("rejects a wire payload with a null target rational and describes it", async () => {
    const hash = await hashFor({
      pack: packTuple(),
      title: "",
      targets: [{ itemId: "copper_powder", ratePerSec: null }],
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
      { itemId: plan.targets[0]!.itemId, ratePerSec: { num: "5", denom: "0" } },
    ];
    const hash = await encodePlan(plan);
    const outcome = await loadPlan(hash, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("invalid-rational");
    }
  });
});
