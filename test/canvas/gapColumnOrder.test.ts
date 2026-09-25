// One column order per gap (gapColumnOrder.ts), on synthetic gaps.
//
// Product cards draw their one port at half their height, so each fixture
// states its port rows directly: a card at y with height h has its port at
// y + h / 2. Layer 0 stands at x 0..100, layer 1 at 400..500, layer 2 at
// 800..900, and gap 0 (x 100..400) is where every column under test stands.

import { describe, it, expect } from "vitest";

import { buildGapColumnOrder } from "../../src/canvas/gapColumnOrder";
import type { GapRecord } from "../../src/canvas/layerModel";
import { mkEdge, productNode } from "./busRouting.testkit";

const LAYER_X = [0, 400, 800];
const card = (id: string, layer: number, y: number, h: number) =>
  productNode(id, LAYER_X[layer]!, y, 100, h);

const gap = (index: number): GapRecord => {
  const left = LAYER_X[index]! + 100;
  const right = LAYER_X[index + 1]!;
  return {
    scope: "",
    index,
    left,
    right,
    sourceZone: { left, right: left + 50 },
    columnZone: { left: left + 50, right: right - 50 },
    targetZone: { left: right - 50, right },
    columns: 2,
  };
};
const GAPS = [gap(0), gap(1)];
// A layer-1 card clear of every row under test, so an edge from layer 0 to
// layer 2 skips a layer and takes a bend column rather than a late drop.
const FILLER = card("mid", 1, 2000, 40);

describe("gap column order", () => {
  it("orders all four column kinds by the left/right row constraint", () => {
    const nodes = [
      // Fan-out trunk of "a": port row 10, near members into rows 20 and 220.
      card("s1", 0, 0, 20),
      card("t1", 1, 0, 40),
      card("t2", 1, 200, 40),
      // Bend (skips layer 1): source row 215, target row 520.
      card("s4", 0, 205, 20),
      card("f1", 2, 500, 40),
      // Late drop: source row 515, entry row 710.
      card("s5", 0, 505, 20),
      card("t4", 1, 690, 40),
      // Fan-in trunk of "b": source rows 710 and 760, merge row 920.
      card("s2", 0, 700, 20),
      card("s3", 0, 750, 20),
      card("t3", 1, 900, 40),
    ];
    const edges = [
      mkEdge("e:0:s1->t1:a", "s1", "t1", "a"),
      mkEdge("e:1:s1->t2:a", "s1", "t2", "a"),
      mkEdge("e:2:s4->f1:c", "s4", "f1", "c"),
      mkEdge("e:3:s5->t4:d", "s5", "t4", "d"),
      mkEdge("e:4:s2->t3:b", "s2", "t3", "b"),
      mkEdge("e:5:s3->t3:b", "s3", "t3", "b"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);

    const fanOut = order.trunkId("a|s1");
    const fanIn = order.trunkId("b|t3|in");
    const bend = order.bendId("e:2:s4->f1:c");
    const arrival = order.arrivalRowId("t4", 710);
    for (const id of [fanOut, fanIn, bend, arrival]) {
      expect(order.byId.has(id), id).toBe(true);
    }

    // The bend's source row (215) lies within the floor of the fan-out's
    // member row (220), the late drop's source row (515) within the bend's
    // target row (520), and the fan-in's member row (710) on the late drop's
    // entry row (710).
    expect(order.mustStandLeft(bend, fanOut)).toBe(true);
    expect(order.mustStandLeft(arrival, bend)).toBe(true);
    expect(order.mustStandLeft(fanIn, arrival)).toBe(true);

    // The resolved order follows every constraint, against the kinds' own
    // sense (fan-outs first, fan-ins last).
    const ranks = [fanIn, arrival, bend, fanOut].map((id) => order.rankOf(id)!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const c of order.byId.values()) {
      for (const right of order.rightNeighbours(c.id)) {
        expect(order.rankOf(c.id)!).toBeLessThan(order.rankOf(right)!);
      }
    }

    // Rank beats the kind anchors: all four walk from the zone's left, left
    // to right in that order.
    const xs = [fanIn, arrival, bend, fanOut].map((id) => order.laneColumn(id));
    expect(xs.every((x) => x !== undefined)).toBe(true);
    expect(xs).toEqual([...xs].sort((a, b) => a! - b!));
    expect(order.cycleOwed.size).toBe(0);
  });

  it("leaves a pair whose two orders cost the same to neither", () => {
    // Two bends each leaving on the other's arriving row: A's source row 10
    // sits on B's target row 15, B's source row 315 on A's target row 320.
    // Either order costs one floor break and one crossing, so the pair is
    // unavoidable rather than a two-member cycle, and nobody owes a jog.
    const nodes = [
      card("sa", 0, 0, 20),
      card("fa", 2, 300, 40),
      card("sb", 0, 305, 20),
      card("fb", 2, -5, 40),
      FILLER,
    ];
    const edges = [
      mkEdge("e:3:sa->fa:x", "sa", "fa", "x"),
      mkEdge("e:7:sb->fb:y", "sb", "fb", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);

    const a = order.bendId("e:3:sa->fa:x");
    const b = order.bendId("e:7:sb->fb:y");
    expect(order.byId.get(a)?.leftRows.map((r) => r.y)).toEqual([10]);
    expect(order.byId.get(b)?.rightRows.map((r) => r.y)).toEqual([15]);
    expect([...order.cycleOwed]).toEqual([]);
    expect(order.mustStandLeft(a, b)).toBe(false);
    expect(order.mustStandLeft(b, a)).toBe(false);
    expect(order.unavoidable).toHaveLength(1);
  });

  it("marks the later-routed of two same-side rows overlapping past a stub", () => {
    // Two bends out of layer 0 on source rows 10 and 27: within the floor,
    // and both run from their ports to their columns whatever the order.
    // They diverge (A rises to -300, B falls to 620), so neither order
    // crosses a vertical and the relation says nothing about them.
    const nodes = [
      card("sa", 0, 0, 20),
      card("sb", 0, 22, 10),
      card("fa", 2, -320, 40),
      card("fb", 2, 600, 40),
      FILLER,
    ];
    const edges = [
      mkEdge("e:9:sa->fa:x", "sa", "fa", "x"),
      mkEdge("e:4:sb->fb:y", "sb", "fb", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const a = order.bendId("e:9:sa->fa:x");
    const b = order.bendId("e:4:sb->fb:y");
    expect(order.mustStandLeft(a, b) || order.mustStandLeft(b, a)).toBe(false);

    // Columns 100 and 116 units out of the ports: the pair shares 100.
    const far = new Map([
      [a, 200],
      [b, 216],
    ]);
    expect([...order.sameSideOwed((id) => far.get(id))]).toEqual([
      "e:9:sa->fa:x",
    ]);

    // Columns within a port stub of the ports share no more than a stub.
    const near = new Map([
      [a, 110],
      [b, 124],
    ]);
    expect(order.sameSideOwed((id) => near.get(id)).size).toBe(0);
  });

  // The relation compares both orders of a pair from their rows: the order in
  // which a run of one crosses the other's vertical (or breaks the floor) is
  // the one ruled out.
  it("nests two rising bends with the upper one left", () => {
    // Upper: row 300 up to 100. Lower: row 340 up to 140. With the lower one
    // left, its target run (140) and the upper's source run (300) each cross
    // the other's vertical.
    const nodes = [
      card("su", 0, 290, 20),
      card("sl", 0, 330, 20),
      card("fu", 2, 80, 40),
      card("fl", 2, 125, 30),
      FILLER,
    ];
    const edges = [
      mkEdge("e:1:su->fu:x", "su", "fu", "x"),
      mkEdge("e:2:sl->fl:y", "sl", "fl", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const upper = order.bendId("e:1:su->fu:x");
    const lower = order.bendId("e:2:sl->fl:y");
    expect(order.mustStandLeft(upper, lower)).toBe(true);
    expect(order.mustStandLeft(lower, upper)).toBe(false);
    expect(order.unavoidable).toEqual([]);
  });

  it("nests two falling bends with the lower one left", () => {
    // Upper: row 100 down to 300. Lower: row 140 down to 340.
    const nodes = [
      card("su", 0, 90, 20),
      card("sl", 0, 130, 20),
      card("fu", 2, 290, 20),
      card("fl", 2, 330, 20),
      FILLER,
    ];
    const edges = [
      mkEdge("e:1:su->fu:x", "su", "fu", "x"),
      mkEdge("e:2:sl->fl:y", "sl", "fl", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const upper = order.bendId("e:1:su->fu:x");
    const lower = order.bendId("e:2:sl->fl:y");
    expect(order.mustStandLeft(lower, upper)).toBe(true);
    expect(order.mustStandLeft(upper, lower)).toBe(false);
    expect(order.unavoidable).toEqual([]);
  });

  it("leaves a pair that crosses once in either order unconstrained and counts it", () => {
    // Outer: row 100 down to 400. Inner: row 200 down to 300, inside it.
    // Outer left: the inner's source run crosses the outer's vertical. Inner
    // left: the inner's target run crosses it.
    const nodes = [
      card("so", 0, 90, 20),
      card("si", 0, 190, 20),
      card("fi", 2, 290, 20),
      card("fo", 2, 390, 20),
      FILLER,
    ];
    const edges = [
      mkEdge("e:1:so->fo:x", "so", "fo", "x"),
      mkEdge("e:2:si->fi:y", "si", "fi", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const outer = order.bendId("e:1:so->fo:x");
    const inner = order.bendId("e:2:si->fi:y");
    expect(order.mustStandLeft(outer, inner)).toBe(false);
    expect(order.mustStandLeft(inner, outer)).toBe(false);
    expect(order.unavoidable).toEqual([
      { gapKey: order.byId.get(outer)!.gapKey, a: outer, b: inner },
    ]);
    expect(order.cycleOwed.size).toBe(0);
  });

  it("puts a floor break before any crossing", () => {
    // A: row 100 down to 150. B: row 200 up to 100. A left: A's target run
    // (150) crosses B's vertical, one crossing. B left: B's target run and
    // A's source run share row 100 between the columns, one floor break. The
    // merge costs more, so A stands left and takes the crossing.
    const nodes = [
      card("sa", 0, 90, 20),
      card("sb", 0, 190, 20),
      card("fa", 2, 140, 20),
      card("fb", 2, 90, 20),
      FILLER,
    ];
    const edges = [
      mkEdge("e:1:sa->fa:x", "sa", "fa", "x"),
      mkEdge("e:2:sb->fb:y", "sb", "fb", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const a = order.bendId("e:1:sa->fa:x");
    const b = order.bendId("e:2:sb->fb:y");
    expect(order.mustStandLeft(a, b)).toBe(true);
    expect(order.mustStandLeft(b, a)).toBe(false);
    expect(order.unavoidable).toEqual([]);
  });

  it("still keeps a left row off a near right row (the floor case)", () => {
    // A: row 10 down to 300. B: row -100 up to 15. A's source run on 10 and
    // B's target run on 15 share the stretch between the columns only when B
    // stands left; A standing left breaks nothing.
    const nodes = [
      card("sa", 0, 0, 20),
      card("sb", 0, -110, 20),
      card("fa", 2, 290, 20),
      card("fb", 2, 5, 20),
      FILLER,
    ];
    const edges = [
      mkEdge("e:1:sa->fa:x", "sa", "fa", "x"),
      mkEdge("e:2:sb->fb:y", "sb", "fb", "y"),
    ];
    const order = buildGapColumnOrder(nodes, edges, GAPS);
    const a = order.bendId("e:1:sa->fa:x");
    const b = order.bendId("e:2:sb->fb:y");
    expect(order.mustStandLeft(a, b)).toBe(true);
    expect(order.mustStandLeft(b, a)).toBe(false);
    expect(order.rankOf(a)!).toBeLessThan(order.rankOf(b)!);
    expect(order.unavoidable).toEqual([]);
  });
});
