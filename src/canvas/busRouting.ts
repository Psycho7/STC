// Whole-graph pre-render ROUTING passes for the blueprint canvas. Layout runs
// them in order after ELK places the nodes (each consumes the previous ones'
// stamps; see layoutRenderPlan in layout.ts):
//   1. routeBusEdges       classify long / boundary-feeder edges into bus
//                          trunks, each on a lane in a top or bottom band.
//   2. assignEntryColumns  stake out per-target entry-gutter columns.
//   3. clearBusColumns     move bus drop / rise verticals clear of foreign
//                          cards / gutters.
//   4. assignBendColumns   stagger the remaining item edges' bend columns.
//   5. jogForwardLegs      bend a blocked forward final leg to a clear y.
//   6. clampBackwardRails  move backward detour rails clear of spanned cards.
// Every pass is pure and deterministic: no React, no Date/random, no mutation
// of the inputs. Nodes are read only for geometry (absolute positions and
// sizes); they pass through untouched. Passes merge routing fields onto edge
// `data` (bus members are retyped `type: "bus"`).
//
// The seventh and final pipeline pass -- chip seating (deconflictChipAnchors)
// -- lives in chipSeating.ts; it consumes this module's shared node/edge
// geometry helpers (absoluteLeft .. portOffsetY) and padding constants.

import type { Edge } from "@xyflow/react";
import Fraction from "fraction.js";

import {
  BETWEEN_LAYERS_SPACING,
  CHIP_BOX_HEIGHT,
  ENTRY_CHIP_BOX_WIDTH,
  ENTRY_CHIP_OFFSET,
  MAX_CHIP_SCALE,
  RECIPE_WIDTH,
  loopBoxDimensions,
} from "./dimensions";
import { CHAMFER, PORT_STUB, clearRailY, type ObstacleRect } from "./edgePath";
import { measureRecipe } from "./recipeGeometry";
import { orderByItem } from "./orderByItem";
import type { RFAnyNode } from "./layout";

// A "long" edge reaches past two full layers. One layer is a column gap plus a
// recipe node, so the threshold is 2 * (gap + recipe width). Derived from the
// layout constants so it tracks any spacing change instead of drifting from a
// hardcoded 820. test/canvas/edgeSpans.ts re-exports this as SPAN_THRESHOLD.
export const BUS_SPAN_THRESHOLD = 2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH);

// A fan-out member reaches at most one layer over. One layer is a column gap
// plus a recipe node, so a same-next-layer target's span (the empty gap) is at
// most BETWEEN_LAYERS_SPACING + RECIPE_WIDTH: an adjacent-layer gap is just the
// spacing, and a two-layers-over gap already exceeds this by a second spacing.
// Strictly below BUS_SPAN_THRESHOLD (= 2x this), so the fan-out and long-span
// bus classifications never both claim one edge. Derived from the layout
// constants so it tracks any spacing change.
export const FANOUT_SPAN_MAX = BETWEEN_LAYERS_SPACING + RECIPE_WIDTH;

// Minimum gap for a fan-out member: the junction column needs a full stub plus a
// chamfer of clearance on each side (the same budget the bus / forward-step
// builders use) or chamferFanoutPath degenerates to a plain step with no
// distinct junction -- no consolidation, and a junction pinned inside a sub-
// budget gap crowds the neighbouring entry gutters. A same-layer pair packed
// this close is left as plain item edges. Boundary case, deliberately excluded.
export const FANOUT_SPAN_MIN = 2 * (PORT_STUB + CHAMFER);

// Gap between the lowest node bottom and the first lane, then the vertical
// pitch between successive lanes. LANE_SPACING is derived from the shared chip
// pitch (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) so a rise chip sitting on one lane
// clears the rise chip on the adjacent lane at every zoom: the two boxes are
// exactly a max-scale box height apart and abut instead of overlapping. The
// earlier fixed 28 sat below that pitch, so adjacent-lane chips interpenetrated.
export const LANE_TOP_OFFSET = 80;
export const LANE_SPACING = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;

// Trunk-aggregate fields shared by BOTH trunk kinds (lane and fan-out). Every
// member of a trunk carries the summed rate (busTotalRate) and member count
// (busMemberCount); busChipOwner marks the single member elected to draw the
// trunk's one aggregate chip (showing the total, plus the count when > 1). The
// other members suppress that chip, so the trunk shows its true total once
// instead of one member's share stacked N times. trunkKey groups the members.
export type BusAggregate = {
  trunkKey: string;
  busTotalRate?: Fraction;
  busMemberCount?: number;
  busChipOwner?: boolean;
};

// Lane-trunk member (routeBusEdges): rides a band lane at laneY.
export type LaneBusEdgeData = BusAggregate & {
  // Discriminant: absent / false on a lane member. Present-and-true only on the
  // fan-out variant, so `data.fanout === true` and `"laneY" in data` both narrow
  // the union.
  fanout?: false;
  laneY: number;
  // Lane x for this member's rise chip, assigned by routeBusEdges so a trunk's
  // rise chips spread evenly along the lane instead of stacking near their rise
  // vertices. BusEdge anchors the rise chip at (busChipX, laneY). Absent on
  // manually built edges, where BusEdge falls back to the geometric rise column.
  busChipX?: number;
  // Chip nudges assigned by deconflictChipAnchors when a trunk's chips crowd on
  // their lane: busDropDy shifts the owner's aggregate drop chip and busChipDy
  // shifts this member's rise chip, each off the lane in CHIP_PITCH_Y steps so
  // they no longer overlap. BusEdge adds them to the chips' laneY. The step is
  // signed by band -- bottom-band chips cascade DOWN (positive, away from the
  // graph below), top-band chips cascade UP (negative, away from the graph
  // above) -- so a chip never walks back toward the nodes. Optional, default 0.
  busDropDy?: number;
  busChipDy?: number;
  // Which lane band this trunk sits in. Bottom band is below the graph (today's
  // behaviour), top band above it. Stamped by routeBusEdges from the mean of the
  // trunk's member port Ys relative to the graph midline; read by
  // deconflictChipAnchors to pick the chip-cascade direction. Absent on manually
  // built edges (they cascade downward, the bottom-band default).
  busBand?: "top" | "bottom";
};

// Fan-out trunk member (routeFanoutEdges). Retyped `type: "bus"` -- so Canvas
// trunk adjacency and hover-dim pick it up exactly like a lane trunk -- but
// carries NO laneY: it does not ride a lane band, it consolidates N
// same-source-port edges onto one shared junction column in a single layer gap.
// `fanout: true` is the discriminant, so BusEdge draws the short in-corridor
// trunk (chamferFanoutPath) instead of the lane drop/rise and the downstream
// lane passes (clearBusColumns, the bus chip phases) skip it. `junctionX` is the
// shared column, deterministic via clearColumnX. The aggregate reuses
// BusAggregate. Its chip offsets are the four fanout* below, threaded by
// deconflictChipAnchors and added to the fan-out chip anchors by BusEdge (dx +
// dy because the aggregate slides along the horizontal trunk and a branch along
// its vertical leg).
export type FanoutBusEdgeData = BusAggregate & {
  fanout: true;
  junctionX?: number;
  fanoutAggDx?: number;
  fanoutAggDy?: number;
  fanoutBranchDx?: number;
  fanoutBranchDy?: number;
  // Set by deconflictChipAnchors when no chip/card-clear seat exists anywhere
  // on this member's own polyline (a narrow-corridor fan-out whose aggregate
  // box covers the whole short path). BusEdge then skips the branch chip: an
  // off-line seat would float in empty canvas, and the member's rate is
  // already on its target card's input row. The companion anchor records the
  // branch anchor the hide was decided at: nodes stay mouse-draggable and the
  // seating pass does not rerun on drag, so BusEdge drops a hide whose live
  // recomputed anchor no longer matches the stamp.
  fanoutBranchHidden?: true;
  fanoutBranchHiddenAt?: { x: number; y: number };
};

// Data fields the bus pass merges onto a member edge's existing `data`. A
// discriminated union on `fanout` so laneY lives only on the lane member (never
// declared required-but-sometimes-absent) and the fan-out offsets live only on
// the fan-out member. Narrow with `data.fanout === true` or `"laneY" in data`.
export type BusEdgeData = LaneBusEdgeData | FanoutBusEdgeData;

// Vertical extent of one lane band, normalized so y0 < y1. The bottom band runs
// from its first lane (bandTop, nearest the graph) down to its deepest lane; the
// top band from its highest lane up to its first lane (nearest the graph). Null
// when the band holds no trunk. Emitted by laneBands for the bus-band marking
// pass to shade.
export type BandExtent = { y0: number; y1: number };
export type LaneBands = { top: BandExtent | null; bottom: BandExtent | null };

// Read a Fraction rate off an edge's data, or undefined when it is absent or not
// a Fraction (older fixtures may omit it).
function edgeRate(edge: Edge): Fraction | undefined {
  const rate = (edge.data as { rate?: unknown } | undefined)?.rate;
  return rate instanceof Fraction ? rate : undefined;
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

// Per-edge horizontal span: the empty gap between the source node's right edge
// and the target node's left edge, floored at 0. Backward edges collapse to 0.
// Mirrors test/canvas/edgeSpans.ts.
function edgeSpan(
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
  const targetLeft = absoluteLeft(target, byId);
  return Math.max(0, targetLeft - sourceRight);
}

function isInputProduct(node: RFAnyNode | undefined): boolean {
  return node?.type === "product" && node.data.kind === "inputProduct";
}

export function edgeItem(edge: Edge): string | undefined {
  const item = (edge.data as { item?: unknown } | undefined)?.item;
  return typeof item === "string" ? item : undefined;
}

// The lowest node bottom in absolute coordinates. The bottom lane band starts
// below this so no bottom lane ever crosses a node.
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

// The highest node top in absolute coordinates. The top lane band starts above
// this so no top lane ever crosses a node. Mirror of maxAbsoluteNodeBottom on
// the other side; +Infinity for an empty node set (never reached -- lanes only
// exist when edges, hence nodes, do).
function minAbsoluteNodeTop(
  nodes: ReadonlyArray<RFAnyNode>,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  let top = Infinity;
  for (const node of nodes) {
    top = Math.min(top, absoluteTop(node, byId));
  }
  return top;
}

// Absolute y of the source out-port and target in-port of a bus member, given
// the resolved endpoints and item. The band decision averages these across a
// trunk's members.
function memberPortMidY(
  source: RFAnyNode,
  target: RFAnyNode,
  item: string | undefined,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
  const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
  return (sy + ty) / 2;
}

// routeBusEdges: classify long / boundary-feeder edges as bus members and give
// each (item, source) trunk one lane, in a top or bottom band chosen by where
// the trunk's members lean (Task 13). Non-member edges pass through unchanged;
// member edges are retyped and get `{ laneY, trunkKey, busBand, ... }` merged
// onto their data.
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
    const isBus =
      edgeSpan(source, target, byId) > BUS_SPAN_THRESHOLD || bothInput;
    if (!isBus) return;

    const trunkKey = item + "|" + edge.source;
    trunkKeyByEdgeIndex.set(index, trunkKey);
    if (!trunks.has(trunkKey))
      trunks.set(trunkKey, { item, source: edge.source });
  });

  // Demote clear-corridor single-member FORWARD trunks back to plain item edges.
  // A "would-be trunk with exactly one member" is only knowable after grouping,
  // so this is a post-grouping pass; it runs BEFORE any lane / aggregate stamping
  // below so no bus scaffolding leaks onto a demoted edge. A lone forward member
  // (span > threshold) whose direct item-edge corridor is provably clear needs no
  // lane detour: dropped from the bus set it flows on as a plain item edge, and
  // assignBendColumns / jogForwardLegs route it directly. bothInput feeders are
  // excluded -- they ride the bus to cross the whole graph, not for span -- and
  // backward members keep the lane (their corridor is the rail shape, not this
  // forward leg). Conservative: any unproven corridor keeps today's bus lane.
  const memberIndicesByTrunk = new Map<string, number[]>();
  trunkKeyByEdgeIndex.forEach((trunkKey, index) => {
    const list = memberIndicesByTrunk.get(trunkKey) ?? [];
    list.push(index);
    memberIndicesByTrunk.set(trunkKey, list);
  });
  const singleMemberTrunks = [...memberIndicesByTrunk].filter(
    ([, indices]) => indices.length === 1,
  );
  // A demoted edge is bound to its proven clear bend column: the stamp keeps
  // assignBendColumns' fan (which skips pre-stamped edges) and the drawer's mid
  // fallback from re-picking a blocked column the existence proof never checked.
  const demotedBendXByIndex = new Map<number, number>();
  if (singleMemberTrunks.length > 0) {
    const obstacles = paddedObstacles(nodes, edges);
    for (const [trunkKey, indices] of singleMemberTrunks) {
      const index = indices[0]!;
      const edge = edges[index]!;
      const source = byId.get(edge.source)!;
      const target = byId.get(edge.target)!;
      if (isInputProduct(source) && isInputProduct(target)) continue; // bothInput
      // Forward only. Unreachable under current classification (edgeSpan floors
      // at 0, so a non-bothInput member always has gap > 0); kept as a guard so
      // a future classifier change cannot silently demote a backward member,
      // whose corridor is the rail shape, not this forward leg.
      if (nodeGap(source, target, byId) <= 0) continue;
      const item = edgeItem(edge);
      if (!forwardCorridorClear(source, target, item, byId, obstacles)) {
        continue; // horizontal corridor not provably clear -> keep the lane
      }
      const proof = provenForwardBendColumn(
        source,
        target,
        item,
        byId,
        obstacles,
      );
      if (proof === null) {
        continue; // no clear vertical bend column -> keep the lane
      }
      trunkKeyByEdgeIndex.delete(index);
      trunks.delete(trunkKey);
      if (proof.bendX !== null) demotedBendXByIndex.set(index, proof.bendX);
    }
  }

  const withDemotedBends = (edge: Edge, index: number): Edge => {
    const bendX = demotedBendXByIndex.get(index);
    if (bendX === undefined) return edge;
    return { ...edge, data: { ...edge.data, bendX } };
  };

  if (trunkKeyByEdgeIndex.size === 0) return edges.map(withDemotedBends);

  // Split trunks into a top and a bottom band. The bottom band sits below the
  // graph (today's single band, lanes stacking DOWN); the top band mirrors it
  // above the graph (lanes stacking UP). A trunk joins the band its members lean
  // toward: the mean of its members' port midpoints (source out-port to target
  // in-port) versus the graph's vertical midline. A mean strictly above the
  // midline goes top; at or below goes bottom, so an exact-midline trunk falls
  // deterministically to the bottom band (matching the pre-split behaviour where
  // everything went below).
  const graphTop = minAbsoluteNodeTop(nodes, byId);
  const graphBottom = maxAbsoluteNodeBottom(nodes, byId);
  const bandTopBottom = graphBottom + LANE_TOP_OFFSET;
  const bandTopTop = graphTop - LANE_TOP_OFFSET;
  const midline = (graphTop + graphBottom) / 2;

  // Mean member port Y per trunk, accumulated over its members.
  const trunkPortSum = new Map<string, number>();
  const trunkPortCount = new Map<string, number>();
  trunkKeyByEdgeIndex.forEach((trunkKey, index) => {
    const edge = edges[index]!;
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    const midY = memberPortMidY(source, target, edgeItem(edge), byId);
    trunkPortSum.set(trunkKey, (trunkPortSum.get(trunkKey) ?? 0) + midY);
    trunkPortCount.set(trunkKey, (trunkPortCount.get(trunkKey) ?? 0) + 1);
  });
  const bandByTrunk = new Map<string, "top" | "bottom">();
  for (const trunkKey of trunks.keys()) {
    const mean = trunkPortSum.get(trunkKey)! / trunkPortCount.get(trunkKey)!;
    // Task 13 tiebreak: an exact-midline trunk (mean == midline) falls to bottom.
    bandByTrunk.set(trunkKey, mean < midline ? "top" : "bottom");
  }

  // Assign one lane slot per trunk within its band. Sort by item id, then source
  // id (i.e. by trunkKey), so slot order is deterministic across runs regardless
  // of edge order and the bottom band keeps its pre-split ordering. Bottom lanes
  // stack DOWN from bandTopBottom; top lanes stack UP from bandTopTop.
  type TrunkEntry = [string, { item: string; source: string }];
  const byTrunkKey = ([, a]: TrunkEntry, [, b]: TrunkEntry): number => {
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return 0;
  };
  const sortedTrunks = [...trunks.entries()].sort(byTrunkKey);
  const laneYByTrunk = new Map<string, number>();
  let topSlot = 0;
  let bottomSlot = 0;
  for (const [trunkKey] of sortedTrunks) {
    if (bandByTrunk.get(trunkKey) === "top") {
      laneYByTrunk.set(trunkKey, bandTopTop - topSlot * LANE_SPACING);
      topSlot += 1;
    } else {
      laneYByTrunk.set(trunkKey, bandTopBottom + bottomSlot * LANE_SPACING);
      bottomSlot += 1;
    }
  }

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
  // fields merged; demoted edges carry their proven bendX; everything else is
  // returned as-is.
  return edges.map((edge, index) => {
    const trunkKey = trunkKeyByEdgeIndex.get(index);
    if (trunkKey === undefined) return withDemotedBends(edge, index);
    const laneY = laneYByTrunk.get(trunkKey)!;
    return {
      ...edge,
      type: "bus",
      data: {
        ...edge.data,
        laneY,
        trunkKey,
        busBand: bandByTrunk.get(trunkKey)!,
        busTotalRate: trunkTotal.get(trunkKey)!,
        busMemberCount: trunkCount.get(trunkKey)!,
        busChipOwner: edge.id === trunkOwner.get(trunkKey),
        busChipX: busChipXByIndex.get(index)!,
      },
    };
  });
}

// laneBands: the vertical extent of each lane band, folded directly over the
// already-ROUTED edges (routeBusEdges output). It reads the band + laneY each bus
// member carries, so the extents are consistent with the assigned lanes by
// construction -- one source of truth, no re-run of the classifier. Taking routed
// edges (not raw nodes / edges) keeps it a pure fold: the caller routes once and
// both the drawn lanes and their shaded extents derive from that single pass. A
// band with no trunk is null. Consumed by the bus-band marking pass to shade the
// lane region. Pure and deterministic.
export function laneBands(edges: ReadonlyArray<Edge>): LaneBands {
  const topYs: number[] = [];
  const bottomYs: number[] = [];
  for (const edge of edges) {
    if (edge.type !== "bus") continue;
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) continue;
    (data.busBand === "top" ? topYs : bottomYs).push(data.laneY);
  }
  const extent = (ys: number[]): BandExtent | null =>
    ys.length === 0 ? null : { y0: Math.min(...ys), y1: Math.max(...ys) };
  return { top: extent(topYs), bottom: extent(bottomYs) };
}

// Vertical margin added above and below a band's lane extent so a single-lane
// band (y0 == y1, zero-height by itself) still marks a visible region and a
// multi-lane band wraps its lanes -- and the rise / drop chips seated on them --
// with air. Half a lane pitch: a max-scale chip is one LANE_SPACING tall and
// centred on its lane, so this clears its half-box.
export const BAND_Y_PAD = LANE_SPACING / 2;

// Horizontal margin added on each side of the node span for a band's x-extent.
// One stub keeps the faint band from cutting exactly at the border cards' edges.
export const BAND_X_MARGIN = PORT_STUB;

// An absolute-coordinate band rectangle for the bus-band marking layer: the
// faint tinted region drawn BENEATH the edges to show where a lane band sits.
export type BusBandRegion = {
  band: "top" | "bottom";
  x: number;
  y: number;
  width: number;
  height: number;
};

// busBandRegions: the drawable rectangle of every non-null lane band, folded
// over the ROUTED edges (laneBands) plus the node span. The y-extent is the
// band's lane range padded by BAND_Y_PAD; the x-extent is the graph's node
// horizontal span padded by BAND_X_MARGIN. Bus trunks span two-plus layers, so
// their lane runs live under essentially the full node span -- the node span is
// a stable, honest proxy for the lane region without recomputing every member's
// drop / rise column. Empty when no band holds a trunk (or the graph has no
// nodes). Pure and deterministic; consumed by the BusBands render layer.
export function busBandRegions(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): BusBandRegion[] {
  const bands = laneBands(edges);
  if (bands.top === null && bands.bottom === null) return [];

  const byId = new Map<string, RFAnyNode>();
  for (const node of nodes) byId.set(node.id, node);
  let left = Infinity;
  let right = -Infinity;
  for (const node of nodes) {
    const l = absoluteLeft(node, byId);
    left = Math.min(left, l);
    right = Math.max(right, l + nodeWidth(node));
  }
  if (!Number.isFinite(left)) return []; // no nodes -> nothing to anchor to

  const x = left - BAND_X_MARGIN;
  const width = right + BAND_X_MARGIN - x;
  const regions: BusBandRegion[] = [];
  for (const band of ["top", "bottom"] as const) {
    const extent = bands[band];
    if (extent === null) continue;
    const y = extent.y0 - BAND_Y_PAD;
    regions.push({
      band,
      x,
      y,
      width,
      height: extent.y1 + BAND_Y_PAD - y,
    });
  }
  return regions;
}

// routeFanoutEdges: synthesize a first-class fan-out trunk wherever N >= 2 edges
// leave the SAME source port (same item, same source unit) into targets one
// layer over. Runs AFTER routeBusEdges, on the still-"item" remainder (bus
// members and demoted trunks are already retyped / bound, and none overlap a
// fan-out by span). Each qualifying member is retyped `type: "bus"` and stamped
// { fanout, junctionX, trunkKey, busTotalRate, busMemberCount, busChipOwner } --
// reusing the trunk aggregation scaffolding -- but carries NO laneY, so the lane
// passes (clearBusColumns, the bus drop/rise chip phases) skip it and BusEdge
// draws the short in-corridor trunk. Members of a fan-out share one junction
// column so their trunk segments overlap into one line and the junction
// consolidates them (audit issue 6: the chip no longer hides the branch point).
//
// Classification bounds, all so a fan-out never captures an edge another pass
// owns: still type "item" (not a bus member / demoted); forward with a positive
// gap at most FANOUT_SPAN_MAX (one layer, strictly under BUS_SPAN_THRESHOLD);
// not a bothInput feeder (those ride the bus to cross the whole graph); a
// resolvable item. Grouping is unconditional at N >= 2 sharing a source port --
// the junction is the point of the formation. Non-members pass through by
// reference. Pure and deterministic: grouping, owner election (lex-smallest edge
// id), and junction columns depend only on geometry and edge ids, never order.
export function routeFanoutEdges(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const node of nodes) byId.set(node.id, node);

  // Bucket qualifying members by (item, source-port) == trunkKey. A recipe
  // out-port carries exactly one item, so item + source id identifies the port.
  const memberIndicesByTrunk = new Map<string, number[]>();
  const trunkKeyByEdgeIndex = new Map<number, string>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    const item = edgeItem(edge);
    if (item === undefined) return;
    if (isInputProduct(source) && isInputProduct(target)) return; // bothInput
    const gap = nodeGap(source, target, byId);
    if (gap <= FANOUT_SPAN_MIN || gap > FANOUT_SPAN_MAX) return;
    const trunkKey = item + "|" + edge.source;
    trunkKeyByEdgeIndex.set(index, trunkKey);
    const list = memberIndicesByTrunk.get(trunkKey) ?? [];
    list.push(index);
    memberIndicesByTrunk.set(trunkKey, list);
  });

  // Keep only trunks that actually fan out (N >= 2).
  const fanoutTrunks = [...memberIndicesByTrunk].filter(
    ([, indices]) => indices.length >= 2,
  );
  if (fanoutTrunks.length === 0) return edges.map((e) => e);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);

  // Per-trunk aggregate + shared junction column.
  const totalByTrunk = new Map<string, Fraction>();
  const countByTrunk = new Map<string, number>();
  const ownerByTrunk = new Map<string, string>();
  const junctionXByTrunk = new Map<string, number>();
  const memberTrunk = new Set<number>();
  for (const [trunkKey, indices] of fanoutTrunks) {
    let total = new Fraction(0);
    let owner: string | undefined;
    let corridorRight = Infinity;
    const exempt = new Set<string>();
    // Source is shared across members; resolve its port geometry once.
    const source = byId.get(edges[indices[0]!]!.source)!;
    const item = edgeItem(edges[indices[0]!]!);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    exempt.add(source.id);
    if (source.parentId !== undefined) exempt.add(source.parentId);
    let yLo = sy;
    let yHi = sy;
    // Each member's target-approach leg: the horizontal from the shared junction
    // column across to the target port at ty.
    const memberLegs: Array<{ tx: number; ty: number }> = [];
    for (const index of indices) {
      const edge = edges[index]!;
      total = total.add(edgeRate(edge) ?? new Fraction(0));
      if (owner === undefined || edge.id < owner) owner = edge.id;
      const target = byId.get(edge.target)!;
      const tx = absoluteLeft(target, byId);
      const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
      corridorRight = Math.min(corridorRight, tx);
      yLo = Math.min(yLo, ty);
      yHi = Math.max(yHi, ty);
      exempt.add(target.id);
      if (target.parentId !== undefined) exempt.add(target.parentId);
      memberLegs.push({ tx, ty });
    }

    // Shared junction column, resolved with ACCEPTANCE so the whole formation
    // stays clear of foreign cards -- not just the vertical column. A candidate
    // is accepted only when the shared trunk leg at sy (source port -> column)
    // AND every member's branch leg at its ty (column -> target port) clear
    // foreign RAW cards, and the column sits inside the trunk-wide corridor
    // [sx + stub + chamfer, min(all tx) - stub - chamfer]. Clamping to that
    // corridor keeps the shared column from fragmenting past a member's own
    // per-edge clamp (chamferFanoutPath re-clamps each member to its [lo, hi], so
    // a shared column outside a tighter member's range would split the trunk).
    // Own source / targets and their containers are exempt.
    const foreignPadded = obstacles.filter((o) => !exempt.has(o.nodeId));
    const foreignRaw = rawCards.filter((o) => !exempt.has(o.nodeId));
    const corLo = sx + PORT_STUB + CHAMFER;
    const corHi = corridorRight - PORT_STUB - CHAMFER;
    const legsClear = (x: number): boolean =>
      !connectingLegBlocked(sx, sy, x, foreignRaw) &&
      memberLegs.every((l) => !connectingLegBlocked(l.tx, l.ty, x, foreignRaw));
    const accept = (x: number): boolean =>
      x >= corLo && x <= corHi && legsClear(x);
    const desired = Math.min(Math.max((sx + corridorRight) / 2, corLo), corHi);
    const junctionX = clearColumnX(desired, yLo, yHi, foreignPadded, {
      towardTarget: 1,
      accept,
    });
    // clearColumnX returns the desired column unchanged when no candidate
    // qualifies, so confirm the resolved column is BOTH vertically clear of the
    // foreign padded cards / gutters AND accepted before forming the trunk. When
    // no acceptable shared column exists, DO NOT form the fan-out: the members
    // stay plain item edges (left unmarked), keeping the item-edge passes'
    // per-leg jog protection that a bus-retyped member would lose.
    const spanLo = Math.min(yLo, yHi);
    const spanHi = Math.max(yLo, yHi);
    const columnClear = !foreignPadded.some(
      (o) =>
        o.bottom > spanLo &&
        o.top < spanHi &&
        junctionX > o.left - CHAMFER &&
        junctionX < o.right + CHAMFER,
    );
    if (!columnClear || !accept(junctionX)) continue;

    for (const index of indices) memberTrunk.add(index);
    totalByTrunk.set(trunkKey, total);
    countByTrunk.set(trunkKey, indices.length);
    ownerByTrunk.set(trunkKey, owner!);
    junctionXByTrunk.set(trunkKey, junctionX);
  }

  return edges.map((edge, index) => {
    if (!memberTrunk.has(index)) return edge;
    const trunkKey = trunkKeyByEdgeIndex.get(index)!;
    return {
      ...edge,
      type: "bus",
      data: {
        ...edge.data,
        fanout: true,
        trunkKey,
        junctionX: junctionXByTrunk.get(trunkKey)!,
        busTotalRate: totalByTrunk.get(trunkKey)!,
        busMemberCount: countByTrunk.get(trunkKey)!,
        busChipOwner: edge.id === ownerByTrunk.get(trunkKey),
      },
    };
  });
}

// Would a long forward edge's DIRECT (plain item-edge) corridor draw clear of
// foreign cards? The item edge routes its final leg at the target-port y from
// the bend column across to the target; on a long span that leg can slice an
// intervening card. Mirror jogForwardLegs' clear test -- clearRailY on the leg's
// y-band -- over the whole source->target extent, the most conservative bound
// since the real bend column sits somewhere inside it. Only CARD obstacles
// block: gutters guard foreign VERTICAL runs, while this test is about a
// horizontal final leg, which legitimately crosses gutter x-bands (every
// entering leg does). Card-only also makes the demotion gate and the census
// helper agree by construction -- the gate runs on pre-retype edges (every
// gutter at minimum width) while the census sees post-retype edges whose bus
// rises widen foreign gutters, so any gutter sensitivity would make the census
// stricter than the gate it audits. Own source / target cards, plus each
// endpoint's container, are exempt (same semantics as jogForwardLegs): the run
// legitimately starts / ends inside them. A clear result means the edge needs no
// bus lane; anything unproven keeps the lane.
function forwardCorridorClear(
  source: RFAnyNode,
  target: RFAnyNode,
  item: string | undefined,
  byId: ReadonlyMap<string, RFAnyNode>,
  obstacles: ReadonlyArray<PaddedObstacle>,
): boolean {
  const sx = absoluteLeft(source, byId) + nodeWidth(source);
  const tx = absoluteLeft(target, byId);
  const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
  const exempt = new Set<string>([source.id, target.id]);
  if (source.parentId !== undefined) exempt.add(source.parentId);
  if (target.parentId !== undefined) exempt.add(target.parentId);
  const foreign = obstacles.filter(
    (o) => o.kind === "card" && !exempt.has(o.nodeId),
  );
  // Final-leg y-band from just past the source port to one stub before the
  // target port. clearRailY returns ty unchanged iff nothing foreign crosses it.
  return clearRailY(ty, sx + PORT_STUB, tx - PORT_STUB, foreign) === ty;
}

// Proven clear vertical bend column for a demoted forward edge, or null. A
// demoted single-member trunk (Task 12) draws a normal forward step whose bend
// is a vertical run between the source and target rows. forwardCorridorClear
// proves the horizontal legs clear, but that vertical can still slice a card
// stacked in the inter-layer gap -- so demotion additionally requires SOME
// column in [sx, tx] spanning sy..ty pierced by no foreign card, and the
// demotion BINDS the drawn bend to that proven column (stamped as bendX; the
// existence proof alone would not constrain assignBendColumns' fan or the mid
// fallback, which can still pick a blocked column). Candidates live inside the
// drawer's clamp range so the stamp survives clamping; the one nearest the
// corridor midpoint wins for visual balance, ties toward the left. A same-y /
// small-dy route (|ty - sy| <= a chamfer) draws no vertical run and needs no
// column (returns the corridor midpoint). Uses the same card-only foreign set
// (own source / target and their containers exempt) as the corridor gate, so a
// demotion never leaves a bend crossing a card the segment audit would then
// flag. Any unproven column keeps the lane (null). A clear route that draws no
// vertical needs no stamp: bendX comes back null inside the proof so the edge
// passes through untouched.
type BendProof = { bendX: number | null };
function provenForwardBendColumn(
  source: RFAnyNode,
  target: RFAnyNode,
  item: string | undefined,
  byId: ReadonlyMap<string, RFAnyNode>,
  obstacles: ReadonlyArray<PaddedObstacle>,
): BendProof | null {
  const sx = absoluteLeft(source, byId) + nodeWidth(source);
  const tx = absoluteLeft(target, byId);
  const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
  const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
  const mid = (sx + tx) / 2;
  if (Math.abs(ty - sy) <= 2 * CHAMFER) return { bendX: null }; // no vertical run
  const exempt = new Set<string>([source.id, target.id]);
  if (source.parentId !== undefined) exempt.add(source.parentId);
  if (target.parentId !== undefined) exempt.add(target.parentId);
  const ymin = Math.min(sy, ty);
  const ymax = Math.max(sy, ty);
  const spanned = obstacles.filter(
    (o) =>
      o.kind === "card" &&
      !exempt.has(o.nodeId) &&
      o.bottom > ymin &&
      o.top < ymax,
  );
  const gap = CHAMFER;
  const blocked = (x: number): boolean =>
    spanned.some((o) => x > o.left - gap && x < o.right + gap);
  // Candidate columns: the corridor midpoint, one stub+chamfer inside each port
  // (the drawer's clamp bounds), and each spanned card's padded edges, all
  // restricted to the clamp range so the stamped bendX draws as proven.
  const lo = sx + PORT_STUB + CHAMFER;
  const hi = tx - PORT_STUB - CHAMFER;
  const candidates = [
    mid,
    lo,
    hi,
    ...spanned.flatMap((o) => [o.left - gap, o.right + gap]),
  ]
    .filter((x) => x >= lo && x <= hi)
    .filter((x) => !blocked(x))
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  const best = candidates[0];
  return best === undefined ? null : { bendX: best };
}

// directCorridorClear: the corridor gate above, resolved from raw nodes / edges
// for one edge. Exported for the edge-span census, which asserts every non-bus
// edge spanning past the threshold has a provably clear direct corridor -- the
// successor criterion to "zero long non-bus edges": the old zero-count satisfies
// it vacuously, and it additionally admits the provably-clear long edges the
// demotion pass deliberately leaves plain. Missing endpoints or a backward /
// zero gap read as not-clear.
export function directCorridorClear(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  edge: Edge,
): boolean {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return false;
  if (nodeGap(source, target, byId) <= 0) return false;
  const obstacles = paddedObstacles(nodes, edges);
  return forwardCorridorClear(source, target, edgeItem(edge), byId, obstacles);
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
    // A fan-out member approaches its target horizontally off the shared
    // junction column (mid-corridor), never up the target's entry gutter, so it
    // stakes no gutter column and does not widen the band.
    if ((edge.data as { fanout?: unknown } | undefined)?.fanout === true) {
      return false;
    }
    const budget = 2 * (PORT_STUB + CHAMFER);
    return gap <= 0 || gap >= budget; // narrow-forward hairpin claims no column
  }
  if (edge.type === "item") return gap <= 0; // backward rail
  return false;
}

// Resolved input-port index of an edge at its target, or -1 when unknown. Only
// recipe/loop nodes carry the ELK-resolved `inputOrder`; product targets have a
// single port. Used to order a target's staggered entry columns top to bottom.
export function inputPortIndex(target: RFAnyNode, item: string | undefined): number {
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
    // Respect a pre-stamped bendX (a demoted trunk bound to its proven clear
    // column): re-fanning it could move the bend back onto a blocked column.
    if ((edge.data as { bendX?: number } | undefined)?.bendX !== undefined) {
      continue;
    }
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
  // Per-edge corridor budget for enlarging its forward chamfers (Task 20). The
  // columns sit `pitch` apart, so a chamfer of width c on one reaches c toward
  // its neighbour; keeping both envelopes disjoint needs 2c <= pitch, i.e.
  // c <= pitch/2. The symmetric end gaps are also one pitch, so pitch/2 keeps the
  // outermost column's bevel off the corridor walls too. Hence budget = pitch/2:
  // the largest chamfer that stays sibling- and wall-safe. chamferStepPath caps
  // the drawn chamfer at min(MAX_CHAMFER, half the shorter leg, this budget).
  const budgetById = new Map<string, number>();
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
    const budget = pitch / 2;
    sorted.forEach((c, i) => {
      bendById.set(c.id, groupLeft + leftMargin + pitch * (i + 1));
      budgetById.set(c.id, budget);
    });
  }

  return edges.map((edge) => {
    const bendX = bendById.get(edge.id);
    if (bendX === undefined) return edge;
    return {
      ...edge,
      data: { ...edge.data, bendX, chamferBudget: budgetById.get(edge.id) },
    };
  });
}

// -- Padded obstacle provider -------------------------------------------------
//
// The single source of truth for "what a vertical run (backward rail, bus rise /
// drop, forward bend) must stay clear of". Two kinds of obstacle:
//   - card:   a node's box, padded for the geometry that overhangs it. A source
//             port stub reaches PORT_STUB right; a target port stub reaches
//             PORT_STUB left, and the entry chip reaches further still (it
//             renders one ENTRY_CHIP_OFFSET inside the port and spans half its
//             max-scale box left of that), so the left pad is the wider of the
//             two. Top / bottom carry the CHAMFER bevel overhang, matching the
//             gutter rects.
//   - gutter: each node's entry-gutter rect (entryGutterRects), a first-class
//             obstacle so a run stays out of a foreign node's entry corridor.
// Pure: rects are a deterministic function of node geometry and the gutter
// column counts derived from the edges.

// Overhang a padded card rect adds around a node's raw box. RIGHT carries the
// source port stub; LEFT the wider of the target stub and the entry chip; Y the
// chamfer bevel.
const OBSTACLE_PAD_RIGHT = PORT_STUB;
export const OBSTACLE_PAD_LEFT = Math.max(
  PORT_STUB,
  ENTRY_CHIP_OFFSET + (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2,
);
export const OBSTACLE_PAD_Y = CHAMFER;

// nodeId identifies the node an obstacle belongs to, so a consumer can exempt an
// edge's OWN target card / gutter (the default rise and backward entry columns
// sit inside their own target's padded left band by construction) while
// treating every foreign rect as blocked.
export type PaddedObstacle = ObstacleRect & {
  kind: "card" | "gutter";
  nodeId: string;
};

export function paddedObstacles(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): PaddedObstacle[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);
  const out: PaddedObstacle[] = [];
  for (const node of nodes) {
    const left = absoluteLeft(node, byId);
    const top = absoluteTop(node, byId);
    out.push({
      left: left - OBSTACLE_PAD_LEFT,
      right: left + nodeWidth(node) + OBSTACLE_PAD_RIGHT,
      top: top - OBSTACLE_PAD_Y,
      bottom: top + nodeHeight(node) + OBSTACLE_PAD_Y,
      kind: "card",
      nodeId: node.id,
    });
  }
  for (const [nodeId, g] of entryGutterRects(nodes, edges)) {
    out.push({ ...g, kind: "gutter", nodeId });
  }
  return out;
}

// -- Obstacle-free vertical columns -------------------------------------------
//
// clearColumnX is the x-axis analog of clearRailY: given a vertical run at
// `desiredX` spanning [yLo, yHi], move it to the nearest column that no obstacle
// pierces. Only obstacles whose y-extent the run overlaps can block it (a card in
// a distant row is irrelevant, exactly as clearRailY ignores cards outside its
// x-span). Each blocking obstacle is padded by `gap` so the returned column keeps
// clear air off the card edge, and two obstacles closer than 2*gap merge into one
// no-go band (a candidate that would land between them fails the clear test and
// is skipped, pushing the column to the outer edge).
//
// Nearest clear column to `desiredX`; ties break toward the target side
// (towardTarget: +1 target to the right, -1 to the left). An `accept` predicate
// further gates every candidate (including the desired column): the caller uses
// it to require that the CONNECTING horizontal leg to the column stays clear,
// so a cleared vertical never trades its own clearance for a horizontal that
// slices the card it dodged. If no clear column exists within `radius` of the
// desired one, return `desiredX` unchanged (degraded but stable -- the
// segment-vs-card audit quantifies the residual rather than flinging the run
// across the graph). Pure and deterministic: a function of the sorted obstacle
// list (and the pure accept) only.
export const CLEAR_COLUMN_RADIUS = RECIPE_WIDTH + BETWEEN_LAYERS_SPACING;

export function clearColumnX(
  desiredX: number,
  yLo: number,
  yHi: number,
  obstacles: ReadonlyArray<ObstacleRect>,
  opts?: {
    towardTarget?: number;
    radius?: number;
    gap?: number;
    accept?: (x: number) => boolean;
  },
): number {
  const gap = opts?.gap ?? CHAMFER;
  const radius = opts?.radius ?? CLEAR_COLUMN_RADIUS;
  const toward = opts?.towardTarget ?? 0;
  const accept = opts?.accept ?? (() => true);
  const ymin = Math.min(yLo, yHi);
  const ymax = Math.max(yLo, yHi);
  // Only obstacles whose vertical extent the run overlaps can block it.
  const spanned = obstacles
    .filter((o) => o.bottom > ymin && o.top < ymax)
    .sort((a, b) => a.left - b.left || a.right - b.right);
  const blocked = (x: number): boolean =>
    spanned.some((o) => x > o.left - gap && x < o.right + gap);
  if (!blocked(desiredX) && accept(desiredX)) return desiredX;

  // The nearest clear column sits just outside some spanning obstacle's padded
  // band. Gather both padded edges of every obstacle, drop any that are still
  // blocked (they fall inside a neighbour's band), rejected by the caller's
  // accept, or beyond the search radius, and pick the nearest surviving
  // candidate, tie-breaking toward the target.
  const candidates = spanned
    .flatMap((o) => [o.left - gap, o.right + gap])
    .sort((a, b) => a - b);
  let best: number | undefined;
  for (const x of candidates) {
    if (Math.abs(x - desiredX) > radius) continue;
    if (blocked(x)) continue;
    if (!accept(x)) continue;
    if (best === undefined) {
      best = x;
      continue;
    }
    const dNew = Math.abs(x - desiredX);
    const dBest = Math.abs(best - desiredX);
    if (dNew < dBest) {
      best = x;
    } else if (dNew === dBest) {
      // Equidistant on opposite sides: prefer the column toward the target.
      const preferX = toward > 0 ? x > best : toward < 0 ? x < best : x < best;
      if (preferX) best = x;
    }
  }
  return best ?? desiredX;
}

// Raw (unpadded) card rectangles, one per node, tagged with the node id. The
// side-keeping fallback below resolves against these when no fully padded-clear
// column exists: a run that at least threads the raw gaps never slices a card
// the user sees, even where sibling paddings overlap and the padded model calls
// the whole corridor blocked.
function rawCardRects(nodes: ReadonlyArray<RFAnyNode>): PaddedObstacle[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);
  return nodes.map((node) => {
    const left = absoluteLeft(node, byId);
    const top = absoluteTop(node, byId);
    return {
      left,
      right: left + nodeWidth(node),
      top,
      bottom: top + nodeHeight(node),
      kind: "card" as const,
      nodeId: node.id,
    };
  });
}

// Does the horizontal connecting leg from a port at (portX, portY) out to a
// vertical column at `x` cross any of the given card rects? Open-interval test
// on y so a leg running exactly along a padded boundary does not count.
function connectingLegBlocked(
  portX: number,
  portY: number,
  x: number,
  cards: ReadonlyArray<PaddedObstacle>,
): boolean {
  const lo = Math.min(portX, x);
  const hi = Math.max(portX, x);
  return cards.some(
    (o) => o.right > lo && o.left < hi && portY > o.top && portY < o.bottom,
  );
}

// Side-keeping column resolver shared by the bus drop / rise and backward-rail
// clamps. Resolves a vertical run's column in two tiers:
//   1. padded: clearColumnX over the full padded card + gutter set, accepting
//      only columns whose connecting horizontal (from the port that anchors the
//      run) stays clear of foreign PADDED cards -- so a moved column never puts
//      its own connecting leg through the card it dodged;
//   2. raw fallback: when no padded-clear column passes, retry against RAW
//      foreign card boxes with a slim gap and a doubled radius, accepting only
//      columns whose connecting leg clears the raw boxes. Threading a raw gap
//      beats keeping a default column that slices a card outright.
// When even the fallback fails, the desired column is returned unchanged
// (degraded but stable; the audit quantifies it). Pure and deterministic.
function clearColumnKeepingLeg(args: {
  desired: number;
  portX: number;
  portY: number;
  yLo: number;
  yHi: number;
  toward: number;
  foreignPadded: ReadonlyArray<PaddedObstacle>;
  foreignRawCards: ReadonlyArray<PaddedObstacle>;
}): number {
  const {
    desired,
    portX,
    portY,
    yLo,
    yHi,
    toward,
    foreignPadded,
    foreignRawCards,
  } = args;
  const paddedCards = foreignPadded.filter((o) => o.kind === "card");
  const ymin = Math.min(yLo, yHi);
  const ymax = Math.max(yLo, yHi);
  const columnClear = (
    x: number,
    set: ReadonlyArray<PaddedObstacle>,
    gap: number,
  ): boolean =>
    !set.some(
      (o) =>
        o.bottom > ymin &&
        o.top < ymax &&
        x > o.left - gap &&
        x < o.right + gap,
    );

  // Tier 1: padded set, padded-card leg acceptance.
  const paddedAccept = (x: number): boolean =>
    !connectingLegBlocked(portX, portY, x, paddedCards);
  const padded = clearColumnX(desired, yLo, yHi, foreignPadded, {
    towardTarget: toward,
    accept: paddedAccept,
  });
  if (columnClear(padded, foreignPadded, CHAMFER) && paddedAccept(padded)) {
    return padded;
  }

  // Tier 2: raw fallback. A slim gap keeps a hair of air off the raw box; the
  // doubled radius lets a fully packed near corridor escape to the next gap.
  const RAW_GAP = 2;
  const rawAccept = (x: number): boolean =>
    !connectingLegBlocked(portX, portY, x, foreignRawCards);
  const raw = clearColumnX(desired, yLo, yHi, foreignRawCards, {
    towardTarget: toward,
    gap: RAW_GAP,
    radius: 2 * CLEAR_COLUMN_RADIUS,
    accept: rawAccept,
  });
  if (columnClear(raw, foreignRawCards, RAW_GAP) && rawAccept(raw)) {
    return raw;
  }
  return desired;
}

// clearBusColumns: move each bus member's drop and rise verticals off any foreign
// padded card / gutter they would pierce. The drop vertical runs from the source
// port down to the shared lane; the rise vertical from the lane up to the target
// port, crossing every row between the lane band and the target. When the default
// drop column, or the entryX-staggered rise column, sits inside foreign geometry,
// stamp a cleared { dropX } / { riseX } for chamferBusPath. Own source (drop) and
// own target (rise) cards / gutters are exempt: the default columns sit inside
// their own node's padded band by construction, so only foreign rects block.
// Column resolution is side-keeping (clearColumnKeepingLeg): a candidate column
// is accepted only when the connecting horizontal from the port also stays clear,
// with a raw-gap fallback where sibling paddings overlap.
//
// Runs AFTER assignEntryColumns so the rise's desired column is the final
// staggered entryX (clearance starts from the stagger and only moves it when it
// pierces foreign geometry; riseX then overrides entryX in chamferBusPath). The
// narrow-forward hairpin member has no distinct drop / rise column (both collapse
// onto the corridor midpoint), so it is left untouched. Threads { dropX } /
// { riseX } onto the moved edges; every other edge passes through by reference.
// Pure and deterministic.
export function clearBusColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);
  const budget = 2 * (PORT_STUB + CHAMFER);

  const dropXByIndex = new Map<number, number>();
  const riseXByIndex = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "bus") return;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    const data = edge.data as BusEdgeData | undefined;
    if (data === undefined || !("laneY" in data)) return;
    const laneY = data.laneY;
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const tx = absoluteLeft(target, byId);
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const gap = tx - sx;
    // Only the drop-lane-rise forms have distinct columns to clear; the narrow
    // forward hairpin (0 < gap < budget) collapses both onto the midpoint.
    if (gap > 0 && gap < budget) return;
    const toward = gap > 0 ? 1 : -1;

    // Drop vertical: source port level down to the lane, side-keeping (the
    // connecting horizontal from the source port must stay clear too). Exempt
    // the source's own card / gutter (the default column sits a chamfer off its
    // padded right edge) and the source's own container box (a grouped source's
    // drop legitimately leaves through its container; treating the container as
    // an obstacle would reject every candidate and degrade the column).
    const dropExempt = new Set<string>([edge.source]);
    if (source.parentId !== undefined) dropExempt.add(source.parentId);
    const dropDesired = sx + PORT_STUB + CHAMFER;
    const dropX = clearColumnKeepingLeg({
      desired: dropDesired,
      portX: sx,
      portY: sy,
      yLo: sy,
      yHi: laneY,
      toward,
      foreignPadded: obstacles.filter((o) => !dropExempt.has(o.nodeId)),
      foreignRawCards: rawCards.filter((o) => !dropExempt.has(o.nodeId)),
    });
    if (dropX !== dropDesired) dropXByIndex.set(index, dropX);

    // Rise vertical: lane up to the target port, side-keeping (the connecting
    // horizontal into the target port must stay clear too). Its desired column
    // is the staggered entryX when present (keep the stagger; only move it off
    // foreign geometry). Exempt the target's own card / gutter and the target's
    // own container box (same rationale as the drop side).
    const riseExempt = new Set<string>([edge.target]);
    if (target.parentId !== undefined) riseExempt.add(target.parentId);
    const riseDesired =
      (edge.data as { entryX?: number } | undefined)?.entryX ??
      tx - PORT_STUB - CHAMFER;
    const riseX = clearColumnKeepingLeg({
      desired: riseDesired,
      portX: tx,
      portY: ty,
      yLo: ty,
      yHi: laneY,
      toward,
      foreignPadded: obstacles.filter((o) => !riseExempt.has(o.nodeId)),
      foreignRawCards: rawCards.filter((o) => !riseExempt.has(o.nodeId)),
    });
    if (riseX !== riseDesired) riseXByIndex.set(index, riseX);
  });

  if (dropXByIndex.size === 0 && riseXByIndex.size === 0) {
    return edges.map((e) => e);
  }
  return edges.map((edge, index) => {
    const dropX = dropXByIndex.get(index);
    const riseX = riseXByIndex.get(index);
    if (dropX === undefined && riseX === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(dropX !== undefined ? { dropX } : {}),
        ...(riseX !== undefined ? { riseX } : {}),
      },
    };
  });
}

// clampBackwardRails: give each backward item edge's detour rail a y that clears
// the cards it horizontally spans, so a recycle rail no longer slices through
// its own source / target cards or the columns between them. Mirrors the bus
// lane band's obstacle avoidance (clearRailY): the padded obstacle provider
// supplies the rectangles, and the rail moves just clear of the ones its
// horizontal run crosses. Because those rects now carry the port-stub / entry-
// chip overhang and each node's entry gutter, the rail also avoids grazing that
// overhang, not just the raw card. Threads { railY } onto the affected edges;
// every other edge passes through by reference. Runs after assignEntryColumns so
// it sees the entry column that fixes the rail's left end.
export function clampBackwardRails(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);

  const railYByIndex = new Map<number, number>();
  const railXRightByIndex = new Map<number, number>();
  const railXLeftByIndex = new Map<number, number>();
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
    const xrDesired = sx + PORT_STUB;
    const xlDesired =
      (edge.data as { entryX?: number } | undefined)?.entryX ?? tx - PORT_STUB;
    const preferredY = sy === ty ? sy + PORT_STUB + 2 * CHAMFER : (sy + ty) / 2;
    const railY = clearRailY(preferredY, xlDesired, xrDesired, obstacles);
    if (railY !== preferredY) railYByIndex.set(index, railY);

    // Clamp the two verticals out of any foreign card / gutter they pierce. The
    // right column runs from the source port down/up to the rail; the left column
    // from the rail to the target port. Each column's own node is exempt (the
    // default columns sit inside their own node's padded band), as is that
    // endpoint's own container box (a grouped endpoint's column legitimately
    // runs inside its container). The rail y is taken as fixed (computed from
    // the default columns above), so the columns only dodge along x.
    // Side-keeping: a moved column is accepted only when the connecting
    // horizontal from its port also stays clear (raw-gap fallback where
    // paddings overlap); the segment audit quantifies any residual.
    const xrExempt = new Set<string>([edge.source]);
    if (source.parentId !== undefined) xrExempt.add(source.parentId);
    const xr = clearColumnKeepingLeg({
      desired: xrDesired,
      portX: sx,
      portY: sy,
      yLo: sy,
      yHi: railY,
      toward: -1,
      foreignPadded: obstacles.filter((o) => !xrExempt.has(o.nodeId)),
      foreignRawCards: rawCards.filter((o) => !xrExempt.has(o.nodeId)),
    });
    if (xr !== xrDesired) railXRightByIndex.set(index, xr);
    const xlExempt = new Set<string>([edge.target]);
    if (target.parentId !== undefined) xlExempt.add(target.parentId);
    const xl = clearColumnKeepingLeg({
      desired: xlDesired,
      portX: tx,
      portY: ty,
      yLo: railY,
      yHi: ty,
      toward: -1,
      foreignPadded: obstacles.filter((o) => !xlExempt.has(o.nodeId)),
      foreignRawCards: rawCards.filter((o) => !xlExempt.has(o.nodeId)),
    });
    if (xl !== xlDesired) railXLeftByIndex.set(index, xl);
  });

  if (
    railYByIndex.size === 0 &&
    railXRightByIndex.size === 0 &&
    railXLeftByIndex.size === 0
  ) {
    return edges.map((e) => e);
  }
  return edges.map((edge, index) => {
    const railY = railYByIndex.get(index);
    const railXRight = railXRightByIndex.get(index);
    const railXLeft = railXLeftByIndex.get(index);
    if (
      railY === undefined &&
      railXRight === undefined &&
      railXLeft === undefined
    ) {
      return edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(railY !== undefined ? { railY } : {}),
        ...(railXRight !== undefined ? { railXRight } : {}),
        ...(railXLeft !== undefined ? { railXLeft } : {}),
      },
    };
  });
}

// jogForwardLegs: bend a forward item edge's final approach leg around any
// intervening card it would otherwise cross. A forward normal step runs its last
// horizontal leg at the target-port y from the bend column to the target; on a
// layer-skipping edge that leg can slice straight through a node card sitting at
// the same row one layer over. When the padded obstacle provider reports the leg
// blocked, stamp a { legY }: the drawer then bends the run down / up to that
// clear y, carries the long horizontal there, and only descends into the target
// in its own entry gutter. The bend column already sits in a node-free corridor
// (assignBendColumns), so its vertical stays clear at any legY; only the long
// horizontal needs the clearance, which clearRailY supplies exactly as it does
// for the backward detour rail. Exempt from the obstacle scan: the target's own
// card / gutter (the leg ends inside it) and each endpoint's own container box (a
// group background the edge legitimately enters, not an obstacle to route
// around). A foreign container in an intermediate layer still blocks.
//
// The detour level is chosen by a per-obstacle candidate scan (the y-axis analog
// of clearColumnX): each card the straight step's span crosses offers its padded
// top-gap and bottom-gap as a candidate rail, tried nearest-to-ty first. A
// candidate is accepted only when its ENTIRE jog is clear -- the entry vertical,
// the long horizontal, the descent column (itself moved clear via clearColumnX,
// starting from the target's next free entry slot), and the final stub into the
// port. The SOURCE horizontal at sy gets the symmetric treatment: when it is the
// blocked piece, the step leaves sy at a cleared column just out of the source
// port (srcColX, replacing the bend column) instead of running to the bend
// first; with a clear final leg that collapses to a single srcColX column
// straight to ty. Two obstacle tiers: full padded quality first, then a
// raw-card fallback where overlapping sibling paddings leave no padded-clear
// jog (threading the raw gaps beats keeping a straight leg through a card).
// When no candidate clears in either tier, the edge keeps its straight leg --
// no worse than before -- and the residual is left for a deeper routing pass
// rather than a jog that fights itself.
//
// Runs after assignBendColumns so it reads each edge's FINAL bendX (the leg
// starts at that column). Only the normal forward step has a distinct final leg
// to jog; the same-y straight line and small-dy diagonal are left to their own
// branches, which do not read legY. Threads { legY } onto the affected edges;
// every other edge passes through by reference. Pure and deterministic.
export function jogForwardLegs(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = new Map<string, RFAnyNode>();
  for (const n of nodes) byId.set(n.id, n);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);
  const budget = 2 * (PORT_STUB + CHAMFER);

  // Descent-slot occupancy per target (jog descents coordinate with entry
  // columns): a target hosting k gutter columns (backward rails / bus rises)
  // owns slots tx-PORT_STUB .. tx-PORT_STUB-(k-1)*pitch, so a jogged descent
  // starts one pitch further left, and each additional jog into the same
  // target takes the next slot leftward. This is the gutter-occupant
  // registration for jogs: no two jogs into one target, and no jog vs rail /
  // rise pair, ever draw coincident verticals at the default column.
  const gutterCounts = gutterColumnCounts(edges, byId);
  const jogsByTarget = new Map<string, number>();

  const legYByIndex = new Map<number, number>();
  const descentXByIndex = new Map<number, number>();
  const srcColXByIndex = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return; // only forward item edges take the step
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    if (nodeGap(source, target, byId) <= 0) return; // backward / zero-gap edge
    const item = edgeItem(edge);
    const sx = absoluteLeft(source, byId) + nodeWidth(source);
    const tx = absoluteLeft(target, byId);
    const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
    const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
    const gap = tx - sx;
    // Only the normal forward step draws a distinct final horizontal leg: the
    // same-y case is a straight line and the small-dy case a single diagonal,
    // neither of which reads legY. Mirror chamferStepPath's branch guards so a
    // stamped hint is always one the drawer consumes.
    const scale = gap >= budget ? 1 : gap / budget;
    const stub = PORT_STUB * scale;
    const chamfer = CHAMFER * scale;
    if (sy === ty) return;
    if (Math.abs(ty - sy) <= 2 * chamfer) return;
    // Bend column, exactly as chamferStepPath's forward normal step derives it,
    // so the leg's start x matches the drawn path.
    const lo = sx + stub + chamfer;
    const hi = tx - stub - chamfer;
    const mid = (sx + tx) / 2;
    const bendHint = (edge.data as { bendX?: number } | undefined)?.bendX;
    const bx =
      lo < hi && bendHint !== undefined
        ? Math.min(Math.max(bendHint, lo), hi)
        : mid;
    // The jog runs the long horizontal from its entry column to the descent
    // column, then descends into the target port. The descent's desired column
    // is the target's next free entry slot (see occupancy above).
    const occupied =
      (gutterCounts.get(edge.target) ?? 0) +
      (jogsByTarget.get(edge.target) ?? 0);
    const descentX0 = tx - PORT_STUB - occupied * ENTRY_SLOT_PITCH;

    // Exempt from the obstacle scan: both endpoints' own cards / gutters (the leg
    // leaves the source and ends inside the target) and each endpoint's own
    // container box (a group background the edge legitimately enters, not an
    // obstacle to route around). A foreign container in an intermediate layer
    // stays an obstacle. Horizontal legs may cross a foreign entry gutter (every
    // entering leg does), so the leg tests only foreign CARDS; vertical runs
    // (bend, descent, source column) must also stay out of foreign gutters, so
    // they test the full card + gutter set. Each obstacle tier (padded first,
    // raw-card fallback where sibling paddings overlap) carries its own leg /
    // column tests.
    const exempt = new Set<string>([edge.source, edge.target]);
    if (source.parentId !== undefined) exempt.add(source.parentId);
    if (target.parentId !== undefined) exempt.add(target.parentId);
    const foreignCards = obstacles.filter(
      (o) => o.kind === "card" && !exempt.has(o.nodeId),
    );
    const foreignAll = obstacles.filter((o) => !exempt.has(o.nodeId));
    const foreignRaw = rawCards.filter((o) => !exempt.has(o.nodeId));
    const legBlockedIn = (
      set: ReadonlyArray<PaddedObstacle>,
      y: number,
      x0: number,
      x1: number,
    ): boolean =>
      set.some(
        (o) =>
          o.right > Math.min(x0, x1) &&
          o.left < Math.max(x0, x1) &&
          y > o.top &&
          y < o.bottom,
      );
    const vRunBlockedIn = (
      set: ReadonlyArray<PaddedObstacle>,
      x: number,
      y0: number,
      y1: number,
    ): boolean =>
      set.some(
        (o) =>
          o.left < x &&
          o.right > x &&
          o.top < Math.max(y0, y1) &&
          o.bottom > Math.min(y0, y1),
      );

    // Nothing to jog unless the straight step is dirty: the final leg at ty or
    // the SOURCE horizontal at sy out to the bend column crosses a foreign
    // card. (A blocked bend VERTICAL with both legs clean is the demotion
    // binding's concern -- routeBusEdges stamps a proven bendX -- not a jog.)
    const tgtBlocked = legBlockedIn(foreignCards, ty, bx, descentX0);
    const srcBlocked = legBlockedIn(foreignCards, sy, sx, bx);
    if (!tgtBlocked && !srcBlocked) return;

    // Try one obstacle tier: find (entry column C, rail level R, descent D)
    // with every piece clear in this tier's card / obstacle sets. R candidates:
    // ty itself (single-column shape, only useful when the source leg is the
    // blocked piece) plus each spanned card's padded top / bottom gap, nearest
    // to ty first so the jog takes the smallest vertical excursion.
    type Jog = { C: number; R: number; D: number };
    const tryTier = (
      cardSet: ReadonlyArray<PaddedObstacle>,
      columnSet: ReadonlyArray<PaddedObstacle>,
      pad: number,
      colGap: number,
    ): Jog | null => {
      const spanning = cardSet.filter((o) => o.right > sx && o.left < tx);
      const rails = [
        ...new Set(spanning.flatMap((o) => [o.top - pad, o.bottom + pad])),
      ].sort((a, b) => Math.abs(a - ty) - Math.abs(b - ty));
      const candidates = srcBlocked ? [ty, ...rails] : rails;
      for (const R of candidates) {
        // Entry column: the bend column when the source leg is clean, else a
        // cleared column just out of the source port whose own stub leg stays
        // clear.
        let C = bx;
        if (srcBlocked) {
          const desiredC = sx + PORT_STUB + CHAMFER;
          C = clearColumnX(
            desiredC,
            Math.min(sy, R),
            Math.max(sy, R),
            columnSet,
            {
              towardTarget: 1,
              gap: colGap,
              accept: (x) =>
                x > sx && x < tx && !legBlockedIn(cardSet, sy, sx, x),
            },
          );
          if (
            vRunBlockedIn(columnSet, C, sy, R) ||
            legBlockedIn(cardSet, sy, sx, C)
          ) {
            continue;
          }
        } else if (vRunBlockedIn(columnSet, bx, sy, R)) {
          continue;
        }
        if (R === ty) {
          // Single-column shape: C from sy straight to ty, then the long
          // horizontal at ty into the target.
          if (legBlockedIn(cardSet, ty, C, tx)) continue;
          return { C, R, D: descentX0 };
        }
        // The descent must stay left of the target port (final approach runs
        // rightward into the Left handle; a column at or past tx would reverse
        // the closing stub and flip the arrow).
        const D = clearColumnX(
          descentX0,
          Math.min(R, ty),
          Math.max(R, ty),
          columnSet.filter((o) => o.nodeId !== edge.target),
          {
            towardTarget: 1,
            gap: colGap,
            accept: (x) =>
              x <= tx - CHAMFER && !legBlockedIn(cardSet, ty, x, tx),
          },
        );
        if (D > tx - CHAMFER) continue;
        if (legBlockedIn(cardSet, R, C, D)) continue;
        if (vRunBlockedIn(columnSet, D, R, ty)) continue;
        if (legBlockedIn(cardSet, ty, D, tx)) continue;
        return { C, R, D };
      }
      return null;
    };

    // Padded tier first (full quality), then the raw-card fallback where
    // overlapping sibling paddings leave no padded-clear jog: threading the raw
    // gaps beats keeping a straight leg through a card.
    const jog =
      tryTier(foreignCards, foreignAll, CHAMFER, CHAMFER) ??
      tryTier(foreignRaw, foreignRaw, 2, 2);
    if (jog === null) return; // no clear jog -> straight leg residual

    if (jog.R !== ty) {
      legYByIndex.set(index, jog.R);
      if (jog.D !== tx - PORT_STUB) descentXByIndex.set(index, jog.D);
      jogsByTarget.set(edge.target, (jogsByTarget.get(edge.target) ?? 0) + 1);
    }
    if (srcBlocked) srcColXByIndex.set(index, jog.C);
  });

  if (
    legYByIndex.size === 0 &&
    srcColXByIndex.size === 0 &&
    descentXByIndex.size === 0
  ) {
    return edges.map((e) => e);
  }
  return edges.map((edge, index) => {
    const legY = legYByIndex.get(index);
    const jogDescentX = descentXByIndex.get(index);
    const srcColX = srcColXByIndex.get(index);
    if (legY === undefined && srcColX === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(legY !== undefined ? { legY } : {}),
        ...(jogDescentX !== undefined ? { jogDescentX } : {}),
        ...(srcColX !== undefined ? { srcColX } : {}),
      },
    };
  });
}

