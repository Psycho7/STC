// Declined fan-out divergence dot (issue #43). routeFanoutEdges only builds a
// real trunk (with its own junction dot from BusEdge) when the source/target gap
// sits inside (FANOUT_SPAN_MIN, FANOUT_SPAN_MAX]. Outside that band the members
// stay plain ItemEdges that leave the same out-port and run coincident until
// they peel off one by one, so the reader sees a single line and reads one
// member's rate as the whole flow. deconflictChipAnchors marks the split point
// with a junction dot on ONE elected owner edge; these tests pin the election,
// the stamped point, and the cases that must NOT be marked.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import {
  routeFanoutEdges,
  FANOUT_SPAN_MIN,
  FANOUT_SPAN_MAX,
} from "../../src/canvas/busRouting";
import { nodeWidth, portOffsetY } from "../../src/canvas/nodeGeometry";
import {
  CHAMFER,
  chamferStepPath,
  parsePathPoints,
  type RoutingHints,
} from "../../src/canvas/edgePath";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

type FanoutData = {
  fanoutJunctionX?: number;
  fanoutJunctionY?: number;
  fanout?: boolean;
};

const dataOf = (edges: Edge[], id: string): FanoutData =>
  (edges.find((e) => e.id === id)?.data as FanoutData | undefined) ?? {};

// chipSeating's own PORT_DRIFT.recipe, mirrored here (the module does not export
// it): a recipe's drawn out handle sits 5 units right of the model right edge,
// its in handle 3 units left of the model left edge, and both a unit below the
// model row y.
const SRC_DX = 5;
const TGT_DX = -3;
const PORT_DY = 1;

const ITEM = "s";

// Below FANOUT_SPAN_MIN, so routeFanoutEdges declines the group and leaves both
// members plain item edges -- the case this marker exists for.
const DECLINED_GAP = 28;

const rateEdge = (
  id: string,
  source: string,
  target: string,
  rate: Fraction,
  // Routing hints merged onto the edge data. deconflictChipAnchors rebuilds an
  // item edge's polyline through routingHintsFromData, so a hint here reaches
  // the stamper's geometry exactly as a routing pass's would.
  hints: RoutingHints = {},
): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item: ITEM, rate, ...hints },
});

// The source card and its drawn out-port, shared by every fixture below.
const srcNode = (): RFRecipeNode =>
  recipeNode("src", 0, 0, mkRecipe("src", [], [ITEM]));
const sourceRight = nodeWidth(srcNode());
const sourceX = sourceRight + SRC_DX;
const sourceY = portOffsetY(srcNode(), ITEM, "out") + PORT_DY;

// A one-input consumer card whose in-port row lands `rowOffset` below the
// source's out-port row (0 => a straight, never-bending member).
const consumer = (id: string, gap: number, rowOffset: number): RFRecipeNode => {
  const probe = orderedRecipeNode(id, 0, 0, [ITEM]);
  const inY = measureRecipe(probe.data.recipe).inHandleYs[0]!;
  return orderedRecipeNode(
    id,
    sourceRight + gap,
    sourceY - PORT_DY - inY + rowOffset,
    [ITEM],
  );
};

// The polyline ItemEdge draws for one of these edges, rebuilt from the same port
// model chipSeating reconstructs from, so the assertions below are about the
// drawn geometry rather than about the stamping code restating itself.
const drawnPoints = (
  target: RFRecipeNode,
  hints: RoutingHints = {},
): ReadonlyArray<readonly [number, number]> => {
  const inY = measureRecipe(target.data.recipe).inHandleYs[0]!;
  const [path] = chamferStepPath({
    sourceX,
    sourceY,
    targetX: target.position.x + TGT_DX,
    targetY: target.position.y + inY + PORT_DY,
    ...hints,
  });
  return parsePathPoints(path);
};

// x of the last vertex still on the polyline's own starting row -- the column
// where this member peels off, or undefined when it never leaves. Mirrors the
// stamper's 1-unit row tolerance without borrowing its walk.
const bendXOf = (
  pts: ReadonlyArray<readonly [number, number]>,
): number | undefined => {
  const sy = pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i]![1] - sy) > 1) return pts[i - 1]![0];
  }
  return undefined;
};

// y of a left-to-right polyline where it first reaches x. Used to compare two
// members' paths at a chosen x without borrowing the stamper's own bend walk.
const yAt = (
  pts: ReadonlyArray<readonly [number, number]>,
  x: number,
): number => {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1)) {
      if (x1 === x0) return y0;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  throw new Error(`x=${x} is outside the polyline`);
};

describe("deconflictChipAnchors: declined fan-out divergence dot", () => {
  it("stamps the owner with the point where the coincident members split", () => {
    // Two edges off ONE out-port into two consumers a declined gap away: "a"
    // runs straight at the source row, "b" bends down to a lower row.
    const src = srcNode();
    const tgtA = consumer("tgtA", DECLINED_GAP, 0);
    const tgtB = consumer("tgtB", DECLINED_GAP, 200);
    const nodes: RFAnyNode[] = [src, tgtA, tgtB];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3)),
    ];

    // Premise 1: the group really is a fan-out that routeFanoutEdges DECLINED,
    // so no bus trunk (and no BusEdge junction dot) covers it.
    expect(DECLINED_GAP).toBeLessThanOrEqual(FANOUT_SPAN_MIN);
    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item"]);
    expect(declined.some((e) => (e.data as FanoutData).fanout === true)).toBe(
      false,
    );
    expect(new Set(edges.map((e) => e.target)).size).toBe(2);

    const ptsA = drawnPoints(tgtA);
    const ptsB = drawnPoints(tgtB);

    const out = deconflictChipAnchors(nodes, declined);
    const owner = dataOf(out, "e:a"); // lexicographically smallest id
    const other = dataOf(out, "e:b");

    expect(owner.fanoutJunctionY).toBe(sourceY);
    const jx = owner.fanoutJunctionX!;
    expect(typeof jx).toBe("number");

    // Premise 2: there is a real shared prefix to mark. Both members start at
    // the same drawn out-port and run coincident at the source row up to the
    // stamped x -- the dot sits ON both lines, not beside them.
    expect(ptsA[0]).toEqual([sourceX, sourceY]);
    expect(ptsB[0]).toEqual([sourceX, sourceY]);
    expect(jx).toBeGreaterThan(sourceX);
    for (const x of [sourceX, (sourceX + jx) / 2, jx]) {
      expect(yAt(ptsA, x)).toBeCloseTo(sourceY, 6);
      expect(yAt(ptsB, x)).toBeCloseTo(sourceY, 6);
    }

    // Premise 3: the split is AT the stamp, not before or after it. Just past
    // jx the bent member has left the row while the straight one has not.
    expect(yAt(ptsB, jx + 2)).not.toBeCloseTo(sourceY, 6);
    expect(yAt(ptsA, jx + 2)).toBeCloseTo(sourceY, 6);
    // ... and the straight member never leaves the row at all, so the whole
    // prefix reading above is about the bent member's peel-off.
    for (const p of ptsA) expect(p[1]).toBe(sourceY);

    // One dot for the group: the non-owner carries nothing.
    expect(other.fanoutJunctionX).toBeUndefined();
    expect(other.fanoutJunctionY).toBeUndefined();
  });

  it("marks the other decline too: a span past FANOUT_SPAN_MAX", () => {
    // The band is declined from both sides. Over-long spans are the roomier
    // case: the shared prefix runs to the bend column, far from the port, so the
    // dot lands well out in the corridor rather than against the source card.
    const gap = FANOUT_SPAN_MAX + 200;
    const src = srcNode();
    const tgtA = consumer("tgtA", gap, 0);
    const tgtB = consumer("tgtB", gap, 200);
    const nodes: RFAnyNode[] = [src, tgtA, tgtB];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3)),
    ];

    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item"]);

    const out = deconflictChipAnchors(nodes, declined);
    const jx = dataOf(out, "e:a").fanoutJunctionX!;
    const ptsA = drawnPoints(tgtA);
    const ptsB = drawnPoints(tgtB);
    expect(yAt(ptsA, jx)).toBeCloseTo(sourceY, 6);
    expect(yAt(ptsB, jx)).toBeCloseTo(sourceY, 6);
    expect(yAt(ptsB, jx + 2)).not.toBeCloseTo(sourceY, 6);
    // Out in the corridor: past the source card's own port zone, not hugging it.
    expect(jx - sourceX).toBeGreaterThan(FANOUT_SPAN_MIN);
    expect(dataOf(out, "e:b").fanoutJunctionX).toBeUndefined();
  });

  it("stamps the FIRST peel-off when two members bend at different columns", () => {
    // Three members off one port: a straight one plus two that bend at
    // different columns (different target distances => different bend
    // midpoints). The line stops being shared where the EARLIEST of them
    // leaves, so the dot belongs at the smaller column -- everything past it is
    // already fewer lines than the reader sees at the port.
    const src = srcNode();
    const nearGap = FANOUT_SPAN_MAX + 200;
    const farGap = FANOUT_SPAN_MAX + 700;
    const tgtA = consumer("tgtA", nearGap, 0); // straight
    const tgtB = consumer("tgtB", nearGap, 200); // early bend
    const tgtC = consumer("tgtC", farGap, 300); // late bend
    const nodes: RFAnyNode[] = [src, tgtA, tgtB, tgtC];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3)),
      rateEdge("e:c", "src", "tgtC", new Fraction(4)),
    ];

    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item", "item"]);
    expect(new Set(edges.map((e) => e.target)).size).toBe(3);

    // Premise: the drawn geometry really has TWO distinct peel-off columns and
    // one member that never leaves the row -- otherwise "first" is vacuous.
    const bendB = bendXOf(drawnPoints(tgtB))!;
    const bendC = bendXOf(drawnPoints(tgtC))!;
    expect(bendXOf(drawnPoints(tgtA))).toBeUndefined();
    expect(bendB).toBeLessThan(bendC);

    const out = deconflictChipAnchors(nodes, declined);
    const jx = dataOf(out, "e:a").fanoutJunctionX; // lex-smallest id owns it
    expect(jx).toBe(Math.min(bendB, bendC));
    expect(jx).toBe(bendB);
    // The last shared column, not the last column anyone shares with anyone:
    // stamping the later bend would put the dot where member B has already gone.
    expect(jx).not.toBe(bendC);
    expect(dataOf(out, "e:a").fanoutJunctionY).toBe(sourceY);
    expect(dataOf(out, "e:b").fanoutJunctionX).toBeUndefined();
    expect(dataOf(out, "e:c").fanoutJunctionX).toBeUndefined();
  });

  it("stamps nothing when the only bend happens at the port itself", () => {
    // A jogged source column (srcColX, stamped by jogForwardLegs when the plain
    // leg is blocked) can put the bend on the very first vertex: the member
    // turns as it leaves the handle. There is no shared run to mark then, and a
    // dot at the port would read as part of the source card's own output row.
    const src = srcNode();
    const gap = FANOUT_SPAN_MAX + 200;
    const tgtA = consumer("tgtA", gap, 0); // straight
    const tgtB = consumer("tgtB", gap, 200);
    // Column one chamfer right of the port => the pre-bend horizontal collapses
    // to zero length and the turn starts at the port vertex.
    const hints: RoutingHints = { srcColX: sourceX + CHAMFER };
    const nodes: RFAnyNode[] = [src, tgtA, tgtB];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3), hints),
    ];

    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item"]);
    expect(new Set(edges.map((e) => e.target)).size).toBe(2);

    // Premise: member "b" DOES bend, and it bends at the port x itself -- the
    // group is otherwise a perfectly ordinary two-member decline.
    const ptsB = drawnPoints(tgtB, hints);
    expect(ptsB.some((p) => Math.abs(p[1] - sourceY) > 1)).toBe(true);
    expect(bendXOf(ptsB)).toBe(sourceX);
    expect(bendXOf(drawnPoints(tgtA))).toBeUndefined();

    const out = deconflictChipAnchors(nodes, declined);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });

  it("marks the forward split and ignores a backward member in the group", () => {
    // A backward member leaves the port and immediately turns onto its own
    // detour rail, so it shares no forward prefix with the others. It must not
    // pull the dot back to its rail column: the split the reader sees is where
    // the forward members part.
    const src = srcNode();
    const gap = FANOUT_SPAN_MAX + 200;
    const tgtA = consumer("tgtA", gap, 0); // forward, straight
    const tgtB = consumer("tgtB", gap, 200); // forward, bends
    const tgtC = consumer("tgtC", -gap, 200); // backward
    const nodes: RFAnyNode[] = [src, tgtA, tgtB, tgtC];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3)),
      rateEdge("e:c", "src", "tgtC", new Fraction(4)),
    ];

    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item", "item"]);

    // Premise: "c" really is drawn backward (its path ends left of where it
    // started), and it turns off the source row EARLIER than "b" bends -- so a
    // stamper that counted it would move the dot.
    const ptsC = drawnPoints(tgtC);
    expect(ptsC[ptsC.length - 1]![0]).toBeLessThan(ptsC[0]![0]);
    const bendB = bendXOf(drawnPoints(tgtB))!;
    const bendC = bendXOf(ptsC)!;
    expect(bendC).toBeGreaterThan(sourceX);
    expect(bendC).toBeLessThan(bendB);

    const out = deconflictChipAnchors(nodes, declined);
    expect(dataOf(out, "e:a").fanoutJunctionX).toBe(bendB);
    expect(dataOf(out, "e:a").fanoutJunctionY).toBe(sourceY);
    expect(dataOf(out, "e:b").fanoutJunctionX).toBeUndefined();
    expect(dataOf(out, "e:c").fanoutJunctionX).toBeUndefined();
  });

  it("stamps nothing for a forward + backward pair", () => {
    // Drop the backward member and one forward edge is left: a lone line off
    // the port, nothing to split. The pair must stay unmarked even though the
    // backward member's own detour turn sits right of the port.
    const src = srcNode();
    const gap = FANOUT_SPAN_MAX + 200;
    const tgtA = consumer("tgtA", gap, 0);
    const tgtC = consumer("tgtC", -gap, 200);
    const nodes: RFAnyNode[] = [src, tgtA, tgtC];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtA", new Fraction(2)),
      rateEdge("e:c", "src", "tgtC", new Fraction(4)),
    ];

    const declined = routeFanoutEdges(nodes, edges);
    expect(declined.map((e) => e.type)).toEqual(["item", "item"]);
    expect(new Set(edges.map((e) => e.target)).size).toBe(2);

    // Premise: "c" is backward and does turn off the row at a column right of
    // the port, so only the backward rule keeps this pair unmarked.
    const ptsC = drawnPoints(tgtC);
    expect(ptsC[ptsC.length - 1]![0]).toBeLessThan(ptsC[0]![0]);
    expect(bendXOf(ptsC)!).toBeGreaterThan(sourceX);
    expect(bendXOf(drawnPoints(tgtA))).toBeUndefined();

    const out = deconflictChipAnchors(nodes, declined);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });

  it("stamps nothing for a lone edge off the port", () => {
    const src = srcNode();
    const tgtB = consumer("tgtB", DECLINED_GAP, 200);
    const nodes: RFAnyNode[] = [src, tgtB];
    const edges: Edge[] = [rateEdge("e:b", "src", "tgtB", new Fraction(3))];

    // Premise: this edge DOES bend, so only the member count keeps it unmarked.
    expect(drawnPoints(tgtB).some((p) => p[1] !== sourceY)).toBe(true);

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });

  it("stamps nothing for a parallel bundle into ONE target", () => {
    // Same (item, source) edges into the same unit are one visual line carrying
    // one flow: nothing diverges, so a dot would invent a split.
    const src = srcNode();
    const tgtB = consumer("tgtB", DECLINED_GAP, 200);
    const nodes: RFAnyNode[] = [src, tgtB];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "tgtB", new Fraction(2)),
      rateEdge("e:b", "src", "tgtB", new Fraction(3)),
    ];
    expect(new Set(edges.map((e) => e.target)).size).toBe(1);

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });

  it("stamps nothing when no member ever leaves the source row", () => {
    // Two consumers on the source's own row at different distances: both lines
    // run straight along one another to their ports and never visibly split, so
    // there is no divergence point to mark.
    const src = srcNode();
    const near = consumer("near", DECLINED_GAP, 0);
    const far = consumer("far", DECLINED_GAP + 12, 0);
    const nodes: RFAnyNode[] = [src, near, far];
    const edges: Edge[] = [
      rateEdge("e:a", "src", "near", new Fraction(2)),
      rateEdge("e:b", "src", "far", new Fraction(3)),
    ];
    expect(new Set(edges.map((e) => e.target)).size).toBe(2);
    for (const pts of [drawnPoints(near), drawnPoints(far)]) {
      for (const p of pts) expect(p[1]).toBe(sourceY);
    }

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });

  it("stamps nothing on a REAL fan-out trunk (BusEdge already draws its dot)", () => {
    // Same source port, but a gap inside the accepted band: routeFanoutEdges
    // retypes both members to bus and gives them a junction of their own. The
    // item-edge marker must not double up on it.
    const S = recipeNode("S", 0, 100, mkRecipe("S", [], [ITEM]));
    const A = orderedRecipeNode("A", 500, 0, [ITEM]);
    const B = orderedRecipeNode("B", 500, 260, [ITEM]);
    const nodes: RFAnyNode[] = [S, A, B];
    const edges: Edge[] = [
      rateEdge("e:a", "S", "A", new Fraction(2)),
      rateEdge("e:b", "S", "B", new Fraction(3)),
    ];

    const fanned = routeFanoutEdges(nodes, edges);
    expect(dataOf(fanned, "e:a").fanout).toBe(true); // premise: trunk formed
    expect(dataOf(fanned, "e:b").fanout).toBe(true);

    const out = deconflictChipAnchors(nodes, fanned);
    for (const e of out) {
      expect((e.data as FanoutData).fanoutJunctionX).toBeUndefined();
    }
  });
});
