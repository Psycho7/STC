// Chip seating: the whole-graph de-confliction pass that places every
// edge-label chip (bus drop/rise chips, fan-out chips, item rate chips) after
// routing has finished, plus the clearance machinery it runs on.
//
// Two coincident chips read as one, and on a bus lane the surviving chip lied
// about the flow. deconflictChipAnchors runs last in the render pipeline
// (after routeBusEdges, assignEntryColumns, and assignBendColumns, so it sees
// the final laneY, entryX, bendX, and busChipX) and threads chip-nudge offsets
// onto edge data through one shared collision set (the ClearanceField).
//
// Seating runs in EXPLICIT PHASES, in this order -- the ordering is
// load-bearing, not incidental, so keep it explicit rather than folding it
// into a generic priority framework:
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
// Escapes follow the ratified priority order: chip-vs-chip and chip-vs-CARD
// clearance are HARD invariants; staying on the own polyline and clearing
// foreign flow lines are preferences that yield when the hard pair forces an
// escape.

import type { Edge } from "@xyflow/react";

import { CHIP_BOX_HEIGHT, CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "./dimensions";
import {
  chamferBusPath,
  chamferFanoutPath,
  chamferStepPath,
  parsePathPoints,
  pathPointAtPts,
  routingHintsFromData,
} from "./edgePath";
import {
  OBSTACLE_PAD_LEFT,
  OBSTACLE_PAD_Y,
  absoluteLeft,
  absoluteTop,
  edgeItem,
  nodeHeight,
  nodeWidth,
  portOffsetY,
  type BusEdgeData,
} from "./busRouting";
import type { RFAnyNode } from "./layout";

// Chip half-extents, in graph units. A chip counter-scales up to MAX_CHIP_SCALE
// about its centre, so its rendered box in graph space never exceeds
// MAX_CHIP_SCALE times its natural dimension; half of that is the half-extent two
// centres must stay apart on an axis to keep the boxes clear at every zoom down
// to the fit floor. The collision test sums the two boxes' half-extents per
// axis, so a wide-vs-wide pair needs the full MAX_CHIP_SCALE * CHIP_BOX_WIDTH
// of centre separation -- the earlier single fixed 60 flagged only
// near-coincident pairs and missed wide chips that overlap on screen from tens
// of graph units away.
const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
const CHIP_HALF_W_WIDE = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;

// Vertical pitch a colliding chip is bumped by each step, and the shared full
// chip-box height. A full max-scale box height keeps the resolved clearance from
// dropping below one box at any zoom.
const CHIP_PITCH_Y = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
const CHIP_NUDGE_STEP = CHIP_PITCH_Y;

// A placed chip box in the shared collision set: its centre plus per-axis
// half-extents. Two boxes overlap when their centres sit closer than the sum of
// their half-extents on BOTH axes.
export type ChipBox = { x: number; y: number; halfW: number; halfH: number };

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

// Does the segment (x0,y0)-(x1,y1) enter the chip box's interior? Liang-Barsky
// parametric clip against the box slabs; boundary-only contact does not count.
function segIntersectsChipBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  box: ChipBox,
): boolean {
  const left = box.x - box.halfW;
  const right = box.x + box.halfW;
  const top = box.y - box.halfH;
  const bottom = box.y + box.halfH;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
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
    clip(-dx, x0 - left) &&
    clip(dx, right - x0) &&
    clip(-dy, y0 - top) &&
    clip(dy, bottom - y0)
  ) {
    return t1 - t0 > 1e-6;
  }
  return false;
}

// A reconstructed edge polyline the chip pass treats as an obstacle: the
// segments of every edge OUTSIDE the chip's own flow (its own edge plus
// same-(item, source) siblings, which share one visual line -- a trunk's lane
// run or a fanout's common trajectory) and outside its own ARRIVAL CLUSTER
// (edges into the same target: the converging lines before one consumer read
// as one junction, so a chip near its port may sit among its siblings' final
// approaches). flowKey groups the flow siblings; target the cluster.
export type EdgeSegments = {
  flowKey: string;
  target: string;
  segs: ReadonlyArray<readonly [number, number, number, number]>;
};

// A raw card rect a chip's box must stay clear of (the P3 hard invariant).
export type CardRect = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
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
// crosses deeper. Depth is the recipe row's horizontal frame/padding strip
// (canvas.css .rn-row padding: 0 12px) -- the frame between the card edge and the
// row's item glyph (at the 14px port-side inset), so an exempt chip's centre
// never sits on the glyph. A box-overlap rule instead would flag every on-line
// chip (box wider than corridor) and fling it off its line -- the issue-#9
// orphaned-chip regression this narrowing must avoid.
export const PORT_ZONE_DEPTH = 12;

export type PortZoneSide = "source" | "target";

type PortZoneRect = { left: number; top: number; right: number; bottom: number };

// Does `chip`'s CENTRE sit ON the OWN endpoint `card`'s body, past its
// port-adjacent strip? True = the chip is seated on the card body (a #10
// violation the seat must escape); false = no vertical overlap with the card, or
// the centre is still in the corridor / port strip (the normal on-line state).
// `side` selects the port edge ("source" hugs the card's right edge / out-port,
// "target" its left edge / in-port). Shared verbatim by the seating pass
// (makeClearanceField) and the e2e chip/card audit so the gate and the placement
// rule never drift.
export function chipEntersOwnCardBody(
  chip: PortZoneRect,
  card: PortZoneRect,
  side: PortZoneSide,
  eps = 0.5,
): boolean {
  const oy = Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
  if (oy <= eps) return false; // not even level with the card: never on its body
  const cx = (chip.left + chip.right) / 2;
  return side === "target"
    ? cx > card.left + PORT_ZONE_DEPTH
    : cx < card.right - PORT_ZONE_DEPTH;
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
// polylines and raw card rects), exposed through the three named predicates
// each seat composes. `placed` is mutated as chips seat, so later phases see
// everything earlier phases placed.
export type ClearanceField = {
  placed: ChipBox[];
  overlapsChip(box: ChipBox): boolean;
  // A foreign card is any obstacle whose id is neither wholly exempt (a
  // container slab) nor an own endpoint card. Own endpoint cards are obstacles
  // MINUS their port-adjacent zone (issue #10): a chip entering such a card's
  // body outside the shallow port strip is a violation just like a foreign card.
  entersForeignCard(box: ChipBox, exempt: CardExemption): boolean;
  // Foreign-line test with the arrival-cluster exemption: a same-target
  // sibling's line is skipped unconditionally when no entry band is given
  // (bus / entry seats), and only while the box centre sits inside the band
  // when one is (rate-chip seats, the narrowed rule).
  onForeignLine(
    box: ChipBox,
    flowKey: string,
    target: string,
    entryBand?: EntryBand,
  ): boolean;
};

export function makeClearanceField(
  segments: ReadonlyArray<EdgeSegments>,
  cards: ReadonlyArray<CardRect>,
): ClearanceField {
  const placed: ChipBox[] = [];
  return {
    placed,
    overlapsChip: (box) => placed.some((b) => chipBoxesOverlap(b, box)),
    entersForeignCard: (box, exempt) =>
      cards.some((c) => {
        if (exempt.whole.has(c.id)) return false;
        const chip = {
          left: box.x - box.halfW,
          top: box.y - box.halfH,
          right: box.x + box.halfW,
          bottom: box.y + box.halfH,
        };
        const zone = exempt.zones.get(c.id);
        if (zone === undefined) {
          return (
            Math.min(chip.right, c.right) - Math.max(chip.left, c.left) > 0.5 &&
            Math.min(chip.bottom, c.bottom) - Math.max(chip.top, c.top) > 0.5
          );
        }
        return chipEntersOwnCardBody(chip, c, zone, 0.5);
      }),
    onForeignLine: (box, flowKey, target, entryBand) => {
      const clusterExempt =
        entryBand === undefined || centreInBand(box.x, box.y, entryBand);
      return segments.some(
        (e) =>
          e.flowKey !== flowKey &&
          (!clusterExempt || e.target !== target) &&
          e.segs.some(([x0, y0, x1, y1]) =>
            segIntersectsChipBox(x0, y0, x1, y1, box),
          ),
      );
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
  target = "",
  maxSteps: number = CHIP_SEAT_MAX_STEPS,
  entryBand?: EntryBand,
  // When given, the cascade also clears every FOREIGN raw card (the drop
  // aggregate's hard chip-vs-card tier); absent leaves cards unchecked (rises).
  cardExempt?: CardExemption,
): number | null {
  let dy = 0;
  for (let steps = 0; steps <= maxSteps; steps++) {
    const box = { x, y: y + dy, halfW, halfH };
    if (
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target, entryBand) &&
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
): number {
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
    undefined,
    cardExempt,
  );
  if (clear !== null) {
    field.placed.push({ x, y: y + clear, halfW, halfH });
    return clear;
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
  field.placed.push({ x, y: y + dy, halfW, halfH });
  return dy;
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
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
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

// How a rate chip ended up seated, coarsest last:
//   anchor    on its clear-segment anchor, fully clear;
//   slide     slid along its own polyline to a fully clear point;
//   graze     on its own polyline clear of chips and cards, grazing a foreign
//             line (no fully clear on-line point existed);
//   nudge     a short vertical lift off the line, still fully clear;
//   escape    the chips-and-cards cascade found a seat (foreign-line
//             clearance and on-own-line preference yielded);
//   exhausted the bounded search failed and the chip parked at its anchor
//             (never expected; the caller's DEV warning fires on this).
export type RateSeatTier =
  | "anchor"
  | "slide"
  | "graze"
  | "nudge"
  | "escape"
  | "exhausted";

export type RateSeat = { dx: number; dy: number; tier: RateSeatTier };

// Seat an item rate chip: the tiered seat the item phase (and 3b's fan-out
// chips) run. Tier 1 slides ALONG THE OWN POLYLINE from the anchor, nearest
// arc-length offset first, taking the first point clear of chips, cards, and
// foreign lines -- the chip stays on the flow it labels. Tier 1b (graze)
// repeats that slide upholding only the HARD invariants (chips and cards),
// grazing foreign lines: staying visibly attached to the own line outranks
// clearing a parallel foreign line, because a braided corridor can poison
// every fully-clear candidate and the old off-line exits parked chips in
// empty canvas (issue #9). Tier 2 is a short bidirectional vertical nudge off
// the anchor, fully clear, reached only when the whole own line is chip- or
// card-blocked. Tier 3 waives every soft preference and cascades
// bidirectionally against CHIPS AND CARDS only, nearest escape first (ties
// prefer down). The seat is pushed into the field; the returned offsets are
// relative to the anchor.
export function seatRateChip(
  field: ClearanceField,
  path: {
    pts: ReadonlyArray<readonly [number, number]>;
    anchorX: number;
    anchorY: number;
  },
  flowKey: string,
  target: string,
  exempt: CardExemption,
  entryBand: EntryBand,
): RateSeat {
  const { pts, anchorX, anchorY } = path;
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
    halfW: CHIP_HALF_W_WIDE,
    halfH: CHIP_HALF_H,
  });
  // A candidate is clear when it clears every placed chip box, every foreign
  // flow line (arrival cluster narrowed to the entry band), AND every foreign
  // card box.
  const isClear = (px: number, py: number): boolean => {
    const box = boxAt(px, py);
    return (
      !field.entersForeignCard(box, exempt) &&
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target, entryBand)
    );
  };
  const seat = (px: number, py: number, tier: RateSeatTier): RateSeat => {
    field.placed.push(boxAt(px, py));
    return { dx: px - anchorX, dy: py - anchorY, tier };
  };
  const hardClearAt = (px: number, py: number): boolean => {
    const box = boxAt(px, py);
    return !field.entersForeignCard(box, exempt) && !field.overlapsChip(box);
  };
  // The shared slide walk of tiers 1 and 1b: along the line, nearest arc-length
  // offset first, seating at the first candidate the tier's predicate accepts.
  const slideAlong = (
    ok: (px: number, py: number) => boolean,
    tierAt: (px: number, py: number) => RateSeatTier,
  ): RateSeat | null => {
    for (let k = 0; k <= SLIDE_MAX_STEPS; k++) {
      const deltas = k === 0 ? [0] : [k * SLIDE_STEP, -k * SLIDE_STEP];
      for (const delta of deltas) {
        const len = anchorLen + delta;
        if (len < 0 || len > total) continue;
        const [px, py] = pathPointAtPts(pts, total === 0 ? 0 : len / total);
        if (ok(px, py)) return seat(px, py, tierAt(px, py));
      }
    }
    return null;
  };
  // Tier 1: the slide taking the first FULLY clear point. Tier 1b (graze),
  // reached when nothing on the line is fully clear: the same slide upholding
  // only the HARD invariants (chips and cards), grazing foreign lines. In a
  // braided corridor a parallel foreign line within a chip half-height poisons
  // every tier-1 candidate at once, yet the own line is otherwise empty -- the
  // chip belongs on it, icon and tint disambiguate the graze.
  const slid =
    slideAlong(isClear, (px, py) =>
      px === anchorX && py === anchorY ? "anchor" : "slide",
    ) ?? slideAlong(hardClearAt, () => "graze");
  if (slid !== null) return slid;
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
  // (ratcheted).
  const hardClear = (py: number): boolean => {
    const box = boxAt(anchorX, py);
    return !field.entersForeignCard(box, exempt) && !field.overlapsChip(box);
  };
  for (let k = 0; k <= LAST_RESORT_CAP_STEPS; k++) {
    const deltas = k === 0 ? [0] : [k * CHIP_NUDGE_STEP, -k * CHIP_NUDGE_STEP];
    for (const delta of deltas) {
      if (hardClear(anchorY + delta)) {
        return seat(anchorX, anchorY + delta, "escape");
      }
    }
  }
  // Bounded search exhausted (never expected: cards are finite). Park at the
  // anchor; the caller's DEV warning fires on this tier.
  return seat(anchorX, anchorY, "exhausted");
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
    (edgeItem(edge) ?? "?") + "|" + edge.source;
  const edgeSegments: EdgeSegments[] = [];
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
    junction: { x: number; y: number };
    trunkAnchor: { x: number; y: number };
    branchAnchor: { x: number; y: number };
    owner: boolean;
  };
  const fanoutGeomByIndex = new Map<number, FanoutGeom>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item" && edge.type !== "bus") return;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const tx = absoluteLeft(target, byId);
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
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
      fanoutGeomByIndex.set(index, {
        pts: parsePathPoints(d),
        junction: fan.junction,
        trunkAnchor: fan.trunkAnchor,
        branchAnchor: fan.branchAnchor,
        owner: (edge.data as BusEdgeData | undefined)?.busChipOwner === true,
      });
    } else if (edge.type === "bus") {
      // Narrow the union on `"laneY" in` (the same discriminant laneBands and the
      // census helpers use) rather than a bare LaneBusEdgeData cast: it does not
      // silently assume this bus edge is the lane variant just because the fan-out
      // branch ran first.
      const data = edge.data as BusEdgeData | undefined;
      const laneY = data !== undefined && "laneY" in data ? data.laneY : ty;
      d = chamferBusPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        laneY,
        ...routingHintsFromData(edge.data),
      }).path;
    } else {
      const [path, lx, ly] = chamferStepPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        ...routingHintsFromData(edge.data),
      });
      d = path;
      itemGeomByIndex.set(index, { pts: parsePathPoints(d), lx, ly });
    }
    const pts = itemGeomByIndex.get(index)?.pts ?? parsePathPoints(d);
    const segs: Array<readonly [number, number, number, number]> = [];
    for (let i = 1; i < pts.length; i++) {
      segs.push([pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]]);
    }
    edgeSegments.push({ flowKey: flowKeyOf(edge), target: edge.target, segs });
  });

  // Raw card rects a chip's box must stay clear of, so a chip never sits on top
  // of a foreign node (the P3 hard invariant). Every node type is included --
  // recipe / product / loop cards and group slabs -- mirroring the chip/card
  // audit; the per-edge exemption below (own source, target, and their
  // containers) is the same one the audit applies.
  const cards: CardRect[] = nodes.map((n) => {
    const left = absoluteLeft(n, byId);
    const top = absoluteTop(n, byId);
    return {
      id: n.id,
      left,
      top,
      right: left + nodeWidth(n),
      bottom: top + nodeHeight(n),
    };
  });
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

  // The shared clearance field: every phase seats into `field.placed`, so a
  // later phase yields to everything an earlier phase placed.
  const field = makeClearanceField(edgeSegments, cards);

  // Phases 1 and 2 -- bus chips: each trunk draws one aggregate drop chip (on
  // the owner member) and one rise chip per member, all on the trunk's lane.
  // Reconstruct their lane anchors from the same geometry BusEdge uses
  // (chamferBusPath for dropX/riseX, busChipX for the spread rise slot) and
  // seat each one, cascading off the lane when it crowds a neighbour. Seating
  // is two-phase: EVERY trunk's drop chip settles first, then every rise chip,
  // each phase in edge-id order. The drop chip is the trunk's aggregate total
  // at its junction; interleaving by edge id alone would let an earlier
  // trunk's cascading rise land on a later trunk's junction and knock that
  // aggregate off its lane, so drop priority is structural, not an accident of
  // id order. Drop and rise carry separate offsets (busDropDy, busChipDy)
  // because a member's rise may need a different push than the trunk's shared
  // drop.
  const busDropDyByIndex = new Map<number, number>();
  const busChipDyByIndex = new Map<number, number>();
  type BusSlot = {
    index: number;
    id: string;
    laneY: number;
    dropX: number;
    riseChipX: number;
    owner: boolean;
    step: number;
    flowKey: string;
    target: string;
    trunkKey: string;
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
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) continue;
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const tx = absoluteLeft(target, byId);
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const { dropX, riseX } = chamferBusPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      laneY: data.laneY,
      ...routingHintsFromData(edge.data),
    });
    busSlots.push({
      index,
      id: edge.id,
      laneY: data.laneY,
      dropX,
      riseChipX: data.busChipX ?? riseX,
      owner: data.busChipOwner === true,
      // Top-band chips cascade UP (away from the graph below them); bottom-band
      // and un-banded chips cascade DOWN. Signed step drives seatChip's walk.
      step: data.busBand === "top" ? -CHIP_NUDGE_STEP : CHIP_NUDGE_STEP,
      flowKey: flowKeyOf(edge),
      target: edge.target,
      trunkKey: data.trunkKey,
    });
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
  for (const slot of busSlots) {
    if (!slot.owner) continue;
    const dropDy = seatChip(
      field,
      slot.dropX,
      slot.laneY,
      CHIP_HALF_W_WIDE,
      CHIP_HALF_H,
      slot.step,
      slot.flowKey,
      slot.target,
      slot.id,
      laneTrunkExempt.get(slot.trunkKey),
    );
    if (dropDy !== 0) busDropDyByIndex.set(slot.index, dropDy);
  }
  // Capacity check before seating the rises. A short lane run cannot host every
  // member rise chip beside the trunk's aggregate at the wide-chip x-separation
  // (2 * CHIP_HALF_W_WIDE); left to seatChip the crowded rises cascade off the
  // band into empty canvas above/below the graph (issue #24). Instead keep only
  // the rises the run supports and hide the overflow: the aggregate (drop) chip,
  // already seated above, stays the trunk's one on-lane truth, and each hidden
  // member's rate remains on its target card's input row and its edge tooltip
  // (mirroring fanoutBranchHidden). Members are tried FARTHEST-from-aggregate
  // first (edge-id tie-break) so a member that reads at the consumer end -- where
  // the source-side drop cannot label it -- wins the scarce slots over a near
  // one. The aggregate's lane column seeds the kept set so a kept rise clears it
  // too -- deliberately even when the drop chip itself cascaded off the lane
  // (busDropDy != 0): the column stays reserved for it, keeping the check a
  // pure x-capacity rule. Single-member trunks are exempt: a lone rise merely restates its own
  // drop's rate, and the long-run lone member (Task 4) belongs at the consumer
  // end, so never capacity-hide it.
  const MIN_CHIP_SEP = 2 * CHIP_HALF_W_WIDE;
  const busRiseHiddenByIndex = new Set<number>();
  const slotsByTrunk = new Map<string, BusSlot[]>();
  for (const slot of busSlots) {
    const list = slotsByTrunk.get(slot.trunkKey) ?? [];
    list.push(slot);
    slotsByTrunk.set(slot.trunkKey, list);
  }
  for (const [, slots] of slotsByTrunk) {
    if (slots.length < 2) continue;
    const aggX = (slots.find((s) => s.owner) ?? slots[0]!).dropX;
    const keptX = [aggX];
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
  for (const slot of busSlots) {
    // A capacity-hidden rise seats nothing, so its phantom box never blocks a
    // later chip and no busChipDy is stamped (BusEdge draws no rise chip).
    if (busRiseHiddenByIndex.has(slot.index)) continue;
    const riseDy = seatChip(
      field,
      slot.riseChipX,
      slot.laneY,
      CHIP_HALF_W_WIDE,
      CHIP_HALF_H,
      slot.step,
      slot.flowKey,
      slot.target,
      slot.id,
    );
    if (riseDy !== 0) busChipDyByIndex.set(slot.index, riseDy);
  }

  // Phase 3 -- fan-out trunk chips: each fan-out trunk draws one aggregate chip
  // on its owner (the summed rate + xN, seated on the shared trunk segment) and
  // one branch chip per member (that member's share, seated on its branch leg).
  // They seat here -- after the lane bus chips (structurally pinned to their
  // lanes) and before the free item rate chips -- through seatRateChip's
  // three-tier seat, so both slide along their own drawn polyline before nudging
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
  // Card exemption for a trunk's AGGREGATE chip: the union over every member of
  // the trunk. The aggregate spans the shared trunk feeding ALL the members'
  // targets, and its wide box necessarily reaches into the target column, so it
  // must clear every one of those target cards (and the shared source) rather
  // than only the owner's own -- otherwise a sibling member's target reads as a
  // foreign card and shoves the aggregate off the trunk and down onto a branch.
  const trunkExempt = new Map<string, MutCardExemption>();
  for (const { edge } of fanoutEdges) {
    const key = (edge.data as BusEdgeData).trunkKey;
    let set = trunkExempt.get(key);
    if (set === undefined) {
      set = { whole: new Set<string>(), zones: new Map() };
      trunkExempt.set(key, set);
    }
    mergeExemptionInto(set, cardExemptFor(edge));
  }
  for (const { edge, index } of fanoutEdges) {
    const geom = fanoutGeomByIndex.get(index)!;
    if (!geom.owner) continue;
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
      field,
      {
        pts: trunkPts,
        anchorX: geom.trunkAnchor.x,
        anchorY: geom.trunkAnchor.y,
      },
      flowKeyOf(edge),
      edge.target,
      trunkExempt.get((edge.data as BusEdgeData).trunkKey) ?? cardExemptFor(edge),
      NEVER_BAND,
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
  for (const { edge, index } of fanoutEdges) {
    const geom = fanoutGeomByIndex.get(index)!;
    const seat = seatRateChip(
      field,
      {
        pts: geom.pts,
        anchorX: geom.branchAnchor.x,
        anchorY: geom.branchAnchor.y,
      },
      flowKeyOf(edge),
      edge.target,
      cardExemptFor(edge),
      entryBandOf(edge),
    );
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
    // an off-line seat would float in empty canvas. The share it would have
    // shown remains on the target card's input row and in the edge tooltip.
    // The hide is stamped with the branch anchor it was decided at, so BusEdge
    // can drop it once a node drag moves the live anchor away from the stamp.
    // Pop the seat the off-line tiers pushed so the phantom box never blocks a
    // later chip.
    if (seat.tier === "nudge" || seat.tier === "escape" || seat.tier === "exhausted") {
      field.placed.pop();
      fanoutBranchHiddenByIndex.add(index);
      fanoutBranchHiddenAtByIndex.set(index, geom.branchAnchor);
      continue;
    }
    if (seat.dx !== 0) fanoutBranchDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) fanoutBranchDyByIndex.set(index, seat.dy);
  }

  // Phase 4 -- item rate chips: each item edge's clear-segment anchor (cached
  // from the reconstruction above, exactly where ItemEdge renders it) goes
  // through seatRateChip's three-tier seat: slide along the own polyline,
  // short fully-clear nudge, then the chips-and-cards escape cascade.
  // Ordering by edge id keeps it deterministic.
  const labelDyByIndex = new Map<number, number>();
  const labelDxByIndex = new Map<number, number>();
  const items = edges
    .map((edge, index) => ({ edge, index }))
    .filter((e) => e.edge.type === "item")
    .sort((a, b) =>
      a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0,
    );
  for (const { edge, index } of items) {
    const geom = itemGeomByIndex.get(index);
    const target = byId.get(edge.target);
    if (geom === undefined || target === undefined) continue;
    const tx = absoluteLeft(target, byId);
    // Target entry band: the padded-left gutter of the consumer card, mirroring
    // paddedObstacles' overhangs. The arrival-cluster exemption holds only while
    // the chip's centre sits here (the narrowed rate-chip rule).
    const targetTop = absoluteTop(target, byId);
    const entryBand: EntryBand = {
      left: tx - OBSTACLE_PAD_LEFT,
      right: tx,
      top: targetTop - OBSTACLE_PAD_Y,
      bottom: targetTop + nodeHeight(target) + OBSTACLE_PAD_Y,
    };
    const seat = seatRateChip(
      field,
      { pts: geom.pts, anchorX: geom.lx, anchorY: geom.ly },
      flowKeyOf(edge),
      edge.target,
      cardExemptFor(edge),
      entryBand,
    );
    if (seat.tier === "exhausted" && import.meta.env.DEV) {
      // Dev/test-only tripwire, tree-shaken out of production builds (parity
      // with the render hook in src/pipeline/driver.ts). Never expected: cards
      // are finite, so the cascade should always find free space.
      console.warn(
        `chip seating: last-resort cascade for ${edge.id} exhausted its cap; ` +
          "chip parked at its anchor (chip/card hard invariants abandoned)",
      );
    }
    if (seat.dx !== 0) labelDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) labelDyByIndex.set(index, seat.dy);
  }

  return edges.map((edge, index) => {
    const labelDy = labelDyByIndex.get(index);
    const labelDx = labelDxByIndex.get(index);
    const busDropDy = busDropDyByIndex.get(index);
    const busChipDy = busChipDyByIndex.get(index);
    const busRiseHidden = busRiseHiddenByIndex.has(index);
    const fanoutAggDx = fanoutAggDxByIndex.get(index);
    const fanoutAggDy = fanoutAggDyByIndex.get(index);
    const fanoutBranchDx = fanoutBranchDxByIndex.get(index);
    const fanoutBranchDy = fanoutBranchDyByIndex.get(index);
    const fanoutBranchHidden = fanoutBranchHiddenByIndex.has(index);
    const fanoutBranchHiddenAt = fanoutBranchHiddenAtByIndex.get(index);
    if (
      labelDy === undefined &&
      labelDx === undefined &&
      busDropDy === undefined &&
      busChipDy === undefined &&
      !busRiseHidden &&
      fanoutAggDx === undefined &&
      fanoutAggDy === undefined &&
      fanoutBranchDx === undefined &&
      fanoutBranchDy === undefined &&
      !fanoutBranchHidden
    ) {
      return edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(labelDy !== undefined ? { labelDy } : {}),
        ...(labelDx !== undefined ? { labelDx } : {}),
        ...(busDropDy !== undefined ? { busDropDy } : {}),
        ...(busChipDy !== undefined ? { busChipDy } : {}),
        ...(busRiseHidden ? { busRiseHidden: true as const } : {}),
        ...(fanoutAggDx !== undefined ? { fanoutAggDx } : {}),
        ...(fanoutAggDy !== undefined ? { fanoutAggDy } : {}),
        ...(fanoutBranchDx !== undefined ? { fanoutBranchDx } : {}),
        ...(fanoutBranchDy !== undefined ? { fanoutBranchDy } : {}),
        ...(fanoutBranchHidden ? { fanoutBranchHidden: true as const } : {}),
        ...(fanoutBranchHiddenAt !== undefined ? { fanoutBranchHiddenAt } : {}),
      },
    };
  });
}

// A flow-coordinate rectangle, the shape React Flow's fitBounds consumes.
export type ContentRect = { x: number; y: number; width: number; height: number };

// Content bounding box (flow coords) covering both the node cards AND every
// seated edge-label chip, for the camera fit. React Flow's fitView frames node
// cards only, so a chip that cascaded below the deepest lane band, or nudged
// past a border card's edge, lands outside the framed region and clips at the
// viewport rim. This unions the node cards with the bus-lane chip extents
// (exact: lane y + the cascade recorded on edge data) and pads by one chip
// half-box plus the largest recorded item / entry / fan-out nudge, so the
// shallow chips that seat just outside a card stay inside the fit too. Pure and
// deterministic: it reads only the seated offsets the render components already
// consume, never re-seating. Null for an empty graph (nothing to frame).
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

  // Bus-lane chips cascade off their band -- the deepest overflow past the node
  // cards. Their y is exact from the lane plus the cascade on edge data; include
  // a chip half-height so the whole box, not just its centre, clears the rim.
  for (const edge of edges) {
    if (edge.type !== "bus") continue;
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) continue;
    const dropY = data.laneY + (data.busDropDy ?? 0);
    const riseY = data.laneY + (data.busChipDy ?? 0);
    top = Math.min(top, dropY - CHIP_HALF_H, riseY - CHIP_HALF_H);
    bottom = Math.max(bottom, dropY + CHIP_HALF_H, riseY + CHIP_HALF_H);
  }

  // Shallow chips (item rate, fan-out aggregate / branch) anchor within the
  // node span, but their box plus any de-confliction nudge can spill past a
  // border card's edge. Pad every side by one chip half-box plus the largest
  // recorded nudge on each axis so those boxes stay inside the fit too.
  let maxDx = 0;
  let maxDy = 0;
  for (const edge of edges) {
    const d = edge.data as
      | {
          labelDx?: number;
          labelDy?: number;
          fanoutAggDx?: number;
          fanoutAggDy?: number;
          fanoutBranchDx?: number;
          fanoutBranchDy?: number;
        }
      | undefined;
    if (d === undefined) continue;
    maxDx = Math.max(
      maxDx,
      Math.abs(d.labelDx ?? 0),
      Math.abs(d.fanoutAggDx ?? 0),
      Math.abs(d.fanoutBranchDx ?? 0),
    );
    maxDy = Math.max(
      maxDy,
      Math.abs(d.labelDy ?? 0),
      Math.abs(d.fanoutAggDy ?? 0),
      Math.abs(d.fanoutBranchDy ?? 0),
    );
  }
  left -= CHIP_HALF_W_WIDE + maxDx;
  right += CHIP_HALF_W_WIDE + maxDx;
  top -= CHIP_HALF_H + maxDy;
  bottom += CHIP_HALF_H + maxDy;

  return { x: left, y: top, width: right - left, height: bottom - top };
}
