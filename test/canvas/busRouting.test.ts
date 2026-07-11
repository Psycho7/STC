// Bus classification + lane assignment pass. Exercises routeBusEdges on
// synthetic laid-out node/edge fixtures: short edges pass through untouched,
// long edges become bus members with a lane below every node, trunks of the
// same (item, source) share a lane, different items land on LANE_SPACING-apart
// lanes in item-sorted order, and the whole pass is deterministic.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearBusColumns,
  clearColumnX,
  jogForwardLegs,
  deconflictChipAnchors,
  entryGutterRects,
  paddedObstacles,
  gutterWidth,
  ENTRY_SLOT_PITCH,
  ENTRY_CHIP_MIN_GAP,
  BUS_SPAN_THRESHOLD,
  LANE_TOP_OFFSET,
  LANE_SPACING,
} from "../../src/canvas/busRouting";
import {
  CHIP_BOX_HEIGHT,
  ENTRY_CHIP_BOX_WIDTH,
  ENTRY_CHIP_OFFSET,
  MAX_CHIP_SCALE,
} from "../../src/canvas/dimensions";
import {
  PORT_STUB,
  CHAMFER,
  chamferStepPath,
  routingHintsFromData,
  type ObstacleRect,
} from "../../src/canvas/edgePath";
import { parsePoints, type Point } from "./pathAssertions";
import { entryChipAnchor } from "../../src/canvas/ItemEdge";
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

describe("chip stack pitch", () => {
  it("couples the entry pitch to max counter-scale times true chip height", () => {
    expect(ENTRY_CHIP_MIN_GAP).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(ENTRY_CHIP_MIN_GAP).toBe(48);
  });

  it("couples the lane pitch to the same max-scale chip box height", () => {
    // Adjacent lanes carry rise chips a max-scale box height apart, so their
    // boxes abut instead of interpenetrating at the fit-zoom floor.
    expect(LANE_SPACING).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(LANE_SPACING).toBe(48);
  });
});

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
      // A card straddling the direct corridor at the target row, so the lone
      // member is NOT demoted to a plain item edge (Task 12) and stays on a lane.
      recipeNode("mid", 600, 200, r),
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

  it("puts different items on lanes LANE_SPACING apart in item-sorted order", () => {
    const rApple = mkRecipe("rApple", ["x"], ["apple"]);
    const rBanana = mkRecipe("rBanana", ["x"], ["banana"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    // Declare the banana source first to prove ordering is by item, not input.
    // Each lone member's corridor is blocked at its own target row so both stay
    // bus members (Task 12) instead of demoting to plain item edges.
    const nodes: RFAnyNode[] = [
      recipeNode("sBanana", 0, 0, rBanana),
      recipeNode("tBanana", far, 0, rBanana),
      recipeNode("midBanana", 600, 0, rBanana),
      recipeNode("sApple", 0, 400, rApple),
      recipeNode("tApple", far, 400, rApple),
      recipeNode("midApple", 600, 400, rApple),
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
    // Corridor blockers keep both lone members on the bus (Task 12) so this
    // exercises deterministic lane assignment, not the demotion path.
    const nodes: RFAnyNode[] = [
      recipeNode("sBanana", 0, 0, rBanana),
      recipeNode("tBanana", far, 0, rBanana),
      recipeNode("midBanana", 600, 0, rBanana),
      recipeNode("sApple", 0, 400, rApple),
      recipeNode("tApple", far, 400, rApple),
      recipeNode("midApple", 600, 400, rApple),
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

describe("routeBusEdges single-member demotion (9C)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);

  it("demotes a lone clear-corridor forward trunk to a plain item edge", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    // Stays type "item", passes through by reference, and carries no bus
    // scaffolding: no lane, no trunk key, no rise-chip slot leaked on.
    expect(out[0]!.type).toBe("item");
    expect(out[0]).toBe(edges[0]);
    expect(out[0]!.data).not.toHaveProperty("laneY");
    expect(out[0]!.data).not.toHaveProperty("trunkKey");
    expect(out[0]!.data).not.toHaveProperty("busChipX");
    expect(out[0]!.data).not.toHaveProperty("busTotalRate");
  });

  it("keeps a lone member on the bus when a card blocks its corridor", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      // Straddles the direct corridor at the target row.
      recipeNode("mid", 600, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBe("b|s");
  });

  it("leaves a two-member trunk on the bus even when both corridors are clear", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 400, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
    ];

    const out = routeBusEdges(nodes, edges);

    // Same trunk (two members), so demotion never applies: both ride the lane.
    expect(out[0]!.type).toBe("bus");
    expect(out[1]!.type).toBe("bus");
  });

  it("leaves a lone bothInput feeder on the bus regardless of its corridor", () => {
    // A long aggregate -> tap feeder: a single-member trunk whose corridor is
    // clear, yet excluded from demotion because bothInput trunks ride the bus to
    // cross the whole graph, not for span.
    const bothFar = 148 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", bothFar, 0),
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBe("ore|agg");
  });

  it("demotes deterministically across two identical runs", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges(nodes, edges);
    expect(a[0]!.type).toBe("item");
    expect(a[0]!.type).toBe(b[0]!.type);
  });

  it("routes a demoted member through the whole pipeline as a plain item edge", () => {
    // End to end: a demoted single-member trunk must flow through every
    // downstream pass as an item edge -- picking up bend-column treatment and no
    // bus fields -- exactly like any other forward item edge.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 100, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = deconflictChipAnchors(
      nodes,
      clampBackwardRails(
        nodes,
        jogForwardLegs(
          nodes,
          assignBendColumns(
            nodes,
            clearBusColumns(
              nodes,
              assignEntryColumns(nodes, routeBusEdges(nodes, edges)),
            ),
          ),
        ),
      ),
    );

    const e = out[0]!;
    expect(e.type).toBe("item");
    expect(e.data).not.toHaveProperty("laneY");
    expect(e.data).not.toHaveProperty("busChipX");
    // Got bend-column staggering as a plain forward item edge.
    expect(e.data).toHaveProperty("bendX");
  });
});

function busChipXOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipX?: number }
    | undefined;
  return d?.busChipX;
}

describe("routeBusEdges trunk rise-chip slots", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);
  const buildThreeMember = (): { nodes: RFAnyNode[]; edges: Edge[] } => ({
    nodes: [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 300, r),
      recipeNode("t3", far, 600, r),
    ],
    edges: [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ],
  });

  it("distributes three members' rise chips across distinct, evenly spaced lane slots", () => {
    const { nodes, edges } = buildThreeMember();
    const out = routeBusEdges(nodes, edges);
    const x0 = busChipXOf(out, "e0")!;
    const x1 = busChipXOf(out, "e1")!;
    const x2 = busChipXOf(out, "e2")!;
    // Lane extent runs from the drop column (sourceRight 300 + stub + chamfer) to
    // the members' shared rise column (targetLeft - stub - chamfer). With n = 3
    // members the extent splits into n + 1 = 4 equal gaps and each slot sits at
    // (i + 1)/4 of it, ordered by edge id.
    const dropX = 300 + PORT_STUB + CHAMFER;
    const maxRiseX = far - PORT_STUB - CHAMFER;
    const step = (maxRiseX - dropX) / 4;
    expect(x0).toBeCloseTo(dropX + step, 6);
    expect(x1).toBeCloseTo(dropX + 2 * step, 6);
    expect(x2).toBeCloseTo(dropX + 3 * step, 6);
    // Distinct, evenly spaced, and strictly inside the extent so no rise chip
    // ever lands on the aggregate drop chip at dropX.
    expect(new Set([x0, x1, x2]).size).toBe(3);
    expect(x1 - x0).toBeCloseTo(x2 - x1, 6);
    for (const x of [x0, x1, x2]) {
      expect(x).toBeGreaterThan(dropX);
      expect(x).toBeLessThan(maxRiseX);
    }
  });

  it("assigns slots deterministically across two identical runs", () => {
    const { nodes, edges } = buildThreeMember();
    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipXOf(a, id)).toBe(busChipXOf(b, id));
    }
  });

  it("keeps the trunk aggregate on the owner while distributing rise slots", () => {
    const { nodes, edges } = buildThreeMember();
    const out = routeBusEdges(nodes, edges);
    // Owner election and totals are untouched by the slot pass.
    const owners = out.filter(
      (e) => (e.data as { busChipOwner?: boolean }).busChipOwner,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]!.id).toBe("e0");
    const d = owners[0]!.data as {
      busTotalRate?: Fraction;
      busMemberCount?: number;
    };
    expect(d.busTotalRate!.equals(new Fraction(3))).toBe(true);
    expect(d.busMemberCount).toBe(3);
    // Every member still carries its own slot.
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipXOf(out, id)).toBeGreaterThan(0);
    }
  });

  it("stacks rise slots at the drop column when the lane extent is too short", () => {
    // Two input-product feeders sit almost adjacent, so the rise column lands at
    // or left of the drop column and the extent is non-positive. The step
    // collapses to 0 so every member's rise slot falls on the drop column;
    // deconflictChipAnchors then cascades the coincident pile downward off the
    // lane rather than spreading it horizontally past the rise column.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0), // right edge 148
      inputProductNode("t1", "ore", 200, 0), // bothInput feeder -> bus
      inputProductNode("t2", "ore", 200, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = routeBusEdges(nodes, edges);
    const dropX = 148 + PORT_STUB + CHAMFER; // 180
    expect(busChipXOf(out, "e0")).toBeCloseTo(dropX, 6);
    expect(busChipXOf(out, "e1")).toBeCloseTo(dropX, 6);
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

  it("bands mixed-width sources of one layer together (finding 2)", () => {
    // A product source (width 148 -> right 148) and a recipe source (width 300
    // -> right 300) share the same source layer (left x = 0) and both feed the
    // next layer at x = 500. Banding by source LEFT (not source right) puts them
    // in ONE band so they fan against each other and land on DISTINCT columns
    // inside the shared first gap [300, 500]; the old source-right banding split
    // them into independent bands that could pick coincident columns.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      inputProductNode("sp", "b", 0, 0), // right 0 + 148 = 148
      recipeNode("sr", 0, 300, r), //         right 0 + 300 = 300
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 300, r),
    ];
    const edges = [mkEdge("eP", "sp", "t1", "b"), mkEdge("eR", "sr", "t2", "b")];
    const out = assignBendColumns(nodes, edges);
    const bp = bendOf(out, "eP");
    const br = bendOf(out, "eR");
    const margin = PORT_STUB + CHAMFER;
    expect(bp).toBeDefined();
    expect(br).toBeDefined();
    // Corridor is the shared first gap: rightmost source edge (300) to the next
    // node column (500). Both bends sit inside it, and they are distinct.
    for (const b of [bp!, br!]) {
      expect(b).toBeGreaterThan(300 + margin);
      expect(b).toBeLessThan(500 - margin);
    }
    expect(bp).not.toBe(br);
  });

  it("keeps a layer-skipping bend clear of the intermediate node (finding 3)", () => {
    // A forward item edge from layer 0 to layer 2, with a node occupying layer 1
    // between them. Span 820 - 300 = 520 stays <= BUS_SPAN_THRESHOLD so the edge
    // is a plain item edge, not a bus member. Its bend must land in the first gap
    // (before the layer-1 column), never inside the intermediate node box.
    const r = mkRecipe("r", ["a"], ["b"]);
    const midLeft = 410;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r), //          right 300
      recipeNode("mid", midLeft, 0, r), //  layer-1 column at 410
      recipeNode("t", 820, 200, r), //      layer-2 target
    ];
    const span = 820 - 300;
    expect(span).toBeLessThanOrEqual(BUS_SPAN_THRESHOLD);
    const out = assignBendColumns(nodes, [mkEdge("e0", "s", "t", "b")]);
    const b = bendOf(out, "e0");
    expect(b).toBeDefined();
    // Strictly left of the intermediate node's left edge.
    expect(b!).toBeLessThan(midLeft);
  });

  it("assigns bends to every member when one target is adjacent (finding 5)", () => {
    // One band mixing a short-span "adjacent" edge (its target's left edge sits
    // within the band's widest source span, so it is <= groupLeft) with several
    // far-target edges. The corridor is the first NODE-free gap right of the
    // source layer, so the adjacent target no longer collapses the whole band's
    // corridor: every member still receives a distinct bend. The old min-target
    // corridor went to the near target (200), driving usable negative and
    // dropping bends for the whole band, far edges included.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("sR", 0, 0, r), //          width 300 -> right 300 (sets groupLeft)
      inputProductNode("sP", "b", 0, 400), // width 148 -> right 148
      recipeNode("near", 200, 400, r), //     adjacent target, left 200 <= 300
      recipeNode("far1", 1000, 0, r),
      recipeNode("far2", 1000, 400, r),
    ];
    const edges = [
      mkEdge("eFar1", "sR", "far1", "b"),
      mkEdge("eFar2", "sP", "far2", "b"),
      mkEdge("eNear", "sP", "near", "b"),
    ];
    const out = assignBendColumns(nodes, edges);
    const bends = ["eFar1", "eFar2", "eNear"].map((id) => bendOf(out, id));
    for (const b of bends) expect(b).toBeDefined();
    // No whole-band dropout, and all three bends are distinct.
    expect(new Set(bends).size).toBe(3);
  });
});

function entryOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { entryX?: number }
    | undefined;
  return d?.entryX;
}

// A recipe node carrying an explicit resolved input-port order, so the entry
// column ordering (by port index) is exercised against a known top-to-bottom
// port layout instead of the fallback item-id order.
const orderedRecipeNode = (
  id: string,
  x: number,
  y: number,
  ins: string[],
): RFRecipeNode => {
  const base = recipeNode(id, x, y, mkRecipe(id, ins, []));
  return { ...base, data: { ...base.data, inputOrder: ins } };
};

describe("assignEntryColumns", () => {
  it("gives two backward rails into one node distinct, port-ordered columns", () => {
    // M hosts two backward rails (its sources sit to the right, so both edges
    // reverse into M). inputOrder ["p","q"] puts port p on top. The topmost port
    // takes the leftmost column; the bottom port sits at the pre-gutter default
    // (targetLeft - PORT_STUB), so the two rails never overlap.
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("m", 0, 0, ["p", "q"]),
      recipeNode("rp", 500, 0, mkRecipe("rp", [], ["p"])),
      recipeNode("rq", 500, 200, mkRecipe("rq", [], ["q"])),
    ];
    const edges = [mkEdge("eP", "rp", "m", "p"), mkEdge("eQ", "rq", "m", "q")];
    const out = assignEntryColumns(nodes, edges);
    const xP = entryOf(out, "eP");
    const xQ = entryOf(out, "eQ");
    expect(xP).toBeDefined();
    expect(xQ).toBeDefined();
    expect(xP).not.toBe(xQ);
    expect(xQ).toBe(0 - PORT_STUB); // bottom port at the default column
    expect(xP).toBe(0 - PORT_STUB - ENTRY_SLOT_PITCH); // top port one slot left
    expect(xP! < xQ!).toBe(true); // higher port sits further left
  });

  it("gives two bus rises into one node distinct, port-ordered columns", () => {
    // Two wide-forward bus members feed M from the far left, so both rise up M's
    // gutter. They take staggered columns ordered by port index, same as rails.
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("m", 1000, 0, ["p", "q"]),
      recipeNode("sp", 0, 0, mkRecipe("sp", [], ["p"])),
      recipeNode("sq", 0, 200, mkRecipe("sq", [], ["q"])),
    ];
    const busP: Edge = { ...mkEdge("eP", "sp", "m", "p"), type: "bus" };
    const busQ: Edge = { ...mkEdge("eQ", "sq", "m", "q"), type: "bus" };
    const out = assignEntryColumns(nodes, [busP, busQ]);
    const xP = entryOf(out, "eP");
    const xQ = entryOf(out, "eQ");
    expect(xP).toBeDefined();
    expect(xQ).toBeDefined();
    expect(xP).not.toBe(xQ);
    expect(xQ).toBe(1000 - PORT_STUB);
    expect(xP).toBe(1000 - PORT_STUB - ENTRY_SLOT_PITCH);
    expect(xP! < xQ!).toBe(true);
  });

  it("assigns entry columns deterministically across shuffled input order", () => {
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("m", 1000, 0, ["p", "q"]),
      recipeNode("sp", 0, 0, mkRecipe("sp", [], ["p"])),
      recipeNode("sq", 0, 200, mkRecipe("sq", [], ["q"])),
    ];
    const eP: Edge = { ...mkEdge("eP", "sp", "m", "p"), type: "bus" };
    const eQ: Edge = { ...mkEdge("eQ", "sq", "m", "q"), type: "bus" };
    const a = assignEntryColumns(nodes, [eP, eQ]);
    const b = assignEntryColumns(nodes, [eQ, eP]);
    for (const id of ["eP", "eQ"]) {
      expect(entryOf(a, id)).toBe(entryOf(b, id));
    }
  });

  it("keeps forward bend verticals out of an inflated next-column gutter", () => {
    // M sits in the next column and hosts four backward rails, so its entry
    // gutter widens to gutterWidth(4). Four forward edges skip M to layer 2;
    // every one of their bend columns must stay left of M's gutter so no
    // vertical run crosses M's entering rails.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, mkRecipe("s", [], ["b"])), // right edge 300
      orderedRecipeNode("m", 600, 0, ["b", "w", "x", "y", "z"]),
      recipeNode("t1", 1200, 0, mkRecipe("t1", ["b"], [])),
      recipeNode("t2", 1200, 200, mkRecipe("t2", ["b"], [])),
      recipeNode("t3", 1200, 400, mkRecipe("t3", ["b"], [])),
      recipeNode("t4", 1200, 600, mkRecipe("t4", ["b"], [])),
      recipeNode("r1", 1000, 0, mkRecipe("r1", [], ["w"])),
      recipeNode("r2", 1000, 100, mkRecipe("r2", [], ["x"])),
      recipeNode("r3", 1000, 250, mkRecipe("r3", [], ["y"])),
      recipeNode("r4", 1000, 350, mkRecipe("r4", [], ["z"])),
    ];
    const edges = [
      mkEdge("f1", "s", "t1", "b"),
      mkEdge("f2", "s", "t2", "b"),
      mkEdge("f3", "s", "t3", "b"),
      mkEdge("f4", "s", "t4", "b"),
      // Backward rails into M inflate its gutter to gutterWidth(4).
      mkEdge("w", "r1", "m", "w"),
      mkEdge("x", "r2", "m", "x"),
      mkEdge("y", "r3", "m", "y"),
      mkEdge("z", "r4", "m", "z"),
    ];
    const out = assignBendColumns(nodes, edges);
    const rects = entryGutterRects(nodes, edges);
    const mRect = rects.get("m")!;
    expect(mRect.right - mRect.left).toBe(gutterWidth(4));
    for (const id of ["f1", "f2", "f3", "f4"]) {
      const b = bendOf(out, id);
      expect(b).toBeDefined();
      // Strictly left of M's gutter band -> the bend vertical never enters it.
      expect(b! < mRect.left).toBe(true);
    }
  });
});

function labelDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { labelDy?: number }
    | undefined;
  return d?.labelDy ?? 0;
}

function entryDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { entryChipDy?: number }
    | undefined;
  return d?.entryChipDy ?? 0;
}

// A product node with fully specified geometry, so a source/target port y can be
// pinned exactly (product ports sit at the node's vertical center).
const productNode = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): RFProductNode => ({
  id,
  type: "product",
  position: { x, y },
  width,
  height,
  data: {
    kind: "inputProduct",
    itemId: "w",
    rate: { num: "1", denom: "1" },
    portTransportKinds: emptyPorts,
  },
});

function busDropDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { busDropDy?: number }
    | undefined;
  return d?.busDropDy ?? 0;
}

function busChipDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipDy?: number }
    | undefined;
  return d?.busChipDy ?? 0;
}

describe("deconflictChipAnchors: bus lane cascade", () => {
  it("cascades a crowded trunk's rise chips below its lane in pitch steps", () => {
    // Two input-product feeders share one trunk (ore|agg) but sit so close that
    // the lane extent collapses: routeBusEdges stacks both rise slots on the drop
    // column. The owner (e0) keeps its aggregate drop chip on the lane; the rise
    // chips, coincident on that column, cascade straight down a full max-scale
    // pitch apart so no two bus chips overlap on screen.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("t1", "ore", 200, 0),
      inputProductNode("t2", "ore", 200, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    // e0 owns the drop chip, which settles first on the lane and is never pushed.
    expect(busDropDyOf(out, "e0")).toBe(0);
    // The two rise chips pile below it at successive pitch steps, edge-id order.
    expect(busChipDyOf(out, "e0")).toBe(pitch);
    expect(busChipDyOf(out, "e1")).toBe(2 * pitch);
  });

  it("leaves a well-spread trunk's chips on the lane", () => {
    // Three members feeding distinct far layers spread their rise slots evenly
    // across a wide lane extent, so no chip crowds another and none is nudged.
    const r = mkRecipe("r", ["a"], ["b"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far + 4000, 300, r),
      recipeNode("t3", far + 8000, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipDyOf(out, id)).toBe(0);
      expect(busDropDyOf(out, id)).toBe(0);
    }
  });

  it("keeps every trunk's owner drop chip on its junction across trunks", () => {
    // Two trunks off ONE aggregate (items "a" and "b" -> lanes 0 and 1, same
    // drop column), with the "a" trunk's extent collapsed so its rise chips
    // stack on that column and cascade downward -- straight through the "b"
    // trunk's junction one lane below. Seating is two-phase (all drops, then all
    // rises), so trunk b's aggregate drop chip must hold its junction even
    // though trunk a's edges sort first; an id-interleaved seating would let
    // a's cascading rise squat on b's junction and push the aggregate off it.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("t1", "ore", 200, 0),
      inputProductNode("t2", "ore", 200, 200),
      inputProductNode("t3", "ore", 200, 400),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "a"),
      mkEdge("e1", "agg", "t2", "a"),
      mkEdge("e2", "agg", "t3", "b"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    // Both owners' aggregate drop chips stay at their junctions.
    expect(busDropDyOf(out, "e0")).toBe(0);
    expect(busDropDyOf(out, "e2")).toBe(0);
    // The crowded rises all cascaded below the lanes instead.
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipDyOf(out, id)).toBeGreaterThan(0);
    }
  });
});

describe("deconflictChipAnchors: reconstruction tripwires", () => {
  it("reconstructs a backward edge's rail anchor exactly as the render args do", () => {
    // A backward edge (source right of target) carries a threaded railY. The
    // expected midpoint anchor is computed HERE with chamferStepPath on the same
    // args ItemEdge renders with; a forward edge is then laid out so its own
    // straight-line midpoint sits exactly on that anchor. The forward edge (id
    // "a:...") seats first, so the backward chip is nudged one pitch iff the
    // pass reconstructed its anchor at the same spot -- if the reconstruction
    // dropped railY (or mirrored the path builder wrongly) the anchors diverge
    // and no nudge fires. The cheapest render-vs-reconstruction drift detector.
    const railY = 400;
    // Backward pair: source right edge 600, target left edge 0, both port
    // centers at y = 200.
    const bwdSource = productNode("bs", 500, 170, 100, 60);
    const bwdTarget = productNode("bt", 0, 170, 100, 60);
    const [, ex, ey] = chamferStepPath({
      sourceX: 600,
      sourceY: 200,
      targetX: 0,
      targetY: 200,
      railY,
    });
    expect(ey).toBe(railY); // the anchor sits on the threaded rail
    // Forward pair whose straight-line midpoint is exactly (ex, ey).
    const fwdSource = productNode("fs", ex - 150, ey - 30, 100, 60);
    const fwdTarget = productNode("ft", ex + 50, ey - 30, 100, 60);
    const nodes: RFAnyNode[] = [bwdSource, bwdTarget, fwdSource, fwdTarget];
    const edges: Edge[] = [
      {
        id: "a:fwd",
        source: "fs",
        target: "ft",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
      {
        id: "z:bwd",
        source: "bs",
        target: "bt",
        type: "item",
        data: { item: "w", rate: new Fraction(1), railY },
      },
    ];
    const out = deconflictChipAnchors(nodes, edges);
    expect(labelDyOf(out, "a:fwd")).toBe(0); // seated first, unmoved
    // Exactly one pitch: the anchors coincided, and one step clears the pair.
    expect(labelDyOf(out, "z:bwd")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
  });

  it("nudges a midpoint chip off a bus rise chip's box", () => {
    // A bus member's rise chip sits at (busChipX, laneY). A forward item edge's
    // straight-line midpoint lands exactly there; bus chips seat before
    // midpoints, so the midpoint must yield one pitch while the bus chip holds
    // its lane.
    const laneY = 300;
    const busChipX = 500;
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t", 900, 0, 100, 60),
      // Forward pair centered on the bus chip: right edge 400 / left edge 600
      // -> midpoint x 500; port centers at y 300.
      productNode("fs", 300, 270, 100, 60),
      productNode("ft", 600, 270, 100, 60),
    ];
    const edges: Edge[] = [
      {
        id: "bus:0",
        source: "s",
        target: "t",
        type: "bus",
        data: {
          item: "w",
          rate: new Fraction(1),
          laneY,
          trunkKey: "w|s",
          busChipX,
          busChipOwner: false,
        },
      },
      {
        id: "mid:0",
        source: "fs",
        target: "ft",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
    ];
    const out = deconflictChipAnchors(nodes, edges);
    expect(busChipDyOf(out, "bus:0")).toBe(0); // bus chip holds the lane
    expect(labelDyOf(out, "mid:0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
  });
});

describe("deconflictChipAnchors: merged collision set", () => {
  it("nudges a midpoint chip that lands in a target's entry-chip stack clear of every entry box", () => {
    // Target T hosts two same-port entry chips (item "water"), which stack a
    // pitch apart at (Tx - 12, waterY) and (Tx - 12, waterY + 48). A third,
    // non-multiInput forward edge A runs straight into that same port with a
    // 24px gap, so its midpoint lands exactly on the top entry chip. The merged
    // pass must nudge A's midpoint down past BOTH entry boxes.
    const Tx = 600;
    const tRecipe = mkRecipe("t", ["water", "ore"], []);
    const waterY = measureRecipe(tRecipe).inHandleYs[0]!; // T top is 0
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("t", Tx, 0, ["water", "ore"]),
      // Sources for the two entry chips, far to the left (their own midpoint
      // chips land nowhere near the entry stack).
      recipeNode("sb1", -2000, 0, mkRecipe("sb1", [], ["water"])),
      recipeNode("sb2", -2000, 300, mkRecipe("sb2", [], ["water"])),
      // Source for A: a product whose right edge sits one 24px gap before T and
      // whose center is exactly waterY, so a straight-line midpoint lands on the
      // entry chip anchor (Tx - 12, waterY).
      productNode("sa", Tx - 24 - 148, waterY - 30, 148, 60),
    ];
    const edges: Edge[] = [
      {
        id: "e:a",
        source: "sa",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1) },
      },
      {
        id: "e:b1",
        source: "sb1",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
      },
      {
        id: "e:b2",
        source: "sb2",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
      },
    ];

    const out = deconflictChipAnchors(nodes, edges);

    // A's midpoint anchor after the nudge.
    const aDy = labelDyOf(out, "e:a");
    expect(aDy).toBeGreaterThan(0); // it was pushed at all
    const aX = Tx - 12;
    const aY = waterY + aDy;

    // Each entry chip's final box, at its own stacked dy.
    const entryBoxes = [
      entryChipAnchor(Tx, waterY, entryDyOf(out, "e:b1")),
      entryChipAnchor(Tx, waterY, entryDyOf(out, "e:b2")),
    ];
    // No box intersection: the midpoint clears every entry box on at least one
    // axis. X is shared here (both sit at Tx - 12), so the clearance is vertical
    // and must reach a full max-scale box height.
    for (const box of entryBoxes) {
      const clears =
        Math.abs(box.x - aX) >= 60 ||
        Math.abs(box.y - aY) >= MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
      expect(clears).toBe(true);
    }
  });

  it("moves a coincident midpoint chip by at least the max-scale pitch (48)", () => {
    // Two parallel forward edges share one source and one target, so their
    // straight-line midpoints coincide exactly. The second (by edge id) is
    // nudged, and its offset must be at least the chip pitch so the two boxes
    // clear at the fit-zoom counter-scale cap. Pinning the magnitude to the
    // exported product catches a silent decoupling of the nudge step / collision
    // box from the chip dimensions.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 170, 100, 60), // right 100, center 200
      productNode("t", 300, 170, 100, 60), // left 300, center 200
    ];
    const edges: Edge[] = [
      {
        id: "m:1",
        source: "s",
        target: "t",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
      {
        id: "m:2",
        source: "s",
        target: "t",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
    ];

    const out = deconflictChipAnchors(nodes, edges);

    expect(labelDyOf(out, "m:1")).toBe(0); // first placed, unmoved
    expect(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT).toBe(48);
    expect(labelDyOf(out, "m:2")).toBeGreaterThanOrEqual(
      MAX_CHIP_SCALE * CHIP_BOX_HEIGHT,
    );
  });
});

describe("paddedObstacles", () => {
  it("pads card obstacles beyond the node bounds by stub/chip overhang on X and CHAMFER on Y", () => {
    const node = inputProductNode("n", "ore", 100, 50, 148, 78);
    const rects = paddedObstacles([node], []);
    const card = rects.find((r) => r.kind === "card");
    expect(card).toBeDefined();
    const nodeLeft = 100;
    const nodeRight = 100 + 148;
    const nodeTop = 50;
    const nodeBottom = 50 + 78;
    // Left overhang: the wider of the port stub and the entry chip, which renders
    // one ENTRY_CHIP_OFFSET inside the port plus half its max-scale box.
    const leftPad = Math.max(
      PORT_STUB,
      ENTRY_CHIP_OFFSET + (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2,
    );
    expect(nodeLeft - card!.left).toBe(leftPad);
    expect(card!.right - nodeRight).toBe(PORT_STUB); // right: source stub only
    expect(nodeTop - card!.top).toBe(CHAMFER);
    expect(card!.bottom - nodeBottom).toBe(CHAMFER);
    // The entry chip reaches past the bare stub, so the X pad exceeds PORT_STUB.
    expect(leftPad).toBeGreaterThan(PORT_STUB);
    // Each card carries the id of the node it was built from.
    expect(card!.nodeId).toBe("n");
  });

  it("includes each node's entry-gutter rect as a first-class obstacle tagged with its node id", () => {
    // M hosts a backward rail (its source sits to the right), so it owns a gutter
    // column; every node still gets a gutter rect from entryGutterRects. Each
    // gutter obstacle carries the OWNING node's id (M's inflated band must map to
    // "m", not "rp"), which is what lets a consumer exempt an edge's own target
    // gutter while blocking foreign ones.
    const nodes: RFAnyNode[] = [
      recipeNode("m", 0, 0, mkRecipe("m", ["p"], [])),
      recipeNode("rp", 500, 0, mkRecipe("rp", [], ["p"])),
    ];
    const edges = [mkEdge("eP", "rp", "m", "p")];
    const gutter = entryGutterRects(nodes, edges);
    const rects = paddedObstacles(nodes, edges);
    const gutterRects = rects.filter((r) => r.kind === "gutter");
    // One gutter obstacle per node, each carrying its owner's id with the
    // geometry entryGutterRects computed for that same node.
    expect(gutterRects).toHaveLength(nodes.length);
    for (const [nodeId, g] of gutter) {
      expect(gutterRects).toContainEqual({ ...g, kind: "gutter", nodeId });
    }
    expect(new Set(gutterRects.map((r) => r.nodeId))).toEqual(
      new Set(["m", "rp"]),
    );
  });
});

describe("clampBackwardRails overhang clearance", () => {
  it("clears a card whose CHAMFER overhang zone the rail would have grazed", () => {
    // Backward edge src -> tgt (target left of source). A mid card sits between
    // them. The rail's preferred y (70) falls just below the mid card's raw
    // bottom (65) but inside its CHAMFER overhang band [65, 73]. Unpadded
    // obstacles miss it, so the old code left the rail on that grazing y; the
    // padded provider catches the overhang and clears the rail off it.
    const nodes: RFAnyNode[] = [
      inputProductNode("src", "water", 800, 0, 148, 60),
      inputProductNode("tgt", "water", 0, 0, 148, 60),
      inputProductNode("mid", "water", 400, 0, 148, 65),
    ];
    const edges = [mkEdge("e0", "src", "tgt", "water")];
    const out = clampBackwardRails(nodes, edges);
    const railY = (out[0]!.data as { railY?: number }).railY;
    expect(railY).toBeDefined();
    const midBottom = 65;
    // Threaded rail sits clear of the mid card's padded (overhang) extent.
    expect(railY! > midBottom + CHAMFER || railY! < 0 - CHAMFER).toBe(true);
  });
});

// -- clearColumnX -------------------------------------------------------------

const rect = (
  left: number,
  right: number,
  top: number,
  bottom: number,
): ObstacleRect => ({ left, right, top, bottom });

describe("clearColumnX", () => {
  it("returns the desired column when nothing pierces the run's y-span", () => {
    // An obstacle sitting entirely above the run's y-span cannot block it.
    const obstacles = [rect(90, 110, 200, 300)];
    expect(clearColumnX(100, 0, 100, obstacles)).toBe(100);
  });

  it("returns the desired column when no obstacle covers it in x", () => {
    const obstacles = [rect(200, 300, 0, 100)];
    expect(clearColumnX(100, 0, 100, obstacles)).toBe(100);
  });

  it("moves to the nearest clear column when the desired one is blocked", () => {
    // Desired 105 sits inside [90, 110], nearer the right edge; the run overlaps
    // the obstacle's y-span, so the column moves just past the right edge with a
    // CHAMFER of clear air (110 + 8 = 118), which is nearer than the left escape.
    const obstacles = [rect(90, 110, 0, 100)];
    const x = clearColumnX(105, 0, 100, obstacles);
    expect(x).toBe(110 + CHAMFER);
  });

  it("breaks an equidistant tie toward the target side", () => {
    // Symmetric obstacle around the desired column: left and right escapes sit an
    // equal distance away, so the tie-break picks the side toward the target.
    const obstacles = [rect(90, 110, 0, 100)];
    expect(clearColumnX(100, 0, 100, obstacles, { towardTarget: 1 })).toBe(
      110 + CHAMFER,
    );
    expect(clearColumnX(100, 0, 100, obstacles, { towardTarget: -1 })).toBe(
      90 - CHAMFER,
    );
  });

  it("jumps a merged no-go band of two obstacles within 2*gap", () => {
    // Two obstacles closer than 2*CHAMFER form one continuous no-go band: a column
    // landing between them (118 or 104) fails the clear test, so from a desired
    // inside the right obstacle the nearest clear column escapes past the whole
    // band to 130 + 8 = 138 rather than into the sliver between the two.
    const obstacles = [rect(90, 110, 0, 100), rect(112, 130, 0, 100)];
    const x = clearColumnX(125, 0, 100, obstacles, { towardTarget: 1 });
    expect(x).toBe(130 + CHAMFER);
  });

  it("falls back to the desired column when no clear column is within radius", () => {
    // One obstacle wider than 2*radius engulfs both escapes, so neither is
    // reachable; the column degrades back to the desired x rather than flinging
    // across the graph.
    const obstacles = [rect(-10000, 10000, 0, 100)];
    const x = clearColumnX(100, 0, 100, obstacles, { radius: 50 });
    expect(x).toBe(100);
  });

  it("is a deterministic function of the obstacle list, order-independent", () => {
    const obstacles = [
      rect(90, 110, 0, 100),
      rect(200, 260, 0, 100),
      rect(40, 60, 0, 100),
    ];
    const shuffled = [obstacles[2]!, obstacles[0]!, obstacles[1]!];
    expect(clearColumnX(100, 0, 100, obstacles, { towardTarget: 1 })).toBe(
      clearColumnX(100, 0, 100, shuffled, { towardTarget: 1 }),
    );
  });
});

// -- clearBusColumns ----------------------------------------------------------

function dropXOf(edges: Edge[], id: string): number | undefined {
  return (edges.find((e) => e.id === id)?.data as { dropX?: number } | undefined)
    ?.dropX;
}
function riseXOf(edges: Edge[], id: string): number | undefined {
  return (edges.find((e) => e.id === id)?.data as { riseX?: number } | undefined)
    ?.riseX;
}

describe("clearBusColumns", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50); // 1170

  it("leaves a bus with no foreign geometry untouched (own card/gutter exempt)", () => {
    // A lone wide-forward bus: its drop sits a chamfer off its own source card and
    // its rise sits inside its own target card / gutter. Both are exempt, so with
    // no foreign obstacle in the way neither column is stamped.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
    ];
    const out = clearBusColumns(nodes, routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]));
    expect(dropXOf(out, "e0")).toBeUndefined();
    expect(riseXOf(out, "e0")).toBeUndefined();
  });

  it("stamps a cleared riseX when the default rise column pierces a foreign card", () => {
    // A foreign product sits below the target row, straddling the default rise
    // column (tx - PORT_STUB - CHAMFER = 1138). The rise vertical climbs from the
    // lane to the target port through it, so clearBusColumns moves the rise column
    // off the foreign card.
    const blockLeft = 1070;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      inputProductNode("block", "ore", blockLeft, 300, 148, 78),
      // A target-row card mid-corridor (clear of the drop / rise columns) keeps
      // the lone member on the bus (Task 12) so the rise-clearance path runs.
      recipeNode("corridor", 550, 0, r),
    ];
    const out = clearBusColumns(nodes, routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]));
    const riseX = riseXOf(out, "e0");
    expect(riseX).toBeDefined();
    expect(riseX).not.toBe(1138);
    // Cleared off the foreign card's raw x-extent [1070, 1218].
    expect(riseX! < blockLeft || riseX! > blockLeft + 148).toBe(true);
  });

  it("stamps a cleared dropX when the default drop column pierces a foreign card", () => {
    // A foreign product straddles the default drop column (sx + PORT_STUB +
    // CHAMFER = 332) in an intermediate row, so the drop vertical is moved off it.
    const blockLeft = 250;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      inputProductNode("block", "ore", blockLeft, 300, 148, 78),
      // A target-row card mid-corridor (clear of the drop / rise columns) keeps
      // the lone member on the bus (Task 12) so the drop-clearance path runs.
      recipeNode("corridor", 550, 0, r),
    ];
    const out = clearBusColumns(nodes, routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]));
    const dropX = dropXOf(out, "e0");
    expect(dropX).toBeDefined();
    expect(dropX).not.toBe(332);
    expect(dropX! < blockLeft || dropX! > blockLeft + 148).toBe(true);
  });

  it("leaves the narrow-forward hairpin member untouched", () => {
    // Two input-product feeders sit adjacent (gap 52 < budget 64), so the bus path
    // collapses to a midpoint hairpin with no distinct drop / rise column. Even
    // with a foreign card nearby, clearBusColumns stamps nothing.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0),
      inputProductNode("block", "ore", 150, 300, 148, 78),
    ];
    const out = clearBusColumns(nodes, routeBusEdges(nodes, [mkEdge("e0", "agg", "tap", "ore")]));
    expect(dropXOf(out, "e0")).toBeUndefined();
    expect(riseXOf(out, "e0")).toBeUndefined();
  });

  it("is deterministic across two identical runs", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      inputProductNode("block", "ore", 1070, 300, 148, 78),
    ];
    const routed = routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]);
    expect(riseXOf(clearBusColumns(nodes, routed), "e0")).toBe(
      riseXOf(clearBusColumns(nodes, routed), "e0"),
    );
  });
});

// -- jogForwardLegs -----------------------------------------------------------

function legYOf(edges: Edge[], id: string): number | undefined {
  return (edges.find((e) => e.id === id)?.data as { legY?: number } | undefined)
    ?.legY;
}

// Liang-Barsky segment clip: does the segment a->b cross the rectangle's
// interior? Boundary-only contact (the segment grazing an edge) is not a
// crossing, so a run sitting exactly one CHAMFER off a padded card reads clear.
function segCrossesRect(a: Point, b: Point, rect: ObstacleRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    a.x - rect.left,
    rect.right - a.x,
    a.y - rect.top,
    rect.bottom - a.y,
  ];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false; // parallel and outside this slab
      continue;
    }
    const t = q[i]! / p[i]!;
    if (p[i]! < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

describe("jogForwardLegs", () => {
  // A forward item edge s -> t skipping a layer, its bend column staked in the
  // first gap (bendX 200). t sits one row down so the edge takes the normal
  // forward step (sy 39, ty 139). `mid`, when present, is a foreign card at the
  // target row straddling the final leg's path.
  const buildFixture = (withMid: boolean): { nodes: RFAnyNode[]; edges: Edge[] } => {
    const nodes: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 0, 148, 78), // right 148, port y 39
      inputProductNode("t", "ore", 760, 100, 148, 78), // left 760, port y 139
    ];
    if (withMid) {
      nodes.push(inputProductNode("mid", "ore", 400, 100, 148, 78));
    }
    const edges: Edge[] = [
      {
        ...mkEdge("e0", "s", "t", "ore"),
        data: { item: "ore", rate: new Fraction(1), bendX: 200 },
      },
    ];
    return { nodes, edges };
  };

  it("jogs a blocked leg so the drawn path avoids the foreign card's padded rect", () => {
    const { nodes, edges } = buildFixture(true);
    const out = jogForwardLegs(nodes, edges);
    const legY = legYOf(out, "e0");
    expect(legY).toBeDefined();
    expect(legY).not.toBe(139); // moved off the target port y

    // Reconstruct the drawn path from the stamped hint exactly as ItemEdge does,
    // then assert no segment crosses the mid card's padded obstacle rect.
    const [d] = chamferStepPath({
      sourceX: 148,
      sourceY: 39,
      targetX: 760,
      targetY: 139,
      ...routingHintsFromData(out[0]!.data),
    });
    const midCard = paddedObstacles(nodes, edges).find(
      (o) => o.kind === "card" && o.nodeId === "mid",
    )!;
    const pts = parsePoints(d);
    for (let i = 1; i < pts.length; i++) {
      expect(segCrossesRect(pts[i - 1]!, pts[i]!, midCard)).toBe(false);
    }
  });

  it("stamps nothing and passes the edge through by reference when the leg is clear", () => {
    const { nodes, edges } = buildFixture(false);
    const out = jogForwardLegs(nodes, edges);
    expect(legYOf(out, "e0")).toBeUndefined();
    expect(out[0]).toBe(edges[0]);
  });

  it("leaves bus and backward edges untouched", () => {
    const { nodes } = buildFixture(true);
    const busEdge: Edge = {
      ...mkEdge("bus0", "s", "t", "ore"),
      type: "bus",
      data: { item: "ore", rate: new Fraction(1) },
    };
    // Backward edge (target left of source): t -> s.
    const backwardEdge = mkEdge("bwd0", "t", "s", "ore");
    const out = jogForwardLegs(nodes, [busEdge, backwardEdge]);
    expect(legYOf(out, "bus0")).toBeUndefined();
    expect(legYOf(out, "bwd0")).toBeUndefined();
    expect(out[0]).toBe(busEdge);
    expect(out[1]).toBe(backwardEdge);
  });

  it("suppresses the jog when a stacked sibling blocks the descent column", () => {
    // The blocked leg would jog, but the target's column is packed: siblings sit
    // above and below the target (a loop-interior shape), so whichever clear y
    // the horizontal takes, a sibling card lies straight across the descent. A
    // jog here would trade the intermediate-card strike for a sibling strike, so
    // the guard leaves the edge on its straight leg (no legY stamped).
    const nodes: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 0, 148, 78), // right 148, port y 39
      inputProductNode("t", "ore", 760, 400, 148, 78), // left 760, port y 439
      inputProductNode("mid", "ore", 400, 400, 148, 78), // blocks the leg at ty
      inputProductNode("sibA", "ore", 760, 200, 148, 78), // stacked above target
      inputProductNode("sibB", "ore", 760, 600, 148, 78), // stacked below target
    ];
    const edges: Edge[] = [
      {
        ...mkEdge("e0", "s", "t", "ore"),
        data: { item: "ore", rate: new Fraction(1), bendX: 200 },
      },
    ];
    const out = jogForwardLegs(nodes, edges);
    expect(legYOf(out, "e0")).toBeUndefined();
    expect(out[0]).toBe(edges[0]);
  });

  it("is deterministic across two identical runs", () => {
    const { nodes, edges } = buildFixture(true);
    expect(legYOf(jogForwardLegs(nodes, edges), "e0")).toBe(
      legYOf(jogForwardLegs(nodes, edges), "e0"),
    );
  });
});

describe("clampBackwardRails column clamp", () => {
  it("clamps the target-side vertical out of a foreign node's entry band", () => {
    // Backward edge s -> t (source right, target left). A foreign node f sits one
    // row below the target in the same column, so the left vertical (default
    // tx - PORT_STUB = -24) climbs from the rail to the target port straight
    // through f's padded card / gutter. clearColumnX moves it clear, stamping a
    // railXLeft.
    const nodes: RFAnyNode[] = [
      productNode("t", 0, -30, 148, 60), // target, port center y = 0
      productNode("s", 600, 370, 148, 60), // source, port center y = 400
      productNode("f", 0, 100, 148, 60), // foreign, same column, row below target
    ];
    const edges = [mkEdge("e0", "s", "t", "w")];
    const out = clampBackwardRails(nodes, edges);
    const railXLeft = (out[0]!.data as { railXLeft?: number }).railXLeft;
    expect(railXLeft).toBeDefined();
    expect(railXLeft).not.toBe(-24);
    // Cleared off the foreign card's raw left edge (f card left = 0 - 34 = -34).
    expect(railXLeft! < -34).toBe(true);
  });
});
