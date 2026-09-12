// Chip metrics: the box a chip reserves and the text it draws. These cases used
// to live inside the seating suite; they are the metrics module's own surface,
// arithmetic over its estimator and its three text builders, with no field and
// no seat.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";

import {
  aggregateChipText,
  branchChipText,
  chipSeatHalfW,
  examChipReservations,
} from "../../src/canvas/chipMetrics";
import { CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";

// Chip half-extents at max scale: a wide box is 120 half-wide.
const HALF_W = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;

// Per-chip seat box (Task 6b): the seat reserves an upper bound on what the chip
// will DRAW instead of the widest box the CSS clamp allows.
describe("chipSeatHalfW: the per-chip reserved box", () => {
  // The .flow-chip chrome (canvas.css): 16px sprite + 6px gap + 7px padding per
  // side + 1px border per side. Mirrored here so a change to either number
  // shows up as a failing expectation rather than a silently re-derived one.
  const CHROME = 16 + 6 + 2 * 7 + 2 * 1;
  const GLYPH = 7.5;
  const UNIT = 34;
  const ICON = (MAX_CHIP_SCALE * 24) / 2;

  it("reserves the chip's own text width, not the worst-case box", () => {
    // "150" plus the unit: 38 + 3 glyphs + the widest localized unit = 94.5px
    // natural, reserved at MAX_CHIP_SCALE and halved.
    expect(chipSeatHalfW({ body: "150", unit: true }, false)).toBe(
      (MAX_CHIP_SCALE * (CHROME + 3 * GLYPH + UNIT)) / 2,
    );
    expect(chipSeatHalfW({ body: "150", unit: true }, false)).toBeLessThan(
      HALF_W,
    );
  });

  it("charges no unit to a share chip, which draws digits only", () => {
    // A multi-member bus rise reads "30/270" with no unit (issue #45), so the
    // 34px unit reserve must not be charged to it.
    expect(chipSeatHalfW({ body: "30/270", unit: false }, false)).toBe(
      (MAX_CHIP_SCALE * (CHROME + 6 * GLYPH)) / 2,
    );
  });

  it("clamps at the CSS max-width, which is the old worst case", () => {
    // .flow-chip has max-width: 120px and ellipsizes past it, so no estimate may
    // exceed CHIP_BOX_WIDTH however long the digits get.
    expect(chipSeatHalfW({ body: "1234567.89", unit: true }, false)).toBe(
      HALF_W,
    );
  });

  it("falls back to the worst case when there is no text to measure", () => {
    // Fixtures without a rate, and edges whose rate rounds to the empty string
    // (which draw no chip at all): over-reserving an invisible box is harmless,
    // guessing a narrow one is not.
    expect(chipSeatHalfW(undefined, false)).toBe(HALF_W);
    expect(chipSeatHalfW({ body: "", unit: true }, false)).toBe(HALF_W);
  });

  it("reserves the square icon box for a collapsed chip, text or not", () => {
    expect(chipSeatHalfW({ body: "150", unit: true }, true)).toBe(ICON);
    expect(chipSeatHalfW(undefined, true)).toBe(ICON);
  });
});

describe("aggregateChipText / branchChipText", () => {
  // Minimal fan-out member edges: only the fields the builders read.
  const member = (data: Record<string, unknown>) =>
    ({
      id: "e0",
      source: "s",
      target: "t",
      type: "bus",
      data: { item: "a", ...data },
    }) as unknown as Parameters<typeof branchChipText>[0];

  it("branch: a multi-member trunk reads as a unit-less share of the total", () => {
    const text = branchChipText(
      member({
        rate: new Fraction(1, 2), // 30/min
        busMemberCount: 2,
        busTotalRate: new Fraction(9, 2), // 270/min
      }),
    );
    expect(text).toEqual({ body: "30/270", unit: false });
  });

  it("branch: a fan-out member keeps the plain rate + unit reading", () => {
    // R3 (exam 2026-09-04): the share form is reserved for bus-LANE members.
    // routeFanoutEdges retypes a formed fan-out branch to type "bus" with
    // busMemberCount >= 2, so keying the share on the count alone printed
    // "15/30" beside the "15/min" item edges of its unformed siblings. The
    // fanout discriminant returns the plain body + unit instead.
    const text = branchChipText(
      member({
        rate: new Fraction(1, 2), // 30/min
        fanout: true,
        busMemberCount: 2,
        busTotalRate: new Fraction(9, 2), // 270/min
      }),
    );
    expect(text).toEqual({ body: "30", unit: true });
  });

  it("branch: a lone member keeps the plain rate + unit reading", () => {
    const text = branchChipText(
      member({ rate: new Fraction(1, 2), busMemberCount: 1 }),
    );
    expect(text).toEqual({ body: "30", unit: true });
  });

  it("branch: multi-member with busTotalRate absent falls back to its own rate as the total", () => {
    const text = branchChipText(
      member({ rate: new Fraction(1, 2), busMemberCount: 2 }),
    );
    expect(text).toEqual({ body: "30/30", unit: false });
  });

  it("aggregate: shows the trunk total with unit, falling back to the member rate", () => {
    expect(
      aggregateChipText(
        member({ rate: new Fraction(1, 2), busTotalRate: new Fraction(9, 2) }),
      ),
    ).toEqual({ body: "270", unit: true });
    expect(aggregateChipText(member({ rate: new Fraction(1, 2) }))).toEqual({
      body: "30",
      unit: true,
    });
  });

  it("a missing rate reserves the worst case", () => {
    // Both builders return undefined with no usable rate, and the estimator
    // charges the full clamp width to that invisible box (over-reserve only).
    const noRate = member({});
    expect(branchChipText(noRate)).toBeUndefined();
    expect(aggregateChipText(noRate)).toBeUndefined();
    expect(chipSeatHalfW(undefined, false)).toBe(
      (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2,
    );
  });
});

describe("examChipReservations", () => {
  const edge = (id: string, type: string, data: Record<string, unknown>) =>
    ({
      id,
      source: "s",
      target: "t",
      type,
      data: { item: "a", ...data },
    }) as unknown as Parameters<typeof examChipReservations>[0][number];

  it("maps each edge to its FlowChip testIds with the builder texts", () => {
    const rows = examChipReservations([
      edge("i1", "item", { rate: new Fraction(1, 2) }), // 30/min
      edge("b1", "bus", {
        rate: new Fraction(1, 2), // 30/min
        busMemberCount: 2,
        busTotalRate: new Fraction(9, 2), // 270/min
      }),
      // R3: a fan-out member reserves the plain rate + unit, never the share
      // form its lane-member sibling above reserves.
      edge("f1", "bus", {
        rate: new Fraction(1, 2), // 30/min
        fanout: true,
        busMemberCount: 2,
        busTotalRate: new Fraction(9, 2), // 270/min
      }),
    ]);
    expect(rows).toEqual([
      {
        testId: "item-edge-label-i1",
        body: "30",
        unit: true,
        reservedPx:
          (2 * chipSeatHalfW({ body: "30", unit: true }, false)) /
          MAX_CHIP_SCALE,
      },
      {
        testId: "bus-edge-label-b1-drop",
        body: "270",
        unit: true,
        reservedPx:
          (2 * chipSeatHalfW({ body: "270", unit: true }, false)) /
          MAX_CHIP_SCALE,
      },
      {
        testId: "bus-edge-label-b1-rise",
        body: "30/270",
        unit: false,
        reservedPx:
          (2 * chipSeatHalfW({ body: "30/270", unit: false }, false)) /
          MAX_CHIP_SCALE,
      },
      {
        testId: "bus-edge-label-f1-drop",
        body: "270",
        unit: true,
        reservedPx:
          (2 * chipSeatHalfW({ body: "270", unit: true }, false)) /
          MAX_CHIP_SCALE,
      },
      {
        testId: "bus-edge-label-f1-rise",
        body: "30",
        unit: true,
        reservedPx:
          (2 * chipSeatHalfW({ body: "30", unit: true }, false)) /
          MAX_CHIP_SCALE,
      },
    ]);
  });

  it("skips edges with no usable rate: their chips never draw a box", () => {
    expect(
      examChipReservations([edge("x", "item", {}), edge("y", "bus", {})]),
    ).toEqual([]);
  });
});
