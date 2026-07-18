// Direct unit tests for seatRateChip's tier ladder, exercised through a
// hand-built ClearanceField. The scenario that motivates the graze tier comes
// from issue #9: a foreign line running parallel within a chip half-height of
// the whole own polyline used to poison EVERY tier-1 candidate, so the chip
// took an off-line vertical exit (48..144 units) and rendered as a label
// floating in empty canvas. Staying on the own line, even when that grazes a
// foreign line, must outrank leaving the line.

import { describe, it, expect } from "vitest";

import {
  chipEntersOwnCardBody,
  makeClearanceField,
  seatRateChip,
  type CardExemption,
  type EdgeSegments,
  type CardRect,
  type EntryBand,
} from "../../src/canvas/chipSeating";
import { CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";

// No entry band: left > right can never contain a point, so the arrival-cluster
// exemption never applies (mirrors chipSeating's NEVER_BAND idiom).
const NO_BAND: EntryBand = {
  left: Infinity,
  right: -Infinity,
  top: Infinity,
  bottom: -Infinity,
};

// No card exemption at all: no container is wholly exempt and no card carries a
// port zone, so every card in the field is a plain foreign obstacle.
const NO_EXEMPT: CardExemption = { whole: new Set(), zones: new Map() };

// A long horizontal own line at y=0 with its anchor at the middle.
const LINE: {
  pts: ReadonlyArray<readonly [number, number]>;
  anchorX: number;
  anchorY: number;
} = { pts: [[0, 0], [1000, 0]], anchorX: 500, anchorY: 0 };

// A foreign flow line running parallel 10 units above the own line. Any chip
// box centred ON the own line (half-height MAX_CHIP_SCALE * 24 / 2 = 24)
// overlaps it, so no fully-clear on-line point exists anywhere.
const PARALLEL_FOREIGN: EdgeSegments = {
  id: "parallel",
  flowKey: "foreign",
  target: "elsewhere",
  segs: [[-1000, 10, 2000, 10]],
};

describe("seatRateChip: graze tier (on-own-line outranks foreign-line clearance)", () => {
  it("seats at the anchor on its own line when only a foreign line blocks it", () => {
    const field = makeClearanceField([PARALLEL_FOREIGN], []);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toEqual({ dx: 0, dy: 0, tier: "graze" });
  });

  it("slides along its own line past a blocking chip instead of leaving it", () => {
    const field = makeClearanceField([PARALLEL_FOREIGN], []);
    // A wide chip already sits exactly on the anchor.
    field.placed.push({
      x: LINE.anchorX,
      y: LINE.anchorY,
      halfW: (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2,
      halfH: MAX_CHIP_SCALE * 12,
    });
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat.tier).toBe("graze");
    // Still on the own line...
    expect(seat.dy).toBe(0);
    // ...and horizontally clear of the placed chip (wide-vs-wide needs a full
    // max-scale box width of centre separation).
    expect(Math.abs(seat.dx)).toBeGreaterThanOrEqual(
      MAX_CHIP_SCALE * CHIP_BOX_WIDTH,
    );
  });

  it("still prefers a fully clear on-line seat when one exists (anchor tier)", () => {
    const field = makeClearanceField([], []);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toEqual({ dx: 0, dy: 0, tier: "anchor" });
  });

  it("clamps an anchor rounding pushed past the polyline end instead of sliding", () => {
    // A fan-out trunk anchor is rounded independently of the polyline's end
    // point, so it can land a hair past the last vertex. lengthAtPoint's
    // 1-unit segment tolerance still resolves it, but to an arc length beyond
    // the total, which used to make tier 1 skip the delta=0 candidate and every
    // positive delta: an uncrowded chip took a spurious one-step slide left.
    // The clamped anchor seats at the path end, a sub-rounding offset at most.
    const field = makeClearanceField([], []);
    const seat = seatRateChip(
      field,
      { pts: [[0, 0], [100, 0]], anchorX: 100.0075, anchorY: 0 },
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(seat.dy).toBe(0);
    expect(Math.abs(seat.dx)).toBeLessThanOrEqual(0.02);
  });

  it("keeps the off-line nudge as the last resort when a card covers the whole line", () => {
    // A foreign card spans the entire own line, so both on-line tiers fail on
    // the chip-vs-card HARD invariant; the seat must leave the line exactly as
    // before the graze tier existed.
    const card: CardRect = {
      id: "card",
      left: -100,
      top: -30,
      right: 1100,
      bottom: 30,
    };
    const field = makeClearanceField([], [card]);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat.tier).toBe("nudge");
    expect(seat.dx).toBe(0);
    // First nudge step clear of the card's 30-bottom plus the 24 half-height:
    // k=1 (48) still grazes, k=2 (96) clears.
    expect(Math.abs(seat.dy)).toBe(96);
  });
});

// Chip half-extents at max scale (matching seatRateChip's boxAt): a wide box is
// 120 half-wide, 24 half-tall.
const HALF_W = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;
const HALF_H = MAX_CHIP_SCALE * 12;

// The seated chip box, reconstructed from the anchor plus the returned offsets.
function seatedBox(
  anchorX: number,
  anchorY: number,
  seat: { dx: number; dy: number },
): { left: number; top: number; right: number; bottom: number } {
  const cx = anchorX + seat.dx;
  const cy = anchorY + seat.dy;
  return { left: cx - HALF_W, top: cy - HALF_H, right: cx + HALF_W, bottom: cy + HALF_H };
}

// Own-card exemption limited to a single card's port zone (no wholly exempt
// containers), the issue #10 narrowing under test.
function portZone(cardId: string, side: "source" | "target"): CardExemption {
  return { whole: new Set(), zones: new Map([[cardId, side]]) };
}

describe("seatRateChip: own-card port-zone exemption (issue #10)", () => {
  it("(a) pushes a chip whose centre is buried deep on its target card body off to a free line", () => {
    // The #10 defect: a chip whose CENTRE lands ~2 box-widths into the consumer
    // card (anchor 720 vs card left 500 = 220 in). The whole-card exemption used
    // to seat it there on its line; the port-zone rule makes the body past the
    // strip an obstacle, so the seat slides back out of the card.
    const card: CardRect = { id: "T", left: 500, top: -30, right: 900, bottom: 30 };
    const field = makeClearanceField([], [card]);
    const line = {
      pts: [[0, 0], [900, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 720,
      anchorY: 0,
    };
    const seat = seatRateChip(field, line, "own", "t", portZone("T", "target"), NO_BAND);
    // Moved off the buried anchor...
    expect(seat.dx !== 0 || seat.dy !== 0).toBe(true);
    // ...to a seat whose centre no longer sits on the card body.
    expect(
      chipEntersOwnCardBody(seatedBox(720, 0, seat), card, "target"),
    ).toBe(false);
  });

  it("(b) keeps a normal on-line chip whose centre is in the corridor on its anchor", () => {
    // The wide box pokes 110 units past the in-port edge (chip.right 610 vs card
    // left 500) -- unavoidable, the box is wider than the corridor -- but its
    // CENTRE (490) is still in the corridor, so the chip is exempt and seats
    // untouched. The regression guard that the narrowing did not reintroduce
    // issue #9's orphaned chips by flinging every on-line chip off its line.
    const card: CardRect = { id: "T", left: 500, top: -30, right: 900, bottom: 30 };
    const field = makeClearanceField([], [card]);
    const line = {
      pts: [[0, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 490,
      anchorY: 0,
    };
    const seat = seatRateChip(field, line, "own", "t", portZone("T", "target"), NO_BAND);
    expect(seat).toEqual({ dx: 0, dy: 0, tier: "anchor" });
    expect(
      chipEntersOwnCardBody(seatedBox(490, 0, seat), card, "target"),
    ).toBe(false);
  });

  it("(c) seats a chip whose whole line is buried in a card via the escape cascade", () => {
    // A short own line lying ENTIRELY inside a card body (centre on the body
    // everywhere): no on-line point clears the body, so the seat must escape off
    // the line, land near the anchor, and clear the body -- not hide or float far
    // (issue #9).
    const card: CardRect = { id: "T", left: 300, top: -30, right: 900, bottom: 30 };
    const field = makeClearanceField([], [card]);
    const exempt = portZone("T", "target");
    const line = {
      pts: [[400, 0], [600, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 500,
      anchorY: 0,
    };
    const seat = seatRateChip(field, line, "own", "t", exempt, NO_BAND);
    expect(["nudge", "escape"]).toContain(seat.tier);
    expect(Math.abs(seat.dy)).toBeLessThanOrEqual(300);
    expect(
      chipEntersOwnCardBody(seatedBox(500, 0, seat), card, "target"),
    ).toBe(false);
  });

  it("(d) slides a fan-out aggregate leftward along the trunk off a member-target body", () => {
    // The aggregate anchor's centre sits on a member target's body (anchor 460 vs
    // member left 380 = 80 in, past the 12 strip). Zone-narrowing re-adds that
    // body as an obstacle (issue #10), and the seat slides LEFT along the trunk
    // (tier 1) until its centre leaves the body rather than leaving the line.
    const source: CardRect = { id: "S", left: 0, top: -30, right: 100, bottom: 30 };
    const member: CardRect = { id: "A", left: 380, top: -30, right: 900, bottom: 30 };
    const field = makeClearanceField([], [source, member]);
    const exempt: CardExemption = {
      whole: new Set(),
      zones: new Map<string, "source" | "target">([
        ["S", "source"],
        ["A", "target"],
      ]),
    };
    const trunk = {
      pts: [[100, 0], [600, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 460,
      anchorY: 0,
    };
    const seat = seatRateChip(field, trunk, "own", "t", exempt, NO_BAND);
    expect(seat.tier).toBe("slide");
    expect(seat.dx).toBeLessThan(0);
    expect(seat.dy).toBe(0);
    expect(
      chipEntersOwnCardBody(seatedBox(460, 0, seat), member, "target"),
    ).toBe(false);
  });
});

describe("seatRateChip: horizontal sidestep off a parallel foreign vertical (issue #28)", () => {
  it("steps a chip off a foreign vertical 16 units away instead of straddling it", () => {
    // Twin vertical corridors 16 units apart (fan-out branch legs right of a
    // card): the own leg at x=0, a FOREIGN leg at x=16. A wide chip box seated on
    // the own leg (half-width 120) necessarily straddles the foreign leg, and no
    // vertical motion clears it: slide-along-leg, nudge, and cascade all hold x
    // on a vertical leg, so the pre-sidestep seat grazed the neighbour. The
    // sidestep tier steps the box horizontally away from the foreign leg toward
    // the own leg's free side until the box clears the foreign leg.
    const ownVertical = {
      pts: [[0, 0], [0, 1000]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 0,
      anchorY: 500,
    };
    const foreignVertical: EdgeSegments = {
      id: "foreign",
      flowKey: "foreign",
      target: "elsewhere",
      segs: [[16, -1000, 16, 2000]],
    };
    const field = makeClearanceField([foreignVertical], []);
    const seat = seatRateChip(field, ownVertical, "own", "t", NO_EXEMPT, NO_BAND);
    const cx = ownVertical.anchorX + seat.dx;
    // The seated box no longer overlaps the foreign leg at x=16: a wide box needs
    // a full half-width of centre separation to clear a vertical line.
    expect(Math.abs(cx - 16)).toBeGreaterThanOrEqual(HALF_W);
    // Escaped toward the free side (left, away from the foreign leg at +16).
    expect(seat.dx).toBeLessThan(0);
    // The own leg (x=0) still lies within the box, so the chip reads as bound to
    // it -- the escape stays within one half-width of the line.
    expect(Math.abs(seat.dx)).toBeLessThanOrEqual(HALF_W);
    // A pure horizontal escape: no vertical move off the anchor.
    expect(seat.dy).toBe(0);
    expect(seat.tier).toBe("sidestep");
  });

  it("still grazes (stays on the line) when the foreign line is parallel to the own line", () => {
    // A HORIZONTAL foreign line parallel to a horizontal own line (issue #9): no
    // horizontal step can clear it (it spans every x at that y), so the sidestep
    // finds nothing and the chip stays ON its own line via the graze tier rather
    // than flying off. Guards that the sidestep never regresses the #9 fix.
    const field = makeClearanceField([PARALLEL_FOREIGN], []);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toEqual({ dx: 0, dy: 0, tier: "graze" });
  });
});

describe("seatRateChip: trunk-aware foreignness for the aggregate (issue #28)", () => {
  it("treats a same-flowKey edge OUTSIDE the trunk member set as foreign", () => {
    // A fan-out aggregate on a SHORT horizontal trunk whose wide box wholly
    // overhangs it, plus a direct same-item edge (SAME flowKey, but NOT a trunk
    // member) dropping vertically just past the junction. flowKey grouping alone
    // treats that direct edge as own flow, so the aggregate seats straddling it
    // at its anchor; the trunk-aware own-set (member edge ids) flags it foreign,
    // so the sidestep steps the box clear of its vertical. This is the v14-gas
    // Sigma-60-vs-12/min defect in miniature (finding 1).
    const member: EdgeSegments = { id: "m", flowKey: "trunk", target: "tm", segs: [] };
    const direct: EdgeSegments = {
      id: "d",
      flowKey: "trunk", // same item|source as the trunk, yet a separate edge
      target: "td",
      segs: [[210, -1000, 210, 1000]],
    };
    const field = makeClearanceField([member, direct], []);
    const trunk = {
      pts: [[100, 0], [200, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 150,
      anchorY: 0,
    };
    const seat = seatRateChip(field, trunk, "trunk", "t", NO_EXEMPT, NO_BAND, {
      ownIds: new Set(["m"]),
    });
    // Stepped off the direct edge's vertical (x=210): a wide box needs a full
    // half-width of centre separation to clear it.
    const cx = trunk.anchorX + seat.dx;
    expect(Math.abs(cx - 210)).toBeGreaterThanOrEqual(HALF_W);
    // Still within a half-width of its own trunk column, purely horizontal.
    expect(Math.abs(seat.dx)).toBeLessThanOrEqual(HALF_W);
    expect(seat.dy).toBe(0);
    expect(seat.tier).toBe("sidestep");
  });
});

describe("seatRateChip: slide barrier keeps branch chips in stack order (issue #28)", () => {
  it("clamps a pushed bottom branch below an already-seated sibling instead of crossing it", () => {
    // Three-branch fan-out on one junction column (multi6 Sandleaf lane): the
    // mid branch is already seated at y=384, and a foreign lane chip blocks the
    // bottom branch's anchor (y=480) and everything below it up to y=640. With no
    // barrier the bottom branch slides UP its own leg to y=336, crossing ABOVE
    // the mid sibling (the inverted stack of finding 2). The barrier clamps the
    // slide at the sibling, so the branch instead slides DOWN past the foreign
    // chip, staying below its sibling -- the stack reads top-to-bottom in order.
    const leg = {
      pts: [[0, 0], [0, 1000]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 0,
      anchorY: 480,
    };
    const field = makeClearanceField([], []);
    // Mid-branch sibling already seated at y=384 on the shared column.
    field.placed.push({ x: 0, y: 384, halfW: HALF_W, halfH: HALF_H });
    // Foreign lane chip covering [408, 640]: blocks the anchor and below it.
    field.placed.push({ x: 0, y: 524, halfW: HALF_W, halfH: 116 });
    const seat = seatRateChip(field, leg, "own", "t", NO_EXEMPT, NO_BAND, {
      barrierYs: [384],
    });
    // Seats BELOW the sibling (y > 384): monotonic top-to-bottom order kept, no
    // crossing above it.
    expect(leg.anchorY + seat.dy).toBeGreaterThan(384);
  });
});
