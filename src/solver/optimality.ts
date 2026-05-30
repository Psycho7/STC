// SPIKE finding: duals available: NO. solver.Solve(model) from
// javascript-lp-solver@1.0.3 returns a plain object whose only keys are
// `feasible`, `result`, `bounded`, and the positive-rate primal variables
// (e.g. `x_<recipeId>`). There are no dual values, reduced costs, shadow
// prices, or slack fields, and the result's prototype carries only
// `constructor`, so no helper method exposes them either. (Verified by a
// throwaway probe test that JSON-dumped a solved model at runtime: keys were
// ["feasible","result","x_make","bounded"].) Because no duals are available,
// assertOptimal below implements the FORCED RE-SOLVE witness rather than a
// strong-duality / complementary-slackness check.

import type { Recipe, RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import type { LpResult, LpInput } from "./lp";
import type { InvariantResult } from "./invariants";
import { solveLp } from "./lp";

// Objective weights, mirrored EXACTLY from lp.ts so the recomputed objective
// matches what solveLp's primary pass minimized.
const SURPLUS_WEIGHT = 1e-3;
const DEFICIT_WEIGHT = 1e9;

// Active-rate threshold, matching the >1e-12 filter solveLp uses when building
// its rates map. A recipe present in result.rates already passed that filter.
const ACTIVE_EPS = 1e-12;

// Relative tolerance for objective comparisons, matching invariants.ts.
const REL_TOL = 1e-6;

// Recipe-cost weight, mirrored EXACTLY from lp.ts recipeCostWeight: an override
// is clamped to >= 0; the target-only flag, cost === -1, and category
// __domain_transfer each map to the 1e6 big-M; everything else is 1.
function recipeCostWeight(
  r: Recipe,
  overrides: Map<RecipeId, number> | undefined,
): number {
  if (overrides?.has(r.id)) return Math.max(0, overrides.get(r.id)!);
  if (r.flags?.includes("target-only")) return 1e6;
  if (r.cost === -1) return 1e6;
  if (r.category === "__domain_transfer") return 1e6;
  return 1;
}

/**
 * Recompute the primary-pass objective from an LpResult's emitted rates,
 * surplus, and deficit, using the SAME weights solveLp's primary pass uses:
 *   objective = sum_r cost(r) * rate(r)
 *             + sum_i SURPLUS_WEIGHT * surplus(i)
 *             + sum_i DEFICIT_WEIGHT * deficit(i)
 * `recipeCosts` is applied through recipeCostWeight exactly as lp.ts does. Pass
 * the same map solveLp was given to reproduce result.objectiveValue; omit it to
 * score against the intrinsic (default unit) recipe costs.
 */
export function recomputeObjective(
  result: LpResult,
  pack: RecipePack,
  recipeCosts?: Map<RecipeId, number>,
): number {
  let total = 0;
  for (const r of pack.recipes) {
    const rate = result.rates.get(r.id)?.valueOf() ?? 0;
    if (rate === 0) continue;
    total += recipeCostWeight(r, recipeCosts) * rate;
  }
  for (const s of result.surplus.values()) {
    total += SURPLUS_WEIGHT * s.valueOf();
  }
  for (const d of result.deficit.values()) {
    total += DEFICIT_WEIGHT * d.valueOf();
  }
  return total;
}

/**
 * The set of recipe ids running at a positive rate. solveLp already filters its
 * rates map with the >1e-12 threshold, so every entry qualifies; ACTIVE_EPS is
 * re-applied defensively in case a caller hands in an unfiltered result.
 */
export function activeRecipeSet(result: LpResult): Set<RecipeId> {
  const active = new Set<RecipeId>();
  for (const [id, rate] of result.rates) {
    if (rate.valueOf() > ACTIVE_EPS) active.add(id);
  }
  return active;
}

type OptimalityInput = {
  targets: Target[];
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
  recipeCosts?: Map<RecipeId, number>;
};

// Items that appear (as an input or output) in the active recipes of a result.
function itemsTouchedBy(result: LpResult, pack: RecipePack): Set<ItemId> {
  const active = activeRecipeSet(result);
  const items = new Set<ItemId>();
  for (const r of pack.recipes) {
    if (!active.has(r.id)) continue;
    for (const io of r.in) items.add(io.item);
    for (const io of r.out) items.add(io.item);
  }
  return items;
}

/**
 * Reference-free optimality witness via FORCED RE-SOLVE (no duals available).
 *
 * Procedure:
 *  1. Solve the baseline with the given recipeCosts: base = solveLp(input).
 *  2. Score the baseline at INTRINSIC (default unit) recipe costs:
 *     baseObj = recomputeObjective(base, pack)   // note: no recipeCosts arg.
 *     Scoring at intrinsic costs (rather than the supplied override map) is the
 *     load-bearing choice: it asks "is this plan minimal in real recipe-run
 *     terms?", so a recipeCosts override that steers solveLp onto a needlessly
 *     long chain becomes detectable. With no override (recipeCosts undefined)
 *     the solve and the score share the same costs, so the base is by
 *     construction the intrinsic optimum and no candidate can beat it -> ok.
 *  3. Bound the candidate set to recipes that are INACTIVE in base but produce
 *     an item touched by base's active recipes (the only recipes that could
 *     substitute into the existing plan graph). For each candidate, re-solve
 *     forcing it cheap by overriding its cost to 0 on top of the original
 *     recipeCosts.
 *  4. Score each re-solved alternative at the SAME intrinsic costs, NOT the
 *     perturbed cost. The 0-override is only an incentive to admit the
 *     candidate; scoring at the perturbed cost would merely measure the
 *     perturbation. If an alternative is strictly cheaper than baseObj beyond
 *     tolerance, the baseline was suboptimal -> violation.
 *  5. No cheaper alternative -> base is (LP-)optimal -> ok.
 */
export function assertOptimal(input: OptimalityInput): InvariantResult {
  const { targets, pack, itemOverrides, recipeCosts } = input;
  const violations: string[] = [];

  // Build an LpInput, omitting optional keys when undefined so the call stays
  // compatible with exactOptionalPropertyTypes.
  const lpInput = (costs: Map<RecipeId, number> | undefined): LpInput => {
    const base: LpInput = { targets, pack };
    if (itemOverrides !== undefined) base.itemOverrides = itemOverrides;
    if (costs !== undefined) base.recipeCosts = costs;
    return base;
  };

  const base = solveLp(lpInput(recipeCosts));
  const baseObj = recomputeObjective(base, pack);
  const baseActive = activeRecipeSet(base);
  const touched = itemsTouchedBy(base, pack);

  const tol = Math.max(1, Math.abs(baseObj)) * REL_TOL;

  for (const candidate of pack.recipes) {
    if (baseActive.has(candidate.id)) continue;
    // Only consider candidates that produce an item already in the plan graph.
    const producesTouched = candidate.out.some((io) => touched.has(io.item));
    if (!producesTouched) continue;

    const forced = new Map(recipeCosts ?? []);
    forced.set(candidate.id, 0);
    const alt = solveLp(lpInput(forced));
    // Score at intrinsic costs, NOT the perturbed `forced` map.
    const altObj = recomputeObjective(alt, pack);

    if (altObj < baseObj - tol) {
      violations.push(
        `forcing recipe ${candidate.id} active yields a cheaper plan ` +
          `(${altObj} < ${baseObj}); base is suboptimal`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}
