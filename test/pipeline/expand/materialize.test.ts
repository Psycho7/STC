import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, Recipe, Stoich, TransportKindId } from "@aef/schema";
import { expandMultipliers } from "../../../src/pipeline/expand";
import type {
  LogicalEdge,
  LogicalGraph,
  LogicalRecipeNode,
} from "../../../src/canvas/layout";
import type { ItemId } from "../../../src/pipeline/types";
import type { Replica } from "../../../src/solver/types";
import type {
  MachineRecipeVertex,
  MachineSccVertex,
  NetIOPort,
} from "../../../src/pipeline/types";
import {
  isMachineRecipeVertex,
  isMachineSccVertex,
} from "../../../src/pipeline/types";

function makeRecipe(id: string, inItems: string[], outItems: string[]): Recipe {
  const toStoich = (item: string): Stoich => ({ item, qty: 1 });
  return {
    id,
    name: id,
    category: "c",
    icon: id,
    row: 0,
    time: 1,
    in: inItems.map(toStoich),
    out: outItems.map(toStoich),
    producers: ["m:any"],
  };
}

function makeItem(id: string, transportKind: TransportKindId): Item {
  return {
    id,
    name: id,
    category: "c",
    icon: id,
    row: 0,
    raw: false,
    transportKind,
  };
}

// Shared itemById covering every item referenced by the recipes in this file
// ("i:x", "i:y", "i:in", "i:out"). Default transport is "belt"; tests that
// need a specific kind per item should build their own map via makeItem.
const DEFAULT_ITEM_BY_ID: ReadonlyMap<ItemId, Item> = new Map<ItemId, Item>([
  ["i:x", makeItem("i:x", "belt")],
  ["i:y", makeItem("i:y", "belt")],
  ["i:in", makeItem("i:in", "belt")],
  ["i:out", makeItem("i:out", "belt")],
]);

function makeNode(opts: {
  id: string;
  recipe: Recipe;
  multiplier: number;
}): LogicalRecipeNode {
  return {
    kind: "recipe",
    id: opts.id,
    recipe: opts.recipe,
    multiplier: opts.multiplier,
    expanded: false,
  };
}

function makeReplica(opts: {
  id: string;
  recipeId: string;
  executionRate: Fraction;
  consumerPath?: ReadonlyArray<string>;
  sharedAtArticulation?: boolean;
  blueprintGroupId?: string;
}): Replica {
  return {
    id: opts.id,
    recipeId: opts.recipeId,
    executionRate: opts.executionRate,
    consumerPath: opts.consumerPath ?? [],
    blueprintGroupId: opts.blueprintGroupId ?? "target:" + opts.recipeId,
    sharedAtArticulation: opts.sharedAtArticulation ?? false,
  };
}

function makeEdge(opts: {
  id?: string;
  source: string;
  target: string;
  item: string;
}): LogicalEdge {
  return {
    id: opts.id ?? `${opts.source}->${opts.target}:${opts.item}`,
    source: opts.source,
    target: opts.target,
    sourcePort: `out:${opts.item}`,
    targetPort: `in:${opts.item}`,
  };
}

describe("expandMultipliers / single replica with multiplier=1", () => {
  it("produces one machine vertex and one outgoing machine edge", () => {
    const rA = makeRecipe("r:A", [], ["i:x"]);
    const rB = makeRecipe("r:B", ["i:x"], []);
    const nodeA = makeNode({ id: "rA0", recipe: rA, multiplier: 1 });
    const nodeB = makeNode({ id: "rB0", recipe: rB, multiplier: 1 });
    const edge = makeEdge({ source: "rA0", target: "rB0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeA, nodeB], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rA0",
        recipeId: "r:A",
        executionRate: new Fraction(1),
      }),
      makeReplica({
        id: "rB0",
        recipeId: "r:B",
        executionRate: new Fraction(1),
        consumerPath: [],
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(2)]]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    expect(out.vertices).toHaveLength(2);
    const recipeVerts = out.vertices.filter(isMachineRecipeVertex);
    expect(recipeVerts).toHaveLength(2);
    expect(recipeVerts.every((v) => v.stampIndex === 0)).toBe(true);

    expect(out.edges).toHaveLength(1);
    const e = out.edges[0]!;
    expect(e.item).toBe("i:x");
    expect(e.rate.equals(new Fraction(2))).toBe(true);
    expect(e.from).toContain("rA0");
    expect(e.to).toContain("rB0");
  });
});

describe("expandMultipliers / paired distribution (producer 4 -> consumer 4)", () => {
  it("emits 4+4 vertices and 4 paired edges by stampIndex", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    // Producer was created to satisfy consumer X (per-consumer replication):
    // consumerPath ends with the consumer replica id.
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 4 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 4 });
    const edge = makeEdge({ source: "rP0", target: "rC0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(4),
        consumerPath: ["rC0"],
        sharedAtArticulation: false,
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(4),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(8)]]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const recipeVerts = out.vertices.filter(isMachineRecipeVertex);
    expect(recipeVerts).toHaveLength(8);
    const producerStamps = recipeVerts
      .filter((v) => v.replicaId === "rP0")
      .sort((a, b) => a.stampIndex - b.stampIndex);
    const consumerStamps = recipeVerts
      .filter((v) => v.replicaId === "rC0")
      .sort((a, b) => a.stampIndex - b.stampIndex);
    expect(producerStamps.map((v) => v.stampIndex)).toEqual([0, 1, 2, 3]);
    expect(consumerStamps.map((v) => v.stampIndex)).toEqual([0, 1, 2, 3]);

    expect(out.edges).toHaveLength(4);
    // Verify 1:1 by stampIndex.
    for (let i = 0; i < 4; i++) {
      const pId = producerStamps[i]!.id;
      const cId = consumerStamps[i]!.id;
      const e = out.edges.find((x) => x.from === pId && x.to === cId);
      expect(e).toBeDefined();
      // Per-edge rate = total / 4 = 8/4 = 2.
      expect(e!.rate.equals(new Fraction(2))).toBe(true);
      expect(e!.item).toBe("i:x");
    }
  });
});

describe("expandMultipliers / paired distribution with unequal multipliers", () => {
  // Regression: a producer recipe with a slower per-machine throughput than
  // the consumer needs more producer machines than consumer machines, so the
  // replicator emits unequal multipliers (e.g., AEF iron_ore at 1/3/s feeds
  // iron_nugget-iron_ore at 0.5/s -> 6 producers feeding 4 consumers totalling
  // 2/s). Every machine on both sides must end up with at least one edge so
  // the render plan does not show isolated stamps.
  it("round-robins so every producer machine has an outgoing edge (6 -> 4)", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 6 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 4 });
    const edge = makeEdge({ source: "rP0", target: "rC0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(2),
        consumerPath: ["rC0"],
        sharedAtArticulation: false,
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(2),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(2)]]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const producerStamps = out.vertices
      .filter(isMachineRecipeVertex)
      .filter((v) => v.replicaId === "rP0")
      .sort((a, b) => a.stampIndex - b.stampIndex);
    expect(producerStamps).toHaveLength(6);

    // edgeCount = max(6, 4) = 6; every producer machine must be a source.
    expect(out.edges).toHaveLength(6);
    const producerOutDegree = new Map<string, number>();
    for (const v of producerStamps) producerOutDegree.set(v.id, 0);
    for (const e of out.edges) {
      const prev = producerOutDegree.get(e.from);
      if (prev !== undefined) producerOutDegree.set(e.from, prev + 1);
    }
    for (const v of producerStamps) {
      expect(producerOutDegree.get(v.id)).toBe(1);
    }
    // Total flow preserved.
    const total = out.edges.reduce(
      (acc, e) => acc.add(e.rate),
      new Fraction(0),
    );
    expect(total.equals(new Fraction(2))).toBe(true);
  });

  it("round-robins when consumer count exceeds producer count (3 -> 5)", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 3 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 5 });
    const edge = makeEdge({ source: "rP0", target: "rC0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(1),
        consumerPath: ["rC0"],
        sharedAtArticulation: false,
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(1),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(1)]]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    // edgeCount = max(3, 5) = 5; every consumer machine must have an incoming
    // edge.
    expect(out.edges).toHaveLength(5);
    const consumerStamps = out.vertices
      .filter(isMachineRecipeVertex)
      .filter((v) => v.replicaId === "rC0");
    const consumerInDegree = new Map<string, number>();
    for (const v of consumerStamps) consumerInDegree.set(v.id, 0);
    for (const e of out.edges) {
      const prev = consumerInDegree.get(e.to);
      if (prev !== undefined) consumerInDegree.set(e.to, prev + 1);
    }
    for (const v of consumerStamps) {
      expect(consumerInDegree.get(v.id)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("expandMultipliers / parallel-edge preservation", () => {
  it("preserves two distinct logical edges as two machine edges per stamp pair", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 3 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 3 });
    const edge1 = makeEdge({
      id: "e:1",
      source: "rP0",
      target: "rC0",
      item: "i:x",
    });
    const edge2 = makeEdge({
      id: "e:2",
      source: "rP0",
      target: "rC0",
      item: "i:x",
    });
    const logical: LogicalGraph = {
      nodes: [nodeP, nodeC],
      edges: [edge1, edge2],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(3),
        consumerPath: ["rC0"],
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(3),
      }),
    ];
    const rates = new Map([
      [edge1.id, new Fraction(6)],
      [edge2.id, new Fraction(3)],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const recipeVerts = out.vertices.filter(isMachineRecipeVertex);
    expect(recipeVerts).toHaveLength(6);
    expect(out.edges).toHaveLength(6);

    // 3 pairs, each with 2 parallel edges. Group edges by (from, to) and count.
    const counts = new Map<string, number>();
    for (const e of out.edges) {
      const k = `${e.from}|${e.to}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect([...counts.values()].every((c) => c === 2)).toBe(true);
    expect(counts.size).toBe(3);

    // Per-edge rates: edge1 -> 6/3 = 2; edge2 -> 3/3 = 1.
    const rateCounts = new Map<string, number>();
    for (const e of out.edges) {
      const k = e.rate.toFraction();
      rateCounts.set(k, (rateCounts.get(k) ?? 0) + 1);
    }
    expect(rateCounts.get("2")).toBe(3);
    expect(rateCounts.get("1")).toBe(3);
  });
});

describe("expandMultipliers / shared-utility distribution (greedy by demand)", () => {
  it("fans 12 producer machines onto 3 consumers (4+4+4) deterministically", () => {
    const rShared = makeRecipe("r:S", [], ["i:y"]);
    const rA = makeRecipe("r:CA", ["i:y"], []);
    const rB = makeRecipe("r:CB", ["i:y"], []);
    const rC = makeRecipe("r:CC", ["i:y"], []);

    const nodeS = makeNode({ id: "rS", recipe: rShared, multiplier: 12 });
    const nodeA = makeNode({ id: "rA", recipe: rA, multiplier: 4 });
    const nodeB = makeNode({ id: "rB", recipe: rB, multiplier: 4 });
    const nodeC = makeNode({ id: "rC", recipe: rC, multiplier: 4 });

    const eA = makeEdge({ source: "rS", target: "rA", item: "i:y" });
    const eB = makeEdge({ source: "rS", target: "rB", item: "i:y" });
    const eC = makeEdge({ source: "rS", target: "rC", item: "i:y" });

    const logical: LogicalGraph = {
      nodes: [nodeS, nodeA, nodeB, nodeC],
      edges: [eA, eB, eC],
    };

    const replicas: Replica[] = [
      makeReplica({
        id: "rS",
        recipeId: "r:S",
        executionRate: new Fraction(12),
        sharedAtArticulation: true,
      }),
      makeReplica({
        id: "rA",
        recipeId: "r:CA",
        executionRate: new Fraction(4),
      }),
      makeReplica({
        id: "rB",
        recipeId: "r:CB",
        executionRate: new Fraction(4),
      }),
      makeReplica({
        id: "rC",
        recipeId: "r:CC",
        executionRate: new Fraction(4),
      }),
    ];
    // Distinct demands so greedy assignment is observable: A=8, B=6, C=4.
    const rates = new Map([
      [eA.id, new Fraction(8)],
      [eB.id, new Fraction(6)],
      [eC.id, new Fraction(4)],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const recipeVerts = out.vertices.filter(isMachineRecipeVertex);
    expect(recipeVerts).toHaveLength(24); // 12 + 4 + 4 + 4
    expect(out.edges).toHaveLength(12);

    // Each producer machine has exactly one outgoing edge.
    const outgoingPerProducer = new Map<string, number>();
    for (const e of out.edges) {
      outgoingPerProducer.set(
        e.from,
        (outgoingPerProducer.get(e.from) ?? 0) + 1,
      );
    }
    const producerIds = recipeVerts
      .filter((v) => v.replicaId === "rS")
      .map((v) => v.id);
    expect(producerIds).toHaveLength(12);
    for (const pid of producerIds) {
      expect(outgoingPerProducer.get(pid) ?? 0).toBe(1);
    }

    // Each consumer machine has exactly one incoming edge.
    const incomingPerConsumer = new Map<string, number>();
    for (const e of out.edges) {
      incomingPerConsumer.set(e.to, (incomingPerConsumer.get(e.to) ?? 0) + 1);
    }
    const consumerIds = recipeVerts
      .filter((v) => v.replicaId !== "rS")
      .map((v) => v.id);
    expect(consumerIds).toHaveLength(12);
    for (const cid of consumerIds) {
      expect(incomingPerConsumer.get(cid) ?? 0).toBe(1);
    }

    // Greedy by demand desc: A (rate 8) gets producer stamps 0..3, B (6) gets
    // 4..7, C (4) gets 8..11. Verify producer stamp 0 -> rA stamp 0 and
    // producer stamp 11 -> rC stamp 3.
    const sortedProducers = recipeVerts
      .filter((v) => v.replicaId === "rS")
      .sort((a, b) => a.stampIndex - b.stampIndex);
    const consumerOf = (vid: string): string => {
      const v = recipeVerts.find((x) => x.id === vid)!;
      return v.replicaId;
    };
    // First 4 producers must feed consumer A.
    for (let i = 0; i < 4; i++) {
      const edge = out.edges.find((x) => x.from === sortedProducers[i]!.id)!;
      expect(consumerOf(edge.to)).toBe("rA");
    }
    // Producers 4..7 feed B.
    for (let i = 4; i < 8; i++) {
      const edge = out.edges.find((x) => x.from === sortedProducers[i]!.id)!;
      expect(consumerOf(edge.to)).toBe("rB");
    }
    // Producers 8..11 feed C.
    for (let i = 8; i < 12; i++) {
      const edge = out.edges.find((x) => x.from === sortedProducers[i]!.id)!;
      expect(consumerOf(edge.to)).toBe("rC");
    }

    // Per-edge rate is per-consumer-machine demand: A -> 8/4=2, B -> 6/4=3/2, C -> 4/4=1.
    const rateOf = (replicaId: string): Fraction => {
      const e = out.edges.find((x) => consumerOf(x.to) === replicaId)!;
      return e.rate;
    };
    expect(rateOf("rA").equals(new Fraction(2))).toBe(true);
    expect(rateOf("rB").equals(new Fraction(3, 2))).toBe(true);
    expect(rateOf("rC").equals(new Fraction(1))).toBe(true);

    // Determinism: re-running with the same input produces identical output.
    const out2 = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });
    expect(out2.vertices.map((v) => v.id)).toEqual(
      out.vertices.map((v) => v.id),
    );
    expect(
      out2.edges.map(
        (e) => `${e.from}->${e.to}:${e.item}@${e.rate.toFraction()}`,
      ),
    ).toEqual(
      out.edges.map(
        (e) => `${e.from}->${e.to}:${e.item}@${e.rate.toFraction()}`,
      ),
    );
  });
});

describe("expandMultipliers / shared-utility distribution with unequal totals", () => {
  // Same root cause as paired unequal-mults: a shared producer whose
  // per-machine throughput is slower than the consumers it feeds ends up
  // with more producer machines than total consumer slots. Pre-fix, the
  // greedy assignment truncated at min(producers, slots) and the extras
  // were silently dropped from the edge set.
  it("round-robins so every producer machine has an outgoing edge (6 -> 4 across 2 consumers)", () => {
    const rShared = makeRecipe("r:S", [], ["i:y"]);
    const rA = makeRecipe("r:CA", ["i:y"], []);
    const rB = makeRecipe("r:CB", ["i:y"], []);

    const nodeS = makeNode({ id: "rS", recipe: rShared, multiplier: 6 });
    const nodeA = makeNode({ id: "rA", recipe: rA, multiplier: 2 });
    const nodeB = makeNode({ id: "rB", recipe: rB, multiplier: 2 });

    const eA = makeEdge({ source: "rS", target: "rA", item: "i:y" });
    const eB = makeEdge({ source: "rS", target: "rB", item: "i:y" });

    const logical: LogicalGraph = {
      nodes: [nodeS, nodeA, nodeB],
      edges: [eA, eB],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rS",
        recipeId: "r:S",
        executionRate: new Fraction(2),
        sharedAtArticulation: true,
      }),
      makeReplica({
        id: "rA",
        recipeId: "r:CA",
        executionRate: new Fraction(1),
      }),
      makeReplica({
        id: "rB",
        recipeId: "r:CB",
        executionRate: new Fraction(1),
      }),
    ];
    const rates = new Map([
      [eA.id, new Fraction(1)],
      [eB.id, new Fraction(1)],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    // edgeCount = max(6 producers, 2+2=4 slots) = 6.
    expect(out.edges).toHaveLength(6);

    // Every producer machine has at least one outgoing edge.
    const producerIds = out.vertices
      .filter(isMachineRecipeVertex)
      .filter((v) => v.replicaId === "rS")
      .map((v) => v.id);
    expect(producerIds).toHaveLength(6);
    const outgoing = new Set(out.edges.map((e) => e.from));
    for (const pid of producerIds) {
      expect(outgoing.has(pid)).toBe(true);
    }
  });
});

describe("expandMultipliers / SCC vertex stays a singleton", () => {
  it("emits one MachineSccVertex with carry-over netIO and no internal stamps", () => {
    const rLoop = makeRecipe("r:Loop", ["i:in"], ["i:out"]);
    const rDown = makeRecipe("r:D", ["i:out"], []);
    // The SCC stand-in node has multiplier > 1 in the logical graph (its
    // member replicas materialized as a single composite), but the SCC map
    // overrides materialization to a single typed vertex.
    const sccNode = makeNode({ id: "sccLoop", recipe: rLoop, multiplier: 5 });
    const downNode = makeNode({ id: "rD", recipe: rDown, multiplier: 1 });
    const edge = makeEdge({ source: "sccLoop", target: "rD", item: "i:out" });
    const logical: LogicalGraph = {
      nodes: [sccNode, downNode],
      edges: [edge],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rD",
        recipeId: "r:D",
        executionRate: new Fraction(1),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(2)]]);
    const netIO: NetIOPort[] = [
      { item: "i:in", direction: "in", rate: new Fraction(1) },
      { item: "i:out", direction: "out", rate: new Fraction(2) },
    ];
    const sccByLogicalNodeId = new Map([
      ["sccLoop", { sccId: "scc:Loop", netIO }],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      sccByLogicalNodeId,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const sccVerts = out.vertices.filter(isMachineSccVertex);
    const machineVerts = out.vertices.filter(isMachineRecipeVertex);
    expect(sccVerts).toHaveLength(1);
    expect(machineVerts).toHaveLength(1);
    const scc = sccVerts[0] as MachineSccVertex;
    expect(scc.sccId).toBe("scc:Loop");
    expect(scc.netIO).toEqual(netIO);

    // One outgoing edge from the SCC vertex to the downstream stamp.
    expect(out.edges).toHaveLength(1);
    const e = out.edges[0]!;
    expect(e.from).toBe(scc.id);
    const downStamp = machineVerts[0] as MachineRecipeVertex;
    expect(e.to).toBe(downStamp.id);
    expect(e.rate.equals(new Fraction(2))).toBe(true);
  });
});

describe("expandMultipliers / SCC boundary with multi-stamp non-SCC neighbor", () => {
  // Pre-fix the SCC-touching branch emitted exactly one edge to/from the
  // SCC singleton regardless of the non-SCC side's multiplier, leaving
  // stamps 1..N-1 isolated. Fan out across the non-SCC side so every
  // machine participates; the SCC interior renderer is free to re-route
  // boundary distribution later.
  it("fans across all consumer stamps when the SCC is the producer (1 -> 4)", () => {
    const rLoop = makeRecipe("r:Loop", ["i:in"], ["i:out"]);
    const rDown = makeRecipe("r:D", ["i:out"], []);
    const sccNode = makeNode({ id: "sccLoop", recipe: rLoop, multiplier: 1 });
    const downNode = makeNode({ id: "rD", recipe: rDown, multiplier: 4 });
    const edge = makeEdge({ source: "sccLoop", target: "rD", item: "i:out" });
    const logical: LogicalGraph = {
      nodes: [sccNode, downNode],
      edges: [edge],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rD",
        recipeId: "r:D",
        executionRate: new Fraction(4),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(2)]]);
    const netIO: NetIOPort[] = [
      { item: "i:out", direction: "out", rate: new Fraction(2) },
    ];
    const sccByLogicalNodeId = new Map([
      ["sccLoop", { sccId: "scc:Loop", netIO }],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      sccByLogicalNodeId,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const scc = out.vertices.filter(isMachineSccVertex)[0]!;
    const downStamps = out.vertices.filter(isMachineRecipeVertex);
    expect(downStamps).toHaveLength(4);
    expect(out.edges).toHaveLength(4);
    const incoming = new Set(out.edges.map((e) => e.to));
    for (const ds of downStamps) {
      expect(incoming.has(ds.id)).toBe(true);
    }
    for (const e of out.edges) {
      expect(e.from).toBe(scc.id);
      // Per-edge rate = 2 / 4 = 1/2.
      expect(e.rate.equals(new Fraction(1, 2))).toBe(true);
    }
  });

  it("fans across all producer stamps when the SCC is the consumer (3 -> 1)", () => {
    const rUp = makeRecipe("r:U", [], ["i:in"]);
    const rLoop = makeRecipe("r:Loop", ["i:in"], ["i:out"]);
    const upNode = makeNode({ id: "rU", recipe: rUp, multiplier: 3 });
    const sccNode = makeNode({ id: "sccLoop", recipe: rLoop, multiplier: 1 });
    const edge = makeEdge({ source: "rU", target: "sccLoop", item: "i:in" });
    const logical: LogicalGraph = {
      nodes: [upNode, sccNode],
      edges: [edge],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rU",
        recipeId: "r:U",
        executionRate: new Fraction(3),
        consumerPath: ["sccLoop"],
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(3)]]);
    const netIO: NetIOPort[] = [
      { item: "i:in", direction: "in", rate: new Fraction(3) },
    ];
    const sccByLogicalNodeId = new Map([
      ["sccLoop", { sccId: "scc:Loop", netIO }],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      sccByLogicalNodeId,
      itemById: DEFAULT_ITEM_BY_ID,
    });

    const scc = out.vertices.filter(isMachineSccVertex)[0]!;
    const upStamps = out.vertices.filter(isMachineRecipeVertex);
    expect(upStamps).toHaveLength(3);
    expect(out.edges).toHaveLength(3);
    const outgoing = new Set(out.edges.map((e) => e.from));
    for (const us of upStamps) {
      expect(outgoing.has(us.id)).toBe(true);
    }
    for (const e of out.edges) {
      expect(e.to).toBe(scc.id);
      // Per-edge rate = 3 / 3 = 1.
      expect(e.rate.equals(new Fraction(1))).toBe(true);
    }
  });
});

describe("expandMultipliers / determinism property", () => {
  it("produces identical vertex/edge sequences across runs on the same input", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 3 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 3 });
    const edge = makeEdge({ source: "rP0", target: "rC0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(3),
        consumerPath: ["rC0"],
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(3),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(3)]]);

    const snapshot = (g: ReturnType<typeof expandMultipliers>): string =>
      JSON.stringify({
        v: g.vertices.map((v) =>
          v.kind === "machine"
            ? {
                kind: v.kind,
                id: v.id,
                replicaId: v.replicaId,
                recipeId: v.recipeId,
                stampIndex: v.stampIndex,
              }
            : { kind: v.kind, id: v.id, sccId: v.sccId },
        ),
        e: g.edges.map((e) => ({
          from: e.from,
          to: e.to,
          item: e.item,
          rate: e.rate.toFraction(),
        })),
      });

    const a = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });
    const b = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById: DEFAULT_ITEM_BY_ID,
    });
    expect(snapshot(a)).toBe(snapshot(b));
  });
});
