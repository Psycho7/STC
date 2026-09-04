// Short-leg rate chips (issue #41, direction C). A rendered rate chip is ~99-110
// graph units wide, so an edge whose polyline lacks the USABLE WIDTH for its own
// chip's box -- the x-extent a wide horizontal box can slide along, measured
// against the width THIS chip's text reserves at natural scale -- has nowhere on
// its own line to hold the full box: seatRateChip's slide clamps to the arc,
// leaving the anchor as the only candidate, and the box buries the endpoint
// cards. deconflictChipAnchors stamps chipIconOnly on such an edge so ItemEdge
// collapses the chip to its icon-only variant (the exact rate survives on the
// hover title). The rule is per chip: a short rate text reserves a narrow box,
// so a corridor the widest chip cannot use may still hold it.

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

// chipSeating's own CHIP_HALF_W_WIDE (MAX_CHIP_SCALE * CHIP_BOX_WIDTH / 2),
// which the fan-out BRANCH short-leg rule USED to gate on as SHORT_LEG_MAX
// (both the item and the branch rule now gate on the per-chip natural width;
// see usableWidthCollapses). Mirrored here (the module does not export it).
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

// Three item edges across ONE 118-unit corridor (the exam finding's geometry,
// default e:1 / e:2 / e:4): rows at separate y bands so their cards never meet,
// one straight leg and two whose target sits 17 units below / above the source
// port, so the leg steps (H run, chamfer, V run, chamfer, H run). Reports each
// row's drawn leg as parsed points so the test can state its own premises.
const CORRIDOR_GAP = 126; // card-edge gap -> an 118-unit port-to-port corridor
const corridorFixture = (): {
  nodes: RFAnyNode[];
  edges: Edge[];
  legs: Array<{ pts: ReadonlyArray<readonly [number, number]> }>;
} => {
  const rows = [0, 200, 400];
  const dys = [0, 17, -17];
  const nodes: RFAnyNode[] = [];
  const edges: Edge[] = [];
  const legs: Array<{ pts: ReadonlyArray<readonly [number, number]> }> = [];
  rows.forEach((rowY, i) => {
    const srcX = 0;
    const tgtX = srcX + CARD_W + CORRIDOR_GAP;
    nodes.push(productNode(`s${i}`, srcX, rowY, CARD_W, CARD_H));
    nodes.push(productNode(`t${i}`, tgtX, rowY + dys[i]!, CARD_W, CARD_H));
    const id = `e:${i}:s${i}->t${i}:w`;
    edges.push({
      id,
      type: "item",
      source: `s${i}`,
      target: `t${i}`,
      data: { item: "w", rate: new Fraction(3) },
    });
    // The drawn polyline, from the same path builder chipSeating reconstructs
    // it with (rowFixture's contract).
    const [d] = chamferStepPath({
      sourceX: srcX + CARD_W + PRODUCT_DX,
      sourceY: rowY + CARD_H / 2,
      targetX: tgtX - PRODUCT_DX,
      targetY: rowY + dys[i]! + CARD_H / 2,
    });
    legs.push({ pts: parsePathPoints(d) });
  });
  return { nodes, edges, legs };
};

// Arc length of a reconstructed polyline, the measure the BRANCH short-leg
// rule is stated in (chipSeating sums the same segments), and the x-extent the
// ITEM rule gates on (chipSeating's usableWidthCollapses spans the same
// points).
const polylineLength = (
  pts: ReadonlyArray<readonly [number, number]>,
): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return len;
};

const polylineXExtent = (
  pts: ReadonlyArray<readonly [number, number]>,
): number => {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  return maxX - minX;
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
    // Premise: no seat fits -- the leg is shorter than THIS chip's own reserved
    // width at natural scale (94.5 for a "180/min" body), the per-chip bound
    // the collapse gates on, not the widest box the CSS clamp allows.
    expect(legLen).toBeLessThan(
      (2 * chipSeatHalfW({ body: "180", unit: true }, false)) / MAX_CHIP_SCALE,
    );

    const out = deconflictChipAnchors(nodes, edges);
    expect(iconOnlyOf(out, "e:1:src->tgt:w")).toBe(true);
  });

  it("classifies straight and dogleg siblings across one corridor identically", () => {
    // The exam finding (default e:1/e:2/e:4, "ferrium-leg-icon-only-while-
    // twin-leg-labelled"): three legs across one 118-unit corridor. Under the
    // old TOTAL-ARC-LENGTH gate the straight leg (arc 118 < the 120 threshold)
    // collapsed to its icon while both dogleg twins (arc 125.6 apiece: the same
    // corridor plus their 17-unit steps and chamfers) kept full chips -- yet
    // every leg offers the SAME 118 units of horizontal run, and the doglegs'
    // per-segment runs are SHORTER than the straight one's. Arc length counts
    // vertical travel a horizontal chip cannot use; the collapse must read the
    // corridor's x-extent against the chip's own reserved width instead.
    const { nodes, edges, legs } = corridorFixture();
    const arcs = legs.map((l) => polylineLength(l.pts));
    const extents = legs.map((l) => polylineXExtent(l.pts));
    // Premises, old rule's split first: the straight leg measured under the
    // threshold, both doglegs over it (why this test is red at the arc gate).
    expect(arcs[0]).toBeLessThan(CHIP_HALF_W_WIDE);
    expect(arcs[1]).toBeGreaterThanOrEqual(CHIP_HALF_W_WIDE);
    expect(arcs[2]).toBeGreaterThanOrEqual(CHIP_HALF_W_WIDE);
    // ...and the new rule's: one corridor, three times over, all wider than
    // this chip's own box ("180/min" reserves 94.5), so all three carry it.
    expect(extents[0]).toBe(extents[1]);
    expect(extents[0]).toBe(extents[2]);
    expect(extents[0]).toBeGreaterThan(
      (2 * chipSeatHalfW({ body: "180", unit: true }, false)) / MAX_CHIP_SCALE,
    );

    const out = deconflictChipAnchors(nodes, edges);
    const flags = edges.map((e) => iconOnlyOf(out, e.id));
    expect(new Set(flags).size).toBe(1); // identical for all three siblings
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

  it("pins the tier-1 slide drift: a realistic-box clash slides exactly one step", () => {
    // Same chain, but a 7-glyph body ("1234.57") widens the estimated box to
    // 124.5px natural: two of those need 249 of centre separation against the
    // 239 the chain provides, so the later chip must move. One 24-unit slide
    // step buys back the 10 missing, so the stamped drift is EXACTLY one step
    // on one chip - the fixture-level numeric pin the corpus drift
    // re-measurements lacked.
    const { nodes, edges } = chainFixture(130);
    const wide = edges.map((e) => ({
      ...e,
      data: { ...(e.data as object), rate: new Fraction(123457, 6000) },
    }));
    const anchors = wide.map((e) => chipAnchorOf(nodes, e));
    const apart = Math.abs(anchors[1]! - anchors[0]!);
    const half = chipSeatHalfW({ body: "1234.57", unit: true }, false);
    expect(2 * half - apart).toBeCloseTo(10, 5); // premise: 10-unit clash

    const out = deconflictChipAnchors(nodes, wide);
    const dataOf = (id: string) =>
      out.find((e) => e.id === id)?.data as
        | { labelDx?: number; labelDy?: number }
        | undefined;
    const drifts = wide.map((e) => dataOf(e.id)?.labelDx);
    // One chip keeps its anchor, the other slides exactly one 24-unit step;
    // nothing leaves the horizontal leg.
    expect(drifts.filter((d) => d === undefined)).toHaveLength(1);
    expect(drifts.filter((d) => d !== undefined && Math.abs(d) === 24)).toHaveLength(1);
    for (const e of wide) expect(dataOf(e.id)?.labelDy).toBeUndefined();
  });
});

// The same rule for a fan-out trunk's per-member BRANCH chip (issue #50). A
// member whose whole polyline is shorter than one chip has no seat on its own
// leg that keeps the full box off the trunk's split dot -- the box is wider than
// the leg, so wherever it slides it still swallows the dot. Collapsing it to the
// icon-only variant makes the box narrow enough for the dot keep-off to seat it
// clear; the rate stays readable on the chip's title / aria-label.

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
  levelExtent: number;
  downExtent: number;
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
  // The x-extent of one member's OWN leg -- the suffix after the junction,
  // which the branch short-leg rule gates on (the whole-polyline arc length
  // the old rule read is reported alongside as the premise it used to be).
  const extentOf = (tgt: RFRecipeNode, id: string): number => {
    const fan = chamferFanoutPath({
      ...drawnFanEnds(src, tgt),
      ...routingHintsFromData(fanDataOf(routed, id)),
    });
    const pts = parsePathPoints(fan.path);
    let i = 1;
    while (i < pts.length && pts[i]![0] < fan.junction.x) i++;
    const suffix = [
      [fan.junction.x, fan.junction.y] as const,
      ...pts.slice(i + 1),
    ];
    return polylineXExtent(suffix);
  };
  return {
    nodes,
    routed,
    levelExtent: extentOf(level, "e:1"),
    downExtent: extentOf(down, "e:2"),
  };
};

// A two-member fan-out trunk in a ROOMY corridor with a 13-unit RISER member
// (rot-bottled_food_3's Sandleaf shape, Task 8): the source ports at the row,
// one consumer's drawn in-port sits 13 units ABOVE the drawn out-port -- a
// single-diagonal branch, far too little vertical for its own chip -- and the
// other 300 below (an ordinary long leg that keeps the trunk multi-member, so
// no aggregate chip rides it). The corridor is wide enough that the member's
// WHOLE polyline (shared trunk prefix included) clears one max-scale chip box,
// which is what let the old arc-length stamp vouch for the riser's full box.
const RISER_GAP = 158; // card-edge gap -> a 150-unit port-to-port corridor
const RISER_DY = 13;
const riserFixture = (): {
  nodes: RFAnyNode[];
  routed: Edge[];
  src: RFRecipeNode;
  riser: RFRecipeNode;
  down: RFRecipeNode;
} => {
  const src = fanProducer("src", 0, 0);
  const tgtX = nodeWidth(src) + RISER_GAP;
  // Place the riser consumer so its DRAWN in-port y sits RISER_DY above the
  // drawn out-port y (the port drift cancels: both rows resolve the item).
  const probe = fanConsumer("riser", tgtX, 0);
  const riserY =
    portOffsetY(src, FAN_ITEM, "out") -
    RISER_DY -
    portOffsetY(probe, FAN_ITEM, "in");
  const riser = fanConsumer("riser", tgtX, riserY);
  const down = fanConsumer("down", tgtX, riserY + RISER_DY + 300);
  const nodes: RFAnyNode[] = [src, riser, down];
  const routed = routeFanoutEdges(nodes, [
    fanEdge("e:1", "src", "riser"),
    fanEdge("e:2", "src", "down"),
  ]);
  return { nodes, routed, src, riser, down };
};

// The riser member's drawn polyline and its post-junction suffix (the sub-
// polyline its branch chip owns: junction vertex -> diagonal -> target port),
// from the same path builder and hints the seating pass reconstructs with.
const riserGeometry = (
  fixture: ReturnType<typeof riserFixture>,
): {
  pts: ReadonlyArray<readonly [number, number]>;
  suffix: ReadonlyArray<readonly [number, number]>;
  junction: { x: number; y: number };
  branchAnchor: { x: number; y: number };
} => {
  const fan = chamferFanoutPath({
    ...drawnFanEnds(fixture.src, fixture.riser),
    ...routingHintsFromData(fanDataOf(fixture.routed, "e:1")),
  });
  const pts = parsePathPoints(fan.path);
  // Slice at the junction vertex: the first vertex at or beyond the junction's
  // x on the shared row (mirrors the stamper's own slice, without borrowing it).
  let i = 1;
  while (i < pts.length && pts[i]![0] < fan.junction.x) i++;
  return {
    pts,
    suffix: [[fan.junction.x, fan.junction.y] as const, ...pts.slice(i + 1)],
    junction: fan.junction,
    branchAnchor: fan.branchAnchor,
  };
};

// The riser fixture plus one FOREIGN item edge running horizontally across
// the corridor three units above the trunk candidates' box band and inside
// every leg-side candidate's band: the push that the confinement is tested
// against. A foreign stroke through a box is a HARD tier-1 blocker, so at HEAD
// (seat on the whole polyline) the only fully-clear on-line candidates are on
// the shared trunk prefix; on the member's own leg the same stroke blocks the
// anchor and the whole 13-unit riser.
const riserPushFixture = (): {
  nodes: RFAnyNode[];
  routed: Edge[];
  src: RFRecipeNode;
  riser: RFRecipeNode;
  lineY: number;
  sy: number;
} => {
  const base = riserFixture();
  const sy = drawnFanEnds(base.src, base.riser).sourceY;
  const lineY = sy - 27;
  const fs = productNode("fs", -1054, lineY - CARD_H / 2, CARD_W, CARD_H);
  const ft = productNode("ft", 1000, lineY - CARD_H / 2, CARD_W, CARD_H);
  const nodes: RFAnyNode[] = [...base.nodes, fs, ft];
  const edges: Edge[] = [
    ...base.routed,
    {
      id: "f:1",
      type: "item",
      source: "fs",
      target: "ft",
      data: { item: "z", rate: new Fraction(1) },
    },
  ];
  return { nodes, routed: edges, src: base.src, riser: base.riser, lineY, sy };
};

describe("deconflictChipAnchors: short-leg fan-out branch chips", () => {
  it("stamps fanoutBranchIconOnly on a branch shorter than one chip", () => {
    const { nodes, routed, levelExtent, downExtent } = fanoutFixture();
    // Premises: the trunk really formed, and NEITHER member's OWN leg -- the
    // suffix after the junction, the run each branch chip actually draws on --
    // holds this chip's reserved width ("1"/min reserves 79.5). Task 8
    // re-derivation: the gate used to read the whole-polyline arc length, so
    // the down member's 400-unit vertical kept its full chip; on its own leg
    // that vertical offers no horizontal run a wide box can use, so both
    // members collapse now (and the collapse is what lets each seat clear the
    // split dot on the narrow corridor).
    expect(routed.map((e) => e.type)).toEqual(["bus", "bus"]);
    const reserved =
      (2 * chipSeatHalfW({ body: "1", unit: true }, false)) / MAX_CHIP_SCALE;
    expect(levelExtent).toBeLessThan(reserved);
    expect(downExtent).toBeLessThan(reserved);

    const seated = deconflictChipAnchors(nodes, routed);
    expect(fanDataOf(seated, "e:1").fanoutBranchIconOnly).toBe(true);
    expect(fanDataOf(seated, "e:2").fanoutBranchIconOnly).toBe(true);
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

  it("collapses a long-trunk riser whose own leg cannot hold its chip", () => {
    // The rot-bottled_food_3 finding (Task 8): a 13-unit diagonal branch off a
    // long trunk. The member's WHOLE polyline (shared trunk prefix included)
    // spans more than one max-scale chip box, so the old TOTAL-ARC-LENGTH stamp
    // never fired and the seat reserved a full "300/min" box on a leg whose own
    // horizontal run is a fraction of it -- every seat on the leg buries the
    // trunk's split dot, and the box reads as a trunk label. The gate now
    // measures the member's OWN leg (the suffix after the junction) against the
    // width THIS chip reserves, exactly the item rule's usable-width bound.
    const fixture = riserFixture();
    const geom = riserGeometry(fixture);
    // Premises: the trunk really formed, the branch really is a 13-unit riser,
    // and the drawn geometry separates the two rules -- the whole polyline
    // clears one chip box (the old rule's bound, why this was red there) while
    // the member's own leg does not clear THIS chip's reserved width.
    expect(fixture.routed.map((e) => e.type)).toEqual(["bus", "bus"]);
    const ends = drawnFanEnds(fixture.src, fixture.riser);
    expect(Math.abs(ends.targetY - ends.sourceY)).toBe(RISER_DY);
    expect(polylineLength(geom.pts)).toBeGreaterThanOrEqual(CHIP_HALF_W_WIDE);
    expect(polylineXExtent(geom.suffix)).toBeLessThan(
      (2 * chipSeatHalfW({ body: "300", unit: true }, false)) / MAX_CHIP_SCALE,
    );

    const seated = deconflictChipAnchors(fixture.nodes, fixture.routed);
    expect(fanDataOf(seated, "e:1").fanoutBranchIconOnly).toBe(true);
  });

  it("seats a pushed branch chip on its own leg, never back across the junction", () => {
    // The confinement half of the Task 8 fix: the branch seat used to slide
    // over the WHOLE polyline, trunk prefix included, so a branch chip pushed
    // off its anchor walked back across the junction and parked on the shared
    // trunk -- its box reading as a trunk label stood at the split. The push
    // here is a foreign stroke crossing the corridor: it is a HARD tier-1
    // blocker, it sits inside every leg-side candidate's box band (the whole
    // leg is a 13-unit riser, so every leg candidate's box reaches it) and
    // outside the trunk candidates' band, so on the full polyline the only
    // fully-clear seats are on the shared prefix. On the member's OWN leg the
    // same push has nowhere left to go: the chip keeps its anchor (graze) or
    // slides within the leg, and never crosses the junction column.
    const fixture = riserPushFixture();
    const geom = riserGeometry({
      nodes: fixture.nodes,
      routed: fixture.routed,
      src: fixture.src,
      riser: fixture.riser,
      down: fixture.riser, // unused by riserGeometry
    });
    // Premises: the trunk formed, the riser is a 13-unit diagonal, and the
    // foreign line really is the push described -- inside the leg band (any
    // leg candidate's box reaches up to 24 past the riser's top row) and clear
    // of the trunk band.
    expect(fixture.routed.slice(0, 2).map((e) => e.type)).toEqual([
      "bus",
      "bus",
    ]);
    expect(Math.abs(fixture.lineY - fixture.sy)).toBe(27);
    expect(Math.abs(fixture.lineY - (fixture.sy - RISER_DY))).toBeLessThan(
      CHIP_HALF_W_ICON,
    );
    expect(Math.abs(fixture.lineY - fixture.sy)).toBeGreaterThan(
      CHIP_HALF_W_ICON,
    );

    const seated = deconflictChipAnchors(fixture.nodes, fixture.routed);
    const data = fanDataOf(seated, "e:1");
    expect(data.fanoutBranchHidden).toBeUndefined(); // the chip still draws
    const cx =
      (geom.branchAnchor.x as number) + ((data.fanoutBranchDx as number) ?? 0);
    expect(cx).toBeGreaterThanOrEqual(geom.junction.x);
  });
});
