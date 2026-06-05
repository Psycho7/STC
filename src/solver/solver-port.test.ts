import { describe, expect, it } from "vitest";
import { solvePlanWithIntermediates } from "./index";
import { solveLp, type LpSolver } from "./lp";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";

const headlineTargets: Target[] = [
  { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
];

describe("solver port injection", () => {
  it("routes the solve through the injected LpSolver", () => {
    let calls = 0;
    const stub: LpSolver = (input) => {
      calls += 1;
      return solveLp(input);
    };
    const full = solvePlanWithIntermediates(
      headlineTargets,
      pack,
      defaultTransportConfig,
      undefined,
      undefined,
      stub,
    );
    expect(calls).toBe(1);
    expect(full.feasibility.softFeasible).toBe(true);
  });
});
