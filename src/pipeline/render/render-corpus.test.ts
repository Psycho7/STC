// End-to-end render corpus test.
//
// Known-good group: the four feasible closed-form micro-fixtures (chain,
// multi-producer, byproduct, raw-draw) all pass all five render invariants
// as confirmed empirically before this file was written.
//
// RF-1 characterization: the real-pack plan encoded in RF1_HASH contains an
// internally balanced intermediate item iron_nugget whose render edge is
// dropped by the pipeline. The detector reports this as violations in
// boundaryProductsJustified, internalFlowConservation, and
// consumerInputsSatisfied. This test asserts that the violations are reported;
// when RF-1 is fixed the assertion should be updated to expect no iron_nugget
// violation.

import { describe, it, expect } from "vitest";
import { CLOSED_FORM_FIXTURES } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
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

// RF-1 characterization: the detector must report an iron_nugget violation.
// This asserts reality; do not loosen this assertion to make it pass more
// broadly. When RF-1 is fixed, update this to expect no iron_nugget violation.
describe("render corpus: RF-1 characterization", () => {
  it("reports iron_nugget violation for the RF-1 hash (known render bug)", async () => {
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
    expect(ironNuggetViolations.length).toBeGreaterThan(0);
  });
});
