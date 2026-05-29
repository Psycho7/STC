import type { ItemOverride, Plan } from "./plan";
import type { Target } from "./targets";
import { gzipBytes, gunzipBytes } from "./encoding/gzip";
import { bytesToBase64url, base64urlToBytes } from "./encoding/base64url";

// Wire shape for the current (v1) envelope. We sort by stable keys when
// encoding so the same plan always produces the same URL hash. Decoding is
// lenient about unknown fields: optional fields added by a slightly newer build
// just come through as `undefined`. The actual invariant checks happen in
// validatePlan.
export type PlanWireV1 = {
  pack: [id: string, schemaVersion: string, sha: string];
  title: string;
  targets: Target[];
  itemOverrides?: ItemOverride[];
};

export function toWire(plan: Plan): PlanWireV1 {
  const targets = [...plan.targets].sort((a, b) =>
    a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0,
  );
  const wire: PlanWireV1 = {
    pack: [plan.pack.id, plan.pack.schemaVersion, plan.pack.submoduleSha],
    title: plan.title,
    targets,
  };
  if (plan.itemOverrides && plan.itemOverrides.length > 0) {
    wire.itemOverrides = [...plan.itemOverrides].sort((a, b) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
    );
  }
  return wire;
}

export function fromWire(wire: PlanWireV1): Plan {
  const [id, schemaVersion, submoduleSha] = wire.pack;
  const plan: Plan = {
    version: 1,
    pack: { id, schemaVersion, submoduleSha },
    title: wire.title,
    targets: wire.targets,
  };
  if (wire.itemOverrides !== undefined) {
    plan.itemOverrides = wire.itemOverrides;
  }
  return plan;
}

export async function encodeWire(wire: PlanWireV1): Promise<string> {
  const json = JSON.stringify(wire);
  const bytes = new TextEncoder().encode(json);
  const compressed = await gzipBytes(bytes);
  return bytesToBase64url(compressed);
}

export async function decodeWire(blob: string): Promise<PlanWireV1> {
  const compressed = base64urlToBytes(blob);
  const bytes = await gunzipBytes(compressed);
  return JSON.parse(new TextDecoder().decode(bytes)) as PlanWireV1;
}
