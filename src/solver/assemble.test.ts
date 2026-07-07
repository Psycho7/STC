import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type {
  Condensation,
  RecipeEdge,
  RecipeGraph,
  RecipeId,
  Replica,
  SccId,
  TornEdge,
} from "./types";
import { assembleLogicalGraph } from "./assemble";

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

// buildGraph and condensationOf are kept in sync with the copies in replicate.test.ts.
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
    (outgoing.get(l.source) ?? outgoing.set(l.source, []).get(l.source)!).push(
      e,
    );
    (incoming.get(l.target) ?? incoming.set(l.target, []).get(l.target)!).push(
      e,
    );
  }
  return { nodes: nodeMap, outgoing, incoming };
}

function condensationOf(
  sccs: Array<{ id: SccId; recipeIds: RecipeId[] }>,
): Condensation {
  const sccOfRecipe = new Map<RecipeId, SccId>();
  for (const s of sccs) for (const r of s.recipeIds) sccOfRecipe.set(r, s.id);
  return {
    sccs,
    sccOfRecipe,
    outgoing: new Map(),
    incoming: new Map(),
  };
}

function replica(
  id: string,
  recipeId: string,
  rate: Fraction,
  opts?: {
    consumerPath?: string[];
    shared?: boolean;
    outgoingEdgeFilter?: ReadonlySet<string>;
  },
): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath: opts?.consumerPath ?? [],
    blueprintGroupId: `target:${recipeId}`,
    sharedAtArticulation: opts?.shared ?? false,
    ...(opts?.outgoingEdgeFilter !== undefined
      ? { outgoingEdgeFilter: opts.outgoingEdgeFilter }
      : {}),
  };
}

describe("assembleLogicalGraph: deferred re-route fans to every producer", () => {
  // Pin for the producer-blind fed-set bug. Two per-consumer producers (P1, P2)
  // of item x both carry consumerPath tails to a dropped designated stamp of
  // consumer recipe C (the LP-zeroed canonical), so both land in
  // pendingReroutes. The surviving sibling stamp must receive an edge from
  // BOTH producers: the old (stamp, item) fed-set let the first re-route block
  // every later producer of the same item, silently dropping P2's edge.
  it("emits edges from BOTH deferred producers to the surviving sibling stamp", () => {
    const recipes = [
      recipe("C", [{ item: "x", qty: 1 }], [{ item: "cout", qty: 1 }]),
      recipe("P1", [], [{ item: "x", qty: 1 }]),
      recipe("P2", [], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(recipes, [
      { source: "P1", item: "x", target: "C" },
      { source: "P2", item: "x", target: "C" },
    ]);
    const replicas: Replica[] = [
      // Designated stamp, dropped by the multiplier pass (not in multipliers).
      replica("r:C#0", "C", new Fraction(0), {
        shared: true,
        outgoingEdgeFilter: new Set<string>(),
      }),
      // Surviving sibling stamp of the same recipe.
      replica("r:C#1", "C", new Fraction(1), {
        shared: true,
        outgoingEdgeFilter: new Set<string>(),
      }),
      replica("r:P1#2", "P1", new Fraction(1, 2), {
        consumerPath: ["r:C#0"],
      }),
      replica("r:P2#3", "P2", new Fraction(1, 2), {
        consumerPath: ["r:C#0"],
      }),
    ];
    const multipliers = new Map<string, number>([
      ["r:C#1", 1],
      ["r:P1#2", 1],
      ["r:P2#3", 1],
    ]);
    const logical = assembleLogicalGraph({
      replicas,
      multipliers,
      lanes: [],
      condensation: condensationOf([
        { id: "scc:C", recipeIds: ["C"] },
        { id: "scc:P1", recipeIds: ["P1"] },
        { id: "scc:P2", recipeIds: ["P2"] },
      ]),
      recipeById: new Map(recipes.map((r) => [r.id, r])),
      g,
      torn: [],
    });

    const xEdges = logical.edges.filter(
      (e) => e.sourcePort === "out:x" && e.target === "r:C~1",
    );
    const sources = xEdges.map((e) => e.source).sort();
    expect(sources).toEqual(["r:P1~2", "r:P2~3"]);
  });

  // Dual-fed variant: a torn return arc already delivers x to the surviving
  // stamp. The deferred external producers were minted net of the intra-SCC
  // supply, so their residual edges are legitimate alongside the arc; the old
  // fed-set blocked both of them. All edge ids must stay unique.
  it("keeps the deferred producers' edges alongside a torn return arc", () => {
    const recipes = [
      // C and L form a 2-member SCC; L's x edge to C is torn.
      recipe(
        "C",
        [
          { item: "x", qty: 1 },
          { item: "lin", qty: 1 },
        ],
        [{ item: "cout", qty: 1 }],
      ),
      recipe("L", [{ item: "cout", qty: 1 }], [{ item: "x", qty: 1 }]),
      recipe("P1", [], [{ item: "x", qty: 1 }]),
      recipe("P2", [], [{ item: "x", qty: 1 }]),
    ];
    const g = buildGraph(recipes, [
      { source: "L", item: "x", target: "C" },
      { source: "C", item: "cout", target: "L" },
      { source: "P1", item: "x", target: "C" },
      { source: "P2", item: "x", target: "C" },
    ]);
    const replicas: Replica[] = [
      replica("r:C#0", "C", new Fraction(0), {
        shared: true,
        outgoingEdgeFilter: new Set<string>(),
      }),
      replica("r:C#1", "C", new Fraction(1), {
        shared: true,
        outgoingEdgeFilter: new Set<string>(),
      }),
      replica("r:L#2", "L", new Fraction(1, 4), { shared: true }),
      replica("r:P1#3", "P1", new Fraction(3, 8), {
        consumerPath: ["r:C#0"],
      }),
      replica("r:P2#4", "P2", new Fraction(3, 8), {
        consumerPath: ["r:C#0"],
      }),
    ];
    const multipliers = new Map<string, number>([
      ["r:C#1", 1],
      ["r:L#2", 1],
      ["r:P1#3", 1],
      ["r:P2#4", 1],
    ]);
    const torn: TornEdge[] = [
      {
        id: "torn:0",
        sccId: "scc:loop",
        edge: { id: "L->C:x", source: "L", target: "C", item: "x" },
      },
    ];
    const logical = assembleLogicalGraph({
      replicas,
      multipliers,
      lanes: [],
      condensation: condensationOf([
        { id: "scc:loop", recipeIds: ["C", "L"] },
        { id: "scc:P1", recipeIds: ["P1"] },
        { id: "scc:P2", recipeIds: ["P2"] },
      ]),
      recipeById: new Map(recipes.map((r) => [r.id, r])),
      g,
      torn,
    });

    const xEdges = logical.edges.filter(
      (e) => e.sourcePort === "out:x" && e.target === "r:C~1",
    );
    const sources = xEdges.map((e) => e.source).sort();
    // The return arc from L plus BOTH residual external producers.
    expect(sources).toEqual(["r:L~2", "r:P1~3", "r:P2~4"]);
    const ids = logical.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
