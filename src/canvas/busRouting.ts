// Phase-2 declutter pass: classify the remaining long edges into horizontal
// "bus" trunks and assign each trunk a lane below the graph.
//
// After phase 1a (per-consumer taps + un-pinned fanout slices) a handful of
// edges still reach across many layers: aggregate -> tap feeders, boundary
// supplies, and the xiranite recycle family. Rather than let ELK route those as
// long diagonal crossings, this pass tags them so a later render step (Task 6)
// can draw them through a shared lane band under the node graph, one lane slot
// per (item, source) trunk.
//
// Pure and deterministic: no React, no Date/random, no mutation of the inputs.
// Nodes are read only for geometry (absolute positions and sizes); they pass
// through untouched. Bus-member edges are retyped `type: "bus"` and get
// `{ laneY, trunkKey }` merged onto their existing `data`.
//
// This module hosts both whole-graph pre-render routing passes: routeBusEdges
// (bus classification + lane assignment) and assignBendColumns (bend-column
// stagger for forward item edges). Both read node geometry and merge routing
// fields onto edge `data`.

import type { Edge } from "@xyflow/react";

import {
  BETWEEN_LAYERS_SPACING,
  RECIPE_WIDTH,
  loopBoxDimensions,
} from "./dimensions";
import { CHAMFER, PORT_STUB } from "./edgePath";
import { measureRecipe } from "./recipeGeometry";
import type { RFAnyNode } from "./layout";

// A "long" edge reaches past two full layers. One layer is a column gap plus a
// recipe node, so the threshold is 2 * (gap + recipe width). Derived from the
// layout constants so it tracks any spacing change instead of drifting from a
// hardcoded 820. test/canvas/edgeSpans.ts re-exports this as SPAN_THRESHOLD.
export const BUS_SPAN_THRESHOLD = 2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH);

// Gap between the lowest node bottom and the first lane, then the vertical
// pitch between successive lanes.
export const LANE_TOP_OFFSET = 80;
export const LANE_SPACING = 28;

// Data fields the bus pass merges onto a member edge's existing `data`.
export type BusEdgeData = {
  laneY: number;
  trunkKey: string;
};

// Absolute left-edge x for a node. Container children store a parent-relative
// position, so resolve one level of `parentId` and add the parent's own x.
// Mirrors test/canvas/edgeSpans.ts.
function absoluteLeft(
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
function absoluteTop(
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
function nodeWidth(node: RFAnyNode): number {
  return node.width ?? RECIPE_WIDTH;
}

// Height of a node. Recipe and loop nodes carry no top-level `height` (React
// Flow measures them at render), so derive it from the same geometry helpers
// the layout uses; product and container nodes carry height directly.
function nodeHeight(node: RFAnyNode): number {
  switch (node.type) {
    case "recipe":
      return measureRecipe(node.data.recipe).height;
    case "loop":
      return loopBoxDimensions(node.data.interior).height;
    default:
      return node.height ?? 0;
  }
}

// Per-edge horizontal span: the empty gap between the source node's right edge
// and the target node's left edge, floored at 0. Backward edges collapse to 0.
// Mirrors test/canvas/edgeSpans.ts.
function edgeSpan(source: RFAnyNode, target: RFAnyNode, byId: ReadonlyMap<string, RFAnyNode>): number {
  const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
  const targetLeft = absoluteLeft(target, byId);
  return Math.max(0, targetLeft - sourceRight);
}

function isInputProduct(node: RFAnyNode | undefined): boolean {
  return node?.type === "product" && node.data.kind === "inputProduct";
}

function edgeItem(edge: Edge): string | undefined {
  const item = (edge.data as { item?: unknown } | undefined)?.item;
  return typeof item === "string" ? item : undefined;
}

// The lowest node bottom in absolute coordinates. The lane band starts below
// this so no lane ever crosses a node.
function maxAbsoluteNodeBottom(
  nodes: ReadonlyArray<RFAnyNode>,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  let bottom = 0;
  for (const node of nodes) {
    bottom = Math.max(bottom, absoluteTop(node, byId) + nodeHeight(node));
  }
  return bottom;
}

// routeBusEdges: classify long / boundary-feeder edges as bus members and give
// each (item, source) trunk one lane below the graph. Non-member edges pass
// through unchanged; member edges are retyped and get `{ laneY, trunkKey }`
// merged onto their data.
export function routeBusEdges(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const node of nodes) byId.set(node.id, node);

  // First pass: classify. An edge is a bus member iff its span exceeds the
  // threshold, or both endpoints are input-product nodes (the aggregate -> tap
  // feeder, which rides the bus regardless of span).
  const trunkKeyByEdgeIndex = new Map<number, string>();
  const trunks = new Map<string, { item: string; source: string }>();

  edges.forEach((edge, index) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    const item = edgeItem(edge);
    if (item === undefined) return;

    const bothInput = isInputProduct(source) && isInputProduct(target);
    const isBus = edgeSpan(source, target, byId) > BUS_SPAN_THRESHOLD || bothInput;
    if (!isBus) return;

    const trunkKey = item + "|" + edge.source;
    trunkKeyByEdgeIndex.set(index, trunkKey);
    if (!trunks.has(trunkKey)) trunks.set(trunkKey, { item, source: edge.source });
  });

  if (trunkKeyByEdgeIndex.size === 0) return edges.map((e) => e);

  // Assign one lane slot per trunk. Sort by item id, then source id, so the
  // slot order is deterministic across runs regardless of edge order.
  const bandTop = maxAbsoluteNodeBottom(nodes, byId) + LANE_TOP_OFFSET;
  const laneYByTrunk = new Map<string, number>();
  const sortedTrunks = [...trunks.entries()].sort(([, a], [, b]) => {
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return 0;
  });
  sortedTrunks.forEach(([trunkKey], slot) => {
    laneYByTrunk.set(trunkKey, bandTop + slot * LANE_SPACING);
  });

  // Second pass: emit. Members are retyped and get the lane fields merged;
  // everything else is returned as-is.
  return edges.map((edge, index) => {
    const trunkKey = trunkKeyByEdgeIndex.get(index);
    if (trunkKey === undefined) return edge;
    const laneY = laneYByTrunk.get(trunkKey)!;
    return {
      ...edge,
      type: "bus",
      data: { ...edge.data, laneY, trunkKey },
    };
  });
}

function hasItem(edge: Edge): boolean {
  const item = (edge.data as { item?: unknown } | undefined)?.item;
  return typeof item === "string";
}

// assignBendColumns: stagger the bend column of forward item edges that share a
// corridor so their vertical runs do not overlap into one blurred line. Pure and
// deterministic. Runs after routeBusEdges, so it only sees still-type:"item"
// edges (bus members were already retyped) and skips backward / zero-gap edges.
// Non-member edges pass through by reference; members get { bendX } merged onto
// their data (consumed by chamferStepPath).
export function assignBendColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const margin = PORT_STUB + CHAMFER;

  // Group candidate edges by their source-right x (quantized to the pixel).
  // Edges leaving the same layer share the same corridor band, so this buckets
  // them together regardless of which target layer they reach.
  type Cand = { id: string; sourceRight: number; targetLeft: number };
  const groups = new Map<number, Cand[]>();
  for (const edge of edges) {
    if (edge.type !== undefined && edge.type !== "item") continue;
    if (!hasItem(edge)) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
    const targetLeft = absoluteLeft(target, byId);
    if (targetLeft - sourceRight <= 0) continue; // backward / zero-gap edge
    const band = Math.round(sourceRight);
    const list = groups.get(band) ?? [];
    list.push({ id: edge.id, sourceRight, targetLeft });
    groups.set(band, list);
  }

  // Fan each band's members across the middle of its shared corridor. The
  // corridor spans from the band's rightmost source edge to its nearest target
  // so every member can host a bend inside it; margins keep the columns off the
  // port stubs on both sides. pitch = usable width / (n + 1) leaves symmetric
  // gaps at both ends.
  const bendById = new Map<string, number>();
  for (const list of groups.values()) {
    const groupLeft = Math.max(...list.map((c) => c.sourceRight));
    const groupRight = Math.min(...list.map((c) => c.targetLeft));
    const usable = groupRight - groupLeft - 2 * margin;
    if (usable <= 0) continue; // corridor too tight; keep the default midpoints
    const sorted = [...list].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const pitch = usable / (sorted.length + 1);
    sorted.forEach((c, i) => {
      bendById.set(c.id, groupLeft + margin + pitch * (i + 1));
    });
  }

  return edges.map((edge) => {
    const bendX = bendById.get(edge.id);
    if (bendX === undefined) return edge;
    return { ...edge, data: { ...edge.data, bendX } };
  });
}
