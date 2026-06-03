import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { replicatePerConsumer } from "../../src/solver/replicate";
import type {
  Condensation,
  RecipeGraph,
  RecipeEdge,
  RecipeId,
  Scc,
} from "../../src/solver/types";
import type { Target } from "../../src/data/targets";

// Helper to build a synthetic graph with embedded Recipe shapes.
type SynthRecipe = {
  id: string;
  in: { item: string; qty: number }[];
  out: { item: string; qty: number }[];
};

function buildG(
  recipes: SynthRecipe[],
  edges: Array<[string, string, string]>, // [source, target, item]
): RecipeGraph {
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  const nodes = new Map<string, SynthRecipe>();
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

function trivialCondensation(recipeIds: string[]): Condensation {
  const sccs: Scc[] = recipeIds.map((id) => ({ id, recipeIds: [id] }));
  const sccOfRecipe = new Map<string, string>(recipeIds.map((id) => [id, id]));
  const outgoing = new Map<string, Set<string>>(
    recipeIds.map((id) => [id, new Set<string>()]),
  );
  const incoming = new Map<string, Set<string>>(
    recipeIds.map((id) => [id, new Set<string>()]),
  );
  return { sccs, sccOfRecipe, outgoing, incoming };
}

function tgt(recipeId: string): Target {
  return { recipeId, ratePerSec: { num: "1", denom: "1" } };
}

describe("replicatePerConsumer", () => {
  it("(i) AP-shared: shared producer at AP gets one shared replica", () => {
    // Graph: target_a, target_b both consume "x"; producer P produces "x"; P is an AP.
    const g = buildG(
      [
        { id: "P", in: [], out: [{ item: "x", qty: 1 }] },
        { id: "A", in: [{ item: "x", qty: 1 }], out: [{ item: "ya", qty: 1 }] },
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "yb", qty: 1 }] },
      ],
      [
        ["P", "A", "x"],
        ["P", "B", "x"],
      ],
    );
    const articulation = new Set(["P"]);
    const rates = new Map([
      ["A", new Fraction(1)],
      ["B", new Fraction(1)],
      ["P", new Fraction(2)],
    ]);
    const condensation = trivialCondensation(["P", "A", "B"]);
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("A"), tgt("B")],
    });
    const pReplicas = replicas.filter((r) => r.recipeId === "P");
    expect(pReplicas.length).toBe(1); // shared
    expect(pReplicas[0]!.sharedAtArticulation).toBe(true);
    expect(pReplicas[0]!.blueprintGroupId.startsWith("shared:")).toBe(true);
  });

  it("(ii) non-AP replicated: non-AP producer replicates per consumer", () => {
    // Same graph but P is NOT an AP. Each consumer creates its own P replica.
    const g = buildG(
      [
        { id: "P", in: [], out: [{ item: "x", qty: 1 }] },
        { id: "A", in: [{ item: "x", qty: 1 }], out: [{ item: "ya", qty: 1 }] },
        { id: "B", in: [{ item: "x", qty: 1 }], out: [{ item: "yb", qty: 1 }] },
      ],
      [
        ["P", "A", "x"],
        ["P", "B", "x"],
      ],
    );
    const articulation = new Set<RecipeId>(); // empty: P not an AP
    const rates = new Map([
      ["A", new Fraction(1)],
      ["B", new Fraction(1)],
      ["P", new Fraction(2)],
    ]);
    const condensation = trivialCondensation(["P", "A", "B"]);
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("A"), tgt("B")],
    });
    const pReplicas = replicas.filter((r) => r.recipeId === "P");
    expect(pReplicas.length).toBe(2); // one per consumer
    for (const pr of pReplicas) expect(pr.sharedAtArticulation).toBe(false);
  });

  it("(iv) sink-as-target: sink target produces a replica with execRate from rates", () => {
    const g = buildG(
      [
        { id: "U", in: [], out: [{ item: "w", qty: 1 }] },
        { id: "SINK", in: [{ item: "w", qty: 1 }], out: [] },
      ],
      [["U", "SINK", "w"]],
    );
    const articulation = new Set<RecipeId>();
    const rates = new Map([
      ["U", new Fraction(1, 4)],
      ["SINK", new Fraction(1, 4)],
    ]);
    const condensation = trivialCondensation(["U", "SINK"]);
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("SINK")],
    });
    const sinkReplica = replicas.find((r) => r.recipeId === "SINK");
    expect(sinkReplica).toBeDefined();
    expect(sinkReplica!.executionRate.equals(new Fraction(1, 4))).toBe(true);
  });

  it("(v) SCC-member-as-target: target with intra-SCC outgoing edge splits into looper+deliverer", () => {
    // 2-recipe SCC: M1 <-> M2; one target = M1.
    // M1 has an intra-SCC outgoing edge AND is the user target (the
    // boundary-products pass will synthesize a target output from M1's
    // stamps), so the splitter emits TWO M1 replicas (looper + deliverer).
    // M2's only outgoing edge is intra-SCC and M2 is not a target, so M2 stays
    // single.
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
    const articulation = new Set<RecipeId>();
    const rates = new Map([
      ["M1", new Fraction(2)],
      ["M2", new Fraction(1)],
    ]);
    const condensation: Condensation = {
      sccs: [{ id: "M1", recipeIds: ["M1", "M2"] }],
      sccOfRecipe: new Map([
        ["M1", "M1"],
        ["M2", "M1"],
      ]),
      outgoing: new Map([["M1", new Set()]]),
      incoming: new Map([["M1", new Set()]]),
    };
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("M1")],
    });
    const m1Replicas = replicas.filter((r) => r.recipeId === "M1");
    const m2Replicas = replicas.filter((r) => r.recipeId === "M2");
    expect(m1Replicas.length).toBe(2);
    expect(m2Replicas.length).toBe(1);
    // Both M1 split replicas share the same SCC group and are pinned-shared.
    for (const m1 of m1Replicas) {
      expect(m1.blueprintGroupId.startsWith("scc:")).toBe(true);
      expect(m1.sharedAtArticulation).toBe(true);
      expect(m1.outgoingEdgeFilter).toBeDefined();
    }
    expect(m2Replicas[0]!.blueprintGroupId.startsWith("scc:")).toBe(true);
    expect(m2Replicas[0]!.sharedAtArticulation).toBe(true);
    expect(m1Replicas[0]!.blueprintGroupId).toBe(
      m2Replicas[0]!.blueprintGroupId,
    );
    // One M1 owns the intra-SCC edge (M1 -> M2, item "a"); the other owns the
    // empty-cross-boundary filter (the synthetic target output role).
    const looper = m1Replicas.find((r) => r.outgoingEdgeFilter!.has("a|M2"));
    const deliverer = m1Replicas.find(
      (r) => !r.outgoingEdgeFilter!.has("a|M2"),
    );
    expect(looper).toBeDefined();
    expect(deliverer).toBeDefined();
    // Mass-balance invariant: split rates sum to the pre-split recipe rate.
    expect(
      looper!.executionRate
        .add(deliverer!.executionRate)
        .equals(new Fraction(2)),
    ).toBe(true);
  });

  it("(iii) mixed-chain: A and B share upstream AP Q, but both also create their own non-AP P", () => {
    // Graph: P -> A, P -> B, A -> Q (no), wait. Let me restructure.
    // target_X, target_Y both consume "p_out" from P (non-AP).
    // P consumes "q_out" from Q.
    // Q is an AP.
    // Q consumes "raw" from R (non-AP).
    // Expectations:
    //  - P replicas: 2 (one per consumer)
    //  - Q replica: 1 shared (because Q is AP)
    //  - R replica: 1 (reached only once, from Q)
    const g = buildG(
      [
        { id: "R", in: [], out: [{ item: "raw", qty: 1 }] },
        {
          id: "Q",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "q_out", qty: 1 }],
        },
        {
          id: "P",
          in: [{ item: "q_out", qty: 1 }],
          out: [{ item: "p_out", qty: 1 }],
        },
        { id: "X", in: [{ item: "p_out", qty: 1 }], out: [] },
        { id: "Y", in: [{ item: "p_out", qty: 1 }], out: [] },
      ],
      [
        ["R", "Q", "raw"],
        ["Q", "P", "q_out"],
        ["P", "X", "p_out"],
        ["P", "Y", "p_out"],
      ],
    );
    // Note: P is reachable via two paths X<-P, Y<-P. Q is reached via the shared P.
    // In the *initial* (initial-recipe-graph) undirected projection: removing Q disconnects R from {P,X,Y}, so Q is an AP.
    const articulation = new Set(["Q"]);
    const rates = new Map([
      ["R", new Fraction(2)],
      ["Q", new Fraction(2)],
      ["P", new Fraction(2)],
      ["X", new Fraction(1)],
      ["Y", new Fraction(1)],
    ]);
    const condensation = trivialCondensation(["R", "Q", "P", "X", "Y"]);
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("X"), tgt("Y")],
    });
    expect(replicas.filter((r) => r.recipeId === "P").length).toBe(2);
    expect(replicas.filter((r) => r.recipeId === "Q").length).toBe(1);
    expect(replicas.filter((r) => r.recipeId === "R").length).toBe(1);
  });

  // An SCC member with BOTH intra-SCC AND cross-boundary outgoing edges
  // splits into two replicas (one per role).
  it("(vi) SCC-member with intra-SCC and cross-boundary outgoing edges splits", () => {
    // Sandleaf-shape SCC: PLANTER <-> PICKER plus a downstream consumer DOWN
    // that pulls PLANT outside the SCC.
    //   PICKER: 1 plant -> 2 seeds
    //   PLANTER: 1 seed -> 1 plant
    //   DOWN: 1 plant -> 1 powder
    const g = buildG(
      [
        {
          id: "PLANTER",
          in: [{ item: "seed", qty: 1 }],
          out: [{ item: "plant", qty: 1 }],
        },
        {
          id: "PICKER",
          in: [{ item: "plant", qty: 1 }],
          out: [{ item: "seed", qty: 2 }],
        },
        {
          id: "DOWN",
          in: [{ item: "plant", qty: 1 }],
          out: [{ item: "powder", qty: 1 }],
        },
      ],
      [
        ["PLANTER", "PICKER", "plant"],
        ["PICKER", "PLANTER", "seed"],
        ["PLANTER", "DOWN", "plant"],
      ],
    );
    const articulation = new Set<RecipeId>();
    // Steady-state: DOWN exec = 1/sec consumes 1 plant/sec cross-boundary;
    // PICKER exec = 1/sec consumes 1 plant/sec intra-SCC; PLANTER exec = 2/sec
    // produces 2 plants/sec total (split 50/50 across roles).
    const rates = new Map([
      ["PLANTER", new Fraction(2)],
      ["PICKER", new Fraction(1)],
      ["DOWN", new Fraction(1)],
    ]);
    const condensation: Condensation = {
      sccs: [
        { id: "PICKER", recipeIds: ["PICKER", "PLANTER"] },
        { id: "DOWN", recipeIds: ["DOWN"] },
      ],
      sccOfRecipe: new Map([
        ["PICKER", "PICKER"],
        ["PLANTER", "PICKER"],
        ["DOWN", "DOWN"],
      ]),
      outgoing: new Map([
        ["PICKER", new Set(["DOWN"])],
        ["DOWN", new Set<string>()],
      ]),
      incoming: new Map([
        ["PICKER", new Set<string>()],
        ["DOWN", new Set(["PICKER"])],
      ]),
    };
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("DOWN")],
    });
    const plantersReplicas = replicas.filter((r) => r.recipeId === "PLANTER");
    const pickerReplicas = replicas.filter((r) => r.recipeId === "PICKER");
    // PLANTER splits into looper + deliverer; PICKER stays single (only
    // intra-SCC outgoing edge, not a target).
    expect(plantersReplicas.length).toBe(2);
    expect(pickerReplicas.length).toBe(1);
    expect(pickerReplicas[0]!.outgoingEdgeFilter).toBeUndefined();
    // Looper carries the intra-SCC edge (plant -> PICKER); deliverer carries
    // the cross-boundary edge (plant -> DOWN).
    const looper = plantersReplicas.find((r) =>
      r.outgoingEdgeFilter!.has("plant|PICKER"),
    );
    const deliverer = plantersReplicas.find((r) =>
      r.outgoingEdgeFilter!.has("plant|DOWN"),
    );
    expect(looper).toBeDefined();
    expect(deliverer).toBeDefined();
    // Distinct ids, both shared-at-articulation.
    expect(looper!.id).not.toBe(deliverer!.id);
    expect(looper!.sharedAtArticulation).toBe(true);
    expect(deliverer!.sharedAtArticulation).toBe(true);
    // Mass-balance invariant: split rates sum to the pre-split recipe rate.
    expect(
      looper!.executionRate
        .add(deliverer!.executionRate)
        .equals(new Fraction(2)),
    ).toBe(true);
    // Symmetric Sandleaf: each role consumes 1 plant/sec; each replica gets
    // half the planter execution rate.
    expect(looper!.executionRate.equals(new Fraction(1))).toBe(true);
    expect(deliverer!.executionRate.equals(new Fraction(1))).toBe(true);
  });

  // An SCC member with only intra-SCC outgoing edges (and not itself a user
  // target) does NOT split.
  it("(vii) SCC-member with purely intra-SCC outgoing edges does not split", () => {
    // Symmetric M1 <-> M2 SCC. Target is OUTSIDE the SCC (downstream
    // consumer DC pulls a as a boundary).
    const g = buildG(
      [
        { id: "M1", in: [{ item: "b", qty: 1 }], out: [{ item: "a", qty: 1 }] },
        { id: "M2", in: [{ item: "a", qty: 1 }], out: [{ item: "b", qty: 1 }] },
        { id: "DC", in: [{ item: "a", qty: 1 }], out: [{ item: "z", qty: 1 }] },
      ],
      [
        ["M1", "M2", "a"],
        ["M2", "M1", "b"],
        ["M1", "DC", "a"],
      ],
    );
    const articulation = new Set<RecipeId>();
    const rates = new Map([
      ["M1", new Fraction(2)],
      ["M2", new Fraction(1)],
      ["DC", new Fraction(1)],
    ]);
    const condensation: Condensation = {
      sccs: [
        { id: "M1", recipeIds: ["M1", "M2"] },
        { id: "DC", recipeIds: ["DC"] },
      ],
      sccOfRecipe: new Map([
        ["M1", "M1"],
        ["M2", "M1"],
        ["DC", "DC"],
      ]),
      outgoing: new Map([
        ["M1", new Set(["DC"])],
        ["DC", new Set<string>()],
      ]),
      incoming: new Map([
        ["M1", new Set<string>()],
        ["DC", new Set(["M1"])],
      ]),
    };
    const replicas = replicatePerConsumer({
      g,
      articulation,
      rates,
      condensation,
      targets: [tgt("DC")],
    });
    // M1 has both intra-SCC and cross-boundary edges; it should split.
    // M2 has only intra-SCC and is not a target; it stays single.
    expect(replicas.filter((r) => r.recipeId === "M2").length).toBe(1);
    const m2 = replicas.find((r) => r.recipeId === "M2");
    expect(m2!.outgoingEdgeFilter).toBeUndefined();
  });
});
