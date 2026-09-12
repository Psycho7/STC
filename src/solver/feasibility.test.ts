import { describe, expect, it } from "vitest";
import { solvePlanWithIntermediates } from "./index";
import { pack } from "../data/load";
import type { ItemTarget } from "../data/targets";

const headlineTargets: ItemTarget[] = [
  {
    itemId: "xiranite_enr_powder",
    ratePerSec: { num: "6", denom: "60" },
  },
];

describe("SolvePlanFull.feasibility", () => {
  it("a satisfiable plan surfaces softFeasible:true with no deficits", () => {
    const full = solvePlanWithIntermediates(headlineTargets, pack);
    expect(full.feasibility.softFeasible).toBe(true);
    expect(full.feasibility.deficits.size).toBe(0);
  });
});
