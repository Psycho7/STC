import Fraction from "fraction.js";
import solver from "javascript-lp-solver";
import type { Recipe, RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import { effectiveSupply } from "./effectiveSupply";
import { isExcludedProducer } from "../data/recipe-category";

export type LpInput = {
  targets: Target[];
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
// only runs them when the user pins them or no alternative exists.
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

// Demand per item: sum over targets of the rate placed on each target recipe's
// primary output (recipe.out[0]). Duplicate targets on the same primary item
// accumulate. Shared with the invariant checkers so model and checks read demand
// the same way.
export function demandByItem(
  pack: RecipePack,
  targets: Target[],
): Map<ItemId, number> {
  const demand = new Map<ItemId, number>();
  for (const t of targets) {
    const recipe = pack.recipes.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.out.length === 0) continue;
    const primary = recipe.out[0]!;
    const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    demand.set(primary.item, (demand.get(primary.item) ?? 0) + rate);
  }
  return demand;
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
  const recipes = [...pack.recipes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const items = [...pack.items].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  // Effective supply per item. Infinity = free boundary; finite = fixed cap.
  const supplyById = new Map<ItemId, Fraction | typeof Infinity>();
  for (const it of items) {
    supplyById.set(it.id, effectiveSupply(it.id, pack, itemOverrides));
  }

  const demand = demandByItem(pack, targets);

  // Lex rank per recipe (sorted by id) for the pass-2 tie-break.
  const lexRank = new Map<RecipeId, number>();
  recipes.forEach((r, i) => lexRank.set(r.id, i));

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

    // Target floor: x_target >= rate / primary.qty (min, NOT equality). A hard
    // equality over-constrains SCC-self targets, forcing residual demand through
    // __domain_transfer recipes. The min floor keeps user-recipe intent without
    // blocking mass-balance from raising production to cover a cycle's internal
    // consumption.
    for (const t of targets) {
      const recipe = recipeById.get(t.recipeId);
      if (!recipe || recipe.out.length === 0) continue;
      const primary = recipe.out[0]!;
      // Guard malformed data: a zero/negative primary qty makes the floor
      // rate/qty infinite or nonsensical. Skip the pin so unmet demand surfaces as
      // deficit rather than an infeasible Infinity bound.
      if (!(primary.qty > 0)) continue;
      const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
      const pinName = `pin_${t.recipeId}`;
      // Accumulate the floor across duplicate targets on the same recipe rather
      // than overwriting, like the demand loop above sums duplicate target rates
      // onto the same primary item.
      const existingFloor = constraints[pinName]?.min ?? 0;
      constraints[pinName] = { min: existingFloor + rate / primary.qty };
      variables[`x_${t.recipeId}`]![pinName] = 1;

      // Surplus cap on the requested item. The floor above is one-sided, so a
      // co-product of the target recipe could subsidize over-running it to cover
      // another recipe's input, silently over-producing the headline item. Cap the
      // requested item's surplus to hold production at the requested rate, while
      // leaving the floor and mass-balance free to raise production for internal
      // consumption. eps is a small relative slack tied to this item's demand so
      // LP float noise does not make the equality model spuriously infeasible;
      // keep the larger eps when several targets share a primary item. eps stays
      // an order of magnitude below the invariant checkers' REL_TOL (1e-6) so a
      // surplus sitting at the cap never trips the mass-balance / targets-met
      // residual checks.
      const surpCap = `surpcap_${primary.item}`;
      const eps = Math.max(rate / primary.qty, 1) * 1e-7;
      const existingCap = constraints[surpCap]?.max ?? 0;
      constraints[surpCap] = { max: Math.max(existingCap, eps) };
      variables[`surplus_${primary.item}`]![surpCap] = 1;
    }

    // Pass 2: freeze pass-1 cost as an upper bound (with a relative epsilon) so the
    // lex objective only reorders cost-optimal solutions.
    if (mode === "lex" && costCap !== undefined) {
      const capName = "cost_cap";
      const capEps = Math.max(Math.abs(costCap) * 1e-9, 1e-9);
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
    // If the lex pass fails numerically against the cost cap, keep the feasible
    // cost-optimal pass-1 solution rather than emitting empty result maps.
    lpResult = pass2.feasible === false ? pass1 : pass2;
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
//  - MB_REL_TOL: mirror of the invariant checkers' REL_TOL. Residuals the
//    extraction leaves unreported must stay below what checkMassBalance tags.
//  - DEFICIT_MATERIAL_REL: materiality threshold for raw deficit variables,
//    relative to the item's demand.
const SNAP_REL = 1e-6;
const RATE_ZERO = 1e-12;
const NOISE_CEILING_REL = 1e-4;
const MB_REL_TOL = 1e-6;
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
  targets: Target[];
  t0: number;
};

// Turn the raw float primals of a feasible solve into an exact, self-consistent
// LpResult. Ordered hygiene pass:
//   1. snap rates (pass-2 big-M filter, exact pin-floor re-snap, relative snap)
//   2. tentatively zero sub-noise rates (flow-blind candidate set)
//   3. recompute per-item slack exactly; re-admit or revert whatever the
//      checkers would tag (in-pass checkMassBalance-tolerance gate)
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

  // Exact pin floor per recipe and exact demand per item: rational mirrors of
  // the pin block and demandByItem (same skip rules, duplicate targets
  // accumulate). The model floats lose exactness; extraction snaps back onto
  // these.
  const floorByRecipe = new Map<RecipeId, Fraction>();
  const demandExact = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const recipe = recipeById.get(t.recipeId);
    if (!recipe || recipe.out.length === 0) continue;
    const primary = recipe.out[0]!;
    const rate = new Fraction(`${t.ratePerSec.num}/${t.ratePerSec.denom}`);
    demandExact.set(
      primary.item,
      (demandExact.get(primary.item) ?? FRAC_ZERO).add(rate),
    );
    if (!(primary.qty > 0)) continue;
    const floor = rate.div(primary.qty);
    if (floor.compare(0) <= 0) continue;
    floorByRecipe.set(
      t.recipeId,
      (floorByRecipe.get(t.recipeId) ?? FRAC_ZERO).add(floor),
    );
  }

  // Plan scale: the magnitude this plan operates at; sizes the noise ceiling.
  let planScale = 1;
  for (const f of floorByRecipe.values())
    planScale = Math.max(planScale, f.valueOf());
  for (const d of demand.values()) planScale = Math.max(planScale, Math.abs(d));

  const plainSnap = (v: number): Fraction =>
    new Fraction(v).simplify(Math.min(SNAP_REL, Math.abs(v) * SNAP_REL));

  // Rate extraction. A pinned recipe within radius of its exact floor snaps
  // onto the floor itself: the raw float can otherwise round to an adjacent
  // rational (1/1499 against a 1/1500 floor). On pass-2 results, big-M recipes
  // that pass 1 kept at zero are dropped: the lex cost_cap row magnitude grows
  // with target scale and the solver's internal relative tolerance can buy
  // them a tiny positive rate, while a legitimate big-M activation (a pin)
  // forces pass-1 positivity too.
  const isPass2 = lpResult !== pass1;
  const rates = new Map<RecipeId, Fraction>();
  const floorSnapped = new Set<RecipeId>();
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
    const floor = floorByRecipe.get(r.id);
    if (
      floor !== undefined &&
      Math.abs(v - floor.valueOf()) <=
        Math.max(SNAP_REL, SNAP_REL * Math.abs(v))
    ) {
      rates.set(r.id, floor);
      floorSnapped.add(r.id);
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
  // live consumer), except pinned recipes, whose floors are user intent. All
  // candidates are tentatively zeroed; the repair loop below re-admits exactly
  // those whose removal breaks mass balance beyond checker tolerance.
  const zeroed = new Set<RecipeId>();
  const ceiling = NOISE_CEILING_REL * planScale;
  for (const [recipeId, rate] of rates) {
    if (floorByRecipe.has(recipeId)) continue;
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
    Math.max(scaleFloor, Math.abs(demand.get(itemId) ?? 0)) * MB_REL_TOL;

  // Repair loop: zeroing candidates (or snapping a pin) must not leave an item
  // with a raw-clean negative slack the checkers would tag. First re-admit
  // zeroed producers of a broken item (their removal caused the shortfall),
  // then revert floor snaps on its producers to the plain relative snap. The
  // loop never grows either set and each round shrinks exactly one of them,
  // so it terminates in at most |zeroed| + |floorSnapped| iterations.
  let slack = computeSlack();
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
    const reverts = [...floorSnapped].filter(producesBroken);
    if (reverts.length > 0) {
      for (const recipeId of reverts) {
        floorSnapped.delete(recipeId);
        rates.set(recipeId, plainSnap(lpResult[`x_${recipeId}`] ?? 0));
      }
      slack = computeSlack();
      continue;
    }
    // Nothing left to repair with: leave the residual unreported, no worse
    // than the pre-hygiene extraction.
    if (import.meta.env.DEV) {
      console.warn(
        `solveLp extraction left residuals beyond checker tolerance on: ${broken.join(", ")}`,
      );
    }
    break;
  }
  for (const recipeId of zeroed) rates.delete(recipeId);

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
    if (material) softFeasible = false;
    if (s.compare(0) > 0) surplus.set(itemId, s);
    if (!material) continue;
    if (s.compare(0) < 0) {
      deficit.set(itemId, s.neg());
    } else {
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
