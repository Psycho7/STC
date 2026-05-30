import type { RecipePack } from "@aef/schema";
import type { RationalString, Target } from "./targets";
import { defaultTargets } from "./targets";
import { isInputSupplyRecipe } from "./recipe-category";
import type { PlanWireV1 } from "./plan-wire-v1";
import {
  decodeWire,
  encodeWire,
  fromWire,
  toWire,
} from "./plan-wire-v1";

// A per-item override for the production walk, keyed by item id.
//   plan: true    -> keep walking through this item.
//   ratePerSec: X -> cap the input boundary at X during rendering.
// Both fields are optional. There's no `plan: false`; the presence of
// `plan: true` is itself the signal. If both `plan: true` and `ratePerSec` are
// set, the rate wins.
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
};

// Cap on the URL-fragment payload length. We check it before decompressing so a
// hostile hash can't blow up memory.
export const MAX_HASH_PAYLOAD_LEN = 16384;

const CURRENT_VERSION = 1;

export type PlanLoadError =
  | { kind: "malformed-hash"; reason: string }
  | { kind: "payload-too-large"; length: number; limit: number }
  | { kind: "unrecognized-version"; got: number }
  | { kind: "schema-version-mismatch"; planSchema: string; packSchema: string }
  | { kind: "duplicate-target"; recipeId: string }
  | { kind: "target-not-a-producer"; recipeId: string }
  | { kind: "unknown-item-override"; itemId: string }
  | { kind: "duplicate-item-override"; itemId: string }
  | { kind: "invalid-item-override-plan-flag"; itemId: string; value: unknown };

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
    case "target-not-a-producer":
      return `Recipe ${error.recipeId} is input-supply metadata, not a selectable target.`;
    case "unknown-item-override":
      return `Item override references unknown item ${error.itemId}.`;
    case "duplicate-item-override":
      return `Item override duplicated for ${error.itemId}.`;
    case "invalid-item-override-plan-flag":
      return `Item override ${error.itemId}: plan must be literal true.`;
  }
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
    const recipe = recipeById.get(t.recipeId);
    // __domain_transfer recipes are input-supply metadata, not production steps
    // you can select. This is a second line of defense in case one slips past
    // the picker filter and lands in a plan.
    if (recipe && isInputSupplyRecipe(recipe)) {
      return { kind: "target-not-a-producer", recipeId: t.recipeId };
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
    }
  }
  return null;
}
