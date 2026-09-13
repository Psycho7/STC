// Fan-in as a ROUTED structure (issue #131, T3b). N sources feeding one target
// port are a trunk exactly as N targets off one source port are: routeTrunkEdges
// gives the trunk one shared merge column in its gap's reserved zone -- filled
// from the RIGHT, so a merge column stands beside the layer it merges into --
// retypes the members that reach it from the next layer back, pins the ones
// further back to the same column, and hands a backward member that column as
// its rail. Everything the seating pass used to infer from collinear final legs
// comes off those stamps now.
//
// These suites pin the membership split, the column, the drawn shape and its
// three anchors, the dual member that belongs to a fan-out and a fan-in at once,
// and the two passes that must keep their own columns out of the way.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  ENTRY_SLOT_PITCH,
  assignEntryColumns,
  clampBackwardRails,
  entryGutterRects,
  gutterWidth,
  jogForwardLegs,
  routeTrunkEdges,
} from "../../src/canvas/busRouting";
import {
  COLUMN_PITCH,
  widenLayerGaps,
  type GapRecord,
} from "../../src/canvas/layerModel";
import {
  CHAMFER,
  drawnEdge,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { drawnPortsOf } from "../../src/canvas/nodeGeometry";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

const ITEM = "s";

// One layer is a column gap plus a recipe card.
const LAYER_PITCH = 410;

const producer = (id: string, x: number, y: number): RFRecipeNode =>
  recipeNode(id, x, y, mkRecipe(id, [], [ITEM]));
const consumer = (id: string, x: number, y: number): RFRecipeNode =>
  orderedRecipeNode(id, x, y, [ITEM]);
// A card parked in the layer between, far below the trunk's own rows: it makes
// the layer a far member needs without obstructing any leg.
const layerFiller = (id: string, x: number): RFRecipeNode =>
  consumer(id, x, 2800);

const edge = (
  id: string,
  source: string,
  target: string,
  rate = new Fraction(1),
  item = ITEM,
): Edge => ({ id, type: "item", source, target, data: { item, rate } });

type EdgeData = Record<string, unknown>;

const dataOf = (edges: Edge[], id: string): EdgeData =>
  (edges.find((e) => e.id === id)?.data as EdgeData | undefined) ?? {};
const typeOf = (edges: Edge[], id: string): string | undefined =>
  edges.find((e) => e.id === id)?.type;
const num = (edges: Edge[], id: string, key: string): number =>
  dataOf(edges, id)[key] as number;

// The whole pre-pass + trunk pass a real plan runs: the gap records come from
// the widening, so the columns below are the reserved ones rather than the
// no-ctx fallback.
type Routed = {
  nodes: RFAnyNode[];
  gaps: ReadonlyArray<GapRecord>;
  edges: Edge[];
};
const widenAndRoute = (nodes: RFAnyNode[], edges: Edge[]): Routed => {
  const widened = widenLayerGaps(nodes, edges);
  return {
    nodes: widened.nodes,
    gaps: widened.gaps,
    edges: routeTrunkEdges(widened.nodes, edges, { gaps: widened.gaps }),
  };
};

// The drawn shape of one routed edge, rebuilt exactly as BusEdge and the
// seating pass rebuild it.
const shapeOf = (routed: Routed, id: string) => {
  const e = routed.edges.find((x) => x.id === id)!;
  const byId = new Map(routed.nodes.map((n) => [n.id, n]));
  return drawnEdge(drawnPortsOf(e, byId)!, e.type, e.data);
};

describe("routeTrunkEdges: fan-in trunks", () => {
  // Two producers one layer back feeding one consumer's single in-port.
  const fixture = (): { nodes: RFAnyNode[]; edges: Edge[] } => ({
    nodes: [
      producer("p1", 0, 0),
      producer("p2", 0, 300),
      consumer("tgt", LAYER_PITCH, 120),
    ],
    edges: [
      edge("e:1", "p1", "tgt", new Fraction(2)),
      edge("e:2", "p2", "tgt", new Fraction(3)),
    ],
  });

  it("retypes both members onto one column taken from the right of the zone", () => {
    const { nodes, edges } = fixture();
    const routed = widenAndRoute(nodes, edges);

    for (const id of ["e:1", "e:2"]) {
      expect(typeOf(routed.edges, id)).toBe("bus");
      const data = dataOf(routed.edges, id);
      expect(data.fanin).toBe(true);
      expect(data.fanout).toBeUndefined();
      expect(data.trunkKey).toBe(`${ITEM}|tgt`);
      expect(data.busMemberCount).toBe(2);
      expect((data.busTotalRate as Fraction).equals(new Fraction(5))).toBe(
        true,
      );
    }
    // One column for the trunk, the first slot from the RIGHT of the gap's
    // reserved zone -- the mirror of the fan-out's first slot from the left.
    const junctionX = num(routed.edges, "e:1", "junctionX");
    expect(num(routed.edges, "e:2", "junctionX")).toBe(junctionX);
    expect(junctionX).toBe(routed.gaps[0]!.columnZone.right - COLUMN_PITCH / 2);

    // Exactly one member draws the trunk's aggregate chip.
    const owners = ["e:1", "e:2"].filter(
      (id) => dataOf(routed.edges, id).busChipOwner === true,
    );
    expect(owners).toEqual(["e:1"]);
  });

  it("draws the merge shape with the dot on the shared leg's start", () => {
    const { nodes, edges } = fixture();
    const routed = widenAndRoute(nodes, edges);
    const drawn = shapeOf(routed, "e:1");
    expect(drawn.shape).toBe("fanin");
    if (drawn.shape !== "fanin") return;

    const e = routed.edges.find((x) => x.id === "e:1")!;
    const byId = new Map(routed.nodes.map((n) => [n.id, n]));
    const ports = drawnPortsOf(e, byId)!;
    const jx = routingHintsFromData(e.data).junctionX!;

    // The dot is the first point every member shares: one chamfer past the
    // column, on the target row. Both members answer the same point.
    expect(drawn.junction).toEqual({ x: jx + CHAMFER, y: ports.targetY });
    const other = shapeOf(routed, "e:2");
    expect(other.shape === "fanin" && other.junction).toEqual(drawn.junction);

    // The aggregate rides the shared leg from that dot into the port; the
    // member's own chip rides its stub out of the source port.
    expect(drawn.trunkAnchor).toEqual({
      x: (jx + CHAMFER + ports.targetX) / 2,
      y: ports.targetY,
    });
    expect(drawn.branchAnchor).toEqual({
      x: (ports.sourceX + jx - CHAMFER) / 2,
      y: ports.sourceY,
    });
    // The member's own sub-polyline stops at the dot: nothing of the shared leg
    // is in it.
    const last = drawn.branchPts[drawn.branchPts.length - 1]!;
    expect(last[0]).toBeLessThanOrEqual(drawn.junction.x);
  });

  it("is no trunk when both edges leave ONE source unit", () => {
    // Same (item, source) edges are one flow drawn as one line, not a merge.
    const nodes: RFAnyNode[] = [
      producer("p", 0, 0),
      consumer("tgt", LAYER_PITCH, 0),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p", "tgt"),
      edge("e:2", "p", "tgt"),
    ]);
    for (const id of ["e:1", "e:2"]) {
      expect(typeOf(routed.edges, id)).toBe("item");
      expect(dataOf(routed.edges, id).fanin).toBeUndefined();
      expect(dataOf(routed.edges, id).faninColumn).toBeUndefined();
    }
  });

  it("is no trunk when the two feeds into one card carry different items", () => {
    // A trunk is keyed (item, unit): two items entering one card are two
    // separate one-to-one flows on two different ports, never a merge.
    const tgt = orderedRecipeNode("tgt", LAYER_PITCH, 0, [ITEM, "t"]);
    const nodes: RFAnyNode[] = [
      producer("p1", 0, 0),
      recipeNode("p2", 0, 300, mkRecipe("p2", [], ["t"])),
      tgt,
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p1", "tgt"),
      edge("e:2", "p2", "tgt", new Fraction(1), "t"),
    ]);
    for (const id of ["e:1", "e:2"]) {
      expect(typeOf(routed.edges, id)).toBe("item");
      expect(dataOf(routed.edges, id).fanin).toBeUndefined();
    }
  });

  it("pins a far member to the column and keeps it through jogForwardLegs", () => {
    // p2 sits two layers back, so it joins the trunk as a plain item edge
    // pinned to the shared column -- it keeps every item-edge pass, and none of
    // them may move the pin.
    const nodes: RFAnyNode[] = [
      producer("p2", 0, 300),
      layerFiller("mid", LAYER_PITCH),
      producer("p1", 2 * LAYER_PITCH, 0),
      consumer("tgt", 3 * LAYER_PITCH, 120),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p1", "tgt"),
      edge("e:2", "p2", "tgt"),
    ]);
    const junctionX = num(routed.edges, "e:1", "junctionX");
    expect(typeOf(routed.edges, "e:1")).toBe("bus");
    expect(typeOf(routed.edges, "e:2")).toBe("item");
    expect(dataOf(routed.edges, "e:2").faninColumn).toBe(true);
    expect(dataOf(routed.edges, "e:2").bendX).toBe(junctionX);

    const jogged = jogForwardLegs(routed.nodes, routed.edges, {
      gaps: routed.gaps,
    });
    expect(dataOf(jogged, "e:2").bendX).toBe(junctionX);
    expect(dataOf(jogged, "e:2").faninColumn).toBe(true);
  });

  it("gives every fan-in trunk of one gap its own slot, top-to-bottom", () => {
    // Two consumers in one layer, each fed by two producers of its own (so no
    // member is a fan-out member too): two trunks in one gap, taking the two
    // rightmost slots ordered by target port row.
    const nodes: RFAnyNode[] = [
      producer("p1", 0, 0),
      producer("p2", 0, 300),
      producer("p3", 0, 900),
      producer("p4", 0, 1200),
      consumer("top", LAYER_PITCH, 0),
      consumer("bottom", LAYER_PITCH, 900),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p1", "top"),
      edge("e:2", "p2", "top"),
      edge("e:3", "p3", "bottom"),
      edge("e:4", "p4", "bottom"),
    ]);
    const zone = routed.gaps[0]!.columnZone;
    // The top target's trunk takes the outermost slot, the bottom one the next.
    expect(num(routed.edges, "e:1", "junctionX")).toBe(
      zone.right - COLUMN_PITCH / 2,
    );
    expect(num(routed.edges, "e:2", "junctionX")).toBe(
      num(routed.edges, "e:1", "junctionX"),
    );
    expect(num(routed.edges, "e:3", "junctionX")).toBe(
      zone.right - COLUMN_PITCH / 2 - COLUMN_PITCH,
    );
    // Both columns stand inside the zone the pre-pass reserved for them.
    for (const id of ["e:1", "e:3"]) {
      const x = num(routed.edges, id, "junctionX");
      expect(x).toBeGreaterThanOrEqual(zone.left);
      expect(x).toBeLessThanOrEqual(zone.right);
    }
  });
});

describe("routeTrunkEdges: a member of a fan-out AND a fan-in", () => {
  // The 2x2 same-item component minus one edge: s1 feeds t1 and t2, s2 feeds
  // t1. That is one fan-out (off s1) and one fan-in (into t1), and s1 -> t1
  // belongs to both.
  const fixture = (): Routed => {
    const nodes: RFAnyNode[] = [
      producer("s1", 0, 0),
      producer("s2", 0, 400),
      consumer("t1", LAYER_PITCH, 200),
      consumer("t2", LAYER_PITCH, 600),
    ];
    return widenAndRoute(nodes, [
      edge("e:1", "s1", "t1", new Fraction(2)),
      edge("e:2", "s1", "t2", new Fraction(3)),
      edge("e:3", "s2", "t1", new Fraction(5)),
    ]);
  };

  it("routes the dual member as its fan-out branch handing over to the fan-in column", () => {
    const routed = fixture();
    const fanoutX = num(routed.edges, "e:2", "junctionX");
    const faninX = num(routed.edges, "e:3", "junctionX");
    const zone = routed.gaps[0]!.columnZone;
    expect(fanoutX).toBe(zone.left + COLUMN_PITCH / 2);
    expect(faninX).toBe(zone.right - COLUMN_PITCH / 2);

    // The dual member draws as the fan-out member it is, with the fan-in column
    // stamped as the point its own stretch ends.
    const dual = dataOf(routed.edges, "e:1");
    expect(typeOf(routed.edges, "e:1")).toBe("bus");
    expect(dual.fanout).toBe(true);
    expect(dual.fanin).toBeUndefined();
    expect(dual.junctionX).toBe(fanoutX);
    expect(dual.faninJoinX).toBe(faninX);

    // Both trunks still draw an aggregate. The fan-in's is drawn by its one
    // non-dual member: the dual's `-drop` chip is already its fan-out's.
    expect(dataOf(routed.edges, "e:1").busChipOwner).toBe(true);
    expect(dataOf(routed.edges, "e:3").busChipOwner).toBe(true);
    expect(dataOf(routed.edges, "e:2").busChipOwner).toBe(false);
  });

  it("gives the dual member exactly one chip, on the run between the two columns", () => {
    const routed = fixture();
    const drawn = shapeOf(routed, "e:1");
    expect(drawn.shape).toBe("fanout");
    if (drawn.shape !== "fanout") return;
    const fanoutX = num(routed.edges, "e:1", "junctionX");
    const faninX = num(routed.edges, "e:1", "faninJoinX");
    const e = routed.edges.find((x) => x.id === "e:1")!;
    const byId = new Map(routed.nodes.map((n) => [n.id, n]));
    const ports = drawnPortsOf(e, byId)!;

    // The member's own chip anchors at the target row, between its own column
    // and the column it hands over at -- never on the shared aggregate leg
    // right of the fan-in junction, and never on its source stub, where its
    // fan-out trunk's aggregate reads.
    expect(drawn.branchAnchor.y).toBe(ports.targetY);
    expect(drawn.branchAnchor.x).toBeGreaterThan(fanoutX + CHAMFER);
    expect(drawn.branchAnchor.x).toBeLessThan(faninX + CHAMFER);
    // Its source stub is at the source row, which the own-chip anchor left
    // behind: that stub carries the fan-out trunk's aggregate instead.
    expect(ports.sourceY).not.toBe(ports.targetY);

    // Seated, the chip is still on that run: the seat slides along the
    // member's own stretch, and it has exactly one -- no fan-in member chip is
    // stamped on it beside the fan-out branch one.
    const seated = deconflictChipAnchors(routed.nodes, routed.edges);
    const data = dataOf(seated, "e:1");
    expect(data.faninMemberDx).toBeUndefined();
    expect(data.faninMemberDy).toBeUndefined();
    expect(data.faninAggDx).toBeUndefined();
    const chipX = drawn.branchAnchor.x + ((data.fanoutBranchDx as number) ?? 0);
    const chipY = drawn.branchAnchor.y + ((data.fanoutBranchDy as number) ?? 0);
    expect(chipY).toBe(ports.targetY);
    expect(chipX).toBeGreaterThan(fanoutX + CHAMFER);
    expect(chipX).toBeLessThan(faninX + CHAMFER);
  });
});

describe("routeTrunkEdges: backward members share their trunk's column", () => {
  it("hands a fan-in rail the merge column and a fan-out rail the split column", () => {
    // t is fed by p (one layer back) and by b, which sits one layer AHEAD of
    // it: b's edge is a backward rail, and it is a member of t's fan-in trunk.
    // b also feeds c further right, so b's out-port is a fan-out trunk whose
    // backward member is the same edge.
    const nodes: RFAnyNode[] = [
      producer("p", 0, 0),
      consumer("t", LAYER_PITCH, 0),
      recipeNode("b", 2 * LAYER_PITCH, 600, mkRecipe("b", [], [ITEM])),
      consumer("c", 3 * LAYER_PITCH, 600),
      consumer("c2", 3 * LAYER_PITCH, 1000),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p", "t"),
      edge("e:2", "b", "t"),
      edge("e:3", "b", "c"),
      edge("e:4", "b", "c2"),
    ]);

    const faninX = num(routed.edges, "e:1", "junctionX");
    const fanoutX = num(routed.edges, "e:3", "junctionX");
    const rail = dataOf(routed.edges, "e:2");
    expect(typeOf(routed.edges, "e:2")).toBe("item");
    expect(rail.railXLeft).toBe(faninX);
    expect(rail.railXRight).toBe(fanoutX);

    // clampBackwardRails keeps both pinned sides as given: no column search
    // runs on a side the trunk pass already decided.
    const entries = assignEntryColumns(routed.nodes, routed.edges, {
      gaps: routed.gaps,
    });
    const clamped = clampBackwardRails(routed.nodes, entries, {
      gaps: routed.gaps,
    });
    expect(dataOf(clamped, "e:2").railXLeft).toBe(faninX);
    expect(dataOf(clamped, "e:2").railXRight).toBe(fanoutX);
  });
});

describe("arrival columns stay left of the target zone", () => {
  // One consumer fed by a fan-in trunk AND by a backward rail: the rail takes
  // an entry column in front of the card, which must not stand in the zone the
  // pre-pass reserved for that card's arrival chips, nor on the trunk's column.
  const fixture = (): Routed => {
    const nodes: RFAnyNode[] = [
      producer("p1", 0, 0),
      producer("p2", 0, 300),
      consumer("t", LAYER_PITCH, 120),
      recipeNode("b", 2 * LAYER_PITCH, 600, mkRecipe("b", [], [ITEM])),
    ];
    return widenAndRoute(nodes, [
      edge("e:1", "p1", "t"),
      edge("e:2", "p2", "t"),
      edge("e:3", "b", "t"),
    ]);
  };

  it("counts a fan-in member as an arrival and seats the entry column left of the zone", () => {
    const routed = fixture();
    const entries = assignEntryColumns(routed.nodes, routed.edges, {
      gaps: routed.gaps,
    });
    const gap = routed.gaps[0]!;
    const entryX = num(entries, "e:3", "entryX");
    const faninX = num(routed.edges, "e:1", "junctionX");
    // The arrival columns start half a slot pitch left of the target zone and
    // step left by a pitch; this one takes the first slot that also stands
    // clear of the trunk's own column, so the rail never braids the line the
    // merge draws on.
    const base = gap.targetZone.left - ENTRY_SLOT_PITCH / 2;
    const firstClear = [0, 1, 2, 3, 4]
      .map((i) => base - i * ENTRY_SLOT_PITCH)
      .find((x) => Math.abs(x - faninX) >= COLUMN_PITCH / 2);
    expect(entryX).toBe(firstClear);
    expect(entryX).toBeLessThan(gap.targetZone.left);
    // Premise: the plain first slot really was contested, so the skip above is
    // exercised rather than vacuous.
    expect(Math.abs(base - faninX)).toBeLessThan(COLUMN_PITCH / 2);

    // The fan-in members count toward the card's arrival band: three arrivals
    // (two members plus the rail), so the gutter is three slots wide.
    const rect = entryGutterRects(routed.nodes, routed.edges).get("t")!;
    expect(rect.right - rect.left).toBe(gutterWidth(3));
  });
});

describe("jogged descents stay left of the target zone", () => {
  it("takes an arrival slot in the column zone, never the chip reserve", () => {
    // A card straddling the far member's approach row, so jogForwardLegs bends
    // that member's leg to a clear y and has to pick a descent column in front
    // of the target. That column is an arrival slot like any other.
    const src = producer("src", 0, 0);
    const blocker = recipeNode(
      "blk",
      2 * LAYER_PITCH,
      560,
      mkRecipe("blk", ["z"], ["z"]),
    );
    const nodes: RFAnyNode[] = [
      src,
      layerFiller("mid", LAYER_PITCH),
      blocker,
      consumer("far1", 3 * LAYER_PITCH, 600),
      consumer("far2", 3 * LAYER_PITCH, 900),
    ];
    const widened = widenLayerGaps(nodes, [
      edge("e:1", "src", "far1"),
      edge("e:2", "src", "far2"),
    ]);
    const ctx = { gaps: widened.gaps };
    const routed = routeTrunkEdges(
      widened.nodes,
      [edge("e:1", "src", "far1"), edge("e:2", "src", "far2")],
      ctx,
    );
    const jogged = jogForwardLegs(
      widened.nodes,
      assignEntryColumns(widened.nodes, routed, ctx),
      ctx,
    );

    // Premise: a jog really happened, so the descent column below is one this
    // pass chose.
    const data = dataOf(jogged, "e:1");
    expect(data.legY).toBeDefined();
    const descentX = data.jogDescentX as number;
    expect(typeof descentX).toBe("number");

    // The target sits in the last layer, so its arrivals belong to the last
    // gap: the descent stands in that gap's column zone, at or left of the
    // first arrival slot, never inside the chip reserve in front of the card.
    const gap = widened.gaps[widened.gaps.length - 1]!;
    expect(descentX).toBeLessThanOrEqual(
      gap.targetZone.left - ENTRY_SLOT_PITCH / 2,
    );
    expect(descentX).toBeGreaterThanOrEqual(gap.columnZone.left);
  });
});
