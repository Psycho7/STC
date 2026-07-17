import type { RecipePack } from "@aef/schema";
import type { Plan, ItemOverride } from "../data/plan";
import type { Target, ItemTarget } from "../data/targets";
import type { RecipeId } from "./types";

// BRIDGE: the solver pipeline is mid-flip from recipe-keyed to item-keyed
// targets. The LP core consumes `itemId`; the graph/replicate/render stages
// still key on `recipeId`. planToSolverArgs emits both until those stages are
// rewritten to item targets, at which point `recipeId` (and this alias) go
// away and the solver speaks ItemTarget only.
export type SolverTarget = Target & ItemTarget;

export type SolverArgs = {
  targets: SolverTarget[];
  itemOverrides: ItemOverride[];
  recipeCosts: Map<RecipeId, number> | undefined;
};

/**
 * Convert a parsed Plan into the argument tuple consumed by
 * solvePlanWithIntermediates. Centralizes the num/denom -> number coercion
 * (Number(num)/Number(denom)) that both App.tsx call sites previously inlined,
 * and maps each recipe target onto its primary output item (the temporary
 * recipe->item bridge; see SolverTarget).
 *
 * The conversion is deliberately lossy the same way the inline code was:
 * Number() coercion of a rational string not exactly representable in IEEE 754
 * (e.g. 1/3) yields the same repeating-decimal approximation JS float arithmetic
 * does.
 */
export function planToSolverArgs(plan: Plan, pack: RecipePack): SolverArgs {
  const itemOverrides = plan.itemOverrides ?? [];

  // recipeCosts are coerced to number here via Number(num)/Number(denom).
  // itemOverrides.ratePerSec (the per-item supply cap) stays a RationalString and
  // is coerced downstream (effectiveSupply.ts uses Fraction).
  const recipeCosts = plan.recipeCosts
    ? new Map(
        [...plan.recipeCosts].map(
          ([k, v]) =>
            [k, Number(v.num) / Number(v.denom)] as [string, number],
        ),
      )
    : undefined;

  return { targets: toSolverTargets(plan.targets, pack), itemOverrides, recipeCosts };
}

// BRIDGE: attach each recipe target's primary output item. A target that
// already carries an itemId keeps it. Plan validation rejects unknown recipes
// upstream, so the empty-string fallback never fires on a validated plan; it
// only keeps the mapping total. Also used by tests that feed recipe-form
// targets straight into the solver entry points.
export function toSolverTargets(
  targets: ReadonlyArray<Target & Partial<ItemTarget>>,
  pack: RecipePack,
): SolverTarget[] {
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  return targets.map((t) => ({
    ...t,
    itemId: t.itemId ?? recipeById.get(t.recipeId)?.out[0]?.item ?? "",
  }));
}
