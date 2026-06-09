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

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { CLOSED_FORM_FIXTURES } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import type { Target } from "../../data/targets";
import { renderPlanFromSolve } from "../driver";
import { assertRenderInvariants, checkRenderPlan } from "./invariants";
import { pack } from "../../data/load";
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
