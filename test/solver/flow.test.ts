import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { solveSccFlow } from "../../src/solver/flow";
import { pickTearEdges } from "../../src/solver/tear";
import { InconsistentSccError, SingularSccError } from "../../src/solver/types";
import type { RecipeGraph, RecipeEdge, Scc } from "../../src/solver/types";

function build3CycleGraph(): { g: RecipeGraph; scc: Scc } {
  // SCC: A -x-> B -y-> C -z-> A (qty 1 each). C also produces "out" (qty 1).
  const recipeData = {
    A: { id: "A", in: [{ item: "z", qty: 1 }], out: [{ item: "x", qty: 1 }] },
    B: { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
    C: {
      id: "C",
      in: [{ item: "y", qty: 1 }],
      out: [
        { item: "z", qty: 1 },
        { item: "out", qty: 1 },
      ],
    },
  };
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  function ensure(id: string) {
    if (!outgoing.has(id)) {
      outgoing.set(id, []);
      incoming.set(id, []);
    }
  }
  function add(s: string, t: string, item: string) {
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
  }
  add("A", "B", "x");
  add("B", "C", "y");
  add("C", "A", "z");
  // External consumer EXT consumes "out" at rate 1/sec.
  // Represented by an edge C -> EXT, and EXT not in scc.recipeIds.
  add("C", "EXT", "out");
  const nodes = new Map([
    ["A", recipeData.A],
    ["B", recipeData.B],
    ["C", recipeData.C],
    ["EXT", { id: "EXT", in: [{ item: "out", qty: 1 }], out: [] }],
  ]) as unknown as Map<string, never>;
  return {
    g: {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph,
    scc: { id: "A", recipeIds: ["A", "B", "C"] },
  };
}

describe("solveSccFlow", () => {
  it("3-cycle with unit qty and external demand on 'out' at 1/sec yields unit rates", () => {
    const { g, scc } = build3CycleGraph();
    const tears = pickTearEdges(scc, g);
    expect(tears.length).toBe(1);
    // boundaryDemand keyed by consumer recipeId (the EXT consumer outside the SCC)
    const boundaryDemand = new Map<string, Fraction>([
      ["EXT", new Fraction(1)],
    ]);
    const result = solveSccFlow(scc, g, tears, boundaryDemand);
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("C")!.equals(new Fraction(1))).toBe(true);
    const tornFlowValues = [...result.tornFlow.values()];
    expect(tornFlowValues.length).toBe(1);
    expect(tornFlowValues[0]!.equals(new Fraction(1))).toBe(true);
  });

  it("zero demand yields zero rates", () => {
    const { g, scc } = build3CycleGraph();
    const tears = pickTearEdges(scc, g);
    const result = solveSccFlow(scc, g, tears, new Map());
    for (const r of result.rates.values())
      expect(r.equals(new Fraction(0))).toBe(true);
  });

  it("target-in-SCC: pinning a member's rate to a known value drives the cycle", () => {
    // Pure 2-cycle A <-> B with unit qtys. Without a boundary demand the
    // system is singular (homogeneous). Pinning A = 3/sec converts the system
    // to a determinate one; B must equal 3/sec to satisfy mass balance.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 1 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const pinned = new Map([["A", new Fraction(3)]]);
    const result = solveSccFlow(scc, g, tears, new Map(), pinned);
    expect(result.rates.get("A")!.equals(new Fraction(3))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(3))).toBe(true);
  });

  it("singular (under-determined) 2-cycle with no external boundary throws SingularSccError", () => {
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 1 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    expect(() => solveSccFlow(scc, g, tears, new Map())).toThrow(
      SingularSccError,
    );
  });

  it("asymmetric 2-cycle with downstream external demand solves square after tear-consistency row", () => {
    // A: in y qty 1, out x qty 2. B: in x qty 1, out y qty 1. EXT consumes x at 1/sec.
    // Today: m=2 producer-item rows, n=3 (rate_A, rate_B, tornFlow) -> SingularSccError.
    // Post-fix: the consumer-side row adds m=3, making m=n=3 and yielding rate_A = rate_B = 1,
    // tornFlow = 1. The asymmetry (out qty 2) is required - unit-qty cycles cannot sustain
    // both internal recycling and external draw at the same rate.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    add("A", "EXT", "x");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
      ["EXT", { id: "EXT", in: [{ item: "x", qty: 1 }], out: [] }],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    expect(tears.length).toBe(1);
    const boundaryDemand = new Map<string, Fraction>([
      ["EXT", new Fraction(1)],
    ]);
    const result = solveSccFlow(scc, g, tears, boundaryDemand);
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
    const tornValues = [...result.tornFlow.values()];
    expect(tornValues.length).toBe(1);
    expect(tornValues[0]!.equals(new Fraction(1))).toBe(true);
  });

  it("asymmetric 2-cycle with member pinned and surplus draining to EXT remains consistent", () => {
    // A: in y qty 1, out x qty 2. B: in x qty 1, out y qty 1. EXT consumes x at 1/sec.
    // Pin A=1. Expected: B=1 (recycles 1 x); A produces 2 x; EXT consumes 1; surplus 0.
    // Today m=2,n=2 (rate_B, tornFlow) and solves. Post-fix the new row adds m=3 but
    // is linearly dependent (tornFlow = rate_B); residual-consistency check accepts.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    add("A", "EXT", "x");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
      ["EXT", { id: "EXT", in: [{ item: "x", qty: 1 }], out: [] }],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const pinned = new Map([["A", new Fraction(1)]]);
    const boundaryDemand = new Map<string, Fraction>([
      ["EXT", new Fraction(1)],
    ]);
    const result = solveSccFlow(scc, g, tears, boundaryDemand, pinned);
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
  });

  it("closed asymmetric 2-cycle with member pinned and no external draw throws InconsistentSccError", () => {
    // Same A/B as bucket (b) but no EXT consumer. Pin A=1 forces tornFlow=2 (from
    // A's x output row) but the consumer-side row forces tornFlow = rate_B * 1.
    // Mass balance on y forces rate_B=1, so consumer-side asserts tornFlow=1 while
    // producer-side asserts tornFlow=2: contradiction. Today this solves silently
    // with mass-conservation-violating rates; post-fix the new row exposes it.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const pinned = new Map([["A", new Fraction(1)]]);
    expect(() => solveSccFlow(scc, g, tears, new Map(), pinned)).toThrow(
      InconsistentSccError,
    );
  });

  it("closed unit-qty 2-cycle with downstream external demand throws InconsistentSccError", () => {
    // A: in y qty 1, out x qty 1. B: in x qty 1, out y qty 1. EXT consumes x at 1/sec.
    // Closed 1:1 cycle: every x produced by A returns as y from B, so there is no
    // net x for EXT. The new tear-balance row reduces the system to 0 = nonzero
    // (proven inconsistent); the elimination-order fix surfaces this as
    // InconsistentSccError rather than SingularSccError. Without the fix this
    // case throws Singular because the zero-pivot column halts elimination
    // before the residual-consistency loop ever runs.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    add("A", "EXT", "x");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 1 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
      ["EXT", { id: "EXT", in: [{ item: "x", qty: 1 }], out: [] }],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    expect(tears.length).toBe(1);
    const boundaryDemand = new Map<string, Fraction>([
      ["EXT", new Fraction(1)],
    ]);
    expect(() => solveSccFlow(scc, g, tears, boundaryDemand)).toThrow(
      InconsistentSccError,
    );
  });

  it("externalDelivery on a closed asymmetric 2-cycle resolves the inconsistent case", () => {
    // Same closed-asymmetric-2-cycle fixture as the InconsistentSccError
    // test above, but with externalDelivery on A's "x" at 1/sec. The synthetic
    // external draw turns the homogeneous system into a determinate one with
    // rate_A = rate_B = tornFlow = 1. This mirrors how the plant_moss and
    // plant_grass SCCs get resolved.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const externalDelivery = new Map<string, Map<string, Fraction>>([
      ["A", new Map([["x", new Fraction(1)]])],
    ]);
    const result = solveSccFlow(
      scc,
      g,
      tears,
      new Map(),
      undefined,
      undefined,
      externalDelivery,
    );
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
    const tornValues = [...result.tornFlow.values()];
    expect(tornValues.length).toBe(1);
    expect(tornValues[0]!.equals(new Fraction(1))).toBe(true);
  });

  it("externalDelivery composes additively with downstream external demand", () => {
    // Asymmetric 2-cycle with EXT consuming x at 1/sec AND
    // externalDelivery on A's "x" at 1/sec. Both flows draw the same item from
    // the same producer; the cycle scales linearly: total external x demand is
    // 2 -> rate_A = rate_B = 2. Documents that delivery and boundaryDemand are
    // additive on the same producer-item axis.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    add("A", "EXT", "x");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
      ["EXT", { id: "EXT", in: [{ item: "x", qty: 1 }], out: [] }],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const boundaryDemand = new Map<string, Fraction>([
      ["EXT", new Fraction(1)],
    ]);
    const externalDelivery = new Map<string, Map<string, Fraction>>([
      ["A", new Map([["x", new Fraction(1)]])],
    ]);
    const result = solveSccFlow(
      scc,
      g,
      tears,
      boundaryDemand,
      undefined,
      undefined,
      externalDelivery,
    );
    expect(result.rates.get("A")!.equals(new Fraction(2))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(2))).toBe(true);
  });

  it("externalDelivery is added AFTER the externalSupplyByItem cap subtraction (and zero-clamp)", () => {
    // Pins the cap-vs-delivery ordering. Closed asymmetric 2-cycle
    // (no EXT consumer), cap = 2 (would clamp externalSum to 0 if no draw
    // existed), delivery = 1. Correct ordering: externalSum starts at 0, -=2
    // clamps to 0, +=1 leaves 1 -> rate_A = rate_B = 1. Wrong ordering
    // (delivery before clamp): 0 - 2 + 1 = -1 -> clamp to 0 -> homogeneous
    // system -> SingularSccError. The test asserting rate_A = 1 fails if the
    // delivery contribution is placed before the clamp.
    const outgoing = new Map<string, RecipeEdge[]>();
    const incoming = new Map<string, RecipeEdge[]>();
    function add(s: string, t: string, item: string) {
      if (!outgoing.has(s)) {
        outgoing.set(s, []);
        incoming.set(s, []);
      }
      if (!outgoing.has(t)) {
        outgoing.set(t, []);
        incoming.set(t, []);
      }
      const e: RecipeEdge = {
        id: `${s}->${t}:${item}`,
        source: s,
        target: t,
        item,
      };
      outgoing.get(s)!.push(e);
      incoming.get(t)!.push(e);
    }
    add("A", "B", "x");
    add("B", "A", "y");
    const nodes = new Map([
      [
        "A",
        { id: "A", in: [{ item: "y", qty: 1 }], out: [{ item: "x", qty: 2 }] },
      ],
      [
        "B",
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] },
      ],
    ]) as unknown as Map<string, never>;
    const g: RecipeGraph = {
      nodes,
      outgoing,
      incoming,
      depthToItem: new Map(),
      depthToRecipe: new Map(),
    } as RecipeGraph;
    const scc: Scc = { id: "A", recipeIds: ["A", "B"] };
    const tears = pickTearEdges(scc, g);
    const externalSupplyByItem = new Map<string, Fraction>([
      ["x", new Fraction(2)],
    ]);
    const externalDelivery = new Map<string, Map<string, Fraction>>([
      ["A", new Map([["x", new Fraction(1)]])],
    ]);
    const result = solveSccFlow(
      scc,
      g,
      tears,
      new Map(),
      undefined,
      externalSupplyByItem,
      externalDelivery,
    );
    expect(result.rates.get("A")!.equals(new Fraction(1))).toBe(true);
    expect(result.rates.get("B")!.equals(new Fraction(1))).toBe(true);
  });
});
