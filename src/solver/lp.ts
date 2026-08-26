import Fraction from "fraction.js";
import solver from "javascript-lp-solver";
import type { Recipe, RecipePack } from "@aef/schema";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import { effectiveSupply } from "./effectiveSupply";
import {
  isExcludedProducer,
  isExtractionRecipe,
} from "../data/recipe-category";

export type LpInput = {
  targets: ReadonlyArray<ItemTarget>;
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
  recipeCosts?: Map<RecipeId, number>;
};

export type LpResult = {
  rates: Map<RecipeId, Fraction>;
  surplus: Map<ItemId, Fraction>;
  deficit: Map<ItemId, Fraction>;
  // External boundary draw per finite-capped item: how much of the item's cap
  // the solution actually pulled in (0 <= draw <= cap). Items without a finite
  // positive cap never appear. Zero draws are omitted.
  draws: Map<ItemId, Fraction>;
  objectiveValue: number;
  solverWallClockMs: number;
  // Solver outcome. "infeasible"/"unbounded" come from the raw solver flags;
  // for those, rates/surplus/deficit are always empty (a failed solve leaves
  // junk partial values that must not leak) and softFeasible is always false.
  // "empty" is feasible but no recipe runs at a positive rate; "feasible" means
  // at least one runs. softFeasible is false when any material demand stays
  // unmet, judged from the raw pre-snap deficit variables (the solver pays
  // 1e9/unit for them), not from the extracted deficit map.
  status: "feasible" | "infeasible" | "unbounded" | "empty";
  softFeasible: boolean;
};

// The solver port: any function from LpInput to LpResult. solveLp is the
// in-house default. A vendor solver (e.g. GLPK) is another implementation that
// maps its native output into the LpResult shape, so swapping engines stays a
// reversible decision.
export type LpSolver = (input: LpInput) => LpResult;

// Model and result shapes accepted by javascript-lp-solver.
type LpModelVars = Record<string, Record<string, number>>;
type LpModelConstraints = Record<
  string,
  { equal?: number; min?: number; max?: number }
>;
type LpModel = {
  optimize: string;
  opType: "min" | "max";
  constraints: LpModelConstraints;
  variables: LpModelVars;
};
type LpRaw = Record<string, number> & {
  feasible?: boolean;
  result?: number;
  bounded?: boolean;
};

// Soft penalty weights for the primary objective. Surplus is cheap to leave on
// the table; deficit is huge so the LP only leaves demand unmet when nothing can
// satisfy it. Exported so the optimality screen scores against the same weights
// solveLp minimizes instead of a hand-copied duplicate.
export const SURPLUS_WEIGHT = 1e-3;
export const DEFICIT_WEIGHT = 1e9;

// Big-M cost for target-only and excluded-producer recipes. Exported so the
// extraction's pass-2 leak filter and recipeCostWeight key on the same value.
export const BIG_M_COST = 1e6;

// Default cost weights. The ordering deficit >> recipe >> surplus is the cost
// contract. Target-only and excluded-producer recipes get a big-M cost so the LP
// only runs them when no alternative exists. Miners and pumps are the one
// excluded class this does not decide: solveLp gives them no variable at all,
// so their big-M weight is never priced and no cost can make one run.
export function recipeCostWeight(
  r: Recipe,
  overrides: Map<RecipeId, number> | undefined,
): number {
  // Clamp to non-negative: a negative override would reward unbounded execution
  // of this recipe. 0 means "run if useful, no cost".
  if (overrides?.has(r.id)) return Math.max(0, overrides.get(r.id)!);
  if (r.flags?.includes("target-only") || isExcludedProducer(r)) return BIG_M_COST;
  return 1;
}

// Scale floor for relative residual tolerances: min(1, largest per-item
// demand). Plans at unit scale and above keep the historical absolute floor of
// 1; sub-unit plans shrink the floor to the plan's own magnitude so a 1e-6
// relative tolerance keeps meaning at tiny scales instead of swallowing the
// whole plan. Shared by the extraction hygiene gate and the invariant checkers
// (solver and render) so all of them tag at the same threshold.
export function toleranceScaleFloor(demand: Map<ItemId, number>): number {
  let maxDemand = 0;
  for (const d of demand.values()) maxDemand = Math.max(maxDemand, Math.abs(d));
  return maxDemand > 0 ? Math.min(1, maxDemand) : 1;
}

// Relative tolerance for PLAN-RATE residuals, shared by the extraction hygiene
// gate and every invariant checker (solver and render). Always applied as
// Math.max(toleranceScaleFloor(demandByItem(targets)), |magnitude|) * REL_TOL.
//
// Directional constraint: the extraction hygiene gate must never leave a
// residual checkMassBalance would tag, i.e. the gate's tolerance stays at or
// below the checkers'. Both are this one value today. An extraction gate that
// ever needs to be looser must declare its own constant that is <= REL_TOL;
// raising this shared constant instead inverts that direction silently, so
// raising it is forbidden.
//
// Not the LP objective tolerance (solver/optimality), not the transport
// capacity tolerance (pipeline/expand/edge-rates), and not for tools/oracle,
// whose cross-check must stay independent of this value.
export const REL_TOL = 1e-6;

// Demand per item: sum over targets of the requested net-export rate.
// Duplicate targets on the same item accumulate. Shared with the invariant
// checkers so model and checks read demand the same way.
export function demandByItem(targets: ReadonlyArray<ItemTarget>): Map<ItemId, number> {
  const demand = new Map<ItemId, number>();
  for (const t of targets) {
    const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    demand.set(t.itemId, (demand.get(t.itemId) ?? 0) + rate);
  }
  return demand;
}

// Relative tolerance for comparing pass-2's recomputed objective against
// pass-1's cost cap, floored so a zero-cost cap still admits solver noise.
// This is the OBJECTIVE/COST domain, deliberately NOT the plan-rate REL_TOL
// above: the two answer different questions and may move apart.
const COST_REL_TOL = 1e-6;

// Primary-pass objective recomputed from a raw solve's float primals, using the
// same weights buildModel("primary") minimizes: sum_r cost(r)*x_r +
// SURPLUS_WEIGHT*surplus + DEFICIT_WEIGHT*deficit. Infinite-supply items carry no
// surplus/deficit variable in the model, so the `?? 0` contributes nothing for
// them, matching the model. Draw variables cost 0 and are omitted. Used to verify
// the lex pass stayed within the cost cap the engine may not have enforced.
function primaryObjective(
  raw: LpRaw,
  recipes: Recipe[],
  items: RecipePack["items"],
  costById: Map<RecipeId, number>,
): number {
  let total = 0;
  for (const r of recipes) total += costById.get(r.id)! * (raw[`x_${r.id}`] ?? 0);
  for (const it of items) {
    total += SURPLUS_WEIGHT * (raw[`surplus_${it.id}`] ?? 0);
    total += DEFICIT_WEIGHT * (raw[`deficit_${it.id}`] ?? 0);
  }
  return total;
}

export function solveLp(input: LpInput): LpResult {
  const t0 = performance.now();
  const { targets, pack, itemOverrides = [] } = input;

  if (targets.length === 0) {
    return {
      rates: new Map(),
      surplus: new Map(),
      deficit: new Map(),
      draws: new Map(),
      objectiveValue: 0,
      solverWallClockMs: performance.now() - t0,
      status: "empty",
      softFeasible: true,
    };
  }

  // Sort recipes and items by id for deterministic iteration / lex-rank.
  // Miners and pumps are dropped outright rather than priced at big-M: the
  // model gets no x_ variable for them, so no solution can run one. A big-M
  // cost would still let the LP recruit a miner whenever nothing else covers
  // the demand, which is exactly the case that matters - a raw item capped
  // below what the plan consumes must report the shortfall as a deficit, not
  // grow its own mine.
  const sortedRecipes = [...pack.recipes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const recipes = sortedRecipes.filter((r) => !isExtractionRecipe(r));
  const items = [...pack.items].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  // Effective supply per item. Infinity = free boundary; finite = fixed cap.
  const supplyById = new Map<ItemId, Fraction | typeof Infinity>();
  for (const it of items) {
    supplyById.set(it.id, effectiveSupply(it.id, pack, itemOverrides));
  }

  const demand = demandByItem(targets);

  // Lex rank per recipe (sorted by id) for the pass-2 tie-break. Ranked over
  // the FULL sorted list, gaps for the dropped miners included. The ranks are
  // objective coefficients, not just an ordering, so compacting them would
  // reweight the pass-2 objective and move which cost-equal solution wins;
  // keeping every surviving recipe on its historical rank is what stops
  // dropping a miner from silently reshuffling pinned plans.
  const lexRank = new Map<RecipeId, number>();
  sortedRecipes.forEach((r, i) => lexRank.set(r.id, i));

  // Per-recipe objective cost, computed once. buildModel reads it in both passes
  // (variable objective and the pass-2 cost cap) instead of recomputing.
  const costById = new Map<RecipeId, number>();
  for (const r of recipes)
    costById.set(r.id, recipeCostWeight(r, input.recipeCosts));

  // Two-pass deterministic solve.
  //  - "primary": minimize weighted recipe cost + soft surplus/deficit penalty.
  //  - "lex":     minimize recipe-id rank under a frozen cost cap, so the
  //               tie-break only reshuffles among cost-optimal solutions.
  const buildModel = (mode: "primary" | "lex", costCap?: number): LpModel => {
    const variables: LpModelVars = {};
    const constraints: LpModelConstraints = {};

    for (const r of recipes) {
      const cost = costById.get(r.id)!;
      const rank = lexRank.get(r.id)!;
      variables[`x_${r.id}`] = { objective: mode === "primary" ? cost : rank };
    }

    for (const it of items) {
      variables[`surplus_${it.id}`] = {
        objective: mode === "lex" ? 0 : SURPLUS_WEIGHT,
      };
      variables[`deficit_${it.id}`] = {
        objective: mode === "lex" ? 0 : DEFICIT_WEIGHT,
      };
    }

    // Mass balance, one equality per finite-supply item:
    //   production - consumption + draw - surplus + deficit = demand
    // A finite positive cap is a bounded draw variable (0..cap), never a
    // forced injection: the LP pulls in only what the solution consumes, so an
    // unconsumed cap remainder produces neither phantom surplus nor recruited
    // consumers. The draw costs 0 in both passes (raw boundary draws are free,
    // so a capped draw is too); cap 0 emits no variable, keeping no-override
    // models identical to before. Where production and draw are cost-equal the
    // solve prefers the draw (use external supply first); a recipe-cost
    // override of 0 ties with the free draw and the pick is solver-arbitrary
    // (the lex pass ranks only recipes). Accepted corner.
    for (const it of items) {
      const supply = supplyById.get(it.id)!;
      if (supply === Infinity) continue;
      const cn = `mb_${it.id}`;
      constraints[cn] = { equal: demand.get(it.id) ?? 0 };
      for (const r of recipes) {
        const outQty = r.out.find((o) => o.item === it.id)?.qty ?? 0;
        const inQty = r.in.find((i) => i.item === it.id)?.qty ?? 0;
        const coef = outQty - inQty;
        if (coef !== 0) variables[`x_${r.id}`]![cn] = coef;
      }
      variables[`surplus_${it.id}`]![cn] = -1;
      variables[`deficit_${it.id}`]![cn] = 1;
      const cap = (supply as Fraction).valueOf();
      if (cap > 0) {
        variables[`draw_${it.id}`] = {
          objective: 0,
          [cn]: 1,
          [`drawcap_${it.id}`]: 1,
        };
        constraints[`drawcap_${it.id}`] = { max: cap };
      }
    }

    // Pass 2: freeze pass-1 cost as an upper bound (with a relative epsilon) so the
    // lex objective only reorders cost-optimal solutions.
    if (mode === "lex" && costCap !== undefined) {
      const capName = "cost_cap";
      // Relative tie-break slack, clamped at the top end. The relative term
      // keeps the cap epsilon proportional to the objective for normal plans,
      // but a large recipeCost override (or a huge big-M sum) inflates costCap
      // enough that the slack grows large enough to let pass-2 under-produce an
      // unrelated active recipe. Clamp at 1e-3 - the slack a 1e6 big-M costCap
      // already produces, clean at unit scale - so an override-inflated
      // objective cannot loosen the cap further; pass-2 then fails the cap and
      // the solve falls back to the cost-optimal pass-1 (handled at the call
      // site, where pass2.feasible === false keeps pass1).
      const capEps = Math.min(Math.max(Math.abs(costCap) * 1e-9, 1e-9), 1e-3);
      constraints[capName] = { max: costCap + capEps };
      for (const r of recipes) {
        const cost = costById.get(r.id)!;
        if (cost !== 0) variables[`x_${r.id}`]![capName] = cost;
      }
      for (const it of items) {
        variables[`surplus_${it.id}`]![capName] = SURPLUS_WEIGHT;
        variables[`deficit_${it.id}`]![capName] = DEFICIT_WEIGHT;
      }
    }

    return { optimize: "objective", opType: "min", constraints, variables };
  };

  const pass1 = solver.Solve(buildModel("primary")) as LpRaw;
  let lpResult: LpRaw;
  if (pass1.feasible === false || pass1.bounded === false) {
    // Infeasible or unbounded: skip the lex pass. A non-finite pass-1 objective
    // would corrupt the pass-2 cost cap, and the status gate below reads
    // pass1's feasible/bounded flags directly. (Unbounded can't happen for a valid
    // model: every objective coefficient is non-negative under a min objective, so
    // the optimum is bounded below by 0.)
    lpResult = pass1;
  } else {
    const costCap = pass1.result ?? 0;
    const pass2 = solver.Solve(buildModel("lex", costCap)) as LpRaw;
    // Enforce the cost cap the engine may not have. The lex pass must only
    // reorder cost-optimal solutions, so its true cost must EQUAL pass-1's. But
    // javascript-lp-solver polices the cost_cap and mass-balance rows with an
    // absolute 1e-8 tolerance against coefficients up to 1e9 (deficit) / 1e6
    // (big-M); on that unscaled spread it can admit a pass-2 that either pays a
    // big-M transfer above the cap (cost too HIGH) or leaves an equality row
    // unsatisfied without paying the deficit penalty (cost too LOW) - both drop a
    // real producer. Recompute pass-2's true primary objective and keep it only
    // when it matches pass-1's within tolerance; otherwise fall back to the
    // validated cost-optimal pass-1. Also covers "pass-2 numerically infeasible".
    const pass2Cost = primaryObjective(pass2, recipes, items, costById);
    const costTol = Math.max(Math.abs(costCap) * COST_REL_TOL, COST_REL_TOL);
    const pass2Valid =
      pass2.feasible !== false && Math.abs(pass2Cost - costCap) <= costTol;
    lpResult = pass2Valid ? pass2 : pass1;
    // Report pass-1's objective; pass-2's "result" is the lex tie-break.
    lpResult.result = costCap;
  }

  // Status gate: a failed solve leaves arbitrary partial variable values on the
  // raw result object, so extraction must not run on it. Return empty maps and
  // an honest softFeasible:false.
  if (lpResult.feasible === false || lpResult.bounded === false) {
    return {
      rates: new Map(),
      surplus: new Map(),
      deficit: new Map(),
      draws: new Map(),
      objectiveValue: lpResult.result ?? 0,
      solverWallClockMs: performance.now() - t0,
      status: lpResult.feasible === false ? "infeasible" : "unbounded",
      softFeasible: false,
    };
  }

  return extractResult({
    lpResult,
    pass1,
    recipes,
    items,
    recipeById,
    supplyById,
    costById,
    demand,
    targets,
    t0,
  });
}

// ---------------------------------------------------------------------------
// Post-solve extraction hygiene
// ---------------------------------------------------------------------------

// Constants for the extraction hygiene pass.
//  - SNAP_REL: snap radius for rational extraction. Applied relatively
//    (min(SNAP_REL, |v|*SNAP_REL)), so values >= 1 keep the historical 1e-6
//    absolute radius while sub-unit rates snap proportionally and survive with
//    their magnitude intact.
//  - RATE_ZERO: hard zero floor; raw primals at or below it are solver dust.
//  - NOISE_CEILING_REL: noise-sweep candidate ceiling relative to plan scale.
//    Deliberately decoupled from (two decades above) the snap radius: epsilon
//    chains exist precisely because they exceed the snap radius (1/900900).
//  - Mass-balance residuals use the shared REL_TOL declared above: residuals
//    the extraction leaves unreported must stay at or below what
//    checkMassBalance tags, which is why the gate reads the checkers' own
//    constant rather than a local copy that could drift above it.
//  - DEFICIT_MATERIAL_REL: materiality threshold for raw deficit variables,
//    relative to the item's demand.
const SNAP_REL = 1e-6;
const RATE_ZERO = 1e-12;
const NOISE_CEILING_REL = 1e-4;
const DEFICIT_MATERIAL_REL = 1e-9;

const FRAC_ZERO = new Fraction(0);

type ExtractArgs = {
  lpResult: LpRaw;
  pass1: LpRaw;
  recipes: Recipe[];
  items: RecipePack["items"];
  recipeById: Map<string, Recipe>;
  supplyById: Map<ItemId, Fraction | typeof Infinity>;
  costById: Map<RecipeId, number>;
  demand: Map<ItemId, number>;
  targets: ReadonlyArray<ItemTarget>;
  t0: number;
};

// Turn the raw float primals of a feasible solve into an exact, self-consistent
// LpResult. Ordered hygiene pass:
//   1. snap rates (pass-2 big-M filter, relative snap)
//   2. tentatively zero sub-noise rates (flow-blind candidate set)
//   3. recompute per-item slack exactly; re-admit whatever the checkers would
//      tag (in-pass checkMassBalance-tolerance gate)
//   4. derive surplus/deficit from the recompute and softFeasible from the raw
//      pre-snap deficit variables
function extractResult(args: ExtractArgs): LpResult {
  const {
    lpResult,
    pass1,
    recipes,
    items,
    recipeById,
    supplyById,
    costById,
    demand,
    targets,
    t0,
  } = args;

  // Exact demand per item: rational mirror of demandByItem (duplicate targets
  // accumulate). The model floats lose exactness; the slack recompute below
  // nets against these.
  const demandExact = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const rate = new Fraction(`${t.ratePerSec.num}/${t.ratePerSec.denom}`);
    demandExact.set(
      t.itemId,
      (demandExact.get(t.itemId) ?? FRAC_ZERO).add(rate),
    );
  }

  // Plan scale: the magnitude this plan operates at; sizes the noise ceiling.
  let planScale = 1;
  for (const d of demand.values()) planScale = Math.max(planScale, Math.abs(d));

  const plainSnap = (v: number): Fraction =>
    new Fraction(v).simplify(Math.min(SNAP_REL, Math.abs(v) * SNAP_REL));

  // Rate extraction. On pass-2 results, big-M recipes that pass 1 kept at zero
  // are dropped: the lex cost_cap row magnitude grows with target scale and
  // the solver's internal relative tolerance can buy them a tiny positive
  // rate, while a legitimate big-M activation (a sole producer of a demanded
  // item) forces pass-1 positivity too.
  const isPass2 = lpResult !== pass1;
  const rates = new Map<RecipeId, Fraction>();
  for (const r of recipes) {
    const v = lpResult[`x_${r.id}`] ?? 0;
    if (v <= RATE_ZERO) continue;
    if (
      isPass2 &&
      costById.get(r.id)! >= BIG_M_COST &&
      (pass1[`x_${r.id}`] ?? 0) <= RATE_ZERO
    ) {
      continue;
    }
    rates.set(r.id, plainSnap(v));
  }

  // Bounded boundary draws for finite positive caps. A raw primal within snap
  // radius of the cap snaps onto the exact cap Fraction (the draw commonly
  // saturates its bound, and the float must not round to a nearby rational);
  // anything else gets the plain relative snap. Zero draws are omitted. The
  // extracted draws join the exact slack recompute below, so the reported
  // rows close exactly against the reported draws.
  const draws = new Map<ItemId, Fraction>();
  for (const it of items) {
    const supply = supplyById.get(it.id)!;
    if (supply === Infinity) continue;
    const cap = supply as Fraction;
    const capValue = cap.valueOf();
    if (!(capValue > 0)) continue;
    const v = lpResult[`draw_${it.id}`] ?? 0;
    if (v <= RATE_ZERO) continue;
    if (Math.abs(v - capValue) <= Math.max(SNAP_REL, SNAP_REL * capValue)) {
      draws.set(it.id, cap);
    } else {
      draws.set(it.id, plainSnap(v));
    }
  }

  // Noise-sweep candidates: every positive rate at or below the ceiling,
  // regardless of graph connectivity (an epsilon chain can be anchored on a
  // live consumer). All candidates are tentatively zeroed; the repair loop
  // below re-admits exactly those whose removal breaks mass balance beyond
  // checker tolerance.
  const zeroed = new Set<RecipeId>();
  const ceiling = NOISE_CEILING_REL * planScale;
  for (const [recipeId, rate] of rates) {
    if (rate.valueOf() <= ceiling) zeroed.add(recipeId);
  }

  // Exact per-item slack over the active rates: production - consumption +
  // draw - demand. Mirror of the mb_ row built above (bounded-draw supply
  // semantics); a reformulation of the row must change this recompute in the
  // same commit.
  const computeSlack = (): Map<ItemId, Fraction> => {
    const net = new Map<ItemId, Fraction>();
    for (const [recipeId, rate] of rates) {
      if (zeroed.has(recipeId)) continue;
      const r = recipeById.get(recipeId)!;
      for (const o of r.out) {
        if (o.qty === 0) continue;
        net.set(o.item, (net.get(o.item) ?? FRAC_ZERO).add(rate.mul(o.qty)));
      }
      for (const i of r.in) {
        if (i.qty === 0) continue;
        net.set(i.item, (net.get(i.item) ?? FRAC_ZERO).sub(rate.mul(i.qty)));
      }
    }
    const slackByItem = new Map<ItemId, Fraction>();
    for (const it of items) {
      const supply = supplyById.get(it.id)!;
      if (supply === Infinity) continue;
      slackByItem.set(
        it.id,
        (net.get(it.id) ?? FRAC_ZERO)
          .add(draws.get(it.id) ?? FRAC_ZERO)
          .sub(demandExact.get(it.id) ?? FRAC_ZERO),
      );
    }
    return slackByItem;
  };

  // Material deficit: the raw pre-snap deficit variable is the honest signal
  // (the solver pays DEFICIT_WEIGHT per unit for it); snap- or sweep-induced
  // negative slack has a raw value of ~0.
  const hasMaterialRawDeficit = (itemId: ItemId): boolean => {
    const dv = lpResult[`deficit_${itemId}`] ?? 0;
    return (
      dv >
      Math.max(RATE_ZERO, DEFICIT_MATERIAL_REL * Math.max(1, demand.get(itemId) ?? 0))
    );
  };

  // checkMassBalance mirror: the residual tolerance the checkers tag at.
  const scaleFloor = toleranceScaleFloor(demand);
  const mbTol = (itemId: ItemId): number =>
    Math.max(scaleFloor, Math.abs(demand.get(itemId) ?? 0)) * REL_TOL;

  // Repair loop: zeroing candidates must not leave an item with a raw-clean
  // negative slack the checkers would tag. Re-admit zeroed producers of a
  // broken item (their removal caused the shortfall). The loop never grows the
  // zeroed set and each round shrinks it, so it terminates in at most |zeroed|
  // iterations.
  let slack = computeSlack();
  const forcedDeficit = new Set<ItemId>();
  for (;;) {
    const broken: ItemId[] = [];
    for (const [itemId, s] of slack) {
      if (s.compare(0) >= 0) continue;
      if (hasMaterialRawDeficit(itemId)) continue;
      if (Math.abs(s.valueOf()) < mbTol(itemId)) continue;
      broken.push(itemId);
    }
    if (broken.length === 0) break;
    const producesBroken = (recipeId: RecipeId): boolean => {
      const r = recipeById.get(recipeId)!;
      return r.out.some((o) => o.qty > 0 && broken.includes(o.item));
    };
    const readmit = [...zeroed].filter(producesBroken);
    if (readmit.length > 0) {
      for (const recipeId of readmit) zeroed.delete(recipeId);
      slack = computeSlack();
      continue;
    }
    // Nothing can close these rows: no producer to re-admit.
    // Report the shortfall honestly as a deficit (softFeasible goes false in the
    // surplus/deficit derivation below) instead of swallowing a broken row and
    // claiming the plan is feasible. The broken slack is negative by construction
    // here, so the derivation reports -slack as the deficit.
    for (const itemId of broken) forcedDeficit.add(itemId);
    if (import.meta.env.DEV) {
      console.warn(
        `solveLp extraction reporting unmet demand as deficit on: ${broken.join(", ")}`,
      );
    }
    break;
  }
  for (const recipeId of zeroed) rates.delete(recipeId);

  // The sweep can zero the only consumer of a finite-capped item, orphaning
  // its draw: the entry would report a pull the surviving solution never
  // consumes (violating the draws contract) and leak into surplus. Drop draws
  // on items no surviving recipe consumes, then refresh the slack the
  // surplus/deficit derivation below reads so the rows still close exactly.
  //
  // A draw on an item that carries external demand is NOT orphaned: it feeds
  // the target directly through the mb row (draw - demand), so it is kept.
  // Target items with a finite cap routinely reach this case: an external draw
  // of the target item counts toward meeting it. This also bounds the drop.
  // Post-drop slack on an item with no surviving consumer is production -
  // demand (the consumption term is zero by the drop condition, and the draw
  // is gone), so it can only go negative when demand > 0 - exactly the case
  // excluded here. The drop therefore can never create a shortfall the
  // (already-converged) repair loop would need to re-enter for.
  if (draws.size > 0) {
    const consumedItems = new Set<ItemId>();
    for (const recipeId of rates.keys()) {
      const r = recipeById.get(recipeId)!;
      for (const i of r.in) if (i.qty > 0) consumedItems.add(i.item);
    }
    let drawsDropped = false;
    for (const itemId of draws.keys()) {
      if (consumedItems.has(itemId)) continue;
      if (!(demandExact.get(itemId) ?? FRAC_ZERO).equals(0)) continue;
      draws.delete(itemId);
      drawsDropped = true;
    }
    if (drawsDropped) slack = computeSlack();
  }

  // Free-boundary target items (effectiveSupply === Infinity: raw:true, or a
  // plan:true non-raw item) carry no mass-balance row and no draw variable in
  // the model - their supply is unlimited and free, so the LP has nothing to
  // decide. But when such an item is itself a target, the demand is met by
  // pulling it in at the boundary, and the render layer needs that pull
  // reported. Account for it here as pure post-solve accounting:
  //   draw = demand - net production  (= demand + net consumption)
  // the exact amount the boundary must supply to net-export the item at its
  // rate on top of whatever running recipes consume. A non-positive result
  // means running recipes already net-produce the demand (boundary free
  // disposal absorbs the excess), so no draw is reported. Non-target
  // free-boundary items (demand 0) are skipped, leaving the raw-input draw path
  // untouched.
  for (const it of items) {
    if (supplyById.get(it.id) !== Infinity) continue;
    const demandIt = demandExact.get(it.id) ?? FRAC_ZERO;
    if (demandIt.equals(0)) continue;
    let net = FRAC_ZERO;
    for (const [recipeId, rate] of rates) {
      const r = recipeById.get(recipeId)!;
      for (const o of r.out) {
        if (o.qty !== 0 && o.item === it.id) net = net.add(rate.mul(o.qty));
      }
      for (const i of r.in) {
        if (i.qty !== 0 && i.item === it.id) net = net.sub(rate.mul(i.qty));
      }
    }
    const drawAmt = demandIt.sub(net);
    if (drawAmt.compare(0) > 0) draws.set(it.id, drawAmt);
  }

  // Surplus/deficit from the exact recompute, never from the raw slack
  // variables: the extracted point's rows then close exactly. A material raw
  // deficit surfaces as the recomputed shortfall (or, when the snapped rates
  // happen to cover it, as the snapped raw value so the unmet-demand signal
  // survives). Non-material negative slack is snap drift below every checker
  // tolerance (enforced by the repair loop) and reports neither.
  const surplus = new Map<ItemId, Fraction>();
  const deficit = new Map<ItemId, Fraction>();
  let softFeasible = true;
  for (const [itemId, s] of slack) {
    const material = hasMaterialRawDeficit(itemId);
    const forced = forcedDeficit.has(itemId);
    if (material || forced) softFeasible = false;
    if (s.compare(0) > 0) surplus.set(itemId, s);
    if (!material && !forced) continue;
    if (s.compare(0) < 0) {
      deficit.set(itemId, s.neg());
    } else if (material) {
      const df = plainSnap(lpResult[`deficit_${itemId}`] ?? 0);
      if (!df.equals(0)) deficit.set(itemId, df);
    }
  }

  return {
    rates,
    surplus,
    deficit,
    draws,
    objectiveValue: lpResult.result ?? 0,
    solverWallClockMs: performance.now() - t0,
    status: rates.size === 0 ? "empty" : "feasible",
    softFeasible,
  };
}
