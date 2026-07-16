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
