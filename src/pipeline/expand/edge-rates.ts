// Edge-rate allocation: prices every logical edge with the demand rate the
// expansion stage distributes across machine stamps. computeEdgeRates owns the
// per-consumer demand split (production-share and recorded-supply-share
// weighting, boundary netting) and capProducerInputOutflow is its exact-
// rational capacity backstop.

import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { LogicalGraph } from "../../canvas/layout";
import {
  logicalNodeIdForReplica,
  supplyShareKey,
} from "../../solver/replicate";
import type { ItemId, RecipeId, Replica } from "../../solver/types";

/**
 * Works out the demand rate on each edge.
 *
 * Input-side edges (consumer recipe lists X as an input): a consumer STAMP C
 * demands `C.executionRate * inQty(X)`. When several producer edges feed the
 * same (stamp, item) group, the demand splits across them by a per-edge weight.
 * The default weight is the source replica's output of X
 * (`srcStamp.executionRate * outQty(X)`, "production share"). A single inbound
 * edge gets share/sum = 1 and carries the full stamp demand, keeping
 * single-producer wiring bit-identical. The split makes inbound rates sum to
 * exactly the stamp demand and never overfeed. Degenerate groups with no
 * positive producer share fall back to an even demand/k split.
 *
 * SHARED producers (SCC members, AP-shared, byproduct-shared, seeded targets)
 * emit once at full LP rate, so their production-share over-counts a producer
 * that serves several consumers: each group would bill it its whole output.
 * `supplyShares` carries replicate's recorded committed flow from that producer
 * RECIPE to this consumer RECIPE; the per-edge weight becomes that recorded
 * flow, scaled into this stamp's units and apportioned within the recipe's
 * stamps present in the group. The recorded flow is constant across a consumer
 * recipe's stamps (replicate splits by global LP rates), so
 * `recordedStampFlow = flow * consumerStamp.executionRate /
 * rates(consumerRecipe)`. When the SAME producer recipe has several stamps
 * (looper + deliverer) in one group, that recorded flow is split among them by
 * their production shares (`recipeShareSum` = sum of those stamps' output of X
 * in the group), so a split producer keeps its production-ratio split and a
 * single-stamp recipe reduces exactly to the recorded flow. Producers with no
 * recorded share keep the production-share weight.
 *
 * Output-side edges (consumer lists X only as an output) keep producer-side
 * billing: `producerRate * outQty(X)`.
 *
 * Return-arc torn edges (id contains "->return->") use the same rules; the SCC
 * member executionRate the flow solve assigned already matches the torn-flow
 * rate once the loop converges.
 */
export function computeEdgeRates(args: {
  logical: LogicalGraph;
  replicas: ReadonlyArray<Replica>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  rates: ReadonlyMap<RecipeId, Fraction>;
  supplyShares: ReadonlyMap<string, Fraction>;
  boundaryShare: ReadonlyMap<ItemId, Fraction>;
}): Map<string, Fraction> {
  const { logical, replicas, recipeById, rates, supplyShares, boundaryShare } =
    args;
  const replicaByLogicalId = new Map<string, Replica>();
  for (const r of replicas)
    replicaByLogicalId.set(logicalNodeIdForReplica(r.id), r);

  const result = new Map<string, Fraction>();
  const ZERO = new Fraction(0);

  const itemFor = (port: string): string =>
    port.startsWith("in:") ? port.slice("in:".length) : port;

  // Pre-pass: group INPUT edges (consumer treats the item as a recipe input) by
  // (consumer replica logical-node id, item). Each consumer STAMP's demand for
  // an item splits across its inbound edges in proportion to each source
  // replica's output of that item. A single inbound edge collapses to
  // share/sum = 1, leaving single-producer wiring bit-identical; several edges
  // apportion the stamp demand so inbound rates sum to exactly the demand and
  // never overfeed. Output-side edges (consumer carries the item only as an
  // output) keep producer-side billing in the loop below.
  const inputEdgesByGroup = new Map<
    string,
    { edges: typeof logical.edges; inQty: number }
  >();
  const groupKey = (target: string, item: string): string => `${target}\0${item}`;
  for (const e of logical.edges) {
    const item = itemFor(e.targetPort);
    const consumer = replicaByLogicalId.get(e.target);
    if (!consumer) continue;
    const recipe = recipeById.get(consumer.recipeId);
    if (!recipe) continue;
    const inStoich = recipe.in.find((s) => s.item === item);
    if (!inStoich) continue;
    const key = groupKey(e.target, item);
    const existing = inputEdgesByGroup.get(key);
    if (existing) existing.edges.push(e);
    else inputEdgesByGroup.set(key, { edges: [e], inQty: inStoich.qty });
  }

  // A producer stamp's production of an item: rate * out qty. The billing
  // capacity AND the default demand-split weight for a producer with no
  // recorded supply share.
  const outputShare = (producer: Replica | undefined, item: string): Fraction => {
    if (!producer) return ZERO;
    const prodRecipe = recipeById.get(producer.recipeId);
    const outStoich = prodRecipe?.out.find((s) => s.item === item);
    if (!outStoich) return ZERO;
    return producer.executionRate.mul(new Fraction(outStoich.qty));
  };
  // Input edges of one item feeding one consumer stamp; collected so the
  // capacity cap below can see every edge and its producer's output of the item.
  const capInputs: CapEdge[] = [];
  for (const [key, group] of inputEdgesByGroup) {
    const sep = key.indexOf("\0");
    const targetLogicalId = key.slice(0, sep);
    const item = key.slice(sep + 1);
    const consumer = replicaByLogicalId.get(targetLogicalId)!;
    // In-graph producer edges carry only the residual share of the stamp's
    // demand; the boundary-served fraction (1 - share) arrives via the
    // boundary input product. Missing entries default to share 1.
    const demand = consumer.executionRate
      .mul(new Fraction(group.inQty))
      .mul(boundaryShare.get(item) ?? CAP_ONE);
    const consumerRate = rates.get(consumer.recipeId);

    // Production share per edge (the capacity and the no-record weight).
    const producers = group.edges.map((e) => replicaByLogicalId.get(e.source));
    const shares = producers.map((p) => outputShare(p, item));

    // For a producer RECIPE with a recorded committed flow to this consumer
    // recipe, the recorded flow is apportioned within that recipe's stamps in
    // this group by their production shares. Precompute, per producer recipe
    // id, the sum of those stamps' production share and the stamp count, so a
    // split producer (looper + deliverer both present) keeps its production
    // ratio instead of an even 50/50 split.
    const recipeShareSum = new Map<RecipeId, Fraction>();
    const recipeEdgeCount = new Map<RecipeId, number>();
    for (let i = 0; i < producers.length; i++) {
      const p = producers[i];
      if (!p) continue;
      recipeShareSum.set(
        p.recipeId,
        (recipeShareSum.get(p.recipeId) ?? ZERO).add(shares[i]!),
      );
      recipeEdgeCount.set(p.recipeId, (recipeEdgeCount.get(p.recipeId) ?? 0) + 1);
    }

    const weights = group.edges.map((_e, i) => {
      const p = producers[i];
      // Unresolvable producer stamp: defer to the production-share fallback
      // (ZERO here), mirroring outputShare's undefined guard.
      if (!p) return ZERO;
      const flow =
        consumerRate !== undefined && consumerRate.compare(ZERO) > 0
          ? supplyShares.get(supplyShareKey(p.recipeId, consumer.recipeId, item))
          : undefined;
      // No recorded share (per-consumer producer, or zero consumer rate): the
      // production share already equals committed supply.
      if (flow === undefined) return shares[i]!;
      // Recorded recipe-level flow scaled into this stamp's units.
      const recordedStampFlow = flow.mul(consumer.executionRate).div(consumerRate!);
      const rShareSum = recipeShareSum.get(p.recipeId) ?? ZERO;
      if (rShareSum.compare(ZERO) > 0) {
        return recordedStampFlow.mul(shares[i]!).div(rShareSum);
      }
      // All sibling stamps of this recipe have zero production share: split the
      // recorded flow evenly among them.
      const count = recipeEdgeCount.get(p.recipeId) ?? 1;
      return recordedStampFlow.div(new Fraction(count));
    });

    const weightSum = weights.reduce((acc, w) => acc.add(w), ZERO);
    const k = group.edges.length;
    for (let i = 0; i < group.edges.length; i++) {
      const e = group.edges[i]!;
      const rate =
        weightSum.compare(ZERO) > 0
          ? demand.mul(weights[i]!).div(weightSum)
          : demand.div(new Fraction(k));
      result.set(e.id, rate);
      capInputs.push({
        edgeId: e.id,
        producerId: e.source,
        groupKey: `${targetLogicalId}\0${item}`,
        item,
        rate,
        capacity: shares[i]!,
      });
    }
  }

  // Capacity guard: no producer's total billed input-edge outflow of an item may
  // exceed its production. The share split above already balances this whenever
  // every sibling producer carries its share, so this is a no-op on well-wired
  // plans (clean edge rates stay bit-identical). It is the durable backstop for
  // the bug class where a dropped sibling edge leaves one producer over-billed:
  // cap the saturated producer and refill the freed consumer demand from sibling
  // inbound edges with spare capacity.
  capProducerInputOutflow(capInputs, result);

  // Remaining edges, two buckets:
  //   - consumer/recipe unresolvable, OR the consumer lists the item as an
  //     OUTPUT (not an input). The output-side case bills the producer.
  //   - everything else stays ZERO.
  for (const e of logical.edges) {
    if (result.has(e.id)) continue;
    const item = itemFor(e.targetPort);
    let rate = ZERO;
    const consumer = replicaByLogicalId.get(e.target);
    const consumerRecipe = consumer
      ? recipeById.get(consumer.recipeId)
      : undefined;
    if (consumer && consumerRecipe) {
      // Output-side billing: producer delivers its own output of the item.
      const producer = replicaByLogicalId.get(e.source);
      if (producer) {
        const prodRecipe = recipeById.get(producer.recipeId);
        const outStoich = prodRecipe?.out.find((s) => s.item === item);
        if (outStoich) {
          const producerRate = producer.outgoingEdgeFilter
            ? producer.executionRate
            : (rates.get(producer.recipeId) ?? producer.executionRate ?? ZERO);
          rate = producerRate.mul(new Fraction(outStoich.qty));
        }
      }
    }
    result.set(e.id, rate);
  }
  return result;
}

/**
 * One input edge as the capacity guard sees it: which producer stamp ships the
 * item, which consumer group it feeds, its current billed rate, and the
 * producer's total production of the item (its billing capacity).
 */
export type CapEdge = {
  edgeId: string;
  producerId: string;
  /** `${consumerLogicalId}\0${item}` - the demand group the edge belongs to. */
  groupKey: string;
  item: string;
  rate: Fraction;
  capacity: Fraction;
};

// Capacity tolerance for the transport-cap pass, deliberately its own constant
// rather than the shared plan-rate REL_TOL in solver/lp (which that file and
// solver/optimality both mark as not-for-this-path).
//
// It is not independent of REL_TOL, though. The cap decides how much billed
// outflow it is willing to leave standing; the render invariant checkers then
// judge that same outflow at REL_TOL. So the rule is directional:
//   - CAP_REL_TOL <= REL_TOL, and
//   - the magnitude floor this tolerance is taken against must not exceed the
//     floor the checkers use.
// A looser cap tolerance (or a higher floor) admits a residual the checkers go
// on to report; a tighter one only makes the cap work harder, which is safe.
//
// Both constants are 1e-6 today, so the first clause holds. The second does
// not hold everywhere: this cap floors at an absolute 1 (CAP_ONE below) while
// the checkers floor at toleranceScaleFloor, which drops below 1 on a sub-unit
// plan, so the cap is the looser of the two down there. Aligning the floor
// changes which residuals survive the cap - a behaviour change that needs its
// own test, not a constant edit.
const CAP_REL_TOL = 1e-6;
// Hoisted constants: building a Fraction from the float tolerance is costly, and
// the cap runs (and scans every producer) on every plan, so construct these once.
const CAP_REL_TOL_FRAC = new Fraction(CAP_REL_TOL);
const CAP_ONE = new Fraction(1);

/**
 * Caps each producer's total billed outflow of an item at its production and
 * refills the freed consumer demand from sibling inbound edges with spare
 * capacity. Mutates `result` in place, keyed by edgeId.
 *
 * Exact-rational. When no producer is over-billed (every sibling carries its
 * share, the normal case after the assemble torn-arc fan) this is a no-op and
 * the edge rates passed in are untouched, so clean plans stay bit-identical.
 *
 * Each iteration scales the most-oversubscribed producer down to exactly its
 * capacity, marks it saturated (it never receives more), and refills the
 * resulting per-group deficits across that group's other non-saturated edges in
 * proportion to their producers' remaining spare. Saturating one producer per
 * iteration bounds the loop by the producer count. A consumer group whose total
 * sibling spare cannot cover its deficit beyond tolerance signals a dropped
 * supplier upstream: fail loud in dev, leave the uncapped rates in prod so the
 * plan still renders.
 */
export function capProducerInputOutflow(
  edges: ReadonlyArray<CapEdge>,
  result: Map<string, Fraction>,
): void {
  const ZERO = new Fraction(0);
  if (edges.length === 0) return;

  // Working rate per edge (seeded from result, which holds the share split).
  const rate = new Map<string, Fraction>();
  for (const e of edges) rate.set(e.edgeId, result.get(e.edgeId) ?? e.rate);

  // Capacity is per (producer stamp, item): one stamp can output several items
  // and the cap applies to each item's production separately, so key every
  // per-producer map by `${producerId}\0${item}` rather than the stamp alone.
  // Keying by the stamp alone would sum a stamp's outflow of distinct items
  // against one item's capacity and mis-fire on a correctly wired plan.
  const prodKeyOf = (e: CapEdge): string => `${e.producerId}\0${e.item}`;
  const capacityOf = new Map<string, Fraction>();
  const edgesOfProducer = new Map<string, CapEdge[]>();
  const edgesOfGroup = new Map<string, CapEdge[]>();
  // Billed outflow per (producer, item), maintained incrementally so the worst-
  // producer search and the spare lookups stay O(1) instead of re-summing each
  // producer's edges every pass (the cap runs on every plan, the no-op case
  // included, so the hot path must not be quadratic).
  const billed = new Map<string, Fraction>();
  const edgeKeyOf = new Map<string, string>();
  for (const e of edges) {
    const pk = prodKeyOf(e);
    edgeKeyOf.set(e.edgeId, pk);
    capacityOf.set(pk, e.capacity);
    (edgesOfProducer.get(pk) ?? setDefault(edgesOfProducer, pk)).push(e);
    (edgesOfGroup.get(e.groupKey) ?? setDefault(edgesOfGroup, e.groupKey)).push(e);
    billed.set(pk, (billed.get(pk) ?? ZERO).add(rate.get(e.edgeId) ?? ZERO));
  }

  // Set an edge's working rate and keep its producer's billed total in step.
  const setRate = (edgeId: string, next: Fraction): void => {
    const pk = edgeKeyOf.get(edgeId);
    if (pk !== undefined) {
      const old = rate.get(edgeId) ?? ZERO;
      billed.set(pk, (billed.get(pk) ?? ZERO).sub(old).add(next));
    }
    rate.set(edgeId, next);
  };
  const billedOf = (prodKey: string): Fraction => billed.get(prodKey) ?? ZERO;
  const spareOf = (prodKey: string): Fraction => {
    const cap = capacityOf.get(prodKey) ?? ZERO;
    const spare = cap.sub(billedOf(prodKey));
    return spare.compare(ZERO) > 0 ? spare : ZERO;
  };

  // Relative tolerance against a magnitude (cap or freed demand).
  const tolFor = (magnitude: Fraction): Fraction =>
    CAP_REL_TOL_FRAC.mul(maxFrac(magnitude, CAP_ONE));

  // Fast no-op exit: when no (producer, item) is billed past capacity (the
  // normal case after the assemble torn-arc fan) there is nothing to cap.
  let anyOver = false;
  for (const [pk, cap] of capacityOf) {
    if (billedOf(pk).sub(cap).compare(tolFor(cap)) > 0) {
      anyOver = true;
      break;
    }
  }
  if (!anyOver) return;

  const saturated = new Set<string>();
  // Bounded by the (producer, item) count: each pass saturates at least one.
  for (let guard = 0; guard <= capacityOf.size; guard++) {
    // Most-oversubscribed (producer, item) (largest billed - capacity) past tol.
    let worst: string | undefined;
    let worstExcess = ZERO;
    for (const [pk, cap] of capacityOf) {
      if (saturated.has(pk)) continue;
      const excess = billedOf(pk).sub(cap);
      if (excess.compare(tolFor(cap)) > 0 && excess.compare(worstExcess) > 0) {
        worst = pk;
        worstExcess = excess;
      }
    }
    if (worst === undefined) break;

    const cap = capacityOf.get(worst) ?? ZERO;
    const billedWorst = billedOf(worst);
    // Scale this producer's edges down to exactly its capacity; collect the
    // freed demand per consumer group.
    const freedByGroup = new Map<string, Fraction>();
    for (const e of edgesOfProducer.get(worst) ?? []) {
      const old = rate.get(e.edgeId) ?? ZERO;
      const scaled = billedWorst.compare(ZERO) > 0 ? old.mul(cap).div(billedWorst) : ZERO;
      const freed = old.sub(scaled);
      setRate(e.edgeId, scaled);
      if (freed.compare(ZERO) > 0) {
        freedByGroup.set(e.groupKey, (freedByGroup.get(e.groupKey) ?? ZERO).add(freed));
      }
    }
    saturated.add(worst);

    // Refill each group's freed demand across its other non-saturated edges, in
    // proportion to their producers' remaining spare.
    for (const [groupKey, freed] of freedByGroup) {
      const siblings = (edgesOfGroup.get(groupKey) ?? []).filter(
        (e) => !saturated.has(prodKeyOf(e)),
      );
      const spares = siblings.map((e) => spareOf(prodKeyOf(e)));
      const spareSum = spares.reduce((acc, s) => acc.add(s), ZERO);
      if (spareSum.compare(ZERO) <= 0) {
        // No sibling can absorb the freed demand: a supplier was dropped.
        if (freed.compare(tolFor(freed)) > 0) {
          if (import.meta.env.DEV) {
            const sep = groupKey.indexOf("\0");
            const consumer = groupKey.slice(0, sep);
            const item = groupKey.slice(sep + 1);
            throw new Error(
              `capProducerInputOutflow: consumer "${consumer}" item "${item}" has ` +
                `insufficient inbound capacity; ${freed.toFraction()} of demand cannot ` +
                `be served after capping producers (dropped supplier upstream)`,
            );
          }
          // Prod: leave the uncapped rates so the plan still renders.
          return;
        }
        continue;
      }
      for (let i = 0; i < siblings.length; i++) {
        const e = siblings[i]!;
        const add = freed.mul(spares[i]!).div(spareSum);
        setRate(e.edgeId, (rate.get(e.edgeId) ?? ZERO).add(add));
      }
    }
  }

  for (const e of edges) result.set(e.edgeId, rate.get(e.edgeId) ?? ZERO);
}

function setDefault<K, V>(map: Map<K, V[]>, key: K): V[] {
  const arr: V[] = [];
  map.set(key, arr);
  return arr;
}

function maxFrac(a: Fraction, b: Fraction): Fraction {
  return a.compare(b) >= 0 ? a : b;
}
