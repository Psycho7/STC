// Shared fixtures for the busRouting test suite, split across
// busRouting.classify / busRouting.columns / busRouting.chips. Synthetic
// laid-out node / edge builders plus the two band-extent metrics the lane
// assertions mirror from the module. No assertions here -- just constructors.

import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { Edge } from "@xyflow/react";

import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type {
  RFAnyNode,
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

// Bottom of every node in a fixture, mirroring the module's own metric so the
// "lane below every node" assertions are grounded in the same geometry.
export const maxBottom = (nodes: RFAnyNode[]): number =>
  Math.max(
    ...nodes.map((n) => {
      const h =
        n.type === "recipe"
          ? measureRecipe(n.data.recipe).height
          : (n.height ?? 0);
      return n.position.y + h;
    }),
  );

// Top of every node in a fixture, mirroring the module's minAbsoluteNodeTop so
// the "lane above every node" assertions share the top band's own geometry.
export const minTop = (nodes: RFAnyNode[]): number =>
  Math.min(...nodes.map((n) => n.position.y));

// A recipe node carrying an explicit ELK input order, so entry-column and rise
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

// Read a bus member's stamped chip nudges (0 when absent).
export function busDropDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { busDropDy?: number }
    | undefined;
  return d?.busDropDy ?? 0;
}

export function busChipDyOf(edges: Edge[], id: string): number {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipDy?: number }
    | undefined;
  return d?.busChipDy ?? 0;
}
