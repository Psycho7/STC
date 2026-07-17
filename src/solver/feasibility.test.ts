import { describe, expect, it } from "vitest";
import { solvePlanWithIntermediates } from "./index";
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

describe("SolvePlanFull.feasibility", () => {
  it("a satisfiable plan surfaces softFeasible:true with no deficits", () => {
    const full = solvePlanWithIntermediates(
      headlineTargets,
      pack,
      defaultTransportConfig,
    );
    expect(full.feasibility.softFeasible).toBe(true);
    expect(full.feasibility.deficits.size).toBe(0);
  });
});
