// Shared assertion helpers for edge-path `d` strings. Both the pure-geometry
// edgePath tests and the BusEdge render test parse the emitted polyline the same
// way and check the same rightward-finish invariant, so the regex parser and
// that check live here in one place (mirrors the shared-helper convention of
// edgeSpans.ts). The final segment of every path must be a rightward horizontal
// so the ArrowClosed marker (orient=auto) points right into the target's Left
// handle.

import { expect } from "vitest";

export type Point = { x: number; y: number };

// Every "x,y" coordinate pair in an SVG path `d` string, in order.
export function parsePoints(d: string): Point[] {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

// The last two points of the path (the final drawn segment).
function lastTwoPoints(d: string): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const pts = parsePoints(d);
  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

// Assert the last "L x,y" is a rightward horizontal: its y equals the previous
// point's y and its x is greater.
export function expectRightwardFinish(d: string): void {
  const { x0, y0, x1, y1 } = lastTwoPoints(d);
  expect(y1).toBe(y0); // horizontal
  expect(x1).toBeGreaterThan(x0); // rightward
}
