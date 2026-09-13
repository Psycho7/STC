// Pure-geometry tests for the chamfered edge-path builder. Coordinates are
// chosen so the emitted `d` strings are exact and human-checkable. The final
// segment of every path must be a rightward horizontal so the ArrowClosed
// marker (orient=auto) points right into the target's Left handle.

import { describe, it, expect } from "vitest";

import {
  branchLegAfterJunction,
  cardClearRunAnchor,
  chamferStepPath,
  chamferFanoutPath,
  chamferFaninPath,
  drawnEdge,
  parsePathPoints,
  pathPointAtPts,
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

describe("pathPointAtPts", () => {
  // Two segments of length 10 (horizontal) then 30 (vertical); total 40. The
  // chip-slide pass reads off-midpoint fractions to move a blocked label along
  // its own line, so the interpolation must be exact and clamp out of range.
  const D = "M 0,0 L 10,0 L 10,30";
  const P = parsePathPoints(D);
  it("returns the first vertex at frac 0", () => {
    expect(pathPointAtPts(P, 0)).toEqual([0, 0]);
  });
  it("lands exactly on the shared vertex when the fraction hits a seg boundary", () => {
    // 0.25 of 40 = 10 = the whole first segment, so the point is the corner.
    expect(pathPointAtPts(P, 0.25)).toEqual([10, 0]);
  });
  it("interpolates within the covering segment", () => {
    // 0.5 of 40 = 20; 10 covers the first segment, the remaining 10 runs 10
    // down the 30-long vertical: (10, 10).
    expect(pathPointAtPts(P, 0.5)).toEqual([10, 10]);
  });
  it("clamps a fraction past 1 to the final vertex", () => {
    expect(pathPointAtPts(P, 2)).toEqual([10, 30]);
  });
  it("clamps a negative fraction to the first vertex", () => {
    expect(pathPointAtPts(P, -1)).toEqual([0, 0]);
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
    // Rule anchor: the centre of the longest horizontal run. The symmetric step
    // draws two runs of 92, and their centres are the same distance from the
    // arc midpoint (100, 50), so the tie falls to the first -- the source-side
    // run at (46, 0).
    expect(lx).toBe(46);
    expect(ly).toBe(0);
    expectRightwardFinish(d);
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
    // An early bend leaves the TARGET-side run the longest (68..200 = 132
    // against 0..52 = 52), so the chip rides its centre at (134, 100).
    expect(lx).toBe(134);
    expect(ly).toBe(100);
    expectRightwardFinish(d);
  });

  it("anchors on the long target-side run when the bend is early", () => {
    // bendX 100 pushes the bend far left of the 600-wide corridor: the run into
    // the target (108..600 = 492) dwarfs the source stub (0..92), so the chip
    // stands at its centre (354, 40).
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 600,
      targetY: 40,
      bendX: 100,
    });
    expect(d).toBe("M 0,0 L 92,0 L 100,8 L 100,32 L 108,40 L 600,40");
    expect(lx).toBe(354);
    expect(ly).toBe(40);
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
    // Two 92-long runs again, tied on distance to the arc midpoint: the
    // source-side one takes it.
    expect(lx).toBe(46);
    expect(ly).toBe(0);
    expectRightwardFinish(d);
  });

  it("keeps the label anchor continuous across the small-dy branch boundary", () => {
    // The forward step flips between the diagonal (small-dy) and the full
    // vertical-run shape at |dy| = 2 * chamfer. Live handle coordinates and an
    // offline port model can disagree by a pixel, so a dy that straddles the
    // boundary must not teleport the anchor. One rule covers both shapes: the
    // long run into the target wins on each side, and it moves by the pixel the
    // target row moved.
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
    expect(atX).toBe(334);
    expect(atY).toBe(2 * CHAMFER);
    expect(pastX).toBe(334);
    expect(pastY).toBe(2 * CHAMFER + 1);
  });

  it("anchors a same-rail straight line on its one run", () => {
    // A straight line draws a single horizontal run whatever the bend hint
    // says, so the chip stands at its centre.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 50,
      targetX: 600,
      targetY: 50,
      bendX: 60,
    });
    expect(d).toBe("M 0,50 L 600,50");
    expect(lx).toBe(300);
    expect(ly).toBe(50);
  });

  it("keeps the backward anchor continuous across the apex-rail boundary", () => {
    // Backward mirror of the small-dy continuity: within 2 * CHAMFER of the
    // source level the rail collapses to a single apex bevel. The rail run
    // (-16..216 at railY) is the longest horizontal on both sides of the
    // boundary, so the anchor does not teleport across it: x is identical and y
    // tracks railY.
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
    expect(atX).toBe(100);
    expect(atY).toBe(2 * CHAMFER);
    expect(pastX).toBe(100);
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
    // Both horizontals are 12 long; the source-side one wins the tie.
    expect(lx).toBe(6);
    expect(ly).toBe(0);
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
    // Rule anchor: the rail's leftward run at railY = 50 is by far the longest
    // horizontal (-16..216), so the chip stands at its centre.
    expect(lx).toBe(100);
    expect(ly).toBe(50);
    expect(Number.isFinite(lx)).toBe(true);
    expect(Number.isFinite(ly)).toBe(true);
    expectRightwardFinish(d);
  });

  it("anchors a short backward rail on its own run, on the line", () => {
    // The rail run is only 42 long here (174..216 at railY) but still the
    // longest horizontal, so the chip centres on it at 195.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 200,
      sourceY: 0,
      targetX: 190,
      targetY: 100,
    });
    expect(lx).toBe(195);
    expect(ly).toBe(50);
    expect(distanceToPolyline(d, { x: lx, y: ly })).toBeLessThan(0.01);
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
    // entryX moves the run's target-side end from -16 to -32, so the run's
    // centre follows it from 100 to 92.
    expect(lx).toBe(92);
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

  it("replaces the bend column with srcColX", () => {
    // srcColX (jogForwardLegs, blocked source leg) replaces the bend column
    // outright: the forward step leaves sy at srcColX = 40, which makes the run
    // into the target (48..200) the longest horizontal.
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      srcColX: 40,
    });
    expect(d).toBe("M 0,0 L 32,0 L 40,8 L 40,92 L 48,100 L 200,100");
    expect(lx).toBe(124);
    expect(ly).toBe(100);
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
    // Both runs measure 76: the source-side one takes the tie.
    expect(lx).toBe(38);
    expect(ly).toBe(0);
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
    // it must be used as-is, not clamped back to 32. The bend vertical lands at
    // x = 10, leaving 18..200 as the longest run.
    const [d, lx] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      srcColX: 10,
    });
    expect(d).toBe("M 0,0 L 2,0 L 10,8 L 10,92 L 18,100 L 200,100");
    expect(lx).toBe(109);
    expectRightwardFinish(d);
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
    // Aggregate chip stands on the trunk run, its box a port stub out of the
    // source port -- here the run is short, so the split dot's keep-off pulls it
    // in to 92 - (DOT_KEEPOFF + 60). The member's chip stands on its LAST
    // horizontal leg, its box a port stub back from the target port.
    expect(trunkAnchor).toEqual({ x: 16, y: 0 });
    expect(branchAnchor).toEqual({ x: 116, y: 100 });
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
    // The member's leg starts one chamfer past the column; on a shared-y member
    // the split dot lies on that same line, so its keep-off pushes the chip
    // right of the port-stub seat.
    expect(branchAnchor).toEqual({ x: 168, y: 50 });
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

describe("drawnEdge", () => {
  const PORTS = { sourceX: 0, sourceY: 0, targetX: 200, targetY: 100 };

  it("draws an item edge exactly as a direct chamferStepPath call does", () => {
    for (const hints of [{}, { bendX: 140, chamferBudget: 20 }]) {
      const drawn = drawnEdge(PORTS, "item", { item: "s", ...hints });
      expect(drawn.shape).toBe("item");
      if (drawn.shape !== "item") return;
      const [path, lx, ly] = chamferStepPath({ ...PORTS, ...hints });
      expect(drawn.path).toBe(path);
      expect(drawn.labelAnchor).toEqual({ x: lx, y: ly });
      expect(drawn.pts).toEqual(parsePathPoints(path));
    }
  });

  it("draws a fan-out member exactly as a direct chamferFanoutPath call does", () => {
    for (const hints of [{}, { junctionX: 120 }]) {
      const drawn = drawnEdge(PORTS, "bus", {
        item: "s",
        fanout: true,
        ...hints,
      });
      expect(drawn.shape).toBe("fanout");
      if (drawn.shape !== "fanout") return;
      const fan = chamferFanoutPath({ ...PORTS, ...hints });
      expect(drawn.path).toBe(fan.path);
      expect(drawn.junction).toEqual(fan.junction);
      expect(drawn.trunkAnchor).toEqual(fan.trunkAnchor);
      expect(drawn.branchAnchor).toEqual(fan.branchAnchor);
      expect(drawn.pts).toEqual(parsePathPoints(fan.path));
      expect(drawn.branchPts).toEqual(
        branchLegAfterJunction(parsePathPoints(fan.path), fan.junction),
      );
    }
  });

  it("falls back to the item shape with default hints for an unstamped edge", () => {
    const drawn = drawnEdge(PORTS, undefined, undefined);
    expect(drawn.shape).toBe("item");
    const [path] = chamferStepPath(PORTS);
    expect(drawn.path).toBe(path);
  });

  it("seats every returned anchor ON its own returned polyline", () => {
    // The invariant each of the hand-written copies assumed and none
    // asserted: an anchor a shape hands back must lie on the shape's own drawn
    // geometry, or the chip that rides it floats off its line.
    const ON_LINE = 1; // sub-unit: paths round to two decimals
    const item = drawnEdge(PORTS, "item", { item: "s" });
    if (item.shape !== "item") throw new Error("expected the item shape");
    expect(distanceToPolyline(item.path, item.labelAnchor)).toBeLessThan(
      ON_LINE,
    );

    const fan = drawnEdge(PORTS, "bus", { item: "s", fanout: true });
    if (fan.shape !== "fanout") throw new Error("expected the fan-out shape");
    for (const anchor of [fan.junction, fan.trunkAnchor, fan.branchAnchor]) {
      expect(distanceToPolyline(fan.path, anchor)).toBeLessThan(ON_LINE);
    }
  });
});

// The chip anchor of every TRUNK shape, including the two degenerate arms each
// builder guards (a shared-y straight member, a small-dy diagonal). The rule is
// one sentence per chip -- the aggregate's box a port stub out of the port it
// labels, the member's box a port stub back from its own port, neither closer
// to the junction dot than the column-side pad -- and these pin it on each arm,
// at the default (worst-case) chip box.
describe("trunk chip anchors, per drawn shape", () => {
  const PORTS = {
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 100,
  } as const;
  const JX = 100;
  // The default reserve when a caller hands in no chip box: CHIP_BOX_WIDTH / 2.
  const HALF_W = 60;

  it("seats a branching fan-out member's two chips", () => {
    const fan = chamferFanoutPath({ ...PORTS, junctionX: JX });
    // The trunk run (0 .. dot at 92) cannot hold the stub AND the box, so the
    // dot's keep-off decides: the box ends DOT_KEEPOFF short of the dot.
    expect(fan.trunkAnchor).toEqual({ x: 92 - 16 - HALF_W, y: 0 });
    // The member's leg (108 .. 200) is measured from the target port.
    expect(fan.branchAnchor).toEqual({ x: 200 - PORT_STUB - HALF_W, y: 100 });
  });

  it("seats a small-dy fan-out member's two chips on the two rows", () => {
    const fan = chamferFanoutPath({
      ...PORTS,
      targetY: 2 * CHAMFER,
      junctionX: JX,
    });
    expect(fan.path).toBe("M 0,0 L 92,0 L 108,16 L 200,16");
    expect(fan.trunkAnchor).toEqual({ x: 92 - 16 - HALF_W, y: 0 });
    expect(fan.branchAnchor).toEqual({
      x: 200 - PORT_STUB - HALF_W,
      y: 2 * CHAMFER,
    });
  });

  it("seats a branching fan-in member's two chips", () => {
    const fan = chamferFaninPath({ ...PORTS, junctionX: JX });
    // The aggregate leg runs from the merge dot (108) into the port: too short
    // for the stub seat, so the dot's keep-off decides from the other side.
    expect(fan.trunkAnchor).toEqual({ x: 108 + 16 + HALF_W, y: 100 });
    // The member's own stub runs out of the source port to the column.
    expect(fan.branchAnchor).toEqual({ x: PORT_STUB + HALF_W, y: 0 });
  });

  it("seats a shared-y fan-in member's two chips on one line", () => {
    const fan = chamferFaninPath({
      ...PORTS,
      sourceY: 50,
      targetY: 50,
      junctionX: JX,
    });
    expect(fan.path).toBe("M 0,50 L 200,50");
    expect(fan.trunkAnchor).toEqual({ x: 108 + 16 + HALF_W, y: 50 });
    // Both chips share the row here, so the member's box also keeps off the
    // merge dot -- it gives up its port-stub seat to do it.
    expect(fan.branchAnchor).toEqual({ x: 108 - 16 - HALF_W, y: 50 });
  });

  it("seats a small-dy fan-in member's two chips", () => {
    const fan = chamferFaninPath({
      ...PORTS,
      targetY: 2 * CHAMFER,
      junctionX: JX,
    });
    expect(fan.path).toBe("M 0,0 L 92,0 L 108,16 L 200,16");
    expect(fan.trunkAnchor).toEqual({ x: 108 + 16 + HALF_W, y: 2 * CHAMFER });
    expect(fan.branchAnchor).toEqual({ x: PORT_STUB + HALF_W, y: 0 });
  });

  it("seats a DUAL member on the run between the two columns", () => {
    // A fan-out member whose target port also carries a fan-in trunk hands its
    // flow over at the fan-in column: everything right of it is the aggregate
    // leg the fan-in members share, so this member's own stretch is the run
    // between the columns and its chip rides that run's middle.
    const fan = chamferFanoutPath({
      ...PORTS,
      junctionX: JX,
      faninJoinX: 160,
    });
    expect(fan.branchAnchor).toEqual({ x: (JX + CHAMFER + 168) / 2, y: 100 });
    // The trunk chip is unaffected by the hand-over.
    expect(fan.trunkAnchor).toEqual(
      chamferFanoutPath({ ...PORTS, junctionX: JX }).trunkAnchor,
    );
  });

  it("scales both chips down to the box they actually draw", () => {
    // The anchors are measured from the chip BOX, so a narrow chip fits its
    // port-stub seat on the very trunk run that pushed the worst-case box back
    // onto the dot's keep-off.
    const narrow = chamferFanoutPath({
      ...PORTS,
      junctionX: JX,
      aggHalfW: 20,
      memberHalfW: 20,
    });
    expect(narrow.trunkAnchor.x).toBe(PORT_STUB + 20);
    expect(narrow.branchAnchor.x).toBe(200 - PORT_STUB - 20);
  });
});

// The item-shape anchor as drawnEdge answers it -- the seam the renderers and
// the bookkeeping pass both draw through. Three rules, plus the card-clear
// stamp's gate.
describe("drawnEdge: the item chip anchor", () => {
  const PORTS = {
    sourceX: 0,
    sourceY: 0,
    targetX: 1000,
    targetY: 400,
  } as const;
  const HALF_W = 60;

  const anchorOf = (data: Record<string, unknown>): [number, number] => {
    const drawn = drawnEdge(PORTS, "item", data);
    if (drawn.shape !== "item") throw new Error("expected the item shape");
    return [drawn.labelAnchor.x, drawn.labelAnchor.y];
  };

  it("puts a far fan-in member one stub out of its source port", () => {
    expect(anchorOf({ item: "s", bendX: 900, faninColumn: true })).toEqual([
      PORT_STUB + HALF_W,
      PORTS.sourceY,
    ]);
  });

  it("puts a far fan-out member one stub back from its target port", () => {
    expect(anchorOf({ item: "s", bendX: 100, fanoutColumn: true })).toEqual([
      PORTS.targetX - PORT_STUB - HALF_W,
      PORTS.targetY,
    ]);
  });

  it("reads a DUAL far member as its fan-out side", () => {
    const dual = anchorOf({
      item: "s",
      bendX: 100,
      fanoutColumn: true,
      faninColumn: true,
    });
    expect(dual).toEqual(
      anchorOf({ item: "s", bendX: 100, fanoutColumn: true }),
    );
  });

  it("puts every other item edge on the longest run's centre", () => {
    const [, plainY] = anchorOf({ item: "s", bendX: 500 });
    // The two horizontals of a symmetric step are equal, so the tie goes to the
    // run nearest the arc midpoint; either way the anchor is a run centre, not
    // a port seat.
    expect([PORTS.sourceY, PORTS.targetY]).toContain(plainY);
  });

  it("takes a stamped card-clear seat only while it sits on a run", () => {
    const [ruleX, ruleY] = anchorOf({ item: "s", bendX: 500 });
    const slid = anchorOf({ item: "s", bendX: 500, chipX: 300, chipY: ruleY });
    expect(slid).toEqual([300, ruleY]);
    // Off every horizontal run -- what a drag in flight leaves behind -- the
    // stamp is ignored and the rule seat stands.
    expect(
      anchorOf({ item: "s", bendX: 500, chipX: 300, chipY: ruleY + 37 }),
    ).toEqual([ruleX, ruleY]);
  });
});

describe("cardClearRunAnchor", () => {
  // A two-run polyline: the long run at y 0 from x 0 to 400, then down to y 100
  // and a short run to 500.
  const PTS = parsePathPoints("M 0,0 L 400,0 L 400,100 L 500,100");
  const HALF_W = 50;

  it("keeps the run centre when no card is in the way", () => {
    expect(cardClearRunAnchor(PTS, HALF_W, [])).toEqual([200, 0]);
  });

  it("slides the box along its run to the nearer clear side", () => {
    // A card under the run centre: the box clears it on the left at 150 - 50
    // and on the right at 260 + 50, and the left move is the shorter one.
    const card = { left: 150, right: 260, top: -20, bottom: 20 };
    expect(cardClearRunAnchor(PTS, HALF_W, [card])).toEqual([100, 0]);
  });

  it("falls to the next-longest run when nothing on this one clears", () => {
    // A card spanning the whole long run: no seat on it clears, so the chip
    // takes the short run at y 100 instead.
    const card = { left: -100, right: 600, top: -20, bottom: 20 };
    expect(cardClearRunAnchor(PTS, HALF_W, [card])).toEqual([450, 100]);
  });

  it("keeps the longest run's centre when no run clears at all", () => {
    const wall = { left: -1000, right: 1000, top: -1000, bottom: 1000 };
    expect(cardClearRunAnchor(PTS, HALF_W, [wall])).toEqual([200, 0]);
  });

  it("ignores a card the chip row cannot reach", () => {
    const below = { left: 150, right: 260, top: 200, bottom: 300 };
    expect(cardClearRunAnchor(PTS, HALF_W, [below])).toEqual([200, 0]);
  });
});
