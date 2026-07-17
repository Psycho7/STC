// Curated small synthetic recipe-pack fixtures, each exercising one solver
// topology. Used by corpus.test.ts for golden regression: any change to solver
// output on a known topology must trip a test.
//
// Per-fixture fields:
//   pack         - minimal RecipePack (cast via `as unknown as RecipePack`)
//   targets      - ItemTarget[] for solveLp
//   itemOverrides? - ItemOverride[] for supply caps / plan flags
//   recipeCosts?   - Map<RecipeId, number> for cost overrides
//
// All goldens (objectiveValue + active recipe set) come from running the actual
// solver and reading output, never invented.

import type { RecipePack } from "@aef/schema";
import type { ItemTarget } from "../data/targets";
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

function rate(num: string, denom: string): ItemTarget["ratePerSec"] {
  return { num, denom };
}

// Full pack constructor for fixtures that run the whole pipeline (replicate,
// multipliers, render): unlike mkPack it fills in the machine and per-recipe
// producers/name/icon fields those stages read.
function mkFullPack(
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
  return {
    schemaVersion: "0.2",
    source: {
      name: "corpus",
      sourceRepo: "",
      sourceCommit: "",
      gameVersion: "",
      extractedAt: "",
    },
    categories: [{ id: "material", name: "material", icon: "material" }],
    locations: [],
    items: items.map((i) => ({
      id: i.id,
      name: i.id,
      category: "material",
      icon: i.id,
      row: 0,
      raw: i.raw,
      transportKind: "belt",
      stack: 1,
    })),
    machines: [
      {
        id: "machine",
        name: "machine",
        icon: "machine",
        speed: 1,
        powerType: "electric",
        powerKw: 1,
        hideRate: false,
      },
    ],
    transports: [],
    recipes: recipes.map((r) => ({
      id: r.id,
      name: r.id,
      category: r.category,
      icon: r.id,
      row: 0,
      time: r.time,
      in: r.in,
      out: r.out,
      producers: ["machine"],
      ...(r.flags !== undefined ? { flags: r.flags } : {}),
      ...(r.cost !== undefined ? { cost: r.cost } : {}),
    })),
  } as unknown as RecipePack;
}

// ---------------------------------------------------------------------------
// Scenario 1: acyclic single producer
//
// One linear chain: raw -> a -> b. Exactly one recipe per item.
// Target: item "b" at 1/sec. Must run r_make_a to supply "a".
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
  targets: [{ itemId: "b", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
// "raw". Target: item "prod". The LP minimizes cost: 1 vs 1e6, so r_transfer
// stays inactive.
//
// The "prod" mass balance is met by r_normal alone. Adding r_transfer would
// add 1e6 per unit, so it is only chosen when it is the sole producer
// (unavoidable). Here it is avoidable.
//
// Why no genuine-SCC variant: a two-item SCC (A -> B -> A) where
// __domain_transfer is strictly unavoidable can't be built from a minimal
// synthetic pack without replicating the full cross-domain import chain. In the
// real pack __domain_transfer bridges two separate domain graphs (e.g. base-game
// to Endfield items) and only runs when the user needs an item from the other
// domain; a two-recipe synthetic would make __domain_transfer the only producer,
// trivially unavoidable rather than a meaningful SCC test. So here we assert
// only the exclusion case (avoidable big-M stays inactive).
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
};

export const domainTransferExclusionGolden = {
  objectiveValue: 1,
  // r_normal (cost 1) satisfies the target; r_transfer (cost 1e6) stays inactive.
  activeRecipes: ["r_normal"],
};

// ---------------------------------------------------------------------------
// Scenario 7a: cyclic SCC -- net-export contract
//
// r_scc_target and r_scc_cycle form a two-recipe cycle:
//   r_scc_target: raw(1) + mid(1) -> target_item(1)
//   r_scc_cycle:  target_item(1)  -> mid(1)            [cycle back-edge]
//
// The cycle makes mid depend on target_item, which depends on mid. The target
// demands a net export of target_item at 1/2. The cycle exactly recycles its
// own output (every unit of target_item produced is consumed rebuilding mid),
// so no rate assignment yields positive net export: running the cycle only
// adds recipe cost on top of the same unavoidable deficit. The cost-min
// optimum runs nothing and reports the full demand as a deficit on
// target_item (softFeasible=false, status "empty").
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
  targets: [{ itemId: "target_item", ratePerSec: rate("1", "2") }],
};

export const domainTransferSccGolden = {
  // Objective is the pure deficit penalty: 1e9 * 0.5 = 500000000. No recipe
  // runs (the cycle cannot create net export, so running it only adds cost).
  objectiveValue: 500000000,
  status: "empty" as const,
  softFeasible: false,
  activeRecipes: [] as string[],
  // Deficit on target_item = 0.5: the demanded item itself goes unmet.
  deficitItem: "target_item",
};

// ---------------------------------------------------------------------------
// Scenario 7b: target-only flag exclusion (big-M signal variant)
//
// r_normal and r_targetonly produce the same item. r_targetonly has
// flags:["target-only"] => recipeCostWeight returns 1e6, so demand on "prod"
// is covered by r_normal and r_targetonly is never chosen.
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
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
// "prod". Running r_target just moves the unavoidable 1-unit deficit from
// "prod" onto "missing_item", so the 1e9-dominated deficit cost is flat in
// x_r_target and the engine stops at an arbitrary point on that flat edge (it
// returns a small junk rate, 20/19999, rather than the cost-minimal 0). The
// extraction keeps the point and reports the honest deficit split: the bulk
// stays on the demanded "prod", the run fraction lands on "missing_item".
// softFeasible===false; status "feasible" because the junk rate is positive.
// Objective = 1e9 * total deficit(1).
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
};

export const deficitUnmetDemandGolden = {
  // Total deficit is exactly 1 unit however the flat edge splits it.
  objectiveValue: 1_000_000_000,
  status: "feasible" as const,
  softFeasible: false,
  // The junk-vertex rate keeps r_target nominally active.
  activeRecipes: ["r_target"],
  // The demanded item carries the bulk of the deficit.
  deficitItem: "prod",
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
// The only producer of "prod" (r_zero_out) emits it at qty=0, so no recipe can
// create net output of the demanded item; the optimal is 0 recipe runs with
// all demand absorbed by deficit. The solve is feasible but no x_recipe
// exceeds the >1e-12 threshold => rates map empty => status === "empty".
// softFeasible===false because the prod deficit survives.
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
  targets: [{ itemId: "prod", ratePerSec: rate("1", "1") }],
};

export const feasibleEmptyGolden = {
  status: "empty" as const,
  softFeasible: false,
  // No recipe runs at a positive rate; rates map is empty.
  activeRecipes: [] as string[],
};

// ---------------------------------------------------------------------------
// Scenario 11: producer choice by cost (new net-export freedom)
//
// Two producers of "widget", cost-distinct via recipeCosts (both positive, not
// big-M): z_cheap=2, a_pricey=5. The old pin-floor could force a specific
// producer; the new semantics let the LP minimize cost freely. z_cheap wins on
// cost even though its id sorts AFTER a_pricey (a_pricey has lex rank 0), so a
// pass-2 lex tie-break alone would have picked a_pricey. Cost, not lex, decides.
//
// widget demand 1/sec -> z_cheap runs 1/sec (1 widget per run). Objective =
// cost(z_cheap) * 1 = 2. a_pricey stays inactive.
// ---------------------------------------------------------------------------
export const producerChoiceByCost = {
  pack: mkPack(
    [
      {
        id: "a_pricey",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "widget", qty: 1 }],
      },
      {
        id: "z_cheap",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [{ item: "widget", qty: 1 }],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "widget", raw: false },
    ],
  ),
  targets: [{ itemId: "widget", ratePerSec: rate("1", "1") }],
  recipeCosts: new Map<RecipeId, number>([
    ["a_pricey", 5],
    ["z_cheap", 2],
  ]),
};

export const producerChoiceByCostGolden = {
  // z_cheap at cost 2 covers the 1/sec demand; a_pricey (cost 5, lex rank 0)
  // stays inactive. Objective is the pass-1 cost cap: 2.
  objectiveValue: 2,
  activeRecipes: ["z_cheap"],
};

// ---------------------------------------------------------------------------
// Scenario 12: byproduct-only item target
//
// "byp" appears only as the secondary output (out[1]) of r_dual; there is no
// recipe that makes it primary. Targeting it forces co-product production:
// r_dual runs to net-export byp, and the primary output "primary" (unconsumed,
// non-raw) lands in free-disposal surplus (the deleted-surpcap behavior).
//
// byp demand 1/sec -> r_dual runs 1/sec. primary surplus = 1*r_dual - 0 = 1.
// Objective = cost(r_dual) 1 + SURPLUS_WEIGHT * surplus(primary)=1 = 1.001.
// ---------------------------------------------------------------------------
export const byproductOnlyTarget = {
  pack: mkPack(
    [
      {
        id: "r_dual",
        category: "material",
        time: 1,
        in: [{ item: "raw", qty: 1 }],
        out: [
          { item: "primary", qty: 1 },
          { item: "byp", qty: 1 },
        ],
      },
    ],
    [
      { id: "raw", raw: true },
      { id: "primary", raw: false },
      { id: "byp", raw: false },
    ],
  ),
  targets: [{ itemId: "byp", ratePerSec: rate("1", "1") }],
};

export const byproductOnlyTargetGolden = {
  // 1 recipe run + 1e-3 * surplus(primary)=1 = 1.001.
  objectiveValue: 1.001,
  activeRecipes: ["r_dual"],
  // The co-product primary is unconsumed: full 1/sec production surpluses.
  surplusPrimary: 1,
};

// ---------------------------------------------------------------------------
// Scenario 13: raw item target via a miner recipe (miner runs)
//
// "ore" is modeled NON-raw (raw:false) and produced by r_miner from nothing, so
// it is NOT boundary-drawable: the LP must run the miner to net-export it rather
// than pull it free from the boundary (that draw-satisfied case is Scenario
// 14/15). Targeting ore runs the miner at the declared rate.
//
// ore demand 1/sec -> r_miner runs 1/sec. Objective = cost(r_miner) 1 = 1.
// ---------------------------------------------------------------------------
export const rawItemTargetViaMiner = {
  pack: mkPack(
    [
      {
        id: "r_miner",
        category: "material",
        time: 1,
        in: [],
        out: [{ item: "ore", qty: 1 }],
      },
    ],
    [{ id: "ore", raw: false }],
  ),
  targets: [{ itemId: "ore", ratePerSec: rate("1", "1") }],
};

export const rawItemTargetViaMinerGolden = {
  objectiveValue: 1,
  activeRecipes: ["r_miner"],
};

// ---------------------------------------------------------------------------
// Scenario 14: free-boundary item target met by boundary draw
//
// "ore" is raw:true (effectiveSupply === Infinity, effectively unlimited free
// external supply) and there is no producer at all. Targeting it does NOT run
// anything and is NOT a deficit: the demand is met by an external boundary draw
// equal to the declared rate. The LP builds no mass-balance row for a free
// boundary item, so the draw is post-solve accounting: draw = demand - net
// production = 1 - 0 = 1.
//
// Nothing runs -> status "empty"; softFeasible stays true (no unmet demand);
// draws{ore} = 1; deficit empty.
// ---------------------------------------------------------------------------
export const freeBoundaryTarget = {
  pack: mkPack([], [{ id: "ore", raw: true }]),
  targets: [{ itemId: "ore", ratePerSec: rate("1", "1") }],
};

export const freeBoundaryTargetGolden = {
  objectiveValue: 0,
  status: "empty" as const,
  softFeasible: true,
  activeRecipes: [] as string[],
  drawOre: 1,
};

// ---------------------------------------------------------------------------
// Scenario 15: free-boundary target that ALSO has a costly miner (draw wins)
//
// Same raw:true "ore" target, but now a miner r_mine (from nothing, cost 1)
// could also produce it. The free boundary draw costs 0; running the miner
// costs 1 and produces an unconstrained item (no row, no benefit), so the
// cost-min LP keeps the miner idle and meets demand via the free draw. draw =
// demand - net production = 1 - 0 = 1 (miner idle, net 0).
//
// Nothing runs -> status "empty"; softFeasible true; draws{ore} = 1; deficit
// empty. r_mine must NOT be active.
// ---------------------------------------------------------------------------
export const freeBoundaryTargetWithMiner = {
  pack: mkPack(
    [
      {
        id: "r_mine",
        category: "material",
        time: 1,
        in: [],
        out: [{ item: "ore", qty: 1 }],
      },
    ],
    [{ id: "ore", raw: true }],
  ),
  targets: [{ itemId: "ore", ratePerSec: rate("1", "1") }],
};

export const freeBoundaryTargetWithMinerGolden = {
  objectiveValue: 0,
  status: "empty" as const,
  softFeasible: true,
  activeRecipes: [] as string[],
  drawOre: 1,
};

// ---------------------------------------------------------------------------
// Scenario 16: one target item split across two producers by a finite cap
//
// "gold" is demanded at 5/s and has two producers with UNEQUAL output
// quantities. r_cheap (cost 1/5 via the fixture's recipeCosts, out qty 1, so
// 1/5 per unit of gold) consumes "vein", a non-raw item with no producer and
// a finite external cap of 1/s, so r_cheap can run at most 1/s. r_dear
// (default cost 1, out qty 3, so 1/3 per unit) consumes free raw "rock". The
// cost-min LP maxes out the cheaper-per-unit producer at its cap and covers
// the remaining 4/s with r_dear at the fractional rate 4/3, so the ONE target
// item is genuinely split across two positive-rate producers with different
// flows:
//   r_cheap = 1 (flow 1), r_dear = 4/3 (flow 4), draw(vein) = 1,
//   no surplus, no deficit; declared draw apportioned 1 : 4.
// Built with the full closed-form pack shape (machines, producers) so
// pipeline tests can run it end-to-end through replicate and render.
// ---------------------------------------------------------------------------
export const splitTargetProducers = {
  pack: mkFullPack(
    [
      {
        id: "r_cheap",
        category: "material",
        time: 1,
        in: [{ item: "vein", qty: 1 }],
        out: [{ item: "gold", qty: 1 }],
      },
      {
        id: "r_dear",
        category: "material",
        time: 1,
        in: [{ item: "rock", qty: 1 }],
        out: [{ item: "gold", qty: 3 }],
      },
    ],
    [
      { id: "gold", raw: false },
      { id: "vein", raw: false },
      { id: "rock", raw: true },
    ],
  ),
  targets: [{ itemId: "gold", ratePerSec: rate("5", "1") }],
  itemOverrides: [
    { itemId: "vein", ratePerSec: { num: "1", denom: "1" } } satisfies ItemOverride,
  ],
  recipeCosts: new Map<RecipeId, number>([["r_cheap", 0.2]]),
};

export const splitTargetProducersGolden = {
  // r_cheap 1 * 0.2 + r_dear 4/3 * 1 = 23/15; the engine reports the pass-1
  // objective rounded to 8 decimals, so the golden is the value read from
  // solveLp output.
  objectiveValue: 1.53333333,
  activeRecipes: ["r_cheap", "r_dear"],
  rateCheap: 1,
  rateDearNum: 4,
  rateDearDen: 3,
  drawVein: 1,
};
