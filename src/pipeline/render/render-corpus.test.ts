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
import { assertRenderInvariants, checkRenderPlan } from "./invariants";
import { pack } from "../../data/load";
import { checkRepresentable, checkMassBalance } from "../../solver/invariants";
import { solveLp } from "../../solver/lp";
import { loadPlan } from "../../data/plan";
import { planToSolverArgs } from "../../solver/planToSolverArgs";
import { isMachineRecipeVertex } from "../types";

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
// After isInvariantThrow classification (below) the swept population is green
// and two deferred buckets are excluded and pinned as xfail tests below (each
// asserts the plan still throws its dev invariant and will start failing once
// the defect is fixed):
//   - copper_enr+liquid_xiranite_enr (multi-target solver mass-balance residual),
//   - 34 transfer_tundra_* single-target plans (DEFERRED_TUNDRA), each tripping
//     the SOLVER dev invariant with the same mass-balance residual (~6.67e-4),
//     one shared solver-residual defect the old blanket solve-catch silently
//     skipped (the other 25 transfer_tundra recipes are clean and stay green).
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

// Known, still-open defects. Excluded from the green sweep and pinned as xfail
// tests below (each passes now because the plan still fails, and will start
// failing once the defect is fixed):
//   - copper_enr+liquid_xiranite_enr (multi-target): solver mass-balance
//     residual (~2.4e-4 on liquid_sewage) trips the solver dev invariant.
//   - 34 transfer_tundra_* single-target plans (DEFERRED_TUNDRA below): each
//     trips the SOLVER dev invariant with an identical mass-balance residual
//     (~6.67e-4), one shared solver-residual defect, same nature as
//     copper_enr+liquid_xiranite_enr. The blanket solve-catch used to hide it
//     as a skip; the classification now surfaces it. Pinned rather than fixed
//     because the solver is out of scope. The other 25 transfer_tundra recipes
//     solve+render clean and stay in the green sweep, hence an explicit name set
//     rather than a prefix match.
const KNOWN_DEFERRED: ReadonlySet<string> = new Set([
  "copper_enr+liquid_xiranite_enr",
]);

// The 34 transfer_tundra_* single-target plans that trip the solver dev
// invariant (shared mass-balance residual ~6.67e-4). Deferred, pinned as an
// xfail below. Listed explicitly because 25 sibling transfer_tundra recipes are
// clean and remain in the green sweep.
const DEFERRED_TUNDRA: ReadonlySet<string> = new Set([
  "transfer_tundra_carbon_enr",
  "transfer_tundra_carbon_enr_powder",
  "transfer_tundra_carbon_mtl",
  "transfer_tundra_carbon_powder",
  "transfer_tundra_crystal_powder",
  "transfer_tundra_crystal_shell",
  "transfer_tundra_glass_cmpt",
  "transfer_tundra_iron_cmpt",
  "transfer_tundra_iron_nugget",
  "transfer_tundra_iron_powder",
  "transfer_tundra_originium_enr_powder",
  "transfer_tundra_originium_powder",
  "transfer_tundra_plant_bbflower_1",
  "transfer_tundra_plant_bbflower_powder_1",
  "transfer_tundra_plant_bbflower_seed_1",
  "transfer_tundra_plant_grass_1",
  "transfer_tundra_plant_grass_2",
  "transfer_tundra_plant_grass_powder_1",
  "transfer_tundra_plant_grass_powder_2",
  "transfer_tundra_plant_grass_seed_1",
  "transfer_tundra_plant_grass_seed_2",
  "transfer_tundra_plant_moss_1",
  "transfer_tundra_plant_moss_2",
  "transfer_tundra_plant_moss_3",
  "transfer_tundra_plant_moss_enr_powder_1",
  "transfer_tundra_plant_moss_enr_powder_2",
  "transfer_tundra_plant_moss_powder_1",
  "transfer_tundra_plant_moss_powder_2",
  "transfer_tundra_plant_moss_powder_3",
  "transfer_tundra_plant_moss_seed_1",
  "transfer_tundra_plant_moss_seed_2",
  "transfer_tundra_plant_moss_seed_3",
  "transfer_tundra_quartz_glass",
  "transfer_tundra_quartz_powder",
]);

function isDeferred(name: string): boolean {
  return KNOWN_DEFERRED.has(name) || DEFERRED_TUNDRA.has(name);
}

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

    // Single-target sweep over the whole recipe pack, minus the deferred
    // transfer_tundra_* solver-residual family (pinned as an xfail below).
    for (const r of pack.recipes) {
      if (isDeferred(r.id)) continue;
      const targets: Target[] = [
        { recipeId: r.id, ratePerSec: { num: "1", denom: "1" } },
      ];
      const { failures } = sweepPlan(r.id, targets);
      allFailures.push(...failures);
    }

    // Multi-target plans, minus the known-deferred set (pinned as xfail below).
    for (const mt of MULTI_TARGET_PLANS) {
      if (isDeferred(mt.name)) continue;
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

  // xfail pin for the known-deferred multi-target plan. Asserts the plan
  // currently fails (the dev assertion throws), so this test passes now and
  // documents the known-bad state. It will start failing once the defect is
  // fixed.
  //
  // copper_enr+liquid_xiranite_enr: solver mass-balance residual (~2.4e-4 on
  // liquid_sewage) trips the solver dev invariant assertion in
  // solvePlanWithIntermediates.
  it("xfail (deferred): copper_enr+liquid_xiranite_enr still throws solver invariants", () => {
    const targets: Target[] = ["copper_enr", "liquid_xiranite_enr"].map(
      (recipeId) => ({ recipeId, ratePerSec: { num: "1", denom: "1" } }),
    );
    expect(() => {
      const full = solvePlanWithIntermediates(
        targets,
        pack,
        defaultTransportConfig,
        [],
      );
      renderPlanFromSolve(full, pack, targets, []);
    }).toThrow(/solver invariants violated/);
  });

  // The 34 deferred transfer_tundra_* single-target plans each trip the solver
  // dev invariant with an identical mass-balance residual (~6.67e-4). One shared
  // solver-residual defect, previously hidden by the blanket solve-catch. This
  // pin asserts each still throws the solver invariant and will start failing
  // (per recipe) once the residual is fixed, prompting removal of that recipe
  // from DEFERRED_TUNDRA.
  it("xfail (deferred): the 34 transfer_tundra_* plans still throw solver invariants", () => {
    expect(DEFERRED_TUNDRA.size).toBe(34);
    for (const recipeId of DEFERRED_TUNDRA) {
      const targets: Target[] = [
        { recipeId, ratePerSec: { num: "1", denom: "1" } },
      ];
      expect(
        () =>
          solvePlanWithIntermediates(targets, pack, defaultTransportConfig, []),
        `expected ${recipeId} to still throw the solver dev invariant`,
      ).toThrow(/solver invariants violated/);
    }
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

function machineCountGaps(targets: Target[]) {
  const full = solvePlanWithIntermediates(
    targets,
    pack,
    defaultTransportConfig,
    [],
  );
  const out = renderPlanFromSolve(full, pack, targets, []);
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
    pack,
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

  // The off-graph CHAIN case: originium_powder -> originium_enr_powder ->
  // proc_battery_5 are all LP-active and all unreachable from the target cone.
  // This is the only plan that augments the whole chain (augSize == 3), and it
  // also activates the four AP-flip recipes (carbon_enr, liquid_xiranite,
  // liquid_xiranite_poly, xiranite_powder) whose articulation status the closure
  // shifts. The closure renders every augmented recipe and never drops a
  // previously-correct machine.
  //
  // This exact target pair also carries a pre-existing LP-solver mass-balance
  // residual on originium_powder (~1.2e-6, net -1/833333), the same deferred
  // solver-residual class pinned as xfail above (transfer_tundra,
  // copper_enr+liquid_xiranite_enr). The residual is solver-side and orthogonal
  // to graph membership: solveLp returns it for this plan with or without the
  // closure, and no residual-free xiranite plan exercises this chain. Under DEV
  // (the default in tests) solvePlanWithIntermediates runs assertInvariants and
  // the render driver runs the render-invariant hook, both of which throw on
  // that tolerated residual before any render-level contract can be asserted.
  //
  // To assert the render-level contract the closure exists to satisfy, this test
  // stubs DEV off for the duration of the solve+render (vi.stubEnv("DEV",
  // false)), which skips both dev hooks so machineCountGaps and
  // solvePlanWithIntermediates return normally. The finally block restores the
  // env so no other test is affected. gaps == [] pins every recipe in the LP
  // support at vtxSum == lpRate -- the three augmented off-graph chain recipes
  // AND the four AP-flip recipes -- and violations == [] covers all seven render
  // checkers. The deferred solver residual is kept visible by checking the raw
  // LpResult directly: it must be the only mass-balance violation and must name
  // originium_powder, never a missing-node augmentation failure.
  it("xiranite chain plan augments and renders the off-graph originium chain", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      {
        recipeId: "liquid_xiranite_poly-purifier",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];

    vi.stubEnv("DEV", false);
    try {
      // DEV is off here, so neither the solver dev assertion nor the render dev
      // hook throws on the deferred residual; the render-level contract runs.
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
    } finally {
      vi.unstubAllEnvs();
    }

    // The deferred solver residual stays visible and is the only mass-balance
    // violation: it must name originium_powder and must not be a missing-node
    // augmentation failure.
    const lp = solveLp({ targets, pack, itemOverrides: [] });
    const mb = checkMassBalance(lp, pack, targets, []);
    expect(mb.violations.length).toBe(1);
    expect(mb.violations[0]).toMatch(/originium_powder/);
    expect(mb.violations[0]).not.toMatch(/has no node in the logical graph/);
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
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
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
