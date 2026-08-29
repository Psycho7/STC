// Model-frame geometry readers for laid-out React Flow nodes. Five pure
// accessors shared by the whole-graph routing passes, the chip-seating pass
// and their tests.
//
// Contract:
//   1. MODEL frame, not DRAWN frame. Every value is the coordinate the layout
//      positions by, not the coordinate React Flow paints. The drawn frame is
//      model + PORT_DRIFT / CARD_GROWTH and stays owned by the chip-seating
//      pass. Comparing one of these values against a DRAWN rect crosses
//      frames and is wrong by 1-2 units, exactly at the thresholds the
//      ratcheted occlusion and crossing counts live on.
//   2. One level of nesting only. absoluteLeft / absoluteTop resolve a single
//      parentId hop; a grandchild would be wrong. A parent missing from `byId`
//      is treated as the origin (0), never an error.
//   3. Fallbacks. nodeWidth falls back to RECIPE_WIDTH when node.width is
//      absent (recipe and loop nodes carry no top-level width). nodeHeight
//      derives recipe height from measureRecipe and loop height from
//      loopBoxDimensions, and returns node.height ?? 0 otherwise.
//   4. portOffsetY returns a NODE-LOCAL y (add absoluteTop for absolute). It
//      resolves the row via orderByItem over the node's inputOrder /
//      outputOrder and returns nodeHeight(node) / 2 when the port cannot be
//      resolved (non-recipe node, absent item, missing order, item not in
//      that side's rows, or no handle y at that index). On a recipe
//      node that centre fallback is exactly distinguishable from any real row:
//      rows sit at 97 + 22i and the centre at 59 + 11 * maxRows, which have no
//      common solution. The chip-seating pass's driftedPortY helper depends
//      on that discriminator, so the fallback value must not change and must
//      not be pre-drifted.
//   5. Total and pure. No throws, no React, no mutation of inputs,
//      deterministic for a given node map.

import { RECIPE_WIDTH, loopBoxDimensions } from "./dimensions";
import { measureRecipe } from "./recipeGeometry";
import { orderByItem } from "./orderByItem";
import type { RFAnyNode } from "./layout";

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

// Only recipe / loop unit nodes omit an explicit width. Every recipe node is a
// fixed RECIPE_WIDTH; product and container nodes carry width on the node.
// Mirrors test/canvas/edgeSpans.ts.
export function nodeWidth(node: RFAnyNode): number {
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

// Node-local y of the port carrying `item` on the given side, or the node's
// vertical center when the port cannot be resolved (product / loop node, or a
// missing item / order). Mirrors RecipeNode's handle placement: handles sit in
// the ELK-resolved row order, so the row index is the item's position in the
// ordered rows.
export function portOffsetY(
  node: RFAnyNode,
  item: string | undefined,
  side: "in" | "out",
): number {
  if (node.type === "recipe" && item !== undefined) {
    const recipe = node.data.recipe;
    const rows = side === "in" ? recipe.in : recipe.out;
    const order = side === "in" ? node.data.inputOrder : node.data.outputOrder;
    const idx = orderByItem(rows, order).findIndex((r) => r.item === item);
    if (idx >= 0) {
      const geom = measureRecipe(recipe);
      const ys = side === "in" ? geom.inHandleYs : geom.outHandleYs;
      const y = ys[idx];
      if (y !== undefined) return y;
    }
  }
  return nodeHeight(node) / 2;
}
