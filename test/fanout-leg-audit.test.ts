// The fan-out leg counter measures a member chip against the member's OWN leg,
// not against its whole polyline, so the shared junction column -- part of every
// member's polyline suffix -- stops counting as a legal seat. The rule is worth
// a suite of its own, here rather than under test/e2e/ (Vitest is kept out of
// that directory; the counter is a pure function and pulls in no Playwright
// runtime).
import { describe, expect, it } from "vitest";

import { CHAMFER } from "../src/canvas/edgePath";
import {
  auditFanoutChipsOnOwnLeg,
  type ChipRect,
  type DotRect,
  type RawEdge,
} from "./e2e/geometry";

// One fan-out member, shaped like a real one: the trunk runs right to its
// divergence corner, bevels one chamfer into the shared column at x 600, the
// member descends that column from y 200 to y 400, then runs right to its
// target. The junction dot is drawn at the corner, a chamfer left of the
// column.
const COLUMN_X = 600;
const JUNCTION_X = COLUMN_X - CHAMFER;
const LEG_Y = 400;

const edge: RawEdge = {
  id: "e:1",
  source: "A",
  target: "B",
  item: "iron",
  d: `M 500,192 L ${JUNCTION_X},192 L ${COLUMN_X},200 L ${COLUMN_X},${LEG_Y} L 800,${LEG_Y}`,
};

const dot: DotRect = {
  testId: `bus-junction-${edge.id}`,
  left: JUNCTION_X - 3,
  right: JUNCTION_X + 3,
  top: 189,
  bottom: 195,
};

function chip(
  kind: ChipRect["kind"],
  centre: readonly [number, number],
): ChipRect {
  const [cx, cy] = centre;
  return {
    edgeId: edge.id,
    testId: `bus-edge-${edge.id}`,
    label: `${kind} chip`,
    kind,
    iconOnly: false,
    left: cx - 20,
    right: cx + 20,
    top: cy - 8,
    bottom: cy + 8,
  };
}

describe("auditFanoutChipsOnOwnLeg", () => {
  it("flags a label chip parked on the shared junction column", () => {
    const onColumn = chip("label", [COLUMN_X, 300]);

    const hits = auditFanoutChipsOnOwnLeg([onColumn], [edge], [dot]);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chipEdgeId).toBe(edge.id);
    // The leg opens where the column meets the leg row, so a column seat
    // measures the whole drop to that row.
    expect(hits[0]!.distance).toBeCloseTo(100, 6);
  });

  it("flags a bus chip parked on the shared junction column", () => {
    const onColumn = chip("bus", [COLUMN_X, 300]);

    const hits = auditFanoutChipsOnOwnLeg([onColumn], [edge], [dot]);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chipLabel).toBe("bus chip");
  });

  it("clears a chip seated on the member's own leg", () => {
    const onLeg = chip("bus", [720, LEG_Y]);

    expect(auditFanoutChipsOnOwnLeg([onLeg], [edge], [dot])).toEqual([]);
  });

  it("ignores an edge with no junction dot", () => {
    const onColumn = chip("label", [COLUMN_X, 300]);

    expect(auditFanoutChipsOnOwnLeg([onColumn], [edge], [])).toEqual([]);
  });
});
