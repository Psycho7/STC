import Fraction from "fraction.js";
import type { ReplicaEdge } from "./types";
import type { RecipeGraph, Replica } from "../types";
import { wireConnections } from "../wiring";

/**
 * Build the ReplicaEdge list from a RecipeGraph and its replicas: the shared
 * replica-wiring rule (wiring.ts) run in its pre-quotient mode, priced for the
 * bisim signatures. Each edge's rate is the consumer-side demand
 * (consumer.executionRate * in.qty), so all edges arriving at a
 * consumer-replica sum to that replica's input requirement.
 */
export function deriveReplicaEdges(
  g: RecipeGraph,
  replicas: ReadonlyArray<Replica>,
): ReplicaEdge[] {
  const replicaById = new Map(replicas.map((r) => [r.id, r]));
  const edges: ReplicaEdge[] = [];
  for (const c of wireConnections(g, replicas)) {
    const consumer = replicaById.get(c.consumerId);
    if (consumer === undefined) continue;
    const inQty = inQtyForRecipe(g, consumer.recipeId, c.item);
    if (inQty === undefined) continue;
    edges.push({
      source: c.producerId,
      target: c.consumerId,
      item: c.item,
      rate: consumer.executionRate.mul(new Fraction(inQty)),
    });
  }
  return edges;
}

function inQtyForRecipe(
  g: RecipeGraph,
  recipeId: string,
  item: string,
): number | undefined {
  const recipe = g.nodes.get(recipeId);
  if (!recipe) return undefined;
  const stoich = recipe.in.find((s) => s.item === item);
  return stoich?.qty;
}
