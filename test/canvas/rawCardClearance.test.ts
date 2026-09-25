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
  CHAMFER,
  MAX_CHAMFER,
  PORT_STUB,
  cardClearRunAnchor,
  chamferStepPath,
  chipBoxClearsCards,
  drawnEdge,
  horizontalRuns,
  parsePathPoints,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import {
  cardRectsFor,
  deconflictChipAnchors,
  portKeepOutRect,
  verticalBlockerRects,
} from "../../src/canvas/chipSeating";
import { chipSeatHalfW, rateChipText } from "../../src/canvas/chipMetrics";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
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
      // Flush against p1's right edge, so the two share one layer.
      productNode("blk", RECIPE_WIDTH, 0, 260, 200),
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
      // The three x-intervals chain: blk's right edge meets the bridge's left,
      // and the bridge's right edge meets the target's.
      productNode("blk", 1400 - RECIPE_WIDTH - 200, 600, 200, 200),
      consumer("bridge", 1400 - RECIPE_WIDTH, 3000),
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
      // Overlaps blk and reaches the target's left edge, chaining all three
      // into one layer.
      consumer("bridge", 1460 - RECIPE_WIDTH, 3000),
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

describe("the chip slide's obstacle tiers", () => {
  // The slide's blockers come in three tiers -- cards + port furniture +
  // foreign verticals, then cards + furniture, then cards alone -- and the
  // first tier that yields a CLEAR seat wins. The tiers matter because
  // cardClearRunAnchor always answers with a point: when nothing on the line
  // clears the tier it falls back to the longest run's centre, which is the
  // seat the slide was called to escape. So a tier that cannot clear must be
  // discarded whole, not taken as an answer.
  //
  // Both fixtures draw one 1-to-1 edge on a straight run, one card (`blk`)
  // standing on that run's middle, and a second flow whose column crosses the
  // run -- p2 above and t2 below, so its vertical passes through the chip row
  // while its own cards stay far off it.
  const fixture = (
    p: [number, number],
    t: [number, number],
    p2: [number, number],
    t2: [number, number],
  ): {
    drawn: Extract<ReturnType<typeof drawnEdge>, { shape: "item" }>;
    halfW: number;
    cards: ReturnType<typeof cardRectsFor>;
    withFurniture: Array<{
      left: number;
      right: number;
      top: number;
      bottom: number;
    }>;
    verticals: Array<{
      left: number;
      right: number;
      top: number;
      bottom: number;
    }>;
  } => {
    const nodes: RFAnyNode[] = [
      producer("p", p[0], p[1]),
      consumer("t", t[0], t[1]),
      productNode("blk", 700, -20, 200, 120),
      producer("p2", p2[0], p2[1]),
      consumer("t2", t2[0], t2[1]),
    ];
    const seated = deconflictChipAnchors(nodes, [
      edge("e:1", "p", "t"),
      edge("e:2", "p2", "t2"),
    ]);
    const byId = nodeIndexOf(nodes);
    const cards = cardRectsFor(
      nodes.filter((n) => n.type !== "group"),
      byId,
    );
    const withFurniture = cards.flatMap((card) => [
      card as { left: number; right: number; top: number; bottom: number },
      portKeepOutRect(card, "source"),
      portKeepOutRect(card, "target"),
    ]);
    const shapeOf = (id: string) => {
      const found = seated.find((e) => e.id === id)!;
      return drawnEdge(drawnPortsOf(found, byId)!, found.type, found.data);
    };
    const own = shapeOf("e:1");
    const foreign = shapeOf("e:2");
    // e:2's flow key differs from e:1's (a different source), so every
    // vertical of its polyline is a blocker of e:1's chip.
    const verticals = segmentsOf(foreign.pts)
      .filter(([a, b]) => a[0] === b[0] && a[1] !== b[1])
      .map(([a, b]) => ({
        left: a[0] - CHAMFER,
        right: a[0] + CHAMFER,
        top: Math.min(a[1], b[1]),
        bottom: Math.max(a[1], b[1]),
      }));
    expect(own.shape).toBe("item");
    expect(verticals.length).toBe(1);
    return {
      drawn: own as Extract<typeof own, { shape: "item" }>,
      halfW: chipSeatHalfW(
        rateChipText(seated.find((e) => e.id === "e:1")!),
        false,
      ),
      cards,
      withFurniture,
      verticals,
    };
  };

  it("takes tier 1's seat when the run can clear the foreign vertical", () => {
    const { drawn, halfW, withFurniture, verticals } = fixture(
      [0, 0],
      [1600, 0],
      [400, -900],
      [1300, 900],
    );
    const tier1 = [...withFurniture, ...verticals];
    const anchor = drawn.labelAnchor;
    // Premise: the two tiers really do want different seats, so the assertion
    // below is about the order and not about one seat clearing both.
    const [tier2X] = cardClearRunAnchor(drawn.pts, halfW, withFurniture);
    expect(chipBoxClearsCards(tier2X, anchor.y, halfW, tier1)).toBe(false);

    expect(anchor.x).not.toBe(tier2X);
    expect(chipBoxClearsCards(anchor.x, anchor.y, halfW, tier1)).toBe(true);
  });

  it("does not take tier 1's answer when no seat clears that tier", () => {
    // The corridor is short and the foreign column stands over the only
    // card-clear window, so no seat on the run clears tier 1.
    const { drawn, halfW, withFurniture, verticals } = fixture(
      [412, 0],
      [1043, 0],
      [455, -900],
      [1273, 900],
    );
    const tier1 = [...withFurniture, ...verticals];
    const anchor = drawn.labelAnchor;
    const [tier1X, tier1Y] = cardClearRunAnchor(drawn.pts, halfW, tier1);
    // Premise: tier 1 answers with a point that does not clear tier 1 -- the
    // fallback this rule must throw away.
    expect(chipBoxClearsCards(tier1X, tier1Y, halfW, tier1)).toBe(false);

    expect(anchor.x).not.toBe(tier1X);
    expect(chipBoxClearsCards(anchor.x, anchor.y, halfW, withFurniture)).toBe(
      true,
    );
  });

  it("pads a vertical blocker by the bevel that column actually draws", () => {
    // A bend carrying a corridor budget draws its two corner bevels at up to
    // MAX_CHAMFER (24), three times the base CHAMFER, and each bevel is a
    // separate diagonal segment the vertical scan skips. The column below
    // stands at x = 100 between y = 24 and y = 76, with its two diagonals
    // reaching 24 out in x and 24 past each end in y -- so its keep-out is the
    // padded band [76, 124] x [0, 100], not the base-chamfer band.
    const [d] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 100,
      chamferBudget: MAX_CHAMFER,
    });
    const segs = segmentsOf(parsePathPoints(d)).map(
      ([a, b]) => [a[0], a[1], b[0], b[1]] as const,
    );

    expect(verticalBlockerRects(segs)).toEqual([
      {
        left: 100 - MAX_CHAMFER,
        right: 100 + MAX_CHAMFER,
        top: 24 - MAX_CHAMFER,
        bottom: 76 + MAX_CHAMFER,
      },
    ]);
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

describe("a slide seat whose ideal position is off the 0.01 grid", () => {
  it("emits a seat the caller's rounded re-validation still clears", () => {
    // Card rects come from fractional layout coordinates, while the emitted
    // seat lands on the 0.01 grid (r()). A card edge off that grid makes the
    // flush seat off-grid too: `card.right + halfW + clearance` validated
    // UNROUNDED touches the card exactly, but rounding it can drift up to
    // 0.005 TOWARD the card -- far past BOX_EPS -- so the caller's boxHits
    // re-validation of the emitted point rejects the very seat the filter
    // just accepted. Every tier answers with the same drifted point, the
    // slide is dropped, and the chip stays on the card it was to escape.
    const nodes: RFAnyNode[] = [
      producer("p", 0, 0),
      consumer("t", 1600, 0),
      // Right edge at 900.994: the near (right) seat 948.494 rounds DOWN to
      // 948.49, into the card.
      productNode("blk", 700.994, -20, 200, 120),
    ];
    const seated = deconflictChipAnchors(nodes, [edge("e:1", "p", "t")]);
    const byId = nodeIndexOf(nodes);
    const laid = seated.find((e) => e.id === "e:1")!;
    const ports = drawnPortsOf(laid, byId)!;
    const drawn = drawnEdge(ports, laid.type, laid.data);
    expect(drawn.shape).toBe("item");
    if (drawn.shape !== "item") return;

    const cards = cardRectsFor(
      nodes.filter((n) => n.type !== "group"),
      byId,
    );
    const halfW = chipSeatHalfW(rateChipText(laid), false);
    const runs = horizontalRuns(drawn.pts);
    const blk = cards.find((c) => c.id === "blk")!;
    const centre = (runs[0]!.lo + runs[0]!.hi) / 2;

    // Premise: the blocker's edge really is off the grid, and the rule seat
    // (the straight run's centre) stands on that card, so the chip can only
    // escape through the slide.
    expect(Math.round(blk.right * 100) / 100).not.toBe(blk.right);
    expect(chipBoxClearsCards(centre, runs[0]!.y, halfW, cards)).toBe(false);

    const anchor = drawn.labelAnchor;
    expect(chipBoxClearsCards(anchor.x, anchor.y, halfW, cards)).toBe(true);
    expect(
      runs.some(
        (run) => run.y === anchor.y && anchor.x >= run.lo && anchor.x <= run.hi,
      ),
    ).toBe(true);
  });
});

describe("a run centre whose ideal position is off the 0.01 grid", () => {
  it("emits a centre the caller's rounded re-validation still clears", () => {
    // The other half of the rounding hazard: the run bounds are on the grid,
    // but their midpoint can land on a half-hundredth, and the early return
    // validated the UNROUNDED centre while emitting r(centre). A card edge
    // 4.002 past the unrounded box clears it, yet rounding the centre 0.005
    // toward that card puts the emitted box 3.997 past it -- past BOX_EPS, so
    // the caller's boxHits re-validation rejects the very centre the check
    // just accepted, every tier answers with the same drifted point, and the
    // slide is dropped leaving the chip inside the card's clearance band.
    //
    // The corridor is exactly one box wide between the port furniture: no
    // furniture-flush candidate fits either, so the centre early-return is
    // the only branch that can answer and the fixture pins it alone.
    const nodes: RFAnyNode[] = [
      producer("p", 0, 0),
      // Off-grid target port: run [245, 352.01], centre 298.505.
      consumer("t", 355.01, 0),
      // Left edge at 346.007: the unrounded box clears it by 4.002, the
      // rounded centre 298.51 misses by 0.003.
      productNode("blk", 346.007, -20, 20, 120),
    ];
    const seated = deconflictChipAnchors(nodes, [edge("e:1", "p", "t")]);
    const byId = nodeIndexOf(nodes);
    const laid = seated.find((e) => e.id === "e:1")!;
    const ports = drawnPortsOf(laid, byId)!;
    const drawn = drawnEdge(ports, laid.type, laid.data);
    expect(drawn.shape).toBe("item");
    if (drawn.shape !== "item") return;

    const cards = cardRectsFor(
      nodes.filter((n) => n.type !== "group"),
      byId,
    );
    const halfW = chipSeatHalfW(rateChipText(laid), false);
    const runs = horizontalRuns(drawn.pts);
    const centre = (runs[0]!.lo + runs[0]!.hi) / 2;
    const rounded = Math.round(centre * 100) / 100;

    // Premise: the centre really is off the grid, its unrounded box clears
    // every card, and the rounded one does not -- the hazard the emitted seat
    // must not carry.
    expect(rounded).not.toBe(centre);
    expect(chipBoxClearsCards(centre, runs[0]!.y, halfW, cards)).toBe(true);
    expect(chipBoxClearsCards(rounded, runs[0]!.y, halfW, cards)).toBe(false);

    const anchor = drawn.labelAnchor;
    expect(chipBoxClearsCards(anchor.x, anchor.y, halfW, cards)).toBe(true);
    expect(
      runs.some(
        (run) => run.y === anchor.y && anchor.x >= run.lo && anchor.x <= run.hi,
      ),
    ).toBe(true);
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
