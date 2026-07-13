// Column and rail geometry passes: assignBendColumns, assignEntryColumns, the
// padded obstacle provider, clearColumnX, clearBusColumns, clampBackwardRails,
// and jogForwardLegs. Fixtures come from ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearBusColumns,
  clearColumnX,
  jogForwardLegs,
  entryGutterRects,
  paddedObstacles,
  gutterWidth,
  ENTRY_SLOT_PITCH,
  BUS_SPAN_THRESHOLD,
} from "../../src/canvas/busRouting";
import { ENTRY_GUTTER_OVERHANG } from "../../src/canvas/dimensions";
import {
  PORT_STUB,
  CHAMFER,
  chamferStepPath,
  routingHintsFromData,
  type ObstacleRect,
} from "../../src/canvas/edgePath";
import { parsePoints, type Point } from "./pathAssertions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
  orderedRecipeNode,
  productNode,
} from "./busRouting.testkit";

function bendOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { bendX?: number }
    | undefined;
  return d?.bendX;
}

function budgetOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { chamferBudget?: number }
    | undefined;
  return d?.chamferBudget;
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

  it("stamps a pitch-bounded, sibling-safe chamfer budget per bend", () => {
    // Same corridor as the fan test: [300, 500], usable = 136, two members, so
    // pitch = 136 / 3. Each bend carries budget = pitch / 2, the largest chamfer
    // whose envelope [bend - budget, bend + budget] stays off its sibling's.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = assignBendColumns(nodes, edges);
    const margin = PORT_STUB + CHAMFER;
    const pitch = (200 - 2 * margin) / 3;
    const g0 = budgetOf(out, "e0")!;
    const g1 = budgetOf(out, "e1")!;
    expect(g0).toBeCloseTo(pitch / 2, 6);
    expect(g1).toBeCloseTo(pitch / 2, 6);
    // Sibling-safe: the two bends' max-chamfer envelopes are disjoint (they abut
    // at most), since the column gap equals the summed budgets.
    const b0 = bendOf(out, "e0")!;
    const b1 = bendOf(out, "e1")!;
    expect(b1 - b0).toBeGreaterThanOrEqual(g0 + g1 - 1e-6);
  });

  it("stamps no chamfer budget when it stamps no bend", () => {
    // A backward edge is skipped by the stagger, so it carries neither hint.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("back", 0, 200, r),
    ];
    // s right edge 300 > back left 0 -> backward, skipped by the stagger.
    const out = assignBendColumns(nodes, [mkEdge("bwd0", "s", "back", "b")]);
    expect(bendOf(out, "bwd0")).toBeUndefined();
    expect(budgetOf(out, "bwd0")).toBeUndefined();
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
    const edges = [
      mkEdge("eP", "sp", "t1", "b"),
      mkEdge("eR", "sr", "t2", "b"),
    ];
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
    // Left overhang: the wider of the port stub and the entry-gutter overhang.
    const leftPad = Math.max(PORT_STUB, ENTRY_GUTTER_OVERHANG);
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
  return (
    edges.find((e) => e.id === id)?.data as { dropX?: number } | undefined
  )?.dropX;
}
function riseXOf(edges: Edge[], id: string): number | undefined {
  return (
    edges.find((e) => e.id === id)?.data as { riseX?: number } | undefined
  )?.riseX;
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
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    expect(dropXOf(out, "e0")).toBeUndefined();
    expect(riseXOf(out, "e0")).toBeUndefined();
  });

  it("stamps a cleared riseX when the default rise column pierces a foreign card", () => {
    // A foreign product sits below the target row, straddling the default rise
    // column (tx - PORT_STUB - CHAMFER = 1138). The rise vertical climbs from the
    // lane to the target port through it, so clearBusColumns moves the rise column
    // off the foreign card. An anchor up top keeps the trunk in the bottom band so
    // its lane sits below the block and the rise runs downward through it.
    const blockLeft = 1070;
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      recipeNode("t", far, 1000, r),
      inputProductNode("block", "ore", blockLeft, 1300, 148, 78),
      // A target-row card mid-corridor (clear of the drop / rise columns) keeps
      // the lone member on the bus (Task 12) so the rise-clearance path runs.
      recipeNode("corridor", 550, 1000, r),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const riseX = riseXOf(out, "e0");
    expect(riseX).toBeDefined();
    expect(riseX).not.toBe(1138);
    // Cleared off the foreign card's raw x-extent [1070, 1218].
    expect(riseX! < blockLeft || riseX! > blockLeft + 148).toBe(true);
  });

  it("stamps a cleared dropX when the default drop column pierces a foreign card", () => {
    // A foreign product straddles the default drop column (sx + PORT_STUB +
    // CHAMFER = 332) in an intermediate row, so the drop vertical is moved off it.
    // An anchor up top keeps the trunk in the bottom band so its lane sits below
    // the block and the drop runs downward through it.
    const blockLeft = 250;
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      recipeNode("t", far, 1000, r),
      inputProductNode("block", "ore", blockLeft, 1300, 148, 78),
      // A target-row card mid-corridor (clear of the drop / rise columns) keeps
      // the lone member on the bus (Task 12) so the drop-clearance path runs.
      recipeNode("corridor", 550, 1000, r),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
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
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "agg", "tap", "ore")]),
    );
    expect(dropXOf(out, "e0")).toBeUndefined();
    expect(riseXOf(out, "e0")).toBeUndefined();
  });

  it("is deterministic across shuffled node order", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      inputProductNode("block", "ore", 1070, 300, 148, 78),
    ];
    const shuffled = [nodes[2]!, nodes[0]!, nodes[1]!];
    const routed = routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]);
    expect(riseXOf(clearBusColumns(nodes, routed), "e0")).toBe(
      riseXOf(clearBusColumns(shuffled, routed), "e0"),
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
  const buildFixture = (
    withMid: boolean,
  ): { nodes: RFAnyNode[]; edges: Edge[] } => {
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

  it("suppresses the jog when a wall packs the target's descent column", () => {
    // The blocked leg would jog, but a tall foreign card ("wall") sits directly
    // in front of the target's entry column and spans the whole y-range every
    // candidate descent would traverse (a loop-interior shape). Whichever clear y
    // the horizontal takes, the descent -- and every clearColumnX alternative,
    // whose final stub then re-crosses the wall -- stays blocked. A jog here would
    // trade the intermediate-card strike for a wall strike, so the candidate scan
    // exhausts and the edge keeps its straight leg (no legY stamped).
    const nodes: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 0, 148, 78), // right 148, port y 39
      inputProductNode("t", "ore", 760, 400, 148, 78), // left 760, port y 439
      inputProductNode("mid", "ore", 400, 400, 148, 78), // blocks the leg at ty
      inputProductNode("wall", "ore", 612, 300, 148, 220), // right 760, y 300..520
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

  // A container ("group") box, the obstacle kind whose exemption this fixture
  // exercises. Only geometry matters to the jog, so data is minimal.
  const containerNode = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): RFAnyNode => ({
    id,
    type: "group",
    position: { x, y },
    width,
    height,
    data: {
      containerKind: "blueprint-group",
      containerId: id,
      memberCount: 1,
    },
  });

  it("exempts the endpoints' own container but jogs around a foreign one", () => {
    // The straight leg at ty would strike a group box straddling the target row.
    // When that box is the TARGET's own container (parentId), the leg legitimately
    // enters it, so the exemption drops it and no jog is stamped. An identically
    // placed FOREIGN container (no endpoint's parent) stays an obstacle, so the
    // leg jogs around it. Same geometry, opposite outcome -- the parentId
    // exemption is what separates them.
    const own: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 0, 148, 78), // right 148, port y 39
      { ...inputProductNode("t", "ore", 760, 100, 148, 78), parentId: "G" },
      containerNode("G", 700, 50, 300, 200), // wraps t, straddles the leg
    ];
    const edge: Edge = {
      ...mkEdge("e0", "s", "t", "ore"),
      data: { item: "ore", rate: new Fraction(1), bendX: 200 },
    };
    const ownOut = jogForwardLegs(own, [edge]);
    expect(legYOf(ownOut, "e0")).toBeUndefined();
    expect(ownOut[0]).toBe(edge);

    const foreign: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 0, 148, 78),
      inputProductNode("t", "ore", 760, 100, 148, 78),
      containerNode("F", 360, 80, 220, 120), // intermediate, no endpoint's parent
    ];
    const foreignOut = jogForwardLegs(foreign, [edge]);
    expect(legYOf(foreignOut, "e0")).toBeDefined();
  });

  it("is deterministic across shuffled node order", () => {
    const { nodes, edges } = buildFixture(true);
    expect(legYOf(jogForwardLegs(nodes, edges), "e0")).toBe(
      legYOf(jogForwardLegs([...nodes].reverse(), edges), "e0"),
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
