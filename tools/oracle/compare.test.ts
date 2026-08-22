// T3 acceptance: comparison harness unit tests.
//   - tolerance math (rel 1e-6 / abs 1e-9; exact path) on hand values;
//   - structural uniqueness: pass on the single-producer-acyclic-no-disposal
//     fixture, fail on multi-producer and byproduct-disposal;
//   - perturbation guard: leaves a unique fixture unchanged, MOVES a known
//     alternate-optima fixture (demoting it out of Tier 2);
//   - a Tier-1 record carries feasibility verdict, softFeasible, deficit
//     presence, and exact forced-active-set equality.

import Fraction from "fraction.js";
import { loadModule } from "glpk-ts";
import { beforeAll, describe, expect, it } from "vitest";

import { Rational } from "~/models/rational";
import {
  closeFloat,
  compareScenario,
  exactEqFracRational,
  perturbationGuard,
  rateClose,
  runGlpk,
  structuralUnique,
  type Scenario,
} from "./compare";
import { FIXTURES } from "./fixtures";

beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

function fixture(axis: string): Scenario {
  const f = FIXTURES.find((x) => x.axis === axis);
  if (!f) throw new Error(`no fixture for axis ${axis}`);
  return f.scenario;
}

describe("tolerances", () => {
  it("closeFloat: relative 1e-6 with absolute floor 1e-9", () => {
    // Equal values are close.
    expect(closeFloat(1, 1)).toBe(true);
    // Within relative 1e-6 of a large value.
    expect(closeFloat(1_000_000, 1_000_000.4)).toBe(true); // diff 0.4 <= 1e-6*1e6=1
    expect(closeFloat(1_000_000, 1_000_002)).toBe(false); // diff 2 > 1
    // Tiny values: absolute floor governs.
    expect(closeFloat(0, 1e-10)).toBe(true); // diff <= 1e-9
    expect(closeFloat(0, 1e-8)).toBe(false); // diff > 1e-9 and rel scale tiny
    // Mid value, relative tolerance.
    expect(closeFloat(2, 2 + 1e-7)).toBe(true); // 1e-7 <= 1e-6*2
    expect(closeFloat(2, 2 + 1e-5)).toBe(false);
  });

  it("exactEqFracRational: exact rational equality, sign-aware", () => {
    expect(exactEqFracRational(new Fraction(2, 5), new Rational(2n, 5n))).toBe(
      true,
    );
    expect(exactEqFracRational(new Fraction(4, 10), new Rational(2n, 5n))).toBe(
      true,
    ); // normalized
    expect(exactEqFracRational(new Fraction(1, 3), new Rational(1n, 4n))).toBe(
      false,
    );
    expect(
      exactEqFracRational(new Fraction(-2, 5), new Rational(-2n, 5n)),
    ).toBe(true);
    expect(exactEqFracRational(new Fraction(2, 5), new Rational(-2n, 5n))).toBe(
      false,
    );
  });

  it("rateClose: exact path first, float-bridged fallback", () => {
    // Exact match.
    expect(rateClose(new Fraction(2, 5), new Rational(2n, 5n))).toBe(true);
    // 1/3 vs a 7-digit decimal approximation: not exactly equal but float-close.
    const approx = new Rational(3333333n, 10000000n); // 0.3333333
    expect(exactEqFracRational(new Fraction(1, 3), approx)).toBe(false);
    expect(rateClose(new Fraction(1, 3), approx)).toBe(true);
    // Genuinely different rates are not close.
    expect(rateClose(new Fraction(1, 2), new Rational(2n, 5n))).toBe(false);
  });
});

describe("structural uniqueness rule", () => {
  it("PASSES on single-producer-acyclic-no-disposal (chain)", () => {
    const s = fixture("chain");
    const g = runGlpk(s);
    const active = new Set(
      [...g.machinesByRecipe].filter(([, m]) => m.nonzero()).map(([id]) => id),
    );
    const u = structuralUnique(s.pack, active, g.surplus);
    expect(u.unique).toBe(true);
    expect(u.reasons).toEqual([]);
  });

  it("FAILS on the multi-producer fixture (two producers of M)", () => {
    const s = fixture("multi-producer");
    const g = runGlpk(s);
    const active = new Set(
      [...g.machinesByRecipe].filter(([, m]) => m.nonzero()).map(([id]) => id),
    );
    const u = structuralUnique(s.pack, active, g.surplus);
    expect(u.unique).toBe(false);
    expect(u.reasons.some((r) => r.includes("producers"))).toBe(true);
  });

  it("FAILS on the byproduct-disposal fixture (surplus active)", () => {
    const s = fixture("byproduct");
    const g = runGlpk(s);
    const active = new Set(
      [...g.machinesByRecipe].filter(([, m]) => m.nonzero()).map(([id]) => id),
    );
    const u = structuralUnique(s.pack, active, g.surplus);
    expect(u.unique).toBe(false);
    expect(u.reasons.some((r) => r.includes("surplus"))).toBe(true);
  });
});

describe("empirical perturbation guard", () => {
  it("leaves a unique fixture's rates unchanged (stable)", () => {
    const p = perturbationGuard(fixture("chain"));
    expect(p.stable).toBe(true);
    expect(p.moved).toEqual([]);
  });

  it("MOVES a known alternate-optima fixture (demoted out of Tier 2)", () => {
    const p = perturbationGuard(fixture("multi-producer"));
    expect(p.stable).toBe(false);
    expect(p.moved.length).toBeGreaterThan(0);
    // The two parallel producers swap under the opposite cost profiles.
    expect(p.moved).toEqual(expect.arrayContaining(["b1", "b2"]));
  });
});

describe("Tier-1 record", () => {
  it("carries verdict, softFeasible, deficit presence, and exact forced-active-set equality", () => {
    const rec = compareScenario(fixture("chain"));
    // feasibility verdict + agreement
    expect(rec.stcVerdict).toBe("satisfiable");
    expect(rec.glpkVerdict).toBe("satisfiable");
    expect(rec.verdictAgree).toBe(true);
    // softFeasible + deficit presence
    expect(rec.stcSoftFeasible).toBe(true);
    expect(rec.stcHasDeficit).toBe(false);
    // forced active set, exact set equality
    expect(rec.stcActiveSet).toEqual(["a", "b"]);
    expect(rec.glpkActiveSet).toEqual(["a", "b"]);
    expect(rec.activeSetAgree).toBe(true);
  });

  it("records softFeasible=false + deficit for an unsatisfiable target (cyclic)", () => {
    const rec = compareScenario(fixture("cyclic-target"));
    expect(rec.stcVerdict).toBe("unsatisfiable");
    expect(rec.glpkVerdict).toBe("unsatisfiable");
    expect(rec.stcSoftFeasible).toBe(false);
    expect(rec.stcHasDeficit).toBe(true);
    expect(rec.stcTargetMet).toBe(false);
    expect(rec.glpkTargetMet).toBe(false);
  });
});
