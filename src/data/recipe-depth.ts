import type { RecipePack } from "@aef/schema";
import { isExcludedProducer, isPlanterRecipe } from "./recipe-category";

// Crafting-tier depth per recipe and per item: an item's depth is the minimum
// number of production steps from the depth-0 items, a recipe's depth is 1 +
// the deepest of its inputs (max over inputs, min over an item's producers).
// Depth 0 covers raw items and planter outputs: crops live in self-sustaining
// seed loops (seed -> crop -> seed), so treating them as raw is what lets the
// fixpoint rank loop members and everything downstream of them; on the real
// pack nothing stays at POSITIVE_INFINITY. Excluded producers get no entry and
// never feed either depth, so anything reachable only through an excluded
// producer (or a cycle no planter breaks open) stays at POSITIVE_INFINITY.
// Zero-input recipes are depth 1.
function computeDepths(pack: RecipePack): {
  depthToRecipe: Map<string, number>;
  depthToItem: Map<string, number>;
} {
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
  for (const r of pack.recipes) {
    if (isExcludedProducer(r) || !isPlanterRecipe(r)) continue;
    for (const o of r.out) depthToItem.set(o.item, 0);
  }
  const depthToRecipe = new Map<string, number>();
  for (const r of pack.recipes) {
    if (!isExcludedProducer(r))
      depthToRecipe.set(r.id, Number.POSITIVE_INFINITY);
  }

  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

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

  return { depthToRecipe, depthToItem };
}

// Recipe ranks for the solver: pickProducer orders each item's candidate
// producers by this depth.
export function computeRecipeDepths(pack: RecipePack): Map<string, number> {
  return computeDepths(pack).depthToRecipe;
}

// Item ranks for the UI: the recipe picker groups target tiles by this depth.
// Same fixpoint as computeRecipeDepths, viewed from the item side.
export function computeItemDepths(pack: RecipePack): Map<string, number> {
  return computeDepths(pack).depthToItem;
}
