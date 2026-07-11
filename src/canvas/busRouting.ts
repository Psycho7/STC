// Phase-2 declutter pass: classify the remaining long edges into horizontal
// "bus" trunks and assign each trunk a lane in one of two bands -- above or below
// the graph -- picked by where the trunk's members lean (Task 13).
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
  ENTRY_CHIP_OFFSET,
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

function edgeItem(edge: Edge): string | undefined {
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
      if (!forwardBendColumnClear(source, target, item, byId, obstacles)) {
        continue; // no clear vertical bend column -> keep the lane
      }
      trunkKeyByEdgeIndex.delete(index);
      trunks.delete(trunkKey);
    }
  }

  if (trunkKeyByEdgeIndex.size === 0) return edges.map((e) => e);

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
    if (data?.laneY === undefined) continue;
    (data.busBand === "top" ? topYs : bottomYs).push(data.laneY);
  }
  const extent = (ys: number[]): BandExtent | null =>
    ys.length === 0 ? null : { y0: Math.min(...ys), y1: Math.max(...ys) };
  return { top: extent(topYs), bottom: extent(bottomYs) };
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

// Does a demoted forward edge have a clear vertical bend column? A demoted
// single-member trunk (Task 12) draws a normal forward step whose bend is a
// vertical run between the source and target rows. forwardCorridorClear proves
// the horizontal legs clear, but that vertical can still slice a card stacked in
// the inter-layer gap -- so demotion additionally requires that SOME column in
// [sx, tx] spanning sy..ty is pierced by no foreign card. A same-y / small-dy
// route (|ty - sy| <= a chamfer) draws no vertical run and needs no column. Uses
// the same card-only foreign set (own source / target and their containers
// exempt) as the corridor gate, so a demotion never leaves a bend crossing a
// card the segment audit would then flag. Any unproven column keeps the lane.
function forwardBendColumnClear(
  source: RFAnyNode,
  target: RFAnyNode,
  item: string | undefined,
  byId: ReadonlyMap<string, RFAnyNode>,
  obstacles: ReadonlyArray<PaddedObstacle>,
): boolean {
  const sx = absoluteLeft(source, byId) + nodeWidth(source);
  const tx = absoluteLeft(target, byId);
  const sy = absoluteTop(source, byId) + portOffsetY(source, item, "out");
  const ty = absoluteTop(target, byId) + portOffsetY(target, item, "in");
  if (Math.abs(ty - sy) <= 2 * CHAMFER) return true; // no vertical run to place
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
  // Candidate columns: one stub inside each port, plus each spanned card's padded
  // edges, restricted to the span. A demotion is safe iff one of them is clear.
  const candidates = [
    sx + PORT_STUB,
    tx - PORT_STUB,
    ...spanned.flatMap((o) => [o.left - gap, o.right + gap]),
  ].filter((x) => x >= sx && x <= tx);
  return candidates.some((x) => !blocked(x));
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
const OBSTACLE_PAD_LEFT = Math.max(
  PORT_STUB,
  ENTRY_CHIP_OFFSET + (MAX_CHIP_SCALE * ENTRY_CHIP_BOX_WIDTH) / 2,
);
const OBSTACLE_PAD_Y = CHAMFER;

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
    if (data?.laneY === undefined) return;
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
    // column, then descends into the target port. descentX0 is the target's
    // entry gutter (its staggered entry column, else one stub before the port).
    const descentX0 =
      (edge.data as { entryX?: number } | undefined)?.entryX ?? tx - PORT_STUB;

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

// Seat a chip at its preferred anchor, cascading it in `step`-sized increments
// until it clears every box already in `placed`, then record it. Returns the
// signed offset applied (0 when the anchor was already clear). `step` defaults
// to a downward CHIP_NUDGE_STEP; a top-band bus chip passes -CHIP_NUDGE_STEP so
// it cascades UP, away from the graph below it, instead of walking into the
// nodes. Deterministic given a fixed placement order.
function seatChip(
  placed: ChipBox[],
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  step: number = CHIP_NUDGE_STEP,
): number {
  let dy = 0;
  while (
    placed.some((box) => chipBoxesOverlap(box, { x, y: y + dy, halfW, halfH }))
  ) {
    dy += step;
  }
  placed.push({ x, y: y + dy, halfW, halfH });
  return dy;
}

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
    const entryX = absoluteLeft(byId.get(targetId)!, byId) - ENTRY_CHIP_OFFSET;
    const stacked = stackEntryAnchors(list.map((s) => s.anchorY));
    list.forEach((s, i) => {
      const y = stacked[i]!;
      const dy = y - s.anchorY;
      if (dy !== 0) entryDyByIndex.set(s.index, dy);
      placed.push({
        x: entryX,
        y,
        halfW: CHIP_HALF_W_ENTRY,
        halfH: CHIP_HALF_H,
      });
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
    step: number;
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
      // Top-band chips cascade UP (away from the graph below them); bottom-band
      // and un-banded chips cascade DOWN. Signed step drives seatChip's walk.
      step: data.busBand === "top" ? -CHIP_NUDGE_STEP : CHIP_NUDGE_STEP,
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
      slot.step,
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
      slot.step,
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
