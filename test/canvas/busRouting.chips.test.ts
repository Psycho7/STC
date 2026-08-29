// Chip pitch and de-confliction: the shared chip/lane pitch constants and
// deconflictChipAnchors (bus lane cascade, render-vs-reconstruction tripwires,
// and the merged entry/bus/midpoint collision set). Fixtures come from
// ./busRouting.testkit.

import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  routeFanoutEdges,
  BUS_SPAN_THRESHOLD,
  LANE_SPACING,
  LANE_TOP_OFFSET,
} from "../../src/canvas/busRouting";
import { portOffsetY } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
  productNode,
  maxBottom,
  minTop,
  busDropDyOf,
  busChipDyOf,
} from "./busRouting.testkit";

describe("chip stack pitch", () => {
  it("couples the lane pitch to the same max-scale chip box height", () => {
    // Adjacent lanes carry rise chips a max-scale box height apart, so their
    // boxes abut instead of interpenetrating at the fit-zoom floor.
    expect(LANE_SPACING).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(LANE_SPACING).toBe(48);
  });
});

function labelDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { labelDy?: number }
    | undefined;
  return d?.labelDy ?? 0;
}

function labelDxOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { labelDx?: number }
    | undefined;
  return d?.labelDx ?? 0;
}

function busRiseHiddenOf(edges: Edge[], id: string): boolean {
  const d = edges.find((e) => e.id === id)?.data as
    | { busRiseHidden?: true }
    | undefined;
  return d?.busRiseHidden === true;
}

// The raw drop stamp, which busDropDyOf's 0 default cannot distinguish from an
// absent one. A multi-member trunk draws no aggregate chip and so seats none:
// nothing is stamped at all, not "seated at offset 0".
function busDropDyRawOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { busDropDy?: number }
    | undefined;
  return d?.busDropDy;
}

// The rise slot as it stands AFTER seating: routeBusEdges' trunk-wide slot,
// replaced by the clamped one where the seating pass moved it. This is the x
// BusEdge anchors the rise chip at and contentBounds frames.
function busChipXOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipX?: number }
    | undefined;
  return d?.busChipX;
}

// The raw rise stamp, which busChipDyOf's 0 default cannot distinguish from an
// absent one: a member seated on the lane stamps nothing at all.
function busChipDyRawOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipDy?: number }
    | undefined;
  return d?.busChipDy;
}

// A collapsed-extent lane trunk: every rise slot stacked on the drop column.
// routeBusEdges no longer produces one (span-only membership means the run is
// always at least a layer long), so these fixtures stamp the bus data by hand
// -- the seating rules under test are generic and still fire whenever chips
// crowd one column on a real trunk.
const shortRunBus = (
  id: string,
  source: string,
  target: string,
  item: string,
  laneY: number,
  opts: { owner: boolean; memberCount: number; band?: "top" | "bottom" },
): Edge => ({
  id,
  source,
  target,
  type: "bus",
  data: {
    item,
    rate: new Fraction(1),
    laneY,
    trunkKey: item + "|" + source,
    busChipX: 180, // the drop column: 148 (agg right edge) + PORT_STUB + CHAMFER
    busChipOwner: opts.owner,
    busMemberCount: opts.memberCount,
    ...(opts.owner
      ? { busTotalRate: new Fraction(opts.memberCount) }
      : {}),
    busBand: opts.band ?? ("bottom" as const),
  },
});

describe("deconflictChipAnchors: bus lane cascade", () => {
  it("keeps the rises the short run supports; no aggregate column is reserved", () => {
    // Two feeders share one trunk (ore|agg) and sit so close that the lane
    // extent collapses: both rise slots land on the drop column. The trunk is
    // multi-member, so it draws and seats NO aggregate chip (issue #39) and the
    // kept set starts empty: the first member tried keeps its slot and the second,
    // 0 units away, cannot clear the wide-chip x-separation (2 * 120 = 240) and is
    // hidden rather than cascaded off the band into empty canvas (issue #24). The
    // two rises tie on distance from the drop column, so edge id orders them and
    // e0 takes the slot. The hidden member's rate stays on its target card's input
    // row and its edge tooltip. An anchor node up top keeps the trunk in the lower
    // half (bottom band), matching the original fixture.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, mkRecipe("anchor", ["a"], ["b"])),
      inputProductNode("agg", "ore", 0, 1000),
      inputProductNode("t1", "ore", 200, 1000),
      inputProductNode("t2", "ore", 200, 1200),
    ];
    const laneY = maxBottom(nodes) + LANE_TOP_OFFSET;
    const edges = [
      shortRunBus("e0", "agg", "t1", "ore", laneY, {
        owner: true,
        memberCount: 2,
      }),
      shortRunBus("e1", "agg", "t2", "ore", laneY, {
        owner: false,
        memberCount: 2,
      }),
    ];
    const out = deconflictChipAnchors(nodes, edges);
    // Nothing seats a drop chip on a multi-member trunk, so the owner carries no
    // busDropDy at all.
    expect(busDropDyRawOf(out, "e0")).toBeUndefined();
    // e0 takes the freed slot; e1 is hidden, not cascaded. e0's rise lifts one
    // pitch off the lane rather than seating flush on it: its slot sits a
    // chamfer from the trunk's junction dot, so the seat takes the dot keep-off
    // pass (#50) -- the same "beside the lane" offset the cascade uses, and
    // still inside the one-pitch band that distinguishes a lane-side chip from
    // an orphaned one.
    expect(busRiseHiddenOf(out, "e0")).toBe(false);
    expect(busChipDyOf(out, "e0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(busRiseHiddenOf(out, "e1")).toBe(true);
    expect(busChipDyOf(out, "e1")).toBe(0);
  });

  it("keeps the farther rise chip and hides the near one when only one fits", () => {
    // A hand-built 2-member trunk (w|s) whose drop column sits at
    // busDropBase(sourceRight) = 132. The two slots are only 200 apart (232 and
    // 432), under the wide-chip separation (2 * 120 = 240), so the run supports
    // exactly ONE rise and the ordering rule decides which. The capacity check
    // tries members FARTHEST-from-the-drop-column first: e1 (432, 300 off) is
    // tried before e0 (232, 100 off) and takes the only slot; e0 then sits 200
    // from the kept x and is hidden. A member that reads at the consumer end
    // beats a near one, so inverting the comparator would flip this result.
    const laneY = 300;
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60), // right edge 100 -> dropX 132
      productNode("t0", 900, 0, 100, 60),
      productNode("t1", 900, 200, 100, 60),
    ];
    const mkBus = (
      id: string,
      target: string,
      busChipX: number,
      owner: boolean,
    ): Edge => ({
      id,
      source: "s",
      target,
      type: "bus",
      data: {
        item: "w",
        rate: new Fraction(1),
        laneY,
        trunkKey: "w|s",
        busChipX,
        busChipOwner: owner,
        busMemberCount: 2,
        busBand: "bottom" as const,
      },
    });
    const edges: Edge[] = [
      mkBus("e0", "t0", 232, true), // near member, the elected owner
      mkBus("e1", "t1", 432, false), // far member
    ];
    const out = deconflictChipAnchors(nodes, edges);
    // The multi-member trunk stamps no drop offset: no aggregate chip is seated.
    expect(busDropDyRawOf(out, "e0")).toBeUndefined();
    // The far member wins the single slot; the near one is hidden, not cascaded.
    expect(busRiseHiddenOf(out, "e1")).toBe(false);
    expect(busChipDyOf(out, "e1")).toBe(0);
    expect(busRiseHiddenOf(out, "e0")).toBe(true);
    expect(busChipDyOf(out, "e0")).toBe(0);
  });

  it("hides a lane rise whose cascade carries it off the band", () => {
    // A KEPT rise (the capacity check clears both members: their columns sit
    // exactly the wide-chip separation apart) whose lane seat is blocked by
    // foreign lines at the lane and at the next two steps below it. The seat
    // clears only 3 pitches down -- far off the band, in empty canvas with no
    // stroke touching it -- so the rise is hidden instead, like a crowded one.
    // Trunk "b|s2"'s lane at y=410 both forces that third step and gives the
    // pop a witness: its own rise column coincides with the hidden chip's
    // would-be seat (700, 444), 34 units away, so a phantom box left behind
    // would push it off ITS lane.
    const laneY = 300;
    const mkBus = (
      id: string,
      source: string,
      target: string,
      item: string,
      lane: number,
      busChipX: number,
      owner: boolean,
      memberCount: number,
    ): Edge => ({
      id,
      source,
      target,
      type: "bus",
      data: {
        item,
        rate: new Fraction(1),
        laneY: lane,
        trunkKey: `${item}|${source}`,
        busChipX,
        busChipOwner: owner,
        busMemberCount: memberCount,
        busBand: "bottom" as const,
      },
    });
    const foreign = (id: string): Edge => ({
      id,
      source: `fs${id}`,
      target: `ft${id}`,
      type: "item",
      data: { item: "f", rate: new Fraction(1) },
    });
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60), // right edge 100
      productNode("t0", 1400, 0, 100, 60), // in-port y 30
      productNode("t1", 1400, 200, 100, 60), // in-port y 230
      productNode("s2", 0, 700, 100, 60),
      productNode("t2", 1400, 700, 100, 60),
      // Two foreign horizontals at y = 300 and y = 348, spanning x 600..800.
      productNode("fsf0", 500, 270, 100, 60),
      productNode("ftf0", 800, 270, 100, 60),
      productNode("fsf1", 500, 318, 100, 60),
      productNode("ftf1", 800, 318, 100, 60),
    ];
    const edges: Edge[] = [
      mkBus("e0", "s", "t0", "a", laneY, 700, true, 2),
      mkBus("e1", "s", "t1", "a", laneY, 940, false, 2),
      mkBus("b0", "s2", "t2", "b", 410, 700, true, 1),
      foreign("f0"),
      foreign("f1"),
    ];
    const out = deconflictChipAnchors(nodes, edges);
    // e0's lane seat and the next two steps are blocked (y = 300 and 348 by the
    // foreign horizontals, y = 372..420 by trunk b's lane at 410), so its only
    // clear seat is 3 pitches off the lane: hidden.
    expect(busRiseHiddenOf(out, "e0")).toBe(true);
    expect(busChipDyOf(out, "e0")).toBe(0);
    // Its uncrowded sibling is untouched, and so is trunk b's rise -- proof the
    // hidden chip left no phantom box behind.
    expect(busRiseHiddenOf(out, "e1")).toBe(false);
    expect(busChipDyOf(out, "e1")).toBe(0);
    expect(busRiseHiddenOf(out, "b0")).toBe(false);
    expect(busChipDyOf(out, "b0")).toBe(0);
  });

  it("keeps a lane rise that clears one step off its lane", () => {
    // The same trunk with only the lane-level foreign line: the rise clears one
    // pitch below the lane, still adjacent to it and reading as a lane chip, so
    // it seats and stamps its offset rather than hiding. One step is the line
    // between "beside the lane" and "floating off the band".
    const laneY = 300;
    const mkBus = (
      id: string,
      target: string,
      busChipX: number,
      owner: boolean,
    ): Edge => ({
      id,
      source: "s",
      target,
      type: "bus",
      data: {
        item: "a",
        rate: new Fraction(1),
        laneY,
        trunkKey: "a|s",
        busChipX,
        busChipOwner: owner,
        busMemberCount: 2,
        busBand: "bottom" as const,
      },
    });
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      productNode("t1", 1400, 200, 100, 60),
      productNode("fs", 500, 270, 100, 60),
      productNode("ft", 800, 270, 100, 60),
    ];
    const edges: Edge[] = [
      mkBus("e0", "t0", 700, true),
      mkBus("e1", "t1", 940, false),
      {
        id: "f0",
        source: "fs",
        target: "ft",
        type: "item",
        data: { item: "f", rate: new Fraction(1) },
      },
    ];
    const out = deconflictChipAnchors(nodes, edges);
    expect(busRiseHiddenOf(out, "e0")).toBe(false);
    expect(busChipDyOf(out, "e0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(busRiseHiddenOf(out, "e1")).toBe(false);
    expect(busChipDyOf(out, "e1")).toBe(0);
  });

  it("leaves a well-spread trunk's chips beside their own runs", () => {
    // Three members feeding distinct far layers spread their rise slots evenly
    // across a wide lane extent, so no chip crowds another and none is nudged.
    // The trunk is multi-member, so it seats no aggregate drop chip either.
    // The two far members keep their lane seat. The NEAREST member does not:
    // its trunk-wide slot (2533.5) sat 1400 units past its own rise column, so
    // the slot clamp pulls it back onto its own run, where the run's own
    // junction dot sits -- the wide box swallows the dot wherever it lands near
    // that end, so the dot keep-off pass (#50) lifts it one pitch off the lane.
    // Beside its own run beats spread onto a sibling's stroke.
    const r = mkRecipe("r", ["a"], ["b"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far + 4000, 300, r),
      recipeNode("t3", far + 8000, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    for (const id of ["e0", "e1", "e2"]) {
      expect(busDropDyRawOf(out, id)).toBeUndefined();
      expect(busRiseHiddenOf(out, id)).toBe(false);
    }
    expect(busChipDyOf(out, "e1")).toBe(0);
    expect(busChipDyOf(out, "e2")).toBe(0);
    // Top band, so the nearest member's dot keep-off lifts it upward.
    expect(busChipDyOf(out, "e0")).toBe(-(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT));
    expect(busChipXOf(out, "e0")).toBe(1130);
  });

  it("holds both drop chips on their junctions when only foreign lines cross", () => {
    // Two SINGLE-member trunks off ONE aggregate (items "a" and "b" -> lanes 0
    // and 1, same drop column) -- a lone member still draws its drop chip, so
    // this is where drop seating survives (issue #39). Seating is two-phase (all
    // drops, then all rises) so no CHIP can knock a drop off its junction.
    // Trunk b's chip (bottom lane) holds: nothing foreign crosses it. Trunk a's
    // chip is crossed -- trunk b's drop vertical descends through its junction on
    // the shared drop column -- and used to cascade two pitches to clear it,
    // landing well below both lanes in empty canvas where no rule hides it. The
    // drop cascade is capped at one pitch now, and inside that cap the
    // foreign-line preference is the first thing relaxed, so the chip stays on
    // its own junction and grazes b's vertical instead. b's placed CHIP one lane
    // down stays hard throughout; it just does not reach the lane-0 seat.
    // t2 carries no edge; it stays in the fixture to hold the band geometry the
    // offsets are measured in.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, mkRecipe("anchor", ["x"], ["y"])),
      inputProductNode("agg", "ore", 0, 1000),
      inputProductNode("t1", "ore", 200, 1000),
      inputProductNode("t2", "ore", 200, 1200),
      inputProductNode("t3", "ore", 200, 1400),
    ];
    const bandTop = maxBottom(nodes) + LANE_TOP_OFFSET;
    const edges = [
      shortRunBus("e0", "agg", "t1", "a", bandTop, {
        owner: true,
        memberCount: 1,
      }),
      shortRunBus("e2", "agg", "t3", "b", bandTop + LANE_SPACING, {
        owner: true,
        memberCount: 1,
      }),
    ];
    const out = deconflictChipAnchors(nodes, edges);
    expect(busDropDyOf(out, "e0")).toBe(0);
    expect(busDropDyOf(out, "e2")).toBe(0);
    // Both trunks are lone members, exempt from the CAPACITY check -- and on
    // this short run each rise sits on its own drop column, right under its own
    // drop chip. Trunk a's rise still cascades clean off the band and is hidden
    // by the off-band rule (a lone rise only restates its own drop's rate, which
    // is still on its junction above). Trunk b's rise clears one pitch below its
    // lane now that trunk a's drop no longer cascades down into that space, so
    // it keeps its seat: capping the drop gave the lower lane its room back.
    expect(busRiseHiddenOf(out, "e0")).toBe(true);
    expect(busChipDyOf(out, "e0")).toBe(0);
    expect(busRiseHiddenOf(out, "e2")).toBe(false);
    expect(busChipDyOf(out, "e2")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
  });

  it("cascades a lone top-band member's rise chip UP off its lane", () => {
    // A LONE member in the top band whose collapsed run puts the rise slot on
    // the drop column. A lone member is exempt from the #24 capacity hide (its
    // rise merely restates its own drop's rate but keeps it near the consumer),
    // so it still cascades -- and in the top band that cascade must run UPWARD
    // (negative dy) so the chip moves away from the graph below, not toward it.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0),
      recipeNode("low", 0, 3000, mkRecipe("low", ["a"], ["b"])),
    ];
    const laneY = minTop(nodes) - LANE_TOP_OFFSET;
    const edges = [
      shortRunBus("e0", "agg", "tap", "ore", laneY, {
        owner: true,
        memberCount: 1,
        band: "top",
      }),
    ];
    const out = deconflictChipAnchors(nodes, edges);
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    // Owner drop chip settles on the lane; the lone rise piles UPWARD off it.
    expect(busDropDyOf(out, "e0")).toBe(0);
    expect(busChipDyOf(out, "e0")).toBe(-pitch);
  });
});

describe("deconflictChipAnchors: bus rise slot clamp", () => {
  // routeBusEdges spreads a trunk's rise slots across the WHOLE trunk extent in
  // edge-id order, so a member's slot index says nothing about where that
  // member's own lane run ends. The seating pass clamps every slot into the
  // member's own resolved run and stamps the corrected x back onto edge data,
  // which is what BusEdge draws and what contentBounds frames.
  const laneY = 300;
  const mkBus = (
    id: string,
    target: string,
    busChipX: number | undefined,
    memberCount: number,
  ): Edge => ({
    id,
    source: "s",
    target,
    type: "bus",
    data: {
      item: "w",
      rate: new Fraction(1),
      laneY,
      trunkKey: "w|s",
      ...(busChipX === undefined ? {} : { busChipX }),
      busChipOwner: id === "e0",
      busMemberCount: memberCount,
      busBand: "bottom" as const,
    },
  });

  it("pulls every out-of-run slot back onto its member's own run", () => {
    // One trunk off a source whose right edge is 100, so every member drops at
    // busDropBase(100) = 132. Four members, three of them handed a slot at 2000
    // -- far past where their own lines leave the lane, the multi6 rise-anchor
    // family. Each clamps into its own run with a chamfer of slack:
    //   e0 forward to x=1400: run 132..1368, slot 800 already inside -> kept.
    //   e1 forward to x=600:  run 132..568, slot 2000 -> 568 - 8 = 560.
    //   e2 BACKWARD to x=-400: the run reverses (rise -432, drop 132) and the
    //      slot clamps to the drop end, 132 - 8 = 124.
    //   e3 forward to x=140: the gap is under the two-column budget, so the
    //      path is a hairpin with drop === rise === 120 and no interior at all
    //      -- the slot goes to that midpoint rather than a chamfer outside it.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      productNode("t1", 600, 200, 100, 60),
      productNode("t2", -400, 400, 100, 60),
      productNode("t3", 140, 600, 100, 60),
    ];
    const out = deconflictChipAnchors(nodes, [
      mkBus("e0", "t0", 800, 4),
      mkBus("e1", "t1", 2000, 4),
      mkBus("e2", "t2", 2000, 4),
      mkBus("e3", "t3", 2000, 4),
    ]);
    expect(busChipXOf(out, "e0")).toBe(800);
    expect(busChipXOf(out, "e1")).toBe(560);
    expect(busChipXOf(out, "e2")).toBe(124);
    expect(busChipXOf(out, "e3")).toBe(120);
    // e2 and e3 end up 4 units apart, far under the wide-chip separation, so the
    // capacity check hides one of them (ruling: shortening the runs hides more
    // rise chips, and the rate stays on the target card's input row). WHICH one
    // goes is decided by keep-order distance from the junction at 132: e3 sits
    // 12 out and e2 only 8, so e3 takes the slot and e2 is the overflow -- this
    // has nothing to do with run length (e2's backward run is 564 long, e3's
    // hairpin run is 0), because both clamp to within a few units of the drop
    // column. The clamp itself is per member and unaffected by the outcome.
    expect(busRiseHiddenOf(out, "e2")).toBe(true);
    expect(busRiseHiddenOf(out, "e3")).toBe(false);
  });

  it("stamps a clamped slot even when the member carries no other stamp", () => {
    // The same trunk without the hairpin member, so nothing crowds e2 out of
    // its seat: it seats on the lane (no busChipDy) and survives the capacity
    // check (no busRiseHidden), leaving the clamped x as the ONLY thing seating
    // has to say about it. That is the case the stamp-block's early return can
    // swallow, sending the stale trunk-wide 2000 to BusEdge instead of 124.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      productNode("t1", 600, 200, 100, 60),
      productNode("t2", -400, 400, 100, 60),
    ];
    const out = deconflictChipAnchors(nodes, [
      mkBus("e0", "t0", 800, 3),
      mkBus("e1", "t1", 2000, 3),
      mkBus("e2", "t2", 2000, 3),
    ]);
    expect(busChipXOf(out, "e2")).toBe(124);
    expect(busChipDyRawOf(out, "e2")).toBeUndefined();
    expect(busRiseHiddenOf(out, "e2")).toBe(false);
  });

  it("puts a member with no run interior at its run's midpoint", () => {
    // t1's left edge is 174, so the run is 132..142: ten units, positive but
    // under the two chamfers the clamp wants to keep clear. Clamping into
    // [lo + CHAMFER, hi - CHAMFER] would invert the interval and pin the chip
    // at 134, an arbitrary point that is neither end of the run. The collapse
    // branch takes the midpoint instead.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      productNode("t1", 174, 200, 100, 60),
    ];
    const out = deconflictChipAnchors(nodes, [
      mkBus("e0", "t0", 800, 2),
      mkBus("e1", "t1", 2000, 2),
    ]);
    expect(busChipXOf(out, "e1")).toBe(137);
  });

  it("leaves the lone long-run member with no slot at all", () => {
    // routeBusEdges deliberately omits the slot for a lone member on a long run
    // (#32) and BusEdge keys the rise chip's zoom-gate exemption on that
    // ABSENCE, so the clamp must not invent one: undefined in, undefined out.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
    ];
    const out = deconflictChipAnchors(nodes, [mkBus("e0", "t0", undefined, 1)]);
    expect(busChipXOf(out, "e0")).toBeUndefined();
  });
});

describe("deconflictChipAnchors: bus drop cascade cap", () => {
  // The drop chip is the only bus chip exempt from the label zoom gate and has
  // no hide rule, so its cascade is capped at one pitch: past that it reads as
  // an orphan floating off the band with nothing to bind it to a trunk.
  const laneY = 300;
  const loneBus = (target: string): Edge => ({
    id: "e0",
    source: "s",
    target,
    type: "bus",
    data: {
      item: "a",
      rate: new Fraction(1),
      laneY,
      trunkKey: "a|s",
      busChipOwner: true,
      busMemberCount: 1,
      busBand: "bottom" as const,
    },
  });
  // A foreign horizontal at y, drawn from x = -500 to x = 600 so it crosses the
  // drop column (132) while both its cards stay clear of the chip box there --
  // chip-vs-card is hard and would otherwise decide the seat instead.
  const foreign = (
    id: string,
    y: number,
  ): { nodes: RFAnyNode[]; edge: Edge } => ({
    nodes: [
      productNode(`fs-${id}`, -600, y - 30, 100, 60),
      productNode(`ft-${id}`, 600, y - 30, 100, 60),
    ],
    edge: {
      id,
      source: `fs-${id}`,
      target: `ft-${id}`,
      type: "item",
      data: { item: "f", rate: new Fraction(1) },
    },
  });

  it("cascades one pitch when that clears the foreign line", () => {
    const f0 = foreign("f0", laneY);
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      ...f0.nodes,
    ];
    const out = deconflictChipAnchors(nodes, [loneBus("t0"), f0.edge]);
    expect(busDropDyOf(out, "e0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
  });

  it("grazes a foreign line rather than cascading past the cap", () => {
    // Both seats inside the cap are crossed (the lane itself and one pitch
    // below). Clearing the lines would take a third seat two pitches out; the
    // cap relaxes the foreign-line preference instead and the chip stays on its
    // own junction.
    const f0 = foreign("f0", laneY);
    const f1 = foreign("f1", laneY + MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      ...f0.nodes,
      ...f1.nodes,
    ];
    const out = deconflictChipAnchors(nodes, [loneBus("t0"), f0.edge, f1.edge]);
    expect(busDropDyOf(out, "e0")).toBe(0);
  });

  it("breaks the cap rather than overlap a chip already placed", () => {
    // The cap relaxes the foreign-line preference, never the chip tier. Three
    // lone trunks all drop at 132: two off s1 on adjacent lanes (300 and 348,
    // one LANE_SPACING apart), and one off s2 that shares lane 300. Drops seat
    // in edge-id order, so by the time e2 is seated both of its in-cap seats --
    // its own lane and one pitch down -- hold another trunk's drop chip. There
    // is no third seat inside the cap, so the seat falls through to the
    // unbounded ladder and lands two pitches out, clear of both.
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    const trunk = (
      id: string,
      source: string,
      target: string,
      item: string,
      lane: number,
    ): Edge => ({
      id,
      source,
      target,
      type: "bus",
      data: {
        item,
        rate: new Fraction(1),
        laneY: lane,
        trunkKey: `${item}|${source}`,
        busChipOwner: true,
        busMemberCount: 1,
        busBand: "bottom" as const,
      },
    });
    const nodes: RFAnyNode[] = [
      productNode("s1", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      productNode("t1", 1400, 500, 100, 60),
      productNode("s2", 0, 900, 100, 60),
      productNode("t2", 1400, 1000, 100, 60),
    ];
    const out = deconflictChipAnchors(nodes, [
      trunk("e0", "s1", "t0", "a", laneY),
      trunk("e1", "s1", "t1", "b", laneY + pitch),
      trunk("e2", "s2", "t2", "c", laneY),
    ]);
    // The two blockers keep their own junctions.
    expect(busDropDyOf(out, "e0")).toBe(0);
    expect(busDropDyOf(out, "e1")).toBe(0);
    // The seat e2 takes clears both blockers -- chip centres a full max-scale
    // box height apart do not overlap on y -- which it can only do by exceeding
    // the cap.
    const e2Y = laneY + busDropDyOf(out, "e2");
    expect(Math.abs(e2Y - laneY)).toBeGreaterThanOrEqual(pitch);
    expect(Math.abs(e2Y - (laneY + pitch))).toBeGreaterThanOrEqual(pitch);
    expect(busDropDyOf(out, "e2")).toBe(2 * pitch);
  });

  it("breaks the cap rather than enter a foreign card", () => {
    // The other half of the cap's hard pair: foreign CARDS stay hard inside the
    // cap exactly as placed chips do. One lone trunk, and a foreign card
    // (nobody's endpoint, so no exemption reaches it) laid over the drop column
    // across BOTH in-cap seats -- the lane and one pitch down. Every seat the
    // cap offers enters the card, so the seat falls through to the unbounded
    // ladder and lands two pitches out, the first seat clear of the card.
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t0", 1400, 0, 100, 60),
      // Spans y 280..360: it covers the lane seat's box (276..324) and the
      // one-pitch seat's (324..372), and clears the two-pitch seat's
      // (372..420). Its x straddles the drop column, so the box laps it there.
      productNode("blk", 100, 280, 100, 80),
    ];
    const out = deconflictChipAnchors(nodes, [loneBus("t0")]);
    const dropDy = busDropDyOf(out, "e0");
    expect(dropDy).toBeGreaterThan(pitch);
    expect(dropDy).toBe(2 * pitch);
    // ...and the seat it took really is off the card: box top (chip centre minus
    // a max-scale half height) sits below the card's bottom edge.
    expect(laneY + dropDy - pitch / 2).toBeGreaterThanOrEqual(360);
  });
});

describe("deconflictChipAnchors: reconstruction tripwires", () => {
  it("reconstructs a backward edge's rail vertical exactly as the render args do", () => {
    // Reconstruction-fidelity tripwire with a negative control. A wide forward
    // edge (a:fwd) is laid out so its clear-segment anchor sits exactly where a
    // backward edge's (z:bwd) source-side rail VERTICAL runs -- but only when the
    // threaded railY stretches that vertical down to the anchor's y. a:fwd seats
    // first: if the pass rebuilt z:bwd's path WITH railY, a:fwd's anchor lands on
    // the reconstructed vertical and the chip slides along its own line to clear
    // it (labelDx set). WITHOUT railY the backward rail collapses to its short
    // default far from the anchor, a:fwd is clear, and no slide fires. The
    // presence/absence of the slide is the drift detector.
    const build = (withRail: boolean): Edge[] => {
      const bwdSource = productNode("bs", 500, 170, 100, 60); // right edge 600
      const bwdTarget = productNode("bt", 0, 170, 100, 60); // port y 200
      // a:fwd: a wide horizontal at y=300 whose midpoint (624) sits on z:bwd's
      // rail vertical x = sx + PORT_STUB = 624. Wide enough to slide clear.
      const fwdSource = productNode("as", 274, 270, 100, 60); // right edge 374
      const fwdTarget = productNode("at", 874, 270, 100, 60); // left edge 874
      const nodes: RFAnyNode[] = [bwdSource, bwdTarget, fwdSource, fwdTarget];
      const edges: Edge[] = [
        {
          id: "a:fwd",
          source: "as",
          target: "at",
          type: "item",
          data: { item: "w", rate: new Fraction(1) },
        },
        {
          id: "z:bwd",
          source: "bs",
          target: "bt",
          type: "item",
          data: {
            item: "w",
            rate: new Fraction(1),
            ...(withRail ? { railY: 608 } : {}),
          },
        },
      ];
      return deconflictChipAnchors(nodes, edges);
    };
    // With railY: the reconstructed vertical reaches the anchor, so a:fwd slides.
    expect(labelDxOf(build(true), "a:fwd")).not.toBe(0);
    // Without it: the short default rail is far away, so a:fwd never moves.
    expect(labelDxOf(build(false), "a:fwd")).toBe(0);
    expect(labelDyOf(build(false), "a:fwd")).toBe(0);
  });

  it("nudges a midpoint chip off a bus rise chip's box", () => {
    // A bus member's rise chip sits at (busChipX, laneY). A forward item edge's
    // straight-line midpoint lands exactly there; bus chips seat before
    // midpoints, so the midpoint must yield one pitch while the bus chip holds
    // its lane.
    const laneY = 300;
    const busChipX = 500;
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60),
      productNode("t", 900, 0, 100, 60),
      // Forward pair centered on the bus chip: right edge 400 / left edge 600
      // -> midpoint x 500; port centers at y 300.
      productNode("fs", 300, 270, 100, 60),
      productNode("ft", 600, 270, 100, 60),
    ];
    const edges: Edge[] = [
      {
        id: "bus:0",
        source: "s",
        target: "t",
        type: "bus",
        data: {
          item: "w",
          rate: new Fraction(1),
          laneY,
          trunkKey: "w|s",
          busChipX,
          busChipOwner: false,
        },
      },
      {
        id: "mid:0",
        source: "fs",
        target: "ft",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
    ];
    const out = deconflictChipAnchors(nodes, edges);
    // The forward edge's straight line passes exactly through the bus chip's
    // lane slot, so the bus chip yields one pitch (a chip never sits on a
    // foreign flow's line). The rate chip's own line is collinear with the
    // foreign lane run, so no fully clear on-line point exists -- but the
    // graze tier keeps it ON its own line anyway (chips and cards are the only
    // hard blockers, and the displaced bus chip now sits a full pitch away),
    // so the chip holds its anchor instead of lifting off the line.
    expect(busChipDyOf(out, "bus:0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(labelDyOf(out, "mid:0")).toBe(0);
    expect(labelDxOf(out, "mid:0")).toBe(0);
  });
});

describe("deconflictChipAnchors: merged collision set", () => {
  it("moves a coincident midpoint chip by at least the max-scale pitch (48)", () => {
    // Two parallel forward edges share one source and one target, so their
    // straight-line midpoints coincide exactly. The second (by edge id) is
    // nudged, and its offset must be at least the chip pitch so the two boxes
    // clear at the fit-zoom counter-scale cap. Pinning the magnitude to the
    // exported product catches a silent decoupling of the nudge step / collision
    // box from the chip dimensions.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 170, 100, 60), // right 100, center 200
      productNode("t", 300, 170, 100, 60), // left 300, center 200
    ];
    const edges: Edge[] = [
      {
        id: "m:1",
        source: "s",
        target: "t",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
      {
        id: "m:2",
        source: "s",
        target: "t",
        type: "item",
        data: { item: "w", rate: new Fraction(1) },
      },
    ];

    const out = deconflictChipAnchors(nodes, edges);

    expect(labelDyOf(out, "m:1")).toBe(0); // first placed, unmoved
    expect(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT).toBe(48);
    expect(labelDyOf(out, "m:2")).toBeGreaterThanOrEqual(
      MAX_CHIP_SCALE * CHIP_BOX_HEIGHT,
    );
  });
});

describe("deconflictChipAnchors: fan-out aggregate seat (3b)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const oneGap = 410; // 410 - 300 = 110, inside FANOUT_SPAN_MAX

  const aggOf = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      fanoutAggDx?: number;
      fanoutAggDy?: number;
      busChipOwner?: boolean;
    };

  it("stamps no aggregate offset on a multi-member fan-out trunk", () => {
    // A clean 2-member fan-out. A trunk with more than one member draws no
    // aggregate chip (issue #39), so phase 3b seats none and neither member
    // carries an aggregate offset: not the owner (nothing was seated) and not the
    // non-owner (phase 3b only ever ran under `if (geom.owner)`).
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const routed = routeFanoutEdges(nodes, edges);
    // e0 is the elected owner (lex-smallest edge id); e1 is a non-owner.
    expect(aggOf(routed, "e0").busChipOwner).toBe(true);
    expect(aggOf(routed, "e1").busChipOwner).toBe(false);

    const out = deconflictChipAnchors(nodes, routed);
    // The non-owner never had an aggregate offset.
    expect(aggOf(out, "e1").fanoutAggDx).toBeUndefined();
    expect(aggOf(out, "e1").fanoutAggDy).toBeUndefined();
    // The owner has none either: no aggregate chip is seated on a 2-member trunk.
    expect(aggOf(out, "e0").fanoutAggDx).toBeUndefined();
    expect(aggOf(out, "e0").fanoutAggDy).toBeUndefined();
  });

  it("seats the short-path branch chip the removed aggregate used to cover", () => {
    // A same-y member's branch degenerates to the straight in-corridor trunk,
    // and the narrow corridor is shorter than one max-scale chip box, so while
    // the owner's aggregate box sat on that corridor there was no chip/card-clear
    // point anywhere on the member's own polyline and its branch chip was hidden.
    // The multi-member trunk draws no aggregate now (issue #39), so the corridor
    // is free and the branch chip seats -- at its own anchor, stamping nothing.
    // The far member keeps its branch chip too: its long vertical leg is clear.
    const branchOf = (edges: Edge[], id: string) =>
      edges.find((e) => e.id === id)!.data as {
        fanoutBranchHidden?: true;
        fanoutBranchHiddenAt?: { x: number; y: number };
        fanoutBranchDx?: number;
        fanoutBranchDy?: number;
      };
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r), // same y: straight member, short path
      recipeNode("t2", oneGap, 400, r), // far below: long clear branch leg
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = deconflictChipAnchors(nodes, routeFanoutEdges(nodes, edges));
    expect(branchOf(out, "e0").fanoutBranchHidden).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchHiddenAt).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchDx).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchDy).toBeUndefined();
    expect(branchOf(out, "e1").fanoutBranchHidden).toBeUndefined();
    expect(branchOf(out, "e1").fanoutBranchHiddenAt).toBeUndefined();
  });

  it("keeps the DEV exhausted tripwire when a branch seat exhausts before hiding", () => {
    // Two foreign wall cards straddle the same-y member's escape column: they
    // leave the port rows (and so the fan-out classification's trunk / leg /
    // column acceptance) clear, but block every off-line candidate the nudge
    // and escape cascades probe, over the full LAST_RESORT_CAP_STEPS range. The
    // half-gap between them is derived to stay 4 units under the chip's own
    // half-height, so a change to the chip box cannot silently un-wall this
    // fixture: the member's short line has no clear stretch either and the branch
    // seat runs the whole ladder and returns "exhausted". The chip is still
    // hidden (the hide covers all off-line tiers), but the DEV tripwire must
    // fire: an exhausted cascade is a seating regression, not an intentional
    // hide, and folding it silently into the hide path would mask it.
    const branchOf = (edges: Edge[], id: string) =>
      edges.find((e) => e.id === id)!.data as {
        fanoutBranchHidden?: true;
        fanoutBranchHiddenAt?: { x: number; y: number };
      };
    const sy = portOffsetY(recipeNode("s", 0, 0, r), "b", "out");
    // Chip half-height is (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2 = 24; the wall
    // half-gap must stay under it for the line to count as blocked.
    const wallHalfGap = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2 - 4;
    // 9700 > LAST_RESORT_CAP_STEPS * CHIP_NUDGE_STEP (9600) plus box slack.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r), // same y: straight member, short path
      recipeNode("t2", oneGap, 400, r),
      productNode("wallTop", 240, sy - wallHalfGap - 9700, 80, 9700),
      productNode("wallBot", 240, sy + wallHalfGap, 80, 9700),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const routed = routeFanoutEdges(nodes, edges);
      // The walls must not defeat the classification itself.
      expect(routed.find((e) => e.id === "e0")!.type).toBe("bus");
      const out = deconflictChipAnchors(nodes, routed);
      expect(branchOf(out, "e0").fanoutBranchHidden).toBe(true);
      // The hide is stamped WITH the branch anchor it was decided at, so BusEdge
      // can tell a still-valid hide from one gone stale under node drag (the live
      // recomputed anchor diverges once the user moves either endpoint).
      const hiddenAt = branchOf(out, "e0").fanoutBranchHiddenAt;
      expect(hiddenAt).toBeDefined();
      expect(Number.isFinite(hiddenAt!.x)).toBe(true);
      expect(Number.isFinite(hiddenAt!.y)).toBe(true);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("fan-out branch cascade"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
