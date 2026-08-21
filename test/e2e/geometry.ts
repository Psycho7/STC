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
import { chipEntersOwnCardBody } from "../../src/canvas/chipSeating";

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
