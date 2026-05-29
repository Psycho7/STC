import Fraction from "fraction.js";
import type { ReplicaEdge } from "./types";
import type { RecipeGraph, Replica } from "../types";
import { outgoingEdgeKey } from "../types";

/**
 * Build the ReplicaEdge list from a RecipeGraph and its replicas, matching the
 * per-consumer routing that assembleLogicalGraph uses. A producer shared at an
 * articulation point fans out to every consumer-replica of the recipe; a
 * per-consumer producer routes only to the one consumer it was replicated for,
 * which is the last entry of its consumerPath.
 *
 * Each edge's rate is the consumer-side demand (consumer.executionRate * in.qty),
 * so the rates of all edges arriving at a consumer-replica add up to that
 * replica's actual input requirement.
 */
export function deriveReplicaEdges(
  g: RecipeGraph,
  replicas: ReadonlyArray<Replica>,
): ReplicaEdge[] {
  const replicasByRecipeId = new Map<string, Replica[]>();
  for (const r of replicas) {
    const arr = replicasByRecipeId.get(r.recipeId) ?? [];
    arr.push(r);
    replicasByRecipeId.set(r.recipeId, arr);
  }

  const edges: ReplicaEdge[] = [];
  for (const [pRid, outEdges] of g.outgoing) {
    const producers = replicasByRecipeId.get(pRid) ?? [];
    for (const e of outEdges) {
      const cRid = e.target;
      const item = e.item;
      const consumers = replicasByRecipeId.get(cRid) ?? [];
      if (producers.length === 0 || consumers.length === 0) continue;
      const inQty = inQtyForRecipe(g, cRid, item);
      if (inQty === undefined) continue;

      for (const P of producers) {
        // Respect a split replica's outgoing-edge ownership so the bisim
        // signatures can tell the two halves apart: one carries the intra-SCC
        // edge, the other the cross-boundary edge.
        if (
          P.outgoingEdgeFilter !== undefined &&
          !P.outgoingEdgeFilter.has(outgoingEdgeKey(item, cRid))
        ) {
          continue;
        }
        if (P.sharedAtArticulation) {
          for (const C of consumers) {
            edges.push({
              source: P.id,
              target: C.id,
              item,
              rate: C.executionRate.mul(new Fraction(inQty)),
            });
          }
        } else {
          const last = P.consumerPath[P.consumerPath.length - 1];
          if (!last) continue;
          const C = consumers.find((c) => c.id === last);
          if (!C) continue;
          edges.push({
            source: P.id,
            target: C.id,
            item,
            rate: C.executionRate.mul(new Fraction(inQty)),
          });
        }
      }
    }
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
