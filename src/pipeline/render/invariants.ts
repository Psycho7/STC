import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemTarget } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";
import type { InvariantResult } from "../../solver/invariants";
import { effectiveSupply } from "../../solver/effectiveSupply";
import { netSelfConsumption } from "../../solver/net-self";
import { demandByItem, toleranceScaleFloor } from "../../solver/lp";
import type {
  RenderPlan,
  RenderUnitId,
  RenderUnit,
  ItemId,
  RecipeId,
} from "../types";
import {
  isInputProductUnit,
  isOutputProductUnit,
  isRecipeUnit,
  isLoopUnit,
} from "../types";

import { rationalFromString } from "./rational";

export type { InvariantResult };

// Relative tolerance, same value the solver invariants use. Exported so
// boundary-products suppresses phantom surpluses at the exact threshold
// checkBoundaryProductsJustified tags at.
export const REL_TOL = 1e-6;

// Plan-magnitude floor for tolerance scales, shared with the solver checkers
// and the extraction hygiene gate. Sub-unit plans shrink the floor to their
// own magnitude; an absolute floor of 1 would exceed everything a tiny plan
// produces and misfire predicates that require a magnitude above slack.
function planScaleFloor(targets: ReadonlyArray<ItemTarget>): number {
  return toleranceScaleFloor(demandByItem(targets));
}

// Shared args object so all checkers have one signature and can be called from
// a list. Targets are item-keyed; every checker keys on itemId.
export type RenderInvariantArgs = {
  plan: RenderPlan;
  rates: ReadonlyMap<RecipeId, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<ItemTarget>;
  itemOverrides: ReadonlyArray<ItemOverride>;
};

// ---------------------------------------------------------------------------
// Foundation helpers
// ---------------------------------------------------------------------------

const FRAC_ZERO = new Fraction(0);

// Checkers must read the same netted stoichiometry the solve pipeline ran on
// (see netSelfConsumption): against the raw pack, a self-consuming recipe
// would flag phantom shortfalls on the folded-away self flow. Memoized per
// pack object so the nine checkers of one assert call net only once.
const nettedPackCache = new WeakMap<RecipePack, RecipePack>();
function nettedPack(pack: RecipePack): RecipePack {
  let netted = nettedPackCache.get(pack);
  if (netted === undefined) {
    netted = netSelfConsumption(pack);
    nettedPackCache.set(pack, netted);
  }
  return netted;
}

// Lookup map from unit id to unit.
export function unitById(plan: RenderPlan): Map<RenderUnitId, RenderUnit> {
  const m = new Map<RenderUnitId, RenderUnit>();
  for (const u of plan.units) {
    m.set(u.id, u);
  }
  return m;
}

// Sum of out.qty * rate over recipes. With restrict, only recipes in the set count.
function productionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
  restrict?: ReadonlySet<RecipeId>,
): Map<ItemId, Fraction> {
  const result = new Map<ItemId, Fraction>();
  for (const r of nettedPack(pack).recipes) {
    if (restrict !== undefined && !restrict.has(r.id)) continue;
    const rate = rates.get(r.id);
    if (!rate) continue;
    for (const o of r.out) {
      result.set(o.item, (result.get(o.item) ?? FRAC_ZERO).add(new Fraction(o.qty).mul(rate)));
    }
  }
  return result;
}

// Sum of in.qty * rate over recipes. With restrict, only recipes in the set count.
function consumptionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
  restrict?: ReadonlySet<RecipeId>,
): Map<ItemId, Fraction> {
  const result = new Map<ItemId, Fraction>();
  for (const r of nettedPack(pack).recipes) {
    if (restrict !== undefined && !restrict.has(r.id)) continue;
    const rate = rates.get(r.id);
    if (!rate) continue;
    for (const inp of r.in) {
      result.set(inp.item, (result.get(inp.item) ?? FRAC_ZERO).add(new Fraction(inp.qty).mul(rate)));
    }
  }
  return result;
}

// Per item: sum of out.qty * rate over all recipes (exact Fraction math).
export function internalProductionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
): Map<ItemId, Fraction> {
  return productionByItem(rates, pack);
}

// Per item: sum of in.qty * rate over all recipes (exact Fraction math).
export function internalConsumptionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
): Map<ItemId, Fraction> {
  return consumptionByItem(rates, pack);
}

// Per item: production minus consumption.
export function internalNetByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
): Map<ItemId, Fraction> {
  const production = internalProductionByItem(rates, pack);
  const consumption = internalConsumptionByItem(rates, pack);
  const itemIds = new Set<ItemId>([
    ...production.keys(),
    ...consumption.keys(),
  ]);
  const result = new Map<ItemId, Fraction>();
  for (const id of itemIds) {
    const prod = production.get(id) ?? new Fraction(0);
    const cons = consumption.get(id) ?? new Fraction(0);
    result.set(id, prod.sub(cons));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

/**
 * Every edge must reference valid unit ids, carry a positive rate, and label a
 * known item. Catches dropped units and mislabeled ids.
 */
export function checkEdgeEndpointIntegrity(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, pack } = args;
  const violations: string[] = [];
  const units = unitById(plan);
  const knownItems = new Set(pack.items.map((i) => i.id));

  for (const edge of plan.edges) {
    if (!units.has(edge.fromUnit)) {
      violations.push(
        `edge from "${edge.fromUnit}" to "${edge.toUnit}": fromUnit "${edge.fromUnit}" not found in plan.units`,
      );
    }
    if (!units.has(edge.toUnit)) {
      violations.push(
        `edge from "${edge.fromUnit}" to "${edge.toUnit}": toUnit "${edge.toUnit}" not found in plan.units`,
      );
    }
    if (edge.rate.compare(FRAC_ZERO) <= 0) {
      violations.push(
        `edge from "${edge.fromUnit}" to "${edge.toUnit}": rate ${edge.rate.toString()} is not positive`,
      );
    }
    if (!knownItems.has(edge.item)) {
      violations.push(
        `edge from "${edge.fromUnit}" to "${edge.toUnit}": item "${edge.item}" not found in pack.items`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Every inputProduct and outputProduct unit must match a real boundary
 * condition in the solve.
 *
 * - inputProduct for X: justified iff effectiveSupply(X) is Infinity or finite
 *   positive AND the plan draws X from outside, i.e. consumption(X) >
 *   production(X) - declaredTargetDemand(X) beyond tolerance. Production
 *   claimed by a declared target draw never feeds internal consumers, so it is
 *   subtracted before the comparison. Or, for a free-supply target item, by
 *   its export shortfall: the declared rate beyond what net production covers
 *   arrives as a boundary passthrough into the target output.
 *
 * - outputProduct "target" for X: justified iff X is a declared target item
 *   (X is a demandByItem key).
 *
 * - outputProduct "surplus" for X: justified iff genuine overproduction beyond
 *   demand: production(X) - consumption(X) - demand(X) exceeds tolerance.
 *
 * Slack = max(scaleFloor, |magnitude|) * REL_TOL with the shared plan-magnitude
 * floor. The catch this checker exists for: an internally balanced
 * intermediate (production ~= consumption, residual within tolerance) that is
 * not a target showing up as a phantom surplus output.
 */
export function checkBoundaryProductsJustified(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets, itemOverrides } = args;
  const violations: string[] = [];

  const production = internalProductionByItem(rates, pack);
  const consumption = internalConsumptionByItem(rates, pack);
  const demandOf = demandByItem(targets);
  const scaleFloor = planScaleFloor(targets);

  for (const unit of plan.units) {
    if (isInputProductUnit(unit)) {
      const x = unit.itemId;
      const supply = effectiveSupply(x, pack, itemOverrides as ItemOverride[]);
      // Justified only with real external supply and net consumption (consumption
      // exceeds internal production).
      const hasExternalSupply =
        supply === Infinity ||
        (supply instanceof Fraction && supply.compare(FRAC_ZERO) > 0);
      if (!hasExternalSupply) {
        violations.push(
          `inputProduct for "${x}": no external supply (effectiveSupply is zero or finite-zero)`,
        );
        continue;
      }
      // The plan must draw X from outside: consumption > production left
      // after the declared target draw. Target-claimed production never feeds
      // internal consumers, so a raw-also-target item with cons < prod can
      // still be a justified boundary input.
      const prod = production.get(x) ?? FRAC_ZERO;
      const cons = consumption.get(x) ?? FRAC_ZERO;
      const targetDemand = new Fraction(demandOf.get(x) ?? 0);
      const availRaw = prod.sub(targetDemand);
      const availProd = availRaw.compare(FRAC_ZERO) > 0 ? availRaw : FRAC_ZERO;
      const net = cons.sub(availProd); // positive means net external draw
      // A free-supply target item is additionally justified by its export
      // shortfall: the declared rate beyond what net production covers arrives
      // as a boundary passthrough into the target output.
      const netProd = prod.sub(cons);
      const exportShortfall =
        supply === Infinity
          ? targetDemand.sub(
              netProd.compare(FRAC_ZERO) > 0 ? netProd : FRAC_ZERO,
            )
          : FRAC_ZERO;
      const magnitude = net.valueOf();
      const slack = Math.max(scaleFloor, Math.abs(magnitude)) * REL_TOL;
      const shortSlack =
        Math.max(scaleFloor, Math.abs(exportShortfall.valueOf())) * REL_TOL;
      if (
        net.valueOf() <= slack &&
        exportShortfall.valueOf() <= shortSlack
      ) {
        violations.push(
          `inputProduct for "${x}": item is not net-consumed from outside (consumption - production = ${magnitude})`,
        );
      }
    } else if (isOutputProductUnit(unit)) {
      const x = unit.itemId;
      if (unit.flavor === "target") {
        // Justified iff X is a declared target item.
        if (!demandOf.has(x)) {
          violations.push(
            `outputProduct (target) for "${x}": item is not a declared target item`,
          );
        }
      } else {
        // "surplus": justified iff genuine overproduction beyond demand.
        const prod = production.get(x) ?? FRAC_ZERO;
        const cons = consumption.get(x) ?? FRAC_ZERO;
        const demand = demandOf.get(x) ?? 0;
        const netSurplus = prod.sub(cons).sub(new Fraction(demand));
        const magnitude = netSurplus.valueOf();
        const slack = Math.max(scaleFloor, Math.abs(magnitude)) * REL_TOL;
        if (magnitude <= slack) {
          violations.push(
            `outputProduct (surplus) for "${x}": no genuine surplus (production - consumption - demand = ${magnitude}); unjustified surplus unit (RF-1 phantom)`,
          );
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * For each item with visible internal production AND consumption, the sum of
 * internal-edge rates carrying it must be at least
 * max(0, min(prodVisible - declaredTargetDemand, consVisible)) within
 * tolerance. Production claimed by a declared target output product is
 * unavailable for internal routing, so it is subtracted before the min.
 *
 * "Internal" edges have both endpoints on recipe or loop units, not product
 * units. This catches a dropped internal edge: the solve routes an intermediate
 * item entirely inside the plan but the render graph is missing the edge.
 *
 * "Visible production/consumption" for item X:
 *   - Recipe: sum over recipes whose id appears in the rendered recipe units
 *     (loop-internal recipes are collapsed and excluded, to avoid false
 *     positives from cycle items).
 *   - Loop unit: the netIO ports.
 *
 * Shortfall-only: excess internal flow is not flagged. Items with zero visible
 * production or consumption are skipped.
 */
export function checkInternalFlowConservation(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);

  // Declared target rate per target item, built like
  // checkTargetOutputsSatisfied: production delivered to a target output
  // product is unavailable for internal routing.
  const declaredByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const rate = rationalFromString(t.ratePerSec);
    declaredByItem.set(
      t.itemId,
      (declaredByItem.get(t.itemId) ?? FRAC_ZERO).add(rate),
    );
  }

  // recipeIds with a rendered recipe unit. Loop-internal recipes collapse into
  // a loop unit and do not appear here.
  const renderedRecipeIds = new Set<RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      renderedRecipeIds.add(u.recipeId);
    }
  }

  // Visible production and consumption: rendered recipes plus loop unit netIO.
  const prodVisible = productionByItem(rates, pack, renderedRecipeIds);
  const consVisible = consumptionByItem(rates, pack, renderedRecipeIds);

  const addTo = (
    map: Map<ItemId, Fraction>,
    item: ItemId,
    qty: Fraction,
  ): void => {
    map.set(item, (map.get(item) ?? FRAC_ZERO).add(qty));
  };

  // Loop unit netIO contributions.
  for (const u of plan.units) {
    if (!isLoopUnit(u)) continue;
    for (const port of u.netIO) {
      if (port.direction === "out") {
        addTo(prodVisible, port.item, port.rate);
      } else {
        addTo(consVisible, port.item, port.rate);
      }
    }
  }

  // Unit lookup; internal units are recipe or loop units.
  const units = unitById(plan);
  const isInternalUnit = (id: RenderUnitId): boolean => {
    const u = units.get(id);
    if (!u) return false;
    return isRecipeUnit(u) || isLoopUnit(u);
  };

  // Sum internal-edge rates per item (both endpoints internal).
  const internalSum = new Map<ItemId, Fraction>();
  for (const edge of plan.edges) {
    if (isInternalUnit(edge.fromUnit) && isInternalUnit(edge.toUnit)) {
      addTo(internalSum, edge.item, edge.rate);
    }
  }

  // Check each item with visible activity on both sides.
  const allItems = new Set<ItemId>([
    ...prodVisible.keys(),
    ...consVisible.keys(),
  ]);

  for (const item of allItems) {
    const prod = prodVisible.get(item) ?? FRAC_ZERO;
    const cons = consVisible.get(item) ?? FRAC_ZERO;

    // Expected internal flow is min(prod - targetDemand, cons) clamped at
    // zero: target-claimed production never routes internally, excess prod
    // beyond that goes to a boundary output product, excess cons comes from a
    // boundary input product. The clamp guards a solver under-production.
    const targetDemand = declaredByItem.get(item) ?? FRAC_ZERO;
    const availRaw = prod.sub(targetDemand);
    const availProd = availRaw.compare(FRAC_ZERO) > 0 ? availRaw : FRAC_ZERO;
    const expected = availProd.compare(cons) <= 0 ? availProd : cons;
    const slack = Math.max(scaleFloor, expected.valueOf()) * REL_TOL;

    // Skip items with negligible expected internal flow.
    if (prod.valueOf() <= slack || cons.valueOf() <= slack) continue;

    const actual = internalSum.get(item) ?? FRAC_ZERO;

    if (actual.valueOf() < expected.valueOf() - slack) {
      violations.push(
        `internal flow shortfall for "${item}": expected internal rate ${expected.valueOf()} but actual ${actual.valueOf()} (missing or under-carried internal edge)`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * For each running recipe unit, every required input item must have enough
 * inflow from edges arriving at that recipe's units (aggregated across units
 * sharing a recipeId). Catches a consumer fed from nothing: a recipe rendered
 * with a required input that has no incoming edge.
 *
 * Aggregation by recipeId: expected intake for recipe R, item I is
 * rates(R) * recipe.in[I].qty. Actual inflow is the sum of edge.rate over edges
 * whose toUnit is a recipe unit with recipeId === R and edge.item === I. Both
 * boundary (inputProduct -> recipe) and internal (recipe/loop -> recipe) edges
 * count.
 *
 * Loop units are skipped; their net input ports go through the internal flow
 * conservation checker. Shortfall-only: excess inflow is not flagged.
 */
export function checkConsumerInputsSatisfied(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);

  // Lookup from unit id to recipeId, recipe units only.
  const recipeIdByUnitId = new Map<RenderUnitId, RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      recipeIdByUnitId.set(u.id, u.recipeId);
    }
  }

  // Inflow keyed by "recipeId\0item" to avoid a map-of-maps. Only edges whose
  // toUnit is a recipe unit count.
  const inflow = new Map<string, Fraction>();
  for (const edge of plan.edges) {
    const recipeId = recipeIdByUnitId.get(edge.toUnit);
    if (recipeId === undefined) continue;
    const key = `${recipeId}\0${edge.item}`;
    inflow.set(key, (inflow.get(key) ?? FRAC_ZERO).add(edge.rate));
  }

  // Distinct recipeIds among rendered recipe units.
  const renderedRecipeIds = new Set(recipeIdByUnitId.values());

  const recipeById = new Map(nettedPack(pack).recipes.map((r) => [r.id, r]));

  for (const recipeId of renderedRecipeIds) {
    const rate = rates.get(recipeId);
    if (!rate) continue; // recipe not running

    const rateVal = rate.valueOf();
    const rateSlack = Math.max(scaleFloor, rateVal) * REL_TOL;
    if (rateVal <= rateSlack) continue; // negligible rate

    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    for (const inp of recipe.in) {
      const expected = rate.mul(new Fraction(inp.qty));
      const expectedVal = expected.valueOf();
      const actual = inflow.get(`${recipeId}\0${inp.item}`) ?? FRAC_ZERO;
      const actualVal = actual.valueOf();
      const slack = Math.max(scaleFloor, expectedVal) * REL_TOL;

      if (actualVal < expectedVal - slack) {
        violations.push(
          `recipe "${recipeId}" input "${inp.item}": expected inflow ${expectedVal} but actual ${actualVal} (consumer fed from nothing)`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Mirror of checkConsumerInputsSatisfied. For each running recipe unit, the
 * aggregated inbound edge rate for a required input must not exceed the
 * expected intake rates(R) * recipe.in[I].qty beyond tolerance.
 *
 * Catches over-connection: a consumer wired to more producer flow than it
 * consumes (double-feeding), e.g. a producer fanning the same item into one
 * consumer stamp twice, or an over-replicated producer whose surplus is
 * misrouted back into a live consumer.
 *
 * Aggregation by recipeId mirrors checkConsumerInputsSatisfied: inflow keyed by
 * "recipeId\0item" over edges whose toUnit is a recipe unit; boundary and
 * internal edges count. Loop units are skipped.
 *
 * Excess-only: shortfall is left to checkConsumerInputsSatisfied.
 */
export function checkConsumerInputsNotOverfed(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);

  // Lookup from unit id to recipeId, recipe units only.
  const recipeIdByUnitId = new Map<RenderUnitId, RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      recipeIdByUnitId.set(u.id, u.recipeId);
    }
  }

  // Inflow keyed by "recipeId\0item" to avoid a map-of-maps. Only edges whose
  // toUnit is a recipe unit count.
  const inflow = new Map<string, Fraction>();
  for (const edge of plan.edges) {
    const recipeId = recipeIdByUnitId.get(edge.toUnit);
    if (recipeId === undefined) continue;
    const key = `${recipeId}\0${edge.item}`;
    inflow.set(key, (inflow.get(key) ?? FRAC_ZERO).add(edge.rate));
  }

  // Distinct recipeIds among rendered recipe units.
  const renderedRecipeIds = new Set(recipeIdByUnitId.values());

  const recipeById = new Map(nettedPack(pack).recipes.map((r) => [r.id, r]));

  for (const recipeId of renderedRecipeIds) {
    const rate = rates.get(recipeId);
    if (!rate) continue; // recipe not running

    const rateVal = rate.valueOf();
    const rateSlack = Math.max(scaleFloor, rateVal) * REL_TOL;
    if (rateVal <= rateSlack) continue; // negligible rate

    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    for (const inp of recipe.in) {
      const expected = rate.mul(new Fraction(inp.qty));
      const expectedVal = expected.valueOf();
      const actual = inflow.get(`${recipeId}\0${inp.item}`) ?? FRAC_ZERO;
      const actualVal = actual.valueOf();
      const slack = Math.max(scaleFloor, expectedVal) * REL_TOL;

      if (actualVal > expectedVal + slack) {
        violations.push(
          `recipe "${recipeId}" input "${inp.item}": expected inflow ${expectedVal} but actual ${actualVal} (consumer over-fed / over-connected)`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * For each target item X, the declared rate must be delivered by edges
 * arriving at the target output-product unit (`u:out:<X>`).
 * Catches an under-fed target output edge. checkBoundaryProductsJustified only
 * verifies such a unit exists, not that it is fed.
 *
 * `declared` for X is the sum of ratePerSec over targets declaring X, the
 * same way boundary-products builds targetRateByItem. `actual` is the sum of
 * edge.rate over edges whose toUnit is `u:out:<X>` and item is X.
 *
 * Shortfall-only: violation iff actual < declared - slack, slack =
 * max(1, declared) * REL_TOL. Excess is left to the over-connection checkers.
 */
export function checkTargetOutputsSatisfied(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);

  // Declared target rate per target item.
  const declaredByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const rate = rationalFromString(t.ratePerSec);
    declaredByItem.set(
      t.itemId,
      (declaredByItem.get(t.itemId) ?? FRAC_ZERO).add(rate),
    );
  }

  // Actual inflow into each target output-product unit, keyed by item.
  const actualByItem = new Map<ItemId, Fraction>();
  for (const edge of plan.edges) {
    const declared = declaredByItem.get(edge.item);
    if (declared === undefined) continue;
    if (edge.toUnit !== `u:out:${edge.item}`) continue;
    actualByItem.set(
      edge.item,
      (actualByItem.get(edge.item) ?? FRAC_ZERO).add(edge.rate),
    );
  }

  for (const [item, declared] of declaredByItem) {
    const declaredVal = declared.valueOf();
    const actual = actualByItem.get(item) ?? FRAC_ZERO;
    const actualVal = actual.valueOf();
    const slack = Math.max(scaleFloor, declaredVal) * REL_TOL;
    if (actualVal < declaredVal - slack) {
      violations.push(
        `target output "${item}": expected delivery ${declaredVal} but actual ${actualVal} (target output fed below declared rate)`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Every recipe unit must have a positive rate. A unit whose recipeId is absent
 * from rates, or whose rate is <= 0, is an orphan: the render pipeline
 * materialized a unit the solver never ran.
 */
export function checkNoOrphanUnits(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates } = args;
  const violations: string[] = [];

  for (const unit of plan.units) {
    if (!isRecipeUnit(unit)) continue;
    const rate = rates.get(unit.recipeId);
    if (rate === undefined || rate.compare(FRAC_ZERO) <= 0) {
      violations.push(
        `recipe unit "${unit.id}" (recipeId "${unit.recipeId}"): no positive rate in rates map`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Per-unit Kirchhoff check on producer outflow. Every checker above aggregates
 * consumer inflow by recipeId or item; none verifies that a render unit ships
 * no more of an item than it produces. A dropped co-product edge on one sibling
 * replica leaves the surviving edge over-billed past its producer's capacity,
 * and a phantom target edge can drain a unit with no real spare; both pass all
 * the inflow checkers because the consumer side still balances.
 *
 * Per-unit production of item X for a recipe unit is derived from its rational
 * machine count: production = multiplicity * (machineSpeed / recipe.time) *
 * out.qty. This equals the unit's share of the LP execution rate (the LP rate
 * is the sum over the units of one recipe), validated against the machine-graph
 * execution rates. Machine speed comes from the recipe's first producer; an
 * absent producer or machine defaults speed to 1, the only value the pack uses.
 *
 * Three clauses, all relative-tolerance:
 *   (a) For each recipe unit and each item it produces, the total outgoing edge
 *       rate of that item from the unit must not exceed the unit's production of
 *       that item. Catches the over-billed surviving edge.
 *   (b) Per item, summed over all recipe units, total production must equal the
 *       total outgoing edge rate from recipe units. Edges into outputProduct
 *       units of either flavor ("surplus" and "target") count as ordinary
 *       shipment, so a balanced byproduct that ships its full output into a
 *       surplus node is clean. Catches production that vanishes off the graph
 *       with no compensating over-bill elsewhere. (When a vanish is paired with
 *       an over-bill on the same item the two cancel here and clause (a) is what
 *       fires; clause (b) is the cheap complement for vanish-without-over-bill.)
 *   (c) Per recipe, the multiplicity-derived execution rate summed over the
 *       recipe's units must equal `args.rates` (LP truth). Clauses (a) and (b)
 *       reconstruct production from unit.multiplicity, which derives from the
 *       same idealCount that feeds the edges, so a COHERENTLY inflated plan
 *       (multiplicity and edges scaled together) is structurally invisible to
 *       them; anchoring the multiplicity sum on the LP rate closes that
 *       render-vs-render blind spot.
 *
 * Loop units are skipped: their recipes collapse and have no multiplicity, and
 * their boundary-crossing flow goes through checkInternalFlowConservation.
 */
export function checkUnitOutflowVsProduction(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);

  const recipeById = new Map(nettedPack(pack).recipes.map((r) => [r.id, r]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));

  const speedOf = (recipe: (typeof pack.recipes)[number]): Fraction => {
    const producerId = recipe.producers[0];
    const machine =
      producerId === undefined ? undefined : machineById.get(producerId);
    return machine ? new Fraction(machine.speed) : new Fraction(1);
  };

  // The set of recipe-unit ids, so clause (b) sums outgoing edges only from
  // recipe units (boundary and loop units do not produce here).
  const recipeUnitIds = new Set<RenderUnitId>();
  // Per-unit production of each item, keyed by "unitId\0item".
  const producedByUnitItem = new Map<string, Fraction>();
  // Per-item total production, summed over recipe units.
  const producedByItem = new Map<ItemId, Fraction>();
  // Multiplicity-derived execution rate summed per recipe, for clause (c).
  const derivedRateByRecipe = new Map<RecipeId, Fraction>();

  for (const unit of plan.units) {
    if (!isRecipeUnit(unit)) continue;
    recipeUnitIds.add(unit.id);
    const recipe = recipeById.get(unit.recipeId);
    if (!recipe) continue;
    const multiplicity = rationalFromString(unit.multiplicity);
    const time = new Fraction(recipe.time);
    const execRate = multiplicity.mul(speedOf(recipe)).div(time);
    derivedRateByRecipe.set(
      unit.recipeId,
      (derivedRateByRecipe.get(unit.recipeId) ?? FRAC_ZERO).add(execRate),
    );
    for (const o of recipe.out) {
      const produced = execRate.mul(new Fraction(o.qty));
      const key = `${unit.id}\0${o.item}`;
      producedByUnitItem.set(
        key,
        (producedByUnitItem.get(key) ?? FRAC_ZERO).add(produced),
      );
      producedByItem.set(
        o.item,
        (producedByItem.get(o.item) ?? FRAC_ZERO).add(produced),
      );
    }
  }

  // Outgoing edge rate per "unitId\0item" and per item, restricted to edges
  // leaving a recipe unit. Edges into outputProduct units of either flavor
  // ("surplus" and "target") are ordinary shipments and counted here.
  const outgoingByUnitItem = new Map<string, Fraction>();
  const outgoingByItem = new Map<ItemId, Fraction>();
  for (const edge of plan.edges) {
    if (!recipeUnitIds.has(edge.fromUnit)) continue;
    const key = `${edge.fromUnit}\0${edge.item}`;
    outgoingByUnitItem.set(
      key,
      (outgoingByUnitItem.get(key) ?? FRAC_ZERO).add(edge.rate),
    );
    outgoingByItem.set(
      edge.item,
      (outgoingByItem.get(edge.item) ?? FRAC_ZERO).add(edge.rate),
    );
  }

  // Clause (a): no unit ships more of an item than it produces.
  for (const [key, produced] of producedByUnitItem) {
    const sep = key.indexOf("\0");
    const unitId = key.slice(0, sep);
    const item = key.slice(sep + 1);
    const outgoing = outgoingByUnitItem.get(key) ?? FRAC_ZERO;
    const producedVal = produced.valueOf();
    const outgoingVal = outgoing.valueOf();
    const slack = Math.max(scaleFloor, producedVal) * REL_TOL;
    if (outgoingVal > producedVal + slack) {
      violations.push(
        `unit "${unitId}" item "${item}": outgoing ${outgoingVal} exceeds production ${producedVal} (over-billed producer edge)`,
      );
    }
  }

  // Clause (b): per item, total production must equal total outgoing edge rate
  // from recipe units. Catches production that vanishes off the graph without a
  // compensating over-bill (an over-bill cancels here and clause (a) fires).
  const itemsB = new Set<ItemId>([
    ...producedByItem.keys(),
    ...outgoingByItem.keys(),
  ]);
  for (const item of itemsB) {
    const produced = producedByItem.get(item) ?? FRAC_ZERO;
    const outgoing = outgoingByItem.get(item) ?? FRAC_ZERO;
    const producedVal = produced.valueOf();
    const outgoingVal = outgoing.valueOf();
    const slack = Math.max(scaleFloor, producedVal, outgoingVal) * REL_TOL;
    if (Math.abs(producedVal - outgoingVal) > slack) {
      violations.push(
        `item "${item}": production ${producedVal} != outgoing ${outgoingVal} (production vanished without a compensating over-bill)`,
      );
    }
  }

  // Clause (c): per recipe, the multiplicity-derived rate sum must match the
  // LP rate. A recipe with no rates entry is left to checkNoOrphanUnits.
  for (const [recipeId, derived] of derivedRateByRecipe) {
    const lpRate = rates.get(recipeId);
    if (lpRate === undefined) continue;
    const derivedVal = derived.valueOf();
    const lpVal = lpRate.valueOf();
    const slack = Math.max(scaleFloor, Math.abs(lpVal)) * REL_TOL;
    if (Math.abs(derivedVal - lpVal) > slack) {
      violations.push(
        `recipe "${recipeId}": multiplicity-derived rate ${derivedVal} != LP rate ${lpVal} (unit multiplicities incoherent with the solve)`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validates the displayed rate chips on boundary product units and the shape
 * of edges leaving input products. Every other checker validates flow through
 * recipe-unit stoichiometry only, so the ProductNode chrome (input demand,
 * surplus rate, target rate) and inputProduct->inputProduct aggregate wiring
 * were previously unvalidated; this family of display fields regressed once
 * before (render-audit "Bug 3") with no checker able to catch it.
 *
 * Rules, rate clauses relative-tolerance, structural clauses exact:
 *   (a) inputProduct rate chip == sum of the unit's outbound edge rates (the
 *       documented contract of RenderUnitInputProduct.rate).
 *   (b) fanout inputProduct inbound (its aggregate feed) == its rate chip;
 *       non-fanout input products (single-bucket nodes and aggregates) accept
 *       no inbound edges at all.
 *   (c) every edge leaving an inputProduct must carry the unit's own item and
 *       land on an inputProduct of the same item (aggregate -> fanout), on a
 *       recipe/loop unit that consumes the item per its stoichiometry or
 *       netIO, or on the same item's target outputProduct (the free-boundary
 *       passthrough). Catches a spurious boundary edge into a non-consumer.
 *   (d) outputProduct "surplus" rate chip == sum of inbound edge rates.
 *   (e) outputProduct "target" rate chip == the declared target rate for the
 *       item (sum over targets sharing the primary output).
 */
export function checkProductUnitRates(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, pack, targets } = args;
  const violations: string[] = [];
  const scaleFloor = planScaleFloor(targets);
  const units = unitById(plan);

  const slackFor = (expected: number): number =>
    Math.max(scaleFloor, Math.abs(expected)) * REL_TOL;

  // Outbound/inbound edge-rate sums per unit id, restricted to product units.
  const outboundByUnit = new Map<RenderUnitId, Fraction>();
  const inboundByUnit = new Map<RenderUnitId, Fraction>();
  for (const edge of plan.edges) {
    const from = units.get(edge.fromUnit);
    if (from && (isInputProductUnit(from) || isOutputProductUnit(from))) {
      outboundByUnit.set(
        edge.fromUnit,
        (outboundByUnit.get(edge.fromUnit) ?? FRAC_ZERO).add(edge.rate),
      );
    }
    const to = units.get(edge.toUnit);
    if (to && (isInputProductUnit(to) || isOutputProductUnit(to))) {
      inboundByUnit.set(
        edge.toUnit,
        (inboundByUnit.get(edge.toUnit) ?? FRAC_ZERO).add(edge.rate),
      );
    }
  }

  // Declared target rate per target item, the targetRateByItem rule.
  const declaredByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const rate = rationalFromString(t.ratePerSec);
    declaredByItem.set(
      t.itemId,
      (declaredByItem.get(t.itemId) ?? FRAC_ZERO).add(rate),
    );
  }

  // Consumed-item sets per recipe, built once so the clause (c) edge loop
  // resolves consumption in O(1) instead of scanning recipe.in per edge.
  const consumedByRecipe = new Map<string, Set<ItemId>>();
  for (const recipe of nettedPack(pack).recipes) {
    consumedByRecipe.set(recipe.id, new Set(recipe.in.map((s) => s.item)));
  }

  const consumesItem = (unit: RenderUnit, item: ItemId): boolean => {
    if (isRecipeUnit(unit)) {
      return consumedByRecipe.get(unit.recipeId)?.has(item) ?? false;
    }
    if (isLoopUnit(unit)) {
      return unit.netIO.some((p) => p.direction === "in" && p.item === item);
    }
    return false;
  };

  for (const unit of plan.units) {
    if (isInputProductUnit(unit)) {
      const chip = rationalFromString(unit.rate).valueOf();
      const outbound = (outboundByUnit.get(unit.id) ?? FRAC_ZERO).valueOf();
      if (Math.abs(chip - outbound) > slackFor(chip)) {
        violations.push(
          `inputProduct "${unit.id}": rate chip ${chip} != outbound edge sum ${outbound}`,
        );
      }
      const inbound = (inboundByUnit.get(unit.id) ?? FRAC_ZERO).valueOf();
      if (unit.isFanout) {
        if (Math.abs(chip - inbound) > slackFor(chip)) {
          violations.push(
            `inputProduct fanout "${unit.id}": rate chip ${chip} != aggregate inbound ${inbound}`,
          );
        }
      } else if (inbound > slackFor(inbound)) {
        violations.push(
          `inputProduct "${unit.id}": unexpected inbound edge flow ${inbound} (only fanout slices are fed)`,
        );
      }
    } else if (isOutputProductUnit(unit)) {
      const chip = rationalFromString(unit.rate).valueOf();
      if (unit.flavor === "surplus") {
        const inbound = (inboundByUnit.get(unit.id) ?? FRAC_ZERO).valueOf();
        if (Math.abs(chip - inbound) > slackFor(chip)) {
          violations.push(
            `outputProduct (surplus) "${unit.id}": rate chip ${chip} != inbound edge sum ${inbound}`,
          );
        }
      } else {
        const declared = (
          declaredByItem.get(unit.itemId) ?? FRAC_ZERO
        ).valueOf();
        if (Math.abs(chip - declared) > slackFor(declared)) {
          violations.push(
            `outputProduct (target) "${unit.id}": rate chip ${chip} != declared target rate ${declared}`,
          );
        }
      }
    }
  }

  // Clause (c): structure of edges leaving input products.
  for (const edge of plan.edges) {
    const from = units.get(edge.fromUnit);
    if (!from || !isInputProductUnit(from)) continue;
    if (edge.item !== from.itemId) {
      violations.push(
        `inputProduct "${from.id}": outbound edge carries "${edge.item}" instead of its own item "${from.itemId}"`,
      );
      continue;
    }
    const to = units.get(edge.toUnit);
    if (!to) continue; // dangling endpoint is checkEdgeEndpointIntegrity's job
    const okTarget =
      (isInputProductUnit(to) && to.itemId === from.itemId) ||
      // Free-boundary target passthrough: the import feeds the same item's
      // target export directly.
      (isOutputProductUnit(to) &&
        to.itemId === from.itemId &&
        to.flavor === "target") ||
      consumesItem(to, edge.item);
    if (!okTarget) {
      violations.push(
        `inputProduct "${from.id}": edge to "${edge.toUnit}" lands on a unit that does not consume "${edge.item}"`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Run all nine render invariant checkers in stable order. Mirrors the solver
 * debug surface that lists a verdict per checker.
 */
export function checkRenderPlan(args: RenderInvariantArgs): InvariantResult[] {
  return [
    checkEdgeEndpointIntegrity(args),
    checkBoundaryProductsJustified(args),
    checkInternalFlowConservation(args),
    checkConsumerInputsSatisfied(args),
    checkConsumerInputsNotOverfed(args),
    checkTargetOutputsSatisfied(args),
    checkNoOrphanUnits(args),
    checkUnitOutflowVsProduction(args),
    checkProductUnitRates(args),
  ];
}

/**
 * Assert all render invariants. Throws one Error aggregating every violation
 * across the nine checkers. Mirrors assertInvariants in the solver invariants.
 */
export function assertRenderInvariants(args: RenderInvariantArgs): void {
  const violations = checkRenderPlan(args).flatMap((r) => r.violations);
  if (violations.length > 0) {
    throw new Error(`render invariants violated:\n${violations.join("\n")}`);
  }
}
