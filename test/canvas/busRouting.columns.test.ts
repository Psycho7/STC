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
  CONTAINER_COLUMN_GAP,
  CONTAINER_RAIL_GAP,
  OBSTACLE_PAD_Y,
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

  // A container (loop / SCC slab) box wrapping its members. Only geometry
  // matters to the rail clearance, so the data payload is minimal.
  const containerNode = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): RFAnyNode =>
    ({
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
    }) as unknown as RFAnyNode;

  it("clears a container slab by the wider container gap, not the plain CHAMFER", () => {
    // Backward edge src -> tgt with a container slab ("G") straddling the
    // corridor between them; the rail's preferred y falls inside the slab. A
    // return edge and the slab border in a near-identical gray read as one line
    // when the rail hugs the border at the plain gap, so a container obstacle
    // gets the wider CONTAINER_RAIL_GAP clearance (#29).
    const gTop = -20;
    const gBottom = 100;
    const nodes: RFAnyNode[] = [
      inputProductNode("src", "water", 800, 0, 148, 60),
      inputProductNode("tgt", "water", 0, 0, 148, 60),
      containerNode("G", 200, gTop, 400, gBottom - gTop),
    ];
    const edges = [mkEdge("e0", "src", "tgt", "water")];
    const out = clampBackwardRails(nodes, edges);
    const railY = (out[0]!.data as { railY?: number }).railY;
    expect(railY).toBeDefined();
    // Rail sits at least (OBSTACLE_PAD_Y + CONTAINER_RAIL_GAP) off the slab's
    // raw border on whichever side it exits.
    const clearance = OBSTACLE_PAD_Y + CONTAINER_RAIL_GAP;
    expect(
      railY! <= gTop - clearance || railY! >= gBottom + clearance,
    ).toBe(true);
  });

  it("clears a plain card of the same shape by only the CHAMFER gap", () => {
    // The load-bearing half of the container distinction: an ordinary card
    // (not a group / loop slab) at the same geometry keeps the plain clearance,
    // so only container obstacles get the wider gap.
    const cTop = -20;
    const cBottom = 100;
    const nodes: RFAnyNode[] = [
      inputProductNode("src", "water", 800, 0, 148, 60),
      inputProductNode("tgt", "water", 0, 0, 148, 60),
      inputProductNode("mid", "water", 200, cTop, 400, cBottom - cTop),
    ];
    const edges = [mkEdge("e0", "src", "tgt", "water")];
    const out = clampBackwardRails(nodes, edges);
    const railY = (out[0]!.data as { railY?: number }).railY;
    expect(railY).toBeDefined();
    const wide = OBSTACLE_PAD_Y + CONTAINER_RAIL_GAP;
    const plain = OBSTACLE_PAD_Y + CHAMFER;
    // Cleared off the card (on whichever side) by the plain gap...
    expect(railY! <= cTop - plain || railY! >= cBottom + plain).toBe(true);
    // ...but NOT by the wide container clearance.
    expect(railY! > cTop - wide && railY! < cBottom + wide).toBe(true);
  });
});

// -- clampBackwardRails loop returns -----------------------------------------

describe("clampBackwardRails loop returns", () => {
  // A container (loop / SCC slab) box wrapping its members. Only geometry
  // matters to the rail clearance, so the data payload is minimal.
  const containerNode = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): RFAnyNode =>
    ({
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
    }) as unknown as RFAnyNode;

  it("keeps both rail columns of a same-container return off the slab border", () => {
    // Loop-backedge family: source and target are both members of one
    // container, each sitting one ELK inset (12 here) off a side border, so
    // the default columns -- one stub out of the source port, one stub before
    // the target port -- land 12 units off the raw border and the return's
    // verticals braid the frame. Both resolved columns must sit at least
    // CONTAINER_COLUMN_GAP off the raw slab border (either side).
    const gLeft = 200;
    const gRight = 800;
    const sx = 788; // src's absolute right edge (640 + 148)
    const tx = 212; // tgt's absolute left edge
    const nodes: RFAnyNode[] = [
      containerNode("G", gLeft, 0, gRight - gLeft, 260),
      { ...productNode("src", 440, 80, 148, 78), parentId: "G" },
      { ...productNode("tgt", 12, 80, 148, 78), parentId: "G" },
    ];
    const out = clampBackwardRails(nodes, [mkEdge("e0", "src", "tgt", "w")]);
    const railXRight =
      (out[0]!.data as { railXRight?: number }).railXRight ?? sx + PORT_STUB;
    const railXLeft =
      (out[0]!.data as { railXLeft?: number }).railXLeft ?? tx - PORT_STUB;
    const offFrame = (x: number): number =>
      Math.min(Math.abs(x - gLeft), Math.abs(x - gRight));
    // Today both defaults sit 12 off a border, inside the gap.
    expect(offFrame(railXRight)).toBeGreaterThanOrEqual(CONTAINER_COLUMN_GAP);
    expect(offFrame(railXLeft)).toBeGreaterThanOrEqual(CONTAINER_COLUMN_GAP);
    // And the columns actually moved (the defaults are stamped, not kept).
    expect((out[0]!.data as { railXRight?: number }).railXRight).toBeDefined();
    expect((out[0]!.data as { railXLeft?: number }).railXLeft).toBeDefined();
  });

  it("keeps a one-endpoint return's member-side column off the slab border", () => {
    // Round-2 finding 2: only the SOURCE is a member of the container (the
    // target sits outside it, to the left), so the shared-parent un-exemption
    // never fires and the source's own container stays fully exempt: its
    // default column -- one stub out of the port, 12 off the right border
    // here -- rides the frame exactly like the both-endpoint case did. Each
    // endpoint's OWN container joins ITS side's scan as border bands, so the
    // member-side column must hold the same CONTAINER_COLUMN_GAP off the raw
    // border, while the outside target's column keeps today's unstamped
    // default (no container is its own geometry).
    const gLeft = 200;
    const gRight = 800;
    const sx = 788; // src's absolute right edge (200 + 440 + 148)
    const tx = -400; // tgt's absolute left edge, outside the slab
    const nodes: RFAnyNode[] = [
      containerNode("G", gLeft, 0, gRight - gLeft, 260),
      { ...productNode("src", 440, 80, 148, 78), parentId: "G" },
      productNode("tgt", tx, 80, 148, 78),
    ];
    const out = clampBackwardRails(nodes, [mkEdge("e0", "src", "tgt", "w")]);
    const railXRight =
      (out[0]!.data as { railXRight?: number }).railXRight ?? sx + PORT_STUB;
    const offFrame = (x: number): number =>
      Math.min(Math.abs(x - gLeft), Math.abs(x - gRight));
    // Today the default rides 12 off the right border, inside the gap.
    expect(offFrame(railXRight)).toBeGreaterThanOrEqual(CONTAINER_COLUMN_GAP);
    // And the column actually moved (the default is stamped, not kept).
    expect((out[0]!.data as { railXRight?: number }).railXRight).toBeDefined();
    // Per-side: the outside target's column is no container's business.
    expect((out[0]!.data as { railXLeft?: number }).railXLeft).toBeUndefined();
  });

  it("clears the rail over only the connected band of obstacles around the preferred y", () => {
    // The y-window: a backward rail whose preferred y strikes a LOCAL card
    // must escape just off that card's band, not over every x-overlapping
    // card in the graph. Two distant cards -- one far above, one far below --
    // share the rail's x-span but sit in their own bands; today the escape
    // flies over the far-above card's top (min over ALL spanned tops).
    const nodes: RFAnyNode[] = [
      productNode("src", 1000, 0, 148, 78), // right 1148, port y 39
      productNode("tgt", 0, 0, 148, 78), // left 0, port y 39
      productNode("mid", 400, 60, 148, 78), // padded y [52, 146]: local
      productNode("far", 400, -800, 148, 78), // padded y [-808, -724]
      productNode("deep", 400, 900, 148, 78), // padded y [892, 980]
    ];
    const out = clampBackwardRails(nodes, [mkEdge("e0", "src", "tgt", "w")]);
    const railY = (out[0]!.data as { railY?: number }).railY;
    expect(railY).toBeDefined();
    // Stays between the two distant cards (today it lands at -816, over the
    // far-above card's top).
    expect(railY!).toBeGreaterThan(-800);
    expect(railY!).toBeLessThan(900);
    // And it clears the local band it actually struck (the mid card's padded
    // extent [52, 146]).
    expect(railY! < 52 || railY! > 146).toBe(true);
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
    // And it stays on the port's own (left) side of the target card: a rise
    // column at or right of the port would tunnel the target's body.
    const tx = far; // target left edge
    expect(riseX! <= tx - CHAMFER).toBe(true);
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
    // A bus member whose endpoints sit adjacent (gap 52 < budget 64) collapses
    // to a midpoint hairpin with no distinct drop / rise column, so even with a
    // foreign card nearby clearBusColumns stamps nothing. Span-only
    // classification can no longer produce such a member, so the stamps are
    // hand-built; the hairpin guard inside clearBusColumns is unchanged.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0),
      inputProductNode("block", "ore", 150, 300, 148, 78),
    ];
    const hairpinBus: Edge = {
      id: "e0",
      source: "agg",
      target: "tap",
      type: "bus",
      data: {
        item: "ore",
        rate: new Fraction(1),
        // Bottom band top: block's bottom (378) + LANE_TOP_OFFSET, lane slot 0.
        laneY: 378 + 80,
        trunkKey: "ore|agg",
        busChipOwner: true,
        busMemberCount: 1,
        busTotalRate: new Fraction(1),
        busBand: "bottom" as const,
      },
    };
    const out = clearBusColumns(nodes, [hairpinBus]);
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

  // A container (loop / SCC slab) box wrapping its members. Only geometry matters
  // to column clearance, so the data payload is minimal.
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

  it("keeps the rise on the port side when an SCC-slab sibling packs the left corridor", () => {
    // The crystal-equip shape: the target ("t") lives inside a loop container
    // ("G") with a sibling card ("sib") packing its left corridor, its right edge
    // one entry-gutter overhang off the target's Left port. The sibling is not the
    // target's own geometry (only t and its parent G are exempt), so it blocks the
    // default rise column (tx - PORT_STUB - CHAMFER = 1138). Without the own-side
    // guard the nearest accepted column is the rightward fallback (sib's padded
    // right edge + gap, 1178) -- past the port and straight through the target
    // card's own body. The guard clamps the rise to the port's own (left) side, so
    // it threads the raw gutter between sib and t (1148) instead.
    //   sib.left_raw = 998 (abs), width 148 -> raw right 1146, padded right 1170.
    //   t.left (tx) = 1170; the rise must land at x <= tx - CHAMFER = 1162.
    const tx = far; // 1170, target's absolute left edge
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      // A mid-corridor card keeps the lone member on the bus rather than a
      // single-member direct route.
      recipeNode("corridor", 550, 1000, r),
      containerNode("G", 950, 970, 540, 200), // wraps t + sib
      { ...recipeNode("t", 220, 30, r), parentId: "G" }, // abs (1170, 1000)
      {
        ...inputProductNode("sib", "ore", 48, 30, 148, 78),
        parentId: "G",
      }, // abs (998, 1000): raw [998, 1146]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const riseX = riseXOf(out, "e0");
    expect(riseX).toBeDefined();
    // On the port's own side: never at or right of the target's Left port.
    expect(riseX! <= tx - CHAMFER).toBe(true);
    // The approach leg runs [riseX, tx] at the port height; since riseX <= tx and
    // the target's raw rect starts at x = tx, the leg touches only the card's
    // left boundary and never enters its body (open-interval crossing test).
    expect(riseX! <= tx).toBe(true);
  });

  it("escapes past an abutting sibling instead of piercing its body with the rise", () => {
    // Same slab, but the sibling ("sib") abuts the target's left edge (raw right
    // == tx = 1170), so no clamp-valid leftward column is clear: the rightward
    // candidates are rejected by the own-side clamp and every leftward
    // candidate's approach leg crosses the sibling. The desired column (1138)
    // sits strictly INSIDE the sibling's raw body, so returning it unchanged
    // would slice a foreign card outright -- a hard violation. The pierce
    // rescue drops the own-side guard and takes the nearest clear column past
    // the sibling (raw right + 2 = 1172) instead: a boundary-hugging column on
    // the wrong side of the port beats piercing a foreign body.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      recipeNode("corridor", 550, 1000, r),
      containerNode("G", 950, 970, 540, 200),
      { ...recipeNode("t", 220, 30, r), parentId: "G" }, // abs left 1170
      {
        ...inputProductNode("sib", "ore", 72, 30, 148, 78),
        parentId: "G",
      }, // abs (1022, 1000): raw right 1170 == tx
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const riseX = riseXOf(out, "e0");
    expect(riseX).toBeDefined();
    // Clear of the sibling's raw body (never strictly inside [1022, 1170]).
    expect(riseX! > 1022 && riseX! < 1170).toBe(false);
  });

  it("keeps a backward (gap <= 0) rise on the port side through the same resolver", () => {
    // Backward bus member: the target ("t") sits left of its source ("agg"), so
    // gap <= 0 and clearBusColumns routes it through the same
    // clearColumnKeepingLeg call (no forward early-return). Span-only
    // classification can never produce a backward member (backward spans floor
    // at 0), so the bus stamps are hand-built; clearBusColumns' backward path
    // itself is unchanged and this pins its own-side clamp. A sibling ("sib")
    // left of the target straddles the default rise column (tx - PORT_STUB -
    // CHAMFER = -32) below the port row (its top sits under the port y, so
    // leftward approach legs stay clear). Without the own-side guard the
    // nearest accepted column is rightward past the port (x >= tx), tunneling
    // the target; the clamp rejects it, so the rise resolves to a clamp-valid
    // leftward column instead.
    const tx = 0; // target's absolute left edge
    const nodes: RFAnyNode[] = [
      // A high anchor keeps the graph midline above the member ports so the
      // trunk stays in the BOTTOM band and the rise run crosses the sibling.
      inputProductNode("anchor", "ore", 600, -800, 148, 78),
      inputProductNode("agg", "ore", 1000, 0, 148, 78), // source, right 1148
      inputProductNode("t", "ore", 0, 0, 148, 78), // target, left 0, port y 39
      inputProductNode("sib", "ore", -150, 60, 148, 78), // raw [-150, -2] y [60, 138]
    ];
    // Bottom band top: sib's bottom (138) + LANE_TOP_OFFSET, lane slot 0.
    const backwardBus: Edge = {
      id: "e0",
      source: "agg",
      target: "t",
      type: "bus",
      data: {
        item: "ore",
        rate: new Fraction(1),
        laneY: 138 + 80,
        trunkKey: "ore|agg",
        busChipOwner: true,
        busMemberCount: 1,
        busTotalRate: new Fraction(1),
        busBand: "bottom" as const,
      },
    };
    const out = clearBusColumns(nodes, [backwardBus]);
    const riseX = riseXOf(out, "e0");
    // A clamp-valid leftward column: never at or right of the port (x >= tx
    // would tunnel the target's body).
    expect(riseX).toBeDefined();
    expect(riseX! <= tx - CHAMFER).toBe(true);
  });

  it("keeps the drop on the port side when a sibling packs the source's right corridor", () => {
    // Mirror of the rise slab on the source card. The source ("s") lives inside a
    // container ("G2") with a sibling ("sib") packing its right corridor, its left
    // edge one gutter overhang off the source's Right port. The sibling blocks the
    // default drop column (sx + PORT_STUB + CHAMFER = 332); without the own-side
    // guard the nearest accepted column is the leftward fallback (292), past the
    // port and through the source card's own body. The clamp (x >= sx + CHAMFER)
    // rejects that, so the drop stays right of the port -- here it degrades to the
    // unstamped right-of-port default when no clamp-valid rightward column clears.
    //   sib.left_raw = 334 (abs) -> padded left 300 == sx; sib blocks x in
    //   (292, 514). s.right (sx) = 300; the drop must land at x >= sx + CHAMFER.
    // The sibling is tall (height 200) so it spans the drop column's y-range,
    // which runs from the source's low out-port (y 1097) down to the lane.
    const sx = 300; // source's absolute right edge (left 0 + RECIPE_WIDTH)
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("corridor", 550, 1000, r),
      recipeNode("t", far, 1000, r),
      containerNode("G2", -40, 970, 560, 260), // wraps s + tall sib
      { ...recipeNode("s", 40, 30, r), parentId: "G2" }, // abs (0, 1000)
      {
        ...inputProductNode("sib", "ore", 374, 30, 148, 200),
        parentId: "G2",
      }, // abs (334, 1000): raw [334, 482] x [1000, 1200], padded left 300
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const dropX = dropXOf(out, "e0");
    // Never at or left of the port (which would tunnel the source body): either a
    // clamp-valid rightward column, or the unstamped degrade to dropDesired (> sx).
    expect(dropX === undefined || dropX >= sx + CHAMFER).toBe(true);
  });

  it("escapes into the chamfer band rather than piercing a sibling with the drop", () => {
    // Drop-side pierce rescue. The desired drop column (sx + PORT_STUB +
    // CHAMFER = 332) sits strictly INSIDE the tall sibling's raw body [306,
    // 454], which spans the whole drop run; every rightward candidate's leg
    // crosses the sibling and every clamp-valid leftward candidate is blocked,
    // so the guarded tiers exhaust. Returning the desired column would slice
    // the sibling outright, so the rescue drops the guard and takes the
    // nearest clear column: x = 304 (raw left - RAW_GAP), inside the chamfer
    // band [sx, sx + CHAMFER) but clear of every raw body. A cramped
    // boundary-hugging column beats piercing a foreign card.
    //   s: abs (0, 1000), sx = 300, out-port y = 1097.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      // A mid-corridor card keeps the lone member on the bus rather than a
      // single-member direct route.
      recipeNode("corridor", 550, 1000, r),
      recipeNode("t", far, 1000, r),
      inputProductNode("sib", "ore", 306, 1000, 148, 200), // raw [306, 454]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const dropX = dropXOf(out, "e0");
    expect(dropX).toBeDefined();
    // Clear of the sibling's raw body (never strictly inside [306, 454]).
    expect(dropX! > 306 && dropX! < 454).toBe(false);
  });

  it("prefers a clamp-valid drop column over a nearer one inside the chamfer band", () => {
    // Isolates the drop-side clamp with NO pierce in play (so the rescue never
    // runs). Two short foreign cards sit below the port row, straddling the
    // drop run: "c" blocks the desired column (332) within the raw gap without
    // containing it (raw left 333), and "d" (raw [304, 330]) walls off c's
    // near-left candidate while supplying its own left candidate at x = 302 --
    // inside the chamfer band [sx, sx + CHAMFER) = [300, 308). Both cards sit
    // under the port row, so their approach legs are clear; the own-card leg
    // rect rejects every column left of the port but admits the band. Without
    // the clamp the nearest legal candidate 302 wins (a column butting the
    // port with no room for the chamfer elbow); the clamp rejects it and the
    // resolver takes the clamp-valid column right of c (483) instead.
    const sx = 300; // source's absolute right edge (left 0 + RECIPE_WIDTH)
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      // A mid-corridor card keeps the lone member on the bus rather than a
      // single-member direct route.
      recipeNode("corridor", 550, 1000, r),
      recipeNode("t", far, 1000, r),
      productNode("c", 333, 1300, 148, 78), // raw [333, 481]
      productNode("d", 304, 1400, 26, 78), // raw [304, 330]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const dropX = dropXOf(out, "e0");
    expect(dropX).toBeDefined();
    expect(dropX! >= sx + CHAMFER).toBe(true);
  });

  it("traverses its own target card only as the last resort when the port-side corridor is packed", () => {
    // The battery5 shape that regressed the geometry audit's hard gate: the
    // target's left corridor is walled at PORT height by one card ("wall",
    // abutting the port so every leftward approach leg crosses its body) while
    // a second card ("block") straddles the DESIRED rise column further down
    // the run, between the target row and the lane. The own-side guard rejects
    // every candidate -- leftward legs cross the wall, rightward columns are
    // clamp-rejected -- and the pre-rescue degrade kept the desired column
    // (1138), which runs straight through the block's raw body [1064, 1212]: a
    // hard-gate pierce of an unrelated card. The pierce rescue's off-own tier
    // (3a) finds nothing -- the wall occupies the whole chamfer band so no
    // body-clear column keeps its leg off the own card -- so the last-resort
    // tier (3b) runs: it lands right of the block (1214), which is clear of
    // every FOREIGN raw body but sits INSIDE the own target card's body
    // [1170, 1470]. This is the ruled last resort for geometry with no clear
    // option (matching pre-guard behaviour). The foreign segment audit exempts
    // an edge's own endpoint cards and cannot see this run; auditOwnCardPierces
    // measures it instead.
    //   t: (1170, 1000), port y 1074 (product-style center fallback).
    //   wall: raw [1022, 1170] y [1020, 1120] -- abuts tx, contains port y.
    //   block: raw [1064, 1212] y [1300, 1378] -- contains desired 1138.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      // A mid-corridor card keeps the lone member on the bus rather than a
      // single-member direct route.
      recipeNode("corridor", 550, 1000, r),
      recipeNode("t", far, 1000, r),
      inputProductNode("wall", "ore", 1022, 1020, 148, 100),
      inputProductNode("block", "ore", 1064, 1300, 148, 78),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const resolved = riseXOf(out, "e0") ?? far - PORT_STUB - CHAMFER;
    // The resolved rise column never runs strictly inside a FOREIGN raw card
    // body it spans: not the block's [1064, 1212], not the wall's [1022, 1170].
    expect(resolved > 1064 && resolved < 1212).toBe(false);
    expect(resolved > 1022 && resolved < 1170).toBe(false);
    // It IS an own-card landing (the last-resort 3b traversal): right of the
    // target's Left port (tx = far = 1170), strictly inside the target card's
    // own raw body [1170, 1470]. This is what the own-pierce audit ratchets.
    expect(resolved > far).toBe(true);
    expect(resolved > far && resolved < far + 300).toBe(true);
  });

  it("prefers a body-clear off-own column over traversing its own target card", () => {
    // The 3a sub-tier of the pierce rescue: same packed shape, but the wall's
    // raw right edge stops one chamfer short of the port (1160, not 1170), so
    // the chamfer band [tx - CHAMFER, tx) = [1162, 1170) is not walled. A short
    // foreign "shelf" (raw right 1166) sitting at the run's lane depth supplies
    // a candidate column at 1168 -- inside the chamfer band, off-side of the
    // clamp (so tiers 1/2 reject it) but with an approach leg that stops at the
    // port without crossing the own card body. "block" (raw [1002, 1150])
    // straddles the desired column 1138 and, with the wall, exhausts every
    // clamp-valid tier-1/2 column, so the rescue runs. Its off-own tier (3a)
    // takes 1168 -- a body-clear column whose leg clears the own card -- in
    // preference to any own-card traversal (3b). The rescue lands off-own.
    //   t: (1170, 1000), port y 1074. tx = 1170, chamfer band [1162, 1170).
    //   wall:  raw [1012, 1160] y [1020, 1120] -- blocks leftward legs, clears band.
    //   shelf: raw [1018, 1166] y [1300, 1378] -- supplies the 1168 candidate.
    //   block: raw [1002, 1150] y [1300, 1378] -- contains desired 1138.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s", 0, 1000, r),
      recipeNode("corridor", 550, 1000, r),
      recipeNode("t", far, 1000, r),
      inputProductNode("shelf", "ore", 1018, 1300, 148, 78),
      inputProductNode("wall", "ore", 1012, 1020, 148, 100),
      inputProductNode("block", "ore", 1002, 1300, 148, 78),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]),
    );
    const resolved = riseXOf(out, "e0") ?? far - PORT_STUB - CHAMFER;
    // Off-own: strictly LEFT of the target's Left port (tx = far = 1170), so
    // its approach leg never enters the own card body [1170, 1470]. Contrast
    // the last-resort test above, where the packed wall forces an own-card
    // landing (resolved > far).
    expect(resolved).toBeLessThan(far);
    // And clear of the foreign bodies it spans (block, wall, shelf raw).
    expect(resolved > 1002 && resolved < 1150).toBe(false);
    expect(resolved > 1012 && resolved < 1160).toBe(false);
  });

  it("fans two distinct-item trunks off a shared drop and rise column (#25)", () => {
    // Two trunks leave the same source layer (right edge 300 -> drop column 332)
    // and rise into ONE shared multi-input target (left far -> rise column
    // far - 32), one carrying item "b" and one item "c". Absent per-trunk
    // separation both drops resolve to 332 and both rises to far - 32, candy-
    // striping two items on one column. The shared target is each rise's own
    // (exempt) card, so neither rise dodges the other and they genuinely coincide.
    // Each lone member keeps a mid-corridor blocker so it stays on the bus, and a
    // high anchor pins both trunks to the bottom band.
    const tr = mkRecipe("tr", ["b", "c"], []);
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s1", 0, 1000, r),
      recipeNode("s2", 0, 1150, r),
      recipeNode("cor1", 550, 1000, r),
      recipeNode("cor2", 550, 1150, r),
      recipeNode("t", far, 1075, tr),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [
        mkEdge("e1", "s1", "t", "b"),
        mkEdge("e2", "s2", "t", "c"),
      ]),
    );
    const dropDefault = 300 + PORT_STUB + CHAMFER; // 332
    const riseDefault = far - PORT_STUB - CHAMFER;
    // Every member of a colliding bucket stores its resolved column -- including
    // the lowest-slot trunk at offset 0 -- so both render on the same basis and
    // the on-screen gap is exactly one pitch (an unstored base would fall back to
    // a handle-derived column and shrink the gap below a pitch).
    expect(dropXOf(out, "e1")).toBeDefined();
    expect(dropXOf(out, "e2")).toBeDefined();
    expect(riseXOf(out, "e1")).toBeDefined();
    expect(riseXOf(out, "e2")).toBeDefined();
    const drop1 = dropXOf(out, "e1") ?? dropDefault;
    const drop2 = dropXOf(out, "e2") ?? dropDefault;
    const rise1 = riseXOf(out, "e1") ?? riseDefault;
    const rise2 = riseXOf(out, "e2") ?? riseDefault;
    // Distinct columns, exactly one slot pitch apart on both the drop and rise.
    expect(Math.abs(drop1 - drop2)).toBe(ENTRY_SLOT_PITCH);
    expect(Math.abs(rise1 - rise2)).toBe(ENTRY_SLOT_PITCH);
  });

  it("keeps two separated trunk drops apart when a card forces a dodge (#25)", () => {
    // The same two colliding trunks, plus a foreign card straddling both drop
    // columns (332 and 348) at the run's lane depth. Both drops sit inside the
    // card's padded band, so the foreign-card dodge moves both -- collapsing them
    // onto the same escape column. The post-dodge separation pass then buckets
    // them on that shared resolved column and steps them one slot pitch apart, so
    // the two dodged drops still land on distinct columns.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s1", 0, 1000, r),
      recipeNode("s2", 0, 1150, r),
      recipeNode("cor1", 550, 1000, r),
      recipeNode("cor2", 550, 1150, r),
      recipeNode("t1", far, 1000, r),
      recipeNode("t2", far, 1150, r),
      inputProductNode("block", "ore", 300, 1250, 148, 78), // raw [300, 448]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [
        mkEdge("e1", "s1", "t1", "b"),
        mkEdge("e2", "s2", "t2", "c"),
      ]),
    );
    // Both dodged the block (stamped away from the 332 default)...
    expect(dropXOf(out, "e1")).toBeDefined();
    expect(dropXOf(out, "e2")).toBeDefined();
    // ...and never onto the same escape column.
    expect(dropXOf(out, "e1")).not.toBe(dropXOf(out, "e2"));
  });

  it("fans two same-item trunks from different sources off a shared drop column (#25)", () => {
    // The separation keys on the trunk (`item|source`), not the item alone: two
    // trunks carrying the SAME item from DIFFERENT sources coincide on the drop
    // column (both resolve to 332 off the shared source layer) and are stepped
    // apart exactly like a distinct-item pair.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s1", 0, 1000, r),
      recipeNode("s2", 0, 1150, r),
      recipeNode("cor1", 550, 1000, r),
      recipeNode("cor2", 550, 1150, r),
      recipeNode("t1", far, 1000, r),
      recipeNode("t2", far, 1150, r),
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [
        mkEdge("e1", "s1", "t1", "b"),
        mkEdge("e2", "s2", "t2", "b"),
      ]),
    );
    expect(dropXOf(out, "e1")).toBeDefined();
    expect(dropXOf(out, "e2")).toBeDefined();
    expect(Math.abs(dropXOf(out, "e1")! - dropXOf(out, "e2")!)).toBe(
      ENTRY_SLOT_PITCH,
    );
  });

  it("never steps a separated drop column into a foreign card (#25 re-check)", () => {
    // Four distinct-item trunks leave the same source layer; a foreign card with
    // raw x-extent [350, 498] sits at the run's lane depth. The three upper
    // trunks' drop spans also pass their sibling source cards below, so the
    // padded tier is walled on both sides and the raw fallback keeps their 332
    // default (2px shy of the card's raw left minus the slim gap) -- a colliding
    // bucket of three at 332. The bottom trunk's span passes no sibling, so it
    // dodges alone to the card's padded escape at 308. Naive separation would
    // step the bucket's rank 2 to 332 + 32 = 364, INSIDE the card's raw body.
    // The post-offset re-check must instead keep stepping (every bounded
    // candidate is still inside the card) and then drop rank 2's offset so it
    // falls back to the coincident 332 -- a benign overlap, never a pierce.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s1", 0, 1000, r),
      recipeNode("s2", 0, 1150, r),
      recipeNode("s3", 0, 1300, r),
      recipeNode("s4", 0, 1450, r),
      recipeNode("cor1", 550, 1000, r),
      recipeNode("cor2", 550, 1150, r),
      recipeNode("cor3", 550, 1300, r),
      recipeNode("cor4", 550, 1450, r),
      recipeNode("t1", far, 1000, r),
      recipeNode("t2", far, 1150, r),
      recipeNode("t3", far, 1300, r),
      recipeNode("t4", far, 1450, r),
      inputProductNode("block", "ore", 350, 1550, 148, 78), // raw [350, 498]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [
        mkEdge("e1", "s1", "t1", "b"),
        mkEdge("e2", "s2", "t2", "c"),
        mkEdge("e3", "s3", "t3", "d"),
        mkEdge("e4", "s4", "t4", "e"),
      ]),
    );
    const xs = ["e1", "e2", "e3", "e4"].map((id) => dropXOf(out, id));
    // Every trunk stores its column (bucket members and the lone dodger)...
    for (const x of xs) expect(x).toBeDefined();
    // ...and no stored column pierces the card's raw body.
    for (const x of xs) expect(x! > 350 && x! < 498).toBe(false);
    // Rank 2, boxed in by the card, falls back to rank 0's coincident column
    // instead of stepping into the card.
    expect(xs[2]).toBe(xs[0]);
  });

  it("rejects a stepped drop whose connecting leg would cross a card (#25 re-check)", () => {
    // The same four-trunk fixture, plus a slim card with raw x-extent [336, 344]
    // -- strictly between the bucket's 332 natural and rank 1's 348 candidate --
    // straddling the second source's port row. The 348 candidate's VERTICAL is
    // clear of that card, but stepping there lengthens the port-to-column leg at
    // the port row so the leg would slice the card's body. The re-check must
    // reject the candidate via the leg guard; with every further candidate
    // inside the big card, rank 1 falls back to the coincident 332 like rank 2.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, r),
      recipeNode("s1", 0, 1000, r),
      recipeNode("s2", 0, 1150, r),
      recipeNode("s3", 0, 1300, r),
      recipeNode("s4", 0, 1450, r),
      recipeNode("cor1", 550, 1000, r),
      recipeNode("cor2", 550, 1150, r),
      recipeNode("cor3", 550, 1300, r),
      recipeNode("cor4", 550, 1450, r),
      recipeNode("t1", far, 1000, r),
      recipeNode("t2", far, 1150, r),
      recipeNode("t3", far, 1300, r),
      recipeNode("t4", far, 1450, r),
      inputProductNode("block", "ore", 350, 1550, 148, 78), // raw [350, 498]
      inputProductNode("legcard", "ore", 336, 1150, 8, 140), // raw [336, 344]
    ];
    const out = clearBusColumns(
      nodes,
      routeBusEdges(nodes, [
        mkEdge("e1", "s1", "t1", "b"),
        mkEdge("e2", "s2", "t2", "c"),
        mkEdge("e3", "s3", "t3", "d"),
        mkEdge("e4", "s4", "t4", "e"),
      ]),
    );
    // Rank 1's leg-crossing 348 candidate is rejected: it falls back to the
    // coincident column instead of slicing the slim card with its leg.
    expect(dropXOf(out, "e2")).toBeDefined();
    expect(dropXOf(out, "e2")).toBe(dropXOf(out, "e1"));
    // And no stored column pierces either card's raw body.
    for (const id of ["e1", "e2", "e3", "e4"]) {
      const x = dropXOf(out, id)!;
      expect(x > 350 && x < 498).toBe(false);
      expect(x > 336 - 2 && x < 344 + 2).toBe(false);
    }
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
