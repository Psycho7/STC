// Column and rail geometry passes: assignBendColumns, assignEntryColumns, the
// padded obstacle provider, clearColumnX, clampBackwardRails, and
// jogForwardLegs. Fixtures come from ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearColumnX,
  edgePortsModel,
  jogForwardLegs,
  entryGutterRects,
  paddedObstacles,
  rawCardRects,
  gutterWidth,
  ENTRY_SLOT_PITCH,
  CONTAINER_COLUMN_GAP,
  CONTAINER_RAIL_GAP,
  OBSTACLE_PAD_Y,
} from "../../src/canvas/busRouting";
import {
  BETWEEN_LAYERS_SPACING,
  ENTRY_GUTTER_OVERHANG,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import { ENV_ROW_HEIGHT } from "../../src/canvas/envBanner";
import { cardRectsFor } from "../../src/canvas/chipSeating";
import { widenLayerGaps } from "../../src/canvas/layerModel";
import { nodeIndexOf } from "../../src/canvas/nodeGeometry";
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
    // Source right edge at x = 0 + 240 = 240; targets at x = 500 (left edge),
    // so the corridor is [240, 500], usable = 260 - 2*(24+8) = 196.
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
      expect(b).toBeGreaterThan(RECIPE_WIDTH + margin);
      expect(b).toBeLessThan(500 - margin);
    }
    // Distinct, evenly pitched slots: e0 sorts first (slot 1), e1 second.
    expect(b0).toBeLessThan(b1);
    const pitch = (500 - RECIPE_WIDTH - 2 * margin) / 3;
    expect(b0).toBeCloseTo(RECIPE_WIDTH + margin + pitch, 6);
    expect(b1).toBeCloseTo(RECIPE_WIDTH + margin + 2 * pitch, 6);
  });

  it("stamps a pitch-bounded, sibling-safe chamfer budget per bend", () => {
    // Same corridor as the fan test: [240, 500], usable = 196, two members, so
    // pitch = 196 / 3. Each bend carries budget = pitch / 2, the largest chamfer
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
    const pitch = (500 - RECIPE_WIDTH - 2 * margin) / 3;
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
    // s right edge 240 > back left 0 -> backward, skipped by the stagger.
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
    // A product source (width 148 -> right 148) and a recipe source (width 240
    // -> right 240) share the same source layer (left x = 0) and both feed the
    // next layer at x = 500. Banding by source LEFT (not source right) puts them
    // in ONE band so they fan against each other and land on DISTINCT columns
    // inside the shared first gap [240, 500]; the old source-right banding split
    // them into independent bands that could pick coincident columns.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      inputProductNode("sp", "b", 0, 0), // right 0 + 148 = 148
      recipeNode("sr", 0, 300, r), //         right 0 + 240 = 240
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
    // Corridor is the shared first gap: rightmost source edge (240) to the next
    // node column (500). Both bends sit inside it, and they are distinct.
    for (const b of [bp!, br!]) {
      expect(b).toBeGreaterThan(RECIPE_WIDTH + margin);
      expect(b).toBeLessThan(500 - margin);
    }
    expect(bp).not.toBe(br);
  });

  it("keeps a layer-skipping bend clear of the intermediate node (finding 3)", () => {
    // A forward item edge from layer 0 to layer 2, with a node occupying layer 1
    // between them. Its bend must land in the first gap (before the layer-1
    // column), never inside the intermediate node box.
    const r = mkRecipe("r", ["a"], ["b"]);
    // One layer pitch: a card plus the gap right of it.
    const midLeft = RECIPE_WIDTH + BETWEEN_LAYERS_SPACING;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r), //          right 240
      recipeNode("mid", midLeft, 0, r), //  layer-1 column at 350
      recipeNode("t", 2 * midLeft, 200, r), // layer-2 target at 700
    ];
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
      recipeNode("sR", 0, 0, r), //          width 240 -> right 240 (sets groupLeft)
      inputProductNode("sP", "b", 0, 400), // width 148 -> right 148
      recipeNode("near", 200, 400, r), //     adjacent target, left 200 <= 240
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

  it("fans inside the column zone of the gap right of its source layer", () => {
    // With gap records the corridor is the gap's column zone, so no bend stands
    // in the source chip reserve (where the first leg's chip draws) or in the
    // target reserve (where the last leg's does). Every fixture above runs
    // without a ctx and pins the margin-only corridor unchanged.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const widened = widenLayerGaps(nodes, edges);
    const out = assignBendColumns(widened.nodes, edges, {
      gaps: widened.gaps,
    });
    const gap = widened.gaps[0]!;
    // Premise: the gap really does reserve room on both sides of its columns.
    expect(gap.sourceZone.right).toBeGreaterThan(gap.left);
    expect(gap.targetZone.left).toBeLessThan(gap.right);
    for (const id of ["e0", "e1"]) {
      const bend = bendOf(out, id)!;
      expect(bend).toBeGreaterThanOrEqual(gap.columnZone.left);
      expect(bend).toBeLessThanOrEqual(gap.columnZone.right);
    }
  });

  it("keeps the floor off a trunk column whatever the member's edge type", () => {
    // A bus-typed member's junction column stands in the same gap as the band's
    // own bends. The stagger skips the member itself, but it may not fan a
    // vertical onto its column either: a trunk column carries every member's
    // stroke, so the keep-out is a whole port stub.
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("sb", 0, 400, r),
      recipeNode("t1", 500, 0, r),
      recipeNode("t2", 500, 200, r),
      recipeNode("tb", 500, 400, r),
    ];
    const items = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const widened = widenLayerGaps(nodes, [
      ...items,
      mkEdge("bus0", "sb", "tb", "b"),
    ]);
    const gap = widened.gaps[0]!;
    const junctionX = (gap.columnZone.left + gap.columnZone.right) / 2;
    const trunkMember: Edge = {
      ...mkEdge("bus0", "sb", "tb", "b"),
      type: "bus",
      data: { item: "b", fanout: true, trunkKey: "k", junctionX },
    };
    const out = assignBendColumns(widened.nodes, [...items, trunkMember], {
      gaps: widened.gaps,
    });
    for (const id of ["e0", "e1"]) {
      expect(Math.abs(bendOf(out, id)! - junctionX)).toBeGreaterThanOrEqual(
        PORT_STUB,
      );
    }
  });

  it("falls back to the floor itself when the even pitch is under it", () => {
    // Twelve members in the margin-only corridor [240, 500]: usable 196, so the
    // even pitch would be 196 / 13 = 15.08, under the floor. The fan then stands
    // at exactly the floor, centred in the corridor, so no two verticals braid.
    const r = mkRecipe("r", ["a"], ["b"]);
    const count = 12;
    const nodes: RFAnyNode[] = [recipeNode("s", 0, 0, r)];
    const edges: Edge[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(recipeNode(`t${i}`, 500, i * 200, r));
      edges.push(mkEdge(`e${i}`, "s", `t${i}`, "b"));
    }
    const out = assignBendColumns(nodes, edges);
    const bends = edges.map((e) => bendOf(out, e.id)!).sort((a, b) => a - b);
    const margin = PORT_STUB + CHAMFER;
    const usable = 500 - RECIPE_WIDTH - 2 * margin;
    for (let i = 1; i < bends.length; i += 1) {
      expect(bends[i]! - bends[i - 1]!).toBeCloseTo(ENTRY_SLOT_PITCH, 6);
    }
    // Centred: the slack the floor leaves is split between the two end gaps.
    const slack = (usable - (count - 1) * ENTRY_SLOT_PITCH) / 2;
    expect(bends[0]!).toBeCloseTo(RECIPE_WIDTH + margin + slack, 6);
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
      recipeNode("s", 0, 0, mkRecipe("s", [], ["b"])), // right edge 240
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
    // The gutter overhang reaches past the bare stub, so the X pad exceeds
    // PORT_STUB.
    expect(leftPad).toBeGreaterThan(PORT_STUB);
    // Each card carries the id of the node it was built from.
    expect(card!.nodeId).toBe("n");
  });

  it("adds no frame term to an environment recipe's card obstacle: the plate is a row of the card", () => {
    // An environment recipe draws its plate as the card's first row (ruling
    // I9), so the obstacle is the plain card box, one ENV_ROW_HEIGHT taller
    // than the same recipe without an environment. Nothing reaches outside it,
    // and the pierce rect model (cardRectsFor) says the same.
    const plain = recipeNode("p", 0, 0, mkRecipe("p", ["a"], ["b"]));
    const env: RFAnyNode = {
      ...plain,
      id: "e",
      data: {
        ...plain.data,
        recipe: { ...plain.data.recipe, environment: "acidic" },
      },
    };
    const cardOf = (node: RFAnyNode) => {
      const card = paddedObstacles([node], []).find((r) => r.kind === "card");
      expect(card).toBeDefined();
      return card!;
    };
    const bare = cardOf(plain);
    const plated = cardOf(env);
    expect(plated.left).toBe(bare.left);
    expect(plated.right).toBe(bare.right);
    expect(plated.top).toBe(bare.top);
    expect(plated.bottom - bare.bottom).toBe(ENV_ROW_HEIGHT);
    // The pierce audit's rect model grows by the same row and no more, so the
    // two models cannot disagree about where the plate is.
    const drawnOf = (node: RFAnyNode) =>
      cardRectsFor([node], nodeIndexOf([node]))[0]!;
    const drawnBare = drawnOf(plain);
    const drawnPlated = drawnOf(env);
    expect(drawnPlated.top).toBe(drawnBare.top);
    expect(drawnPlated.bottom - drawnBare.bottom).toBe(ENV_ROW_HEIGHT);
  });

  it("adds no frame term to an environment recipe's RAW rect either", () => {
    // The raw-fallback tiers (clearColumnKeepingLeg's tier 2, its leg check and
    // desiredPierces) resolve against rawCardRects, so they have to see the
    // same box: the card box, plate row included.
    const plain = recipeNode("p", 0, 0, mkRecipe("p", ["a"], ["b"]));
    const env: RFAnyNode = {
      ...plain,
      id: "e",
      data: {
        ...plain.data,
        recipe: { ...plain.data.recipe, environment: "acidic" },
      },
    };
    const bare = rawCardRects([plain])[0]!;
    const plated = rawCardRects([env])[0]!;
    expect(plated.left).toBe(bare.left);
    expect(plated.right).toBe(bare.right);
    expect(plated.top).toBe(bare.top);
    expect(plated.bottom - bare.bottom).toBe(ENV_ROW_HEIGHT);
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
    expect(railY! <= gTop - clearance || railY! >= gBottom + clearance).toBe(
      true,
    );
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

  it("jogs a blocked small-dy leg, whose closing horizontal crosses a foreign card", () => {
    // The small-dy diagonal still closes on a long horizontal at the target y,
    // and that leg can slice a card exactly like the normal step's (a group
    // input feeding a container member one row off its own port y). The scan
    // has to cover it: legY stamped, and the drawn path clear of the card.
    const nodes: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 100, 148, 78), // right 148, port y 139
      inputProductNode("t", "ore", 760, 87, 148, 78), // left 760, port y 126
      inputProductNode("mid", "ore", 400, 60, 148, 78), // y 60..138 holds 126
    ];
    const edges: Edge[] = [
      {
        ...mkEdge("e0", "s", "t", "ore"),
        data: { item: "ore", rate: new Fraction(1), bendX: 200 },
      },
    ];
    const out = jogForwardLegs(nodes, edges);
    const legY = legYOf(out, "e0");
    expect(legY).toBeDefined();
    expect(legY).not.toBe(126); // moved off the target port y

    const [d] = chamferStepPath({
      sourceX: 148,
      sourceY: 139,
      targetX: 760,
      targetY: 126,
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

  it("passes a clear small-dy edge through by reference", () => {
    const nodes: RFAnyNode[] = [
      inputProductNode("s", "ore", 0, 100, 148, 78),
      inputProductNode("t", "ore", 760, 87, 148, 78),
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

  // The SOURCE-side column of a jog (srcColX). A card straddling the source row
  // between the port and the bend column is what stamps one: the step leaves sy
  // at this column instead of running to the bend first.
  describe("the jogged source column", () => {
    const srcColXOf = (edges: Edge[], id: string): number | undefined =>
      (edges.find((e) => e.id === id)?.data as { srcColX?: number } | undefined)
        ?.srcColX;

    // s -> t across three layers, with a card of the middle layer straddling
    // the source row: the source horizontal at sy is the blocked piece, the
    // final leg at ty is clear.
    const fixture = (): { nodes: RFAnyNode[]; edges: Edge[] } => ({
      nodes: [
        inputProductNode("s", "ore", 0, 0, 148, 78), // right 148, port y 39
        inputProductNode("blk", "ore", 300, 0, 148, 78), // straddles the source row
        inputProductNode("t", "ore", 1200, 400, 148, 78), // left 1200, port y 439
      ],
      edges: [
        {
          ...mkEdge("e0", "s", "t", "ore"),
          data: { item: "ore", rate: new Fraction(1), bendX: 700 },
        },
      ],
    });

    it("keeps the pre-zone column with no gap records", () => {
      const { nodes, edges } = fixture();
      // No ctx: the column is the old default, one stub plus a chamfer out of
      // the source port -- byte-identical for a caller running the pass alone.
      expect(srcColXOf(jogForwardLegs(nodes, edges), "e0")).toBe(
        148 + PORT_STUB + CHAMFER,
      );
    });

    it("stands in the column zone of the gap right of its source layer", () => {
      const { nodes, edges } = fixture();
      const widened = widenLayerGaps(nodes, edges);
      const out = jogForwardLegs(widened.nodes, edges, { gaps: widened.gaps });
      const srcColX = srcColXOf(out, "e0")!;
      // Premise: the pass really did re-column this edge.
      expect(typeof srcColX).toBe("number");
      // The source sits in the first layer, so its departing runs stand in the
      // first gap -- inside its column zone, never in the chip reserve the gap
      // was widened for.
      const gap = widened.gaps[0]!;
      expect(srcColX).toBeGreaterThanOrEqual(gap.columnZone.left);
      expect(srcColX).toBeLessThanOrEqual(gap.columnZone.right);
      expect(srcColX).toBeGreaterThan(gap.sourceZone.right - 1e-6);
    });
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

describe("edgePortsModel", () => {
  it("reads the source out-port and target in-port rows in the model frame", () => {
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 148, 60),
      productNode("t", 400, 100, 148, 60),
    ];
    const ports = edgePortsModel(
      mkEdge("e0", "s", "t", "w"),
      nodeIndexOf(nodes),
    );
    // Product rows fall back to the node's vertical centre on both sides.
    expect(ports).toEqual({ sx: 148, sy: 30, tx: 400, ty: 130 });
  });

  it("yields no port coordinates when an endpoint is missing from the node index", () => {
    const byId = nodeIndexOf([productNode("s", 0, 0, 148, 60)]);
    expect(edgePortsModel(mkEdge("e0", "s", "t", "w"), byId)).toBeNull();
  });
});

// Column families that no single pass owns: a trunk's pre-stamped rail column,
// an arrival slot, a jog descent and another rail's column are placed by four
// different passes, and two of them a few units apart draw as one thick line.
// The rule is that the rail yields (it is the last column resolved) except
// where routeTrunkEdges pinned it, where the stagger yields instead.
describe("column families keep the pitch floor off each other", () => {
  const railOf = (edges: Edge[], id: string) =>
    routingHintsFromData(edges.find((e) => e.id === id)?.data);

  it("stakes no arrival slot on a trunk's pre-stamped backward rail column", () => {
    // A backward member of a trunk carries its rail on the trunk's junction
    // column and cannot move, so the arrival stagger is what keeps the floor.
    // The two flows enter different port rows, so they own separate slots.
    const feed = mkRecipe("feed", [], ["b"]);
    const sink = mkRecipe("sink", ["b", "d"], ["c"]);
    const back = mkRecipe("back", ["c"], ["d"]);
    const nodes: RFAnyNode[] = [
      recipeNode("t", 500, 0, sink),
      recipeNode("s", 0, 200, feed),
      recipeNode("r", 1000, 400, back),
    ];
    const forward = mkEdge("eF", "s", "t", "b");
    const returning = mkEdge("eR", "r", "t", "d");
    const widened = widenLayerGaps(nodes, [forward, returning]);
    const ctx = { gaps: widened.gaps };

    // Where the stagger seats the forward arrival with nothing pinned.
    const free = assignEntryColumns(widened.nodes, [forward, returning], ctx);
    const natural = railOf(free, "eF").entryX;
    expect(natural).toBeDefined();

    // Pin the return's rail half a floor off that column, the shape the trunk
    // pass produces when its junction lands beside an arrival.
    const pin = natural! - ENTRY_SLOT_PITCH / 2;
    const pinned = {
      ...returning,
      data: { ...returning.data, railXLeft: pin },
    };
    const out = assignEntryColumns(widened.nodes, [forward, pinned], ctx);
    const moved = railOf(out, "eF").entryX;
    expect(moved).toBeDefined();
    expect(Math.abs(moved! - pin)).toBeGreaterThanOrEqual(ENTRY_SLOT_PITCH);
    // The rail itself is untouched: assignEntryColumns stamps no rail column.
    expect(railOf(out, "eR").railXLeft).toBe(pin);
  });

  it("moves a backward rail's column off a jog descent column", () => {
    // The jog runs before the rail clamp, so its descent column is fixed and
    // the rail is the one that steps aside.
    const feed = mkRecipe("feed", [], ["b"]);
    const sink = mkRecipe("sink", ["b"], ["c"]);
    const back = mkRecipe("back", ["c"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("t", 600, 0, sink),
      recipeNode("s", 0, 0, feed),
      recipeNode("r", 1200, 400, back),
    ];
    const returning = mkEdge("eR", "r", "t", "b");
    // Where the rail's left column lands with nothing else in the corridor.
    const alone = clampBackwardRails(nodes, [returning]);
    const bare = railOf(alone, "eR").railXLeft ?? 600 - PORT_STUB;

    // A forward edge whose jog descends on that exact column.
    const plain = mkEdge("eF", "s", "t", "b");
    const jogged: Edge = {
      ...plain,
      data: { ...plain.data, legY: 260, jogDescentX: bare },
    };
    const out = clampBackwardRails(nodes, [jogged, returning]);
    const railX = railOf(out, "eR").railXLeft ?? bare;
    expect(Math.abs(railX - bare)).toBeGreaterThanOrEqual(ENTRY_SLOT_PITCH);
    // The jog keeps its column: only the rail moved.
    expect(railOf(out, "eF").jogDescentX).toBe(bare);
  });

  it("gives two backward rails sharing a corridor distinct columns", () => {
    // Two returns whose sources share a layer take the same default column.
    // Their right-hand verticals overlap in y here, so the two would draw as
    // one line for the length of that overlap.
    const sink = mkRecipe("sink", ["b"], ["c"]);
    const back = mkRecipe("back", ["c"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("t1", 0, 500, sink),
      recipeNode("t2", 0, 900, sink),
      recipeNode("s1", 900, 0, back),
      recipeNode("s2", 900, 200, back),
    ];
    const edges = [
      mkEdge("e0", "s1", "t1", "b"),
      mkEdge("e1", "s2", "t2", "b"),
    ];
    const out = clampBackwardRails(nodes, edges);
    const defaultRight = 900 + RECIPE_WIDTH + PORT_STUB;
    const rightA = railOf(out, "e0").railXRight ?? defaultRight;
    const rightB = railOf(out, "e1").railXRight ?? defaultRight;
    expect(Math.abs(rightA - rightB)).toBeGreaterThanOrEqual(ENTRY_SLOT_PITCH);
  });

  it("gives two backward rails preferring one level distinct levels", () => {
    // Mirrored returns: each rail's preferred level is the midpoint of its own
    // two ports, and the mirror makes both midpoints the same. Their
    // horizontal runs span the same corridor, so one has to move.
    const sink = mkRecipe("sink", ["b"], ["c"]);
    const back = mkRecipe("back", ["c"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("t1", 0, 0, sink),
      recipeNode("t2", 0, 400, sink),
      recipeNode("s1", 900, 0, back),
      recipeNode("s2", 900, 400, back),
    ];
    const edges = [
      mkEdge("e0", "s1", "t2", "b"),
      mkEdge("e1", "s2", "t1", "b"),
    ];
    const byId = nodeIndexOf(nodes);
    const preferredOf = (edge: Edge): number => {
      const ports = edgePortsModel(edge, byId)!;
      return (ports.sy + ports.ty) / 2;
    };
    // Premise: the two rails really do want the same level, so the assertion
    // below is about the deconfliction and not about the fixture.
    expect(preferredOf(edges[0]!)).toBe(preferredOf(edges[1]!));

    const out = clampBackwardRails(nodes, edges);
    // One rail keeps its preferred level (unstamped) and the other steps off
    // it, so read each level through its own default.
    const levelA = railOf(out, "e0").railY ?? preferredOf(edges[0]!);
    const levelB = railOf(out, "e1").railY ?? preferredOf(edges[1]!);
    expect(Math.abs(levelA - levelB)).toBeGreaterThanOrEqual(CHAMFER);
  });

  it("separates two backward rails whose preferred levels are 2px apart", () => {
    // The near-miss case: two rails in one corridor that want levels a couple
    // of pixels apart still draw as one line, so the level a placed rail
    // occupies has to block its whole clearance band, not just the exact y.
    const sink = mkRecipe("sink", ["b"], ["c"]);
    const back = mkRecipe("back", ["c"], ["b"]);
    // t2 sits 4 units below the mirrored position, which moves e0's midpoint
    // level by 2.
    const nodes: RFAnyNode[] = [
      recipeNode("t1", 0, 0, sink),
      recipeNode("t2", 0, 404, sink),
      recipeNode("s1", 900, 0, back),
      recipeNode("s2", 900, 400, back),
    ];
    const edges = [
      mkEdge("e0", "s1", "t2", "b"),
      mkEdge("e1", "s2", "t1", "b"),
    ];
    const byId = nodeIndexOf(nodes);
    const preferredOf = (edge: Edge): number => {
      const ports = edgePortsModel(edge, byId)!;
      return (ports.sy + ports.ty) / 2;
    };
    // Premise: the two preferred levels are a hair apart, not equal.
    expect(preferredOf(edges[0]!) - preferredOf(edges[1]!)).toBe(2);

    const out = clampBackwardRails(nodes, edges);
    const levelA = railOf(out, "e0").railY ?? preferredOf(edges[0]!);
    const levelB = railOf(out, "e1").railY ?? preferredOf(edges[1]!);
    expect(Math.abs(levelA - levelB)).toBeGreaterThanOrEqual(CHAMFER);
  });
});
