// Bus classification + lane assignment pass. Exercises routeBusEdges on
// synthetic laid-out node/edge fixtures: short edges pass through untouched,
// long edges become bus members with a lane below every node, trunks of the
// same (item, source) share a lane, different items land on 28px-apart lanes in
// item-sorted order, and the whole pass is deterministic.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  assignBendColumns,
  BUS_SPAN_THRESHOLD,
  LANE_TOP_OFFSET,
  LANE_SPACING,
} from "../../src/canvas/busRouting";
import { PORT_STUB, CHAMFER } from "../../src/canvas/edgePath";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type {
  RFAnyNode,
  RFProductNode,
  RFRecipeNode,
} from "../../src/canvas/layout";

const emptyPorts = new Map<string, never>();

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

const recipeNode = (
  id: string,
  x: number,
  y: number,
  recipe: Recipe,
): RFRecipeNode => ({
  id,
  type: "recipe",
  position: { x, y },
  data: {
    recipe,
    kind: "recipe",
    portTransportKinds: emptyPorts,
    multiplicity: { num: "1", denom: "1" },
  },
});

const inputProductNode = (
  id: string,
  itemId: string,
  x: number,
  y: number,
  width = 148,
  height = 78,
): RFProductNode => ({
  id,
  type: "product",
  position: { x, y },
  width,
  height,
  data: {
    kind: "inputProduct",
    itemId,
    rate: { num: "1", denom: "1" },
    portTransportKinds: emptyPorts,
  },
});

const mkEdge = (
  id: string,
  source: string,
  target: string,
  item: string,
): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item, rate: new Fraction(1) },
});

// Bottom of every node in a fixture, mirroring the module's own metric so the
// "lane below every node" assertions are grounded in the same geometry.
const maxBottom = (nodes: RFAnyNode[]): number =>
  Math.max(
    ...nodes.map((n) => {
      const h =
        n.type === "recipe" ? measureRecipe(n.data.recipe).height : (n.height ?? 0);
      return n.position.y + h;
    }),
  );

describe("routeBusEdges", () => {
  it("leaves a short edge untouched", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 400, 0, r), // gap 400 - 300 = 100 < 820
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(edges[0]); // same reference, no bus fields
    expect(out[0]!.type).toBe("item");
    expect(out[0]!.data).not.toHaveProperty("laneY");
  });

  it("retypes a long edge to bus with a lane below every node", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 0 + 300 + (BUS_SPAN_THRESHOLD + 50), 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    const data = out[0]!.data as { laneY: number; trunkKey: string };
    expect(data.trunkKey).toBe("b|s");
    // First (only) slot: bandTop with slot 0.
    expect(data.laneY).toBe(maxBottom(nodes) + LANE_TOP_OFFSET);
    // Strictly below every node's bottom.
    for (const n of nodes) {
      const h = measureRecipe(r).height;
      expect(data.laneY).toBeGreaterThan(n.position.y + h);
    }
    // Existing data preserved.
    expect(data).toHaveProperty("item", "b");
  });

  it("shares one trunkKey and laneY across long edges of the same item+source", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 300, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
    ];

    const out = routeBusEdges(nodes, edges);

    const d0 = out[0]!.data as { laneY: number; trunkKey: string };
    const d1 = out[1]!.data as { laneY: number; trunkKey: string };
    expect(d0.trunkKey).toBe("b|s");
    expect(d1.trunkKey).toBe("b|s");
    expect(d0.laneY).toBe(d1.laneY);
  });

  it("puts different items on lanes 28px apart in item-sorted order", () => {
    const rApple = mkRecipe("rApple", ["x"], ["apple"]);
    const rBanana = mkRecipe("rBanana", ["x"], ["banana"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    // Declare the banana source first to prove ordering is by item, not input.
    const nodes: RFAnyNode[] = [
      recipeNode("sBanana", 0, 0, rBanana),
      recipeNode("tBanana", far, 0, rBanana),
      recipeNode("sApple", 0, 400, rApple),
      recipeNode("tApple", far, 400, rApple),
    ];
    const edges = [
      mkEdge("e0", "sBanana", "tBanana", "banana"),
      mkEdge("e1", "sApple", "tApple", "apple"),
    ];

    const out = routeBusEdges(nodes, edges);

    const byId = new Map(out.map((e) => [e.id, e.data as { laneY: number; trunkKey: string }]));
    const apple = byId.get("e1")!;
    const banana = byId.get("e0")!;
    // apple sorts before banana -> slot 0, banana slot 1.
    expect(banana.laneY - apple.laneY).toBe(LANE_SPACING);
    const bandTop = maxBottom(nodes) + LANE_TOP_OFFSET;
    expect(apple.laneY).toBe(bandTop);
    expect(banana.laneY).toBe(bandTop + LANE_SPACING);
  });

  it("classifies an input-product -> input-product feeder as bus even when short", () => {
    // Aggregate and tap sit one next to the other (span well under threshold).
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0), // gap 200 - 148 = 52 < 820
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    const data = out[0]!.data as { trunkKey: string };
    expect(data.trunkKey).toBe("ore|agg");
  });

  it("is deterministic: same input twice yields identical output", () => {
    const rApple = mkRecipe("rApple", ["x"], ["apple"]);
    const rBanana = mkRecipe("rBanana", ["x"], ["banana"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("sBanana", 0, 0, rBanana),
      recipeNode("tBanana", far, 0, rBanana),
      recipeNode("sApple", 0, 400, rApple),
      recipeNode("tApple", far, 400, rApple),
    ];
    const edges = [
      mkEdge("e0", "sBanana", "tBanana", "banana"),
      mkEdge("e1", "sApple", "tApple", "apple"),
    ];

    // Project to the deterministic bus fields (the rate Fraction carries a
    // BigInt that JSON can't serialize, and is irrelevant to routing).
    const project = (out: Edge[]) =>
      out.map((e) => {
        const d = e.data as { laneY?: number; trunkKey?: string };
        return { id: e.id, type: e.type, laneY: d.laneY, trunkKey: d.trunkKey };
      });

    expect(project(routeBusEdges(nodes, edges))).toEqual(
      project(routeBusEdges(nodes, edges)),
    );
  });
});

function bendOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { bendX?: number }
    | undefined;
  return d?.bendX;
}

describe("assignBendColumns", () => {
  it("fans bend columns across the shared corridor for a same-source group", () => {
    // Source right edge at x = 0 + 300 = 300; targets at x = 500 (left edge),
    // so the corridor is [300, 500], usable = 200 - 2*(24+8) = 136.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = assignBendColumns(nodes, edges);
    const b0 = bendOf(out, "e0")!;
    const b1 = bendOf(out, "e1")!;
    const margin = PORT_STUB + CHAMFER;
    // Both inside the corridor margins.
    for (const b of [b0, b1]) {
      expect(b).toBeGreaterThan(300 + margin);
      expect(b).toBeLessThan(500 - margin);
    }
    // Distinct, evenly pitched slots: e0 sorts first (slot 1), e1 second.
    expect(b0).toBeLessThan(b1);
    const pitch = (200 - 2 * margin) / 3;
    expect(b0).toBeCloseTo(300 + margin + pitch, 6);
    expect(b1).toBeCloseTo(300 + margin + 2 * pitch, 6);
  });

  it("is deterministic across shuffled input order", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 200, r),
      recipeNode("t3", 500, 400, r),
    ];
    const ordered = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    const a = assignBendColumns(nodes, ordered);
    const b = assignBendColumns(nodes, shuffled);
    for (const id of ["e0", "e1", "e2"]) {
      expect(bendOf(a, id)).toBe(bendOf(b, id));
    }
  });

  it("leaves bus and backward edges untouched", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 500, 0, r),
      recipeNode("back", 0, 200, r), // target left of source -> backward
    ];
    const busEdge: Edge = { ...mkEdge("bus0", "s", "t", "b"), type: "bus" };
    const backwardEdge = mkEdge("bwd0", "t", "back", "b"); // t right of back
    const out = assignBendColumns(nodes, [busEdge, backwardEdge]);
    expect(bendOf(out, "bus0")).toBeUndefined();
    expect(bendOf(out, "bwd0")).toBeUndefined();
    // Untouched edges pass through by reference.
    expect(out[0]).toBe(busEdge);
    expect(out[1]).toBe(backwardEdge);
  });
});
