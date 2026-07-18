import type { RecipePack } from "@aef/schema";
import { isExcludedProducer } from "./recipe-category";
import { tarjanScc } from "../solver/scc";
import type { RecipeEdge, RecipeGraph } from "../solver/types";

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

// UI-only item availability tiers for the recipe picker. Acyclic items keep
// their fixpoint depth (min over non-excluded producer depths, raw = 0). The
// POSITIVE_INFINITY remainder - loop members the fixpoint can never relax - is
// resolved by condensing SCCs of the item dependency graph: each SCC's tier is
// 1 + the max tier of the items feeding it from outside, shared by all members.
// The solver keeps consuming computeRecipeDepths (where loop recipes stay
// Infinity), so this is a separate function and leaves that path untouched.
export function computeItemTiers(pack: RecipePack): Map<string, number> {
  const recipeDepths = computeRecipeDepths(pack);

  // Non-excluded producers per item, mirroring computeRecipeDepths.
  const producersByItem = new Map<string, string[]>();
  for (const r of pack.recipes) {
    if (isExcludedProducer(r)) continue;
    for (const o of r.out) {
      if (!producersByItem.has(o.item)) producersByItem.set(o.item, []);
      producersByItem.get(o.item)!.push(r.id);
    }
  }

  // Item availability depth: raw = 0, else the min over non-excluded producer
  // recipe depths. This reconstructs the item map computeRecipeDepths relaxes
  // internally (line "min over an item's producers") but does not return.
  const itemDepth = new Map<string, number>();
  for (const item of pack.items) {
    if (item.raw) {
      itemDepth.set(item.id, 0);
      continue;
    }
    let min = Number.POSITIVE_INFINITY;
    for (const pid of producersByItem.get(item.id) ?? []) {
      const d = recipeDepths.get(pid) ?? Number.POSITIVE_INFINITY;
      if (d < min) min = d;
    }
    itemDepth.set(item.id, min);
  }

  // The Infinity remainder: items no non-excluded producer chain can reach
  // acyclically. These are the only nodes we condense.
  const remainder = new Set<string>();
  for (const [id, d] of itemDepth) {
    if (d === Number.POSITIVE_INFINITY) remainder.add(id);
  }

  // Item dependency subgraph restricted to remainder items and non-excluded
  // recipes: edge in-item -> out-item when a recipe consumes the former and
  // produces the latter. tarjanScc reads only `outgoing` and returns members in
  // its `recipeIds` field, so an adjacency-only graph shape fits directly and
  // carries item ids through unchanged; nodes/incoming stay empty.
  const outgoing = new Map<string, RecipeEdge[]>();
  for (const id of remainder) outgoing.set(id, []);
  const seenEdge = new Set<string>();
  for (const r of pack.recipes) {
    if (isExcludedProducer(r)) continue;
    for (const o of r.out) {
      if (!remainder.has(o.item)) continue;
      for (const i of r.in) {
        if (!remainder.has(i.item)) continue;
        const key = `${i.item} ${o.item}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        outgoing.get(i.item)!.push({
          id: key,
          source: i.item,
          target: o.item,
          item: o.item,
        });
      }
    }
  }

  const graph: RecipeGraph = {
    nodes: new Map(),
    incoming: new Map(),
    outgoing,
  };
  const sccs = tarjanScc(graph);
  const sccOf = new Map<string, string>();
  for (const s of sccs) for (const m of s.recipeIds) sccOf.set(m, s.id);

  // External feeders per SCC: items consumed by a member-producing recipe that
  // are not themselves members of that SCC. A feeder may be a finite item or a
  // member of another (upstream) SCC.
  const externalInputs = new Map<string, Set<string>>();
  for (const s of sccs) externalInputs.set(s.id, new Set());
  for (const r of pack.recipes) {
    if (isExcludedProducer(r)) continue;
    for (const o of r.out) {
      const sid = sccOf.get(o.item);
      if (sid === undefined) continue;
      for (const i of r.in) {
        if (sccOf.get(i.item) === sid) continue;
        externalInputs.get(sid)!.add(i.item);
      }
    }
  }

  const sccTier = new Map<string, number>();
  for (const s of sccs) sccTier.set(s.id, Number.POSITIVE_INFINITY);

  const tierOfItem = (item: string): number => {
    const d = itemDepth.get(item);
    if (d !== undefined && d !== Number.POSITIVE_INFINITY) return d;
    const sid = sccOf.get(item);
    if (sid !== undefined) return sccTier.get(sid)!;
    return Number.POSITIVE_INFINITY;
  };

  // Relax SCC tiers to a fixpoint over the condensation DAG. An SCC resolves
  // once every external feeder is finite; tier = 1 + max feeder tier. An SCC
  // with no external feeder, or any still-Infinity feeder, stays Infinity.
  const maxIter = sccs.length + 1;
  for (let iter = 0, changed = true; changed && iter <= maxIter; iter++) {
    changed = false;
    for (const s of sccs) {
      if (sccTier.get(s.id) !== Number.POSITIVE_INFINITY) continue;
      const inputs = externalInputs.get(s.id)!;
      if (inputs.size === 0) continue;
      let maxT = 0;
      let allFinite = true;
      for (const u of inputs) {
        const t = tierOfItem(u);
        if (t === Number.POSITIVE_INFINITY) {
          allFinite = false;
          break;
        }
        if (t > maxT) maxT = t;
      }
      if (allFinite) {
        sccTier.set(s.id, maxT + 1);
        changed = true;
      }
    }
  }

  const result = new Map<string, number>();
  for (const item of pack.items) result.set(item.id, tierOfItem(item.id));
  return result;
}
