import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { assembleLogicalGraph } from "../../src/solver/assemble";
import type {
  Condensation,
  PackedLane,
  RecipeEdge,
  RecipeGraph,
  Replica,
  TornEdge,
} from "../../src/solver/types";
import type { Recipe } from "@aef/schema";

function buildG(
  recipes: Array<{
    id: string;
    in: { item: string; qty: number }[];
    out: { item: string; qty: number }[];
  }>,
  edges: Array<[string, string, string]>, // [source, target, item]
): RecipeGraph {
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  const nodes = new Map<string, unknown>();
  for (const r of recipes) {
    nodes.set(r.id, r);
    if (!outgoing.has(r.id)) {
      outgoing.set(r.id, []);
      incoming.set(r.id, []);
    }
  }
  for (const [s, t, item] of edges) {
    const e: RecipeEdge = {
      id: `${s}->${t}:${item}`,
      source: s,
      target: t,
      item,
    };
    outgoing.get(s)!.push(e);
    incoming.get(t)!.push(e);
  }
  return {
    nodes: nodes as unknown as Map<string, never>,
    outgoing,
    incoming,
    depthToItem: new Map(),
    depthToRecipe: new Map(),
  } as RecipeGraph;
}

describe("assembleLogicalGraph", () => {
  it("emits one group node per unique blueprintGroupId and one recipe node per replica (skipping zero-multiplier)", () => {
    const replicas: Replica[] = [
      {
        id: "r:T#0",
        recipeId: "T",
        executionRate: new Fraction(1),
        consumerPath: [],
        blueprintGroupId: "target:T",
        sharedAtArticulation: false,
      },
      {
        id: "r:U#0",
        recipeId: "U",
        executionRate: new Fraction(1),
        consumerPath: ["r:T#0"],
        blueprintGroupId: "target:T",
        sharedAtArticulation: false,
      },
    ];
    const multipliers = new Map<string, number>([
      ["r:T#0", 1],
      ["r:U#0", 1],
    ]);
    const recipeT = {
      id: "T",
      name: "T",
      in: [{ item: "x", qty: 1 }],
      out: [],
      producers: ["m"],
      time: 1,
      category: "x",
      icon: "x",
      row: 0,
    } as unknown as Recipe;
    const recipeU = {
      id: "U",
      name: "U",
      in: [],
      out: [{ item: "x", qty: 1 }],
      producers: ["m"],
      time: 1,
      category: "x",
      icon: "x",
      row: 0,
    } as unknown as Recipe;
    const recipeById = new Map<string, Recipe>([
      ["T", recipeT],
      ["U", recipeU],
    ]);
    const g = buildG(
      [
        { id: "T", in: [{ item: "x", qty: 1 }], out: [] },
        { id: "U", in: [], out: [{ item: "x", qty: 1 }] },
      ],
      [["U", "T", "x"]],
    );
    const condensation: Condensation = {
      sccs: [
        { id: "T", recipeIds: ["T"] },
        { id: "U", recipeIds: ["U"] },
      ],
      sccOfRecipe: new Map([
        ["T", "T"],
        ["U", "U"],
      ]),
      outgoing: new Map([
        ["T", new Set()],
        ["U", new Set(["T"])],
      ]),
      incoming: new Map([
        ["T", new Set(["U"])],
        ["U", new Set()],
      ]),
    };
    const lg = assembleLogicalGraph({
      replicas,
      multipliers,
      lanes: [] as PackedLane[],
      tornEdges: [],
      condensation,
      recipeById,
      g,
      torn: [] as TornEdge[],
    });
    const groups = lg.nodes.filter((n) => n.kind === "group");
    const recipeNodes = lg.nodes.filter((n) => n.kind === "recipe");
    expect(groups.length).toBe(1);
    expect(recipeNodes.length).toBe(2);
    expect(lg.edges.length).toBe(1);
    // edge is U#0 -> T#0 with item x
    expect(lg.edges[0]!.source).toBe("r:U~0"); // safeId transform
    expect(lg.edges[0]!.target).toBe("r:T~0");
  });

  it("torn SCC edge appears as a return-arc LogicalEdge connecting the two SCC member replicas", () => {
    const replicas: Replica[] = [
      {
        id: "r:M1#0",
        recipeId: "M1",
        executionRate: new Fraction(1),
        consumerPath: [],
        blueprintGroupId: "scc:M1",
        sharedAtArticulation: true,
      },
      {
        id: "r:M2#0",
        recipeId: "M2",
        executionRate: new Fraction(1),
        consumerPath: [],
        blueprintGroupId: "scc:M1",
        sharedAtArticulation: true,
      },
    ];
    const multipliers = new Map<string, number>([
      ["r:M1#0", 1],
      ["r:M2#0", 1],
    ]);
    const recipeM1 = {
      id: "M1",
      name: "M1",
      in: [{ item: "b", qty: 1 }],
      out: [{ item: "a", qty: 1 }],
      producers: ["m"],
      time: 1,
      category: "x",
      icon: "x",
      row: 0,
    } as unknown as Recipe;
    const recipeM2 = {
      id: "M2",
      name: "M2",
      in: [{ item: "a", qty: 1 }],
      out: [{ item: "b", qty: 1 }],
      producers: ["m"],
      time: 1,
      category: "x",
      icon: "x",
      row: 0,
    } as unknown as Recipe;
    const recipeById = new Map<string, Recipe>([
      ["M1", recipeM1],
      ["M2", recipeM2],
    ]);
    const g = buildG(
      [
        { id: "M1", in: [{ item: "b", qty: 1 }], out: [{ item: "a", qty: 1 }] },
        { id: "M2", in: [{ item: "a", qty: 1 }], out: [{ item: "b", qty: 1 }] },
      ],
      [
        ["M1", "M2", "a"],
        ["M2", "M1", "b"],
      ],
    );
    const condensation: Condensation = {
      sccs: [{ id: "M1", recipeIds: ["M1", "M2"] }],
      sccOfRecipe: new Map([
        ["M1", "M1"],
        ["M2", "M1"],
      ]),
      outgoing: new Map([["M1", new Set()]]),
      incoming: new Map([["M1", new Set()]]),
    };
    const tornEdgeObj: TornEdge = {
      id: "M1 a M2",
      edge: { id: "M1->M2:a", source: "M1", target: "M2", item: "a" },
      sccId: "M1",
    };
    const lg = assembleLogicalGraph({
      replicas,
      multipliers,
      lanes: [] as PackedLane[],
      tornEdges: ["M1 a M2"],
      condensation,
      recipeById,
      g,
      torn: [tornEdgeObj],
    });
    // The non-torn edge M2->M1:b is a regular edge; the torn M1->M2:a appears as a return-arc edge.
    const returnArc = lg.edges.find((e) => e.id.includes("return"));
    expect(returnArc).toBeDefined();
    expect(returnArc!.source).toBe("r:M1~0");
    expect(returnArc!.target).toBe("r:M2~0");
  });
});
