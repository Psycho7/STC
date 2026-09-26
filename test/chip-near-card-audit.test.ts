// The near-card counter reads zero on every corpus plan, so a synthetic fixture
// is the only thing that shows it can fire. Kept out of test/e2e/ like the
// trunk leg audit suite: the counter is a pure function with no Playwright
// runtime behind it.
import { describe, expect, it } from "vitest";

import { CHIP_CARD_CLEARANCE } from "../src/canvas/edgePath";
import {
  auditChipNearCard,
  type ChipRect,
  type NodeRect,
  type RawEdge,
} from "./e2e/geometry";

// Source card A at the left, target card B at the right, and a foreign card F
// between them, well below the row the edge runs on.
//
//   [A] ------- e:1 ------- [B]
//
//            [F]
const cardA: NodeRect = {
  nodeId: "A",
  type: "machine",
  left: 0,
  right: 100,
  top: 0,
  bottom: 60,
};
const cardB: NodeRect = {
  nodeId: "B",
  type: "machine",
  left: 600,
  right: 700,
  top: 0,
  bottom: 60,
};
const cardF: NodeRect = {
  nodeId: "F",
  type: "machine",
  left: 300,
  right: 400,
  top: 300,
  bottom: 360,
};
const nodes = [cardA, cardB, cardF];

const edge: RawEdge = {
  id: "e:1",
  source: "A",
  target: "B",
  item: "iron",
  d: "M 100,30 L 600,30",
};

const CHIP_HALF_W = 20;
const CHIP_HALF_H = 8;

function chip(centre: readonly [number, number]): ChipRect {
  const [cx, cy] = centre;
  return {
    edgeId: edge.id,
    testId: `bus-edge-${edge.id}`,
    label: "iron chip",
    kind: "label",
    iconOnly: false,
    left: cx - CHIP_HALF_W,
    right: cx + CHIP_HALF_W,
    top: cy - CHIP_HALF_H,
    bottom: cy + CHIP_HALF_H,
  };
}

describe("auditChipNearCard", () => {
  it("flags a chip inside the clearance of a foreign card", () => {
    // Bottom edge half the clearance above F's top.
    const gap = CHIP_CARD_CLEARANCE / 2;
    const nearF = chip([350, cardF.top - gap - CHIP_HALF_H]);

    const hits = auditChipNearCard([nearF], [edge], nodes);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chipEdgeId).toBe(edge.id);
    expect(hits[0]!.detail).toContain("card F");
  });

  it("passes a chip clear of every card", () => {
    const clear = chip([350, 30]);

    expect(auditChipNearCard([clear], [edge], nodes)).toHaveLength(0);
  });

  it("exempts a chip flush against its own endpoint card", () => {
    // Left edge touching A's right edge: a zero gap, but A is the chip's own
    // source card.
    const besideA = chip([cardA.right + CHIP_HALF_W, 30]);

    expect(auditChipNearCard([besideA], [edge], nodes)).toHaveLength(0);
  });
});
