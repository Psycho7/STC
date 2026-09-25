// Synthetic laid-out node / edge builders, colocated so the levelOccupancy
// suite beside the module never reaches into test/. The busRouting suites
// under test/canvas borrow the same builders through
// test/canvas/busRouting.testkit.ts. Constructors only -- no assertions.

import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { Edge } from "@xyflow/react";

import type { RFProductNode, RFRecipeNode } from "./layout";

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
