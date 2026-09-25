// Horizontal level occupancy: the drawn horizontals a routing pass owes
// clearance to, and the levels it may move to instead.
//
// This module holds one kind of geometry and nothing else -- lines that run
// along x at some y. Two consumers read it. jogForwardLegs asks it for the
// forward runs of the other edges and for the levels a relocated run may take;
// clampBackwardRails asks it for the same runs once they are final. The jog
// pass also asks it to count what a clear level crosses, handing in the other
// edges' drawn verticals as data, and how many cards it passes close to. It
// is not a registry of everything occupied: verticals live in the chip pass's
// own segment index, and reserved chip boxes are not here at all.
//
// Two rules the module states and neither consumer restates:
//   - the port-row waiver. Two runs that coincide on a port row their edges
//     share draw as one line on purpose, so they owe each other nothing.
//   - no chaining. Run bands are floor predicates and candidate sources. They
//     never become obstacles fed into the card-clearance search, because a band
//     that can merge with a card into one connected escape band sends a
//     relocated level hundreds of units away.
//
// Everything here is pure and depends only on the geometry handed in, never on
// the order it arrived in. Clearance policy is NOT here: the module supplies
// floors and candidates, and each consumer keeps its own acceptance test.

import type { Edge } from "@xyflow/react";

import { PORT_STUB, clamp, drawnEdge, horizontalRuns } from "./edgePath";
import { CHIP_HALF_H } from "./chipMetrics";
import { COLUMN_MIN_PITCH } from "./layerModel";
import { drawnPortsOf, type Rect } from "./nodeGeometry";
import type { RFAnyNode } from "./layout";

// The y clearance two forward horizontal runs of different edges keep where
// they share an x-corridor. Below it the pair reads as a single thick stroke
// carrying two chips -- gas-web held a raw supply and a catalyst supply 2 units
// apart for about a thousand units, with the catalyst's fan-out dot sitting on
// the raw line. COLUMN_MIN_PITCH is the floor the rule asks for, the same value
// the column families keep on the x axis (busRouting names it ENTRY_SLOT_PITCH
// there); the separation actually taken is a whole chip box, for the reason
// railLevelBand takes one -- each run carries its rate chip centred on it, so
// two runs less than a box apart stack their two chips into one smeared figure
// belonging to neither line.
export const FORWARD_LEVEL_FLOOR = Math.max(COLUMN_MIN_PITCH, 2 * CHIP_HALF_H);

// The port-row identity of the run a query is asked about, so the waiver below
// can fire.
export type LevelPorts = {
  source: string;
  target: string;
  sy: number;
  ty: number;
};

// One drawn horizontal run, grown by the clearance it owns on each side.
// `top` / `bottom` are y +/- FORWARD_LEVEL_FLOOR, materialised because every
// consumer tests them the same way; `left` / `right` are the run's x span.
export type RunBand = LevelPorts & {
  edgeId: string;
  y: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

// One edge's drawn horizontal runs, as bands for the OTHER edges' runs. Read
// off the drawn polyline rather than the stamps, so the band covers the line
// the reader sees; a backward detour contributes none (its rail level is
// clampBackwardRails' business). Each band carries the level it is grown around
// and its edge's two port rows, which is all the waiver needs.
export function runBandsOfEdge(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): RunBand[] {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return [];
  if (ends.targetX <= ends.sourceX) return [];
  const { pts } = drawnEdge(ends, edge.type, edge.data);
  const ports: LevelPorts = {
    source: edge.source,
    target: edge.target,
    sy: ends.sourceY,
    ty: ends.targetY,
  };
  return horizontalRuns(pts).map((run) => ({
    ...ports,
    edgeId: edge.id,
    left: run.lo,
    right: run.hi,
    top: run.y - FORWARD_LEVEL_FLOOR,
    bottom: run.y + FORWARD_LEVEL_FLOOR,
    y: run.y,
  }));
}

// Do these two runs draw as ONE line on purpose? They do when they coincide on
// a port row the two edges share: every edge leaving one output row draws the
// same stub out of it, and every edge arriving on one input row draws the same
// approach into it, which is what a trunk is. Sharing the target CARD is not
// enough -- a recipe fed the same item as a raw input and as a catalyst charge
// takes it on two different rows, and those two supplies are two lines.
export function sharesPortRow(
  band: LevelPorts & { y: number },
  self: LevelPorts,
  y: number,
): boolean {
  if (band.y !== y) return false;
  if (band.source === self.source && band.sy === self.sy && y === self.sy) {
    return true;
  }
  return band.target === self.target && band.ty === self.ty && y === self.ty;
}

// Does a horizontal run at `y` from x0 to x1 break the floor against any of
// these bands? The x test is an OVERLAP LENGTH, not a bare intersection: two
// runs that share less than a port stub of span are a corner meeting a line,
// not one smeared line, and forcing them apart would jog an edge for a graze
// nobody reads as a collision. A band the run shares a port row with is waived.
export function runFloorHit(
  bands: ReadonlyArray<RunBand>,
  self: LevelPorts,
  y: number,
  x0: number,
  x1: number,
): boolean {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  return bands.some(
    (b) =>
      !sharesPortRow(b, self, y) &&
      Math.min(hi, b.right) - Math.max(lo, b.left) > PORT_STUB &&
      y > b.top &&
      y < b.bottom,
  );
}

// The levels a horizontal spanning [x0, x1] may relocate to, in acceptance
// order: every spanned card's padded escape, and every spanned band's own edges
// as well as those edges padded. A band already carries the clearance it wants, so
// its own edge IS a candidate level; offering only the padded one would skip
// the level that just clears a neighbouring line and land on the line past it.
// Both are offered, since a candidate further out of a band is no less clear of
// it.
//
// The span is given in BOTH frames, because the inputs are built in two: the
// bands are read off the drawn polylines (runBandsOfEdge), while the cards are
// the routing passes' model rects. Each input is filtered by the span in its
// own frame, so the drift between the two never decides what the run spans.
//
// Sorted nearest to `anchorY` first -- the smallest vertical excursion wins --
// with the row value as the tie-break, so the order never depends on the order
// the obstacles were handed in.
export function levelCandidates(args: {
  anchorY: number;
  // The run's x-span in the MODEL frame, for the cards.
  x0: number;
  x1: number;
  // The same span in the DRAWN frame, for the bands.
  drawnX0: number;
  drawnX1: number;
  bands: ReadonlyArray<RunBand>;
  cards: ReadonlyArray<Rect>;
  pad: number;
}): number[] {
  const lo = Math.min(args.x0, args.x1);
  const hi = Math.max(args.x0, args.x1);
  const spans = (o: Rect): boolean => o.right > lo && o.left < hi;
  const drawnLo = Math.min(args.drawnX0, args.drawnX1);
  const drawnHi = Math.max(args.drawnX0, args.drawnX1);
  const levels = new Set<number>();
  for (const card of args.cards) {
    if (!spans(card)) continue;
    levels.add(card.top - args.pad);
    levels.add(card.bottom + args.pad);
  }
  for (const band of args.bands) {
    if (band.right <= drawnLo || band.left >= drawnHi) continue;
    levels.add(band.top);
    levels.add(band.bottom);
    levels.add(band.top - args.pad);
    levels.add(band.bottom + args.pad);
  }
  return [...levels].sort(
    (a, b) => Math.abs(a - args.anchorY) - Math.abs(b - args.anchorY) || a - b,
  );
}

// Walk the candidate levels and return the first one the consumer accepts, or
// `preferred` when none is accepted. The degrade is deliberate: a pass that
// finds no clear level keeps the level it already has rather than flinging the
// line somewhere arbitrary. `acceptable` is the consumer's whole-shape test,
// because the module supplies floors and candidates and decides nothing.
export function chooseLevel(
  preferred: number,
  candidates: ReadonlyArray<number>,
  acceptable: (y: number) => boolean,
): number {
  for (const y of candidates) {
    if (acceptable(y)) return y;
  }
  return preferred;
}

// A jog's three movable pieces, in the drawn frame: the column at C from the
// source row sy down / up to the level R, the run at R from C to D, and the
// descent at D from R to the target row ty.
export type JogShape = {
  sy: number;
  C: number;
  R: number;
  D: number;
  ty: number;
};

// Another edge's drawn vertical, zero-width at x = left (the shape
// drawnColumnBands hands back).
export type ColumnLine = { left: number; top: number; bottom: number };

// Another edge's drawn horizontal run at y from left to right.
export type RunLine = { y: number; left: number; right: number };

// How many of the lines already drawn the jog's three pieces cross. Only
// PROPER crossings count, strictly inside both segments: a line that ends on
// the jog, or that the jog ends on, meets it at a corner and draws no X.
// Axis-aligned throughout, so each test is two open-interval checks.
export function levelCrossingCost(
  shape: JogShape,
  columns: ReadonlyArray<ColumnLine>,
  runs: ReadonlyArray<RunLine>,
): number {
  const inside = (v: number, a: number, b: number): boolean =>
    v > Math.min(a, b) && v < Math.max(a, b);
  const { sy, C, R, D, ty } = shape;
  let count = 0;
  for (const col of columns) {
    if (inside(col.left, C, D) && inside(R, col.top, col.bottom)) count += 1;
  }
  for (const run of runs) {
    if (inside(C, run.left, run.right) && inside(run.y, sy, R)) count += 1;
    if (inside(D, run.left, run.right) && inside(run.y, R, ty)) count += 1;
  }
  return count;
}

// Does the jog's column, run or descent pass strictly within `clearance` of
// any of the dot centres? A line that close runs through the dot's disc and
// reads as a member of the split or merge the dot marks.
export function levelPassesDot(
  shape: JogShape,
  dots: ReadonlyArray<{ x: number; y: number }>,
  clearance: number,
): boolean {
  const { sy, C, R, D, ty } = shape;
  const pieces: ReadonlyArray<readonly [number, number, number, number]> = [
    [C, sy, C, R],
    [C, R, D, R],
    [D, R, D, ty],
  ];
  return dots.some((dot) =>
    pieces.some(([x0, y0, x1, y1]) => {
      const dx = dot.x - clamp(dot.x, Math.min(x0, x1), Math.max(x0, x1));
      const dy = dot.y - clamp(dot.y, Math.min(y0, y1), Math.max(y0, y1));
      return Math.hypot(dx, dy) < clearance;
    }),
  );
}

// How many cards a run at R from x0 to x1 passes closer than `pad` to: a card
// the run's x-extent reaches, whose top or bottom lies strictly within `pad`
// of R, counts once. `pad` is the router's own card-candidate pad, the one
// levelCandidates offers a card's escape at, so a card's own escape level sits
// exactly one pad off it and is not near.
export function levelNearCardCount(
  R: number,
  x0: number,
  x1: number,
  cards: ReadonlyArray<Rect>,
  pad: number,
): number {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  let count = 0;
  for (const card of cards) {
    if (card.right <= lo || card.left >= hi) continue;
    if (Math.abs(R - card.top) < pad || Math.abs(R - card.bottom) < pad) {
      count += 1;
    }
  }
  return count;
}

// The candidate with the lowest cost, compared term by term, the earliest in
// the given order breaking a full tie; undefined when there are none.
// Candidates arrive nearest-first, so the last tie-break is the smallest
// excursion without recomputing it. Stops at the first all-zero cost, which
// nothing after it can beat.
export function chooseLevelByCost<T>(
  candidates: Iterable<T>,
  cost: (candidate: T) => ReadonlyArray<number>,
): T | undefined {
  let best: T | undefined;
  let bestCost: ReadonlyArray<number> | undefined;
  for (const candidate of candidates) {
    const c = cost(candidate);
    if (bestCost !== undefined && !lexLess(c, bestCost)) continue;
    best = candidate;
    bestCost = c;
    if (c.every((term) => term === 0)) break;
  }
  return best;
}

function lexLess(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}
