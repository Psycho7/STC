import type { Recipe } from "@aef/schema";

// These recipes import items from elsewhere in the save rather than producing
// them on site, so they're supply metadata rather than real production steps.
// Right now that's the 59 __domain_transfer recipes, one per cross-domain
// transferable item.
export function isInputSupplyRecipe(recipe: Recipe): boolean {
  return recipe.category === "__domain_transfer";
}

// Recipes that pickProducer should never rank as producers. That covers the
// input-supply recipes plus anything carrying the cost === -1 sentinel, which
// the recipe pack uses to mean "skip me by default" (today, the liquid_cleaner_1
// waste sinks).
export function isExcludedProducer(recipe: Recipe): boolean {
  return isInputSupplyRecipe(recipe) || recipe.cost === -1;
}

// A sink recipe consumes items and produces nothing back. A target rate is
// undefined for such a recipe, so it can never be a target. The empty output
// list covers both the cost === -1 liquid_cleaner_1 waste sinks and the
// cost-less pure consumers (sewage-treat, power_originium_ore,
// power_proc_battery_1..5), which carry no sentinel at all.
export function isSinkRecipe(recipe: Recipe): boolean {
  return recipe.out.length === 0;
}
