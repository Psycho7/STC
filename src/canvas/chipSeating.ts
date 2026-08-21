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
// Escapes follow the ratified priority order: chip-vs-chip and chip-vs-CARD
// clearance are HARD invariants; staying on the own polyline and clearing
// foreign flow lines are preferences that yield when the hard pair forces an
// escape.

import type { Edge } from "@xyflow/react";

import { CHIP_BOX_HEIGHT, CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "./dimensions";
import {
  CHAMFER,
  chamferBusPath,
  chamferFanoutPath,
  chamferStepPath,
  parsePathPoints,
  pathPointAtPts,
  routingHintsFromData,
} from "./edgePath";
import {
  ENTRY_SLOT_PITCH,
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

// A leg shorter than this cannot hold the full rate chip anywhere on its own
// line (rendered chips measure ~99-110 units; slideAlong clamps to the arc, so
// on such a leg the anchor is the only candidate). Those chips collapse to the
// icon-only variant instead of burying their endpoint cards; the exact rate
// stays on the hover title.
const SHORT_LEG_MAX = CHIP_HALF_W_WIDE;

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
  const own = ownIds !== undefined ? ownIds.has(edge.id) : edge.flowKey === flowKey;
  return !own && (!clusterExempt || edge.target !== target);
}

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
// crosses deeper. Depth is the recipe row's port-side inset (canvas.css
// .rn-row.input padding-left / .rn-row.output padding-right, both 8px) -- the
// strip between the card edge and the row's item glyph, so an exempt chip's
// centre stops at the glyph's leading edge and never sits on the glyph itself.
// Re-derive it whenever that row padding changes. A box-overlap rule instead
// would flag every on-line chip (box wider than corridor) and fling it off its
// line -- the issue-#9 orphaned-chip regression this narrowing must avoid.
export const PORT_ZONE_DEPTH = 8;

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

// Horizontal sidestep pitch and reach. When a parallel FOREIGN vertical line
// sits within the wide chip box on a corridor leg, no vertical motion clears it:
// the on-line slide, the nudge, and the escape cascade all hold x, so a wide box
// straddling a neighbour a few units away would have to travel its whole
// half-width -- which it cannot on a vertical leg, and cannot along a short
// horizontal trunk whose whole span the box already overhangs. The sidestep
// steps the box in x, away from the foreign line toward the own line's free
// side, by ENTRY_SLOT_PITCH increments out to one half-width. That reach is the
// most that keeps the own line WITHIN the box (its edge flush to the line at the
// cap), so the chip still reads as bound to its own leg while its box no longer
// overlaps the neighbour.
const SIDESTEP_PITCH = ENTRY_SLOT_PITCH;
const SIDESTEP_MAX = CHIP_HALF_W_WIDE;

// How a rate chip ended up seated, coarsest last:
//   anchor    on its clear-segment anchor, fully clear;
//   slide     slid along its own polyline to a fully clear point;
//   graze     on its own polyline clear of chips and cards, grazing a foreign
//             line (no fully clear on-line point existed);
//   sidestep  a bounded horizontal step off a corridor leg, away from a parallel
//             foreign line the wide box straddled and no vertical motion could
//             clear, the own line still within the box (fully clear at the seat);
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

export type RateSeat = { dx: number; dy: number; tier: RateSeatTier };

// Seat an item rate chip: the tiered seat the item phase (and 3b's fan-out
// chips) run. Tier 1 slides ALONG THE OWN POLYLINE from the anchor, nearest
// arc-length offset first, taking the first point clear of chips, cards, and
// foreign lines -- the chip stays on the flow it labels. Tier 1b (graze)
// repeats that slide upholding only the HARD invariants (chips and cards) and
// seats at the LEAST-crossed candidate rather than the first one, grazing as
// few foreign lines as the line allows: staying visibly attached to the own
// line outranks clearing a parallel foreign line, because a braided corridor
// can poison every fully-clear candidate and the old off-line exits parked
// chips in empty canvas (issue #9). Tier 1c (sidestep), tried between them: a
// bounded horizontal step off the line, away from a parallel foreign vertical
// the wide box straddles and no on-line motion can shed, keeping the own line
// within the box (issue #28). Tier 2 is a short bidirectional vertical nudge
// off the anchor, fully clear, reached only when the whole own line is chip-
// or card-blocked. Tier 3 waives every soft preference and cascades
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
  // Trunk-context seats (the fan-out aggregate, the fan-out branch) pass extra
  // constraints here; plain item / aggregate-less seats omit it.
  //   ownIds:    trunk-aware foreignness -- own flow is EXACTLY this edge-id set,
  //              not the flowKey group, so a same-flowKey non-member reads
  //              foreign (issue #28, the aggregate seam).
  //   barrierYs: already-seated same-trunk sibling centre-ys on a shared branch
  //              column. The on-line slide may not cross one (jump to its far
  //              side), so a pushed branch stays below its higher sibling rather
  //              than inverting the stack (issue #28, the branch seam).
  //              CONTRACT: only the on-line slide tiers (fully-clear and graze,
  //              both via slideAlong) honor barriers; the nudge and escape
  //              tiers move vertically UNCHECKED, so a caller passing barrierYs
  //              must hide (or consciously accept) off-line seats. Today's only
  //              caller, the fan-out branch loop, hides nudge/escape/exhausted
  //              seats -- that hide is what makes a rendered crossing
  //              impossible, not the barrier alone.
  opts?: {
    ownIds?: ReadonlySet<string> | undefined;
    barrierYs?: ReadonlyArray<number> | undefined;
  },
): RateSeat {
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
      !field.onForeignLine(box, flowKey, target, entryBand, ownIds)
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
  // The slide walk of tier 1: along the line, nearest arc-length offset first,
  // seating at the first candidate the tier's predicate accepts. Tier 1b walks
  // the same candidates in the same order but scores them all, so it spells the
  // walk out below instead of taking a first hit here.
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
        if (crossesBarrier(py)) continue;
        if (ok(px, py)) return seat(px, py, tierAt(px, py));
      }
    }
    return null;
  };
  // Tier 1: the slide taking the first FULLY clear point. Tier 1b (graze, in
  // the scan below) is reached when nothing on the line is fully clear. In a
  // braided corridor a parallel foreign line within a chip half-height poisons
  // every tier-1 candidate at once, yet the own line is otherwise empty -- the
  // chip belongs on it, icon and tint disambiguate the graze.
  const fullyClearSlide = slideAlong(isClear, (px, py) =>
    px === anchorX && py === anchorY ? "anchor" : "slide",
  );
  if (fullyClearSlide !== null) return fullyClearSlide;
  // Tier 1c (sidestep): no fully clear point exists ALONG the own line, which on
  // a vertical corridor leg (or a short horizontal trunk the box wholly
  // overhangs) means a parallel foreign line the wide box cannot shed by any
  // vertical motion. Step the box horizontally off the line -- away from the
  // foreign line, toward the own line's free side -- keeping the own line within
  // the box (offset <= one half-width). Both directions are probed nearest-first
  // so the free side wins: clearing the foreign line by moving toward it would
  // take more than a half-width plus a pitch (past the reach), and the blocked
  // side (a card or the foreign line itself) never clears. On a tie the positive
  // x wins. The reach's last step is clamped to the flush half-width even when
  // the pitch does not divide it.
  for (let step = 1; ; step++) {
    const off = Math.min(step * SIDESTEP_PITCH, SIDESTEP_MAX);
    for (const px of [anchorX + off, anchorX - off]) {
      if (isClear(px, anchorY)) return seat(px, anchorY, "sidestep");
    }
    if (off >= SIDESTEP_MAX) break;
  }
  // Tier 1b (graze), least-bad: no candidate on the line is fully clear, so
  // every remaining on-line seat crosses at least one foreign line (a
  // zero-crossing hard-clear point would already have been taken by tier 1).
  // Taking the FIRST hard-clear candidate parks the chip at the anchor, which
  // at saturated counter-scale is the thick of the fan. Walk the same
  // candidates in the same order, score each by its foreign-line crossings, and
  // seat at the minimum. Strict less-than keeps the nearest-first,
  // forward-first preference on ties (an all-equal line still seats at the
  // anchor), and a score of 1 cannot be beaten, so the walk stops there.
  // The walk is spelled out rather than run through slideAlong because that
  // helper seats at its first accepted candidate by construction; the order,
  // the barrier skip and the arc-length clamp mirror it exactly.
  let bestGraze: { px: number; py: number; score: number } | null = null;
  for (
    let k = 0;
    k <= SLIDE_MAX_STEPS && (bestGraze === null || bestGraze.score > 1);
    k++
  ) {
    const deltas = k === 0 ? [0] : [k * SLIDE_STEP, -k * SLIDE_STEP];
    for (const delta of deltas) {
      const len = anchorLen + delta;
      if (len < 0 || len > total) continue;
      const [px, py] = pathPointAtPts(pts, total === 0 ? 0 : len / total);
      if (crossesBarrier(py)) continue;
      if (!hardClearAt(px, py)) continue;
      const score = field.foreignLineCrossings(
        boxAt(px, py),
        flowKey,
        target,
        entryBand,
        ownIds,
      );
      if (bestGraze === null || score < bestGraze.score) {
        bestGraze = { px, py, score };
      }
    }
  }
  if (bestGraze !== null) return seat(bestGraze.px, bestGraze.py, "graze");
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

// Drawn-vs-model port drift, in graph units, per node kind. React Flow anchors
// an edge at the OUTER edge of the handle's 8x8 box (getHandlePosition), not at
// the model port busRouting computes, so the drawn path starts and ends a few
// units off the model coordinate. Derivation, from the DOM boxes:
//   recipe: the card is content-box RECIPE_WIDTH (300) with a 1px border per
//     side, so its border box is 302 wide while node.position is still the
//     model left L. Handles hang off the .rn-row edges INSIDE that border
//     (row spans L+1 .. L+301), each box centred on its row edge, so the outer
//     edges land at L-3 and L+305: targetDx -3, and sourceDx +5 against the
//     model port at L+300. The same 1px top border pushes each row's mid-line
//     one unit below the model row y, hence dy +1.
//   product: the 148-wide wrapper carries no such width discrepancy, so its
//     handle boxes give a symmetric [-4, +4]; the handles are CSS-centred on a
//     wrapper inline-sized to node.height, so dy is 0.
//   loop / container: no measured drift and no edge endpoints on them in any
//     corpus plan, so they stay at zero rather than borrowing another kind's
//     numbers.
// Re-derive these if the card borders or paddings change, if handle sizing or
// nesting changes (RecipeNode/ProductNode markup, .react-flow__handle CSS), or
// if React Flow changes its handle-anchoring rule.
type PortDrift = { sourceDx: number; targetDx: number; dy: number };

const PORT_DRIFT: Record<"recipe" | "product" | "other", PortDrift> = {
  recipe: { sourceDx: 5, targetDx: -3, dy: 1 },
  product: { sourceDx: 4, targetDx: -4, dy: 0 },
  other: { sourceDx: 0, targetDx: 0, dy: 0 },
};

function portDrift(node: RFAnyNode): PortDrift {
  if (node.type === "recipe") return PORT_DRIFT.recipe;
  if (node.type === "product") return PORT_DRIFT.product;
  return PORT_DRIFT.other;
}

// The drawn port y for one endpoint. The recipe dy applies only when the port
// resolved to an actual row: portOffsetY falls back to the node's vertical
// centre for an unresolvable item / order, and that fallback is a deliberate
// approximation of an unknown row, not a row shifted by the card border. A row
// mid-line can never coincide with the centre -- rows sit at 97 + 22i and the
// card centre at 59 + 11*maxRows, and 22i + 38 = 11*maxRows has no integer
// solution -- so comparing against the centre is an exact test for "resolved".
function driftedPortY(
  node: RFAnyNode,
  item: string | undefined,
  side: "in" | "out",
): number {
  const y = portOffsetY(node, item, side);
  const centreFallback = node.type === "recipe" && y === nodeHeight(node) / 2;
  return centreFallback ? y : y + portDrift(node).dy;
}

// The four port coordinates an edge's path builders take, resolved the same way
// every routing pass resolves them (source Right port, target Left port, at the
// item's row), then shifted onto the drawn handle coordinates by PORT_DRIFT.
// Null when either endpoint is missing from the node map. Shared by the seating
// pass and contentBounds so both reconstruct the DRAWN geometry.
function edgeEndpoints(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): { sx: number; sy: number; tx: number; ty: number } | null {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return null;
  const item = edgeItem(edge);
  return {
    sx:
      absoluteLeft(source, byId) +
      nodeWidth(source) +
      portDrift(source).sourceDx,
    sy: absoluteTop(source, byId) + driftedPortY(source, item, "out"),
    tx: absoluteLeft(target, byId) + portDrift(target).targetDx,
    ty: absoluteTop(target, byId) + driftedPortY(target, item, "in"),
  };
}

// One drawn junction dot and the family it belongs to. The four families are
// drawn by three different components -- BusEdge draws the lane member's branch
// dot and the fan-out trunk's split dot from the path builders, ItemEdge draws
// the fan-in merge dot and the declined-fan-out divergence dot from the stamps
// below -- but they are one obstacle class to the seating phases, so the
// collected set keeps the family only as a label.
type JunctionDotKind = "lane" | "fanout" | "fanin" | "divergence";
type JunctionDot = { x: number; y: number; kind: JunctionDotKind };

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
  // Lane bus members cache the junction BusEdge draws at their branch point.
  // Taken from the same chamferBusPath result the polyline comes from, so the
  // cached dot is the drawn dot rather than a second derivation of it.
  const laneJunctionByIndex = new Map<number, { x: number; y: number }>();
  // Item edges whose whole polyline is shorter than one rendered chip: their
  // rate chip renders icon-only (see SHORT_LEG_MAX).
  const shortLegByIndex = new Set<number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item" && edge.type !== "bus") return;
    const ends = edgeEndpoints(edge, byId);
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
      const lane = chamferBusPath({
        sourceX: sx,
        sourceY: sy,
        targetX: tx,
        targetY: ty,
        laneY,
        ...routingHintsFromData(edge.data),
      });
      d = lane.path;
      laneJunctionByIndex.set(index, lane.junction);
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
      let legLen = 0;
      for (let i = 1; i < itemPts.length; i++) {
        legLen += Math.hypot(
          itemPts[i]![0] - itemPts[i - 1]![0],
          itemPts[i]![1] - itemPts[i - 1]![1],
        );
      }
      if (legLen < SHORT_LEG_MAX) shortLegByIndex.add(index);
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
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
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
    const tx = absoluteLeft(target, byId);
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
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
  for (const p of fanoutJunctionByIndex.values()) addDot(p, "divergence");

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
  type BusSlot = {
    index: number;
    id: string;
    laneY: number;
    dropX: number;
    riseChipX: number;
    owner: boolean;
    // Lane members sharing this trunk. Only a lone member draws (and so seats)
    // an aggregate drop chip.
    memberCount: number;
    step: number;
    flowKey: string;
    target: string;
    trunkKey: string;
    // Target in-port y, the top-to-bottom key the rise seat loop stacks by.
    entryY: number;
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
      memberCount: data.busMemberCount ?? 1,
      // Top-band chips cascade UP (away from the graph below them); bottom-band
      // and un-banded chips cascade DOWN. Signed step drives seatChip's walk.
      step: data.busBand === "top" ? -CHIP_NUDGE_STEP : CHIP_NUDGE_STEP,
      flowKey: flowKeyOf(edge),
      target: edge.target,
      trunkKey: data.trunkKey,
      entryY: ty,
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
    // Multi-member trunks draw no aggregate chip (issue #39), so seat none.
    if (!slot.owner || slot.memberCount > 1) continue;
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
  // member rise chip at the wide-chip x-separation (2 * CHIP_HALF_W_WIDE); left
  // to seatChip the crowded rises cascade off the band into empty canvas
  // above/below the graph (issue #24). Instead keep only the rises the run
  // supports and hide the overflow: each hidden member's rate remains on its
  // target card's input row and its edge tooltip (mirroring fanoutBranchHidden).
  // No aggregate chip exists on a multi-member trunk (issue #39); the run's
  // capacity all goes to member rises, farthest from the junction first (edge-id
  // tie-break), so a member that reads at the consumer end -- where the
  // source-side junction cannot label it -- wins the scarce slots over a near
  // one. Single-member trunks are exempt: a lone rise merely restates its own
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
    // seatChip's cascade is unbounded in y, so a KEPT rise whose lane slot is
    // blocked can still walk clean off the band into empty canvas -- the chip
    // ends up with no stroke touching it, the same orphan silhouette the
    // capacity check above hides a crowded rise to avoid (issue #37). One step
    // still reads as sitting beside the lane; two or more do not, so past that
    // the rise is unseatable: undo its seat (seatChip pushes exactly one box)
    // and hide it, its rate staying on the target card's input row and the edge
    // tooltip like every other hidden member's.
    if (Math.abs(riseDy) > CHIP_PITCH_Y) {
      field.placed.pop();
      busRiseHiddenByIndex.add(slot.index);
      continue;
    }
    if (riseDy !== 0) busChipDyByIndex.set(slot.index, riseDy);
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
      { ownIds: trunkMemberIds.get((edge.data as BusEdgeData).trunkKey) },
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
    return absoluteTop(target, byId) + portOffsetY(target, edgeItem(edge), "in");
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
      { barrierYs: seatedBranchYByTrunk.get(trunkKey) },
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
    // The chip seated on its column: record its centre-y as a barrier for the
    // next same-trunk branch so a pushed later branch cannot slide across it.
    const seatedYs = seatedBranchYByTrunk.get(trunkKey) ?? [];
    seatedYs.push(geom.branchAnchor.y + seat.dy);
    seatedBranchYByTrunk.set(trunkKey, seatedYs);
    if (seat.dx !== 0) fanoutBranchDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) fanoutBranchDyByIndex.set(index, seat.dy);
  }

  // Phase 4 -- item rate chips: each item edge's clear-segment anchor (cached
  // from the reconstruction above, exactly where ItemEdge renders it) goes
  // through seatRateChip's tier ladder: slide along the own polyline (fully
  // clear, then graze), the horizontal sidestep, the short fully-clear nudge,
  // then the chips-and-cards escape cascade.
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
    // A non-owner fan-in member whose own chip SEATED on the shared run (at the
    // port y, between the merge and the port) crowds the run the owner's chip
    // reads on: pop its box and hide it (ItemEdge draws no rate chip, the exact
    // rate stays on the hover path and the target card's input row). A member
    // seated on its own PRE-merge leg (off the run) keeps its chip. Anchor-based
    // hiding cannot catch a member that SLID onto the run, so this reads the
    // seated centre.
    const run = faninMemberRunByIndex.get(index);
    if (run !== undefined) {
      const seatX = geom.lx + seat.dx;
      const seatY = geom.ly + seat.dy;
      if (
        Math.abs(seatY - run.ty) <= FANIN_EPS &&
        seatX >= run.mergeX - FANIN_EPS &&
        seatX <= run.tx + FANIN_EPS
      ) {
        field.placed.pop();
        faninChipHiddenByIndex.add(index);
        continue;
      }
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
    const faninJunction = faninJunctionByIndex.get(index);
    const fanoutJunction = fanoutJunctionByIndex.get(index);
    const faninChipHidden = faninChipHiddenByIndex.has(index);
    const chipIconOnly = shortLegByIndex.has(index);
    if (
      !chipIconOnly &&
      labelDy === undefined &&
      labelDx === undefined &&
      busDropDy === undefined &&
      busChipDy === undefined &&
      !busRiseHidden &&
      fanoutAggDx === undefined &&
      fanoutAggDy === undefined &&
      fanoutBranchDx === undefined &&
      fanoutBranchDy === undefined &&
      !fanoutBranchHidden &&
      faninJunction === undefined &&
      fanoutJunction === undefined &&
      !faninChipHidden
    ) {
      return edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(labelDy !== undefined ? { labelDy } : {}),
        ...(labelDx !== undefined ? { labelDx } : {}),
        ...(chipIconOnly ? { chipIconOnly: true as const } : {}),
        ...(busDropDy !== undefined ? { busDropDy } : {}),
        ...(busChipDy !== undefined ? { busChipDy } : {}),
        ...(busRiseHidden ? { busRiseHidden: true as const } : {}),
        ...(fanoutAggDx !== undefined ? { fanoutAggDx } : {}),
        ...(fanoutAggDy !== undefined ? { fanoutAggDy } : {}),
        ...(fanoutBranchDx !== undefined ? { fanoutBranchDx } : {}),
        ...(fanoutBranchDy !== undefined ? { fanoutBranchDy } : {}),
        ...(fanoutBranchHidden ? { fanoutBranchHidden: true as const } : {}),
        ...(fanoutBranchHiddenAt !== undefined ? { fanoutBranchHiddenAt } : {}),
        ...(faninJunction !== undefined
          ? { faninJunctionX: faninJunction.x, faninJunctionY: faninJunction.y }
          : {}),
        ...(fanoutJunction !== undefined
          ? {
              fanoutJunctionX: fanoutJunction.x,
              fanoutJunctionY: fanoutJunction.y,
            }
          : {}),
        // The hide is stamped with the port y it was decided at, so ItemEdge
        // can drop it once a node drag moves the live port away from the stamp
        // (the fanoutBranchHiddenAt staleness pattern).
        ...(faninChipHidden
          ? {
              faninChipHidden: true as const,
              faninChipHiddenAtY: faninMemberRunByIndex.get(index)!.ty,
            }
          : {}),
      },
    };
  });
}

// A flow-coordinate rectangle, the shape React Flow's fitBounds consumes.
export type ContentRect = { x: number; y: number; width: number; height: number };

// The edge-data fields contentBounds needs to place a chip: which families the
// edge draws, their anchors' inputs, their seated nudges, and their hides. Flat
// and all-optional rather than the BusEdgeData / ItemEdgeData unions, because
// this reader takes one uniform view over every edge type.
type ChipAnchorData = {
  labelDx?: number;
  labelDy?: number;
  fanout?: boolean;
  busChipOwner?: boolean;
  fanoutAggDx?: number;
  fanoutAggDy?: number;
  fanoutBranchDx?: number;
  fanoutBranchDy?: number;
  fanoutBranchHidden?: boolean;
  laneY?: number;
  busChipX?: number;
  busDropDy?: number;
  busChipDy?: number;
  busRiseHidden?: boolean;
  busMemberCount?: number;
  faninChipHidden?: boolean;
};

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
    const ends = edgeEndpoints(edge, byId);
    if (ends === null) continue;
    const geom = {
      sourceX: ends.sx,
      sourceY: ends.sy,
      targetX: ends.tx,
      targetY: ends.ty,
      ...routingHintsFromData(edge.data),
    };
    if (edge.type === "item") {
      if (data?.faninChipHidden === true) continue;
      const [, lx, ly] = chamferStepPath(geom);
      unionChip(lx + (data?.labelDx ?? 0), ly + (data?.labelDy ?? 0));
    } else if (edge.type === "bus" && data?.fanout === true) {
      const fan = chamferFanoutPath(geom);
      // A multi-member trunk renders no aggregate chip (issue #39), so it
      // frames none.
      if (data.busChipOwner !== false && (data.busMemberCount ?? 1) === 1) {
        unionChip(
          fan.trunkAnchor.x + (data.fanoutAggDx ?? 0),
          fan.trunkAnchor.y + (data.fanoutAggDy ?? 0),
        );
      }
      if (data.fanoutBranchHidden !== true) {
        unionChip(
          fan.branchAnchor.x + (data.fanoutBranchDx ?? 0),
          fan.branchAnchor.y + (data.fanoutBranchDy ?? 0),
        );
      }
    } else if (edge.type === "bus" && data?.laneY !== undefined) {
      const bus = chamferBusPath({ ...geom, laneY: data.laneY });
      if (data.busChipOwner !== false && (data.busMemberCount ?? 1) === 1) {
        unionChip(bus.dropX, data.laneY + (data.busDropDy ?? 0));
      }
      if (data.busRiseHidden !== true) {
        unionChip(data.busChipX ?? bus.riseX, data.laneY + (data.busChipDy ?? 0));
      }
    }
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
