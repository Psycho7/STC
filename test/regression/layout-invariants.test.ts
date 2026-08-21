// Regression smoke tests for the canvas render-pipeline layout invariants.
// Locks in the load-bearing ELK options so future refactors that drop them
// will fail loudly:
//   - elk.layout() runs exactly once per top-level layout cycle.
//   - hierarchyHandling = INCLUDE_CHILDREN on the root.
//   - recipe and loop render-unit kinds get non-default, non-zero dimensions.
//   - every ELK port has PORT_WIDTH x PORT_HEIGHT (non-zero).
//   - React Flow edges carry markerEnd = ArrowClosed.

import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import ELK from "elkjs/lib/elk.bundled.js";
import { MarkerType } from "@xyflow/react";
import type { Recipe } from "@aef/schema";

import {
  renderPlanToElkGraph,
  layoutRenderPlan,
  ROOT_LAYOUT_OPTIONS,
  type LayoutInput,
} from "../../src/canvas/layout";
import {
  BETWEEN_LAYERS_SPACING,
  NODE_NODE_SPACING,
  PORT_HEIGHT,
  PORT_WIDTH,
  loopBoxDimensions,
} from "../../src/canvas/dimensions";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type {
  RenderEdge,
  RenderPlan,
  RenderUnitLoop,
  RenderUnitRecipe,
} from "../../src/pipeline/types";

const recipeR: Recipe = {
  id: "r:r",
  name: "r:r",
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: [{ item: "i1", qty: 1 }],
  out: [{ item: "o1", qty: 1 }],
  producers: [],
};
const recipeS: Recipe = {
  id: "r:s",
  name: "r:s",
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: [{ item: "o1", qty: 1 }],
  out: [{ item: "o2", qty: 1 }],
  producers: [],
};

const recipeUnit: RenderUnitRecipe = {
  id: "u:recipe",
  kind: "recipe",
  recipeId: "r:r",
  count: 1,
  multiplicity: { num: "1", denom: "1" },
};
const recipeUnit2: RenderUnitRecipe = {
  id: "u:recipe2",
  kind: "recipe",
  recipeId: "r:s",
  count: 1,
  multiplicity: { num: "1", denom: "1" },
};
const loopUnit: RenderUnitLoop = {
  id: "u:loop",
  kind: "loop",
  sccId: "scc:1",
  count: 1,
  netIO: [
    { item: "water", direction: "in", rate: new Fraction(1) },
    { item: "steam", direction: "out", rate: new Fraction(1) },
  ],
};

const planEdge = (from: string, to: string, item: string): RenderEdge => ({
  fromUnit: from,
  toUnit: to,
  item,
  rate: new Fraction(1),
  transportKind: "belt",
});

const buildInput = (): LayoutInput => {
  const plan: RenderPlan = {
    units: [recipeUnit, recipeUnit2, loopUnit],
    edges: [planEdge("u:recipe", "u:recipe2", "o1")],
    containers: [],
  };
  return {
    plan,
    recipeById: new Map([
      ["r:r", recipeR],
      ["r:s", recipeS],
    ]),
    itemById: new Map(),
    interiorByLoopId: new Map([["scc:1", { width: 320, height: 240 }]]),
  };
};

// Same plan, but with both recipe units parked inside one loop-box container so
// the graph carries a container child with its own layoutOptions.
const CONTAINER_ID = "c:loop";
const buildContainerInput = (): LayoutInput => {
  const input = buildInput();
  const plan: RenderPlan = {
    units: [
      { ...recipeUnit, containerId: CONTAINER_ID },
      { ...recipeUnit2, containerId: CONTAINER_ID },
      loopUnit,
    ],
    edges: [planEdge("u:recipe", "u:recipe2", "o1")],
    containers: [
      {
        kind: "loop-box",
        id: CONTAINER_ID,
        members: ["u:recipe", "u:recipe2"],
        sccId: "scc:1",
      },
    ],
  };
  return { ...input, plan };
};

describe("layout-invariants: root layout options", () => {
  it("root id is 'root'", () => {
    const g = renderPlanToElkGraph(buildInput());
    expect(g.id).toBe("root");
  });

  it("hierarchyHandling = INCLUDE_CHILDREN", () => {
    const g = renderPlanToElkGraph(buildInput());
    expect(g.layoutOptions?.["org.eclipse.elk.hierarchyHandling"]).toBe(
      "INCLUDE_CHILDREN",
    );
    expect(ROOT_LAYOUT_OPTIONS["org.eclipse.elk.hierarchyHandling"]).toBe(
      "INCLUDE_CHILDREN",
    );
  });

  it("algorithm = layered, edgeRouting = ORTHOGONAL", () => {
    const g = renderPlanToElkGraph(buildInput());
    expect(g.layoutOptions?.["elk.algorithm"]).toBe("layered");
    expect(g.layoutOptions?.["elk.edgeRouting"]).toBe("ORTHOGONAL");
  });

  it("spacing constants are surfaced from dimensions.ts", () => {
    const g = renderPlanToElkGraph(buildInput());
    expect(g.layoutOptions?.["elk.spacing.nodeNode"]).toBe(
      String(NODE_NODE_SPACING),
    );
    expect(g.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"]).toBe(
      String(BETWEEN_LAYERS_SPACING),
    );
  });

  it("container spacing mirrors the root spacing pair", () => {
    // A slab interior does not inherit the root spacing options, so the two
    // strings are set a second time on every container. If they drift apart,
    // slab members pack at ELK's default spacing and the corridor stops being
    // wide enough for a rate chip. Pin both sides against the same constants.
    const g = renderPlanToElkGraph(buildContainerInput());
    const container = g.children.find((c) => c.id === CONTAINER_ID);
    expect(container?.children?.length).toBe(2);
    expect(container?.layoutOptions?.["elk.spacing.nodeNode"]).toBe(
      String(NODE_NODE_SPACING),
    );
    expect(
      container?.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"],
    ).toBe(String(BETWEEN_LAYERS_SPACING));
    expect(container?.layoutOptions?.["elk.spacing.nodeNode"]).toBe(
      g.layoutOptions?.["elk.spacing.nodeNode"],
    );
    expect(
      container?.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"],
    ).toBe(g.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"]);
  });

  it("cycleBreaking strategy = DEPTH_FIRST", () => {
    const g = renderPlanToElkGraph(buildInput());
    expect(g.layoutOptions?.["elk.layered.cycleBreaking.strategy"]).toBe(
      "DEPTH_FIRST",
    );
    expect(ROOT_LAYOUT_OPTIONS["elk.layered.cycleBreaking.strategy"]).toBe(
      "DEPTH_FIRST",
    );
  });
});

describe("layout-invariants: pinned unit dimensions", () => {
  it("recipe unit dimensions come from measureRecipe", () => {
    const g = renderPlanToElkGraph(buildInput());
    const node = g.children.find((c) => c.id === "u:recipe");
    const geom = measureRecipe(recipeR);
    expect(node?.width).toBe(geom.width);
    expect(node?.height).toBe(geom.height);
    expect(node?.width).toBeGreaterThan(16);
    expect(node?.height).toBeGreaterThan(16);
  });

  it("loop unit -> loopBoxDimensions(interior)", () => {
    const g = renderPlanToElkGraph(buildInput());
    const node = g.children.find((c) => c.id === "u:loop");
    const expected = loopBoxDimensions({ width: 320, height: 240 });
    expect(node?.width).toBe(expected.width);
    expect(node?.height).toBe(expected.height);
    expect(node?.width).toBeGreaterThan(16);
    expect(node?.height).toBeGreaterThan(16);
  });
});

describe("layout-invariants: ports", () => {
  it("every port across every unit kind has PORT_WIDTH x PORT_HEIGHT", () => {
    const g = renderPlanToElkGraph(buildInput());
    let portCount = 0;
    for (const node of g.children) {
      for (const p of node.ports ?? []) {
        expect(p.width).toBe(PORT_WIDTH);
        expect(p.height).toBe(PORT_HEIGHT);
        expect(p.width).toBeGreaterThan(0);
        expect(p.height).toBeGreaterThan(0);
        portCount += 1;
      }
    }
    // recipe + recipe2: 1 in + 1 out each, loop: 1 in + 1 out ==> 6 total.
    expect(portCount).toBe(6);
  });

  it("every unit uses FIXED_SIDE portConstraints", () => {
    // FIXED_SIDE keeps inputs on the WEST side and outputs on the EAST side
    // while letting ELK order the ports within each side to minimize crossings.
    // The per-side order is read back after layout as inputOrder / outputOrder.
    const g = renderPlanToElkGraph(buildInput());
    for (const node of g.children) {
      expect(node.layoutOptions?.["org.eclipse.elk.portConstraints"]).toBe(
        "FIXED_SIDE",
      );
    }
  });
});

describe("layout-invariants: single elk.layout() call per cycle", () => {
  it("layoutRenderPlan triggers exactly one elk.layout() on a flat plan", async () => {
    const spy = vi.spyOn(ELK.prototype, "layout");
    try {
      await layoutRenderPlan(buildInput());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("layout-invariants: edge marker", () => {
  it("layoutRenderPlan attaches markerEnd ArrowClosed to every edge", async () => {
    const result = await layoutRenderPlan(buildInput());
    expect(result.edges.length).toBeGreaterThan(0);
    for (const e of result.edges) {
      expect(e.markerEnd).toEqual({ type: MarkerType.ArrowClosed });
    }
  });
});
