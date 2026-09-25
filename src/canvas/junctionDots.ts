// Where the junction dots of plain item edges stand, derived from the drawn
// polylines. Two passes read it: the chip seating pass stamps each dot on its
// owner edge for the renderer, and the forward jog pass keeps its levels off
// the dots of other flows.

import type { Edge } from "@xyflow/react";

import { CHAMFER, drawnEdge, routingHintsFromData } from "./edgePath";
import { drawnPortsOf, edgeItem, flowKeyOf } from "./nodeGeometry";
import { pushInto } from "../util/multimap";
import type { RFAnyNode } from "./layout";

type Pt = { x: number; y: number };
type Polyline = ReadonlyArray<readonly [number, number]>;

// The row tolerance the divergence derivation compares against: every
// comparison is in the DRAWN frame (drawnPortsOf, the same reconstruction the
// polylines came from), so a unit of slack is a real collinearity tolerance
// rather than a budget already spent on a frame mismatch.
const ROW_EPS = 1;

// DIVERGENCE DOTS for declined fan-outs (#43): N >= 2 same-(item, source)
// item edges into >= 2 distinct targets whose gap fell outside
// routeTrunkEdges' span band stay plain ItemEdges. They leave the shared out-port coincident and
// peel off one at a time, so the reader sees ONE line and takes a member's
// rate for the whole flow. Mark the split with a junction dot on one owner
// edge -- the counterpart of the fan-in merge dot, and of the dot a real
// fan-out trunk draws from BusEdge. Bus-typed members never reach here (they
// have no item geometry), so an accepted trunk is not double-marked. No
// aggregate chip rides along: a declined fan-out's gap was never widened for
// one, and its shared prefix is too short to hold the box. Presentational
// only -- no edge is retyped.
//
// Keyed by the owner's index in `edges`; `itemPtsById` holds the drawn
// polyline of every item edge.
export function divergenceDotsByIndex(
  edges: ReadonlyArray<Edge>,
  itemPtsById: ReadonlyMap<string, Polyline>,
): Map<number, Pt> {
  const fanoutJunctionByIndex = new Map<number, Pt>();
  type DivergenceMember = {
    index: number;
    id: string;
    target: string;
    sx: number;
    sy: number;
    // x of the last vertex still on the source row, i.e. where this member
    // peels off. Undefined for a member that never leaves the row.
    bendX: number | undefined;
  };
  const divergenceGroups = new Map<string, DivergenceMember[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const pts = itemPtsById.get(edge.id);
    if (pts === undefined) return;
    if (pts.length < 2) return;
    const sx = pts[0]![0];
    const sy = pts[0]![1];
    // A backward member leaves through its own detour rail rather than sharing
    // a forward prefix, so it neither carries the dot nor counts as a target of
    // the split.
    if (pts[pts.length - 1]![0] <= sx) return;
    let bendX: number | undefined;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]![1] - sy) > ROW_EPS) {
        bendX = pts[i - 1]![0];
        break;
      }
    }
    const key = flowKeyOf(edgeItem(edge), edge.source);
    pushInto(divergenceGroups, key, {
      index,
      id: edge.id,
      target: edge.target,
      sx,
      sy,
      bendX,
    });
  });
  for (const members of divergenceGroups.values()) {
    if (members.length < 2) continue;
    // Same-(item, source) edges into ONE unit are a parallel bundle drawn as a
    // single line, not a split -- the mirror of the fan-in distinct-sources rule.
    if (new Set(members.map((m) => m.target)).size < 2) continue;
    // The split becomes visible where the FIRST member peels off; before that
    // every member is still on the shared row. A group where nobody bends draws
    // no visible divergence at all, so it gets no dot.
    const bends = members.filter((m) => m.bendX !== undefined);
    if (bends.length === 0) continue;
    const junctionX = Math.min(...bends.map((m) => m.bendX!));
    // The owner is elected among the BENDING members only: the column above is
    // one of their peel-offs, and a straight member whose target stops short of
    // it would carry a stamp off its own line, which the render layer's
    // on-own-polyline gate then hides while the keep-offs still push chips away
    // from the invisible dot.
    const owner = bends.reduce((a, b) => (a.id <= b.id ? a : b));
    // A dot at the port itself would read as part of the source card's own
    // output row, not as a split in the run.
    if (junctionX <= owner.sx) continue;
    fanoutJunctionByIndex.set(owner.index, { x: junctionX, y: owner.sy });
  }
  return fanoutJunctionByIndex;
}

// FAN-IN CONVERGENCE DOT for a trunk drawn entirely from FAR members. A
// fan-in member reaching its target from the next layer back is retyped bus
// and BusEdge draws the trunk's merge dot; a member further back stays a
// plain item edge pinned to the trunk's column (faninColumn beside bendX),
// and where every member is such a one no BusEdge exists to draw it. The
// members still converge -- they all run into the same port along the same
// row -- so the reader sees several lines become one with nothing marking
// the merge, the very confusion the dot exists to prevent. One elected member
// carries it, the mirror of the declined-fan-out divergence dot above.
//
// The dot sits where the retyped shape would put it: one chamfer past the
// trunk's column on the target row (chamferFaninPath's junction). Members
// that jog may already run collinear left of it, from their source-side jog
// columns on; the dot still marks the trunk column, not that earlier
// coincidence. The point lies on every member's own final run, so each
// member's renderer can
// corroborate the stamp against the line it drew.
//
// Keyed by the owner's index in `edges`; `targetYById` holds the drawn target
// row of every edge.
export function faninDotsByIndex(
  edges: ReadonlyArray<Edge>,
  targetYById: ReadonlyMap<string, number>,
): Map<number, Pt> {
  const faninJunctionByIndex = new Map<number, Pt>();
  type FaninMember = { index: number; id: string; x: number; y: number };
  const faninGroups = new Map<string, FaninMember[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const column = (edge.data as { faninColumn?: boolean } | undefined)
      ?.faninColumn;
    const bendX = routingHintsFromData(edge.data).bendX;
    if (column !== true || bendX === undefined) return;
    const ty = targetYById.get(edge.id);
    if (ty === undefined) return;
    // One trunk is one (item, target port) with one column, the same key
    // routeTrunkEdges pinned the column by.
    const key = `${edgeItem(edge) ?? ""}|${edge.target}|${bendX}`;
    pushInto(faninGroups, key, {
      index,
      id: edge.id,
      x: bendX + CHAMFER,
      y: ty,
    });
  });
  for (const members of faninGroups.values()) {
    if (members.length < 2) continue;
    const owner = members.reduce((a, b) => (a.id <= b.id ? a : b));
    faninJunctionByIndex.set(owner.index, { x: owner.x, y: owner.y });
  }
  return faninJunctionByIndex;
}

// One junction dot and the trunk it marks: the flow of `item` leaving `unit`
// (a split, side "source") or reaching it (a merge, side "target").
export type JunctionDotSite = Pt & {
  item: string | undefined;
  side: "source" | "target";
  unit: string;
};

// Every junction dot the edges draw as they stand: a trunk member's split or
// merge dot (BusEdge), a declined fan-out's divergence dot and a far fan-in's
// convergence dot. Coincident dots of one trunk are listed once per member.
export function junctionDotSites(
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
): JunctionDotSite[] {
  const out: JunctionDotSite[] = [];
  const itemPtsById = new Map<string, Polyline>();
  const targetYById = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type !== "item" && edge.type !== "bus") continue;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    targetYById.set(edge.id, ends.targetY);
    const drawn = drawnEdge(ends, edge.type, edge.data);
    if (drawn.shape === "item") {
      itemPtsById.set(edge.id, drawn.pts);
      continue;
    }
    const merge = drawn.shape === "fanin";
    out.push({
      ...drawn.junction,
      item: edgeItem(edge),
      side: merge ? "target" : "source",
      unit: merge ? edge.target : edge.source,
    });
  }
  for (const [index, at] of divergenceDotsByIndex(edges, itemPtsById)) {
    const edge = edges[index]!;
    out.push({
      ...at,
      item: edgeItem(edge),
      side: "source",
      unit: edge.source,
    });
  }
  for (const [index, at] of faninDotsByIndex(edges, targetYById)) {
    const edge = edges[index]!;
    out.push({
      ...at,
      item: edgeItem(edge),
      side: "target",
      unit: edge.target,
    });
  }
  return out;
}
