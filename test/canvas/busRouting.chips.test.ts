// Chip pitch and de-confliction: the shared chip/lane pitch constants and
// deconflictChipAnchors (bus lane cascade, render-vs-reconstruction tripwires,
// and the merged entry/bus/midpoint collision set). Fixtures come from
// ./busRouting.testkit.

import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  portOffsetY,
  routeBusEdges,
  routeFanoutEdges,
  BUS_SPAN_THRESHOLD,
  LANE_SPACING,
} from "../../src/canvas/busRouting";
import {
  deconflictChipAnchors,
  ENTRY_CHIP_MIN_GAP,
} from "../../src/canvas/chipSeating";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import { entryChipAnchor } from "../../src/canvas/ItemEdge";
import type { RFAnyNode } from "../../src/canvas/layout";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
  orderedRecipeNode,
  productNode,
  busDropDyOf,
  busChipDyOf,
} from "./busRouting.testkit";

describe("chip stack pitch", () => {
  it("couples the entry pitch to max counter-scale times true chip height", () => {
    expect(ENTRY_CHIP_MIN_GAP).toBe(MAX_CHIP_SCALE * CHIP_BOX_HEIGHT);
    expect(ENTRY_CHIP_MIN_GAP).toBe(48);
  });

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

function entryDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { entryChipDy?: number }
    | undefined;
  return d?.entryChipDy ?? 0;
}

describe("deconflictChipAnchors: bus lane cascade", () => {
  it("cascades a crowded trunk's rise chips below its lane in pitch steps", () => {
    // Two input-product feeders share one trunk (ore|agg) but sit so close that
    // the lane extent collapses: routeBusEdges stacks both rise slots on the drop
    // column. The owner (e0) keeps its aggregate drop chip on the lane; the rise
    // chips, coincident on that column, cascade straight down a full max-scale
    // pitch apart so no two bus chips overlap on screen. An anchor node up top
    // keeps the trunk in the lower half, so it lands in the BOTTOM band and the
    // cascade runs downward (the mirror top-band case is covered below).
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, mkRecipe("anchor", ["a"], ["b"])),
      inputProductNode("agg", "ore", 0, 1000),
      inputProductNode("t1", "ore", 200, 1000),
      inputProductNode("t2", "ore", 200, 1200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    // e0 owns the drop chip, which settles first on the lane and is never pushed.
    expect(busDropDyOf(out, "e0")).toBe(0);
    // The two rise chips pile below it at successive pitch steps, edge-id order.
    expect(busChipDyOf(out, "e0")).toBe(pitch);
    expect(busChipDyOf(out, "e1")).toBe(2 * pitch);
  });

  it("leaves a well-spread trunk's chips on the lane", () => {
    // Three members feeding distinct far layers spread their rise slots evenly
    // across a wide lane extent, so no chip crowds another and none is nudged.
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
      expect(busChipDyOf(out, id)).toBe(0);
      expect(busDropDyOf(out, id)).toBe(0);
    }
  });

  it("holds a drop chip on its junction unless a foreign trunk's line crosses it", () => {
    // Two trunks off ONE aggregate (items "a" and "b" -> lanes 0 and 1, same
    // drop column), with the "a" trunk's extent collapsed so its rise chips
    // stack on that column and cascade downward. Seating is two-phase (all
    // drops, then all rises) so no CHIP can knock an aggregate off its
    // junction. Trunk b's chip (bottom lane) holds: nothing foreign crosses it.
    // Trunk a's chip CANNOT hold: trunk b's drop vertical descends through its
    // junction on the shared drop column, and a chip never sits on a foreign
    // flow's line, so it cascades below both lanes (two steps: one clears b's
    // vertical run down to lane 1, the next clears b's lane clearance band).
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, mkRecipe("anchor", ["x"], ["y"])),
      inputProductNode("agg", "ore", 0, 1000),
      inputProductNode("t1", "ore", 200, 1000),
      inputProductNode("t2", "ore", 200, 1200),
      inputProductNode("t3", "ore", 200, 1400),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "a"),
      mkEdge("e1", "agg", "t2", "a"),
      mkEdge("e2", "agg", "t3", "b"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    expect(busDropDyOf(out, "e0")).toBe(2 * (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT));
    expect(busDropDyOf(out, "e2")).toBe(0);
    // The crowded rises all cascaded below the lanes instead.
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipDyOf(out, id)).toBeGreaterThan(0);
    }
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
  it("keeps a midpoint chip and a target's entry-chip stack clear of each other", () => {
    // Target T hosts two same-port entry chips (item "water") whose port anchor
    // is (Tx - 12, waterY). A third, non-multiInput forward edge A runs straight
    // into that same port with a 24px gap, so its rate-chip anchor lands exactly
    // on the entry port slot. A's source card (sa) is packed so close that it
    // overlaps the entry chips' x-reserve: the card-aware entry stack must push
    // both markers below sa's card (a foreign card for the b-edges), which
    // leaves A's anchor clear -- the merged set must end with the rate chip and
    // every entry box disjoint, whoever yielded.
    const Tx = 600;
    const tRecipe = mkRecipe("t", ["water", "ore"], []);
    const waterY = measureRecipe(tRecipe).inHandleYs[0]!; // T top is 0
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("t", Tx, 0, ["water", "ore"]),
      // Sources for the two entry chips, far to the left (their own midpoint
      // chips land nowhere near the entry stack).
      recipeNode("sb1", -2000, 0, mkRecipe("sb1", [], ["water"])),
      recipeNode("sb2", -2000, 300, mkRecipe("sb2", [], ["water"])),
      // Source for A: a product whose right edge sits one 24px gap before T and
      // whose center is exactly waterY, so a straight-line midpoint lands on the
      // entry chip anchor (Tx - 12, waterY).
      productNode("sa", Tx - 24 - 148, waterY - 30, 148, 60),
    ];
    const edges: Edge[] = [
      {
        id: "e:a",
        source: "sa",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1) },
      },
      {
        id: "e:b1",
        source: "sb1",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
      },
      {
        id: "e:b2",
        source: "sb2",
        target: "t",
        type: "item",
        data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
      },
    ];

    const out = deconflictChipAnchors(nodes, edges);

    // The entry markers stepped below sa's card bottom (waterY + 30): their
    // boxes must not enter that foreign card.
    const b1Dy = entryDyOf(out, "e:b1");
    const b2Dy = entryDyOf(out, "e:b2");
    const saBottom = waterY + 30;
    for (const dy of [b1Dy, b2Dy]) {
      expect(waterY + dy - CHIP_BOX_HEIGHT).toBeGreaterThanOrEqual(saBottom);
    }

    // A's rate chip then finds its port-slot anchor clear and stays put.
    const aDy = labelDyOf(out, "e:a");
    expect(aDy).toBe(0);
    const aX = Tx - 12;
    const aY = waterY + aDy;

    // Each entry chip's final box, at its own stacked dy.
    const entryBoxes = [
      entryChipAnchor(Tx, waterY, b1Dy),
      entryChipAnchor(Tx, waterY, b2Dy),
    ];
    // No box intersection: the rate chip clears every entry box on at least one
    // axis. X is shared here (both sit at Tx - 12), so the clearance is vertical
    // and must reach a full max-scale box height.
    for (const box of entryBoxes) {
      const clears =
        Math.abs(box.x - aX) >= 60 ||
        Math.abs(box.y - aY) >= MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
      expect(clears).toBe(true);
    }
  });

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

  it("seats the aggregate on the owner only, stamping nothing when it need not move", () => {
    // A clean 2-member fan-out. Phase 3b seats the aggregate first, on the TRUNK
    // sub-polyline only (source port -> junction). The trunk render anchor is the
    // trunk midpoint, which is exactly the right end of the keep-off-truncated
    // slide range on this narrow corridor, and nothing else is in the field yet
    // (no lane bus chips, no entry chips), so the aggregate seats at that anchor
    // and stamps no offset -- offsets record only where a seat actually moved.
    // Non-owner members carry no aggregate offset either: phase 3b seats the
    // aggregate under `if (geom.owner)`.
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
    // Owner-only: the non-owner carries no aggregate offset.
    expect(aggOf(out, "e1").fanoutAggDx).toBeUndefined();
    expect(aggOf(out, "e1").fanoutAggDy).toBeUndefined();
    // Only-where-moved: the uncrowded owner aggregate seats at its trunk anchor,
    // so no offset is stamped there either.
    expect(aggOf(out, "e0").fanoutAggDx).toBeUndefined();
    expect(aggOf(out, "e0").fanoutAggDy).toBeUndefined();
  });
  it("hides a branch chip whose whole short path the aggregate box covers", () => {
    // A same-y member's branch degenerates to the straight in-corridor trunk,
    // and the narrow corridor is shorter than one max-scale chip box, so after
    // the owner's aggregate seats there is no chip/card-clear point anywhere on
    // that member's own polyline. Seating it off-line would render a label
    // floating in empty canvas (issue #9, 1.1 for the fan-out family), and the
    // member's rate is already visible on its target card's input row -- so the
    // branch chip is hidden instead. The far member keeps its branch chip: its
    // long vertical leg is clear.
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
    expect(branchOf(out, "e0").fanoutBranchHidden).toBe(true);
    expect(branchOf(out, "e0").fanoutBranchDx).toBeUndefined();
    expect(branchOf(out, "e0").fanoutBranchDy).toBeUndefined();
    // The hide is stamped WITH the branch anchor it was decided at, so BusEdge
    // can tell a still-valid hide from one gone stale under node drag (the live
    // recomputed anchor diverges once the user moves either endpoint).
    const hiddenAt = branchOf(out, "e0").fanoutBranchHiddenAt;
    expect(hiddenAt).toBeDefined();
    expect(Number.isFinite(hiddenAt!.x)).toBe(true);
    expect(Number.isFinite(hiddenAt!.y)).toBe(true);
    expect(branchOf(out, "e1").fanoutBranchHidden).toBeUndefined();
    expect(branchOf(out, "e1").fanoutBranchHiddenAt).toBeUndefined();
  });

  it("keeps the DEV exhausted tripwire when a branch seat exhausts before hiding", () => {
    // Two foreign wall cards straddle the same-y member's escape column: they
    // leave the port rows (and so the fan-out classification's trunk / leg /
    // column acceptance) clear, but block every off-line candidate the nudge
    // and escape cascades probe, over the full LAST_RESORT_CAP_STEPS range. The
    // owner's exhausted aggregate parks on the short trunk and chip-blocks the
    // one wall-free stretch of the member's own line, so the branch seat runs
    // the whole ladder and returns "exhausted". The chip is still hidden (the
    // hide covers all off-line tiers), but the DEV tripwire must fire: an
    // exhausted cascade is a seating regression, not an intentional hide, and
    // folding it silently into the hide path would mask it.
    const branchOf = (edges: Edge[], id: string) =>
      edges.find((e) => e.id === id)!.data as { fanoutBranchHidden?: true };
    const sy = portOffsetY(recipeNode("s", 0, 0, r), "b", "out");
    // 9700 > LAST_RESORT_CAP_STEPS * CHIP_NUDGE_STEP (9600) plus box slack.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r), // same y: straight member, short path
      recipeNode("t2", oneGap, 400, r),
      productNode("wallTop", 240, sy - 25 - 9700, 80, 9700),
      productNode("wallBot", 240, sy + 25, 80, 9700),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const routed = routeFanoutEdges(nodes, edges);
      // The walls must not defeat the classification itself.
      expect(routed.find((e) => e.id === "e0")!.type).toBe("bus");
      const out = deconflictChipAnchors(nodes, routed);
      expect(branchOf(out, "e0").fanoutBranchHidden).toBe(true);
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
