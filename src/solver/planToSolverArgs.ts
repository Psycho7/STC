import type { Plan, ItemOverride } from "../data/plan";
import type { Target } from "../data/targets";
import type { RecipeId } from "./types";

export type SolverArgs = {
  targets: Target[];
  itemOverrides: ItemOverride[];
  recipeCosts: Map<RecipeId, number> | undefined;
};

/**
 * Convert a parsed Plan into the argument tuple consumed by solvePlan and
 * solvePlanWithIntermediates. Centralizes the num/denom -> number coercion
 * (Number(num)/Number(denom)) that both App.tsx call sites previously inlined.
 *
 * NOTE: the conversion is deliberately lossy in the same way the inline code
 * was -- Number() coercion for rational strings that cannot be represented
 * exactly in IEEE 754 (e.g. 1/3) produces the same repeating-decimal
 * approximation that JS floating-point arithmetic yields.
 */
export function planToSolverArgs(plan: Plan): SolverArgs {
  const itemOverrides = plan.itemOverrides ?? [];

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
