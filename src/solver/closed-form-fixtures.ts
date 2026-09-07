// Hand-authored closed-form fixtures. Each declares its expected answer in
// STC-native terms, derived by hand and independent of solveLp's output, so a
// systematically-wrong solver cannot pass by agreeing with itself. solveLp uses
// per-execution stoich; recipe `time` does NOT enter the mass balance, so
// expected rates are exec/sec.

import type { Item, Recipe, RecipePack, Stoich } from "@aef/schema";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";

export interface MicroRecipe {
  id: string;
  time: number;
  in: Record<string, number>;
  out: Record<string, number>;
  cost?: number;
  category?: string;
  catalyst?: Stoich[];
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
    ...(r.catalyst !== undefined ? { catalyst: r.catalyst } : {}),
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
    environmentBadges: { stable: "badge_stable", acidic: "badge_acidic" },
  } as RecipePack;
}

// game v1.4 added the gas-system machines. Suites whose witnesses were written
// against the pre-gas routes solve against the pack this returns: the same pack
// with every gas-machine recipe filtered out. Every other recipe is unchanged,
// so the pre-v1.4 plans reproduce exactly.
const GAS_MACHINES = new Set([
  "gas_pump_1",
  "gas_reactor_1",
  "phase_trans_1",
  "phase_trans_2",
]);

export function withoutGasMachines(p: RecipePack): RecipePack {
  return {
    ...p,
    recipes: p.recipes.filter(
      (r) => !r.producers.some((m) => GAS_MACHINES.has(m)),
    ),
  };
}

export interface ClosedFormFixture {
  name: string;
  targets: ItemTarget[];
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
  expected: {
    // True when no material demand is left unmet (no surviving deficit var).
    softFeasible: boolean;
    // Items expected to carry a deficit (only when softFeasible is false).
    deficitItems?: string[];
    // Closed-form shortfall per deficit item. When present the deficit map
    // must hold exactly these items at exactly these magnitudes.
    deficits?: { itemId: string; num: number; den: number }[];
    // Items expected to carry surplus (free disposal), closed-form value.
    surplus?: { itemId: string; num: number; den: number }[];
    // Per-recipe closed-form exec/sec, only when the solution is uniquely
    // determined (omitted for alternate-optima fixtures).
    rates?: { recipeId: string; num: number; den: number }[];
    // Balanced boundary draw per finite-capped item, closed-form. When present
    // the map must hold exactly these items: a listed empty array pins "no
    // draw at all".
    draws?: { itemId: string; num: number; den: number }[];
    // Catalyst draw per item (items/sec), closed-form. When present the map
    // must hold exactly these items.
    catalystDraw?: { itemId: string; num: number; den: number }[];
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
  targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
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
  targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
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
  targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
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
  targets: [{ itemId: "F", ratePerSec: { num: "3", denom: "1" } }],
  expected: { softFeasible: true, rates: [{ recipeId: "a", num: 3, den: 1 }] },
};

// Axis 5: cyclic target (2-cycle). make_F: M -> F; make_M: F -> M. No external
// source of M or F. The demand "net-export 1 F/sec" is unsatisfiable: the
// cycle recycles every unit of F into M, so no rate assignment yields positive
// net F. Running the cycle only adds recipe cost on top of the same deficit,
// so the cost-min optimum runs nothing and the shortfall lands as a deficit on
// the demanded item F. softFeasible=false (honest-infeasibility contract).
const cyclicTarget: ClosedFormFixture = {
  name: "cyclic-target",
  pack: makePack(
    [
      { id: "make_F", time: 1, in: { M: 1 }, out: { F: 1 } },
      { id: "make_M", time: 1, in: { F: 1 }, out: { M: 1 } },
    ],
    [{ id: "F", stack: 1 }, { id: "M", stack: 1 }],
  ),
  targets: [{ itemId: "F", ratePerSec: { num: "1", denom: "1" } }],
  expected: { softFeasible: false, deficitItems: ["F"] },
};

// Axis 6: structurally infeasible target (unsourceable input). a: 1 X -> 1 F.
// X has no producing recipe and is not raw, so running a just relocates the
// 1-unit deficit onto X while paying a's cost; the optimum runs nothing and
// the deficit lands on the demanded item F. softFeasible=false.
const noProducer: ClosedFormFixture = {
  name: "no-producer",
  pack: makePack(
    [{ id: "a", time: 1, in: { X: 1 }, out: { F: 1 } }],
    [{ id: "F", stack: 1 }, { id: "X", stack: 1 }],
  ),
  targets: [{ itemId: "F", ratePerSec: { num: "1", denom: "1" } }],
  expected: { softFeasible: false, deficitItems: ["F"] },
};

// ---------------------------------------------------------------------------
// Catalyst axes. A catalyst is cycled, not consumed: it never enters mass
// balance, but it is drawn from the boundary and shares its item's supply cap.
// Kept out of CLOSED_FORM_FIXTURES so the render corpora keep their pinned
// fixture set; the solver suite iterates this list on its own.
// ---------------------------------------------------------------------------

// Catalyst axis 1: uncapped catalyst item. a: 1 M -> 1 F, cycling 1/5 C per
// execution. C is raw with no override, so effectiveSupply is Infinity: no cap
// row exists and nothing throttles the draw. Target 2 F/sec => x_a = 2, and the
// catalyst draw is 2 * 1/5 = 2/5 C/sec.
const catalystUncapped: ClosedFormFixture = {
  name: "catalyst-uncapped",
  pack: makePack(
    [
      {
        id: "a",
        time: 1,
        in: { M: 1 },
        out: { F: 1 },
        catalyst: [{ item: "C", qty: 0.2 }],
      },
    ],
    [
      { id: "F", stack: 1 },
      { id: "M", raw: true, stack: 1 },
      { id: "C", raw: true, stack: 1 },
    ],
  ),
  targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
  expected: {
    softFeasible: true,
    rates: [{ recipeId: "a", num: 2, den: 1 }],
    draws: [],
    catalystDraw: [{ itemId: "C", num: 2, den: 5 }],
  },
};

// Catalyst axis 2: finite cap above the catalyst need, saturated exactly.
// a: 1 C -> 1 F cycling 1/5 C (cost 1); b: 1 R -> 1 F (cost 5, C-free).
// C is capped at 3/sec, so a's cap row reads draw_C + 1/5 x_a <= 3 while its
// mass balance still consumes 1 C per execution: x_a + 1/5 x_a <= 3 =>
// x_a <= 5/2. Target 3 F/sec: the cheap route runs at its ceiling 5/2 and the
// costly route covers the remaining 1/2. The cap saturates, so the balanced
// draw is cap minus catalyst use = 3 - 1/2 = 5/2, exactly.
const catalystCapSaturated: ClosedFormFixture = {
  name: "catalyst-cap-saturated",
  pack: makePack(
    [
      {
        id: "a",
        time: 1,
        in: { C: 1 },
        out: { F: 1 },
        catalyst: [{ item: "C", qty: 0.2 }],
      },
      { id: "b", time: 1, in: { R: 1 }, out: { F: 1 }, cost: 5 },
    ],
    [
      { id: "F", stack: 1 },
      { id: "C", raw: true, stack: 1 },
      { id: "R", raw: true, stack: 1 },
    ],
  ),
  itemOverrides: [{ itemId: "C", ratePerSec: { num: "3", denom: "1" } }],
  targets: [{ itemId: "F", ratePerSec: { num: "3", denom: "1" } }],
  expected: {
    softFeasible: true,
    rates: [
      { recipeId: "a", num: 5, den: 2 },
      { recipeId: "b", num: 1, den: 2 },
    ],
    draws: [{ itemId: "C", num: 5, den: 2 }],
    catalystDraw: [{ itemId: "C", num: 1, den: 2 }],
  },
};

// Catalyst axis 3: cap below the catalyst need. a: 1 M -> 1 F cycling 1 C, and
// C is capped at 1/2 C/sec with no producer. The cap row draw_C + x_a <= 1/2
// throttles a to 1/2 exec/sec; C never enters a's mass balance, so the whole
// cap goes to the catalyst and no balanced draw is reported. Target 1 F/sec
// leaves 1/2 F/sec unmet, reported honestly as a deficit on F.
const catalystCapShort: ClosedFormFixture = {
  name: "catalyst-cap-short",
  pack: makePack(
    [
      {
        id: "a",
        time: 1,
        in: { M: 1 },
        out: { F: 1 },
        catalyst: [{ item: "C", qty: 1 }],
      },
    ],
    [
      { id: "F", stack: 1 },
      { id: "M", raw: true, stack: 1 },
      { id: "C", raw: true, stack: 1 },
    ],
  ),
  itemOverrides: [{ itemId: "C", ratePerSec: { num: "1", denom: "2" } }],
  targets: [{ itemId: "F", ratePerSec: { num: "1", denom: "1" } }],
  expected: {
    softFeasible: false,
    deficitItems: ["F"],
    // 1 F/sec asked, 1/2 produced: the shortfall is exactly the half the
    // throttled catalyst could not fund.
    deficits: [{ itemId: "F", num: 1, den: 2 }],
    rates: [{ recipeId: "a", num: 1, den: 2 }],
    draws: [],
    catalystDraw: [{ itemId: "C", num: 1, den: 2 }],
  },
};

// Catalyst axis 4: cap 0 through `plan: true` on a raw item. effectiveSupply is
// Fraction(0), so the model emits no draw variable and no cap row: only a
// finite POSITIVE cap constrains a catalyst. The catalyst is still drawn and
// nothing is throttled. Target 2 F/sec => x_a = 2 and 2 C/sec cycled.
const catalystPlanned: ClosedFormFixture = {
  name: "catalyst-plan-true",
  pack: makePack(
    [
      {
        id: "a",
        time: 1,
        in: { M: 1 },
        out: { F: 1 },
        catalyst: [{ item: "C", qty: 1 }],
      },
    ],
    [
      { id: "F", stack: 1 },
      { id: "M", raw: true, stack: 1 },
      { id: "C", raw: true, stack: 1 },
    ],
  ),
  itemOverrides: [{ itemId: "C", plan: true }],
  targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
  expected: {
    softFeasible: true,
    rates: [{ recipeId: "a", num: 2, den: 1 }],
    draws: [],
    catalystDraw: [{ itemId: "C", num: 2, den: 1 }],
  },
};

export const CATALYST_FIXTURES: ClosedFormFixture[] = [
  catalystUncapped,
  catalystCapSaturated,
  catalystCapShort,
  catalystPlanned,
];

export const CLOSED_FORM_FIXTURES: ClosedFormFixture[] = [
  chain, multiProducer, byproduct, rawDraw, cyclicTarget, noProducer,
];

export const CYCLIC_TARGET_FIXTURE = cyclicTarget;
