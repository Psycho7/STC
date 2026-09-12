// Lay out what solveForRender returned.
//
// The layout call needs two lookup maps beside the render plan, and both are
// built from the RAW pack the solve ran against:
//
//   itemById   - resolves each port's transportKind;
//   recipeById - the in-game stoichiometry every node row is drawn from.
//
// recipeById is NEVER the solve's own map. The solver nets self-consumption
// away (see netSelfConsumption) so a self-consuming recipe cannot materialize
// a self-edge, but the drawing has to keep the in-game rows: a self-consumed
// input renders as a row with no incoming edge, telling the player to loop
// that flow back themselves. Taking the netted map instead silently deletes
// those rows and moves every port beneath them.
//
// This module sits apart from solveForRender because it pulls elkjs: the bun
// CLIs solve and render headless and must never reach it.

import type { Edge } from "@xyflow/react";

import { layoutRenderPlan, type RFAnyNode } from "./layout";
import type { SolveForRenderOutput } from "../pipeline/solveForRender";

export type LayoutSolvedOptions = {
  // Omitted means the app default: lanes on. Passed straight through.
  busLanesEnabled?: boolean | undefined;
};

export async function layoutSolved(
  solved: SolveForRenderOutput,
  { busLanesEnabled }: LayoutSolvedOptions = {},
): Promise<{ nodes: RFAnyNode[]; edges: Edge[] }> {
  const { plan, pack } = solved;
  return layoutRenderPlan({
    plan,
    recipeById: new Map(pack.recipes.map((r) => [r.id, r])),
    itemById: new Map(pack.items.map((i) => [i.id, i])),
    ...(busLanesEnabled === undefined ? {} : { busLanesEnabled }),
  });
}
