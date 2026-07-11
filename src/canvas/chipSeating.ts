// Chip seating: the whole-graph de-confliction pass that places every
// edge-label chip (entry markers, bus drop/rise chips, item rate chips) after
// routing has finished, plus the clearance machinery it runs on.
//
// Two coincident chips read as one, and on a bus lane the surviving chip lied
// about the flow. deconflictChipAnchors runs last in the render pipeline
// (after routeBusEdges, assignEntryColumns, and assignBendColumns, so it sees
// the final laneY, entryX, bendX, and busChipX) and threads chip-nudge offsets
// onto edge data through one shared collision set (the ClearanceField).
//
// Seating runs in FOUR EXPLICIT PHASES, in this order -- the ordering is
// load-bearing, not incidental, so keep it explicit rather than folding it
// into a generic priority framework:
//   1. entry chips: pinned to their target ports, stacked to a clear pitch;
//      they seed the field first as (near-)fixed obstacles because they are
//      the only chips whose meaning depends on staying at a port.
//   2. bus drop chips: one aggregate total per trunk at its junction; they
//      settle before any rise so a cascading rise can never knock a trunk's
//      aggregate off its lane.
//   3. bus rise chips: per-member lane chips, cascading off the lane (down in
//      the bottom band, up in the top band) when crowded.
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

import {
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  ENTRY_CHIP_BOX_WIDTH,
  ENTRY_CHIP_OFFSET,
  MAX_CHIP_SCALE,
} from "./dimensions";
import {
  chamferBusPath,
  chamferFanoutPath,
  chamferStepPath,
  routingHintsFromData,
} from "./edgePath";
import {
  OBSTACLE_PAD_LEFT,
  OBSTACLE_PAD_Y,
  absoluteLeft,
  absoluteTop,
  edgeItem,
  inputPortIndex,
  nodeHeight,
  nodeWidth,
  portOffsetY,
  type BusEdgeData,
  type LaneBusEdgeData,
} from "./busRouting";
import type { RFAnyNode } from "./layout";

// Chip half-extents, in graph units. A chip counter-scales up to MAX_CHIP_SCALE
// about its centre, so its rendered box in graph space never exceeds
// MAX_CHIP_SCALE times its natural dimension; half of that is the half-extent two
// centres must stay apart on an axis to keep the boxes clear at every zoom down
// to the fit floor. Height is shared by both chip families (they are the same
// height); width splits by family because the icon-only entry marker is far
// narrower than a rate/bus chip carrying text. The collision test sums the two
// boxes' half-extents per axis, so a wide-vs-wide pair needs the full
// MAX_CHIP_SCALE * CHIP_BOX_WIDTH of centre separation while a wide-vs-entry pair
// needs less -- the earlier single fixed 60 flagged only near-coincident pairs
// and missed wide chips that overlap on screen from tens of graph units away.
const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
const CHIP_HALF_W_WIDE = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;
const CHIP_HALF_W_ENTRY = (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2;

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

// The shared clearance state every seating phase runs against: the chips
// placed so far plus the two static obstacle sets (reconstructed edge
// polylines and raw card rects), exposed through the three named predicates
// each seat composes. `placed` is mutated as chips seat, so later phases see
// everything earlier phases placed.
export type ClearanceField = {
  placed: ChipBox[];
  overlapsChip(box: ChipBox): boolean;
  entersForeignCard(box: ChipBox, exempt: ReadonlySet<string>): boolean;
  // Foreign-line test with the arrival-cluster exemption: a same-target
  // sibling's line is skipped unconditionally when no entry band is given
  // (bus / entry seats), and only while the box centre sits inside the band
  // when one is (rate-chip seats, the narrowed 3a rule).
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
      cards.some(
        (c) =>
          !exempt.has(c.id) &&
          Math.min(box.x + box.halfW, c.right) -
            Math.max(box.x - box.halfW, c.left) >
            0.5 &&
          Math.min(box.y + box.halfH, c.bottom) -
            Math.max(box.y - box.halfH, c.top) >
            0.5,
      ),
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
): number | null {
  let dy = 0;
  for (let steps = 0; steps <= maxSteps; steps++) {
    const box = { x, y: y + dy, halfW, halfH };
    if (
      !field.overlapsChip(box) &&
      !field.onForeignLine(box, flowKey, target, entryBand)
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
): number {
  const clear = cascadeClearDy(field, x, y, halfW, halfH, step, flowKey, target);
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
  while (field.overlapsChip({ x, y: y + dy, halfW, halfH })) {
    dy += step;
  }
  field.placed.push({ x, y: y + dy, halfW, halfH });
  return dy;
}

// Minimum vertical pitch between two entry chips arriving at one node, in graph
// units. Entry chips whose port anchors sit closer than this (same-item
// duplicates share a port y outright) are stacked down to this pitch so none
// coincide at any zoom.
export const ENTRY_CHIP_MIN_GAP = CHIP_PITCH_Y;

// Push a column of arrival y-anchors (given in arrival order) down just enough
// that each sits at least ENTRY_CHIP_MIN_GAP below the previous one, so equal or
// too-close anchors never coincide while their order is preserved. The first
// anchor is never moved. Pure.
export function stackEntryAnchors(ys: readonly number[]): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const y of ys) {
    const placed = Math.max(y, prev + ENTRY_CHIP_MIN_GAP);
    out.push(placed);
    prev = placed;
  }
  return out;
}

// Round to two decimals, mirroring edgePath's coordinate rounding so points
// interpolated here land exactly where pathPointAt would put them.
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The point at `frac` (0..1) of the cumulative polyline length, computed over
// an already-parsed vertex list. Byte-for-byte the same arithmetic as
// edgePath's pathPointAt, minus the per-call regex re-parse of the `d` string
// (the slide loop probes dozens of candidates per chip, so the parse cost is
// hoisted to one parse per edge).
function pathPointAtPts(
  pts: ReadonlyArray<readonly [number, number]>,
  frac: number,
): [number, number] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  let remaining = total * Math.min(1, Math.max(0, frac));
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg >= remaining) {
      const t = seg === 0 ? 0 : remaining / seg;
      return [r2(x0 + t * (x1 - x0)), r2(y0 + t * (y1 - y0))];
    }
    remaining -= seg;
  }
  return [r2(pts[0]![0]), r2(pts[0]![1])];
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
//   nudge     a short vertical lift off the line, still fully clear;
//   escape    the chips-and-cards cascade found a seat (foreign-line
//             clearance and on-own-line preference yielded);
//   exhausted the bounded search failed and the chip parked at its anchor
//             (never expected; the caller's DEV warning fires on this).
export type RateSeatTier = "anchor" | "slide" | "nudge" | "escape" | "exhausted";

export type RateSeat = { dx: number; dy: number; tier: RateSeatTier };

// Seat an item rate chip: the three-tier seat the item phase (and P4's
// aggregate chips) run. Tier 1 slides ALONG THE OWN POLYLINE from the anchor,
// nearest arc-length offset first, taking the first point clear of chips,
// cards, and foreign lines -- the chip stays on the flow it labels. Tier 2 is
// a short bidirectional vertical nudge off the anchor, still fully clear, for
// the coincident-parallel-edge case where the own line offers no separation.
// Tier 3 waives the soft preferences (foreign lines, on-own-line) and cascades
// bidirectionally against CHIPS AND CARDS only, nearest escape first (ties
// prefer down), upholding the two hard invariants. The seat is pushed into the
// field; the returned offsets are relative to the anchor.
export function seatRateChip(
  field: ClearanceField,
  path: {
    pts: ReadonlyArray<readonly [number, number]>;
    anchorX: number;
    anchorY: number;
  },
  flowKey: string,
  target: string,
  exempt: ReadonlySet<string>,
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
  const anchorLen = lengthAtPoint(pts, anchorX, anchorY);
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
  // Tier 1: slide along the line, nearest-first, taking the first clear point.
  for (let k = 0; k <= SLIDE_MAX_STEPS; k++) {
    const deltas = k === 0 ? [0] : [k * SLIDE_STEP, -k * SLIDE_STEP];
    for (const delta of deltas) {
      const len = anchorLen + delta;
      if (len < 0 || len > total) continue;
      const [px, py] = pathPointAtPts(pts, total === 0 ? 0 : len / total);
      if (isClear(px, py)) {
        return seat(
          px,
          py,
          px === anchorX && py === anchorY ? "anchor" : "slide",
        );
      }
    }
  }
  // Nothing on the line clears. Two coincident parallel edges, or a chip on a
  // shared bus lane, cannot separate along the line (their lines overlap), and
  // a chip pinned in a dense weave has no clear point on its own polyline.
  // Escapes off the line follow the ratified priority order: chip/chip and
  // chip/card clearance are HARD, staying on the line and clearing foreign
  // lines are preferences that yield.
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
        pts: [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
          (m) => [Number(m[1]), Number(m[2])] as const,
        ),
        junction: fan.junction,
        trunkAnchor: fan.trunkAnchor,
        branchAnchor: fan.branchAnchor,
        owner: (edge.data as BusEdgeData | undefined)?.busChipOwner === true,
      });
    } else if (edge.type === "bus") {
      const laneY = (edge.data as LaneBusEdgeData | undefined)?.laneY ?? ty;
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
      itemGeomByIndex.set(index, {
        pts: [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
          (m) => [Number(m[1]), Number(m[2])] as const,
        ),
        lx,
        ly,
      });
    }
    const pts =
      itemGeomByIndex.get(index)?.pts ??
      [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
        (m) => [Number(m[1]), Number(m[2])] as const,
      );
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
  // The card exemption for an edge's chips: its own endpoints plus their
  // containing groups (one parentId level, same as the audit's containersAt).
  const cardExemptFor = (edge: Edge): Set<string> => {
    const exempt = new Set<string>([edge.source, edge.target]);
    const sp = byId.get(edge.source)?.parentId;
    const tp = byId.get(edge.target)?.parentId;
    if (sp !== undefined) exempt.add(sp);
    if (tp !== undefined) exempt.add(tp);
    return exempt;
  };

  // The shared clearance field: every phase seats into `field.placed`, so a
  // later phase yields to everything an earlier phase placed.
  const field = makeClearanceField(edgeSegments, cards);

  // Phase 1 -- entry chips: every forward item edge flagged multiInputTarget
  // pins an icon-only chip just left of its target port. Chips arriving at one
  // node (same-item duplicates share a port y outright, adjacent ports sit a
  // row apart) collide, so bucket them per target, order by port index then
  // edge id, and stack their port anchors down to a clear pitch. The threaded
  // dy is the push each chip received off its own port y. Each chip's final
  // box is seeded into the field (even a lone chip that received no push) so
  // the later phases see it, at the narrow entry-marker half-width so a bus or
  // rate chip only yields when it truly overlaps the marker.
  const entryDyByIndex = new Map<number, number>();
  type EntrySlot = {
    index: number;
    id: string;
    port: number;
    anchorY: number;
    exempt: Set<string>;
  };
  const entryByTarget = new Map<string, EntrySlot[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const data = edge.data as { multiInputTarget?: unknown } | undefined;
    if (data?.multiInputTarget !== true) return;
    const target = byId.get(edge.target);
    if (target === undefined) return;
    const item = edgeItem(edge);
    const anchorY = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const list = entryByTarget.get(edge.target) ?? [];
    list.push({
      index,
      id: edge.id,
      port: inputPortIndex(target, item),
      anchorY,
      exempt: cardExemptFor(edge),
    });
    entryByTarget.set(edge.target, list);
  });
  for (const [targetId, list] of entryByTarget) {
    list.sort((a, b) => {
      const ap = a.port < 0 ? Infinity : a.port;
      const bp = b.port < 0 ? Infinity : b.port;
      if (ap !== bp) return ap - bp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const entryX = absoluteLeft(byId.get(targetId)!, byId) - ENTRY_CHIP_OFFSET;
    const stacked = stackEntryAnchors(list.map((s) => s.anchorY));
    // Segment-, card-, and chip-aware stacking: a chip whose slot lands on a
    // FOREIGN line (an edge neither of this cluster nor of the chip's own flow
    // -- e.g. a backward rail passing between this node's rows), inside a
    // FOREIGN card box (a packed neighbour under the target), or on a chip
    // already placed steps further down until clear, keeping the stack
    // monotone. The placed check guards CROSS-target stacks: within one target
    // the monotone pitch already keeps chips disjoint, but a neighbour target's
    // overflowed stack can park chips in this stack's descent path. Entry
    // stacks seed the field in target-map insertion order, so the guard is
    // deterministic.
    const clusterBlocked = (box: ChipBox, exempt: ReadonlySet<string>): boolean =>
      field.overlapsChip(box) ||
      field.entersForeignCard(box, exempt) ||
      field.onForeignLine(box, "", targetId);
    let prevY = -Infinity;
    list.forEach((s, i) => {
      let y = Math.max(stacked[i]!, prevY + ENTRY_CHIP_MIN_GAP);
      const boxAt = (yy: number): ChipBox => ({
        x: entryX,
        y: yy,
        halfW: CHIP_HALF_W_ENTRY,
        halfH: CHIP_HALF_H,
      });
      let steps = 0;
      let cleared = y;
      while (
        steps <= CHIP_SEAT_MAX_STEPS &&
        clusterBlocked(boxAt(cleared), s.exempt)
      ) {
        cleared += ENTRY_CHIP_MIN_GAP;
        steps += 1;
      }
      // Cap exhausted: keep the plain stacked slot (pre-segment behaviour).
      if (steps <= CHIP_SEAT_MAX_STEPS) {
        y = cleared;
      } else if (import.meta.env.DEV) {
        // Dev/test-only tripwire, tree-shaken out of production builds
        // (parity with the render hook in src/pipeline/driver.ts).
        console.warn(
          `chip seating: entry stack for ${s.id} exhausted its cap; ` +
            "chip parked on a blocked slot (line/card/chip clearance abandoned)",
        );
      }
      const dy = y - s.anchorY;
      if (dy !== 0) entryDyByIndex.set(s.index, dy);
      field.placed.push(boxAt(y));
      prevY = y;
    });
  }

  // Phases 2 and 3 -- bus chips: each trunk draws one aggregate drop chip (on
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
    });
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
    );
    if (dropDy !== 0) busDropDyByIndex.set(slot.index, dropDy);
  }
  for (const slot of busSlots) {
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

  // Phase 3b -- fan-out trunk chips: each fan-out trunk draws one aggregate chip
  // on its owner (the summed rate + xN, seated on the shared trunk segment) and
  // one branch chip per member (that member's share, seated on its branch leg).
  // They seat here -- after the lane bus chips (structurally pinned to their
  // lanes) and before the free item rate chips -- through seatRateChip's
  // three-tier seat, so both slide along their own drawn polyline before nudging
  // off it. Aggregates settle before branches (the trunk's one truth first,
  // mirroring drop-before-rise). The aggregate has no single consumer gutter, so
  // it passes a degenerate zero-area entry band (no arrival-cluster exemption --
  // it clears every foreign line); a branch uses its own target's entry band.
  const fanoutAggDxByIndex = new Map<number, number>();
  const fanoutAggDyByIndex = new Map<number, number>();
  const fanoutBranchDxByIndex = new Map<number, number>();
  const fanoutBranchDyByIndex = new Map<number, number>();
  const ZERO_BAND: EntryBand = { left: 0, right: 0, top: 0, bottom: 0 };
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
  const trunkExempt = new Map<string, Set<string>>();
  for (const { edge } of fanoutEdges) {
    const key = (edge.data as BusEdgeData).trunkKey;
    let set = trunkExempt.get(key);
    if (set === undefined) {
      set = new Set<string>();
      trunkExempt.set(key, set);
    }
    for (const id of cardExemptFor(edge)) set.add(id);
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
      ZERO_BAND,
    );
    if (seat.dx !== 0) fanoutAggDxByIndex.set(index, seat.dx);
    if (seat.dy !== 0) fanoutAggDyByIndex.set(index, seat.dy);
  }
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
    // the chip's centre sits here (3a).
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

  if (
    labelDyByIndex.size === 0 &&
    labelDxByIndex.size === 0 &&
    entryDyByIndex.size === 0 &&
    busDropDyByIndex.size === 0 &&
    busChipDyByIndex.size === 0 &&
    fanoutAggDxByIndex.size === 0 &&
    fanoutAggDyByIndex.size === 0 &&
    fanoutBranchDxByIndex.size === 0 &&
    fanoutBranchDyByIndex.size === 0
  ) {
    return edges.map((e) => e);
  }
  return edges.map((edge, index) => {
    const labelDy = labelDyByIndex.get(index);
    const labelDx = labelDxByIndex.get(index);
    const entryChipDy = entryDyByIndex.get(index);
    const busDropDy = busDropDyByIndex.get(index);
    const busChipDy = busChipDyByIndex.get(index);
    const fanoutAggDx = fanoutAggDxByIndex.get(index);
    const fanoutAggDy = fanoutAggDyByIndex.get(index);
    const fanoutBranchDx = fanoutBranchDxByIndex.get(index);
    const fanoutBranchDy = fanoutBranchDyByIndex.get(index);
    if (
      labelDy === undefined &&
      labelDx === undefined &&
      entryChipDy === undefined &&
      busDropDy === undefined &&
      busChipDy === undefined &&
      fanoutAggDx === undefined &&
      fanoutAggDy === undefined &&
      fanoutBranchDx === undefined &&
      fanoutBranchDy === undefined
    ) {
      return edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(labelDy !== undefined ? { labelDy } : {}),
        ...(labelDx !== undefined ? { labelDx } : {}),
        ...(entryChipDy !== undefined ? { entryChipDy } : {}),
        ...(busDropDy !== undefined ? { busDropDy } : {}),
        ...(busChipDy !== undefined ? { busChipDy } : {}),
        ...(fanoutAggDx !== undefined ? { fanoutAggDx } : {}),
        ...(fanoutAggDy !== undefined ? { fanoutAggDy } : {}),
        ...(fanoutBranchDx !== undefined ? { fanoutBranchDx } : {}),
        ...(fanoutBranchDy !== undefined ? { fanoutBranchDy } : {}),
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

  // Shallow chips (item rate, entry marker, fan-out aggregate / branch) anchor
  // within the node span, but their box plus any de-confliction nudge can spill
  // past a border card's edge. Pad every side by one chip half-box plus the
  // largest recorded nudge on each axis so those boxes stay inside the fit too.
  let maxDx = 0;
  let maxDy = 0;
  for (const edge of edges) {
    const d = edge.data as
      | {
          labelDx?: number;
          labelDy?: number;
          entryChipDy?: number;
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
      Math.abs(d.entryChipDy ?? 0),
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
