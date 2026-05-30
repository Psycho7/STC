import { describe, it, expect } from "vitest";
import { pickTearEdges } from "../../src/solver/tear";
import type { RecipeGraph, RecipeEdge, Scc } from "../../src/solver/types";

function gWithEdges(
  edges: Array<[string, string, string, number]>,
): RecipeGraph {
  // edges: [source, target, item, qty]
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  const nodes = new Map<
    string,
    {
      id: string;
      in: { item: string; qty: number }[];
      out: { item: string; qty: number }[];
    }
  >();
  function ensure(id: string) {
    if (!outgoing.has(id)) {
      outgoing.set(id, []);
      incoming.set(id, []);
    }
    if (!nodes.has(id)) nodes.set(id, { id, in: [], out: [] });
  }
  for (const [s, t, item, qty] of edges) {
    ensure(s);
    ensure(t);
    const e: RecipeEdge = {
      id: `${s}->${t}:${item}`,
      source: s,
      target: t,
      item,
    };
    outgoing.get(s)!.push(e);
    incoming.get(t)!.push(e);
    nodes.get(s)!.out.push({ item, qty });
    nodes.get(t)!.in.push({ item, qty });
  }
  return {
    nodes: nodes as unknown as Map<string, never>,
    outgoing,
    incoming,
    depthToItem: new Map(),
    depthToRecipe: new Map(),
  } as RecipeGraph;
}

describe("pickTearEdges", () => {
  it("3-recipe cycle picks the lowest-qty back edge", () => {
    const g = gWithEdges([
      ["a", "b", "x", 5],
      ["b", "c", "y", 3],
      ["c", "a", "z", 1],
    ]);
    const scc: Scc = { id: "a", recipeIds: ["a", "b", "c"] };
    const tears = pickTearEdges(scc, g);
    expect(tears.length).toBe(1);
    expect(tears[0]!.edge.item).toBe("z");
  });
  it("ties broken lexicographically by (source, item, target)", () => {
    const g = gWithEdges([
      ["a", "b", "x", 1],
      ["b", "a", "y", 1],
    ]);
    const scc: Scc = { id: "a", recipeIds: ["a", "b"] };
    const tears = pickTearEdges(scc, g);
    expect(tears.length).toBe(1);
    expect(tears[0]!.edge.source).toBe("a"); // "a" < "b" lex
  });
});
