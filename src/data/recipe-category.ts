import type { Recipe } from "@aef/schema";

// These recipes import items from elsewhere in the save rather than producing
// them on site, so they're supply metadata rather than real production steps.
// Right now that's the 59 __domain_transfer recipes, one per cross-domain
// transferable item.
export function isInputSupplyRecipe(recipe: Recipe): boolean {
  return recipe.category === "__domain_transfer";
}

// Recipe flags the pack uses to name a machine the player places on a map
// deposit rather than on the factory floor: "mining" on the 8 miner and pump
// recipes, "world-node" on the 2 purification nodes (derived by the extractor
// from the upstream machine's cost === -1 skip sentinel).
const EXTRACTION_FLAGS = ["mining", "world-node"];

// An extraction recipe draws a material out of the world instead of making it:
// the 10 miner, pump, and world-node recipes. A plan never builds one. What it
// yields arrives over the boundary as external supply, so an extractor is
// supply metadata the same way a cross-domain transfer is, not a production
// step. Most extractors consume nothing, and the zero-input test alone caught
// them until the hydro miner (copper ore for water) and the purification nodes
// showed up with real inputs, so the flags carry the rest.
export function isExtractionRecipe(recipe: Recipe): boolean {
  if (recipe.in.length === 0) return true;
  return (recipe.flags ?? []).some((f) => EXTRACTION_FLAGS.includes(f));
}

// Producers the LP may still fund - at big-M cost, when nothing else covers a
// demand - but that the render never draws: the input-supply recipes plus
// anything carrying the cost === -1 sentinel, which the recipe pack uses to
// mean "skip me by default" (today, the liquid_cleaner_1 waste sinks). Their
// absence from the logical graph is sanctioned rather than a defect, which is
// what checkRepresentable keys on. Extraction recipes are deliberately NOT
// here: they get no LP variable at all, so a positive rate on one is a real
// defect and must stay reportable.
export function isSanctionedAbsentProducer(recipe: Recipe): boolean {
  return isInputSupplyRecipe(recipe) || recipe.cost === -1;
}

// Recipes that pickProducer should never rank as producers: the sanctioned-
// absent set plus the extractors. This is the union of both enforcement
// strengths, so membership means "never walked or ranked" and nothing more -
// what the LP charges a member is a separate question.
export function isExcludedProducer(recipe: Recipe): boolean {
  return isSanctionedAbsentProducer(recipe) || isExtractionRecipe(recipe);
}

// A planter recipe grows a crop inside a self-sustaining seed loop (the seed
// collector recovers the seed from the crop), so once a planter exists the crop
// is gatherable like a raw material. The depth ranking uses this to seed
// planter outputs at depth 0; without it the seed loops keep most of the pack
// unranked. Matched by machine prefix so future planter tiers stay covered.
export function isPlanterRecipe(recipe: Recipe): boolean {
  return (recipe.producers ?? []).some((p) => p.startsWith("planter"));
}

// A sink recipe consumes items and produces nothing back. A target rate is
// undefined for such a recipe, so it can never be a target. The empty output
// list covers both the cost === -1 liquid_cleaner_1 waste sinks and the
// cost-less pure consumers (sewage-treat, power_originium_ore,
// power_proc_battery_1..5), which carry no sentinel at all.
export function isSinkRecipe(recipe: Recipe): boolean {
  return recipe.out.length === 0;
}

// The set of items that can be a plan target: any item produced with positive
// qty in ANY output slot of at least one recipe that is neither `__internal`
// (synthetic raw source) nor input-supply (`__domain_transfer`). Raw items with
// a real miner and byproduct-only items both qualify; an item that only ever
// comes out of an internal or input-supply recipe, or only ever at zero qty,
// does not.
export function producibleItemIds(recipes: readonly Recipe[]): Set<string> {
  const ids = new Set<string>();
  for (const r of recipes) {
    if (r.category === "__internal" || isInputSupplyRecipe(r)) continue;
    for (const o of r.out) {
      if (o.qty > 0) ids.add(o.item);
    }
  }
  return ids;
}
