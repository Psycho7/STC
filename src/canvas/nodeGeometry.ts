// Geometry readers for laid-out React Flow nodes. Pure accessors shared by the
// whole-graph routing passes, the chip-seating pass and their tests.
//
// Contract:
//   1. This module owns BOTH frames and the single conversion between them.
//      The MODEL frame is the coordinate the layout positions by; the DRAWN
//      frame is the coordinate React Flow paints, model plus PORT_DRIFT (the
//      box-side counterpart, CARD_GROWTH, stays with the card rects in
//      chipSeating.ts). Every other module reads one frame or the other and
//      never converts. Every drawn-frame export here carries `drawn` in its
//      name, because comparing a model value against a DRAWN rect is wrong by
//      1-2 units, exactly at the thresholds the ratcheted occlusion and
//      crossing counts live on.
//   2. One level of nesting only. absoluteLeft / absoluteTop resolve a single
//      parentId hop; a grandchild would be wrong. A parent missing from `byId`
//      is treated as the origin (0), never an error.
//   3. Fallbacks. Recipe and loop nodes carry no top-level width or height.
//      nodeWidth derives loop width from loopBoxDimensions and otherwise
//      falls back to RECIPE_WIDTH when node.width is absent; nodeHeight
//      derives recipe height from measureRecipe and loop height from
//      loopBoxDimensions, and returns node.height ?? 0 otherwise.
//   4. portOffsetY returns a NODE-LOCAL y (add absoluteTop for absolute). It
//      resolves the row via orderByItem over the node's inputOrder (input
//      side only; output rows read in the recipe's declared order, ruling R4,
//      so no output order exists; catalyst rows read in the recipe's declared
//      order too, below every input row) and returns nodeHeight(node) / 2 when
//      the port cannot be resolved (non-recipe node, absent item, missing
//      order, item not in that side's rows, or no handle y at that index). The
//      side is the caller's, never guessed from the item: one card can carry
//      the same item on an input row and a catalyst row. On a recipe node that
//      centre fallback is exactly distinguishable from any real row: rows sit
//      at 73 + 22i and the centre at 34 + 11 * maxRows, which have no common
//      solution. A card with catalysts pushes both by the 11px block gap --
//      its rows land on integers and its centre on a half, so they still
//      cannot meet. driftedPortY below depends on that discriminator, so the
//      fallback value must not change and must not be pre-drifted.
//   5. Total and pure. No throws, no React, no mutation of inputs,
//      deterministic for a given node map.

import type { Edge } from "@xyflow/react";
import Fraction from "fraction.js";

import { RECIPE_WIDTH, loopBoxDimensions } from "./dimensions";
import { measureRecipe } from "./recipeGeometry";
import { orderByItem } from "./orderByItem";
import type { DrawnPorts } from "./edgePath";
import type { RFAnyNode } from "./layout";

// Read a Fraction rate off an edge's data, or undefined when it is absent or not
// a Fraction (older fixtures may omit it). Exported because the chip-seating
// pass reads the same field to predict a chip's drawn text, and two readers of
// one loosely typed field would be free to disagree about what counts as a rate.
export function edgeRate(edge: Edge): Fraction | undefined {
  // Deliberately weaker than ItemEdgeData: older fixtures carry a non-Fraction
  // rate, so the guard below has to see `unknown` rather than a claimed type.
  const rate = (edge.data as { rate?: unknown } | undefined)?.rate;
  return rate instanceof Fraction ? rate : undefined;
}

// Key of one FLOW: the (item, source unit) pair leaving a single out-port. A
// recipe out-port carries exactly one item, so item plus source id names the
// port, and every edge sharing the key draws as one physical line. Trunks (routeTrunkEdges) key on it -- that is the `trunkKey` they stamp --
// and chip seating reuses it to decide which lines a chip may legitimately sit
// on. Built here so the callers cannot drift on the separator or on how a
// missing item is spelled.
export function flowKeyOf(item: string | undefined, source: string): string {
  return (item ?? "?") + "|" + source;
}

// The id -> node index every geometry accessor here takes. Last id wins on a
// duplicate, matching the loops this replaces.
export function nodeIndexOf(
  nodes: ReadonlyArray<RFAnyNode>,
): Map<string, RFAnyNode> {
  return new Map<string, RFAnyNode>(nodes.map((n) => [n.id, n]));
}

// Absolute left-edge x for a node. Container children store a parent-relative
// position, so resolve one level of `parentId` and add the parent's own x.
// Mirrors test/canvas/edgeSpans.ts.
export function absoluteLeft(
  node: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const localX = node.position?.x ?? 0;
  if (node.parentId === undefined) return localX;
  const parent = byId.get(node.parentId);
  return localX + (parent?.position?.x ?? 0);
}

// Absolute top-edge y for a node, resolving one level of `parentId` (same rule
// as absoluteLeft, on the vertical axis).
export function absoluteTop(
  node: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const localY = node.position?.y ?? 0;
  if (node.parentId === undefined) return localY;
  const parent = byId.get(node.parentId);
  return localY + (parent?.position?.y ?? 0);
}

// Width of a node. Recipe and loop nodes omit an explicit width: a recipe node
// is a fixed RECIPE_WIDTH, a loop node is sized from its interior by the same
// helper the layout and LoopNode use. Product and container nodes carry width
// on the node. Mirrors test/canvas/edgeSpans.ts.
export function nodeWidth(node: RFAnyNode): number {
  if (node.type === "loop") return loopBoxDimensions(node.data.interior).width;
  return node.width ?? RECIPE_WIDTH;
}

// Height of a node. Recipe and loop nodes carry no top-level `height` (React
// Flow measures them at render), so derive it from the same geometry helpers
// the layout uses; product and container nodes carry height directly.
export function nodeHeight(node: RFAnyNode): number {
  switch (node.type) {
    case "recipe":
      return measureRecipe(node.data.recipe).height;
    case "loop":
      return loopBoxDimensions(node.data.interior).height;
    default:
      return node.height ?? 0;
  }
}

// Which column of rows a port sits in. "cat" is the catalyst rows at the foot
// of the input column: they take edges like input rows but are looked up in
// recipe.catalyst, so the same item can resolve to a different row per side.
export type PortSide = "in" | "out" | "cat";

// Node-local y of the port carrying `item` on the given side, or the node's
// vertical center when the port cannot be resolved (product / loop node, or a
// missing item / order). Mirrors RecipeNode's handle placement: input handles
// sit in the ELK-resolved row order (inputOrder), output handles in the
// recipe's declared row order (ruling R4), so the row index is the item's
// position in the ordered rows.
export function portOffsetY(
  node: RFAnyNode,
  item: string | undefined,
  side: PortSide,
): number {
  if (node.type === "recipe" && item !== undefined) {
    const recipe = node.data.recipe;
    const rows =
      side === "in"
        ? recipe.in
        : side === "out"
          ? recipe.out
          : (recipe.catalyst ?? []);
    const order = side === "in" ? node.data.inputOrder : undefined;
    const idx = orderByItem(rows, order).findIndex((r) => r.item === item);
    if (idx >= 0) {
      const geom = measureRecipe(recipe);
      const ys =
        side === "in"
          ? geom.inHandleYs
          : side === "out"
            ? geom.outHandleYs
            : geom.catHandleYs;
      const y = ys[idx];
      if (y !== undefined) return y;
    }
  }
  return nodeHeight(node) / 2;
}

// Did portOffsetY resolve `y` to an actual row on this node, rather than the
// centre fallback? Exact on recipe nodes by the discriminator in item 4 of the
// header contract (rows at 73 + 22i can never equal the centre 34 + 11 *
// maxRows); the canonical statement of that proof lives there, and callers that
// need "resolved vs fallback" must go through this predicate instead of
// restating the numbers.
export function portRowResolved(node: RFAnyNode, y: number): boolean {
  return !(node.type === "recipe" && y === nodeHeight(node) / 2);
}

// The item one edge carries, when it names one. Deliberately weaker than
// ItemEdgeData: older fixtures carry a non-string item, so the guard has to see
// `unknown` rather than a claimed type. Lives here because resolving a port row
// starts by asking which item the edge feeds.
export function edgeItem(edge: Edge): string | undefined {
  const item = (edge.data as { item?: unknown } | undefined)?.item;
  return typeof item === "string" ? item : undefined;
}

// Which row column an edge's TARGET end lands in. The layout stamps
// `toPortKind` on the edge data beside the item; only a catalyst edge carries
// one, and it is the only way to tell a catalyst row's edge from the input-row
// edge of the same item on the same card.
export function edgeTargetSide(edge: Edge): PortSide {
  const kind = (edge.data as { toPortKind?: unknown } | undefined)?.toPortKind;
  return kind === "catalyst" ? "cat" : "in";
}

// Drawn-vs-model port drift, in graph units, per node kind. React Flow anchors
// an edge at the OUTER edge of the handle's 8x8 box (getHandlePosition), not at
// the model port busRouting computes, so the drawn path starts and ends a few
// units off the model coordinate. Derivation, from the DOM boxes:
//   recipe: the card is content-box RECIPE_WIDTH (240) with a 1px border per
//     side, so its border box is 242 wide while node.position is still the
//     model left L. Handles hang off the .rn-row edges INSIDE that border
//     (row spans L+1 .. L+241), each box centred on its row edge, so the outer
//     edges land at L-3 and L+245: targetDx -3, and sourceDx +5 against the
//     model port at L+240. The same 1px top border pushes each row's mid-line
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
// This table stays unexported on purpose: every copy below is a negative
// control, rebuilding the drawn port from the model side so a suite can catch
// this module quietly agreeing with itself. Two copies live in two suites:
//   test/canvas/portDrift.test.ts        the whole table, the designated unit
//                                        control -- it runs drawnPortsOf beside
//                                        its copy, so a stale one fails loudly
//   test/e2e/geometry.ts                 the whole table, the designated e2e
//                                        control -- it measures the rendered
//                                        DOM and never calls this module, so a
//                                        stale copy there stays silent
// Every other unit suite calls drawnPortsOf rather than copying the numbers.
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
// approximation of an unknown row, not a row shifted by the card border.
// portRowResolved tells the two apart exactly (its row-vs-centre proof lives
// with it in item 4 of the header contract).
function driftedPortY(
  node: RFAnyNode,
  item: string | undefined,
  side: PortSide,
): number {
  const y = portOffsetY(node, item, side);
  return portRowResolved(node, y) ? y + portDrift(node).dy : y;
}

// The four port coordinates an edge's path builders take, resolved the same way
// every routing pass resolves them (source Right port, target Left port, at the
// item's row), then shifted onto the drawn handle coordinates by PORT_DRIFT.
// Null when either endpoint is missing from the node map. Shared by the seating
// pass and contentBounds so both reconstruct the DRAWN geometry.
//
// This is the DRAWN frame. Its sibling edgePortsModel in busRouting.ts answers
// the same four names in the MODEL frame, the coordinate the routing passes
// place by. The two are never merged: the difference is PORT_DRIFT, 1-2 units,
// exactly the size the ratcheted occlusion and crossing counts turn on.
export function drawnPortsOf(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): DrawnPorts | null {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return null;
  const item = edgeItem(edge);
  const targetSide = edgeTargetSide(edge);
  return {
    sourceX:
      absoluteLeft(source, byId) +
      nodeWidth(source) +
      portDrift(source).sourceDx,
    sourceY: absoluteTop(source, byId) + driftedPortY(source, item, "out"),
    targetX: absoluteLeft(target, byId) + portDrift(target).targetDx,
    targetY: absoluteTop(target, byId) + driftedPortY(target, item, targetSide),
  };
}
