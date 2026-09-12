// The one entry for "solve this plan against a pack and render it".
//
// Solving and rendering are two calls whose argument orders differ, and three
// values (pack, targets, itemOverrides) have to be spelled identically into
// both for the result to mean anything. Every caller used to restate that by
// hand. This module owns it:
//
//   1. one pack instance reaches both the solver and the render pipeline;
//   2. one targets list and one itemOverrides list reach both;
//   3. the pack that reaches the render pipeline is the RAW one -- netting is
//      the solver's business and never crosses this seam;
//   4. the transport config is supplied once, here.
//
// It deliberately does NOT validate the transport config: the app validates
// once at import against the shipped pack, and validating per call would newly
// throw on synthetic packs carrying an unknown transport kind.
//
// Error modes are pass-through and unchanged: LpInfeasibleError from the
// solver, and the DEV invariant throws from the solver and the driver.
//
// No elkjs import, directly or transitively: the bun CLIs (tools/solver-cli,
// tools/exam/coverage) run this chain headless. The layout step lives behind
// its own module.

import type { RecipePack } from "@aef/schema";
import { pack as shippedPack } from "../data/load";
import type { ItemOverride } from "../data/plan";
import type { ItemTarget } from "../data/targets";
import { solvePlanWithIntermediates, type SolvePlanFull } from "../solver";
import type { RecipeId } from "../solver/types";
import { renderPlanFromSolve, type RenderPipelineOutput } from "./driver";

export type SolveForRenderRequest = {
  targets: ReadonlyArray<ItemTarget>;
  /** Defaults to no overrides. */
  itemOverrides?: ReadonlyArray<ItemOverride> | undefined;
  recipeCosts?: Map<RecipeId, number> | undefined;
  /** Defaults to the shipped pack. Must be the RAW pack. */
  pack?: RecipePack | undefined;
};

/** The render pipeline's output plus the solve it came from. */
export type SolveForRenderOutput = RenderPipelineOutput & {
  full: SolvePlanFull;
};

export function solveForRender({
  targets,
  itemOverrides = [],
  recipeCosts,
  pack = shippedPack,
}: SolveForRenderRequest): SolveForRenderOutput {
  // solvePlanWithIntermediates still declares a mutable array and only reads
  // it; the cast keeps ONE overrides instance reaching both calls, which is
  // the whole point of this module.
  const overrides = itemOverrides as ItemOverride[];
  const full = solvePlanWithIntermediates(
    targets,
    pack,
    overrides,
    recipeCosts,
  );
  return { full, ...renderPlanFromSolve(full, pack, targets, overrides) };
}
