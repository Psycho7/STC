import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { Target } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";
import type { InvariantResult } from "../../solver/invariants";
import { effectiveSupply } from "../../solver/effectiveSupply";
import { demandByItem } from "../../solver/lp";
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

// Relative tolerance matching the solver invariants module.
const REL_TOL = 1e-6;

// Uniform args object shared by all render checkers so a future aggregator can
// call them in a list without per-function signature differences.
export type RenderInvariantArgs = {
  plan: RenderPlan;
  rates: ReadonlyMap<RecipeId, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<ItemOverride>;
};

// ---------------------------------------------------------------------------
// Foundation helpers
// ---------------------------------------------------------------------------

const FRAC_ZERO = new Fraction(0);

// Build an O(1) lookup map from unit id to unit.
export function unitById(plan: RenderPlan): Map<RenderUnitId, RenderUnit> {
  const m = new Map<RenderUnitId, RenderUnit>();
  for (const u of plan.units) {
    m.set(u.id, u);
  }
  return m;
}

// Core: sum of out.qty * rate over recipes. When restrict is provided, only
// recipes whose id is in the set are included.
function productionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
  restrict?: ReadonlySet<RecipeId>,
): Map<ItemId, Fraction> {
  const result = new Map<ItemId, Fraction>();
  for (const r of pack.recipes) {
    if (restrict !== undefined && !restrict.has(r.id)) continue;
    const rate = rates.get(r.id);
    if (!rate) continue;
    for (const o of r.out) {
      result.set(o.item, (result.get(o.item) ?? FRAC_ZERO).add(new Fraction(o.qty).mul(rate)));
    }
  }
  return result;
}

// Core: sum of in.qty * rate over recipes. When restrict is provided, only
// recipes whose id is in the set are included.
function consumptionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
  restrict?: ReadonlySet<RecipeId>,
): Map<ItemId, Fraction> {
  const result = new Map<ItemId, Fraction>();
  for (const r of pack.recipes) {
    if (restrict !== undefined && !restrict.has(r.id)) continue;
    const rate = rates.get(r.id);
    if (!rate) continue;
    for (const inp of r.in) {
      result.set(inp.item, (result.get(inp.item) ?? FRAC_ZERO).add(new Fraction(inp.qty).mul(rate)));
    }
  }
  return result;
}

// Per item: sum of out.qty * rate over all recipes (exact Fraction arithmetic).
export function internalProductionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
): Map<ItemId, Fraction> {
  return productionByItem(rates, pack);
}

// Per item: sum of in.qty * rate over all recipes (exact Fraction arithmetic).
export function internalConsumptionByItem(
  rates: ReadonlyMap<RecipeId, Fraction>,
  pack: RecipePack,
): Map<ItemId, Fraction> {
  return consumptionByItem(rates, pack);
}

// Per item: production minus consumption (the netProduction pattern as a map).
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
 * Edge endpoint integrity: every edge must reference valid unit ids, carry a
 * positive rate, and label a known item. Catches render-pipeline bugs such as
 * dropped units or mislabeled ids.
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
 * Boundary products justified: every inputProduct and outputProduct unit in the
 * render plan must correspond to a genuine boundary condition in the solve.
 *
 * - inputProduct for X: justified iff effectiveSupply(X) is Infinity OR a
 *   finite positive (external supply exists) AND the plan actually draws X
 *   from outside, i.e. consumption(X) > production(X) beyond tolerance.
 *
 * - outputProduct flavor "target" for X: justified iff X is the primary output
 *   of one of the target recipes (i.e. X appears in demandByItem keys).
 *
 * - outputProduct flavor "surplus" for X: justified iff there is genuine net
 *   overproduction beyond demand: production(X) - consumption(X) - demand(X)
 *   exceeds the relative tolerance.
 *
 * Tolerance: relative slack = max(1, |magnitude|) * REL_TOL, consistent with
 * checkRawOnlyBoundary in the solver invariants module.
 *
 * The RF-1 bug: an internally balanced intermediate (production ~= consumption,
 * net residual within tolerance), not a target, appearing as a surplus output
 * product is the canonical violation this checker catches.
 */
export function checkBoundaryProductsJustified(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack, targets, itemOverrides } = args;
  const violations: string[] = [];

  const production = internalProductionByItem(rates, pack);
  const consumption = internalConsumptionByItem(rates, pack);
  const demandOf = demandByItem(pack, targets as Target[]);

  for (const unit of plan.units) {
    if (isInputProductUnit(unit)) {
      const x = unit.itemId;
      const supply = effectiveSupply(x, pack, itemOverrides as ItemOverride[]);
      // An inputProduct is justified only when there is genuine external supply
      // and the item is net-consumed (consumption exceeds internal production).
      const hasExternalSupply =
        supply === Infinity ||
        (supply instanceof Fraction && supply.compare(FRAC_ZERO) > 0);
      if (!hasExternalSupply) {
        violations.push(
          `inputProduct for "${x}": no external supply (effectiveSupply is zero or finite-zero)`,
        );
        continue;
      }
      // Check that the plan actually draws X from outside: consumption > production.
      const prod = production.get(x) ?? FRAC_ZERO;
      const cons = consumption.get(x) ?? FRAC_ZERO;
      const net = cons.sub(prod); // positive means net external draw
      const magnitude = net.valueOf();
      const slack = Math.max(1, Math.abs(magnitude)) * REL_TOL;
      if (net.valueOf() <= slack) {
        violations.push(
          `inputProduct for "${x}": item is not net-consumed from outside (consumption - production = ${magnitude})`,
        );
      }
    } else if (isOutputProductUnit(unit)) {
      const x = unit.itemId;
      if (unit.flavor === "target") {
        // Justified iff X is the primary output of a target recipe.
        if (!demandOf.has(x)) {
          violations.push(
            `outputProduct (target) for "${x}": item is not the primary output of any target recipe`,
          );
        }
      } else {
        // flavor "surplus": justified iff genuine overproduction beyond demand.
        const prod = production.get(x) ?? FRAC_ZERO;
        const cons = consumption.get(x) ?? FRAC_ZERO;
        const demand = demandOf.get(x) ?? 0;
        // net surplus = production - consumption - demand
        const netSurplus = prod.sub(cons).sub(new Fraction(demand));
        const magnitude = netSurplus.valueOf();
        const slack = Math.max(1, Math.abs(magnitude)) * REL_TOL;
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
 * Internal flow conservation: for each item with visible internal production
 * AND visible internal consumption, the sum of internal-edge rates carrying
 * that item must be at least min(prodVisible, consVisible) within tolerance.
 *
 * "Internal" edges are those whose both endpoints resolve to recipe or loop
 * units (not product units). This catches the dropped-internal-edge half of
 * bug RF-1, where the solve routes an intermediate item entirely inside the
 * plan but the render graph is missing the edge.
 *
 * "Visible production/consumption" for an item X:
 *   - Recipe contribution: sum over recipes whose id appears in the rendered
 *     recipe units (collapsed loop-internal recipes are excluded to avoid
 *     false positives from loop-internal cycle items).
 *   - Loop unit contribution: the netIO ports on each loop unit.
 *
 * Shortfall-only: excess internal flow (internalSum > expected) is not
 * flagged. Items with zero visible consumption or zero visible production
 * are skipped.
 */
export function checkInternalFlowConservation(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack } = args;
  const violations: string[] = [];

  // Set of recipeIds that have a rendered recipe unit. Loop-internal recipes
  // are collapsed into a loop unit and do not appear here.
  const renderedRecipeIds = new Set<RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      renderedRecipeIds.add(u.recipeId);
    }
  }

  // Accumulate visible production and consumption restricted to rendered
  // recipes plus loop unit netIO contributions.
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

  // Build the unit lookup and identify which units are internal (recipe or loop).
  const units = unitById(plan);
  const isInternalUnit = (id: RenderUnitId): boolean => {
    const u = units.get(id);
    if (!u) return false;
    return isRecipeUnit(u) || isLoopUnit(u);
  };

  // Sum internal-edge rates per item (both endpoints must be internal units).
  const internalSum = new Map<ItemId, Fraction>();
  for (const edge of plan.edges) {
    if (isInternalUnit(edge.fromUnit) && isInternalUnit(edge.toUnit)) {
      addTo(internalSum, edge.item, edge.rate);
    }
  }

  // Check each item that has visible activity on both sides.
  const allItems = new Set<ItemId>([
    ...prodVisible.keys(),
    ...consVisible.keys(),
  ]);

  for (const item of allItems) {
    const prod = prodVisible.get(item) ?? FRAC_ZERO;
    const cons = consVisible.get(item) ?? FRAC_ZERO;

    // The expected internal flow is min(prod, cons): any excess prod goes to a
    // boundary output product, any excess cons comes from a boundary input product.
    const expected = prod.compare(cons) <= 0 ? prod : cons;
    const slack = Math.max(1, expected.valueOf()) * REL_TOL;

    // Skip items whose expected internal flow is negligible (min(prod,cons) <= slack).
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
 * Consumer inputs satisfied: for each running recipe unit, every required
 * input item must have sufficient inflow from edges that arrive at that
 * recipe's units (aggregated across all units sharing the same recipeId).
 *
 * Catches the consumer half of bug RF-1: a recipe rendered with a required
 * input that has no incoming edge (fed from nothing).
 *
 * Aggregation by recipeId: the total expected intake for recipe R and item I
 * is rates(R) * recipe.in[I].qty. The total actual inflow is the sum of
 * edge.rate over all edges whose toUnit resolves to a recipe unit with
 * recipeId === R and whose edge.item === I. Both boundary (inputProduct ->
 * recipe) and internal (recipe/loop -> recipe) edges count.
 *
 * Loop units are not checked here; their net input ports are handled by the
 * internal flow conservation checker.
 *
 * Shortfall-only: excess inflow is not flagged.
 */
export function checkConsumerInputsSatisfied(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack } = args;
  const violations: string[] = [];

  // Build a lookup from unit id to recipeId for recipe units only.
  const recipeIdByUnitId = new Map<RenderUnitId, RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      recipeIdByUnitId.set(u.id, u.recipeId);
    }
  }

  // Accumulate inflow keyed by "recipeId\0item" to avoid a map-of-maps.
  // Only edges whose toUnit is a recipe unit are attributed.
  const inflow = new Map<string, Fraction>();
  for (const edge of plan.edges) {
    const recipeId = recipeIdByUnitId.get(edge.toUnit);
    if (recipeId === undefined) continue;
    const key = `${recipeId}\0${edge.item}`;
    inflow.set(key, (inflow.get(key) ?? FRAC_ZERO).add(edge.rate));
  }

  // Distinct recipeIds present among rendered recipe units.
  const renderedRecipeIds = new Set(recipeIdByUnitId.values());

  // Fast lookup from recipeId to recipe definition.
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  for (const recipeId of renderedRecipeIds) {
    const rate = rates.get(recipeId);
    if (!rate) continue; // recipe not running

    const rateVal = rate.valueOf();
    const rateSlack = Math.max(1, rateVal) * REL_TOL;
    if (rateVal <= rateSlack) continue; // negligible rate

    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    for (const inp of recipe.in) {
      const expected = rate.mul(new Fraction(inp.qty));
      const expectedVal = expected.valueOf();
      const actual = inflow.get(`${recipeId}\0${inp.item}`) ?? FRAC_ZERO;
      const actualVal = actual.valueOf();
      const slack = Math.max(1, expectedVal) * REL_TOL;

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
 * Consumer inputs not overfed: the mirror of checkConsumerInputsSatisfied. For
 * each running recipe unit, the aggregated inbound edge rate for a required
 * input item must not EXCEED the expected intake rates(R) * recipe.in[I].qty
 * beyond the relative tolerance.
 *
 * Catches the over-connection half of the render-replication defect family: a
 * consumer wired to more producer flow than it consumes (double-feeding), e.g.
 * a per-consumer producer that fans the same item into a single consumer stamp
 * more than once, or an over-replicated producer whose surplus is mis-routed
 * back into a live consumer.
 *
 * Aggregation by recipeId mirrors checkConsumerInputsSatisfied exactly: inflow
 * is keyed by "recipeId\0item" over edges whose toUnit resolves to a recipe
 * unit; both boundary (inputProduct -> recipe) and internal (recipe/loop ->
 * recipe) edges count. Loop units are not checked here.
 *
 * Excess-only: shortfall (actual < expected) is not flagged here; that is the
 * job of checkConsumerInputsSatisfied.
 */
export function checkConsumerInputsNotOverfed(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, rates, pack } = args;
  const violations: string[] = [];

  // Build a lookup from unit id to recipeId for recipe units only.
  const recipeIdByUnitId = new Map<RenderUnitId, RecipeId>();
  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      recipeIdByUnitId.set(u.id, u.recipeId);
    }
  }

  // Accumulate inflow keyed by "recipeId\0item" to avoid a map-of-maps.
  // Only edges whose toUnit is a recipe unit are attributed.
  const inflow = new Map<string, Fraction>();
  for (const edge of plan.edges) {
    const recipeId = recipeIdByUnitId.get(edge.toUnit);
    if (recipeId === undefined) continue;
    const key = `${recipeId}\0${edge.item}`;
    inflow.set(key, (inflow.get(key) ?? FRAC_ZERO).add(edge.rate));
  }

  // Distinct recipeIds present among rendered recipe units.
  const renderedRecipeIds = new Set(recipeIdByUnitId.values());

  // Fast lookup from recipeId to recipe definition.
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  for (const recipeId of renderedRecipeIds) {
    const rate = rates.get(recipeId);
    if (!rate) continue; // recipe not running

    const rateVal = rate.valueOf();
    const rateSlack = Math.max(1, rateVal) * REL_TOL;
    if (rateVal <= rateSlack) continue; // negligible rate

    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    for (const inp of recipe.in) {
      const expected = rate.mul(new Fraction(inp.qty));
      const expectedVal = expected.valueOf();
      const actual = inflow.get(`${recipeId}\0${inp.item}`) ?? FRAC_ZERO;
      const actualVal = actual.valueOf();
      const slack = Math.max(1, expectedVal) * REL_TOL;

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
 * Target outputs satisfied: for each target recipe, the declared target rate of
 * its primary output item X must be delivered by edges arriving at the target
 * output-product unit (`u:out:<X>`). Catches the under-feeding of a target
 * output edge, the dual of checkBoundaryProductsJustified (which only verifies
 * such a unit EXISTS, not that it is FED).
 *
 * `declared` for X is the sum over targets sharing X of their ratePerSec,
 * mirroring how boundary-products computes `targetRateByItem`.
 *
 * `actual` is the sum of edge.rate over edges whose toUnit is `u:out:<X>` and
 * whose item is X.
 *
 * Shortfall-only: a violation is raised iff actual < declared - slack, with
 * slack = max(1, declared) * REL_TOL. Excess is left to the over-connection
 * checkers.
 */
export function checkTargetOutputsSatisfied(
  args: RenderInvariantArgs,
): InvariantResult {
  const { plan, pack, targets } = args;
  const violations: string[] = [];

  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  // declared target rate per primary-output item.
  const declaredByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const recipe = recipeById.get(t.recipeId);
    if (!recipe) continue;
    const outItem = recipe.out[0]?.item;
    if (outItem === undefined) continue;
    const rate = rationalFromString(t.ratePerSec);
    declaredByItem.set(outItem, (declaredByItem.get(outItem) ?? FRAC_ZERO).add(rate));
  }

  // actual inflow into each target output-product unit, keyed by item.
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
    const slack = Math.max(1, declaredVal) * REL_TOL;
    if (actualVal < declaredVal - slack) {
      violations.push(
        `target output "${item}": expected delivery ${declaredVal} but actual ${actualVal} (target output fed below declared rate)`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Orphan units: every recipe unit must have a positive rate in rates.
 * A recipe unit whose recipeId is absent from rates, or whose rate is <= 0,
 * is an orphan - the render pipeline materialized a unit the solver did not
 * actually run.
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
 * Run all seven render invariant checkers and return their results in stable
 * order. Mirrors the solver debug surface that lists verdicts per checker.
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
  ];
}

/**
 * Assert all render invariants. Throws a single Error aggregating every
 * violation found across all seven checkers. Mirrors assertInvariants in the
 * solver invariants module.
 */
export function assertRenderInvariants(args: RenderInvariantArgs): void {
  const violations = checkRenderPlan(args).flatMap((r) => r.violations);
  if (violations.length > 0) {
    throw new Error(`render invariants violated:\n${violations.join("\n")}`);
  }
}
