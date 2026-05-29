import Fraction from "fraction.js";
import type {
  ItemId,
  RecipeGraph,
  RecipeId,
  Scc,
  TornEdge,
  TornEdgeId,
} from "./types";
import { InconsistentSccError, SingularSccError } from "./types";

const ZERO = new Fraction(0);

/**
 * Solves one SCC's mass-balance linear system over exact rationals (Fraction).
 * The unknowns are the per-recipe execution rates inside the SCC plus one flow
 * value per torn edge. Anything named in `pinnedRates` drops out of the
 * unknowns and its fixed rate moves to the RHS.
 *
 * The mass balance for each (producer recipe in SCC, output item) is:
 *
 *   rate_p * p.out[i].qty
 *     = sum_{non-torn internal consumer c} rate_c * c.in[i].qty
 *     + sum_{torn edge from p with item i} tornFlow_edge
 *     + sum_{external consumer c} boundaryDemand[c] * c.in[i].qty
 *     - externalSupplyByItem[i]
 *
 * `externalSupplyByItem` is an optional per-output-item cap the caller derives
 * from boundary supply. We just subtract it from the per-item RHS sum and clamp
 * at zero, so any surplus supply above demand is dropped. The policy lives with
 * the caller; this function only applies the delta. Leave the parameter off and
 * the behavior is identical to before it existed.
 *
 * There is one equation per (producer p in scc, output item i of p). We solve
 * the system with Gaussian elimination and partial pivoting, throwing
 * SingularSccError when it is under-determined and InconsistentSccError when it
 * is inconsistent.
 */
export function solveSccFlow(
  scc: Scc,
  g: RecipeGraph,
  torn: TornEdge[],
  boundaryDemand: Map<RecipeId, Fraction>,
  pinnedRates?: Map<RecipeId, Fraction>,
  externalSupplyByItem?: Map<ItemId, Fraction>,
  // External delivery rate per (producer recipe, output item). It is added to
  // the per-item RHS after the externalSupplyByItem cap subtraction and
  // zero-clamp. The supply cap is external supply that covers internal demand,
  // so it subtracts from the RHS; a delivery is a user-declared external draw,
  // so it adds. They sit on opposite sides of the conservation equation and
  // must not collide through the clamp. Omit the parameter and the behavior
  // matches the original baseline exactly.
  externalDelivery?: Map<RecipeId, Map<ItemId, Fraction>>,
): { rates: Map<RecipeId, Fraction>; tornFlow: Map<TornEdgeId, Fraction> } {
  const members = new Set(scc.recipeIds);
  const pinned = pinnedRates ?? new Map<RecipeId, Fraction>();
  const unknownRecipeIds = scc.recipeIds.filter((r) => !pinned.has(r));

  // Column layout: 0..k-1 = unknown recipe rates, k..k+t-1 = torn flows.
  const rateCol = new Map<RecipeId, number>();
  unknownRecipeIds.forEach((r, idx) => rateCol.set(r, idx));
  const tornCol = new Map<TornEdgeId, number>();
  torn.forEach((te, idx) => tornCol.set(te.id, unknownRecipeIds.length + idx));
  const numCols = unknownRecipeIds.length + torn.length;

  // Index torn edges by their underlying graph edge id so the equations can
  // look them up. A torn edge has both its source and target inside the SCC.
  const tornByEdgeId = new Map<string, TornEdge>();
  for (const te of torn) tornByEdgeId.set(te.edge.id, te);

  // One equation per (producer p in scc, output item i of p).
  type Row = { coeffs: Fraction[]; rhs: Fraction };
  const rows: Row[] = [];

  for (const recipeId of scc.recipeIds) {
    const recipe = g.nodes.get(recipeId);
    if (!recipe) continue;
    const outgoingEdges = g.outgoing.get(recipeId) ?? [];
    const recipePin = pinned.get(recipeId);
    for (const outItem of recipe.out) {
      const coeffs = Array.from({ length: numCols }, () => new Fraction(0));
      let rhs = new Fraction(0);
      // Keep the external-consumer contribution in its own running total so the
      // optional externalSupplyByItem cap can subtract from it and clamp at zero
      // without touching the other RHS terms.
      let externalSum = new Fraction(0);
      // The producer's term goes on the LHS unless it is pinned. A pinned rate
      // is a known constant, so its rate_p * out.qty term crosses to the RHS
      // with its sign flipped.
      if (recipePin) {
        rhs = rhs.sub(recipePin.mul(new Fraction(outItem.qty)));
      } else {
        coeffs[rateCol.get(recipeId)!] = coeffs[rateCol.get(recipeId)!]!.add(
          new Fraction(outItem.qty),
        );
      }
      for (const edge of outgoingEdges) {
        if (edge.item !== outItem.item) continue;
        const consumerId = edge.target;
        const tornEdge = tornByEdgeId.get(edge.id);
        const consumerInternal = members.has(consumerId);
        if (consumerInternal && tornEdge) {
          // Torn internal edge: subtract its tornFlow term on the LHS.
          const col = tornCol.get(tornEdge.id)!;
          coeffs[col] = coeffs[col]!.sub(new Fraction(1));
        } else if (consumerInternal) {
          // Non-torn internal edge: subtract its rate_c * c.in[i].qty term on
          // the LHS, or move it to the RHS if that consumer is pinned.
          const consumer = g.nodes.get(consumerId);
          if (!consumer) continue;
          const inItem = consumer.in.find((x) => x.item === outItem.item);
          if (!inItem) continue;
          const consumerPin = pinned.get(consumerId);
          if (consumerPin) {
            rhs = rhs.add(consumerPin.mul(new Fraction(inItem.qty)));
          } else {
            const col = rateCol.get(consumerId)!;
            coeffs[col] = coeffs[col]!.sub(new Fraction(inItem.qty));
          }
        } else {
          // External consumer: contributes boundaryDemand[c] * c.in[i].qty.
          const consumer = g.nodes.get(consumerId);
          if (!consumer) continue;
          const inItem = consumer.in.find((x) => x.item === outItem.item);
          if (!inItem) continue;
          const consumerRate = boundaryDemand.get(consumerId) ?? ZERO;
          externalSum = externalSum.add(
            consumerRate.mul(new Fraction(inItem.qty)),
          );
        }
      }
      // Apply the caller's per-item cap to the external subtotal only, clamping
      // at zero. The caller should pass a cap no larger than externalSum, but
      // clamping defensively keeps the contract forgiving.
      const cap = externalSupplyByItem?.get(outItem.item);
      if (cap !== undefined) {
        externalSum = externalSum.sub(cap);
        if (externalSum.compare(0) < 0) externalSum = ZERO;
      }
      // Net external delivery, added after the cap subtraction and zero-clamp
      // so a user-declared delivery on this item is never wiped out by an
      // external-supply cap on the same item.
      const deliveryRate = externalDelivery?.get(recipeId)?.get(outItem.item);
      if (deliveryRate !== undefined) {
        externalSum = externalSum.add(deliveryRate);
      }
      rhs = rhs.add(externalSum);
      rows.push({ coeffs, rhs });
    }
  }

  // One consumer-side tear-balance row per torn edge. This relies on
  // pickProducer in graph.ts choosing a single producer per item, so the torn
  // edge carries the consumer's whole intake of te.edge.item;
  // scripts/audit-scc-multi-producer.ts keeps that invariant honest. The row is
  // what makes the SCC's mass-balance system determinate: without it a 2-cycle
  // with one tear has only 2 rows against 3 columns and trips the m < n guard.
  // Should a future pack ever produce multi-supplier-per-item SCCs without
  // tripping the MultiProducerSccCapError in walk.ts, this formulation extends
  // naturally to a sum over the incoming torn flows.
  for (const te of torn) {
    const consumer = g.nodes.get(te.edge.target);
    if (!consumer) continue;
    const inItem = consumer.in.find((x) => x.item === te.edge.item);
    if (!inItem) continue;
    const coeffs = Array.from({ length: numCols }, () => new Fraction(0));
    let rhs = new Fraction(0);
    coeffs[tornCol.get(te.id)!] = new Fraction(1);
    const consumerPin = pinned.get(consumer.id);
    if (consumerPin) {
      rhs = consumerPin.mul(new Fraction(inItem.qty));
    } else {
      const col = rateCol.get(consumer.id)!;
      coeffs[col] = coeffs[col]!.sub(new Fraction(inItem.qty));
    }
    rows.push({ coeffs, rhs });
  }

  // Gaussian elimination with partial pivoting over Fraction: build the
  // augmented matrix and reduce it.
  const m = rows.length;
  const n = numCols;
  if (m < n) throw new SingularSccError(scc.id);

  // Copy the rows so elimination doesn't mutate the ones we built.
  const aug: Fraction[][] = rows.map((r) => [...r.coeffs, r.rhs]);

  let pivotRow = 0;
  for (let col = 0; col < n; col++) {
    // Partial pivot: find the row at index >= pivotRow with the largest |aug[r][col]|.
    let best = pivotRow;
    let bestAbs = aug[best]![col]!.abs();
    for (let r = pivotRow + 1; r < m; r++) {
      const cand = aug[r]![col]!.abs();
      if (cand.compare(bestAbs) > 0) {
        best = r;
        bestAbs = cand;
      }
    }
    if (bestAbs.equals(0)) {
      // No pivot in this column. Before calling the system under-determined,
      // look for an unpivoted row that has reduced to [0..0 | non-zero]: that is
      // a mass-conservation contradiction (say, a closed unit-qty SCC with
      // downstream demand), not singularity. The post-elimination check below
      // tests the same thing, but it can't run once we throw here, so we repeat
      // it to keep the Singular-vs-Inconsistent distinction inside the loop.
      for (let r = pivotRow; r < m; r++) {
        let allZero = true;
        for (let c = 0; c < n; c++) {
          if (!aug[r]![c]!.equals(0)) {
            allZero = false;
            break;
          }
        }
        if (allZero && !aug[r]![n]!.equals(0)) {
          throw new InconsistentSccError(scc.id);
        }
      }
      throw new SingularSccError(scc.id);
    }
    if (best !== pivotRow) {
      const tmp = aug[pivotRow]!;
      aug[pivotRow] = aug[best]!;
      aug[best] = tmp;
    }
    // Normalize pivot row.
    const pivot = aug[pivotRow]![col]!;
    for (let c = col; c <= n; c++) {
      aug[pivotRow]![c] = aug[pivotRow]![c]!.div(pivot);
    }
    // Eliminate column in all other rows.
    for (let r = 0; r < m; r++) {
      if (r === pivotRow) continue;
      const factor = aug[r]![col]!;
      if (factor.equals(0)) continue;
      for (let c = col; c <= n; c++) {
        aug[r]![c] = aug[r]![c]!.sub(factor.mul(aug[pivotRow]![c]!));
      }
    }
    pivotRow++;
  }

  // Any remaining rows must have zero coefficients AND zero RHS (consistent).
  for (let r = pivotRow; r < m; r++) {
    let allZero = true;
    for (let c = 0; c < n; c++) {
      if (!aug[r]![c]!.equals(0)) {
        allZero = false;
        break;
      }
    }
    if (allZero && !aug[r]![n]!.equals(0)) {
      throw new InconsistentSccError(scc.id);
    }
  }

  // Read out the solution. After full reduction the unknown for column `col`
  // sits in the row whose pivot is 1 at that column, and since we placed the
  // pivots in order, aug[col] holds unknown col's value when m >= n and the
  // matrix is full rank. Pinned members keep their input rate as-is.
  const rates = new Map<RecipeId, Fraction>();
  const tornFlow = new Map<TornEdgeId, Fraction>();
  unknownRecipeIds.forEach((rid, idx) => {
    rates.set(rid, aug[idx]![n]!);
  });
  for (const [rid, pinRate] of pinned) {
    if (members.has(rid)) rates.set(rid, pinRate);
  }
  torn.forEach((te, idx) => {
    tornFlow.set(te.id, aug[unknownRecipeIds.length + idx]![n]!);
  });
  return { rates, tornFlow };
}

export type SolveSccFlowResult = ReturnType<typeof solveSccFlow>;
