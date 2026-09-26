import { describe, expect, it } from "vitest";
import { pack } from "./load";
import { unavailableCauses } from "./availability";
import {
  blockedTargets,
  decodeItemOverrideKey,
  defaultPlan,
  describePlanLoadError,
  encodeItemOverrideKey,
  validatePlan,
  loadPlan,
  encodePlan,
  type ItemOverride,
  type Plan,
  type ProducerUnavailableCause,
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

// Chat auto-linking often swallows the punctuation after a share link. Those
// characters never occur in base64url, so the loader tolerates them as a tail.
describe("loadPlan - trailing punctuation from auto-linked share links", () => {
  it.each([".", ")", "]", ",", ";", ")."])(
    "decodes a valid hash followed by %j",
    async (tail) => {
      const hash = "#" + (await encodePlan(basePlan())) + tail;
      const outcome = await loadPlan(hash, pack);
      expect(outcome.kind).toBe("loaded");
    },
  );

  it("still rejects a payload that is invalid after the tail is stripped", async () => {
    // A truncated payload passes the envelope once the "." goes, then fails
    // to decode.
    const full = await encodePlan(basePlan());
    const truncated = "#" + full.slice(0, full.length - 7) + ".";
    const outcome = await loadPlan(truncated, pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("malformed-hash");
    }
  });

  it("still checks the version of a hash with a tolerated tail", async () => {
    const outcome = await loadPlan("#v9.abc)", pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("unrecognized-version");
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
          {
            itemId: plan.targets[0]!.itemId,
            ratePerSec: { num: "1", denom: "0" },
          },
        ];
      },
    },
    {
      name: "a target rate with a non-numeric numerator",
      mutate: (plan: Plan) => {
        plan.targets = [
          {
            itemId: plan.targets[0]!.itemId,
            ratePerSec: { num: "abc", denom: "1" },
          },
        ];
      },
    },
    {
      name: "a negative target rate",
      mutate: (plan: Plan) => {
        plan.targets = [
          {
            itemId: plan.targets[0]!.itemId,
            ratePerSec: { num: "-5", denom: "2" },
          },
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
          ["copper_bottle", { num: "1", denom: "0" }],
        ]);
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

  it("rejects a duplicate item override on the same item and role", () => {
    const plan = basePlan();
    plan.itemOverrides = [
      { itemId: "gas_xiranite", role: "catalyst" },
      {
        itemId: "gas_xiranite",
        role: "catalyst",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    expect(validatePlan(plan, pack)?.kind).toBe("duplicate-item-override");
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

// The availability seam: with a map of unavailable recipe ids, an item whose
// producers all sit in the map is a blocked target, carrying the cause that
// switched them off. The plan itself still validates.
describe("blockedTargets", () => {
  // Causes keyed like the availability core hands them over, one kind per
  // helper so the precedence can be pinned per kind.
  function causesFor(
    recipeIds: readonly string[],
    cause:
      | ProducerUnavailableCause
      | ((id: string) => ProducerUnavailableCause),
  ): ReadonlyMap<string, ProducerUnavailableCause> {
    return new Map(
      recipeIds.map((id) => [
        id,
        typeof cause === "function" ? cause(id) : cause,
      ]),
    );
  }

  const v15Ids = pack.recipes
    .filter((r) => r.event === "v1.5")
    .map((r) => r.id);
  const v15 = causesFor(v15Ids, { kind: "event", cohort: "v1.5" });

  function targeting(itemId: string): Plan {
    const plan = basePlan();
    plan.targets = [{ itemId, ratePerSec: { num: "1", denom: "1" } }];
    return plan;
  }

  it("names the event cohort when every producer is switched off", () => {
    // activity_xiranite_lung's only producer is the v1.5 event recipe of the
    // same id.
    expect(
      blockedTargets(targeting("activity_xiranite_lung"), pack, v15),
    ).toEqual([
      {
        itemId: "activity_xiranite_lung",
        cause: { kind: "event", cohort: "v1.5" },
      },
    ]);
  });

  it("blocks nothing with an empty set (the default)", () => {
    expect(validatePlan(targeting("activity_xiranite_lung"), pack)).toBeNull();
    expect(
      blockedTargets(targeting("activity_xiranite_lung"), pack, new Map()),
    ).toEqual([]);
  });

  it("leaves an item with no producers at all to target-not-producible", () => {
    // domain_key_tundra comes only from an input-supply recipe: no producers
    // under the shared predicate, so the availability set must not claim it -
    // the two outcomes partition.
    expect(validatePlan(targeting("domain_key_tundra"), pack)?.kind).toBe(
      "target-not-producible",
    );
    expect(blockedTargets(targeting("domain_key_tundra"), pack, v15)).toEqual(
      [],
    );
  });

  it("accepts an item with a partially available producer set", () => {
    // jinlong_coupon has 12 always-on producers besides the two v1.5 event
    // exchanges; switching the cohort off must not make it untargetable.
    expect(blockedTargets(targeting("jinlong_coupon"), pack, v15)).toEqual([]);
  });

  it("carries an area cause when the area is what hides the producers", () => {
    const causes = causesFor(v15Ids, { kind: "area", area: "tundra" });
    expect(
      blockedTargets(targeting("activity_xiranite_lung"), pack, causes),
    ).toEqual([
      {
        itemId: "activity_xiranite_lung",
        cause: { kind: "area", area: "tundra" },
      },
    ]);
  });

  it("blocks a target the selected area has no producer for, end to end", () => {
    // Not a hand-built cause map: the real area rule over the shipped pack.
    // liquid_copper's two producers both sit in jinlong, so the tundra leaves
    // the item without a producer.
    expect(
      blockedTargets(
        targeting("liquid_copper"),
        pack,
        unavailableCauses(pack, { eventOverrides: {}, area: "tundra" }),
      ),
    ).toEqual([
      { itemId: "liquid_copper", cause: { kind: "area", area: "tundra" } },
    ]);
    // The same target under jinlong, and under no area at all, is fine.
    expect(
      blockedTargets(
        targeting("liquid_copper"),
        pack,
        unavailableCauses(pack, { eventOverrides: {}, area: "jinlong" }),
      ),
    ).toEqual([]);
    expect(
      blockedTargets(
        targeting("liquid_copper"),
        pack,
        unavailableCauses(pack, { eventOverrides: {} }),
      ),
    ).toEqual([]);
  });

  it("carries a manual cause naming the recipe the user switched off", () => {
    const causes = causesFor(v15Ids, (recipeId) => ({
      kind: "manual",
      recipeId,
    }));
    // The recipe id is the whole point of the manual kind: it names the toggle.
    expect(
      blockedTargets(targeting("activity_xiranite_lung"), pack, causes),
    ).toEqual([
      {
        itemId: "activity_xiranite_lung",
        cause: { kind: "manual", recipeId: "activity_xiranite_lung" },
      },
    ]);
  });

  it("reports the outermost cause when producers are off for different reasons", () => {
    // jinlong_coupon's 14 producers: the two event exchanges land on a manual
    // cause, everything else on an area cause, so the area cause wins.
    const producers = pack.recipes.filter((r) =>
      r.out.some((o) => o.item === "jinlong_coupon" && o.qty > 0),
    );
    const causes = new Map<string, ProducerUnavailableCause>(
      producers.map((r) => [
        r.id,
        r.event === "v1.5"
          ? { kind: "manual", recipeId: r.id }
          : { kind: "area", area: "tundra" },
      ]),
    );
    expect(blockedTargets(targeting("jinlong_coupon"), pack, causes)).toEqual([
      { itemId: "jinlong_coupon", cause: { kind: "area", area: "tundra" } },
    ]);
  });
});

// A catalyst-role override addresses the catalyst supply pool, which only
// exists for an item some recipe cycles as a catalyst.
describe("validatePlan - item override roles", () => {
  it("accepts a catalyst role on a pack catalyst item", () => {
    const plan = basePlan();
    plan.itemOverrides = [{ itemId: "liquid_xiranite", role: "catalyst" }];
    expect(validatePlan(plan, pack)).toBeNull();
  });

  it("accepts one item carrying a role-less row and a catalyst row", () => {
    const plan = basePlan();
    plan.itemOverrides = [
      { itemId: "gas_xiranite", ratePerSec: { num: "1", denom: "2" } },
      {
        itemId: "gas_xiranite",
        role: "catalyst",
        ratePerSec: { num: "1", denom: "10" },
      },
    ];
    expect(validatePlan(plan, pack)).toBeNull();
  });

  it("rejects a catalyst role on an item no recipe cycles", () => {
    const plan = basePlan();
    plan.itemOverrides = [{ itemId: "copper_powder", role: "catalyst" }];
    const error = validatePlan(plan, pack);
    expect(error?.kind).toBe("invalid-item-override-role");
    expect(error && describePlanLoadError(error)).toContain("copper_powder");
  });

  // "catalyst" is the only role there is. An unrecognised one addresses
  // nothing: pool G skips the row because it carries a role and pool C skips
  // it because the role is not the one it answers for.
  it("rejects a role value other than catalyst", () => {
    const plan = basePlan();
    plan.itemOverrides = [
      { itemId: "gas_xiranite", role: "bogus" } as unknown as ItemOverride,
    ];
    const error = validatePlan(plan, pack);
    expect(error?.kind).toBe("invalid-item-override-role");
    expect(error && describePlanLoadError(error)).toContain("gas_xiranite");
  });

  it("rejects a catalyst role combined with plan: true", () => {
    const plan = basePlan();
    plan.itemOverrides = [
      { itemId: "gas_xiranite", role: "catalyst", plan: true },
    ];
    const error = validatePlan(plan, pack);
    expect(error?.kind).toBe("invalid-item-override-role");
    expect(error && describePlanLoadError(error)).toContain("gas_xiranite");
  });

  it("rejects a role a pack catalyst item cannot carry, end-to-end", async () => {
    const plan = basePlan();
    plan.itemOverrides = [{ itemId: "copper_powder", role: "catalyst" }];
    const outcome = await loadPlan(await encodePlan(plan), pack);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error.kind).toBe("invalid-item-override-role");
    }
  });
});

// The string form of an override's identity, shared by the loader's duplicate
// check, the inputs panel's row keys and App's supply map.
describe("item override key codec", () => {
  it.each([
    { name: "a role-less key", key: { itemId: "gas_xiranite" } },
    {
      name: "an explicitly undefined role",
      key: { itemId: "gas_xiranite", role: undefined },
    },
    {
      name: "a catalyst key",
      key: { itemId: "gas_xiranite", role: "catalyst" as const },
    },
  ])("round-trips $name", ({ key }) => {
    const decoded = decodeItemOverrideKey(encodeItemOverrideKey(key));
    expect(decoded.itemId).toBe(key.itemId);
    expect(decoded.role).toBe(key.role);
  });

  it("separates the two pools of one item", () => {
    expect(encodeItemOverrideKey({ itemId: "gas_xiranite" })).not.toBe(
      encodeItemOverrideKey({ itemId: "gas_xiranite", role: "catalyst" }),
    );
  });

  // Every pack item id is free of the suffix character, which is what makes
  // the two namespaces disjoint.
  it("keys every pack item apart from every catalyst key", () => {
    const keys = new Set<string>();
    for (const item of pack.items) {
      keys.add(encodeItemOverrideKey({ itemId: item.id }));
      keys.add(encodeItemOverrideKey({ itemId: item.id, role: "catalyst" }));
    }
    expect(keys.size).toBe(pack.items.length * 2);
  });
});
