import type { Recipe, RecipePack } from "@aef/schema";
import type { RecipeGraph, RecipeEdge } from "./types";
import { UnknownRecipeError } from "./types";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { effectiveSupply } from "./effectiveSupply";
import { isExcludedProducer } from "../data/recipe-category";

export function buildRecipeGraph(
  targets: Target[],
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): RecipeGraph {
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  const targetIds = new Set(targets.map((t) => t.recipeId));
  const overrides = itemOverrides ?? [];

  for (const t of targets) {
    if (!recipeById.has(t.recipeId)) throw new UnknownRecipeError(t.recipeId);
  }

  const producersByItem = new Map<string, string[]>();
  for (const r of pack.recipes) {
    for (const o of r.out) {
      if (!producersByItem.has(o.item)) producersByItem.set(o.item, []);
      producersByItem.get(o.item)!.push(r.id);
    }
  }

  // Raw-distance ranking. depthToItem[i] is the shortest recipe-depth to reach
  // item i across its non-excluded producers, with raw items sitting at 0.
  // depthToRecipe[r] is one more than the deepest of r's inputs. Excluded
  // recipes get no entry and never feed into either depth. Anything reachable
  // only through a cycle or an excluded producer stays at POSITIVE_INFINITY. We
  // stash both maps on the returned graph so pickProducer can read them without
  // recomputing on every call.
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
  // is just a guard against a malformed pack that never converges; a sane pack
  // settles in roughly the length of its longest acyclic chain.
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

  // Order each item's candidate producers by (depth, id) ascending so the
  // shallowest acyclic recipe comes first. Excluded recipes (no depthToRecipe
  // entry) and cycle-only ones (POSITIVE_INFINITY) sink to the back, so
  // pickProducer's filter drops the excluded ones and a cycle-only recipe only
  // wins when nothing acyclic is available.
  for (const arr of producersByItem.values()) {
    arr.sort((a, b) => {
      const da = depthToRecipe.get(a) ?? Number.POSITIVE_INFINITY;
      const db = depthToRecipe.get(b) ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  const nodes = new Map<string, Recipe>();
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();

  function ensureNode(id: string): void {
    if (nodes.has(id)) return;
    const recipe = recipeById.get(id);
    if (!recipe) throw new UnknownRecipeError(id);
    nodes.set(id, recipe);
    outgoing.set(id, []);
    incoming.set(id, []);
  }

  // Pick the candidate with the smallest (depth, id) tuple. Since the
  // producersByItem arrays are already sorted that way, we just walk them and
  // skip anything the exclusion filter rejects. An excluded recipe is only
  // honored if the user named it as a target (this covers the cost === -1
  // waste-sink carve-out, which now lives inside the predicate).
  function pickProducer(itemId: string): string | undefined {
    const candidates = producersByItem.get(itemId) ?? [];
    for (const cid of candidates) {
      const r = recipeById.get(cid);
      if (!r) continue;
      if (isExcludedProducer(r) && !targetIds.has(cid)) continue;
      return cid;
    }
    return undefined;
  }

  function addEdge(source: string, target: string, item: string): void {
    const id = `${source}:${item}->${target}`;
    const edge: RecipeEdge = { id, source, target, item };
    outgoing.get(source)!.push(edge);
    incoming.get(target)!.push(edge);
  }

  const stack: string[] = [];
  for (const t of targets) {
    ensureNode(t.recipeId);
    stack.push(t.recipeId);
  }

  while (stack.length) {
    const consumerId = stack.pop()!;
    const consumer = nodes.get(consumerId)!;
    for (const inp of consumer.in) {
      // Only stop expanding producers when the boundary supply for this item is
      // truly unlimited. A finite cap still falls through so the producer stays
      // in the graph and we can account for any deficit.
      if (effectiveSupply(inp.item, pack, overrides) === Infinity) continue;
      const producerId = pickProducer(inp.item);
      // A non-raw item with no producer recipe in the pack. Normally the data
      // tells us what to do, but skip defensively if nothing matched.
      if (!producerId) continue;
      const wasNew = !nodes.has(producerId);
      ensureNode(producerId);
      const already = (outgoing.get(producerId) ?? []).some(
        (e) => e.target === consumerId && e.item === inp.item,
      );
      if (!already) addEdge(producerId, consumerId, inp.item);
      if (wasNew) stack.push(producerId);
    }
  }

  return { nodes, outgoing, incoming, depthToItem, depthToRecipe };
}
