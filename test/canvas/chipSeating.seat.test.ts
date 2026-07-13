// Direct unit tests for seatRateChip's tier ladder, exercised through a
// hand-built ClearanceField. The scenario that motivates the graze tier comes
// from issue #9: a foreign line running parallel within a chip half-height of
// the whole own polyline used to poison EVERY tier-1 candidate, so the chip
// took an off-line vertical exit (48..144 units) and rendered as a label
// floating in empty canvas. Staying on the own line, even when that grazes a
// foreign line, must outrank leaving the line.

import { describe, it, expect } from "vitest";

import {
  makeClearanceField,
  seatRateChip,
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

const NO_EXEMPT: ReadonlySet<string> = new Set();

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
