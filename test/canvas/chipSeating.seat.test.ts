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
