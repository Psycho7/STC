// SPIKE finding: duals available: NO. solver.Solve(model) from
// javascript-lp-solver@1.0.3 returns a plain object whose only keys are
// `feasible`, `result`, `bounded`, and the positive-rate primal variables
// (e.g. `x_<recipeId>`). There are no dual values, reduced costs, shadow
// prices, or slack fields, and the result's prototype carries only
// `constructor`, so no helper method exposes them either. (Verified by a
// throwaway probe test that JSON-dumped a solved model at runtime: keys were
// ["feasible","result","x_make","bounded"].) Because no duals are available,
// assertOptimal below implements the FORCED RE-SOLVE heuristic screen rather
// than a strong-duality / complementary-slackness check.

import type { RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import type { LpResult, LpInput } from "./lp";
import type { InvariantResult } from "./invariants";
import {
  solveLp,
  recipeCostWeight,
  SURPLUS_WEIGHT,
  DEFICIT_WEIGHT,
} from "./lp";

// Surplus/deficit objective weights are imported from lp.ts (not copied) so the
// screen scores against the exact weights solveLp's primary pass minimizes.

// Active-rate threshold, matching the >1e-12 filter solveLp uses when building
// its rates map. A recipe present in result.rates already passed that filter.
const ACTIVE_EPS = 1e-12;

// Relative tolerance for objective comparisons, matching invariants.ts.
const REL_TOL = 1e-6;

/**
 * Recompute the primary-pass objective from an LpResult's emitted rates,
 * surplus, and deficit, using the SAME weights solveLp's primary pass uses:
 *   objective = sum_r cost(r) * rate(r)
 *             + sum_i SURPLUS_WEIGHT * surplus(i)
 *             + sum_i DEFICIT_WEIGHT * deficit(i)
 * `recipeCosts` is applied through lp.ts's exported recipeCostWeight. Pass
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
 * Reference-free heuristic optimality SCREEN via FORCED RE-SOLVE (no duals
 * available). A passing screen does NOT prove LP-optimality; it means no
 * cheaper one-hop-neighbor substitution was found (see Limitations below).
 *
 * Procedure:
 *  1. Solve the baseline with the given recipeCosts: base = solveLp(input).
 *     If the base is not softFeasible (a deficit var survives), the screen
 *     abstains: returns ok:true with no violations. An infeasible/deficit-laden
 *     base is not a meaningful optimality target; comparisons against it produce
 *     noise, not signal.
 *  2. Score the baseline at INTRINSIC (default unit) recipe costs:
 *     baseObj = recomputeObjective(base, pack)   // note: no recipeCosts arg.
 *     Scoring at intrinsic costs (rather than the supplied override map) is the
 *     load-bearing choice: it asks "is this plan minimal in real recipe-run
 *     terms?", so a recipeCosts override that steers solveLp onto a needlessly
 *     long chain becomes detectable. With no override (recipeCosts undefined)
 *     the solve and the score share the same costs, so the base is the
 *     intrinsic optimum up to the pass-2 lex cost-cap epsilon (see Limitations)
 *     and in practice no candidate beats it -> ok.
 *  3. Bound the candidate set to recipes that are INACTIVE in base but produce
 *     an item touched by base's active recipes (one-hop neighbors of the current
 *     plan graph). For each candidate, re-solve forcing it cheap by overriding
 *     its cost to 0 on top of the original recipeCosts.
 *  4. Score each re-solved alternative at the SAME intrinsic costs, NOT the
 *     perturbed cost. The 0-override is only an incentive to admit the
 *     candidate; scoring at the perturbed cost would merely measure the
 *     perturbation. If an alternative is strictly cheaper than baseObj beyond
 *     tolerance, the baseline was suboptimal -> violation.
 *  5. No cheaper one-hop-neighbor alternative found -> the screen passes (ok).
 *     This does NOT prove LP-optimality (see Limitations below).
 *
 * Limitations. False negatives: the candidate set is restricted to inactive
 * recipes that produce an item already touched by the base plan. Multi-hop
 * restructurings and substitutions that introduce entirely new items or
 * sub-chains are NOT explored, so a passing screen can still sit on a globally
 * suboptimal plan; it catches one-hop cost improvements only. False positives:
 * solveLp's pass 2 is capped at the pass-1 cost plus a relative epsilon, so the
 * base can sit fractionally above the true optimum and a forced re-solve that
 * lands just below it could, in rare cases, report a spurious violation. The
 * REL_TOL comparison absorbs the common case.
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
  // Abstain when the base is not softFeasible: a deficit var survived, so the
  // objective is dominated by the 1e9 deficit weight and cheaper-alternative
  // comparisons are meaningless noise rather than optimality signal.
  if (!base.softFeasible) return { ok: true, violations: [] };
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
