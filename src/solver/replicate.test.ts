import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type {
  Condensation,
  RecipeEdge,
  RecipeGraph,
  RecipeId,
  SccId,
} from "./types";
import {
  assignSplitRoles,
  replicatePerConsumer,
  splitConsumerDemand,
} from "./replicate";
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
      new Map([["pTarget", new Fraction(2)]]),
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
      new Map([["pTarget", new Fraction(1)]]),
    );
    const bySource = new Map(result.map((r) => [r.edge.source, r.consumerRate]));
    expect(bySource.get("pTarget")!.equals(new Fraction(2))).toBe(true);
    expect(bySource.get("pSibling")!.equals(new Fraction(6))).toBe(true);
  });

  it("ignores the draw when the edge item is not the target's primary output", () => {
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
    // The declared draw claims y (out[0]), not x: x splits 2:2 as before.
    const result = splitConsumerDemand(
      nodes,
      rates,
      nodes.get("consumer")!,
      [edge("pTarget", "x"), edge("pSibling", "x")],
      new Fraction(8),
      new Map([["pTarget", new Fraction(2)]]),
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
  // driver output (xiranite_poly, primary, isTarget) has NO intra consumer, so
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
      isTarget: true,
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

// Builds a RecipeGraph from a node list and (source -> item -> target) edges.
function buildGraph(
  nodes: Recipe[],
  links: Array<{ source: RecipeId; item: string; target: RecipeId }>,
): RecipeGraph {
  const nodeMap = new Map<RecipeId, Recipe>(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<RecipeId, RecipeEdge[]>();
  const incoming = new Map<RecipeId, RecipeEdge[]>();
  for (const l of links) {
    const e: RecipeEdge = {
      id: `${l.source}->${l.target}:${l.item}`,
      source: l.source,
      target: l.target,
      item: l.item,
    };
    (outgoing.get(l.source) ?? outgoing.set(l.source, []).get(l.source)!).push(e);
    (incoming.get(l.target) ?? incoming.set(l.target, []).get(l.target)!).push(e);
  }
  return { nodes: nodeMap, outgoing, incoming };
}

function condensationOf(sccs: Array<{ id: SccId; recipeIds: RecipeId[] }>): Condensation {
  const sccOfRecipe = new Map<RecipeId, SccId>();
  for (const s of sccs) for (const r of s.recipeIds) sccOfRecipe.set(r, s.id);
  return {
    sccs,
    sccOfRecipe,
    outgoing: new Map(),
    incoming: new Map(),
  };
}

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
    const replicas = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ recipeId: "pc", ratePerSec: { num: "2", denom: "1" } }],
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
    const replicas = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ recipeId: "m", ratePerSec: { num: "1", denom: "1" } }],
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
    const replicas = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ recipeId: "c2", ratePerSec: { num: "2", denom: "1" } }],
    });
    const sumOf = (rid: string) =>
      replicas
        .filter((r) => r.recipeId === rid)
        .reduce((acc, r) => acc.add(r.executionRate), new Fraction(0));
    expect(sumOf("ex1").equals(new Fraction(2, 3))).toBe(true);
    expect(sumOf("ex2").equals(new Fraction(4, 3))).toBe(true);
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
    const replicas = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ recipeId: "prod", ratePerSec: { num: "1", denom: "1" } }],
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
    const replicas = replicatePerConsumer({
      g,
      articulation: new Set<RecipeId>(),
      rates,
      condensation,
      targets: [{ recipeId: "t", ratePerSec: { num: "1", denom: "1" } }],
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
