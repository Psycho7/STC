// Chip seating: the whole-graph de-confliction pass that places every
// edge-label chip (bus drop/rise chips, fan-out chips, item rate chips) after
// routing has finished, plus the clearance machinery it runs on.
//
// Two coincident chips read as one, and on a bus lane the surviving chip lied
// about the flow. deconflictChipAnchors runs last in the render pipeline
// (after routeBusEdges, assignEntryColumns, and assignBendColumns, so it sees
// the final laneY, entryX and bendX; busChipX it takes as routeBusEdges left it
// and REWRITES, clamping each member's slot into its own resolved lane run)
// and threads chip-nudge offsets
// onto edge data through one shared collision set (the ClearanceField).
//
// Seating runs in EXPLICIT PHASES, in this order -- the ordering is
// load-bearing, not incidental, so keep it explicit rather than folding it
// into a generic priority framework:
//   0. junction-dot geometry: the four dot families (lane bus branch, fan-out
//      trunk split, fan-in merge, declined-fan-out divergence) are pure
//      functions of the reconstructed polylines, so they all resolve before the
//      first chip seats and every seating phase runs against a known dot set.
//   1. bus drop chips: one aggregate total per trunk at its junction; they
//      settle before any rise so a cascading rise can never knock a trunk's
//      aggregate off its lane.
//   2. bus rise chips: per-member lane chips, cascading off the lane (down in
//      the bottom band, up in the top band) when crowded.
//   3. fan-out trunk chips: the owner's aggregate on the shared trunk, then
//      each member's branch chip on its own leg.
//   4. item rate chips: seated on their own polyline's clear segment by
//      seatRateChip, yielding to everything placed before them.
// Within each phase, edges are processed in edge-id (or target-map insertion)
// order, so the whole pass is pure and deterministic.
//
// Phase boundaries, measured rather than assumed -- the phases are NOT separable
// modules. No seating phase reads another seating phase's accumulator: the 13
// index maps phases 1/2, 3 and 4 write between them flow only to the emit loop
// at the end of deconflictChipAnchors. Their sole coupling is field.placed --
// every seat tests overlapsChip against everything seated so far -- so the phase
// order is a PRIORITY order, not a data dependency: reordering changes which
// chip keeps a contested position and which one yields its seat at the rollback
// sites. The one accumulator that crosses backwards is faninChipHiddenByIndex,
// declared with the phase 0a state and written in phase 4. The wide-reach region
// is the reconstruction that runs before phase 0, whose geometry maps every
// later phase reads -- not any seating phase. So a phase seam would carry only
// field.placed, to exactly one caller each, and would turn the ordering the
// compiler guarantees here into a call-site convention.
//
// Escapes follow the ratified priority order: chip-vs-chip and chip-vs-CARD
// clearance are HARD invariants; staying on the own polyline and clearing
// foreign flow lines are preferences that yield when the hard pair forces an
// escape. Keeping off a junction dot (#50) is a SOFT preference throughout: it
// never costs a chip its tier, its line, or a foreign-line clearance. Where it
// ranks against the other soft terms depends on the tier, and the two orders
// differ: within tier 1 the dot count outranks own-card intrusion (measured --
// ranking intrusion first buries more split dots for a handful of shallow card
// laps), while in the graze scorer the dot is the LAST tiebreak, under
// crossings, then intrusion, then binding.

import type { Edge } from "@xyflow/react";

import {
  CHIP_BOX_HEIGHT,
  DOT_KEEPOFF,
  GLYPH_SIDE_OFFSET,
  HIDE_STALE_EPS,
  MAX_CHIP_SCALE,
} from "./dimensions";
import {
  CHAMFER,
  branchLegAfterJunction,
  chamferBusPath,
  chamferFanoutPath,
  chamferStepPath,
  clamp,
  forwardStepGeometry,
  parsePathPoints,
  pathPointAtPts,
  routingHintsFromData,
} from "./edgePath";
import {
  clipSegmentToBox,
  pointSegDistance,
  pointToPolylineDistance,
  properCrossPoint,
  type CrossingCue,
  type CrossingCuePartner,
} from "./crossings";
import {
  BUS_LONG_RUN_THRESHOLD,
  ENTRY_SLOT_PITCH,
  OBSTACLE_PAD_LEFT,
  OBSTACLE_PAD_Y,
  flowKeyOf as busFlowKey,
  isTrunkOwner,
  type BusEdgeData,
  type FanoutBusEdgeData,
  type LaneBusEdgeData,
} from "./busRouting";
import {
  absoluteLeft,
  absoluteTop,
  drawnPortsOf,
  edgeItem,
  nodeHeight,
  nodeWidth,
  portOffsetY,
} from "./nodeGeometry";
// Type-only: ItemEdge.tsx declares the base canvas edge payload this pass seats
// chips for. Erased at compile time, so it adds no runtime or bundler edge.
import type { ItemEdgeData } from "./ItemEdge";
import type { RFAnyNode } from "./layout";
// The chip BOX: how wide a chip is and what it says. This pass owns only the
// POLICY -- where that box may sit and how far it may move.
import {
  CHIP_HALF_H,
  CHIP_HALF_W_WIDE,
  aggregateChipText,
  branchChipText,
  chipNaturalWidth,
  chipSeatHalfW,
  rateChipText,
  type ChipText,
} from "./chipMetrics";

// The fan-out BRANCH short-leg rule shares the item rule's usable-width gate
// (usableWidthCollapses above): a member whose OWN leg -- the sub-polyline
// AFTER the junction, never the trunk-including whole polyline -- lacks the
// horizontal run for its chip's reserved box has no seat on that leg that
// keeps the box off the trunk's split dot either (#50; the keep-off square
// alone reaches DOT_KEEPOFF past the box's half-width), and the collapsed
// box is narrow enough that one exists. Measuring the leg rather than the
// whole polyline, a long shared trunk can no longer vouch for a 13-unit
// riser's full "300/min" box: the trunk prefix is the trunk's to draw on, not
// the branch chip's. The rule USED to state this as a total-arc-length bound
// against the widest box (SHORT_LEG_MAX = CHIP_HALF_W_WIDE), which both
// counted vertical travel a horizontal chip cannot use and let the shared
// trunk prefix puff the measure -- the two failures Task 6's item rule fixed
// first.

// Minimum centre x-separation two WIDE bus rise chips must keep when they
// share one lane run -- the capacity floor the bus rise pass hides against
// (see deconflictChipAnchors). Also, deliberately, the WIDTH of the rise-end
// window clampChipXToOwnRun intersects a member's own run with, so a rise
// chip is never seated more than one separation from the corner it labels:
// the window is exactly as wide as the closest two chips may sit, so a chip
// held at its window's far edge still clears a sibling parked at its own
// corner beside it.
const MIN_CHIP_SEP = 2 * CHIP_HALF_W_WIDE;

export type XSpan = { lo: number; hi: number };

// The widest sub-interval of the polyline's x-extent that no band reaches
// into: the longest clear run a chip's box can slide along. Null when the
// points are empty or the bands blanket the extent. Its width is the chip's
// clear window (the collapse rule and the scale cap both read it) and its
// midpoint is the seat's preferred on-line candidate.
//
// Exported for the seating suite, which asserts that bands blanketing the
// extent report no window at all rather than the bare extent.
export function largestClearSpan(
  pts: ReadonlyArray<readonly [number, number]>,
  ownBands: ReadonlyArray<XSpan>,
): XSpan | null {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const clips: XSpan[] = [];
  for (const b of ownBands) {
    const lo = Math.max(b.lo, minX);
    const hi = Math.min(b.hi, maxX);
    if (hi > lo) clips.push({ lo, hi });
  }
  clips.sort((a, b) => a.lo - b.lo);
  let best: XSpan | null = null;
  let sweep = minX;
  for (const c of clips) {
    if (c.lo > sweep) {
      if (best === null || c.lo - sweep > best.hi - best.lo)
        best = { lo: sweep, hi: c.lo };
    }
    sweep = Math.max(sweep, c.hi);
  }
  if (maxX > sweep) {
    if (best === null || maxX - sweep > best.hi - best.lo)
      best = { lo: sweep, hi: maxX };
  }
  return best;
}

// Vertical pitch a colliding chip is bumped by each step, and the shared full
// chip-box height. A full max-scale box height keeps the resolved clearance from
// dropping below one box at any zoom.
const CHIP_PITCH_Y = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
const CHIP_NUDGE_STEP = CHIP_PITCH_Y;

// The small lift a bus chip may take off its lane while the lane stroke still
// runs through the box it PAINTS. A bus chip is anchored to a lane it has no
// other tie to -- it draws no leg of its own -- so that stroke is the only thing
// saying which trunk the rate belongs to, and it is inside the painted box only
// while the offset stays under CHIP_HALF_H: at exactly CHIP_HALF_H the line lies
// ON the box edge and the chip reads as floating beside the lane. The bite is
// that depth less a few units of margin. It is tried as an early rung of the
// cascade, ahead of the full pitch, so a chip that can clear its obstacle with a
// small lift keeps its line.
const LANE_LINE_KEEP = 4;
const LANE_BITE = CHIP_HALF_H - LANE_LINE_KEEP;

// A placed chip box in the shared collision set: its centre plus per-axis
// half-extents. Two boxes overlap when their centres sit closer than the sum of
// their half-extents on BOTH axes.
export type ChipBox = { x: number; y: number; halfW: number; halfH: number };

// Frame margin around foreign card rects in the clearance field.
const CARD_CLEAR_MARGIN = 0.5;

// The target's entry band: the gutter just left of a consumer's card where its
// arriving lines converge on the Left port. A rate chip whose centre sits in
// this band is part of the arrival cluster -- it names a line entering here, so
// it may rest among its siblings' final approaches; one out on the corridor is
// not, so it must clear a sibling's line like any foreign flow. Built from the
// same OBSTACLE_PAD_LEFT / OBSTACLE_PAD_Y overhangs paddedObstacles reserves, so
// the band matches the padded card's left overhang by construction.
export type EntryBand = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function centreInBand(x: number, y: number, band: EntryBand): boolean {
  return x >= band.left && x <= band.right && y >= band.top && y <= band.bottom;
}

function chipBoxesOverlap(a: ChipBox, b: ChipBox): boolean {
  return (
    Math.abs(a.x - b.x) < a.halfW + b.halfW &&
    Math.abs(a.y - b.y) < a.halfH + b.halfH
  );
}

// A segment clipped to a chip box: the piece of it the box actually contains,
// in the same (x0,y0,x1,y1) shape the obstacle segments use.
type ClippedSeg = readonly [number, number, number, number];

// A chip box as an edge rect.
function boxRect(box: ChipBox): PortZoneRect {
  return {
    left: box.x - box.halfW,
    top: box.y - box.halfH,
    right: box.x + box.halfW,
    bottom: box.y + box.halfH,
  };
}

// Do two rects interpenetrate by more than eps on both axes?
function rectsOverlapBy(
  a: PortZoneRect,
  b: PortZoneRect,
  eps: number,
): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > eps &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > eps
  );
}

// The part of the segment (x0,y0)-(x1,y1) inside the chip box, or null when the
// box does not contain a positive-length piece of it. The clip itself is
// crossings.ts's clipSegmentToBox, shared with the placement audits; this wraps
// it in the chip box's centre/half-extent shape and maps the parameter window
// back onto the segment. The single segment-vs-box geometry in this module: the
// boolean probe below and the window probe on the ClearanceField are both this
// one clip, so "the box contains this stroke" and "here is the piece it
// contains" can never disagree.
function clipSegToChipBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  box: ChipBox,
): ClippedSeg | null {
  const window = clipSegmentToBox(x0, y0, x1, y1, boxRect(box));
  if (window === null) return null;
  const [t0, t1] = window;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

// Does the segment (x0,y0)-(x1,y1) enter the chip box's interior?
function segIntersectsChipBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  box: ChipBox,
): boolean {
  return clipSegToChipBox(x0, y0, x1, y1, box) !== null;
}

// Distance-from-a-point geometry (pointSegDistance,
// pointToPolylineDistance) is shared from ./crossings.ts since the
// exam-surfaced Task 9 crossing-cue work: the render layer's cue liveness
// filter and the e2e audits read the same copy, so the seating pass and the
// audit can never disagree about whether a point sits on a line.

// A reconstructed edge polyline the chip pass treats as an obstacle: the
// segments of every edge OUTSIDE the chip's own flow (its own edge plus
// same-(item, source) siblings, which share one visual line -- a trunk's lane
// run or a fanout's common trajectory) and outside its own ARRIVAL CLUSTER
// (edges into the same target: the converging lines before one consumer read
// as one junction, so a chip near its port may sit among its siblings' final
// approaches). flowKey groups the flow siblings; target the cluster.
export type EdgeSegments = {
  // The owning edge's id. `ownIds`-based (trunk-aware) foreignness matches on it;
  // plain item chips ignore it and group by flowKey.
  id: string;
  flowKey: string;
  target: string;
  segs: ReadonlyArray<readonly [number, number, number, number]>;
};

// The arrival-cluster state of ONE query, resolved once before the per-edge
// walk: with no entry band the cluster exemption is unconditional (bus / entry
// seats), with one it holds only while the box centre sits inside the band.
function clusterExemptOf(box: ChipBox, entryBand?: EntryBand): boolean {
  return entryBand === undefined || centreInBand(box.x, box.y, entryBand);
}

// The single per-edge foreignness rule both line probes run: an edge is foreign
// when it is not own (by `ownIds` membership when the caller gives a trunk
// member set, else by flowKey group) and not waived by the arrival cluster
// (same target while the cluster exemption holds). Shared so the boolean probe
// and the counting probe cannot drift apart -- the count is zero EXACTLY when
// the boolean is false because both ask this one question per edge.
function isForeignEdge(
  edge: EdgeSegments,
  flowKey: string,
  target: string,
  clusterExempt: boolean,
  ownIds?: ReadonlySet<string>,
): boolean {
  const own =
    ownIds !== undefined ? ownIds.has(edge.id) : edge.flowKey === flowKey;
  return !own && (!clusterExempt || edge.target !== target);
}

// A raw card rect a chip's box must stay clear of (the P3 hard invariant), in
// the DRAWN frame: the rendered border box, which is what the browser paints and
// what the e2e audit measures (see CARD_GROWTH). `border` is the card's frame
// width (cardBorder): the port furniture anchors on the row edge, one border
// inside the drawn edge.
export type CardRect = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  border: number;
};

// Port-adjacent exemption depth (issue #10). An edge-label chip is ~2x wider
// than the inter-card corridor it labels, so a chip on its own line necessarily
// pokes its wide box into its own source / target card near the port -- that is
// the normal, on-line state, not a defect. The #10 defect is a chip whose CENTRE
// (its icon + rate text, the readable payload) lands ON the card body, well past
// the port, burying the label in the card ("~2 box-widths into the consumer
// card"). So the exemption is on the chip CENTRE, not the box: a chip is exempt
// from its own card while its centre stays within PORT_ZONE_DEPTH of the port
// edge (in the corridor or a hair inside), and enters the body once the centre
// crosses deeper. Depth is the recipe row's port-side inset (canvas.css
// .rn-row.input padding-left / .rn-row.output padding-right, both 8px) -- the
// strip between the ROW edge and the row's item glyph, so an exempt chip's
// centre stops at the glyph's leading edge and never sits on the glyph itself.
// The row sits inside the card's border, so the strip is measured from the card
// edge inward by CARD_BORDER first (the card rects are drawn border boxes).
// Re-derive it whenever that row padding changes. A box-overlap rule instead
// would flag every on-line chip (box wider than corridor) and fling it off its
// line -- the issue-#9 orphaned-chip regression this narrowing must avoid.
export const PORT_ZONE_DEPTH = 8;

// How far the port furniture (the PortGlyph, which reaches past the handle)
// hangs outside the row edge, in graph units.
const PORT_FURNITURE_OUT = GLYPH_SIDE_OFFSET;

// The port keep-out band: the full-height x-strip straddling one own endpoint
// card's port edge, from the glyph's outer edge to the port strip's inner
// edge. Full card height because a step edge anchors at mid(sy,ty), so a
// row-height band would let a wide box land on a neighbouring row's text.
//
// Exported for the port-zone suite, which asserts the band reaches the drawn
// glyph's outer edge on each card kind.
export function portKeepOutRect(
  card: CardRect,
  side: PortZoneSide,
): PortZoneRect {
  const out = PORT_FURNITURE_OUT - card.border;
  const depth = card.border + PORT_ZONE_DEPTH;
  return side === "target"
    ? {
        left: card.left - out,
        right: card.left + depth,
        top: card.top,
        bottom: card.bottom,
      }
    : {
        left: card.right - depth,
        right: card.right + out,
        top: card.top,
        bottom: card.bottom,
      };
}

export type PortZoneSide = "source" | "target";

type PortZoneRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

// Does `chip`'s CENTRE sit ON the OWN endpoint `card`'s body, past its
// port-adjacent strip? True = the chip is seated on the card body (a #10
// violation the seat must escape); false = no vertical overlap with the card, or
// the centre is still in the corridor / port strip (the normal on-line state).
// `side` selects the port edge ("source" hugs the card's right edge / out-port,
// "target" its left edge / in-port). Shared verbatim by the seating pass
// (makeClearanceField) and the e2e chip/card audit so the gate and the placement
// rule never drift.
//
// BOTH callers pass DRAWN card rects -- the audit reads them off the DOM, the
// seating pass grows the model box by CARD_GROWTH -- so the strip starts one
// CARD_BORDER inside the rect, where the row the depth is derived from begins.
export function chipEntersOwnCardBody(
  chip: PortZoneRect,
  card: PortZoneRect,
  side: PortZoneSide,
  eps = 0.5,
): boolean {
  const oy = Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
  if (oy <= eps) return false; // not even level with the card: never on its body
  const cx = (chip.left + chip.right) / 2;
  // CARD_BORDER is declared further down this file, next to the CARD_GROWTH
  // table it is derived with (the port-side counterpart, PORT_DRIFT, lives with
  // drawnPortsOf in nodeGeometry.ts); hoisting makes it readable here.
  const depth = CARD_BORDER + PORT_ZONE_DEPTH;
  return side === "target" ? cx > card.left + depth : cx < card.right - depth;
}

// Seat-side companion to chipEntersOwnCardBody, and a DIFFERENT rule on the
// same number: how much deeper than the port strip the chip's BOX reaches into
// one of its own endpoint cards, in graph units, 0 when it stays within budget.
// The centre rule above says whether the readable payload is buried; this one
// says how much of the box the reader sees lying ON the card, which is the F1
// complaint (a chip whose centre is still in the corridor but whose box is
// swallowed by the card body). Both are needed: the centre rule is the hard
// invariant every tier upholds, this one is a PREFERENCE the on-line tiers
// minimise, so it can never fling a chip off its line (issue #9).
//
// Depth is the smaller of the two overlap extents. For a box lapping a card's
// port edge that is the x-overlap; once the lap passes the box's own height the
// depth saturates there, which is the "swallowed whole" state. Conservative in
// the same direction as the e2e census counter (auditChipCardIntrusion in the
// geometry audit), which mirrors this rule against the DRAWN box; the box here
// is the seat's max-counter-scale reservation, so it is never narrower than the
// box the census measures.
//
// The budget is the same CARD_BORDER + PORT_ZONE_DEPTH strip the centre rule
// exempts (9): a chip lying across its own port strip is the normal on-line
// state however wide it is. Taken as a default argument, not a module const,
// because CARD_BORDER is declared further down the file.
//
// Exported for the seating suite, which asserts a box lying no deeper than the
// port strip scores zero intrusion.
export function chipOwnCardIntrusion(
  chip: PortZoneRect,
  card: PortZoneRect,
  budget = CARD_BORDER + PORT_ZONE_DEPTH,
): number {
  const ox = Math.min(chip.right, card.right) - Math.max(chip.left, card.left);
  const oy = Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
  if (ox <= 0 || oy <= 0) return 0;
  return Math.max(0, Math.min(ox, oy) - budget);
}

// Per-edge card exemption for the chip seat. Container slabs (group boxes) stay
// wholly exempt; the edge's own source / target cards are exempt only while the
// chip centre stays in their port-adjacent strip (issue #10), keyed by node id
// to the zone's port side.
export type CardExemption = {
  whole: ReadonlySet<string>;
  zones: ReadonlyMap<string, PortZoneSide>;
};

// The shared clearance state every seating phase runs against: the chips
// placed so far plus the two static obstacle sets (reconstructed edge
// polylines and raw card rects), exposed through the named predicates each
// seat composes. Chips enter through `seat` as they seat, so later phases see
// everything earlier phases placed.
export type ClearanceField = {
  // Every box seated so far, append-ordered by seat time. This IS the phase
  // priority record: a later seat yields to every earlier box. Read it freely;
  // it is not mutable from out here -- `seat` and `unseat` are the only ways in
  // and out.
  readonly placed: ReadonlyArray<ChipBox>;
  // Reserve one box and return it. Exactly one box enters the field per call,
  // and the returned box is that box: the rollback handle AND the authoritative
  // seated centre. Callers read `box.x` / `box.y` rather than re-deriving the
  // centre from their anchor plus the offsets they were handed, which can drift
  // from what was actually reserved.
  seat(box: ChipBox): ChipBox;
  // Release a box `seat` returned, by reference identity, so an undone seat
  // leaves no phantom obstacle blocking a later chip. Valid only for the most
  // recent seat on this field: interleaving two live seats and releasing the
  // older one is unsupported, and a box that is absent or not last leaves the
  // set unchanged and fires a DEV-only tripwire.
  unseat(box: ChipBox): void;
  overlapsChip(box: ChipBox): boolean;
  // A foreign card is any obstacle whose id is neither wholly exempt (a
  // container slab) nor an own endpoint card. Own endpoint cards are obstacles
  // MINUS their port-adjacent zone (issue #10): a chip entering such a card's
  // body outside the shallow port strip is a violation just like a foreign card.
  entersForeignCard(box: ChipBox, exempt: CardExemption): boolean;
  // Does this box cover an own endpoint card's port keep-out band
  // (portKeepOutRect)? A hard keep-out for every tier. Only the `zones` cards
  // have a band: a foreign card's whole box already blocks.
  entersOwnPortBand(box: ChipBox, exempt: CardExemption): boolean;
  // Foreign-line test with the arrival-cluster exemption: a same-target
  // sibling's line is skipped unconditionally when no entry band is given
  // (bus / entry seats), and only while the box centre sits inside the band
  // when one is (rate-chip seats, the narrowed rule).
  //
  // Own-flow classification is by flowKey (same item|source is one visual line)
  // UNLESS `ownIds` is given: then "own" is EXACTLY that edge-id set -- the
  // trunk's actual member edges plus the aggregate's own edge -- so a same-
  // flowKey edge outside the trunk (a separate direct edge) reads foreign. Only
  // trunk-context chips (the fan-out aggregate) pass it; plain item-edge chips
  // omit it and keep the flowKey grouping (issue #28).
  onForeignLine(
    box: ChipBox,
    flowKey: string,
    target: string,
    entryBand?: EntryBand,
    ownIds?: ReadonlySet<string>,
  ): boolean;
  // Counting sibling of onForeignLine, same own-flow and arrival-cluster
  // exemptions, same obstacle set and frame: the number of foreign
  // (edge, segment) pairs intersecting the box. Counts PAIRS rather than
  // distinct edges because that is what the segment-vs-chip audit ratchets, so
  // a seat minimizing this score minimizes the audited count. Zero exactly when
  // onForeignLine is false -- both ask the same shared per-edge question
  // (isForeignEdge over clusterExemptOf), so they cannot drift apart. Kept
  // separate from the boolean so the hot tier-1 slide keeps its early exit.
  foreignLineCrossings(
    box: ChipBox,
    flowKey: string,
    target: string,
    entryBand?: EntryBand,
    ownIds?: ReadonlySet<string>,
  ): number;
  // Windowing sibling of the two probes above: the piece of each foreign
  // (edge, segment) the box actually contains, clipped to the box, one entry per
  // pair in the same unit foreignLineCrossings counts. Same own-flow and
  // arrival-cluster exemptions (the shared isForeignEdge over clusterExemptOf),
  // same obstacle set, same frame, and the same single clip the boolean probe
  // runs -- so the array is EMPTY exactly when onForeignLine is false and its
  // length is exactly foreignLineCrossings, by construction rather than by
  // agreement.
  //
  // Counts alone cannot say WHERE inside the box a foreign stroke runs, which is
  // the braid question: a stroke crossing the box from side to side reads as a
  // line passing under the chip, while one running ALONGSIDE the chip's own
  // stroke leaves the reader unable to tell which flow the chip labels. The
  // caller answers that by measuring these windows against its own polyline,
  // which it already holds -- no own-line API is added here.
  foreignLineWindows(
    box: ChipBox,
    flowKey: string,
    target: string,
    entryBand?: EntryBand,
    ownIds?: ReadonlySet<string>,
  ): ReadonlyArray<ClippedSeg>;
  // How many junction dots this box would swallow, for the graze tier's scored
  // seat. Chips paint ABOVE the dots in the shared label layer (canvas.css
  // .flow-chip z-index 2 vs .bus-junction 1) and are opaque, so a chip seated on
  // a dot does not overlap it -- it deletes it, and the merge / split the dot
  // marks reads as an ordinary corner. Unlike the chip and card predicates this
  // one is a PREFERENCE: it never forces a chip off its line or into a coarser
  // tier.
  dotsCovered(box: ChipBox): number;
  // Deepest over-budget reach of this box into one of the edge's OWN endpoint
  // cards (chipOwnCardIntrusion, worst card), 0 when every one of them is within
  // the port strip. Only own cards are asked: a foreign card is hard-blocked by
  // entersForeignCard in every tier, so a candidate that got this far cannot be
  // on one. Like dotsCovered this is a PREFERENCE -- the on-line tiers minimise it
  // and no tier is blocked by it.
  ownCardIntrusion(box: ChipBox, exempt: CardExemption): number;
};

// Exported for the seating and sidestep-gate suites, which build a field from
// synthetic crossings and cards and assert the seat / unseat contract (an
// unseated box is no obstacle again) directly.
export function makeClearanceField(
  segments: ReadonlyArray<EdgeSegments>,
  cards: ReadonlyArray<CardRect>,
  // Every junction dot the render layer will draw, resolved before the first
  // chip seats (phase 0). Empty for callers that seat against chips and lines
  // alone.
  dots: ReadonlyArray<JunctionDot> = [],
): ClearanceField {
  const placed: ChipBox[] = [];
  // A box swallows a dot when it covers the dot's keep-off square, i.e. their
  // rects overlap on both axes -- the same per-axis test chipBoxesOverlap runs.
  const swallows = (box: ChipBox, dot: JunctionDot): boolean =>
    Math.abs(box.x - dot.x) < box.halfW + DOT_KEEPOFF &&
    Math.abs(box.y - dot.y) < box.halfH + DOT_KEEPOFF;
  // Foreign cards are tested with a frame margin: a seat parked flush against
  // the interpenetration eps clears the model frame by thousandths and then
  // flips the e2e hard gate on camera rounding.
  const foreignCards = cards.map((c) => ({
    id: c.id,
    left: c.left - CARD_CLEAR_MARGIN,
    top: c.top - CARD_CLEAR_MARGIN,
    right: c.right + CARD_CLEAR_MARGIN,
    bottom: c.bottom + CARD_CLEAR_MARGIN,
  }));
  const portBands = new Map(
    cards.map((c) => [
      c.id,
      {
        source: portKeepOutRect(c, "source"),
        target: portKeepOutRect(c, "target"),
      },
    ]),
  );
  return {
    placed,
    seat: (box) => {
      placed.push(box);
      return box;
    },
    unseat: (box) => {
      if (placed[placed.length - 1] === box) {
        placed.pop();
        return;
      }
      if (import.meta.env.DEV) {
        // Dev/test-only tripwire, tree-shaken out of production builds (parity
        // with the seat-exhaustion warnings below), where the call is a no-op.
        console.warn(
          "chip seating: unseat on a box that is not the most recent seat " +
            "(absent, or seated before another live seat); field unchanged",
        );
      }
    },
    overlapsChip: (box) => placed.some((b) => chipBoxesOverlap(b, box)),
    entersForeignCard: (box, exempt) => {
      const chip = boxRect(box);
      return cards.some((c, i) => {
        if (exempt.whole.has(c.id)) return false;
        const zone = exempt.zones.get(c.id);
        if (zone === undefined)
          return rectsOverlapBy(chip, foreignCards[i]!, 0.5);
        return chipEntersOwnCardBody(chip, c, zone, 0.5);
      });
    },
    entersOwnPortBand: (box, exempt) => {
      if (exempt.zones.size === 0) return false;
      const chip = boxRect(box);
      for (const [id, side] of exempt.zones) {
        const band = portBands.get(id)?.[side];
        if (band !== undefined && rectsOverlapBy(chip, band, 0.5)) return true;
      }
      return false;
    },
    onForeignLine: (box, flowKey, target, entryBand, ownIds) => {
      const clusterExempt = clusterExemptOf(box, entryBand);
      return segments.some(
        (e) =>
          isForeignEdge(e, flowKey, target, clusterExempt, ownIds) &&
          e.segs.some(([x0, y0, x1, y1]) =>
            segIntersectsChipBox(x0, y0, x1, y1, box),
          ),
      );
    },
    foreignLineCrossings: (box, flowKey, target, entryBand, ownIds) => {
      const clusterExempt = clusterExemptOf(box, entryBand);
      let count = 0;
      for (const e of segments) {
        if (!isForeignEdge(e, flowKey, target, clusterExempt, ownIds)) continue;
        for (const [x0, y0, x1, y1] of e.segs) {
          if (segIntersectsChipBox(x0, y0, x1, y1, box)) count++;
        }
      }
      return count;
    },
    foreignLineWindows: (box, flowKey, target, entryBand, ownIds) => {
      const clusterExempt = clusterExemptOf(box, entryBand);
      const out: ClippedSeg[] = [];
      for (const e of segments) {
        if (!isForeignEdge(e, flowKey, target, clusterExempt, ownIds)) continue;
        for (const [x0, y0, x1, y1] of e.segs) {
          const win = clipSegToChipBox(x0, y0, x1, y1, box);
          if (win !== null) out.push(win);
        }
      }
      return out;
    },
    dotsCovered: (box) =>
      dots.reduce((n, d) => n + (swallows(box, d) ? 1 : 0), 0),
    ownCardIntrusion: (box, exempt) => {
      const chip = boxRect(box);
      let worst = 0;
      for (const c of cards) {
        if (exempt.whole.has(c.id)) continue;
        if (!exempt.zones.has(c.id)) continue;
        const excess = chipOwnCardIntrusion(chip, c);
        if (excess > worst) worst = excess;
      }
      return worst;
    },
  };
}

// Cap on the cascade when foreign edge segments join the collision set. A chip
// crossing a dense weave could otherwise walk far off its anchor; past the cap
// the seat falls back to chip-only collisions (the pre-segment behaviour, no
// worse than before).
const CHIP_SEAT_MAX_STEPS = 24;

// Cascade probe: the smallest dy multiple of `step` (within the cap) at which
// the box clears every placed chip and every foreign-flow line, or null when
// the cap exhausts. `step` is signed: bottom-band chips cascade DOWN, top-band
// chips pass a negative step and cascade UP, away from the graph below them.
// No side effects; callers push the box themselves.
function cascadeClearDy(
  field: ClearanceField,
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  step: number,
  flowKey: string,
  target: string,
  maxSteps: number,
  // When given, the cascade also clears every FOREIGN raw card (the drop
  // aggregate's hard chip-vs-card tier); absent leaves cards unchecked (rises).
  cardExempt?: CardExemption,
): number | null {
  let dy = 0;
  for (let steps = 0; steps <= maxSteps; steps++) {
    const box = { x, y: y + dy, halfW, halfH };
    if (
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target) &&
      (cardExempt === undefined || !field.entersForeignCard(box, cardExempt))
    ) {
      return dy;
    }
    dy += step;
  }
  return null;
}

// Seat a bus chip at its preferred lane anchor, cascading in `step`-sized
// increments until it clears every placed chip and every foreign line, then
// record it. Returns the signed offset applied (0 when the anchor was already
// clear). When no step within the cap clears the lines, the seat retries
// against chips alone so crowding never regresses past the pre-segment
// behaviour. Deterministic given a fixed placement order.
function seatChip(
  field: ClearanceField,
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  step: number,
  flowKey: string,
  target: string,
  // Owning edge id, used only for the DEV exhaustion warning below.
  devId: string,
  // Trunk-member card exemption for the drop aggregate seat (union of member
  // targets + shared source + containers). When given, both the segment-clear
  // cascade and the chips-only fallback keep the chip off every foreign raw
  // card, upholding the bus-drop-vs-card hard tier at the seating side. Absent
  // for rise chips (lane-anchored, out of scope for that tier).
  cardExempt?: CardExemption,
  // Soft cascade cap, in steps (the bus DROP seat only). Inside the cap the
  // seat is tried first against everything, then again with the FOREIGN-LINE
  // preference relaxed -- the softest obstacle this seat consults -- so a drop
  // chip grazing a foreign stroke beside its own
  // junction beats a clean seat pitches away in empty canvas, where no rule
  // hides it and nothing marks which trunk it belongs to. Chips (and, with a
  // cardExempt, foreign cards) stay HARD throughout: when nothing inside the
  // cap clears them the cap yields to the unbounded ladder below rather than
  // let two chips overlap.
  capSteps?: number,
): { dy: number; box: ChipBox } {
  const bite = step < 0 ? -LANE_BITE : LANE_BITE;
  // The bite rung: a lift small enough to keep the lane line inside the painted
  // box, tried before the pitch-sized ladder below so a chip that clears its
  // obstacle cheaply never pays the full pitch for it. A pitch-sized neighbour
  // chip is not cleared by a bite (two boxes need a full height between their
  // centres), so this only ever picks up the cases a thin obstacle caused.
  // The lane slot itself comes first, exactly as the ladder below would take it.
  for (const dy of [0, bite]) {
    const box = { x, y: y + dy, halfW, halfH };
    if (
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target) &&
      (cardExempt === undefined || !field.entersForeignCard(box, cardExempt))
    ) {
      return { dy, box: field.seat(box) };
    }
  }
  if (capSteps !== undefined) {
    const capped = cascadeClearDy(
      field,
      x,
      y,
      halfW,
      halfH,
      step,
      flowKey,
      target,
      capSteps,
      cardExempt,
    );
    if (capped !== null) {
      return {
        dy: capped,
        box: field.seat({ x, y: y + capped, halfW, halfH }),
      };
    }
    let capDy = 0;
    for (let steps = 0; steps <= capSteps; steps++) {
      const box = { x, y: y + capDy, halfW, halfH };
      if (
        !field.overlapsChip(box) &&
        (cardExempt === undefined || !field.entersForeignCard(box, cardExempt))
      ) {
        return { dy: capDy, box: field.seat(box) };
      }
      capDy += step;
    }
  }
  const clear = cascadeClearDy(
    field,
    x,
    y,
    halfW,
    halfH,
    step,
    flowKey,
    target,
    CHIP_SEAT_MAX_STEPS,
    cardExempt,
  );
  if (clear !== null) {
    return { dy: clear, box: field.seat({ x, y: y + clear, halfW, halfH }) };
  }
  // Segment-clear seat not found within the cap: fall back to the chips-only
  // cascade so crowding never regresses past the pre-segment behaviour.
  if (import.meta.env.DEV) {
    // Dev/test-only tripwire, tree-shaken out of production builds (parity
    // with the render hook in src/pipeline/driver.ts).
    console.warn(
      `chip seating: segment-clear cascade for ${devId || "(unnamed chip)"} ` +
        "exhausted its cap; falling back to the chips-only cascade " +
        "(foreign-line clearance abandoned)",
    );
  }
  let dy = 0;
  while (
    field.overlapsChip({ x, y: y + dy, halfW, halfH }) ||
    (cardExempt !== undefined &&
      field.entersForeignCard({ x, y: y + dy, halfW, halfH }, cardExempt))
  ) {
    dy += step;
  }
  return { dy, box: field.seat({ x, y: y + dy, halfW, halfH }) };
}

// Clamp a lane member's trunk-wide rise slot into a WINDOW at the member's
// OWN rise end: the resolved run intersected with [riseX - MIN_CHIP_SEP,
// riseX] for a forward member, or [riseX, riseX + MIN_CHIP_SEP] for a
// backward one (whose rise end is the run's LEFT end), keeping one chamfer of
// slack at each cut so the chip anchors on the straight part of the run
// rather than on a corner bevel. The window makes the clamp two-sided. The
// old clamp only pulled out-of-run slots back IN, so a long-running member
// whose slot already sat inside its own run kept it -- legally, but hundreds
// of units from the rise corner it labels and plausibly right beside a short
// sibling's column (battery5-xiranite: the "300/687.95" rise chip under the
// 297.95 member's dogleg). With the window, no rise chip sits more than one
// MIN_CHIP_SEP from its own corner whatever the spread pass does; members
// whose windows crowd (two feeding one column) are decided by the capacity
// check, untouched. A run with no interior left -- a hairpin (dropX ===
// riseX), or a backward member whose two columns nearly touch -- gets the
// run's midpoint instead. `undefined` in, `undefined` out: that is the lone
// long-run member, whose slot routeBusEdges deliberately omits so the chip
// falls back to the rise column at the consumer end (#32), and whose
// zoom-gate exemption in BusEdge keys on the slot being ABSENT.
//
// The window has one carve-out, `riseColumnCoLocated`: a member whose rise
// column stands within one MIN_CHIP_SEP of a SIBLING member's rise column
// (same-layer targets, whose lane runs are therefore co-extensive). Two such
// members' windows cut overlapping stretches out of the shared run, so the
// two-sided clamp parks both on it -- a window one MIN_CHIP_SEP wide hosts at
// most one chip -- and the capacity check hides one, defeating the trunk-wide
// spread, which exists to separate exactly these members: same-layer members
// anchor near-coincident at their rise vertices because assignEntryColumns
// staggers the entry gutter per target, not per layer. For such a member the
// slot keeps its spread position, clamped into the member's own run only (the
// pull-in-only form the clamp had before the window): co-extensive runs cover
// the whole spread extent, so the slot stays on the member's own stroke
// wherever the spread put it, and the spread -- not the window -- separates
// the chips. The flag is judged per MEMBER, not per trunk: one far member
// (a longer run into the next layer) must not re-impose the window on the
// co-located rest, whose windows would still collide. A member whose rise
// column stands apart from every sibling's (mixed-length runs, the battery5
// shape the window was built for) keeps the window.
function clampChipXToOwnRun(
  busChipX: number | undefined,
  dropX: number,
  riseX: number,
  riseColumnCoLocated: boolean,
): number | undefined {
  if (busChipX === undefined) return undefined;
  const lo = Math.min(dropX, riseX);
  const hi = Math.max(dropX, riseX);
  if (hi - lo <= 2 * CHAMFER) return (lo + hi) / 2;
  if (riseColumnCoLocated) {
    return Math.min(Math.max(busChipX, lo + CHAMFER), hi - CHAMFER);
  }
  // Direction-aware rise-end window, one MIN_CHIP_SEP wide, ending at the
  // member's own rise column and reaching back along the run toward the drop
  // column.
  const windowLo = riseX >= dropX ? riseX - MIN_CHIP_SEP : riseX;
  const windowHi = riseX >= dropX ? riseX : riseX + MIN_CHIP_SEP;
  // Intersect with the chamfer-slack run. Never empty on this branch: the
  // run is longer than two chamfers, so [lo + CHAMFER, hi - CHAMFER] is
  // non-empty, and its rise-side end sits one chamfer INSIDE the window
  // while its drop-side end is cut only when the run outlengths the window.
  const clampLo = Math.max(lo + CHAMFER, windowLo);
  const clampHi = Math.min(hi - CHAMFER, windowHi);
  return Math.min(Math.max(busChipX, clampLo), clampHi);
}

// Row tolerance for matching a stamped y against a drawn vertex: paths round to
// two decimals, so a unit is well clear of the rounding and well under any real
// row separation. Same value the fan-in run detection uses.
const RUN_ROW_EPS = 1;

// The polyline's horizontal run at y: the first vertex pair whose two ends both
// sit on that level (within the row tolerance). Empty when the polyline
// draws no such run -- a jog always draws one, between its two chamfers.
function horizontalRunAt(
  pts: ReadonlyArray<readonly [number, number]>,
  y: number,
): ReadonlyArray<readonly [number, number]> {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (
      Math.abs(a[1] - y) <= RUN_ROW_EPS &&
      Math.abs(b[1] - y) <= RUN_ROW_EPS
    ) {
      return [a, b];
    }
  }
  return [];
}

// A two-point horizontal run with its left end pushed to `lo`, or null when the
// run does not reach past it (nothing of it is seatable, so the caller leaves
// the seat on the whole polyline and the window measurement decides).
function clipRunLeft(
  run: ReadonlyArray<readonly [number, number]>,
  lo: number,
): ReadonlyArray<readonly [number, number]> | null {
  const a = run[0];
  const b = run[run.length - 1];
  if (a === undefined || b === undefined || run.length < 2) return null;
  const left = Math.min(a[0], b[0]);
  const right = Math.max(a[0], b[0]);
  if (right <= lo) return null;
  return [
    [Math.max(left, lo), a[1]],
    [right, b[1]],
  ];
}

// Cumulative arc-length of point (x, y) along the parsed polyline. The point is
// on exactly one segment by construction (a clear-segment anchor is a segment
// midpoint), so this returns the length from the path start to it. Falls back to
// the half-length when the point matches no segment (never expected).
function lengthAtPoint(
  pts: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
): number {
  let acc = 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const cross = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
    const withinX = x >= Math.min(x0, x1) - 1 && x <= Math.max(x0, x1) + 1;
    const withinY = y >= Math.min(y0, y1) - 1 && y <= Math.max(y0, y1) + 1;
    if (Math.abs(cross) < 1 && withinX && withinY) {
      return acc + Math.hypot(x - x0, y - y0);
    }
    acc += segLen;
  }
  return total / 2;
}

// Arc length of the first point on the polyline at x = wantX, or null when no
// segment spans that x.
function arcAtX(
  pts: ReadonlyArray<readonly [number, number]>,
  wantX: number,
): number | null {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if ((x0 <= wantX && wantX <= x1) || (x1 <= wantX && wantX <= x0)) {
      return acc + Math.abs(wantX - x0);
    }
    acc += Math.hypot(x1 - x0, y1 - y0);
  }
  return null;
}

// Arc-length half-pitch of the on-line slide, and its cap. Half the vertical
// pitch keeps the probe fine enough to find gaps between crossing lines.
const SLIDE_STEP = CHIP_NUDGE_STEP / 2;
const SLIDE_MAX_STEPS = 48;
// Cap on the off-line vertical nudge used when no on-line seat clears the
// foreign lines (coincident parallel edges, a shared bus lane, or a dense
// pin). Bounds how far a chip may leave its own line for LINE clearance;
// card clearance below is unbounded within LAST_RESORT_CAP_STEPS.
const NUDGE_CAP_STEPS = 3;
// Cap on the final chips-and-cards cascade. Cards are finite, so free space
// always exists within a few card heights of the anchor; this cap only bounds
// the search, it is never expected to exhaust.
const LAST_RESORT_CAP_STEPS = 200;

// Horizontal sidestep pitch and reach. When a parallel FOREIGN vertical line
// sits within the wide chip box on a corridor leg, no vertical motion clears it:
// the on-line slide, the nudge, and the escape cascade all hold x, so a wide box
// straddling a neighbour a few units away would have to travel its whole
// half-width -- which it cannot on a vertical leg, and cannot along a short
// horizontal trunk whose whole span the box already overhangs. The sidestep
// steps the box in x, away from the foreign line toward the own line's free
// side, by ENTRY_SLOT_PITCH increments.
//
// The reach is HALF the reserved half-width, and the halving is a containment
// bound rather than a taste call. The reserve is what the chip may draw at
// MAX_CHIP_SCALE; at counter-scale 1 (zoom 1 and above) it paints half of that,
// so an offset past halfW / 2 puts the own line outside the PAINTED box and the
// chip reads as an orphan floating beside its line -- the issue-#9 defect the
// whole tier ladder exists to prevent. BOTH sidestep tiers take that bound:
// the fully clear step (tier 1c) and the scored step (tier 1b'). Tier 1c used
// to keep the full half-width on the argument that a seat shedding every
// foreign stroke buys the flush step's risk back; measured against the
// per-chip seat box that argument no longer pays -- capping it holds
// seat-validity at its baseline and drops card-intrusion and foreign-stroke
// further than the uncapped tier does (Task 6b, ruling R12).
const SIDESTEP_PITCH = ENTRY_SLOT_PITCH;
const SIDESTEP_MAX = CHIP_HALF_W_WIDE;

// How close a foreign stroke has to run to the chip's OWN stroke before the two
// read as one line under the chip -- the braid distance (Z2). Half the entry
// slot pitch, i.e. one chamfer: adjacent routed columns are a full pitch apart
// by construction (assignBendColumns / the entry gutter), so two strokes closer
// than half of that are not two lanes the reader can separate, they are one
// stroke's width of paint. Measured braids sit at 0.0-3.0 units apart, well
// inside it.
const BIND_NEAR = ENTRY_SLOT_PITCH / 2;
// ...and for how far it has to hold that distance before it is a braid rather
// than an incident. One slot pitch of shared run: below that the "parallel"
// stroke is a corner the clip caught, a port stub ending beside the own line,
// or a chamfer turning away -- none of which the reader mistakes for the
// chip's own lane, and none of which a horizontal step could shed anyway.
const BIND_RUN = ENTRY_SLOT_PITCH;

// How a rate chip ended up seated, coarsest last:
//   anchor    on its clear-segment anchor, fully clear;
//   slide     slid along its own polyline to a fully clear point;
//   graze     on its own polyline clear of chips and cards, grazing a foreign
//             line (no fully clear on-line point existed);
//   sidestep  a bounded horizontal step off a corridor leg, away from a parallel
//             foreign line the wide box straddled and no vertical motion could
//             clear, the own line still within the box. Either fully clear at
//             the seat, or -- where nothing on the line or beside it is -- the
//             step that scores strictly better than the best on-line graze;
//   nudge     a short vertical lift off the line, still fully clear;
//   escape    the chips-and-cards cascade found a seat (foreign-line
//             clearance and on-own-line preference yielded);
//   exhausted the bounded search failed and the chip parked at its anchor
//             (never expected; the caller's DEV warning fires on this).
export type RateSeatTier =
  | "anchor"
  | "slide"
  | "graze"
  | "sidestep"
  | "nudge"
  | "escape"
  | "exhausted";

// The seated result: the offsets from the render anchor, the tier that produced
// them, and the box actually reserved in the field -- the rollback handle for a
// caller that decides to hide the chip after seeing the tier, and the
// authoritative seated centre.
export type RateSeat = {
  dx: number;
  dy: number;
  tier: RateSeatTier;
  box: ChipBox;
  // The counter-scale the reserved box allows: MAX_CHIP_SCALE, less when the
  // clear window capped the reserve, 1 for a seat found on the shrink pass.
  scaleCap: number;
};

export type RateSeatOpts = {
  // Trunk-aware foreignness: own flow is exactly this edge-id set, not the
  // flowKey group (issue #28).
  ownIds?: ReadonlySet<string> | undefined;
  // Seated same-trunk sibling centre-ys the on-line slide may not cross. The
  // nudge and escape tiers move vertically unchecked, so a caller passing
  // these must hide off-line seats.
  barrierYs?: ReadonlyArray<number> | undefined;
  // The chip renders collapsed, so every tier reserves the icon square. Only
  // a caller that also stamps the collapse may pass it.
  iconOnly?: boolean | undefined;
  // The text the chip draws, sizing the reserve; omitted, the worst case.
  text?: ChipText | undefined;
  // The longest clear run of the chip's own line (largestClearSpan). Its
  // width caps the reserve and its centre is the first candidate after the
  // anchor, ahead of the slide grid that can step over a narrow corridor.
  clearSpan?: XSpan | null | undefined;
};

// Seat an item rate chip: the tiered seat the item phase (and 3b's fan-out
// chips) run. Tier 1 slides ALONG THE OWN POLYLINE from the anchor, nearest
// arc-length offset first, taking the first point clear of chips, cards, and
// foreign lines whose box also stays within the port strip of its own endpoint
// cards -- the chip stays on the flow it labels without lying on the card it
// runs into. Where the line offers no such point the tier still seats on it, at
// the shallowest intrusion available. Tier 1b (graze)
// repeats that slide upholding only the HARD invariants (chips and cards) and
// seats at the LEAST-crossed candidate rather than the first one, grazing as
// few foreign lines as the line allows: staying visibly attached to the own
// line outranks clearing a parallel foreign line, because a braided corridor
// can poison every fully-clear candidate and the old off-line exits parked
// chips in empty canvas (issue #9). Tier 1c (sidestep), tried between them: a
// bounded horizontal step off the line, away from a parallel foreign vertical
// the wide box straddles and no on-line motion can shed, keeping the own line
// within the box (issue #28). Where the graze tier's own seat is left braided
// with a coincident foreign stroke, those same offsets are walked a second time
// under the graze scorer and a strictly better one wins (Z2). Tier 2 is a short
// bidirectional vertical nudge
// off the anchor, fully clear, reached only when the whole own line is chip-
// or card-blocked. Tier 3 waives every soft preference and cascades
// bidirectionally against CHIPS AND CARDS only, nearest escape first (ties
// prefer down). The seat is pushed into the field; the returned offsets are
// relative to the anchor.
//
// The on-line tiers run twice before any seat leaves the line: at the full
// reserve (the max-scale box, capped at the clear window), then at the
// scale-1 box, so two chips whose full boxes cannot share a corridor both
// stay on their lines at the smaller size. The off-line tiers keep the full
// reserve. The reserve never drops below the scale-1 box: the render floors
// the cap at 1, so a narrower reserve would pass the band at a seat the
// painted box then covers.
// Every seat the on-line tiers may take, in the order they prefer them: the
// anchor, the clear-span centre, then the arc-length grid nearest offset first,
// forward before backward, barrier-crossing points dropped. The tier-1 slide,
// the graze walk and the scarcity probe below all walk this one list, so an
// edge's seat and its measured window count are always counted the same way.
function onLineCandidates(
  pts: ReadonlyArray<readonly [number, number]>,
  total: number,
  anchorLen: number,
  clearSpan: XSpan | null | undefined,
  crossesBarrier: (py: number) => boolean,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  const pushArc = (len: number): void => {
    if (len < 0 || len > total) return;
    const [px, py] = pathPointAtPts(pts, total === 0 ? 0 : len / total);
    if (!crossesBarrier(py)) out.push([px, py]);
  };
  pushArc(anchorLen);
  if (clearSpan != null) {
    const arc = arcAtX(pts, (clearSpan.lo + clearSpan.hi) / 2);
    if (arc !== null && Math.abs(arc - anchorLen) > 1e-9) pushArc(arc);
  }
  for (let k = 1; k <= SLIDE_MAX_STEPS; k++) {
    pushArc(anchorLen + k * SLIDE_STEP);
    pushArc(anchorLen - k * SLIDE_STEP);
  }
  return out;
}

// Everything needed to ask where a chip could sit: the clearance field, the
// chip's OWN polyline with its render anchor, the flow key and target id that
// decide which lines and cards count as foreign, the card exemption, and the
// entry band an arrival cluster is narrowed to. It describes the query, not the
// chip -- the chip's own text, icon state, own-id set, barriers and clear span
// travel beside it in RateSeatOpts.
//
// A query is evaluated against the field AS IT STANDS. Read once per edge
// BEFORE any item chip is placed, it is a property of the edge and the bus
// furniture rather than of the seating order, and so order-independent and
// deterministic.
export type SeatQuery = {
  readonly field: ClearanceField;
  readonly path: {
    readonly pts: ReadonlyArray<readonly [number, number]>;
    readonly anchorX: number;
    readonly anchorY: number;
  };
  readonly flowKey: string;
  readonly target: string;
  readonly exempt: CardExemption;
  readonly entryBand: EntryBand;
};

// How many points on this edge's OWN polyline could still hold its rate chip
// fully clear of every placed chip, every foreign flow line, every foreign card
// and its own port bands -- its supply of on-line seats. Measured at the
// NARROWEST reserve the online passes use (the natural box, what the chip paints
// at counter-scale 1), so a count of zero means no box this chip can draw fits
// anywhere on its line: the edge cannot be seated on its line at all.
function clearOnLineSeats(query: SeatQuery, opts?: RateSeatOpts): number {
  const { field, path, flowKey, target, exempt, entryBand } = query;
  const { pts, anchorX, anchorY } = path;
  const halfW =
    chipSeatHalfW(opts?.text, opts?.iconOnly === true) / MAX_CHIP_SCALE;
  const halfH = CHIP_BOX_HEIGHT / 2;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  const anchorLen = Math.min(total, lengthAtPoint(pts, anchorX, anchorY));
  const candidates = onLineCandidates(
    pts,
    total,
    anchorLen,
    opts?.clearSpan,
    () => false,
  );
  let clear = 0;
  for (const [px, py] of candidates) {
    const box = { x: px, y: py, halfW, halfH };
    if (
      !field.entersForeignCard(box, exempt) &&
      !field.entersOwnPortBand(box, exempt) &&
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target, entryBand, opts?.ownIds)
    ) {
      clear++;
    }
  }
  return clear;
}

// Exported for the seating suites, which assert the tier ladder one seat at a
// time (graze, sidestep, shrink, off-line) -- tiers deconflictChipAnchors'
// stamped output cannot tell apart.
export function seatRateChip(query: SeatQuery, opts?: RateSeatOpts): RateSeat {
  const maxHalfW = chipSeatHalfW(opts?.text, opts?.iconOnly === true);
  const naturalHalfW = maxHalfW / MAX_CHIP_SCALE;
  const span = opts?.clearSpan;
  const fullHalfW =
    span === undefined
      ? maxHalfW
      : clamp(
          span === null ? 0 : (span.hi - span.lo) / 2,
          naturalHalfW,
          maxHalfW,
        );
  const run = (halfW: number, halfH: number, online: boolean) =>
    seatRateChipPass(query, opts, halfW, halfH, online);
  const withCap = (seat: RateSeat | null, scaleCap: number) =>
    seat === null ? null : { ...seat, scaleCap };
  return (
    withCap(run(fullHalfW, CHIP_HALF_H, true), fullHalfW / naturalHalfW) ??
    withCap(run(naturalHalfW, CHIP_BOX_HEIGHT / 2, true), 1) ??
    withCap(run(fullHalfW, CHIP_HALF_H, false), fullHalfW / naturalHalfW)!
  );
}

// One pass of the tier ladder at a fixed reserve. Online: the anchor / slide /
// sidestep / graze tiers, null when none seats. Offline: the nudge and escape
// cascades, which always seat. The returned scaleCap is a placeholder the
// driver overwrites.
function seatRateChipPass(
  query: SeatQuery,
  opts: RateSeatOpts | undefined,
  halfW: number,
  halfH: number,
  online: boolean,
): RateSeat | null {
  const { field, path, flowKey, target, exempt, entryBand } = query;
  const { pts, anchorX, anchorY } = path;
  const ownIds = opts?.ownIds;
  const barrierYs = opts?.barrierYs;
  // A slide candidate crosses a barrier when it and the anchor sit on OPPOSITE
  // sides of a seated sibling (their signed offsets from it differ), i.e. the
  // slide would jump past the sibling and invert the stack. Same-side and
  // on-the-sibling candidates (the latter blocked by the hard chip overlap
  // anyway) are allowed.
  const crossesBarrier = (py: number): boolean =>
    barrierYs !== undefined &&
    barrierYs.some((by) => (anchorY - by) * (py - by) < 0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  // Clamp: a fan-out trunk anchor is rounded independently of the polyline's
  // last vertex, so it can land a sub-rounding hair past the end. lengthAtPoint
  // still resolves it (1-unit segment tolerance) but to an arc length beyond
  // total, which would make tier 1 skip the delta=0 candidate and every
  // positive delta, ejecting an uncrowded chip one slide step left.
  const anchorLen = Math.min(total, lengthAtPoint(pts, anchorX, anchorY));
  const boxAt = (px: number, py: number): ChipBox => ({
    x: px,
    y: py,
    halfW,
    halfH,
  });
  // A candidate is clear when it clears every placed chip box, every foreign
  // flow line (arrival cluster narrowed to the entry band), every foreign
  // card box, and its own endpoint cards' port bands.
  const isClear = (px: number, py: number): boolean => {
    const box = boxAt(px, py);
    return (
      !field.entersForeignCard(box, exempt) &&
      !field.entersOwnPortBand(box, exempt) &&
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target, entryBand, ownIds)
    );
  };
  const seat = (px: number, py: number, tier: RateSeatTier): RateSeat => {
    const box = field.seat(boxAt(px, py));
    return { dx: px - anchorX, dy: py - anchorY, tier, box, scaleCap: 1 };
  };
  const hardClearAt = (px: number, py: number): boolean => {
    const box = boxAt(px, py);
    return (
      !field.entersForeignCard(box, exempt) &&
      !field.entersOwnPortBand(box, exempt) &&
      !field.overlapsChip(box)
    );
  };
  // How many foreign strokes inside this box RUN ALONGSIDE the chip's own
  // stroke instead of crossing it -- the braid term (Z2). A foreign window
  // counts when it is at least BIND_RUN long and BOTH its ends lie within
  // BIND_NEAR of the own polyline: a stroke that crosses the box from side to
  // side leaves the own line by the box half-height at its ends and does not
  // count however close it passes at the crossing itself, because a line
  // running UNDER a chip is unambiguous; one that hugs the own line for a
  // stretch is the one that steals the chip's ownership, and two gas lanes
  // drawn with the same dash pattern differ only in an item-derived tint. Same
  // unit as the crossing count -- (edge, segment) pairs -- so the two terms
  // read on one scale. The own line comes from `pts`, which this function
  // already holds; the field exposes only the foreign side.
  const bindingAt = (box: ChipBox): number => {
    let bound = 0;
    for (const [x0, y0, x1, y1] of field.foreignLineWindows(
      box,
      flowKey,
      target,
      entryBand,
      ownIds,
    )) {
      if (
        Math.hypot(x1 - x0, y1 - y0) >= BIND_RUN &&
        pointToPolylineDistance([x0, y0], pts) <= BIND_NEAR &&
        pointToPolylineDistance([x1, y1], pts) <= BIND_NEAR
      ) {
        bound++;
      }
    }
    return bound;
  };
  // The least-bad score of a candidate that already clears the HARD invariants,
  // in precedence order: how many foreign strokes cross its box, how deep it
  // lies on its own card, how many of those strokes braid with its own, how many
  // junction dots it swallows.
  type GrazeScore = {
    score: number;
    intrusion: number;
    binding: number;
    dots: number;
  };
  const better = (a: GrazeScore, b: GrazeScore): boolean =>
    a.score !== b.score
      ? a.score < b.score
      : a.intrusion !== b.intrusion
        ? a.intrusion < b.intrusion
        : a.binding !== b.binding
          ? a.binding < b.binding
          : a.dots < b.dots;
  // Unbeatable in this tier: one crossing (zero is impossible where the scorers
  // run -- tier 1 would already have taken it), within the card budget, no
  // braid, no dot buried. Every term has to appear or the walk would stop on a
  // candidate a lower term could still improve on.
  const unbeatable = (s: GrazeScore): boolean =>
    s.score <= 1 && s.intrusion === 0 && s.binding === 0 && s.dots === 0;
  // Score a hard-clear candidate, returning it only when it beats the
  // incumbent. The two cheap terms are evaluated first and the candidate is
  // dropped at the first one it has already lost on, so the braid count -- a
  // second full sweep over every foreign segment, on top of the crossing
  // count's -- is only ever paid by a candidate still in the running.
  const scoreIfBetter = (
    box: ChipBox,
    best: GrazeScore | null,
  ): GrazeScore | null => {
    const score = field.foreignLineCrossings(
      box,
      flowKey,
      target,
      entryBand,
      ownIds,
    );
    if (best !== null && score > best.score) return null;
    const intrusion = field.ownCardIntrusion(box, exempt);
    if (best !== null && score === best.score && intrusion > best.intrusion) {
      return null;
    }
    const cand = {
      score,
      intrusion,
      binding: bindingAt(box),
      dots: field.dotsCovered(box),
    };
    return best === null || better(cand, best) ? cand : null;
  };
  if (online) {
    // Every seat the on-line tiers may take, in the order they prefer them:
    // the anchor, the clear-span centre, then the arc-length grid nearest
    // offset first, forward before backward, barrier-crossing points dropped.
    // Tier 1 and the graze tier both walk this list.
    const onLine = onLineCandidates(
      pts,
      total,
      anchorLen,
      opts?.clearSpan,
      crossesBarrier,
    );
    // Tier 1: the slide over the FULLY clear points of the own line. Tier 1b
    // (graze, in the scan below) is reached when nothing on the line is fully
    // clear. In a braided corridor a parallel foreign line within a chip
    // half-height poisons every tier-1 candidate at once, yet the own line is
    // otherwise empty -- the chip belongs on it, icon and tint disambiguate the
    // graze.
    //
    // The tier SCORES its candidates instead of taking the first clear one, on
    // two soft terms: the junction-dot keep-off (#50) and the own-card intrusion
    // the box spends past its port strip (F1). Dots rank ABOVE intrusion, and
    // both rank below staying fully clear:
    //   - the fewest dots buried always wins. That is a change of shape from the
    //     original keep-off, which took the first dot-free candidate and fell
    //     back to the first clear one: minimising the count also improves the
    //     line where NO candidate is dot-free. Its ranking is what was measured
    //     -- putting intrusion first instead buys a handful of shallow card laps
    //     by burying four more junction dots (a fan-out split dot under its own
    //     short-leg branch chip is the recurring shape), and a hidden split reads
    //     as an ordinary corner;
    //   - among candidates that tie on dots, the shallowest intrusion wins, so
    //     the slide keeps walking rather than parking the box on the card the
    //     moment it is otherwise clear.
    // The walk stops at the first candidate that is unbeatable on both (no dot,
    // within budget), so an uncrowded chip still costs one candidate and still
    // seats on its anchor. The acceptance set is unchanged -- every fully clear
    // point is still a candidate -- so no chip is pushed to the sidestep, graze,
    // nudge or escape tiers by either term (the issue-#9 blowback this rule must
    // not cause); both terms can only reorder WITHIN tier 1, on the own line.
    const tierOf = (px: number, py: number): RateSeatTier =>
      px === anchorX && py === anchorY ? "anchor" : "slide";
    let bestOnLine: {
      px: number;
      py: number;
      dots: number;
      intrusion: number;
    } | null = null;
    for (const [px, py] of onLine) {
      if (
        bestOnLine !== null &&
        bestOnLine.dots === 0 &&
        bestOnLine.intrusion === 0
      ) {
        break;
      }
      if (!isClear(px, py)) continue;
      const box = boxAt(px, py);
      const dots = field.dotsCovered(box);
      const intrusion = field.ownCardIntrusion(box, exempt);
      if (
        bestOnLine === null ||
        dots < bestOnLine.dots ||
        (dots === bestOnLine.dots && intrusion < bestOnLine.intrusion)
      ) {
        bestOnLine = { px, py, dots, intrusion };
      }
    }
    if (bestOnLine !== null) {
      return seat(
        bestOnLine.px,
        bestOnLine.py,
        tierOf(bestOnLine.px, bestOnLine.py),
      );
    }
    // The reach both sidestep tiers share, built once and walked twice below:
    // the fully clear step (tier 1c) and the scored step (tier 1b'). It is HALF
    // the reserved half-width, a containment bound rather than a taste call --
    // the reserve is what the chip may draw at MAX_CHIP_SCALE, at counter-scale 1
    // it paints half of that, so an offset past halfW / 2 puts the own line
    // outside the PAINTED box and the chip reads as an orphan floating beside its
    // line (the issue-#9 defect this whole ladder exists to prevent). Derived from
    // the box THIS chip reserves, so a collapsed chip -- or one whose estimated
    // box is narrower than the worst case -- steps only as far as its own box
    // still holds the line. Both directions are probed nearest-first so the free
    // side wins, positive x breaking a tie, and the last step is clamped FLUSH to
    // the bound even when the pitch does not divide it.
    const sidestepMax = Math.min(SIDESTEP_MAX, halfW) / 2;
    const sidestepXs: number[] = [];
    for (let step = 1; ; step++) {
      const off = Math.min(step * SIDESTEP_PITCH, sidestepMax);
      sidestepXs.push(anchorX + off, anchorX - off);
      if (off >= sidestepMax) break;
    }
    // Tier 1b (graze), least-bad: no candidate on the line is fully clear, so
    // every remaining on-line seat crosses at least one foreign line (a
    // zero-crossing hard-clear point would already have been taken by tier 1).
    // Taking the FIRST hard-clear candidate parks the chip at the anchor, which
    // at saturated counter-scale is the thick of the fan. Walk the same
    // candidates in the same order, score each by its foreign-line crossings, and
    // seat at the minimum. Strict less-than keeps the nearest-first,
    // forward-first preference on ties (an all-equal line still seats at the
    // anchor).
    // Own-card intrusion (F1), own-line binding (Z2) and junction dots (#50)
    // enter as STRICT TIEBREAKS under the crossing count, never above it, in that
    // order: a seat that occludes one more flow line to keep its box off its own
    // card would trade a ratcheted defect for a softer one; a seat that took one
    // more crossing to shed a braid would do the same; and a seat that buries its
    // box on the card to spare a decorative dot would trade the readable state
    // for a cosmetic one. So each term only chooses between candidates every term
    // above it already ties. Binding sits under intrusion and above dots because
    // an unreadable OWNER is worse than a hidden marker and better than a chip
    // lying on a card: all three are legibility, and that is their order of harm.
    // The early exit has to name all four or the lower terms would never get to
    // compare: the walk stops only on a candidate unbeatable on every one of them
    // (a single crossing, within the intrusion budget, no braid, no dot).
    let bestGraze: { px: number; py: number; s: GrazeScore } | null = null;
    for (const [px, py] of onLine) {
      if (bestGraze !== null && unbeatable(bestGraze.s)) break;
      if (!hardClearAt(px, py)) continue;
      const s = scoreIfBetter(boxAt(px, py), bestGraze?.s ?? null);
      if (s !== null) bestGraze = { px, py, s };
    }
    // A horizontal step off a HORIZONTAL leg is a slide ALONG the own line, which
    // costs the chip nothing; off a VERTICAL leg the same step is PERPENDICULAR
    // to it, and buys its clearance by moving the chip off the line it labels.
    // Only the second needs a gate, and on a vertical leg the gate has to be
    // measured in the box the step STARTS FROM -- the anchor's -- because a step
    // moves that box and nothing else. A blockage the least-bad on-line seat
    // carries can sit hundreds of units away on a different leg, where no step
    // here reaches it.
    //
    // Parallel is judged on the dominant axis, so a chamfer diagonal counts as
    // the leg it turns into rather than as its own direction.
    const ownSegVerticalAt = (px: number, py: number): boolean => {
      let best = Infinity;
      let vertical = false;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const d = pointSegDistance([px, py], a, b);
        if (d >= best) continue;
        best = d;
        vertical = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
      }
      return vertical;
    };
    const anchorBox = boxAt(anchorX, anchorY);
    const ownVertical = ownSegVerticalAt(anchorX, anchorY);
    // What qualifies for tier 1c on a vertical leg: a foreign stroke inside the
    // anchor's box running PARALLEL to the own line -- a neighbour sharing the
    // corridor, which no motion ALONG the line can get out of the box because
    // the box travels beside it the whole way (the issue-#28 twin-corridor shape
    // this tier was written for). A stroke that merely CROSSES does not qualify:
    // sliding walks the box off it, and a line running UNDER a chip is
    // unambiguous to the reader anyway -- the same reading the braid term is
    // built on. Ungated, tier 1c stepped a chip flush off a short bend-column
    // vertical whenever a long clear leg happened to be crossed often enough,
    // which is the orphan shape bought against a crossing that confused nobody.
    const parallelAtAnchor = field
      .foreignLineWindows(anchorBox, flowKey, target, entryBand, ownIds)
      .some(([x0, y0, x1, y1]) => {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        return Math.hypot(dx, dy) >= BIND_RUN && dy > dx === ownVertical;
      });
    // Tier 1c (sidestep): nothing along the own line is fully clear, but a
    // horizontal step can seat the box clear of everything. Free on a horizontal
    // leg, where it is a slide; on a vertical leg it is taken only against the
    // parallel neighbour above, and the walk is skipped otherwise so the graze
    // tier below keeps the chip on its line. A null bestGraze opens the gate
    // either way: no point on the line clears even the HARD invariants, so there
    // is no on-line seat to prefer and the alternative is the offline escape
    // cascade, which leaves the line by more than a step does. That ordering is
    // why this walk sits below the graze scorer rather than above it.
    if (bestGraze === null || !ownVertical || parallelAtAnchor) {
      // The fully clear step is SCORED, not first-hit: a step that clears every
      // foreign line can still park the box on the chip's own card, which is the
      // one soft term tier 1 walked its whole line to avoid. Crossings and braids
      // are zero for all of these by definition (that is what fully clear means),
      // so only the own-card depth and the junction dots can separate them, in that
      // precedence; the enumeration order breaks the rest, keeping the nearest step
      // and the positive side. The walk stops at the first unbeatable step (off the
      // card, no dot), so the common case still costs one probe.
      let bestStep: { px: number; intrusion: number; dots: number } | null =
        null;
      for (const px of sidestepXs) {
        if (
          bestStep !== null &&
          bestStep.intrusion === 0 &&
          bestStep.dots === 0
        ) {
          break;
        }
        if (!isClear(px, anchorY)) continue;
        const box = boxAt(px, anchorY);
        const intrusion = field.ownCardIntrusion(box, exempt);
        const dots = field.dotsCovered(box);
        if (
          bestStep === null ||
          intrusion < bestStep.intrusion ||
          (intrusion === bestStep.intrusion && dots < bestStep.dots)
        ) {
          bestStep = { px, intrusion, dots };
        }
      }
      if (bestStep !== null) return seat(bestStep.px, anchorY, "sidestep");
    }
    // Tier 1b' (scored sidestep), GATED on a braid the on-line seat could not
    // shed. Where the least-bad on-line candidate still has a foreign stroke
    // running alongside its own, no motion ALONG the line can help -- the two
    // strokes share the corridor for its whole length -- but a horizontal step
    // can improve everything ranked AROUND the braid. So the same offsets are
    // walked again under the HARD invariants only, scored on the same four terms,
    // and one is taken only if it strictly beats the on-line seat: ties keep the
    // chip on its line, which is the issue-#9 preference the graze tier exists to
    // protect.
    //
    // What the step cannot buy is the braid itself, and that is arithmetic, not
    // ranking: a foreign stroke at gap g from the own line only leaves the box
    // once the offset exceeds halfW - g, a braid has g <= BIND_NEAR (8) by
    // definition, and the reach is halfW / 2 -- 112 needed against 60 allowed for
    // the 120 half-width, and the per-chip seat box shrinks BOTH sides of that
    // comparison (ruling R12), so it never closes. So the braid is the GATE, and
    // what the step sheds is a FAR crossing the wide box straddles, own-card
    // depth, or a buried junction dot.
    //
    // Two things this must not become. It is not nearest-first, and it keeps the
    // BEST offset rather than the first improving one: the strokes a step can
    // shed are the ones near the box's far edge, so a near offset often changes
    // nothing while a farther one still inside the cap sheds more -- a walk that
    // stopped at the first improvement would seat short of it. And it is not
    // ungated: the graze walk is already ~97 candidates against every segment of
    // every edge, and a second pass over ~16 offsets on every chip that reaches
    // this tier would multiply the cost of a synchronous layout pass for the
    // chips that have nothing to gain. A braid in the ANCHOR's box is what pays
    // for the second pass -- the anchor's, not the graze seat's, because the
    // anchor is where the step happens. Scored against a graze seat on a
    // DIFFERENT leg, a step into the open beats it on every occlusion term by
    // construction (there is nothing where it lands to occlude), and none of the
    // four terms can see that it left its line to get there; the strict-improvement
    // rule below only protects the line while the two candidates are comparable,
    // which off a vertical leg they are not.
    //
    // Its reach is sidestepMax, the containment bound the fully clear tier now
    // shares (SIDESTEP_MAX derives it): at an offset within half the reserve the
    // own line stays inside the painted box down to counter-scale 1 (zoom 1),
    // which covers every reading camera; past it the chip reads as an orphan
    // floating beside its line. Measured before the bound reached tier 1c: the
    // one corpus seat this tier moved to a flush 120 (multi6 e:18) shed both its
    // strokes and became exactly that orphan. Shedding a 3-unit braid needs
    // almost the whole reserve, so under this bound neither tier can separate the
    // tightest braids at all -- that is the R11/R12 trade, and the per-chip seat
    // box does not buy it back, because it narrows the reach in step with the box.
    const stepBraid = ownVertical
      ? bindingAt(anchorBox) > 0
      : bestGraze !== null && bestGraze.s.binding > 0;
    if (bestGraze !== null && stepBraid) {
      let stepped: { px: number; s: GrazeScore } | null = null;
      for (const px of sidestepXs) {
        if (!hardClearAt(px, anchorY)) continue;
        const s = scoreIfBetter(boxAt(px, anchorY), stepped?.s ?? bestGraze.s);
        if (s !== null) stepped = { px, s };
      }
      if (stepped !== null) return seat(stepped.px, anchorY, "sidestep");
    }
    if (bestGraze !== null) return seat(bestGraze.px, bestGraze.py, "graze");
    return null;
  }
  // The whole own line is chip- or card-blocked. Escapes off the line follow
  // the ratified priority order: chip/chip and chip/card clearance are HARD,
  // staying on the line and clearing foreign lines are preferences that yield.
  // Tier 2: a SHORT bidirectional vertical nudge off the anchor that clears
  // chips, cards, AND foreign lines (cap NUDGE_CAP_STEPS): the parallel-edge
  // chip lifts a step or two and stays fully clean.
  for (let k = 1; k <= NUDGE_CAP_STEPS; k++) {
    for (const dy of [k * CHIP_NUDGE_STEP, -k * CHIP_NUDGE_STEP]) {
      if (isClear(anchorX, anchorY + dy)) {
        return seat(anchorX, anchorY + dy, "nudge");
      }
    }
  }
  // Tier 3: cascade against CHIPS AND CARDS only (foreign lines waived),
  // bidirectionally, nearest escape first (ties prefer down). Cards are
  // finite, so a clear slot always exists within a few card heights; the cap
  // only bounds the search. This upholds the two HARD invariants -- no two
  // chips overlap, no chip on a foreign card -- at the cost of the chip
  // grazing a foreign line (ratcheted) and sitting off its own polyline
  // (ratcheted). The own-port band is hard here too, so an escape never
  // parks on its own port.
  for (let k = 0; k <= LAST_RESORT_CAP_STEPS; k++) {
    const deltas = k === 0 ? [0] : [k * CHIP_NUDGE_STEP, -k * CHIP_NUDGE_STEP];
    for (const delta of deltas) {
      if (hardClearAt(anchorX, anchorY + delta)) {
        return seat(anchorX, anchorY + delta, "escape");
      }
    }
  }
  // Bounded search exhausted (never expected: cards are finite). Park at the
  // anchor; the caller's DEV warning fires on this tier.
  return seat(anchorX, anchorY, "exhausted");
}

// The card border, in graph units per side: the 1px frame a rendered card draws
// around its content box (canvas.css .recipe-node / .product-node). It is the
// same discrepancy nodeGeometry's PORT_DRIFT.recipe derives its handle offsets
// from, seen from the box side instead of the port side, so the two must be
// re-derived together, in their two homes.
export const CARD_BORDER = 1;

// How much WIDER and TALLER a node's DRAWN border box is than the model box the
// layout positions it by, per node kind. Its origin never moves: the wrapper
// sits at the model position and the border grows the box on the right and the
// bottom only.
//   recipe: the card is content-box RECIPE_WIDTH (300) with a CARD_BORDER frame
//     per side, so the drawn box is 302 wide and two units taller than
//     recipeHeight -- exactly the offset nodeGeometry's PORT_DRIFT.recipe
//     derivation records.
//   product: the model width ALREADY counts the card's borders (124 content +
//     20 padding + 1 border + a 3 accent border = the 148 layout assigns), so
//     the drawn box is the model box.
//   loop / container: sized by inline width / height in model units, so the
//     border stays inside the box and likewise adds no growth.
// Measured in-browser across the seven corpus scenarios (recipe 302 x
// recipeHeight+2 everywhere, product 148x78, group == its model size, no loop
// node in any corpus plan). Re-derive alongside nodeGeometry's PORT_DRIFT
// whenever a card's border or box-sizing changes.
const CARD_GROWTH: Record<"recipe" | "product" | "other", number> = {
  recipe: 2 * CARD_BORDER,
  product: 0,
  other: 0,
};

// The drawn-vs-model box growth for one node kind, keyed by the `type` string
// React Flow carries on the node (and the e2e audit reads off the DOM), so the
// audit can state the same contract against the rendered card.
export function cardGrowth(type: string | undefined): number {
  if (type === "recipe") return CARD_GROWTH.recipe;
  if (type === "product") return CARD_GROWTH.product;
  return CARD_GROWTH.other;
}

// The frame width one node kind draws per side (half its growth).
function cardBorder(type: string | undefined): number {
  return type === "recipe" ? CARD_BORDER : 0;
}

// The raw card rects a chip's box must stay clear of, so a chip never sits on
// top of a foreign node (the P3 hard invariant). Every node type is included --
// recipe / product / loop cards and group slabs -- mirroring the chip/card
// audit; the per-edge exemption the seating pass applies is the same one the
// audit applies.
//
// These are DRAWN border boxes, the same frame drawnPortsOf reconstructs the
// polylines in: the model box grown by CARD_GROWTH, which is zero for every
// kind but the recipe card, whose 1px border makes it 302 wide against the
// model's 300 (see CARD_BORDER). The audit collects the rendered card rect
// straight off the DOM, so measuring the model box here would leave the two
// frames two units apart on every recipe -- a chip could clear a card in the
// seating pass and overlap its drawn border in the browser.
//
// Exported so a unit test can observe the growth actually being applied: the
// e2e card-frame criterion rebuilds the same constants and so cannot see this
// call site at all.
export function cardRectsFor(
  nodes: ReadonlyArray<RFAnyNode>,
  byId: ReadonlyMap<string, RFAnyNode>,
): CardRect[] {
  return nodes.map((n) => {
    const left = absoluteLeft(n, byId);
    const top = absoluteTop(n, byId);
    const growth = cardGrowth(n.type);
    return {
      id: n.id,
      left,
      top,
      right: left + nodeWidth(n) + growth,
      bottom: top + nodeHeight(n) + growth,
      border: cardBorder(n.type),
    };
  });
}

// One drawn junction dot and the family it belongs to. The four families are
// drawn by three different components -- BusEdge draws the lane member's branch
// dot and the fan-out trunk's split dot from the path builders, ItemEdge draws
// the fan-in merge dot and the declined-fan-out divergence dot from the stamps
// below -- but they are one obstacle class to the seating phases, so the
// collected set keeps the family only as a label.
type JunctionDotKind = "lane" | "fanout" | "fanin" | "divergence";
export type JunctionDot = { x: number; y: number; kind: JunctionDotKind };

// Every edge-data field the seating phases stamp. Picking them off the types
// that declare them makes a rename at the declaration a build error here.
const SEAT_PATCH_KEYS = [
  "labelDx",
  "labelDy",
  "chipIconOnly",
  "chipScaleCap",
  "faninJunctionX",
  "faninJunctionY",
  "faninChipHidden",
  "faninChipHiddenAtY",
  "fanoutJunctionX",
  "fanoutJunctionY",
  "crossingCues",
  "busChipX",
  "busDropDy",
  "busChipDy",
  "busRiseHidden",
  "fanoutAggDx",
  "fanoutAggDy",
  "fanoutBranchDx",
  "fanoutBranchDy",
  "fanoutBranchIconOnly",
  "fanoutBranchScaleCap",
  "fanoutBranchHidden",
  "fanoutBranchHiddenAt",
] as const;
type SeatPatchKey = (typeof SEAT_PATCH_KEYS)[number];
type PickSeatKeys<T> = Pick<T, Extract<SeatPatchKey, keyof T>>;
type SeatPatch = Partial<
  PickSeatKeys<ItemEdgeData> &
    PickSeatKeys<LaneBusEdgeData> &
    PickSeatKeys<FanoutBusEdgeData>
>;

// The drag-end re-seat: strip every stamp the pass owns and run it again on
// the moved nodes. The routing hints earlier passes wrote stay, as the live
// edge paths keep reading them. An untouched edge comes back by reference.
export function reseatChips(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const clean = edges.map((edge) => {
    if (edge.data === undefined) return edge;
    const data: Record<string, unknown> = edge.data;
    if (!SEAT_PATCH_KEYS.some((key) => key in data)) return edge;
    const stripped = { ...data };
    for (const key of SEAT_PATCH_KEYS) delete stripped[key];
    return { ...edge, data: stripped };
  });
  return deconflictChipAnchors(nodes, clean);
}

export function deconflictChipAnchors(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Reconstructed edge polylines, obstacles for the bus / rate seats: a chip
  // must not sit on a FOREIGN edge's line (the reader would bind the rate to
  // the wrong flow). Edges of one flow -- same (item, source), i.e. a trunk's
  // members sharing a lane or a fanout's slices sharing their common
  // trajectory -- are one visual line, so a chip may sit on its own flow's
  // siblings. Reconstruction mirrors the render components (same builders,
  // same hints), so the avoided lines are the drawn ones. Item edges also
  // cache their parsed points and clear-segment anchor here, so the rate-chip
  // phase below neither rebuilds the path nor re-parses the `d` string.
  const flowKeyOf = (edge: Edge): string =>
    busFlowKey(edgeItem(edge), edge.source);
  const edgeSegments: EdgeSegments[] = [];
  // The edges-array index of each edgeSegments entry, parallel to it: the
  // crossing-cue pass below reads it to key each edge's stamped-cue list,
  // while the segment list skips edges with unresolvable endpoints.
  const edgeIndexOfSegment: number[] = [];
  type ItemGeom = {
    pts: ReadonlyArray<readonly [number, number]>;
    lx: number;
    ly: number;
  };
  const itemGeomByIndex = new Map<number, ItemGeom>();
  // Fan-out members cache their reconstructed geometry (points + the two chip
  // anchors) so the fan-out seating phase below neither rebuilds the path nor
  // re-parses the `d` -- the lockstep mirror of itemGeomByIndex for rate chips.
  type FanoutGeom = {
    pts: ReadonlyArray<readonly [number, number]>;
    // The member's OWN leg (see branchLegAfterJunction): the polyline the
    // branch chip's seat slides over and the branch short-leg rule measures.
    branchPts: ReadonlyArray<readonly [number, number]>;
    junction: { x: number; y: number };
    trunkAnchor: { x: number; y: number };
    branchAnchor: { x: number; y: number };
    owner: boolean;
  };
  const fanoutGeomByIndex = new Map<number, FanoutGeom>();
  // Lane bus members cache the junction BusEdge draws at their branch point.
  // Taken from the same chamferBusPath result the polyline comes from, so the
  // cached dot is the drawn dot rather than a second derivation of it.
  const laneJunctionByIndex = new Map<number, { x: number; y: number }>();
  // Item edges whose clear window cannot hold their own rate chip: the chip
  // renders icon-only.
  const shortLegByIndex = new Set<number>();
  // FAN-OUT members whose branch chip renders icon-only, either because its own
  // leg lacks the usable width or because the member sits in a contested
  // corridor. Decided once, here: the seat below reserves the collapsed box so
  // the narrower chip can slide clear of the trunk's split dot, and the emit
  // loop stamps the same verdict, so the box that was reserved is the box that
  // gets drawn.
  const branchIconOnlyByIndex = new Set<number>();
  // The longest clear run of each item edge / fan-out branch leg (null when
  // the port bands blanket it): the collapse verdict, the seat's capped
  // reserve and its preferred candidate all read it.
  const clearSpanByIndex = new Map<number, XSpan | null>();
  // Final-leg points of each item edge pinned to a shared fan-out column: the
  // stretch of its polyline its rate chip may seat on (see the slice below).
  const fanoutLegPtsByIndex = new Map<
    number,
    ReadonlyArray<readonly [number, number]>
  >();
  // The counter-scale cap each seat allows (RateSeat.scaleCap).
  const scaleCapByIndex = new Map<number, number>();
  // The drawn card rects a chip's box must stay clear of (see cardRectsFor);
  // the clearance field consumes the same array.
  const cards: CardRect[] = cardRectsFor(nodes, byId);
  const cardsById = new Map(cards.map((c) => [c.id, c] as const));
  // The card exemption for an edge's chips: its own source / target cards get a
  // port-adjacent zone (issue #10, exempt while the chip centre stays in the port
  // strip), their containing groups (one parentId level, same as the audit's
  // containersAt) stay wholly exempt. The source zone hugs the source card's
  // right edge (out-port), the target zone its left edge (in-port).
  const cardExemptFor = (edge: Edge): CardExemption => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const whole = new Set<string>();
    const zones = new Map<string, PortZoneSide>();
    if (source !== undefined) {
      if (source.parentId !== undefined) whole.add(source.parentId);
      zones.set(source.id, "source");
    }
    if (target !== undefined) {
      if (target.parentId !== undefined) whole.add(target.parentId);
      zones.set(target.id, "target");
    }
    return { whole, zones };
  };
  // The x-ranges of an edge's own endpoint port bands.
  const ownPortBandXs = (edge: Edge): XSpan[] => {
    const out: XSpan[] = [];
    for (const [id, side] of cardExemptFor(edge).zones) {
      const card = cardsById.get(id);
      if (card === undefined) continue;
      const band = portKeepOutRect(card, side);
      out.push({ lo: band.left, hi: band.right });
    }
    return out;
  };
  // Measure a chip's clear window on its line and return whether the chip's
  // natural box fits it.
  const measureWindow = (
    index: number,
    pts: ReadonlyArray<readonly [number, number]>,
    bands: ReadonlyArray<XSpan>,
    text: ChipText | undefined,
  ): boolean => {
    const span = largestClearSpan(pts, bands);
    clearSpanByIndex.set(index, span);
    return span !== null && span.hi - span.lo >= chipNaturalWidth(text);
  };
  edges.forEach((edge, index) => {
    if (edge.type !== "item" && edge.type !== "bus") return;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) return;
    const { sx, sy, tx, ty } = ends;
    let d: string;
    if (edge.type === "bus" && (edge.data as BusEdgeData | undefined)?.fanout) {
      const fan = chamferFanoutPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        ...routingHintsFromData(edge.data),
      });
      d = fan.path;
      const fanPts = parsePathPoints(d);
      const branchPts = branchLegAfterJunction(fanPts, fan.junction);
      fanoutGeomByIndex.set(index, {
        pts: fanPts,
        branchPts,
        junction: fan.junction,
        trunkAnchor: fan.trunkAnchor,
        branchAnchor: fan.branchAnchor,
        // Deliberately STRICTER than isTrunkOwner, which reads absent as owner:
        // routeFanoutEdges always stamps the field in production, so the two
        // rules only diverge on hand-built fixtures. Unifying them is
        // render-visible and out of scope here.
        owner: (edge.data as BusEdgeData | undefined)?.busChipOwner === true,
      });
      // The branch gate reads the member's own leg, never the trunk-including
      // polyline, and its window also subtracts the split dot's keep-off: the
      // chip must fit between the split and the target's furniture. A
      // contested corridor collapses the chip too: the wide box reaches the
      // sibling trunk's column from every seat there.
      const bands = ownPortBandXs(edge);
      bands.push({ lo: -Infinity, hi: fan.junction.x + DOT_KEEPOFF });
      if (
        !measureWindow(index, branchPts, bands, branchChipText(edge)) ||
        (edge.data as FanoutBusEdgeData).fanoutContested === true
      )
        branchIconOnlyByIndex.add(index);
    } else if (edge.type === "bus") {
      // Narrow the union on `"laneY" in` (the same discriminant laneBands and the
      // census helpers use) rather than a bare LaneBusEdgeData cast: it does not
      // silently assume this bus edge is the lane variant just because the fan-out
      // branch ran first.
      const data = edge.data as BusEdgeData | undefined;
      const laneY = data !== undefined && "laneY" in data ? data.laneY : ty;
      const lane = chamferBusPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        laneY,
        ...routingHintsFromData(edge.data),
      });
      d = lane.path;
      // A lone-member trunk draws no junction dot (nothing branches at its
      // corner; BusEdge mirrors this), so it registers no keep-off either --
      // otherwise the keep-off would evict the rise chip off the lane to dodge
      // a dot that is not there (#83).
      if ((data?.busMemberCount ?? 1) > 1) {
        laneJunctionByIndex.set(index, lane.junction);
      }
    } else {
      const [path, lx, ly] = chamferStepPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        ...routingHintsFromData(edge.data),
      });
      d = path;
      const itemPts = parsePathPoints(d);
      itemGeomByIndex.set(index, { pts: itemPts, lx, ly });
      // A member pinned to a fan-out trunk's SHARED column draws its vertical
      // on the same line as every sibling, and the split dot sits at its top.
      // Its chip belongs on the horizontal run that is the member's ALONE, so
      // the window is banded off at the column exactly as a formed fan-out
      // branch's is: no seat may slide back onto the shared vertical, and the
      // collapse below then fires only when that run is narrower than the chip.
      const bands = ownPortBandXs(edge);
      const itemData = edge.data as ItemEdgeData | undefined;
      if (itemData?.fanoutColumn === true && itemData.bendX !== undefined) {
        // The DRAWN column: a jog that had to clear a blocked source leg
        // replaces it outright (srcColX), exactly as chamferStepPath resolves
        // it, so the band never sits on a line this member does not draw.
        const drawnBx =
          routingHintsFromData(edge.data).srcColX ??
          forwardStepGeometry(sx, tx, itemData.bendX).bx;
        const keepOff = drawnBx + DOT_KEEPOFF;
        bands.push({ lo: -Infinity, hi: keepOff });
        // The seat slides along the points it is given, so a pinned member is
        // seated on that own run alone. Without this a crowded chip could slide
        // back over the bend onto the column every sibling draws, which is the
        // stack the whole formation exists to avoid (the fan-out branch seat
        // confines itself to branchLegAfterJunction for the same reason). The
        // run is the last segment -- the horizontal into the target port -- or,
        // when jogForwardLegs bent the approach, the cleared horizontal at
        // legY, which is where chamferStepPath anchors such a member. Either is
        // clipped to start past the column's keep-off.
        const own =
          itemData.legY === undefined
            ? itemPts.slice(itemPts.length - 2)
            : horizontalRunAt(itemPts, itemData.legY);
        const clipped = clipRunLeft(own, keepOff);
        if (clipped !== null) fanoutLegPtsByIndex.set(index, clipped);
      }
      if (!measureWindow(index, itemPts, bands, rateChipText(edge)))
        shortLegByIndex.add(index);
    }
    const pts = itemGeomByIndex.get(index)?.pts ?? parsePathPoints(d);
    const segs: Array<readonly [number, number, number, number]> = [];
    for (let i = 1; i < pts.length; i++) {
      segs.push([pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]]);
    }
    edgeSegments.push({
      id: edge.id,
      flowKey: flowKeyOf(edge),
      target: edge.target,
      segs,
    });
    edgeIndexOfSegment.push(index);
  });

  // Phase 0c -- crossing cues (unmarked-same-item-crossing). Where two
  // reconstructed polylines of DIFFERENT flows (different item|source)
  // properly cross, the pair reads as a bare X -- and a bare X of two
  // strokes is indistinguishable from a join, which is exactly the confusion
  // the merge dot exists to prevent on the other side. Stamp the crossing
  // point on ONE edge of the pair: that edge's renderer masks its own stroke
  // out around the point (see CrossingCueMask), so the other edge's stroke
  // shows through the gap and the pair reads as one flow passing under the
  // other.
  //
  // WHY a mask on one edge rather than a background-coloured disk on the
  // edge painting above: a gap cut out of a stroke is transparent, so it
  // leaves the container slab tint, the bus band tint and their hairlines
  // untouched, and it reads the same whichever edge paints above. React
  // Flow renders every edge in its own <svg style={{zIndex}}> whose z folds
  // in the endpoint NODES' z, and a SELECTED node is lifted to z 1000 (a
  // default, and a drag auto-selects), so "which edge paints above" is not
  // a rest-time constant; a masked gap needs no such ruling, because the
  // continuous stroke is the only one drawn there in either order. The
  // stamped edge is simply the earlier one in the edges array: any
  // consistent choice draws the same picture, and where several members of
  // one trunk cross a foreign edge at one shared point (overlapping lane
  // runs), the mixture of stamps still reads right -- a member's gap is
  // covered by its unstamped siblings' continuous runs, and the foreign
  // edge's gap is the one that shows.
  //
  // The pass is presentational only -- no edge is retyped, no chip moves, no
  // routing changes -- and the CROSSING ratchet above the routing passes is
  // untouched: this adds cues, not crossings.
  //
  // Why properCross semantics are the whole safety argument (the negative
  // tests pin each clause): a strict-interior crossing can never fire on
  //   - a collinear fan-in merge run (collinear overlap, not opposite
  //     orientations),
  //   - a bus lane's overlapping member runs (collinear) or a foreign
  //     member's drop/rise column meeting the lane (the column ENDS at
  //     laneY, an endpoint touch on the run's interior), or
  //   - a shared fan-out trunk (the members leave the junction from one
  //     shared vertex, so every intersection is an endpoint touch), or its
  //     FAR members, the item edges pinned to the same junction column: their
  //     verticals overlap collinearly on that column and they are same-flow
  //     besides, so neither clause can fire between two members of one trunk,
  // so the cue cannot mark a real merge or a trunk as a crossing. Same-flow
  // pairs are skipped outright: one flow is one visual line (the flowKey
  // doctrine the chip clearance tiers already apply).
  //
  // O(S^2) over segment pairs of different flows, the same shape as the e2e
  // crossing census. Points are rounded to the emitted paths' two decimals and
  // deduped per edge: the members of one trunk share a lane exactly, so their
  // crossings with one foreign edge land on the same point and one gap must
  // draw there, not six stacked cut-outs. Each stamp carries every partner
  // edge crossing there -- its id and endpoint NODE anchors (see
  // crossingPartnerBits): the render-side staleness rule needs the OTHER
  // side's identity to drop the cue once a drag moves every partner off the
  // crossing, which the point alone cannot express, and it must not drop
  // the gap while a sibling partner still crosses there.
  const crossingCuesByIndex = new Map<number, Array<CrossingCue>>();
  {
    // The partner record for one segment entry: its edge id plus its two
    // endpoint node ABSOLUTE origins (rounded to the stamp's two decimals).
    // Every segment entry resolved its endpoints (drawnPortsOf returned
    // non-null), so both nodes exist here.
    const partnerStampOf = (segIdx: number): CrossingCuePartner => {
      const edge = edges[edgeIndexOfSegment[segIdx]!]!;
      const anchorOf = (nodeId: string): { x: number; y: number } => {
        const node = byId.get(nodeId)!;
        return {
          x: Math.round(absoluteLeft(node, byId) * 100) / 100,
          y: Math.round(absoluteTop(node, byId) * 100) / 100,
        };
      };
      return {
        edgeId: edgeSegments[segIdx]!.id,
        source: anchorOf(edge.source),
        target: anchorOf(edge.target),
      };
    };
    // Cue by (stamped edge, point), so a second partner crossing the same
    // point joins the existing cue's partner list instead of stacking a
    // second cut-out.
    const cueByKey = new Map<
      string,
      { cue: CrossingCue; partners: Array<CrossingCuePartner> }
    >();
    for (let i = 0; i < edgeSegments.length; i++) {
      for (let j = i + 1; j < edgeSegments.length; j++) {
        const si = edgeSegments[i]!;
        const sj = edgeSegments[j]!;
        if (si.flowKey === sj.flowKey) continue;
        for (const sa of si.segs) {
          for (const sb of sj.segs) {
            const p = properCrossPoint(
              [sa[0], sa[1]],
              [sa[2], sa[3]],
              [sb[0], sb[1]],
              [sb[2], sb[3]],
            );
            if (p === null) continue;
            const x = Math.round(p[0] * 100) / 100;
            const y = Math.round(p[1] * 100) / 100;
            // The earlier edge carries the gap; the later one is a partner.
            const stampIndex = edgeIndexOfSegment[i]!;
            const key = `${stampIndex}|${x}|${y}`;
            let entry = cueByKey.get(key);
            if (entry === undefined) {
              const partners: Array<CrossingCuePartner> = [];
              entry = { cue: { x, y, partners }, partners };
              cueByKey.set(key, entry);
              const list = crossingCuesByIndex.get(stampIndex) ?? [];
              list.push(entry.cue);
              crossingCuesByIndex.set(stampIndex, list);
            }
            entry.partners.push(partnerStampOf(j));
          }
        }
      }
    }
  }

  // Accumulate the per-member exemptions of a trunk into one union (containers
  // merge into `whole`, endpoint zones into `zones`). A shared source port
  // resolves to the same zone across members, so overwriting is a no-op there.
  type MutCardExemption = {
    whole: Set<string>;
    zones: Map<string, PortZoneSide>;
  };
  const mergeExemptionInto = (
    into: MutCardExemption,
    from: CardExemption,
  ): void => {
    for (const id of from.whole) into.whole.add(id);
    for (const [id, z] of from.zones) into.zones.set(id, z);
  };

  // The target entry band of an edge: the padded-left gutter of its consumer
  // card, mirroring paddedObstacles' overhangs. The arrival-cluster exemption
  // holds only while a rate chip's centre sits here (the narrowed rate-chip
  // rule), so both the fan-out branch phase and the item phase build it. The
  // non-null assertion holds because every caller has already skipped an edge
  // whose target is missing from byId.
  const entryBandOf = (edge: Edge): EntryBand => {
    const target = byId.get(edge.target)!;
    const tx = absoluteLeft(target, byId);
    const targetTop = absoluteTop(target, byId);
    return {
      left: tx - OBSTACLE_PAD_LEFT,
      right: tx,
      top: targetTop - OBSTACLE_PAD_Y,
      bottom: targetTop + nodeHeight(target) + OBSTACLE_PAD_Y,
    };
  };

  // Phase 0 -- junction-dot geometry. Every junction dot the render layer draws
  // resolves here, before the first chip seats. Two families come straight off
  // the path builders the reconstruction above already ran (the lane members'
  // branch dots, the fan-out trunks' split dots); the other two are derived
  // below (the fan-in merge dots, the declined fan-outs' divergence dots). All
  // four are pure functions of the reconstructed polylines and touch no seating
  // state, so resolving them up front moves no dot -- it only makes the whole
  // dot set known to every phase that follows.

  // Phase 0a -- fan-in markers: fan-in is structurally unmodeled (every trunk
  // key is (item, source), never (item, target)), so where 2+ forward same-item
  // edges enter ONE target in-port their final legs run collinear at the port y
  // with no junction dot. Stamp ONE merge dot on the shared run (drawn by the
  // elected owner's ItemEdge), and suppress any NON-OWNER member whose own rate
  // chip would sit ON that shared run. Its only input is the reconstructed
  // polylines above -- a dual-role edge's fan-out geometry included -- so it
  // resolves before any chip seats; the item phase reads the suppression back
  // at seat time, where a member that SLID onto the run is still caught. It is
  // presentational only: no edge is retyped and a fan-out member keeps its
  // fan-out role.
  //
  // Every comparison below is in the DRAWN frame: the port coordinates come from
  // drawnPortsOf, the same reconstruction the polylines above were built from,
  // so FANIN_EPS is a real collinearity tolerance rather than a budget already
  // spent on the frame mismatch. Taking the raw model port instead left every
  // recipe target off by the recipe row drift (and the run's right bound off by
  // targetDx), which sat exactly at the eps: the sub-pixel rounding of a
  // fractional layout y was then enough to tip a genuine merge out of detection.
  const FANIN_EPS = 1;
  type FaninMember = {
    index: number;
    id: string;
    source: string;
    joinX: number;
    isItem: boolean;
    anchorX: number;
    anchorY: number;
  };
  const faninGroups = new Map<string, FaninMember[]>();
  const faninTargetByKey = new Map<string, { tx: number; ty: number }>();
  // (item, target) ports that ALSO receive a same-item edge outside the marker's
  // scope (a lane-bus rise, a backward rail, or any non-collinear approach). A
  // dot there would mark only the collinear members' merge and misstate where
  // the card's input row is fed from, so such a port gets NO marker at all.
  const faninExcludedKeys = new Set<string>();
  edges.forEach((edge, index) => {
    const item = edgeItem(edge);
    if (item === undefined) return;
    // The drawn target port, from the same reconstruction the polylines came
    // from. Null only when an endpoint is missing from the node map, the case
    // the geometry pass above skipped too.
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) return;
    const { tx, ty } = ends;
    const key = item + "|" + edge.target;
    const itemGeom = itemGeomByIndex.get(index);
    const fanGeom = fanoutGeomByIndex.get(index);
    let pts: ReadonlyArray<readonly [number, number]>;
    let anchorX = 0;
    let anchorY = 0;
    let isItem = false;
    if (itemGeom !== undefined) {
      pts = itemGeom.pts;
      anchorX = itemGeom.lx;
      anchorY = itemGeom.ly;
      isItem = true;
    } else if (fanGeom !== undefined) {
      pts = fanGeom.pts;
    } else {
      // Lane bus members approach via a rise column, not along the port-y run.
      faninExcludedKeys.add(key);
      return;
    }
    if (pts.length < 2) {
      faninExcludedKeys.add(key);
      return;
    }
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (last[0] <= first[0]) {
      // Backward rail: enters through the gutter, not along the shared run.
      faninExcludedKeys.add(key);
      return;
    }
    const secondLast = pts[pts.length - 2]!;
    if (Math.abs(secondLast[1] - ty) > FANIN_EPS) {
      // Final leg not at the port y: feeds the port off the shared run.
      faninExcludedKeys.add(key);
      return;
    }
    const list = faninGroups.get(key) ?? [];
    list.push({
      index,
      id: edge.id,
      source: edge.source,
      joinX: secondLast[0],
      isItem,
      anchorX,
      anchorY,
    });
    faninGroups.set(key, list);
    faninTargetByKey.set(key, { tx, ty });
  });
  const faninJunctionByIndex = new Map<number, { x: number; y: number }>();
  const faninChipHiddenByIndex = new Set<number>();
  // Per NON-OWNER item member of a fan-in group: the merge x and port y of its
  // shared run. The item phase reads this to decide, AT SEAT TIME, whether the
  // member's own chip landed ON the shared run (where the owner's own chip
  // already reads) and should hide -- a member chip that slides onto the run
  // cannot be caught by its anchor alone.
  const faninMemberRunByIndex = new Map<
    number,
    { mergeX: number; tx: number; ty: number }
  >();
  for (const [key, members] of faninGroups) {
    if (members.length < 2) continue;
    // Mixed-feed port: an out-of-scope same-item edge (lane-bus rise, backward
    // rail, non-collinear approach) also enters this port, so a dot on the
    // collinear members' join would mark a partial merge. No marker.
    if (faninExcludedKeys.has(key)) continue;
    // Fan-in needs 2+ DISTINCT incoming flows. Same-(item, source) edges are one
    // flow (a parallel bundle already drawn as one visual line), not a merge, so
    // require distinct sources before marking a junction.
    if (new Set(members.map((m) => m.source)).size < 2) continue;
    // The owner draws the marker via its ItemEdge, so it must be an item edge.
    const itemMembers = members.filter((m) => m.isItem);
    if (itemMembers.length === 0) continue;
    const { tx, ty } = faninTargetByKey.get(key)!;
    // The merge point: where the LAST member joins the shared run (the rightmost
    // final-leg start). The dot marks it; the run [mergeX, tx] is where all
    // members are collinear at the port y.
    const mergeX = Math.max(...members.map((m) => m.joinX));
    const runLen = tx - mergeX;
    if (runLen <= 2 * CHAMFER) continue; // no real shared run to mark
    const owner = itemMembers.reduce((a, b) => (a.id <= b.id ? a : b));
    faninJunctionByIndex.set(owner.index, { x: mergeX, y: ty });
    for (const m of itemMembers) {
      // The OWNER is exempt from the shared-run hide: it is the member that
      // draws the merge dot, and since the summed aggregate that used to label
      // this run was removed (#39, #45), hiding the owner too would leave the
      // merged run carrying no number at all. Its chip seats under the ordinary
      // member rules; only its non-owner siblings yield the run, their rates
      // still readable on their own pre-merge legs.
      if (m.index === owner.index) continue;
      faninMemberRunByIndex.set(m.index, { mergeX, tx, ty });
    }
  }

  // Phase 0b -- declined fan-outs (#43): N >= 2 same-(item, source) item edges
  // into >= 2 distinct targets whose gap fell outside routeFanoutEdges' span
  // band stay plain ItemEdges. They leave the shared out-port coincident and
  // peel off one at a time, so the reader sees ONE line and takes a member's
  // rate for the whole flow. Mark the split with a junction dot on one owner
  // edge -- the counterpart of the fan-in merge dot above, and of the dot a real
  // fan-out trunk draws from BusEdge. Bus-typed members never reach here (they
  // have no item geometry), so an accepted trunk is not double-marked. No
  // aggregate chip rides along: a total would sit a few pixels from the source
  // card's own output row, which already states it (#39), and a declined
  // fan-out's shared prefix is too short to hold the box anyway. Presentational
  // only -- no edge is retyped and no chip moves.
  const fanoutJunctionByIndex = new Map<number, { x: number; y: number }>();
  // Keep-off points for the DECLINED group's dot-less corners: every bending
  // member's own peel-off column, whether or not the group renders a dot (the
  // non-owner peel-offs never do, and a group whose first bend hugs the port
  // renders none at all). A chip parked on one of those corners reads as the
  // junction the reader never gets to see, so they carry the same keep-off
  // rect geometry as the drawn dots -- but through the same dot set and the
  // same weakest-preference rank, never as a hard term (R13).
  const divergenceKeepoffs: Array<{ x: number; y: number }> = [];
  type DivergenceMember = {
    index: number;
    id: string;
    target: string;
    sx: number;
    sy: number;
    // x of the last vertex still on the source row, i.e. where this member
    // peels off. Undefined for a member that never leaves the row.
    bendX: number | undefined;
  };
  const divergenceGroups = new Map<string, DivergenceMember[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const geom = itemGeomByIndex.get(index);
    if (geom === undefined) return;
    const pts = geom.pts;
    if (pts.length < 2) return;
    const sx = pts[0]![0];
    const sy = pts[0]![1];
    // A backward member leaves through its own detour rail rather than sharing
    // a forward prefix, so it neither carries the dot nor counts as a target of
    // the split (the fan-in marker draws the same line at its own end).
    if (pts[pts.length - 1]![0] <= sx) return;
    let bendX: number | undefined;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]![1] - sy) > FANIN_EPS) {
        bendX = pts[i - 1]![0];
        break;
      }
    }
    const key = flowKeyOf(edge);
    const list = divergenceGroups.get(key) ?? [];
    list.push({ index, id: edge.id, target: edge.target, sx, sy, bendX });
    divergenceGroups.set(key, list);
  });
  for (const members of divergenceGroups.values()) {
    if (members.length < 2) continue;
    // Same-(item, source) edges into ONE unit are a parallel bundle drawn as a
    // single line, not a split -- the mirror of the fan-in distinct-sources rule.
    if (new Set(members.map((m) => m.target)).size < 2) continue;
    // The split becomes visible where the FIRST member peels off; before that
    // every member is still on the shared row. A group where nobody bends draws
    // no visible divergence at all, so it gets no dot.
    const bends = members.filter((m) => m.bendX !== undefined);
    if (bends.length === 0) continue;
    // EVERY bending member's own peel-off column carries a keep-off, dotted or
    // not: only the first peel-off can ever render the dot, and the port-hug
    // guard below can suppress even that -- but each column is still where one
    // line visibly becomes two, and a chip standing on it impersonates the
    // junction (the #43 reopen).
    for (const m of bends) divergenceKeepoffs.push({ x: m.bendX!, y: m.sy });
    const junctionX = Math.min(...bends.map((m) => m.bendX!));
    const owner = members.reduce((a, b) => (a.id <= b.id ? a : b));
    // A dot at the port itself would read as part of the source card's own
    // output row, not as a split in the run.
    if (junctionX <= owner.sx) continue;
    fanoutJunctionByIndex.set(owner.index, { x: junctionX, y: owner.sy });
  }

  // The distinct dots, in one keep-off set. Every member of a fan-out trunk
  // draws the same split dot, so the set is deduped per (family, point).
  const dotKeepoffs: JunctionDot[] = [];
  const seenDots = new Set<string>();
  const addDot = (p: { x: number; y: number }, kind: JunctionDotKind): void => {
    const key = kind + "|" + p.x + "|" + p.y;
    if (seenDots.has(key)) return;
    seenDots.add(key);
    dotKeepoffs.push({ x: p.x, y: p.y, kind });
  };
  for (const p of laneJunctionByIndex.values()) addDot(p, "lane");
  for (const g of fanoutGeomByIndex.values()) addDot(g.junction, "fanout");
  for (const p of faninJunctionByIndex.values()) addDot(p, "fanin");
  // The declined groups' peel-off corners ARE the divergence dot set: every
  // bending member's column is stamped below, and the first peel-off's entry
  // is the drawn dot's own point (the group's min bendX at the source-port y
  // every group member shares), so stamping the map's entries here as well
  // only added keys this loop already carries.
  for (const p of divergenceKeepoffs) addDot(p, "divergence");

  // The shared clearance field: every phase seats into `field.placed`, so a
  // later phase yields to everything an earlier phase placed. It carries the
  // dot set as a third static obstacle class beside the edge polylines and the
  // card rects -- hence its construction here, after phase 0, rather than
  // before: the dots are known and fixed by now, and every seat that follows
  // consults them through the one field.
  const field = makeClearanceField(edgeSegments, cards, dotKeepoffs);

  // Phases 1 and 2 -- bus chips: a LONE-member trunk draws one aggregate drop
  // chip (on the owner member); a multi-member trunk draws none (issue #39).
  // Every trunk draws one rise chip per member, all on the trunk's lane.
  // Reconstruct their lane anchors from the same geometry BusEdge uses
  // (chamferBusPath for dropX/riseX, busChipX for the spread rise slot) and
  // seat each one, cascading off the lane when it crowds a neighbour. Seating
  // is two-phase: every drawn drop chip settles first, then every rise chip,
  // each phase in edge-id order. The drop chip is the trunk's aggregate total
  // at its junction; interleaving by edge id alone would let an earlier
  // trunk's cascading rise land on a later trunk's junction and knock that
  // aggregate off its lane, so drop priority is structural, not an accident of
  // id order. Drop and rise carry separate offsets (busDropDy, busChipDy)
  // because a member's rise may need a different push than the trunk's shared
  // drop.
  const busDropDyByIndex = new Map<number, number>();
  const busChipDyByIndex = new Map<number, number>();
  // Clamped rise slots, stamped back onto edge data below so BusEdge's chip
  // anchor and contentBounds' frame read the same x this pass seated.
  const busChipXByIndex = new Map<number, number>();
  type BusSlot = {
    index: number;
    id: string;
    laneY: number;
    dropX: number;
    // The member's own resolved rise column, the clamp's window reference.
    riseX: number;
    // The trunk-wide spread slot as routeBusEdges stamped it, before the
    // clamp: undefined for the lone long-run member, whose riseChipX falls
    // back to the rise column and whom the clamp leaves slotless.
    riseSlot: number | undefined;
    riseChipX: number;
    owner: boolean;
    // Lane members sharing this trunk. Only a lone member draws (and so seats)
    // an aggregate drop chip.
    memberCount: number;
    // Lone member on a long lane detour: its rise chip is zoom-gate exempt
    // (#32) and labels the trunk on its own, so the drop seat is DEFERRED and
    // taken only if the rise phase ends up hiding that chip (BusEdge mirrors
    // the draw condition).
    longSingleRun: boolean;
    step: number;
    flowKey: string;
    target: string;
    trunkKey: string;
    // Target in-port y, the top-to-bottom key the rise seat loop stacks by.
    entryY: number;
    // Per-chip reserved half-widths (Task 10): what each seat reserves is the
    // box ITS chip draws -- the drop seat the aggregate text (the trunk total
    // the drop chip prints), the rise seat the member text (the share
    // "30/270" or the plain rate) -- through the same chipSeatHalfW estimate
    // the rate seats have carried since T6b. Until now both bus seats charged
    // the flat 240-wide clamp, so a "600/min" rise drawing about 162 units
    // read as blocked to the seat while the corridor beside it was open.
    // Falls back to the wide box inside the estimator itself (no usable
    // rate); the capacity comparator and MIN_CHIP_SEP stay wide regardless.
    dropHalfW: number;
    riseHalfW: number;
  };
  const busSlots: BusSlot[] = [];
  const busEdges = edges
    .map((edge, index) => ({ edge, index }))
    .filter(
      (e) =>
        e.edge.type === "bus" &&
        (e.edge.data as BusEdgeData | undefined)?.fanout !== true,
    )
    .sort((a, b) =>
      a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0,
    );
  for (const { edge, index } of busEdges) {
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) continue;
    // The DRAWN frame, through the same drawnPortsOf the polyline
    // reconstruction above uses. Rebuilding the model-frame ports here instead
    // put an unmoved trunk's drop column one source-port drift out from where
    // BusEdge paints it (5 units on a recipe source, 4 on a product), so the
    // drop chip reserved its clearance box beside its junction rather than on
    // it -- and this was the last seat left in the model frame, with BusEdge,
    // contentBounds and the placement audit all reading the drawn one.
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const { sx, sy, tx, ty } = ends;
    const { dropX, riseX } = chamferBusPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      laneY: data.laneY,
      ...routingHintsFromData(edge.data),
    });
    // Pull the trunk-wide rise slot back into this member's own lane run.
    // routeBusEdges spreads a trunk's slots across the WHOLE trunk extent (the
    // drop column out to the rightmost member's rise column), but a member's
    // own lane run ends at its OWN rise column -- so a member whose consumer
    // sits near the source can be handed a slot hundreds of units past the
    // point where its line leaves the lane, parking its rate chip on a
    // sibling's stroke with nothing of its own beneath it.
    // The clamp belongs HERE and not in routeBusEdges: these dropX / riseX come
    // out of chamferBusPath with the stamped routing hints, so they are the
    // columns actually drawn (assignEntryColumns staggers the rise afterwards
    // and clearBusColumns may dodge either column by far more than a chamfer).
    // The slots are collected raw here and clamped just below the loop: the
    // clamp's co-location carve-out needs a trunk-level fact (see there). It
    // stays per member and order-independent, so routeBusEdges' shuffled-input
    // determinism is untouched; slots the clamp pushes together are resolved by
    // the capacity check below, which hides the overflow.
    busSlots.push({
      index,
      id: edge.id,
      laneY: data.laneY,
      dropX,
      riseX,
      riseSlot: data.busChipX,
      riseChipX: data.busChipX ?? riseX,
      // Deliberately STRICTER than isTrunkOwner, which reads absent as owner:
      // routeBusEdges always stamps the field in production, so the two rules
      // only diverge on hand-built fixtures. Unifying them is render-visible
      // and out of scope here.
      owner: data.busChipOwner === true,
      memberCount: data.busMemberCount ?? 1,
      // Mirrors BusEdge's longSingleRun: keyed to routeBusEdges' own long-run
      // decision through the ABSENT lane slot, on the same drawn columns.
      longSingleRun:
        (data.busMemberCount ?? 1) === 1 &&
        data.busChipX === undefined &&
        Math.abs(riseX - dropX) > BUS_LONG_RUN_THRESHOLD,
      // Top-band chips cascade UP (away from the graph below them); bottom-band
      // and un-banded chips cascade DOWN. Signed step drives seatChip's walk.
      step: data.busBand === "top" ? -CHIP_NUDGE_STEP : CHIP_NUDGE_STEP,
      flowKey: flowKeyOf(edge),
      target: edge.target,
      trunkKey: data.trunkKey,
      entryY: ty,
      dropHalfW: chipSeatHalfW(aggregateChipText(edge), false),
      riseHalfW: chipSeatHalfW(branchChipText(edge), false),
    });
  }
  // Trunk grouping over the lane slots, shared by the rise-slot clamp below
  // and the capacity check further down.
  const slotsByTrunk = new Map<string, BusSlot[]>();
  for (const slot of busSlots) {
    const list = slotsByTrunk.get(slot.trunkKey) ?? [];
    list.push(slot);
    slotsByTrunk.set(slot.trunkKey, list);
  }
  // The one sibling fact the clamp cannot see per member: whether a slotted
  // member's rise column is CO-LOCATED with another slotted member's of the
  // same trunk, within one MIN_CHIP_SEP -- same-layer targets, whose lane
  // runs are co-extensive. Judged per member against its siblings, not as a
  // trunk-wide extent: a trunk with three same-layer members and one further
  // out still has three colliding windows, and the far member alone keeps
  // its window. A lone slot bears no sibling to separate from, so it keeps
  // the window (a chip still belongs beside the corner it labels).
  const coLocatedIndices = new Set<number>();
  for (const [, slots] of slotsByTrunk) {
    const slotted = slots.filter((s) => s.riseSlot !== undefined);
    for (const a of slotted) {
      for (const b of slotted) {
        if (a === b) continue;
        if (Math.abs(a.riseX - b.riseX) <= MIN_CHIP_SEP) {
          coLocatedIndices.add(a.index);
          break;
        }
      }
    }
  }
  for (const slot of busSlots) {
    // undefined in, undefined out: the lone long-run member keeps its absent
    // slot and its riseChipX fallback to the rise column.
    const clampedChipX = clampChipXToOwnRun(
      slot.riseSlot,
      slot.dropX,
      slot.riseX,
      coLocatedIndices.has(slot.index),
    );
    if (clampedChipX === undefined) continue;
    if (clampedChipX !== slot.riseSlot) {
      busChipXByIndex.set(slot.index, clampedChipX);
    }
    slot.riseChipX = clampedChipX;
  }
  // Card exemption for a lane trunk's AGGREGATE drop chip: the union over every
  // lane member of the trunk (member targets + shared source + containers),
  // mirroring the fan-out aggregate's trunk exemption. The drop chip's wide box
  // sits on the lane but can reach a card the trunk feeds; exempting the whole
  // trunk keeps a sibling member's target from reading as a foreign card and
  // shoving the aggregate, while still upholding the bus-drop-vs-card hard tier
  // against every FOREIGN card.
  const laneTrunkExempt = new Map<string, MutCardExemption>();
  for (const { edge } of busEdges) {
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) continue;
    let set = laneTrunkExempt.get(data.trunkKey);
    if (set === undefined) {
      set = { whole: new Set<string>(), zones: new Map() };
      laneTrunkExempt.set(data.trunkKey, set);
    }
    mergeExemptionInto(set, cardExemptFor(edge));
  }
  // The drop chip's cascade is capped at ONE pitch. It is the only bus chip
  // exempt from the label zoom gate (BusEdge), i.e. a lone trunk's only rate
  // visible at fit zoom, and no hide rule exists for it -- so an unbounded
  // cascade could walk it several pitches off its own band into empty canvas
  // and nothing would catch it (multi6's gas_inert drop sat 144 units out). One
  // pitch still reads as sitting beside its junction. The cap is soft against
  // placed chips: see seatChip's capSteps.
  const BUS_DROP_CASCADE_STEPS = 1;
  const seatDropChip = (slot: BusSlot): void => {
    const { dy: dropDy } = seatChip(
      field,
      slot.dropX,
      slot.laneY,
      slot.dropHalfW,
      CHIP_HALF_H,
      slot.step,
      slot.flowKey,
      slot.target,
      slot.id,
      laneTrunkExempt.get(slot.trunkKey),
      BUS_DROP_CASCADE_STEPS,
    );
    if (dropDy !== 0) busDropDyByIndex.set(slot.index, dropDy);
  };
  for (const slot of busSlots) {
    // Multi-member trunks draw no aggregate chip (issue #39), so seat none.
    if (!slot.owner || slot.memberCount > 1) continue;
    // A long lone run defers its drop seat past the rise phase (#83): the rise
    // chip labels the trunk on its own, so the drop draws (and seats) only as
    // the fallback for a hidden rise, below.
    if (slot.longSingleRun) continue;
    seatDropChip(slot);
  }
  // Capacity check before seating the rises. A short lane run cannot host every
  // member rise chip at the wide-chip x-separation (2 * CHIP_HALF_W_WIDE); left
  // to seatChip the crowded rises cascade off the band into empty canvas
  // above/below the graph (issue #24). Instead keep only the rises the run
  // supports and hide the overflow: each hidden member's rate remains on its
  // target card's input row and its edge tooltip (mirroring fanoutBranchHidden).
  // No aggregate chip exists on a multi-member trunk (issue #39); the run's
  // capacity all goes to member rises, farthest from the junction first (edge-id
  // tie-break). The keep order measures the distance from the shared junction to
  // the CLAMPED slot -- a proxy for run length on forward members only, since a
  // backward member's run reverses and clamps back toward the drop column, so a
  // long backward run can rank below a hairpin's zero-length one. What the order
  // buys either way: a chip that ends up far from the shared junction -- where
  // the source-side junction cannot label it -- wins the scarce slots over one
  // sitting right beside that junction, which is crowded there anyway.
  // Single-member trunks are exempt: a lone rise merely restates its own
  // drop's rate, and the long-run lone member (Task 4) belongs at the consumer
  // end, so never capacity-hide it. (MIN_CHIP_SEP itself is module scope:
  // clampChipXToOwnRun's rise-end window shares the constant.)
  const busRiseHiddenByIndex = new Set<number>();
  for (const [, slots] of slotsByTrunk) {
    if (slots.length < 2) continue;
    // The drop column no longer reserves a slot, but it stays the ordering
    // reference: the junction is still the natural far end of the run.
    const aggX = (slots.find((s) => s.owner) ?? slots[0]!).dropX;
    const keptX: number[] = [];
    const ordered = [...slots].sort((a, b) => {
      const da = Math.abs(a.riseChipX - aggX);
      const db = Math.abs(b.riseChipX - aggX);
      if (da !== db) return db - da;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const slot of ordered) {
      if (keptX.every((x) => Math.abs(slot.riseChipX - x) >= MIN_CHIP_SEP)) {
        keptX.push(slot.riseChipX);
      } else {
        busRiseHiddenByIndex.add(slot.index);
      }
    }
  }
  // Seat the kept rise chips within each trunk TOP-TO-BOTTOM by their target's
  // in-port y, not edge-id order which can invert the visible stack (issue #28):
  // the topmost branch takes the lane and lower branches cascade below it, so a
  // crowded column reads in branch order. Trunks stay grouped by trunkKey and
  // ordered among themselves as before; only the within-trunk seat sequence
  // changes. Edge id breaks ties for determinism. The capacity KEEP decision
  // above (farthest-from-aggregate first) is untouched -- this reorders only the
  // seat sequence of the chips that survive it.
  const riseOrder = [...busSlots].sort((a, b) =>
    a.trunkKey !== b.trunkKey
      ? a.trunkKey < b.trunkKey
        ? -1
        : 1
      : a.entryY !== b.entryY
        ? a.entryY - b.entryY
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  for (const slot of riseOrder) {
    // A capacity-hidden rise seats nothing, so its phantom box never blocks a
    // later chip and no busChipDy is stamped (BusEdge draws no rise chip).
    if (busRiseHiddenByIndex.has(slot.index)) continue;
    const { dy: riseDy, box: riseBox } = seatChip(
      field,
      slot.riseChipX,
      slot.laneY,
      slot.riseHalfW,
      CHIP_HALF_H,
      slot.step,
      slot.flowKey,
      slot.target,
      slot.id,
    );
    // seatChip's cascade is unbounded in y, so a KEPT rise whose lane slot is
    // blocked can still walk clean off the band into empty canvas -- the chip
    // ends up with no stroke touching it, the same orphan silhouette the
    // capacity check above hides a crowded rise to avoid (issue #37). One step
    // still reads as sitting beside the lane; two or more do not, so past that
    // the rise is unseatable: release its seat (seatChip reserves exactly one
    // box, and hands it back) and hide it, its rate staying on the target card's
    // input row and the edge tooltip like every other hidden member's.
    if (Math.abs(riseDy) > CHIP_PITCH_Y) {
      field.unseat(riseBox);
      busRiseHiddenByIndex.add(slot.index);
      continue;
    }
    if (riseDy !== 0) busChipDyByIndex.set(slot.index, riseDy);
  }
  // Deferred long-lone-run drop seats (#83): the rise phase hid the trunk's
  // only chip, so the drop steps back in as the always-on label BusEdge falls
  // back to; a trunk whose rise seated keeps the single consumer-end label.
  for (const slot of busSlots) {
    if (!slot.owner || slot.memberCount > 1 || !slot.longSingleRun) continue;
    if (!busRiseHiddenByIndex.has(slot.index)) continue;
    seatDropChip(slot);
  }

  // Phase 3 -- fan-out trunk chips: each fan-out trunk draws one aggregate chip
  // on its owner (the summed rate + xN, seated on the shared trunk segment) and
  // one branch chip per member (that member's share, seated on its branch leg).
  // They seat here -- after the lane bus chips (structurally pinned to their
  // lanes) and before the free item rate chips -- through seatRateChip's
  // tier ladder (slide / graze / sidestep / nudge / escape), so both slide
  // along their own drawn polyline before stepping or nudging
  // off it. Aggregates settle before branches (the trunk's one truth first,
  // mirroring drop-before-rise). The aggregate has no single consumer gutter, so
  // it passes an INVERTED (empty) entry band that no point can fall inside (no
  // arrival-cluster exemption -- it clears every foreign line); a branch uses its
  // own target's entry band. An all-zero band would spuriously match a chip
  // centred exactly at the graph origin, so left > right guarantees no match.
  const fanoutAggDxByIndex = new Map<number, number>();
  const fanoutAggDyByIndex = new Map<number, number>();
  const fanoutBranchDxByIndex = new Map<number, number>();
  const fanoutBranchDyByIndex = new Map<number, number>();
  const NEVER_BAND: EntryBand = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
  };
  const fanoutEdges = edges
    .map((edge, index) => ({ edge, index }))
    .filter((e) => fanoutGeomByIndex.has(e.index))
    .sort((a, b) =>
      a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0,
    );
  // Card exemption for a trunk's AGGREGATE chip: the union over every member of
  // the trunk. The aggregate spans the shared trunk feeding ALL the members'
  // targets, and its wide box necessarily reaches into the target column, so it
  // must clear every one of those target cards (and the shared source) rather
  // than only the owner's own -- otherwise a sibling member's target reads as a
  // foreign card and shoves the aggregate off the trunk and down onto a branch.
  const trunkExempt = new Map<string, MutCardExemption>();
  // Trunk-aware own-flow set for each trunk's AGGREGATE chip: the edge ids of
  // every member. The aggregate rides the shared trunk, whose flowKey (item|
  // source) a SEPARATE direct edge off the same source can share without being a
  // trunk member; keyed by id, that direct edge reads foreign so the aggregate
  // steps clear of it rather than binding to it (issue #28, finding 1).
  const trunkMemberIds = new Map<string, Set<string>>();
  for (const { edge } of fanoutEdges) {
    const key = (edge.data as BusEdgeData).trunkKey;
    let set = trunkExempt.get(key);
    if (set === undefined) {
      set = { whole: new Set<string>(), zones: new Map() };
      trunkExempt.set(key, set);
    }
    mergeExemptionInto(set, cardExemptFor(edge));
    let ids = trunkMemberIds.get(key);
    if (ids === undefined) {
      ids = new Set<string>();
      trunkMemberIds.set(key, ids);
    }
    ids.add(edge.id);
  }
  for (const { edge, index } of fanoutEdges) {
    const geom = fanoutGeomByIndex.get(index)!;
    if (!geom.owner) continue;
    // Multi-member trunks draw no aggregate chip (issue #39), so seat none.
    if (((edge.data as BusEdgeData).busMemberCount ?? 1) > 1) continue;
    // The aggregate seats on the SHARED TRUNK sub-polyline only (source port ->
    // junction), never the owner's private branch leg: the tier-1 slide runs
    // horizontally along [source port, trunkEnd]. trunkEnd sits a keep-off left
    // of the junction so the chip clears the junction dot -- a full chip half-box
    // when the trunk is long enough, but never more than half the trunk, so a
    // short in-corridor trunk keeps its whole [source, midpoint] span rather than
    // collapsing to the source port (which would force a vertical nudge onto the
    // branch leg, the very slide this truncation prevents). The render anchor is
    // the trunk midpoint, always <= trunkEnd, so an uncrowded aggregate seats
    // there on the horizontal. Offsets stay relative to the render trunkAnchor so
    // BusEdge adds them to the same point.
    const [sx, sy] = geom.pts[0]!;
    const keepoff = Math.min(CHIP_HALF_W_WIDE, (geom.junction.x - sx) / 2);
    const trunkEndX = Math.max(sx, geom.junction.x - keepoff);
    const trunkPts: ReadonlyArray<readonly [number, number]> = [
      [sx, sy],
      [trunkEndX, geom.trunkAnchor.y],
    ];
    const seat = seatRateChip(
      {
        field,
        path: {
          pts: trunkPts,
          anchorX: geom.trunkAnchor.x,
          anchorY: geom.trunkAnchor.y,
        },
        flowKey: flowKeyOf(edge),
        target: edge.target,
        exempt:
          trunkExempt.get((edge.data as BusEdgeData).trunkKey) ??
          cardExemptFor(edge),
        entryBand: NEVER_BAND,
      },
      {
        ownIds: trunkMemberIds.get((edge.data as BusEdgeData).trunkKey),
        text: aggregateChipText(edge),
      },
    );
    if (seat.tier === "exhausted" && import.meta.env.DEV) {
      // Dev/test-only tripwire, tree-shaken out of production builds (parity with
      // the item phase and the render hook in src/pipeline/driver.ts).
      console.warn(
        `chip seating: fan-out aggregate cascade for ${edge.id} exhausted its ` +
          "cap; chip parked at its anchor (chip/card hard invariants abandoned)",
      );
    }
    if (seat.dx !== 0) fanoutAggDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) fanoutAggDyByIndex.set(index, seat.dy);
  }
  const fanoutBranchHiddenByIndex = new Set<number>();
  const fanoutBranchHiddenAtByIndex = new Map<
    number,
    { x: number; y: number }
  >();
  // Target in-port y of a fan-out member: the top-to-bottom key its branch chip
  // stacks by when several members share one junction column.
  const branchEntryY = (edge: Edge): number => {
    const target = byId.get(edge.target)!;
    return (
      absoluteTop(target, byId) + portOffsetY(target, edgeItem(edge), "in")
    );
  };
  // Seat the branch chips within each trunk TOP-TO-BOTTOM by their target's
  // in-port y, not edge-id order which can invert the visible stack when members
  // share one junction column (issue #28, the multi6 fan-out lane): the first
  // branch seated on a contested column claims it and later branches yield, so
  // seating in branch order makes the column read in branch order. Trunks stay
  // grouped by trunkKey and ordered among themselves as before; only the
  // within-trunk seat sequence changes, edge id breaking ties for determinism.
  const branchOrder = [...fanoutEdges].sort((a, b) => {
    const ka = (a.edge.data as BusEdgeData).trunkKey;
    const kb = (b.edge.data as BusEdgeData).trunkKey;
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ya = branchEntryY(a.edge);
    const yb = branchEntryY(b.edge);
    if (ya !== yb) return ya - yb;
    return a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0;
  });
  // Seated branch centre-ys per trunk, the barriers a later same-trunk branch's
  // on-line slide may not cross (issue #28, finding 2). All members of one trunk
  // share the junction column, so a trunk key IS a column key here. Only chips
  // that actually seat (not hidden) enter it, since a hidden branch draws no
  // chip to invert against.
  const seatedBranchYByTrunk = new Map<string, number[]>();
  for (const { edge, index } of branchOrder) {
    const geom = fanoutGeomByIndex.get(index)!;
    const trunkKey = (edge.data as BusEdgeData).trunkKey;
    // The branch chip slides over its OWN leg only (geom.branchPts, the
    // suffix after the junction) -- the mirror of the aggregate seat's
    // trunk-prefix truncation above. On the full polyline the slide could
    // walk back across the junction onto the shared trunk, where the box
    // reads as a trunk label and buries the split dot from the left; on the
    // leg the same push goes down the member's own column instead. The
    // branch anchor is on the leg by construction for branching and diagonal
    // members (the column's midpoint, the diagonal's); a shared-y member's
    // whole-corridor midpoint can sit left of the junction, where the arc
    // resolver falls back to the leg's own midpoint -- its seat moves ONTO
    // the leg, which is the point.
    const seat = seatRateChip(
      {
        field,
        path: {
          pts: geom.branchPts,
          anchorX: geom.branchAnchor.x,
          anchorY: geom.branchAnchor.y,
        },
        flowKey: flowKeyOf(edge),
        target: edge.target,
        exempt: cardExemptFor(edge),
        entryBand: entryBandOf(edge),
      },
      {
        barrierYs: seatedBranchYByTrunk.get(trunkKey),
        // A branch chip that renders collapsed (stamped below) reserves the
        // square icon box here rather than the wide one no full seat could
        // have cleared.
        iconOnly: branchIconOnlyByIndex.has(index),
        text: branchChipText(edge),
        clearSpan: clearSpanByIndex.get(index),
      },
    );
    scaleCapByIndex.set(index, seat.scaleCap);
    if (seat.tier === "exhausted" && import.meta.env.DEV) {
      // The hide below covers the exhausted tier too, but exhausting the
      // bounded cascade is a seating regression, never an intentional hide, so
      // it keeps its tripwire (parity with the aggregate and item phases).
      console.warn(
        `chip seating: fan-out branch cascade for ${edge.id} exhausted its ` +
          "cap; branch chip hidden (chip/card hard invariants abandoned)",
      );
    }
    // A branch chip that cannot seat ON its own polyline is hidden rather than
    // parked off-line: a narrow-corridor fan-out cannot host two max-scale chip
    // boxes side by side, so once the owner's aggregate covers the short path
    // an off-line seat would float in empty canvas. The rate it would have
    // shown remains on the target card's input row and in the edge tooltip.
    // The hide is stamped with the branch anchor it was decided at, so BusEdge
    // can drop it once a node drag moves the live anchor away from the stamp.
    // Release the seat the off-line tiers reserved so the phantom box never
    // blocks a later chip.
    if (
      seat.tier === "nudge" ||
      seat.tier === "escape" ||
      seat.tier === "exhausted"
    ) {
      field.unseat(seat.box);
      fanoutBranchHiddenByIndex.add(index);
      fanoutBranchHiddenAtByIndex.set(index, geom.branchAnchor);
      continue;
    }
    // The chip seated on its column: record its centre-y as a barrier for the
    // next same-trunk branch so a pushed later branch cannot slide across it.
    const seatedYs = seatedBranchYByTrunk.get(trunkKey) ?? [];
    seatedYs.push(seat.box.y);
    seatedBranchYByTrunk.set(trunkKey, seatedYs);
    if (seat.dx !== 0) fanoutBranchDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) fanoutBranchDyByIndex.set(index, seat.dy);
  }

  // Phase 4 -- item rate chips: each item edge's clear-segment anchor (cached
  // from the reconstruction above, exactly where ItemEdge renders it) goes
  // through seatRateChip's tier ladder: slide along the own polyline (fully
  // clear, then graze), the horizontal sidestep, the short fully-clear nudge,
  // then the chips-and-cards escape cascade.
  // SCARCITY FIRST: an edge is seated before another whose own polyline offers
  // MORE clear on-line seats than its own does. Each seat consumes a window for
  // everyone else, so seating a rich edge first can spend the only window a poor
  // one had and leave it with no on-line seat at all -- which is how battery5's
  // e:1 lost its whole 345-unit approach leg to e:12's chip and had to step off
  // its line. Taking the poorest first spends the scarce windows on the edges
  // that have nowhere else to go, and leaves the rich ones their many
  // alternatives. The counts are all read BEFORE any item chip is placed, so
  // they describe the edges and not the order, and the edge id breaks every tie:
  // the sort is a total order on fixed keys and stays deterministic.
  const labelDyByIndex = new Map<number, number>();
  const labelDxByIndex = new Map<number, number>();
  const seatOpts = (edge: Edge, index: number): RateSeatOpts => ({
    iconOnly: shortLegByIndex.has(index),
    text: rateChipText(edge),
    clearSpan: clearSpanByIndex.get(index),
  });
  const items = edges
    .map((edge, index) => ({ edge, index }))
    .filter((e) => e.edge.type === "item");
  const windowsByIndex = new Map<number, number>();
  for (const { edge, index } of items) {
    const geom = itemGeomByIndex.get(index);
    if (geom === undefined) continue;
    windowsByIndex.set(
      index,
      clearOnLineSeats(
        {
          field,
          path: {
            pts: fanoutLegPtsByIndex.get(index) ?? geom.pts,
            anchorX: geom.lx,
            anchorY: geom.ly,
          },
          flowKey: flowKeyOf(edge),
          target: edge.target,
          exempt: cardExemptFor(edge),
          entryBand: entryBandOf(edge),
        },
        seatOpts(edge, index),
      ),
    );
  }
  items.sort((a, b) => {
    const wa = windowsByIndex.get(a.index) ?? 0;
    const wb = windowsByIndex.get(b.index) ?? 0;
    if (wa !== wb) return wa - wb;
    return a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0;
  });
  for (const { edge, index } of items) {
    const geom = itemGeomByIndex.get(index);
    const target = byId.get(edge.target);
    if (geom === undefined || target === undefined) continue;
    const entryBand = entryBandOf(edge);
    const seat = seatRateChip(
      {
        field,
        path: {
          pts: fanoutLegPtsByIndex.get(index) ?? geom.pts,
          anchorX: geom.lx,
          anchorY: geom.ly,
        },
        flowKey: flowKeyOf(edge),
        target: edge.target,
        exempt: cardExemptFor(edge),
        entryBand,
      },
      // A short-leg item chip renders collapsed at every zoom (chipIconOnly,
      // stamped below from the same set), so it reserves the square icon box
      // rather than the wide worst case it never draws.
      seatOpts(edge, index),
    );
    scaleCapByIndex.set(index, seat.scaleCap);
    if (seat.tier === "exhausted" && import.meta.env.DEV) {
      // Dev/test-only tripwire, tree-shaken out of production builds (parity
      // with the render hook in src/pipeline/driver.ts). Never expected: cards
      // are finite, so the cascade should always find free space.
      console.warn(
        `chip seating: last-resort cascade for ${edge.id} exhausted its cap; ` +
          "chip parked at its anchor (chip/card hard invariants abandoned)",
      );
    }
    // A non-owner fan-in member whose own chip SEATED on the shared run (at the
    // port y, between the merge and the port) crowds the run the owner's chip
    // reads on: release its box and hide it (ItemEdge draws no rate chip, the exact
    // rate stays on the hover path and the target card's input row). A member
    // seated on its own PRE-merge leg (off the run) keeps its chip. Anchor-based
    // hiding cannot catch a member that SLID onto the run, so this reads the
    // seated centre.
    const run = faninMemberRunByIndex.get(index);
    if (run !== undefined) {
      const seatX = seat.box.x;
      const seatY = seat.box.y;
      if (
        Math.abs(seatY - run.ty) <= FANIN_EPS &&
        seatX >= run.mergeX - FANIN_EPS &&
        seatX <= run.tx + FANIN_EPS
      ) {
        field.unseat(seat.box);
        faninChipHiddenByIndex.add(index);
        continue;
      }
    }
    if (seat.dx !== 0) labelDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) labelDyByIndex.set(index, seat.dy);
  }

  // Stamp every phase's verdicts onto one patch object, then decide by the
  // patch: an edge nothing seated is returned BY REFERENCE (the routing passes
  // and their tests read that identity as "untouched"), and every other edge
  // gets exactly the keys that were set. Each stamp is written once and read
  // once. The shape this replaced listed all seventeen keys a second time in a
  // hand-kept untouched-edge guard, so a stamp added to the writer and
  // forgotten in the guard was dropped from the emitted edge without a sound.
  return edges.map((edge, index) => {
    const patch: SeatPatch = {};
    // Indexing SeatPatch by every listed key is what makes a key no type
    // declares a build error.
    const stamp = <K extends SeatPatchKey>(
      key: K,
      value: SeatPatch[K],
    ): void => {
      if (value !== undefined) patch[key] = value;
    };
    stamp("labelDy", labelDyByIndex.get(index));
    stamp("labelDx", labelDxByIndex.get(index));
    if (shortLegByIndex.has(index)) patch.chipIconOnly = true;
    // The counter-scale cap, stamped only when it binds.
    const cap = scaleCapByIndex.get(index);
    if (cap !== undefined && cap < MAX_CHIP_SCALE) {
      if (fanoutGeomByIndex.has(index)) patch.fanoutBranchScaleCap = cap;
      else patch.chipScaleCap = cap;
    }
    stamp("busDropDy", busDropDyByIndex.get(index));
    stamp("busChipDy", busChipDyByIndex.get(index));
    // The clamped rise slot REPLACES routeBusEdges' trunk-wide one, so
    // BusEdge's anchor and contentBounds' frame use the x this pass reserved a
    // box at. Absent when the slot needed no clamping (and on the lone long-run
    // member, which has no slot to clamp).
    stamp("busChipX", busChipXByIndex.get(index));
    if (busRiseHiddenByIndex.has(index)) patch.busRiseHidden = true;
    stamp("fanoutAggDx", fanoutAggDxByIndex.get(index));
    stamp("fanoutAggDy", fanoutAggDyByIndex.get(index));
    stamp("fanoutBranchDx", fanoutBranchDxByIndex.get(index));
    stamp("fanoutBranchDy", fanoutBranchDyByIndex.get(index));
    if (branchIconOnlyByIndex.has(index)) patch.fanoutBranchIconOnly = true;
    if (fanoutBranchHiddenByIndex.has(index)) patch.fanoutBranchHidden = true;
    stamp("fanoutBranchHiddenAt", fanoutBranchHiddenAtByIndex.get(index));
    const faninJunction = faninJunctionByIndex.get(index);
    if (faninJunction !== undefined) {
      patch.faninJunctionX = faninJunction.x;
      patch.faninJunctionY = faninJunction.y;
    }
    const fanoutJunction = fanoutJunctionByIndex.get(index);
    if (fanoutJunction !== undefined) {
      patch.fanoutJunctionX = fanoutJunction.x;
      patch.fanoutJunctionY = fanoutJunction.y;
    }
    // Crossing cues read by ItemEdge AND BusEdge (the field lives on the shared
    // ItemEdgeData payload both render). Absolute graph points; the renderers
    // drop any whose own polyline has since moved off them.
    stamp("crossingCues", crossingCuesByIndex.get(index));
    // The hide is stamped with the port y it was decided at, so ItemEdge can
    // drop it once a node drag moves the live port away from the stamp (the
    // fanoutBranchHiddenAt staleness pattern).
    if (faninChipHiddenByIndex.has(index)) {
      patch.faninChipHidden = true;
      patch.faninChipHiddenAtY = faninMemberRunByIndex.get(index)!.ty;
    }
    if (Object.keys(patch).length === 0) return edge;
    return { ...edge, data: { ...edge.data, ...patch } };
  });
}

// A flow-coordinate rectangle, the shape React Flow's fitBounds consumes.
export type ContentRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// The edge-data fields contentBounds needs to place a chip: which families the
// edge draws, their anchors' inputs, their seated nudges, and their hides. Flat
// and all-optional rather than the BusEdgeData / ItemEdgeData unions, because
// this reader takes one uniform view over every edge type. Picked from the
// three declaring types rather than restated, so renaming a field there breaks
// this build instead of silently leaving a reader behind. Each hide is Picked
// together with the anchor it was decided at: a hide only holds while its stamp
// still matches the live anchor, so the reader needs them both.
type ChipAnchorData = Partial<
  Pick<
    ItemEdgeData,
    "labelDx" | "labelDy" | "faninChipHidden" | "faninChipHiddenAtY"
  > &
    Pick<
      LaneBusEdgeData,
      | "laneY"
      | "busChipX"
      | "busDropDy"
      | "busChipDy"
      | "busRiseHidden"
      | "busMemberCount"
      | "busChipOwner"
    > &
    Pick<
      FanoutBusEdgeData,
      | "fanoutAggDx"
      | "fanoutAggDy"
      | "fanoutBranchDx"
      | "fanoutBranchDy"
      | "fanoutBranchHidden"
      | "fanoutBranchHiddenAt"
    >
  // `fanout` is the only name this view declares itself: the two union arms
  // type it `false` and `true`, so the intersection cannot Pick it.
> & { fanout?: boolean };

// Content bounding box (flow coords) covering both the node cards AND every
// seated edge-label chip, for the camera fit. React Flow's fitView frames node
// cards only, so a chip that cascaded below the deepest lane band, or nudged
// past a border card's edge, lands outside the framed region and clips at the
// viewport rim. This unions the node cards with each chip's reconstructed
// seated box: the anchor comes from the same path builder the render component
// calls, plus the de-confliction offset stamped on edge data, so every unioned
// box is a drawn box. Padding instead by the largest nudge recorded anywhere
// framed all four sides as if one cascaded chip existed at every corner, which
// depressed the fit zoom on dense plans, and still missed chips whose anchor
// sits on a routed leg outside the cards. Pure and deterministic: it reads only
// the seated offsets the render components already consume, never re-seating.
// Recomputing the anchors here, rather than reading a stamped absolute centre,
// keeps the rect right after a node drag. Null for an empty graph.
export function contentBounds(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): ContentRect | null {
  if (nodes.length === 0) return null;
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const n of nodes) {
    const l = absoluteLeft(n, byId);
    const t = absoluteTop(n, byId);
    left = Math.min(left, l);
    top = Math.min(top, t);
    right = Math.max(right, l + nodeWidth(n));
    bottom = Math.max(bottom, t + nodeHeight(n));
  }

  // One chip box, centred at its seated position, into the frame.
  const unionChip = (cx: number, cy: number): void => {
    left = Math.min(left, cx - CHIP_HALF_W_WIDE);
    right = Math.max(right, cx + CHIP_HALF_W_WIDE);
    top = Math.min(top, cy - CHIP_HALF_H);
    bottom = Math.max(bottom, cy + CHIP_HALF_H);
  };

  // Every chip family, anchored exactly as its render component anchors it:
  // rebuild the polyline with the same builder and hints, then apply the nudge
  // the seating pass stamped. Hidden chips draw nothing, so they frame nothing.
  for (const edge of edges) {
    const data = edge.data as ChipAnchorData | undefined;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const geom = {
      sourceX: ends.sx,
      sourceY: ends.sy,
      targetX: ends.tx,
      targetY: ends.ty,
      ...routingHintsFromData(edge.data),
    };
    if (edge.type === "item") {
      // Staleness parity with ItemEdge: the fan-in member hide holds only while
      // the stamped port y is still within HIDE_STALE_EPS of the LIVE target y,
      // so a drag that moved the port brings the chip back -- and the frame with
      // it. An ABSENT stamp is not stale, which keeps the chip out of the rect
      // exactly as the renderer keeps it off the canvas.
      const stampY = data?.faninChipHiddenAtY;
      const faninStale =
        stampY !== undefined && Math.abs(stampY - ends.ty) >= HIDE_STALE_EPS;
      if (data?.faninChipHidden === true && !faninStale) continue;
      const [, lx, ly] = chamferStepPath(geom);
      unionChip(lx + (data?.labelDx ?? 0), ly + (data?.labelDy ?? 0));
    } else if (edge.type === "bus" && data?.fanout === true) {
      const fan = chamferFanoutPath(geom);
      // A multi-member trunk renders no aggregate chip (issue #39), so it
      // frames none.
      if (isTrunkOwner(data) && (data.busMemberCount ?? 1) === 1) {
        unionChip(
          fan.trunkAnchor.x + (data.fanoutAggDx ?? 0),
          fan.trunkAnchor.y + (data.fanoutAggDy ?? 0),
        );
      }
      // Staleness parity with BusEdge, whose rule differs from the fan-in one
      // above: per-axis, strict, and an ABSENT stamp still hides. (BusEdge also
      // un-hides when its fan path is null; here the branch already resolved a
      // fan-out path, so that arm cannot arise.)
      const hiddenAt = data.fanoutBranchHiddenAt;
      const branchHidden =
        data.fanoutBranchHidden === true &&
        (hiddenAt === undefined ||
          (Math.abs(fan.branchAnchor.x - hiddenAt.x) < HIDE_STALE_EPS &&
            Math.abs(fan.branchAnchor.y - hiddenAt.y) < HIDE_STALE_EPS));
      if (!branchHidden) {
        unionChip(
          fan.branchAnchor.x + (data.fanoutBranchDx ?? 0),
          fan.branchAnchor.y + (data.fanoutBranchDy ?? 0),
        );
      }
    } else if (edge.type === "bus" && data?.laneY !== undefined) {
      const bus = chamferBusPath({ ...geom, laneY: data.laneY });
      if (isTrunkOwner(data) && (data.busMemberCount ?? 1) === 1) {
        unionChip(bus.dropX, data.laneY + (data.busDropDy ?? 0));
      }
      if (data.busRiseHidden !== true) {
        unionChip(
          data.busChipX ?? bus.riseX,
          data.laneY + (data.busChipDy ?? 0),
        );
      }
    }
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
