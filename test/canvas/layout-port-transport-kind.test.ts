import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Item, Recipe } from "@aef/schema";

import {
  fromElkRenderLayout,
  renderPlanToElkGraph,
  type ElkGraph,
  type LayoutInput,
} from "../../src/canvas/layout";
import type {
  RenderEdge,
  RenderPlan,
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

const mkItem = (id: string, transportKind: string): Item => ({
  id,
  name: id,
  category: "cat",
  icon: "ico",
  row: 0,
  raw: false,
  transportKind,
});

const mkUnit = (id: string, recipeId: string): RenderUnitRecipe => ({
  id,
  kind: "recipe",
  recipeId,
  count: 1,
  multiplicity: { num: "1", denom: "1" },
});

const mkEdge = (
  fromUnit: string,
  toUnit: string,
  item: string,
  transportKind: string,
): RenderEdge => ({
  fromUnit,
  toUnit,
  item,
  rate: new Fraction(1),
  transportKind,
});

describe("layout / per-port transportKind stamping", () => {
  it("attaches transportKind to each ELK port resolved via itemById", () => {
    const recipe = mkRecipe("r:mix", ["copper_nugget", "water"], ["alloy"]);
    const itemById = new Map<string, Item>([
      ["copper_nugget", mkItem("copper_nugget", "belt")],
      ["water", mkItem("water", "pipe")],
      ["alloy", mkItem("alloy", "belt")],
    ]);
    const plan: RenderPlan = {
      units: [mkUnit("u:mix", "r:mix")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:mix", recipe]]),
      itemById,
    });
    const node = graph.children.find((c) => c.id === "u:mix");
    expect(node).toBeDefined();
    const portKinds = new Map(
      (node?.ports ?? []).map((p) => [
        p.id,
        (p as { transportKind?: string }).transportKind,
      ]),
    );
    expect(portKinds.get("u:mix.in:copper_nugget")).toBe("belt");
    expect(portKinds.get("u:mix.in:water")).toBe("pipe");
    expect(portKinds.get("u:mix.out:alloy")).toBe("belt");
  });

  it("omits transportKind on ports whose item is not in itemById", () => {
    const recipe = mkRecipe("r:a", ["unknown"], []);
    const plan: RenderPlan = {
      units: [mkUnit("u:a", "r:a")],
      edges: [],
      containers: [],
    };
    const graph = renderPlanToElkGraph({
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById: new Map(),
    });
    const node = graph.children.find((c) => c.id === "u:a");
    const port = (node?.ports ?? []).find((p) => p.id === "u:a.in:unknown");
    expect(
      (port as { transportKind?: string } | undefined)?.transportKind,
    ).toBeUndefined();
  });

  it("threads transportKind from ELK ports into RFNode portTransportKinds (keyed by handle id)", () => {
    const recipe = mkRecipe("r:mix", ["copper_nugget", "water"], ["alloy"]);
    const itemById = new Map<string, Item>([
      ["copper_nugget", mkItem("copper_nugget", "belt")],
      ["water", mkItem("water", "pipe")],
      ["alloy", mkItem("alloy", "belt")],
    ]);
    const plan: RenderPlan = {
      units: [mkUnit("u:mix", "r:mix")],
      edges: [],
      containers: [],
    };
    const input: LayoutInput = {
      plan,
      recipeById: new Map([["r:mix", recipe]]),
      itemById,
    };
    const graph = renderPlanToElkGraph(input);
    // Synthetic laid result: ELK preserves ports/children verbatim.
    const laid: ElkGraph = {
      ...graph,
      children: graph.children.map((c) => ({ ...c, x: 0, y: 0 })),
      edges: graph.edges,
    };
    const { nodes } = fromElkRenderLayout(laid, input);
    const mix = nodes.find((n) => n.id === "u:mix");
    expect(mix).toBeDefined();
    const kinds = (
      mix as { data: { portTransportKinds?: ReadonlyMap<string, string> } }
    ).data.portTransportKinds;
    expect(kinds?.get("in:copper_nugget")).toBe("belt");
    expect(kinds?.get("in:water")).toBe("pipe");
    expect(kinds?.get("out:alloy")).toBe("belt");
  });

  it("threads RenderEdge.transportKind into the RF edge data", () => {
    const recipe = mkRecipe("r:a", ["x"], ["x"]);
    const itemById = new Map<string, Item>([["x", mkItem("x", "pipe")]]);
    const plan: RenderPlan = {
      units: [mkUnit("u:a", "r:a"), mkUnit("u:b", "r:a")],
      edges: [mkEdge("u:a", "u:b", "x", "pipe")],
      containers: [],
    };
    const input: LayoutInput = {
      plan,
      recipeById: new Map([["r:a", recipe]]),
      itemById,
    };
    const graph = renderPlanToElkGraph(input);
    const laid: ElkGraph = {
      ...graph,
      children: graph.children.map((c, i) => ({ ...c, x: i * 300, y: 0 })),
      edges: graph.edges,
    };
    const { edges } = fromElkRenderLayout(laid, input);
    expect(edges).toHaveLength(1);
    const data = edges[0]?.data as { transportKind?: string } | undefined;
    expect(data?.transportKind).toBe("pipe");
  });
});
