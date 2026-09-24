// Pure geometry helpers for the P2 placement audit (geometry-audit.spec.ts).
//
// The browser side (collectGeometry, inlined in the spec) hands back, in flow /
// graph coordinates, every edge's parsed path polyline plus every node's raw
// (unpadded) card rect. Everything here is a pure function of that snapshot, so
// the same code scores the current build and the recorded pre-P2 baseline. Node
// import: the padding constants come straight from the routing source so a card
// rect built here matches paddedObstacles' `card` rect by construction.

import {
  CHAMFER,
  CHIP_CARD_CLEARANCE,
  PORT_STUB,
} from "../../src/canvas/edgePath";
import {
  CATALYST_BLOCK_GAP,
  ENTRY_GUTTER_OVERHANG,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_WIDTH,
  recipeHeight,
} from "../../src/canvas/dimensions";
import { ENV_ROW_HEIGHT } from "../../src/canvas/envBanner";
import { RESERVE_COLUMN_PAD } from "../../src/canvas/layerModel";
import {
  CARD_BORDER,
  PORT_ZONE_DEPTH,
  cardGrowth,
  chipEntersOwnCardBody,
} from "../../src/canvas/chipSeating";
// properCross / properCrossPoint and the point-distance helpers live in
// src/canvas/crossings.ts since the exam-surfaced Task 9 crossing-cue work:
// the render layer's cue stamp pass, its liveness filter, and this audit's
// crossing census share one definition instead of two copies that happen to
// agree. Imported for the census / coverage below and re-exported so the
// audits' existing imports are unchanged. clipSegmentToBox joins them for the
// same reason: the rect clip below and chipSeating's chip-box clip are one
// function, not two copies that happen to agree.
import {
  clipSegmentToBox,
  pointSegDistance,
  pointToPolylineDistance,
  properCross,
  properCrossPoint,
} from "../../src/canvas/crossings";
export { properCross, properCrossPoint, pointToPolylineDistance };

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

// Clip segment p0->p1 against the OPEN interior of `rect` shrunk by eps (so a
// run grazing the padded boundary -- cleared runs sit a chamfer outside it --
// is not a hit). Returns the clipped parameter window [t0, t1], or null when
// the segment misses or only touches. The clip is crossings.ts's
// clipSegmentToBox, the same one chipSeating's chip boxes are cleared with, so
// the seat and the audit that scores it cannot disagree about what a box
// contains; only the eps shrink is this audit's own.
function clipWindow(
  p0: Pt,
  p1: Pt,
  rect: RawRect,
  eps: number,
): [number, number] | null {
  return clipSegmentToBox(p0[0], p0[1], p1[0], p1[1], {
    left: rect.left + eps,
    right: rect.right - eps,
    top: rect.top + eps,
    bottom: rect.bottom - eps,
  });
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
// meeting at a shared port are not miscounted as crossings. The definition
// itself now lives in src/canvas/crossings.ts (see the import above); the
// census calls it through this module's re-export unchanged.

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

// One drawn crossing cue: the background-coloured disk an edge's renderer
// emits where its polyline properly crosses a different flow's, keyed to the
// owning edge id (the React Flow edge group the circle lives in) and carrying
// its centre in graph coordinates (the SVG cx/cy attributes, already in the
// same frame as the path `d` strings). This is the shape collectGeometry
// hands back for every [data-testid="edge-crossing-cue"] element.
export type CrossingCue = { edgeId: string; x: number; y: number };

export type CrossingCoverage = {
  // Counted crossings (properCross, different edges) whose two edges carry
  // DIFFERENT flowKeys (item|source) -- the pairs the seating pass stamps a
  // cue on, because two different flows crossing is what a bare X would
  // misread as a merge.
  crossFlow: number;
  // Of those, the crossings whose point carries a cue on the pair edge that
  // paints ABOVE -- the larger (group z-index, DOM order) key, the SAME key
  // React Flow computes (each edge renders in its own <svg style={{zIndex}}>
  // and CSS z beats DOM order) and the same owner rule the seating pass
  // stamps by. That edge's renderer is the only one that can erase the
  // z-beneath stroke around the point, so the cue must live on IT, not on
  // the beneath edge and not blindly on the later array entry.
  cued: number;
  // Counted crossings between SAME-flowKey edges (a trunk's members, a
  // fanout's slices): one visual line by the flowKey doctrine, deliberately
  // never cued. Reported so a plan where this class suddenly appears is
  // visible in the audit output rather than silently outside the assertion.
  sameFlow: number;
  // Inventory of uncued cross-flow crossings, for the failure message.
  uncued: string[];
};

// Match a counted crossing to a drawn cue WITHOUT demanding the exact computed
// intersection point: the stamps come from the seating pass's reconstructed
// polylines while the census reads the drawn `d` strings, and the two frames
// agree only to the endpoint-parity noise, which a shallow crossing angle
// amplifies along the line. A cue matches when it sits within `eps` of BOTH
// crossing segments -- a cue is always stamped ON both lines, so this stays
// tight while tolerating the frame noise -- and lives on EITHER edge of the
// pair: the seating pass stamps one edge per crossing (the one whose stroke
// is masked out, so the other shows through), and a transparent gap reads
// the same whichever edge paints above, so paint order is not part of the
// contract.
export function crossingCueCoverage(
  edges: ReadonlyArray<{ id: string; d: string }>,
  cues: ReadonlyArray<CrossingCue>,
  eps = 4,
): CrossingCoverage {
  const flowKeyOf = (id: string): string => {
    const parsed = parseEdgeId(id);
    return parsed === null ? id : `${parsed.item}|${parsed.source}`;
  };
  const perEdge = edges.map((e) => segmentsOf(parsePath(e.d)));
  const out: CrossingCoverage = {
    crossFlow: 0,
    cued: 0,
    sameFlow: 0,
    uncued: [],
  };
  for (let i = 0; i < perEdge.length; i++) {
    for (let j = i + 1; j < perEdge.length; j++) {
      const idI = edges[i]!.id;
      const idJ = edges[j]!.id;
      const sameFlow = flowKeyOf(idI) === flowKeyOf(idJ);
      for (const [a, b] of perEdge[i]!) {
        for (const [c, d] of perEdge[j]!) {
          const p = properCrossPoint(a, b, c, d);
          if (p === null) continue;
          if (sameFlow) {
            out.sameFlow++;
            continue;
          }
          out.crossFlow++;
          const matched = cues.some(
            (cue) =>
              (cue.edgeId === idI || cue.edgeId === idJ) &&
              pointSegDistance([cue.x, cue.y], a, b) <= eps &&
              pointSegDistance([cue.x, cue.y], c, d) <= eps,
          );
          if (matched) {
            out.cued++;
          } else {
            out.uncued.push(
              `no cue on ${idI} or ${idJ} at (${p[0].toFixed(1)},${p[1].toFixed(1)})`,
            );
          }
        }
      }
    }
  }
  return out;
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
    if (s !== undefined && s.type !== "group")
      own.push({ card: s, role: "source" });
    if (t !== undefined && t.type !== "group")
      own.push({ card: t, role: "target" });
    if (own.length === 0) continue;
    for (const [seg0, seg1] of segmentsOf(pts)) {
      for (const { card, role } of own) {
        if (segmentEntersRect(seg0, seg1, card, eps)) {
          out.push({
            edgeId: edge.id,
            card: card.nodeId,
            role,
            seg: [seg0, seg1],
          });
        }
      }
    }
  }
  return out;
}

// Frame rides: segments that run ALONG a container slab's border, close enough
// that the stroke and the border read as one line (the
// loop-backedge-braids-container family, #29 follow-on, and the forward jog
// hugging a frame the casebook re-reports). A ride needs a parallel run, so a
// near-border segment counts only when it overlaps the border's own extent by
// more than two port stubs -- a perpendicular crossing or a short corner never
// does. Diagonal chamfers never ride a frame.
//
// The two directions are scored under different rules, because different
// routing levers stand behind them:
//
//   BACKWARD (target at or left of the source, mirroring clampBackwardRails'
//     nodeGap test): both axes, at `tol`. The rail pass keeps a return's
//     verticals CONTAINER_COLUMN_GAP off the side borders (Task 7) and the
//     tolerance matches that constant. The endpoints' own containers are
//     deliberately NOT exempt: a return between two members of one slab is
//     exactly the shape whose columns may hug the frame.
//
//   FORWARD: HORIZONTALS only, at the wider `forwardTol` -- no forward pass
//     takes any container clearance, so what a run holds off a border is
//     whatever the level search left it, and the band at which the two read as
//     one edge of the slab is the whole port stub. Forward VERTICALS stay out:
//     a tap's jog descent may share an entry-gutter line with a container
//     border by convention, so counting them would pin a shape the doctrine
//     declares legal. Two more forward exemptions: the endpoints' own
//     containers (a run leaving a card inside a slab has to travel beside that
//     slab's border), and an edge drawn as ONE straight horizontal from port to
//     port (its level is the row its two ports share, not a choice any pass
//     made).
//
// Pure and deterministic.
export type FrameRideHit = {
  edgeId: string;
  direction: "forward" | "backward";
  // The container node id whose border is ridden.
  target: string;
  border: "left" | "right" | "top" | "bottom";
  seg: [Pt, Pt];
  distance: number;
};

export const FRAME_RIDE_TOL = 16;

// The band a FORWARD horizontal has to hold off a container border. A port stub
// is the shortest run the canvas draws, so a stroke nearer than that to a
// border has no visible corridor of its own between the two.
export const FORWARD_FRAME_RIDE_TOL = PORT_STUB;

// Minimum parallel overlap before a near-border run counts as riding it: two
// port stubs. Port stubs and corner chamfers legitimately touch a border zone
// briefly while crossing or turning; a ride is a long parallel run.
const FRAME_RIDE_MIN_OVERLAP = 2 * PORT_STUB;

// Is the whole polyline one horizontal line? Then both its endpoints are ports
// on that row (an edge starts and ends at a port), so its level is the ports'.
function isStraightRun(pts: ReadonlyArray<Pt>): boolean {
  return pts.length > 1 && pts.every((p) => p[1] === pts[0]![1]);
}

export function auditFrameRides(
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  tol = FRAME_RIDE_TOL,
  forwardTol = FORWARD_FRAME_RIDE_TOL,
  eps = 0.5,
): FrameRideHit[] {
  const nodeById = new Map<string, NodeRect>();
  for (const n of nodes) nodeById.set(n.nodeId, n);
  const containers = nodes.filter(
    (n) => n.type === "group" || n.type === "loop",
  );
  const out: FrameRideHit[] = [];
  for (const edge of edges) {
    const pts = parsePath(edge.d);
    if (pts.length === 0) continue;
    const s = nodeById.get(edge.source);
    const t = nodeById.get(edge.target);
    const backward = s !== undefined && t !== undefined && t.left <= s.right;
    const direction = backward ? "backward" : "forward";
    if (!backward && isStraightRun(pts)) continue;
    const limit = (backward ? tol : forwardTol) - eps;

    const exempt = new Set<string>();
    if (!backward) {
      exempt.add(edge.source);
      exempt.add(edge.target);
      for (const c of containersAt(pts[0]!, nodes)) exempt.add(c);
      for (const c of containersAt(pts[pts.length - 1]!, nodes)) exempt.add(c);
    }
    const push = (
      target: string,
      border: FrameRideHit["border"],
      p0: Pt,
      p1: Pt,
      distance: number,
    ): void => {
      out.push({
        edgeId: edge.id,
        direction,
        target,
        border,
        seg: [p0, p1],
        distance,
      });
    };

    for (const [p0, p1] of segmentsOf(pts)) {
      const vertical = p0[0] === p1[0];
      const horizontal = p0[1] === p1[1];
      if (!vertical && !horizontal) continue; // a chamfer diagonal
      if (vertical) {
        if (!backward) continue; // tap-descent exception
        const yLo = Math.min(p0[1], p1[1]);
        const yHi = Math.max(p0[1], p1[1]);
        const overlapY = (r: { top: number; bottom: number }): number =>
          Math.max(0, Math.min(yHi, r.bottom) - Math.max(yLo, r.top));
        for (const c of containers) {
          if (overlapY(c) <= FRAME_RIDE_MIN_OVERLAP) continue;
          const dl = Math.abs(p0[0] - c.left);
          const dr = Math.abs(p0[0] - c.right);
          if (dl < limit) push(c.nodeId, "left", p0, p1, dl);
          if (dr < limit) push(c.nodeId, "right", p0, p1, dr);
        }
        continue;
      }
      const xLo = Math.min(p0[0], p1[0]);
      const xHi = Math.max(p0[0], p1[0]);
      const overlapX = (r: { left: number; right: number }): number =>
        Math.max(0, Math.min(xHi, r.right) - Math.max(xLo, r.left));
      for (const c of containers) {
        if (exempt.has(c.nodeId)) continue;
        if (overlapX(c) <= FRAME_RIDE_MIN_OVERLAP) continue;
        const dt = Math.abs(p0[1] - c.top);
        const db = Math.abs(p0[1] - c.bottom);
        if (dt < limit) push(c.nodeId, "top", p0, p1, dt);
        if (db < limit) push(c.nodeId, "bottom", p0, p1, db);
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
  // "bus" = bus branch chip (out of scope for the corridor
  // invariants), "bus-drop" = the trunk-seated aggregate chip (audited against
  // foreign cards with a trunk-member exemption), "label" = item rate chip.
  kind: "label" | "bus" | "bus-drop";
  // The chip draws its collapsed (icon-only) variant.
  iconOnly: boolean;
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
//   - same flow (same item AND source): a trunk's members share one line and a
//     fanout's slices share their common trajectory, so a chip on that shared
//     line is on its OWN line even when a sibling edge id owns the segment;
//   - arrival cluster (same target), NARROWED (3a): the bus kinds are always
//     exempt (anchored on their own leg or trunk by design, not on the member
//     edge's path); a label chip is exempt only while its centre sits in the
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
    // Arrival cluster, narrowed: the bus kinds are always exempt (anchored on
    // their own leg or trunk by design); a rate chip is exempt only when its
    // centre lies in the target's entry band.
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
//     the trunk (each a target zone). Trunk membership is topological, so every
//     edge of the owner's (source, item) port is a member whatever its span,
//     matching the seating trunkExempt union.
//   - branch bus chips (kind "bus") stay skipped -- leg-anchored, out of
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
    if (chip.kind === "bus") continue; // branch, leg-anchored, out of scope
    const owner = edgeById.get(chip.edgeId);
    const whole = new Set<string>();
    const zones = new Map<string, "source" | "target">();
    if (owner !== undefined) {
      zones.set(owner.source, "source");
      exemptContainers(owner.source, whole);
      if (chip.kind === "bus-drop") {
        for (const e of edges) {
          if (e.source !== owner.source || e.item !== owner.item) continue;
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
  // The chip's data-testid: one edge can own two chips, so its edge id alone
  // does not name the box a report is about.
  chipId: string;
  chipEdgeId: string;
  chipLabel: string;
  distance: number;
};

// Point-to-segment / point-to-polyline distance now live in
// src/canvas/crossings.ts (re-exported here so this module's existing export
// surface is unchanged): the render layer's cue liveness filter, the seating
// pass, and these audits share one copy. Note the ported length guards -- an
// EMPTY polyline is infinitely far, a LONE point is its own distance -- where
// this module's former private copy returned Infinity for both; real paths
// always carry >= 2 vertices, so the audits' behaviour is unchanged.

// The horizontal segments of a polyline, in order. A chip is a horizontal box,
// so a seat on a vertical or on a chamfer diagonal does not read as a label of
// the run beneath it -- only these segments can carry one.
function horizontalSegmentsOf(pts: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  return segmentsOf(pts).filter(([a, b]) => a[1] === b[1]);
}

// Distance from `p` to the nearest HORIZONTAL segment of this polyline, or
// Infinity when the polyline has none (a pure diagonal or a single vertical --
// there is no run a chip could stand on, so no distance is small enough).
function horizontalRunDistance(p: Pt, pts: ReadonlyArray<Pt>): number {
  let best = Infinity;
  for (const [a, b] of horizontalSegmentsOf(pts)) {
    best = Math.min(best, pointSegDistance(p, a, b));
  }
  return best;
}

// Every chip whose centre does NOT stand on a horizontal segment of its OWN
// edge's polyline -- the placement rule, as a hard invariant rather than a
// measurement. It holds for every chip family the canvas draws: an item edge's
// rate chip on its longest run, a trunk's aggregate chip on the run its members
// share, a member's own chip on the stretch that is the member's alone. All
// three are computed off the drawn polyline by the path builder, so a chip off
// its own runs means a stamp outlived the geometry it was measured on.
//
// `tol` is measurement slack, in graph units: the centre comes from a client
// rect mapped back through the inverse viewport transform while the polyline
// comes from the path's own `d`, and the two agree to well under a unit.
export function auditChipsOnOwnPath(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  tol = 1,
): ChipOffPathViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const out: ChipOffPathViolation[] = [];
  for (const chip of chips) {
    const owner = edgeById.get(chip.edgeId);
    if (owner === undefined) continue;
    const pts = parsePath(owner.d);
    if (pts.length === 0) continue;
    const dist = horizontalRunDistance(centreOf(chip), pts);
    if (dist > tol) {
      out.push({
        chipId: chip.testId,
        chipEdgeId: chip.edgeId,
        chipLabel: chip.label,
        distance: dist,
      });
    }
  }
  return out;
}

// A DRAWN junction dot's box in graph coordinates, tagged with its data-testid
// and its data-family.
export type DotRect = RawRect & { testId: string; family: string };

// The testid prefixes the collector gives a trunk's junction dot: the
// divergence dot of a fan-out, the convergence dot of a fan-in.
const BUS_JUNCTION_PREFIX = "bus-junction-";
const FANIN_JUNCTION_PREFIX = "fanin-junction-";
// The third drawn family: the declined-fan-out divergence dot an ItemEdge owner
// draws where coincident same-flow edges leave their shared out-port run.
const FANOUT_JUNCTION_PREFIX = "fanout-junction-";

// The data-family each of those dots carries.
const FANOUT_FAMILY = "fanout";
const FANIN_FAMILY = "fanin";

// The junction dot x of every edge that draws one of the given family, keyed by
// edge id.
function junctionXByEdge(
  dots: ReadonlyArray<DotRect>,
  prefix: string,
  family: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const dot of dots) {
    if (!dot.testId.startsWith(prefix)) continue;
    if (dot.family !== family) continue;
    out.set(dot.testId.slice(prefix.length), centreOf(dot)[0]);
  }
  return out;
}

// The part of a polyline on one side of a vertical cut, opened AT the cut
// itself rather than at the last vertex before it: taking the whole entering
// segment would hand a chip the part of it that lies on the far side, which is
// the run these counters exist to exclude. Null when the polyline has no vertex
// on that side -- with no stretch to measure against there is nothing to be
// off, so the counter undercounts rather than reporting a false positive.
function polylineBeyond(
  pts: ReadonlyArray<Pt>,
  cut: number,
  side: "right" | "left",
): Pt[] | null {
  if (side === "right") {
    const from = pts.findIndex((p) => p[0] > cut);
    if (from <= 0) return null;
    return [
      interpolateAtX(pts[from - 1]!, pts[from]!, cut),
      ...pts.slice(from),
    ];
  }
  let to = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]![0] < cut) to = i;
    else break;
  }
  if (to < 0 || to >= pts.length - 1) return null;
  return [...pts.slice(0, to + 1), interpolateAtX(pts[to]!, pts[to + 1]!, cut)];
}

// The point at x = `cut` on the segment a -> b (which spans it).
function interpolateAtX(a: Pt, b: Pt, cut: number): Pt {
  const t = (cut - a[0]) / (b[0] - a[0]);
  return [cut, a[1] + t * (b[1] - a[1])];
}

// Every fan-out MEMBER chip whose centre lies farther than `tol` from the
// member's OWN leg. The member's polyline suffix past the trunk junction is not
// the leg: it opens with the descent down the junction column, which every
// member of that fan-out shares, so a chip seated on the column is on its own
// polyline and off its own leg. The leg is the suffix right of the column --
// the horizontal run past it and any bends after that.
//
// The column's x is the junction dot's x plus one CHAMFER, not the dot's x: the
// dot is drawn at the trunk row's divergence corner and the path bevels from
// that corner into the column, so on gas-web the dot reads 641 while the column
// the members descend stands at 649. Cutting at the dot would leave the whole
// column inside the "leg" and the counter would see nothing.
//
// Members are the edges the collector reports a `bus-junction-<edge>` dot with
// family "fanout" for. Both drawn kinds count: a member routed by BusEdge
// carries its chip as kind "bus", and one retyped onto the trunk's column as
// kind "label". The trunk's aggregate chip (kind "bus-drop") is not a member
// chip and rides the shared run by design, so it is left out.
export function auditFanoutChipsOnOwnLeg(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  dots: ReadonlyArray<DotRect>,
  tol = 1,
): ChipOffPathViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const junctionXById = junctionXByEdge(
    dots,
    BUS_JUNCTION_PREFIX,
    FANOUT_FAMILY,
  );

  const out: ChipOffPathViolation[] = [];
  for (const chip of chips) {
    if (chip.kind !== "label" && chip.kind !== "bus") continue;
    const jx = junctionXById.get(chip.edgeId);
    if (jx === undefined) continue;
    const owner = edgeById.get(chip.edgeId);
    if (owner === undefined) continue;

    const leg = polylineBeyond(parsePath(owner.d), jx + CHAMFER, "right");
    if (leg === null) continue;

    const dist = pointToPolylineDistance(centreOf(chip), leg);
    if (dist > tol) {
      out.push({
        chipId: chip.testId,
        chipEdgeId: chip.edgeId,
        chipLabel: chip.label,
        distance: dist,
      });
    }
  }
  return out;
}

// The fan-in mirror of the counter above, on the edges that draw a
// `fanin-junction-<edge>` dot with family "fanin". A fan-in's members reach one
// target port along one shared leg, so the two chips of the structure sit on
// opposite sides of the convergence dot:
//   member chip (kinds "bus" and "label") on its OWN source stub, the prefix
//     LEFT of the column -- everything right of it is the shared leg;
//   aggregate chip (kind "bus-drop") on the leg INTO the target, the suffix
//     right of the dot, which is the stretch the trunk shares and the one its
//     total labels.
// The cut mirrors the fan-out's: the dot is drawn one chamfer PAST the column
// on the target row, so the members' own stubs end one chamfer before it.
export function auditFaninChipsOnOwnLeg(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  dots: ReadonlyArray<DotRect>,
  tol = 1,
): ChipOffPathViolation[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const junctionXById = junctionXByEdge(
    dots,
    FANIN_JUNCTION_PREFIX,
    FANIN_FAMILY,
  );

  const out: ChipOffPathViolation[] = [];
  for (const chip of chips) {
    const jx = junctionXById.get(chip.edgeId);
    if (jx === undefined) continue;
    const owner = edgeById.get(chip.edgeId);
    if (owner === undefined) continue;

    const pts = parsePath(owner.d);
    const part =
      chip.kind === "bus-drop"
        ? polylineBeyond(pts, jx, "right")
        : polylineBeyond(pts, jx - CHAMFER, "left");
    if (part === null) continue;

    const dist = pointToPolylineDistance(centreOf(chip), part);
    if (dist > tol) {
      out.push({
        chipId: chip.testId,
        chipEdgeId: chip.edgeId,
        chipLabel: chip.label,
        distance: dist,
      });
    }
  }
  return out;
}

// One inter-layer gap's reserve model, in absolute graph x, as the exam hook
// reports it and the collector passes it through: a chip zone flush against
// each side's cards with the trunk columns between them.
export type GapZones = {
  index: number;
  left: number;
  right: number;
  sourceZone: { left: number; right: number };
  columnZone: { left: number; right: number };
  targetZone: { left: number; right: number };
};

// One trunk chip resolved to the room the placement rule charged it to: the
// chip, the reserve zone it must stand in, and its trunk's junction dot.
export type TrunkChipSeat = {
  chip: ChipRect;
  side: "source" | "target";
  zone: { left: number; right: number };
  dot: Pt;
};

// Is a fan-in convergence dot standing ON this polyline? That is what makes a
// fan-out member a DUAL member -- it hands its flow to a fan-in column before
// reaching the target, so the stretch that is its own ends at that column and
// lies in the gap's COLUMN zone, not in either chip reserve. The rule does not
// place such a chip, so the reserve audit leaves it alone. The geometry is the
// only hook there is: the dot belongs to a sibling edge, and nothing in the DOM
// says the two are joined.
function handsOverToFanin(
  pts: ReadonlyArray<Pt>,
  faninDots: ReadonlyArray<DotRect>,
  tol: number,
): boolean {
  return faninDots.some(
    (dot) => pointToPolylineDistance(centreOf(dot), pts) <= tol,
  );
}

// Every trunk chip paired with the gap reserve it belongs in. Which side that
// is follows the PORT the chip labels, which for a member reaching two layers
// over is not the gap its trunk column stands in:
//   fan-out aggregate  the source port's zone (it labels the whole port's flow
//                      leaving that card);
//   fan-out member     the target port's zone (its own leg arrives there);
//   fan-in member      the source port's zone (its own stub leaves there);
//   fan-in aggregate   the target port's zone (it labels the merged arrival).
// A chip whose port sits on a layer boundary rather than inside a gap, and a
// dual fan-out member (see above), resolve to no reserve and are left out.
export function trunkChipSeats(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  dots: ReadonlyArray<DotRect>,
  gaps: ReadonlyArray<GapZones>,
  tol = 1,
): TrunkChipSeat[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const fanoutX = junctionXByEdge(dots, BUS_JUNCTION_PREFIX, FANOUT_FAMILY);
  const faninX = junctionXByEdge(dots, FANIN_JUNCTION_PREFIX, FANIN_FAMILY);
  const dotByTestId = new Map(dots.map((d) => [d.testId, d] as const));
  const faninDots = dots.filter((d) => d.family === FANIN_FAMILY);

  const out: TrunkChipSeat[] = [];
  for (const chip of chips) {
    if (chip.kind !== "bus" && chip.kind !== "bus-drop") continue;
    const owner = edgeById.get(chip.edgeId);
    if (owner === undefined) continue;
    const fanout = fanoutX.has(chip.edgeId);
    const fanin = faninX.has(chip.edgeId);
    if (fanout === fanin) continue; // no dot, or one of each: not a trunk chip
    const dot = dotByTestId.get(
      (fanout ? BUS_JUNCTION_PREFIX : FANIN_JUNCTION_PREFIX) + chip.edgeId,
    );
    if (dot === undefined) continue;

    const pts = parsePath(owner.d);
    if (pts.length === 0) continue;
    const aggregate = chip.kind === "bus-drop";
    if (fanout && !aggregate && handsOverToFanin(pts, faninDots, tol)) continue;

    const side: "source" | "target" =
      fanout === aggregate ? "source" : "target";
    const portX = (side === "source" ? pts[0]! : pts[pts.length - 1]!)[0];
    const gap = gaps.find((g) => portX > g.left && portX < g.right);
    if (gap === undefined) continue;

    out.push({
      chip,
      side,
      zone: side === "source" ? gap.sourceZone : gap.targetZone,
      dot: centreOf(dot),
    });
  }
  return out;
}

// Trunk chips standing outside the reserve they were charged to, and trunk
// chips standing on their own trunk's junction dot. Both are hard invariants of
// the reserve model: layerModel widens every gap to hold exactly these boxes,
// so a chip outside its zone is standing in room reserved for something else,
// and the model's column-side pad is the clearance the chip owes the dot
// (cleared on EITHER axis -- a chip a row away from the dot owes it nothing in
// x). `tol` is the same measurement slack the on-line audits carry.
export function auditTrunkChipReserves(
  seats: ReadonlyArray<TrunkChipSeat>,
  tol = 1,
): { outside: ChipCensusHit[]; onDot: ChipCensusHit[] } {
  const outside: ChipCensusHit[] = [];
  const onDot: ChipCensusHit[] = [];
  for (const seat of seats) {
    const { chip, zone } = seat;
    if (chip.left < zone.left - tol || chip.right > zone.right + tol) {
      outside.push(
        censusHit(
          chip,
          `box [${chip.left.toFixed(1)}, ${chip.right.toFixed(1)}] leaves its ` +
            `${seat.side} reserve [${zone.left.toFixed(1)}, ${zone.right.toFixed(1)}]`,
        ),
      );
    }
    const [cx, cy] = centreOf(chip);
    const clearsX =
      Math.abs(seat.dot[0] - cx) >=
      (chip.right - chip.left) / 2 + RESERVE_COLUMN_PAD - tol;
    const clearsY =
      Math.abs(seat.dot[1] - cy) >=
      (chip.bottom - chip.top) / 2 + RESERVE_COLUMN_PAD - tol;
    if (!clearsX && !clearsY) {
      onDot.push(
        censusHit(
          chip,
          `stands ${Math.abs(seat.dot[0] - cx).toFixed(1)} x ` +
            `${Math.abs(seat.dot[1] - cy).toFixed(1)} from its junction dot at ` +
            `(${seat.dot[0].toFixed(1)}, ${seat.dot[1].toFixed(1)}), inside the ` +
            `${RESERVE_COLUMN_PAD} column pad`,
        ),
      );
    }
  }
  return { outside, onDot };
}

// Foreign strokes running through a reserve zone at a seated chip's row: the
// zone's full x-range by the y-extent of the chip standing in it. The reserve
// is room the gap was widened for, so a stroke of another flow crossing it is
// a line drawn through a chip's own room -- the same misread as a stroke
// through the box, one zone wider. Foreignness is chipForeignTo, shared with
// the chip-box counters so no stroke can be foreign to one and waived here.
export function auditReserveZoneStrokes(
  seats: ReadonlyArray<TrunkChipSeat>,
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  eps = 0.5,
): ChipCensusHit[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const cardById = new Map<string, RawRect>();
  for (const n of nodes) cardById.set(n.nodeId, n);
  const out: ChipCensusHit[] = [];
  for (const seat of seats) {
    const box: RawRect = {
      left: seat.zone.left,
      right: seat.zone.right,
      top: seat.chip.top,
      bottom: seat.chip.bottom,
    };
    const through: string[] = [];
    for (const edge of edges) {
      if (!chipForeignTo(seat.chip, edge, edgeById, cardById)) continue;
      const pts = parsePath(edge.d);
      if (pts.length === 0) continue;
      if (segmentsOf(pts).some(([a, b]) => segmentEntersRect(a, b, box, eps))) {
        through.push(edge.id);
      }
    }
    if (through.length > 0) {
      out.push(
        censusHit(
          seat.chip,
          `${through.length} foreign stroke(s) through its ${seat.side} ` +
            `reserve [${seat.zone.left.toFixed(1)}, ${seat.zone.right.toFixed(1)}]: ` +
            through.join(", "),
        ),
      );
    }
  }
  return out;
}

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

// Half the widest stroke the canvas draws, in SCREEN pixels: ItemEdge clamps a
// zoom-compensated edge width to 3 physical px. A stroke whose centreline sits
// just outside a dot's disc still paints ink inside it, so the reach of a disc
// is its radius plus this.
const HALF_STROKE_PX = 1.5;

// One junction dot with a foreign flow's stroke inside its disc.
export type DotStrokeHit = {
  dotId: string;
  // The dot's centre, so a report can name WHERE it is.
  at: Pt;
  // Every foreign edge whose polyline reaches into the disc, and the nearest
  // one's distance from the centre.
  strokes: string[];
  distance: number;
};

// The edge a dot is drawn for, and the side of the flow its trunk is keyed by.
// A split dot (the fan-out column's, the declined fan-out's divergence dot) is
// shared by every edge leaving the same port, so the trunk is item + source; a
// merge dot is shared by every edge reaching one port, so it is item + target.
//
// A blind spot rides on that keying. Edge ids carry no port, so a merge dot's
// own trunk is item + target unit only. A card fed one item on both its raw
// row and its catalyst row makes each of the two edges count as the other's
// own trunk, so a catalyst line crossing the raw row's merge-dot disc is
// exempted instead of counted. It can only suppress a hit, never invent one,
// so a zero in DOT_FOREIGN_STROKE_BASELINE does not cover that shape. Keying
// by port would need the port threaded through collect.ts, which reads edges
// as id + d only -- out of scope here.
const DOT_TRUNK_SIDE: ReadonlyArray<readonly [string, "source" | "target"]> = [
  [BUS_JUNCTION_PREFIX, "source"],
  [FANOUT_JUNCTION_PREFIX, "source"],
  [FANIN_JUNCTION_PREFIX, "target"],
];

function dotTrunkOf(
  dot: DotRect,
  edgeById: ReadonlyMap<string, RawEdge>,
): { edge: RawEdge; side: "source" | "target" } | null {
  for (const [prefix, side] of DOT_TRUNK_SIDE) {
    if (!dot.testId.startsWith(prefix)) continue;
    const edge = edgeById.get(dot.testId.slice(prefix.length));
    if (edge === undefined) return null;
    return { edge, side };
  }
  return null;
}

// Every junction dot with a stroke of a DIFFERENT flow inside its disc. A dot
// says "these lines are one flow meeting": a foreign stroke passing through it
// is read as a member of the merge or the split it marks, which is a join the
// plan does not have. The dot's own trunk is exempt by construction -- the
// lines it marks are what it is drawn on.
//
// The disc is measured AS DRAWN (collected from the DOM), so it already carries
// the zoom-clamped radius at this camera; `fitZoom` only converts the
// half-stroke allowance into the graph frame the rects live in. COINCIDENT dots
// count once: every member of one trunk draws the same split point, and the
// reader sees one dot there.
export function auditDotsOnForeignStrokes(
  dots: ReadonlyArray<DotRect>,
  edges: ReadonlyArray<RawEdge>,
  fitZoom: number,
  halfStrokePx = HALF_STROKE_PX,
): DotStrokeHit[] {
  const edgeById = new Map<string, RawEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  const halfStroke = halfStrokePx / fitZoom;
  const out: DotStrokeHit[] = [];
  const seen = new Set<string>();
  for (const dot of dots) {
    const centre = centreOf(dot);
    const key = `${Math.round(centre[0])}|${Math.round(centre[1])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const trunk = dotTrunkOf(dot, edgeById);
    if (trunk === null) continue;
    const reach = (dot.right - dot.left) / 2 + halfStroke;

    const strokes: string[] = [];
    let nearest = Infinity;
    for (const edge of edges) {
      if (
        edge.item === trunk.edge.item &&
        edge[trunk.side] === trunk.edge[trunk.side]
      ) {
        continue; // the dot's own trunk
      }
      const pts = parsePath(edge.d);
      if (pts.length === 0) continue;
      const d = pointToPolylineDistance(centre, pts);
      if (d > reach) continue;
      strokes.push(edge.id);
      nearest = Math.min(nearest, d);
    }
    if (strokes.length > 0) {
      out.push({ dotId: dot.testId, at: centre, strokes, distance: nearest });
    }
  }
  return out;
}

// One crossing cue the reader cannot see.
export type HiddenCueHit = {
  // The edge group the cue's circle lives in.
  edgeId: string;
  at: Pt;
  // What covers it, chip testid or dot testid.
  hiddenBy: string;
};

// Every drawn crossing cue whose centre lies under a chip box or inside a
// junction dot's disc. The cue is the gap that says "crossing, not a merge";
// both chips and dots paint over it (they are opaque boxes in the
// edgelabel-renderer layer, above the edge SVGs), so a cue under one leaves a
// bare X -- or worse, a dot exactly where the two flows cross, which reads as
// the merge the cue exists to deny. This is the measurement the #131 "cue mask
// stays" ruling assumed and never had.
export function auditHiddenCues(
  cues: ReadonlyArray<CrossingCue>,
  chips: ReadonlyArray<ChipRect>,
  dots: ReadonlyArray<DotRect>,
): HiddenCueHit[] {
  const out: HiddenCueHit[] = [];
  for (const cue of cues) {
    const at: Pt = [cue.x, cue.y];
    const chip = chips.find((c) => centreInRect(at, c));
    if (chip !== undefined) {
      out.push({
        edgeId: cue.edgeId,
        at,
        hiddenBy: `chip ${chip.testId} ("${chip.label}")`,
      });
      continue;
    }
    const dot = dots.find((d) => {
      const centre = centreOf(d);
      return (
        Math.hypot(at[0] - centre[0], at[1] - centre[1]) <=
        (d.right - d.left) / 2
      );
    });
    if (dot !== undefined) {
      out.push({ edgeId: cue.edgeId, at, hiddenBy: `dot ${dot.testId}` });
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
  // Items on the card's catalyst rows, which carry a `cat:<item>` port of their
  // own. They sit below every in: row, so no in: port's y depends on them and
  // their own row index is inPorts.length + the item's index here.
  catPorts: ReadonlyArray<string>;
  // Catalyst rows on the card. They add a row of height each, so every height
  // rebuilt here counts them alongside inPorts.
  catalystRows: number;
  // The card draws the environment plate. It is the card's first row, so it
  // adds ENV_ROW_HEIGHT to the height and shifts every row y below it.
  envPlate: boolean;
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
// lists carry in model order. A catalyst row also clears the half-row gap that
// opens the catalyst block, exactly as catHandleYs does, and an environment
// card's rows all sit one plate row lower: the plate is the card's first row,
// above the header.
function recipeRowY(
  rowIndex: number,
  belowBlockGap = false,
  envPlate = false,
): number {
  return (
    (envPlate ? ENV_ROW_HEIGHT : 0) +
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD +
    rowIndex * RECIPE_ROW_HEIGHT +
    RECIPE_ROW_HEIGHT / 2 +
    (belowBlockGap ? CATALYST_BLOCK_GAP : 0)
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

// Row index of one edge endpoint on a recipe card. A source resolves in
// outPorts; a target resolves in inPorts, except a catalyst edge, which lands on
// the row's own `cat:<item>` port -- catalyst rows sit below every in: row, so
// that index is inPorts.length + the item's index in catPorts. -1 when the item
// names no row on that side.
//
// Nothing in the DOM says which port kind an edge landed on: React Flow stamps
// the edge id on the path and no handle id anywhere, and the id itself encodes
// only source, target, and item. One card CAN carry the same item on an in: row
// and on a catalyst row (a phase transmuter cycling the gas it also consumes),
// which leaves two candidate rows for the two edges that arrive. The audit then
// takes the candidate the drawn endpoint is nearer to, so it still proves the
// endpoint sits on a legitimate row within the tolerance while being unable to
// tell those two rows apart on that one card.
function rowIndexOf(
  node: PortedNode,
  end: "source" | "target",
  item: string,
  drawnY: number,
  driftDy: number,
): number {
  if (end === "source") return node.outPorts.indexOf(item);

  const inRow = node.inPorts.indexOf(item);
  const catAt = node.catPorts.indexOf(item);
  if (catAt < 0) return inRow;

  const catRow = node.inPorts.length + catAt;
  if (inRow < 0) return catRow;

  const offBy = (row: number): number =>
    Math.abs(
      node.top +
        recipeRowY(row, row >= node.inPorts.length, node.envPlate) +
        driftDy -
        drawnY,
    );
  return offBy(catRow) < offBy(inRow) ? catRow : inRow;
}

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
// residue is documented noise (the stamp-staleness comment in crossings.ts),
// which is why
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
      const rowIndex = isRecipe
        ? rowIndexOf(node, end, edge.item, drawn[1], drift.dy)
        : -1;
      const modelHeight = isRecipe
        ? recipeHeight(
            node.inPorts.length + node.catalystRows,
            node.outPorts.length,
            node.catalystRows > 0,
            node.envPlate,
          )
        : node.bottom - node.top;
      // A target row past the in: rows is a catalyst row, so it sits below the
      // block gap; a source row indexes the out: column, which has none.
      const belowBlockGap = end === "target" && rowIndex >= node.inPorts.length;
      // portOffsetY falls back to the card's vertical centre for an unresolved
      // item / node kind, and driftedPortY leaves that fallback undrifted.
      const localY =
        rowIndex >= 0
          ? recipeRowY(rowIndex, belowBlockGap, node.envPlate) + drift.dy
          : modelHeight / 2;
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
// An environment recipe needs no separate term: its plate is the card's first
// row, so recipeHeight charges the model box for it and the DOM box carries
// it too. That makes the comparison below the check that the plate really is
// in flow -- a plate drawn outside the card's layout would show up here as a
// height mismatch on every environment card.
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
      recipeHeight(
        n.inPorts.length + n.catalystRows,
        n.outPorts.length,
        n.catalystRows > 0,
        n.envPlate,
      ) + growth;
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
// Three counters over the SAME collected snapshot as the audits above, taken at
// a fixed reading zoom instead of fit zoom (the spec's own describe explains the
// camera). They exist because the fit camera draws far fewer chips than a reader
// ever sees: every chip below the digits gate is collapsed and every chip below
// the mount gate is absent, so a fit-zoom count of a dense plan measures almost
// nothing. Each counter covers ALL chip kinds and counts CHIPS, not
// (chip, other) pairs: the census asks how many SEATS a reader would find wrong,
// and a chip crossed by four foreign strokes is one bad seat, not four.
//
// The counters are deliberately not the same criteria as the tiers above -- they
// are depth-based (how far past a card border) and per-chip -- so a seat can be
// legal there and counted here. Where the two DO overlap (foreign-stroke vs
// CHIP_SEGMENT_BASELINE) the waiver set is literally shared, so the two can
// never move in opposite directions for one seat.
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

// The intrusion budget a chip box may spend inside a node card: the port-side
// strip a chip on its own line necessarily covers. chipEntersOwnCardBody is a
// CENTRE test; this census is a BOX-depth test using the same budget number but
// different rule. Centre-legal wide-box seats are counted here by design (F1
// family: a chip whose centre is in the port strip but whose box overlaps the
// card body past the budget).
export const CARD_INTRUSION_BUDGET = CARD_BORDER + PORT_ZONE_DEPTH;

// A chip seated on the port line sits EXACTLY the budget deep, so its depth
// reads 9 give or take the float noise the screen-to-model conversion picks up
// from the camera's subpixel translate (1e-5 either way). Without a tolerance
// the same chip flips in and out of the census between loads.
export const CARD_INTRUSION_EPS = 1e-3;

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
      const dx =
        Math.min(chip.right, card.right) - Math.max(chip.left, card.left);
      const dy =
        Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
      if (dx <= 0 || dy <= 0) continue;
      const depth = Math.min(dx, dy);
      if (worst === null || depth > worst.depth) {
        worst = { card: card.nodeId, depth };
      }
    }
    if (worst !== null && worst.depth > budget + CARD_INTRUSION_EPS) {
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

// Every chip whose box stands closer than CHIP_CARD_CLEARANCE to a machine
// card that is not one of its own endpoints'. The clearance is the same
// constant the seating slide holds (imported, never duplicated), so this
// counter reads the seated picture against the rule that seated it. A chip's
// own endpoint cards are exempt -- a trunk chip stands in the reserve beside
// the port it labels -- and so is every card a trunk-seated aggregate chip's
// fan feeds (kind "bus-drop" labels a whole fan-out). Container slabs are
// excluded like everywhere above. GAP, not depth: the rule is symmetric for a
// box merely clear of the border (a flush seat reads as the card's label) and
// one buried in it, and the gap of an overlapping pair comes out negative, so
// both count.
export function auditChipNearCard(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  nodes: ReadonlyArray<NodeRect>,
  clearance = CHIP_CARD_CLEARANCE,
  eps = CARD_INTRUSION_EPS,
): ChipCensusHit[] {
  const cards = nodes.filter((n) => n.type !== "group");
  const edgeById = new Map(edges.map((e) => [e.id, e] as const));
  const out: ChipCensusHit[] = [];
  for (const chip of chips) {
    const own = edgeById.get(chip.edgeId);
    if (own === undefined) continue;
    const ownCards = new Set([own.source, own.target]);
    if (chip.kind === "bus-drop") {
      for (const e of edges) {
        if (e.source === own.source && e.item === own.item)
          ownCards.add(e.target);
      }
    }
    let nearest: { card: string; gap: number } | null = null;
    for (const card of cards) {
      if (ownCards.has(card.nodeId)) continue;
      const gap = Math.max(
        card.left - chip.right,
        chip.left - card.right,
        card.top - chip.bottom,
        chip.top - card.bottom,
      );
      if (nearest === null || gap < nearest.gap)
        nearest = { card: card.nodeId, gap };
    }
    if (nearest !== null && nearest.gap < clearance - eps) {
      out.push(
        censusHit(
          chip,
          `stands ${nearest.gap.toFixed(1)} from card ${nearest.card} (clearance ${clearance})`,
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
// segment) and the reach: this one is not restricted to any chip kind, so a
// branch chip lying across someone else's column shows up here.
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
      if (
        segmentsOf(pts).some(([a, b]) => segmentEntersRect(a, b, chip, eps))
      ) {
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

// One piece of drawn port furniture (a handle, a PortGlyph span, or an .rn-row
// strip), keyed to its owning card.
export type PortFurnitureRect = RawRect & {
  nodeId: string;
  kind: "handle" | "glyph" | "row";
};

// Chips whose drawn box covers a piece of their own endpoint card's port
// furniture. Every chip kind counts, once however many pieces it covers; a
// chip whose edge id does not parse is skipped. Target state: zero.
export function auditChipPortCover(
  chips: ReadonlyArray<ChipRect>,
  edges: ReadonlyArray<RawEdge>,
  furniture: ReadonlyArray<PortFurnitureRect>,
  eps = 0.5,
): ChipCensusHit[] {
  const edgeById = new Map(edges.map((e) => [e.id, e] as const));
  const out: ChipCensusHit[] = [];
  for (const chip of chips) {
    const own = edgeById.get(chip.edgeId);
    if (own === undefined) continue;
    const covered: string[] = [];
    for (const f of furniture) {
      if (f.nodeId !== own.source && f.nodeId !== own.target) continue;
      if (rectsOverlap(chip, f, eps)) {
        covered.push(
          `${f.kind} of its own ${f.nodeId === own.source ? "source" : "target"} card ${f.nodeId}`,
        );
      }
    }
    if (covered.length > 0)
      out.push(censusHit(chip, `covers the ${covered.join(", ")}`));
  }
  return out;
}

// One pair of chip boxes standing on each other, in world units.
export type ChipOverlapPair = {
  aId: string;
  aLabel: string;
  bId: string;
  bLabel: string;
  // How deep the two interpenetrate on each axis.
  dx: number;
  dy: number;
};

// Every pair of chip boxes that interpenetrate by more than `eps` on BOTH axes.
// PAIRS, not chips: a collision is a relation between two seats and the report
// has to name both, and the node-side pin this mirrors
// (test/canvas/chipOverlap.corpus.test.ts) counts the same way.
//
// Two chips overlapping do not read as two labels -- the reader gets one smeared
// figure and cannot tell which line either figure belongs to -- so the target is
// zero on every plan. Every chip kind counts: the reader does not know which of
// two boxes is a trunk aggregate and which an item rate.
//
// Abutment is not overlap: the trunk chip pitch equals the chip box height, so
// two chips one above the other legitimately share a boundary.
export function auditChipBoxOverlaps(
  chips: ReadonlyArray<ChipRect>,
  eps = 0.5,
): ChipOverlapPair[] {
  const out: ChipOverlapPair[] = [];
  for (let i = 0; i < chips.length; i++) {
    for (let j = i + 1; j < chips.length; j++) {
      const a = chips[i]!;
      const b = chips[j]!;
      const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (dx <= eps || dy <= eps) continue;
      out.push({
        aId: a.testId,
        aLabel: a.label,
        bId: b.testId,
        bLabel: b.label,
        dx,
        dy,
      });
    }
  }
  return out;
}
