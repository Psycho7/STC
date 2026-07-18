// End-to-end render corpus test.
//
// Known-good group: the four feasible closed-form micro-fixtures (chain,
// multi-producer, byproduct, raw-draw) all pass the seven render invariants.
//
// RF-1 regression: the real-pack plan in RF1_HASH has an internally balanced
// intermediate iron_nugget whose render edge used to be dropped (surfaced as a
// phantom surplus, consumer fed from nothing). The edge wiring now routes the
// producer to the live consumer stamp, so iron_nugget triggers no render
// violation.

import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import { CLOSED_FORM_FIXTURES } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import type { Target } from "../../data/targets";
import { renderPlanFromSolve } from "../driver";
import {
  capProducerInputOutflow,
  type CapEdge,
} from "../expand/edge-rates";
import {
  assertRenderInvariants,
  checkRenderPlan,
  checkUnitOutflowVsProduction,
} from "./invariants";
import { pack } from "../../data/load";

// game v1.4 added the gas-system machines, whose recipes reroute the xiranite
// and copper chains away from the SCC topologies some regression suites below
// were written to exercise. Those suites solve against a pack without the
// gas-machine recipes; every pre-v1.4 recipe is unchanged upstream, so this
// reproduces the exact plans the regressions pinned.
const GAS_MACHINES = new Set([
  "gas_pump_1",
  "gas_reactor_1",
  "phase_trans_1",
  "phase_trans_2",
]);
const legacyPack = {
  ...pack,
  recipes: pack.recipes.filter(
    (r) => !r.producers.some((p) => GAS_MACHINES.has(p)),
  ),
};
import { checkRepresentable, checkMassBalance } from "../../solver/invariants";
import { solveLp } from "../../solver/lp";
import { loadPlan } from "../../data/plan";
import { planToSolverArgs } from "../../solver/planToSolverArgs";
import { isMachineRecipeVertex, isRecipeUnit } from "../types";
import { rationalFromString } from "./rational";
import type { RenderPlan } from "../types";

// RF-1: iron_nugget is an internally balanced intermediate; the render pipeline
// used to drop its internal edge, surfacing it as a phantom surplus and leaving
// its consumer (iron_powder) without an input edge.
const RF1_HASH =
  "v1.H4sIAAAAAAAACo3NQYvCMBQE4P8y56g1tm6Tf7A3waOIpO-9LMFuE2LEQ8l_l94EXdjbHGa-mZEcXWFPkIl9kJFX5EbaeEcl5hBHN0ChWWsotJ7avTZt78X4fad50I3uetPtmHumxgw79mS-cFYooYwCCygUl3-k3GBPM7JQSPLNsKCYkuTLEMvSVMiuyEHyUQh2xnT_hcXyyjLFJW9Rq_okpPhgyX8I2xdBvwkhx-n_-xa1nusTppb41DIBAAA";

// The four feasible micro-fixtures.
const FEASIBLE_FIXTURES = CLOSED_FORM_FIXTURES.filter(
  (f) => f.expected.softFeasible,
);

describe("render corpus: known-good fixtures pass all invariants", () => {
  for (const fixture of FEASIBLE_FIXTURES) {
    it(`fixture: ${fixture.name}`, () => {
      const full = solvePlanWithIntermediates(
        fixture.targets,
        fixture.pack,
        defaultTransportConfig,
        fixture.itemOverrides,
      );
      const { plan } = renderPlanFromSolve(
        full,
        fixture.pack,
        fixture.targets,
        fixture.itemOverrides ?? [],
      );
      expect(() =>
        assertRenderInvariants({
          plan,
          rates: full.rates,
          pack: fixture.pack,
          targets: fixture.targets,
          itemOverrides: fixture.itemOverrides ?? [],
        }),
      ).not.toThrow();
    });
  }
});

// RF-1 regression: the fix routes iron_nugget's producer to its live consumer
// stamp, so the RF-1 hash plan reports no iron_nugget render violation.
describe("render corpus: RF-1 regression", () => {
  it("reports no iron_nugget violation for the RF-1 hash (fixed)", async () => {
    const outcome = await loadPlan(RF1_HASH, pack);
    if (outcome.kind !== "loaded" && outcome.kind !== "seeded") {
      throw new Error(
        `failed to load RF-1 plan: ${JSON.stringify(outcome)}`,
      );
    }
    const { targets, itemOverrides, recipeCosts } = planToSolverArgs(
      outcome.plan,
    );
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      itemOverrides,
      recipeCosts,
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, itemOverrides);
    const results = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides,
    });
    const allViolations = results.flatMap((r) => r.violations);
    const ironNuggetViolations = allViolations.filter((v) =>
      v.includes("iron_nugget"),
    );
    expect(ironNuggetViolations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full-pack + multi-target regression sweep.
//
// Iterates every recipe as a single target at rate 1, plus a small fixed set of
// multi-target plans that exercise shared SCCs and byproducts. For each feasible
// plan it asserts:
//   (a) all checkRenderPlan invariants pass (no render-graph defect), and
//   (b) per recipeId, the sum of MachineRecipeVertex.executionRate over the
//       machine graph equals the LP rate (full.rates) within tolerance. This
//       machine-count gate catches producer over-replication.
//
// The sweep started red: it captured the known render-replication defects as a
// baseline the fixes drive to zero. Each failure carries the plan name and the
// gate it violated so the assertion message stays a usable oracle.
//
// The non-driver co-product routing fix (live-role filter in assignSplitRoles)
// cleared the single-target failures: xiranite_poly co-produces the looped
// byproduct liquid_sewage, and the split-replica filter assigned the
// liquid_sewage role to a zero-rate split, so the logical graph never wired
// xiranite_poly's liquid_sewage to its in-loop consumer. The render layer then
// billed the one wired producer the full demand and surfaced xiranite_poly's
// share as a phantom surplus. Routing the non-driver co-product edges to the
// live split role clears xiranite_poly, proc_battery_5,
// jinlong_coupon-proc_battery_5 (single-target) and xiranite_poly+iron_powder
// (multi-target).
//
// After isInvariantThrow classification (below) the swept population is green.
// The two buckets that used to be deferred for the shared solver-residual
// defect (copper_enr+liquid_xiranite_enr and 34 transfer_tundra_* singles, all
// the wrong-rational pin-extraction class) are clean since the extraction snaps
// pinned rates onto their exact floors, and sweep with everything else.
//
// isInvariantThrow separates a dev-invariant throw (surfaced as a failure) from
// a genuine infeasibility/unsolvable throw (a legit skip), so a regression that
// trips the solver/render dev assertion can no longer hide behind the
// solve-catch.
// ---------------------------------------------------------------------------

const SWEEP_TOL = new Fraction(1, 1000000);

// Representative multi-target plans. Each mixes a copper-chain target with an
// xiranite target to exercise shared SCCs and byproduct accounting across more
// than one target.
const MULTI_TARGET_PLANS: ReadonlyArray<{
  name: string;
  recipeIds: ReadonlyArray<string>;
}> = [
  { name: "xiranite_poly+iron_powder", recipeIds: ["xiranite_poly", "iron_powder"] },
  { name: "proc_battery_5+xiranite_enr_powder", recipeIds: ["proc_battery_5", "xiranite_enr_powder"] },
  { name: "copper_enr+liquid_xiranite_enr", recipeIds: ["copper_enr", "liquid_xiranite_enr"] },
  // Two targets sharing a byproduct supplier (both co-produce liquid_sewage).
  // copper_enr is reached both as a target seed and as a byproduct-shared
  // source, so its whole upstream copper chain is replicated twice instead of
  // shared (per-consumer over-replication).
  { name: "copper_enr+xiranite_poly", recipeIds: ["copper_enr", "xiranite_poly"] },
  // Two mutual-recycling members of one SCC: production of the shared item nets
  // to zero against consumption + demand, but split-role surplus accounting
  // surfaces a phantom surplus (multi-producer SCC routing).
  {
    name: "crystal_powder-crystal_shell+crystal_shell-crystal_powder",
    recipeIds: ["crystal_powder-crystal_shell", "crystal_shell-crystal_powder"],
  },
  // A target recipe that is ALSO an upstream producer of another target. The
  // seed loop registers a target only in the byproductShared cache, so a target
  // reached again as a producer is minted a second time and its whole chain
  // over-replicates ~2x. Two sub-cases of the same gap:
  //   - carbon_enr is a (trivial-SCC) articulation producer of the carbon_enr
  //     that equip_script_4's xiranite chain consumes -> AP-shared double-mint.
  //   - iron_nugget-iron_ore produces the iron_nugget that bottled_food_2's
  //     chain consumes -> non-shared per-consumer double-mint.
  { name: "carbon_enr+equip_script_4", recipeIds: ["carbon_enr", "equip_script_4"] },
  { name: "iron_nugget-iron_ore+bottled_food_2", recipeIds: ["iron_nugget-iron_ore", "bottled_food_2"] },
  // Phantom surplus from production split across render units. The surplus pass
  // differenced produced-vs-outgoing per unit and kept only positive residuals,
  // so when an item's production splits across units -- a loop recipe torn across
  // SCC sibling units, or a target item co-produced by an SCC and a leaf recipe
  // -- one unit's positive residual surfaced as an amber surplus while the
  // matching per-unit deficit was clamped away. Net production for the item is
  // exactly its genuine surplus (zero here), so the leftover is phantom. The
  // surplus pass now emits the genuine surplus (production - consumption -
  // demand) per item, the same quantity checkBoundaryProductsJustified validates.
  //   - proc_battery_5+xiranite_enr_powder: liquid_xiranite_poly / lowpoly are
  //     non-target loop intermediates torn across SCC siblings.
  //   - copper_powder+equip_script_4: crystal_powder, a non-target loop item with
  //     a degenerate sub-tolerance residual.
  //   - carbon_powder-plant_grass_powder_2+plant_grass_2: plant_grass_2 is a
  //     TARGET loop item.
  //   - iron_nugget-iron_powder+jinlong_coupon-proc_battery_5: iron_nugget is a
  //     TARGET item co-produced by an SCC and a separate leaf recipe.
  { name: "copper_powder+equip_script_4", recipeIds: ["copper_powder", "equip_script_4"] },
  { name: "carbon_powder-plant_grass_powder_2+plant_grass_2", recipeIds: ["carbon_powder-plant_grass_powder_2", "plant_grass_2"] },
  { name: "iron_nugget-iron_powder+jinlong_coupon-proc_battery_5", recipeIds: ["iron_nugget-iron_powder", "jinlong_coupon-proc_battery_5"] },
];

// A thrown error counts as a real failure only when it is an invariant
// violation: the solver dev assertion throws "solver invariants violated:"
// (src/solver/invariants.ts) and the render dev assertion throws "render
// invariants violated:" (src/pipeline/render/invariants.ts). A genuinely
// infeasible/unsolvable LP throws "LP solver: infeasible problem" / "LP solver:
// unbounded objective" from assertSolvable (src/solver/index.ts), which is a
// legit skip.
function isInvariantThrow(err: unknown): boolean {
  return String(err).includes("invariants violated");
}

// Run one plan through solve + render and return its gate failures. Empty array
// means clean, or skipped as non-feasible (skipped is true and the caller does
// not count it). A solve/render throw from a dev invariant assertion is
// surfaced as a failure; only an infeasibility/unsolvable throw is a skip.
function sweepPlan(
  name: string,
  targets: Target[],
): { skipped: boolean; failures: string[] } {
  let full;
  try {
    full = solvePlanWithIntermediates(targets, pack, defaultTransportConfig, []);
  } catch (err) {
    if (isInvariantThrow(err)) {
      return {
        skipped: false,
        failures: [`${name}: solver-invariant-throw: ${String(err)}`],
      };
    }
    // Infeasible / unsolvable LP: a skip.
    return { skipped: true, failures: [] };
  }
  if (!full.feasibility.softFeasible) return { skipped: true, failures: [] };

  const failures: string[] = [];

  let out;
  try {
    out = renderPlanFromSolve(full, pack, targets, []);
  } catch (err) {
    // A feasible plan whose render throws the dev render-invariant assertion is
    // a failure, not a skip.
    failures.push(`${name}: render-crash: ${String(err)}`);
    return { skipped: false, failures };
  }
  const { plan, machineGraph } = out;

  // Gate (a): render invariants.
  const results = checkRenderPlan({
    plan,
    rates: full.rates,
    pack,
    targets,
    itemOverrides: [],
  });
  for (const r of results) {
    for (const v of r.violations) {
      failures.push(`${name}: render-invariant: ${v}`);
    }
  }

  // Gate (b): machine-count. Per recipeId, sum executionRate over machine
  // recipe vertices and compare to the LP rate.
  const vtxSum = new Map<string, Fraction>();
  for (const v of machineGraph.vertices) {
    if (isMachineRecipeVertex(v)) {
      vtxSum.set(
        v.recipeId,
        (vtxSum.get(v.recipeId) ?? new Fraction(0)).add(v.executionRate),
      );
    }
  }
  for (const [recipeId, lpRate] of full.rates) {
    const vs = vtxSum.get(recipeId) ?? new Fraction(0);
    if (vs.sub(lpRate).abs().compare(SWEEP_TOL) > 0) {
      failures.push(
        `${name}: machine-count: recipe "${recipeId}" vtxSum ${vs.toFraction()} != lpRate ${lpRate.toFraction()}`,
      );
    }
  }

  return { skipped: false, failures };
}

describe("render corpus: full-pack + multi-target regression sweep", () => {
  it("every feasible plan renders clean and matches LP machine counts", () => {
    const allFailures: string[] = [];

    // Single-target sweep over the whole recipe pack. The 34 transfer_tundra_*
    // plans and copper_enr+liquid_xiranite_enr that used to carry the deferred
    // solver-residual family (wrong-rational pin extraction) are clean since
    // the extraction snaps pinned rates onto their exact floors.
    for (const r of pack.recipes) {
      const targets: Target[] = [
        { recipeId: r.id, ratePerSec: { num: "1", denom: "1" } },
      ];
      const { failures } = sweepPlan(r.id, targets);
      allFailures.push(...failures);
    }

    // Multi-target plans.
    for (const mt of MULTI_TARGET_PLANS) {
      const targets: Target[] = mt.recipeIds.map((recipeId) => ({
        recipeId,
        ratePerSec: { num: "1", denom: "1" },
      }));
      const { failures } = sweepPlan(mt.name, targets);
      allFailures.push(...failures);
    }

    // Distinct plan names with at least one failure, for the assertion summary.
    const dirtyPlans = [
      ...new Set(allFailures.map((f) => f.split(":")[0])),
    ].sort();

    expect(
      allFailures,
      `${dirtyPlans.length} plan(s) failed the render sweep: ${dirtyPlans.join(", ")}\n${allFailures.join("\n")}`,
    ).toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// 1B regression: a RAW item that is ALSO a declared target (e.g. iron_ore in
// iron_ore+bottled_food_2) used to render with its entire production routed to
// u:out:<item> and ZERO inflow for its internal consumers (no u:in unit, no
// boundary edge). The recapture pass now reconciles raw-also-target items with
// a target-demand-adjusted pool, so consumers draw their deficit from the
// boundary while the target keeps its declared rate.
// ---------------------------------------------------------------------------
describe("render corpus: raw-also-target boundary feed (1B regression)", () => {
  function renderClean(targets: Target[]) {
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
    const results = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    });
    return { plan, violations: results.flatMap((r) => r.violations) };
  }

  it("iron_ore+bottled_food_2 feeds iron_nugget-iron_ore from the boundary", () => {
    const targets: Target[] = [
      { recipeId: "iron_ore", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "bottled_food_2", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { plan, violations } = renderClean(targets);
    expect(violations).toEqual([]);
    // The boundary input unit for iron_ore must exist alongside the target
    // output unit (dual render: input FIRST, target output LAST).
    const inUnits = plan.units.filter(
      (u) => u.kind === "inputProduct" && u.itemId === "iron_ore",
    );
    expect(inUnits.length).toBeGreaterThan(0);
    const outUnits = plan.units.filter(
      (u) => u.kind === "outputProduct" && u.itemId === "iron_ore",
    );
    expect(outUnits.length).toBe(1);
  });

  it("carbon_enr+liquid_water renders clean (consumption < production case)", () => {
    const targets: Target[] = [
      { recipeId: "carbon_enr", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "liquid_water", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { violations } = renderClean(targets);
    expect(violations).toEqual([]);
  });

  it("quartz_sand+bottled_food_1 renders clean", () => {
    const targets: Target[] = [
      { recipeId: "quartz_sand", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "bottled_food_1", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { violations } = renderClean(targets);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seeded-target co-producer regression: when a target item is co-produced by
// its own target recipe (pinned at full LP rate by the targetSeeded dedup) and
// a non-target sibling, splitConsumerDemand used to shrink the sibling to its
// proportional share, cascading half-rate (or share-rate) vertices down its
// whole upstream chain and starving the target output.
// ---------------------------------------------------------------------------
const MC_TOL = new Fraction(1, 1000000);

function machineCountGaps(targets: Target[], packArg = pack) {
  const full = solvePlanWithIntermediates(
    targets,
    packArg,
    defaultTransportConfig,
    [],
  );
  const out = renderPlanFromSolve(full, packArg, targets, []);
  const vtx = new Map<string, Fraction>();
  for (const v of out.machineGraph.vertices)
    if (isMachineRecipeVertex(v))
      vtx.set(
        v.recipeId,
        (vtx.get(v.recipeId) ?? new Fraction(0)).add(v.executionRate),
      );
  const gaps: string[] = [];
  for (const [rid, lp] of full.rates) {
    const s = vtx.get(rid) ?? new Fraction(0);
    if (s.sub(lp).abs().compare(MC_TOL) > 0)
      gaps.push(`${rid}: vtxSum ${s.toFraction()} != lpRate ${lp.toFraction()}`);
  }
  const results = checkRenderPlan({
    plan: out.plan,
    rates: full.rates,
    pack: packArg,
    targets,
    itemOverrides: [],
  });
  return { gaps, violations: results.flatMap((r) => r.violations) };
}

describe("render corpus: seeded-target co-producer keeps siblings at LP rate", () => {
  it("carbon_enr_powder co-produced by target + sibling replicates at LP rates", () => {
    const targets: Target[] = [
      {
        recipeId: "carbon_enr_powder-plant_moss_enr_powder_1",
        ratePerSec: { num: "1", denom: "1" },
      },
      { recipeId: "carbon_enr", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("carbon_powder target with equip_script_4 replicates at LP rates", () => {
    const targets: Target[] = [
      {
        recipeId: "carbon_powder-plant_moss_powder_1",
        ratePerSec: { num: "1", denom: "1" },
      },
      { recipeId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);
  });

  // SCC-resident variant: the target recipe lives inside a production loop
  // (iron_nugget<->iron_powder) and co-produces iron_nugget with a non-SCC
  // sibling (iron_nugget-iron_ore). The SCC member ships zero of that output
  // across the boundary (its whole production is the loop plus the target
  // output role), so its declared draw must zero its split weight; otherwise
  // the sibling is share-shrunk and under-fed (vtxSum 221/11 != lpRate 21).
  it("SCC-resident target co-producing with an external sibling replicates at LP rates", () => {
    const targets: Target[] = [
      { recipeId: "iron_nugget-iron_powder", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "bottled_food_2", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe("render corpus: tiny plan clears sub-unit checker tolerances", () => {
  // A legitimately tiny plan (liquid_copper at 1e-6/s) renders correct output
  // whose every magnitude sits at or below the checkers' old absolute 1e-6
  // tolerance floor, so predicates that REQUIRE a magnitude above slack (e.g.
  // checkBoundaryProductsJustified's net-consumed test) misfired on clean
  // plans and the DEV render hook crashed them. The tolerance scale floor is
  // now relative to the plan's own magnitude, so the same correct output
  // passes every checker.
  it("liquid_copper at 1e-6/s solves and renders with zero violations", () => {
    const targets: Target[] = [
      { recipeId: "liquid_copper", ratePerSec: { num: "1", denom: "1000000" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    expect(full.feasibility.softFeasible).toBe(true);
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
  });
});

describe("render corpus: SCC member input dual-fed intra and externally", () => {
  // crystal_shell<->crystal_powder loop: the target member's crystal_powder
  // demand is part-fed intra-SCC over the torn arc (191/1784) and part-fed by
  // the external crystal_powder-originium_powder (1593/1784). The boundary
  // recursion must mint the external producer net of the intra share; minting
  // it at the member's full rate over-feeds it and its upstream chain and
  // surfaces the intra share as a phantom crystal_powder surplus.
  it("crystal SCC replicates the external powder producer at LP rate", () => {
    const targets: Target[] = [
      {
        recipeId: "crystal_shell-crystal_powder",
        ratePerSec: { num: "1", denom: "1" },
      },
      { recipeId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe("render corpus: LP-support closure renders disposal absorbers", () => {
  // copper_bottle: the LP disposes of over-produced copper_nugget through it,
  // but no target cone reaches it. Before the closure the render omitted the
  // machine (machine-count gap) and emitted a phantom copper_nugget surplus.
  it("copper_nugget disposal plan renders copper_bottle and goes fully clean", () => {
    const targets: Target[] = [
      { recipeId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);

    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    expect(checkRepresentable(full).violations).toEqual([]);
  });

  // HISTORY: through game v1.2.4 this target pair was the off-graph CHAIN
  // witness - originium_powder -> originium_enr_powder -> proc_battery_5 all
  // LP-active yet unreachable from the target cone, plus an unavoidable
  // ~1.2e-6 originium_powder deficit the LP reported honestly. The v1.4
  // xiranite_powder recipe split closed that arithmetic corner: the pair now
  // solves exactly, no recipe lands off-graph, and no shipped-pack plan
  // (single-target sweep, 2026-07-17) naturally augments a chain anymore. The
  // chain-wiring contract keeps its synthetic-rate unit coverage in
  // graph.test.ts ("wires off-graph chains"); the end-to-end closure-render
  // integration keeps the copper_nugget disposal witness above. This test now
  // pins the plan's new truth so a future data refresh that reopens the corner
  // (or breaks the exact closure) surfaces here.
  it("xiranite purifier pair solves exactly and renders clean on the v1.4 pack", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      {
        recipeId: "liquid_xiranite_poly-purifier",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];

    const { gaps, violations } = machineCountGaps(targets);
    expect(gaps).toEqual([]);
    expect(violations).toEqual([]);

    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    expect(checkRepresentable(full).violations).toEqual([]);

    const lp = solveLp({ targets, pack, itemOverrides: [] });
    expect(checkMassBalance(lp, pack, targets, []).violations).toEqual([]);
    expect(lp.softFeasible).toBe(true);
    expect([...lp.deficit.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Torn-arc regression: intra-SCC demand apportionment.
//
// The liquid_xiranite_poly SCC has two live producers of liquid_xiranite_poly
// (recipes liquid_xiranite_poly and liquid_xiranite_poly-purifier) feeding the
// intra consumer xiranite_poly AND the cross-boundary consumer
// xiranite_enr_powder. assignSplitRoles billed EVERY producer the intra
// consumer's whole demand, driving each producer's cross flow negative; the
// clamp then zeroed every deliverer and the rendered graph fed
// xiranite_enr_powder ZERO liquid_xiranite_poly while the LP routes 5x its
// rate. The fix apportions each intra consumer's demand across the live
// producers by produced flow, so cross flow stays nonnegative and the
// deliverers jointly carry the cross demand in production ratio.
// ---------------------------------------------------------------------------
describe("torn-arc regression: intra-SCC demand apportionment", () => {
  const TORN_PLANS: ReadonlyArray<{ name: string; targets: Target[] }> = [
    {
      name: "P1",
      targets: [
        { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
        {
          recipeId: "jinlong_coupon-xiranite_enr_powder",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
    },
    {
      name: "P2",
      targets: [
        { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
        {
          recipeId: "jinlong_coupon-xiranite_enr_powder",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
    },
    {
      name: "P3",
      targets: [
        { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "27" } },
      ],
    },
    {
      name: "P4",
      targets: [
        { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
        {
          recipeId: "jinlong_coupon-xiranite_enr_powder",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
    },
    {
      name: "P5",
      targets: [
        { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "liquid_xiranite_enr", ratePerSec: { num: "1", denom: "27" } },
      ],
    },
  ];

  // Sum the rendered inflow of liquid_xiranite_poly into every recipe unit whose
  // recipeId is xiranite_enr_powder (its consumer outside the SCC). The
  // xiranite_enr_powder recipe needs 5 liquid_xiranite_poly per execution, so the
  // LP-implied inflow is 5 * its LP rate.
  function liquidInflowIntoEnr(targets: Target[]): {
    inflow: Fraction;
    expected: Fraction;
  } {
    const full = solvePlanWithIntermediates(
      targets,
      legacyPack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, legacyPack, targets, []);
    const enrUnitIds = new Set(
      plan.units
        .filter((u) => u.kind === "recipe" && u.recipeId === "xiranite_enr_powder")
        .map((u) => u.id),
    );
    let inflow = new Fraction(0);
    for (const e of plan.edges) {
      if (e.item !== "liquid_xiranite_poly") continue;
      if (enrUnitIds.has(e.toUnit)) inflow = inflow.add(e.rate);
    }
    const enrRate = full.rates.get("xiranite_enr_powder") ?? new Fraction(0);
    return { inflow, expected: enrRate.mul(5) };
  }

  for (const { name, targets } of TORN_PLANS) {
    it(`${name}: clean and feeds xiranite_enr_powder its LP liquid demand`, () => {
      // legacyPack: on the full v1.4 pack the gas route displaces
      // xiranite_enr_powder from these plans entirely, so the SCC this suite
      // regression-tests never forms.
      const full = solvePlanWithIntermediates(
        targets,
        legacyPack,
        defaultTransportConfig,
        [],
      );
      const { plan } = renderPlanFromSolve(full, legacyPack, targets, []);
      const violations = checkRenderPlan({
        plan,
        rates: full.rates,
        pack: legacyPack,
        targets,
        itemOverrides: [],
      }).flatMap((r) => r.violations);
      expect(violations).toEqual([]);

      const { inflow, expected } = liquidInflowIntoEnr(targets);
      expect(expected.compare(0)).toBeGreaterThan(0);
      expect(inflow.equals(expected)).toBe(true);
    });
  }

  // CONTROL stays clean (it is clean today) and, after the fix, the
  // cross-boundary liquid_xiranite_poly into xiranite_enr_powder is carried by
  // BOTH producer recipes in proportion to their LP rates (28/5 : 7/5).
  it("CONTROL: deliverers carry cross flow in LP-rate proportion", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);

    // Map each rendered recipe unit to its recipeId so cross edges can be
    // attributed to the producing recipe.
    const unitRecipe = new Map<string, string>();
    for (const u of plan.units) {
      if (u.kind === "recipe") unitRecipe.set(u.id, u.recipeId);
    }
    const enrUnitIds = new Set(
      plan.units
        .filter((u) => u.kind === "recipe" && u.recipeId === "xiranite_enr_powder")
        .map((u) => u.id),
    );
    const byProducer = new Map<string, Fraction>();
    for (const e of plan.edges) {
      if (e.item !== "liquid_xiranite_poly") continue;
      if (!enrUnitIds.has(e.toUnit)) continue;
      const producer = unitRecipe.get(e.fromUnit);
      if (producer === undefined) continue;
      byProducer.set(
        producer,
        (byProducer.get(producer) ?? new Fraction(0)).add(e.rate),
      );
    }

    const liquidRate =
      full.rates.get("liquid_xiranite_poly") ?? new Fraction(0);
    const purifierRate =
      full.rates.get("liquid_xiranite_poly-purifier") ?? new Fraction(0);
    const totalCross = full.rates.get("xiranite_enr_powder")!.mul(5);
    const totalProd = liquidRate.add(purifierRate);
    const expectedLiquid = totalCross.mul(liquidRate).div(totalProd);
    const expectedPurifier = totalCross.mul(purifierRate).div(totalProd);

    expect(
      (byProducer.get("liquid_xiranite_poly") ?? new Fraction(0)).equals(
        expectedLiquid,
      ),
    ).toBe(true);
    expect(
      (
        byProducer.get("liquid_xiranite_poly-purifier") ?? new Fraction(0)
      ).equals(expectedPurifier),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Back-edge tearing lock: pickTearEdges tears DFS back edges, which provably
// covers every directed cycle of a multi-member SCC. Lock that on the witness
// plans (including the formerly deferred torn-arc pair): the full solve +
// render completes clean, every multi-member SCC contributes at least one
// torn edge, and the rendered liquid_xiranite_poly inflow into
// xiranite_enr_powder stays exactly its LP demand (5 per execution).
// ---------------------------------------------------------------------------
describe("torn-arc coverage: back-edge tearing on witness plans", () => {
  const WITNESS_PLANS: ReadonlyArray<{ name: string; recipeIds: string[] }> = [
    { name: "proc_battery_5", recipeIds: ["proc_battery_5"] },
    { name: "xiranite_enr_powder", recipeIds: ["xiranite_enr_powder"] },
    { name: "pair", recipeIds: ["proc_battery_5", "xiranite_enr_powder"] },
    { name: "CONTROL", recipeIds: ["xiranite_poly", "xiranite_enr_powder"] },
  ];

  for (const { name, recipeIds } of WITNESS_PLANS) {
    it(`${name}: clean render, every multi-member SCC torn, exact enr inflow`, () => {
      const targets: Target[] = recipeIds.map((recipeId) => ({
        recipeId,
        ratePerSec: { num: "1", denom: "1" },
      }));
      const full = solvePlanWithIntermediates(
        targets,
        pack,
        defaultTransportConfig,
        [],
      );
      const { plan } = renderPlanFromSolve(full, pack, targets, []);
      const violations = checkRenderPlan({
        plan,
        rates: full.rates,
        pack,
        targets,
        itemOverrides: [],
      }).flatMap((r) => r.violations);
      expect(violations).toEqual([]);

      // Every multi-member SCC must own at least one torn (return-arc) edge.
      const multiSccs = full.condensation.sccs.filter(
        (s) => s.recipeIds.length > 1,
      );
      expect(multiSccs.length).toBeGreaterThan(0);
      for (const scc of multiSccs) {
        expect(
          full.torn.some((t) => t.sccId === scc.id),
          `SCC ${scc.id} has no torn edge`,
        ).toBe(true);
      }

      // Inflow equality on the cross-boundary consumer (when rendered).
      const enrUnitIds = new Set(
        plan.units
          .filter(
            (u) => u.kind === "recipe" && u.recipeId === "xiranite_enr_powder",
          )
          .map((u) => u.id),
      );
      if (enrUnitIds.size > 0) {
        let inflow = new Fraction(0);
        for (const e of plan.edges) {
          if (e.item !== "liquid_xiranite_poly") continue;
          if (enrUnitIds.has(e.toUnit)) inflow = inflow.add(e.rate);
        }
        const enrRate = full.rates.get("xiranite_enr_powder") ?? new Fraction(0);
        expect(inflow.equals(enrRate.mul(5))).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Co-product sibling-replica fanning regression (P6).
//
// liquid_xiranite_poly (in the liquid_xiranite SCC) splits into a looper and a
// deliverer; both stamps physically co-produce liquid_xiranite_lowpoly. The
// co-product (non-driver) edge to its intra consumer was routed to only ONE
// split sibling's outgoingEdgeFilter, so the other sibling's lowpoly production
// had no logical edge at all: it vanished from the graph while the wired sibling
// was billed the whole demand past its own production. Fanning the co-product
// edge across BOTH siblings gives each its share and clears the per-unit
// outflow-vs-production check for the liquid_xiranite_poly units.
// ---------------------------------------------------------------------------
describe("render corpus: co-product fans across sibling replicas (P6)", () => {
  const P6_TARGETS: Target[] = [
    {
      recipeId: "jinlong_coupon-xiranite_enr_powder",
      ratePerSec: { num: "1", denom: "1" },
    },
    {
      recipeId: "jinlong_coupon-proc_battery_5",
      ratePerSec: { num: "1", denom: "1" },
    },
  ];

  function solveP6() {
    const full = solvePlanWithIntermediates(
      P6_TARGETS,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, P6_TARGETS, []);
    return { full, plan };
  }

  // (i) No liquid_xiranite-unit outflow-vs-production violation: every
  // liquid_xiranite_poly stamp ships at most what it produces, and the
  // lowpoly/poly co-products no longer vanish off the graph.
  it("checkUnitOutflowVsProduction reports no liquid_xiranite violations", () => {
    const { full, plan } = solveP6();
    const result = checkUnitOutflowVsProduction({
      plan,
      rates: full.rates,
      pack,
      targets: P6_TARGETS,
      itemOverrides: [],
    });
    const xiranite = result.violations.filter((v) =>
      v.includes("liquid_xiranite"),
    );
    expect(xiranite).toEqual([]);
    // The full violation list is also empty (no unrelated residual remains).
    expect(result.violations).toEqual([]);
  });

  // (ii) Fraction-exact: the total liquid_xiranite_lowpoly shipped out of the
  // liquid_xiranite_poly units equals their combined production (the LP rate of
  // liquid_xiranite_poly, since out qty is 1). Derived from full.rates, not
  // hardcoded.
  it("total lowpoly shipped equals combined liquid_xiranite_poly production", () => {
    const { full, plan } = solveP6();
    const polyUnitIds = new Set(
      plan.units
        .filter((u) => u.kind === "recipe" && u.recipeId === "liquid_xiranite_poly")
        .map((u) => u.id),
    );
    let shipped = new Fraction(0);
    for (const e of plan.edges) {
      if (e.item !== "liquid_xiranite_lowpoly") continue;
      if (polyUnitIds.has(e.fromUnit)) shipped = shipped.add(e.rate);
    }
    const recipe = pack.recipes.find((r) => r.id === "liquid_xiranite_poly")!;
    const lowpolyQty = recipe.out.find(
      (o) => o.item === "liquid_xiranite_lowpoly",
    )!.qty;
    const production = (full.rates.get("liquid_xiranite_poly") ?? new Fraction(0)).mul(
      new Fraction(lowpolyQty),
    );
    expect(production.compare(0)).toBeGreaterThan(0);
    expect(shipped.equals(production)).toBe(true);
  });

  // (iii) P6 is clean on all 7 checkRenderPlan checkers today and must stay so.
  it("all checkRenderPlan checkers report zero violations", () => {
    const { full, plan } = solveP6();
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets: P6_TARGETS,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bug 3 (KD-F): the target-output edge pass aggregated spare per MACHINE VERTEX
// (produced - outgoing, clamping negatives away) before splitting the declared
// target rate across producers. A folded render unit's stamps get offsetting
// +/- residuals from the per-stamp consumer wiring; the per-vertex clamp keeps
// the positive half and inflates that unit's apparent spare, so the
// proportional split over-feeds it and under-feeds the unit with real spare.
// The fix aggregates spare per render UNIT (sum produced and outgoing across the
// unit's stamps first, difference once) before the split.
//
// These three plans are the witnesses from the burn-down: a unit with ZERO true
// spare must get NO target edge, the split must be exact in true-spare
// proportion, and the per-unit outflow-vs-production checker must stay clean.
// ---------------------------------------------------------------------------
describe("render corpus: target-edge spare aggregates per render unit (Bug 3)", () => {
  // For every recipe unit that produces `item` (across all recipes that output
  // it as a primary product or co-product), derive (from the rendered plan +
  // pack, mirroring checkUnitOutflowVsProduction's production formula) its
  // production of `item`, its consumer-edge outflow (edges to non-output-product
  // units), its true spare, and its target-edge rate (edges to the u:out:<item>
  // unit). Optionally restrict to a single recipeId.
  function producerSpares(
    plan: RenderPlan,
    item: string,
    recipeId?: string,
  ): Array<{
    unitId: string;
    recipeId: string;
    production: Fraction;
    consumerOut: Fraction;
    trueSpare: Fraction;
    targetEdge: Fraction;
  }> {
    const outputUnitIds = new Set(
      plan.units.filter((u) => u.kind === "outputProduct").map((u) => u.id),
    );
    const targetOutputUnitId = plan.units.find(
      (u) => u.kind === "outputProduct" && u.itemId === item,
    )?.id;
    const rows: ReturnType<typeof producerSpares> = [];
    for (const u of plan.units) {
      if (u.kind !== "recipe") continue;
      if (recipeId !== undefined && u.recipeId !== recipeId) continue;
      const recipe = pack.recipes.find((r) => r.id === u.recipeId);
      const out = recipe?.out.find((o) => o.item === item);
      if (!recipe || !out) continue;
      const producerId = recipe.producers[0];
      const machine =
        producerId === undefined
          ? undefined
          : pack.machines.find((m) => m.id === producerId);
      const speed = machine ? new Fraction(machine.speed) : new Fraction(1);
      const production = rationalFromString(u.multiplicity)
        .mul(speed)
        .div(new Fraction(recipe.time))
        .mul(new Fraction(out.qty));
      let consumerOut = new Fraction(0);
      let targetEdge = new Fraction(0);
      for (const e of plan.edges) {
        if (e.fromUnit !== u.id || e.item !== item) continue;
        if (e.toUnit === targetOutputUnitId) targetEdge = targetEdge.add(e.rate);
        else if (!outputUnitIds.has(e.toUnit))
          consumerOut = consumerOut.add(e.rate);
      }
      rows.push({
        unitId: u.id,
        recipeId: u.recipeId,
        production,
        consumerOut,
        trueSpare: production.sub(consumerOut),
        targetEdge,
      });
    }
    return rows;
  }

  // P7: plant_moss_seed_3 producers. One producing unit has zero true spare (its
  // whole production goes to consumer edges) and must get NO target edge; the
  // unit with full spare (1.0) must carry the entire declared rate.
  it("P7 [plant_moss_seed_3, plant_moss_powder_3]: zero-spare unit gets no target edge", () => {
    const targets: Target[] = [
      { recipeId: "plant_moss_seed_3", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "plant_moss_powder_3", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);

    const rows = producerSpares(plan, "plant_moss_seed_3");
    const zeroSpare = rows.filter((r) => r.trueSpare.equals(new Fraction(0)));
    const withSpare = rows.filter((r) => r.trueSpare.compare(0) > 0);
    // Structural witness: exactly one zero-spare unit and one spare-bearing unit
    // with spare 1.0 (the declared rate). Guards the fix against a regression
    // that also changes the plan shape.
    expect(zeroSpare.length).toBe(1);
    expect(withSpare.length).toBe(1);
    const [zero] = zeroSpare;
    const [spareBearing] = withSpare;
    expect(zero!.targetEdge.equals(new Fraction(0))).toBe(true);
    expect(spareBearing!.trueSpare.equals(new Fraction(1))).toBe(true);
    expect(spareBearing!.targetEdge.equals(new Fraction(1))).toBe(true);

    // All checkRenderPlan checkers clean.
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
  });

  // P8: liquid_xiranite_poly producers, with liquid_xiranite_poly itself a
  // target. The two SCC producers (the poly recipe and the purifier) feed the
  // cross-boundary consumer xiranite_enr_powder. The supplyShares apportionment
  // (F7) splits that demand by each producer's committed flow net of the poly
  // recipe's own target draw, so the purifier's whole output is consumed by the
  // cross + intra edges (zero spare, no target edge) and the dedicated poly
  // recipe carries the entire declared target rate. The target edge still equals
  // each producer's true-spare share of the declared rate (Bug 3 fix:
  // per-render-unit aggregation, not the pre-fix per-vertex clamp).
  it("P8 [xiranite_enr_powder, liquid_xiranite_poly]: target split is exact spare proportion", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "liquid_xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);

    const allRows = producerSpares(plan, "liquid_xiranite_poly");
    const rows = allRows.filter(
      (r) => r.targetEdge.compare(0) > 0 || r.trueSpare.compare(0) > 0,
    );
    const totalSpare = rows.reduce(
      (acc, r) => acc.add(r.trueSpare),
      new Fraction(0),
    );
    const declared = new Fraction(1);
    expect(totalSpare.compare(0)).toBeGreaterThan(0);
    // Each producer's target edge equals its true-spare share of the declared
    // rate (derived from production minus consumer-edge outflow).
    for (const r of rows) {
      const expected = r.trueSpare.mul(declared).div(totalSpare);
      expect(r.targetEdge.equals(expected)).toBe(true);
    }
    // The purifier is fully consumed by its cross + intra edges (zero spare, no
    // target edge); only the dedicated liquid_xiranite_poly recipe carries spare,
    // and it equals the whole declared rate.
    const purifier = allRows.find(
      (r) => r.recipeId === "liquid_xiranite_poly-purifier",
    );
    expect(purifier).toBeDefined();
    expect(purifier!.trueSpare.equals(new Fraction(0))).toBe(true);
    expect(purifier!.targetEdge.equals(new Fraction(0))).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0]!.recipeId).toBe("liquid_xiranite_poly");
    expect(rows[0]!.trueSpare.equals(declared)).toBe(true);
    expect(rows[0]!.targetEdge.equals(declared)).toBe(true);

    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
  });

  // Purifier witness: a folded purifier unit (production 4/5 of
  // liquid_xiranite_poly) folds two stamps with offsetting +1/6 and -1/30
  // residuals. The pre-fix per-vertex clamp inflated its spare to 1/6, handing it
  // 5/31 of the declared rate and over-shipping it past production (0.828 > 0.8).
  // Per-unit aggregation reports zero outflow-vs-production violations.
  it("purifier [carbon_enr, liquid_xiranite_poly-purifier]: no outflow-vs-production violation", () => {
    const targets: Target[] = [
      { recipeId: "carbon_enr", ratePerSec: { num: "1", denom: "1" } },
      {
        recipeId: "liquid_xiranite_poly-purifier",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);

    const outflow = checkUnitOutflowVsProduction({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    });
    expect(outflow.violations).toEqual([]);

    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bug 2b (Task 5b): torn-arc loop-return edges fanned across sibling stamps +
// capacity-capped edge billing. liquid_xiranite_poly splits into a looper and a
// deliverer SCC-member stamp that BOTH own the lowpoly loop edge. The torn-arc
// pass used to pick a single source stamp and bill the whole loop edge to it,
// so the sibling stamp produced lowpoly with no edge drawing from it while the
// picked stamp over-shipped past its production. The consumer's single inbound
// edge then billed full demand past the wired producer's capacity.
//
// The assemble fan now wires EVERY surviving source stamp that owns the loop
// edge, and computeEdgeRates splits each consumer's demand across its inbound
// arcs by producer output share, so every liquid_xiranite_poly stamp ships
// exactly its production. Witnesses: xiranite_poly+xiranite_enr_powder and
// proc_battery_5+xiranite_enr_powder.
// ---------------------------------------------------------------------------
describe("render corpus: torn-arc returns fan across sibling stamps (Bug 2b)", () => {
  const WITNESSES: ReadonlyArray<{ name: string; recipeIds: string[] }> = [
    { name: "xiranite_poly+xiranite_enr_powder", recipeIds: ["xiranite_poly", "xiranite_enr_powder"] },
    { name: "proc_battery_5+xiranite_enr_powder", recipeIds: ["proc_battery_5", "xiranite_enr_powder"] },
  ];

  for (const w of WITNESSES) {
    const targets: Target[] = w.recipeIds.map((recipeId) => ({
      recipeId,
      ratePerSec: { num: "1", denom: "1" },
    }));

    function solveWitness() {
      const full = solvePlanWithIntermediates(
        targets,
        pack,
        defaultTransportConfig,
        [],
      );
      const { plan } = renderPlanFromSolve(full, pack, targets, []);
      return { full, plan };
    }

    // (i) checkUnitOutflowVsProduction reports zero violations: no
    // liquid_xiranite_poly stamp ships more lowpoly than it produces.
    it(`${w.name}: checkUnitOutflowVsProduction reports zero violations`, () => {
      const { full, plan } = solveWitness();
      const result = checkUnitOutflowVsProduction({
        plan,
        rates: full.rates,
        pack,
        targets,
        itemOverrides: [],
      });
      expect(result.violations).toEqual([]);
    });

    // (ii) Fraction-exact: for EVERY liquid_xiranite_poly unit, its total
    // outgoing lowpoly billed rate equals its production (out qty is 1, so
    // production == that unit's execution rate). Mirrors the P6 production
    // formula but asserts per unit, not just in aggregate, since the bug was a
    // per-stamp over-ship that nets out in the total.
    it(`${w.name}: per-unit lowpoly outflow equals production for every liquid_xiranite_poly unit`, () => {
      const { plan } = solveWitness();
      const recipe = pack.recipes.find((r) => r.id === "liquid_xiranite_poly")!;
      const producerId = recipe.producers[0];
      const machine =
        producerId === undefined
          ? undefined
          : pack.machines.find((m) => m.id === producerId);
      const speed = machine ? new Fraction(machine.speed) : new Fraction(1);
      const lowpolyQty = recipe.out.find(
        (o) => o.item === "liquid_xiranite_lowpoly",
      )!.qty;

      const polyUnits = plan.units
        .filter(isRecipeUnit)
        .filter((u) => u.recipeId === "liquid_xiranite_poly");
      expect(polyUnits.length).toBeGreaterThan(0);
      for (const u of polyUnits) {
        const production = rationalFromString(u.multiplicity)
          .mul(speed)
          .div(new Fraction(recipe.time))
          .mul(new Fraction(lowpolyQty));
        let shipped = new Fraction(0);
        for (const e of plan.edges) {
          if (e.item !== "liquid_xiranite_lowpoly") continue;
          if (e.fromUnit === u.id) shipped = shipped.add(e.rate);
        }
        expect(production.compare(0)).toBeGreaterThan(0);
        expect(
          shipped.equals(production),
          `${w.name} unit ${u.id}: shipped ${shipped.toFraction()} != production ${production.toFraction()}`,
        ).toBe(true);
      }
    });

    // (iii) All nine checkRenderPlan checkers clean.
    it(`${w.name}: all nine checkRenderPlan checkers report zero violations`, () => {
      const { full, plan } = solveWitness();
      const results = checkRenderPlan({
        plan,
        rates: full.rates,
        pack,
        targets,
        itemOverrides: [],
      });
      expect(results.length).toBe(9);
      expect(results.flatMap((r) => r.violations)).toEqual([]);
    });
  }

  // Dev-throw seam: after the assemble fan, every consumer of a split-producer
  // item is wired to all sibling producers, so a consumer with insufficient
  // total inbound capacity cannot arise on a public-path plan. The capacity
  // guard's dev-throw is therefore covered by unit-testing the exported pure
  // helper directly. One producer (cap 1) feeds a consumer demanding 3 with no
  // sibling to absorb the freed 2: capProducerInputOutflow must throw under DEV,
  // naming the consumer, item, freed demand, and the dropped-supplier cause.
  it("capProducerInputOutflow throws under DEV when inbound capacity falls short", () => {
    const groupKey = "consumerX\0itemY";
    const edges: CapEdge[] = [
      {
        edgeId: "e1",
        producerId: "p1",
        groupKey,
        item: "itemY",
        rate: new Fraction(3),
        capacity: new Fraction(1),
      },
    ];
    const result = new Map<string, Fraction>([["e1", new Fraction(3)]]);
    vi.stubEnv("DEV", true);
    try {
      expect(() => capProducerInputOutflow(edges, result)).toThrow(
        /consumer "consumerX" item "itemY"/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // No-op property: when every producer's billed outflow is within capacity the
  // helper leaves the rates bit-identical (clean plans untouched).
  it("capProducerInputOutflow is a no-op when no producer is over capacity", () => {
    const groupKey = "consumerX\0itemY";
    const edges: CapEdge[] = [
      {
        edgeId: "e1",
        producerId: "p1",
        groupKey,
        item: "itemY",
        rate: new Fraction(2),
        capacity: new Fraction(5),
      },
      {
        edgeId: "e2",
        producerId: "p2",
        groupKey,
        item: "itemY",
        rate: new Fraction(1),
        capacity: new Fraction(4),
      },
    ];
    const result = new Map<string, Fraction>([
      ["e1", new Fraction(2)],
      ["e2", new Fraction(1)],
    ]);
    capProducerInputOutflow(edges, result);
    expect(result.get("e1")!.equals(new Fraction(2))).toBe(true);
    expect(result.get("e2")!.equals(new Fraction(1))).toBe(true);
  });

  // Redistribution: an over-billed producer (cap 1, billed 3) caps to its
  // capacity and the freed 2 refills the sibling with spare, exact-rational.
  it("capProducerInputOutflow caps the saturated producer and refills the sibling", () => {
    const groupKey = "consumerX\0itemY";
    const edges: CapEdge[] = [
      {
        edgeId: "e1",
        producerId: "p1",
        groupKey,
        item: "itemY",
        rate: new Fraction(3),
        capacity: new Fraction(1),
      },
      {
        edgeId: "e2",
        producerId: "p2",
        groupKey,
        item: "itemY",
        rate: new Fraction(0),
        capacity: new Fraction(5),
      },
    ];
    const result = new Map<string, Fraction>([
      ["e1", new Fraction(3)],
      ["e2", new Fraction(0)],
    ]);
    capProducerInputOutflow(edges, result);
    // p1 capped to 1, p2 absorbs the freed 2. Total demand (3) preserved.
    expect(result.get("e1")!.equals(new Fraction(1))).toBe(true);
    expect(result.get("e2")!.equals(new Fraction(2))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared byproduct supplier apportionment (plan:true override).
//
// With liquid_water planned in-graph, the SCC-resident purifier supplies its
// water byproduct to several sibling SCC members at once. replicate computes
// the exact per-consumer committed supply, but the replica contract used to
// drop it; computeEdgeRates then weighted the purifier's edge in EVERY consumer
// group by its FULL water production, over-billing it several times over and
// dead-ending capProducerInputOutflow (DEV throw, Kirchhoff-violating rates in
// prod). The supplyShares channel carries the committed flows into the edge
// split, so the purifier is billed exactly its production and each consumer's
// inflow equals its LP demand.
// ---------------------------------------------------------------------------
describe("render corpus: shared byproduct supplier apportionment (plan:true override)", () => {
  const WATER_OVERRIDE = [{ itemId: "liquid_water", plan: true as const }];

  // Sum rendered liquid_water flow per producing / consuming recipe id.
  function waterFlowsByRecipe(targets: Target[]) {
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      WATER_OVERRIDE,
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, WATER_OVERRIDE);
    const unitRecipe = new Map<string, string>();
    for (const u of plan.units) {
      if (u.kind === "recipe") unitRecipe.set(u.id, u.recipeId);
    }
    const outflow = new Map<string, Fraction>();
    const inflow = new Map<string, Fraction>();
    for (const e of plan.edges) {
      if (e.item !== "liquid_water") continue;
      const from = unitRecipe.get(e.fromUnit);
      if (from !== undefined) {
        outflow.set(from, (outflow.get(from) ?? new Fraction(0)).add(e.rate));
      }
      const to = unitRecipe.get(e.toUnit);
      if (to !== undefined) {
        inflow.set(to, (inflow.get(to) ?? new Fraction(0)).add(e.rate));
      }
    }
    return { full, outflow, inflow };
  }

  // Per-producer Kirchhoff: every recipe shipping water ships exactly its LP
  // production (rate * out qty), surplus and target edges included.
  function expectWaterOutflowMatchesProduction(
    full: ReturnType<typeof solvePlanWithIntermediates>,
    outflow: ReadonlyMap<string, Fraction>,
  ): void {
    expect(outflow.size).toBeGreaterThan(0);
    for (const [rid, shipped] of outflow) {
      const recipe = full.recipeById.get(rid)!;
      const outQty = recipe.out.find((o) => o.item === "liquid_water")!.qty;
      const production = full.rates.get(rid)!.mul(new Fraction(outQty));
      expect(
        shipped.equals(production),
        `producer ${rid}: shipped ${shipped.toFraction()} != production ${production.toFraction()}`,
      ).toBe(true);
    }
  }

  // Per-consumer demand: every recipe drawing water draws exactly its LP demand
  // (rate * in qty).
  function expectWaterInflowMatchesDemand(
    full: ReturnType<typeof solvePlanWithIntermediates>,
    inflow: ReadonlyMap<string, Fraction>,
  ): void {
    expect(inflow.size).toBeGreaterThan(0);
    for (const [rid, fed] of inflow) {
      const recipe = full.recipeById.get(rid)!;
      const inQty = recipe.in.find((s) => s.item === "liquid_water")!.qty;
      const demand = full.rates.get(rid)!.mul(new Fraction(inQty));
      expect(
        fed.equals(demand),
        `consumer ${rid}: fed ${fed.toFraction()} != demand ${demand.toFraction()}`,
      ).toBe(true);
    }
  }

  // B4L4-b filed repro. At HEAD the purifier's 4 water edges summed to 3.2x its
  // production and capProducerInputOutflow dead-ended with a DEV throw inside
  // renderPlanFromSolve.
  it("xiranite_poly@1/s + planned water: exact per-recipe water flows, no DEV throw", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { full, outflow, inflow } = waterFlowsByRecipe(targets);
    expectWaterOutflowMatchesProduction(full, outflow);
    expectWaterInflowMatchesDemand(full, inflow);
  });

  // The report's second reproducer of the same mechanism.
  it("proc_battery_5@1/s + planned water: exact per-recipe water flows, no DEV throw", () => {
    const targets: Target[] = [
      { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    const { full, outflow, inflow } = waterFlowsByRecipe(targets);
    expectWaterOutflowMatchesProduction(full, outflow);
    expectWaterInflowMatchesDemand(full, inflow);
  });

  // Combined worst case: the torn P2 plan plus the water override. The purifier
  // is role-split into two stamps (looper + deliverer) and its water byproduct
  // fans BOTH stamps into several interlocking consumer groups, so the recorded
  // recipe-level flow must additionally be apportioned across the split stamps
  // by their output shares. Pins the within-recipe apportionment and the
  // cross-boundary split divergence in one plan.
  it("P2-torn + planned water: split purifier stamps bill water within production", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      {
        recipeId: "jinlong_coupon-xiranite_enr_powder",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const { full, outflow } = waterFlowsByRecipe(targets);
    expectWaterOutflowMatchesProduction(full, outflow);
  });
});

// ---------------------------------------------------------------------------
// Edge-rate bit-identity guard. NOT a TDD red test: it passes both before and
// after the supplyShares weighting change. It pins the exact edge-rate
// Fractions of one clean corpus plan (copper_enr_cmpt has a single producer
// per input plus the liquid_copper <-> liquid_copper_enr loop, so it exercises
// both the fallback and the recorded single-edge paths) as literal expected
// values, so any future change to the edge-weighting that disturbs clean
// wiring fails loudly here. legacyPack: the v1.4 gas machines reroute copper
// through copper_jar/filter_core with multiple producers per input, which is
// a different shape than this guard pins; the pre-gas route keeps the
// single-producer-plus-loop structure the literal was built for.
// ---------------------------------------------------------------------------
describe("render corpus: edge-rate bit-identity guard (copper_enr_cmpt)", () => {
  it("copper_enr_cmpt@1/s edge rates match the pinned literal snapshot", () => {
    const targets: Target[] = [
      { recipeId: "copper_enr_cmpt", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      legacyPack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, legacyPack, targets, []);
    const unitLabel = new Map<string, string>();
    for (const u of plan.units) {
      unitLabel.set(u.id, u.kind === "recipe" ? u.recipeId : `${u.kind}:${u.id}`);
    }
    const lines = plan.edges
      .map(
        (e) =>
          `${unitLabel.get(e.fromUnit)} -> ${unitLabel.get(e.toUnit)} ` +
          `[${e.item}] ${e.rate.toFraction()}`,
      )
      .sort();
    expect(lines).toEqual([
      "copper_enr -> copper_enr_cmpt [copper_enr] 5",
      "copper_enr -> outputProduct:u:surplus:liquid_sewage [liquid_sewage] 5",
      "copper_enr_cmpt -> outputProduct:u:out:copper_enr_cmpt [copper_enr_cmpt] 1",
      "copper_nugget -> copper_powder [copper_nugget] 40",
      "copper_nugget -> outputProduct:u:surplus:liquid_sewage [liquid_sewage] 40",
      "copper_powder -> liquid_copper [copper_powder] 40",
      "inputProduct:u:in:copper_ore -> copper_nugget [copper_ore] 40",
      "inputProduct:u:in:iron_ore -> iron_nugget-iron_ore [iron_ore] 5",
      "inputProduct:u:in:liquid_acid -> liquid_copper [liquid_acid] 30",
      "inputProduct:u:in:liquid_water -> copper_nugget [liquid_water] 40",
      "iron_nugget-iron_ore -> iron_powder [iron_nugget] 5",
      "iron_powder -> copper_enr [iron_powder] 5",
      "liquid_copper -> liquid_copper_enr [liquid_copper] 40",
      "liquid_copper_enr -> copper_enr [liquid_copper_enr] 10",
      "liquid_copper_enr -> liquid_copper [liquid_acid] 10",
    ]);
  });
});
