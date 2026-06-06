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
    // The non-driver secondary co-product (lowpoly) routes ALL its edges to the
    // LIVE role. Here delivererRate>0, so lowpoly attaches to the deliverer, not
    // the looper.
    expect(
      decision.delivererFilter.has(outgoingEdgeKey("lowpoly", "lowpoly_purifier")),
    ).toBe(true);
    expect(
      decision.looperFilter.has(outgoingEdgeKey("lowpoly", "lowpoly_purifier")),
    ).toBe(false);
  });

  // Non-driver co-product routing (the xiranite_poly liquid_sewage bug). The
  // driver output item (xiranite_poly, primary, isTarget) has NO intra
  // consumer, so looperRate==0 and delivererRate==recipeRate. A SECONDARY
  // output item (liquid_sewage) is consumed intra-only. Routing liquid_sewage
  // by its own intra class would land its edges on the dead (rate-0) looper,
  // starving the consumer of the live replica's share. The fix routes ALL
  // non-driver co-product edges to the LIVE role (the deliverer here).
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
  // Mirrors the real liquid_sewage bug in miniature. A 2-member SCC (m, mloop)
  // consumes a byproduct item `byp`. `byp` is a SECONDARY output of producer
  // `bp`, whose PRIMARY output `prim` feeds a non-member consumer `pc`. `bp`'s
  // run rate is therefore fixed by `prim` demand, not by the SCC's byproduct
  // demand. `bp` must be emitted once as a shared replica at its full LP rate
  // (so its machine count == lpRate), and its own input chain (`raw_src`) must
  // be walked exactly once instead of re-minted per byproduct frame.
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
    // Exactly one shared `bp` replica at its full LP rate, feeding both the
    // primary consumer and the SCC byproduct edge. Without the sharing fix the
    // byproduct boundary frame mints an extra per-consumer `bp` (and re-walks
    // its input chain), pushing the summed rate above lp(bp)=2.
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
