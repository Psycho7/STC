import type { ItemOverride, Plan } from "./plan";
import type { RationalString, Target } from "./targets";
import { gzipBytes, gunzipBytes } from "./encoding/gzip";
import { bytesToBase64url, base64urlToBytes } from "./encoding/base64url";

// Wire shape for the v1 envelope. Encoding sorts by stable keys so the same
// plan always produces the same URL hash. Decoding is lenient about unknown
// fields: optional fields from a newer build come through as `undefined`.
// Invariant checks happen in validatePlan.
//
// Canonical order is the designed contract (decided wont-fix): the user's
// panel row order is purely presentational, is NOT carried on the wire, and
// cannot be restored on decode. Sharing or reloading a plan reorders targets
// and itemOverrides into canonical sorted order. Preserving row order would
// either break canonical hashing (stop sorting) or churn the wire format
// (a permutation field) for a cosmetic property.
//
// title is optional and omitted when empty: nothing reads it yet, so every
// hash the app writes today would otherwise carry a constant empty field. A
// wire without it decodes to the empty title, so old and new hashes both load.
//
// The sorts below compare with < and > rather than localeCompare: the hash has
// to come out identical on every machine, and localeCompare is locale- and
// ICU-build-dependent. Code-point order is the only ordering that holds.
export type PlanWireV1 = {
  pack: [id: string, schemaVersion: string, sha: string];
  title?: string;
  targets: Target[];
  itemOverrides?: ItemOverride[];
  recipeCosts?: Record<string, RationalString>;
};

// Rationals are rebuilt with the elements: a hand-crafted hash can hang extra
// keys off the { num, denom } object itself, one level below the element.
function canonicalRational(r: RationalString): RationalString {
  return { num: r.num, denom: r.denom };
}

export function toWire(plan: Plan): PlanWireV1 {
  // Encoding is the canonicalizing boundary: elements are rebuilt field by
  // field rather than passed through, so junk keys a hand-crafted hash carried
  // into fromWire cannot ride along into every re-encoded link, and key order
  // stays fixed no matter how the panel built the object.
  const targets = [...plan.targets]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((t) => ({
      itemId: t.itemId,
      ratePerSec: canonicalRational(t.ratePerSec),
    }));
  const wire: PlanWireV1 = {
    pack: [plan.pack.id, plan.pack.schemaVersion, plan.pack.submoduleSha],
    ...(plan.title !== "" ? { title: plan.title } : {}),
    targets,
  };
  if (plan.itemOverrides && plan.itemOverrides.length > 0) {
    wire.itemOverrides = [...plan.itemOverrides]
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
      .map((o) => ({
        itemId: o.itemId,
        ...(o.plan !== undefined ? { plan: o.plan } : {}),
        ...(o.ratePerSec !== undefined
          ? { ratePerSec: canonicalRational(o.ratePerSec) }
          : {}),
      }));
  }
  if (plan.recipeCosts && plan.recipeCosts.size > 0) {
    // Every override goes on the wire, including 1/1. The default cost is not
    // uniformly 1: target-only and excluded-producer recipes default to the
    // big-M cost, so a 1/1 override on them is load-bearing and dropping it
    // would silently change the shared plan's solve. toWire has no pack
    // access, so it cannot tell which case it is looking at.
    const entries = [...plan.recipeCosts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([recipeId, cost]) => [recipeId, canonicalRational(cost)] as const);
    wire.recipeCosts = Object.fromEntries(entries);
  }
  return wire;
}

// Structural trust boundary for decoded JSON. decodeWire returns whatever the
// hash carried; before fromWire destructures it and validatePlan iterates it,
// the container shapes must hold or both throw raw TypeErrors. Field-level
// semantics (rational validity, known ids) stay in validatePlan.
export function isWireShaped(x: unknown): x is PlanWireV1 {
  if (!isRecord(x)) return false;
  if (
    !Array.isArray(x.pack) ||
    x.pack.length !== 3 ||
    !x.pack.every((s) => typeof s === "string")
  ) {
    return false;
  }
  if (x.title !== undefined && typeof x.title !== "string") return false;
  if (!Array.isArray(x.targets) || !x.targets.every(isRecord)) return false;
  if (
    x.itemOverrides !== undefined &&
    (!Array.isArray(x.itemOverrides) || !x.itemOverrides.every(isRecord))
  ) {
    return false;
  }
  if (x.recipeCosts !== undefined && !isRecord(x.recipeCosts)) return false;
  return true;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function fromWire(wire: PlanWireV1): Plan {
  const [id, schemaVersion, submoduleSha] = wire.pack;
  const plan: Plan = {
    version: 1,
    pack: { id, schemaVersion, submoduleSha },
    title: wire.title ?? "",
    targets: wire.targets,
  };
  if (wire.itemOverrides !== undefined) {
    plan.itemOverrides = wire.itemOverrides;
  }
  if (wire.recipeCosts !== undefined) {
    plan.recipeCosts = new Map(Object.entries(wire.recipeCosts));
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
