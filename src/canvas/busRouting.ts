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
import Fraction from "fraction.js";

import {
  BETWEEN_LAYERS_SPACING,
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  ENTRY_CHIP_BOX_WIDTH,
  MAX_CHIP_SCALE,
  RECIPE_WIDTH,
  loopBoxDimensions,
} from "./dimensions";
import {
  CHAMFER,
  PORT_STUB,
  chamferBusPath,
  chamferStepPath,
  clearRailY,
  routingHintsFromData,
  type ObstacleRect,
} from "./edgePath";
import { measureRecipe } from "./recipeGeometry";
import { orderByItem } from "./orderByItem";
import type { RFAnyNode } from "./layout";

// A "long" edge reaches past two full layers. One layer is a column gap plus a
// recipe node, so the threshold is 2 * (gap + recipe width). Derived from the
// layout constants so it tracks any spacing change instead of drifting from a
// hardcoded 820. test/canvas/edgeSpans.ts re-exports this as SPAN_THRESHOLD.
export const BUS_SPAN_THRESHOLD = 2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH);

// Gap between the lowest node bottom and the first lane, then the vertical
// pitch between successive lanes. LANE_SPACING is derived from the shared chip
// pitch (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) so a rise chip sitting on one lane
// clears the rise chip on the adjacent lane at every zoom: the two boxes are
// exactly a max-scale box height apart and abut instead of overlapping. The
// earlier fixed 28 sat below that pitch, so adjacent-lane chips interpenetrated.
export const LANE_TOP_OFFSET = 80;
export const LANE_SPACING = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;

// Data fields the bus pass merges onto a member edge's existing `data`.
export type BusEdgeData = {
  laneY: number;
  trunkKey: string;
  // Trunk aggregate stamped by routeBusEdges. busTotalRate is the summed rate of
  // every member of this trunk and busMemberCount how many members there are;
  // busChipOwner marks the single member elected to draw the trunk's one drop
  // chip (showing the total, plus the count when > 1). The other members
  // suppress their drop chip, so the shared lane shows its true total once
  // instead of one member's share stacked N times.
  busTotalRate?: Fraction;
  busMemberCount?: number;
  busChipOwner?: boolean;
  // Lane x for this member's rise chip, assigned by routeBusEdges so a trunk's
  // rise chips spread evenly along the lane instead of stacking near their rise
  // vertices. BusEdge anchors the rise chip at (busChipX, laneY). Absent on
  // manually built edges, where BusEdge falls back to the geometric rise column.
  busChipX?: number;
  // Downward chip nudges assigned by deconflictChipAnchors when a trunk's chips
  // crowd on their lane: busDropDy shifts the owner's aggregate drop chip and
  // busChipDy shifts this member's rise chip, each off the lane in CHIP_PITCH_Y
  // steps so they no longer overlap. BusEdge adds them to the chips' laneY.
  // Optional and default to 0.
  busDropDy?: number;
  busChipDy?: number;
};

// Read a Fraction rate off an edge's data, or undefined when it is absent or not
// a Fraction (older fixtures may omit it).
function edgeRate(edge: Edge): Fraction | undefined {
  const rate = (edge.data as { rate?: unknown } | undefined)?.rate;
  return rate instanceof Fraction ? rate : undefined;
}

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

  // Aggregate each trunk: sum member rates, count members, and elect the member
  // that owns the trunk's single drop chip (the lexicographically smallest edge
  // id, so the choice is deterministic across runs regardless of edge order).
  const trunkTotal = new Map<string, Fraction>();
  const trunkCount = new Map<string, number>();
  const trunkOwner = new Map<string, string>();
  trunkKeyByEdgeIndex.forEach((trunkKey, index) => {
    const edge = edges[index]!;
    const rate = edgeRate(edge) ?? new Fraction(0);
    trunkTotal.set(
      trunkKey,
      (trunkTotal.get(trunkKey) ?? new Fraction(0)).add(rate),
    );
    trunkCount.set(trunkKey, (trunkCount.get(trunkKey) ?? 0) + 1);
    const owner = trunkOwner.get(trunkKey);
    if (owner === undefined || edge.id < owner) {
      trunkOwner.set(trunkKey, edge.id);
    }
  });

  // Distribute each trunk's rise chips evenly along its lane. Members feeding the
  // same layer would otherwise anchor near-coincident at their rise vertices, so
  // give every member a chip x-slot spaced across the lane extent from the drop
  // column (dropX, where the owner's aggregate drop chip sits) to the rightmost
  // member's rise column. Members are ordered by edge id so the assignment is
  // deterministic regardless of edge order. Slots sit at fraction (i+1)/(n+1) of
  // the extent, which keeps every slot -- and the drop-side gap -- one even step
  // apart and never places a rise chip on the aggregate drop chip at dropX.
  // When the extent is too short to spread them (members feeding one nearby
  // layer, so maxRiseX <= dropX) the step collapses to 0 and every rise chip
  // stacks at the drop column; deconflictChipAnchors then cascades the pile
  // downward off the lane. Horizontal spacing here is only a hint -- the on-screen
  // no-overlap guarantee is enforced by that vertical cascade, not by this x.
  const busChipXByIndex = new Map<number, number>();
  const membersByTrunk = new Map<
    string,
    Array<{ index: number; id: string; riseX: number }>
  >();
  trunkKeyByEdgeIndex.forEach((trunkKey, index) => {
    const edge = edges[index]!;
    const target = byId.get(edge.target)!;
    // Geometric rise column, mirroring chamferBusPath's wide-forward default
    // (one stub + chamfer inside the target's Left port). Entry-column staggering
    // runs later and shifts it slightly left, but that hint is not yet available
    // and only nudges the extent bound, so the default column is used here.
    const riseX = absoluteLeft(target, byId) - PORT_STUB - CHAMFER;
    const list = membersByTrunk.get(trunkKey) ?? [];
    list.push({ index, id: edge.id, riseX });
    membersByTrunk.set(trunkKey, list);
  });
  for (const [trunkKey, members] of membersByTrunk) {
    const sourceNode = byId.get(trunks.get(trunkKey)!.source)!;
    const dropX =
      absoluteLeft(sourceNode, byId) +
      nodeWidth(sourceNode) +
      PORT_STUB +
      CHAMFER;
    const maxRiseX = Math.max(...members.map((m) => m.riseX));
    // Even fractions space slots (and the drop-side gap) at extent/(n+1), all
    // inside [dropX, maxRiseX]. A non-positive extent (members feeding one nearby
    // layer) collapses the step to 0 so every slot lands on dropX; the vertical
    // cascade in deconflictChipAnchors then spreads the pile downward.
    const extent = Math.max(0, maxRiseX - dropX);
    members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = members.length;
    const step = extent / (n + 1);
    members.forEach((m, i) => {
      busChipXByIndex.set(m.index, dropX + step * (i + 1));
    });
  }

  // Second pass: emit. Members are retyped and get the lane + trunk-aggregate
  // fields merged; everything else is returned as-is.
  return edges.map((edge, index) => {
    const trunkKey = trunkKeyByEdgeIndex.get(index);
    if (trunkKey === undefined) return edge;
    const laneY = laneYByTrunk.get(trunkKey)!;
    return {
      ...edge,
      type: "bus",
      data: {
        ...edge.data,
        laneY,
        trunkKey,
        busTotalRate: trunkTotal.get(trunkKey)!,
        busMemberCount: trunkCount.get(trunkKey)!,
        busChipOwner: edge.id === trunkOwner.get(trunkKey),
        busChipX: busChipXByIndex.get(index)!,
      },
    };
  });
}

// -- Entry gutter -------------------------------------------------------------
//
// Every node reserves a vertical band [nodeLeft - G, nodeLeft] in front of its
// Left (input) ports, its "entry gutter". The band's job is to own the corridor
// immediately in front of a consumer so foreign vertical runs (another node's
// bend column, backward rail, or bus rise) stay out of it; only an edge's own
// final leg into this node may enter the band (its horizontal final leg
// unavoidably crosses the x-band, which is fine -- verticals belonging to OTHER
// nodes' edges are what we eliminate).
//
// Width. The tightest thing the band must hold is one vertical run sitting a
// PORT_STUB inside the port plus a CHAMFER bevel, so the base band is
// PORT_STUB + CHAMFER -- the same value assignBendColumns already used as its
// corridor margin. A node that hosts several staggered entry columns (multiple
// backward rails or bus rises into one node) widens the band by one slot pitch
// per extra column so every column fits with clear air between the bevels. The
// pitch is 2*CHAMFER so adjacent columns' CHAMFER-wide bevels never touch.
// Width scales with the node's own gutter in-degree rather than a global max, so
// a node with a single entry keeps the minimal band (and its geometry stays
// byte-identical to the pre-gutter default).
export const ENTRY_GUTTER_MIN = PORT_STUB + CHAMFER; // 32
export const ENTRY_SLOT_PITCH = 2 * CHAMFER; // 16

// Band width for a node hosting `columnCount` staggered entry columns. Zero or
// one column -> the minimal band; each extra column adds one pitch.
export function gutterWidth(columnCount: number): number {
  return ENTRY_GUTTER_MIN + Math.max(0, columnCount - 1) * ENTRY_SLOT_PITCH;
}

// An entry-gutter rectangle in absolute coordinates: the band [left, right] in
// x and the node's vertical extent padded by CHAMFER in y. Foreign vertical
// runs must not fall strictly inside this rect.
export type GutterRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

// Node-gap between a (source, target) pair, floored the same way as edgeSpan but
// signed: <= 0 means the target sits at or left of the source (a backward edge
// under ELK's cycle reversal). chamferBusPath's own gap (tx - sx, port to port)
// equals this because sources are Right-handles and targets Left-handles.
function nodeGap(
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
  return absoluteLeft(target, byId) - sourceRight;
}

// Does an edge occupy a vertical column inside its target's entry gutter? A
// backward forward-item edge routes a left rail one stub before the port; a bus
// member rises up the gutter -- except the narrow-forward bus hairpin, which
// collapses onto the corridor midpoint far from the gutter (chamferBusPath's
// gap < budget branch) and so claims no column here. Returns true for the edges
// that both consume a gutter slot and count toward the band's width.
function occupiesGutterColumn(
  edge: Edge,
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): boolean {
  const gap = nodeGap(source, target, byId);
  if (edge.type === "bus") {
    const budget = 2 * (PORT_STUB + CHAMFER);
    return gap <= 0 || gap >= budget; // narrow-forward hairpin claims no column
  }
  if (edge.type === "item") return gap <= 0; // backward rail
  return false;
}

// Resolved input-port index of an edge at its target, or -1 when unknown. Only
// recipe/loop nodes carry the ELK-resolved `inputOrder`; product targets have a
// single port. Used to order a target's staggered entry columns top to bottom.
function inputPortIndex(target: RFAnyNode, item: string | undefined): number {
  if (item === undefined) return -1;
  if (target.type !== "recipe" && target.type !== "loop") return -1;
  const order = target.data.inputOrder;
  return order ? order.indexOf(item) : -1;
}

// Count of gutter columns each target node hosts, keyed by node id. Both passes
// derive it from the same rule (occupiesGutterColumn) so their views of every
// node's band width agree without threading a shared structure between them.
function gutterColumnCounts(
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (!occupiesGutterColumn(edge, source, target, byId)) continue;
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

// entryGutterRects: the absolute gutter rectangle of every node, exported for
// the structural tests so they check against the same band geometry this
// module computes.
export function entryGutterRects(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Map<string, GutterRect> {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);
  const counts = gutterColumnCounts(edges, byId);
  const rects = new Map<string, GutterRect>();
  for (const node of nodes) {
    const left = absoluteLeft(node, byId);
    const top = absoluteTop(node, byId);
    const g = gutterWidth(counts.get(node.id) ?? 0);
    rects.set(node.id, {
      left: left - g,
      right: left,
      top: top - CHAMFER,
      bottom: top + nodeHeight(node) + CHAMFER,
    });
  }
  return rects;
}

// assignEntryColumns: give every gutter-occupying edge (backward item rail or
// bus rise) a per-target staggered column x, merged as { entryX } onto its data
// and consumed by chamferStepPath / chamferBusPath. Columns of one target are
// ordered by resolved input-port index so the entering runs form a monotonic
// fan that does not self-cross inside the band: the topmost port takes the
// leftmost column and the bottom port the rightmost (one stub before the port,
// which is the pre-gutter default, so a single-entry node is unchanged).
//
// Pure and deterministic: the column of an edge depends only on its target and
// port rank, never on edge order. Runs after routeBusEdges (so bus members are
// already retyped) and leaves every non-gutter edge untouched by reference.
export function assignEntryColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Bucket gutter edges by target, remembering each one's original index so the
  // emitted array can be rebuilt in place.
  type Slot = {
    index: number;
    edge: Edge;
    portIndex: number;
    item: string | undefined;
  };
  const byTarget = new Map<string, Slot[]>();
  edges.forEach((edge, index) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    if (!occupiesGutterColumn(edge, source, target, byId)) return;
    const item = edgeItem(edge);
    const list = byTarget.get(edge.target) ?? [];
    list.push({ index, edge, portIndex: inputPortIndex(target, item), item });
    byTarget.set(edge.target, list);
  });

  // Assign one column per gutter edge. Sort each target's edges by port index
  // (ports with a known index first, ascending), then item id, then edge id, so
  // the mapping from port order to column x is deterministic. rank 0 (topmost
  // port) takes the leftmost column; rank k-1 sits at the pre-gutter default.
  const entryXByIndex = new Map<number, number>();
  for (const [targetId, list] of byTarget) {
    const target = byId.get(targetId)!;
    const left = absoluteLeft(target, byId);
    const k = list.length;
    const sorted = [...list].sort((a, b) => {
      const ai = a.portIndex < 0 ? Infinity : a.portIndex;
      const bi = b.portIndex < 0 ? Infinity : b.portIndex;
      if (ai !== bi) return ai - bi;
      if (a.item !== b.item) return (a.item ?? "") < (b.item ?? "") ? -1 : 1;
      return a.edge.id < b.edge.id ? -1 : 1;
    });
    sorted.forEach((slot, rank) => {
      const fromRight = k - 1 - rank; // topmost port -> largest offset (leftmost)
      entryXByIndex.set(
        slot.index,
        left - PORT_STUB - fromRight * ENTRY_SLOT_PITCH,
      );
    });
  }

  if (entryXByIndex.size === 0) return edges.map((e) => e);
  return edges.map((edge, index) => {
    const entryX = entryXByIndex.get(index);
    if (entryX === undefined) return edge;
    return { ...edge, data: { ...edge.data, entryX } };
  });
}

// assignBendColumns: stagger the bend column of forward item edges that share a
// corridor so their vertical runs do not overlap into one blurred line. Pure and
// deterministic. Runs after routeBusEdges, so it only sees still-type:"item"
// edges (bus members were already retyped) and skips backward / zero-gap edges.
// Non-member edges pass through by reference; members get { bendX } merged onto
// their data (consumed by chamferStepPath).
//
// Banding: candidates are bucketed by their source LAYER, keyed on the source's
// absolute left edge (quantized to the pixel). Same-layer nodes share that left
// edge regardless of node width, so mixed-width sources (a ~148px product and a
// 300px recipe in one column) land in one band and fan against each other rather
// than splitting into independent bands that can pick coincident columns.
//
// Corridor: a band fans across the first inter-layer gap right of its source
// layer, not the whole source->target span. groupLeft is the band's rightmost
// source edge; groupRight is the nearest node left-edge strictly right of
// groupLeft (the next node column, node-free by construction). This keeps every
// vertical run clear of intermediate node boxes, including the box a
// layer-skipping edge would otherwise cross. When no node lies right of groupLeft
// the corridor falls back to the nearest target left edge.
//
// Gutter clamp (against the entry-gutter bands above): the right corridor bound
// is not a fixed margin but
// the next column's actual entry gutter. A next-column node hosting several
// staggered entry columns owns a wider band (gutterWidth), and a bend vertical
// dropped inside it would cross that node's entering runs. So the right margin
// is the widest gutter among next-column nodes whose vertical extent overlaps
// the band's own y-span -- a y-aware check, not just x, so a wide gutter on a
// node in a distant row does not needlessly squeeze the corridor.
export function assignBendColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const leftMargin = ENTRY_GUTTER_MIN; // keeps columns off the source port stubs

  // Per-node geometry plus entry-gutter width, so the fan can look up the band a
  // next-column node reserves and whether it shares the candidate's rows.
  const gutterCounts = gutterColumnCounts(edges, byId);
  type NodeGeom = { left: number; top: number; bottom: number; gutter: number };
  const geom: NodeGeom[] = nodes.map((n) => {
    const top = absoluteTop(n, byId);
    return {
      left: absoluteLeft(n, byId),
      top,
      bottom: top + nodeHeight(n),
      gutter: gutterWidth(gutterCounts.get(n.id) ?? 0),
    };
  });

  // All node left edges, sorted and de-duplicated once, so each band can find
  // the next node column right of its source layer in one scan.
  const nodeLeftEdges = [
    ...new Set(nodes.map((n) => absoluteLeft(n, byId))),
  ].sort((a, b) => a - b);

  // Group candidate edges by their source layer (the source's absolute left
  // edge, quantized to the pixel). Edges leaving the same layer share a corridor
  // regardless of which target layer they reach or how wide their source is.
  // yLo/yHi is the candidate's conservative vertical span (source row through
  // target row) used for the y-aware gutter clamp below.
  type Cand = {
    id: string;
    sourceRight: number;
    targetLeft: number;
    yLo: number;
    yHi: number;
  };
  const groups = new Map<number, Cand[]>();
  for (const edge of edges) {
    if (edge.type !== "item") continue; // only forward item edges get staggered
    if (edgeItem(edge) === undefined) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const sourceLeft = absoluteLeft(source, byId);
    const sourceRight = sourceLeft + nodeWidth(source);
    const targetLeft = absoluteLeft(target, byId);
    if (targetLeft - sourceRight <= 0) continue; // backward / zero-gap edge
    const sourceTop = absoluteTop(source, byId);
    const targetTop = absoluteTop(target, byId);
    const yLo = Math.min(sourceTop, targetTop);
    const yHi = Math.max(
      sourceTop + nodeHeight(source),
      targetTop + nodeHeight(target),
    );
    const band = Math.round(sourceLeft);
    const list = groups.get(band) ?? [];
    list.push({ id: edge.id, sourceRight, targetLeft, yLo, yHi });
    groups.set(band, list);
  }

  // Fan each band's members across its shared corridor. groupLeft is the band's
  // rightmost source edge; groupRight is the next node column right of it (or the
  // nearest target when the band skips no column). The left margin keeps columns
  // off the source port stubs; the right margin is the widest entry gutter among
  // next-column nodes sharing the band's rows, so no bend vertical lands inside a
  // foreign gutter. pitch = usable width / (n + 1) leaves symmetric end gaps.
  const bendById = new Map<string, number>();
  for (const list of groups.values()) {
    const groupLeft = Math.max(...list.map((c) => c.sourceRight));
    const nextColLeft = nodeLeftEdges.find((x) => x > groupLeft);
    const groupRight =
      nextColLeft ?? Math.min(...list.map((c) => c.targetLeft));
    // Band y-span: the union of member vertical spans. A next-column node whose
    // padded extent overlaps it could be crossed by one of these bends.
    const bandLo = Math.min(...list.map((c) => c.yLo));
    const bandHi = Math.max(...list.map((c) => c.yHi));
    let rightMargin = ENTRY_GUTTER_MIN;
    for (const g of geom) {
      if (Math.round(g.left) !== Math.round(groupRight)) continue;
      if (g.bottom + CHAMFER < bandLo || g.top - CHAMFER > bandHi) continue;
      if (g.gutter > rightMargin) rightMargin = g.gutter;
    }
    const usable = groupRight - groupLeft - leftMargin - rightMargin;
    if (usable <= 0) continue; // corridor too tight; keep the default midpoints
    const sorted = [...list].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const pitch = usable / (sorted.length + 1);
    sorted.forEach((c, i) => {
      bendById.set(c.id, groupLeft + leftMargin + pitch * (i + 1));
    });
  }

  return edges.map((edge) => {
    const bendX = bendById.get(edge.id);
    if (bendX === undefined) return edge;
    return { ...edge, data: { ...edge.data, bendX } };
  });
}

// clampBackwardRails: give each backward item edge's detour rail a y that clears
// the cards it horizontally spans, so a recycle rail no longer slices through
// its own source / target cards or the columns between them. Mirrors the bus
// lane band's obstacle avoidance (clearRailY): all node rectangles are the
// obstacles, and the rail moves just clear of the ones its horizontal run
// crosses. Threads { railY } onto the affected edges; every other edge passes
// through by reference. Runs after assignEntryColumns so it sees the entry
// column that fixes the rail's left end.
export function clampBackwardRails(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const obstacles: ObstacleRect[] = nodes.map((n) => {
    const left = absoluteLeft(n, byId);
    const top = absoluteTop(n, byId);
    return { left, right: left + nodeWidth(n), top, bottom: top + nodeHeight(n) };
  });

  const railYByIndex = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    if (nodeGap(source, target, byId) > 0) return; // forward edges keep the step
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const tx = absoluteLeft(target, byId);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    // Rail x-span mirrors chamferStepPath's backward branch: one stub right of
    // the source port to the entry column (or one stub before the target port).
    const xr = sx + PORT_STUB;
    const xl =
      (edge.data as { entryX?: number } | undefined)?.entryX ?? tx - PORT_STUB;
    const preferredY = sy === ty ? sy + PORT_STUB + 2 * CHAMFER : (sy + ty) / 2;
    const railY = clearRailY(preferredY, xl, xr, obstacles);
    if (railY !== preferredY) railYByIndex.set(index, railY);
  });

  if (railYByIndex.size === 0) return edges.map((e) => e);
  return edges.map((edge, index) => {
    const railY = railYByIndex.get(index);
    if (railY === undefined) return edge;
    return { ...edge, data: { ...edge.data, railY } };
  });
}

// -- Chip de-confliction -----------------------------------------------------
//
// Two coincident chips read as one, and on a bus lane the surviving chip lied
// about the flow. deconflictChipAnchors runs last (after routeBusEdges,
// assignEntryColumns, and assignBendColumns, so it sees the final laneY, entryX,
// bendX, and busChipX) and threads four chip-nudge offsets through one shared
// collision set:
//   - entryChipDy: entry chips arriving at one node are stacked to a clear pitch.
//     Entry chips are pinned to their ports (never pushed by another chip); they
//     seed the set first as fixed obstacles.
//   - busDropDy / busChipDy: a trunk's aggregate drop chip and each member's rise
//     chip prefer their lane position, but when they crowd (same lane, close x)
//     they cascade downward off the lane in CHIP_PITCH_Y steps.
//   - labelDy: item edges (forward or backward) whose reconstructed midpoint
//     anchor lands on a box already placed (an entry, bus, or earlier midpoint
//     chip) get a downward nudge so ItemEdge's midpoint chip clears its neighbour.
// Every family shares the set, so a midpoint no longer lands on a bus chip, a bus
// rise no longer lands on an entry marker, and so on. Pure and deterministic:
// anchors are reconstructed from node geometry with the same path builders the
// components use, and every pass orders by edge id.

// Chip half-extents, in graph units. A chip counter-scales up to MAX_CHIP_SCALE
// about its centre, so its rendered box in graph space never exceeds
// MAX_CHIP_SCALE times its natural dimension; half of that is the half-extent two
// centres must stay apart on an axis to keep the boxes clear at every zoom down
// to the fit floor. Height is shared by both chip families (they are the same
// height); width splits by family because the icon-only entry marker is far
// narrower than a rate/bus chip carrying text. The collision test sums the two
// boxes' half-extents per axis, so a wide-vs-wide pair needs the full
// MAX_CHIP_SCALE * CHIP_BOX_WIDTH of centre separation while a wide-vs-entry pair
// needs less -- the earlier single fixed 60 flagged only near-coincident pairs
// and missed wide chips that overlap on screen from tens of graph units away.
const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
const CHIP_HALF_W_WIDE = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;
const CHIP_HALF_W_ENTRY = (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2;

// Vertical pitch a colliding chip is bumped by each step, and the shared full
// chip-box height. A full max-scale box height keeps the resolved clearance from
// dropping below one box at any zoom.
const CHIP_PITCH_Y = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
const CHIP_NUDGE_STEP = CHIP_PITCH_Y;

// A placed chip box in the shared collision set: its centre plus per-axis
// half-extents. Two boxes overlap when their centres sit closer than the sum of
// their half-extents on BOTH axes.
type ChipBox = { x: number; y: number; halfW: number; halfH: number };

function chipBoxesOverlap(a: ChipBox, b: ChipBox): boolean {
  return (
    Math.abs(a.x - b.x) < a.halfW + b.halfW &&
    Math.abs(a.y - b.y) < a.halfH + b.halfH
  );
}

// Seat a chip at its preferred anchor, cascading it straight down in
// CHIP_NUDGE_STEP increments until it clears every box already in `placed`, then
// record it. Returns the downward offset applied (0 when the anchor was already
// clear). Deterministic given a fixed placement order.
function seatChip(
  placed: ChipBox[],
  x: number,
  y: number,
  halfW: number,
  halfH: number,
): number {
  let dy = 0;
  while (
    placed.some((box) => chipBoxesOverlap(box, { x, y: y + dy, halfW, halfH }))
  ) {
    dy += CHIP_NUDGE_STEP;
  }
  placed.push({ x, y: y + dy, halfW, halfH });
  return dy;
}

// Horizontal inset of an entry chip from its target port, mirroring ItemEdge's
// ENTRY_CHIP_OFFSET. Only used to place the entry box in the shared collision
// set so the midpoint nudge can route around it; the render offset itself lives
// in ItemEdge.
const ENTRY_CHIP_INSET = 12;

// Minimum vertical pitch between two entry chips arriving at one node, in graph
// units. Entry chips whose port anchors sit closer than this (same-item
// duplicates share a port y outright) are stacked down to this pitch so none
// coincide at any zoom.
export const ENTRY_CHIP_MIN_GAP = CHIP_PITCH_Y;

// Push a column of arrival y-anchors (given in arrival order) down just enough
// that each sits at least ENTRY_CHIP_MIN_GAP below the previous one, so equal or
// too-close anchors never coincide while their order is preserved. The first
// anchor is never moved. Pure.
export function stackEntryAnchors(ys: readonly number[]): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const y of ys) {
    const placed = Math.max(y, prev + ENTRY_CHIP_MIN_GAP);
    out.push(placed);
    prev = placed;
  }
  return out;
}

// Node-local y of the port carrying `item` on the given side, or the node's
// vertical center when the port cannot be resolved (product / loop node, or a
// missing item / order). Mirrors RecipeNode's handle placement: handles sit in
// the ELK-resolved row order, so the row index is the item's position in the
// ordered rows.
function portOffsetY(
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

export function deconflictChipAnchors(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Every chip family shares one collision set (`placed`), so a midpoint chip, a
  // bus chip, and an entry chip at the same place no longer overlap. Placement
  // order fixes who yields to whom: entry chips first (pinned to their ports,
  // never nudged), then bus chips (prefer their lane, cascade down when crowded),
  // then midpoint chips (nudge down around everything already placed).
  const placed: ChipBox[] = [];

  // Entry chips: every forward item edge flagged multiInputTarget pins an
  // icon-only chip just left of its target port. Chips arriving at one node
  // (same-item duplicates share a port y outright, adjacent ports sit a row
  // apart) collide, so bucket them per target, order by port index then edge id,
  // and stack their port anchors down to a clear pitch. The threaded dy is the
  // push each chip received off its own port y. Each chip's final box is seeded
  // into `placed` (even a lone chip that received no push) so the later passes
  // see it, at the narrow entry-marker half-width so a bus or midpoint chip only
  // yields when it truly overlaps the marker.
  const entryDyByIndex = new Map<number, number>();
  type EntrySlot = { index: number; id: string; port: number; anchorY: number };
  const entryByTarget = new Map<string, EntrySlot[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const data = edge.data as { multiInputTarget?: unknown } | undefined;
    if (data?.multiInputTarget !== true) return;
    const target = byId.get(edge.target);
    if (target === undefined) return;
    const item = edgeItem(edge);
    const anchorY = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const list = entryByTarget.get(edge.target) ?? [];
    list.push({
      index,
      id: edge.id,
      port: inputPortIndex(target, item),
      anchorY,
    });
    entryByTarget.set(edge.target, list);
  });
  for (const [targetId, list] of entryByTarget) {
    list.sort((a, b) => {
      const ap = a.port < 0 ? Infinity : a.port;
      const bp = b.port < 0 ? Infinity : b.port;
      if (ap !== bp) return ap - bp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const entryX = absoluteLeft(byId.get(targetId)!, byId) - ENTRY_CHIP_INSET;
    const stacked = stackEntryAnchors(list.map((s) => s.anchorY));
    list.forEach((s, i) => {
      const y = stacked[i]!;
      const dy = y - s.anchorY;
      if (dy !== 0) entryDyByIndex.set(s.index, dy);
      placed.push({ x: entryX, y, halfW: CHIP_HALF_W_ENTRY, halfH: CHIP_HALF_H });
    });
  }

  // Bus chips: each trunk draws one aggregate drop chip (on the owner member) and
  // one rise chip per member, all on the trunk's lane. Reconstruct their lane
  // anchors from the same geometry BusEdge uses (chamferBusPath for dropX/riseX,
  // busChipX for the spread rise slot) and seat each one, cascading downward off
  // the lane when it crowds a neighbour. Seating is two-phase: EVERY trunk's
  // drop chip settles first, then every rise chip, each phase in edge-id order.
  // The drop chip is the trunk's aggregate total at its junction; interleaving
  // by edge id alone would let an earlier trunk's cascading rise land on a later
  // trunk's junction and knock that aggregate off its lane, so drop priority is
  // structural, not an accident of id order. Drop and rise carry separate
  // offsets (busDropDy, busChipDy) because a member's rise may need a different
  // push than the trunk's shared drop.
  const busDropDyByIndex = new Map<number, number>();
  const busChipDyByIndex = new Map<number, number>();
  type BusSlot = {
    index: number;
    laneY: number;
    dropX: number;
    riseChipX: number;
    owner: boolean;
  };
  const busSlots: BusSlot[] = [];
  const busEdges = edges
    .map((edge, index) => ({ edge, index }))
    .filter((e) => e.edge.type === "bus")
    .sort((a, b) =>
      a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0,
    );
  for (const { edge, index } of busEdges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const data = edge.data as BusEdgeData | undefined;
    if (data?.laneY === undefined) continue;
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const tx = absoluteLeft(target, byId);
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const { dropX, riseX } = chamferBusPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      laneY: data.laneY,
      ...routingHintsFromData(edge.data),
    });
    busSlots.push({
      index,
      laneY: data.laneY,
      dropX,
      riseChipX: data.busChipX ?? riseX,
      owner: data.busChipOwner === true,
    });
  }
  for (const slot of busSlots) {
    if (!slot.owner) continue;
    const dropDy = seatChip(
      placed,
      slot.dropX,
      slot.laneY,
      CHIP_HALF_W_WIDE,
      CHIP_HALF_H,
    );
    if (dropDy !== 0) busDropDyByIndex.set(slot.index, dropDy);
  }
  for (const slot of busSlots) {
    const riseDy = seatChip(
      placed,
      slot.riseChipX,
      slot.laneY,
      CHIP_HALF_W_WIDE,
      CHIP_HALF_H,
    );
    if (riseDy !== 0) busChipDyByIndex.set(slot.index, riseDy);
  }

  // Item midpoint chips: reconstruct each item edge's label anchor from node
  // geometry (via the same chamferStepPath the component draws, threading the
  // same bendX / entryX / railY hints so a backward edge's chip lands on its
  // detour rail exactly as ItemEdge renders it) and greedily nudge a chip down
  // when it collides with one already placed (an entry, bus, or earlier midpoint
  // box). Backward edges are included, not skipped: ItemEdge draws their rate
  // chip on the rail too, and two rails sharing a clamped y stack their chips on
  // top of one another without this pass. Ordering by edge id keeps the placement
  // deterministic.
  const labelDyByIndex = new Map<number, number>();
  const items = edges
    .map((edge, index) => ({ edge, index }))
    .filter((e) => e.edge.type === "item")
    .sort((a, b) =>
      a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0,
    );
  for (const { edge, index } of items) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const tx = absoluteLeft(target, byId);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const [, lx, ly] = chamferStepPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      ...routingHintsFromData(edge.data),
    });
    const dy = seatChip(placed, lx, ly, CHIP_HALF_W_WIDE, CHIP_HALF_H);
    if (dy !== 0) labelDyByIndex.set(index, dy);
  }

  if (
    labelDyByIndex.size === 0 &&
    entryDyByIndex.size === 0 &&
    busDropDyByIndex.size === 0 &&
    busChipDyByIndex.size === 0
  ) {
    return edges.map((e) => e);
  }
  return edges.map((edge, index) => {
    const labelDy = labelDyByIndex.get(index);
    const entryChipDy = entryDyByIndex.get(index);
    const busDropDy = busDropDyByIndex.get(index);
    const busChipDy = busChipDyByIndex.get(index);
    if (
      labelDy === undefined &&
      entryChipDy === undefined &&
      busDropDy === undefined &&
      busChipDy === undefined
    ) {
      return edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(labelDy !== undefined ? { labelDy } : {}),
        ...(entryChipDy !== undefined ? { entryChipDy } : {}),
        ...(busDropDy !== undefined ? { busDropDy } : {}),
        ...(busChipDy !== undefined ? { busChipDy } : {}),
      },
    };
  });
}
