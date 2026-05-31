import Fraction from "fraction.js";
import solver from "javascript-lp-solver";
import type { Recipe, RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId, ItemId } from "./types";
import { effectiveSupply } from "./effectiveSupply";

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
  objectiveValue: number;
  solverWallClockMs: number;
  // Solver outcome. "infeasible"/"unbounded" come straight from the raw solver
  // flags; "empty" means feasible but no recipe runs at a positive rate;
  // "feasible" means at least one recipe runs. softFeasible is false when any
  // material demand stays unmet (a deficit var survives the >1e-12 filter).
  status: "feasible" | "infeasible" | "unbounded" | "empty";
  softFeasible: boolean;
};

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

// Default cost weights. Relative ordering deficit >> recipe >> surplus is the
// cost contract. Synthetic and target-only recipes are pushed to a
// big-M cost so the LP only runs them when the user pins them or no alternative
// exists; they are sourced from three distinct pack signals.
export function recipeCostWeight(
  r: Recipe,
  overrides: Map<RecipeId, number> | undefined,
): number {
  // Clamp to non-negative: a negative override would make the objective reward
  // unbounded execution of this recipe. 0 means "run if useful, no cost".
  if (overrides?.has(r.id)) return Math.max(0, overrides.get(r.id)!);
  if (r.flags?.includes("target-only")) return 1e6;
  if (r.cost === -1) return 1e6;
  if (r.category === "__domain_transfer") return 1e6;
  return 1;
}

export function solveLp(input: LpInput): LpResult {
  const t0 = performance.now();
  const { targets, pack, itemOverrides = [] } = input;

  if (targets.length === 0) {
    return {
      rates: new Map(),
      surplus: new Map(),
      deficit: new Map(),
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

  // Effective supply per item. Infinity => free boundary; finite => fixed const.
  const supplyById = new Map<ItemId, Fraction | typeof Infinity>();
  for (const it of items) {
    supplyById.set(it.id, effectiveSupply(it.id, pack, itemOverrides));
  }

  // Demand per item: net-external demand on each target's primary output.
  const demand = new Map<ItemId, number>();
  for (const t of targets) {
    const recipe = pack.recipes.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.out.length === 0) continue;
    const primary = recipe.out[0]!;
    const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    demand.set(primary.item, (demand.get(primary.item) ?? 0) + rate);
  }

  // Lex rank per recipe (sorted by id) for the pass-2 tie-break.
  const lexRank = new Map<RecipeId, number>();
  recipes.forEach((r, i) => lexRank.set(r.id, i));

  // Two-pass deterministic solve.
  //  - "primary": minimize weighted recipe cost + soft surplus/deficit penalty.
  //  - "lex":     minimize recipe-id rank under a frozen cost cap, so the
  //               tie-break only reshuffles among cost-optimal solutions.
  const buildModel = (mode: "primary" | "lex", costCap?: number): LpModel => {
    const variables: LpModelVars = {};
    const constraints: LpModelConstraints = {};

    for (const r of recipes) {
      const cost = recipeCostWeight(r, input.recipeCosts);
      const rank = lexRank.get(r.id)!;
      variables[`x_${r.id}`] = { objective: mode === "primary" ? cost : rank };
    }

    for (const it of items) {
      variables[`surplus_${it.id}`] = { objective: mode === "lex" ? 0 : 1e-3 };
      variables[`deficit_${it.id}`] = { objective: mode === "lex" ? 0 : 1e9 };
    }

    // Mass balance, one equality per finite-supply item.
    for (const it of items) {
      const supply = supplyById.get(it.id)!;
      if (supply === Infinity) continue;
      const cn = `mb_${it.id}`;
      constraints[cn] = {
        equal: (demand.get(it.id) ?? 0) - (supply as Fraction).valueOf(),
      };
      for (const r of recipes) {
        const outQty = r.out.find((o) => o.item === it.id)?.qty ?? 0;
        const inQty = r.in.find((i) => i.item === it.id)?.qty ?? 0;
        const coef = outQty - inQty;
        if (coef !== 0) variables[`x_${r.id}`]![cn] = coef;
      }
      variables[`surplus_${it.id}`]![cn] = -1;
      variables[`deficit_${it.id}`]![cn] = 1;
    }

    // Target floor: x_target >= rate / primary.qty (min, NOT equality). A hard
    // equality over-constrains SCC-self targets (forces residual demand through
    // __domain_transfer recipes). The min floor preserves user-recipe intent
    // without blocking mass-balance from raising production to cover a cycle's
    // internal consumption.
    for (const t of targets) {
      const recipe = pack.recipes.find((r) => r.id === t.recipeId);
      if (!recipe || recipe.out.length === 0) continue;
      const primary = recipe.out[0]!;
      // Guard malformed data: a zero/negative primary qty makes the floor
      // rate/qty infinite or nonsensical. Skip the pin so unmet demand surfaces
      // as deficit rather than an infeasible Infinity bound.
      if (!(primary.qty > 0)) continue;
      const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
      const pinName = `pin_${t.recipeId}`;
      constraints[pinName] = { min: rate / primary.qty };
      variables[`x_${t.recipeId}`]![pinName] = 1;
    }

    // Pass 2: freeze pass-1 cost as an upper bound (with a relative epsilon) so
    // the lex objective only reorders among cost-optimal solutions.
    if (mode === "lex" && costCap !== undefined) {
      const capName = "cost_cap";
      const capEps = Math.max(Math.abs(costCap) * 1e-9, 1e-9);
      constraints[capName] = { max: costCap + capEps };
      for (const r of recipes) {
        const cost = recipeCostWeight(r, input.recipeCosts);
        if (cost !== 0) variables[`x_${r.id}`]![capName] = cost;
      }
      for (const it of items) {
        variables[`surplus_${it.id}`]![capName] = 1e-3;
        variables[`deficit_${it.id}`]![capName] = 1e9;
      }
    }

    return { optimize: "objective", opType: "min", constraints, variables };
  };

  const pass1 = solver.Solve(buildModel("primary")) as LpRaw;
  let lpResult: LpRaw;
  if (pass1.feasible === false) {
    lpResult = pass1;
  } else {
    const costCap = pass1.result ?? 0;
    const pass2 = solver.Solve(buildModel("lex", costCap)) as LpRaw;
    // If the lex pass fails numerically against the cost cap, keep the feasible
    // (cost-optimal) pass-1 solution rather than emitting empty result maps.
    lpResult = pass2.feasible === false ? pass1 : pass2;
    // Report pass-1's objective; pass-2's "result" is the lex tie-break.
    lpResult.result = costCap;
  }

  const rates = new Map<RecipeId, Fraction>();
  for (const r of recipes) {
    const v = lpResult[`x_${r.id}`] ?? 0;
    if (v > 1e-12) rates.set(r.id, new Fraction(v).simplify(1e-6));
  }

  const surplus = new Map<ItemId, Fraction>();
  const deficit = new Map<ItemId, Fraction>();
  for (const it of items) {
    const sv = lpResult[`surplus_${it.id}`] ?? 0;
    if (sv > 1e-12) surplus.set(it.id, new Fraction(sv).simplify(1e-6));
    const dv = lpResult[`deficit_${it.id}`] ?? 0;
    if (dv > 1e-12) deficit.set(it.id, new Fraction(dv).simplify(1e-6));
  }

  // Derive status from the chosen raw result. The solver feasible/bounded flags
  // take precedence; otherwise "empty" when no recipe runs at a positive rate
  // (same >1e-12 threshold used to build the rates map), else "feasible".
  let status: LpResult["status"];
  if (lpResult.feasible === false) {
    status = "infeasible";
  } else if (lpResult.bounded === false) {
    status = "unbounded";
  } else if (rates.size === 0) {
    status = "empty";
  } else {
    status = "feasible";
  }

  // softFeasible: no material demand left unmet. A surviving deficit entry (it
  // passed the >1e-12 filter above) means some item could not be supplied.
  const softFeasible = deficit.size === 0;

  return {
    rates,
    surplus,
    deficit,
    objectiveValue: lpResult.result ?? 0,
    solverWallClockMs: performance.now() - t0,
    status,
    softFeasible,
  };
}
