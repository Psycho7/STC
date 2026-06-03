import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { walkAndSolve } from "../../src/solver/walk";
import { buildRecipeGraph } from "../../src/solver/graph";
import { tarjanScc, condense } from "../../src/solver/scc";
import { topologicalOrder } from "../../src/solver/topo";
import { pack } from "../../src/data/load";

describe("walkAndSolve", () => {
  it("default targets pin copper_powder to 1/2 cycle/sec", () => {
    const targets = [
      { recipeId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      {
        recipeId: "liquid_cleaner_1-sewage",
        ratePerSec: { num: "1", denom: "4" },
      },
    ];
    const g = buildRecipeGraph(targets, pack);
    const sccs = tarjanScc(g);
    const c = condense(g, sccs);
    const topo = topologicalOrder(c);
    const result = walkAndSolve({ g, condensation: c, topo, targets, pack });
    const cpRate = result.rates.get("copper_powder");
    expect(cpRate).toBeDefined();
    expect(cpRate!.compare(0) > 0).toBe(true);
    expect(cpRate!.equals(new Fraction(1, 2))).toBe(true);
  });

  it("sink target (liquid_cleaner_1-sewage) gets a positive rate", () => {
    const targets = [
      {
        recipeId: "liquid_cleaner_1-sewage",
        ratePerSec: { num: "1", denom: "4" },
      },
    ];
    const g = buildRecipeGraph(targets, pack);
    const sccs = tarjanScc(g);
    const c = condense(g, sccs);
    const topo = topologicalOrder(c);
    const result = walkAndSolve({ g, condensation: c, topo, targets, pack });
    const r = result.rates.get("liquid_cleaner_1-sewage");
    expect(r).toBeDefined();
    expect(r!.equals(new Fraction(1, 4))).toBe(true); // rate / in[0].qty (qty=1)
  });

  it("SCC-member target (plant_moss_seed_1) solves via net-delivery semantic", () => {
    // plant_moss_seed_1 / plant_moss_1 are an asymmetric 2-cycle: seed recipe
    // consumes 1 moss to produce 2 seeds; moss recipe consumes 1 seed to
    // produce 1 moss. Pinning gross execution at seed=1/sec forces
    // mass-conservation to fail (the cycle grows). Under net-delivery
    // semantics, rate is interpreted as net external delivery of
    // plant_moss_seed_1 per second.
    // Mass balance: 2*rate_seed - 1*rate_moss = 1 (delivery), 1*rate_moss =
    // 1*rate_seed (no net moss leaves). Solution: rate_seed = rate_moss = 1.
    const targets = [
      { recipeId: "plant_moss_seed_1", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraph(targets, pack);
    const sccs = tarjanScc(g);
    const c = condense(g, sccs);
    const topo = topologicalOrder(c);
    const result = walkAndSolve({ g, condensation: c, topo, targets, pack });
    const seedRate = result.rates.get("plant_moss_seed_1");
    const mossRate = result.rates.get("plant_moss_1");
    expect(seedRate).toBeDefined();
    expect(mossRate).toBeDefined();
    expect(seedRate!.equals(new Fraction(1))).toBe(true);
    expect(mossRate!.equals(new Fraction(1))).toBe(true);
  });
});
