import { describe, it, expect } from "vitest";
import { walkAndSolve } from "../../src/solver/walk";
import { buildRecipeGraph } from "../../src/solver/graph";
import { tarjanScc, condense } from "../../src/solver/scc";
import { topologicalOrder } from "../../src/solver/topo";
import { pack } from "../../src/data/load";
import type { ItemOverride } from "../../src/data/plan";

describe("walkAndSolve signature", () => {
  it("accepts an optional itemOverrides parameter without changing behavior", () => {
    const targets = [
      { recipeId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
    ];
    const g = buildRecipeGraph(targets, pack);
    const sccs = tarjanScc(g);
    const c = condense(g, sccs);
    const topo = topologicalOrder(c);

    const itemOverrides: ItemOverride[] = [];
    const withOverrides = walkAndSolve({
      g,
      condensation: c,
      topo,
      targets,
      pack,
      itemOverrides,
    });
    const without = walkAndSolve({ g, condensation: c, topo, targets, pack });

    expect(withOverrides.rates.size).toBe(without.rates.size);
    for (const [rid, rate] of without.rates) {
      const other = withOverrides.rates.get(rid);
      expect(other).toBeDefined();
      expect(other!.equals(rate)).toBe(true);
    }
    expect(withOverrides.tornFlow.size).toBe(without.tornFlow.size);
    for (const [id, val] of without.tornFlow) {
      const other = withOverrides.tornFlow.get(id);
      expect(other).toBeDefined();
      expect(other!.equals(val)).toBe(true);
    }
  });
});
