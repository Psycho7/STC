// Edge-span census helper. Measures the horizontal reach of every rendered
// edge so a layout can be gated on a single number: how many edges still span
// more than two layers.
//
// The threshold is derived from the layout dimensions, so it tracks any spacing
// change instead of drifting from a hardcoded literal.

import {
  BETWEEN_LAYERS_SPACING,
  RECIPE_WIDTH,
  loopBoxDimensions,
} from "../../src/canvas/dimensions";

// A "long" edge reaches past two full layers (2 * (column gap + recipe width)).
export const SPAN_THRESHOLD = 2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH);

// Minimal structural shape of a laid-out React Flow node. Every node sits at
// the root, so its position is absolute. Recipe and loop unit nodes omit
// `width` (a recipe is a fixed RECIPE_WIDTH, a loop is sized from its
// interior); product nodes carry it directly.
export type SpanNode = {
  id: string;
  position?: { x?: number; y?: number };
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

// Absolute left-edge x for a node.
function absoluteLeft(node: SpanNode): number {
  return node.position?.x ?? 0;
}

// Recipe and loop unit nodes omit an explicit width: a recipe node is a fixed
// RECIPE_WIDTH, a loop node is sized from its interior by the same helper the
// layout uses. Product nodes carry width on the node. Mirrors
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
    const sourceRight = absoluteLeft(source) + nodeWidth(source);
    const targetLeft = absoluteLeft(target);
    spans.push(Math.max(0, targetLeft - sourceRight));
  }
  return spans;
}
