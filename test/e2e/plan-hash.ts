// The one place the e2e suite turns plan intent into a share hash. There is no
// second definition of the wire format under test/: the payload comes from the
// app's own encodePlan, so any change to the envelope, the sort order or the
// compression chain reaches every spec automatically.
//
// encodePlan sorts targets and itemOverrides canonically by itemId and omits
// empty optional collections, so a spec must not assume its declared target
// order survives into the loaded plan.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodePlan, type ItemOverride, type Plan } from "../../src/data/plan";
import type { RationalString, Target } from "../../src/data/targets";

// Walk upward from this file to find the repo root that owns the AEF data
// pack. Matches the same discovery the app's vite.config.ts uses so the spec
// works equally well from the main STC/ checkout and from a worktree at
// STC/.claude/worktrees/<branch>/ -- the pack ships inside the repo, so the
// walk lands on the root at depth ~2 from this file either way.
function findParentRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "data/aef/recipe-pack.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    "Cannot locate parent root containing data/aef/recipe-pack.json",
  );
}

// Recipe-pack identity for the wire envelope, read once from
// data/aef/recipe-pack.json at module load. Reading it (rather than
// hard-coding) keeps the fixtures aligned with whatever pack ships with the
// build under test. Field names mirror the pack JSON, NOT the Plan envelope:
// planHash maps sourceCommit onto Plan.pack.submoduleSha, the field's legacy
// name. loadPlan validates only schemaVersion, so the other two ride unread and
// must be correct by construction.
export const PACK_META: {
  readonly id: string;
  readonly schemaVersion: string;
  readonly sourceCommit: string;
} = (() => {
  const packPath = join(
    findParentRoot(resolve(import.meta.dirname)),
    "data/aef/recipe-pack.json",
  );
  const raw = JSON.parse(readFileSync(packPath, "utf8")) as {
    schemaVersion: string;
    source: { name: string; sourceCommit?: string };
  };
  return {
    id: raw.source.name,
    schemaVersion: raw.schemaVersion,
    sourceCommit: raw.source.sourceCommit ?? "",
  };
})();

export type PlanSpec = {
  title?: string;
  targets: Target[];
  itemOverrides?: ItemOverride[];
  // No current caller sets this. It is here so PlanSpec mirrors Plan's
  // optional half; drop it if no spec ever needs a cost override.
  recipeCosts?: Map<string, RationalString>;
};

// Build the app-canonical v1 share hash for a plan spec. Resolves to
// "v1.<payload>" with no leading "#"; callers navigate with
// page.goto("/#" + hash).
export function planHash(spec: PlanSpec): Promise<string> {
  const plan: Plan = {
    version: 1,
    pack: {
      id: PACK_META.id,
      schemaVersion: PACK_META.schemaVersion,
      submoduleSha: PACK_META.sourceCommit,
    },
    title: spec.title ?? "",
    targets: spec.targets,
  };
  if (spec.itemOverrides) plan.itemOverrides = spec.itemOverrides;
  if (spec.recipeCosts) plan.recipeCosts = spec.recipeCosts;
  return encodePlan(plan);
}
