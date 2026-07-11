// Pure-geometry tests for the chamfered edge-path builder. Coordinates are
// chosen so the emitted `d` strings are exact and human-checkable. The final
// segment of every path must be a rightward horizontal so the ArrowClosed
// marker (orient=auto) points right into the target's Left handle.

import { describe, it, expect } from "vitest";

import {
  chamferStepPath,
  chamferBusPath,
  pathMidpoint,
  routingHintsFromData,
  PORT_STUB,
  CHAMFER,
} from "../../src/canvas/edgePath";
import { parsePoints, expectRightwardFinish } from "./pathAssertions";

describe("pathMidpoint", () => {
  it("returns the center of a single-segment path", () => {
    expect(pathMidpoint("M 0,0 L 10,0")).toEqual([5, 0]);
  });

  it("returns the point at half the cumulative length of a polyline", () => {
    // Two segments of length 10 and 30: half of 40 lands 10 into the second
    // segment, at (10, 10).
    expect(pathMidpoint("M 0,0 L 10,0 L 10,30")).toEqual([10, 10]);
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
    // Label anchor at 50% of cumulative length. Segments: 52, 8*sqrt(2), 84,
    // 8*sqrt(2), 132; total ~290.63, half ~145.31. Cumulative through the top
    // chamfer is ~63.31, so the anchor lands 82 into the 84-long vertical run:
    // x = 60 (the bend column), y = 8 + 82 = 90.
    expect(lx).toBe(60);
    expect(ly).toBe(90);
    expectRightwardFinish(d);
  });

  it("anchors the label on the target-side horizontal when the bend is early", () => {
    // bendX 100 pushes the bend far left of the 600-wide corridor, so more
    // than half the path length lies on the target-side horizontal rail.
    // Path: M 0,0 L 92,0 L 100,8 L 100,32 L 108,40 L 600,40. Segments: 92,
    // 8*sqrt(2), 24, 8*sqrt(2), 492; total ~630.63, half ~315.31. Cumulative
    // through the bottom chamfer is ~138.63, so the anchor lands ~176.69 into
    // the final rail: x = 108 + 176.69 = 284.69, y = 40 (the target level).
    const [d, lx, ly] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 600,
      targetY: 40,
      bendX: 100,
    });
    expect(d).toBe("M 0,0 L 92,0 L 100,8 L 100,32 L 108,40 L 600,40");
    expect(lx).toBe(284.69);
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
    expect(lx).toBe(100);
    expect(ly).toBe(5);
    expectRightwardFinish(d);
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
    // Label on the detour rail midpoint, finite.
    expect(lx).toBe(100);
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
    // Label anchor at 50% of cumulative length, on the leftward detour rail.
    // entryX lengthens the final target stub to 32 (vs 16 out of the source),
    // so the length midpoint sits at x = 84, left of the column midpoint 92.
    expect(lx).toBe(84);
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
