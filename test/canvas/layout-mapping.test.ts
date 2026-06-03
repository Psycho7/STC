import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";

import {
  layoutRenderPlan,
  renderPlanToElkGraph,
  fromElkRenderLayout,
  ROOT_LAYOUT_OPTIONS,
  type ElkGraph,
  type LayoutInput,
} from "../../src/canvas/layout";
import {
  PORT_HEIGHT,
  PORT_WIDTH,
  RECIPE_WIDTH,
  loopBoxDimensions,
} from "../../src/canvas/dimensions";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type {
  BlueprintGroupContainer,
  LoopBoxContainer,
  RenderEdge,
  RenderPlan,
  RenderUnitLoop,
  RenderUnitRecipe,
} from "../../src/pipeline/types";

const mkRecipe = (id: string, ins: string[], outs: string[]): Recipe => ({
  id,
  name: id,
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: ins.map((item) => ({ item, qty: 1 })),
  out: outs.map((item) => ({ item, qty: 1 })),
  producers: [],
});

const mkRecipeUnit = (
  id: string,
  recipeId: string,
  containerId?: string,
): RenderUnitRecipe => {
  const base: RenderUnitRecipe = {
    id,
    kind: "recipe",
    recipeId,
    count: 1,
    multiplicity: { num: "1", denom: "1" },
  };
  return containerId !== undefined ? { ...base, containerId } : base;
};

const mkLoopUnit = (
  id: string,
  sccId: string,
  netIO: RenderUnitLoop["netIO"],
): RenderUnitLoop => ({
  id,
  kind: "loop",
  sccId,
  count: 1,
  netIO,
});

const mkEdge = (
  fromUnit: string,
  toUnit: string,
  item: string,
): RenderEdge => ({
  fromUnit,
  toUnit,
  item,
  rate: new Fraction(1),
  transportKind: "belt",
});

const findChild = (graph: ElkGraph, id: string) =>
  graph.children.find((c) => c.id === id);

describe("renderPlanToElkGraph: root layout options", () => {
  it("sets id=root, layered algorithm, INCLUDE_CHILDREN, ORTHOGONAL routing", () => {
    const recipe = mkRecipe("r:a", [], ["x"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    expect(graph.id).toBe("root");
    expect(graph.layoutOptions?.["elk.algorithm"]).toBe("layered");
    expect(graph.layoutOptions?.["org.eclipse.elk.hierarchyHandling"]).toBe(
      "INCLUDE_CHILDREN",
    );
    expect(graph.layoutOptions?.["elk.edgeRouting"]).toBe("ORTHOGONAL");
  });

  it("exports the spacing constants on the root", () => {
    const graph = renderPlanToElkGraph({
      plan: { units: [], edges: [], containers: [] },
      recipeById: new Map(),
      itemById: new Map(),
    });
    expect(graph.layoutOptions?.["elk.spacing.nodeNode"]).toBeDefined();
    expect(
      graph.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"],
    ).toBeDefined();
  });

  it("ROOT_LAYOUT_OPTIONS contains the load-bearing keys", () => {
    expect(ROOT_LAYOUT_OPTIONS["org.eclipse.elk.hierarchyHandling"]).toBe(
      "INCLUDE_CHILDREN",
    );
    expect(ROOT_LAYOUT_OPTIONS["elk.edgeRouting"]).toBe("ORTHOGONAL");
    expect(ROOT_LAYOUT_OPTIONS["elk.algorithm"]).toBe("layered");
  });
});

describe("renderPlanToElkGraph: unit dimensions", () => {
  it("recipe-unit node dimensions match measureRecipe(recipe)", () => {
    const recipe = mkRecipe("r:a", ["i1", "i2"], ["o1"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    const node = findChild(graph, "u:a");
    const geom = measureRecipe(recipe);
    expect(node?.width).toBe(geom.width);
    expect(node?.height).toBe(geom.height);
  });

  it("ports are WEST in / EAST out, FIXED_ORDER, non-zero dims", () => {
    const recipe = mkRecipe("r:a", ["i1", "i2"], ["o1"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    const node = findChild(graph, "u:a");
    expect(node?.layoutOptions?.["org.eclipse.elk.portConstraints"]).toBe(
      "FIXED_ORDER",
    );
    const ports = node?.ports ?? [];
    expect(ports).toHaveLength(3);
    for (const p of ports) {
      expect(p.width).toBe(PORT_WIDTH);
      expect(p.height).toBe(PORT_HEIGHT);
    }
    const westSides = ports
      .filter((p) => p.id?.includes(".in:"))
      .map((p) => p.layoutOptions?.["org.eclipse.elk.port.side"]);
    const eastSides = ports
      .filter((p) => p.id?.includes(".out:"))
      .map((p) => p.layoutOptions?.["org.eclipse.elk.port.side"]);
    expect(westSides).toEqual(["WEST", "WEST"]);
    expect(eastSides).toEqual(["EAST"]);
  });
});

describe("renderPlanToElkGraph: containers", () => {
  it("nests blueprint-group members as children of the container node", () => {
    const recipe = mkRecipe("r:a", ["i"], ["o"]);
    const recipeById = new Map([["r:a", recipe]]);
    const container: BlueprintGroupContainer = {
      kind: "blueprint-group",
      id: "g:1",
      members: ["u:a", "u:b", "u:c"],
    };
    const plan: RenderPlan = {
      units: [
        mkRecipeUnit("u:a", "r:a", "g:1"),
        mkRecipeUnit("u:b", "r:a", "g:1"),
        mkRecipeUnit("u:c", "r:a", "g:1"),
      ],
      edges: [],
      containers: [container],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById,
      itemById: new Map(),
    });
    const groupNode = findChild(graph, "g:1");
    expect(groupNode).toBeDefined();
    expect(groupNode?.children?.map((c) => c.id).sort()).toEqual([
      "u:a",
      "u:b",
      "u:c",
    ]);
    expect(graph.children.filter((c) => c.id !== "g:1")).toHaveLength(0);
  });

  it("places top-level units (no containerId) as direct root children", () => {
    const recipe = mkRecipe("r:a", [], ["o"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a"), mkRecipeUnit("u:b", "r:a")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    expect(graph.children.map((c) => c.id).sort()).toEqual(["u:a", "u:b"]);
  });
});

describe("renderPlanToElkGraph: loop units", () => {
  it("uses precomputed interior size via loopBoxDimensions", () => {
    const interior = { width: 320, height: 240 };
    const expected = loopBoxDimensions(interior);
    const loop = mkLoopUnit("l:0", "scc:loop1", [
      { item: "water", direction: "in", rate: new Fraction(1) },
      { item: "steam", direction: "out", rate: new Fraction(1) },
    ]);
    const plan: RenderPlan = { units: [loop], edges: [], containers: [] };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map(),
      itemById: new Map(),
      interiorByLoopId: new Map([["scc:loop1", interior]]),
    });
    const node = findChild(graph, "l:0");
    expect(node?.width).toBe(expected.width);
    expect(node?.height).toBe(expected.height);
    const ports = node?.ports ?? [];
    expect(ports.find((p) => p.id?.endsWith(".in:water"))).toBeDefined();
    expect(ports.find((p) => p.id?.endsWith(".out:steam"))).toBeDefined();
  });

  it("falls back to a placeholder interior when interiorByLoopId is empty", () => {
    const loop = mkLoopUnit("l:0", "scc:unknown", []);
    const plan: RenderPlan = { units: [loop], edges: [], containers: [] };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map(),
      itemById: new Map(),
    });
    const node = findChild(graph, "l:0");
    expect((node?.width ?? 0) > 16).toBe(true);
    expect((node?.height ?? 0) > 16).toBe(true);
  });
});

describe("renderPlanToElkGraph: edges", () => {
  it("produces one ELK edge per RenderEdge with <unit>.<port> source/target", () => {
    const recipe = mkRecipe("r:a", ["x"], ["x"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a"), mkRecipeUnit("u:b", "r:a")],
      edges: [mkEdge("u:a", "u:b", "x")],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sources).toEqual(["u:a.out:x"]);
    expect(graph.edges[0]?.targets).toEqual(["u:b.in:x"]);
  });
});

describe("layoutRenderPlan: end-to-end", () => {
  it("returns nodes for two recipes plus the connecting edge", async () => {
    const recipeA = mkRecipe("r:a", [], ["x"]);
    const recipeB = mkRecipe("r:b", ["x"], []);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a"), mkRecipeUnit("u:b", "r:b")],
      edges: [mkEdge("u:a", "u:b", "x")],
      containers: [],
    };
    const input: LayoutInput = {
      plan,
      recipeById: new Map([
        ["r:a", recipeA],
        ["r:b", recipeB],
      ]),
      itemById: new Map(),
    };
    const result = await layoutRenderPlan(input);
    expect(result.nodes).toHaveLength(2);
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["u:a", "u:b"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.source).toBe("u:a");
    expect(result.edges[0]?.target).toBe("u:b");
    expect(result.edges[0]?.markerEnd).toEqual({ type: "arrowclosed" });
  });

  it("places the two recipes on different layers (x coords differ)", async () => {
    const recipeA = mkRecipe("r:a", [], ["x"]);
    const recipeB = mkRecipe("r:b", ["x"], []);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a"), mkRecipeUnit("u:b", "r:b")],
      edges: [mkEdge("u:a", "u:b", "x")],
      containers: [],
    };
    const result = await layoutRenderPlan({
      plan,
      recipeById: new Map([
        ["r:a", recipeA],
        ["r:b", recipeB],
      ]),
      itemById: new Map(),
    });
    const a = result.nodes.find((n) => n.id === "u:a");
    const b = result.nodes.find((n) => n.id === "u:b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.position.x).not.toBe(b!.position.x);
  });

  it("places blueprint-group members as parented React Flow nodes", async () => {
    const recipe = mkRecipe("r:a", [], ["o"]);
    const container: BlueprintGroupContainer = {
      kind: "blueprint-group",
      id: "g:1",
      members: ["u:a", "u:b", "u:c"],
    };
    const plan: RenderPlan = {
      units: [
        mkRecipeUnit("u:a", "r:a", "g:1"),
        mkRecipeUnit("u:b", "r:a", "g:1"),
        mkRecipeUnit("u:c", "r:a", "g:1"),
      ],
      edges: [],
      containers: [container],
    };
    const result = await layoutRenderPlan({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    const groupRF = result.nodes.find((n) => n.id === "g:1");
    expect(groupRF?.type).toBe("group");
    const members = result.nodes.filter((n) =>
      ["u:a", "u:b", "u:c"].includes(n.id),
    );
    expect(members).toHaveLength(3);
    for (const m of members) {
      expect((m as { parentId?: string }).parentId).toBe("g:1");
    }
    expect((groupRF?.width ?? 0) >= RECIPE_WIDTH).toBe(true);
  });

  it("treats a loop-box container's loop unit as a single sized outer node", async () => {
    const interior = { width: 240, height: 180 };
    const loopContainer: LoopBoxContainer = {
      kind: "loop-box",
      id: "lc:1",
      members: ["l:0"],
      sccId: "scc:1",
    };
    const loop = mkLoopUnit("l:0", "scc:1", [
      { item: "water", direction: "in", rate: new Fraction(1) },
    ]);
    const plan: RenderPlan = {
      units: [{ ...loop, containerId: "lc:1" }],
      edges: [],
      containers: [loopContainer],
    };

    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map(),
      itemById: new Map(),
      interiorByLoopId: new Map([["scc:1", interior]]),
    });
    const containerNode = findChild(graph, "lc:1");
    const inner = containerNode?.children?.[0];
    expect(inner?.id).toBe("l:0");
    const expectedOuter = loopBoxDimensions(interior);
    expect(inner?.width).toBe(expectedOuter.width);
    expect(inner?.height).toBe(expectedOuter.height);

    const laid = await layoutRenderPlan({
      plan,
      recipeById: new Map(),
      itemById: new Map(),
      interiorByLoopId: new Map([["scc:1", interior]]),
    });
    const loopRF = laid.nodes.find((n) => n.id === "l:0");
    expect(loopRF?.type).toBe("loop");
    expect((loopRF as { parentId?: string }).parentId).toBe("lc:1");
  });
});

describe("fromElkRenderLayout", () => {
  it("applies markerEnd ArrowClosed to every edge", () => {
    const recipe = mkRecipe("r:a", ["x"], ["x"]);
    const plan: RenderPlan = {
      units: [mkRecipeUnit("u:a", "r:a"), mkRecipeUnit("u:b", "r:a")],
      edges: [mkEdge("u:a", "u:b", "x")],
      containers: [],
    };
    const input: LayoutInput = {
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    };
    const graph = renderPlanToElkGraph(input);
    const laid: ElkGraph = {
      ...graph,
      children: graph.children.map((c, i) => ({ ...c, x: i * 300, y: 0 })),
      edges: graph.edges,
    };
    const { edges } = fromElkRenderLayout(laid, input);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.markerEnd).toEqual({ type: "arrowclosed" });
    expect(edges[0]?.sourceHandle).toBe("out:x");
    expect(edges[0]?.targetHandle).toBe("in:x");
  });
});
