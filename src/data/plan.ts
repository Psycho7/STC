import type { RecipePack } from "@aef/schema";
import type { RationalString, Target } from "./targets";
import { defaultTargets } from "./targets";
import {
  hasPositivePrimaryQty,
  isExcludedProducer,
  isSinkRecipe,
} from "./recipe-category";
import type { PlanWireV1 } from "./plan-wire-v1";
import {
  decodeWire,
  encodeWire,
  fromWire,
  isWireShaped,
  toWire,
} from "./plan-wire-v1";

// A per-item override for the production walk, keyed by item id.
//   plan: true    -> keep walking through this item.
//   ratePerSec: X -> cap the input boundary at X during rendering.
// Both fields are optional. There is no `plan: false`; `plan: true` being
// present is the signal. If both are set, the rate wins.
export type ItemOverride = {
  itemId: string;
  plan?: true;
  ratePerSec?: RationalString;
};

export type Plan = {
  version: 1;
  pack: { id: string; schemaVersion: string; submoduleSha: string };
  title: string;
  targets: Target[];
  itemOverrides?: ItemOverride[];
  // Per-recipe cost overrides for the LP solver, keyed by recipe id. Absent =>
  // all default costs. Every entry rides the wire, including "1/1": big-M
  // recipes default to 1e6, so a 1/1 override there is meaningful. Power-user
  // surface, no cost-tuning UI.
  recipeCosts?: Map<string, RationalString>;
};

// Cap on the URL-fragment payload length, checked before decompressing so a
// hostile hash cannot blow up memory.
export const MAX_HASH_PAYLOAD_LEN = 16384;

const CURRENT_VERSION = 1;

export type PlanLoadError =
  | { kind: "malformed-hash"; reason: string }
  | { kind: "payload-too-large"; length: number; limit: number }
  | { kind: "unrecognized-version"; got: number }
  | { kind: "schema-version-mismatch"; planSchema: string; packSchema: string }
  | { kind: "duplicate-target"; recipeId: string }
  | { kind: "unknown-target-recipe"; recipeId: string }
  | { kind: "target-not-a-producer"; recipeId: string }
  | { kind: "target-primary-zero-qty"; recipeId: string; itemId: string }
  | { kind: "unknown-recipe-cost"; recipeId: string }
  | { kind: "unknown-item-override"; itemId: string }
  | { kind: "duplicate-item-override"; itemId: string }
  | { kind: "invalid-item-override-plan-flag"; itemId: string; value: unknown }
  // value is unknown, not RationalString: it comes straight off the wire and
  // may be null or any other JSON shape when the payload is hostile.
  | { kind: "invalid-rational"; field: string; value: unknown };

export type LoadOutcome =
  | { kind: "loaded"; plan: Plan }
  | { kind: "seeded"; plan: Plan }
  | { kind: "error"; error: PlanLoadError };

export function defaultPlan(pack: RecipePack): Plan {
  return {
    version: 1,
    pack: {
      id: pack.source.name,
      schemaVersion: pack.schemaVersion,
      submoduleSha: pack.source.sourceCommit,
    },
    title: "",
    targets: defaultTargets(),
  };
}

export function describePlanLoadError(error: PlanLoadError): string {
  switch (error.kind) {
    case "malformed-hash":
      return `Could not parse URL hash: ${error.reason}`;
    case "payload-too-large":
      return `Hash payload exceeds ${error.limit} chars (got ${error.length}).`;
    case "unrecognized-version":
      return `Hash envelope version v${error.got} is not supported.`;
    case "schema-version-mismatch":
      return `Plan schemaVersion ${error.planSchema} does not match pack ${error.packSchema}.`;
    case "duplicate-target":
      return `Duplicate target recipe ${error.recipeId}.`;
    case "unknown-target-recipe":
      return `Target references unknown recipe ${error.recipeId}.`;
    case "target-not-a-producer":
      return `Recipe ${error.recipeId} cannot be a target: supply metadata or no outputs.`;
    case "target-primary-zero-qty":
      return `Recipe ${error.recipeId} cannot be a target: its primary output ${error.itemId} has zero quantity, so it produces none of the requested item.`;
    case "unknown-recipe-cost":
      return `Recipe cost references unknown recipe ${error.recipeId}.`;
    case "unknown-item-override":
      return `Item override references unknown item ${error.itemId}.`;
    case "duplicate-item-override":
      return `Item override duplicated for ${error.itemId}.`;
    case "invalid-item-override-plan-flag":
      return `Item override ${error.itemId}: plan must be literal true.`;
    case "invalid-rational": {
      // The wire value may be null or mis-shaped; only render num/denom when
      // both are actually strings, otherwise show the raw JSON.
      const v = error.value as { num?: unknown; denom?: unknown } | null;
      const text =
        typeof v?.num === "string" && typeof v?.denom === "string"
          ? `${v.num}/${v.denom}`
          : JSON.stringify(error.value);
      return `Invalid rational in ${error.field}: ${text}.`;
    }
  }
}

// A wire RationalString is well-formed when num and denom are integer strings
// and num/denom is finite (which also rejects a zero denominator). Validating
// at the trust boundary keeps a hostile or corrupt hash from reaching the
// solver, where a zero denominator throws (effectiveSupply) and a non-numeric
// string injects NaN/Infinity into the objective and demand.
function isValidRational(r: RationalString): boolean {
  if (typeof r?.num !== "string" || typeof r?.denom !== "string") return false;
  // Non-negative integer strings only. A negative numerator or denominator
  // passes the finite check yet injects negative demand or a negative supply
  // cap. The denominator must be non-zero, caught here as a non-finite quotient.
  if (!/^\d+$/.test(r.num) || !/^\d+$/.test(r.denom)) return false;
  return Number.isFinite(Number(r.num) / Number(r.denom));
}

export async function loadPlan(
  hash: string,
  pack: RecipePack,
): Promise<LoadOutcome> {
  if (!hash || hash === "#") {
    return { kind: "seeded", plan: defaultPlan(pack) };
  }
  const match = hash.match(/^#?v(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match) {
    return {
      kind: "error",
      error: { kind: "malformed-hash", reason: "envelope did not parse" },
    };
  }
  const version = Number(match[1]);
  if (version !== CURRENT_VERSION) {
    return {
      kind: "error",
      error: { kind: "unrecognized-version", got: version },
    };
  }
  const payload = match[2] ?? "";
  if (payload.length > MAX_HASH_PAYLOAD_LEN) {
    return {
      kind: "error",
      error: {
        kind: "payload-too-large",
        length: payload.length,
        limit: MAX_HASH_PAYLOAD_LEN,
      },
    };
  }
  let wire: PlanWireV1;
  try {
    wire = await decodeWire(payload);
  } catch (e) {
    return {
      kind: "error",
      error: {
        kind: "malformed-hash",
        reason: `wire decode failed: ${(e as Error).message}`,
      },
    };
  }
  // Trust boundary: decodeWire returns arbitrary JSON. Reject wrong container
  // shapes here so fromWire's destructuring and validatePlan's iteration only
  // ever see the typed wire shape; otherwise both leak raw TypeErrors.
  if (!isWireShaped(wire)) {
    return {
      kind: "error",
      error: {
        kind: "malformed-hash",
        reason: "decoded payload is not a v1 plan wire shape",
      },
    };
  }
  const plan = fromWire(wire);
  const error = validatePlan(plan, pack);
  if (error) return { kind: "error", error };
  return { kind: "loaded", plan };
}

export async function encodePlan(plan: Plan): Promise<string> {
  const payload = await encodeWire(toWire(plan));
  return `v${CURRENT_VERSION}.${payload}`;
}

export function validatePlan(
  plan: Plan,
  pack: RecipePack,
): PlanLoadError | null {
  if (plan.pack.schemaVersion !== pack.schemaVersion) {
    return {
      kind: "schema-version-mismatch",
      planSchema: plan.pack.schemaVersion,
      packSchema: pack.schemaVersion,
    };
  }
  const seenTargets = new Set<string>();
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  for (const t of plan.targets) {
    if (seenTargets.has(t.recipeId)) {
      return { kind: "duplicate-target", recipeId: t.recipeId };
    }
    seenTargets.add(t.recipeId);
    if (!isValidRational(t.ratePerSec)) {
      return {
        kind: "invalid-rational",
        field: `target ${t.recipeId} ratePerSec`,
        value: t.ratePerSec,
      };
    }
    const recipe = recipeById.get(t.recipeId);
    // An unknown target recipe would otherwise map to no item demand and the
    // plan would silently under-deliver; reject it as a structured load error.
    if (!recipe) {
      return { kind: "unknown-target-recipe", recipeId: t.recipeId };
    }
    // Input-supply (__domain_transfer) recipes are supply metadata and
    // no-output recipes (waste sinks, pure consumers) have no defined target
    // rate; neither is a selectable target. Second line of defense in case
    // one slips past the picker filter.
    if (isExcludedProducer(recipe) || isSinkRecipe(recipe)) {
      return { kind: "target-not-a-producer", recipeId: t.recipeId };
    }
    // A recipe with outputs but a zero/negative primary qty produces none of
    // the item the target rate names. Left to the solver the item demand can
    // never be met by this recipe and only surfaces downstream as a deficit;
    // reject it here so the unsatisfiable target surfaces immediately.
    if (!hasPositivePrimaryQty(recipe)) {
      return {
        kind: "target-primary-zero-qty",
        recipeId: t.recipeId,
        itemId: recipe.out[0]!.item,
      };
    }
  }
  if (plan.itemOverrides) {
    const itemIds = new Set(pack.items.map((i) => i.id));
    const seenOverrides = new Set<string>();
    for (const ov of plan.itemOverrides) {
      if (
        Object.prototype.hasOwnProperty.call(ov, "plan") &&
        ov.plan !== true
      ) {
        return {
          kind: "invalid-item-override-plan-flag",
          itemId: ov.itemId,
          value: ov.plan,
        };
      }
      if (!itemIds.has(ov.itemId)) {
        return { kind: "unknown-item-override", itemId: ov.itemId };
      }
      if (seenOverrides.has(ov.itemId)) {
        return { kind: "duplicate-item-override", itemId: ov.itemId };
      }
      seenOverrides.add(ov.itemId);
      if (ov.ratePerSec !== undefined && !isValidRational(ov.ratePerSec)) {
        return {
          kind: "invalid-rational",
          field: `item override ${ov.itemId} ratePerSec`,
          value: ov.ratePerSec,
        };
      }
    }
  }
  if (plan.recipeCosts) {
    for (const [recipeId, rc] of plan.recipeCosts) {
      if (!recipeById.has(recipeId)) {
        return { kind: "unknown-recipe-cost", recipeId };
      }
      if (!isValidRational(rc)) {
        return {
          kind: "invalid-rational",
          field: `recipe cost ${recipeId}`,
          value: rc,
        };
      }
    }
  }
  return null;
}
