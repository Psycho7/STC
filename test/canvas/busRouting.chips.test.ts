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
import {
  chamferFanoutPath,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { portOffsetY } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import {
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  MAX_CHIP_SCALE,
} from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  orderedRecipeNode,
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
    // busDropBase(sourceRight) = 132. Both members feed ONE layer (t0 and t1
    // share the rise column 868), so the trunk's rise columns are co-located
    // and the stamped slots keep their spread positions: 232 and 432, both
    // inside the co-extensive run, 200 apart -- under the wide-chip
    // separation (2 * 120 = 240), so the run supports exactly ONE rise and
    // the ordering rule decides which. The capacity check tries members
    // FARTHEST-from-the-drop-column first: e1 (432, 300 off) is tried before
    // e0 (232, 100 off) and takes the only slot; e0 then sits 200 from the
    // kept x and is hidden. A member that reads at the consumer end beats a
    // near one, so inverting the comparator would flip this result.
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
    // A KEPT rise (the capacity check clears both members: their slots sit
    // 240 apart) whose lane seat is blocked by foreign lines at the lane and
    // at the next two steps below it. The seat clears only 3 pitches down --
    // far off the band, in empty canvas with no stroke touching it -- so the
    // rise is hidden instead, like a crowded one. Both members feed ONE layer
    // (t0 and t1 share the rise column 1368), so the trunk's rise columns are
    // co-located and e0's stamped slot (700) keeps its spread position, under
    // the foreign lines; e1's slot (940) sits past them.
    // Trunk "b|s2"'s lane at y=410 both forces that third step and gives the
    // pop a witness: its own rise column coincides with the hidden chip's
    // would-be seat (700, 444), 34 units away, so a phantom box left behind
    // would push it off ITS lane. (t2 sits at 900, not beside the pair: its
    // column sets trunk b's OWN single-member geometry, whose window clamp
    // keeps b0's slot at 700 -- the witness.)
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
      productNode("t0", 1400, 0, 100, 60), // rise column 1368
      productNode("t1", 1400, 200, 100, 60), // rise column 1368
      productNode("s2", 0, 700, 100, 60),
      productNode("t2", 900, 700, 100, 60),
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
    // between "beside the lane" and "floating off the band". Both members feed
    // ONE layer (t0 and t1 share the rise column 1368), so the trunk's rise
    // columns are co-located and the stamped slots keep their spread
    // positions: the foreign line is laid across e0's seat (700) while e1's
    // slot (940) sits 240 past it, clear of the line, so e1 holds its lane.
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
    // Every slot now clamps into a MIN_CHIP_SEP-wide window at its member's
    // own rise end: the two far members' slots (4735, 6936.5) pull to their
    // windows' near edges (4898, 8898 -- unpinned) and keep their lane seats.
    // The NEAREST member's slot (2533.5) sat 1400 units past its own rise
    // column (1138), so its window [898, 1130] parks it at the FAR end,
    // 1130 = riseX - CHAMFER, where the run's own junction dot sits -- the
    // wide box swallows the dot wherever it lands near that end, so the dot
    // keep-off pass (#50) lifts it one pitch off the lane. Beside its own
    // corner beats spread onto a sibling's stroke.
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

describe("deconflictChipAnchors: per-chip bus seat box", () => {
  // Task 10: the lane bus seats (drop and rise) reserve the box their own
  // text draws through chipSeatHalfW -- the same estimate the rate seats have
  // carried since T6b -- instead of the flat 240-wide clamp. The fixtures pin
  // the two observables of a narrower reserve: a lane seat the wide box had to
  // leave is TAKEN, and a rise seated flush beside its own trunk's drop no
  // longer stacks a pitch off it. MIN_CHIP_SEP and the capacity comparator
  // stay on the wide separation, so only the reserved box changes.
  const laneY = 300;
  // A lone-member lane trunk (a|s) on a bottom band at y 300, drop column 132
  // (source right edge 100), rise window [1128, 1360] for the t0-at-1400
  // member, and a mid-window rise slot at 1248. The rate picks the reserved
  // width: "1/min" (rate 1/60 per sec) reserves 79.5 a side (natural 38 + 7.5
  // + 34, doubled by the counter-scale cap, halved), while "1234.56/min"
  // (rate 123456/6000) clamps to the 120 wide half -- the same box every bus
  // chip reserved before the per-chip change.
  const mkLoneBus = (rate: Fraction): Edge => ({
    id: "e0",
    source: "s",
    target: "t0",
    type: "bus",
    data: {
      item: "a",
      rate,
      laneY,
      trunkKey: "a|s",
      busChipX: 1248,
      busChipOwner: true,
      busMemberCount: 1,
      busBand: "bottom" as const,
    },
  });

  it("takes the lane seat a narrower rise box clears where the wide one cannot", () => {
    // A tall foreign vertical (bend column 1348, spanning y -562..682 past the
    // one-pitch band either side of the lane) runs 100 units right of the
    // rise slot at 1248. A rise whose text reserves 79.5 per side holds its
    // lane seat with the stroke 20.5 clear of the box; the wide box reaches
    // the stroke at every seat within a pitch, so before the per-chip box that
    // same chip cascaded nine pitches down and was hidden by the off-band rule
    // -- the lane slot here is the seat a 240-wide reserve could not clear but
    // the narrower one can. A long body ("1234.56/min", the clamp) still
    // reaches the stroke and stays hidden: the reserve follows the text, not
    // the trunk. Red before: both trunks reserved 240, so the short member's
    // rise hid with the long one's.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60), // right edge 100 -> dropX 132
      productNode("t0", 1400, 0, 100, 60), // left edge 1400 -> rise 1368
      // Foreign bend column at x 1348: fs right edge 1200 (drawn port 1204),
      // ft left edge 1500 (drawn port 1496), so the stamped bendX sits inside
      // the corridor and the vertical spans both sides of the lane.
      productNode("fs", 1100, -600, 100, 60),
      productNode("ft", 1500, 660, 100, 60),
    ];
    const foreign: Edge = {
      id: "f0",
      source: "fs",
      target: "ft",
      type: "item",
      data: { item: "f", rate: new Fraction(1), bendX: 1348 },
    };
    const short = deconflictChipAnchors(nodes, [
      mkLoneBus(new Fraction(1, 60)),
      foreign,
    ]);
    expect(busRiseHiddenOf(short, "e0")).toBe(false);
    expect(busChipDyOf(short, "e0")).toBe(0);
    expect(busDropDyOf(short, "e0")).toBe(0);
    const long = deconflictChipAnchors(nodes, [
      mkLoneBus(new Fraction(123456, 6000)),
      foreign,
    ]);
    expect(busRiseHiddenOf(long, "e0")).toBe(true);
  });

  it("seats a short rise flush beside its own drop where a wide pair stacks", () => {
    // The drop column 132 and a rise slot at 337 sit 205 apart: inside the
    // 240 the two wide half-boxes sum to, 46 clear of the 159 the two "1/min"
    // boxes reserve. Drops seat first, so the wide pair forces the rise one
    // pitch off the lane while the narrow pair holds both seats flush -- a
    // member's rise yields to its own trunk's aggregate only as far as the
    // boxes they actually draw. Red before: both chips reserved 240, so the
    // short member's rise stacked a pitch like the long one's still does.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 0, 100, 60), // right edge 100 -> dropX 132
      productNode("t", 545, 0, 100, 60), // left edge 545 -> rise 513, window [273, 505]
    ];
    const mkLone = (rate: Fraction): Edge[] => [
      {
        id: "e0",
        source: "s",
        target: "t",
        type: "bus",
        data: {
          item: "a",
          rate,
          laneY,
          trunkKey: "a|s",
          busChipX: 337,
          busChipOwner: true,
          busMemberCount: 1,
          busBand: "bottom" as const,
        },
      },
    ];
    const short = deconflictChipAnchors(nodes, mkLone(new Fraction(1, 60)));
    expect(busDropDyOf(short, "e0")).toBe(0);
    expect(busRiseHiddenOf(short, "e0")).toBe(false);
    expect(busChipDyOf(short, "e0")).toBe(0);
    const long = deconflictChipAnchors(
      nodes,
      mkLone(new Fraction(123456, 6000)),
    );
    expect(busRiseHiddenOf(long, "e0")).toBe(false);
    expect(busChipDyOf(long, "e0")).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
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
    // busDropBase(100) = 132. Four members, three of them handed a slot at
    // 2000 -- far past where their own lines leave the lane, the multi6
    // rise-anchor family -- and one (e0) a slot at 800 that is already inside
    // its own run. Each clamps into a MIN_CHIP_SEP-wide window at its OWN rise
    // end (240 = 2 * 120 wide-chip separation), intersected with the run's
    // chamfer slack:
    //   e0 forward to x=1400: run 132..1368, window [1128, 1360]; the in-run
    //      slot 800 is 468 short of the rise corner it labels, so it moves too
    //      -- the clamp is two-sided -- to the window's near edge, 1128.
    //   e1 forward to x=600:  run 132..568, window [328, 560], slot 2000 ->
    //      the window's far end, 560.
    //   e2 BACKWARD to x=-400: the run reverses (rise -432, drop 132) and its
    //      rise end is the LEFT end, so the window is [-424, -192]: the slot
    //      clamps to the RISE end of the reversed run, -192, instead of piling
    //      onto the drop column beside the hairpin member.
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
    expect(busChipXOf(out, "e0")).toBe(1128);
    expect(busChipXOf(out, "e1")).toBe(560);
    expect(busChipXOf(out, "e2")).toBe(-192);
    expect(busChipXOf(out, "e3")).toBe(120);
    // The backward member no longer piles onto the drop column: e2 (-192) and
    // the hairpin e3 (120) end up 312 apart, OVER the wide-chip separation
    // (240), so the capacity check keeps BOTH where it used to hide e2 (the
    // old clamp sat the pair 4 units apart at the drop end). Two chips at
    // their own corners beat one hidden beside a sibling's column.
    expect(busRiseHiddenOf(out, "e2")).toBe(false);
    expect(busRiseHiddenOf(out, "e3")).toBe(false);
  });

  it("seats every member rise within one window of its own rise column", () => {
    // The battery5-xiranite Xiragen-trunk shape (drop column 300 here): three
    // members with rise columns 1330 / 1997 / 3771 whose edge ids rank the
    // FARTHEST member (e0 -> 3771) first, so an id-ordered spread hands e0 the
    // drop-side slot (1167.75). That slot sits legally inside e0's own huge
    // run, so the old one-sided clamp kept it: e0's rate chip drew 2603 units
    // from the rise corner it labels, hard against the 1330 member's column,
    // and the 1330 member's own clamped slot (1322) then crowded it under the
    // wide-chip separation (240) and HID (busRiseHidden) -- one mis-seated
    // chip and one missing label off a single trunk. The fix is two-sided: the
    // spread ranks members by rise column, and the clamp bounds every slot to
    // a MIN_CHIP_SEP-wide window at its own rise end, so every drawn chip sits
    // within one window of the corner it labels whatever the spread does, and
    // three distinct columns never crowd each other.
    const nodes: RFAnyNode[] = [
      productNode("s", 168, 0, 100, 60), // right edge 268 -> dropX 300
      productNode("t0", 3803, 0, 100, 60), // rise column 3771, farthest, id FIRST
      productNode("t1", 2029, 200, 100, 60), // rise column 1997
      productNode("t2", 1362, 400, 100, 60), // rise column 1330
    ];
    const edges = [
      mkEdge("e0", "s", "t0", "w"),
      mkEdge("e1", "s", "t1", "w"),
      mkEdge("e2", "s", "t2", "w"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    // MIN_CHIP_SEP in chipSeating is 2 * CHIP_HALF_W_WIDE; asserted through
    // the dimensions constants so a chip-box change rederives this with it.
    const W = MAX_CHIP_SCALE * CHIP_BOX_WIDTH;
    expect(W).toBe(240);
    const riseXOf: Record<string, number> = { e0: 3771, e1: 1997, e2: 1330 };
    for (const [id, riseX] of Object.entries(riseXOf)) {
      const x = busChipXOf(out, id);
      expect(x, `${id} clamped rise slot`).toBeDefined();
      expect(
        Math.abs(x! - riseX),
        `${id} distance from its own rise column`,
      ).toBeLessThanOrEqual(W);
      expect(busRiseHiddenOf(out, id), `${id} rise hidden`).toBe(false);
    }
    // Multi-member trunk: no aggregate drop chip exists to seat either.
    expect(busDropDyRawOf(out, "e0")).toBeUndefined();
  });

  it("keeps co-located same-layer members on their spread slots, none hidden", () => {
    // The same-layer family the rise-end window defeated: one product source
    // (right edge 300 -> dropX 332) feeding three recipes stacked in ONE far
    // layer at x 1920 (span 1620 > BUS_SPAN_THRESHOLD). The members' runs are
    // co-extensive -- every rise column lands on 1888, entry staggering moves
    // a column by a row pitch at most -- so the trunk-wide spread is the pass
    // that separates their rate chips along the shared run (721 / 1110 /
    // 1499 when each member kept its slot). The window clamps ALL THREE onto
    // the one MIN_CHIP_SEP-wide stretch at the shared rise end (1648), and the
    // capacity check then hides two of the three: the window, built for
    // mixed-length runs like the battery5 case above, defeats the spread
    // exactly when the members it separates share their rise column. So the
    // clamp must keep the spread slots for a trunk whose slotted members'
    // rise columns are co-located within one MIN_CHIP_SEP -- every chip stays
    // on the shared run, separated by the spread, and all three stay visible.
    const r = mkRecipe("r", ["w"], ["b"]);
    const nodes: RFAnyNode[] = [
      productNode("s", 200, 0, 100, 60), // right edge 300 -> dropX 332
      recipeNode("t0", 1920, 0, r), // rise column 1888, all three members
      recipeNode("t1", 1920, 300, r),
      recipeNode("t2", 1920, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t0", "w"),
      mkEdge("e1", "s", "t1", "w"),
      mkEdge("e2", "s", "t2", "w"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    const xs = (["e0", "e1", "e2"] as const).map((id) => {
      expect(busRiseHiddenOf(out, id), `${id} rise hidden`).toBe(false);
      const x = busChipXOf(out, id);
      expect(x, `${id} spread slot`).toBeDefined();
      return x!;
    });
    // Informational: the slots the spread hands out, logged so a re-derivation
    // shows its own values instead of trusting a pinned triple.
    console.log("same-layer rise slots:", xs.join(" / "));
    // MIN_CHIP_SEP in chipSeating is 2 * CHIP_HALF_W_WIDE; asserted through
    // the dimensions constants so a chip-box change rederives this with it.
    const W = MAX_CHIP_SCALE * CHIP_BOX_WIDTH;
    expect(W).toBe(240);
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        expect(
          Math.abs(xs[i]! - xs[j]!),
          `slots ${i}/${j} separated by the spread`,
        ).toBeGreaterThanOrEqual(W);
      }
    }
    // Multi-member trunk: no aggregate drop chip exists to seat either.
    expect(busDropDyRawOf(out, "e0")).toBeUndefined();
  });

  it("stamps a clamped slot even when the member carries no other stamp", () => {
    // The same trunk without the hairpin member: e2's backward run clamps its
    // slot to the rise end (-192, not the old drop-end 124), it seats on the
    // lane (no busChipDy) and survives the capacity check (no busRiseHidden),
    // leaving the clamped x as the ONLY thing seating has to say about it.
    // That is the case the stamp-block's early return can swallow, sending
    // the stale trunk-wide 2000 to BusEdge instead of -192.
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
    expect(busChipXOf(out, "e2")).toBe(-192);
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
      // A lane slot, as routeBusEdges hands a lone member on a SHORT run: with
      // it present the member is not a long lone run, so the drop chip still
      // seats here and these cascade pins keep their subject (#83 defers the
      // slot-less long-run drop instead).
      busChipX: 400,
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
    // A short-branch member's leg degenerates to the in-corridor run past the
    // junction, and that leg is narrower than the chip's own reserved box, so
    // while the owner's aggregate box sat on that corridor there was no
    // chip/card-clear point anywhere on the member's own leg and its branch
    // chip was hidden. The multi-member trunk draws no aggregate (issue #39),
    // so the corridor is free and the branch chip seats. Task 8 re-derivation:
    // the branch short-leg rule now measures the member's OWN leg (the suffix
    // after the junction) against the chip's natural width, so BOTH members
    // collapse to the icon-only variant here -- the short member's riser leg
    // and the far member's vertical offer no horizontal run a full box can
    // slide along -- and the narrow box is what lets the seat clear the split
    // dot: the short member's chip stamps the slide it took along its own leg
    // (down and right of the junction), instead of parking at an anchor whose
    // wide box buried the dot. The far member keeps its chip at its anchor.
    const branchOf = (edges: Edge[], id: string) =>
      edges.find((e) => e.id === id)!.data as {
        fanoutBranchHidden?: true;
        fanoutBranchHiddenAt?: { x: number; y: number };
        fanoutBranchDx?: number;
        fanoutBranchDy?: number;
        fanoutBranchIconOnly?: true;
      };
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r), // same y: straight member, short path
      recipeNode("t2", oneGap, 400, r), // far below: long clear branch leg
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const routed = routeFanoutEdges(nodes, edges);
    const out = deconflictChipAnchors(nodes, routed);
    expect(branchOf(out, "e0").fanoutBranchHidden).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchHiddenAt).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchIconOnly).toBe(true);
    expect(branchOf(out, "e1").fanoutBranchHidden).toBeUndefined();
    expect(branchOf(out, "e1").fanoutBranchHiddenAt).toBeUndefined();
    expect(branchOf(out, "e1").fanoutBranchIconOnly).toBe(true);
    // The slide stayed on the short member's own leg: the seated centre sits
    // between the junction column and the target port, never back across the
    // junction onto the shared trunk prefix (the Task 8 confinement).
    // Drawn-port reconstruction (chipSeating's PORT_DRIFT.recipe, inline: out
    // handle +5 past the model right edge, in handle -3, and the +1 row drift
    // only on rows that resolve the item -- the source's does, t1's "a"-row
    // card does not for item "b").
    const src = nodes[0]!;
    const t1 = nodes[1]!;
    const fan = chamferFanoutPath({
      sourceX: src.position.x + 300 + 5,
      sourceY: 0 + portOffsetY(src, "b", "out") + 1,
      targetX: t1.position.x - 3,
      targetY: 0 + portOffsetY(t1, "b", "in"),
      ...routingHintsFromData(out.find((e) => e.id === "e0")!.data),
    });
    const cx = fan.branchAnchor.x + (branchOf(out, "e0").fanoutBranchDx ?? 0);
    const cy = fan.branchAnchor.y + (branchOf(out, "e0").fanoutBranchDy ?? 0);
    expect(cx).toBeGreaterThanOrEqual(fan.junction.x);
    expect(cx).toBeLessThanOrEqual(t1.position.x - 3);
    // Clear of the split dot's keep-off square on at least one axis (half the
    // collapsed box plus DOT_KEEPOFF), so the dot stays visible under nothing.
    expect(
      Math.abs(cx - fan.junction.x) >= 24 + 16 ||
        Math.abs(cy - fan.junction.y) >= 24 + 16,
    ).toBe(true);
  });

  it("keeps the DEV exhausted tripwire when a branch seat exhausts before hiding", () => {
    // Two foreign wall cards straddle the members' shared row: they leave the
    // row itself (and so the fan-out classification's trunk / leg / column
    // acceptance) clear, but block every candidate the seat can reach. Task 8
    // re-derivation: the branch seat now slides only over the member's OWN leg
    // (the suffix after the junction), and the short-leg rule collapses that
    // leg's chip to the icon-only box -- so the walls must sit where even a
    // 48-unit collapsed box cannot clear them (x 330..430 spans every on-line
    // candidate and both sidestep directions), and the members must be LEVEL
    // with the source row so the walls do not also eat the trunk's y-span and
    // defeat the columnClear formation test. The half-gap between the walls is
    // derived to stay 4 units under the box's half-height, so a change to the
    // chip box cannot silently un-wall this fixture, and the walls run 9700
    // tall -- past LAST_RESORT_CAP_STEPS * CHIP_NUDGE_STEP (9600) plus box
    // slack -- so the nudge and escape cascades exhaust too. The chip is still
    // hidden (the hide covers all off-line tiers), but the DEV tripwire must
    // fire: an exhausted cascade is a seating regression, not an intentional
    // hide, and folding it silently into the hide path would mask it.
    const branchOf = (edges: Edge[], id: string) =>
      edges.find((e) => e.id === id)!.data as {
        fanoutBranchHidden?: true;
        fanoutBranchHiddenAt?: { x: number; y: number };
      };
    const s = recipeNode("s", 0, 0, r);
    // Level consumers: the drawn in-port row equals the drawn out-port row, so
    // both members' legs run along it and the trunk's y-span degenerates to the
    // row itself (outside the walls' gap, clearing columnClear).
    const probe = orderedRecipeNode("probe", 0, 0, ["b"]);
    const levelY = portOffsetY(s, "b", "out") - portOffsetY(probe, "b", "in");
    const sy = portOffsetY(s, "b", "out");
    // Chip half-height is (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2 = 24; the wall
    // half-gap must stay under it for the line to count as blocked.
    const wallHalfGap = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2 - 4;
    const nodes: RFAnyNode[] = [
      s,
      orderedRecipeNode("t1", oneGap, levelY, ["b"]), // level member
      orderedRecipeNode("t2", oneGap + 210, levelY, ["b"]), // level, farther
      productNode("wallTop", 330, sy - wallHalfGap - 9700, 100, 9700),
      productNode("wallBot", 330, sy + wallHalfGap, 100, 9700),
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
