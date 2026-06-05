// Hand-authored closed-form fixtures, adopted from prototype 001
// (tools/oracle/fixtures), stripped of all GLPK/FactorioLab fields. Each fixture
// declares its expected answer in STC-native terms, derived by hand and
// independent of solveLp's own output - so a systematically-wrong solver cannot
// pass by agreeing with itself. solveLp uses per-EXECUTION stoich; recipe `time`
// does NOT enter the mass balance, so expected rates are exec/sec.

import type { Item, Recipe, RecipePack, Stoich } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";

export interface MicroRecipe {
  id: string;
  time: number;
  in: Record<string, number>;
  out: Record<string, number>;
  cost?: number;
  category?: string;
}

export interface MicroItem {
  id: string;
  raw?: boolean;
  stack?: number;
}

function toStoich(m: Record<string, number>): Stoich[] {
  return Object.entries(m).map(([item, qty]) => ({ item, qty }));
}

export function makePack(recipes: MicroRecipe[], items: MicroItem[]): RecipePack {
  const recs: Recipe[] = recipes.map((r) => ({
    id: r.id,
    name: r.id,
    category: r.category ?? "cat",
    icon: r.id,
    row: 0,
    time: r.time,
    in: toStoich(r.in),
    out: toStoich(r.out),
    producers: ["machine"],
    ...(r.cost !== undefined ? { cost: r.cost } : {}),
  }));

  const its: Item[] = items.map((i) => ({
    id: i.id,
    name: i.id,
    category: "cat",
    icon: i.id,
    row: 0,
    raw: i.raw ?? false,
    transportKind: "belt",
    ...(i.stack !== undefined ? { stack: i.stack } : {}),
  }));

  return {
    schemaVersion: "0.2",
    source: { name: "micro", sourceRepo: "", sourceCommit: "", gameVersion: "", extractedAt: "" },
    categories: [{ id: "cat", name: "cat", icon: "cat" }],
    locations: [],
    items: its,
    machines: [
      { id: "machine", name: "machine", icon: "machine", speed: 1, powerType: "electric", powerKw: 1, hideRate: false },
    ],
    transports: [],
    recipes: recs,
  } as RecipePack;
}

export interface ClosedFormFixture {
  name: string;
  targets: Target[];
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
  expected: {
    // True when no material demand is left unmet (no surviving deficit var).
    softFeasible: boolean;
    // Items expected to carry a deficit (only when softFeasible is false).
    deficitItems?: string[];
    // Items expected to carry surplus (free disposal), closed-form value.
    surplus?: { itemId: string; num: number; den: number }[];
    // Per-recipe closed-form exec/sec, only when the solution is uniquely
    // determined (omitted for alternate-optima fixtures).
    rates?: { recipeId: string; num: number; den: number }[];
  };
}

// Axis 1: single-producer acyclic chain. R --b--> M --a--> F.
// b: 2 R -> 1 M (time 2); a: 1 M -> 1 F (time 1). Target 2 F/sec.
// F: a yields 1/exec => x_a = 2. M: x_b = x_a = 2. R free.
const chain: ClosedFormFixture = {
  name: "chain",
  pack: makePack(
    [
      { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
      { id: "b", time: 2, in: { R: 2 }, out: { M: 1 } },
    ],
    [{ id: "F", stack: 1 }, { id: "M", stack: 1 }, { id: "R", raw: true, stack: 1 }],
  ),
  targets: [{ recipeId: "a", ratePerSec: { num: "2", denom: "1" } }],
  expected: {
    softFeasible: true,
    rates: [
      { recipeId: "a", num: 2, den: 1 },
      { recipeId: "b", num: 2, den: 1 },
    ],
  },
};

// Axis 2: multi-producer intermediate (alternate optima). M from b1 (R) and b2
// (S); a: M -> F. Target 2 F/sec. x_a = 2 forced; M split b1/b2 not determined.
const multiProducer: ClosedFormFixture = {
  name: "multi-producer",
  pack: makePack(
    [
      { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
      { id: "b1", time: 1, in: { R: 1 }, out: { M: 1 } },
      { id: "b2", time: 1, in: { S: 1 }, out: { M: 1 } },
    ],
    [
      { id: "F", stack: 1 }, { id: "M", stack: 1 },
      { id: "R", raw: true, stack: 1 }, { id: "S", raw: true, stack: 1 },
    ],
  ),
  targets: [{ recipeId: "a", ratePerSec: { num: "2", denom: "1" } }],
  expected: { softFeasible: true },
};

// Axis 3: byproduct + free disposal. b: 1 R -> 1 F + 1 W. W has no consumer and
// is not raw, so it is dumped as surplus. Target 2 F/sec => x_b = 2, surplus W 2.
const byproduct: ClosedFormFixture = {
  name: "byproduct",
  pack: makePack(
    [{ id: "b", time: 1, in: { R: 1 }, out: { F: 1, W: 1 } }],
    [{ id: "F", stack: 1 }, { id: "W", stack: 1 }, { id: "R", raw: true, stack: 1 }],
  ),
  targets: [{ recipeId: "b", ratePerSec: { num: "2", denom: "1" } }],
  expected: {
    softFeasible: true,
    surplus: [{ itemId: "W", num: 2, den: 1 }],
    rates: [{ recipeId: "b", num: 2, den: 1 }],
  },
};

// Axis 4: boundary/raw drawn directly. a: 2 R -> 1 F (time 2). R raw.
// Target 3 F/sec => x_a = 3 exec/sec.
const rawDraw: ClosedFormFixture = {
  name: "raw-draw",
  pack: makePack(
    [{ id: "a", time: 2, in: { R: 2 }, out: { F: 1 } }],
    [{ id: "F", stack: 1 }, { id: "R", raw: true, stack: 1 }],
  ),
  targets: [{ recipeId: "a", ratePerSec: { num: "3", denom: "1" } }],
  expected: { softFeasible: true, rates: [{ recipeId: "a", num: 3, den: 1 }] },
};

// Axis 5: cyclic target (2-cycle). make_F: M -> F; make_M: F -> M. No external
// source of M or F. The target "1 F/sec" is UNSATISFIABLE: make_F pins at 1 to
// balance F demand, but its M input cannot be sourced, so the shortfall lands as
// a DEFICIT ON M. softFeasible=false. This is the STC-0005 ratified
// honest-infeasibility contract (spec item 4).
const cyclicTarget: ClosedFormFixture = {
  name: "cyclic-target",
  pack: makePack(
    [
      { id: "make_F", time: 1, in: { M: 1 }, out: { F: 1 } },
      { id: "make_M", time: 1, in: { F: 1 }, out: { M: 1 } },
    ],
    [{ id: "F", stack: 1 }, { id: "M", stack: 1 }],
  ),
  targets: [{ recipeId: "make_F", ratePerSec: { num: "1", denom: "1" } }],
  expected: { softFeasible: false, deficitItems: ["M"] },
};

// Axis 6: structurally infeasible target (no producer). a: 1 X -> 1 F. X has no
// producing recipe and is not raw => deficit on X, softFeasible=false.
const noProducer: ClosedFormFixture = {
  name: "no-producer",
  pack: makePack(
    [{ id: "a", time: 1, in: { X: 1 }, out: { F: 1 } }],
    [{ id: "F", stack: 1 }, { id: "X", stack: 1 }],
  ),
  targets: [{ recipeId: "a", ratePerSec: { num: "1", denom: "1" } }],
  expected: { softFeasible: false, deficitItems: ["X"] },
};

export const CLOSED_FORM_FIXTURES: ClosedFormFixture[] = [
  chain, multiProducer, byproduct, rawDraw, cyclicTarget, noProducer,
];

export const CYCLIC_TARGET_FIXTURE = cyclicTarget;
