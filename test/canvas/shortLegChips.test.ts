// Short-leg rate chips (issue #41, direction C). A rendered rate chip is ~99-110
// graph units wide, so an edge whose WHOLE polyline is shorter than one chip has
// nowhere on its own line to hold the full box -- seatRateChip's slide clamps to
// the arc, leaving the anchor as the only candidate, and the box buries the
// endpoint cards. deconflictChipAnchors stamps chipIconOnly on such an edge so
// ItemEdge collapses the chip to its icon-only variant (the exact rate survives
// on the hover title).

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  chipSeatHalfW,
  deconflictChipAnchors,
} from "../../src/canvas/chipSeating";
import {
  chamferStepPath,
  chamferFanoutPath,
  parsePathPoints,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { routeFanoutEdges } from "../../src/canvas/busRouting";
import { nodeWidth, portOffsetY } from "../../src/canvas/nodeGeometry";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import {
  productNode,
  recipeNode,
  orderedRecipeNode,
  mkRecipe,
} from "./busRouting.testkit";

// chipSeating's own CHIP_HALF_W_WIDE (MAX_CHIP_SCALE * CHIP_BOX_WIDTH / 2), the
// short-leg threshold SHORT_LEG_MAX is defined as. Mirrored here (the module
// does not export it).
const CHIP_HALF_W_WIDE = 120;

// Product handle drift, from chipSeating's PORT_DRIFT.product: the drawn source
// handle sits 4 units right of the card's right edge, the drawn target handle 4
// units left of the card's left edge.
const PRODUCT_DX = 4;

const CARD_W = 100;
const CARD_H = 60;
const CARD_Y = 0;

// Two product cards on one row, `gap` graph units apart, and the item edge
// between them. Equal heights put both ports at the same y, so the drawn leg is
// one straight horizontal run whose length the test can measure.
const rowFixture = (
  gap: number,
): { nodes: RFAnyNode[]; edges: Edge[]; legLen: number } => {
  const srcX = 0;
  const tgtX = srcX + CARD_W + gap;
  const nodes: RFAnyNode[] = [
    productNode("src", srcX, CARD_Y, CARD_W, CARD_H),
    productNode("tgt", tgtX, CARD_Y, CARD_W, CARD_H),
  ];
  const edges: Edge[] = [
    {
      id: "e:1:src->tgt:w",
      type: "item",
      source: "src",
      target: "tgt",
      data: { item: "w", rate: new Fraction(3) },
    },
  ];
  // The drawn polyline, from the same path builder chipSeating reconstructs it
  // with, so the premise below measures the real leg rather than assuming it.
  const [d] = chamferStepPath({
    sourceX: srcX + CARD_W + PRODUCT_DX,
    sourceY: CARD_Y + CARD_H / 2,
    targetX: tgtX - PRODUCT_DX,
    targetY: CARD_Y + CARD_H / 2,
  });
  return { nodes, edges, legLen: polylineLength(parsePathPoints(d)) };
};

// Arc length of a reconstructed polyline, the measure both short-leg rules are
// stated in (chipSeating sums the same segments).
const polylineLength = (
  pts: ReadonlyArray<readonly [number, number]>,
): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return len;
};

// Three product cards in a row, each `gap` apart, and the two item edges
// between them: a chain of two short legs whose chips sit close enough to
// contest each other under the WIDE reserve and not under the collapsed one.
const chainFixture = (
  gap: number,
): { nodes: RFAnyNode[]; edges: Edge[] } => {
  const xs = [0, CARD_W + gap, 2 * (CARD_W + gap)];
  const nodes: RFAnyNode[] = xs.map((x, i) =>
    productNode(`n${i}`, x, CARD_Y, CARD_W, CARD_H),
  );
  const edges: Edge[] = [0, 1].map((i) => ({
    id: `e:${i}:n${i}->n${i + 1}:w`,
    type: "item",
    source: `n${i}`,
    target: `n${i + 1}`,
    data: { item: "w", rate: new Fraction(3) },
  }));
  return { nodes, edges };
};

// The chip anchor chamferStepPath puts on an edge of the chain fixture, in the
// drawn frame the seating pass reconstructs.
const chipAnchorOf = (nodes: RFAnyNode[], edge: Edge): number => {
  const src = nodes.find((n) => n.id === edge.source)!;
  const tgt = nodes.find((n) => n.id === edge.target)!;
  const [, lx] = chamferStepPath({
    sourceX: src.position.x + CARD_W + PRODUCT_DX,
    sourceY: CARD_Y + CARD_H / 2,
    targetX: tgt.position.x - PRODUCT_DX,
    targetY: CARD_Y + CARD_H / 2,
  });
  return lx;
};

const iconOnlyOf = (edges: Edge[], id: string): boolean | undefined =>
  (
    edges.find((e) => e.id === id)?.data as
      | { chipIconOnly?: boolean }
      | undefined
  )?.chipIconOnly;

describe("deconflictChipAnchors: short-leg icon-only flag", () => {
  it("stamps chipIconOnly on an edge shorter than one chip", () => {
    // 36 units of corridor -> a 28-unit leg, the shape of battery5's e:8.
    const { nodes, edges, legLen } = rowFixture(36);
    expect(legLen).toBeLessThan(CHIP_HALF_W_WIDE); // premise: no seat fits

    const out = deconflictChipAnchors(nodes, edges);
    expect(iconOnlyOf(out, "e:1:src->tgt:w")).toBe(true);
  });

  it("leaves a full-corridor edge unflagged", () => {
    // 138 units of corridor -> a 130-unit leg, an open-layout corridor.
    const { nodes, edges, legLen } = rowFixture(138);
    expect(legLen).toBeGreaterThanOrEqual(CHIP_HALF_W_WIDE); // premise: it fits

    const out = deconflictChipAnchors(nodes, edges);
    expect(iconOnlyOf(out, "e:1:src->tgt:w")).toBeUndefined();
  });

  it("reserves the collapsed box for the stamped chip, not the wide one", () => {
    // The stamp used to be render-only for ITEM chips: the seat still reserved
    // the 240-wide worst case for a chip that draws 48, which is the largest
    // single conservatism the pass carried (Task 6b). Two short legs in a chain
    // put their chips 136 apart -- inside the 240 of centre separation two wide
    // boxes need, outside the 48 two collapsed ones need. Under the wide
    // reserve the second chip is shoved off its anchor; under the collapsed one
    // both sit where they belong.
    const { nodes, edges } = chainFixture(36);
    const anchors = edges.map((e) => chipAnchorOf(nodes, e));
    // Premise: the two anchors are in exactly that window.
    const apart = Math.abs(anchors[1]! - anchors[0]!);
    expect(apart).toBeGreaterThan(2 * CHIP_HALF_W_ICON);
    expect(apart).toBeLessThan(2 * CHIP_HALF_W_WIDE);

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of edges) {
      expect(iconOnlyOf(out, e.id)).toBe(true); // premise: both collapsed
      const data = out.find((o) => o.id === e.id)?.data as
        | { labelDx?: number; labelDy?: number }
        | undefined;
      expect(data?.labelDx).toBeUndefined();
      expect(data?.labelDy).toBeUndefined();
    }
  });
});

// The rest of the same change (Task 6b): a chip that is NOT collapsed reserves
// the box its own rate text will draw rather than the widest box the CSS clamp
// allows, so two chips the worst case reads as contesting each other are
// actually clear.
describe("deconflictChipAnchors: per-chip reserved box", () => {
  it("leaves two chips at their anchors when only the worst-case box collides", () => {
    // 130 units of corridor -> a 122-unit leg (past the collapse threshold, so
    // both chips draw their digits) with the two anchors 230 apart. Two
    // worst-case boxes need 240 of centre separation and would shove the second
    // chip along its leg; two boxes sized to "180/min" need 189, so neither
    // moves.
    const { nodes, edges } = chainFixture(130);
    const anchors = edges.map((e) => chipAnchorOf(nodes, e));
    const apart = Math.abs(anchors[1]! - anchors[0]!);
    expect(apart).toBeLessThan(2 * CHIP_HALF_W_WIDE); // premise: wide boxes clash
    // ...and estimated ones do not. Taken from the seat's own estimator so a
    // change to the chrome, glyph or unit constants fails here rather than
    // silently invalidating the premise.
    expect(apart).toBeGreaterThan(
      2 * chipSeatHalfW({ body: "180", unit: true }, false),
    );

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of edges) {
      expect(iconOnlyOf(out, e.id)).toBeUndefined(); // premise: neither collapsed
      const data = out.find((o) => o.id === e.id)?.data as
        | { labelDx?: number; labelDy?: number }
        | undefined;
      expect(data?.labelDx).toBeUndefined();
      expect(data?.labelDy).toBeUndefined();
    }
  });
});

// The same rule for a fan-out trunk's per-member BRANCH chip (issue #50). A
// member whose whole polyline is shorter than one chip has no seat on its own
// leg that keeps the full box off the trunk's split dot -- the box is wider than
// the leg, so wherever it slides it still swallows the dot. Collapsing it to the
// icon-only variant makes the box narrow enough for the dot keep-off to seat it
// clear; the share wording stays on the chip's title / aria-label.

const FAN_ITEM = "s";
// chipSeating's PORT_DRIFT.recipe, mirrored here (the module does not export
// it): the drawn out handle sits 5 units right of the model right edge, the in
// handle 3 units left of the model left edge, both a unit below the model row y.
const SRC_DX = 5;
const TGT_DX = -3;
const PORT_DY = 1;

// An icon-only chip is a square: the 16px sprite plus the same 3px padding and
// 1px border the full chip carries (.flow-chip.icon-only in canvas.css), so its
// half-width at max counter-scale is the shared half-HEIGHT. With chipSeating's
// DOT_KEEPOFF this is the separation a collapsed chip needs from a dot.
const CHIP_HALF_W_ICON = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
const DOT_KEEPOFF = 16;

const fanProducer = (id: string, x: number, y: number): RFRecipeNode =>
  recipeNode(id, x, y, mkRecipe(id, [], [FAN_ITEM]));
const fanConsumer = (id: string, x: number, y: number): RFRecipeNode =>
  orderedRecipeNode(id, x, y, [FAN_ITEM]);

const fanEdge = (id: string, source: string, target: string): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item: FAN_ITEM, rate: new Fraction(1) },
});

const drawnFanEnds = (
  src: RFRecipeNode,
  tgt: RFRecipeNode,
): { sourceX: number; sourceY: number; targetX: number; targetY: number } => ({
  sourceX: src.position.x + nodeWidth(src) + SRC_DX,
  sourceY: src.position.y + portOffsetY(src, FAN_ITEM, "out") + PORT_DY,
  targetX: tgt.position.x + TGT_DX,
  targetY: tgt.position.y + portOffsetY(tgt, FAN_ITEM, "in") + PORT_DY,
});

const fanDataOf = (edges: Edge[], id: string): Record<string, unknown> =>
  (edges.find((e) => e.id === id)?.data as Record<string, unknown> | undefined) ??
  {};

// A two-member fan-out trunk in a narrow corridor: one member LEVEL with the
// source port (its whole polyline is the straight 102-unit corridor run, the
// shape of crystal's e:8 and battery5's e:8) and one member far below (trunk +
// a long branch vertical, an ordinary leg). Both members share the corridor, so
// only the leg length differs between them.
const NARROW_GAP = 110;
const fanoutFixture = (): {
  nodes: RFAnyNode[];
  routed: Edge[];
  levelLen: number;
  downLen: number;
} => {
  const src = fanProducer("src", 0, 0);
  const tgtX = nodeWidth(src) + NARROW_GAP;
  // Place the level consumer so its drawn in-port y equals the drawn out-port
  // y: chamferFanoutPath then draws it as a straight trunk with no branch
  // vertical, the corpus survivors' shape.
  const probe = fanConsumer("level", tgtX, 0);
  const levelY =
    portOffsetY(src, FAN_ITEM, "out") - portOffsetY(probe, FAN_ITEM, "in");
  const level = fanConsumer("level", tgtX, levelY);
  const down = fanConsumer("down", tgtX, levelY + 400);
  const nodes: RFAnyNode[] = [src, level, down];
  const routed = routeFanoutEdges(nodes, [
    fanEdge("e:1", "src", "level"),
    fanEdge("e:2", "src", "down"),
  ]);
  const lenOf = (tgt: RFRecipeNode, id: string): number =>
    polylineLength(
      parsePathPoints(
        chamferFanoutPath({
          ...drawnFanEnds(src, tgt),
          ...routingHintsFromData(fanDataOf(routed, id)),
        }).path,
      ),
    );
  return {
    nodes,
    routed,
    levelLen: lenOf(level, "e:1"),
    downLen: lenOf(down, "e:2"),
  };
};

describe("deconflictChipAnchors: short-leg fan-out branch chips", () => {
  it("stamps fanoutBranchIconOnly on a branch shorter than one chip", () => {
    const { nodes, routed, levelLen, downLen } = fanoutFixture();
    // Premises: the trunk really formed, the level member's leg cannot hold the
    // full box, and the branching member's can.
    expect(routed.map((e) => e.type)).toEqual(["bus", "bus"]);
    expect(levelLen).toBeLessThan(CHIP_HALF_W_WIDE);
    expect(downLen).toBeGreaterThanOrEqual(CHIP_HALF_W_WIDE);

    const seated = deconflictChipAnchors(nodes, routed);
    expect(fanDataOf(seated, "e:1").fanoutBranchIconOnly).toBe(true);
    expect(fanDataOf(seated, "e:2").fanoutBranchIconOnly).toBeUndefined();
  });

  it("seats the collapsed branch chip clear of the trunk's split dot", () => {
    // The collapse is load-bearing, not cosmetic: the narrower box is what lets
    // the dot keep-off find a seat ON the leg. The chip stays on its own line
    // (it only slides along it), and the dot it was burying is visible again.
    const { nodes, routed } = fanoutFixture();
    const seated = deconflictChipAnchors(nodes, routed);
    const data = fanDataOf(seated, "e:1");
    expect(data.fanoutBranchHidden).toBeUndefined(); // the chip still draws

    const src = nodes[0] as RFRecipeNode;
    const level = nodes[1] as RFRecipeNode;
    const fan = chamferFanoutPath({
      ...drawnFanEnds(src, level),
      ...routingHintsFromData(data),
    });
    const cx = fan.branchAnchor.x + ((data.fanoutBranchDx as number) ?? 0);
    const cy = fan.branchAnchor.y + ((data.fanoutBranchDy as number) ?? 0);
    expect(Math.abs(cx - fan.junction.x)).toBeGreaterThanOrEqual(
      CHIP_HALF_W_ICON + DOT_KEEPOFF,
    );
    // ...and it did not leave its leg to get there: the seat is on the straight
    // run between the two ports, at the port y.
    expect(cy).toBe(fan.branchAnchor.y);
    expect(cx).toBeGreaterThanOrEqual(drawnFanEnds(src, level).sourceX);
    expect(cx).toBeLessThanOrEqual(drawnFanEnds(src, level).targetX);
  });
});
