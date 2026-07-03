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

// The last "L x,y" of a path is a rightward horizontal iff its y equals the
// previous point's y and its x is greater. This regex captures the last two
// points and the assertions below check the relationship.
function lastTwoPoints(
  d: string,
): { x0: number; y0: number; x1: number; y1: number } {
  const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
    (m) => ({ x: Number(m[1]), y: Number(m[2]) }),
  );
  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

function expectRightwardFinish(d: string) {
  const { x0, y0, x1, y1 } = lastTwoPoints(d);
  expect(y1).toBe(y0); // horizontal
  expect(x1).toBeGreaterThan(x0); // rightward
}

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
    const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
      (m) => ({ x: Number(m[1]), y: Number(m[2]) }),
    );
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
});
