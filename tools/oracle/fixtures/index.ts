// Phase-0 gate fixtures: hand-authored micro-packs, EACH with a closed-form
// expected answer declared here, independent of either solver. The gate
// (gate.test.ts) asserts STC's result AND GLPK's result each match the
// declared truth -- not merely that the two solvers agree.
//
// Axes (PROTOTYPE-001 section 5):
//   1 chain            - single-producer acyclic chain
//   2 multi-producer   - an intermediate item with two producers (alt-optima)
//   3 byproduct        - byproduct + free disposal (surplus dumped)
//   4 raw-draw         - boundary/raw item drawn directly by a recipe
//   5 cyclic-target    - target on a recipe inside a 2-cycle
//   6 no-producer      - structurally infeasible target (input has no producer)
//   7 unbounded        - NOT CONSTRUCTIBLE in this model; see note below.
//
// Units fix (#2): expected per-recipe exec/sec is STC's rate; the expected
// FactorioLab machine count = exec/sec * recipe.time. All chain/raw fixtures
// use time != 1 on at least one recipe so the conversion is exercised, except
// where the closed form is clearer at time=1 (documented per fixture).

import type { Scenario, Verdict } from "../compare";
import { makePack } from "./pack";

export interface ExpectedRate {
  recipeId: string;
  // closed-form exec/sec as a num/den pair (exact).
  num: number;
  den: number;
  // closed-form FactorioLab machine count = exec/sec * time, num/den.
  machinesNum: number;
  machinesDen: number;
}

export interface Fixture {
  axis: string;
  scenario: Scenario;
  // Closed-form expected answer, declared independently of any solver.
  expected: {
    verdict: Verdict; // satisfiable | unsatisfiable | infeasible-hard
    targetMet: boolean;
    // Whether the active solution is uniquely determined (Tier-2 eligible).
    unique: boolean;
    // Forced active recipe set (only meaningful when unique).
    activeSet?: string[];
    // Per-recipe closed-form rates (only when unique).
    rates?: ExpectedRate[];
    // Items expected to carry surplus (free disposal), closed-form value.
    surplus?: { itemId: string; num: number; den: number }[];
    // Items expected to carry an STC deficit (target not satisfiable).
    deficitItems?: string[];
  };
  // When set, the axis is known to diverge from one solver and is EXCLUDED from
  // the whitelist. The gate records the divergence rather than forcing it away.
  exclude?: {
    reason: string;
    classification:
      | "structural-formulation-flaw"
      | "localized-fix"
      | "adapter-artifact"
      | "modeling-difference";
  };
}

// --- Axis 1: single-producer acyclic chain ------------------------------
// raw R --b--> M --a--> F.  b: 2 R -> 1 M (time 2);  a: 1 M -> 1 F (time 1).
// Target: 2 F/sec.  STC's variable is exec/sec and its mass balance uses
// per-EXECUTION stoich (time does NOT enter the balance):
//   F demand 2/sec, a yields 1 F/exec => x_a = 2 exec/sec.
//   M: a consumes 1/exec, b yields 1/exec => x_b = x_a = 2 exec/sec.  (R free.)
// FactorioLab machines = exec/sec * time:  a = 2*1 = 2;  b = 2*2 = 4.
// The units fix (#2) reconciles them: machines_b/time_b = 4/2 = 2 = x_b.
const chain: Fixture = {
  axis: "chain",
  scenario: {
    name: "chain",
    pack: makePack(
      [
        { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
        { id: "b", time: 2, in: { R: 2 }, out: { M: 1 } },
      ],
      [{ id: "F", stack: 1 }, { id: "M", stack: 1 }, { id: "R", raw: true, stack: 1 }],
    ),
    // Item target: F is produced only by recipe "a", so demand on F forces a
    // (and, transitively, b). Item-shaped targets ({itemId, ratePerSec}) let
    // the LP pick producers by cost; here F has a single producer, so the
    // closed form is unchanged from the old recipe-pinned form.
    targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
  },
  expected: {
    verdict: "satisfiable",
    targetMet: true,
    unique: true,
    activeSet: ["a", "b"],
    rates: [
      { recipeId: "a", num: 2, den: 1, machinesNum: 2, machinesDen: 1 },
      { recipeId: "b", num: 2, den: 1, machinesNum: 4, machinesDen: 1 },
    ],
  },
};

// --- Axis 2: multi-producer intermediate --------------------------------
// M produced by b1 (R->M) and b2 (S->M); a: M -> F (single producer of F).
// Target 2 F/sec.  x_a = 2 forced; M demand 2/sec split between b1,b2 is NOT
// determined => alternate optima.  Both solvers satisfiable + target met.
const multiProducer: Fixture = {
  axis: "multi-producer",
  scenario: {
    name: "multi-producer",
    pack: makePack(
      [
        { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
        { id: "b1", time: 1, in: { R: 1 }, out: { M: 1 } },
        { id: "b2", time: 1, in: { S: 1 }, out: { M: 1 } },
      ],
      [
        { id: "F", stack: 1 },
        { id: "M", stack: 1 },
        { id: "R", raw: true, stack: 1 },
        { id: "S", raw: true, stack: 1 },
      ],
    ),
    // Target the item F (single producer a). The multi-producer split is on
    // the intermediate M, so both solvers meet F via a and are free on the M
    // split -> alternate optima.
    targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
  },
  expected: {
    verdict: "satisfiable",
    targetMet: true,
    unique: false, // M has two producers -> not Tier-2 eligible
  },
};

// --- Axis 3: byproduct + free disposal ----------------------------------
// b: 1 R -> 1 F + 1 W (time 1).  W has no consumer and is not raw, so it must
// be dumped as surplus.  Target 2 F/sec => x_b = 2, surplus W = 2/sec.
const byproduct: Fixture = {
  axis: "byproduct",
  scenario: {
    name: "byproduct",
    pack: makePack(
      [{ id: "b", time: 1, in: { R: 1 }, out: { F: 1, W: 1 } }],
      [
        { id: "F", stack: 1 },
        { id: "W", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    ),
    // Target item F (primary output of b). b also emits W, which has no
    // consumer and is not raw, so it is dumped as surplus.
    targets: [{ itemId: "F", ratePerSec: { num: "2", denom: "1" } }],
  },
  expected: {
    verdict: "satisfiable",
    targetMet: true,
    unique: false, // free-disposal var active -> not Tier-2 eligible
    activeSet: ["b"],
    surplus: [{ itemId: "W", num: 2, den: 1 }],
  },
};

// --- Axis 4: boundary/raw item drawn directly ---------------------------
// a: 2 R -> 1 F (time 2).  R raw.  Target 3 F/sec => x_a = 3 exec/sec.
// Machines = 3 * 2 = 6.  Unique (R is a boundary supply, exempt).
const rawDraw: Fixture = {
  axis: "raw-draw",
  scenario: {
    name: "raw-draw",
    pack: makePack(
      [{ id: "a", time: 2, in: { R: 2 }, out: { F: 1 } }],
      [{ id: "F", stack: 1 }, { id: "R", raw: true, stack: 1 }],
    ),
    // Item target F (single producer a, which draws raw R directly).
    targets: [{ itemId: "F", ratePerSec: { num: "3", denom: "1" } }],
  },
  expected: {
    verdict: "satisfiable",
    targetMet: true,
    unique: true,
    activeSet: ["a"],
    rates: [{ recipeId: "a", num: 3, den: 1, machinesNum: 6, machinesDen: 1 }],
  },
};

// --- Axis 5: cyclic target (2-cycle) ------------------------------------
// make_F: M -> F;  make_M: F -> M.  Pure 2-cycle, no external source of M or F.
// Closed-form: you cannot net-produce F (every F made consumes an M that needs
// an F), so the target "1 F/sec" is UNSATISFIABLE as stated.
//
// PREMISE UPDATED for the item-target model: the old fixture pinned the recipe
// make_F (recipe target), which forced make_F=1 and parked the shortfall as a
// deficit on M. The solver no longer pins a recipe; it meets item demand and
// minimizes cost. With demand on F and no way to net-produce it (the cycle
// recycles its own output), the cost-min optimum runs NOTHING and parks the
// full demand as a DEFICIT ON THE TARGET ITEM F (running the cycle only adds
// recipe cost on top of the same unavoidable shortfall). This matches the
// current corpus's own 2-cycle golden (src/solver/corpus.ts domainTransferScc:
// deficit on the demanded item, status "empty", no active recipes). STC returns
// softFeasible=false with that surviving F deficit; GLPK (no deficit var, F is
// producible so not free-supplied) returns a non-Solved result. Both map to
// "unsatisfiable" via the taxonomy.
const cyclicTarget: Fixture = {
  axis: "cyclic-target",
  scenario: {
    name: "cyclic-target",
    pack: makePack(
      [
        { id: "make_F", time: 1, in: { M: 1 }, out: { F: 1 } },
        { id: "make_M", time: 1, in: { F: 1 }, out: { M: 1 } },
      ],
      [{ id: "F", stack: 1 }, { id: "M", stack: 1 }],
    ),
    targets: [{ itemId: "F", ratePerSec: { num: "1", denom: "1" } }],
  },
  expected: {
    verdict: "unsatisfiable",
    targetMet: false,
    unique: false,
    deficitItems: ["F"],
  },
};

// --- Axis 6: structurally infeasible target (no producer) ---------------
// a: 1 X -> 1 F (time 1).  X has NO producing recipe and is not raw.
// Closed-form: F is unsatisfiable (X cannot be sourced). STC returns
// softFeasible=false with a surviving deficit (on X and/or the target F,
// depending on where the flat-edge cost-min lands -- not asserted here). GLPK
// treats any no-producer item as `unproduceable` free supply, so it SOLVES and
// reports the target met -- a divergence from closed-form truth. The axis is
// therefore EXCLUDED from the whitelist; classification = adapter-artifact
// (FactorioLab's unproduceable-free-supply default has no analogue in STC's
// deficit model). Excluded axes only assert STC unsatisfiable + solvers
// disagree; deficitItems below is not checked for an excluded axis.
const noProducer: Fixture = {
  axis: "no-producer",
  scenario: {
    name: "no-producer",
    pack: makePack(
      [{ id: "a", time: 1, in: { X: 1 }, out: { F: 1 } }],
      [{ id: "F", stack: 1 }, { id: "X", stack: 1 }],
    ),
    targets: [{ itemId: "F", ratePerSec: { num: "1", denom: "1" } }],
  },
  expected: {
    verdict: "unsatisfiable",
    targetMet: false,
    unique: false,
    deficitItems: ["X"],
  },
  exclude: {
    reason:
      "FactorioLab models any no-producer item as a free `unproduceable` supply, so the target STC deems unsatisfiable (deficit on X) solves in GLPK. The two solvers disagree because of FactorioLab's free-supply default, not because either solves the wrong LP.",
    classification: "adapter-artifact",
  },
};

export const FIXTURES: Fixture[] = [
  chain,
  multiProducer,
  byproduct,
  rawDraw,
  cyclicTarget,
  noProducer,
];

// Axis 7 (unbounded): MANDATORY to attempt. Under this model an unbounded LP is
// NOT constructible. STC minimizes a sum of non-negative-cost variables (recipe
// costs >= 0, surplus/deficit weights > 0), so the objective is bounded below by
// 0 for any feasible problem -- STC's own lp.ts comments note unbounded is
// unreachable. The adapter feeds GLPK a `min` model whose only negative-cost
// variable is `maximize` (cost -1e6), and that variable exists only when a
// Maximize objective is present; the adapter never emits one (STC has no
// maximize concept). With no negative-cost variable and all recipe vars bounded
// below at 0, GLPK is likewise bounded. Therefore the unbounded status mapping
// CANNOT be validated on a constructed fixture in this model; it is recorded as
// UNVERIFIED in STATUS-MAP.md. (Documented per PLAN-001 T4 acceptance.)
export const UNBOUNDED_CONSTRUCTIBLE = false;
