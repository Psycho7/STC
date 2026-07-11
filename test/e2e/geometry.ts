// Pure geometry helpers for the P2 placement audit (geometry-audit.spec.ts).
//
// The browser side (collectGeometry, inlined in the spec) hands back, in flow /
// graph coordinates, every edge's parsed path polyline plus every node's raw
// (unpadded) card rect. Everything here is a pure function of that snapshot, so
// the same code scores the current build and the recorded pre-P2 baseline. Node
// import: the padding constants come straight from the routing source so a card
// rect built here matches paddedObstacles' `card` rect by construction.

import { CHAMFER, PORT_STUB } from "../../src/canvas/edgePath";
import {
  ENTRY_CHIP_BOX_WIDTH,
  ENTRY_CHIP_OFFSET,
  MAX_CHIP_SCALE,
} from "../../src/canvas/dimensions";

export type Pt = readonly [number, number];

export type RawRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type NodeRect = RawRect & {
  nodeId: string;
  type: string;
};

export type RawEdge = {
  id: string;
  source: string;
  target: string;
  item: string;
  d: string;
};

// Card padding, mirroring busRouting.paddedObstacles' `card` obstacle: the
// source port stub overhangs right, the wider of the target stub and the entry
// chip overhangs left, and the chamfer bevel overhangs top / bottom.
const OBSTACLE_PAD_RIGHT = PORT_STUB;
const OBSTACLE_PAD_LEFT = Math.max(
  PORT_STUB,
  ENTRY_CHIP_OFFSET + (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2,
);
const OBSTACLE_PAD_Y = CHAMFER;

export function paddedCard(rect: RawRect): RawRect {
  return {
    left: rect.left - OBSTACLE_PAD_LEFT,
    right: rect.right + OBSTACLE_PAD_RIGHT,
    top: rect.top - OBSTACLE_PAD_Y,
    bottom: rect.bottom + OBSTACLE_PAD_Y,
  };
}

// Parse an absolute "M x,y L x,y ..." path (the only form edgePath emits) into
// its ordered vertex list.
export function parsePath(d: string): Pt[] {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as const,
  );
}

// Consecutive-vertex segments of a polyline.
export function segmentsOf(pts: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = [];
  for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1]!, pts[i]!]);
  return segs;
}

// Does segment p0->p1 enter the OPEN interior of `rect` (shrunk by eps so a run
// grazing the padded boundary -- cleared runs sit a chamfer outside it -- is not
// a hit)? Liang-Barsky parametric clip: the segment overlaps the rect when the
// clipped parameter window [t0, t1] is non-empty with positive length.
export function segmentEntersRect(
  p0: Pt,
  p1: Pt,
  rect: RawRect,
  eps: number,
): boolean {
  const left = rect.left + eps;
  const right = rect.right - eps;
  const top = rect.top + eps;
  const bottom = rect.bottom - eps;
  if (right <= left || bottom <= top) return false;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel: inside iff on the correct side
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    clip(-dx, p0[0] - left) &&
    clip(dx, right - p0[0]) &&
    clip(-dy, p0[1] - top) &&
    clip(dy, bottom - p0[1])
  ) {
    return t1 - t0 > 1e-6;
  }
  return false;
}

// Proper crossing of two segments: they intersect at a point strictly interior
// to BOTH (shared endpoints and collinear touches do not count). Used for the
// crossing census, so a chain of connected segments in one edge and two edges
// meeting at a shared port are not miscounted as crossings.
export function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  const EPS = 1e-9;
  const strictlyOpposite = (u: number, v: number): boolean =>
    (u > EPS && v < -EPS) || (u < -EPS && v > EPS);
  return strictlyOpposite(d1, d2) && strictlyOpposite(d3, d4);
}

// Count crossings between segments belonging to DIFFERENT edges. O(S^2), fine at
// this scale. Segments within one edge are never compared (adjacent ones share a
// vertex; the polyline is simple by construction).
export function countCrossings(
  edges: ReadonlyArray<{ id: string; d: string }>,
): number {
  const perEdge = edges.map((e) => segmentsOf(parsePath(e.d)));
  let count = 0;
  for (let i = 0; i < perEdge.length; i++) {
    for (let j = i + 1; j < perEdge.length; j++) {
      for (const [a, b] of perEdge[i]!) {
        for (const [c, d] of perEdge[j]!) {
          if (properCross(a, b, c, d)) count++;
        }
      }
    }
  }
  return count;
}

// Container node ids (type "group") whose raw rect contains point p. An edge's
// endpoint sitting inside a group legitimately crosses that group's card, so the
// audit exempts the endpoints' containers -- the same parentId exemption the
// routing passes apply, recovered geometrically.
export function containersAt(p: Pt, nodes: ReadonlyArray<NodeRect>): string[] {
  return nodes
    .filter(
      (n) =>
        n.type === "group" &&
        p[0] >= n.left &&
        p[0] <= n.right &&
        p[1] >= n.top &&
        p[1] <= n.bottom,
    )
    .map((n) => n.nodeId);
}

export type SegmentViolation = {
  edgeId: string;
  card: string;
  seg: [Pt, Pt];
  // True when the segment enters the node's RAW (unpadded) box; false when it
  // only clips the padding overhang (a "graze").
  raw: boolean;
};

// Every edge segment that enters a FOREIGN padded card, each flagged raw (the
// segment also pierces the unpadded node box) or graze (padding only). Foreign =
// any node card except the edge's own source, target, and their containing
// groups (the same exemption the routing corridor tests use). eps guards the
// boundaries.
export function auditSegmentsVsCards(
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): SegmentViolation[] {
  const cardById = new Map<string, RawRect>();
  for (const n of nodes) cardById.set(n.nodeId, paddedCard(n));
  const out: SegmentViolation[] = [];
  for (const edge of edges) {
    const pts = parsePath(edge.d);
    if (pts.length === 0) continue;
    const exempt = new Set<string>([edge.source, edge.target]);
    for (const c of containersAt(pts[0]!, nodes)) exempt.add(c);
    for (const c of containersAt(pts[pts.length - 1]!, nodes)) exempt.add(c);
    for (const [seg0, seg1] of segmentsOf(pts)) {
      for (const n of nodes) {
        if (exempt.has(n.nodeId)) continue;
        const card = cardById.get(n.nodeId)!;
        if (segmentEntersRect(seg0, seg1, card, eps)) {
          out.push({
            edgeId: edge.id,
            card: n.nodeId,
            seg: [seg0, seg1],
            raw: segmentEntersRect(seg0, seg1, n, eps),
          });
        }
      }
    }
  }
  return out;
}

// A rendered chip box in flow coordinates, tagged with its owning edge (the
// data-edge-id hook FlowChip emits) and its family ("entry" for the icon-only
// port marker, "label" for everything else).
export type ChipRect = RawRect & {
  edgeId: string;
  label: string;
  kind: "entry" | "label";
};

export type ChipViolation = {
  edgeId: string;
  chipEdgeId: string;
  chipLabel: string;
  seg: [Pt, Pt];
};

// Every edge segment that enters a FOREIGN chip's box. Exemptions mirror the
// canvas design rather than bare edge identity (the chip de-confliction pass
// applies the same three):
//   - own edge: a chip sits on its own path by construction;
//   - same flow (same item AND source): a trunk's members share one lane and a
//     fanout's slices share their common trajectory, so a chip on that shared
//     line is on its OWN line even when a sibling edge id owns the segment;
//   - arrival cluster (same target): the converging final approaches before
//     one consumer read as a single junction -- entry chips are pinned at its
//     ports by design (row pitch is smaller than the max-scale chip box), and
//     an arrival's rate chip near that junction legitimately sits among its
//     siblings' entering runs.
export function auditSegmentsVsChips(
  edges: ReadonlyArray<RawEdge>,
  chips: ReadonlyArray<ChipRect>,
  eps = 0.5,
): ChipViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const out: ChipViolation[] = [];
  for (const edge of edges) {
    const pts = parsePath(edge.d);
    if (pts.length === 0) continue;
    for (const [seg0, seg1] of segmentsOf(pts)) {
      for (const chip of chips) {
        if (chip.edgeId === edge.id) continue;
        const owner = edgeById.get(chip.edgeId);
        if (
          owner !== undefined &&
          owner.item === edge.item &&
          owner.source === edge.source
        ) {
          continue; // same flow: one visual line
        }
        if (owner !== undefined && owner.target === edge.target) {
          continue; // arrival cluster before the shared consumer
        }
        if (segmentEntersRect(seg0, seg1, chip, eps)) {
          out.push({
            edgeId: edge.id,
            chipEdgeId: chip.edgeId,
            chipLabel: chip.label,
            seg: [seg0, seg1],
          });
        }
      }
    }
  }
  return out;
}

export function polylineLength(pts: ReadonlyArray<Pt>): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  return total;
}

// Manhattan distance between a polyline's two endpoints.
export function endpointManhattan(pts: ReadonlyArray<Pt>): number {
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
}

export function fmtSeg(seg: readonly [Pt, Pt]): string {
  const [a, b] = seg;
  return `(${a[0].toFixed(1)},${a[1].toFixed(1)})->(${b[0].toFixed(1)},${b[1].toFixed(1)})`;
}
