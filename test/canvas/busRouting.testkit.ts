// Shared fixtures for the busRouting test suite, split across
// busRouting.classify / busRouting.columns / busRouting.chips. Synthetic
// laid-out node / edge builders. No assertions here -- just constructors.

import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { Edge } from "@xyflow/react";

import type {
  RFContainerNode,
  RFProductNode,
  RFRecipeNode,
} from "../../src/canvas/layout";

export const emptyPorts = new Map<string, never>();

export const mkRecipe = (
  id: string,
  ins: string[],
  outs: string[],
): Recipe => ({
  id,
  name: id,
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: ins.map((item) => ({ item, qty: 1 })),
  out: outs.map((item) => ({ item, qty: 1 })),
  producers: [],
});

export const recipeNode = (
  id: string,
  x: number,
  y: number,
  recipe: Recipe,
): RFRecipeNode => ({
  id,
  type: "recipe",
  position: { x, y },
  data: {
    recipe,
    kind: "recipe",
    portTransportKinds: emptyPorts,
    multiplicity: { num: "1", denom: "1" },
  },
});

export const inputProductNode = (
  id: string,
  itemId: string,
  x: number,
  y: number,
  width = 148,
  height = 78,
): RFProductNode => ({
  id,
  type: "product",
  position: { x, y },
  width,
  height,
  data: {
    kind: "inputProduct",
    itemId,
    rate: { num: "1", denom: "1" },
    portTransportKinds: emptyPorts,
  },
});

export const mkEdge = (
  id: string,
  source: string,
  target: string,
  item: string,
): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item, rate: new Fraction(1) },
});

// A recipe node carrying an explicit ELK input order, so entry-column
// assertions can resolve a port's rank.
export const orderedRecipeNode = (
  id: string,
  x: number,
  y: number,
  ins: string[],
): RFRecipeNode => {
  const base = recipeNode(id, x, y, mkRecipe(id, ins, []));
  return { ...base, data: { ...base.data, inputOrder: ins } };
};

// A sized input-product node (item "w"), for column / chip fixtures that need a
// product box of a specific footprint.
export const productNode = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): RFProductNode => ({
  id,
  type: "product",
  position: { x, y },
  width,
  height,
  data: {
    kind: "inputProduct",
    itemId: "w",
    rate: { num: "1", denom: "1" },
    portTransportKinds: emptyPorts,
  },
});

// A container ("group") node: a root-level box with an absolute position and an
// explicit size, whose children carry `parentId` and a PARENT-RELATIVE position
// (what fromElkRenderLayout emits, no React Flow `extent`).
export const containerNode = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): RFContainerNode => ({
  id,
  type: "group",
  position: { x, y },
  width,
  height,
  style: { width, height },
  data: {
    containerKind: "blueprint-group",
    containerId: id,
    memberCount: 0,
  },
});

// Re-parent a laid-out node into a container: the caller hands in the
// node's PARENT-RELATIVE position, the same frame ELK's children come back in.
export const inContainer = <
  T extends RFRecipeNode | RFProductNode | RFContainerNode,
>(
  node: T,
  parentId: string,
): T => ({ ...node, parentId });
