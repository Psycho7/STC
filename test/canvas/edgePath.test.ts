// Pure-geometry tests for the chamfered edge-path builder. Coordinates are
// chosen so the emitted `d` strings are exact and human-checkable. The final
// segment of every path must be a rightward horizontal so the ArrowClosed
// marker (orient=auto) points right into the target's Left handle.

import { describe, it, expect } from "vitest";

import {
  chamferStepPath,
  chamferBusPath,
  chamferFanoutPath,
  pathPointAt,
  routingHintsFromData,
  PORT_STUB,
  CHAMFER,
  MAX_CHAMFER,
} from "../../src/canvas/edgePath";
import {
  parsePoints,
  expectRightwardFinish,
  distanceToPolyline,
} from "./pathAssertions";

describe("pathPointAt", () => {
  // Two segments of length 10 (horizontal) then 30 (vertical); total 40. The
  // chip-slide pass reads off-midpoint fractions to move a blocked label along
  // its own line, so the interpolation must be exact and clamp out of range.
  const D = "M 0,0 L 10,0 L 10,30";
  it("returns the first vertex at frac 0", () => {
    expect(pathPointAt(D, 0)).toEqual([0, 0]);
  });
  it("lands exactly on the shared vertex when the fraction hits a seg boundary", () => {
    // 0.25 of 40 = 10 = the whole first segment, so the point is the corner.
    expect(pathPointAt(D, 0.25)).toEqual([10, 0]);
  });
  it("interpolates within the covering segment", () => {
    // 0.5 of 40 = 20; 10 covers the first segment, the remaining 10 runs 10
    // down the 30-long vertical: (10, 10).
    expect(pathPointAt(D, 0.5)).toEqual([10, 10]);
  });
  it("clamps a fraction past 1 to the final vertex", () => {
    expect(pathPointAt(D, 2)).toEqual([10, 30]);
  });
  it("clamps a negative fraction to the first vertex", () => {
    expect(pathPointAt(D, -1)).toEqual([0, 0]);
  });
});

describe("chamferStepPath", () => {
  it("draws a plain straight line when the endpoints share a y", () => {
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 50,
      targetX: 200,
      targetY: 50,
    });
    expect(d).toBe("M 0,50 L 200,50");
    expect(lx).toBe(100);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
  });

  it("draws a forward step with chamfered corners at the default midpoint bend", () => {
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
    });
    expect(d).toBe("M 0,0 L 92,0 L 100,8 L 100,92 L 108,100 L 200,100");
    expect(lx).toBe(100);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
    // Bend column sits inside the corridor margins.
    expect(lx).toBeGreaterThan(PORT_STUB + CHAMFER);
    expect(lx).toBeLessThan(200 - PORT_STUB - CHAMFER);
  });

  it("honors an explicit bendX inside the corridor", () => {
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 60,
    });
    expect(d).toBe("M 0,0 L 52,0 L 60,8 L 60,92 L 68,100 L 200,100");
    // Clear-segment anchor: the bend-column vertical (x = bendX = 60) at its run
    // midpoint y = (sourceY + targetY) / 2 = 50, on the segment 60,8 -> 60,92.
    expect(lx).toBe(60);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
  });

  it("anchors the label on the bend-column vertical even when the bend is early", () => {
    // bendX 100 pushes the bend far left of the 600-wide corridor, so the old
    // geometric midpoint drifted onto the long target-side horizontal rail
    // (crossing card rows). The clear-segment anchor stays on the bend vertical
    // (x = 100) at its run midpoint y = (0 + 40) / 2 = 20, on 100,8 -> 100,32.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 600,
      targetY: 40,
      bendX: 100,
    });
    expect(d).toBe("M 0,0 L 92,0 L 100,8 L 100,32 L 108,40 L 600,40");
    expect(lx).toBe(100);
    expect(ly).toBe(20);
    expectRightwardFinish(d);
  });

  it("joins the rails with a single diagonal when dy is small", () => {
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 10,
    });
    // No vertical segment: horizontal, diagonal, horizontal into target.
    expect(d).toBe("M 0,0 L 92,0 L 108,10 L 200,10");
    expect(lx).toBe(100);
    expect(ly).toBe(5);
    expectRightwardFinish(d);
  });

  it("keeps the label anchor continuous across the small-dy branch boundary", () => {
    // The forward step flips between the diagonal (small-dy) and the full
    // vertical-run shape at |dy| = 2 * chamfer. Live handle coordinates and the
    // seating pass's offline port model can disagree by a pixel, so a dy that
    // straddles the boundary must not teleport the anchor: the render applies
    // the seat's labelDx/labelDy to ITS anchor, and an anchor jump of hundreds
    // of units strands the chip inside a card (the food-tundra 30/min defect).
    // Both sides of the boundary anchor on the bend column at the y midpoint --
    // the diagonal's own midpoint, so the anchor stays on the path.
    const base = {
      sourceX: 0,
      sourceY: 0,
      targetX: 600,
      bendX: 60,
    };
    const [, atX, atY] = chamferStepPath({ ...base, targetY: 2 * CHAMFER });
    const [, pastX, pastY] = chamferStepPath({
      ...base,
      targetY: 2 * CHAMFER + 1,
    });
    expect(atX).toBe(60);
    expect(atY).toBe(CHAMFER);
    expect(pastX).toBe(60);
    expect(pastY).toBe(CHAMFER + 0.5);
  });

  it("anchors a same-rail straight line on the bend column", () => {
    // The same continuity across the sy === ty boundary: a one-pixel port-model
    // disagreement flips between the straight line and the small-dy diagonal,
    // so the straight line anchors at the bend column too (on the line by
    // construction), not the geometric midpoint.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 50,
      targetX: 600,
      targetY: 50,
      bendX: 60,
    });
    expect(d).toBe("M 0,50 L 600,50");
    expect(lx).toBe(60);
    expect(ly).toBe(50);
  });

  it("keeps the backward anchor continuous across the apex-rail boundary", () => {
    // Backward mirror of the small-dy continuity: within 2 * CHAMFER of the
    // source level the rail collapses to a single apex bevel. The anchor stays
    // on the rail's horizontal run (labelX = xr - CHAMFER - PORT_STUB = 200 -
    // CHAMFER, at railY), shared with the full rail's anchor rule, so it does not
    // teleport across the branch boundary: x is identical and y tracks railY.
    const [, atX, atY] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      railY: 2 * CHAMFER,
    });
    const [, pastX, pastY] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      railY: 2 * CHAMFER + 1,
    });
    expect(atX).toBe(200 - CHAMFER);
    expect(atY).toBe(2 * CHAMFER);
    expect(pastX).toBe(200 - CHAMFER);
    expect(pastY).toBe(2 * CHAMFER + 1);
  });

  it("degrades symmetrically in a narrow gap, scaling stub and chamfer", () => {
    // gap 32 = half the full budget (2*(24+8)=64), so scale = 0.5: stub 12,
    // chamfer 4, bend forced to the midpoint (the scaled range collapses).
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 32,
      targetY: 100,
    });
    expect(d).toBe("M 0,0 L 12,0 L 16,4 L 16,96 L 20,100 L 32,100");
    expect(lx).toBe(16);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
  });

  it("routes a backward edge through a leftward detour rail", () => {
    const [d, lx, ly] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
    });
    expect(d).toBe(
      "M 200,0 L 216,0 L 224,8 L 224,42 L 216,50 L -16,50 L -24,58 L -24,92 L -16,100 L 0,100",
    );
    // Clear-segment anchor: the rail's horizontal run (at railY = 50), one stub
    // in from the source-side corner (xr - CHAMFER = 216), so labelX = 216 -
    // PORT_STUB = 192, on the segment 216,50 -> -16,50.
    expect(lx).toBe(192);
    expect(ly).toBe(50);
    expect(Number.isFinite(lx)).toBe(true);
    expect(Number.isFinite(ly)).toBe(true);
    expectRightwardFinish(d);
  });

  it("routes a backward edge's left rail through an explicit entryX gutter column", () => {
    // The entry-gutter pass stakes out the left rail at a staggered column so two
    // backward rails into one node do not overlap. entryX = -40 moves the rail
    // one slot left of the default (tx - PORT_STUB = -24); the run still enters
    // the target with a final rightward stub.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      entryX: -40,
    });
    expect(d).toBe(
      "M 200,0 L 216,0 L 224,8 L 224,42 L 216,50 L -32,50 L -40,58 L -40,92 L -32,100 L 0,100",
    );
    // Clear-segment anchor: the rail's horizontal run, source side. entryX only
    // moves the LEFT rail column (the run's target-side end), so the source-side
    // anchor is unchanged from the no-hint case: (192, 50).
    expect(lx).toBe(192);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
  });

  it("routes a backward edge's verticals through explicit railXRight/railXLeft columns", () => {
    // clampBackwardRails moves the two backward verticals clear of a foreign card
    // or gutter. railXRight relocates the source-side column (default sx+PORT_STUB
    // = 224) and railXLeft the target-side column (default tx-PORT_STUB = -24);
    // both branches of chamferColumn keep their single-side entry/exit.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      railXRight: 250,
      railXLeft: -50,
    });
    expect(d).toBe(
      "M 200,0 L 242,0 L 250,8 L 250,42 L 242,50 L -42,50 L -50,58 L -50,92 L -42,100 L 0,100",
    );
    expect(Number.isFinite(lx)).toBe(true);
    expect(Number.isFinite(ly)).toBe(true);
    expectRightwardFinish(d);
  });

  it("lets railXLeft override the entryX stagger on a backward edge", () => {
    // When both hints are present the obstacle-cleared railXLeft wins, so the
    // left column lands at -50, not the entryX stagger.
    const [withBoth] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      entryX: -40,
      railXLeft: -50,
    });
    const [onlyRail] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      railXLeft: -50,
    });
    expect(withBoth).toBe(onlyRail);
  });

  it("is byte-identical to the no-hints backward path when railX hints are absent", () => {
    const [base] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
    });
    // Mirrors the render path: data carrying no railX hints spreads to nothing.
    const [threaded] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 100,
      ...routingHintsFromData({ item: "w" }),
    });
    expect(threaded).toBe(base);
    expect(base).toBe(
      "M 200,0 L 216,0 L 224,8 L 224,42 L 216,50 L -16,50 L -24,58 L -24,92 L -16,100 L 0,100",
    );
  });

  it("jogs the forward final leg to a clear legY, descending in the target gutter", () => {
    // legY moves the long horizontal off the target y so it clears an
    // intervening card: bend down to legY at the bend column, run the horizontal
    // there, then descend at descentX (tx - PORT_STUB = 276) into the target.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 100,
      legY: 200,
    });
    expect(d).toBe(
      "M 0,0 L 142,0 L 150,8 L 150,192 L 158,200 L 268,200 L 276,192 L 276,108 L 284,100 L 300,100",
    );
    expect(Number.isFinite(lx)).toBe(true);
    expect(Number.isFinite(ly)).toBe(true);
    expectRightwardFinish(d);
  });

  it("routes the forward jog's descent through an explicit entryX gutter column", () => {
    // entryX overrides the default descent column (tx - PORT_STUB), so the run
    // descends at 250 instead of 276; the bend column and legY are unchanged.
    const [d] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 100,
      legY: 200,
      entryX: 250,
    });
    expect(d).toBe(
      "M 0,0 L 142,0 L 150,8 L 150,192 L 158,200 L 242,200 L 250,192 L 250,108 L 258,100 L 300,100",
    );
    expectRightwardFinish(d);
  });

  it("is byte-identical to the no-hints forward step when legY is absent", () => {
    const [base] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
    });
    // Mirrors the render path: data carrying no legY hint spreads to nothing.
    const [threaded] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      ...routingHintsFromData({ item: "w" }),
    });
    expect(threaded).toBe(base);
    expect(base).toBe("M 0,0 L 92,0 L 100,8 L 100,92 L 108,100 L 200,100");
  });

  it("does not backtrack on a backward edge with a small |dy| (< 4*CHAMFER)", () => {
    // |ty - sy| = 20 < 32 (= 4*CHAMFER): the detour rail sits within a chamfer
    // of the source level, so the old full-chamfer columns would invert into a
    // zigzag spike. Each column must collapse to a monotonic apex bevel.
    const [d] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 20,
    });
    const pts = parsePoints(d);
    // Right column (source stub out to the rail) and left column (rail down to
    // target), each three points; y must be monotonic across each (no spike).
    const isMonotonic = (ys: number[]) =>
      ys.every((y, i) => i === 0 || y >= ys[i - 1]!) ||
      ys.every((y, i) => i === 0 || y <= ys[i - 1]!);
    const rightCol = pts.slice(1, 4).map((p) => p.y); // sy, apex, railY
    const leftCol = pts.slice(4, 7).map((p) => p.y); // railY, apex, ty
    expect(isMonotonic(rightCol)).toBe(true);
    expect(isMonotonic(leftCol)).toBe(true);
    expectRightwardFinish(d);
  });

  it("replaces the bend column with srcColX and anchors on that vertical", () => {
    // srcColX (jogForwardLegs, blocked source leg) replaces the bend column
    // outright. The forward step leaves sy at srcColX = 40, and the clear
    // segment anchor rides that vertical at its run midpoint (0 + 100) / 2 = 50.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      srcColX: 40,
    });
    expect(d).toBe("M 0,0 L 32,0 L 40,8 L 40,92 L 48,100 L 200,100");
    expect(lx).toBe(40);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
  });

  it("grows the forward chamfers toward MAX_CHAMFER when a budget allows", () => {
    // Wide corridor, generous budget: shorter adjacent leg is 100 (all three
    // legs), half = 50, so the cap binds at MAX_CHAMFER = 24. The corners
    // fatten from the base 8 to 24 while the bend column (x = 100) is unmoved.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 100,
      chamferBudget: 24,
    });
    expect(d).toBe("M 0,0 L 76,0 L 100,24 L 100,76 L 124,100 L 200,100");
    // Anchor still on the bend-column vertical run midpoint.
    expect(lx).toBe(100);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
    // Each bevel leg equals MAX_CHAMFER, not the base CHAMFER.
    const pts = parsePoints(d);
    expect(pts[1]!.x).toBe(100 - MAX_CHAMFER);
  });

  it("caps the chamfer at half the shorter adjacent leg", () => {
    // Early bend (bendX = 40) makes the source-side horizontal leg (bx - sx = 40)
    // the shortest of the three legs, so the cap is 40 / 2 = 20 -- below both
    // MAX_CHAMFER (24) and the budget (24). The vertical run (100) stays, so the
    // column keeps its bevels rather than collapsing.
    const [d] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 40,
      chamferBudget: 24,
    });
    expect(d).toBe("M 0,0 L 20,0 L 40,20 L 40,80 L 60,100 L 200,100");
    expectRightwardFinish(d);
  });

  it("never exceeds the stamped budget, even below the base chamfer", () => {
    // A tight sibling budget (6) caps the chamfer under the base CHAMFER (8): a
    // dense corridor legitimately draws SMALLER bevels so a bend never reaches
    // its neighbour's column.
    const [d] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 100,
      chamferBudget: 6,
    });
    expect(d).toBe("M 0,0 L 94,0 L 100,6 L 100,94 L 106,100 L 200,100");
    expectRightwardFinish(d);
  });

  it("is byte-identical to the no-budget forward step when chamferBudget is absent", () => {
    const [base] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 100,
    });
    // Mirrors the render path: data carrying no chamferBudget spreads to nothing.
    const [threaded] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 100,
      ...routingHintsFromData({ item: "w", bendX: 100 }),
    });
    expect(threaded).toBe(base);
    expect(base).toBe("M 0,0 L 92,0 L 100,8 L 100,92 L 108,100 L 200,100");
  });

  it("ignores the chamfer budget on a jogged source column (srcColX)", () => {
    // srcColX carries only a CHAMFER of jog clearance, so the budget's
    // sibling-envelope invariant (proven for the stagger column at bendX) does
    // not hold there. With both srcColX and chamferBudget stamped the step must
    // keep the base CHAMFER, byte-identical to the no-budget srcColX path.
    const [d] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      srcColX: 40,
      chamferBudget: 24,
    });
    expect(d).toBe("M 0,0 L 32,0 L 40,8 L 40,92 L 48,100 L 200,100");
    expectRightwardFinish(d);
  });

  it("uses srcColX UNCLAMPED, past the corridor margin", () => {
    // The default bend clamps to [sx+stub+chamfer, tx-stub-chamfer] = [32, 168].
    // srcColX = 10 sits left of that margin; the routing pass proved it clear, so
    // it must be used as-is, not clamped back to 32. The bend vertical (and its
    // anchor) land at x = 10.
    const [d, lx] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      srcColX: 10,
    });
    expect(d).toBe("M 0,0 L 2,0 L 10,8 L 10,92 L 18,100 L 200,100");
    expect(lx).toBe(10);
    expectRightwardFinish(d);
  });
});

describe("chamferBusPath", () => {
  it("exits horizontally, dives to the lane, and rises into the target", () => {
    const { path, dropX, riseX, junction } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
    });
    expect(path).toBe(
      "M 0,0 L 24,0 L 32,8 L 32,192 L 40,200 L 260,200 L 268,192 L 268,28 L 276,20 L 300,20",
    );
    expect(dropX).toBe(32);
    expect(riseX).toBe(268);
    // Junction sits on the lane just before the rise chamfer.
    expect(junction).toEqual({ x: 260, y: 200 });
    expectRightwardFinish(path);
  });

  it("mirrors the shape when the lane sits ABOVE both endpoints (top band)", () => {
    // Two-sided lane bands (9B): a top-band trunk's lane runs above the graph,
    // so the "drop" is geometrically a RISE and the "rise" a descent.
    // chamferColumn derives each vertical's direction from its own y0 -> y1, so
    // the same builder must emit a sane mirrored shape with no negative-length
    // segments. The pin proves the mirror: the first column's ys DECREASE
    // (500 -> 492 -> 108 -> 100, source level UP to the lane) and the second's
    // INCREASE (100 -> 108 -> 472 -> 480, lane DOWN to the target), with the
    // 8px chamfer bevels intact on both columns.
    const { path, dropX, riseX, junction } = chamferBusPath({
      sourceX: 0,
      sourceY: 500,
      targetX: 300,
      targetY: 480,
      laneY: 100,
    });
    expect(path).toBe(
      "M 0,500 L 24,500 L 32,492 L 32,108 L 40,100 L 260,100 L 268,108 L 268,472 L 276,480 L 300,480",
    );
    // Columns sit at the same default x as the lane-below case; the junction
    // tracks the lane just before the descent chamfer.
    expect(dropX).toBe(32);
    expect(riseX).toBe(268);
    expect(junction).toEqual({ x: 260, y: 100 });
    // Structural sanity on the parsed points: no NaN, the first (drop) column's
    // vertical run goes UP toward the lane and the second (rise) column's goes
    // DOWN toward the target.
    const pts = parsePoints(path);
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    const dropRun = [pts[1]!, pts[2]!, pts[3]!, pts[4]!].map((p) => p.y);
    const riseRun = [pts[5]!, pts[6]!, pts[7]!, pts[8]!].map((p) => p.y);
    expect(dropRun.every((y, i) => i === 0 || y < dropRun[i - 1]!)).toBe(true);
    expect(riseRun.every((y, i) => i === 0 || y > riseRun[i - 1]!)).toBe(true);
    expectRightwardFinish(path);
  });

  it("rises through an explicit entryX gutter column on a wide forward gap", () => {
    // The entry-gutter pass may stagger the rise so two rises into one node do
    // not coincide. entryX = 250 moves the rise right of the default
    // (tx - PORT_STUB - CHAMFER = 268); drop, lane run, and final rightward stub
    // are otherwise unchanged and the junction tracks the moved rise.
    const { path, dropX, riseX, junction } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
      entryX: 250,
    });
    expect(path).toBe(
      "M 0,0 L 24,0 L 32,8 L 32,192 L 40,200 L 242,200 L 250,192 L 250,28 L 258,20 L 300,20",
    );
    expect(dropX).toBe(32);
    expect(riseX).toBe(250);
    expect(junction).toEqual({ x: 242, y: 200 });
    expectRightwardFinish(path);
  });

  it("drops through an explicit dropX column on a wide forward gap", () => {
    // clearBusColumns moves the drop vertical clear of a foreign card. dropX = 50
    // relocates the drop column left of the default (sx+PORT_STUB+CHAMFER = 32);
    // the lane run, rise column, and final stub are otherwise unchanged.
    const { path, dropX, riseX } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
      dropX: 50,
    });
    expect(path).toBe(
      "M 0,0 L 42,0 L 50,8 L 50,192 L 58,200 L 260,200 L 268,192 L 268,28 L 276,20 L 300,20",
    );
    expect(dropX).toBe(50);
    expect(riseX).toBe(268);
    expectRightwardFinish(path);
  });

  it("lets riseX override the entryX stagger on a wide forward gap", () => {
    // riseX (obstacle-cleared) wins over entryX (stagger), so the rise column
    // lands at 250 regardless of the entryX hint.
    const { path: withBoth } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
      entryX: 999,
      riseX: 250,
    });
    const { path: onlyRise } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
      riseX: 250,
    });
    expect(withBoth).toBe(onlyRise);
    expect(withBoth).toBe(
      "M 0,0 L 24,0 L 32,8 L 32,192 L 40,200 L 242,200 L 250,192 L 250,28 L 258,20 L 300,20",
    );
  });

  it("is byte-identical to the no-hints bus path when drop/rise hints are absent", () => {
    const base = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
    });
    // Mirrors the render path: data carrying no drop/rise hints spreads to nothing.
    const threaded = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 20,
      laneY: 200,
      ...routingHintsFromData({ item: "w" }),
    });
    expect(threaded.path).toBe(base.path);
    expect(base.path).toBe(
      "M 0,0 L 24,0 L 32,8 L 32,192 L 40,200 L 260,200 L 268,192 L 268,28 L 276,20 L 300,20",
    );
  });

  it("stays sane when targetY is below the lane (laneY-missing fallback)", () => {
    // laneY === targetY mimics the fallback BusEdge uses when laneY is missing.
    const { path } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 100,
      laneY: 100,
    });
    // No throw, no NaN, and still finishes rightward into the target.
    expect(path).not.toMatch(/NaN/);
    expectRightwardFinish(path);
  });

  it("routes a backward member (target left of source) through the lane", () => {
    // gap = -200 <= 0: drop one stub+chamfer inside the source, run the lane
    // leftward, rise one stub+chamfer inside the target, finish rightward.
    const { path, dropX, riseX, junction } = chamferBusPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 0,
      targetY: 20,
      laneY: 200,
    });
    expect(path).toBe(
      "M 200,0 L 224,0 L 232,8 L 232,192 L 224,200 L -24,200 L -32,192 L -32,28 L -24,20 L 0,20",
    );
    expect(dropX).toBe(232);
    expect(riseX).toBe(-32);
    expect(riseX).toBeLessThan(dropX); // lane runs leftward
    expect(junction).toEqual({ x: -24, y: 200 });
    expect(path).not.toMatch(/NaN/);
    expectRightwardFinish(path);
  });

  it("collapses drop and rise onto the midpoint in a narrow forward gap", () => {
    // gap 32 < budget 64 (= 2*(24+8)): scale 0.5, chamfer 4. Drop and rise
    // columns land on the corridor midpoint as a hairpin: chamfer in, straight
    // down to the lane apex, straight back up the same column, chamfer out.
    const { path, dropX, riseX, junction } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 32,
      targetY: 20,
      laneY: 200,
    });
    expect(path).toBe("M 0,0 L 12,0 L 16,4 L 16,200 L 16,24 L 20,20 L 32,20");
    expect(dropX).toBe(16);
    expect(riseX).toBe(16); // midpoint collapse
    // Junction dot sits on the actual hairpin apex vertex.
    expect(junction).toEqual({ x: 16, y: 200 });
    expect(path).not.toMatch(/NaN/);
    // No zero-length segments (consecutive identical points) and no zero-area
    // spurs (an immediate A -> B -> A retrace) anywhere in the path.
    const pts = parsePoints(path);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      expect(a.x === b.x && a.y === b.y).toBe(false);
    }
    for (let i = 2; i < pts.length; i++) {
      const a = pts[i - 2]!;
      const c = pts[i]!;
      expect(a.x === c.x && a.y === c.y).toBe(false);
    }
    expectRightwardFinish(path);
  });

  it("draws a flat rise when laneY === targetY (no 16px spike)", () => {
    // The BusEdge laneY-missing fallback sets laneY = targetY. The rise column
    // then has zero height and must collapse to a flat horizontal instead of
    // spiking a chamfer above and below the lane.
    const { path, riseX } = chamferBusPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 100,
      laneY: 100,
    });
    // Every point from the rise column onward (x >= riseX - CHAMFER) sits flat
    // on the lane; y never departs from 100, so there is no spike.
    const riseAndAfter = parsePoints(path).filter(
      (p) => p.x >= riseX - CHAMFER,
    );
    expect(riseAndAfter.length).toBeGreaterThan(1);
    expect(riseAndAfter.every((p) => p.y === 100)).toBe(true);
    expect(path).not.toMatch(/NaN/);
    expectRightwardFinish(path);
  });
});

describe("chamferFanoutPath", () => {
  it("draws trunk, junction, and a chamfered branch leg into the target", () => {
    const { path, junction, trunkAnchor, branchAnchor } = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      junctionX: 100,
    });
    // Trunk horizontal at sy from the source to the junction's incoming chamfer,
    // the branch vertical down the junction column, then the final rightward stub.
    expect(path).toBe("M 0,0 L 92,0 L 100,8 L 100,92 L 108,100 L 200,100");
    // Junction sits at the trunk's end (the last point every member shares
    // before its branch chamfer), ON the drawn polyline. The sharp corner
    // (jx, sy) itself is cut away by the chamfer, so a dot there would float
    // between the bends.
    expect(junction).toEqual({ x: 100 - CHAMFER, y: 0 });
    // Aggregate chip rides the midpoint of the dot-terminated trunk run; the
    // branch chip the branch mid.
    expect(trunkAnchor).toEqual({ x: (100 - CHAMFER) / 2, y: 0 });
    expect(branchAnchor).toEqual({ x: 100, y: 50 });
    expectRightwardFinish(path);
  });

  it("shares the trunk segment across members on one junction column", () => {
    // Two members of one fan-out (same source port, same junction) fan up and
    // down: their trunk segments overlap so the trunk draws once.
    const up = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: -120,
      junctionX: 100,
    });
    const down = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 120,
      junctionX: 100,
    });
    const trunkUp = parsePoints(up.path).slice(0, 2);
    const trunkDown = parsePoints(down.path).slice(0, 2);
    expect(trunkUp).toEqual(trunkDown); // M 0,0 L 92,0 both
    expect(up.junction).toEqual(down.junction);
    expectRightwardFinish(up.path);
    expectRightwardFinish(down.path);
  });

  it("clamps the junction column into the corridor", () => {
    // A junction hint past the target is clamped one stub+chamfer inside the port.
    const { junction } = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      junctionX: 10_000,
    });
    expect(junction.x).toBe(200 - PORT_STUB - 2 * CHAMFER); // clamped 168, dot at 160
  });

  it("joins a small-dy member with a single diagonal at the junction", () => {
    const { path } = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 2 * CHAMFER, // within one chamfer pair: no vertical run
      junctionX: 100,
    });
    expect(path).toBe("M 0,0 L 92,0 L 108,16 L 200,16");
    expectRightwardFinish(path);
  });

  it("draws a shared-y member as a straight trunk", () => {
    const { path, branchAnchor } = chamferFanoutPath({
      sourceX: 0,
      sourceY: 50,
      targetX: 200,
      targetY: 50,
      junctionX: 100,
    });
    expect(path).toBe("M 0,50 L 200,50");
    expect(branchAnchor).toEqual({ x: 100, y: 50 });
    expectRightwardFinish(path);
  });

  it("is deterministic and reads junctionX off routing hints", () => {
    const hints = routingHintsFromData({ junctionX: 100 });
    const a = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      ...hints,
    });
    const b = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      ...hints,
    });
    expect(a.path).toBe(b.path);
    expect(a.junction).toEqual({ x: 100 - CHAMFER, y: 0 });
  });

  it("seats the junction dot ON the drawn polyline for every member shape", () => {
    // Branching, small-dy diagonal, and shared-y straight members must all put
    // their junction on their own drawn geometry: the dot marks the split, and a
    // dot off the line reads as a floating speck (issue #9, 1.2).
    const shapes = [
      { targetY: 100 }, // full branch vertical
      { targetY: -120 }, // branch up
      { targetY: 2 * CHAMFER }, // small-dy diagonal
      { targetY: 0 }, // shared-y straight trunk
    ];
    for (const { targetY } of shapes) {
      const { path, junction } = chamferFanoutPath({
        sourceX: 0,
        sourceY: 0,
        targetX: 200,
        targetY,
        junctionX: 100,
      });
      expect(distanceToPolyline(path, junction)).toBe(0);
    }
    // Up and down members of one trunk still agree on a single junction point.
    const up = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: -120,
      junctionX: 100,
    });
    const down = chamferFanoutPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 120,
      junctionX: 100,
    });
    expect(up.junction).toEqual(down.junction);
  });
});
