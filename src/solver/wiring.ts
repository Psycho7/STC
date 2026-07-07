// The replica-wiring rule: given the recipe graph and a replica set, produce
// the canonical list of producer-replica -> consumer-replica connections. This
// is the one place that knows how routing-relevant Replica internals compose:
//
//  - `outgoingEdgeFilter` ownership: a split SCC replica owns only the (item,
//    consumer-recipe) edges its filter lists, so it projects nothing else.
//  - `sharedAtArticulation`: a shared producer fans out to every consumer
//    replica of the edge's consumer recipe.
//  - `consumerPath` tail designation: a per-consumer producer feeds the one
//    consumer it was replicated for -- unless that consumer is a split SCC
//    stamp (discriminated by carrying an outgoingEdgeFilter, which only
//    looper/deliverer replicas do), in which case the producer feeds EVERY
//    live split sibling so the deliverer's demand does not fall entirely on
//    the intra-SCC producer.
//
// Two call modes share this walk:
//
//  - Pre-quotient (no options): the bare routing walk over the raw replicas,
//    used to derive the bisim signature edges. No torn-edge handling -- torn
//    edges are not even computed yet at that pipeline stage, and adding return
//    arcs to the signature input would shift equivalence classes.
//  - Post-quotient (`live` + `torn` + `condensation`): the full wiring of the
//    logical graph. Torn SCC edges are skipped in the main walk and emitted as
//    `returnArc` connections instead; a per-consumer producer whose designated
//    consumer stamp was dropped by the LP (the SCC looper/deliverer case) is
//    re-routed to every live stamp of its consumer recipe in a collision-safe
//    post-pass.
//
// Connections carry topology only (producer, consumer, item). Rates are
// deliberately not emitted here: the bisim derivation prices each connection
// at the consumer's full demand, while computeEdgeRates splits each consumer's
// demand across its inbound edges -- two different quantities that would be
// wrong to conflate on the connection.

import type {
  Condensation,
  ItemId,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  TornEdge,
} from "./types";
import { outgoingEdgeKey } from "./types";

export type WireConnection = {
  producerId: ReplicaId;
  consumerId: ReplicaId;
  item: ItemId;
  // "flow" is a normal routed edge (including re-routed ones); "returnArc" is
  // the back-edge of a torn SCC loop, which assembleLogicalGraph renders with
  // its distinct return-arc id shape.
  kind: "flow" | "returnArc";
};

export type WireOptions = {
  // Liveness predicate over replica ids. Connections only ever join two live
  // replicas; a dead designated consumer triggers the re-route pass instead.
  // Defaults to everything-live (the pre-quotient mode).
  live?: (id: ReplicaId) => boolean;
  // Torn SCC edges plus the condensation that locates them. Provided together
  // in the post-quotient mode: the condensation tells the main walk which
  // graph edges are torn (same non-trivial SCC), and each torn edge is then
  // emitted as a returnArc fan instead.
  torn?: ReadonlyArray<TornEdge>;
  condensation?: Condensation;
};

export function wireConnections(
  g: RecipeGraph,
  replicas: ReadonlyArray<Replica>,
  opts?: WireOptions,
): WireConnection[] {
  const live = opts?.live ?? (() => true);
  const torn = opts?.torn ?? [];
  const condensation = opts?.condensation;

  const byRecipe = new Map<RecipeId, Replica[]>();
  for (const r of replicas) {
    const arr = byRecipe.get(r.recipeId) ?? [];
    arr.push(r);
    byRecipe.set(r.recipeId, arr);
  }
  const liveOf = (rid: RecipeId): Replica[] =>
    (byRecipe.get(rid) ?? []).filter((r) => live(r.id));

  // Torn edges are keyed by (sccId, source, target, item) so the main walk can
  // skip exactly the edges the returnArc pass re-emits.
  const tornKey = (
    sccId: string,
    source: string,
    target: string,
    item: string,
  ): string => `${sccId}|${source}|${target}|${item}`;
  const tornSet = new Set<string>();
  for (const te of torn) {
    tornSet.add(
      tornKey(te.sccId, te.edge.source, te.edge.target, te.edge.item),
    );
  }

  // Whether two recipes share the same non-trivial SCC (needed to recognize a
  // torn edge in the main walk). Without a condensation nothing is torn.
  const isSameScc = (a: RecipeId, b: RecipeId): boolean => {
    if (condensation === undefined) return false;
    const sa = condensation.sccOfRecipe.get(a);
    const sb = condensation.sccOfRecipe.get(b);
    if (sa === undefined || sb === undefined || sa !== sb) return false;
    const scc = condensation.sccs.find((s) => s.id === sa);
    return !!scc && scc.recipeIds.length > 1;
  };

  const out: WireConnection[] = [];
  // Per-consumer producers whose designated consumer stamp exists but is not
  // live (the SCC looper/deliverer stamp the LP zeroed out). Resolved after
  // the torn arcs: each fans to every live stamp of its consumer recipe,
  // deduping only exact duplicate connections.
  const pending: Array<{
    producerId: ReplicaId;
    cRid: RecipeId;
    item: ItemId;
  }> = [];
  const flowKey = (p: ReplicaId, c: ReplicaId, item: ItemId): string =>
    `${p}\x1F${c}\x1F${item}`;
  const flowKeys = new Set<string>();
  const pushFlow = (p: ReplicaId, c: ReplicaId, item: ItemId): void => {
    out.push({ producerId: p, consumerId: c, item, kind: "flow" });
    flowKeys.add(flowKey(p, c, item));
  };

  for (const [pRid, outEdges] of g.outgoing) {
    for (const e of outEdges) {
      const cRid = e.target;
      const item = e.item;
      const consumers = byRecipe.get(cRid) ?? [];
      const liveProducers = liveOf(pRid);
      const liveConsumers = consumers.filter((r) => live(r.id));
      if (liveProducers.length === 0 || liveConsumers.length === 0) continue;

      // A torn SCC edge is emitted below as a return arc, so skip it here.
      if (
        isSameScc(pRid, cRid) &&
        tornSet.has(
          tornKey(condensation!.sccOfRecipe.get(pRid)!, pRid, cRid, item),
        )
      ) {
        continue;
      }

      for (const P of liveProducers) {
        // A split replica owns only the (item, target-recipe) edges its filter
        // lists; skip any edge it doesn't own.
        if (
          P.outgoingEdgeFilter !== undefined &&
          !P.outgoingEdgeFilter.has(outgoingEdgeKey(item, cRid))
        ) {
          continue;
        }
        if (P.sharedAtArticulation) {
          // A shared producer (AP or SCC member) feeds every live consumer
          // replica of this recipe.
          for (const C of liveConsumers) pushFlow(P.id, C.id, item);
        } else {
          // A per-consumer producer feeds the one consumer replica it was
          // created for, found via its consumerPath tail.
          const last = P.consumerPath[P.consumerPath.length - 1];
          const designated = last
            ? consumers.find((c) => c.id === last)
            : undefined;
          if (designated !== undefined && live(designated.id)) {
            if (designated.outgoingEdgeFilter !== undefined) {
              // The designated consumer is a SPLIT SCC stamp: a per-consumer
              // producer minted for the canonical looper must feed EVERY live
              // split sibling, not just the looper -- else the deliverer's
              // demand for this item falls entirely on the intra-SCC producer,
              // which over-ships while this producer's unshipped share
              // surfaces as a phantom surplus. The re-route pass covers the
              // designated consumer DROPPING; this covers the looper
              // surviving. computeEdgeRates splits each consumer's demand
              // across its inbound edges, so feeding both siblings never
              // over-feeds.
              for (const C of liveConsumers) {
                if (C.outgoingEdgeFilter !== undefined) {
                  pushFlow(P.id, C.id, item);
                }
              }
            } else {
              pushFlow(P.id, designated.id, item);
            }
          } else if (designated !== undefined) {
            // The designated consumer is a stamp of THIS consumer recipe that
            // is not live (the LP zeroed it out): the SCC looper/deliverer
            // case. Defer the re-route to the collision-safe post-pass.
            pending.push({ producerId: P.id, cRid, item });
          }
          // Otherwise the designated consumer belongs to a different recipe (a
          // secondary/byproduct edge); a sibling producer minted for THIS
          // recipe carries it, so dropping here avoids double-feeding.
        }
      }
    }
  }

  // Return arcs for each torn SCC edge. Both endpoints may have split into
  // several live stamps (a looper plus a deliverer), so the arc fans across
  // every live source stamp that owns the loop edge and every live consumer
  // stamp; computeEdgeRates scopes each arc to the consumer stamp's own
  // demand, split by producer output share, so no stamp over-ships. When only
  // one stamp exists on a side the fan collapses to it, keeping single-stamp
  // wiring bit-identical.
  for (const te of torn) {
    const srcReplicas = pickLoopEdgeOwners(
      liveOf(te.edge.source),
      te.edge.item,
      te.edge.target,
    );
    if (srcReplicas.length === 0) continue;
    for (const src of srcReplicas) {
      for (const tgt of liveOf(te.edge.target)) {
        out.push({
          producerId: src.id,
          consumerId: tgt.id,
          item: te.edge.item,
          kind: "returnArc",
        });
      }
    }
  }

  // Re-route pass: fan each deferred producer to EVERY live stamp of its
  // consumer recipe. Feeding a stamp that already has inbound connections for
  // the item is safe (computeEdgeRates redistributes shares); only exact
  // duplicate connections are skipped.
  for (const pr of pending) {
    for (const C of liveOf(pr.cRid)) {
      if (flowKeys.has(flowKey(pr.producerId, C.id, pr.item))) continue;
      pushFlow(pr.producerId, C.id, pr.item);
    }
  }

  return out;
}

/**
 * Every SCC-member stamp among `candidates` that owns the loop edge (item,
 * target), so the torn-arc fan can split a loop edge across all sibling
 * producers (the looper/deliverer split of a byproduct producer). When no
 * stamp carries an outgoingEdgeFilter owning the edge, falls back to a single
 * representative -- the first shared stamp, else the first candidate -- so the
 * un-split case stays bit-identical.
 */
function pickLoopEdgeOwners(
  candidates: ReadonlyArray<Replica>,
  edgeItem: ItemId,
  edgeTarget: RecipeId,
): Replica[] {
  if (candidates.length === 0) return [];
  const key = outgoingEdgeKey(edgeItem, edgeTarget);
  const owners = candidates.filter(
    (r) =>
      r.sharedAtArticulation &&
      r.outgoingEdgeFilter !== undefined &&
      r.outgoingEdgeFilter.has(key),
  );
  if (owners.length > 0) return owners;
  const shared = candidates.find((r) => r.sharedAtArticulation);
  const single = shared ?? candidates[0];
  return single ? [single] : [];
}
