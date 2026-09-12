// Heuristic #9 (next-stage invariant): the render policy's output is consumed
// by ELK Layered. The driver runs AlwaysFoldRender as its final stage, so this
// test takes the plan renderPlanFromSolve returns and pipes it through the same
// layoutRenderPlan() entry point the canvas uses, then asserts the laid-out
// graph is well-formed.

import { describe, it, expect } from "vitest";
import {
  solveForRender,
  type SolveForRenderOutput,
} from "../../../src/pipeline/solveForRender";
import { layoutSolved } from "../../../src/canvas/layoutSolved";
import { pack } from "../../../src/data/load";
import { defaultTargets } from "../../../src/data/targets";
import type { ItemOverride } from "../../../src/data/plan";

// The default-targets plan, rendered exactly the way the app renders it.
function buildAlwaysFoldPlan(): SolveForRenderOutput {
  const targets = defaultTargets();
  const itemOverrides: ItemOverride[] = [];
  return solveForRender({ targets, pack, itemOverrides });
}

describe("AlwaysFoldRender -> ELK acceptance", () => {
  it("produces a layout with finite coordinates for every node on the default plan", async () => {
    const solved = buildAlwaysFoldPlan();
    expect(solved.plan.units.length).toBeGreaterThan(0);

    const laid = await layoutSolved(solved);

    expect(laid.nodes.length).toBeGreaterThan(0);
    for (const n of laid.nodes) {
      const x = n.position?.x;
      const y = n.position?.y;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("every render-plan edge endpoint resolves to a laid-out node", async () => {
    const solved = buildAlwaysFoldPlan();
    const { plan } = solved;

    const laid = await layoutSolved(solved);

    const nodeIds = new Set(laid.nodes.map((n) => n.id));
    // Cross-check: every unit emitted by AlwaysFoldRender shows up as a laid
    // node (catches "unit emitted but ELK dropped it" regressions). Container
    // wrappers are not units; AlwaysFoldRender's `units` array only contains
    // recipe / loop / input-product / output-product nodes, all of which ELK
    // must place.
    for (const u of plan.units) {
      expect(nodeIds.has(u.id)).toBe(true);
    }
    // And every edge endpoint resolves. This catches "AlwaysFoldRender emits
    // an edge whose fromUnit/toUnit doesn't exist in `units`" regressions.
    for (const e of plan.edges) {
      expect(nodeIds.has(e.fromUnit)).toBe(true);
      expect(nodeIds.has(e.toUnit)).toBe(true);
    }
  });
});
