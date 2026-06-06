import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { RecipeEdge, RecipeId } from "./types";
import { assignSplitRoles, splitConsumerDemand } from "./replicate";
import { outgoingEdgeKey } from "./types";

function recipe(
  id: string,
  inItems: Array<{ item: string; qty: number }>,
  outItems: Array<{ item: string; qty: number }>,
): Recipe {
  return {
    id,
    category: "material",
    time: 1,
    in: inItems,
    out: outItems,
  } as unknown as Recipe;
}

function edge(source: string, item: string): RecipeEdge {
  return { id: `${source}->${item}`, source, target: "consumer", item };
}

describe("splitConsumerDemand", () => {
  it("passes the full rate to a single producer (share 1)", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([["p1", new Fraction(5)]]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x")],
      new Fraction(10),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.edge.source).toBe("p1");
    expect(result[0]!.consumerRate.equals(new Fraction(10))).toBe(true);
  });

  it("divides demand across two producers by LP rate, not full to each", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
      ["p2", recipe("p2", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["p1", new Fraction(3)],
      ["p2", new Fraction(1)],
    ]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x"), edge("p2", "x")],
      new Fraction(8),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    // 8 split 3:1 -> 6 and 2; the bug sized each producer to the full 8.
    expect(bySource.get("p1")!.equals(new Fraction(6))).toBe(true);
    expect(bySource.get("p2")!.equals(new Fraction(2))).toBe(true);
    // Conservation: the shares sum back to the consumer's demand.
    const sum = result.reduce((a, r) => a.add(r.consumerRate), new Fraction(0));
    expect(sum.equals(new Fraction(8))).toBe(true);
  });

  it("weights the split by produced quantity, not just run rate", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 2 }])],
      ["p2", recipe("p2", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["p1", new Fraction(1)],
      ["p2", new Fraction(1)],
    ]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x"), edge("p2", "x")],
      new Fraction(9),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    // Flow weights are 2 and 1 -> 9 split 2:1 -> 6 and 3.
    expect(bySource.get("p1")!.equals(new Fraction(6))).toBe(true);
    expect(bySource.get("p2")!.equals(new Fraction(3))).toBe(true);
  });

  it("emits nothing when no producer carries any rate (no div by zero)", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
      ["p2", recipe("p2", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["p1", new Fraction(0)],
      ["p2", new Fraction(0)],
    ]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x"), edge("p2", "x")],
      new Fraction(8),
    );
    expect(result).toEqual([]);
  });
});

describe("assignSplitRoles", () => {
  // Co-product case (KD-1). A single SCC member produces two output items:
  //   - poly  (primary, out qty 1): consumed BOTH intra (by an SCC member) AND
  //     cross (by an external consumer) -> the single split-driving item.
  //   - lowpoly (secondary, out qty 1): consumed intra-only.
  // The per-item balance must drive looper/deliverer off poly alone, so the
  // deliverer that owns the poly cross edge keeps a positive rate. The bug
  // lumped lowpoly's intra flow into poly's produced flow, collapsing crossFlow
  // to 0 and zeroing the deliverer.
  it("keeps a positive deliverer for a co-product whose primary is split", () => {
    const recipeRate = new Fraction(4);
    const decision = assignSplitRoles({
      recipeRate,
      primaryOutItem: "poly",
      outQtys: new Map([
        ["poly", 1],
        ["lowpoly", 1],
      ]),
      intraEdges: [
        {
          item: "poly",
          target: "xiranite_poly",
          consumerRate: new Fraction(3),
          consumerInQty: 1,
        },
        {
          item: "lowpoly",
          target: "lowpoly_purifier",
          consumerRate: new Fraction(4),
          consumerInQty: 1,
        },
      ],
      crossEdges: [{ item: "poly", target: "xiranite_enr_powder" }],
      isTarget: false,
    });

    expect(decision.kind).toBe("split");
    if (decision.kind !== "split") return;
    // poly produced flow = 4*1 = 4; poly intra flow = 3*1 = 3; cross = 1.
    // looperRate = 4 * 3/4 = 3, delivererRate = 4 - 3 = 1.
    expect(decision.delivererRate.compare(0) > 0).toBe(true);
    expect(decision.delivererRate.equals(new Fraction(1))).toBe(true);
    expect(decision.looperRate.equals(new Fraction(3))).toBe(true);
    // Mass balance preserved.
    expect(
      decision.looperRate.add(decision.delivererRate).equals(recipeRate),
    ).toBe(true);
    // The primary cross edge is owned by the deliverer.
    expect(
      decision.delivererFilter.has(
        outgoingEdgeKey("poly", "xiranite_enr_powder"),
      ),
    ).toBe(true);
    // Both intra edges (primary AND the intra-only secondary) attach to the
    // looper filter.
    expect(decision.looperFilter.has(outgoingEdgeKey("poly", "xiranite_poly"))).toBe(
      true,
    );
    expect(
      decision.looperFilter.has(outgoingEdgeKey("lowpoly", "lowpoly_purifier")),
    ).toBe(true);
  });

  it("treats isTarget as a synthetic cross consumer on the primary item", () => {
    const recipeRate = new Fraction(2);
    const decision = assignSplitRoles({
      recipeRate,
      primaryOutItem: "poly",
      outQtys: new Map([["poly", 1]]),
      intraEdges: [
        {
          item: "poly",
          target: "xiranite_poly",
          consumerRate: new Fraction(1),
          consumerInQty: 1,
        },
      ],
      crossEdges: [],
      isTarget: true,
    });
    expect(decision.kind).toBe("split");
    if (decision.kind !== "split") return;
    // poly produced = 2; intra = 1; cross (synthetic target) = 1.
    expect(decision.looperRate.equals(new Fraction(1))).toBe(true);
    expect(decision.delivererRate.equals(new Fraction(1))).toBe(true);
  });
});
