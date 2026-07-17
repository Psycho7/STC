import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { assertInvariants } from "./invariants";
import { solvePlanWithIntermediates } from "./index";
import { solveLp } from "./lp";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { SolverTarget } from "./planToSolverArgs";

const headlineTargets: SolverTarget[] = [
  {
    recipeId: "xiranite_enr_powder",
    itemId: "xiranite_enr_powder",
    ratePerSec: { num: "6", denom: "60" },
  },
];

describe("assertInvariants", () => {
  it("passes on a valid headline solve", () => {
    const full = solvePlanWithIntermediates(
      headlineTargets,
      pack,
      defaultTransportConfig,
    );
    const result = solveLp({ targets: headlineTargets, pack });
    expect(() =>
      assertInvariants(full, result, pack, headlineTargets, []),
    ).not.toThrow();
  });

  it("throws when the solve result is corrupted (mass balance broken)", () => {
    const full = solvePlanWithIntermediates(
      headlineTargets,
      pack,
      defaultTransportConfig,
    );
    const result = solveLp({ targets: headlineTargets, pack });
    // Zero out every recipe rate: production collapses while the demand
    // remains, so checkMassBalance fires.
    for (const key of [...result.rates.keys()]) {
      result.rates.set(key, new Fraction(0));
    }
    expect(() =>
      assertInvariants(full, result, pack, headlineTargets, []),
    ).toThrow(/invariants violated/);
  });
});
