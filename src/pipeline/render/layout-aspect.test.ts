// Layout aspect-ratio regression.
//
// Dense plans used to lay out as one ~6:1 flat band, so fitView zoomed far below
// legibility and wasted most of the canvas. The root ELK graph now folds large
// plans (>= WRAP_MIN_UNITS) into stacked rows toward a ~1.6:1 target, keeping the
// bounding box close to the pane shape. These plans measure ~1.6-2.2:1 after the
// change; the <= 3.5:1 bound is a guard against regressing back toward the flat
// band, not a target to hit exactly.
//
// The change is geometry-only: the full render invariants and machine-count
// gates live in render-corpus.test.ts and are unaffected. Here we assert two
// things the option change must preserve: the reduced aspect, and that every SCC
// group container still fully contains its child members (wrapping must not
// fold a member outside its compound node).
import { describe, expect, it } from "vitest";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import type { Target } from "../../data/targets";
import { renderPlanFromSolve } from "../driver";
import { pack } from "../../data/load";
import { layoutRenderPlan } from "../../canvas/layout";

const ASPECT_BOUND = 3.5;

async function measure(recipeIds: string[]): Promise<{
  aspect: number;
  containmentViolations: number;
}> {
  const targets: Target[] = recipeIds.map((recipeId) => ({
    recipeId,
    ratePerSec: { num: "1", denom: "1" },
  }));
  const full = solvePlanWithIntermediates(
    targets,
    pack,
    defaultTransportConfig,
    [],
  );
  const { plan } = renderPlanFromSolve(full, pack, targets, []);
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const { nodes } = await layoutRenderPlan({
    plan,
    recipeById: full.recipeById,
    itemById,
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let containmentViolations = 0;
  for (const n of nodes) {
    const w = (n.width as number | undefined) ?? 0;
    const h = (n.height as number | undefined) ?? 0;
    if (n.parentId !== undefined) {
      // Child positions are relative to their parent group. A member must sit
      // inside the parent's box (small epsilon for rounding).
      const parent = byId.get(n.parentId);
      const pw = (parent?.width as number | undefined) ?? 0;
      const ph = (parent?.height as number | undefined) ?? 0;
      if (
        n.position.x < -0.5 ||
        n.position.y < -0.5 ||
        n.position.x + w > pw + 0.5 ||
        n.position.y + h > ph + 0.5
      ) {
        containmentViolations += 1;
      }
      continue;
    }
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return { aspect: height > 0 ? width / height : Infinity, containmentViolations };
}

describe("layout aspect ratio: dense plans stay near the pane shape", () => {
  // proc_battery_5 is the campaign's headline dense plan (23 recipes, SCC loop):
  // ~6:1 before, ~1.7:1 after.
  it("proc_battery_5 lays out within the aspect bound with contained SCC members", async () => {
    const { aspect, containmentViolations } = await measure(["proc_battery_5"]);
    expect(aspect).toBeLessThanOrEqual(ASPECT_BOUND);
    expect(containmentViolations).toBe(0);
  });

  // A multi-target dense plan (battery5 + xiranite) is the widest baseline case
  // (~7:1 before, ~1.6:1 after) and stresses SCC containment across two loops.
  it("battery5 + xiranite multi-target lays out within the aspect bound", async () => {
    const { aspect, containmentViolations } = await measure([
      "proc_battery_5",
      "xiranite_enr_powder",
    ]);
    expect(aspect).toBeLessThanOrEqual(ASPECT_BOUND);
    expect(containmentViolations).toBe(0);
  });
});
