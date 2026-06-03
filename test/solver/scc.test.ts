import { describe, it, expect } from "vitest";
import { tarjanScc, condense } from "../../src/solver/scc";
import type { RecipeGraph, RecipeEdge } from "../../src/solver/types";

function syntheticGraph(edges: Array<[string, string]>): RecipeGraph {
  const nodes = new Map<string, never>();
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  function ensure(id: string) {
    if (!outgoing.has(id)) {
      outgoing.set(id, []);
      incoming.set(id, []);
    }
  }
  for (const [s, t] of edges) {
    ensure(s);
    ensure(t);
    const e: RecipeEdge = { id: `${s}->${t}`, source: s, target: t, item: "x" };
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

describe("tarjanScc", () => {
  it("empty graph returns no SCCs", () => {
    expect(tarjanScc(syntheticGraph([])).length).toBe(0);
  });
  it("pure DAG produces one trivial SCC per node", () => {
    const sccs = tarjanScc(
      syntheticGraph([
        ["a", "b"],
        ["b", "c"],
      ]),
    );
    expect(sccs.length).toBe(3);
    for (const s of sccs) expect(s.recipeIds.length).toBe(1);
  });
  it("3-recipe cycle is one non-trivial SCC", () => {
    const sccs = tarjanScc(
      syntheticGraph([
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ]),
    ).filter((s) => s.recipeIds.length > 1);
    expect(sccs.length).toBe(1);
    expect([...sccs[0]!.recipeIds].sort()).toEqual(["a", "b", "c"]);
    expect(sccs[0]!.id).toBe("a"); // lex-min
  });
  it("cycle plus tail returns one cycle SCC and one tail singleton", () => {
    const sccs = tarjanScc(
      syntheticGraph([
        ["a", "b"],
        ["b", "a"],
        ["a", "t"],
      ]),
    );
    expect(sccs.find((s) => s.recipeIds.length === 2)).toBeDefined();
    expect(
      sccs.find((s) => s.recipeIds.length === 1 && s.recipeIds[0] === "t"),
    ).toBeDefined();
  });
});

describe("condense", () => {
  it("builds correct cross-SCC adjacency", () => {
    const g = syntheticGraph([
      ["a", "b"],
      ["b", "a"],
      ["a", "c"],
    ]);
    const sccs = tarjanScc(g);
    const c = condense(g, sccs);
    const sccOfA = c.sccOfRecipe.get("a")!;
    const sccOfC = c.sccOfRecipe.get("c")!;
    expect(c.outgoing.get(sccOfA)?.has(sccOfC)).toBe(true);
    expect(c.outgoing.get(sccOfA)?.has(sccOfA)).toBe(false); // no self-loops in condensation
  });
});
