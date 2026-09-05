import Fraction from "fraction.js";
import type { Recipe, RecipePack } from "@aef/schema";
import type { RecipeGraph, RecipeEdge, RecipeId } from "./types";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { effectiveSupply } from "./effectiveSupply";
import { isExcludedProducer } from "../data/recipe-category";
import { computeRecipeDepths } from "../data/recipe-depth";

// Index producers by output item and rank each item's candidate producers by
// (depth, id), so the walk attaches them in a stable, shallowest-first order.
function rankProducers(
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): {
  recipeById: Map<string, Recipe>;
  overrides: ItemOverride[];
  producersByItem: Map<string, string[]>;
} {
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  const overrides = itemOverrides ?? [];

  const producersByItem = new Map<string, string[]>();
  for (const r of pack.recipes) {
    for (const o of r.out) {
      if (!producersByItem.has(o.item)) producersByItem.set(o.item, []);
      producersByItem.get(o.item)!.push(r.id);
    }
  }

  // Raw-distance ranking: depthToRecipe[r] is one more than the deepest of r's
  // inputs, with planter outputs seeded at 0 so seed-loop members rank too.
  // Excluded recipes and cycles no planter breaks open stay at
  // POSITIVE_INFINITY.
  const depthToRecipe = computeRecipeDepths(pack);

  // Order each item's candidate producers by (depth, id) ascending so the
  // shallowest recipe comes first. Excluded recipes (no depthToRecipe entry)
  // and unrankable ones (POSITIVE_INFINITY) sink to the back, so the exclusion
  // filter drops the excluded ones and an unrankable recipe only wins when
  // nothing ranked exists.
  for (const arr of producersByItem.values()) {
    arr.sort((a, b) => {
      const da = depthToRecipe.get(a) ?? Number.POSITIVE_INFINITY;
      const db = depthToRecipe.get(b) ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  return { recipeById, overrides, producersByItem };
}

// Walk the target items' input cone, attaching every non-excluded producer of
// each consumed item so the LP can choose among them. Excluded recipes never
// enter the graph (plan validation rejects excluded-producer targets upstream).
// Dedup keeps one edge per (producer, item, consumer).
export function buildRecipeGraphMulti(
  targets: ReadonlyArray<ItemTarget>,
  pack: RecipePack,
  itemOverrides?: ItemOverride[],
): RecipeGraph {
  const { recipeById, overrides, producersByItem } = rankProducers(
    pack,
    itemOverrides,
  );

  const nodes = new Map<string, Recipe>();
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();

  function ensureNode(id: string): void {
    if (nodes.has(id)) return;
    // Every caller resolves the recipe before calling, so the lookup hits.
    nodes.set(id, recipeById.get(id)!);
    outgoing.set(id, []);
    incoming.set(id, []);
  }

  function addEdge(source: string, target: string, item: string): void {
    const id = `${source}:${item}->${target}`;
    const edge: RecipeEdge = { id, source, target, item };
    outgoing.get(source)!.push(edge);
    incoming.get(target)!.push(edge);
  }

  // Seed the walk from every non-excluded producer of each target item: the
  // LP chooses among them, so all of them (and their input cones) must be in
  // the graph. A target item that seeds nothing - unknown, or known with every
  // producer excluded, which on the shipped pack means an extractor-only raw
  // material - is not an error here: its demand is met by the item's boundary
  // supply, or surfaces as an LP deficit when a cap denies that supply.
  // validatePlan rejects unknown and non-producible target items, but only on
  // the app path; the solver CLI and the exam scenario runner reach this
  // builder with unvalidated targets, so do not treat validation as a
  // precondition.
  const stack: string[] = [];
  for (const t of targets) {
    for (const cid of producersByItem.get(t.itemId) ?? []) {
      const r = recipeById.get(cid);
      if (!r || isExcludedProducer(r)) continue;
      if (nodes.has(cid)) continue;
      ensureNode(cid);
      stack.push(cid);
    }
  }

  while (stack.length) {
    const consumerId = stack.pop()!;
    const consumer = nodes.get(consumerId)!;
    for (const inp of consumer.in) {
      // Stop expanding producers only when this item's boundary supply is
      // unlimited. A finite cap falls through so the producer stays in the graph
      // and any deficit can be accounted for.
      if (effectiveSupply(inp.item, pack, overrides) === Infinity) continue;
      // producersByItem is pre-sorted by (depth, id); every viable candidate
      // is attached so the LP picks the producer.
      const candidates = producersByItem.get(inp.item) ?? [];
      for (const cid of candidates) {
        const r = recipeById.get(cid);
        if (!r) continue;
        if (isExcludedProducer(r)) continue;
        const wasNew = !nodes.has(cid);
        ensureNode(cid);
        const already = (outgoing.get(cid) ?? []).some(
          (e) => e.target === consumerId && e.item === inp.item,
        );
        if (!already) addEdge(cid, consumerId, inp.item);
        if (wasNew) stack.push(cid);
      }
    }
  }

  return { nodes, outgoing, incoming };
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
  itemOverrides?: ItemOverride[],
): Set<RecipeId> {
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
        if (isExcludedProducer(producer)) continue;
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
