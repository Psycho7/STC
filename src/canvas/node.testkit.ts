// Shared typed fixtures for the RecipeNode / ProductNode suites, colocated
// under src/canvas and borrowed under test/canvas. Constructors only -- no
// assertions and no rendering, so each suite keeps its own wrappers.

import type { ComponentProps } from "react";
import type { Item, Machine } from "@aef/schema";
import type ProductNode from "./ProductNode";
import type RecipeNode from "./RecipeNode";
import type { ItemPackContextValue } from "./itemPackContext";

export type RecipeNodeProps = ComponentProps<typeof RecipeNode>;
export type RecipeNodeData = RecipeNodeProps["data"];
export type ProductNodeProps = ComponentProps<typeof ProductNode>;
export type ProductNodeData = ProductNodeProps["data"];

export function makeItem(id: string, raw = false): Item {
  return {
    id,
    name: id,
    category: "intermediate",
    icon: id,
    row: 0,
    raw,
    transportKind: "belt",
  };
}

export function makeMachine(
  id: string,
  opts: { icon?: string; speed?: number } = {},
): Machine {
  return {
    id,
    name: id,
    icon: opts.icon ?? id,
    speed: opts.speed ?? 1,
    powerType: "electric",
    powerKw: null,
    hideRate: false,
  };
}

export function makePackValue(
  opts: { items?: Item[]; machines?: Machine[] } = {},
): ItemPackContextValue {
  return {
    itemById: new Map((opts.items ?? []).map((i) => [i.id, i])),
    overrides: [],
    machineById: new Map((opts.machines ?? []).map((m) => [m.id, m])),
  };
}

// The React Flow node props both cards receive. Only `data` and `selected` are
// read by either component; the rest are the fields NodeProps requires.
export function makeRecipeNodeProps(
  data: RecipeNodeData,
  selected = false,
): RecipeNodeProps {
  return {
    id: "recipe-test",
    type: "recipe",
    data,
    selected,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    draggable: true,
    deletable: true,
    selectable: true,
  };
}

export function makeProductNodeProps(
  data: ProductNodeData,
  selected = false,
): ProductNodeProps {
  return {
    id: "product-test",
    type: "product",
    data,
    selected,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    draggable: true,
    deletable: true,
    selectable: true,
  };
}
