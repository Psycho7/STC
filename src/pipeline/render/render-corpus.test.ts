// End-to-end render corpus test.
//
// Known-good group: the four feasible closed-form micro-fixtures (chain,
// multi-producer, byproduct, raw-draw) all pass all seven render invariants
// as confirmed empirically before this file was written.
//
// RF-1 regression: the real-pack plan encoded in RF1_HASH contains an
// internally balanced intermediate item iron_nugget whose render edge used to
// be dropped (surfaced as a phantom surplus, consumer fed from nothing). The
// logical-graph edge wiring now routes the producer to the live consumer stamp,
// so this test pins that iron_nugget no longer triggers any render violation.

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

// RF-1: iron_nugget is an internally balanced intermediate but the render
// pipeline drops its internal edge, surfacing it as a phantom surplus product
// and leaving its consumer (iron_powder) without an input edge.
const RF1_HASH =
  "v1.H4sIAAAAAAAACo3NQYvCMBQE4P8y56g1tm6Tf7A3waOIpO-9LMFuE2LEQ8l_l94EXdjbHGa-mZEcXWFPkIl9kJFX5EbaeEcl5hBHN0ChWWsotJ7avTZt78X4fad50I3uetPtmHumxgw79mS-cFYooYwCCygUl3-k3GBPM7JQSPLNsKCYkuTLEMvSVMiuyEHyUQh2xnT_hcXyyjLFJW9Rq_okpPhgyX8I2xdBvwkhx-n_-xa1nusTppb41DIBAAA";

// The four feasible micro-fixtures: chain, multi-producer, byproduct, raw-draw.
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

// Real-pack render regression pins. Each names a single-target plan (rate 1)
// drawn from the full-recipe sweep's "dirty" set, one per render-drop class
// fixed here:
//   - quartz_powder / iron_powder: per-consumer producer wired to a zeroed-out
//     in-loop consumer stamp (the SCC looper/deliverer case); the live target
//     stamp got no input edge until the re-route pass (assembleLogicalGraph).
//   - plant_moss_seed_1: torn SCC return arc that used to fan into only one of
//     several live split consumer stamps (assembleLogicalGraph).
//   - copper_enr: byproduct-as-raw recapture -- liquid_acid is a byproduct of an
//     in-plan recipe yet has unlimited boundary supply, so the graph never
//     modeled its internal edge (deriveBoundaryProducts recapture pass).
//   - glass_enr_bottle: split-SCC surplus accounting -- per-machine surplus
//     differencing turned an even whole-unit balance into a phantom surplus
//     (deriveBoundaryProducts unit-level surplus aggregation).
// These render with zero invariant violations. (A handful of sweep-dirty plans
// remain on two deeper, distinct bugs these pins do not cover: multi-producer
// SCC routing and per-consumer over-replication.)
describe("render corpus: real-pack plans render clean", () => {
  const RENDER_PINS = [
    "quartz_powder",
    "iron_powder",
    "plant_moss_seed_1",
    "copper_enr",
    "glass_enr_bottle",
  ];
  for (const recipeId of RENDER_PINS) {
    it(`plan ${recipeId}=1 has no render violations`, () => {
      const targets: Target[] = [
        { recipeId, ratePerSec: { num: "1", denom: "1" } },
      ];
      const full = solvePlanWithIntermediates(
        targets,
        pack,
        defaultTransportConfig,
        [],
      );
      expect(() =>
        assertRenderInvariants({
          plan: renderPlanFromSolve(full, pack, targets, []).plan,
          rates: full.rates,
          pack,
          targets,
          itemOverrides: [],
        }),
      ).not.toThrow();
    });
  }
});

// Per-stamp edge-billing + target-output regression pins. One single-target
// plan per render-defect mechanism the per-stamp edge billing and broadened
// target-output spare source set close:
//   - iron_nugget-iron_powder: symmetric SCC whose target item (iron_nugget) is
//     co-produced by a leaf (iron_nugget-iron_ore); per-stamp producer-share
//     billing stops the consumer over-feed and the broadened target-output spare
//     set feeds the target edge from both producers.
//   - equip_script_4: plant_moss SCC whose consumer used to be billed the recipe
//     aggregate (double-feeding); per-stamp billing fixes the over-connection.
//   - xiranite_enr_powder: liquid_xiranite SCC consumer over-fed via the
//     aggregate rate; per-stamp billing brings inbound flow to exactly demand.
// All three render with zero invariant violations across all seven checkers.
describe("render corpus: per-stamp billing + target-output pins", () => {
  const STAMP_PINS = [
    "iron_nugget-iron_powder",
    "equip_script_4",
    "xiranite_enr_powder",
  ];
  for (const recipeId of STAMP_PINS) {
    it(`plan ${recipeId}=1 passes all render invariants`, () => {
      const targets: Target[] = [
        { recipeId, ratePerSec: { num: "1", denom: "1" } },
      ];
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
      const violations = results.flatMap((r) => r.violations);
      expect(violations).toEqual([]);
    });
  }
});

// Non-driver co-product routing pins. These three single-target plans each have
// an SCC member that co-produces a byproduct consumed intra-only while the
// driver output ships cross/target-out (so looperRate==0). Before the live-role
// filter fix the byproduct edges landed on the rate-0 looper, leaving the
// consumer unfed and surfacing a phantom byproduct surplus. They now render
// clean.
describe("render corpus: non-driver co-product routing pins", () => {
  const COPRODUCT_PINS = [
    "xiranite_poly",
    "proc_battery_5",
    "jinlong_coupon-proc_battery_5",
  ];
  for (const recipeId of COPRODUCT_PINS) {
    it(`plan ${recipeId}=1 passes all render invariants`, () => {
      const targets: Target[] = [
        { recipeId, ratePerSec: { num: "1", denom: "1" } },
      ];
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
      const violations = results.flatMap((r) => r.violations);
      expect(violations).toEqual([]);
    });
  }
});

// RF-1 regression: the fix routes iron_nugget's producer to its live consumer
// stamp, so the RF-1 hash plan no longer reports any iron_nugget render
// violation. Pins the fix against regression on the original reported plan.
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
// This is the permanent replacement for the throwaway _sweep.ts / _excess.ts /
// _classify.ts oracle scripts. It iterates every recipe as a single target at
// rate 1, plus a small fixed set of representative multi-target plans that
// exercise shared SCCs / byproducts. For each feasible plan it asserts:
//   (a) all checkRenderPlan invariants pass (no render-graph defect), and
//   (b) per recipeId, the sum of MachineRecipeVertex.executionRate over the
//       machine graph equals the LP rate (full.rates) within tolerance -- the
//       machine-count gate that catches producer over-replication.
//
// This sweep started INTENTIONALLY RED: it captured the known render-replication
// defect set as a baseline the fixes drive toward zero. Each failure is
// collected with the plan name and the gate it violated so the assertion message
// stays a usable oracle.
//
// The non-driver co-product routing fix (live-role filter in assignSplitRoles)
// cleared the single-target failures: xiranite_poly co-produces the looped
// byproduct liquid_sewage, and the split-replica filter used to assign the
// liquid_sewage role to a zero-rate split so the logical graph never wired
// xiranite_poly's liquid_sewage to its in-loop consumer (the render layer then
// billed the one wired producer the full demand and surfaced xiranite_poly's
// share as a phantom surplus). Routing the non-driver co-product edges to the
// live split role fixes that, clearing xiranite_poly, proc_battery_5,
// jinlong_coupon-proc_battery_5 (single-target) and xiranite_poly+iron_powder
// (multi-target).
//
// Residual known-red set: one multi-target plan,
// proc_battery_5+xiranite_enr_powder, still fails. It traces to a separate
// inbound-fan-out defect tracked and fixed in a later task; this sweep leaves
// it red on purpose.
// ---------------------------------------------------------------------------

const SWEEP_TOL = new Fraction(1, 1000000);

// Representative multi-target plans (owner-approved small scope). These mix a
// copper-chain target with an xiranite target to exercise shared SCCs and
// byproduct accounting across more than one target at once.
const MULTI_TARGET_PLANS: ReadonlyArray<{
  name: string;
  recipeIds: ReadonlyArray<string>;
}> = [
  { name: "xiranite_poly+iron_powder", recipeIds: ["xiranite_poly", "iron_powder"] },
  { name: "proc_battery_5+xiranite_enr_powder", recipeIds: ["proc_battery_5", "xiranite_enr_powder"] },
  { name: "copper_enr+liquid_xiranite_enr", recipeIds: ["copper_enr", "liquid_xiranite_enr"] },
];

// Run one plan through solve + render and return the gate failures it produced.
// Empty array means the plan is clean (or was skipped as non-feasible, in which
// case skipped is true and the caller should not count it).
function sweepPlan(
  name: string,
  targets: Target[],
): { skipped: boolean; failures: string[] } {
  let full;
  try {
    full = solvePlanWithIntermediates(targets, pack, defaultTransportConfig, []);
  } catch {
    return { skipped: true, failures: [] };
  }
  if (!full.feasibility.softFeasible) return { skipped: true, failures: [] };

  const failures: string[] = [];

  let out;
  try {
    out = renderPlanFromSolve(full, pack, targets, []);
  } catch (err) {
    // A feasible plan whose render THROWS is a genuine failure, not a skip.
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
  // recipe vertices (per-stamp summation, no extra weighting) and compare to
  // the LP rate.
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

    // Single-target sweep over the whole recipe pack.
    for (const r of pack.recipes) {
      const targets: Target[] = [
        { recipeId: r.id, ratePerSec: { num: "1", denom: "1" } },
      ];
      const { failures } = sweepPlan(r.id, targets);
      allFailures.push(...failures);
    }

    // Multi-target representative plans.
    for (const mt of MULTI_TARGET_PLANS) {
      const targets: Target[] = mt.recipeIds.map((recipeId) => ({
        recipeId,
        ratePerSec: { num: "1", denom: "1" },
      }));
      const { failures } = sweepPlan(mt.name, targets);
      allFailures.push(...failures);
    }

    // Distinct plan names that produced at least one failure, for a compact
    // baseline summary in the assertion message.
    const dirtyPlans = [
      ...new Set(allFailures.map((f) => f.split(":")[0])),
    ].sort();

    expect(
      allFailures,
      `${dirtyPlans.length} plan(s) failed the render sweep: ${dirtyPlans.join(", ")}\n${allFailures.join("\n")}`,
    ).toEqual([]);
  });
});
