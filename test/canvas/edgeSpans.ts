// Edge-span census helper. Measures the horizontal reach of every rendered
// edge so the declutter phases can be gated on a single number: how many edges
// still span more than two layers. This is the acceptance instrument for the
// edge-declutter work; the repro-plan census test records the phase-1a baseline
// and Task 7 tightens the assertion to zero.
//
// The long-edge threshold now lives in the bus-routing module (Task 5); this
// file re-exports it under the census's own name. The derivation from layout
// dimensions stays there, so it still tracks any spacing change.

import { RECIPE_WIDTH, loopBoxDimensions } from "../../src/canvas/dimensions";

// A "long" edge reaches past two full layers (2 * (column gap + recipe width)).
export { BUS_SPAN_THRESHOLD as SPAN_THRESHOLD } from "../../src/canvas/busRouting";

// Minimal structural shape of a laid-out React Flow node. Container children
// carry a parent-relative position plus a `parentId`; top-level nodes have
// neither. Recipe and loop unit nodes omit `width` (a recipe is a fixed
// RECIPE_WIDTH, a loop is sized from its interior); product and container
// nodes carry it directly.
export type SpanNode = {
  id: string;
  position?: { x?: number; y?: number };
  parentId?: string;
  width?: number;
  type?: string;
  data?: Record<string, unknown> & {
    interior?: { width: number; height: number };
  };
};

export type SpanEdge = {
  source: string;
  target: string;
};

// Absolute left-edge x for a node. Container children store a parent-relative
// position, so resolve one level of `parentId` and add the parent's own x.
function absoluteLeft(
  node: SpanNode,
  byId: ReadonlyMap<string, SpanNode>,
): number {
  const localX = node.position?.x ?? 0;
  if (node.parentId === undefined) return localX;
  const parent = byId.get(node.parentId);
  return localX + (parent?.position?.x ?? 0);
}

// Recipe and loop unit nodes omit an explicit width: a recipe node is a fixed
// RECIPE_WIDTH, a loop node is sized from its interior by the same helper the
// layout uses. Product and container nodes carry width on the node. Mirrors
// src/canvas/nodeGeometry.ts.
function nodeWidth(node: SpanNode): number {
  const interior = node.type === "loop" ? node.data?.interior : undefined;
  if (interior) return loopBoxDimensions(interior).width;
  return node.width ?? RECIPE_WIDTH;
}

// Per-edge horizontal span: the empty gap between the source node's right edge
// and the target node's left edge, in absolute canvas coordinates, floored at 0.
// Backward (right-to-left) edges collapse to 0; only forward reach is counted.
// Edges whose endpoints are missing from `nodes` are skipped.
export function computeEdgeSpans(
  nodes: ReadonlyArray<SpanNode>,
  edges: ReadonlyArray<SpanEdge>,
): number[] {
  const byId = new Map<string, SpanNode>();
  for (const node of nodes) byId.set(node.id, node);

  const spans: number[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
    const targetLeft = absoluteLeft(target, byId);
    spans.push(Math.max(0, targetLeft - sourceRight));
  }
  return spans;
}
