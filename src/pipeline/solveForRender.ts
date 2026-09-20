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
//      the solver's business and never crosses this seam.
//
// No transport config crosses this seam, and it deliberately does NOT validate
// one: the app validates the shipped config once at import against the shipped pack, and validating per call would newly
// throw on synthetic packs carrying an unknown transport kind.
//
// Error modes are pass-through and unchanged: LpInfeasibleError from the
// solver, and the DEV invariant throws from the solver and the driver.
//
// No elkjs import, directly or transitively: the bun CLIs (tools/solver-cli,
// tools/exam/coverage) run this chain headless. The layout step lives behind
// its own module.

import { pack as shippedPack } from "../data/load";
import type { ItemOverride, Plan } from "../data/plan";
import type { ItemTarget } from "../data/targets";
import { solvePlanWithIntermediates, type SolvePlanFull } from "../solver";
import type { RawPack } from "../solver/net-self";
import { planToSolverArgs } from "../solver/planToSolverArgs";
import type { RecipeId } from "../solver/types";
import { renderPlanFromSolve, type RenderPipelineOutput } from "./driver";
import { targetOutputShortfalls } from "./render/invariants";
import { rationalFromString } from "./render/rational";
import { isInputProductUnit, type RenderPlan } from "./types";

export type SolveForRenderRequest = {
  targets: ReadonlyArray<ItemTarget>;
  /** Defaults to no overrides. */
  itemOverrides?: ReadonlyArray<ItemOverride> | undefined;
  recipeCosts?: Map<RecipeId, number> | undefined;
  /** Defaults to the shipped pack. The RawPack brand rejects a netted one. */
  pack?: RawPack | undefined;
  /**
   * App-level availability state (#144): recipe ids switched off for this
   * solve, threaded to the graph walk and the LP. Defaults to empty, like the
   * other optionals - which is what a fresh browser solves with.
   */
  unavailableRecipeIds?: ReadonlySet<RecipeId> | undefined;
};

/**
 * The render pipeline's output, the solve it came from, and the RAW pack both
 * ran against -- the layout step needs that same pack to build its item and
 * recipe lookups.
 *
 * `targets` and `itemOverrides` are the very lists both calls received, defaults
 * already applied: a caller that checks the result (render invariants, shortfall
 * reads) asserts against what was solved rather than re-deriving it.
 */
export type SolveForRenderOutput = RenderPipelineOutput & {
  full: SolvePlanFull;
  pack: RawPack;
  targets: ReadonlyArray<ItemTarget>;
  itemOverrides: ReadonlyArray<ItemOverride>;
};

export function solveForRender({
  targets,
  itemOverrides = [],
  recipeCosts,
  pack = shippedPack,
  unavailableRecipeIds,
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
    unavailableRecipeIds,
  );
  return {
    full,
    pack,
    targets,
    itemOverrides: overrides,
    ...renderPlanFromSolve(full, pack, targets, overrides),
  };
}

/** A solve driven by a validated Plan, plus what the drawing fails to deliver. */
export type SolveFromPlanOutput = SolveForRenderOutput & {
  /**
   * The target items the drawn plan feeds below their declared rate. The LP
   * never reports these as infeasible - a capped raw input with no alternative
   * route just yields a partial plan - so this is the one signal that the drawn
   * graph does not meet the declared intent.
   */
  underDelivered: string[];
  /**
   * Items carrying an explicit finite supply cap the drawn plan pulls in full.
   * The only evidence that lets the UI name a supply cap as a reason for a
   * shortfall: a cap the plan does not exhaust constrains nothing.
   */
  cappedAtLimit: string[];
};

/**
 * The items of `itemOverrides` whose cap the drawn plan draws in full, read off
 * the boundary input units the render pipeline emitted (their `rate` is what the
 * solve pulled, their `rateCap` the declared limit). Fan-out slices are skipped:
 * only the whole node carries the item's total draw.
 */
export function boundaryCapsAtLimit(
  plan: RenderPlan,
  itemOverrides: ReadonlyArray<ItemOverride>,
): string[] {
  const capped = new Set(
    itemOverrides.flatMap((ov) =>
      ov.ratePerSec === undefined ? [] : [ov.itemId],
    ),
  );
  if (capped.size === 0) return [];

  const atLimit = new Set<string>();
  for (const unit of plan.units) {
    if (!isInputProductUnit(unit)) continue;
    if (unit.isFanout) continue;
    if (!capped.has(unit.itemId) || unit.rateCap === undefined) continue;
    const cap = rationalFromString(unit.rateCap);
    if (rationalFromString(unit.rate).compare(cap) < 0) continue;
    atLimit.add(unit.itemId);
  }
  return [...atLimit].sort();
}

/**
 * The Plan-driven half of the seam: convert the plan to solver arguments, solve
 * and render it, and read the shortfalls off the plan that was drawn. Callers
 * holding a Plan use this so the argument conversion and the shortfall read have
 * one home each.
 */
export function solveFromPlan(
  plan: Plan,
  pack?: RawPack | undefined,
  unavailableRecipeIds?: ReadonlySet<RecipeId> | undefined,
): SolveFromPlanOutput {
  const { targets, itemOverrides, recipeCosts } = planToSolverArgs(plan);
  const out = solveForRender({
    targets,
    itemOverrides,
    recipeCosts,
    pack,
    unavailableRecipeIds,
  });
  return {
    ...out,
    underDelivered: targetOutputShortfalls(out.plan, out.targets).map(
      (s) => s.item,
    ),
    cappedAtLimit: boundaryCapsAtLimit(out.plan, out.itemOverrides),
  };
}
