// Runs that would cross a card they do not belong to, and the two rules that
// keep them off it.
//
// A NEAR trunk member is drawn as the trunk's own shape: a source stub out to
// the junction column and a branch leg from the column into the target port,
// neither of which is ever moved by an obstacle-aware pass (the bus retype
// takes the edge out of every one of them). A layer is a maximal run of
// overlapping x-intervals, so a card of the source's or the target's OWN layer
// can sit strictly between a member's two ports -- and the member would draw
// straight through it. routeTrunkEdges therefore demotes such a member to the
// far treatment, where jogForwardLegs can move its legs, and re-elects the
// aggregate owner among the members that stay near.
//
// A backward rail's column is resolved from the drawer's default, then clamped
// into its gap's column zone. When the clamp alone moves it the search has
// nothing to fix, and the resolved column still has to be STAMPED: unstamped,
// the drawer falls back to its own default, one stub off the port and inside
// the card band the zone clamp was avoiding.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  clampBackwardRails,
  jogForwardLegs,
  routeTrunkEdges,
} from "../../src/canvas/busRouting";
import { widenLayerGaps, type GapRecord } from "../../src/canvas/layerModel";
import {
  PORT_STUB,
  chipBoxClearsCards,
  drawnEdge,
  horizontalRuns,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import {
  cardRectsFor,
  deconflictChipAnchors,
} from "../../src/canvas/chipSeating";
import { chipSeatHalfW, rateChipText } from "../../src/canvas/chipMetrics";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { segmentEntersRect, segmentsOf } from "../e2e/geometry";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  orderedRecipeNode,
  productNode,
  recipeNode,
} from "./busRouting.testkit";

const ITEM = "s";

const producer = (id: string, x: number, y: number): RFRecipeNode =>
  recipeNode(id, x, y, mkRecipe(id, [], [ITEM]));
const consumer = (id: string, x: number, y: number): RFRecipeNode =>
  orderedRecipeNode(id, x, y, [ITEM]);

const edge = (id: string, source: string, target: string): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item: ITEM, rate: new Fraction(1) },
});

type EdgeData = Record<string, unknown>;

const dataOf = (edges: Edge[], id: string): EdgeData =>
  (edges.find((e) => e.id === id)?.data as EdgeData | undefined) ?? {};
const typeOf = (edges: Edge[], id: string): string | undefined =>
  edges.find((e) => e.id === id)?.type;

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

describe("routeTrunkEdges: a near member whose own run crosses a card", () => {
  it("demotes a fan-in member whose source stub crosses a card in its own layer", () => {
    // p1 and p2 feed one port from the layer before it. `blk` sits in THAT
    // layer too (its x-interval touches p1's, so the two merge into one layer)
    // and reaches out past p1's out-port at p1's own row: the stub p1 would
    // draw to the merge column runs straight through it.
    const nodes: RFAnyNode[] = [
      producer("p1", 0, 0),
      producer("p2", 0, 700),
      productNode("blk", 300, 0, 260, 200),
      consumer("tgt", 1200, 300),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p1", "tgt"),
      edge("e:2", "p2", "tgt"),
    ]);

    // The blocked member leaves the bus and takes the far treatment: it keeps
    // the shared column as its bend, and jogForwardLegs owns its legs again.
    const junctionX = dataOf(routed.edges, "e:2").junctionX as number;
    expect(typeOf(routed.edges, "e:1")).toBe("item");
    expect(dataOf(routed.edges, "e:1").fanin).toBeUndefined();
    expect(dataOf(routed.edges, "e:1").faninColumn).toBe(true);
    expect(dataOf(routed.edges, "e:1").bendX).toBe(junctionX);

    // The clear member still draws the merge, and the aggregate moves to it:
    // e:1 is lex-smallest but draws no shared leg any more.
    expect(typeOf(routed.edges, "e:2")).toBe("bus");
    expect(dataOf(routed.edges, "e:2").fanin).toBe(true);
    expect(dataOf(routed.edges, "e:2").busChipOwner).toBe(true);
    expect(dataOf(routed.edges, "e:1").busChipOwner).toBeUndefined();
  });

  it("demotes a fan-out member whose branch leg crosses a card in the target's layer", () => {
    // s feeds t1 and t2 one layer over. `blk` belongs to THAT layer (its
    // x-interval touches t1's) and stands in front of t1 at t1's own row, so
    // the leg from the split column into t1 would run through it.
    const nodes: RFAnyNode[] = [
      producer("s", 0, 300),
      productNode("blk", 940, 0, 260, 200),
      consumer("t1", 1200, 0),
      consumer("t2", 1200, 700),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "s", "t1"),
      edge("e:2", "s", "t2"),
    ]);

    const junctionX = dataOf(routed.edges, "e:2").junctionX as number;
    expect(typeOf(routed.edges, "e:1")).toBe("item");
    expect(dataOf(routed.edges, "e:1").fanout).toBeUndefined();
    expect(dataOf(routed.edges, "e:1").fanoutColumn).toBe(true);
    expect(dataOf(routed.edges, "e:1").bendX).toBe(junctionX);

    expect(typeOf(routed.edges, "e:2")).toBe("bus");
    expect(dataOf(routed.edges, "e:2").fanout).toBe(true);
    expect(dataOf(routed.edges, "e:2").busChipOwner).toBe(true);
  });

  it("keeps both members near when nothing stands between their ports", () => {
    // The same fan-in without the blocker: the demotion is about the card, not
    // about the span.
    const nodes: RFAnyNode[] = [
      producer("p1", 0, 0),
      producer("p2", 0, 700),
      consumer("tgt", 1200, 300),
    ];
    const routed = widenAndRoute(nodes, [
      edge("e:1", "p1", "tgt"),
      edge("e:2", "p2", "tgt"),
    ]);
    for (const id of ["e:1", "e:2"]) {
      expect(typeOf(routed.edges, id)).toBe("bus");
      expect(dataOf(routed.edges, id).fanin).toBe(true);
    }
    expect(dataOf(routed.edges, "e:1").busChipOwner).toBe(true);
  });
});

describe("clampBackwardRails: the resolved column is always stamped", () => {
  it("stamps railXRight when the zone clamp alone moves the column", () => {
    // Three layers, so the source layer has a gap after it, and a backward
    // edge from the middle layer to the first. Nothing blocks the rail's right
    // column, but the gap's column zone starts well right of the drawer's
    // default (one stub off the out-port), so the clamp moves it -- and the
    // drawer only hears about the move through the stamp.
    const nodes: RFAnyNode[] = [
      consumer("first", 0, 0),
      producer("mid", 900, 0),
      consumer("last", 1800, 0),
    ];
    const edges: Edge[] = [
      edge("e:1", "mid", "first"),
      edge("e:2", "mid", "last"),
    ];
    const widened = widenLayerGaps(nodes, edges);
    const out = clampBackwardRails(widened.nodes, edges, {
      gaps: widened.gaps,
    });

    const byId = nodeIndexOf(widened.nodes);
    const ports = drawnPortsOf(out.find((e) => e.id === "e:1")!, byId)!;
    const zone = widened.gaps.find((g) => g.index === 1)!.columnZone;
    // Premise: the default column really is outside the zone, so the stamp
    // below is the clamp's doing and not an accident of the fixture.
    expect(ports.sourceX + PORT_STUB).toBeLessThan(zone.left);

    const railXRight = routingHintsFromData(
      out.find((e) => e.id === "e:1")!.data,
    ).railXRight;
    expect(railXRight).toBe(zone.left);
  });
});

describe("jogForwardLegs: a card in the target's own layer", () => {
  // `blk` stands in front of the target at the target's row, and `bridge` (far
  // below, out of every run's way) overlaps them both, so all three are ONE
  // layer: the gap in front of the target -- and with it the descent column's
  // zone -- sits left of `blk` instead of between `blk` and the target.
  const fixture = () => {
    const nodes: RFAnyNode[] = [
      producer("s", 0, 300),
      productNode("blk", 940, 600, 200, 200),
      consumer("bridge", 1100, 3000),
      consumer("tgt", 1400, 600),
    ];
    const edges = [edge("e:1", "s", "tgt")];
    const widened = widenLayerGaps(nodes, edges);
    return {
      nodes: widened.nodes,
      gaps: widened.gaps,
      edges: jogForwardLegs(widened.nodes, edges, { gaps: widened.gaps }),
    };
  };

  it("jogs a leg blocked between the descent slot and the port", () => {
    // The straight step's final leg runs from the bend column all the way to
    // the PORT, so the card standing past the target's descent slot blocks it.
    const jogged = fixture();
    expect(dataOf(jogged.edges, "e:1").legY).toBeDefined();
  });

  it("puts the descent in the layer's own band when no zoned column clears", () => {
    const jogged = fixture();
    const byId = nodeIndexOf(jogged.nodes);
    const blk = byId.get("blk")!;
    const blkRight = blk.position.x + (blk.width ?? 0);
    const descentX = dataOf(jogged.edges, "e:1").jogDescentX as number;
    const ports = drawnPortsOf(
      jogged.edges.find((e) => e.id === "e:1")!,
      byId,
    )!;

    // Right of the card (the only side a clear final leg can come from), left
    // of the port, and outside every gap's column zone -- it stands inside the
    // layer's own x-band, which is the last-resort tier's whole point.
    expect(descentX).toBeGreaterThan(blkRight);
    expect(descentX).toBeLessThan(ports.targetX);
    for (const gap of jogged.gaps) {
      expect(
        descentX < gap.columnZone.left || descentX > gap.columnZone.right,
      ).toBe(true);
    }
  });
});

describe("a far member whose named run cannot hold its chip", () => {
  it("falls back to the card-clear seat on its own longest clear run", () => {
    // Same one-layer trap as above, with the card so close to the target that
    // the jogged leg between them is shorter than the chip box: the far
    // fan-out seat one port stub back from the port hangs over the card, so the
    // seating pass slides the chip onto another run of this member's own line.
    const nodes: RFAnyNode[] = [
      producer("s", 0, 300),
      productNode("blk", 1200, 600, 200, 200),
      consumer("bridge", 1160, 3000),
      consumer("tgt", 1460, 600),
    ];
    const member = edge("e:1", "s", "tgt");
    member.data = { ...member.data, fanoutColumn: true };
    const widened = widenLayerGaps(nodes, [member]);
    const jogged = jogForwardLegs(widened.nodes, [member], {
      gaps: widened.gaps,
    });
    const seated = deconflictChipAnchors(widened.nodes, jogged);

    const byId = nodeIndexOf(widened.nodes);
    const laid = seated.find((e) => e.id === "e:1")!;
    const ports = drawnPortsOf(laid, byId)!;
    const drawn = drawnEdge(ports, laid.type, laid.data);
    expect(drawn.shape).toBe("item");
    if (drawn.shape !== "item") return;

    const cards = cardRectsFor(
      widened.nodes.filter((n) => n.type !== "group"),
      byId,
    );
    const halfW = chipSeatHalfW(rateChipText(laid), false);
    const runs = horizontalRuns(drawn.pts);
    const last = runs[runs.length - 1]!;
    const named = Math.min(
      Math.max(ports.targetX - PORT_STUB - halfW, last.lo),
      last.hi,
    );
    // Premise: the named seat really is the one that cannot clear the card, so
    // the fallback below is the rule's doing and not the fixture's.
    expect(chipBoxClearsCards(named, last.y, halfW, cards)).toBe(false);

    const anchor = drawn.labelAnchor;
    expect(anchor.y).not.toBe(last.y);
    expect(chipBoxClearsCards(anchor.x, anchor.y, halfW, cards)).toBe(true);
    // Still on this member's own line.
    expect(
      runs.some(
        (run) => run.y === anchor.y && anchor.x >= run.lo && anchor.x <= run.hi,
      ),
    ).toBe(true);
  });
});

describe("jogForwardLegs: a demoted member whose same-row leg crosses a card", () => {
  // s feeds t1 at its OWN row and t2 below it. `blk` stands between s and t1 on
  // that row, and `bridge` (far below, out of every run's way) overlaps s and
  // blk, so the blocker joins the SOURCE layer: routeTrunkEdges demotes the
  // same-row member to the far treatment, and the jog has to bend it around the
  // card the straight line would cross.
  const CARD = 100;
  const fixture = (withBlocker: boolean) => {
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, CARD, CARD),
      ...(withBlocker
        ? [
            productNode("blk", 150, 0, CARD, CARD),
            productNode("bridge", 80, 300, CARD, CARD),
          ]
        : []),
      productNode("t1", 400, 0, CARD, CARD),
      productNode("t2", 400, 200, CARD, CARD),
    ];
    const edges = [edge("e:1", "s", "t1"), edge("e:2", "s", "t2")];
    const widened = widenLayerGaps(nodes, edges);
    const routed = routeTrunkEdges(widened.nodes, edges, {
      gaps: widened.gaps,
    });
    return {
      nodes: widened.nodes,
      edges: jogForwardLegs(widened.nodes, routed, { gaps: widened.gaps }),
    };
  };

  const drawnPts = (
    out: { nodes: RFAnyNode[]; edges: Edge[] },
    id: string,
  ): Array<readonly [number, number]> => {
    const byId = nodeIndexOf(out.nodes);
    const laid = out.edges.find((e) => e.id === id)!;
    const ports = drawnPortsOf(laid, byId)!;
    return drawnEdge(ports, laid.type, laid.data).pts.map(
      ([x, y]) => [x, y] as const,
    );
  };

  it("jogs the same-row member clear of the card it would cross", () => {
    const out = fixture(true);
    const data = dataOf(out.edges, "e:1");
    // Premise: the member really was demoted out of the bus, so its legs are
    // jogForwardLegs' to move.
    expect(typeOf(out.edges, "e:1")).toBe("item");
    expect(data.fanout).toBeUndefined();

    const byId = nodeIndexOf(out.nodes);
    const ports = drawnPortsOf(out.edges.find((e) => e.id === "e:1")!, byId)!;
    expect(ports.sourceY).toBe(ports.targetY);
    expect(data.legY).toBeDefined();
    expect(data.legY).not.toBe(ports.targetY);

    const blk = byId.get("blk")!;
    const rect = {
      nodeId: "blk",
      type: "product",
      left: blk.position.x,
      top: blk.position.y,
      right: blk.position.x + (blk.width ?? 0),
      bottom: blk.position.y + (blk.height ?? 0),
    };
    for (const [p0, p1] of segmentsOf(drawnPts(out, "e:1"))) {
      expect(segmentEntersRect(p0, p1, rect, 0.5)).toBe(false);
    }
  });

  it("leaves an unblocked same-row member straight", () => {
    const out = fixture(false);
    expect(dataOf(out.edges, "e:1").legY).toBeUndefined();
    expect(dataOf(out.edges, "e:1").srcColX).toBeUndefined();
    const pts = drawnPts(out, "e:1");
    expect(pts.every(([, y]) => y === pts[0]![1])).toBe(true);
  });
});

describe("jogForwardLegs: the rail-row candidate order is total", () => {
  it("routes identically when the node array is reversed", () => {
    // Two blockers whose padded rails sit the SAME distance from the target
    // row, one above and one below: only a tie-break beyond the distance keeps
    // the chosen rail independent of the array order.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 250, 100, 100),
      productNode("b1", 400, 0, 100, 150),
      productNode("b2", 600, 50, 100, 150),
      productNode("tgt", 900, 50, 100, 100),
    ];
    const member: Edge = {
      ...edge("e:1", "s", "tgt"),
      data: { item: ITEM, rate: new Fraction(1), bendX: 200 },
    };
    const railOf = (arranged: RFAnyNode[]): EdgeData =>
      dataOf(jogForwardLegs(arranged, [member]), "e:1");

    const forward = railOf(nodes);
    expect(forward.legY).toBeDefined();
    expect(railOf([...nodes].reverse())).toEqual(forward);
  });
});
