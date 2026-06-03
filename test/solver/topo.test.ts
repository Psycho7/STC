import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../../src/solver/topo";
import type { Condensation, SccId } from "../../src/solver/types";

function condensation(
  edges: Array<[string, string]>,
  sccIds: string[],
): Condensation {
  const outgoing = new Map<SccId, Set<SccId>>();
  const incoming = new Map<SccId, Set<SccId>>();
  for (const id of sccIds) {
    outgoing.set(id, new Set());
    incoming.set(id, new Set());
  }
  for (const [s, t] of edges) {
    outgoing.get(s)!.add(t);
    incoming.get(t)!.add(s);
  }
  return {
    sccs: sccIds.map((id) => ({ id, recipeIds: [id] })),
    sccOfRecipe: new Map(),
    outgoing,
    incoming,
  };
}

describe("topologicalOrder", () => {
  it("returns upstream-first (sources before sinks)", () => {
    const c = condensation(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["a", "b", "c"],
    );
    expect(topologicalOrder(c)).toEqual(["a", "b", "c"]);
  });
  it("tie-breaks by SCC id", () => {
    const c = condensation(
      [
        ["a", "z"],
        ["a", "y"],
      ],
      ["a", "y", "z"],
    );
    const order = topologicalOrder(c);
    expect(order[0]).toBe("a");
    expect(order.indexOf("y")).toBeLessThan(order.indexOf("z"));
  });
});
