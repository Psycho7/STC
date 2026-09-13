// The trunk leg counters measure a chip against the stretch that is its OWN,
// not against its whole polyline, so the shared junction column -- part of every
// member's polyline -- stops counting as a legal seat. Both directions are here:
// a fan-out member's leg is the suffix right of the column, a fan-in member's
// stub the prefix left of it, and a fan-in aggregate's leg the shared suffix
// into the target. The rules are worth a suite of their own, here rather than
// under test/e2e/ (Vitest is kept out of that directory; the counters are pure
// functions and pull in no Playwright runtime).
import { describe, expect, it } from "vitest";

import { CHAMFER } from "../src/canvas/edgePath";
import {
  auditFaninChipsOnOwnLeg,
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

function junctionDot(family: string): DotRect {
  return {
    testId: `bus-junction-${edge.id}`,
    family,
    left: JUNCTION_X - 3,
    right: JUNCTION_X + 3,
    top: 189,
    bottom: 195,
  };
}

const dot = junctionDot("fanout");

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

  it("ignores a dot of the other family on the same testid", () => {
    // Same testid prefix, same geometry, family "fanin": the counter keys on
    // the family as well as the prefix, so a merge dot never makes an edge a
    // fan-out member.
    const onColumn = chip("bus", [COLUMN_X, 300]);

    expect(
      auditFanoutChipsOnOwnLeg([onColumn], [edge], [junctionDot("fanin")]),
    ).toEqual([]);
  });

  it("leaves the aggregate chip alone: it rides the shared run", () => {
    const onTrunk = chip("bus-drop", [540, 192]);

    expect(auditFanoutChipsOnOwnLeg([onTrunk], [edge], [dot])).toEqual([]);
  });

  it("ignores an edge with no junction dot", () => {
    const onColumn = chip("label", [COLUMN_X, 300]);

    expect(auditFanoutChipsOnOwnLeg([onColumn], [edge], [])).toEqual([]);
  });
});

// The fan-in mirror: members reach one target port along one shared leg, so the
// member's own stretch is its SOURCE STUB (left of the column) and the
// aggregate's is the leg from the merge dot into the target.
const FANIN_COLUMN_X = 600;
const FANIN_SOURCE_Y = 200;
const FANIN_TARGET_Y = 400;
// The merge dot is drawn one chamfer PAST the column, on the target row.
const MERGE_X = FANIN_COLUMN_X + CHAMFER;

const faninEdge: RawEdge = {
  id: "e:2",
  source: "A",
  target: "B",
  item: "iron",
  d:
    `M 400,${FANIN_SOURCE_Y}` +
    ` L ${FANIN_COLUMN_X - CHAMFER},${FANIN_SOURCE_Y}` +
    ` L ${FANIN_COLUMN_X},${FANIN_SOURCE_Y + CHAMFER}` +
    ` L ${FANIN_COLUMN_X},${FANIN_TARGET_Y - CHAMFER}` +
    ` L ${MERGE_X},${FANIN_TARGET_Y}` +
    ` L 800,${FANIN_TARGET_Y}`,
};

const mergeDot: DotRect = {
  testId: `fanin-junction-${faninEdge.id}`,
  family: "fanin",
  left: MERGE_X - 3,
  right: MERGE_X + 3,
  top: FANIN_TARGET_Y - 3,
  bottom: FANIN_TARGET_Y + 3,
};

function faninChip(
  kind: ChipRect["kind"],
  centre: readonly [number, number],
): ChipRect {
  const [cx, cy] = centre;
  return {
    edgeId: faninEdge.id,
    testId: `bus-edge-label-${faninEdge.id}`,
    label: `${kind} chip`,
    kind,
    iconOnly: false,
    left: cx - 20,
    right: cx + 20,
    top: cy - 8,
    bottom: cy + 8,
  };
}

describe("auditFaninChipsOnOwnLeg", () => {
  it("clears a member chip seated on its own source stub", () => {
    const onStub = faninChip("bus", [450, FANIN_SOURCE_Y]);

    expect(auditFaninChipsOnOwnLeg([onStub], [faninEdge], [mergeDot])).toEqual(
      [],
    );
  });

  it("flags a member chip parked on the shared leg", () => {
    const onSharedLeg = faninChip("bus", [700, FANIN_TARGET_Y]);

    const hits = auditFaninChipsOnOwnLeg(
      [onSharedLeg],
      [faninEdge],
      [mergeDot],
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chipEdgeId).toBe(faninEdge.id);
  });

  it("clears an aggregate chip seated on the leg into the target", () => {
    const onLeg = faninChip("bus-drop", [700, FANIN_TARGET_Y]);

    expect(auditFaninChipsOnOwnLeg([onLeg], [faninEdge], [mergeDot])).toEqual(
      [],
    );
  });

  it("flags an aggregate chip parked back on a member's own stub", () => {
    const onStub = faninChip("bus-drop", [450, FANIN_SOURCE_Y]);

    const hits = auditFaninChipsOnOwnLeg([onStub], [faninEdge], [mergeDot]);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chipLabel).toBe("bus-drop chip");
  });

  it("ignores an edge with no merge dot", () => {
    const onSharedLeg = faninChip("bus", [700, FANIN_TARGET_Y]);

    expect(auditFaninChipsOnOwnLeg([onSharedLeg], [faninEdge], [])).toEqual([]);
  });
});
