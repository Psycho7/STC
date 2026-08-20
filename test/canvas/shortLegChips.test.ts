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

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { chamferStepPath, parsePathPoints } from "../../src/canvas/edgePath";
import type { RFAnyNode } from "../../src/canvas/layout";
import { productNode } from "./busRouting.testkit";

// chipSeating's own CHIP_HALF_W_WIDE (MAX_CHIP_SCALE * CHIP_BOX_WIDTH / 2), the
// short-leg threshold SHORT_LEG_MAX is defined as. Mirrored here (the module
// does not export it), as faninMarkers.test.ts mirrors it.
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
  const pts = parsePathPoints(d);
  let legLen = 0;
  for (let i = 1; i < pts.length; i++) {
    legLen += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  return { nodes, edges, legLen };
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
});
