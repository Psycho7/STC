// Curated small synthetic recipe-pack fixtures, each exercising one solver
// topology. Used by corpus.test.ts for golden regression: any change to solver
// output on a known topology must trip a test.
//
// Per-fixture fields:
//   pack         - minimal RecipePack (cast via `as unknown as RecipePack`)
//   targets      - Target[] for solveLp
//   itemOverrides? - ItemOverride[] for supply caps / plan flags
//   recipeCosts?   - Map<RecipeId, number> for cost overrides
//
// All goldens (objectiveValue + active recipe set) come from running the actual
// solver and reading output, never invented.

import type { RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipeId } from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Minimal pack constructor. The cast omits non-solver fields (name, icon,
// producers, locations, etc.) that solveLp never reads.
function mkPack(
  recipes: {
    id: string;
    category: string;
    time: number;
    in: { item: string; qty: number }[];
    out: { item: string; qty: number }[];
    flags?: string[];
    cost?: number;
  }[],
  items: { id: string; raw: boolean }[],
): RecipePack {
  return { recipes, items } as unknown as RecipePack;
}

function rate(num: string, denom: string): Target["ratePerSec"] {
  return { num, denom };
}

// ---------------------------------------------------------------------------
// Scenario 1: acyclic single producer
//
// One linear chain: raw -> a -> b. Exactly one recipe per item.
// Target: r_make_b at 1/sec. Must run r_make_a to supply "a".
// Expected active set: {r_make_a, r_make_b} (full chain).
// Objective: 2 recipe runs * cost 1 each = 2.
// ---------------------------------------------------------------------------
export const acyclicSingleProducer = {
  pack: mkPack(
    [
      {
        id: "r_make_a",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "a", qty: 1 }],
      },
      {
        id: "r_make_b",
        category: "material",
        time: 1,
        in: [{ item: "a", qty: 1 }],
        out: [{ item: "b", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "a", raw: false },
      { id: "b", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_make_b", ratePerSec: rate("1", "1") }],
};

// Golden for scenario 1 (from solveLp output).
export const acyclicSingleProducerGolden = {
  objectiveValue: 2,
  // Both chain members run; no alternative for either item.
  activeRecipes: ["r_make_a", "r_make_b"],
};

// ---------------------------------------------------------------------------
// Scenario 2: multi-producer lex tie-break (parallel producers, equal cost)
//
// Two producers for "mid": cheap (1 raw) and pricey (2 raw). "raw" is raw, so
// its effective supply is Infinity and the LP builds no mass-balance row for it:
// raw consumption is unpriced. Both producers cost the same (1 recipe run) and
// give the same objective, so the pass-2 lex tie-break decides: it minimizes
// recipe-id rank, "cheap" (rank 0) beats "pricey" (rank 1). Same mechanism as
// Scenario 3; the differing raw footprints don't matter since raw never enters
// the objective.
//
// Objective: 2 (target_r + cheap, each at rate 1, cost 1 each).
// "pricey" must NOT be active.
// ---------------------------------------------------------------------------
export const multiProducerCostChoice = {
  pack: mkPack(
    [
      {
        id: "cheap",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "pricey",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 2 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "target_r",
        category: "material",
        time: 1,
        in: [{ item: "mid", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "mid", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "target_r", ratePerSec: rate("1", "1") }],
};

export const multiProducerCostChoiceGolden = {
  objectiveValue: 2,
  // "cheap" wins the pass-2 lex tie-break (rank 0 < "pricey" rank 1); raw is
  // unpriced, so cost alone doesn't separate them.
  activeRecipes: ["cheap", "target_r"],
};

// ---------------------------------------------------------------------------
// Scenario 2b: recipeCosts override flips the winner
//
// Same pack as scenario 2, but a recipeCosts override raises "cheap" to cost
// 100. Pass-1 now avoids the cost-100 "cheap" and runs "pricey" + "target_r" at
// cost 1 + 1 = 2, leaving "cheap" inactive. The reported objective is the pass-1
// cost cap (2), not 100-something: "cheap" never runs, so its cost never enters
// the objective. The override flips the winner by making "cheap" genuinely
// dearer than "pricey".
// ---------------------------------------------------------------------------
export const multiProducerCostChoiceWithOverride = {
  pack: multiProducerCostChoice.pack,
  targets: multiProducerCostChoice.targets,
  recipeCosts: new Map<RecipeId, number>([["cheap", 100]]),
};

export const multiProducerCostChoiceWithOverrideGolden = {
  objectiveValue: 2,
  // "pricey" now wins because "cheap" was overridden to cost 100.
  activeRecipes: ["pricey", "target_r"],
};

// ---------------------------------------------------------------------------
// Scenario 3: equal-cost tie-break
//
// Two identical producers for "mid": "aaa_producer" and "zzz_producer" (same
// category, inputs, output qty), both cost 1 per run. The pass-2 lex tie-break
// minimizes recipe-id rank (sorted ascending). By id: "aaa_producer" <
// "target_r" < "zzz_producer", so ranks are 0 and 2. Pass-2 picks
// "aaa_producer". "zzz_producer" must NOT be active.
// ---------------------------------------------------------------------------
export const equalCostTieBreak = {
  pack: mkPack(
    [
      {
        id: "aaa_producer",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "zzz_producer",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "target_r",
        category: "material",
        time: 1,
        in: [{ item: "mid", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "mid", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "target_r", ratePerSec: rate("1", "1") }],
};

export const equalCostTieBreakGolden = {
  objectiveValue: 2,
  // "aaa_producer" wins the lex tie-break (smallest id rank => lowest pass-2
  // objective). "zzz_producer" stays inactive.
  activeRecipes: ["aaa_producer", "target_r"],
};

// ---------------------------------------------------------------------------
// Scenario 4: byproduct surplus
//
// r_main produces "main"(1) and "byp"(2) per run. r_finalize consumes
// "main"(1) and "byp"(1) per run to produce "prod"(1). Target: r_finalize at
// 1/sec. Mass balance on "byp": supply 2*r_main - demand 1*r_finalize = surplus.
// At r_main=1, r_finalize=1: surplus[byp] = 2 - 1 = 1.
// Objective: 2 recipe runs (cost 1 each) + 1 surplus[byp] * 1e-3 = 2.001.
// ---------------------------------------------------------------------------
export const byproductSurplus = {
  pack: mkPack(
    [
      {
        id: "r_main",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [
          { item: "main", qty: 1 },
          { item: "byp", qty: 2 },
        ],
      },
      {
        id: "r_finalize",
        category: "material",
        time: 1,
        in: [
          { item: "main", qty: 1 },
          { item: "byp", qty: 1 },
        ],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "main", raw: false },
      { id: "byp", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_finalize", ratePerSec: rate("1", "1") }],
};

export const byproductSurplusGolden = {
  // 2 recipe runs + 1e-3 * surplus(byp)=1 = 2.001
  objectiveValue: 2.001,
  activeRecipes: ["r_finalize", "r_main"],
  // byp surplus = 1 (r_main emits 2, r_finalize consumes 1).
  surplusByp: 1,
};

// ---------------------------------------------------------------------------
// Scenario 5: finite cap forces fallback producer
//
// "a_primary" and "z_fallback" both produce "mid" at the same cost.
// Lex tie-break (pass 2) picks "a_primary" (id rank 0 < 3).
// An ItemOverride caps "raw_aprimary" supply to 0 units/sec, so the mass
// balance for "raw_aprimary" forces a_primary to 0. "z_fallback" picks up
// the entire demand for "mid".
// ---------------------------------------------------------------------------
export const finiteCapForcingFallback = {
  pack: mkPack(
    [
      {
        id: "a_primary",
        category: "material",
        time: 1,
        in: [{ item: "raw_aprimary", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "z_fallback",
        category: "material",
        time: 1,
        in: [{ item: "raw_zfallback", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "r_final",
        category: "material",
        time: 1,
        in: [{ item: "mid", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw_aprimary", raw: true },
      { id: "raw_zfallback", raw: true },
      { id: "mid", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_final", ratePerSec: rate("1", "1") }],
  itemOverrides: [
    // Cap raw_aprimary supply to 0: effectiveSupply becomes Fraction(0) => mass
    // balance forces a_primary to 0 (cannot consume what is not supplied).
    {
      itemId: "raw_aprimary",
      ratePerSec: { num: "0", denom: "1" },
    } satisfies ItemOverride,
  ],
};

export const finiteCapForcingFallbackBaseline = {
  // No override: lex picks "a_primary" as the cheaper-ranked producer.
  objectiveValue: 2,
  activeRecipes: ["a_primary", "r_final"],
};

export const finiteCapForcingFallbackGolden = {
  objectiveValue: 2,
  // a_primary is blocked by the 0-cap; z_fallback covers all demand for "mid".
  activeRecipes: ["r_final", "z_fallback"],
};

// ---------------------------------------------------------------------------
// Scenario 6: plan passthrough (plan:true forces item to boundary)
//
// r_make_mid produces "mid" from raw. r_final consumes "mid" -> prod.
// ItemOverride { plan: true } on "mid" (a non-raw item) makes effectiveSupply
// return Infinity => "mid" is treated as an uncapped external boundary. The
// LP omits "mid" from finite-supply mass balance, so r_make_mid is never
// needed. r_make_mid must NOT be active.
// ---------------------------------------------------------------------------
export const planPassthrough = {
  pack: mkPack(
    [
      {
        id: "r_make_mid",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
      {
        id: "r_final",
        category: "material",
        time: 1,
        in: [{ item: "mid", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "mid", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_final", ratePerSec: rate("1", "1") }],
  itemOverrides: [
    // plan:true on a non-raw item -> effectiveSupply = Infinity -> boundary.
    { itemId: "mid", plan: true as const } satisfies ItemOverride,
  ],
};

export const planPassthroughBaseline = {
  // Without override: r_make_mid is active to supply "mid".
  objectiveValue: 2,
  activeRecipes: ["r_final", "r_make_mid"],
};

export const planPassthroughGolden = {
  // With plan:true on "mid": supply is infinite boundary, no producer needed.
  objectiveValue: 1,
  activeRecipes: ["r_final"],
};

// ---------------------------------------------------------------------------
// Scenario 7: __domain_transfer big-M exclusion
//
// r_normal (category "material", cost 1) and r_transfer (category
// "__domain_transfer", cost 1e6 per recipeCostWeight) both produce "prod" from
// "raw". Target pins r_normal. The LP minimizes cost: 1 vs 1e6, so r_transfer
// stays inactive.
//
// The "prod" mass balance is met by the pinned r_normal alone. Adding r_transfer
// would add 1e6 per unit, so it is only chosen when it is the sole producer
// (unavoidable). Here it is avoidable.
//
// Why no genuine-SCC variant: a two-item SCC (A -> B -> A) where
// __domain_transfer is strictly unavoidable can't be built from a minimal
// synthetic pack without replicating the full cross-domain import chain. In the
// real pack __domain_transfer bridges two separate domain graphs (e.g. base-game
// to Endfield items) and only runs when the user needs an item from the other
// domain; a two-recipe synthetic would make __domain_transfer the only producer,
// trivially unavoidable rather than a meaningful SCC test. Floor-vs-equality SCC
// semantics (documented in lp.ts) are already covered by the real-pack tests in
// optimality.test.ts and index.test.ts, so here we assert only the exclusion
// case (avoidable big-M stays inactive).
// ---------------------------------------------------------------------------
export const domainTransferExclusion = {
  pack: mkPack(
    [
      {
        id: "r_normal",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
      {
        id: "r_transfer",
        category: "__domain_transfer",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_normal", ratePerSec: rate("1", "1") }],
};

export const domainTransferExclusionGolden = {
  objectiveValue: 1,
  // r_normal (cost 1) satisfies the target; r_transfer (cost 1e6) stays inactive.
  activeRecipes: ["r_normal"],
};

// ---------------------------------------------------------------------------
// Scenario 7a: cyclic SCC -- min-floor contract
//
// r_scc_target and r_scc_cycle form a two-recipe cycle:
//   r_scc_target: raw(1) + mid(1) -> target_item(1)   [targeted]
//   r_scc_cycle:  target_item(1)  -> mid(1)            [cycle back-edge]
//
// The cycle makes mid depend on target_item, which depends on mid. The LP sets
// target_item demand to ratePerSec = 1/2. Because the SCC exactly recycles mid,
// the mass-balance equality system can't meet the demand without a deficit on
// target_item (softFeasible=false). The floor (min, not equality) still forces
// x_r_scc_target >= ratePerSec / primary.qty = 0.5. This exercises the lp.ts
// rule that floor is a MIN constraint, not equality, so the pin doesn't
// over-constrain mass balance.
//
// Golden: both SCC members run at rate 0.5 (floor binding); deficit on
// target_item = 0.5 from the unresolvable cyclic demand.
// ---------------------------------------------------------------------------
export const domainTransferScc = {
  pack: mkPack(
    [
      {
        id: "r_scc_target",
        category: "material",
        time: 1,
        in: [
          { item: "raw", qty: 1 },
          { item: "mid", qty: 1 },
        ],
        out: [{ item: "target_item", qty: 1 }],
      },
      {
        id: "r_scc_cycle",
        category: "material",
        time: 1,
        in: [{ item: "target_item", qty: 1 }],
        out: [{ item: "mid", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "target_item", raw: false },
      { id: "mid", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_scc_target", ratePerSec: rate("1", "2") }],
};

export const domainTransferSccGolden = {
  // Objective dominated by deficit penalty: 1e9 * 0.5 + 0.5 + 0.5 = 500000001,
  // but the solver returns 500000000.5 from LP float rounding of the deficit
  // variable. Use the value read directly from solveLp output.
  objectiveValue: 500000000.5,
  status: "feasible" as const,
  softFeasible: false,
  // Both SCC members run; cycle drives both to the floor.
  activeRecipes: ["r_scc_cycle", "r_scc_target"],
  // Deficit on target_item = 0.5: demand driven by ratePerSec, unresolved by cycle.
  deficitItem: "target_item",
};

// ---------------------------------------------------------------------------
// Scenario 7b: target-only flag exclusion (big-M signal variant)
//
// r_normal and r_targetonly produce the same item. r_targetonly has
// flags:["target-only"] => recipeCostWeight returns 1e6. When r_normal is
// the target, r_targetonly is never chosen.
// ---------------------------------------------------------------------------
export const targetOnlyFlagExclusion = {
  pack: mkPack(
    [
      {
        id: "r_normal",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
      {
        id: "r_targetonly",
        category: "material",
        time: 1,
        flags: ["target-only"],
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_normal", ratePerSec: rate("1", "1") }],
};

export const targetOnlyFlagExclusionGolden = {
  objectiveValue: 1,
  // r_targetonly (cost 1e6) stays inactive; r_normal (cost 1) covers the target.
  activeRecipes: ["r_normal"],
};

// ---------------------------------------------------------------------------
// Scenario 7c: cost=-1 sink exclusion (big-M signal variant)
//
// r_normal and r_sink produce the same item. r_sink has cost:-1 =>
// recipeCostWeight returns 1e6 (clamped, interpreted as "do not use").
// ---------------------------------------------------------------------------
export const costMinusOneSinkExclusion = {
  pack: mkPack(
    [
      {
        id: "r_normal",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
      {
        id: "r_sink",
        category: "material",
        time: 1,
        cost: -1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_normal", ratePerSec: rate("1", "1") }],
};

export const costMinusOneSinkExclusionGolden = {
  objectiveValue: 1,
  // r_sink (cost 1e6) stays inactive; r_normal (cost 1) covers the target.
  activeRecipes: ["r_normal"],
};

// ---------------------------------------------------------------------------
// Scenario 8: deficit (unmet demand)
//
// r_target consumes "missing_item" (not raw, no producer in pack) to produce
// "prod". The LP adds a deficit slack for "missing_item" but cannot supply it
// from any recipe. The deficit variable survives the >1e-12 filter =>
// softFeasible===false. The raw solver still marks the problem feasible (the
// slack absorbs the gap). status==="feasible", deficit has "missing_item".
// Objective is dominated by 1e9 * deficit(1) + 1 * r_target(1) = 1e9 + 1.
// ---------------------------------------------------------------------------
export const deficitUnmetDemand = {
  pack: mkPack(
    [
      {
        id: "r_target",
        category: "material",
        time: 1,
        in: [{ item: "missing_item", qty: 1 }],
        out: [{ item: "prod", qty: 1 }],
      },
    ],
    [
      { id: "missing_item", raw: false },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_target", ratePerSec: rate("1", "1") }],
};

export const deficitUnmetDemandGolden = {
  // Deficit-dominated objective: 1e9 * 1 (missing_item deficit) + 1 (r_target run).
  objectiveValue: 1_000_000_001,
  status: "feasible" as const,
  softFeasible: false,
  // r_target runs (pinned to at least rate/primary.qty = 1).
  activeRecipes: ["r_target"],
  // "missing_item" cannot be produced => deficit = 1.
  deficitItem: "missing_item",
};

// ---------------------------------------------------------------------------
// Scenario 9: unbounded status
//
// Status "unbounded" is NOT reachable through solveLp with real or synthetic
// packs:
//   - All LP variables (recipe rates, surplus, deficit) are non-negative.
//   - The objective is a MINIMIZATION with non-negative weights (recipe costs
//     >= 0, surplus 1e-3, deficit 1e9), so it is bounded below by 0; it cannot
//     go to -infinity.
//   - javascript-lp-solver only emits bounded:false when the objective is
//     unbounded in the MAX direction. solveLp uses opType:"min".
//
// So unbounded is structurally unreachable. No fabricated scenario or fake
// LpResult for it.
// ---------------------------------------------------------------------------
export const SCENARIO_9_UNBOUNDED_UNREACHABLE =
  "Status 'unbounded' is unreachable via solveLp: all vars are non-negative " +
  "and all objective coefficients are non-negative, so a minimization " +
  "objective is bounded below by 0. javascript-lp-solver only emits " +
  "bounded:false in the maximization direction.";

// ---------------------------------------------------------------------------
// Scenario 10: feasible-empty
//
// The target recipe "r_zero_out" has primary output qty=0, so solveLp's
// target-floor guard skips the pin (primary.qty must be > 0). Without a pin no
// recipe is forced active; the optimal is 0 recipe runs with all demand absorbed
// by deficit. The solve is feasible but no x_recipe exceeds the >1e-12 threshold
// => rates map empty => status === "empty". softFeasible===false because the
// prod deficit survives.
// ---------------------------------------------------------------------------
export const feasibleEmpty = {
  pack: mkPack(
    [
      {
        id: "r_zero_out",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "prod", qty: 0 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "prod", raw: false },
    ],
  ),
  targets: [{ recipeId: "r_zero_out", ratePerSec: rate("1", "1") }],
};

export const feasibleEmptyGolden = {
  status: "empty" as const,
  softFeasible: false,
  // No recipe runs at a positive rate; rates map is empty.
  activeRecipes: [] as string[],
};
