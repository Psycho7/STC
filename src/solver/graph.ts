import Fraction from "fraction.js";
import type { Recipe, RecipePack } from "@aef/schema";
import type { RecipeGraph, RecipeEdge, RecipeId } from "./types";
import { UnknownRecipeError } from "./types";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { effectiveSupply } from "./effectiveSupply";
import { isExcludedProducer } from "../data/recipe-category";
import { computeRecipeDepths } from "../data/recipe-depth";

// Validate targets, index producers by output item, and rank each item's
// candidate producers by (depth, id). Shared by both graph builders so ranking
// is identical regardless of how producers are selected.
function rankProducers(
  targets: Target[],
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): {
  recipeById: Map<string, Recipe>;
  targetIds: Set<string>;
  overrides: ItemOverride[];
  producersByItem: Map<string, string[]>;
} {
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

  // Raw-distance ranking: depthToRecipe[r] is one more than the deepest of r's
  // inputs, with excluded and cycle-only recipes left at POSITIVE_INFINITY.
  const depthToRecipe = computeRecipeDepths(pack);

  // Order each item's candidate producers by (depth, id) ascending so the
  // shallowest acyclic recipe comes first. Excluded recipes (no depthToRecipe
  // entry) and cycle-only ones (POSITIVE_INFINITY) sink to the back, so the
  // exclusion filter drops the excluded ones and a cycle-only recipe only wins
  // when nothing acyclic exists.
  for (const arr of producersByItem.values()) {
    arr.sort((a, b) => {
      const da = depthToRecipe.get(a) ?? Number.POSITIVE_INFINITY;
      const db = depthToRecipe.get(b) ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  return { recipeById, targetIds, overrides, producersByItem };
}

// Walk the targets' input cone, attaching producer edges. When multi is false,
// attach only the shallowest viable producer per consumed item; when true,
// attach every non-excluded producer. An excluded recipe is honored only if the
// user named it as a target (covers the cost === -1 waste-sink carve-out inside
// isExcludedProducer). Dedup keeps one edge per (producer, item, consumer).
function buildGraph(
  targets: Target[],
  pack: RecipePack,
  itemOverrides: ItemOverride[] | undefined,
  multi: boolean,
): RecipeGraph {
  const { recipeById, targetIds, overrides, producersByItem } = rankProducers(
    targets,
    pack,
    itemOverrides,
  );

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
      // Stop expanding producers only when this item's boundary supply is
      // unlimited. A finite cap falls through so the producer stays in the graph
      // and any deficit can be accounted for.
      if (effectiveSupply(inp.item, pack, overrides) === Infinity) continue;
      // producersByItem is pre-sorted by (depth, id). Single mode keeps the first
      // viable producer; multi mode keeps them all.
      const candidates = producersByItem.get(inp.item) ?? [];
      for (const cid of candidates) {
        const r = recipeById.get(cid);
        if (!r) continue;
        if (isExcludedProducer(r) && !targetIds.has(cid)) continue;
        const wasNew = !nodes.has(cid);
        ensureNode(cid);
        const already = (outgoing.get(cid) ?? []).some(
          (e) => e.target === consumerId && e.item === inp.item,
        );
        if (!already) addEdge(cid, consumerId, inp.item);
        if (wasNew) stack.push(cid);
        if (!multi) break;
      }
    }
  }

  return { nodes, outgoing, incoming };
}

export function buildRecipeGraph(
  targets: Target[],
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): RecipeGraph {
  return buildGraph(targets, pack, itemOverrides, false);
}

// LP variant: enumerates all non-excluded producers for each consumed item
// instead of picking one, so the LP can choose among them.
export function buildRecipeGraphMulti(
  targets: Target[],
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): RecipeGraph {
  return buildGraph(targets, pack, itemOverrides, true);
}

// Close graph membership over the LP support. The walk above only reaches
// recipes whose output some consumer demands, so a recipe the LP runs purely to
// absorb co-product overproduction (a disposal absorber) never becomes a node
// and the render omits a machine the plan requires. After the LP solves, add
// every positive-rate non-excluded recipe missing from the graph and wire
// producer edges to its inputs. Two-phase (nodes first, then edges) so a chain
// of off-graph recipes wires among its own members. Wiring is inputs-only: an
// absorber's output is by definition undemanded, so no edge ever leaves an
// augmented node toward a pre-existing one. Mutates g in place: the
// pipeline hands the same graph object to every downstream stage, and a
// copy-and-return variant that misses one consumer splits the pipeline across
// two graphs with no error. Returns the added recipe ids.
export function augmentGraphWithLpSupport(
  g: RecipeGraph,
  rates: Map<RecipeId, Fraction>,
  pack: RecipePack,
  targets: Target[],
  itemOverrides?: ItemOverride[],
): Set<RecipeId> {
  const targetIds = new Set(targets.map((t) => t.recipeId));
  const overrides = itemOverrides ?? [];
  const added = new Set<RecipeId>();

  for (const r of pack.recipes) {
    const rate = rates.get(r.id);
    if (!rate || rate.compare(0) <= 0) continue;
    if (g.nodes.has(r.id)) continue;
    // Excluded producers are sanctioned-absent by checkRepresentable; keep the
    // augmentation aligned with that contract.
    if (isExcludedProducer(r)) continue;
    g.nodes.set(r.id, r);
    g.outgoing.set(r.id, []);
    g.incoming.set(r.id, []);
    added.add(r.id);
  }

  for (const id of added) {
    const consumer = g.nodes.get(id)!;
    for (const inp of consumer.in) {
      // Same boundary rule as the walk: an unlimited-supply item is a raw
      // boundary feed, not an internal edge.
      if (effectiveSupply(inp.item, pack, overrides) === Infinity) continue;
      for (const [pid, producer] of g.nodes) {
        // Unlike the walk, skip self-edges: a recipe consuming its own output
        // nets the flow internally and a self-loop adds nothing downstream.
        if (pid === id) continue;
        if (!producer.out.some((o) => o.item === inp.item)) continue;
        // Same exclusion rule as the walk's edge attachment. An augmented node
        // is non-excluded by construction, so chains stay wireable.
        if (isExcludedProducer(producer) && !targetIds.has(pid)) continue;
        const already = (g.outgoing.get(pid) ?? []).some(
          (e) => e.target === id && e.item === inp.item,
        );
        if (already) continue;
        const edge: RecipeEdge = {
          id: `${pid}:${inp.item}->${id}`,
          source: pid,
          target: id,
          item: inp.item,
        };
        g.outgoing.get(pid)!.push(edge);
        g.incoming.get(id)!.push(edge);
      }
    }
  }

  return added;
}
