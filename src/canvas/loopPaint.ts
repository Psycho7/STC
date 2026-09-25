// The loop paint: a tint behind the cards of one directed cycle of the drawn
// plan, painted after routing. It is no node and no obstacle, so nothing lays
// out or routes around it; a stroke may cross it.
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
//   | |  A  | |         | |  B  | |      bounding box, only when it keeps clear
//   | +-----+ |         | +-----+ |      of every other card), and one caption
//   +---------+---------+---------+      band on a member's top or bottom side
//
// The caption band is placed where it covers no card and no chip.

import type { Edge } from "@xyflow/react";

import { tarjanScc } from "../solver/scc";
import type { RecipeEdge, RecipeGraph } from "../solver/types";
import type { ItemId } from "../pipeline/types";
import { seatedChipBoxes } from "./chipSeating";
import type { RFAnyNode } from "./layout";
import { nodeIndexOf, nodeRectOf, type Rect } from "./nodeGeometry";

// Air between a member card and the paint edge. Below half NODE_NODE_SPACING
// (30), so a member's pad never reaches a neighbouring card.
export const LOOP_PAINT_PAD = 16;

// The caption band's height: the old loop box's caption strip.
export const LOOP_CAPTION_HEIGHT = 22;

// How far a bridge or the caption band keeps off a card it must not cover. A
// drawn card is a unit or two larger than its model rect (the border and the
// port drift), so flush is not clear.
const CARD_CLEARANCE = 4;

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

export function loopPaints(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): LoopPaint[] {
  const sets = loopMemberSets(nodes, edges);
  if (sets.length === 0) return [];

  const byId = nodeIndexOf(nodes);
  const cards = nodes
    .filter((n) => n.type === "recipe" || n.type === "product")
    .map((n) => ({ id: n.id, rect: nodeRectOf(n, byId) }));
  const chips = seatedChipBoxes(nodes, edges).map((c) => ({
    left: c.x - c.halfW,
    right: c.x + c.halfW,
    top: c.y - c.halfH,
    bottom: c.y + c.halfH,
  }));

  return sets.map((members) => {
    const memberSet = new Set(members);
    const foreign = cards
      .filter((c) => !memberSet.has(c.id))
      .map((c) => grow(c.rect, CARD_CLEARANCE));
    const padded = new Map(
      members.map((id) => [
        id,
        grow(nodeRectOf(byId.get(id)!, byId), LOOP_PAINT_PAD),
      ]),
    );
    const rects = [...padded.values()];

    // One bridge per joined pair, both directions of a 2-cycle counted once.
    const joined = new Set<string>();
    for (const e of edges) {
      if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
      const key = [e.source, e.target].sort().join("\0");
      if (joined.has(key)) continue;
      joined.add(key);
      const bridge = span(padded.get(e.source)!, padded.get(e.target)!);
      if (foreign.some((f) => overlaps(f, bridge))) continue;
      rects.push(bridge);
    }

    const caption = captionSeat(
      members.map((id) => padded.get(id)!),
      cards.map((c) => grow(c.rect, CARD_CLEARANCE)),
      chips,
    );
    if (caption !== undefined) rects.push(caption);

    const titleItems: ItemId[] = [];
    for (const id of members) {
      const node = byId.get(id);
      if (node?.type !== "recipe") continue;
      const item = node.data.recipe.out[0]?.item;
      if (item !== undefined && !titleItems.includes(item)) {
        titleItems.push(item);
      }
    }

    return { members, rects, titleItems, caption };
  });
}

// The first clear caption band: on top of a member's padded rect, the topmost
// member first (left to right on a tie), then under one, bottommost first. A
// band is clear when it covers no card, member or not, and no chip.
function captionSeat(
  memberRects: ReadonlyArray<Rect>,
  cards: ReadonlyArray<Rect>,
  chips: ReadonlyArray<Rect>,
): Rect | undefined {
  const clear = (band: Rect): boolean =>
    !cards.some((c) => overlaps(c, band)) &&
    !chips.some((c) => overlaps(c, band));
  const above = [...memberRects].sort(
    (a, b) => a.top - b.top || a.left - b.left,
  );
  for (const r of above) {
    const band = { ...r, top: r.top - LOOP_CAPTION_HEIGHT, bottom: r.top };
    if (clear(band)) return band;
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
    if (clear(band)) return band;
  }
  return undefined;
}
