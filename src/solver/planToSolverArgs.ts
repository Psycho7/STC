import type { Plan, ItemOverride } from "../data/plan";
import type { Target } from "../data/targets";
import type { RecipeId } from "./types";

export type SolverArgs = {
  targets: Target[];
  itemOverrides: ItemOverride[];
  recipeCosts: Map<RecipeId, number> | undefined;
};

/**
 * Convert a parsed Plan into the argument tuple consumed by
 * solvePlanWithIntermediates. Plan targets are already item-keyed, so they pass
 * straight through; this centralizes the num/denom -> number coercion
 * (Number(num)/Number(denom)) that both App.tsx call sites previously inlined.
 *
 * The conversion is deliberately lossy the same way the inline code was:
 * Number() coercion of a rational string not exactly representable in IEEE 754
 * (e.g. 1/3) yields the same repeating-decimal approximation JS float arithmetic
 * does.
 */
export function planToSolverArgs(plan: Plan): SolverArgs {
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

  return { targets: plan.targets, itemOverrides, recipeCosts };
}
