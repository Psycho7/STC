import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { RecipeEdge, RecipeId } from "./types";
import {
  assignSplitRoles,
  logicalNodeIdForReplica,
  replicatePerConsumer,
  splitConsumerDemand,
  supplyShareKey,
} from "./replicate";
import { outgoingEdgeKey } from "./types";
import { buildGraph, condensationOf } from "./graph.testkit";

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

  it("excludes a seeded target's declared draw from the split weights", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["pTarget", recipe("pTarget", [], [{ item: "x", qty: 1 }])],
      ["pSibling", recipe("pSibling", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["pTarget", new Fraction(2)],
      ["pSibling", new Fraction(8)],
    ]);
    // The target's production (2) is fully claimed by its declared draw (2):
    // the sibling carries the consumer's whole demand instead of an 8/10 share.
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("pTarget", "x"), edge("pSibling", "x")],
      new Fraction(8),
      new Map([["pTarget", new Map([["x", new Fraction(2)]])]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.edge.source).toBe("pSibling");
    expect(result[0]!.consumerRate.equals(new Fraction(8))).toBe(true);
  });

  it("splits the residual when the draw claims only part of the target's production", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["pTarget", recipe("pTarget", [], [{ item: "x", qty: 1 }])],
      ["pSibling", recipe("pSibling", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["pTarget", new Fraction(3)],
      ["pSibling", new Fraction(6)],
    ]);
    // Weights: target 3-1=2, sibling 6 -> demand 8 splits 2:6.
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("pTarget", "x"), edge("pSibling", "x")],
      new Fraction(8),
      new Map([["pTarget", new Map([["x", new Fraction(1)]])]]),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    expect(bySource.get("pTarget")!.equals(new Fraction(2))).toBe(true);
    expect(bySource.get("pSibling")!.equals(new Fraction(6))).toBe(true);
  });

  it("leaves an item's weight alone when the draw is keyed to another output", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      [
        "pTarget",
        recipe("pTarget", [], [
          { item: "y", qty: 1 },
          { item: "x", qty: 1 },
        ]),
      ],
      ["pSibling", recipe("pSibling", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["pTarget", new Fraction(2)],
      ["pSibling", new Fraction(2)],
    ]);
    // The declared draw claims y, not x: x splits 2:2 as before.
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("pTarget", "x"), edge("pSibling", "x")],
      new Fraction(8),
      new Map([["pTarget", new Map([["y", new Fraction(2)]])]]),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    expect(bySource.get("pTarget")!.equals(new Fraction(4))).toBe(true);
    expect(bySource.get("pSibling")!.equals(new Fraction(4))).toBe(true);
  });

  it("deducts per-item intra supply from the demand before splitting", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([["p1", new Fraction(3, 4)]]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x")],
      new Fraction(1),
      undefined,
      new Map([["x", new Fraction(1, 4)]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.consumerRate.equals(new Fraction(3, 4))).toBe(true);
  });

  it("emits no frame when intra supply covers the whole demand", () => {
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 1 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([["p1", new Fraction(1)]]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x")],
      new Fraction(1),
      undefined,
      new Map([["x", new Fraction(2)]]),
    );
    expect(result).toHaveLength(0);
  });

  it("converts intra supply flow into rate units via the input qty", () => {
    // Demand is 1 (rate) * 2 (in-qty) = 2 flow; intra covers 1 flow, so the
    // external producer carries rate 1/2, not 1 - 1 = 0.
    const nodes = new Map<RecipeId, Recipe>([
      ["consumer", recipe("consumer", [{ item: "x", qty: 2 }], [])],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([["p1", new Fraction(1)]]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x")],
      new Fraction(1),
      undefined,
      new Map([["x", new Fraction(1)]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.consumerRate.equals(new Fraction(1, 2))).toBe(true);
  });

  it("leaves items without an intra supply entry at the full rate", () => {
    const nodes = new Map<RecipeId, Recipe>([
      [
        "consumer",
        recipe(
          "consumer",
          [
            { item: "x", qty: 1 },
            { item: "y", qty: 1 },
          ],
          [],
        ),
      ],
      ["p1", recipe("p1", [], [{ item: "x", qty: 1 }])],
      ["p2", recipe("p2", [], [{ item: "y", qty: 1 }])],
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["p1", new Fraction(1)],
      ["p2", new Fraction(1)],
    ]);
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("p1", "x"), edge("p2", "y")],
      new Fraction(1),
      undefined,
      new Map([["x", new Fraction(1, 4)]]),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    expect(bySource.get("p1")!.equals(new Fraction(3, 4))).toBe(true);
    expect(bySource.get("p2")!.equals(new Fraction(1))).toBe(true);
  });

  it("splits the netted rate across multiple producers by weight", () => {
    // Demand 1 minus intra supply 1/4 leaves 3/4, split 3:1 across the
    // producers -> 9/16 and 3/16. Netting after the split would instead
    // deduct 1/4 from each share.
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
      new Fraction(1),
      undefined,
      new Map([["x", new Fraction(1, 4)]]),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    expect(bySource.get("p1")!.equals(new Fraction(9, 16))).toBe(true);
    expect(bySource.get("p2")!.equals(new Fraction(3, 16))).toBe(true);
  });
});

describe("assignSplitRoles", () => {
  // Co-product case. One SCC member produces two outputs:
  //   - poly  (primary, out qty 1): consumed BOTH intra (by an SCC member) AND
  //     cross (by an external consumer) -> the single split-driving item.
  //   - lowpoly (secondary, out qty 1): consumed intra-only.
  // The per-item balance must drive looper/deliverer off poly alone, so the
  // deliverer owning the poly cross edge keeps a positive rate. The bug lumped
  // lowpoly's intra flow into poly's produced flow, collapsing crossFlow to 0
  // and zeroing the deliverer.
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
      targetOutItems: new Set<string>(),
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
    // The primary (driver) cross edge is owned by the deliverer.
    expect(
      decision.delivererFilter.has(
        outgoingEdgeKey("poly", "xiranite_enr_powder"),
      ),
    ).toBe(true);
    // The driver item's intra edge stays on the looper (driver keeps the
    // intra/cross split).
    expect(decision.looperFilter.has(outgoingEdgeKey("poly", "xiranite_poly"))).toBe(
      true,
    );
    // The non-driver secondary co-product (lowpoly) fans to EVERY live split
    // role. Here looperRate>0 and delivererRate>0, so lowpoly attaches to BOTH
    // the looper and the deliverer: each sibling physically co-produces it and
    // must carry a logical edge for its share.
    expect(
      decision.delivererFilter.has(outgoingEdgeKey("lowpoly", "lowpoly_purifier")),
    ).toBe(true);
    expect(
      decision.looperFilter.has(outgoingEdgeKey("lowpoly", "lowpoly_purifier")),
    ).toBe(true);
  });

  // Non-driver co-product routing (the xiranite_poly liquid_sewage bug). The
  // driver output (xiranite_poly, primary, targeted) has NO intra consumer, so
  // looperRate==0 and delivererRate==recipeRate. A secondary output
  // (liquid_sewage) is consumed intra-only. Routing liquid_sewage by its own
  // intra class would land its edges on the dead (rate-0) looper, starving the
  // consumer of the live replica's share. The fix routes ALL non-driver
  // co-product edges to the LIVE role (the deliverer here).
  it("routes a non-driver co-product's edges to the live split role", () => {
    const recipeRate = new Fraction(1);
    const decision = assignSplitRoles({
      recipeRate,
      primaryOutItem: "xiranite_poly",
      outQtys: new Map([
        ["xiranite_poly", 1],
        ["liquid_sewage", 1],
      ]),
      intraEdges: [
        {
          item: "liquid_sewage",
          target: "sewage_consumer_a",
          consumerRate: new Fraction(1),
          consumerInQty: 1,
        },
        {
          item: "liquid_sewage",
          target: "sewage_consumer_b",
          consumerRate: new Fraction(1),
          consumerInQty: 1,
        },
      ],
      crossEdges: [],
      targetOutItems: new Set(["xiranite_poly"]),
    });

    expect(decision.kind).toBe("split");
    if (decision.kind !== "split") return;
    // driver = xiranite_poly (primary, split-driving via synthetic target
    // cross). It has no intra consumer, so looperRate==0, delivererRate==1.
    expect(decision.looperRate.equals(new Fraction(0))).toBe(true);
    expect(decision.delivererRate.equals(new Fraction(1))).toBe(true);
    // The live role is the deliverer (rate>0). Both liquid_sewage edges must
    // attach to it, NOT to the dead looper.
    const sewageA = outgoingEdgeKey("liquid_sewage", "sewage_consumer_a");
    const sewageB = outgoingEdgeKey("liquid_sewage", "sewage_consumer_b");
    expect(decision.delivererFilter.has(sewageA)).toBe(true);
    expect(decision.delivererFilter.has(sewageB)).toBe(true);
    expect(decision.looperFilter.has(sewageA)).toBe(false);
    expect(decision.looperFilter.has(sewageB)).toBe(false);
  });

  it("treats a targeted output item as a synthetic cross consumer", () => {
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
      targetOutItems: new Set(["poly"]),
    });
    expect(decision.kind).toBe("split");
    if (decision.kind !== "split") return;
    // poly produced = 2; intra = 1; cross (synthetic target) = 1.
    expect(decision.looperRate.equals(new Fraction(1))).toBe(true);
    expect(decision.delivererRate.equals(new Fraction(1))).toBe(true);
  });
});

describe("replicatePerConsumer: SCC-boundary byproduct supplier sharing", () => {
  // Miniature of the real liquid_sewage bug. A 2-member SCC (m, mloop) consumes
  // byproduct `byp`, a secondary output of producer `bp` whose primary output
  // `prim` feeds non-member consumer `pc`. So `bp`'s run rate is fixed by `prim`
  // demand, not the SCC's byproduct demand. `bp` must emit once as a shared
  // replica at its full LP rate (machine count == lpRate), and its input chain
  // (`raw_src`) must be walked exactly once, not re-minted per byproduct frame.
  it("emits the byproduct supplier once at full LP rate, not per byproduct frame", () => {
    const nodes: Recipe[] = [
      // SCC members forming a 2-cycle on `loopitem`. `m` also pulls `byp`.
      recipe("m", [{ item: "loopitem", qty: 1 }, { item: "byp", qty: 1 }], [
        { item: "mout", qty: 1 },
      ]),
      recipe("mloop", [{ item: "mout", qty: 1 }], [{ item: "loopitem", qty: 1 }]),
      // Byproduct supplier: primary `prim`, secondary `byp`, input `raw`.
      recipe("bp", [{ item: "raw", qty: 1 }], [
        { item: "prim", qty: 1 },
        { item: "byp", qty: 1 },
      ]),
      // Non-member consumer of the primary output, so `bp` feeds outside the SCC.
      recipe("pc", [{ item: "prim", qty: 1 }], [{ item: "pcout", qty: 1 }]),
      // `bp`'s upstream input source.
      recipe("raw_src", [], [{ item: "raw", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "mloop", item: "loopitem", target: "m" },
      { source: "m", item: "mout", target: "mloop" },
      { source: "bp", item: "byp", target: "m" },
      { source: "bp", item: "prim", target: "pc" },
      { source: "raw_src", item: "raw", target: "bp" },
    ]);
    const condensation = condensationOf([
      { id: "scc:m", recipeIds: ["m", "mloop"] },
      { id: "scc:bp", recipeIds: ["bp"] },
      { id: "scc:pc", recipeIds: ["pc"] },
      { id: "scc:raw_src", recipeIds: ["raw_src"] },
    ]);
    // LP rates: pc=2 needs prim=2 -> bp=2 (primary driven). bp also yields byp=2,
    // exactly covering m's byproduct demand (m=2). raw_src=2 feeds bp.
    const rates = new Map<RecipeId, Fraction>([
      ["m", new Fraction(2)],
      ["mloop", new Fraction(2)],
      ["bp", new Fraction(2)],
      ["pc", new Fraction(2)],
      ["raw_src", new Fraction(2)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "pcout", ratePerSec: { num: "2", denom: "1" } }],
    });

    const bpReplicas = replicas.filter((r) => r.recipeId === "bp");
    // Exactly one shared `bp` replica at full LP rate, feeding both the primary
    // consumer and the SCC byproduct edge. Without the sharing fix the byproduct
    // boundary frame mints an extra per-consumer `bp` (and re-walks its input
    // chain), pushing the summed rate above lp(bp)=2.
    const bpSum = bpReplicas.reduce(
      (acc, r) => acc.add(r.executionRate),
      new Fraction(0),
    );
    expect(bpSum.equals(new Fraction(2))).toBe(true);
    expect(bpReplicas).toHaveLength(1);
    expect(bpReplicas[0]!.sharedAtArticulation).toBe(true);

    // `bp`'s input chain is walked once: a single `raw_src` replica summing to
    // its LP rate, never duplicated by repeated byproduct re-walks.
    const rawReplicas = replicas.filter((r) => r.recipeId === "raw_src");
    const rawSum = rawReplicas.reduce(
      (acc, r) => acc.add(r.executionRate),
      new Fraction(0),
    );
    expect(rawSum.equals(new Fraction(2))).toBe(true);
  });
});

describe("replicatePerConsumer: SCC intra supply nets the boundary demand", () => {
  // Miniature of the crystal_shell<->crystal_powder plan. Target member m
  // (rate 1) consumes `powder` fed BOTH intra-SCC (ploop's torn arc, 1/4) and
  // externally (pext). The boundary frame for pext must carry the demand net
  // of the intra share (3/4), not m's full rate. The reverse direction guards
  // the target-draw netting: m's `shell` production is fully claimed by its
  // declared draw, so zero shell is available intra and ploop's external
  // supplier sext must still carry ploop's full demand (1/4) - a deduction
  // that ignored the draw would mint sext at 0.
  it("nets the external boundary demand by the intra-SCC supply", () => {
    const nodes: Recipe[] = [
      recipe("m", [{ item: "powder", qty: 1 }], [{ item: "shell", qty: 1 }]),
      recipe("ploop", [{ item: "shell", qty: 1 }], [{ item: "powder", qty: 1 }]),
      recipe("pext", [{ item: "raw", qty: 1 }], [{ item: "powder", qty: 1 }]),
      recipe("sext", [{ item: "raw2", qty: 1 }], [{ item: "shell", qty: 1 }]),
      recipe("raw_src", [], [{ item: "raw", qty: 1 }]),
      recipe("raw2_src", [], [{ item: "raw2", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "ploop", item: "powder", target: "m" },
      { source: "m", item: "shell", target: "ploop" },
      { source: "pext", item: "powder", target: "m" },
      { source: "sext", item: "shell", target: "ploop" },
      { source: "raw_src", item: "raw", target: "pext" },
      { source: "raw2_src", item: "raw2", target: "sext" },
    ]);
    const condensation = condensationOf([
      { id: "scc:m", recipeIds: ["m", "ploop"] },
      { id: "scc:pext", recipeIds: ["pext"] },
      { id: "scc:sext", recipeIds: ["sext"] },
      { id: "scc:raw_src", recipeIds: ["raw_src"] },
      { id: "scc:raw2_src", recipeIds: ["raw2_src"] },
    ]);
    // LP balance: powder = ploop 1/4 + pext 3/4 = m's demand 1. shell =
    // m 1 + sext 1/4 vs target draw 1 + ploop 1/4.
    const rates = new Map<RecipeId, Fraction>([
      ["m", new Fraction(1)],
      ["ploop", new Fraction(1, 4)],
      ["pext", new Fraction(3, 4)],
      ["sext", new Fraction(1, 4)],
      ["raw_src", new Fraction(3, 4)],
      ["raw2_src", new Fraction(1, 4)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "shell", ratePerSec: { num: "1", denom: "1" } }],
    });
    const sumOf = (rid: string) =>
      replicas
        .filter((r) => r.recipeId === rid)
        .reduce((acc, r) => acc.add(r.executionRate), new Fraction(0));
    // External powder producer carries the demand net of the 1/4 intra share.
    expect(sumOf("pext").equals(new Fraction(3, 4))).toBe(true);
    // Cascade: pext's upstream chain is sized off the netted rate too.
    expect(sumOf("raw_src").equals(new Fraction(3, 4))).toBe(true);
    // m's shell is fully claimed by the target draw, so ploop's external shell
    // supplier keeps its full demand.
    expect(sumOf("sext").equals(new Fraction(1, 4))).toBe(true);
    expect(sumOf("raw2_src").equals(new Fraction(1, 4))).toBe(true);
  });

  // One under-producing intra producer (p, x flow 1) feeds TWO members with
  // unequal demand (c1 wants 1, c2 wants 2). The credit must split 1:2
  // (1/3 to c1, 2/3 to c2), so c1's external supplier carries 1 - 1/3 = 2/3
  // and c2's carries 2 - 2/3 = 4/3. A non-proportional allocation (full
  // credit to each) would mint both externals short.
  it("allocates an under-producing member's supply proportionally to demand", () => {
    const nodes: Recipe[] = [
      // 3-member SCC: p -> c1 -> c2 -> p (strongly connected via x, y, z),
      // plus a second intra x edge p -> c2.
      recipe("p", [{ item: "z", qty: 2 }], [{ item: "x", qty: 1 }]),
      recipe("c1", [{ item: "x", qty: 1 }], [{ item: "y", qty: 2 }]),
      recipe(
        "c2",
        [
          { item: "x", qty: 1 },
          { item: "y", qty: 1 },
        ],
        [{ item: "z", qty: 1 }],
      ),
      recipe("ex1", [], [{ item: "x", qty: 1 }]),
      recipe("ex2", [], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "p", item: "x", target: "c1" },
      { source: "p", item: "x", target: "c2" },
      { source: "c1", item: "y", target: "c2" },
      { source: "c2", item: "z", target: "p" },
      { source: "ex1", item: "x", target: "c1" },
      { source: "ex2", item: "x", target: "c2" },
    ]);
    const condensation = condensationOf([
      { id: "scc:p", recipeIds: ["p", "c1", "c2"] },
      { id: "scc:ex1", recipeIds: ["ex1"] },
      { id: "scc:ex2", recipeIds: ["ex2"] },
    ]);
    // LP balance: x = p 1 + ex1 2/3 + ex2 4/3 = c1 1 + c2 2; y = c1 2 = c2 2;
    // z = c2 2 = p 2 (all intra, fully covered, no external frames for z/y).
    const rates = new Map<RecipeId, Fraction>([
      ["p", new Fraction(1)],
      ["c1", new Fraction(1)],
      ["c2", new Fraction(2)],
      ["ex1", new Fraction(2, 3)],
      ["ex2", new Fraction(4, 3)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "z", ratePerSec: { num: "2", denom: "1" } }],
    });
    const sumOf = (rid: string) =>
      replicas
        .filter((r) => r.recipeId === rid)
        .reduce((acc, r) => acc.add(r.executionRate), new Fraction(0));
    expect(sumOf("ex1").equals(new Fraction(2, 3))).toBe(true);
    expect(sumOf("ex2").equals(new Fraction(4, 3))).toBe(true);
  });
});

describe("replicatePerConsumer: canonical inputs-consumer of a split SCC member", () => {
  // Pin for the zero-rate canonical seed. SCC member B splits into a looper
  // (intra role) and a deliverer (cross role); when the looper's rate is 0 the
  // multiplier pass drops its stamp. The boundary-minted per-consumer producers
  // (P1, P2, E) must carry consumerPath tails to a POSITIVE-rate stamp, else
  // assembleLogicalGraph has to re-route every one of them through the
  // dropped-designated fallback.
  it("boundary-minted producers point at a positive-rate stamp when the looper rate is 0", () => {
    // 2-member SCC A+B on loop_m/loop_t. B's intra item (loop_m) and cross item
    // (out_b) are disjoint, so the split balances on the primary out_b whose
    // intra flow is 0: looperRate 0, delivererRate 1. A is LP-zeroed (its
    // scarce input is capped to 0); external E covers B's loop_t instead.
    const nodes: Recipe[] = [
      recipe("tgt", [{ item: "out_b", qty: 1 }], [{ item: "final", qty: 1 }]),
      recipe(
        "B",
        [
          { item: "x", qty: 1 },
          { item: "loop_t", qty: 1 },
        ],
        [
          { item: "out_b", qty: 1 },
          { item: "loop_m", qty: 1 },
        ],
      ),
      recipe(
        "A",
        [
          { item: "loop_m", qty: 1 },
          { item: "scarce", qty: 1 },
        ],
        [{ item: "loop_t", qty: 1 }],
      ),
      recipe("E", [{ item: "raw_e", qty: 1 }], [{ item: "loop_t", qty: 1 }]),
      recipe("P1", [{ item: "raw1", qty: 1 }], [{ item: "x", qty: 1 }]),
      recipe("P2", [{ item: "raw2", qty: 1 }], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "B", item: "out_b", target: "tgt" },
      { source: "B", item: "loop_m", target: "A" },
      { source: "A", item: "loop_t", target: "B" },
      { source: "E", item: "loop_t", target: "B" },
      { source: "P1", item: "x", target: "B" },
      { source: "P2", item: "x", target: "B" },
    ]);
    const condensation = condensationOf([
      { id: "scc:loop", recipeIds: ["A", "B"] },
      { id: "scc:tgt", recipeIds: ["tgt"] },
      { id: "scc:E", recipeIds: ["E"] },
      { id: "scc:P1", recipeIds: ["P1"] },
      { id: "scc:P2", recipeIds: ["P2"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["tgt", new Fraction(1)],
      ["B", new Fraction(1)],
      ["A", new Fraction(0)],
      ["E", new Fraction(1)],
      ["P1", new Fraction(1, 2)],
      ["P2", new Fraction(1, 2)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "final", ratePerSec: { num: "1", denom: "1" } }],
    });
    const byId = new Map(replicas.map((r) => [r.id, r]));
    const perConsumer = replicas.filter(
      (r) => ["P1", "P2", "E"].includes(r.recipeId) && !r.sharedAtArticulation,
    );
    expect(perConsumer.length).toBeGreaterThan(0);
    for (const p of perConsumer) {
      const tail = p.consumerPath[p.consumerPath.length - 1];
      expect(tail).toBeDefined();
      const designated = byId.get(tail!);
      expect(designated).toBeDefined();
      expect(
        designated!.executionRate.compare(0) > 0,
        `producer ${p.id}: designated stamp ${tail} has rate ${designated!.executionRate.toFraction()}`,
      ).toBe(true);
    }
  });

  it("keeps the looper canonical when its rate is positive", () => {
    // 2-member SCC A+B where B's primary out_b is split-driving: it feeds the
    // intra consumer A (1 of 2 produced) and the cross consumer tgt. looperRate
    // = delivererRate = 1/2; the canonical inputs-consumer stays the looper
    // (the stamp owning the intra out_b edge), bit-identical pre/post fix.
    const nodes: Recipe[] = [
      recipe("tgt", [{ item: "out_b", qty: 1 }], [{ item: "final", qty: 1 }]),
      recipe(
        "B",
        [
          { item: "x", qty: 1 },
          { item: "loop_t", qty: 1 },
        ],
        [{ item: "out_b", qty: 2 }],
      ),
      recipe("A", [{ item: "out_b", qty: 1 }], [{ item: "loop_t", qty: 1 }]),
      recipe("P1", [{ item: "raw1", qty: 1 }], [{ item: "x", qty: 1 }]),
      recipe("P2", [{ item: "raw2", qty: 1 }], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "B", item: "out_b", target: "tgt" },
      { source: "B", item: "out_b", target: "A" },
      { source: "A", item: "loop_t", target: "B" },
      { source: "P1", item: "x", target: "B" },
      { source: "P2", item: "x", target: "B" },
    ]);
    const condensation = condensationOf([
      { id: "scc:loop", recipeIds: ["A", "B"] },
      { id: "scc:tgt", recipeIds: ["tgt"] },
      { id: "scc:P1", recipeIds: ["P1"] },
      { id: "scc:P2", recipeIds: ["P2"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["tgt", new Fraction(1)],
      ["B", new Fraction(1)],
      ["A", new Fraction(1)],
      ["P1", new Fraction(1, 2)],
      ["P2", new Fraction(1, 2)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "final", ratePerSec: { num: "1", denom: "1" } }],
    });
    const byId = new Map(replicas.map((r) => [r.id, r]));
    const looper = replicas.find(
      (r) =>
        r.recipeId === "B" &&
        r.outgoingEdgeFilter !== undefined &&
        r.outgoingEdgeFilter.has(outgoingEdgeKey("out_b", "A")),
    );
    expect(looper).toBeDefined();
    expect(looper!.executionRate.equals(new Fraction(1, 2))).toBe(true);
    const perConsumer = replicas.filter(
      (r) => ["P1", "P2"].includes(r.recipeId) && !r.sharedAtArticulation,
    );
    expect(perConsumer.length).toBeGreaterThan(0);
    for (const p of perConsumer) {
      const tail = p.consumerPath[p.consumerPath.length - 1];
      expect(byId.get(tail!)?.id).toBe(looper!.id);
    }
  });
});

describe("replicatePerConsumer: duplicate target seeds", () => {
  // A duplicate-recipe target ([X@1, X@1]) must replicate IDENTICALLY to the
  // single accumulated target ([X@2]). The LP sums duplicate floors, and the
  // targetDraw loop accumulates the declared draw, but the seed loop minted one
  // full-rate replica per array entry and pushed a full upstream walk frame for
  // each (targetSeeded.set silently overwriting the first), so the recipe and
  // its whole upstream cone replicated 2x: per-recipeId summed execution rate ==
  // 2x LP rate and every upstream input over-fed 2x.
  //
  // Chain: target `t` (consumes `a`) <- upstream `up` (produces `a`) <- `src`.
  function dupChainGraph() {
    const nodes: Recipe[] = [
      recipe("t", [{ item: "a", qty: 1 }], [{ item: "tout", qty: 1 }]),
      recipe("up", [{ item: "raw", qty: 1 }], [{ item: "a", qty: 1 }]),
      recipe("src", [], [{ item: "raw", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "up", item: "a", target: "t" },
      { source: "src", item: "raw", target: "up" },
    ]);
    const condensation = condensationOf([
      { id: "scc:t", recipeIds: ["t"] },
      { id: "scc:up", recipeIds: ["up"] },
      { id: "scc:src", recipeIds: ["src"] },
    ]);
    // LP rate for the accumulated demand t=2: up=2 feeds a, src=2 feeds raw.
    const rates = new Map<RecipeId, Fraction>([
      ["t", new Fraction(2)],
      ["up", new Fraction(2)],
      ["src", new Fraction(2)],
    ]);
    return { g, condensation, rates };
  }

  const sumOf = (
    replicas: ReturnType<typeof replicatePerConsumer>["replicas"],
    rid: string,
  ) =>
    replicas
      .filter((r) => r.recipeId === rid)
      .reduce((acc, r) => acc.add(r.executionRate), new Fraction(0));

  it("a duplicate non-SCC target replicates identically to the accumulated single target", () => {
    const { g, condensation, rates } = dupChainGraph();
    const base = {
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
    };
    const { replicas: dup } = replicatePerConsumer({
      ...base,
      targets: [
        { itemId: "tout", ratePerSec: { num: "1", denom: "1" } },
        { itemId: "tout", ratePerSec: { num: "1", denom: "1" } },
      ],
    });

    // Per recipeId, summed vertex execution rates == LP rate (Fraction-exact).
    // The bug doubled every one of these to 4.
    expect(sumOf(dup, "t").equals(new Fraction(2))).toBe(true);
    expect(sumOf(dup, "up").equals(new Fraction(2))).toBe(true);
    expect(sumOf(dup, "src").equals(new Fraction(2))).toBe(true);

    // The dup walk emits the same replicas as the single accumulated target.
    const { replicas: single } = replicatePerConsumer({
      ...base,
      targets: [{ itemId: "tout", ratePerSec: { num: "2", denom: "1" } }],
    });
    expect(dup).toHaveLength(single.length);
    expect(sumOf(dup, "t").equals(sumOf(single, "t"))).toBe(true);
    expect(sumOf(dup, "up").equals(sumOf(single, "up"))).toBe(true);
    expect(sumOf(dup, "src").equals(sumOf(single, "src"))).toBe(true);
  });

  it("an SCC-resident duplicate target stays correct (sccCreated dedup)", () => {
    // 2-member SCC (m, mloop) on `loopitem`; m is the user target. Duplicating
    // an SCC-resident target is already deduped by sccCreated, so the summed
    // member rates stay at LP rate. Guards that the seed-loop fix does not
    // disturb the SCC path.
    const nodes: Recipe[] = [
      recipe("m", [{ item: "loopitem", qty: 1 }], [{ item: "mout", qty: 1 }]),
      recipe("mloop", [{ item: "mout", qty: 1 }], [{ item: "loopitem", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "mloop", item: "loopitem", target: "m" },
      { source: "m", item: "mout", target: "mloop" },
    ]);
    const condensation = condensationOf([
      { id: "scc:m", recipeIds: ["m", "mloop"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["m", new Fraction(2)],
      ["mloop", new Fraction(2)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [
        { itemId: "mout", ratePerSec: { num: "1", denom: "1" } },
        { itemId: "mout", ratePerSec: { num: "1", denom: "1" } },
      ],
    });
    expect(sumOf(replicas, "m").equals(new Fraction(2))).toBe(true);
    expect(sumOf(replicas, "mloop").equals(new Fraction(2))).toBe(true);
  });

  it("a zero-rate second duplicate does not change the rendered plan", () => {
    // The old seed loop gave the second seed the full LP rate regardless of its
    // own declared draw; a [t@1, t@0] target must match [t@1].
    const nodes: Recipe[] = [
      recipe("t", [{ item: "a", qty: 1 }], [{ item: "tout", qty: 1 }]),
      recipe("up", [], [{ item: "a", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [{ source: "up", item: "a", target: "t" }]);
    const condensation = condensationOf([
      { id: "scc:t", recipeIds: ["t"] },
      { id: "scc:up", recipeIds: ["up"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["t", new Fraction(1)],
      ["up", new Fraction(1)],
    ]);
    const base = {
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
    };
    const { replicas: withZeroDup } = replicatePerConsumer({
      ...base,
      targets: [
        { itemId: "tout", ratePerSec: { num: "1", denom: "1" } },
        { itemId: "tout", ratePerSec: { num: "0", denom: "1" } },
      ],
    });
    const { replicas: single } = replicatePerConsumer({
      ...base,
      targets: [{ itemId: "tout", ratePerSec: { num: "1", denom: "1" } }],
    });
    expect(withZeroDup).toHaveLength(single.length);
    expect(sumOf(withZeroDup, "t").equals(new Fraction(1))).toBe(true);
    expect(sumOf(withZeroDup, "up").equals(new Fraction(1))).toBe(true);
  });
});

describe("replicatePerConsumer: augmented LP-support seeds", () => {
  // Miniature of the copper_bottle disposal case: target `prod` over-runs (LP 3
  // vs declared 1) and augmented sink `sink` absorbs the excess (LP 1, in: x2).
  it("seeds an augmented node once at full LP rate as a shared replica", () => {
    const nodes: Recipe[] = [
      recipe("prod", [], [{ item: "nug", qty: 1 }]),
      recipe("sink", [{ item: "nug", qty: 2 }], [{ item: "bottle", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "prod", item: "nug", target: "sink" },
    ]);
    const condensation = condensationOf([
      { id: "scc:prod", recipeIds: ["prod"] },
      { id: "scc:sink", recipeIds: ["sink"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["prod", new Fraction(3)],
      ["sink", new Fraction(1)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "nug", ratePerSec: { num: "1", denom: "1" } }],
      augmented: new Set<RecipeId>(["sink"]),
    });

    const sinkReplicas = replicas.filter((r) => r.recipeId === "sink");
    expect(sinkReplicas).toHaveLength(1);
    expect(sinkReplicas[0]!.executionRate.equals(new Fraction(1))).toBe(true);
    expect(sinkReplicas[0]!.sharedAtArticulation).toBe(true);

    // The producer is the target; the targetSeeded guard reuses its replica
    // when the sink's frame walks the nug edge, so no second copy appears.
    const prodReplicas = replicas.filter((r) => r.recipeId === "prod");
    expect(prodReplicas).toHaveLength(1);
    expect(prodReplicas[0]!.executionRate.equals(new Fraction(3))).toBe(true);
  });

  // Miniature of the originium chain: augmented feeder `f` supplies augmented
  // sink `s`. Without registering seeds in the reuse cache, s's walk frame
  // re-mints f per-consumer on top of the seed (vtxSum ~ 2x lpRate).
  it("does not double-mint a chain feeder reached as a producer after seeding", () => {
    const nodes: Recipe[] = [
      recipe("t", [], [{ item: "tout", qty: 1 }]),
      recipe("f", [], [{ item: "a", qty: 1 }]),
      recipe("s", [{ item: "a", qty: 1 }], [{ item: "b", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [{ source: "f", item: "a", target: "s" }]);
    const condensation = condensationOf([
      { id: "scc:t", recipeIds: ["t"] },
      { id: "scc:f", recipeIds: ["f"] },
      { id: "scc:s", recipeIds: ["s"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["t", new Fraction(1)],
      ["f", new Fraction(4)],
      ["s", new Fraction(4)],
    ]);
    const { replicas } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "tout", ratePerSec: { num: "1", denom: "1" } }],
      augmented: new Set<RecipeId>(["f", "s"]),
    });

    const fReplicas = replicas.filter((r) => r.recipeId === "f");
    const fSum = fReplicas.reduce(
      (acc, r) => acc.add(r.executionRate),
      new Fraction(0),
    );
    expect(fReplicas).toHaveLength(1);
    expect(fSum.equals(new Fraction(4))).toBe(true);

    const sReplicas = replicas.filter((r) => r.recipeId === "s");
    expect(sReplicas).toHaveLength(1);
    expect(sReplicas[0]!.executionRate.equals(new Fraction(4))).toBe(true);
  });
});

describe("replicatePerConsumer: supplyShares committed-flow recording", () => {
  // (a) Intra-SCC byproduct producer feeding two sibling members at unequal
  // demand. The recorded (producer, consumer, item) flows must be
  // demand-proportional and sum to the producer's production net of target
  // draw. Reuses the under-producing 3-member SCC: p produces x (rate 1,
  // production 1), c1 demands 1, c2 demands 2, so the 1 unit of x splits 1:2.
  it("records intra-SCC supply demand-proportionally, summing to production", () => {
    const nodes: Recipe[] = [
      recipe("p", [{ item: "z", qty: 2 }], [{ item: "x", qty: 1 }]),
      recipe("c1", [{ item: "x", qty: 1 }], [{ item: "y", qty: 2 }]),
      recipe(
        "c2",
        [
          { item: "x", qty: 1 },
          { item: "y", qty: 1 },
        ],
        [{ item: "z", qty: 1 }],
      ),
      recipe("ex1", [], [{ item: "x", qty: 1 }]),
      recipe("ex2", [], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "p", item: "x", target: "c1" },
      { source: "p", item: "x", target: "c2" },
      { source: "c1", item: "y", target: "c2" },
      { source: "c2", item: "z", target: "p" },
      { source: "ex1", item: "x", target: "c1" },
      { source: "ex2", item: "x", target: "c2" },
    ]);
    const condensation = condensationOf([
      { id: "scc:p", recipeIds: ["p", "c1", "c2"] },
      { id: "scc:ex1", recipeIds: ["ex1"] },
      { id: "scc:ex2", recipeIds: ["ex2"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["p", new Fraction(1)],
      ["c1", new Fraction(1)],
      ["c2", new Fraction(2)],
      ["ex1", new Fraction(2, 3)],
      ["ex2", new Fraction(4, 3)],
    ]);
    const { supplyShares } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ itemId: "z", ratePerSec: { num: "2", denom: "1" } }],
    });
    const toC1 = supplyShares.get(supplyShareKey("p", "c1", "x"));
    const toC2 = supplyShares.get(supplyShareKey("p", "c2", "x"));
    expect(toC1).toBeDefined();
    expect(toC2).toBeDefined();
    // Demand-proportional 1:2.
    expect(toC1!.equals(new Fraction(1, 3))).toBe(true);
    expect(toC2!.equals(new Fraction(2, 3))).toBe(true);
    // Sum to p's production (1), which here is below total demand (3).
    expect(toC1!.add(toC2!).equals(new Fraction(1))).toBe(true);
  });

  // (b) An articulation-point producer feeding two distinct consumers records
  // each consumer's committed share under its own key, and a producer reached
  // twice for the SAME consumer accumulates. Diamond: target t consumes x and y;
  // px (x) and py (y) both consume w from the shared AP `ap`; raw feeds ap. t
  // also draws w directly, and is reached as a w-consumer once via the seed
  // frame.
  it("records each consumer's share for a shared AP producer and accumulates", () => {
    const nodes: Recipe[] = [
      recipe(
        "t",
        [
          { item: "x", qty: 1 },
          { item: "y", qty: 1 },
          { item: "w", qty: 1 },
        ],
        [{ item: "final", qty: 1 }],
      ),
      recipe("px", [{ item: "w", qty: 1 }], [{ item: "x", qty: 1 }]),
      recipe("py", [{ item: "w", qty: 1 }], [{ item: "y", qty: 1 }]),
      recipe("ap", [{ item: "raw", qty: 1 }], [{ item: "w", qty: 1 }]),
      recipe("raw", [], [{ item: "raw", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "px", item: "x", target: "t" },
      { source: "py", item: "y", target: "t" },
      { source: "ap", item: "w", target: "t" },
      { source: "ap", item: "w", target: "px" },
      { source: "ap", item: "w", target: "py" },
      { source: "raw", item: "raw", target: "ap" },
    ]);
    const condensation = condensationOf([
      { id: "scc:t", recipeIds: ["t"] },
      { id: "scc:px", recipeIds: ["px"] },
      { id: "scc:py", recipeIds: ["py"] },
      { id: "scc:ap", recipeIds: ["ap"] },
      { id: "scc:raw", recipeIds: ["raw"] },
    ]);
    // t=1 needs x=1, y=1, w=1; px=1, py=1; ap supplies w to t(1)+px(1)+py(1)=3.
    const rates = new Map<RecipeId, Fraction>([
      ["t", new Fraction(1)],
      ["px", new Fraction(1)],
      ["py", new Fraction(1)],
      ["ap", new Fraction(3)],
      ["raw", new Fraction(3)],
    ]);
    const { replicas, supplyShares } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(["ap"]),
      rates,
      condensation,
      targets: [{ itemId: "final", ratePerSec: { num: "1", denom: "1" } }],
    });
    // The AP is emitted once at its full LP rate.
    const apReplicas = replicas.filter((r) => r.recipeId === "ap");
    expect(apReplicas).toHaveLength(1);
    expect(apReplicas[0]!.executionRate.equals(new Fraction(3))).toBe(true);
    // Each consumer's committed w supply is recorded under its own key.
    expect(
      supplyShares.get(supplyShareKey("ap", "t", "w"))!.equals(new Fraction(1)),
    ).toBe(true);
    expect(
      supplyShares.get(supplyShareKey("ap", "px", "w"))!.equals(new Fraction(1)),
    ).toBe(true);
    expect(
      supplyShares.get(supplyShareKey("ap", "py", "w"))!.equals(new Fraction(1)),
    ).toBe(true);
  });

  // (c) Same-key ACCUMULATION: the same (producer, consumer, item) key reached
  // twice must sum the flows, not overwrite. Consumer c feeds two per-consumer
  // parents (d1, d2), so c is replicated twice; each c replica's frame walks the
  // same ap -> c edge for w and records under the one (ap, c, w) key. Each reach
  // commits 1; an overwrite would leave 1, accumulation leaves 2.
  it("accumulates when the same (producer, consumer, item) key is reached twice", () => {
    const nodes: Recipe[] = [
      recipe(
        "t",
        [
          { item: "a", qty: 1 },
          { item: "b", qty: 1 },
        ],
        [{ item: "final", qty: 1 }],
      ),
      recipe("d1", [{ item: "m", qty: 1 }], [{ item: "a", qty: 1 }]),
      recipe("d2", [{ item: "m", qty: 1 }], [{ item: "b", qty: 1 }]),
      recipe("c", [{ item: "w", qty: 1 }], [{ item: "m", qty: 1 }]),
      recipe("ap", [{ item: "raw", qty: 1 }], [{ item: "w", qty: 1 }]),
      recipe("raw", [], [{ item: "raw", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "d1", item: "a", target: "t" },
      { source: "d2", item: "b", target: "t" },
      { source: "c", item: "m", target: "d1" },
      { source: "c", item: "m", target: "d2" },
      { source: "ap", item: "w", target: "c" },
      { source: "raw", item: "raw", target: "ap" },
    ]);
    const condensation = condensationOf([
      { id: "scc:t", recipeIds: ["t"] },
      { id: "scc:d1", recipeIds: ["d1"] },
      { id: "scc:d2", recipeIds: ["d2"] },
      { id: "scc:c", recipeIds: ["c"] },
      { id: "scc:ap", recipeIds: ["ap"] },
      { id: "scc:raw", recipeIds: ["raw"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["t", new Fraction(1)],
      ["d1", new Fraction(1)],
      ["d2", new Fraction(1)],
      ["c", new Fraction(2)],
      ["ap", new Fraction(2)],
      ["raw", new Fraction(2)],
    ]);
    const { replicas, supplyShares } = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(["ap"]),
      rates,
      condensation,
      targets: [{ itemId: "final", ratePerSec: { num: "1", denom: "1" } }],
    });
    // Guard the premise: c was replicated per-consumer twice, rate 1 each, so
    // the (ap, c, w) key really was recorded on two separate reaches.
    const cReplicas = replicas.filter((r) => r.recipeId === "c");
    expect(cReplicas).toHaveLength(2);
    for (const r of cReplicas) {
      expect(r.executionRate.equals(new Fraction(1))).toBe(true);
    }
    // Accumulated committed flow: 1 + 1 = 2. Overwrite semantics would leave 1.
    expect(
      supplyShares.get(supplyShareKey("ap", "c", "w"))!.equals(new Fraction(2)),
    ).toBe(true);
  });
});

describe("replicatePerConsumer: self-consuming recipe guard", () => {
  // A self-consuming recipe (same item in `in` and `out`, catalyst pattern) is
  // a singleton SCC, so isInScc never intercepts its self-loop edge and it
  // falls through to the non-shared branch, which re-enqueues the recipe as
  // its own consumer with rate scaled by inQty/outQty each round -- never zero
  // under exact Fractions, so the walk never terminates. The guard converts
  // that hang into a loud error.
  //
  // RED-STATE WARNING: without the guard this test does NOT fail by vitest
  // timeout. The runaway loop is synchronous, so the worker's event loop never
  // gets to fire testTimeout; the run hangs while allocating replicas.
  // Reproduce the red state only via an externally bounded run, e.g.
  //   timeout 30 bunx vitest run src/solver/replicate.test.ts -t "self-consuming"
  // (exit 124 = killed), and never run the full suite with the guard absent.
  it("throws on a self-consuming recipe instead of replicating forever", () => {
    const nodes: Recipe[] = [
      recipe(
        "grow",
        [
          { item: "seed", qty: 1 },
          { item: "catalyst", qty: 1 },
        ],
        [{ item: "catalyst", qty: 2 }],
      ),
      recipe("use", [{ item: "catalyst", qty: 1 }], [{ item: "prod", qty: 1 }]),
    ];
    const g = buildGraph(nodes, [
      { source: "grow", item: "catalyst", target: "grow" },
      { source: "grow", item: "catalyst", target: "use" },
    ]);
    const condensation = condensationOf([
      { id: "scc:grow", recipeIds: ["grow"] },
      { id: "scc:use", recipeIds: ["use"] },
    ]);
    const rates = new Map<RecipeId, Fraction>([
      ["grow", new Fraction(1)],
      ["use", new Fraction(1)],
    ]);
    expect(() =>
      replicatePerConsumer({
        g,
        articulation: new Set<RecipeId>(),
        rates,
        condensation,
        targets: [{ itemId: "prod", ratePerSec: { num: "1", denom: "1" } }],
        augmented: new Set<RecipeId>(),
      }),
    ).toThrow(/self-consuming/);
  });
});

describe("logicalNodeIdForReplica", () => {
  it("swaps the replica counter separator for the logical-node one", () => {
    expect(logicalNodeIdForReplica("r:U#0")).toBe("r:U~0");
  });

  it("converts every separator in the id", () => {
    expect(logicalNodeIdForReplica("r:U#1#2")).toBe("r:U~1~2");
  });

  it("returns an id with no separator unchanged", () => {
    expect(logicalNodeIdForReplica("r:U")).toBe("r:U");
  });
});
