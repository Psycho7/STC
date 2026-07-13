// Pure geometry helpers for the P2 placement audit (geometry-audit.spec.ts).
//
// The browser side (collectGeometry, inlined in the spec) hands back, in flow /
// graph coordinates, every edge's parsed path polyline plus every node's raw
// (unpadded) card rect. Everything here is a pure function of that snapshot, so
// the same code scores the current build and the recorded pre-P2 baseline. Node
// import: the padding constants come straight from the routing source so a card
// rect built here matches paddedObstacles' `card` rect by construction.

import { CHAMFER, PORT_STUB } from "../../src/canvas/edgePath";
import { FANOUT_SPAN_MAX } from "../../src/canvas/busRouting";
import { ENTRY_GUTTER_OVERHANG } from "../../src/canvas/dimensions";

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
// source port stub overhangs right, the wider of the target stub and the
// entry-gutter overhang left, and the chamfer bevel overhangs top / bottom.
const OBSTACLE_PAD_RIGHT = PORT_STUB;
const OBSTACLE_PAD_LEFT = Math.max(PORT_STUB, ENTRY_GUTTER_OVERHANG);
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
// data-edge-id hook FlowChip emits) and its family.
export type ChipRect = RawRect & {
  edgeId: string;
  label: string;
  // "bus" = lane-anchored bus rise/branch chip (out of scope for the corridor
  // invariants), "bus-drop" = the trunk-seated aggregate chip (audited against
  // foreign cards with a trunk-member exemption), "label" = item rate chip.
  kind: "label" | "bus" | "bus-drop";
};

export type ChipViolation = {
  edgeId: string;
  chipEdgeId: string;
  chipLabel: string;
  seg: [Pt, Pt];
};

// Centre of a rect.
function centreOf(r: RawRect): Pt {
  return [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
}

// Two rects interpenetrate by more than eps on BOTH axes (a shared boundary or a
// sub-eps graze is not an overlap).
function rectsOverlap(a: RawRect, b: RawRect, eps: number): boolean {
  const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return dx > eps && dy > eps;
}

// The entry band of a target card: its padded-left gutter, where arriving lines
// converge on the Left port. Mirrors busRouting's EntryBand (paddedCard's left
// overhang, from the card's left edge outward). A rate chip whose CENTRE sits
// here is part of the arrival cluster; one out on the corridor is not.
function entryBandOf(card: RawRect): RawRect {
  return {
    left: card.left - OBSTACLE_PAD_LEFT,
    right: card.left,
    top: card.top - OBSTACLE_PAD_Y,
    bottom: card.bottom + OBSTACLE_PAD_Y,
  };
}

function centreInRect(p: Pt, r: RawRect): boolean {
  return p[0] >= r.left && p[0] <= r.right && p[1] >= r.top && p[1] <= r.bottom;
}

// Every edge segment that enters a FOREIGN chip's box. Exemptions mirror the
// canvas design rather than bare edge identity (the chip de-confliction pass
// applies the same set):
//   - own edge: a chip sits on its own path by construction;
//   - same flow (same item AND source): a trunk's members share one lane and a
//     fanout's slices share their common trajectory, so a chip on that shared
//     line is on its OWN line even when a sibling edge id owns the segment;
//   - arrival cluster (same target), NARROWED (3a): entry-kind chips are always
//     exempt (pinned at the port by design, row pitch below the max-scale chip
//     box); a label chip is exempt only while its centre sits in the target's
//     entry band -- the gutter just left of the consumer card where the final
//     approaches converge. A rate chip out on the corridor is no longer masked
//     by the shared target, so a chip lying across a sibling's line is flagged.
// `nodes` supplies the target cards the entry bands are built from.
export function auditSegmentsVsChips(
  edges: ReadonlyArray<RawEdge>,
  chips: ReadonlyArray<ChipRect>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): ChipViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const cardById = new Map<string, RawRect>();
  for (const n of nodes) cardById.set(n.nodeId, n);
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
          // Arrival cluster, narrowed: entry and bus chips always exempt (pinned
          // at the port / anchored on the lane by design); a rate chip is exempt
          // only when its centre lies in the target's entry band.
          if (chip.kind !== "label") continue;
          const card = cardById.get(owner.target);
          if (card !== undefined && centreInRect(centreOf(chip), entryBandOf(card))) {
            continue;
          }
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

export type ChipCardViolation = {
  chipEdgeId: string;
  chipLabel: string;
  chipKind: "label" | "bus-drop";
  card: string;
  raw: boolean;
};

// Every chip box that enters a FOREIGN node's RAW card (the P3 chip-vs-card
// tier). Foreign = any node except the chip's own exemption set (the same
// endpoint / container exemption auditSegmentsVsCards uses):
//   - label chip: source + target + those two endpoints' containers. A label
//     chip rides its own corridor leg, clear of both endpoints' cards.
//   - bus-drop (aggregate) chip: it seats on the SHARED trunk, feeding every
//     member of the trunk, so its exemption spans the whole trunk. Membership =
//     every edge sharing (source, item) with the owner edge; the exempt set is
//     the shared source, each member's target, and the containers of all of
//     them. Rise / branch bus chips (kind "bus") stay skipped -- lane-anchored,
//     out of scope for this tier.
// `raw` is always true here (raw cards only); the field mirrors SegmentViolation
// so callers report uniformly.
export function auditChipsVsCards(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): ChipCardViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const nodeById = new Map<string, NodeRect>();
  for (const n of nodes) nodeById.set(n.nodeId, n);
  const exemptContainers = (nodeId: string, into: Set<string>): void => {
    const node = nodeById.get(nodeId);
    if (node !== undefined) {
      for (const c of containersAt(centreOf(node), nodes)) into.add(c);
    }
  };
  const out: ChipCardViolation[] = [];
  for (const chip of chips) {
    if (chip.kind === "bus") continue; // rise/branch, lane-anchored, out of scope
    const owner = edgeById.get(chip.edgeId);
    const exempt = new Set<string>();
    if (owner !== undefined) {
      exempt.add(owner.source);
      exemptContainers(owner.source, exempt);
      if (chip.kind === "bus-drop") {
        // Aggregate chip on the shared trunk: exempt every member of the OWNER's
        // sub-trunk (its target and containers), mirroring the seating pass. A
        // (source, item) port can host BOTH a fan-out sub-trunk (adjacent-layer
        // targets) and a lane sub-trunk (long-span targets) under one trunkKey,
        // but seating exempts only the members of the aggregate's OWN sub-trunk
        // (fan-out trunkExempt over fan-out members; lane trunkExempt over lane
        // members). Split members by the same span boundary the routing passes
        // use -- FANOUT_SPAN_MAX -- so the audit exempts exactly that sub-trunk's
        // members rather than every edge sharing (source, item).
        const srcRight = nodeById.get(owner.source)?.right;
        const ownerTgt = nodeById.get(owner.target);
        const spanClassOf = (targetLeft: number): boolean => {
          if (srcRight === undefined) return true; // unknown geometry: exempt
          const gap = targetLeft - srcRight;
          return gap > 0 && gap <= FANOUT_SPAN_MAX; // true = fan-out (adjacent)
        };
        const ownerIsFanout =
          ownerTgt === undefined ? true : spanClassOf(ownerTgt.left);
        for (const e of edges) {
          if (e.source !== owner.source || e.item !== owner.item) continue;
          const tgt = nodeById.get(e.target);
          if (tgt !== undefined && spanClassOf(tgt.left) !== ownerIsFanout) {
            continue; // a member of the OTHER sub-trunk sharing this trunkKey
          }
          exempt.add(e.target);
          exemptContainers(e.target, exempt);
        }
      } else {
        exempt.add(owner.target);
        exemptContainers(owner.target, exempt);
      }
    }
    for (const n of nodes) {
      if (exempt.has(n.nodeId)) continue;
      if (rectsOverlap(chip, n, eps)) {
        out.push({
          chipEdgeId: chip.edgeId,
          chipLabel: chip.label,
          chipKind: chip.kind,
          card: n.nodeId,
          raw: true,
        });
      }
    }
  }
  return out;
}

export type ChipOffPathViolation = {
  chipEdgeId: string;
  chipLabel: string;
  distance: number;
};

// Distance from point p to segment a->b.
function pointSegDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Shortest distance from p to a polyline (min over its segments).
export function pointToPolylineDistance(p: Pt, pts: ReadonlyArray<Pt>): number {
  let best = Infinity;
  for (const [a, b] of segmentsOf(pts)) {
    const d = pointSegDistance(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

// Every LABEL chip whose centre lies farther than `tol` from its own edge's
// polyline (the P3 on-own-line invariant). Entry chips are excluded: they are
// pinned one inset off the target port, off the path end by design. A label
// chip's clear-segment anchor is on the path by construction, and both the
// along-line slide and a downward nudge along a vertical corridor leg keep it
// there; a chip flagged here was cascaded off its line.
export function auditChipsOnOwnPath(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  tol = 1,
): ChipOffPathViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const out: ChipOffPathViolation[] = [];
  for (const chip of chips) {
    if (chip.kind !== "label") continue;
    const owner = edgeById.get(chip.edgeId);
    if (owner === undefined) continue;
    const pts = parsePath(owner.d);
    if (pts.length === 0) continue;
    const dist = pointToPolylineDistance(centreOf(chip), pts);
    if (dist > tol) {
      out.push({ chipEdgeId: chip.edgeId, chipLabel: chip.label, distance: dist });
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
