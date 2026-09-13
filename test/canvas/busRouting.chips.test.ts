// Chip de-confliction: deconflictChipAnchors' render-vs-reconstruction
// tripwires, the merged entry/bus/midpoint collision set, and the fan-out
// aggregate seat. Fixtures come from ./busRouting.testkit.

import { describe, it, expect, vi } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { routeFanoutEdges } from "../../src/canvas/busRouting";
import {
  chamferFanoutPath,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { portOffsetY } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { chipNaturalWidth } from "../../src/canvas/chipMetrics";
import { CHIP_BOX_HEIGHT } from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  orderedRecipeNode,
  mkEdge,
  productNode,
} from "./busRouting.testkit";

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
});

// A product source and target far enough apart that their item edges stay plain
// forward edges; explicit width/height so nodeHeight needs no recipe.
function waterProductNode(id: string, x: number): RFAnyNode {
  return {
    id,
    type: "product",
    position: { x, y: 0 },
    width: 148,
    height: 60,
    data: { kind: "inputProduct", itemId: "water" },
  } as unknown as RFAnyNode;
}

describe("deconflictChipAnchors: merged collision set", () => {
  it("moves a coincident midpoint chip by at least the chip pitch (20)", () => {
    // Two parallel forward edges share one source and one target, so their
    // straight-line midpoints coincide exactly. The second (by edge id) is
    // nudged, and its offset must be at least the chip pitch so the two boxes
    // clear. Pinning the magnitude to the exported constant catches a silent
    // decoupling of the nudge step / collision box from the chip dimensions.
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
    expect(CHIP_BOX_HEIGHT).toBe(20);
    expect(labelDyOf(out, "m:2")).toBeGreaterThanOrEqual(CHIP_BOX_HEIGHT);
  });

  it("separates two coincident item midpoint chips along their line", () => {
    // Two forward item edges with identical endpoint geometry produce coincident
    // midpoint anchors. The graze tier keeps both chips ON the shared line
    // (leaving the line is a last resort), so the second chip slides along it by
    // at least the width of the box each of them draws, instead of lifting
    // vertically. Both rates round to a five-glyph body, so the two reserves
    // are equal and their sum is one such box width.
    const nodes = [
      waterProductNode("sA", 0),
      waterProductNode("tA", 2000),
      waterProductNode("sB", 0),
      waterProductNode("tB", 2000),
    ];
    const edges: Edge[] = [
      {
        id: "e:1",
        source: "sA",
        target: "tA",
        type: "item",
        data: { item: "water", rate: new Fraction(400) },
      },
      {
        id: "e:2",
        source: "sB",
        target: "tB",
        type: "item",
        data: { item: "water", rate: new Fraction(300) },
      },
    ];
    const out = deconflictChipAnchors(nodes, edges);
    const seats = out.map((e) => {
      const d = e.data as { labelDx?: number; labelDy?: number };
      return { dx: d.labelDx ?? 0, dy: d.labelDy ?? 0 };
    });
    // Both chips stay on the shared horizontal line...
    for (const s of seats) expect(s.dy).toBe(0);
    // ...separated along it by the width of the box they draw.
    expect(Math.abs(seats[0]!.dx - seats[1]!.dx)).toBeGreaterThanOrEqual(
      chipNaturalWidth({ body: "24000", unit: true }),
    );
  });
});

describe("deconflictChipAnchors: fan-out aggregate seat (3b)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const oneGap = 410; // one layer over: a 110-unit gap right of the source

  const aggOf = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      fanoutAggDx?: number;
      fanoutAggDy?: number;
      busChipOwner?: boolean;
    };

  it("seats the aggregate on a multi-member fan-out trunk's owner", () => {
    // A clean 2-member fan-out. Every trunk draws one aggregate chip, on its
    // owner, so phase 3b seats the owner's -- and only the owner's: it runs
    // under `if (geom.owner)`, so a non-owner never carries an offset.
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
    // The owner's aggregate WAS seated: this short in-corridor trunk is crowded
    // by the members' own chips, so the seat steps off the anchor rather than
    // parking on it (an offset stamped on at least one axis).
    const owner = aggOf(out, "e0");
    expect(
      (owner.fanoutAggDx ?? 0) !== 0 || (owner.fanoutAggDy ?? 0) !== 0,
    ).toBe(true);
  });

  it("seats the short-path branch chip the removed aggregate used to cover", () => {
    // A short-branch member's leg degenerates to the in-corridor run past the
    // junction, and that leg is narrower than the chip's own reserved box, so
    // while the owner's aggregate box sat on that corridor there was no
    // chip/card-clear point anywhere on the member's own leg and its branch
    // chip was hidden. Task 8 re-derivation:
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
    // box the chip RESERVES plus DOT_KEEPOFF, so the dot stays visible under
    // nothing the chip can draw).
    const reservedHalf = CHIP_BOX_HEIGHT / 2;
    expect(
      Math.abs(cx - fan.junction.x) >= reservedHalf + 16 ||
        Math.abs(cy - fan.junction.y) >= reservedHalf + 16,
    ).toBe(true);
  });

  it("keeps the DEV exhausted tripwire when a branch seat exhausts before hiding", () => {
    // Two foreign wall cards straddle the members' shared row: they leave the
    // row itself (and so the fan-out classification's trunk / leg / column
    // acceptance) clear, but block every candidate the seat can reach. Task 8
    // re-derivation: the branch seat now slides only over the member's OWN leg
    // (the suffix after the junction), and the short-leg rule collapses that
    // leg's chip to the icon-only box -- so the walls must sit where even a
    // 24-unit scale-1 collapsed box cannot clear them (x 330..430 spans every
    // on-line candidate and both sidestep directions), and the members must be LEVEL
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
    // Every box the ladder tries on the line is CHIP_BOX_HEIGHT tall, so the
    // wall half-gap must stay under CHIP_BOX_HEIGHT / 2 for the line to count
    // as blocked.
    const wallHalfGap = CHIP_BOX_HEIGHT / 2 - 1;
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
