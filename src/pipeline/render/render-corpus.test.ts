// End-to-end render corpus test.
//
// Known-good group: the four feasible closed-form micro-fixtures (chain,
// multi-producer, byproduct, raw-draw) all pass all five render invariants
// as confirmed empirically before this file was written.
//
// RF-1 regression: the real-pack plan encoded in RF1_HASH contains an
// internally balanced intermediate item iron_nugget whose render edge used to
// be dropped (surfaced as a phantom surplus, consumer fed from nothing). The
// logical-graph edge wiring now routes the producer to the live consumer stamp,
// so this test pins that iron_nugget no longer triggers any render violation.

import { describe, it, expect } from "vitest";
import { CLOSED_FORM_FIXTURES } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import type { Target } from "../../data/targets";
import { renderPlanFromSolve } from "../driver";
import { assertRenderInvariants, checkRenderPlan } from "./invariants";
import { pack } from "../../data/load";
import { loadPlan } from "../../data/plan";
import { planToSolverArgs } from "../../solver/planToSolverArgs";

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
