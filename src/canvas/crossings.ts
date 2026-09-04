// Proper-crossing geometry, shared by the render layer and its audits.
//
// One definition of "two segments properly cross" serves three consumers that
// must never drift apart:
//   - deconflictChipAnchors' crossing-cue stamp pass (chipSeating.ts), which
//     decides where the render layer draws a "passing under" gap;
//   - the e2e crossing census (test/e2e/geometry.ts countCrossings), which
//     ratchets the per-scenario crossing count (CROSSING_BASELINE); and
//   - the render-side cue liveness filter below, which drops a stamped cue
//     once a node drag moves its own polyline off the stamped point.
// properCross moved here from test/e2e/geometry.ts (exam-surfaced Task 9,
// 2026-09-04) so the app and the audit share one definition instead of two
// copies that happen to agree.

import { HIDE_STALE_EPS } from "./dimensions";

export type Pt = readonly [number, number];

// Proper crossing of two segments WITH its point: they intersect at a point
// strictly interior to BOTH (shared endpoints and collinear touches do not
// count). That strictness is the whole argument the cue pass rests on: a
// fan-in merge's collinear run, a bus lane's overlapping member runs, and a
// fan-out trunk's shared junction all only ever TOUCH (endpoints on interiors,
// collinear overlaps), so none of them can produce a stamp and read as a
// crossing. Returns the intersection point, or null when they do not properly
// cross. The parametric solve only runs once the orientation signs have
// already proven a strict crossing, so the boolean caller pays nothing extra.
export function properCrossPoint(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const o = (p: Pt, q: Pt, r: Pt): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  const EPS = 1e-9;
  const strictlyOpposite = (u: number, v: number): boolean =>
    (u > EPS && v < -EPS) || (u < -EPS && v > EPS);
  if (!(strictlyOpposite(d1, d2) && strictlyOpposite(d3, d4))) return null;
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  // Strictly opposite orientations exclude parallel and collinear pairs (and
  // zero-length segments), so the denominator cannot vanish here.
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  return [a[0] + t * rx, a[1] + t * ry];
}

// The boolean form, the exact contract the crossing census has always
// asserted over segment pairs of different edges.
export function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  return properCrossPoint(a, b, c, d) !== null;
}

// Distance from point p to segment a->b (the usual clamped projection). The
// single shared copy for the render layer and its audits: chipSeating's chip
// seating and geometry.ts's audits used to carry private duplicates.
export function pointSegDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Shortest distance from p to a polyline (min over its segments). Guards
// ported from chipSeating's former private copy so the dedupe is
// behaviour-identical at every call site: an EMPTY polyline is infinitely far
// (no such thing exists in practice), a LONE point is its own distance (a
// degenerate single-vertex path still has a location), and only then does the
// segment loop run. Real edges always draw >= 2 vertices; the guards exist so
// the shared helper stays total.
export function pointToPolylineDistance(p: Pt, pts: ReadonlyArray<Pt>): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = pointSegDistance(p, pts[i - 1]!, pts[i]!);
    if (d < best) best = d;
  }
  return best;
}

// Drop cues whose stamped point no longer sits on the edge's own LIVE
// polyline. The stamps are absolute points from the seating pass and nodes
// stay mouse-draggable without a re-seat, so a dragged edge would otherwise
// float its cues off the lines they mark -- the same stale-stamp rule the
// fan-in marker and the fan-out branch hide follow (HIDE_STALE_EPS). At rest
// the stamp lies on the reconstructed polyline and the drawn polyline agrees
// with it to sub-unit noise (the endpoint-parity audit's tolerance, far below
// this eps), so nothing drops spuriously; only a real drag moves a port far
// enough to matter.
export function liveCrossingCues(
  cues: ReadonlyArray<{ x: number; y: number }> | undefined,
  pts: ReadonlyArray<Pt>,
): Array<{ x: number; y: number }> {
  if (cues === undefined || cues.length === 0) return [];
  return cues.filter(
    (c) => pointToPolylineDistance([c.x, c.y], pts) < HIDE_STALE_EPS,
  );
}

// Crossing-cue disk radius, in graph units, holding an on-screen radius
// clamped to [CROSSING_CUE_MIN_PX, CROSSING_CUE_MAX_PX] like the junction
// dot's zoom clamp: the cue must stay wide enough to erase the passing-under
// stroke right across the passing-over stroke's width at the widest stroke
// pair the canvas draws (a 3px dimmed stroke under a 2.25px hover-lit one
// needs ~2.7px of radius; the 4px floor covers it with margin), and narrow
// enough that the gap it cuts stays a gap, not a hole.
const CROSSING_CUE_MIN_PX = 4;
const CROSSING_CUE_MAX_PX = 7;
const CROSSING_CUE_RADIUS = 4.5;

export function crossingCueRadius(zoom: number): number {
  const screen = Math.min(
    CROSSING_CUE_MAX_PX,
    Math.max(CROSSING_CUE_MIN_PX, CROSSING_CUE_RADIUS * zoom),
  );
  return screen / zoom;
}
