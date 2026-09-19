// Whole-graph pre-render ROUTING passes for the blueprint canvas. Layout runs
// them in order after ELK places the nodes, each consuming the previous ones'
// stamps; ROUTING_PASSES in layout.ts is that order, with a per-entry note on
// what each pass does.
// Every pass is pure and deterministic: no React, no Date/random, no mutation
// of the inputs. Nodes are read only for geometry (absolute positions and
// sizes); they pass through untouched. Passes merge routing fields onto edge
// `data` (bus members are retyped `type: "bus"`).
//
// The sixth and final pipeline pass -- the chip bookkeeping stamps
// (deconflictChipAnchors) -- lives in chipSeating.ts; it consumes this module's
// edge-data readers. The model-frame node accessors both modules read live in
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
  drawnEdge,
  fanJunctionX,
  forwardDropX,
  forwardStepGeometry,
  horizontalRuns,
  routingHintsFromData,
  type ObstacleRect,
} from "./edgePath";
import {
  absoluteLeft,
  absoluteTop,
  drawnPortsOf,
  edgeItem,
  edgeTargetSide,
  nodeHeight,
  nodeIndexOf,
  nodeRectOf,
  nodeWidth,
  portOffsetY,
  type Rect,
} from "./nodeGeometry";
import {
  COLUMN_MIN_PITCH,
  COLUMN_PITCH,
  buildLayerModel,
  classifyTrunks,
  gapKeyOf,
  gapKeysFor,
  homeLayerOf,
  layerIndexIn,
  layerSpanOf,
  trunkScopeOf,
  type GapRecord,
  type LayerModel,
  type Trunk,
  type TrunkKind,
} from "./layerModel";
import { CHIP_HALF_H } from "./chipMetrics";
import { pushInto } from "../util/multimap";
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

// Fan-out trunk member (routeTrunkEdges). Retyped `type: "bus"` -- so Canvas
// trunk adjacency and hover-dim pick it up -- and it consolidates N
// same-source-port edges onto one shared junction column in a single layer gap.
// `fanout: true` is always set, so BusEdge draws the short in-corridor trunk
// (chamferFanoutPath). `junctionX` is the shared column, the slot the trunk
// took in its gap's reserved column zone. The aggregate reuses BusAggregate;
// where its two chips stand is the path builder's rule, not a stamp.
export type FanoutBusEdgeData = BusAggregate & {
  fanout: true;
  // The absent half of the discriminated union below, so a reader can ask
  // either question of a BusEdgeData without narrowing it first.
  fanin?: undefined;
  junctionX?: number;
};

// Fan-in trunk member (routeTrunkEdges), the mirror of the fan-out payload
// above. Retyped `type: "bus"` the same way, with `fanin: true` as the
// discriminant BusEdge draws the merge shape (chamferFaninPath) from.
// `junctionX` is the trunk's shared merge column, the slot it took from the
// RIGHT of its gap's reserved column zone. The aggregate reuses BusAggregate:
// here busChipOwner marks the member that draws the trunk's one aggregate chip
// on the shared leg into the port.
export type FaninBusEdgeData = BusAggregate & {
  fanin: true;
  fanout?: undefined;
  junctionX?: number;
};

// Data fields the bus pass merges onto a member edge's existing `data`: a
// bus-typed edge is a member of one trunk or the other, so the payload is the
// union of the two shapes, discriminated by `fanout` / `fanin`.
export type BusEdgeData = FanoutBusEdgeData | FaninBusEdgeData;

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
    ty:
      absoluteTop(target, byId) +
      portOffsetY(target, item, edgeTargetSide(edge)),
  };
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

// Does a HORIZONTAL run at `y` from x0 to x1 enter any rect of `set`? The
// obstacle test every pass that owns a long leg shares: jogForwardLegs decides
// whether a step is dirty with it, and routeTrunkEdges decides with it whether
// a member's trunk runs are clean enough to draw as part of the trunk.
function legBlockedIn(
  set: ReadonlyArray<PaddedObstacle>,
  y: number,
  x0: number,
  x1: number,
  // Narrows `set` in place of a filtered copy.
  include: (o: PaddedObstacle) => boolean = () => true,
): boolean {
  return set.some(
    (o) =>
      include(o) &&
      o.right > Math.min(x0, x1) &&
      o.left < Math.max(x0, x1) &&
      y > o.top &&
      y < o.bottom,
  );
}

// routeTrunkEdges: draw every trunk of the graph -- fan-out and fan-in alike --
// on one shared junction column. Its place in the order, and why that placement
// is scheduling rather than a dependency, is the ROUTING_PASSES entry in
// layout.ts.
//
// Membership is TOPOLOGICAL, not geometric: the trunks come from classifyTrunks,
// so any (item, unit) port feeding or fed by two or more counterpart units is a
// trunk whatever the gap widths are. Nothing here re-decides it, and nothing
// declines a trunk -- the pre-pass already widened the gap for the columns and
// chips this pass places.
//
// The columns come from the GAP RECORDS the pre-pass produced (ctx.gaps), one
// reserved COLUMN_PITCH per trunk. A fan-out whose source unit sits in layer k
// takes a slot in gap k; a fan-in whose target unit sits in layer k takes one in
// gap k-1. The two kinds fill the SAME zone from opposite ends, so a flow's
// split column stands beside its source layer and its merge column beside its
// target layer:
//   fan-out  columnZone.left  + COLUMN_PITCH / 2 + slot * COLUMN_PITCH
//   fan-in   columnZone.right - COLUMN_PITCH / 2 - slot * COLUMN_PITCH
// Slots are handed out top-to-bottom by the port row the trunk hangs off (the
// source port for a fan-out, the target port for a fan-in), the trunk key
// breaking ties, so the columns follow reading order and never depend on where
// an edge sits in the input array. Without a ctx -- a hand-built fixture, or a
// caller that re-runs the passes on its own -- there is no record to read and
// the column falls back to the midpoint of the corridor between the unit's port
// and its nearest counterpart, clamped exactly as the path builders clamp it.
//
// A member's treatment is by LAYER DISTANCE from its trunk's unit, not pixel
// span -- plus, for the next-layer case, the clearance test below, which sends
// a member whose own trunk runs would cross a foreign card to the far
// treatment instead:
//   next layer      retyped `type: "bus"` and stamped { fanout | fanin,
//                   trunkKey, junctionX, busTotalRate, busMemberCount,
//                   busChipOwner }; BusEdge draws the in-corridor trunk
//                   (chamferFanoutPath / chamferFaninPath).
//   two or more     stays `type: "item"` and only borrows the column, stamped
//                   { bendX: junctionX } plus fanoutColumn / faninColumn. The
//                   trunk path builders would draw a straight shared leg
//                   slicing the cards in between, and a bus-typed member never
//                   reaches jogForwardLegs -- so a far member keeps the
//                   item-edge passes and the shared line both. assignBendColumns
//                   leaves a pre-stamped bendX alone, so the pin holds.
//   backward        keeps its detour rail, with the column it shares with the
//                   trunk pre-stamped: railXRight for a fan-out member (the
//                   rail leaves the source at the split column), railXLeft for
//                   a fan-in member (it arrives at the merge column).
//                   clampBackwardRails keeps a pre-stamped side as given.
//
// A DUAL member -- one that is a near member of a fan-out AND of a fan-in -- is
// drawn as the fan-out member it already was, with the fan-in column stamped as
// faninJoinX: the drawn polyline is the same, but the run at the target row
// between the two columns is the stretch that belongs to it alone, so that is
// where its ONE own chip anchors and its source stub stays bare (the fan-out
// aggregate reads there). Both trunks still draw their aggregate.
//
// Non-members pass through by reference. Pure and deterministic: membership,
// owner election and the slot order depend only on the graph and on geometry,
// never on input order.
export function routeTrunkEdges(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const trunks = classifyTrunks(nodes, edges).trunks;
  if (trunks.length === 0) return edges.map((e) => e);

  const model = buildLayerModel(nodes);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  // How far the member reaches from its trunk's own layer, which is what
  // decides whether it is drawn as part of the trunk (next layer over), merely
  // pinned to its column (further away) or left to its detour rail (backward).
  // The distance is read in the trunk's own SCOPE -- the innermost frame the
  // unit and every counterpart share -- so a fan-out inside a loop container
  // measures against the container's interior layers, not against a root
  // layering in which a card standing beside the box merges the two into one.
  // A member whose endpoints have no layer there -- only an unplaced node can do
  // that, and classifyTrunks already dropped those -- reads as backward.
  type Reach = "near" | "far" | "backward";

  type TrunkGeom = {
    trunk: Trunk;
    gapKey: string;
    // The port row the trunk hangs off: its slot order inside the gap.
    portY: number;
    fallbackColumn: number;
    reachByEdgeId: Map<string, Reach>;
  };

  const geoms: TrunkGeom[] = [];
  for (const trunk of trunks) {
    const members = trunk.members
      .map((id) => edgeById.get(id))
      .filter((edge): edge is Edge => edge !== undefined);
    const first = members[0];
    if (first === undefined) continue;
    const scope = trunkScopeOf(model, trunk, edgeById);
    if (scope === undefined) continue;
    const unitLayer = layerIndexIn(model, scope, trunk.unit);
    if (unitLayer === undefined) continue;
    const ports = edgePortsModel(first, byId);
    if (ports === null) continue;
    const fanOut = trunk.kind === "fanOut";

    const reachByEdgeId = new Map<string, Reach>();
    // The nearest counterpart port, for the no-ctx fallback column: the leftmost
    // target for a fan-out, the rightmost source for a fan-in.
    let nearestX = fanOut ? Infinity : -Infinity;
    for (const member of members) {
      const otherLayer = layerIndexIn(
        model,
        scope,
        fanOut ? member.target : member.source,
      );
      const distance =
        otherLayer === undefined
          ? undefined
          : fanOut
            ? otherLayer - unitLayer
            : unitLayer - otherLayer;
      const reach: Reach =
        distance === undefined || distance <= 0
          ? "backward"
          : distance === 1
            ? "near"
            : "far";
      reachByEdgeId.set(member.id, reach);
      if (reach === "backward") continue;
      const memberPorts = edgePortsModel(member, byId);
      if (memberPorts === null) continue;
      nearestX = fanOut
        ? Math.min(nearestX, memberPorts.tx)
        : Math.max(nearestX, memberPorts.sx);
    }

    geoms.push({
      trunk,
      gapKey: gapKeyOf({ scope, index: fanOut ? unitLayer : unitLayer - 1 }),
      portY: fanOut ? ports.sy : ports.ty,
      fallbackColumn: fanOut
        ? corridorMidColumn(ports.sx, nearestX)
        : corridorMidColumn(nearestX, ports.tx),
      reachByEdgeId,
    });
  }
  if (geoms.length === 0) return edges.map((e) => e);

  // One slot per trunk in its gap's reserved zone, the two kinds filling it from
  // opposite ends so neither can land on the other's column.
  const geomsByGap = new Map<string, TrunkGeom[]>();
  for (const geom of geoms) {
    pushInto(geomsByGap, geom.gapKey, geom);
  }
  const gapByKey = new Map(
    (ctx?.gaps ?? []).map((gap) => [gapKeyOf(gap), gap]),
  );

  const junctionByTrunk = new Map<Trunk, number>();
  for (const [gapKey, group] of geomsByGap) {
    const zone = gapByKey.get(gapKey)?.columnZone;
    const bySlot = (a: TrunkGeom, b: TrunkGeom): number =>
      a.portY - b.portY ||
      (a.trunk.key < b.trunk.key ? -1 : a.trunk.key > b.trunk.key ? 1 : 0);
    const place = (
      kind: TrunkKind,
      columnOf: (slot: number) => number,
    ): void => {
      group
        .filter((geom) => geom.trunk.kind === kind)
        .sort(bySlot)
        .forEach((geom, slot) => {
          junctionByTrunk.set(
            geom.trunk,
            zone === undefined ? geom.fallbackColumn : columnOf(slot),
          );
        });
    };
    place(
      "fanOut",
      (slot) => (zone?.left ?? 0) + COLUMN_PITCH / 2 + slot * COLUMN_PITCH,
    );
    place(
      "fanIn",
      (slot) => (zone?.right ?? 0) - COLUMN_PITCH / 2 - slot * COLUMN_PITCH,
    );
  }

  // Per edge, the trunk it belongs to on each side and how far it reaches there.
  type Side = { geom: TrunkGeom; reach: Reach; junctionX: number };
  const fanOutByEdgeId = new Map<string, Side>();
  const fanInByEdgeId = new Map<string, Side>();
  for (const geom of geoms) {
    const junctionX = junctionByTrunk.get(geom.trunk)!;
    const into = geom.trunk.kind === "fanOut" ? fanOutByEdgeId : fanInByEdgeId;
    for (const [id, reach] of geom.reachByEdgeId) {
      into.set(id, { geom, reach, junctionX });
    }
  }

  // A near member is drawn as part of the trunk -- source stub out to the
  // junction column, branch leg from the column into the target port -- and the
  // bus retype then takes it out of every obstacle-aware pass, so those two
  // long horizontals are never moved off a card again. Layer distance alone
  // does not say they are drawable: a layer is a maximal run of OVERLAPPING
  // x-intervals, so a card of the source's or the target's own layer can sit
  // strictly between the member's two ports, and the member would draw straight
  // through it.
  //
  // So a member is near only if both runs are clear of the raw cards foreign to
  // it (its own endpoints and their containers exempt, as everywhere else in
  // this module). One that is not is DEMOTED to the far treatment below: it
  // keeps the shared column as its bend and goes back to the item-edge passes,
  // where jogForwardLegs can move its legs clear. The column itself does not
  // move -- it is the slot the gap record handed the trunk.
  const rawCards = rawCardRects(nodes);
  const trunkRunsClear = (edge: Edge, junctionX: number): boolean => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const ports = edgePortsModel(edge, byId);
    if (source === undefined || target === undefined || ports === null) {
      return true;
    }
    const { sx, sy, tx, ty } = ports;
    const exempt = ownExempt([source, target]);
    const foreign = rawCards.filter((o) => !exempt.has(o.nodeId));
    // A shared-y member draws one straight run from port to port; every other
    // member draws the stub at sy and the leg at ty, split by the drawn column.
    if (sy === ty) return !legBlockedIn(foreign, sy, sx, tx);
    const jx = fanJunctionX(sx, tx, junctionX);
    return (
      !legBlockedIn(foreign, sy, sx, jx - CHAMFER) &&
      !legBlockedIn(foreign, ty, jx + CHAMFER, tx)
    );
  };
  for (const [id, side] of fanOutByEdgeId) {
    const edge = edgeById.get(id);
    if (side.reach !== "near" || edge === undefined) continue;
    if (trunkRunsClear(edge, side.junctionX)) continue;
    fanOutByEdgeId.set(id, { ...side, reach: "far" });
  }
  for (const [id, side] of fanInByEdgeId) {
    const edge = edgeById.get(id);
    if (side.reach !== "near" || edge === undefined) continue;
    // A dual member is drawn as its fan-out branch and only hands its flow to
    // the merge column, so its runs were already tested on the fan-out side.
    if (fanOutByEdgeId.get(id)?.reach === "near") continue;
    if (trunkRunsClear(edge, side.junctionX)) continue;
    fanInByEdgeId.set(id, { ...side, reach: "far" });
  }

  // The member that draws a fan-out trunk's ONE aggregate chip: the lex-smallest
  // member that is STILL near after the demotions above, i.e. one BusEdge draws
  // the fan-out shape (and therefore the trunk anchor) for. Trunk.owner is
  // elected over ALL members, so a trunk whose lex-smallest member is far or
  // backward would hand the aggregate to an edge that draws no trunk segment and
  // the trunk would show no total at all. A trunk with no near member draws its
  // aggregate on nothing, the same way a fan-in trunk of all-dual members does.
  const fanoutAggOwnerByTrunk = new Map<Trunk, string>();
  for (const [id, side] of fanOutByEdgeId) {
    if (side.reach !== "near") continue;
    const owner = fanoutAggOwnerByTrunk.get(side.geom.trunk);
    if (owner === undefined || id < owner) {
      fanoutAggOwnerByTrunk.set(side.geom.trunk, id);
    }
  }

  // The member that draws a fan-in trunk's ONE aggregate chip. It has to be a
  // member BusEdge draws the fan-in shape for, and a dual member already draws
  // its fan-out trunk's aggregate on the same `-drop` chip, so the election runs
  // over the near members that are nobody else's fan-out branch, lex-smallest
  // first. Two trunks draw no aggregate at all: one whose near members are all
  // dual (each of them already states its own source's total beside it), and one
  // with NO near member -- every member reaches from two or more layers back, so
  // no BusEdge draws the aggregate leg the chip would ride. The target card
  // states the total there, and chipSeating still marks the merge with a dot.
  const faninAggOwnerByTrunk = new Map<Trunk, string>();
  for (const [id, side] of fanInByEdgeId) {
    if (side.reach !== "near") continue;
    if (fanOutByEdgeId.get(id)?.reach === "near") continue;
    const owner = faninAggOwnerByTrunk.get(side.geom.trunk);
    if (owner === undefined || id < owner) {
      faninAggOwnerByTrunk.set(side.geom.trunk, id);
    }
  }

  const aggregateOf = (trunk: Trunk, owner: boolean): BusAggregate => ({
    trunkKey: trunk.key,
    busTotalRate: trunk.total,
    busMemberCount: trunk.members.length,
    busChipOwner: owner,
  });

  return edges.map((edge) => {
    const out = fanOutByEdgeId.get(edge.id);
    const into = fanInByEdgeId.get(edge.id);
    if (out === undefined && into === undefined) return edge;

    // Pre-stamped rail columns: a backward member shares its trunk's column
    // with the forward members instead of taking its own default one stub off
    // the port. clampBackwardRails keeps a pre-stamped side as given.
    const rails = {
      ...(out?.reach === "backward" ? { railXRight: out.junctionX } : {}),
      ...(into?.reach === "backward" ? { railXLeft: into.junctionX } : {}),
    };

    if (out?.reach === "near") {
      // Near fan-out member, dual or not. A dual hands its flow to the fan-in
      // column at faninJoinX; the drawn polyline is the same either way.
      return {
        ...edge,
        type: "bus",
        data: {
          ...edge.data,
          ...rails,
          ...aggregateOf(
            out.geom.trunk,
            edge.id === fanoutAggOwnerByTrunk.get(out.geom.trunk),
          ),
          fanout: true,
          junctionX: out.junctionX,
          ...(into?.reach === "near" ? { faninJoinX: into.junctionX } : {}),
        },
      };
    }
    if (into?.reach === "near") {
      return {
        ...edge,
        type: "bus",
        data: {
          ...edge.data,
          ...rails,
          ...aggregateOf(
            into.geom.trunk,
            edge.id === faninAggOwnerByTrunk.get(into.geom.trunk),
          ),
          fanin: true,
          junctionX: into.junctionX,
        },
      };
    }
    // A far member borrows one column. When it is far on BOTH sides the
    // fan-out's wins: that is the column its siblings already leave the shared
    // out-port on, and a single vertical run can only stand in one gap.
    const column =
      out?.reach === "far"
        ? { bendX: out.junctionX, fanoutColumn: true as const }
        : into?.reach === "far"
          ? { bendX: into.junctionX, faninColumn: true as const }
          : {};
    if (Object.keys(column).length === 0 && Object.keys(rails).length === 0) {
      return edge;
    }
    return { ...edge, data: { ...edge.data, ...rails, ...column } };
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
// Also the FLOOR every pass keeps between any two columns in one gap; the value
// lives in layerModel beside the reserve that pays for it.
export const ENTRY_SLOT_PITCH = COLUMN_MIN_PITCH; // 16

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
export type GutterRect = Rect;

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
// width. A routed bus edge is a member of one trunk or the other and the two
// answer differently -- a fan-out member arrives horizontally off its trunk's
// column and stakes nothing, a fan-in member claims its trunk's merge column in
// front of the card; the remaining arm answers only for hand-built bus edges.
function occupiesGutterColumn(
  edge: Edge,
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
): boolean {
  const gap = nodeGap(source, target, byId);
  if (edge.type === "bus") {
    const busData = edge.data as BusEdgeData | undefined;
    // A fan-out member approaches its target horizontally off the shared
    // junction column (mid-corridor), never up the target's entry gutter, so it
    // stakes no gutter column and does not widen the band.
    if (busData?.fanout === true) {
      return false;
    }
    // A fan-in member does claim a column in front of its target -- the trunk's
    // shared merge column -- so it counts as an arrival for the band width and
    // for the slots the other arrivals into this node take.
    if (busData?.fanin === true) {
      return true;
    }
    // narrow-forward hairpin claims no column
    return gap <= 0 || gap >= FORWARD_STEP_BUDGET;
  }
  if (edge.type === "item") return gap <= 0; // backward rail
  return false;
}

// Does an edge take one of its target's ARRIVAL columns -- the vertical run that
// drops to the port row in front of the card? A backward rail does (its left rail
// column) and so does a fan-in member (the trunk's shared merge column), as they
// always have. Since the LATE DROP a forward step does too, for the shapes listed
// below: it holds its source row across the gap and turns down at the entry
// column, so two flows into adjacent rows of one card share only the approach
// band instead of running a row pitch apart the whole way.
//
// Wider than occupiesGutterColumn, which answers the narrower question of which
// columns stand inside the target's gutter BAND and so set its width: an entry
// column stands left of the gap's target chip reserve, outside the band.
function takesArrivalColumn(
  edge: Edge,
  source: RFAnyNode,
  target: RFAnyNode,
  byId: ReadonlyMap<string, RFAnyNode>,
  model: LayerModel,
): boolean {
  if (edge.type !== "item") {
    return occupiesGutterColumn(edge, source, target, byId);
  }
  if (nodeGap(source, target, byId) <= 0) return true; // backward rail
  const span = layerSpanOf(model, edge.source, edge.target);
  if (span === undefined) return false;
  const { from, to } = span;
  // A forward step drops late only where the drop buys something and costs
  // nothing else. Three shapes are left out:
  //   layer-SKIPPING  -- its drop column would span every row between the two
  //     layers, so it braids the drops of the cards in between, and holding the
  //     source row that far puts the run through the cards standing on it (the
  //     jog pass would then bend it back into the old shape anyway);
  //   trunk member    -- a far member is pinned to its trunk's shared line
  //     (fanoutColumn / faninColumn), which is the formation the trunk exists to
  //     draw, and its own leg carries its chip;
  //   ports on ONE row -- drawn as a straight line, port to port; there is no
  //     vertical to move.
  if (to - from !== 1) return false;
  const data = edge.data as ItemEdgeData | undefined;
  if (data?.fanoutColumn === true || data?.faninColumn === true) return false;
  const ports = edgePortsModel(edge, byId);
  return ports !== null && ports.sy !== ports.ty;
}

// One ARRIVAL ROW: a target port row every edge that arrives on it drops into,
// and the vertical extent those drops span (each edge turns down from its own
// source row, so the row's column reaches from the highest source row to the
// port). Rows are keyed by the drawn port y rather than by port index, so a
// catalyst row and an input row carrying the SAME item stay two rows.
// `fromAbove` records which way the row is approached: true only when EVERY
// edge on it is a forward step turning down from a source row above the port.
// A row shared with a rise, a rail or a same-row arrival is not from above, as
// one run of the pair then climbs and the reversed sense would braid it.
type ArrivalRow = {
  key: string;
  targetId: string;
  y: number;
  yLo: number;
  yHi: number;
  fromAbove: boolean;
};

const arrivalRowKey = (targetId: string, y: number): string =>
  `${targetId}@row${Math.round(y * 100)}`;

// The arrival row of one edge, or undefined when it takes no arrival column or
// its ports cannot be resolved.
function arrivalRowOf(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
  model: LayerModel,
): ArrivalRow | undefined {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (source === undefined || target === undefined) return undefined;
  if (!takesArrivalColumn(edge, source, target, byId, model)) {
    return undefined;
  }
  const ports = edgePortsModel(edge, byId);
  if (ports === null) return undefined;
  const { sy, ty } = ports;
  // A forward step's drop runs from its source row to the port row. A BACKWARD
  // rail's column runs from its detour rail, whose level clampBackwardRails only
  // settles two passes later and may push clear across the graph, so its extent
  // is unknown here and taken as unbounded: the row then shares a slot with
  // nothing and no rail braids a drop.
  const backward = nodeGap(source, target, byId) <= 0;
  return {
    key: arrivalRowKey(edge.target, ty),
    targetId: edge.target,
    y: ty,
    yLo: backward ? -Infinity : Math.min(sy, ty),
    yHi: backward ? Infinity : Math.max(sy, ty),
    fromAbove: !backward && sy < ty,
  };
}

// The arrival SLOT of every row: which of its gap's arrival columns the row's
// drops stand on, counting 0 at the rightmost.
//
// Two rules, and they fight: inside one card the fan must be monotonic so the
// entering runs do not cross each other in front of the card, while ACROSS the
// cards of one layer a slot index means one absolute x -- the columns are
// measured off the gap, not off the card
// -- so two cards using index 0 draw their drops on one line wherever their
// verticals share rows. So each card keeps its rows in port order and the card
// as a whole is pushed to the first base offset at which none of its rows meets
// an already-placed row of another card on the same slot: an interval colouring,
// with the cards taken top to bottom and rows whose verticals miss each other in
// y free to share a slot. The column zone is charged one pitch per forward edge
// (gapRequirements), which is the worst case this can ask for.
//
// Which way "monotonic" runs depends on the SIDE the runs approach from, and
// the derivation is two lines. A run holds its source row across the gap, turns
// down (or up) its column, and leaves along its port row, so it crosses a
// neighbour's column exactly where that column's vertical spans the run's own
// y. Take two rows p above q. Fed from BELOW or by a rail, the far run climbs
// past the near row, so the top row must turn first (leftmost) and the bottom
// row last. Fed from ABOVE, the lower row's source can lie inside the upper
// row's drop, and then the same sense braids them twice -- on the approach and
// again on the port legs -- while the reverse sense (bottom row leftmost) puts
// every vertical outside its neighbour's horizontals. So rows whose every edge
// arrives from above take their offsets in reverse among themselves; the other
// rows keep the old sense, and the two classes keep the offsets port order
// gave them, which is what keeps the card's total width unchanged.
// Beside the slots it hands back the row key of every arriving edge, by edge
// index, so a caller placing the columns need not resolve the rows again.
function arrivalSlots(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
): { slots: Map<string, number>; rowKeyByIndex: Map<number, string> } {
  const model = buildLayerModel(nodes);
  const rows = new Map<string, ArrivalRow>();
  const rowKeyByIndex = new Map<number, string>();
  for (const [index, edge] of edges.entries()) {
    const row = arrivalRowOf(edge, byId, model);
    if (row === undefined) continue;
    rowKeyByIndex.set(index, row.key);
    const seen = rows.get(row.key);
    if (seen === undefined) {
      rows.set(row.key, row);
      continue;
    }
    seen.yLo = Math.min(seen.yLo, row.yLo);
    seen.yHi = Math.max(seen.yHi, row.yHi);
    seen.fromAbove = seen.fromAbove && row.fromAbove;
  }

  // Rows of one card, cards of one layer: the two nesting levels the colouring
  // walks. The layer is the card's HOME one -- its index in the scope it is a
  // direct child of -- because that is the set of cards whose arrival columns
  // really share an x band; a card in a container interior fans against its
  // siblings, not against the root cards its box happens to stand beside.
  const byLayer = new Map<string, Map<string, ArrivalRow[]>>();
  for (const row of rows.values()) {
    const home = homeLayerOf(model, row.targetId);
    if (home === undefined) continue;
    const layer = gapKeyOf(home);
    const cards = byLayer.get(layer) ?? new Map<string, ArrivalRow[]>();
    pushInto(cards, row.targetId, row);
    byLayer.set(layer, cards);
  }

  const slots = new Map<string, number>();
  for (const cards of byLayer.values()) {
    const placed: Array<{ slot: number; yLo: number; yHi: number }> = [];
    const ordered = [...cards.entries()]
      .map(([targetId, list]) => ({
        targetId,
        rows: [...list].sort((a, b) => a.y - b.y),
      }))
      .sort((a, b) => a.rows[0]!.y - b.rows[0]!.y);
    for (const card of ordered) {
      // Offsets in port order, counting 0 at the rightmost column. The default
      // sense puts the topmost row on the leftmost column; the rows fed from
      // above take those same offsets in reverse among themselves, so the
      // bottom one of that group turns down first.
      const above = card.rows.flatMap((row, rank) =>
        row.fromAbove ? [rank] : [],
      );
      const offsets = card.rows.map((_, rank) => card.rows.length - 1 - rank);
      above.forEach((rank, j) => {
        offsets[rank] = card.rows.length - 1 - above[above.length - 1 - j]!;
      });

      const slotAt = (base: number, rank: number): number =>
        base + offsets[rank]!;
      let base = 0;
      while (
        card.rows.some((row, rank) =>
          placed.some(
            (other) =>
              other.slot === slotAt(base, rank) &&
              other.yLo < row.yHi &&
              row.yLo < other.yHi,
          ),
        )
      ) {
        base += 1;
      }
      card.rows.forEach((row, rank) => {
        const slot = slotAt(base, rank);
        slots.set(row.key, slot);
        placed.push({ slot, yLo: row.yLo, yHi: row.yHi });
      });
    }
  }
  return { slots, rowKeyByIndex };
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
    const r = nodeRectOf(node, byId);
    const g = gutterWidth(counts.get(node.id) ?? 0);
    rects.set(node.id, {
      left: r.left - g,
      right: r.left,
      top: r.top - CHAMFER,
      bottom: r.bottom + CHAMFER,
    });
  }
  return rects;
}

// -- Pinned columns and the pitch floor ---------------------------------------
//
// Several families of vertical run share one layer gap: a trunk's junction
// column, the same column pinned as a far member's bend, a target's arrival
// columns, the staggered 1-to-1 bend columns, a jogged leg's descent and its
// source column. Nothing made them keep off each other, so a 1-to-1 vertical
// could land a few units from a trunk column and the pair read as one thick
// line. Every pass that places a column now keeps ENTRY_SLOT_PITCH from the
// columns the passes above it already pinned, and gapRequirements charges the
// column zone so the gap is wide enough to hold them at that spacing.
//
// A column stands in the gap the stamp implies, in the SCOPE the edge's two
// endpoints share: a departing column (a fan-out junction, the bend of a forward
// edge) in the gap right of its SOURCE layer there, an arriving one (a fan-in
// junction, an entry column) in the gap left of its TARGET layer there.
//
// Floating-point slack on a column-to-column distance: both sides are sums of
// the same fractional layout coordinates, so a pair exactly one floor apart must
// not read as a hair short of it.
const COLUMN_EPS = 1e-6;

type PinnedColumn = {
  x: number;
  // A trunk column carries every member's stroke, so a neighbour keeps a whole
  // port stub off it rather than the bare floor.
  trunk: boolean;
  // The edge that put the column there. A pass placing a run for THAT edge reads
  // its own column as no blocker at all: a line does not braid itself.
  owner: string;
};

// The columns already pinned when a pass runs, keyed by gap index. Jog descents
// and jogged source columns are absent by construction: jogForwardLegs runs
// after every caller of this, so those columns do not exist yet -- it keeps off
// the ones here instead.
function pinnedColumnsByGap(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Map<string, PinnedColumn[]> {
  const model = buildLayerModel(nodes);
  const out = new Map<string, PinnedColumn[]>();
  // A column is registered in EVERY candidate gap of its side, not just the
  // innermost one that has a record: the passes that consult this only react to
  // a column within one pitch, so a registration in an outer scope's gap is
  // inert unless the two really do stand beside each other -- and where they do,
  // the floor has to hold whichever frame each was placed in.
  const add = (
    gapKeys: ReadonlyArray<string>,
    x: number | undefined,
    trunk: boolean,
    owner: string,
  ): void => {
    if (x === undefined) return;
    for (const key of gapKeys) {
      pushInto(out, key, { x, trunk, owner });
    }
  };
  for (const edge of edges) {
    const data = edge.data as (BusEdgeData & ItemEdgeData) | undefined;
    const sourceGap = gapKeysFor(model, edge.source, "depart");
    const targetGap = gapKeysFor(model, edge.target, "arrive");
    if (edge.type === "bus") {
      if (data?.fanout === true) add(sourceGap, data.junctionX, true, edge.id);
      if (data?.fanin === true) add(targetGap, data.junctionX, true, edge.id);
      continue;
    }
    if (data?.bendX !== undefined) {
      const trunkPin = data.fanoutColumn === true || data.faninColumn === true;
      add(
        data.faninColumn === true ? targetGap : sourceGap,
        data.bendX,
        trunkPin,
        edge.id,
      );
    }
    add(targetGap, data?.entryX, false, edge.id);
    // A backward member of a trunk carries its rail on the trunk's junction
    // column, pre-stamped by routeTrunkEdges and kept as given by
    // clampBackwardRails. It is therefore fixed while this runs, and it is a
    // trunk column like any other: an arrival slot or a jog descent staked a
    // few units off it reads as one thick line, and the rail cannot yield.
    const rail = routingHintsFromData(edge.data);
    add(sourceGap, rail.railXRight, true, edge.id);
    add(targetGap, rail.railXLeft, true, edge.id);
  }
  return out;
}

// The nearest column at or `dir`-ward of `x` that stands at least the floor from
// every pinned column in `blockers`: step past each one that bites and re-test,
// so the walk is monotonic and ends just clear of a whole cluster. Returns `x`
// itself when nothing bites.
function columnClearOfPinned(
  x: number,
  dir: 1 | -1,
  blockers: ReadonlyArray<PinnedColumn>,
): number {
  let out = x;
  for (let i = 0; i < ARRIVAL_SCAN_LIMIT; i += 1) {
    const hit = blockers.find(
      (b) => Math.abs(b.x - out) < ENTRY_SLOT_PITCH - COLUMN_EPS,
    );
    if (hit === undefined) return out;
    out = hit.x + dir * ENTRY_SLOT_PITCH;
  }
  return out;
}

// A closed x-interval a fan may place columns in.
type Span = { lo: number; hi: number };

// `corridor` minus each pinned column's keep-out band, left to right. A trunk
// column claims a port stub either side, anything else the bare floor. An
// interval of zero width survives: it still seats one column.
function freeSpans(
  corridor: Span,
  pinned: ReadonlyArray<PinnedColumn>,
): Span[] {
  let spans: Span[] = [corridor];
  for (const column of [...pinned].sort((a, b) => a.x - b.x)) {
    const keepOut = column.trunk ? PORT_STUB : ENTRY_SLOT_PITCH;
    const next: Span[] = [];
    for (const span of spans) {
      const leftHi = Math.min(span.hi, column.x - keepOut);
      if (leftHi >= span.lo) next.push({ lo: span.lo, hi: leftHi });
      const rightLo = Math.max(span.lo, column.x + keepOut);
      if (span.hi >= rightLo) next.push({ lo: rightLo, hi: span.hi });
    }
    spans = next;
  }
  return spans;
}

// The absolute x that lies `offset` along the free spans, treating them as one
// line with the blocked bands cut out: so two columns `d` apart on that line are
// at least `d` apart in absolute x, whichever spans they fall in.
function spanColumnAt(spans: ReadonlyArray<Span>, offset: number): number {
  let left = Math.max(0, offset);
  for (const span of spans) {
    const width = span.hi - span.lo;
    if (left <= width) return span.lo + left;
    left -= width;
  }
  return spans[spans.length - 1]!.hi;
}

// -- Arrival columns ----------------------------------------------------------
//
// Every vertical run that drops into a target port from in front of it -- a
// backward rail's left column, a jogged forward leg's descent -- takes one
// ARRIVAL column, and the two passes that hand them out (assignEntryColumns,
// jogForwardLegs) share this model so their slots interleave instead of
// colliding.
//
// With a gap record the columns stand LEFT of the gap's target zone: that zone
// is the room the pre-pass reserved for the chips the arriving edges carry, so a
// column inside it would stand on the chips it was widened for. The first slot
// sits half a slot pitch left of the zone, each next one a pitch further left,
// and each one is walked further left until it clears every column already
// pinned in the same gap by the floor (see the pitch floor above) -- a trunk
// column carries a whole trunk's stroke and a bend column its own, and an
// arrival braiding either reads as one line. Without a record (a hand-built
// fixture, or a caller re-running the passes on its own) the pre-zone rule
// stands: the first slot one stub before the port.
//
// Both lookups are keyed by the EDGE, not by its target: the gap an arriving run
// stands in is a gap of the scope the edge's two endpoints share, and a root gap
// and a container-interior gap can cover the same x band.
type ArrivalModel = {
  // The k-th arrival column in front of one edge's target, k counting from 0.
  columnOf: (edge: Edge, k: number) => number;
  // The gap zones in front of one edge's target, absent when there is no record.
  zoneOf: (edge: Edge) => GapRecord | undefined;
};

// Cap on the skip scan: a gap holds at most a handful of columns, so a
// candidate this far out means the skip list is pathological and the plain
// stagger is the better answer.
const ARRIVAL_SCAN_LIMIT = 64;

function arrivalModelOf(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
  ctx: RoutingCtx | undefined,
  // pinnedColumnsByGap(nodes, edges), when the caller already holds it.
  pinned?: Map<string, PinnedColumn[]>,
): ArrivalModel {
  const gaps = ctx?.gaps ?? [];
  const stubColumn = (edge: Edge, k: number): number => {
    const target = byId.get(edge.target);
    if (target === undefined) return 0;
    return absoluteLeft(target, byId) - PORT_STUB - k * ENTRY_SLOT_PITCH;
  };
  if (gaps.length === 0) {
    return { columnOf: stubColumn, zoneOf: () => undefined };
  }
  const model = buildLayerModel(nodes);
  const gapByKey = new Map(gaps.map((gap) => [gapKeyOf(gap), gap]));
  const pinnedByGap = pinned ?? pinnedColumnsByGap(nodes, edges);
  const gapOf = (edge: Edge): GapRecord | undefined =>
    firstGap(gapByKey, gapKeysFor(model, edge.target, "arrive"));
  return {
    zoneOf: gapOf,
    columnOf: (edge, k) => {
      const gap = gapOf(edge);
      if (gap === undefined) return stubColumn(edge, k);
      const base = gap.targetZone.left - ENTRY_SLOT_PITCH / 2;
      const avoid = pinnedByGap.get(gapKeyOf(gap)) ?? [];
      // Slot k is one pitch left of slot k-1, each walked clear of the pinned
      // columns, so the slots stay ordered and none braids a pinned line.
      let x = columnClearOfPinned(base, -1, avoid);
      for (let i = 0; i < k; i += 1) {
        x = columnClearOfPinned(x - ENTRY_SLOT_PITCH, -1, avoid);
      }
      return x;
    },
  };
}

// The first of a node's candidate gaps that has a record: the innermost scope
// whose layering actually has a gap on that side of the node (gapKeysFor).
function firstGap(
  gapByKey: ReadonlyMap<string, GapRecord>,
  keys: ReadonlyArray<string>,
): GapRecord | undefined {
  for (const key of keys) {
    const gap = gapByKey.get(key);
    if (gap !== undefined) return gap;
  }
  return undefined;
}

// The gap one edge's DEPARTING runs stand in: the innermost gap right of its
// source. The arrival model answers the mirror question for its entering runs,
// so between them a backward rail's two columns each know the zone they belong
// in. Always undefined without gap records.
function sourceGapOfEdge(
  nodes: ReadonlyArray<RFAnyNode>,
  ctx: RoutingCtx | undefined,
): (edge: Edge) => GapRecord | undefined {
  const gaps = ctx?.gaps ?? [];
  if (gaps.length === 0) return () => undefined;
  const gapByKey = new Map(gaps.map((gap) => [gapKeyOf(gap), gap]));
  const model = buildLayerModel(nodes);
  return (edge: Edge): GapRecord | undefined =>
    firstGap(gapByKey, gapKeysFor(model, edge.source, "depart"));
}

// A column clamped into the gap zone it belongs to, the guard every arrival and
// rail column passes through once its obstacle search has run: the search may
// walk a column out of the zone (into a chip reserve, or past the cards), and a
// layer gap holds no leaf card, so pulling it back is always drawable.
function clampToZone(x: number, gap: GapRecord | undefined): number {
  if (gap === undefined) return x;
  return clamp(x, gap.columnZone.left, gap.columnZone.right);
}

// The same zone as a column-search predicate. A column resolver has to know the
// zone up front: clamping its answer afterwards would drag a column that moved
// to dodge something right back onto it.
function zoneAccept(gap: GapRecord | undefined): (x: number) => boolean {
  if (gap === undefined) return () => true;
  return (x: number): boolean =>
    x >= gap.columnZone.left - COLUMN_EPS &&
    x <= gap.columnZone.right + COLUMN_EPS;
}

// assignEntryColumns: give every arriving edge -- a forward step's late drop, a
// backward item rail, a fan-in member -- a per-target staggered column x, merged
// as { entryX } onto its data and consumed by chamferStepPath. One slot per
// entering PORT ROW, shared by every edge on that row, so two flows into adjacent
// rows of one card turn down two columns one ENTRY_SLOT_PITCH apart instead of
// running a row pitch apart across the gap. Rows of one target are ordered by
// port row so the entering runs form a monotonic fan that does not self-cross,
// and the fan runs in the sense of the approach: rows reached from below or by
// a rail put the topmost row on the leftmost column, while rows every edge
// drops INTO from above reverse among themselves and put the bottom row
// leftmost, because a lower row's source can sit inside the upper row's drop
// and the other sense would then cross it twice. arrivalSlots derives both and
// keeps the cards of one layer off each other's columns. The columns themselves
// come from the shared arrival model above -- left of the
// gap's target zone with a gap record, one stub before the port without one, so
// a single-entry node in an un-widened fixture is unchanged.
//
// Pure and deterministic: the column of an edge depends only on its target, its
// port row and the layer's other arrivals, never on edge order. Leaves every
// non-arriving edge untouched by reference. What it needs from the passes before
// it is the ROUTING_PASSES entry in layout.ts.
export function assignEntryColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const arrivals = arrivalModelOf(nodes, edges, byId, ctx);
  const { slots, rowKeyByIndex } = arrivalSlots(nodes, edges, byId);

  const entryXByIndex = new Map<number, number>();
  edges.forEach((edge, index) => {
    const rowKey = rowKeyByIndex.get(index);
    if (rowKey === undefined) return;
    const slot = slots.get(rowKey);
    if (slot === undefined) return;
    entryXByIndex.set(index, arrivals.columnOf(edge, slot));
  });

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
//
// Reserve clamp (against the gap records the pre-pass produced): the band's gap
// is the one right of its source layer, and that gap's COLUMN ZONE is the room
// reserved for columns -- the source chip reserve stands left of it and the
// target chip reserve right of it. So the corridor is intersected with the zone:
// a column left of it would shorten the first leg below the chip box that leg
// owes, and one right of it would do the same to the last leg. The margins above
// still apply where they bite harder. Without gap records (a hand-built fixture,
// or a caller re-running the passes on its own) the margins alone stand.
//
// Pitch floor: the fan does not own its corridor. Every column the passes above
// pinned in the same gap -- a trunk's junction column whatever the member's edge
// type, the same column pinned on a far member, a target's entry columns -- cuts
// its keep-out band out of the corridor, and the members fan across what is
// left, at ENTRY_SLOT_PITCH or wider between any two of them. The reserve pays
// for that (gapRequirements charges the column zone one floor per bend column),
// so the even fan usually clears the floor on its own; where it does not, the
// members stand at the floor itself, centred in the free width. Only when even
// that does not fit does the fan squeeze below the floor -- still better than
// dropping the stagger.
export function assignBendColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const sourceGapOf = sourceGapOfEdge(nodes, ctx);

  const leftMargin = ENTRY_GUTTER_MIN; // keeps columns off the source port stubs

  // Per-node geometry plus entry-gutter width, so the fan can look up the band a
  // next-column node reserves and whether it shares the candidate's rows.
  const gutterCounts = gutterColumnCounts(edges, byId);
  type NodeGeom = { left: number; top: number; bottom: number; gutter: number };
  const geom: NodeGeom[] = nodes.map((n) => {
    const r = nodeRectOf(n, byId);
    return {
      left: r.left,
      top: r.top,
      bottom: r.bottom,
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
  // The gap right of each band's source layer, the one its columns stand in.
  // Every member of a band leaves the same layer, so one record per band.
  const gapByBand = new Map<number, GapRecord>();
  // Columns already claimed in a band, keyed the same way, with the gap-keyed
  // view below as the general answer. The stagger cannot re-place these, but it
  // must not fan another edge's vertical onto one of them either: a staggered
  // column half a stub from a trunk column braids it, and the trunk column
  // carries every member's stroke.
  const pinnedColumnsByBand = new Map<number, PinnedColumn[]>();
  const pinnedByGap = pinnedColumnsByGap(nodes, edges);
  for (const edge of edges) {
    if (edge.type !== "item") continue; // only forward item edges get staggered
    if (edgeItem(edge) === undefined) continue;
    const pinnedData = edge.data as ItemEdgeData | undefined;
    if (pinnedData?.fanoutColumn === true && pinnedData.bendX !== undefined) {
      const source = byId.get(edge.source);
      if (source !== undefined) {
        const band = Math.round(absoluteLeft(source, byId));
        pushInto(pinnedColumnsByBand, band, {
          x: pinnedData.bendX,
          trunk: true,
          owner: edge.id,
        });
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
    pushInto(groups, band, { id: edge.id, sourceRight, targetLeft, yLo, yHi });
    const gap = sourceGapOf(edge);
    if (gap !== undefined) gapByBand.set(band, gap);
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
    // The corridor in absolute x: the two margins above, each tightened to the
    // band gap's column zone where there is a record for it (the reserve clamp).
    const zone = gapByBand.get(band)?.columnZone;
    const marginLeft = Math.max(
      groupLeft + leftMargin,
      zone?.left ?? -Infinity,
    );
    const corridorRight = Math.min(
      groupRight - rightMargin,
      zone?.right ?? Infinity,
    );
    const corridorLeft = marginLeft;
    if (corridorRight - corridorLeft <= 0) continue; // too tight; keep midpoints
    // Cut every pinned column's keep-out band out of the corridor. A trunk
    // column claims a whole port stub (columns closer than that read as one
    // line, and it carries every member's stroke); anything else claims the
    // floor. Falls back to the bare corridor when the claims leave nothing at
    // all -- a squeezed fan is still better than none.
    const pinned = [
      ...(pinnedColumnsByBand.get(band) ?? []),
      ...(gapByBand.has(band)
        ? (pinnedByGap.get(gapKeyOf(gapByBand.get(band)!)) ?? [])
        : []),
    ];
    const corridor = { lo: corridorLeft, hi: corridorRight };
    const cut = freeSpans(corridor, pinned);
    const free = cut.length === 0 ? [corridor] : cut;
    const total = free.reduce((sum, span) => sum + (span.hi - span.lo), 0);
    const sorted = [...list].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    // Even fan first (the same symmetric end gaps the plain corridor fan left);
    // where that pitch is under the floor, the floor itself, centred in the free
    // width; where even that does not fit, the even fan stands and squeezes.
    const evenPitch = total / (sorted.length + 1);
    const atFloor =
      evenPitch < ENTRY_SLOT_PITCH &&
      (sorted.length - 1) * ENTRY_SLOT_PITCH <= total;
    const pitch = atFloor ? ENTRY_SLOT_PITCH : evenPitch;
    const first = atFloor
      ? (total - (sorted.length - 1) * ENTRY_SLOT_PITCH) / 2
      : evenPitch;
    const budget = pitch / 2;
    sorted.forEach((c, i) => {
      bendById.set(c.id, spanColumnAt(free, first + i * pitch));
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
// "level" is not a node at all but another edge's drawn horizontal run, already
// grown by the clearance it wants (forwardLevelBands); it never appears in the
// node-derived obstacle field, only in the sets jogForwardLegs assembles, and
// every filter over that field keys on "card" or "gutter" so it stays out.
export type PaddedObstacle = ObstacleRect & {
  kind: "card" | "gutter" | "level";
  nodeId: string;
};

// The obstacle field a routing pass avoids, in two arms with different
// lifetimes:
//   card arm   a fold over `nodes` alone. The nodes array is the same object
//              for every pass (layoutRenderPlan never re-derives it), so this
//              arm is stable for the whole run.
//   gutter arm a fold over `(nodes, edges-as-of-now)`: occupiesGutterColumn
//              reads edge.type and data.fanout, which routeTrunkEdges
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
    const r = nodeRectOf(node, byId);
    out.push({
      left: r.left - OBSTACLE_PAD_LEFT,
      right: r.right + OBSTACLE_PAD_RIGHT,
      top: r.top - OBSTACLE_PAD_Y,
      bottom: r.bottom + OBSTACLE_PAD_Y,
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
    // Candidate columns the caller derives from a constraint the obstacle list
    // cannot express -- the x where a HORIZONTAL neighbour of the run's own
    // connecting leg ends, say. The search only ever proposes the padded edges
    // of the rects it is handed, so a column that must step past something else
    // is never offered unless it is named here. Each one still passes `blocked`,
    // `accept` and the radius.
    extra?: ReadonlyArray<number>;
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
  const candidates = [
    ...spanned.flatMap((o) => [o.left - gapOf(o), o.right + gapOf(o)]),
    ...(opts?.extra ?? []),
  ].sort((a, b) => a - b);
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
// Exported for the column suite, which observes these rects directly; a routed
// edge only shows the column that won.
export function rawCardRects(
  nodes: ReadonlyArray<RFAnyNode>,
): PaddedObstacle[] {
  const byId = nodeIndexOf(nodes);
  return nodes.map((node) => {
    const r = nodeRectOf(node, byId);
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
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
  // Gate on the COLUMN itself, ANDed into both tiers' acceptance. The rail
  // callers pass their gap's column zone: without it a resolved column is
  // clamped back into the zone AFTER the search, which silently undoes the
  // move the search just made and lands the column back on whatever it was
  // dodging. Unlike sideClamp it opens no pierce-rescue tier, so a caller that
  // omits it resolves exactly as before.
  columnAccept?: ((x: number) => boolean) | undefined;
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
    columnAccept,
  } = args;
  const bands = containerBands ?? [];
  const paddedCards = foreignPadded.filter((o) => o.kind === "card");
  const legExtra = ownLegRect ? [ownLegRect] : [];
  const paddedLegCards = [...paddedCards, ...legExtra];
  const rawLegCards = [...foreignRawCards, ...legExtra];
  const onSide = sideClamp ?? (() => true);
  const inZone = columnAccept ?? (() => true);
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
    onSide(x) &&
    inZone(x) &&
    !connectingLegBlocked(portX, portY, x, paddedLegCards);
  const padded = resolve(tier1Set, CHAMFER, CLEAR_COLUMN_RADIUS, paddedAccept);
  if (padded !== null) return padded;

  // Tier 2: raw fallback. The slim RAW_GAP keeps a hair of air off the raw box
  // (the container gap for slabs: a raw-fallback column parked RAW_GAP off a
  // slab border braided the frame, the loop-return family's raw variant); the
  // doubled radius lets a fully packed near corridor escape to the next gap.
  const tier2Set = [...foreignRawCards, ...bands];
  const rawAccept = (x: number): boolean =>
    onSide(x) &&
    inZone(x) &&
    !connectingLegBlocked(portX, portY, x, rawLegCards);
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

// Every vertical run one edge's DRAWN polyline puts on the canvas, as
// zero-width BORDER BANDS (see clearColumnX). A rail column resolved onto one
// of these lines, or a few units off it, reads as a single thick stroke rather
// than two lines; feeding them to the rail's own column search keeps the
// column pitch floor between families that no single pass owns (a trunk
// junction, an entry slot, a bend column, a jog descent, and another rail's
// column are placed by four different passes). They are BANDS, not cards, so
// they gate the column only and never the connecting legs -- a leg crossing
// another edge's vertical is a plain crossing, which the crossing-cue pass
// already draws.
//
// `container: true` puts them on the wider containerGap arm, which the rail
// callers already set to CONTAINER_COLUMN_GAP -- the same 16 units as the
// column pitch floor (ENTRY_SLOT_PITCH), so one gap value serves both.
function drawnColumnBands(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): PaddedObstacle[] {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return [];
  const { pts } = drawnEdge(ends, edge.type, edge.data);
  const out: PaddedObstacle[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (x0 !== x1 || y0 === y1) continue;
    out.push({
      left: x0,
      right: x0,
      top: Math.min(y0, y1),
      bottom: Math.max(y0, y1),
      kind: "card",
      nodeId: `column:${edge.id}`,
      container: true,
    });
  }
  return out;
}

// A rail's own horizontal run, as an obstacle for the NEXT rail's clearRailY.
// Two rails that share an x-corridor and land on one y are drawn one on top of
// the other for the whole overlap, so each placed rail blocks its own level
// for the rails resolved after it.
//
// The band is a whole CHIP BOX tall on each side of the run, not the zero-height
// line the run actually is: clearRailY seats the next rail just outside the
// band, so the band's half-height IS the separation two rails end up with. A
// rail carries its rate chip centred on its own run, so two rails less than a
// chip box apart stack their two chips on each other -- which reads as one
// smeared figure belonging to neither line.
function railLevelBand(xl: number, xr: number, railY: number): ObstacleRect {
  const band = 2 * CHIP_HALF_H;
  return {
    left: Math.min(xl, xr),
    right: Math.max(xl, xr),
    top: railY - band,
    bottom: railY + band,
  };
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
//
// It is also the last column pass, so it carries the column DECONFLICTION the
// families cannot do for themselves: a rail column keeps the pitch floor off
// every vertical the earlier passes drew and off every rail resolved before it
// (drawnColumnBands), and a rail level keeps clear of every rail level already
// placed in its corridor (railLevelBand). The rail is the family that yields,
// because it is the only one resolved here: an entry slot, a bend column and a
// jog descent are settled by the time this runs.
export function clampBackwardRails(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const arrivals = arrivalModelOf(nodes, edges, byId, ctx);
  const sourceGapOf = sourceGapOfEdge(nodes, ctx);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);
  // Raw rect lookup by node id, for building the shared container's border
  // bands at its RAW edges (the frame the reader sees), not its padded band.
  const rawById = new Map<string, PaddedObstacle>();
  for (const o of rawCards) rawById.set(o.nodeId, o);

  // Is this edge a backward rail, the one family this pass resolves? Every
  // other edge's verticals are final by now and become bands below.
  const isRail = (edge: Edge): boolean => {
    if (edge.type !== "item") return false;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return false;
    return nodeGap(source, target, byId) <= 0;
  };
  // The columns already on the canvas. Rails append their own as they resolve,
  // in index order, so a rail never bands itself, the result is deterministic
  // and every pair separates once.
  const foreignColumnBands: PaddedObstacle[] = [];
  for (const edge of edges) {
    if (isRail(edge)) continue;
    foreignColumnBands.push(...drawnColumnBands(edge, byId));
  }
  // The rail-level field: every card / gutter obstacle, plus the level each
  // rail resolved before this one occupies.
  const levelObstacles: ObstacleRect[] = [...obstacles];

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
    // Columns routeTrunkEdges already pinned: a backward member of a trunk
    // shares that trunk's junction column instead of taking a default one, so
    // its rail leaves (or arrives at) the line its forward siblings draw. A
    // pre-stamped side is kept as given -- no search runs on it.
    const railHints = routingHintsFromData(edge.data);
    const pinnedRight = railHints.railXRight;
    const pinnedLeft = railHints.railXLeft;
    const sourceGap = sourceGapOf(edge);
    const targetGap = arrivals.zoneOf(edge);
    // Rail x-span and level come from chamferStepPath's own backward defaults,
    // so the clamp starts at exactly the shape the drawer would produce, then
    // each side is pulled into the column zone of the gap it stands in (where
    // there is a record for it) so a rail column never crosses a chip reserve.
    const defaults = backwardRailDefaults({
      sx,
      sy,
      tx,
      ty,
      entryX: railHints.entryX,
    });
    const preferredY = defaults.railY;
    const xrDesired = pinnedRight ?? clampToZone(defaults.xr, sourceGap);
    const xlDesired = pinnedLeft ?? clampToZone(defaults.xl, targetGap);
    const railY = clearRailY(
      preferredY,
      xlDesired,
      xrDesired,
      levelObstacles,
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
    const xr =
      pinnedRight ??
      clampToZone(
        clearColumnKeepingLeg({
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
          containerBands: [...bandsOf(source), ...foreignColumnBands],
          containerGap: CONTAINER_COLUMN_GAP,
          columnAccept: zoneAccept(sourceGap),
        }),
        sourceGap,
      );
    // Stamp against the DRAWER's default, not the search's starting point: an
    // unstamped side falls back to backwardRailDefaults, so a column the zone
    // clamp alone moved would be drawn back where the clamp took it from --
    // one stub off the port, inside the card band the zone is there to avoid.
    if (xr !== defaults.xr) railXRightByIndex.set(index, xr);
    const xlExempt = ownExempt([target]);
    const xl =
      pinnedLeft ??
      clampToZone(
        clearColumnKeepingLeg({
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
          containerBands: [...bandsOf(target), ...foreignColumnBands],
          containerGap: CONTAINER_COLUMN_GAP,
          columnAccept: zoneAccept(targetGap),
        }),
        targetGap,
      );
    if (xl !== defaults.xl) railXLeftByIndex.set(index, xl);

    // Record what this rail now occupies, so the rails after it separate from
    // it the same way it separated from the earlier families. Both fields are
    // read only by LATER rails, so pushing here is what keeps a rail out of
    // its own bands.
    foreignColumnBands.push(
      ...drawnColumnBands(
        {
          ...edge,
          data: { ...edge.data, railY, railXRight: xr, railXLeft: xl },
        },
        byId,
      ),
    );
    levelObstacles.push(railLevelBand(xl, xr, railY));
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

// The y clearance two forward horizontal runs of different edges keep where
// they share an x-corridor. Below it the pair reads as a single thick stroke
// carrying two chips -- gas-web held a raw supply and a catalyst supply 2 units
// apart for about a thousand units, with the catalyst's fan-out dot sitting on
// the raw line. ENTRY_SLOT_PITCH is the floor the rule asks for, the same value
// the column families keep on the x axis; the separation actually taken is a
// whole chip box, for the reason railLevelBand takes one -- each run carries
// its rate chip centred on it, so two runs less than a box apart stack their
// two chips into one smeared figure belonging to neither line.
const FORWARD_LEVEL_FLOOR = Math.max(ENTRY_SLOT_PITCH, 2 * CHIP_HALF_H);

// One forward edge's drawn horizontal runs, as level bands for the OTHER
// edges' runs. Read off the drawn polyline rather than the stamps, so the band
// covers the line the reader sees; a backward detour contributes none (its rail
// level is clampBackwardRails' business). Each band carries the level it is
// grown around and its edge's two port rows, which is all the waiver below
// needs.
type LevelPorts = {
  source: string;
  target: string;
  sy: number;
  ty: number;
};

type LevelBand = PaddedObstacle & LevelPorts & { y: number };

function forwardLevelBands(
  edge: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): LevelBand[] {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return [];
  if (ends.targetX <= ends.sourceX) return [];
  const { pts } = drawnEdge(ends, edge.type, edge.data);
  const ports: LevelPorts = {
    source: edge.source,
    target: edge.target,
    sy: ends.sourceY,
    ty: ends.targetY,
  };
  return horizontalRuns(pts).map((run) => ({
    ...ports,
    left: run.lo,
    right: run.hi,
    top: run.y - FORWARD_LEVEL_FLOOR,
    bottom: run.y + FORWARD_LEVEL_FLOOR,
    kind: "level" as const,
    nodeId: `level:${edge.id}`,
    y: run.y,
  }));
}

// Do these two runs draw as ONE line on purpose? They do when they coincide on
// a port row the two edges share: every edge leaving one output row draws the
// same stub out of it, and every edge arriving on one input row draws the same
// approach into it, which is what a trunk is. Sharing the target CARD is not
// enough -- a recipe fed the same item as a raw input and as a catalyst charge
// takes it on two different rows, and those two supplies are two lines.
function sharesPortRow(band: LevelBand, self: LevelPorts, y: number): boolean {
  if (band.y !== y) return false;
  if (band.source === self.source && band.sy === self.sy && y === self.sy) {
    return true;
  }
  return band.target === self.target && band.ty === self.ty && y === self.ty;
}

// Does a horizontal run at `y` from x0 to x1 break the floor against any of
// these bands? The x test is an OVERLAP LENGTH, not the bare intersection
// legBlockedIn uses: two runs that share less than a port stub of span are a
// corner meeting a line, not one smeared line, and forcing them apart would jog
// an edge for a graze nobody reads as a collision. A band the run shares a port
// row with is waived (sharesPortRow).
function levelNear(
  bands: ReadonlyArray<LevelBand>,
  self: LevelPorts,
  y: number,
  x0: number,
  x1: number,
): boolean {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  return bands.some(
    (b) =>
      !sharesPortRow(b, self, y) &&
      Math.min(hi, b.right) - Math.max(lo, b.left) > PORT_STUB &&
      y > b.top &&
      y < b.bottom,
  );
}

// The columns at which the stub between a port at (portX, y) and a vertical run
// at x stops sharing more than PORT_STUB of span with a level band it lies
// beside -- one per band the stub could strike, the nearest x that satisfies
// levelNear. The column searches take these as `extra` candidates: a band is no
// obstacle to a VERTICAL run, so it is absent from the rect list the search
// derives its candidates from, and a descent that need only step past the end of
// the line beside its stub would never be offered that column. Without them the
// whole jog is declined and the pair stays drawn as one stroke.
// `columnSide` says which side of the port the column stands on: "left" for a
// descent (its stub runs rightward into the target), "right" for a jogged source
// column (its stub runs leftward back to the source port).
function stubClearColumns(
  bands: ReadonlyArray<LevelBand>,
  self: LevelPorts,
  y: number,
  portX: number,
  columnSide: "left" | "right",
): number[] {
  return bands
    .filter((b) => !sharesPortRow(b, self, y) && y > b.top && y < b.bottom)
    .map((b) =>
      columnSide === "left"
        ? Math.min(b.right, portX) - PORT_STUB
        : Math.max(b.left, portX) + PORT_STUB,
    );
}

// jogForwardLegs: bend a forward item edge's long horizontal around any
// intervening card it would otherwise cross. Since the late drop that run is the
// SOURCE one: a forward step holds the source-port y from the port out to the
// target's entry column, and on a layer-skipping edge that run can slice straight
// through a node card sitting at the same row one layer over (the run at the
// target row is only the approach band in front of the target and stays in the
// gap). When the padded obstacle provider reports a run
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
// blocked piece, the step leaves sy at a cleared column inside the column zone
// of the gap right of its source layer (srcColX, replacing the bend column)
// instead of running to the bend first; with a clear final leg that collapses
// to a single srcColX column straight to ty. Two members of one trunk that both
// jog take columns one ENTRY_SLOT_PITCH apart, so their source stubs stay
// distinct lines each carrying its own chip. Two obstacle tiers: full padded quality first, then a
// raw-card fallback where overlapping sibling paddings leave no padded-clear
// jog (threading the raw gaps beats keeping a straight leg through a card).
// When no candidate clears in either tier, the edge keeps its straight leg --
// no worse than before -- and the residual is left for a deeper routing pass
// rather than a jog that fights itself.
//
// The pass has a SECOND trigger, the horizontal analog of the column pitch
// floor: a forward run that comes closer than FORWARD_LEVEL_FLOOR in y to
// another edge's forward run, over more than a port stub of shared x-span, is
// jogged clear of it even though no card is in its way. The level bands of
// every forward edge are seeded from the pre-pass geometry and refreshed as
// each edge resolves, so the pair separates once: whichever of the two reaches
// the scan first moves, and a run the jog cannot relocate (the stub between the
// source port and the bend column) is a band the other edge yields to rather
// than a strike of its own. Two runs that coincide on a port row their edges
// share are waived (sharesPortRow): that pair is one line on purpose. The bands
// join the tier scan beside the cards, so a level clearing the floor also
// clears every card; should no such level exist, a card-blocked edge falls back
// to the band-blind tier, which is exactly the tier this pass ran before the
// floor existed. The floor never costs an edge a card-clearing jog.
//
// It reads each edge's FINAL bendX (the leg starts at that column); which pass
// settles it is the ROUTING_PASSES entry in layout.ts.
// Every forward edge is scanned, the same-y straight line and the small-dy
// diagonal included: a trunk member demoted here because its straight run
// crosses a card is exactly the edge whose ports share a row, and the drawer
// consumes { legY } ahead of both shortcuts. Threads { legY } onto the affected edges;
// every other edge passes through by reference. Pure and deterministic.
export function jogForwardLegs(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  ctx?: RoutingCtx,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const pinnedByGap = pinnedColumnsByGap(nodes, edges);
  const arrivals = arrivalModelOf(nodes, edges, byId, ctx, pinnedByGap);

  const obstacles = paddedObstacles(nodes, edges);
  const rawCards = rawCardRects(nodes);

  // Descent-slot occupancy per target (jog descents coordinate with entry
  // columns): a target hosting k gutter columns (backward rails / bus rises)
  // owns slots tx-PORT_STUB .. tx-PORT_STUB-(k-1)*pitch, so a jogged descent
  // starts one pitch further left, and each additional jog into the same
  // target takes the next slot leftward. This is the gutter-occupant
  // registration for jogs: no two jogs into one target, and no jog vs rail /
  // rise pair, ever draw coincident verticals at the default column. The late
  // drops need no count of their own: the arrival model walks every candidate
  // clear of the entry columns assignEntryColumns already pinned. Every jog
  // takes a place in the queue, the ones that descend at their own entry column
  // included: the count is how many verticals stand in front of that card, not
  // how many of them asked this model where to stand.
  const gutterCounts = gutterColumnCounts(edges, byId);
  const jogsByTarget = new Map<string, number>();

  // The mirror bookkeeping on the SOURCE side. A jogged source column stands in
  // the gap right of its source layer, and that gap's column zone is the room
  // reserved for columns: a column parked in the source chip reserve stands on
  // the chips the gap was widened for, and two members of one trunk sharing a
  // column merge into one line before they reach the trunk's own column. So
  // each source column starts half a slot pitch inside its zone, each further
  // member of the SAME trunk steps one pitch right, and the obstacle search is
  // confined to the zone. Without gap records (a hand-built fixture, or a
  // caller re-running the passes on its own) the pre-zone rule stands: one
  // stub plus a chamfer out of the source port.
  const sourceGapOf = sourceGapOfEdge(nodes, ctx);
  // The columns THIS pass stakes out, by gap. pinnedColumnsByGap is read off the
  // edges as the earlier passes left them and so knows none of them, while the
  // per-target counts above only separate jogs into ONE card: two jogs into two
  // cards of the same layer stand in the same gap, walk the same zone from the
  // same slot, and settle on the same x -- two verticals drawn as one line. A
  // column registered here is a blocker for every jog scanned after it, exactly
  // as a pre-pinned one is.
  const stakedByGap = new Map<string, PinnedColumn[]>();
  const columnsPinnedIn = (gap: GapRecord | undefined): PinnedColumn[] => {
    if (gap === undefined) return [];
    const key = gapKeyOf(gap);
    return [...(pinnedByGap.get(key) ?? []), ...(stakedByGap.get(key) ?? [])];
  };
  const stakeColumn = (
    gap: GapRecord | undefined,
    x: number,
    owner: string,
  ): void => {
    if (gap === undefined) return;
    const key = gapKeyOf(gap);
    stakedByGap.set(key, [
      ...(stakedByGap.get(key) ?? []),
      { x, trunk: false, owner },
    ]);
  };
  const trunkByEdgeId = classifyTrunks(nodes, edges).trunkByEdgeId;
  const srcSlotsByTrunk = new Map<string, number>();
  const trunkKeyOf = (edge: Edge): string | undefined => {
    const sides = trunkByEdgeId.get(edge.id);
    return sides?.fanIn?.key ?? sides?.fanOut?.key;
  };
  // The level field the floor is measured against: every forward edge's drawn
  // runs, seeded from the geometry the passes above left and refreshed below as
  // each edge resolves, so a jog moves the mover's band with it.
  const levelBands = new Map<string, LevelBand[]>();
  for (const edge of edges) {
    levelBands.set(edge.id, forwardLevelBands(edge, byId));
  }

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
    // A same-y edge is drawn as a straight line and a small-dy edge as a single
    // diagonal, but neither shape can dodge a card: a member the trunk router
    // demoted BECAUSE its straight run crosses a card arrives here at its
    // target's own row. So every forward edge is scanned, and the drawer
    // consumes { legY } ahead of those two shortcuts -- an unblocked edge is
    // still stamped with nothing and still drawn straight.
    // forwardStepGeometry is the drawer's own bend-column derivation, so the
    // leg's start x matches the drawn path by construction.
    const hints = routingHintsFromData(edge.data);
    const geom = forwardStepGeometry(sx, tx, hints.bendX);
    const bx = geom.bx;
    // Where the straight step turns down: the target's entry column since the
    // late drop, so the long horizontal at sy runs out to HERE and the run at the
    // target row is only the approach band.
    const dropX = forwardDropX(geom, hints);

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
    const isForeignCard = (o: PaddedObstacle): boolean =>
      o.kind === "card" && !exempt.has(o.nodeId);

    // Nothing to jog unless the straight step is dirty: the long SOURCE
    // horizontal at sy out to the drop column, or the approach at ty from there
    // into the port, crosses a foreign card. (A blocked drop VERTICAL with both
    // legs clean is not a jog.) Since the late drop the long run is the source
    // one, and the run at ty is the approach band -- which lies in the gap in
    // front of the target and so is dirty only in a degenerate placement, where
    // the drop collapses back onto the bend column. Tested on the whole field
    // through the foreign-card filter, so an edge that turns out clean pays for
    // no obstacle lists.
    const tgtBlocked = legBlockedIn(obstacles, ty, dropX, tx, isForeignCard);
    const srcBlocked = legBlockedIn(obstacles, sy, sx, dropX, isForeignCard);
    const cardBlocked = tgtBlocked || srcBlocked;

    // The jog runs the long horizontal from its entry column to the descent
    // column, then descends into the target port. The descent's desired column
    // is the target's next free entry slot (see occupancy above).
    const occupied =
      (gutterCounts.get(edge.target) ?? 0) +
      (jogsByTarget.get(edge.target) ?? 0);

    // The descent's desired column. A jog around a CARD takes the arrival
    // model's next free slot: the straight shape is unroutable, so where the
    // edge turns down is this pass's to choose. A jog fired only by the level
    // floor moves the long run's LEVEL and nothing else, and its late-drop entry
    // column is already a slot of its own (assignEntryColumns); taking a slot
    // further left instead would lengthen the approach band it shares with the
    // other flows into the same card for no gain.
    const descentX0 =
      cardBlocked || hints.entryX === undefined
        ? arrivals.columnOf(edge, occupied)
        : hints.entryX;

    // The floor trigger is asked only of the stretch a jog RELOCATES: from the
    // bend column out to the drop column at sy, and from there to the descent
    // column at ty. The runs outside that stretch (source port to bend column,
    // descent column to target port) survive the jog unmoved, so a strike on
    // one of them is not this edge's to fix -- it is a band the other edge
    // yields to when its own turn comes.
    // Either stretch can be EMPTY -- an edge that drops at its bend column has
    // nothing to relocate at sy, and one whose descent would stand left of its
    // drop column has nothing to relocate at ty -- and an empty stretch owes
    // nothing, so the bounds are taken in order rather than normalised. A clean
    // edge with both stretches empty cannot fire at all.
    const srcStretch = dropX > bx;
    const tgtStretch = descentX0 > dropX;
    if (!cardBlocked && !srcStretch && !tgtStretch) return;

    // The level bands this edge owes clearance to: every other edge's, confined
    // to this edge's own x-corridor, since a band it never runs beside cannot
    // be struck and would only lengthen the candidate scan. Which of them are
    // waived is levelNear's rule, not a filter here, because the waiver depends
    // on the level being tested.
    const self: LevelPorts = {
      source: edge.source,
      target: edge.target,
      sy,
      ty,
    };
    const foreignBands: LevelBand[] = [];
    for (const [otherId, bands] of levelBands) {
      if (otherId === edge.id) continue;
      for (const band of bands) {
        if (band.right > sx && band.left < tx) foreignBands.push(band);
      }
    }
    const srcNear = srcStretch && levelNear(foreignBands, self, sy, bx, dropX);
    const tgtNear =
      tgtStretch && levelNear(foreignBands, self, ty, dropX, descentX0);
    if (!cardBlocked && !srcNear && !tgtNear) return;

    // The gap the descent stands in, when there is a record for it: every
    // candidate column below is confined to its column zone, so a descent
    // pushed clear of a card cannot end up inside the chip reserve in front of
    // the target.
    const descentGap = arrivals.zoneOf(edge);
    const inDescentZone = (x: number): boolean =>
      descentGap === undefined ||
      (x >= descentGap.columnZone.left && x <= descentGap.columnZone.right);

    // The gap the source column stands in, and this member's slot inside its
    // trunk (see the bookkeeping above).
    const sourceGap = sourceGapOf(edge);
    const trunkKey = trunkKeyOf(edge);
    const srcSlot =
      trunkKey === undefined ? 0 : (srcSlotsByTrunk.get(trunkKey) ?? 0);
    const inSourceZone = (x: number): boolean =>
      sourceGap === undefined ||
      (x >= sourceGap.columnZone.left && x <= sourceGap.columnZone.right);
    // Walked rightward clear of the columns already pinned in that gap (the
    // bend columns the fan placed included), so a jogged source column does not
    // braid one of them; without a record there is no gap to walk inside.
    const desiredSrcColX =
      sourceGap === undefined
        ? sx + PORT_STUB + CHAMFER
        : columnClearOfPinned(
            sourceGap.columnZone.left +
              ENTRY_SLOT_PITCH / 2 +
              srcSlot * ENTRY_SLOT_PITCH,
            1,
            columnsPinnedIn(sourceGap),
          );

    const foreignCards = obstacles.filter(isForeignCard);
    const foreignAll = obstacles.filter((o) => !exempt.has(o.nodeId));
    const foreignRaw = rawCards.filter((o) => !exempt.has(o.nodeId));
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

    // Try one obstacle tier: find (entry column C, rail level R, descent D)
    // with every piece clear in this tier's card / obstacle sets. R candidates:
    // ty itself (single-column shape, only useful when the source leg is the
    // blocked piece) plus each spanned card's padded top / bottom gap, nearest
    // to ty first so the jog takes the smallest vertical excursion.
    type Jog = { C: number; R: number; D: number };
    // `relaxed` is the last-resort mode (see the tier chain below): the column
    // searches drop the zone confinement and the escape radius, so a column may
    // stand inside a layer's OWN x-band and as far from its desired slot as the
    // obstacles demand.
    // How much of the shape the level bands get a veto over:
    //   "all"  every run, the residual stubs at sy and ty included -- the jog
    //          that leaves the whole edge clear of the floor.
    //   "rail" the run at R alone, the piece the jog actually relocates. The
    //          stubs are where they were whatever R comes out, so holding them
    //          to the floor here only vetoes jogs that could never fix them.
    //   "off"  none of it, the shape this pass chose before the floor existed.
    type BandMode = "all" | "rail" | "off";
    // Nearest to ty first, ties broken by the row value itself: the rails are
    // deduped numbers, so (distance, row) is a TOTAL order and the chosen
    // rail no longer depends on the order the obstacles were handed in.
    // A level band already carries the clearance it wants, so its own edges
    // ARE candidate levels; offering only the padded ones would skip the
    // level that just clears a neighbouring line and land on the line past
    // it. Both are offered, since a candidate further out of a band is no
    // less clear of it. A card offers its padded gaps as before.
    // The list depends only on the obstacle tier and on whether the bands are
    // admitted, so the tier chain below builds each one once per edge.
    const railsByTier = new Map<
      ReadonlyArray<PaddedObstacle>,
      Map<string, number[]>
    >();
    const railsFor = (
      cardSet: ReadonlyArray<PaddedObstacle>,
      pad: number,
      withBands: boolean,
    ): number[] => {
      const bySet = railsByTier.get(cardSet) ?? new Map<string, number[]>();
      railsByTier.set(cardSet, bySet);
      const key = `${pad}|${withBands}`;
      const cached = bySet.get(key);
      if (cached !== undefined) return cached;
      const spanning = [...cardSet, ...(withBands ? foreignBands : [])].filter(
        (o) => o.right > sx && o.left < tx,
      );
      const rails = [
        ...new Set(
          spanning.flatMap((o) =>
            o.kind === "level"
              ? [o.top, o.bottom, o.top - pad, o.bottom + pad]
              : [o.top - pad, o.bottom + pad],
          ),
        ),
      ].sort((a, b) => Math.abs(a - ty) - Math.abs(b - ty) || a - b);
      bySet.set(key, rails);
      return rails;
    };
    const tryTier = (
      cardSet: ReadonlyArray<PaddedObstacle>,
      columnSet: ReadonlyArray<PaddedObstacle>,
      pad: number,
      colGap: number,
      relaxed: boolean,
      bands: BandMode,
    ): Jog | null => {
      const radius = relaxed ? Infinity : CLEAR_COLUMN_RADIUS;
      // Is a horizontal run dirty? The run at R answers for the bands in every
      // mode but "off"; the residual stubs answer for them only in "all".
      const railBlocked = (y: number, x0: number, x1: number): boolean =>
        legBlockedIn(cardSet, y, x0, x1) ||
        (bands !== "off" && levelNear(foreignBands, self, y, x0, x1));
      const stubBlocked = (y: number, x0: number, x1: number): boolean =>
        legBlockedIn(cardSet, y, x0, x1) ||
        (bands === "all" && levelNear(foreignBands, self, y, x0, x1));
      // The columns the stubs need when the bands have a say over them, offered
      // to the searches below: stubClearColumns' header says why the searches
      // cannot derive them for themselves.
      const stubColumns = (y: number, portX: number, side: "left" | "right") =>
        bands === "all"
          ? stubClearColumns(foreignBands, self, y, portX, side)
          : [];
      const rails = railsFor(cardSet, pad, bands !== "off");
      const candidates = srcBlocked ? [ty, ...rails] : rails;
      // Everything below that does not depend on R, taken once per tier.
      const srcStubColumns = stubColumns(sy, sx, "right");
      const tgtStubColumns = stubColumns(ty, tx, "left");
      const descentColumnSet = columnSet.filter(
        (o) => o.nodeId !== edge.target,
      );
      for (const R of candidates) {
        // A detour level inside the floor of the row it left has cleared
        // nothing: the stub at ty is still drawn, so the edge reads as two
        // lines a few units apart instead of one. Only the band-blind mode
        // takes such a level, and only because it is the shape this pass drew
        // before the floor existed.
        if (
          bands !== "off" &&
          R !== ty &&
          Math.abs(R - ty) < FORWARD_LEVEL_FLOOR
        ) {
          continue;
        }
        // Entry column: the bend column when the source leg is clean, else a
        // cleared column just out of the source port whose own stub leg stays
        // clear.
        let C = bx;
        if (srcBlocked) {
          C = clearColumnX(
            desiredSrcColX,
            Math.min(sy, R),
            Math.max(sy, R),
            columnSet,
            {
              towardTarget: 1,
              gap: colGap,
              radius,
              extra: srcStubColumns,
              accept: (x) =>
                x > sx &&
                x < tx &&
                (relaxed || inSourceZone(x)) &&
                !stubBlocked(sy, sx, x),
            },
          );
          if (vRunBlockedIn(columnSet, C, sy, R) || stubBlocked(sy, sx, C)) {
            continue;
          }
        } else if (vRunBlockedIn(columnSet, bx, sy, R)) {
          continue;
        }
        if (R === ty) {
          // Single-column shape: C from sy straight to ty, then the long
          // horizontal at ty into the target.
          if (railBlocked(ty, C, tx)) continue;
          return { C, R, D: descentX0 };
        }
        // The descent must stay left of the target port (final approach runs
        // rightward into the Left handle; a column at or past tx would reverse
        // the closing stub and flip the arrow).
        const D = clearColumnX(
          descentX0,
          Math.min(R, ty),
          Math.max(R, ty),
          descentColumnSet,
          {
            towardTarget: 1,
            gap: colGap,
            radius,
            extra: tgtStubColumns,
            accept: (x) =>
              x <= tx - CHAMFER &&
              (relaxed || inDescentZone(x)) &&
              !stubBlocked(ty, x, tx),
          },
        );
        if (D > tx - CHAMFER) continue;
        if (railBlocked(R, C, D)) continue;
        if (vRunBlockedIn(columnSet, D, R, ty)) continue;
        if (stubBlocked(ty, D, tx)) continue;
        return { C, R, D };
      }
      return null;
    };

    // Padded tier first (full quality), then the raw-card fallback where
    // overlapping sibling paddings leave no padded-clear jog: threading the raw
    // gaps beats keeping a straight leg through a card. Both tiers run
    // band-aware first, so a level that also clears the floor wins; a
    // card-blocked edge then retries band-free, because a corridor whose every
    // level already carries a line still owes its card the detour. The floor
    // therefore never costs an edge the jog it needed anyway.
    const chain = (relaxed: boolean): Jog | null => {
      const tiers = (bands: BandMode): Jog | null =>
        tryTier(foreignCards, foreignAll, CHAMFER, CHAMFER, relaxed, bands) ??
        tryTier(foreignRaw, foreignRaw, 2, 2, relaxed, bands);
      return (
        tiers("all") ?? tiers("rail") ?? (cardBlocked ? tiers("off") : null)
      );
    };
    const confined = chain(false);
    // Last resort, both obstacle tiers again with the column searches relaxed.
    // A column is normally confined to its gap's column zone and to one card
    // plus one layer spacing of escape, which is the right rule while the
    // blocking card stands in a layer of its own. It is not reachable at all
    // when the card shares a LAYER with the endpoint -- a container slab merges
    // every column it spans into one layer, so the zone can sit hundreds of
    // units the wrong side of the card and no candidate inside it, or inside
    // the radius, is clear. A column standing in that layer's own band beats a
    // leg drawn through the card; it stands in no gap, so it takes no room
    // reserved for chips or for another gap's columns.
    const jog = confined ?? chain(true);
    if (jog === null) return; // no clear jog -> straight leg residual
    // The zone clamp is the confined tiers' own guard; a relaxed column is out
    // of the zone on purpose, so clamping it would put it straight back on the
    // card it escaped.
    const zoned = confined !== null;

    // The stamped column: the search's answer pulled into its zone, and then
    // walked off any column the pull put it on. clearColumnX hands the desired
    // column back when no candidate qualifies, so the zone clamp can land a
    // column on the zone's own edge, where an arrival column of the same gap may
    // already stand -- two lines eight units apart read as one. This edge's OWN
    // pinned columns (its entry column above all, which a floor-driven jog
    // descends at on purpose) are not such neighbours and are filtered out: a
    // line does not braid itself.
    //
    // The walk goes toward the source first, as it always has, and toward the
    // target when that answer does not survive `clear` -- the floor the descent
    // was placed to keep is a clearance the walk can spend, and the side that
    // keeps it is the side to walk. A walk that would put the column through a
    // card, back out of the zone, or back inside the floor either way is dropped
    // for the clamped value: that is the degrade this pass has always taken.
    const settle = (
      x: number,
      gap: GapRecord | undefined,
      clear: (candidate: number) => boolean,
    ): number => {
      if (!zoned) return x; // a relaxed column is out of the zone on purpose
      const pulled = clampToZone(x, gap);
      const blockers = columnsPinnedIn(gap).filter((b) => b.owner !== edge.id);
      const walked = columnClearOfPinned(pulled, -1, blockers);
      if (walked === pulled) return pulled;
      const settled = (candidate: number): boolean =>
        clear(candidate) && clampToZone(candidate, gap) === candidate;
      if (settled(walked)) return walked;
      const back = columnClearOfPinned(pulled, 1, blockers);
      return settled(back) ? back : pulled;
    };

    if (jog.R !== ty) {
      legYByIndex.set(index, jog.R);
      const descentX = settle(
        jog.D,
        descentGap,
        (x) =>
          x <= tx - CHAMFER &&
          !vRunBlockedIn(foreignAll, x, jog.R, ty) &&
          !legBlockedIn(foreignCards, ty, x, tx) &&
          !legBlockedIn(foreignCards, jog.R, jog.C, x) &&
          // The floor on the approach stub the search just cleared: a walk that
          // puts the column back inside another line's band undoes the jog.
          !levelNear(foreignBands, self, ty, x, tx),
      );
      if (descentX !== tx - PORT_STUB) descentXByIndex.set(index, descentX);
      stakeColumn(descentGap, descentX, edge.id);
      jogsByTarget.set(edge.target, (jogsByTarget.get(edge.target) ?? 0) + 1);
    }
    if (srcBlocked) {
      const srcColX = settle(
        jog.C,
        sourceGap,
        (x) =>
          x > sx &&
          x < tx &&
          !vRunBlockedIn(foreignAll, x, sy, jog.R) &&
          !legBlockedIn(foreignCards, sy, sx, x),
      );
      srcColXByIndex.set(index, srcColX);
      stakeColumn(sourceGap, srcColX, edge.id);
      if (trunkKey !== undefined) srcSlotsByTrunk.set(trunkKey, srcSlot + 1);
    }

    // This edge now draws somewhere else, so the edges scanned after it must
    // see the band where the line actually is. Stamps read back out of the
    // maps, so the refreshed geometry is the one the pass returns.
    levelBands.set(
      edge.id,
      forwardLevelBands(
        {
          ...edge,
          data: {
            ...edge.data,
            ...(legYByIndex.has(index) ? { legY: legYByIndex.get(index) } : {}),
            ...(descentXByIndex.has(index)
              ? { jogDescentX: descentXByIndex.get(index) }
              : {}),
            ...(srcColXByIndex.has(index)
              ? { srcColX: srcColXByIndex.get(index) }
              : {}),
          },
        },
        byId,
      ),
    );
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
