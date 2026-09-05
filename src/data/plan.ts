import type { RecipePack } from "@aef/schema";
import type { RationalString, Target } from "./targets";
import { defaultTargets } from "./targets";
import { producibleItemIds } from "./recipe-category";
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

// Cap on the digit count of a wire rational's numerator and denominator. Rates
// the UI produces are a few digits wide; the ceiling is generous enough that no
// real plan can reach it and low enough that BigInt work on a decoded value
// stays instant. Exported so the rate parser refuses what the loader would
// reject, instead of committing a plan that cannot be reloaded.
export const MAX_RATIONAL_DIGITS = 400;

const CURRENT_VERSION = 1;

export type PlanLoadError =
  | { kind: "malformed-hash"; reason: string }
  | { kind: "payload-too-large"; length: number; limit: number }
  | { kind: "unrecognized-version"; got: number }
  | { kind: "schema-version-mismatch"; planSchema: string; packSchema: string }
  | { kind: "duplicate-target"; itemId: string }
  | { kind: "unknown-target-item"; itemId: string }
  | { kind: "target-not-producible"; itemId: string }
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
      return `Duplicate target item ${error.itemId}.`;
    case "unknown-target-item":
      return `Target references unknown item ${error.itemId}.`;
    case "target-not-producible":
      return `Item ${error.itemId} cannot be a target: no non-internal, non-input-supply recipe produces it.`;
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
  // The quotient check below bounds the value, not the digit count: past 309
  // digits Number() saturates to Infinity, and 1/Infinity is a finite 0 that
  // passes. Downstream the string is re-parsed as BigInt on every solve and
  // stringified for every label, so a crafted million-digit denominator stalls
  // the main thread for tens of seconds. No UI path emits long digit strings.
  if (
    r.num.length > MAX_RATIONAL_DIGITS ||
    r.denom.length > MAX_RATIONAL_DIGITS
  ) {
    return false;
  }
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
  const knownItemIds = new Set(pack.items.map((i) => i.id));
  const producible = producibleItemIds(pack.recipes);
  for (const t of plan.targets) {
    // A legacy recipe-form wire (or hostile payload) may omit itemId entirely;
    // fall back to a placeholder so error messages never render "undefined".
    const itemId = t.itemId ?? "(missing)";
    if (seenTargets.has(itemId)) {
      return { kind: "duplicate-target", itemId };
    }
    seenTargets.add(itemId);
    if (!isValidRational(t.ratePerSec)) {
      return {
        kind: "invalid-rational",
        field: `target ${itemId} ratePerSec`,
        value: t.ratePerSec,
      };
    }
    // An unknown target item would map to no demand and the plan would silently
    // under-deliver; reject it as a structured load error. Legacy recipe-keyed
    // wires land here too: their targets carry no itemId (no migration).
    if (!knownItemIds.has(itemId)) {
      return { kind: "unknown-target-item", itemId };
    }
    // Only producible items are selectable targets: an item no non-internal,
    // non-input-supply recipe yields at positive qty can never be net-exported.
    // Second line of defense in case one slips past the picker filter. Raw and
    // byproduct-only items ARE producible and pass here.
    if (!producible.has(itemId)) {
      return { kind: "target-not-producible", itemId };
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
    const recipeIds = new Set(pack.recipes.map((r) => r.id));
    for (const [recipeId, rc] of plan.recipeCosts) {
      if (!recipeIds.has(recipeId)) {
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
