import type { RecipePack } from "@aef/schema";
import { isExcludedProducer } from "./recipe-category";

// Crafting-tier depth per recipe: 1 + the deepest of a recipe's input items,
// where an item's depth is the shallowest of its non-excluded producers and raw
// items sit at 0. Zero-input recipes are depth 1. Excluded producers get no
// entry and never feed either depth, so anything reachable only through a cycle
// or an excluded producer stays at POSITIVE_INFINITY. Extracted verbatim from
// graph.ts rankProducers so the recipe picker groups by the same metric the
// solver ranks producers by; the item map is computed here but not returned.
export function computeRecipeDepths(pack: RecipePack): Map<string, number> {
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  const producersByItem = new Map<string, string[]>();
  for (const r of pack.recipes) {
    for (const o of r.out) {
      if (!producersByItem.has(o.item)) producersByItem.set(o.item, []);
      producersByItem.get(o.item)!.push(r.id);
    }
  }

  const depthToItem = new Map<string, number>();
  for (const item of pack.items) {
    depthToItem.set(item.id, item.raw ? 0 : Number.POSITIVE_INFINITY);
  }
  const depthToRecipe = new Map<string, number>();
  for (const r of pack.recipes) {
    if (!isExcludedProducer(r))
      depthToRecipe.set(r.id, Number.POSITIVE_INFINITY);
  }

  // Relax depths to a fixpoint over the non-excluded recipes. The iteration cap
  // guards against a malformed pack that never converges; a sane pack settles in
  // roughly the length of its longest acyclic chain.
  const maxIter = pack.recipes.length + 1;
  for (let iter = 0, changed = true; changed && iter <= maxIter; iter++) {
    changed = false;
    for (const r of pack.recipes) {
      if (isExcludedProducer(r)) continue;
      if (
        (depthToRecipe.get(r.id) ?? Number.POSITIVE_INFINITY) !==
        Number.POSITIVE_INFINITY
      )
        continue;
      if (r.in.length === 0) {
        depthToRecipe.set(r.id, 1);
        changed = true;
        continue;
      }
      let maxIn = 0;
      let reachable = true;
      for (const inp of r.in) {
        const d = depthToItem.get(inp.item) ?? Number.POSITIVE_INFINITY;
        if (d === Number.POSITIVE_INFINITY) {
          reachable = false;
          break;
        }
        if (d > maxIn) maxIn = d;
      }
      if (reachable) {
        depthToRecipe.set(r.id, maxIn + 1);
        changed = true;
      }
    }
    for (const [itemId, producers] of producersByItem) {
      const current = depthToItem.get(itemId) ?? Number.POSITIVE_INFINITY;
      if (current !== Number.POSITIVE_INFINITY) continue;
      let min = Number.POSITIVE_INFINITY;
      for (const pid of producers) {
        const r = recipeById.get(pid);
        if (!r || isExcludedProducer(r)) continue;
        const d = depthToRecipe.get(pid) ?? Number.POSITIVE_INFINITY;
        if (d < min) min = d;
      }
      if (min < current) {
        depthToItem.set(itemId, min);
        changed = true;
      }
    }
  }

  return depthToRecipe;
}
