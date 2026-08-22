// No duals available. solver.Solve(model) from javascript-lp-solver@1.0.3
// returns a plain object whose only keys are `feasible`, `result`, `bounded`,
// and the positive-rate primal variables (e.g. `x_<recipeId>`). No dual values,
// reduced costs, shadow prices, or slack fields, and the result's prototype
// carries only `constructor`, so no helper method exposes them either. So
// assertOptimal below uses a forced-re-solve heuristic screen instead of a
// strong-duality / complementary-slackness check.

import type { RecipePack } from "@aef/schema";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import type { LpResult, LpInput } from "./lp";
import type { InvariantResult } from "./invariants";
import { isExtractionRecipe } from "../data/recipe-category";
import {
  solveLp,
  recipeCostWeight,
  SURPLUS_WEIGHT,
  DEFICIT_WEIGHT,
} from "./lp";

// Surplus/deficit objective weights are imported from lp.ts (not copied) so the
// screen scores against the same weights solveLp's primary pass minimizes.

// Active-rate threshold, matching the >1e-12 filter solveLp uses to build its
// rates map. A recipe present in result.rates already passed that filter.
const ACTIVE_EPS = 1e-12;

// Relative tolerance for objective comparisons, matching invariants.ts.
const REL_TOL = 1e-6;

/**
 * Recompute the primary-pass objective from an LpResult's emitted rates,
 * surplus, and deficit, using the SAME weights solveLp's primary pass uses:
 *   objective = sum_r cost(r) * rate(r)
 *             + sum_i SURPLUS_WEIGHT * surplus(i)
 *             + sum_i DEFICIT_WEIGHT * deficit(i)
 * `recipeCosts` is applied through recipeCostWeight. Pass the same map solveLp
 * was given to reproduce result.objectiveValue; omit it to score against the
 * intrinsic (default unit) recipe costs.
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
 * re-applied in case a caller hands in an unfiltered result.
 */
export function activeRecipeSet(result: LpResult): Set<RecipeId> {
  const active = new Set<RecipeId>();
  for (const [id, rate] of result.rates) {
    if (rate.valueOf() > ACTIVE_EPS) active.add(id);
  }
  return active;
}

type OptimalityInput = {
  targets: ReadonlyArray<ItemTarget>;
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
  recipeCosts?: Map<RecipeId, number>;
};

// Items that appear (as an input or output) in the given active recipes.
function itemsTouchedBy(active: Set<RecipeId>, pack: RecipePack): Set<ItemId> {
  const items = new Set<ItemId>();
  for (const r of pack.recipes) {
    if (!active.has(r.id)) continue;
    for (const io of r.in) items.add(io.item);
    for (const io of r.out) items.add(io.item);
  }
  return items;
}

/**
 * Reference-free optimality screen via forced re-solve (no duals available). A
 * pass does NOT prove LP-optimality; it means no cheaper one-hop-neighbor
 * substitution was found.
 *
 * Procedure:
 *  1. Solve the baseline with the given recipeCosts: base = solveLp(input). If
 *     the base is not softFeasible (a deficit var survives), abstain (ok:true,
 *     no violations): a deficit-laden base dominated by the 1e9 weight is not a
 *     meaningful optimality target, so comparisons against it are noise.
 *  2. Score the baseline at INTRINSIC (default unit) recipe costs:
 *     baseObj = recomputeObjective(base, pack)   // no recipeCosts arg.
 *     Scoring at intrinsic costs (not the override map) is the load-bearing
 *     choice: it asks whether the plan is minimal in real recipe-run terms, so a
 *     recipeCosts override steering solveLp onto a needlessly long chain becomes
 *     detectable. With no override, solve and score share the same costs, so the
 *     base is the intrinsic optimum up to the pass-2 lex cost-cap epsilon and in
 *     practice no candidate beats it.
 *  3. Restrict the candidate set to recipes INACTIVE in base that produce an
 *     item touched by base's active recipes (one-hop neighbors). For each, re-
 *     solve forcing it cheap by overriding its cost to 0 atop the original costs.
 *  4. Score each alternative at the SAME intrinsic costs, NOT the perturbed cost.
 *     The 0-override only admits the candidate; scoring at the perturbed cost
 *     would just measure the perturbation. An alternative strictly cheaper than
 *     baseObj beyond tolerance means the baseline was suboptimal -> violation.
 *  5. No cheaper one-hop-neighbor alternative -> screen passes.
 *
 * Limitations. False negatives: the candidate set is only inactive recipes that
 * produce an item already touched by the base plan, so multi-hop restructurings
 * and substitutions that introduce new items or sub-chains go unexplored; a pass
 * can still sit on a globally suboptimal plan. False positives: pass 2 is capped
 * at the pass-1 cost plus a relative epsilon, so the base can sit fractionally
 * above the true optimum and a forced re-solve landing just below it could rarely
 * report a spurious violation. The REL_TOL comparison absorbs the common case.
 */
export function assertOptimal(input: OptimalityInput): InvariantResult {
  const { targets, pack, itemOverrides, recipeCosts } = input;
  const violations: string[] = [];

  // Build an LpInput, omitting optional keys when undefined to stay compatible
  // with exactOptionalPropertyTypes.
  const lpInput = (costs: Map<RecipeId, number> | undefined): LpInput => {
    const base: LpInput = { targets, pack };
    if (itemOverrides !== undefined) base.itemOverrides = itemOverrides;
    if (costs !== undefined) base.recipeCosts = costs;
    return base;
  };

  const base = solveLp(lpInput(recipeCosts));
  // Abstain when the base is not softFeasible: a surviving deficit var makes the
  // objective dominated by the 1e9 deficit weight, so cheaper-alternative
  // comparisons are noise.
  if (!base.softFeasible) return { ok: true, violations: [] };
  const baseObj = recomputeObjective(base, pack);
  const baseActive = activeRecipeSet(base);
  const touched = itemsTouchedBy(baseActive, pack);

  const tol = Math.max(1, Math.abs(baseObj)) * REL_TOL;

  for (const candidate of pack.recipes) {
    if (baseActive.has(candidate.id)) continue;
    // An extraction recipe has no variable in the model, so forcing its cost to
    // 0 changes nothing and the re-solve returns the base plan. Skipping keeps
    // the candidate universe equal to the model's and saves a full solve each.
    if (isExtractionRecipe(candidate)) continue;
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
