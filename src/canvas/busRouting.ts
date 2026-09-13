// Whole-graph pre-render ROUTING passes for the blueprint canvas. Layout runs
// them in order after ELK places the nodes, each consuming the previous ones'
// stamps; ROUTING_PASSES in layout.ts is that order, with a per-entry note on
// what each pass does.
// Every pass is pure and deterministic: no React, no Date/random, no mutation
// of the inputs. Nodes are read only for geometry (absolute positions and
// sizes); they pass through untouched. Passes merge routing fields onto edge
// `data` (bus members are retyped `type: "bus"`).
//
// The sixth and final pipeline pass -- chip seating (deconflictChipAnchors)
// -- lives in chipSeating.ts; it consumes this module's edge-data readers and
// padding constants. The model-frame node accessors both modules read live in
// nodeGeometry.ts.

import type { Edge } from "@xyflow/react";
import Fraction from "fraction.js";

import {
  BETWEEN_LAYERS_SPACING,
  ENTRY_GUTTER_OVERHANG,
  RECIPE_WIDTH,
} from "./dimensions";
import {
  CHAMFER,
  FORWARD_STEP_BUDGET,
  PORT_STUB,
  backwardRailDefaults,
  clamp,
  clearRailY,
  forwardStepGeometry,
  type ObstacleRect,
} from "./edgePath";
import {
  absoluteLeft,
  absoluteTop,
  edgeItem,
  nodeHeight,
  nodeIndexOf,
  nodeWidth,
  portOffsetY,
} from "./nodeGeometry";
import {
  COLUMN_PITCH,
  buildLayerModel,
  classifyTrunks,
  type Trunk,
} from "./layerModel";
import type { RFAnyNode, RoutingCtx } from "./layout";
// Type-only: ItemEdge.tsx declares the base canvas edge payload these passes
// stamp onto and read back. Erased at compile time, so it adds no runtime or
// bundler edge, and ItemEdge imports none of this module.
import type { ItemEdgeData } from "./ItemEdge";

// Trunk-aggregate fields of a fan-out trunk. Every
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

// A bus member owns its trunk's shared drawings (the trunk segment, junction
// dot, and aggregate chip) unless explicitly flagged otherwise. ABSENT data, or
// an absent busChipOwner, counts as OWNER, so an un-annotated fixture keeps the
// whole-group highlight and its aggregate chip. One helper owns that default
// for every reader that agrees with it, instead of the same `!== false` /
// `?? true` rule being restated at each site. The parameter is PARTIAL because
// chipSeating's flat chip-anchor view carries busChipOwner without trunkKey; the
// helper reads only the one field, so the wider shape costs nothing.
export function isTrunkOwner(data: Partial<BusAggregate> | undefined): boolean {
  return data?.busChipOwner ?? true;
}

// Fan-out trunk member (routeFanoutEdges). Retyped `type: "bus"` -- so Canvas
// trunk adjacency and hover-dim pick it up -- and it consolidates N
// same-source-port edges onto one shared junction column in a single layer gap.
// `fanout: true` is always set, so BusEdge draws the short in-corridor trunk
// (chamferFanoutPath). `junctionX` is the shared column, the slot the trunk
// took in its gap's reserved column zone. The aggregate reuses
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
  // seating pass reruns only when a drag ends, so mid-drag BusEdge drops a
  // hide whose live recomputed anchor no longer matches the stamp.
  fanoutBranchHidden?: true;
  fanoutBranchHiddenAt?: { x: number; y: number };
  // Set by deconflictChipAnchors when this member's whole polyline is shorter
  // than one rendered chip: BusEdge collapses the branch chip to its icon-only
  // variant at every zoom, the same rule chipIconOnly applies to a short item
  // edge. The full box is wider than such a leg, so no seat on it can keep the
  // chip off the trunk's split dot; the narrow box can. The rate stays readable
  // on the chip's aria-label and hover title.
  fanoutBranchIconOnly?: true;
};

// Data fields the bus pass merges onto a member edge's existing `data`. Every
// bus-typed edge is a fan-out member, so the payload is that one shape.
export type BusEdgeData = FanoutBusEdgeData;

// Read a Fraction rate off an edge's data, or undefined when it is absent or not
// a Fraction (older fixtures may omit it). Exported because the chip-seating
// pass reads the same field to predict a chip's drawn text, and two readers of
// one loosely typed field would be free to disagree about what counts as a rate.
export function edgeRate(edge: Edge): Fraction | undefined {
  // Deliberately weaker than ItemEdgeData: older fixtures carry a non-Fraction
  // rate, so the guard below has to see `unknown` rather than a claimed type.
  const rate = (edge.data as { rate?: unknown } | undefined)?.rate;
  return rate instanceof Fraction ? rate : undefined;
}

// The four port coordinates of one edge: the source's out-port on its right
// edge and the target's in-port on its left edge, each at the row the edge's
// item resolves to. Null when either endpoint is missing from the node index --
// the guard every caller used to write by hand.
//
// This is the MODEL frame, the coordinate the layout places by and every
// routing pass reasons in. Its sibling drawnPortsOf in nodeGeometry.ts answers
// the same four names in the DRAWN frame (model plus PORT_DRIFT). The two are
// never merged: the gap between them is 1-2 units, exactly where the ratcheted
// occlusion and crossing counts turn, so comparing a model value against drawn
// geometry is a real error, not a rounding one.
export function edgePortsModel(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): { sx: number; sy: number; tx: number; ty: number } | null {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return null;
  const item = edgeItem(edge);
  return {
    sx: absoluteLeft(source, byId) + nodeWidth(source),
    sy: absoluteTop(source, byId) + portOffsetY(source, item, "out"),
    tx: absoluteLeft(target, byId),
    ty: absoluteTop(target, byId) + portOffsetY(target, item, "in"),
  };
}

// Key of one FLOW: the (item, source unit) pair leaving a single out-port. A
// recipe out-port carries exactly one item, so item plus source id names the
// port, and every edge sharing the key draws as one physical line. Fan-out
// trunks (routeFanoutEdges) key on it -- that is the `trunkKey` they stamp --
// and chip seating reuses it to decide which lines a chip may legitimately sit
// on. Built here so the callers cannot drift on the separator or on how a
// missing item is spelled.
export function flowKeyOf(item: string | undefined, source: string): string {
  return (item ?? "?") + "|" + source;
}

// Numeric index encoded in an ELK edge id, or null for a hand-built id. layout's
// renderEdgeToElk writes ids shaped like "e:<index>:<from>-><to>:<item>", and
// that index is the one stable per-edge rank the routing passes have: the passes
// that hand out slots first-come (jog descent columns)
// order on it so their output does not depend on where an edge happens to sit in
// the input array. It has to be the NUMERIC index -- a lexicographic id sort
// would put "e:10" before "e:2" and swap two slots that are pinned by geometry.
export function parseElkEdgeIndex(id: string): number | null {
  if (!id.startsWith("e:")) return null;
  const rest = id.slice(2);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const n = Number.parseInt(rest.slice(0, colon), 10);
  return Number.isFinite(n) ? n : null;
}

// Total order for the slot-handing passes: ELK-indexed edges rank by their
// index, unindexed ids (hand-built fixtures) sort after all of them, and array
// position breaks every remaining tie. Ranking unindexed ids as +Infinity rather
// than special-casing the mixed pair keeps the comparator transitive. Real
// layouts are entirely ELK-indexed, so the pass output there is independent of
// input order; a fixture with no indexed ids keeps its array order untouched.
function byRoutingOrder(
  a: { id: string; index: number },
  b: { id: string; index: number },
): number {
  const ai = parseElkEdgeIndex(a.id) ?? Infinity;
  const bi = parseElkEdgeIndex(b.id) ?? Infinity;
  return ai !== bi ? ai - bi : a.index - b.index;
}

// Exemption set for an edge's own geometry: each given endpoint node plus one
// parentId level (its container box -- a grouped endpoint's runs legitimately
// start / end inside their own group). Every obstacle filter in this module's
// routing passes shares this rule, so what counts as "own" geometry is decided
// once.
function ownExempt(nodes: ReadonlyArray<RFAnyNode>): Set<string> {
  const exempt = new Set<string>();
  for (const n of nodes) {
    exempt.add(n.id);
    if (n.parentId !== undefined) exempt.add(n.parentId);
  }
  return exempt;
}

// routeFanoutEdges: draw every fan-out trunk of the graph on one shared
// junction column. Its place in the order, and why that placement is scheduling
// rather than a dependency, is the ROUTING_PASSES entry in layout.ts.
//
// Membership is TOPOLOGICAL, not geometric: the trunks come from
// classifyTrunks, so any (item, source unit) port feeding two or more target
// units is a trunk whatever the gap widths are. Nothing here re-decides it, and
// nothing declines a trunk -- the pre-pass already widened the gap for the
// columns and chips this pass places.
//
// The column comes from the GAP RECORD the pre-pass produced (ctx.gaps). A
// trunk whose source unit sits in layer k takes a slot in gap k's column zone,
// which was reserved one COLUMN_PITCH per trunk: the slots are handed out
// top-to-bottom by source-port y (trunk key breaks ties) at
//   columnZone.left + COLUMN_PITCH / 2 + slot * COLUMN_PITCH
// so sibling trunks in one gap never share a column. Fan-in columns fill the
// same zone from the right (a later pass), which is why the zone is wider than
// the fan-out slots alone. Without a ctx -- a hand-built fixture, or a caller
// that re-runs the passes on its own -- there is no record to read and the
// column falls back to the midpoint of the source-to-nearest-target corridor,
// clamped exactly as chamferFanoutPath clamps it.
//
// A member's treatment is by LAYER DISTANCE, not pixel span:
//   next layer      retyped `type: "bus"` and stamped { fanout, trunkKey,
//                   junctionX, busTotalRate, busMemberCount, busChipOwner };
//                   BusEdge draws the in-corridor trunk (chamferFanoutPath).
//   two or more     stays `type: "item"` and only borrows the column, stamped
//                   { bendX: junctionX, fanoutColumn: true }. chamferFanoutPath
//                   would draw a straight final leg slicing the cards in
//                   between, and a bus-typed member never reaches
//                   jogForwardLegs -- so a far member keeps the item-edge
//                   passes and the shared line both. assignBendColumns leaves a
//                   pre-stamped bendX alone, so the pin holds; jogForwardLegs
//                   may still replace the column with a cleared srcColX when the
//                   source horizontal is blocked, and that member simply leaves
//                   the shared line.
//   backward        untouched here. It still counts in the trunk's total and
//                   member count, so the aggregate chip reads the whole port.
//
// Non-members pass through by reference. Pure and deterministic: membership,
// owner election (lex-smallest edge id) and the slot order depend only on the
// graph and on geometry, never on input order.
export function routeFanoutEdges(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const fanOutTrunks = classifyTrunks(nodes, edges).trunks.filter(
    (trunk) => trunk.kind === "fanOut",
  );
  if (fanOutTrunks.length === 0) return edges.map((e) => e);

  const { layerByNodeId } = buildLayerModel(nodes);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  // How far right of its source layer a member ends, which is what decides
  // whether it is drawn as a branch of the trunk (next layer) or merely pinned
  // to its column (further right). A member whose endpoints have no layer --
  // only an unplaced node can do that, and classifyTrunks already dropped
  // those -- reads as backward, the treatment that touches nothing.
  type Reach = "near" | "far" | "backward";

  type TrunkGeom = {
    trunk: Trunk;
    gapIndex: number;
    sx: number;
    sy: number;
    nearestTx: number;
    reachByEdgeId: Map<string, Reach>;
  };

  const geoms: TrunkGeom[] = [];
  for (const trunk of fanOutTrunks) {
    const members = trunk.members
      .map((id) => edgeById.get(id))
      .filter((edge): edge is Edge => edge !== undefined);
    const first = members[0];
    if (first === undefined) continue;
    const sourceLayer = layerByNodeId.get(trunk.unit);
    if (sourceLayer === undefined) continue;
    const ports = edgePortsModel(first, byId);
    if (ports === null) continue;

    const reachByEdgeId = new Map<string, Reach>();
    let nearestTx = Infinity;
    for (const member of members) {
      const targetLayer = layerByNodeId.get(member.target);
      const reach: Reach =
        targetLayer === undefined || targetLayer <= sourceLayer
          ? "backward"
          : targetLayer === sourceLayer + 1
            ? "near"
            : "far";
      reachByEdgeId.set(member.id, reach);
      if (reach === "backward") continue;
      const memberPorts = edgePortsModel(member, byId);
      if (memberPorts !== null) {
        nearestTx = Math.min(nearestTx, memberPorts.tx);
      }
    }

    geoms.push({
      trunk,
      gapIndex: sourceLayer,
      sx: ports.sx,
      sy: ports.sy,
      nearestTx,
      reachByEdgeId,
    });
  }
  if (geoms.length === 0) return edges.map((e) => e);

  // Slot order inside one gap: top-to-bottom by source port y, trunk key
  // breaking ties, so the columns follow reading order and never depend on
  // where an edge sits in the input array.
  const geomsByGap = new Map<number, TrunkGeom[]>();
  for (const geom of geoms) {
    const group = geomsByGap.get(geom.gapIndex) ?? [];
    group.push(geom);
    geomsByGap.set(geom.gapIndex, group);
  }
  const gapByIndex = new Map((ctx?.gaps ?? []).map((gap) => [gap.index, gap]));

  const junctionByTrunkKey = new Map<string, number>();
  for (const [gapIndex, group] of geomsByGap) {
    group.sort(
      (a, b) =>
        a.sy - b.sy ||
        (a.trunk.key < b.trunk.key ? -1 : a.trunk.key > b.trunk.key ? 1 : 0),
    );
    const zone = gapByIndex.get(gapIndex)?.columnZone;
    group.forEach((geom, slot) => {
      junctionByTrunkKey.set(
        geom.trunk.key,
        zone === undefined
          ? corridorMidColumn(geom.sx, geom.nearestTx)
          : zone.left + COLUMN_PITCH / 2 + slot * COLUMN_PITCH,
      );
    });
  }

  const geomByEdgeId = new Map<string, TrunkGeom>();
  for (const geom of geoms) {
    for (const id of geom.reachByEdgeId.keys()) geomByEdgeId.set(id, geom);
  }

  return edges.map((edge) => {
    const geom = geomByEdgeId.get(edge.id);
    if (geom === undefined) return edge;
    const reach = geom.reachByEdgeId.get(edge.id);
    if (reach === "backward") return edge;
    const junctionX = junctionByTrunkKey.get(geom.trunk.key)!;
    if (reach === "far") {
      return {
        ...edge,
        data: {
          ...edge.data,
          bendX: junctionX,
          fanoutColumn: true as const,
        },
      };
    }
    return {
      ...edge,
      type: "bus",
      data: {
        ...edge.data,
        fanout: true,
        trunkKey: geom.trunk.key,
        junctionX,
        busTotalRate: geom.trunk.total,
        busMemberCount: geom.trunk.members.length,
        busChipOwner: edge.id === geom.trunk.owner,
      },
    };
  });
}

// Fallback junction column with no gap record to read: the midpoint of the
// corridor from the source port to the NEAREST member's target port, clamped
// into the same [stub + chamfer, stub + chamfer] window chamferFanoutPath
// clamps a junction into, so the shared column is one the drawer will not
// re-clamp away from a tighter member. A trunk with no forward member has no
// corridor and no drawn column; the value is never read.
function corridorMidColumn(sx: number, nearestTx: number): number {
  if (!Number.isFinite(nearestTx)) return sx;
  const lo = sx + PORT_STUB + CHAMFER;
  const hi = nearestTx - PORT_STUB - CHAMFER;
  const mid = (sx + nearestTx) / 2;
  return lo < hi ? clamp(mid, lo, hi) : mid;
}

// Would a long forward edge's DIRECT (plain item-edge) corridor draw clear of
// foreign cards? The item edge routes its final leg at the target-port y from
// the bend column across to the target; on a long span that leg can slice an
// intervening card. Mirror jogForwardLegs' clear test -- clearRailY on the leg's
// y-band -- over the whole source->target extent, the most conservative bound
// since the real bend column sits somewhere inside it. Only CARD obstacles
// block: gutters guard foreign VERTICAL runs, while this test is about a
// horizontal final leg, which legitimately crosses gutter x-bands (every
// entering leg does). Own source / target cards, plus each endpoint's
// container, are exempt (same semantics as jogForwardLegs): the run
// legitimately starts / ends inside them.
function forwardCorridorClear(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
  obstacles: ReadonlyArray<PaddedObstacle>,
): boolean {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  const ports = edgePortsModel(edge, byId);
  if (source === undefined || target === undefined || ports === null) {
    return false;
  }
  const { sx, tx, ty } = ports;
  const exempt = ownExempt([source, target]);
  const foreign = obstacles.filter(
    (o) => o.kind === "card" && !exempt.has(o.nodeId),
  );
  // Final-leg y-band from just past the source port to one stub before the
  // target port. clearRailY returns ty unchanged iff nothing foreign crosses it.
  return clearRailY(ty, sx + PORT_STUB, tx - PORT_STUB, foreign) === ty;
}

// directCorridorClear: the corridor gate above, resolved from raw nodes / edges
// for one edge. Exported for the edge-span census, which asserts every non-bus
// edge spanning past the threshold has a provably clear direct corridor.
// Missing endpoints or a backward / zero gap read as not-clear.
export function directCorridorClear(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  edge: Edge,
): boolean {
  const byId = nodeIndexOf(nodes);
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return false;
  if (nodeGap(source, target, byId) <= 0) return false;
  const obstacles = paddedObstacles(nodes, edges);
  return forwardCorridorClear(edge, byId, obstacles);
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
const ENTRY_GUTTER_MIN = PORT_STUB + CHAMFER; // 32
export const ENTRY_SLOT_PITCH = 2 * CHAMFER; // 16

// Band width for a node hosting `columnCount` staggered entry columns. Zero or
// one column -> the minimal band; each extra column adds one pitch.
//
// Exported for the column suite, which asserts a node's gutter rect measures
// exactly gutterWidth(entry count) across.
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

// Node-gap between a (source, target) pair, signed: <= 0 means the target sits
// at or left of the source (a backward edge under ELK's cycle reversal). The
// drawers' own gap (tx - sx, port to port) equals this because sources are
// Right-handles and targets Left-handles.
function nodeGap(
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): number {
  const sourceRight = absoluteLeft(source, byId) + nodeWidth(source);
  return absoluteLeft(target, byId) - sourceRight;
}

// Does an edge occupy a vertical column inside its target's entry gutter? A
// backward item edge routes a left rail one stub before the port. Returns true
// for the edges that both consume a gutter slot and count toward the band's
// width. Every routed bus edge is a fan-out member, which approaches its target
// horizontally off the shared junction column and so stakes no gutter column;
// the non-fan-out arms answer only for hand-built bus edges.
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
    if ((edge.data as BusEdgeData | undefined)?.fanout === true) {
      return false;
    }
    // narrow-forward hairpin claims no column
    return gap <= 0 || gap >= FORWARD_STEP_BUDGET;
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
  const byId = nodeIndexOf(nodes);
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

// assignEntryColumns: give every gutter-occupying edge (a backward item rail) a
// per-target staggered column x, merged as { entryX } onto its data and
// consumed by chamferStepPath. Columns of one target are
// ordered by resolved input-port index so the entering runs form a monotonic
// fan that does not self-cross inside the band: the topmost port takes the
// leftmost column and the bottom port the rightmost (one stub before the port,
// which is the pre-gutter default, so a single-entry node is unchanged).
//
// Pure and deterministic: the column of an edge depends only on its target and
// port rank, never on edge order. Leaves every non-gutter edge untouched by
// reference. What it needs from the passes before it is the ROUTING_PASSES
// entry in layout.ts.
export function assignEntryColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = nodeIndexOf(nodes);

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
// deterministic. It fans only still-type:"item" edges and skips backward /
// zero-gap ones; what it needs from the passes before it is the ROUTING_PASSES
// entry in layout.ts. Non-member edges pass through by reference; members get
// { bendX } merged onto their data (consumed by chamferStepPath).
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
  const byId = nodeIndexOf(nodes);

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
  // Shared fan-out columns already claimed inside a band, keyed the same way.
  // The stagger cannot re-place these edges, but it must not fan another
  // edge's vertical onto one of them either: a staggered column half a stub
  // from a trunk column braids it, and the trunk column carries every member's
  // stroke, so the seating pass has no clear seat to slide that chip to. The
  // band's left margin below starts past them.
  const pinnedColumnsByBand = new Map<number, number[]>();
  for (const edge of edges) {
    if (edge.type !== "item") continue; // only forward item edges get staggered
    if (edgeItem(edge) === undefined) continue;
    const pinnedData = edge.data as ItemEdgeData | undefined;
    if (pinnedData?.fanoutColumn === true && pinnedData.bendX !== undefined) {
      const source = byId.get(edge.source);
      if (source !== undefined) {
        const band = Math.round(absoluteLeft(source, byId));
        const list = pinnedColumnsByBand.get(band) ?? [];
        list.push(pinnedData.bendX);
        pinnedColumnsByBand.set(band, list);
      }
    }
    // Respect a pre-stamped bendX: a demoted trunk bound to its proven clear
    // column, or a far fan-out member pinned to its trunk's shared junction
    // column. Re-fanning the first could move the bend back onto a blocked
    // column; re-fanning the second would break the formation apart into the
    // parallel verticals it exists to collapse.
    if ((edge.data as ItemEdgeData | undefined)?.bendX !== undefined) {
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
  for (const [band, list] of groups) {
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
    // Start the fan past any shared fan-out column claimed in this band, by the
    // same keep-out a junction column claims against its siblings (one stub, so
    // columns closer than that read as one line). Falls back to the plain
    // margin when clearing the claim would leave no corridor at all -- a
    // squeezed fan is still better than none.
    const pinned = pinnedColumnsByBand.get(band) ?? [];
    const claimedLeft = Math.max(
      leftMargin,
      ...pinned.map((x) => x + PORT_STUB - groupLeft),
    );
    const bandLeftMargin =
      groupRight - groupLeft - claimedLeft - rightMargin > 0
        ? claimedLeft
        : leftMargin;
    const usable = groupRight - groupLeft - bandLeftMargin - rightMargin;
    if (usable <= 0) continue; // corridor too tight; keep the default midpoints
    const sorted = [...list].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const pitch = usable / (sorted.length + 1);
    const budget = pitch / 2;
    sorted.forEach((c, i) => {
      bendById.set(c.id, groupLeft + bandLeftMargin + pitch * (i + 1));
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
//             port stub reaches PORT_STUB right; on the left the pad is the
//             wider of the target port stub and the entry-gutter overhang
//             (ENTRY_GUTTER_OVERHANG, the arrival corridor kept clear before a
//             Left port). Top / bottom carry the CHAMFER bevel overhang,
//             matching the gutter rects.
//   - gutter: each node's entry-gutter rect (entryGutterRects), a first-class
//             obstacle so a run stays out of a foreign node's entry corridor.
// Pure: rects are a deterministic function of node geometry and the gutter
// column counts derived from the edges.

// Overhang a padded card rect adds around a node's raw box. RIGHT carries the
// source port stub; LEFT the wider of the target stub and the entry-gutter
// overhang; Y the chamfer bevel.
const OBSTACLE_PAD_RIGHT = PORT_STUB;
export const OBSTACLE_PAD_LEFT = Math.max(PORT_STUB, ENTRY_GUTTER_OVERHANG);
export const OBSTACLE_PAD_Y = CHAMFER;

// Extra vertical clearance a backward detour rail keeps off a container slab
// (group / loop box), on top of the OBSTACLE_PAD_Y already baked into its padded
// rect. At the plain CHAMFER gap the rail hugs the slab border ~16 graph units
// off it, so a gray return edge and the gray border read as one line at fit zoom
// (#29). This pushes the rail ~56 units (OBSTACLE_PAD_Y + this) off the raw
// border -- ~3.5x the plain net gap -- so the two separate visibly. Picked by
// visual check on the battery5-xiranite / crystal evidence plans.
export const CONTAINER_RAIL_GAP = 48;

// Horizontal clearance a loop return's two VERTICALS keep off a container
// slab's side borders, the column analog of CONTAINER_RAIL_GAP. A loop member
// sits 10-36 units off its container's border (the ELK child inset), so the
// default rail columns (one stub out of the source / before the target) land
// a few units off the border and the return's verticals braid the frame -- the
// stroke and the border merge into one line, or wrap non-members when the rail
// hoists (the loop-backedge-braids-container family, #29 follow-on). This
// pushes each column at least this far off the RAW slab border, into the
// interior corridor. Picked by visual check like CONTAINER_RAIL_GAP.
export const CONTAINER_COLUMN_GAP = 16;

// nodeId identifies the node an obstacle belongs to, so a consumer can exempt an
// edge's OWN target card / gutter (the default rise and backward entry columns
// sit inside their own target's padded left band by construction) while
// treating every foreign rect as blocked.
export type PaddedObstacle = ObstacleRect & {
  kind: "card" | "gutter";
  nodeId: string;
};

// The obstacle field a routing pass avoids, in two arms with different
// lifetimes:
//   card arm   a fold over `nodes` alone. The nodes array is the same object
//              for every pass (layoutRenderPlan never re-derives it), so this
//              arm is stable for the whole run.
//   gutter arm a fold over `(nodes, edges-as-of-now)`: occupiesGutterColumn
//              reads edge.type and data.fanout, which routeFanoutEdges
//              rewrites, so it changes under the first pass and only freezes
//              from the second on.
// Each pass therefore rebuilds the field instead of sharing one hoisted to a
// stage boundary. Hoisting would give the same rects today and go silently
// wrong the day a pass that retypes an edge is added after it.
export function paddedObstacles(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): PaddedObstacle[] {
  const byId = nodeIndexOf(nodes);
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
      container: node.type === "group" || node.type === "loop",
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
// is skipped, pushing the column to the outer edge). Container slabs
// (o.container) take the wider `containerGap` for BOTH the strike test and the
// candidate edges, the column analog of clearRailY's container clearance; it
// defaults to the plain gap, so a caller that passes none is byte-identical to
// before. A zero-width obstacle (left === right) is the caller's BORDER BAND: it
// blocks exactly (x - gap, x + gap) around that line and offers the two
// candidates x - gap / x + gap, which is how a slab's frame is kept clear while
// its interior stays routable.
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
const CLEAR_COLUMN_RADIUS = RECIPE_WIDTH + BETWEEN_LAYERS_SPACING;

// Exported for the column suite, which asserts the escape distance and the
// toward-target tie-break on synthetic obstacle rows; a routed edge only shows
// the column that won.
export function clearColumnX(
  desiredX: number,
  yLo: number,
  yHi: number,
  obstacles: ReadonlyArray<ObstacleRect>,
  opts?: {
    towardTarget?: number;
    radius?: number;
    gap?: number;
    containerGap?: number | undefined;
    accept?: (x: number) => boolean;
  },
): number {
  const gap = opts?.gap ?? CHAMFER;
  const containerGap = opts?.containerGap ?? gap;
  const radius = opts?.radius ?? CLEAR_COLUMN_RADIUS;
  const toward = opts?.towardTarget ?? 0;
  const accept = opts?.accept ?? (() => true);
  const gapOf = (o: ObstacleRect): number => (o.container ? containerGap : gap);
  const ymin = Math.min(yLo, yHi);
  const ymax = Math.max(yLo, yHi);
  // Only obstacles whose vertical extent the run overlaps can block it.
  const spanned = obstacles
    .filter((o) => o.bottom > ymin && o.top < ymax)
    .sort((a, b) => a.left - b.left || a.right - b.right);
  const blocked = (x: number): boolean =>
    spanned.some((o) => x > o.left - gapOf(o) && x < o.right + gapOf(o));
  if (!blocked(desiredX) && accept(desiredX)) return desiredX;

  // The nearest clear column sits just outside some spanning obstacle's padded
  // band. Gather both padded edges of every obstacle, drop any that are still
  // blocked (they fall inside a neighbour's band), rejected by the caller's
  // accept, or beyond the search radius, and pick the nearest surviving
  // candidate, tie-breaking toward the target.
  const candidates = spanned
    .flatMap((o) => [o.left - gapOf(o), o.right + gapOf(o)])
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
  const byId = nodeIndexOf(nodes);
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
      // Same container tag paddedObstacles stamps: the raw-fallback tiers read
      // it to keep a raw column off a slab's FRAME (CONTAINER_COLUMN_GAP), not
      // the RAW_GAP a plain card gets.
      container: node.type === "group" || node.type === "loop",
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

// Slim air gap kept off a RAW card box by the raw-fallback tiers below and by
// the #25 separation re-check: a hair of clearance, not the full CHAMFER pad.
const RAW_GAP = 2;

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
// When even the fallback fails, the desired column is normally returned
// unchanged (degraded but stable; the audit quantifies it) -- EXCEPT when the
// own-side guard is active and the desired column's vertical run pierces a
// foreign RAW card body. Keeping it then would slice an unrelated card
// outright, so a two-step pierce rescue re-runs both tiers with the side clamp
// dropped, RANKED so an own-card traversal is the absolute last resort:
//   3a. drop only the side clamp; KEEP the own-card leg rect in the connecting-
//       leg acceptance. This admits a chamfer-band / gutter column just past
//       the port whose approach leg does not cross the own card, but still
//       rejects any column whose leg would traverse the own endpoint body.
//   3b. only if 3a finds nothing: drop the own-card leg rect too, so the column
//       may land inside the own endpoint card and its leg run across that body.
//       Reached only in packed corridors where every off-own column is blocked
//       (matching the pre-guard behaviour for geometry with no clear option) --
//       a defensible last resort, but one the segment audit cannot see because
//       it exempts an edge's own endpoint cards (auditOwnCardPierces measures
//       it separately).
// Only when even 3b fails does the pierced desired column survive. Pure and
// deterministic.
function clearColumnKeepingLeg(args: {
  desired: number;
  portX: number;
  portY: number;
  yLo: number;
  yHi: number;
  toward: number;
  foreignPadded: ReadonlyArray<PaddedObstacle>;
  foreignRawCards: ReadonlyArray<PaddedObstacle>;
  // The caller's container BORDER BANDS: zero-width frame lines (see
  // clearColumnX) that gate the COLUMN only -- never the connecting legs, which
  // legitimately cross a frame to reach a column on the other side of it.
  // Today only clampBackwardRails passes them, for the return's own shared
  // container; absent means no band treatment and byte-identical resolution.
  containerBands?: ReadonlyArray<PaddedObstacle>;
  // Wider column gap for container-slab obstacles (the CONTAINER_COLUMN_GAP
  // analog of clearRailY's containerGap). Defaults to the tier's plain gap, so
  // an omitting caller resolves exactly as before.
  containerGap?: number | undefined;
  // Own-side guard for a port-anchored column. Both are optional and default to
  // a no-op, so the clampBackwardRails callers (which omit them) are unchanged.
  //   sideClamp -- reject any candidate on the wrong side of the port (target
  //     side: x <= portX - CHAMFER; source side: x >= portX + CHAMFER), mirroring the jog-
  //     descent guard so a packed sibling can never push the column past the
  //     port into the endpoint's own body.
  //   ownLegRect -- the endpoint's own RAW card, folded into the connecting-leg
  //     acceptance only (never the column-clearance sets), so the column may
  //     still sit in that card's own gutter. Redundant belt-and-braces on BOTH
  //     sides while sideClamp is supplied: every candidate whose leg could enter
  //     the own body sits past the port and is already rejected by the clamp
  //     (drop: x < sx implies x < sx + CHAMFER; rise mirrored). It is not
  //     load-bearing today; it only guards against a future loosening or
  //     removal of the clamp.
  ownLegRect?: PaddedObstacle | undefined;
  sideClamp?: ((x: number) => boolean) | undefined;
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
    containerBands,
    containerGap,
    ownLegRect,
    sideClamp,
  } = args;
  const bands = containerBands ?? [];
  const paddedCards = foreignPadded.filter((o) => o.kind === "card");
  const legExtra = ownLegRect ? [ownLegRect] : [];
  const paddedLegCards = [...paddedCards, ...legExtra];
  const rawLegCards = [...foreignRawCards, ...legExtra];
  const onSide = sideClamp ?? (() => true);
  const ymin = Math.min(yLo, yHi);
  const ymax = Math.max(yLo, yHi);
  // Does a vertical run at x, spanning [ymin, ymax], stay out of every rect in
  // `set`? The one predicate behind both the tier verification below and the
  // pierce test that gates tier 3.
  const columnClear = (
    x: number,
    set: ReadonlyArray<PaddedObstacle>,
    gap: number,
    cGap: number,
  ): boolean =>
    !set.some(
      (o) =>
        o.bottom > ymin &&
        o.top < ymax &&
        x > o.left - (o.container ? cGap : gap) &&
        x < o.right + (o.container ? cGap : gap),
    );

  // One resolve-then-verify step, shared by every tier below. clearColumnX hands
  // back the desired column unchanged when no candidate qualifies, so the result
  // only counts once it is re-checked against the same obstacle set and the same
  // acceptance -- otherwise a tier would "succeed" with the column it failed to
  // move. Null means this tier found nothing and the next one runs.
  const resolve = (
    set: ReadonlyArray<PaddedObstacle>,
    gap: number,
    radius: number,
    accept: (x: number) => boolean,
  ): number | null => {
    const x = clearColumnX(desired, yLo, yHi, set, {
      towardTarget: toward,
      gap,
      containerGap,
      radius,
      accept,
    });
    return columnClear(x, set, gap, containerGap ?? gap) && accept(x)
      ? x
      : null;
  };

  // Tier 1: padded set, padded-card leg acceptance. Bands join the column set;
  // the container gap widens every container obstacle's blocked interval.
  const tier1Set = [...foreignPadded, ...bands];
  const paddedAccept = (x: number): boolean =>
    onSide(x) && !connectingLegBlocked(portX, portY, x, paddedLegCards);
  const padded = resolve(tier1Set, CHAMFER, CLEAR_COLUMN_RADIUS, paddedAccept);
  if (padded !== null) return padded;

  // Tier 2: raw fallback. The slim RAW_GAP keeps a hair of air off the raw box
  // (the container gap for slabs: a raw-fallback column parked RAW_GAP off a
  // slab border braided the frame, the loop-return family's raw variant); the
  // doubled radius lets a fully packed near corridor escape to the next gap.
  const tier2Set = [...foreignRawCards, ...bands];
  const rawAccept = (x: number): boolean =>
    onSide(x) && !connectingLegBlocked(portX, portY, x, rawLegCards);
  const raw = resolve(tier2Set, RAW_GAP, 2 * CLEAR_COLUMN_RADIUS, rawAccept);
  if (raw !== null) return raw;

  // Tier 3: pierce rescue. Gated on the own-side guard being active, so the
  // clampBackwardRails callers (which pass neither guard arg) keep today's
  // degrade unchanged. When the guarded tiers exhaust AND the desired column's
  // vertical run pierces a foreign RAW card body, degrading to it would slice
  // an unrelated card outright (the audit's hard gate). Two ranked sub-tiers
  // re-resolve with the side clamp dropped, an own-card landing always last.
  if (sideClamp !== undefined || ownLegRect !== undefined) {
    // Zero gap: the desired column pierces a foreign raw card BODY, not its
    // clearance band.
    const desiredPierces = !columnClear(desired, foreignRawCards, 0, 0);
    if (desiredPierces) {
      // Tier 3a: drop the side clamp but KEEP the own-card leg rect in the
      // acceptance. A column past the port whose approach leg still clears the
      // own endpoint body (a chamfer-band / gutter escape, or any far column
      // whose leg does not cross the own card) beats the foreign pierce without
      // tunnelling the own body.
      const legClearOf =
        (cards: ReadonlyArray<PaddedObstacle>) =>
        (x: number): boolean =>
          !connectingLegBlocked(portX, portY, x, cards);
      const rescueAPadded = resolve(
        tier1Set,
        CHAMFER,
        CLEAR_COLUMN_RADIUS,
        legClearOf(paddedLegCards),
      );
      if (rescueAPadded !== null) return rescueAPadded;
      const rescueARaw = resolve(
        tier2Set,
        RAW_GAP,
        2 * CLEAR_COLUMN_RADIUS,
        legClearOf(rawLegCards),
      );
      if (rescueARaw !== null) return rescueARaw;

      // Tier 3b (last resort): drop the own-card leg rect too. Only reached when
      // no off-own column clears -- every leftward leg crosses a foreign body
      // and every rightward column is walled -- so the run traverses its own
      // endpoint card. auditOwnCardPierces tracks this residue; the foreign
      // segment audit exempts endpoint cards and cannot.
      const rescueBPadded = resolve(
        tier1Set,
        CHAMFER,
        CLEAR_COLUMN_RADIUS,
        legClearOf(paddedCards),
      );
      if (rescueBPadded !== null) return rescueBPadded;
      const rescueBRaw = resolve(
        tier2Set,
        RAW_GAP,
        2 * CLEAR_COLUMN_RADIUS,
        legClearOf(foreignRawCards),
      );
      if (rescueBRaw !== null) return rescueBRaw;
    }
  }
  return desired;
}

// clampBackwardRails: give each backward item edge's detour rail a y that clears
// the cards it horizontally spans, so a recycle rail no longer slices through
// its own source / target cards or the columns between them. Mirrors the bus
// lane band's obstacle avoidance (clearRailY): the padded obstacle provider
// supplies the rectangles, and the rail moves just clear of the ones its
// horizontal run crosses. Because those rects now carry the port-stub / entry-
// chip overhang and each node's entry gutter, the rail also avoids grazing that
// overhang, not just the raw card. Threads { railY } onto the affected edges;
// every other edge passes through by reference. What it needs from the passes
// before it is the ROUTING_PASSES entry in layout.ts.
export function clampBackwardRails(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = nodeIndexOf(nodes);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);
  // Raw rect lookup by node id, for building the shared container's border
  // bands at its RAW edges (the frame the reader sees), not its padded band.
  const rawById = new Map<string, PaddedObstacle>();
  for (const o of rawCards) rawById.set(o.nodeId, o);

  const railYByIndex = new Map<number, number>();
  const railXRightByIndex = new Map<number, number>();
  const railXLeftByIndex = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    if (nodeGap(source, target, byId) > 0) return; // forward edges keep the step
    const ports = edgePortsModel(edge, byId);
    if (ports === null) return;
    const { sx, sy, tx, ty } = ports;
    // Rail x-span and level come from chamferStepPath's own backward defaults,
    // so the clamp starts at exactly the shape the drawer would produce.
    const {
      xr: xrDesired,
      xl: xlDesired,
      railY: preferredY,
    } = backwardRailDefaults({
      sx,
      sy,
      tx,
      ty,
      entryX: (edge.data as ItemEdgeData | undefined)?.entryX,
    });
    const railY = clearRailY(
      preferredY,
      xlDesired,
      xrDesired,
      obstacles,
      CHAMFER,
      CONTAINER_RAIL_GAP,
    );
    if (railY !== preferredY) railYByIndex.set(index, railY);

    // Clamp the two verticals out of any foreign card / gutter they pierce. The
    // right column runs from the source port down/up to the rail; the left column
    // from the rail to the target port. Each column's own node is exempt (the
    // default columns sit inside their own node's padded band), as is that
    // endpoint's own container BOX (a grouped endpoint's column legitimately
    // runs inside its container) -- but each endpoint's own container FRAME is
    // not: a loop return lands its default columns (one stub each side) a few
    // units off the side borders of any container a member sits in, because
    // members sit one ELK inset (10-36) off them, and the return's verticals
    // then braid the frame (#29 follow-on, loop-backedge family). That held
    // the both-endpoint shared slab first; a return with only ONE endpoint
    // inside a container braids that container just the same, so the band
    // treatment is PER SIDE: each endpoint's own container joins that side's
    // column scan as two BORDER BANDS (zero-width frame lines at its raw
    // edges, blocked and escaped with CONTAINER_COLUMN_GAP), so each resolved
    // column sits at least that far off its endpoint's container frame --
    // inside, in the interior corridor, or just outside -- while its
    // connecting leg may still cross the frame to reach it. An endpoint with
    // no container contributes no bands, and the shared-container case feeds
    // both sides the same slab it always did. The rail y is taken as fixed
    // (computed from the default columns above), so the columns only dodge
    // along x.
    // Side-keeping: a moved column is accepted only when the connecting
    // horizontal from its port also stays clear (raw-gap fallback where
    // paddings overlap); the segment audit quantifies any residual.
    const sharedContainerId =
      source.parentId !== undefined && source.parentId === target.parentId
        ? source.parentId
        : undefined;
    const bandsOf = (endpoint: RFAnyNode): PaddedObstacle[] => {
      const containerId = sharedContainerId ?? endpoint.parentId;
      if (containerId === undefined) return [];
      const slab = rawById.get(containerId);
      if (slab === undefined) return [];
      return [
        { ...slab, right: slab.left, container: true },
        { ...slab, left: slab.right, container: true },
      ];
    };
    const xrExempt = ownExempt([source]);
    const xr = clearColumnKeepingLeg({
      desired: xrDesired,
      portX: sx,
      portY: sy,
      yLo: sy,
      yHi: railY,
      toward: -1,
      foreignPadded: obstacles.filter(
        (o) => !xrExempt.has(o.nodeId) && o.nodeId !== sharedContainerId,
      ),
      foreignRawCards: rawCards.filter(
        (o) => !xrExempt.has(o.nodeId) && o.nodeId !== sharedContainerId,
      ),
      containerBands: bandsOf(source),
      containerGap: CONTAINER_COLUMN_GAP,
    });
    if (xr !== xrDesired) railXRightByIndex.set(index, xr);
    const xlExempt = ownExempt([target]);
    const xl = clearColumnKeepingLeg({
      desired: xlDesired,
      portX: tx,
      portY: ty,
      yLo: railY,
      yHi: ty,
      toward: -1,
      foreignPadded: obstacles.filter(
        (o) => !xlExempt.has(o.nodeId) && o.nodeId !== sharedContainerId,
      ),
      foreignRawCards: rawCards.filter(
        (o) => !xlExempt.has(o.nodeId) && o.nodeId !== sharedContainerId,
      ),
      containerBands: bandsOf(target),
      containerGap: CONTAINER_COLUMN_GAP,
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
// It reads each edge's FINAL bendX (the leg starts at that column); which pass
// settles it is the ROUTING_PASSES entry in layout.ts.
// Only the normal forward step has a distinct final leg
// to jog; the same-y straight line and small-dy diagonal are left to their own
// branches, which do not read legY. Threads { legY } onto the affected edges;
// every other edge passes through by reference. Pure and deterministic.
export function jogForwardLegs(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = nodeIndexOf(nodes);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);

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
  // Descent slots are handed out first-come, so the scan runs in routing order
  // rather than array order: two jogs into one target then take the same two
  // columns however the caller happened to arrange the edges.
  const scanOrder = edges
    .map((edge, index) => ({ edge, index, id: edge.id }))
    .sort(byRoutingOrder);
  scanOrder.forEach(({ edge, index }) => {
    if (edge.type !== "item") return; // only forward item edges take the step
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return;
    if (nodeGap(source, target, byId) <= 0) return; // backward / zero-gap edge
    const ports = edgePortsModel(edge, byId);
    if (ports === null) return;
    const { sx, sy, tx, ty } = ports;
    // Only the normal forward step draws a distinct final horizontal leg: the
    // same-y case is a straight line and the small-dy case a single diagonal,
    // neither of which reads legY. Mirror chamferStepPath's branch guards so a
    // stamped hint is always one the drawer consumes. forwardStepGeometry is
    // the drawer's own bend-column derivation, so the leg's start x matches the
    // drawn path by construction.
    const bendHint = (edge.data as ItemEdgeData | undefined)?.bendX;
    const { chamfer, bx } = forwardStepGeometry(sx, tx, bendHint);
    if (sy === ty) return;
    if (Math.abs(ty - sy) <= 2 * chamfer) return;
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
    const exempt = ownExempt([source, target]);
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
    // card. (A blocked bend VERTICAL with both legs clean is not a jog.)
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
