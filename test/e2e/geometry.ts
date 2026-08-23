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
import {
  ENTRY_GUTTER_OVERHANG,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_WIDTH,
  recipeHeight,
} from "../../src/canvas/dimensions";
import {
  CARD_BORDER,
  PORT_ZONE_DEPTH,
  cardGrowth,
  chipEntersOwnCardBody,
} from "../../src/canvas/chipSeating";

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

// Liang-Barsky parametric clip of segment p0->p1 against the OPEN interior of
// `rect` (shrunk by eps so a run grazing the padded boundary -- cleared runs sit
// a chamfer outside it -- is not a hit). Returns the clipped parameter window
// [t0, t1], or null when the segment misses or only touches.
function clipWindow(
  p0: Pt,
  p1: Pt,
  rect: RawRect,
  eps: number,
): [number, number] | null {
  const left = rect.left + eps;
  const right = rect.right - eps;
  const top = rect.top + eps;
  const bottom = rect.bottom - eps;
  if (right <= left || bottom <= top) return null;
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
    return t1 - t0 > 1e-6 ? [t0, t1] : null;
  }
  return null;
}

// Does segment p0->p1 enter the OPEN interior of `rect` (shrunk by eps)?
export function segmentEntersRect(
  p0: Pt,
  p1: Pt,
  rect: RawRect,
  eps: number,
): boolean {
  return clipWindow(p0, p1, rect, eps) !== null;
}

// The PART of segment p0->p1 that lies inside `rect` (shrunk by eps), or null
// when it misses. Same test as segmentEntersRect, keeping the window that one
// discards: a caller that has to say WHERE an occurrence is must report the run
// inside the box and not the whole segment, which can be arbitrarily longer.
export function clipSegmentToRect(
  p0: Pt,
  p1: Pt,
  rect: RawRect,
  eps: number,
): [Pt, Pt] | null {
  const window = clipWindow(p0, p1, rect, eps);
  if (window === null) return null;
  const [t0, t1] = window;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  return [
    [p0[0] + t0 * dx, p0[1] + t0 * dy],
    [p0[0] + t1 * dx, p0[1] + t1 * dy],
  ];
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

// Parse an edge id `e:<index>:<from>-><to>:<item>` (the form layout.ts builds)
// into its source, target, and item. from / to are ELK unit ids (no `->` or
// trailing `:item`). Lives here rather than in a caller because every consumer
// of the audits below has to recover the same three fields from the same id.
export function parseEdgeId(
  id: string,
): { source: string; target: string; item: string } | null {
  const m = /^e:\d+:(.+)->(.+):([^:]+)$/.exec(id);
  if (m === null) return null;
  return { source: m[1]!, target: m[2]!, item: m[3]! };
}

// Lift collected `{ id, d }` edges to RawEdge, dropping any id that does not
// carry the source / target / item encoding the audits need.
export function toRawEdges(
  edges: ReadonlyArray<{ id: string; d: string }>,
): RawEdge[] {
  const out: RawEdge[] = [];
  for (const e of edges) {
    const parsed = parseEdgeId(e.id);
    if (parsed === null) continue;
    out.push({ id: e.id, d: e.d, ...parsed });
  }
  return out;
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

export type OwnCardPierce = {
  edgeId: string;
  card: string;
  role: "source" | "target";
  seg: [Pt, Pt];
};

// Every edge segment that enters the RAW body of the edge's OWN source or
// target card. auditSegmentsVsCards exempts those endpoint cards outright, so a
// run that traverses its own endpoint body -- the last-resort own-card rise /
// drop the packed-corridor pierce rescue falls back to -- is invisible there.
// This surfaces exactly that residue, so a follow-up change that grows it is
// caught by a ratchet. A normal approach leg touches only the card's port-side
// boundary (the open-interval test with eps ignores a boundary graze), so it
// does not count; only a column landing inside the body does. Container (group)
// endpoints are skipped: a run legitimately lives inside its own container, and
// the routing passes exempt it the same way. Pure and deterministic.
export function auditOwnCardPierces(
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): OwnCardPierce[] {
  const nodeById = new Map<string, NodeRect>();
  for (const n of nodes) nodeById.set(n.nodeId, n);
  const out: OwnCardPierce[] = [];
  for (const edge of edges) {
    const pts = parsePath(edge.d);
    if (pts.length === 0) continue;
    const own: Array<{ card: NodeRect; role: "source" | "target" }> = [];
    const s = nodeById.get(edge.source);
    const t = nodeById.get(edge.target);
    if (s !== undefined && s.type !== "group") own.push({ card: s, role: "source" });
    if (t !== undefined && t.type !== "group") own.push({ card: t, role: "target" });
    if (own.length === 0) continue;
    for (const [seg0, seg1] of segmentsOf(pts)) {
      for (const { card, role } of own) {
        if (segmentEntersRect(seg0, seg1, card, eps)) {
          out.push({ edgeId: edge.id, card: card.nodeId, role, seg: [seg0, seg1] });
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
  // The chip's own data-testid: the element id a report names, since one edge
  // can own both a rise and a drop chip.
  testId: string;
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
//
// The foreignness decision itself lives in chipForeignTo, shared with the
// reading-zoom census below so the two can never call the same seat foreign and
// waived respectively.
function chipForeignTo(
  chip: ChipRect,
  edge: RawEdge,
  edgeById: ReadonlyMap<string, RawEdge>,
  cardById: ReadonlyMap<string, RawRect>,
): boolean {
  if (chip.edgeId === edge.id) return false;
  const owner = edgeById.get(chip.edgeId);
  if (
    owner !== undefined &&
    owner.item === edge.item &&
    owner.source === edge.source
  ) {
    return false; // same flow: one visual line
  }
  if (owner !== undefined && owner.target === edge.target) {
    // Arrival cluster, narrowed: entry and bus chips always exempt (pinned
    // at the port / anchored on the lane by design); a rate chip is exempt
    // only when its centre lies in the target's entry band.
    if (chip.kind !== "label") return false;
    const card = cardById.get(owner.target);
    if (card !== undefined && centreInRect(centreOf(chip), entryBandOf(card))) {
      return false;
    }
  }
  return true;
}

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
        if (!chipForeignTo(chip, edge, edgeById, cardById)) continue;
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

// Every chip box that enters a FOREIGN node's RAW card, OR seats its CENTRE on
// its OWN endpoint card's body past the port strip (the P3 chip-vs-card tier,
// tightened for issue #10). Two exemption tiers, mirroring the seating pass:
//   - containers (group slabs holding an endpoint) stay WHOLLY exempt; a chip
//     legitimately sits inside its endpoints' container.
//   - own endpoint cards are exempt while the chip centre stays in the port strip
//     (chipEntersOwnCardBody, shared verbatim with the seating pass). Only the
//     port SIDE is needed (source = right edge, target = left edge); the strip
//     depth and the centre test live in the shared helper.
// Which endpoints count as "own":
//   - label chip: the owner edge's source (source zone) and target (target zone).
//   - bus-drop (aggregate) chip: the shared source plus EVERY member target of
//     the owner's sub-trunk (each a target zone). A (source, item) port can host
//     BOTH a fan-out sub-trunk (adjacent-layer targets) and a lane sub-trunk
//     (long-span targets) under one trunkKey, so members are split by the same
//     FANOUT_SPAN_MAX boundary the routing passes use, matching the seating
//     trunkExempt / laneTrunkExempt union.
//   - rise / branch bus chips (kind "bus") stay skipped -- lane-anchored, out of
//     scope for this tier.
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
    const whole = new Set<string>();
    const zones = new Map<string, "source" | "target">();
    if (owner !== undefined) {
      zones.set(owner.source, "source");
      exemptContainers(owner.source, whole);
      if (chip.kind === "bus-drop") {
        const srcRight = nodeById.get(owner.source)?.right;
        const ownerTgt = nodeById.get(owner.target);
        const spanClassOf = (targetLeft: number): boolean => {
          if (srcRight === undefined) return true; // unknown geometry: fan-out
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
          zones.set(e.target, "target");
          exemptContainers(e.target, whole);
        }
      } else {
        zones.set(owner.target, "target");
        exemptContainers(owner.target, whole);
      }
    }
    for (const n of nodes) {
      if (whole.has(n.nodeId)) continue;
      const zone = zones.get(n.nodeId);
      const hit =
        zone === undefined
          ? rectsOverlap(chip, n, eps)
          : chipEntersOwnCardBody(chip, n, zone, eps);
      if (hit) {
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

// A DRAWN junction dot's box in graph coordinates, tagged with its data-testid.
export type DotRect = RawRect & { testId: string };

export type DotCoverage = {
  dotId: string;
  chipEdgeId: string;
  chipLabel: string;
  // The dot's centre, so a report can name WHERE the hidden dot is.
  at: Pt;
  // The hiding chip's centre. An edge can own TWO chips (a bus drop and a bus
  // rise), so naming the chip by its edge id alone does not identify the box
  // that did the hiding.
  chipAt: Pt;
};

// Every junction dot a chip box HIDES: the dot's drawn box lies inside a chip's
// box except for at most `visibleEpsPx` screen pixels of overhang per side.
// Chips paint above the dots in the shared edgelabel-renderer layer
// (.flow-chip z-index 2 vs .bus-junction z-index 1, canvas.css) and are opaque,
// so a dot under one is simply not there for the reader -- the merge / split it
// marks reads as an ordinary corner.
//
// Coverage is judged against the dot box AS DRAWN (collected from the DOM),
// which already carries the zoom-clamped radius at this camera; `fitZoom` only
// converts the screen-pixel tolerance into the graph frame the rects live in, so
// the same sliver of surviving dot counts the same on a 0.2x plan and a 0.9x
// one. One entry per hidden dot (the first chip found hiding it), not per
// (dot, chip) pair: the census counts dots the reader lost. COINCIDENT dots
// count once for the same reason -- every member of one trunk draws the same
// split point, and the reader sees one dot there.
export function auditDotsUnderChips(
  chips: ReadonlyArray<ChipRect>,
  dots: ReadonlyArray<DotRect>,
  fitZoom: number,
  visibleEpsPx = 1,
): DotCoverage[] {
  const eps = visibleEpsPx / fitZoom;
  const out: DotCoverage[] = [];
  const seen = new Set<string>();
  for (const dot of dots) {
    const [cx, cy] = centreOf(dot);
    const key = `${Math.round(cx)}|${Math.round(cy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const chip of chips) {
      if (
        dot.left >= chip.left - eps &&
        dot.right <= chip.right + eps &&
        dot.top >= chip.top - eps &&
        dot.bottom <= chip.bottom + eps
      ) {
        out.push({
          dotId: dot.testId,
          chipEdgeId: chip.edgeId,
          chipLabel: chip.label,
          at: [cx, cy],
          chipAt: centreOf(chip),
        });
        break;
      }
    }
  }
  return out;
}

// A collected node carrying its per-side port items as well as its rect: what
// the endpoint-parity audit needs and the other audits do not, kept off NodeRect
// so nothing else has to supply it.
export type PortedNode = NodeRect & {
  inPorts: ReadonlyArray<string>;
  outPorts: ReadonlyArray<string>;
};

type PortDrift = { sourceDx: number; targetDx: number; dy: number };

// Drawn-vs-model port drift per node kind, MIRRORED from chipSeating's own
// PORT_DRIFT (the module does not export it), the same way the unit suites
// mirror it. React Flow anchors an edge at the OUTER edge of the handle's 8x8
// box, not at the model port the routing passes compute, so the drawn path
// starts and ends a few units off the model coordinate; chipSeating's
// edgeEndpoints applies exactly these offsets to reconstruct the drawn frame.
//
// The mirror is the load-bearing copy HERE, and it is one-directional: the
// drawn endpoints this audit reads come from React Flow's handle anchoring, not
// from chipSeating, so editing the source table alone moves nothing here
// (verified by mutating it). What the audit pins is the DOM contract both
// tables describe -- card borders, handle sizing, row pitch -- so a change that
// invalidates the source numbers reddens this table through the DOM, and this
// copy then has to be re-derived alongside it.
//
// Nothing checks the two copies against each other, either. The unit-suite
// mirrors at least run chipSeating's own code beside their copy; this one never
// touches src, so a src edit that this file does not follow goes unnoticed until
// the DOM contract itself moves. Treat the copy as hand-maintained.
//
// The product side carries a matching blind spot. The reconstruction takes a
// product node's width from the DOM (node.right - node.left), so a change to
// product width or border moves the drawn endpoint and the rebuilt one together
// and this audit stays green. Recipes rebuild off the model RECIPE_WIDTH, so the
// same class of change on a recipe card does redden.
const PORT_DRIFT: Record<"recipe" | "product" | "other", PortDrift> = {
  recipe: { sourceDx: 5, targetDx: -3, dy: 1 },
  product: { sourceDx: 4, targetDx: -4, dy: 0 },
  other: { sourceDx: 0, targetDx: 0, dy: 0 },
};

function driftOf(type: string): PortDrift {
  if (type === "recipe") return PORT_DRIFT.recipe;
  if (type === "product") return PORT_DRIFT.product;
  return PORT_DRIFT.other;
}

// Node-local y of a recipe row's mid-line, mirroring recipeGeometry's rowHandleY
// off the shared dimension constants (that helper is module-private). The row
// index is the item's position in the node's own side, which the collected port
// lists carry in model order.
function recipeRowY(rowIndex: number): number {
  return (
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD +
    rowIndex * RECIPE_ROW_HEIGHT +
    RECIPE_ROW_HEIGHT / 2
  );
}

// One endpoint's rebuilt-vs-drawn comparison, in graph units.
export type EndpointParity = {
  edgeId: string;
  end: "source" | "target";
  nodeId: string;
  nodeType: string;
  rebuilt: Pt;
  drawn: Pt;
  // Signed drawn - rebuilt, per axis, and the larger absolute of the two.
  dx: number;
  dy: number;
  delta: number;
};

// Rebuild both endpoints of every edge the way chipSeating's edgeEndpoints does
// -- the MODEL port (card origin + node width + the row's mid-line, or the card
// centre when the item resolves to no row) shifted by PORT_DRIFT -- and compare
// each against the first / last vertex of the path actually drawn.
//
// The model side is deliberately built from the card ORIGIN plus model
// constants, never from the drawn row box: a reconstruction that read the row's
// rendered mid-line would cancel PORT_DRIFT.dy against itself and agree by
// construction. Here the row index comes from the port list and the y from
// recipeRowY, so a port resolving to the wrong row shows up as a full row-pitch
// delta. That is the disagreement class this audit exists for; sub-unit
// residue is documented noise (ItemEdge's HIDE_STALE_EPS comment), which is why
// its callers pin a tolerance rather than expect zero.
//
// Endpoints whose node is absent from the collected set are skipped, mirroring
// edgeEndpoints returning null. A node kind the model gives no per-item port
// (product, and container / loop kinds) rebuilds at the card centre, which is
// what portOffsetY returns for it; the whole corpus currently lands every edge
// endpoint on a recipe or a product, so a loop node entering the corpus would
// show up here as a row-pitch gap rather than pass unnoticed. LoopNode already
// renders row-anchored handles while portOffsetY answers with the card centre --
// the mismatch is untested only because no corpus plan contains a loop node.
export function auditEndpointParity(
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<PortedNode>,
): EndpointParity[] {
  const byId = new Map<string, PortedNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const out: EndpointParity[] = [];
  for (const edge of edges) {
    const pts = parsePath(edge.d);
    if (pts.length < 2) continue;
    const ends = [
      { end: "source" as const, node: byId.get(edge.source), drawn: pts[0]! },
      {
        end: "target" as const,
        node: byId.get(edge.target),
        drawn: pts[pts.length - 1]!,
      },
    ];
    for (const { end, node, drawn } of ends) {
      if (node === undefined) continue;
      const drift = driftOf(node.type);
      const isRecipe = node.type === "recipe";
      const modelWidth = isRecipe ? RECIPE_WIDTH : node.right - node.left;
      const ports = end === "source" ? node.outPorts : node.inPorts;
      const rowIndex = isRecipe ? ports.indexOf(edge.item) : -1;
      const modelHeight = isRecipe
        ? recipeHeight(node.inPorts.length, node.outPorts.length)
        : node.bottom - node.top;
      // portOffsetY falls back to the card's vertical centre for an unresolved
      // item / node kind, and driftedPortY leaves that fallback undrifted.
      const localY =
        rowIndex >= 0 ? recipeRowY(rowIndex) + drift.dy : modelHeight / 2;
      const rebuilt: Pt = [
        end === "source"
          ? node.left + modelWidth + drift.sourceDx
          : node.left + drift.targetDx,
        node.top + localY,
      ];
      const dx = drawn[0] - rebuilt[0];
      const dy = drawn[1] - rebuilt[1];
      out.push({
        edgeId: edge.id,
        end,
        nodeId: node.nodeId,
        nodeType: node.type,
        rebuilt,
        drawn,
        dx,
        dy,
        delta: Math.max(Math.abs(dx), Math.abs(dy)),
      });
    }
  }
  return out;
}

// One node whose DRAWN card box disagrees with the box the seating pass
// measures chips against.
export type CardFrameMismatch = {
  nodeId: string;
  drawnWidth: number;
  drawnHeight: number;
  seatingWidth: number;
  seatingHeight: number;
};

// Every RECIPE card whose drawn border box differs from the box chipSeating
// builds for it. The seating pass's obstacle rects are the model box (card
// origin, RECIPE_WIDTH, recipeHeight) grown by `cardGrowth`, which is IMPORTED
// from src here rather than mirrored: a chip cleared against a card two units
// narrower than the painted one is a chip the browser shows overlapping the
// card's border, so the two frames have to be the same box, and this states it
// against the DOM.
//
// Recipes only. A product or group card rebuilds its model width from the DOM
// (nothing else knows it), so it would agree by construction -- the same blind
// spot auditEndpointParity's product side documents. Recipes rebuild off the
// model constants, so they carry the contract.
//
// A CRITERION, not a ratchet table: it holds at zero on every scenario, so it
// adds no baseline and no ruling to the NOTE block's enumeration.
export function auditCardFrames(
  nodes: ReadonlyArray<PortedNode>,
  eps = 0.01,
): CardFrameMismatch[] {
  const out: CardFrameMismatch[] = [];
  const growth = cardGrowth("recipe");
  for (const n of nodes) {
    if (n.type !== "recipe") continue;
    const seatingWidth = RECIPE_WIDTH + growth;
    const seatingHeight =
      recipeHeight(n.inPorts.length, n.outPorts.length) + growth;
    const drawnWidth = n.right - n.left;
    const drawnHeight = n.bottom - n.top;
    if (
      Math.abs(drawnWidth - seatingWidth) > eps ||
      Math.abs(drawnHeight - seatingHeight) > eps
    ) {
      out.push({
        nodeId: n.nodeId,
        drawnWidth,
        drawnHeight,
        seatingWidth,
        seatingHeight,
      });
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

// -- reading-zoom seating census ---------------------------------------------
//
// Four counters over the SAME collected snapshot as the audits above, taken at a
// fixed reading zoom instead of fit zoom (the spec's own describe explains the
// camera). They exist because the tiers above are blind to whole chip families:
// auditChipsOnOwnPath sees "label" chips only and auditChipsVsCards skips "bus"
// chips, so every lane rise / drop chip is invisible to both. Each counter here
// covers ALL chip kinds and counts CHIPS, not (chip, other) pairs: the census
// asks how many SEATS a reader would find wrong, and a chip crossed by four
// foreign strokes is one bad seat, not four.
//
// The counters are deliberately not the same criteria as the tiers above -- they
// are structural (does the line pass through the box), depth-based (how far past
// a card border), and containment-based (is the box still in its band) -- so a
// seat can be legal there and counted here. Where the two DO overlap
// (foreign-stroke vs CHIP_SEGMENT_BASELINE) the waiver set is literally shared,
// so the two can never move in opposite directions for one seat.
export type ChipCensusHit = {
  // The chip's data-testid: the element id a report names.
  chipId: string;
  chipEdgeId: string;
  chipLabel: string;
  chipKind: ChipRect["kind"];
  // What this chip did, in the counter's own terms.
  detail: string;
};

function censusHit(chip: ChipRect, detail: string): ChipCensusHit {
  return {
    chipId: chip.testId,
    chipEdgeId: chip.edgeId,
    chipLabel: chip.label,
    chipKind: chip.kind,
    detail,
  };
}

// Every chip whose OWN edge's drawn polyline does not pass through its drawn
// box -- the structural seat-validity rule. This is the e2e analogue of the
// seating pass's segIntersectsChipBox, and deliberately NOT a centre-distance
// rule like auditChipsOnOwnPath: a sidestep seat holds its own line inside the
// box it RESERVED while moving the centre up to a half-width off it, so a
// centre-distance rule would red-flag a seat the reader still reads as bound to
// its line. Note this counter measures the box the chip PAINTS, which is
// narrower than the reserve at any camera below max counter-scale, so a
// sidestep seat can in principle still redden it -- see the sidestep paragraph
// on SEAT_VALIDITY_BASELINE in the audit spec for the measured case.
//
// Takes the RAW collected edges ({ id, d }) rather than parsed RawEdges so a
// chip is never judged against an edge list that dropped its owner for id-shape
// reasons: a chip whose owner path is genuinely absent from the DOM counts as
// invalid, since no line at all reaches it.
export function auditChipSeatValidity(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<{ id: string; d: string }>,
  eps = 0.5,
): ChipCensusHit[] {
  const pathById = new Map<string, string>();
  for (const e of edges) pathById.set(e.id, e.d);
  const out: ChipCensusHit[] = [];
  for (const chip of chips) {
    const d = pathById.get(chip.edgeId);
    if (d === undefined) {
      out.push(censusHit(chip, `owner edge ${chip.edgeId} draws no path`));
      continue;
    }
    const pts = parsePath(d);
    const on = segmentsOf(pts).some(([a, b]) =>
      segmentEntersRect(a, b, chip, eps),
    );
    if (!on) {
      const gap = pointToPolylineDistance(centreOf(chip), pts);
      out.push(
        censusHit(
          chip,
          `own polyline misses its box (centre ${gap.toFixed(1)} off the line)`,
        ),
      );
    }
  }
  return out;
}

// The intrusion budget a chip box may spend inside a node card: the port-side
// strip a chip on its own line necessarily covers. chipEntersOwnCardBody is a
// CENTRE test; this census is a BOX-depth test using the same budget number but
// different rule. Centre-legal wide-box seats are counted here by design (F1
// family: a chip whose centre is in the port strip but whose box overlaps the
// card body past the budget).
export const CARD_INTRUSION_BUDGET = CARD_BORDER + PORT_ZONE_DEPTH;

// Every chip whose box reaches more than `budget` DEEP past a node card's
// border, own endpoint cards included. Depth, not area: the legal state is a
// wide box lying across the port strip, which is shallow but long (a 9-deep
// strip seat already covers ~432 sq units at max chip scale, so no area
// threshold can separate it from a chip parked on the card body). Penetration
// depth is the smaller of the two overlap extents (overlapping x and y); for
// partial overlap this equals the push-out distance, but for a chip contained in
// a card it saturates at the chip's smaller extent. Conservative (never over-
// reports): a box that only laps the port strip scores its x-overlap and stays
// under budget however tall it is.
//
// Container slabs (type "group", the `loop:` boxes) are excluded outright: a
// chip legitimately sits inside a slab its endpoints live in, and the slab's
// border is not a card border the reader reads a chip against.
export function auditChipCardIntrusion(
  chips: ReadonlyArray<ChipRect>,
  nodes: ReadonlyArray<NodeRect>,
  budget = CARD_INTRUSION_BUDGET,
): ChipCensusHit[] {
  const cards = nodes.filter((n) => n.type !== "group");
  const out: ChipCensusHit[] = [];
  for (const chip of chips) {
    let worst: { card: string; depth: number } | null = null;
    for (const card of cards) {
      const dx = Math.min(chip.right, card.right) - Math.max(chip.left, card.left);
      const dy = Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
      if (dx <= 0 || dy <= 0) continue;
      const depth = Math.min(dx, dy);
      if (worst === null || depth > worst.depth) {
        worst = { card: card.nodeId, depth };
      }
    }
    if (worst !== null && worst.depth > budget) {
      out.push(
        censusHit(
          chip,
          `intrudes ${worst.depth.toFixed(1)} into card ${worst.card} (budget ${budget})`,
        ),
      );
    }
  }
  return out;
}

// Every chip whose box has a FOREIGN flow's stroke running through it. Same
// foreignness rule as auditSegmentsVsChips (own edge skipped, same item+source
// waived as one visual line, same-target arrival cluster waived), shared through
// chipForeignTo -- what differs is the shape of the count (per chip, not per
// segment) and the reach: this one is not restricted to any chip kind, so a lane
// rise chip lying across someone else's column shows up here.
export function auditChipForeignStrokes(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): ChipCensusHit[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const cardById = new Map<string, RawRect>();
  for (const n of nodes) cardById.set(n.nodeId, n);
  const out: ChipCensusHit[] = [];
  for (const chip of chips) {
    const through: string[] = [];
    for (const edge of edges) {
      if (!chipForeignTo(chip, edge, edgeById, cardById)) continue;
      const pts = parsePath(edge.d);
      if (pts.length === 0) continue;
      if (segmentsOf(pts).some(([a, b]) => segmentEntersRect(a, b, chip, eps))) {
        through.push(edge.id);
      }
    }
    if (through.length > 0) {
      out.push(
        censusHit(
          chip,
          `${through.length} foreign stroke(s) through its box: ${through.join(", ")}`,
        ),
      );
    }
  }
  return out;
}

// A drawn bus band's rect, tagged with the data-testid BusBands emits
// (`bus-band-top` / `bus-band-bottom`).
export type BandRect = RawRect & { testId: string };

// The band a lane-seated bus chip belongs to, recovered from the chip's LANE
// rather than from its own box: the owner edge's longest HORIZONTAL run whose y
// lies inside a band strip is that member's lane run, and its band is the one
// the chip is supposed to stay in. Binding by the box instead (nearest band)
// would make an escaped chip define its own target and the escape would never
// count. A lane stroke is inside its band by construction (the band is the lane
// extent padded), so a chip with no such run is not lane-seated at all -- a
// fan-out branch or aggregate chip, which no band covers -- and is skipped.
function laneBandOf(
  d: string,
  bands: ReadonlyArray<BandRect>,
  eps: number,
): BandRect | null {
  let best: BandRect | null = null;
  let bestRun = -1;
  for (const [a, b] of segmentsOf(parsePath(d))) {
    if (Math.abs(a[1] - b[1]) > eps) continue;
    const y = (a[1] + b[1]) / 2;
    for (const band of bands) {
      if (y < band.top - eps || y > band.bottom + eps) continue;
      const run = Math.abs(b[0] - a[0]);
      if (run > bestRun) {
        bestRun = run;
        best = band;
      }
    }
  }
  return best;
}

// Bus chips that have left the tinted band their lane runs in. `escapes` are
// the VERTICAL escapes -- the box shares no y with the band at all, which is
// what a reader sees as a rate chip floating above / below the tint. A chip
// touching the band edge counts as inside (the pad covers exactly one cascade
// pitch, so containment has to be inclusive or the covered case reads as an
// escape). `xOverflows` are reported alongside but kept OUT of the ratchet: a
// box wider than the band's own x-run is a different, milder shape than a chip
// off the lane entirely.
export function auditBusChipsOutsideBand(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<{ id: string; d: string }>,
  bands: ReadonlyArray<BandRect>,
  eps = 0.5,
): { escapes: ChipCensusHit[]; xOverflows: ChipCensusHit[] } {
  const escapes: ChipCensusHit[] = [];
  const xOverflows: ChipCensusHit[] = [];
  if (bands.length === 0) return { escapes, xOverflows };
  const pathById = new Map<string, string>();
  for (const e of edges) pathById.set(e.id, e.d);
  for (const chip of chips) {
    if (chip.kind === "label") continue;
    const d = pathById.get(chip.edgeId);
    if (d === undefined) continue;
    const band = laneBandOf(d, bands, eps);
    if (band === null) continue;
    const overlapY =
      Math.min(chip.bottom, band.bottom) - Math.max(chip.top, band.top);
    if (overlapY <= eps) {
      escapes.push(
        censusHit(
          chip,
          `box [${chip.top.toFixed(0)},${chip.bottom.toFixed(0)}] is outside ` +
            `${band.testId} [${band.top.toFixed(0)},${band.bottom.toFixed(0)}]`,
        ),
      );
    }
    if (chip.left < band.left - eps || chip.right > band.right + eps) {
      xOverflows.push(
        censusHit(
          chip,
          `box [${chip.left.toFixed(0)},${chip.right.toFixed(0)}] overruns ` +
            `${band.testId} [${band.left.toFixed(0)},${band.right.toFixed(0)}] in x`,
        ),
      );
    }
  }
  return { escapes, xOverflows };
}
