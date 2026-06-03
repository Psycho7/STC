import { describe, it, expect } from "vitest";
import { articulationPoints } from "../../src/solver/bctree";
import type { RecipeGraph, RecipeEdge } from "../../src/solver/types";

function syntheticGraph(directedEdges: Array<[string, string]>): RecipeGraph {
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  function ensure(id: string) {
    if (!outgoing.has(id)) {
      outgoing.set(id, []);
      incoming.set(id, []);
    }
  }
  for (const [s, t] of directedEdges) {
    ensure(s);
    ensure(t);
    const e: RecipeEdge = { id: `${s}->${t}`, source: s, target: t, item: "x" };
    outgoing.get(s)!.push(e);
    incoming.get(t)!.push(e);
  }
  return {
    nodes: new Map(),
    outgoing,
    incoming,
    depthToItem: new Map(),
    depthToRecipe: new Map(),
  } as RecipeGraph;
}

describe("articulationPoints", () => {
  it("path graph: every internal node is an AP", () => {
    const g = syntheticGraph([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
    const aps = articulationPoints(g);
    expect(aps.has("b")).toBe(true);
    expect(aps.has("c")).toBe(true);
    expect(aps.has("a")).toBe(false);
    expect(aps.has("d")).toBe(false);
  });
  it("cycle: no APs", () => {
    const g = syntheticGraph([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ]);
    expect(articulationPoints(g).size).toBe(0);
  });
  it("two triangles sharing a vertex: shared vertex is an AP", () => {
    const g = syntheticGraph([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
      ["a", "d"],
      ["d", "e"],
      ["e", "a"],
    ]);
    expect(articulationPoints(g).has("a")).toBe(true);
  });
});
