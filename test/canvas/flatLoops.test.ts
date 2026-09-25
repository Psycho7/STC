// A loop is not a compound node. Its members go to ELK and to React Flow as
// ordinary top-level cards, in the order the loop's members were emitted, and
// the loop is marked afterwards by a paint (loopPaint.ts) the layout and the
// router never see. INCLUDE_CHILDREN stays on the root anyway: on a graph with
// no compound node left it still changes how ELK breaks the planter 2-cycles,
// and the plain run pierces cards on multi6.

import { describe, expect, it } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  ROOT_LAYOUT_OPTIONS,
  renderPlanToElkGraph,
} from "../../src/canvas/layout";
import { packIndex } from "../../src/data/pack-index";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { SCENARIOS } from "../e2e/scenarios";

function solveScenario(id: string) {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  return solveForRender({
    targets: scenario.targets.map((t) => ({
      itemId: t.itemId,
      ratePerSec: t.ratePerSec,
    })),
    pack,
  });
}

describe("flat loops", () => {
  it("keeps INCLUDE_CHILDREN and the hierarchical greedy switch on the root", () => {
    expect(ROOT_LAYOUT_OPTIONS["org.eclipse.elk.hierarchyHandling"]).toBe(
      "INCLUDE_CHILDREN",
    );
    expect(
      ROOT_LAYOUT_OPTIONS[
        "org.eclipse.elk.layered.crossingMinimization.greedySwitchHierarchical.type"
      ],
    ).toBe("TWO_SIDED");
  });

  it("hands ELK no compound node on battery5-xiranite", () => {
    const solved = solveScenario("battery5-xiranite");
    // Premise: the plan still has loops for the flattening to act on.
    expect(solved.plan.containers.length).toBeGreaterThan(0);
    const { recipeById, itemById } = packIndex(solved.pack);
    const graph = renderPlanToElkGraph({
      plan: solved.plan,
      recipeById,
      itemById,
    });
    const compound = graph.children.filter(
      (child) => (child.children ?? []).length > 0,
    );
    expect(compound.map((child) => child.id)).toEqual([]);
    const ids = new Set(graph.children.map((child) => child.id));
    for (const container of solved.plan.containers) {
      expect(ids.has(container.id), container.id).toBe(false);
    }
  });

  it("lays battery5-xiranite out with no group node and no parentId", async () => {
    const { nodes } = await layoutSolved(solveScenario("battery5-xiranite"));
    expect(
      nodes.filter((n) => (n.type as string) === "group").map((n) => n.id),
    ).toEqual([]);
    expect(
      nodes.filter((n) => n.parentId !== undefined).map((n) => n.id),
    ).toEqual([]);
  }, 120_000);
});
