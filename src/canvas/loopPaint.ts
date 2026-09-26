// The loop paint: a tint behind the cards of one directed cycle of the drawn
// plan, and behind the strokes of the cycle's own edges, painted after routing.
// It is no node and no obstacle, so nothing lays out or routes around it; a
// stroke may cross it.
//
// Membership is a fact of the RENDERED edges: every strongly connected set of
// two or more recipe cards over the edges between them. So a cycle that closes
// only through a recaptured byproduct edge (battery5-xiranite's Refining card)
// is a member, and a card the cycle merely feeds (a planter loop's second
// Planting Unit) is not.
//
// Shape: the union of rectangles, never a hull, so the tint cannot reach a card
// outside the cycle.
//
//   +-----------------------------+
//   | caption band                |      each member card padded by
//   +---------+---------+---------+      LOOP_PAINT_PAD, a bridge between two
//   | +-----+ |  bridge | +-----+ |      members an edge joins (their joint
//   | |  A  |=|=========|=|  B  | |      bounding box, only when it keeps clear
//   | +-----+ |         | +-----+ |      of every other card), every drawn
//   +---------+---------+---------+      segment of an edge between two members
//   |  ===== own return rail ==== |      padded the same, and one caption band
//   +-----------------------------+      on a member's top or bottom side
//
// The loop's own strokes are part of its drawing, so a return rail reads as
// inside the loop instead of tracing the tint edge, and every loop is one
// connected region (its members are joined by those strokes). A stroke's pad
// yields where it would reach a foreign card or come within LOOP_PAINT_AIR of
// another loop's paint: it is clipped, never merged.
//
// The segments come from drawnEdge over drawnPortsOf, the drawn geometry the
// edges render with, so the paint follows a drag with them.
//
// A pocket the region encloses is filled unless a foreign card sits in it, so
// the tint shows no slit between a stroke's pad and a card's pad. The fill keeps
// the same air off foreign cards and other paints.
//
// The caption band is placed where it covers no card and no chip, and spans the
// member cards of its row where the paint joins them; a stroke's pad never
// widens it.

import type { Edge } from "@xyflow/react";

import { tarjanScc } from "../solver/scc";
import type { RecipeEdge, RecipeGraph } from "../solver/types";
import type { ItemId } from "../pipeline/types";
import { OBSTACLE_PAD_Y } from "./busRouting";
import { seatedChipBoxes } from "./chipSeating";
import { drawnEdge } from "./edgePath";
import type { RFAnyNode } from "./layout";
import {
  drawnPortsOf,
  nodeIndexOf,
  nodeRectOf,
  type Rect,
} from "./nodeGeometry";

// Air between a member card and the paint edge. It must stay at or below half
// NODE_NODE_SPACING (30 / 2 = 15), or the paints of two neighbouring loops can
// merge. 16 currently exceeds that bound, pending a look review; the closest
// loop-to-loop gap in the corpus is 16 (rot-bottled_food_3).
export const LOOP_PAINT_PAD = 16;

// The least air between a loop's paint and a rail or another loop's paint. The
// paint is a tint, not a card, so it owes the pad a rail keeps off an obstacle
// (OBSTACLE_PAD_Y), not the full air a rail keeps off a raw card.
export const LOOP_PAINT_AIR = OBSTACLE_PAD_Y;

// The caption band's height: the old loop box's caption strip.
export const LOOP_CAPTION_HEIGHT = 22;

// How far a bridge or the caption band keeps off a card it must not cover. The
// card rect is the drawn border box, but the port handles hang a few units past
// it (PORT_DRIFT), so flush is not clear.
export const CARD_CLEARANCE = 4;

export type LoopPaint = {
  // Member card ids, in node order.
  members: string[];
  // The painted shape: the union of these rects.
  rects: Rect[];
  // Primary output of each member recipe, deduped in member order: the
  // caption names the loop by what it makes.
  titleItems: ItemId[];
  // The caption band, one of `rects`. Absent when no clear seat exists.
  caption: Rect | undefined;
};

// The caption text: the loop named by the items its members make, so two loops
// of the same size read differently. Empty when no member item resolves.
export function loopCaption(
  titleItems: ReadonlyArray<ItemId>,
  displayName: (id: string) => string = (id) => id,
): string {
  if (titleItems.length === 0) return "";
  return `LOOP · ${titleItems.map(displayName).join(" · ")}`;
}

// Strongly connected recipe-card sets of size >= 2 over the drawn edges, each
// in node order, sorted by first member.
export function loopMemberSets(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): string[][] {
  const order = new Map<string, number>();
  const outgoing = new Map<string, RecipeEdge[]>();
  for (const n of nodes) {
    if (n.type !== "recipe") continue;
    order.set(n.id, order.size);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    const out = outgoing.get(e.source);
    if (out === undefined || !outgoing.has(e.target)) continue;
    out.push({ id: e.id, source: e.source, target: e.target, item: "" });
  }
  // tarjanScc walks `outgoing` only; the card ids stand in for recipe ids.
  const graph: RecipeGraph = {
    nodes: new Map(),
    outgoing,
    incoming: new Map(),
  };
  return tarjanScc(graph)
    .filter((scc) => scc.recipeIds.length >= 2)
    .map((scc) =>
      [...scc.recipeIds].sort((a, b) => order.get(a)! - order.get(b)!),
    )
    .sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const grow = (r: Rect, by: number): Rect => ({
  left: r.left - by,
  right: r.right + by,
  top: r.top - by,
  bottom: r.bottom + by,
});

const span = (a: Rect, b: Rect): Rect => ({
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  top: Math.min(a.top, b.top),
  bottom: Math.max(a.bottom, b.bottom),
});

const area = (r: Rect): number => (r.right - r.left) * (r.bottom - r.top);

// `a` minus `b`, as up to four rects: the slabs above and below `b`, then the
// pieces left and right of it in between.
function subtract(a: Rect, b: Rect): Rect[] {
  if (!overlaps(a, b)) return [a];
  const out: Rect[] = [];
  if (a.top < b.top) out.push({ ...a, bottom: b.top });
  if (b.bottom < a.bottom) out.push({ ...a, top: b.bottom });
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (a.left < b.left) out.push({ left: a.left, right: b.left, top, bottom });
  if (b.right < a.right)
    out.push({ left: b.right, right: a.right, top, bottom });
  return out;
}

// A stroke's padded rect, yielding to every blocker it reaches. Where a blocker
// stands to one side of the stroke, the pad on that side is pulled back to it
// (the side that keeps the most area), so the rect stays one rect and the
// stroke keeps its pad everywhere else. Only a blocker that reaches the stroke
// itself cuts the rect into pieces.
function yieldingPad(stroke: Rect, blockers: ReadonlyArray<Rect>): Rect[] {
  let pieces = [grow(stroke, LOOP_PAINT_PAD)];
  for (const b of blockers) {
    pieces = pieces.flatMap((p) => {
      if (!overlaps(p, b)) return [p];
      const trims: Rect[] = [];
      if (b.bottom <= stroke.top) trims.push({ ...p, top: b.bottom });
      if (b.top >= stroke.bottom) trims.push({ ...p, bottom: b.top });
      if (b.right <= stroke.left) trims.push({ ...p, left: b.right });
      if (b.left >= stroke.right) trims.push({ ...p, right: b.left });
      if (trims.length === 0) return subtract(p, b);
      return [trims.reduce((best, t) => (area(t) > area(best) ? t : best))];
    });
  }
  return pieces;
}

// The bounding box of every drawn segment of every edge between two members,
// read off the same drawn geometry the edges render with.
function ownStrokes(
  memberSet: ReadonlySet<string>,
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
): Rect[] {
  const strokes: Rect[] = [];
  for (const e of edges) {
    if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
    const ends = drawnPortsOf(e, byId);
    if (ends === null) continue;
    const { pts } = drawnEdge(ends, e.type, e.data);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      strokes.push({
        left: Math.min(x0, x1),
        right: Math.max(x0, x1),
        top: Math.min(y0, y1),
        bottom: Math.max(y0, y1),
      });
    }
  }
  return strokes;
}

export function loopPaints(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): LoopPaint[] {
  const sets = loopMemberSets(nodes, edges);
  if (sets.length === 0) return [];

  const byId = nodeIndexOf(nodes);
  const cards = nodes
    .filter((n) => n.type === "recipe" || n.type === "product")
    .map((n) => ({ id: n.id, rect: nodeRectOf(n) }));
  const chips = seatedChipBoxes(nodes, edges).map((c) => ({
    left: c.x - c.halfW,
    right: c.x + c.halfW,
    top: c.y - c.halfH,
    bottom: c.y + c.halfH,
  }));

  // Every loop's core first: its members padded and bridged.
  const cores = sets.map((members) => {
    const memberSet = new Set(members);
    const foreignCards = cards
      .filter((c) => !memberSet.has(c.id))
      .map((c) => c.rect);
    const foreign = foreignCards.map((r) => grow(r, CARD_CLEARANCE));
    const padded = members.map((id) =>
      grow(nodeRectOf(byId.get(id)!), LOOP_PAINT_PAD),
    );
    const paddedById = new Map(members.map((id, i) => [id, padded[i]!]));
    const rects = [...padded];

    // One bridge per joined pair, both directions of a 2-cycle counted once.
    const joined = new Set<string>();
    for (const e of edges) {
      if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
      const key = [e.source, e.target].sort().join("\0");
      if (joined.has(key)) continue;
      joined.add(key);
      const bridge = span(paddedById.get(e.source)!, paddedById.get(e.target)!);
      if (foreign.some((f) => overlaps(f, bridge))) continue;
      rects.push(bridge);
    }
    return { members, memberSet, foreignCards, foreign, padded, rects };
  });

  // Then the own strokes, loop by loop: a stroke's pad yields to foreign cards,
  // to every other loop's core and to the strokes of the loops before it, so
  // two paints always keep LOOP_PAINT_AIR apart.
  const bodies = cores.map((core) => [...core.rects]);
  cores.forEach((core, k) => {
    const blockers = [
      ...core.foreign,
      ...bodies
        .filter((_, j) => j !== k)
        .flat()
        .map((r) => grow(r, LOOP_PAINT_AIR)),
    ];
    for (const stroke of ownStrokes(core.memberSet, edges, byId)) {
      bodies[k]!.push(...yieldingPad(stroke, blockers));
    }
  });

  // Then the pockets each region encloses, where no foreign card sits.
  cores.forEach((core, k) => {
    const others = bodies
      .filter((_, j) => j !== k)
      .flat()
      .map((r) => grow(r, LOOP_PAINT_AIR));
    bodies[k]!.push(
      ...pocketFill(bodies[k]!, core.foreignCards, [
        ...core.foreign,
        ...others,
      ]),
    );
  });

  // Last the captions, which keep off every card, chip and other paint.
  const cardBlockers = cards.map((c) => grow(c.rect, CARD_CLEARANCE));
  const captions: Rect[] = [];
  return cores.map((core, k) => {
    const rects = bodies[k]!;
    const others = [...bodies.filter((_, j) => j !== k).flat(), ...captions];
    const caption = captionSeat(core.padded, rects, [
      ...cardBlockers,
      ...chips,
      ...others.map((r) => grow(r, LOOP_PAINT_AIR)),
    ]);
    if (caption !== undefined) {
      rects.push(caption);
      captions.push(caption);
    }

    const titleItems: ItemId[] = [];
    for (const id of core.members) {
      const node = byId.get(id);
      if (node?.type !== "recipe") continue;
      const item = node.data.recipe.out[0]?.item;
      if (item !== undefined && !titleItems.includes(item)) {
        titleItems.push(item);
      }
    }

    return { members: core.members, rects, titleItems, caption };
  });
}

// The first clear caption band: on top of a member's padded rect, the topmost
// member first (left to right on a tie), then under one, bottommost first. A
// band is clear when it covers no blocker (cards, chips, other paints). The
// seated band then widens over the member cards of its row.
function captionSeat(
  memberRects: ReadonlyArray<Rect>,
  paint: ReadonlyArray<Rect>,
  blockers: ReadonlyArray<Rect>,
): Rect | undefined {
  const clear = (band: Rect): boolean =>
    !blockers.some((b) => overlaps(b, band));
  const above = [...memberRects].sort(
    (a, b) => a.top - b.top || a.left - b.left,
  );
  for (const r of above) {
    const band = { ...r, top: r.top - LOOP_CAPTION_HEIGHT, bottom: r.top };
    if (clear(band))
      return widened(
        band,
        band.bottom + ROW_PROBE,
        memberRects,
        paint,
        blockers,
      );
  }
  const below = [...memberRects].sort(
    (a, b) => b.bottom - a.bottom || a.left - b.left,
  );
  for (const r of below) {
    const band = {
      ...r,
      top: r.bottom,
      bottom: r.bottom + LOOP_CAPTION_HEIGHT,
    };
    if (clear(band))
      return widened(band, band.top - ROW_PROBE, memberRects, paint, blockers);
  }
  return undefined;
}

// How far inside the paint the row under a caption band is read.
const ROW_PROBE = 0.5;

// The band stretched over the run of paint on row `y` that it stands on, cut
// back to the member cards of that row within the run (so a stroke's pad
// running on past them never widens it), and stopped short of any blocker level
// with it on either side.
function widened(
  band: Rect,
  y: number,
  memberRects: ReadonlyArray<Rect>,
  paint: ReadonlyArray<Rect>,
  blockers: ReadonlyArray<Rect>,
): Rect {
  const runs = paint
    .filter((r) => r.top < y && y < r.bottom)
    .sort((a, b) => a.left - b.left);
  let left = band.left;
  let right = band.right;
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of runs) {
      if (r.right < left || r.left > right) continue;
      if (r.left < left) {
        left = r.left;
        grew = true;
      }
      if (r.right > right) {
        right = r.right;
        grew = true;
      }
    }
  }
  const row = memberRects.filter(
    (r) => r.top < y && y < r.bottom && r.left < right && left < r.right,
  );
  left = Math.max(left, Math.min(...row.map((r) => r.left)));
  right = Math.min(right, Math.max(...row.map((r) => r.right)));

  for (const b of blockers) {
    if (b.bottom <= band.top || b.top >= band.bottom) continue;
    if (b.right <= band.left) left = Math.max(left, b.right);
    if (b.left >= band.right) right = Math.min(right, b.left);
  }
  return { ...band, left, right };
}

// The pockets of `rects` the outside cannot reach and no card of `cards` sits
// in (not even in part), less `blockers`, as rects. The plane is cut into a
// grid at every rect edge, so each cell is wholly painted or wholly bare; a bare
// cell the border cannot reach by bare cells is in a pocket.
function pocketFill(
  rects: ReadonlyArray<Rect>,
  cards: ReadonlyArray<Rect>,
  blockers: ReadonlyArray<Rect>,
): Rect[] {
  const cuts = (lo: (r: Rect) => number, hi: (r: Rect) => number) =>
    [...new Set(rects.flatMap((r) => [lo(r), hi(r)]))].sort((a, b) => a - b);
  const xs = cuts(
    (r) => r.left,
    (r) => r.right,
  );
  const ys = cuts(
    (r) => r.top,
    (r) => r.bottom,
  );
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [];
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));

  // Paint depth per cell, by 2D difference: +1 at each rect's first cell and
  // its opposite corner, -1 at the other two, then prefix sums.
  const w = nx + 1;
  const depth = new Int32Array(w * (ny + 1));
  for (const r of rects) {
    const i0 = xi.get(r.left)!;
    const i1 = xi.get(r.right)!;
    const j0 = yi.get(r.top)!;
    const j1 = yi.get(r.bottom)!;
    if (i0 === i1 || j0 === j1) continue;
    depth[j0 * w + i0]! += 1;
    depth[j0 * w + i1]! -= 1;
    depth[j1 * w + i0]! -= 1;
    depth[j1 * w + i1]! += 1;
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const c = j * w + i;
      if (i > 0) depth[c]! += depth[c - 1]!;
      if (j > 0) depth[c]! += depth[c - w]!;
      if (i > 0 && j > 0) depth[c]! -= depth[c - w - 1]!;
    }
  }
  const bare = (i: number, j: number): boolean => depth[j * w + i] === 0;

  // Flood the bare cells reachable from `seed`, marking each with `mark`.
  const region = new Int32Array(nx * ny);
  const flood = (seed: number, mark: number): number[] => {
    const cells = [seed];
    region[seed] = mark;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]!;
      const i = c % nx;
      const j = (c - i) / nx;
      const next: Array<[number, number]> = [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1],
      ];
      for (const [a, b] of next) {
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a;
        if (region[n] !== 0 || !bare(a, b)) continue;
        region[n] = mark;
        cells.push(n);
      }
    }
    return cells;
  };
  const OUTSIDE = -1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
      if (edge && bare(i, j) && region[j * nx + i] === 0) {
        flood(j * nx + i, OUTSIDE);
      }
    }
  }

  const cellRect = (c: number): Rect => {
    const i = c % nx;
    const j = (c - i) / nx;
    return { left: xs[i]!, right: xs[i + 1]!, top: ys[j]!, bottom: ys[j + 1]! };
  };
  const fill: Rect[] = [];
  let pocket = 0;
  for (let c = 0; c < nx * ny; c++) {
    if (region[c] !== 0 || !bare(c % nx, (c - (c % nx)) / nx)) continue;
    const cells = flood(c, ++pocket).sort((a, b) => a - b);
    const rs = cells.map(cellRect);
    if (rs.some((r) => cards.some((card) => overlaps(r, card)))) continue;

    // One rect per run of cells along a grid row.
    for (let k = 0; k < cells.length; ) {
      let end = k;
      while (end + 1 < cells.length && cells[end + 1] === cells[end]! + 1) {
        end++;
      }
      fill.push({ ...rs[k]!, right: rs[end]!.right });
      k = end + 1;
    }
  }
  return blockers.reduce(
    (pieces, b) => pieces.flatMap((p) => subtract(p, b)),
    fill,
  );
}
