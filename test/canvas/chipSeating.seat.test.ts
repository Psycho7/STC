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
  chipOwnCardIntrusion,
  chipSeatHalfW,
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
    // toMatchObject, not toEqual: a RateSeat also carries the ChipBox the field
    // reserved, which every seat assertion here is indifferent to.
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("slides along its own line past a blocking chip instead of leaving it", () => {
    const field = makeClearanceField([PARALLEL_FOREIGN], []);
    // A wide chip already sits exactly on the anchor.
    field.seat({
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
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "anchor" });
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

  it("grazes at the least-crossed candidate, not the first clear one", () => {
    // Own line runs horizontally (0,100)->(1200,100), anchor at x=48. A
    // parallel foreign line 10 units below poisons every candidate (so tier 1
    // and the sidestep both fail and the ladder reaches graze), and two
    // foreign verticals near the anchor make the anchor a 3-crossing seat.
    // From x=176 the box (halfW 120) sheds both verticals, leaving score 1.
    // First-hit grazing seats at the anchor; least-bad must slide to the first
    // arc step at or past x=176, which is x=192 (48 + 6*24).
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f2", flowKey: "b", target: "other", segs: [[56, 0, 56, 200]] },
        { id: "f3", flowKey: "c", target: "other", segs: [[0, 110, 1200, 110]] },
      ],
      [],
    );
    const seat = seatRateChip(
      field,
      { pts: [[0, 100], [1200, 100]], anchorX: 48, anchorY: 100 },
      "own",
      "T",
      NO_EXEMPT,
      { left: 2000, right: 2100, top: 0, bottom: 200 },
    );
    expect(seat.tier).toBe("graze");
    expect(seat.dy).toBe(0);
    expect(seat.dx).toBe(144);
  });

  it("keeps the forward candidate when two seats tie on crossings", () => {
    // The scan's tie rule, at a tie the score-1 early exit cannot reach. Own
    // line (408,100)->(792,100), anchor at its middle x=600, so the walk has
    // exactly 8 steps of reach in each direction (384 / 2 / SLIDE_STEP 24) and
    // no candidate exists beyond the tying pair.
    //   - two parallel foreign horizontals at y=90 and y=110 sit inside every
    //     candidate box (half-height 24), so the floor is 2 crossings: tier 1
    //     and the sidestep both fail, and 2 is above the early exit's 1;
    //   - two foreign verticals symmetric about the anchor at x=540 / x=660 are
    //     each crossed while the box (half-width 120) reaches them, i.e. while
    //     |dx| < 180 -- both near the anchor, one out to |dx| = 168.
    // So the minimum score 2 is first reached at |dx| = 192, by the k=8 pair on
    // BOTH sides at once. Strict less-than keeps the forward candidate probed
    // first; <= would let the equal backward one replace it. (The all-equal
    // line, where the tie is at the anchor itself, is the first case above.)
    const field = makeClearanceField(
      [
        { id: "h1", flowKey: "a", target: "other", segs: [[0, 90, 1200, 90]] },
        { id: "h2", flowKey: "b", target: "other", segs: [[0, 110, 1200, 110]] },
        { id: "v1", flowKey: "c", target: "other", segs: [[540, 0, 540, 200]] },
        { id: "v2", flowKey: "d", target: "other", segs: [[660, 0, 660, 200]] },
      ],
      [],
    );
    const seat = seatRateChip(
      field,
      { pts: [[408, 100], [792, 100]], anchorX: 600, anchorY: 100 },
      "own",
      "T",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(seat.tier).toBe("graze");
    expect(seat.dy).toBe(0);
    expect(seat.dx).toBe(192);
  });
});

describe("ClearanceField.foreignLineCrossings (counting sibling of onForeignLine)", () => {
  // A wide chip box in the corridor, and the same box far to the right.
  const BOX = { x: 48, y: 100, halfW: 120, halfH: 24 };
  const FAR_BOX = { x: 300, y: 100, halfW: 120, halfH: 24 };
  // A band nowhere near either box centre, so the arrival-cluster exemption is
  // OFF unless a test hands in a band that does contain the centre.
  const AWAY_BAND: EntryBand = { left: 2000, right: 2100, top: 0, bottom: 200 };
  // A band around BOX's centre, so a same-target sibling IS exempt for it.
  const OVER_BOX_BAND: EntryBand = { left: 0, right: 100, top: 0, bottom: 200 };

  it("counts every intersecting foreign (edge, segment) pair", () => {
    // Own flow is "own"; three foreign edges: two verticals crossing the
    // corridor near x=40 and x=56, and one horizontal running 10 units below
    // the own line, spanning the whole corridor.
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f2", flowKey: "b", target: "other", segs: [[56, 0, 56, 200]] },
        { id: "f3", flowKey: "c", target: "other", segs: [[0, 110, 1200, 110]] },
      ],
      [],
    );
    expect(field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND)).toBe(3);
    // Only the long horizontal reaches out here.
    expect(field.foreignLineCrossings(FAR_BOX, "own", "T", AWAY_BAND)).toBe(1);
  });

  it("scores two equally-blocked seats apart where the boolean cannot", () => {
    // The whole point of the count: onForeignLine answers "blocked" for both
    // boxes, so it cannot rank them; the count says the far seat is three times
    // less bad. Segments of ONE edge count separately, matching the (edge,
    // segment) pairs the segment-vs-chip audit ratchets.
    const field = makeClearanceField(
      [
        {
          id: "weave",
          flowKey: "a",
          target: "other",
          segs: [
            [20, 0, 20, 200],
            [40, 0, 40, 200],
            [56, 0, 56, 200],
          ],
        },
        { id: "single", flowKey: "b", target: "other", segs: [[300, 0, 300, 200]] },
      ],
      [],
    );
    expect(field.onForeignLine(BOX, "own", "T", AWAY_BAND)).toBe(true);
    expect(field.onForeignLine(FAR_BOX, "own", "T", AWAY_BAND)).toBe(true);
    expect(field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND)).toBe(3);
    expect(field.foreignLineCrossings(FAR_BOX, "own", "T", AWAY_BAND)).toBe(1);
  });

  it("waives same-flowKey own lines and counts the rest", () => {
    const field = makeClearanceField(
      [
        { id: "o1", flowKey: "own", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f1", flowKey: "a", target: "other", segs: [[56, 0, 56, 200]] },
      ],
      [],
    );
    expect(field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND)).toBe(1);
  });

  it("switches own-ness to the edge-id set when ownIds is given", () => {
    // e1 shares the chip's flowKey but is NOT a trunk member; e2 is (issue #28).
    const field = makeClearanceField(
      [
        {
          id: "e1",
          flowKey: "own",
          target: "other",
          segs: [
            [40, 0, 40, 200],
            [56, 0, 56, 200],
          ],
        },
        { id: "e2", flowKey: "a", target: "other", segs: [[20, 0, 20, 200]] },
      ],
      [],
    );
    // flowKey grouping: e1 is own, only e2's single segment counts.
    expect(field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND)).toBe(1);
    // Trunk member set: e2 is own, e1's two segments count instead.
    expect(
      field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND, new Set(["e2"])),
    ).toBe(2);
  });

  it("waives same-target siblings exactly when the arrival-cluster rule does", () => {
    const field = makeClearanceField(
      [{ id: "sib", flowKey: "a", target: "T", segs: [[40, 0, 40, 200]] }],
      [],
    );
    // No band: cluster exemption is unconditional (bus / entry seats).
    expect(field.foreignLineCrossings(BOX, "own", "T")).toBe(0);
    // Band containing the box centre: still exempt.
    expect(field.foreignLineCrossings(BOX, "own", "T", OVER_BOX_BAND)).toBe(0);
    // Centre outside the band: the sibling counts like any foreign line.
    expect(field.foreignLineCrossings(BOX, "own", "T", AWAY_BAND)).toBe(1);
    // A different target is never cluster-exempt.
    expect(field.foreignLineCrossings(BOX, "own", "U", OVER_BOX_BAND)).toBe(1);
  });

  it("windows exactly the pairs it counts, and nothing where the boolean is clear", () => {
    // The two invariants foreignLineWindows documents, on the same three-edge
    // field the count test above uses: one window per counted (edge, segment)
    // pair, and an empty array exactly when onForeignLine says clear. Both hold
    // by construction (one shared predicate, one shared clip), which is
    // precisely why a refactor could break them silently.
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f2", flowKey: "b", target: "other", segs: [[56, 0, 56, 200]] },
        { id: "f3", flowKey: "c", target: "other", segs: [[0, 110, 1200, 110]] },
        // A same-target sibling, so the OVER_BOX_BAND case below actually runs
        // the arrival-cluster exemption: without one, every band is equivalent
        // here and a windows walk that skipped the exemption would still agree
        // with the count.
        { id: "sib", flowKey: "d", target: "T", segs: [[20, 0, 20, 200]] },
      ],
      [],
    );
    // BOX takes all four, FAR_BOX only the long horizontal, and the third box
    // sits above every one of them so the empty case is exercised too. BOX runs
    // twice: under AWAY_BAND the sibling counts like any foreign line, under
    // OVER_BOX_BAND it is waived, and the windows have to follow either way.
    const CLEAR_BOX = { x: 800, y: 20, halfW: 120, halfH: 24 };
    const cases: ReadonlyArray<
      [{ x: number; y: number; halfW: number; halfH: number }, EntryBand]
    > = [
      [BOX, AWAY_BAND],
      [FAR_BOX, AWAY_BAND],
      [CLEAR_BOX, AWAY_BAND],
      [BOX, OVER_BOX_BAND],
    ];
    for (const [box, band] of cases) {
      const windows = field.foreignLineWindows(box, "own", "T", band);
      expect(windows.length).toBe(
        field.foreignLineCrossings(box, "own", "T", band),
      );
      expect(windows.length === 0).toBe(
        !field.onForeignLine(box, "own", "T", band),
      );
    }
  });

  it("agrees with onForeignLine on zero-vs-nonzero for identical arguments", () => {
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "sib", flowKey: "b", target: "T", segs: [[56, 0, 56, 200]] },
        { id: "own1", flowKey: "own", target: "other", segs: [[20, 0, 20, 200]] },
      ],
      [],
    );
    const cases: ReadonlyArray<
      [{ x: number; y: number; halfW: number; halfH: number }, EntryBand | undefined]
    > = [
      [BOX, AWAY_BAND],
      [BOX, OVER_BOX_BAND],
      [BOX, undefined],
      [FAR_BOX, AWAY_BAND],
      [FAR_BOX, undefined],
    ];
    for (const [box, band] of cases) {
      expect(field.foreignLineCrossings(box, "own", "T", band) > 0).toBe(
        field.onForeignLine(box, "own", "T", band),
      );
    }
  });

  // The two probes are one predicate applied twice, so the contract worth
  // pinning is not a handful of hand-picked boxes but the whole argument space:
  // a dense weave swept by a deterministic pseudo-random walk over box centres,
  // bands, targets and trunk member sets. Each case also decomposes the query
  // per edge -- the whole-field answers must be the OR and the SUM of the
  // single-edge answers -- which pins that no edge's verdict depends on another
  // edge's (an aborted walk, or cluster state resolved from the wrong edge,
  // survives the plain parity check but not this one).
  it("agrees with onForeignLine and decomposes per edge across a swept weave", () => {
    const weave: ReadonlyArray<EdgeSegments> = [
      { id: "e0", flowKey: "own", target: "T", segs: [[20, 0, 20, 200]] },
      { id: "e1", flowKey: "own", target: "U", segs: [[60, 0, 60, 200], [60, 40, 260, 40]] },
      { id: "e2", flowKey: "a", target: "T", segs: [[100, 0, 100, 200]] },
      { id: "e3", flowKey: "a", target: "U", segs: [[140, 0, 140, 200], [0, 90, 400, 90]] },
      { id: "e4", flowKey: "b", target: "T", segs: [[180, 0, 180, 200]] },
      { id: "e5", flowKey: "b", target: "V", segs: [[220, 60, 380, 60], [220, 60, 220, 200]] },
      { id: "e6", flowKey: "c", target: "U", segs: [[260, 0, 260, 200], [300, 0, 300, 200]] },
      { id: "e7", flowKey: "c", target: "V", segs: [[0, 130, 400, 130]] },
    ];
    const field = makeClearanceField(weave, []);
    const single = weave.map((e) => makeClearanceField([e], []));
    // Deterministic 32-bit LCG (Numerical Recipes constants); no test flake.
    let state = 20260820;
    const rnd = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const pick = <T,>(xs: ReadonlyArray<T>): T => xs[Math.floor(rnd() * xs.length)]!;
    const targets = ["T", "U", "V"] as const;
    const ownSets: ReadonlyArray<ReadonlySet<string> | undefined> = [
      undefined,
      new Set(["e0"]),
      new Set(["e2", "e5"]),
      new Set<string>(),
    ];
    let blocked = 0;
    for (let i = 0; i < 400; i++) {
      // Widths vary so the sweep visits clear boxes too: a 240-wide chip box on
      // this weave is blocked almost everywhere.
      const box = {
        x: Math.round(rnd() * 480) - 40,
        y: Math.round(rnd() * 200),
        halfW: pick([6, 40, 120]),
        halfH: pick([6, 24]),
      };
      const bandLeft = Math.round(rnd() * 400) - 40;
      const bandTop = Math.round(rnd() * 200);
      const band: EntryBand | undefined =
        rnd() < 0.25
          ? undefined
          : {
              left: bandLeft,
              right: bandLeft + Math.round(rnd() * 200),
              top: bandTop,
              bottom: bandTop + Math.round(rnd() * 120),
            };
      const target = pick(targets);
      const ownIds = pick(ownSets);
      const blockedHere = field.onForeignLine(box, "own", target, band, ownIds);
      const count = field.foreignLineCrossings(box, "own", target, band, ownIds);
      expect(count > 0).toBe(blockedHere);
      const perEdge = single.map((f) =>
        f.foreignLineCrossings(box, "own", target, band, ownIds),
      );
      expect(count).toBe(perEdge.reduce((a, b) => a + b, 0));
      expect(
        single.some((f) => f.onForeignLine(box, "own", target, band, ownIds)),
      ).toBe(blockedHere);
      if (blockedHere) blocked++;
    }
    // The sweep is only worth its runtime if it actually visits both verdicts.
    expect(blocked).toBeGreaterThan(40);
    expect(blocked).toBeLessThan(360);
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

  it("(b) keeps a normal on-line chip on its own line, sliding it off the card body it laps", () => {
    // At the anchor the wide box pokes 110 units past the in-port edge
    // (chip.right 610 vs card left 500) while its CENTRE (490) is still in the
    // corridor, so the centre rule exempts it. The seat used to stop there; the
    // box-depth preference keeps the slide walking to the nearest point where
    // the BOX also clears the card (centre 370, box right 490), five slide steps
    // back along a 500-unit line. The regression guard that neither rule
    // reintroduced issue #9's orphaned chips: the seat is still tier 1, still on
    // the own line, still at the port y.
    const card: CardRect = { id: "T", left: 500, top: -30, right: 900, bottom: 30 };
    const field = makeClearanceField([], [card]);
    const line = {
      pts: [[0, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 490,
      anchorY: 0,
    };
    const seat = seatRateChip(field, line, "own", "t", portZone("T", "target"), NO_BAND);
    expect(seat).toMatchObject({ dx: -120, dy: 0, tier: "slide" });
    expect(seatedBox(490, 0, seat).right).toBeLessThanOrEqual(card.left);
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

// The card the intrusion fixtures below measure against: 400 wide, taller than a
// chip box, its in-port edge at x=500.
const INTRUSION_CARD: CardRect = {
  id: "T",
  left: 500,
  top: -30,
  right: 900,
  bottom: 30,
};

describe("chipOwnCardIntrusion: box depth past the port strip", () => {
  const boxAt = (cx: number): { left: number; top: number; right: number; bottom: number } => ({
    left: cx - HALF_W,
    top: -HALF_H,
    right: cx + HALF_W,
    bottom: HALF_H,
  });

  it("scores nothing while the box only laps the port strip", () => {
    // Lap exactly the budget (CARD_BORDER 1 + PORT_ZONE_DEPTH 8): the strip a
    // chip on its own line necessarily covers, which is not a defect.
    expect(chipOwnCardIntrusion(boxAt(389), INTRUSION_CARD)).toBe(0);
    // ...and nothing at all when the box stops at the border.
    expect(chipOwnCardIntrusion(boxAt(380), INTRUSION_CARD)).toBe(0);
    // ...or never reaches the card.
    expect(chipOwnCardIntrusion(boxAt(200), INTRUSION_CARD)).toBe(0);
  });

  it("scores the depth past the budget once the lap crosses it", () => {
    expect(chipOwnCardIntrusion(boxAt(390), INTRUSION_CARD)).toBe(1);
    expect(chipOwnCardIntrusion(boxAt(420), INTRUSION_CARD)).toBe(31);
  });

  it("saturates at the box's smaller extent when the card swallows it", () => {
    // Deep inside a card taller than the box: the depth is the box HEIGHT, not
    // the x-overlap, so a chip parked on the body scores the same wherever on
    // the body it sits.
    const swallowed = 2 * HALF_H - 9;
    expect(chipOwnCardIntrusion(boxAt(700), INTRUSION_CARD)).toBe(swallowed);
    expect(chipOwnCardIntrusion(boxAt(650), INTRUSION_CARD)).toBe(swallowed);
  });

  it("ignores a card the box is not level with", () => {
    const above = { left: 500, top: -300, right: 900, bottom: -100 };
    expect(chipOwnCardIntrusion(boxAt(700), above)).toBe(0);
  });
});

describe("seatRateChip: own-card intrusion preference (F1)", () => {
  it("keeps a seat whose box laps exactly the port strip", () => {
    // Boundary, from the legal side: box right 509, i.e. 9 past the card border,
    // so the anchor is within budget and the slide does not move.
    const field = makeClearanceField([], [INTRUSION_CARD]);
    const seat = seatRateChip(
      field,
      {
        pts: [[0, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
        anchorX: 389,
        anchorY: 0,
      },
      "own",
      "t",
      portZone("T", "target"),
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "anchor" });
  });

  it("walks one slide step past a seat that laps one unit deeper", () => {
    // Boundary, from the other side: one unit past the strip is over budget, so
    // the anchor is walked past and the nearest within-budget candidate (one
    // SLIDE_STEP back, box right 486) takes the seat. Nearest-first, so the
    // walk stops at the first legal candidate rather than the shallowest one
    // anywhere on the line.
    const field = makeClearanceField([], [INTRUSION_CARD]);
    const seat = seatRateChip(
      field,
      {
        pts: [[0, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
        anchorX: 390,
        anchorY: 0,
      },
      "own",
      "t",
      portZone("T", "target"),
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: -24, dy: 0, tier: "slide" });
  });

  it("breaks a graze tie away from the card", () => {
    // Every point on the line grazes the same parallel foreign line, so the
    // whole line ties at one crossing and the old scorer stopped at the anchor
    // with its box 110 units onto the card. The intrusion term now decides
    // among those tied candidates: the seat walks back to the nearest one whose
    // box is off the card body, still on its own line, still tier graze.
    const field = makeClearanceField([PARALLEL_FOREIGN], [INTRUSION_CARD]);
    const seat = seatRateChip(
      field,
      {
        pts: [[0, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
        anchorX: 490,
        anchorY: 0,
      },
      "own",
      "t",
      portZone("T", "target"),
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: -120, dy: 0, tier: "graze" });
    expect(seatedBox(490, 0, seat).right).toBeLessThanOrEqual(
      INTRUSION_CARD.left,
    );
  });

  it("keeps the junction-dot keep-off above the intrusion term", () => {
    // The two soft terms in conflict, on a 200-unit leg that runs into the
    // card: every dot-free candidate (>= 136 from the dot, one half-box plus
    // the keep-off) laps the card past the budget, and every within-budget
    // candidate (<= 389) swallows the dot. Dots win -- a buried split dot reads
    // as an ordinary corner, while a lapped box is still legible -- so the seat
    // is the nearest dot-free point and it pays the lap. Ranking the intrusion
    // first instead parks it back on the anchor with the dot underneath, which
    // is what four corpus plans measured when it was tried.
    const field = makeClearanceField(
      [],
      [INTRUSION_CARD],
      [{ x: 300, y: 0, kind: "fanout" }],
    );
    const seat = seatRateChip(
      field,
      {
        pts: [[300, 0], [500, 0]] as ReadonlyArray<readonly [number, number]>,
        anchorX: 380,
        anchorY: 0,
      },
      "own",
      "t",
      portZone("T", "target"),
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 72, dy: 0, tier: "slide" });
    expect(380 + seat.dx - 300).toBeGreaterThanOrEqual(HALF_W + 16);
    expect(
      chipOwnCardIntrusion(seatedBox(380, 0, seat), INTRUSION_CARD),
    ).toBeGreaterThan(0);
  });
});

describe("seatRateChip: horizontal sidestep off a parallel foreign vertical (issue #28)", () => {
  it("steps a chip off a foreign vertical inside its box instead of straddling it", () => {
    // Twin vertical corridors (fan-out branch legs right of a card): the own leg
    // at x=0, a FOREIGN leg at x=80. A wide chip box seated on the own leg
    // (half-width 120) necessarily straddles the foreign leg, and no vertical
    // motion clears it: slide-along-leg, nudge, and cascade all hold x on a
    // vertical leg, so the pre-sidestep seat grazed the neighbour. The sidestep
    // tier steps the box horizontally away from the foreign leg toward the own
    // leg's free side until the box clears the foreign leg.
    //
    // RE-PINNED at gap 80 (was 16) when the sidestep took the counter-scale-1
    // containment bound (Task 6b, ruling R12): a stroke at gap g leaves the box
    // only past offset halfW - g, so at g = 16 the step needed is 104 against a
    // reach of 60 and no step sheds it any more -- the companion test below pins
    // exactly that. At g = 80 the shed costs 40, inside the bound, so the tier
    // still does the work this fixture was written for.
    const ownVertical = {
      pts: [[0, 0], [0, 1000]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 0,
      anchorY: 500,
    };
    const foreignVertical: EdgeSegments = {
      id: "foreign",
      flowKey: "foreign",
      target: "elsewhere",
      segs: [[80, -1000, 80, 2000]],
    };
    const field = makeClearanceField([foreignVertical], []);
    const seat = seatRateChip(field, ownVertical, "own", "t", NO_EXEMPT, NO_BAND);
    const cx = ownVertical.anchorX + seat.dx;
    // The seated box no longer overlaps the foreign leg at x=80: a wide box needs
    // a full half-width of centre separation to clear a vertical line.
    expect(Math.abs(cx - 80)).toBeGreaterThanOrEqual(HALF_W);
    // Escaped toward the free side (left, away from the foreign leg at +80).
    expect(seat.dx).toBeLessThan(0);
    // The own leg (x=0) still lies within the box the chip PAINTS, so the chip
    // reads as bound to it -- the step stays within the containment bound, half
    // the reserved half-width.
    expect(Math.abs(seat.dx)).toBeLessThanOrEqual(HALF_W / 2);
    // A pure horizontal escape: no vertical move off the anchor.
    expect(seat.dy).toBe(0);
    expect(seat.tier).toBe("sidestep");
  });

  it("declines the step when shedding the foreign vertical would leave the painted box", () => {
    // The other side of the bound above, and the cost R12 accepted: the same
    // twin corridors at the 16-unit gap the issue-#28 fixture was written at.
    // Shedding a stroke that close needs an offset of 104 while the reach is 60,
    // so no step is fully clear and the chip stays ON its own line in the graze
    // tier rather than floating a full half-width off it at reading zoom.
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
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("still grazes (stays on the line) when the foreign line is parallel to the own line", () => {
    // A HORIZONTAL foreign line parallel to a horizontal own line (issue #9): no
    // horizontal step can clear it (it spans every x at that y), so the sidestep
    // finds nothing and the chip stays ON its own line via the graze tier rather
    // than flying off. Guards that the sidestep never regresses the #9 fix.
    const field = makeClearanceField([PARALLEL_FOREIGN], []);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
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
      // RE-PINNED (with the trunk below) when the sidestep took the
      // counter-scale-1 containment bound (Task 6b, ruling R12): the old
      // geometry needed a step of 60 out of a reach of 120, and the shed landed
      // exactly ON the clip test's boundary once the reach became 60. Shifted
      // right by 15 with the trunk, so the flush step at the bound sheds the
      // stroke by 5 units of real clearance and the fixture still tests
      // trunk-aware foreignness rather than the clip's edge case.
      segs: [[225, -1000, 225, 1000]],
    };
    const field = makeClearanceField([member, direct], []);
    const trunk = {
      pts: [[110, 0], [210, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 160,
      anchorY: 0,
    };
    const seat = seatRateChip(field, trunk, "trunk", "t", NO_EXEMPT, NO_BAND, {
      ownIds: new Set(["m"]),
    });
    // Stepped off the direct edge's vertical (x=225): a wide box needs a full
    // half-width of centre separation to clear it.
    const cx = trunk.anchorX + seat.dx;
    expect(Math.abs(cx - 225)).toBeGreaterThanOrEqual(HALF_W);
    // Still inside the box it paints, purely horizontal.
    expect(Math.abs(seat.dx)).toBeLessThanOrEqual(HALF_W / 2);
    expect(seat.dy).toBe(0);
    expect(seat.tier).toBe("sidestep");
  });
});

describe("seatRateChip: junction-dot keep-off (#50)", () => {
  it("slides along its own line off a dot its anchor box would swallow", () => {
    // The fan-in case in miniature: nothing blocks the anchor, but a junction
    // dot sits right under it, and a chip paints over the dot (z-order), so the
    // merge marker is simply deleted. The seat must walk its own line until the
    // box no longer covers the dot -- a wide box needs more than a half-width of
    // centre separation to stop covering a point.
    const field = makeClearanceField([], [], [{ x: 500, y: 0, kind: "fanin" }]);
    const seat = seatRateChip(field, LINE, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat.tier).toBe("slide");
    // Still on its own line: the keep-off never trades the line for a dot.
    expect(seat.dy).toBe(0);
    expect(Math.abs(seat.dx)).toBeGreaterThan(HALF_W);
  });

  it("keeps its fully clear anchor when no on-line seat clears the dot", () => {
    // The keep-off is a PREFERENCE, not a hard invariant: on a short line every
    // candidate box swallows the dot, and leaving the line (or grazing) to save
    // a decorative marker would be the worse defect. The seat stays exactly
    // where it sits today.
    const field = makeClearanceField([], [], [{ x: 500, y: 0, kind: "fanin" }]);
    const seat = seatRateChip(
      field,
      { pts: [[440, 0], [560, 0]], anchorX: 500, anchorY: 0 },
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "anchor" });
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
    field.seat({ x: 0, y: 384, halfW: HALF_W, halfH: HALF_H });
    // Foreign lane chip covering [408, 640]: blocks the anchor and below it.
    field.seat({ x: 0, y: 524, halfW: HALF_W, halfH: 116 });
    const seat = seatRateChip(field, leg, "own", "t", NO_EXEMPT, NO_BAND, {
      barrierYs: [384],
    });
    // Seats BELOW the sibling (y > 384): monotonic top-to-bottom order kept, no
    // crossing above it.
    expect(leg.anchorY + seat.dy).toBeGreaterThan(384);
  });
});

describe("seatRateChip: own-line binding and the scored sidestep (Z2 braids)", () => {
  // A vertical own leg, long enough that the slide has real reach, with the
  // anchor at its middle. Every seat on it holds x = 0, which is what makes a
  // parallel neighbour unshakeable by any on-line motion.
  const OWN_LEG = {
    pts: [[0, 0], [0, 1000]] as ReadonlyArray<readonly [number, number]>,
    anchorX: 0,
    anchorY: 500,
  };
  const vertical = (id: string, x: number): EdgeSegments => ({
    id,
    flowKey: id,
    target: "elsewhere",
    segs: [[x, -100, x, 1100]],
  });

  it("prefers a crossing stroke over one braided with the own line", () => {
    // Both halves of a horizontal own line graze exactly one foreign stroke, so
    // the crossing count cannot separate them and neither can the card or dot
    // terms. What differs is WHERE the stroke runs: on the left it lies 4 units
    // off the own line and reads as the chip's own lane; on the right it cuts
    // across the box 20 units above, which no reader mistakes for the flow the
    // chip labels. The seat walks the length of the line to trade one for the
    // other.
    const field = makeClearanceField(
      [
        // Braided: coincident with the own line out to x = 600.
        { id: "braid", flowKey: "a", target: "other", segs: [[-2000, 4, 600, 4]] },
        // Crossing: inside the box (half-height 24) but clear of the own line.
        { id: "over", flowKey: "b", target: "other", segs: [[600, 20, 2000, 20]] },
      ],
      [],
    );
    // The own line runs well past the slide's whole reach in both directions:
    // a foreign window that hangs off the END of the own polyline is not
    // braided with it (there is no own stroke there to confuse it with), and a
    // short own line would score that as the win instead of the real one.
    const seat = seatRateChip(
      field,
      { pts: [[-1200, 0], [1800, 0]], anchorX: 300, anchorY: 0 },
      "own",
      "T",
      NO_EXEMPT,
      NO_BAND,
    );
    // The first candidate whose box has left the braid's reach (x = 600).
    expect(seat).toMatchObject({ dx: 432, dy: 0, tier: "graze" });
  });

  it("steps off the line to shed a crossing when a braid pins the on-line seat", () => {
    // A vertical leg with two foreign verticals in the box: one braided 5 units
    // off it, one crossing 75 units off. No on-line seat and no fully clear step
    // exists, so the graze tier owns the seat -- and its braid is what licenses
    // the second, scored pass over the horizontal steps. The step that sheds the
    // distant stroke is the THIRD one out, not the first: the nearer two change
    // nothing, and a first-hit walk would never reach it.
    const field = makeClearanceField([vertical("braid", 5), vertical("wide", -75)], []);
    const seat = seatRateChip(field, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toMatchObject({ dx: 48, dy: 0, tier: "sidestep" });
  });

  it("stays on the line when the same two strokes are not braided with it", () => {
    // The gate, and nothing else, changed: the near vertical moves from 5 units
    // off the own line to 40, so no stroke in the box is braided with it and the
    // scored pass is never run. Same two crossings, same reachable steps, same
    // arithmetic -- the seat stays on its own line at the anchor.
    const field = makeClearanceField([vertical("apart", 40), vertical("wide", -75)], []);
    const seat = seatRateChip(field, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("will not step past half the reach even when the far step scores better", () => {
    // Same braid, but the crossing stroke sits 40 units off the line, so shedding
    // it needs a step of 80 -- two thirds of the reserved half-width. The
    // reserved box is a worst case and the chip paints a narrower one, so a step
    // that far holds the own line inside the reserve and outside the paint: the
    // chip would read as an orphan beside its line. The scored pass declines it
    // and the seat stays on the line, grazing both.
    const field = makeClearanceField([vertical("braid", 5), vertical("mid", -40)], []);
    const seat = seatRateChip(field, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("does not read a stroke that only nicks the own line as a braid", () => {
    // The run-length half of the braid rule. A six-unit foreign stub sits three
    // units off the own line -- close enough by distance alone -- but nothing
    // that short is a lane the reader could mistake for the chip's own, and no
    // horizontal step can shed it anyway. So it must not license the scored
    // pass: the seat stays on its line, grazing both strokes, where dropping
    // the length test steps it 48 units off to shed the far one.
    const field = makeClearanceField(
      [
        { id: "nick", flowKey: "a", target: "other", segs: [[260, -3, 260, 3]] },
        { id: "far", flowKey: "b", target: "other", segs: [[185, -500, 185, 500]] },
      ],
      [],
    );
    const seat = seatRateChip(
      field,
      { pts: [[240, 0], [280, 0]], anchorX: 260, anchorY: 0 },
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("does not read a stroke that meets the own line and turns away as a braid", () => {
    // The BOTH-ends half of the braid rule, which the nick fixture above cannot
    // reach because its window is too short to be scored at all. Here the
    // foreign stroke arrives along the corridor, touches the own leg, and peels
    // off across the box: its window is long enough to score and ONE of its ends
    // is 4 units from the own line, but the other is 100 units away, so the
    // reader sees a stroke leaving, not a second lane under the chip. That is
    // exactly the shape every transverse crossing has -- a stroke crossing the
    // box leaves the own line by the half-height at its ends -- so relaxing the
    // rule to either-end would make the braid term a near-copy of the crossing
    // count and fire the gate almost everywhere.
    //
    // A 40-unit own leg leaves exactly one on-line candidate, and no step out to
    // the full reach clears every stroke, so the graze tier owns the seat. With
    // the gate correctly shut it stays at the anchor; read as a braid, the
    // scored pass would step it 48 units off the line to shed the far vertical.
    const field = makeClearanceField(
      [
        {
          id: "peel",
          flowKey: "a",
          target: "other",
          segs: [
            // Approach: only its last 4 units are inside the box.
            [-200, 300, 4, 480],
            // Turn-away: wholly inside the box, one end on the leg, one across it.
            [4, 480, 100, 520],
          ],
        },
        // The crossing a step of 48 would shed, if the gate ever opened.
        { id: "wide", flowKey: "b", target: "other", segs: [[-75, -100, -75, 1100]] },
      ],
      [],
    );
    const seat = seatRateChip(
      field,
      { pts: [[0, 480], [0, 520]], anchorX: 0, anchorY: 500 },
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 0, dy: 0, tier: "graze" });
  });

  it("steps to the offset that sheds the most, not to the first that sheds any", () => {
    // The scored pass keeps the BEST reachable offset. Two crossings sit at
    // different depths in the box: the first step out (16) sheds the shallower
    // one, and only the third (48, the last inside the half-reach cap) sheds
    // both. A walk that stopped at the first strictly better offset would seat
    // the chip at 16, still straddling a stroke it could have left behind.
    const field = makeClearanceField(
      [
        vertical("braid", 5),
        // Just past the box edge after one step out.
        vertical("shallow", -110),
        // Still inside the box until the third step.
        vertical("deep", -80),
      ],
      [],
    );
    const seat = seatRateChip(field, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    expect(seat).toMatchObject({ dx: 48, dy: 0, tier: "sidestep" });
  });

  it("scores the fully clear step by own-card depth, not by nearness", () => {
    // The hole the sidestep used to have: it took the first step that cleared
    // everything, so it could park a box on the chip's OWN card that the slide
    // above it walks its whole line to avoid. Here a short leg leaves exactly
    // one on-line candidate and a foreign stroke poisons it; three steps out are
    // clear, and the nearer ones lap the source card past the port strip while
    // the third clears it.
    //
    // RE-PINNED from the 112 step to the 48 one when this tier took the
    // counter-scale-1 containment bound (Task 6b, ruling R12), which caps the
    // reach at 60. The card and the cutting stroke moved left with it so the
    // fixture keeps its shape: the first clear step still laps the card (25
    // deep), the second still laps it (9 deep, the budget), and the third is off
    // it -- so a first-hit walk would still seat at 16 and this test still kills
    // that mutation.
    const card: CardRect = { id: "S", left: -400, right: -70, top: 470, bottom: 530 };
    const field = makeClearanceField(
      [
        {
          id: "cut",
          flowKey: "a",
          target: "other",
          segs: [[-1000, 500, -110, 500]],
        },
      ],
      [card],
    );
    const seat = seatRateChip(
      field,
      { pts: [[0, 480], [0, 520]], anchorX: 0, anchorY: 500 },
      "own",
      "t",
      portZone("S", "source"),
      NO_BAND,
    );
    expect(seat).toMatchObject({ dx: 48, dy: 0, tier: "sidestep" });
    expect(
      chipOwnCardIntrusion(seatedBox(0, 500, seat), card),
    ).toBe(0);
  });

  it("seats the same chip identically whatever order the obstacles arrive in", () => {
    // Every term the scorers use is a count or a distance over the whole
    // obstacle set, so the seat may not depend on the order the segments were
    // collected in. Same field, members reversed.
    const forward = makeClearanceField(
      [vertical("braid", 5), vertical("wide", -75), vertical("far", 300)],
      [],
    );
    const backward = makeClearanceField(
      [vertical("far", 300), vertical("wide", -75), vertical("braid", 5)],
      [],
    );
    const a = seatRateChip(forward, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    const b = seatRateChip(backward, OWN_LEG, "own", "t", NO_EXEMPT, NO_BAND);
    expect(a).toEqual(b);
    // ...and twice through the same field state, which is the plain
    // reproducibility half of the same property.
    const again = seatRateChip(
      makeClearanceField([vertical("braid", 5), vertical("wide", -75), vertical("far", 300)], []),
      OWN_LEG,
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(again).toEqual(a);
  });
});

// Per-chip seat box (Task 6b): the seat reserves an upper bound on what the chip
// will DRAW instead of the widest box the CSS clamp allows. Everything below is
// arithmetic over the exported estimator plus one seat the narrowing frees.
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

  it("seats a chip in a corridor the worst-case box could not fit", () => {
    // Two foreign verticals 210 units apart, walling in a 200-unit horizontal
    // own line. The 240-wide worst-case box cannot sit between them anywhere:
    // it needs 120 of clearance either side and only 105 exists, so every
    // on-line candidate crosses a stroke, no sidestep inside the containment
    // bound helps, and the seat is a graze at the anchor. A chip drawing
    // "30/270" reserves 166, half of which is 83 -- it fits, so the same seat is
    // fully clear and stays a tier-1 anchor.
    const wall = (x: number): EdgeSegments => ({
      id: `w${x}`,
      flowKey: "foreign",
      target: "elsewhere",
      segs: [[x, -1000, x, 1000]],
    });
    const walls = [wall(395), wall(605)];
    const line = {
      pts: [[400, 0], [600, 0]] as ReadonlyArray<readonly [number, number]>,
      anchorX: 500,
      anchorY: 0,
    };
    const wide = seatRateChip(
      makeClearanceField(walls, []),
      line,
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
    );
    expect(wide.tier).toBe("graze");

    const narrow = seatRateChip(
      makeClearanceField(walls, []),
      line,
      "own",
      "t",
      NO_EXEMPT,
      NO_BAND,
      { text: { body: "30/270", unit: false } },
    );
    expect(narrow).toMatchObject({ dx: 0, dy: 0, tier: "anchor" });
  });
});
