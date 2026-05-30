import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { AlwaysFoldRender } from "../../../src/pipeline/render/always-fold";
import { NoFoldRender } from "../../../src/pipeline/render/policy";
import type {
  MachineEdge,
  MachineGraph,
  MachineRecipeVertex,
  RenderPolicyInput,
  RenderUnitRecipe,
} from "../../../src/pipeline/types";
import type { Item, Recipe } from "@aef/schema";

function makeRecipeVertex(
  id: string,
  replicaId: string,
  recipeId: string,
  stampIndex: number,
  executionRate: Fraction,
  partial = false,
): MachineRecipeVertex {
  return {
    kind: "machine",
    id,
    replicaId,
    recipeId,
    stampIndex,
    executionRate,
    partial,
  };
}

function makeInput(
  graph: MachineGraph,
  idealCount: Map<string, Fraction>,
): RenderPolicyInput {
  return {
    containers: { containers: [], containerByMember: new Map() },
    machineGraph: graph,
    targets: [],
    itemOverrides: [],
    itemById: new Map(),
    recipeById: new Map(),
    pack: { items: [] },
    idealCount,
  };
}

describe("AlwaysFoldRender - grouping and multiplicity", () => {
  it("collapses K vertices with same replicaId into one RenderUnitRecipe", () => {
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("m1", "r:A", "rec:smelt", 0, new Fraction(60)),
        makeRecipeVertex("m2", "r:A", "rec:smelt", 1, new Fraction(60)),
        makeRecipeVertex("m3", "r:A", "rec:smelt", 2, new Fraction(60)),
      ],
      edges: [],
    };
    const idealCount = new Map([["r:A", new Fraction(3)]]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    const recipeUnits = plan.units.filter(
      (u): u is RenderUnitRecipe => u.kind === "recipe",
    );
    expect(recipeUnits).toHaveLength(1);
    expect(recipeUnits[0]!.recipeId).toBe("rec:smelt");
    expect(recipeUnits[0]!.multiplicity).toEqual({ num: "3", denom: "1" });
  });

  it("emits multiplicity from idealCount, not vertex count", () => {
    // Class has 5 stamps (4 full + 1 partial) but idealCount = 47/10
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("m1", "r:B", "rec:foo", 0, new Fraction(10)),
        makeRecipeVertex("m2", "r:B", "rec:foo", 1, new Fraction(10)),
        makeRecipeVertex("m3", "r:B", "rec:foo", 2, new Fraction(10)),
        makeRecipeVertex("m4", "r:B", "rec:foo", 3, new Fraction(10)),
        makeRecipeVertex("m5", "r:B", "rec:foo", 4, new Fraction(7), true),
      ],
      edges: [],
    };
    const idealCount = new Map([["r:B", new Fraction(47, 10)]]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    const recipeUnits = plan.units.filter(
      (u): u is RenderUnitRecipe => u.kind === "recipe",
    );
    expect(recipeUnits).toHaveLength(1);
    expect(recipeUnits[0]!.multiplicity).toEqual({ num: "47", denom: "10" });
  });

  it("emits one unit per distinct replicaId", () => {
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("m1", "r:A", "rec:smelt", 0, new Fraction(60)),
        makeRecipeVertex("m2", "r:A", "rec:smelt", 1, new Fraction(60)),
        makeRecipeVertex("m3", "r:B", "rec:cast", 0, new Fraction(30)),
      ],
      edges: [],
    };
    const idealCount = new Map([
      ["r:A", new Fraction(2)],
      ["r:B", new Fraction(1)],
    ]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    const recipeUnits = plan.units.filter(
      (u): u is RenderUnitRecipe => u.kind === "recipe",
    );
    expect(recipeUnits).toHaveLength(2);
    expect(recipeUnits.map((u) => u.recipeId).sort()).toEqual([
      "rec:cast",
      "rec:smelt",
    ]);
  });
});

describe("AlwaysFoldRender - edge aggregation", () => {
  it("collapses K paired edges between two classes into one summed edge", () => {
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("a1", "r:A", "rec:src", 0, new Fraction(60)),
        makeRecipeVertex("a2", "r:A", "rec:src", 1, new Fraction(60)),
        makeRecipeVertex("b1", "r:B", "rec:dst", 0, new Fraction(60)),
        makeRecipeVertex("b2", "r:B", "rec:dst", 1, new Fraction(60)),
      ],
      edges: [
        {
          from: "a1",
          to: "b1",
          item: "iron_ore",
          rate: new Fraction(60),
          transportKind: "belt",
        },
        {
          from: "a2",
          to: "b2",
          item: "iron_ore",
          rate: new Fraction(60),
          transportKind: "belt",
        },
      ],
    };
    const idealCount = new Map([
      ["r:A", new Fraction(2)],
      ["r:B", new Fraction(2)],
    ]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    const oreEdges = plan.edges.filter((e) => e.item === "iron_ore");
    expect(oreEdges).toHaveLength(1);
    expect(oreEdges[0]!.rate.equals(new Fraction(120))).toBe(true);
    expect(oreEdges[0]!.fromUnit).toBe("u:class:r:A");
    expect(oreEdges[0]!.toUnit).toBe("u:class:r:B");
  });

  it("keeps distinct edges per item between the same class pair", () => {
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("a1", "r:A", "rec:src", 0, new Fraction(60)),
        makeRecipeVertex("b1", "r:B", "rec:dst", 0, new Fraction(60)),
      ],
      edges: [
        {
          from: "a1",
          to: "b1",
          item: "iron_ore",
          rate: new Fraction(60),
          transportKind: "belt",
        },
        {
          from: "a1",
          to: "b1",
          item: "water",
          rate: new Fraction(30),
          transportKind: "pipe",
        },
      ],
    };
    const idealCount = new Map([
      ["r:A", new Fraction(1)],
      ["r:B", new Fraction(1)],
    ]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    expect(plan.edges).toHaveLength(2);
    const items = plan.edges.map((e) => e.item).sort();
    expect(items).toEqual(["iron_ore", "water"]);
  });

  it("aggregates cross-product edges (K x M) into one summed edge", () => {
    // r:A has 2 stamps, r:B has 3 stamps. Cross-product = 6 MachineEdges.
    // Always-fold collapses to 1 RenderEdge with sum of all 6 rates.
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("a1", "r:A", "rec:src", 0, new Fraction(60)),
        makeRecipeVertex("a2", "r:A", "rec:src", 1, new Fraction(60)),
        makeRecipeVertex("b1", "r:B", "rec:dst", 0, new Fraction(40)),
        makeRecipeVertex("b2", "r:B", "rec:dst", 1, new Fraction(40)),
        makeRecipeVertex("b3", "r:B", "rec:dst", 2, new Fraction(40)),
      ],
      edges: [
        {
          from: "a1",
          to: "b1",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a1",
          to: "b2",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a1",
          to: "b3",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a2",
          to: "b1",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a2",
          to: "b2",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a2",
          to: "b3",
          item: "ore",
          rate: new Fraction(20),
          transportKind: "belt",
        },
      ],
    };
    const idealCount = new Map([
      ["r:A", new Fraction(2)],
      ["r:B", new Fraction(3)],
    ]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0]!.rate.equals(new Fraction(120))).toBe(true);
  });
});

describe("AlwaysFoldRender - self-edge suppression", () => {
  it("does not emit edges where fromUnit === toUnit", () => {
    // A class consuming its own output (recycle within bisim class).
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("a1", "r:A", "rec:recycle", 0, new Fraction(60)),
        makeRecipeVertex("a2", "r:A", "rec:recycle", 1, new Fraction(60)),
      ],
      edges: [
        {
          from: "a1",
          to: "a2",
          item: "scrap",
          rate: new Fraction(10),
          transportKind: "belt",
        },
      ],
    };
    const idealCount = new Map([["r:A", new Fraction(2)]]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));
    expect(plan.edges).toHaveLength(0);
  });

  it("preserves mass-conservation invariant: rendered + suppressed = sum of machine edges", () => {
    const graph: MachineGraph = {
      vertices: [
        makeRecipeVertex("a1", "r:A", "rec:r", 0, new Fraction(60)),
        makeRecipeVertex("a2", "r:A", "rec:r", 1, new Fraction(60)),
        makeRecipeVertex("b1", "r:B", "rec:s", 0, new Fraction(30)),
      ],
      edges: [
        // Within-class (will be suppressed)
        {
          from: "a1",
          to: "a2",
          item: "x",
          rate: new Fraction(5),
          transportKind: "belt",
        },
        // Cross-class (will be rendered)
        {
          from: "a1",
          to: "b1",
          item: "y",
          rate: new Fraction(20),
          transportKind: "belt",
        },
        {
          from: "a2",
          to: "b1",
          item: "y",
          rate: new Fraction(20),
          transportKind: "belt",
        },
      ],
    };
    const idealCount = new Map([
      ["r:A", new Fraction(2)],
      ["r:B", new Fraction(1)],
    ]);
    const plan = AlwaysFoldRender(makeInput(graph, idealCount));

    // Compute rendered + suppressed sum
    const renderedSum = plan.edges.reduce(
      (acc, e) => acc.add(e.rate),
      new Fraction(0),
    );
    // Suppressed self-edges: from a1 to a2 on item x (rate 5)
    const suppressedSum = new Fraction(5);

    const machineEdgeSum = graph.edges.reduce(
      (acc, e) => acc.add(e.rate),
      new Fraction(0),
    );

    expect(renderedSum.add(suppressedSum).equals(machineEdgeSum)).toBe(true);
  });
});

describe("AlwaysFoldRender - boundary products parity with NoFoldRender", () => {
  it("emits identical inputProduct / outputProduct units as NoFoldRender for the same input", () => {
    // Fixture lifted from policy-product-units.test.ts dual-emission setup:
    // one in-graph producer + one consumer + a finite ratePerSec override on
    // the shared item. Exercises both an inputProduct (override -> rateCap)
    // and an outputProduct (target r_cons -> out).
    const itemById = new Map<string, Item>([
      [
        "shared",
        {
          id: "shared",
          name: "shared",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_prod",
        {
          id: "r_prod",
          name: "r_prod",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "shared", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "shared", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const producer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_prod",
      replicaId: "r_prod#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_prod",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const edge: MachineEdge = {
      from: "v_prod",
      to: "v_cons",
      item: "shared",
      rate: new Fraction(1),
      transportKind: "belt",
    };
    const idealCount = new Map([
      ["r_prod#0", new Fraction(1)],
      ["r_cons#0", new Fraction(1)],
    ]);
    const input: RenderPolicyInput = {
      containers: { containers: [], containerByMember: new Map() },
      machineGraph: { vertices: [producer, consumer], edges: [edge] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "shared", ratePerSec: { num: "1", denom: "2" } },
      ],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
      idealCount,
    };

    const fold = AlwaysFoldRender(input);
    const noFold = NoFoldRender(input);

    const kindOf = (
      plan: { units: ReadonlyArray<{ id: string; kind: string }> },
      k: string,
    ) =>
      plan.units
        .filter((u) => u.kind === k)
        .map((u) => ({ id: u.id, kind: u.kind }))
        .sort((a, b) => a.id.localeCompare(b.id));

    expect(kindOf(fold, "inputProduct")).toEqual(
      kindOf(noFold, "inputProduct"),
    );
    expect(kindOf(fold, "outputProduct")).toEqual(
      kindOf(noFold, "outputProduct"),
    );
  });
});
