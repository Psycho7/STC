// Pure-geometry tests for the chamfered edge-path builder. Coordinates are
// chosen so the emitted `d` strings are exact and human-checkable. The final
// segment of every path must be a rightward horizontal so the ArrowClosed
// marker (orient=auto) points right into the target's Left handle.

import { describe, it, expect } from "vitest";

import {
  chamferStepPath,
  chamferBusPath,
  PORT_STUB,
  CHAMFER,
} from "../../src/canvas/edgePath";
import { parsePoints, expectRightwardFinish } from "./pathAssertions";

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
    const [d, lx] = chamferStepPath({
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 100,
      bendX: 60,
    });
    expect(d).toBe("M 0,0 L 52,0 L 60,8 L 60,92 L 68,100 L 200,100");
    expect(lx).toBe(60);
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
    // Label rides the detour rail midpoint between the two columns.
    expect(lx).toBe(92);
    expect(ly).toBe(50);
    expectRightwardFinish(d);
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
