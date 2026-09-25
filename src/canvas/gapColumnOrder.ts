// One column order per layer gap, built once before any column pass runs.
//
// A gap between two layers hosts four kinds of vertical column: a fan-out
// trunk's junction column, a fan-in trunk's merge column, the bend column of an
// edge that skips a layer, and an ARRIVAL column in front of a target card (a
// late drop's entry column, or the descent of a jogged leg -- one family). A
// horizontal that sits on a port row can only be kept off a neighbouring run by
// where its column stands, so the columns of one gap are ordered here, once,
// from the rows each column's runs leave and enter on, and every column pass
// reads that order instead of a sort key of its own.
//
// Rows. Each candidate carries the rows of the runs LEFT of its column (they
// arrive at it) and RIGHT of it (they leave it), counted only where the run is
// physically in this gap and its row is known before routing:
//   fan-out   left: the source port row; right: every NEAR member's target
//             row (a far member's leg level belongs to the jog pass).
//   fan-in    left: every near member's source row; right: the merge row, on
//             which a far pinned member's row collapses.
//   bend      left: the source row; right: the target row when card-clear.
//   arrival   left: the source row of each late drop on it; right: the port row.
//             A POTENTIAL descent (an edge that arrives only if it jogs) has no
//             left row: its level is the jog's to choose, never guessed here.
//
// Constraint. A stands left of B when a left row of A lies within
// FORWARD_LEVEL_FLOOR of a right row of B:
//
//     B's run leaves B's column on row r          A    B
//     A's run arrives at A's column on row r'     |    |
//     |r - r'| < floor, so A must stand left:   --+    +--
//
// With A right of B the two runs share the stretch between the columns and
// read as one line (or put a junction dot on a foreign stroke).
//
// Order. Kahn over the constraints; the tie-break is each kind's existing
// sense, so wherever no constraint speaks the columns keep the order they had.
// Only constraint edges carry meaning: a consumer placing a column honours its
// constraints, not its tie-break neighbours.
//
// Cycles. A strongly connected set of constraints has no satisfying order. Its
// later-routed member (numeric ELK edge index) owes a jog and drops its
// constraints; the rest are ordered. That is "the one routed later jogs".
//
// Same side. Two LEFT rows within the floor overlap on the stretch from their
// ports to the nearer column however the columns are ordered, and two RIGHT
// rows on the stretch from the farther column to their ports. Where that
// overlap exceeds a port stub the later-routed member owes a jog as well. It
// depends on where the columns stand, so it is asked of the order once they do.
//
// Pure and deterministic: a function of the node placement, the edge topology
// and the gap records. Routing stamps and edge types are ignored, so the order
// is the same whichever pass asks for it.

import type { Edge } from "@xyflow/react";

import {
  edgePortsModel,
  forwardLegsBlocked,
  ownExempt,
  paddedObstacles,
  parseElkEdgeIndex,
} from "./busRouting";
import { PORT_STUB } from "./edgePath";
import { FORWARD_LEVEL_FLOOR } from "./levelOccupancy";
import {
  COLUMN_PITCH,
  buildLayerModel,
  classifyTrunks,
  gapKeyOf,
  gapKeysFor,
  layerIndexIn,
  layerSpanOf,
  trunkScopeOf,
  type GapRecord,
  type Trunk,
} from "./layerModel";
import { edgeItem, nodeIndexOf } from "./nodeGeometry";
import type { RFAnyNode } from "./layout";

export type ColumnKind = "fanOut" | "fanIn" | "bend" | "arrival";

// One run beside a column: its row, the edge drawing it, and the port x it
// runs to (the source port for a left row, the target port for a right row).
export type OrderRow = { y: number; edgeId: string; portX: number };

export type ColumnCandidate = {
  id: string;
  kind: ColumnKind;
  gapKey: string;
  leftRows: ReadonlyArray<OrderRow>;
  rightRows: ReadonlyArray<OrderRow>;
  // Edges that can still jog when this column's constraints form a cycle:
  // item edges after routing (bends, late drops, far trunk members).
  jogEdges: ReadonlyArray<string>;
  trunkKey?: string;
  // Arrival candidates: the target card and the port row they drop onto.
  targetId?: string;
  rowY?: number;
  // An arrival that exists only if its edge jogs. It holds no column of its
  // own; the arrival allocator keeps a slot for it only where a constraint
  // puts it right of one of its card's rows.
  potential?: boolean;
};

export type GapOrder = {
  gapKey: string;
  // Left to right.
  ordered: ReadonlyArray<ColumnCandidate>;
  rank: ReadonlyMap<string, number>;
};

export type GapColumnOrder = {
  gaps: ReadonlyMap<string, GapOrder>;
  byId: ReadonlyMap<string, ColumnCandidate>;
  // Candidate id lookups, per column kind.
  trunkId: (trunkKey: string) => string;
  bendId: (edgeId: string) => string;
  arrivalRowId: (targetId: string, y: number) => string;
  descentId: (edgeId: string) => string;
  // Constraints left after cycles are broken: A must stand left of B.
  mustStandLeft: (a: string, b: string) => boolean;
  // Every candidate A must stand left of / right of.
  rightNeighbours: (id: string) => ReadonlyArray<string>;
  leftNeighbours: (id: string) => ReadonlyArray<string>;
  // Rank inside the candidate's gap order.
  rankOf: (id: string) => number | undefined;
  // The column of a trunk, or of a column that joined a trunk's walk because
  // it must stand beyond it; undefined without a gap record.
  laneColumn: (id: string) => number | undefined;
  // Edges owing a jog because their column sits in a constraint cycle.
  cycleOwed: ReadonlySet<string>;
  // Same-side owed jogs, given where the columns stand.
  sameSideOwed: (columnX: (id: string) => number | undefined) => Set<string>;
};

const trunkIdOf = (key: string): string => `t:${key}`;
const bendIdOf = (edgeId: string): string => `b:${edgeId}`;
const arrivalRowIdOf = (targetId: string, y: number): string =>
  `a:${targetId}@${Math.round(y * 100)}`;
const descentIdOf = (edgeId: string): string => `d:${edgeId}`;

// Routing rank of an edge: its numeric ELK index, a hand-built id after all.
const routeIndex = (edgeId: string): number =>
  parseElkEdgeIndex(edgeId) ?? Infinity;

export function buildGapColumnOrder(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  gaps: ReadonlyArray<GapRecord>,
): GapColumnOrder {
  const byId = nodeIndexOf(nodes);
  const model = buildLayerModel(nodes);
  const gapByKey = new Map(gaps.map((gap) => [gapKeyOf(gap), gap]));
  const cards = paddedObstacles(nodes, edges);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const { trunks } = classifyTrunks(nodes, edges);

  // The innermost gap with a record among a node's candidate gaps; without
  // records, the innermost key, so the grouping is still one per gap.
  const gapOfNode = (id: string, side: "depart" | "arrive"): string => {
    const keys = gapKeysFor(model, id, side);
    return keys.find((key) => gapByKey.has(key)) ?? keys[0] ?? "";
  };
  // Will the jog pass move this forward edge? Asked with the jog pass's own
  // card trigger, the drop column taken at the middle of the edge's source gap
  // (its bend or trunk column stands somewhere in there, and no card does).
  // An edge that jogs rides no port row across the gap and descends in front
  // of its target instead; one that does not rides its target row out of its
  // column, so that row is known before routing.
  const willJog = (
    edge: Edge,
    ports: { sx: number; sy: number; tx: number; ty: number },
  ): boolean => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return false;
    const zone = gapByKey.get(gapOfNode(edge.source, "depart"))?.columnZone;
    const dropX =
      zone === undefined
        ? (ports.sx + ports.tx) / 2
        : (zone.left + zone.right) / 2;
    const { srcBlocked, tgtBlocked } = forwardLegsBlocked(
      cards,
      ownExempt([source, target]),
      ports,
      dropX,
    );
    return srcBlocked || tgtBlocked;
  };

  const candidates: ColumnCandidate[] = [];
  const add = (c: ColumnCandidate): void => {
    candidates.push(c);
  };

  // -- Trunks ----------------------------------------------------------------
  type Reach = "near" | "far" | "backward";
  const reachOf = new Map<string, { fanOut?: Reach; fanIn?: Reach }>();
  const trunkInfo: Array<{ trunk: Trunk; scope: string; unitLayer: number }> =
    [];
  for (const trunk of trunks) {
    const scope = trunkScopeOf(model, trunk, edgeById);
    if (scope === undefined) continue;
    const unitLayer = layerIndexIn(model, scope, trunk.unit);
    if (unitLayer === undefined) continue;
    trunkInfo.push({ trunk, scope, unitLayer });
    const fanOut = trunk.kind === "fanOut";
    for (const id of trunk.members) {
      const member = edgeById.get(id);
      if (member === undefined) continue;
      const other = layerIndexIn(
        model,
        scope,
        fanOut ? member.target : member.source,
      );
      const distance =
        other === undefined
          ? undefined
          : fanOut
            ? other - unitLayer
            : unitLayer - other;
      const reach: Reach =
        distance === undefined || distance <= 0
          ? "backward"
          : distance === 1
            ? "near"
            : "far";
      const entry = reachOf.get(id) ?? {};
      if (fanOut) entry.fanOut = reach;
      else entry.fanIn = reach;
      reachOf.set(id, entry);
    }
  }
  // Which column an edge is DRAWN on, mirroring routeTrunkEdges' treatment: a
  // near fan-out member on its fan-out column, else a near fan-in member on its
  // fan-in column, else a far member on the fan-out column (it wins when far on
  // both sides), else the fan-in one.
  const drawnOn = (id: string): "fanOut" | "fanIn" | undefined => {
    const r = reachOf.get(id);
    if (r === undefined) return undefined;
    if (r.fanOut === "near") return "fanOut";
    if (r.fanIn === "near") return "fanIn";
    if (r.fanOut === "far") return "fanOut";
    if (r.fanIn === "far") return "fanIn";
    return undefined;
  };

  for (const { trunk, scope, unitLayer } of trunkInfo) {
    const fanOut = trunk.kind === "fanOut";
    const gapKey = gapKeyOf({
      scope,
      index: fanOut ? unitLayer : unitLayer - 1,
    });
    const leftRows: OrderRow[] = [];
    const rightRows: OrderRow[] = [];
    let portRow: OrderRow | undefined;
    for (const id of trunk.members) {
      const member = edgeById.get(id);
      if (member === undefined) continue;
      const ports = edgePortsModel(member, byId);
      if (ports === null) continue;
      const reach = reachOf.get(id)?.[trunk.kind];
      if (fanOut) {
        portRow ??= { y: ports.sy, edgeId: id, portX: ports.sx };
      } else {
        portRow ??= { y: ports.ty, edgeId: id, portX: ports.tx };
      }
      if (reach === undefined || reach === "backward") continue;
      if (drawnOn(id) !== trunk.kind) continue;
      // Only a NEAR member's row counts. A far member's leg rides its target
      // row out of the column only while no jog moves it, and counting it
      // anyway reorders trunks against lines drawn elsewhere (script43 32 ->
      // 36 crossings, as STC-0009 measured). A far fan-in member's right row
      // collapses onto the merge row the trunk already carries.
      if (reach !== "near") continue;
      if (fanOut) {
        rightRows.push({ y: ports.ty, edgeId: id, portX: ports.tx });
      } else {
        leftRows.push({ y: ports.sy, edgeId: id, portX: ports.sx });
      }
    }
    if (portRow === undefined) continue;
    if (fanOut) leftRows.unshift(portRow);
    else rightRows.unshift(portRow);
    add({
      id: trunkIdOf(trunk.key),
      kind: trunk.kind,
      gapKey,
      leftRows,
      rightRows,
      // Its rows are near members', drawn as bus: none of them can jog.
      jogEdges: [],
      trunkKey: trunk.key,
    });
  }

  // -- Bends and arrivals ------------------------------------------------------
  const arrivalRows = new Map<
    string,
    ColumnCandidate & {
      leftRows: OrderRow[];
      rightRows: OrderRow[];
      jogEdges: string[];
    }
  >();
  for (const edge of edges) {
    if (edgeItem(edge) === undefined) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const ports = edgePortsModel(edge, byId);
    if (ports === null) continue;
    const { sx, sy, tx, ty } = ports;
    const drawn = drawnOn(edge.id);
    const backward = tx - sx <= 0;
    const arriveGap = gapOfNode(edge.target, "arrive");

    if (backward) {
      // A backward rail's left column is an arrival column; its rail level is
      // the rail pass's to choose, so it carries its port row only.
      if (drawn !== undefined) continue;
      const rowId = arrivalRowIdOf(edge.target, ty);
      const row = arrivalRows.get(rowId);
      if (row === undefined) {
        arrivalRows.set(rowId, {
          id: rowId,
          kind: "arrival",
          gapKey: arriveGap,
          leftRows: [],
          rightRows: [{ y: ty, edgeId: edge.id, portX: tx }],
          jogEdges: [],
          targetId: edge.target,
          rowY: ty,
        });
      }
      continue;
    }
    if (drawn === "fanIn" && reachOf.get(edge.id)?.fanIn === "near") {
      // A near fan-in member's row is an arrival row of its card, drawn on the
      // trunk's merge column: it takes part in the card's arrival sense
      // without rows of its own (the fan-in candidate carries them).
      const rowId = arrivalRowIdOf(edge.target, ty);
      if (!arrivalRows.has(rowId)) {
        arrivalRows.set(rowId, {
          id: rowId,
          kind: "arrival",
          gapKey: arriveGap,
          leftRows: [],
          rightRows: [],
          jogEdges: [],
          targetId: edge.target,
          rowY: ty,
        });
      }
      continue;
    }
    if (drawn !== undefined) {
      // A far member pinned on a trunk column. A fan-out-pinned member whose
      // target row is not card-clear will jog, and then descends in front of
      // its target: a potential arrival.
      if (drawn === "fanOut" && willJog(edge, ports)) {
        add({
          id: descentIdOf(edge.id),
          kind: "arrival",
          gapKey: arriveGap,
          leftRows: [],
          rightRows: [{ y: ty, edgeId: edge.id, portX: tx }],
          jogEdges: [edge.id],
          targetId: edge.target,
          rowY: ty,
          potential: true,
        });
      }
      continue;
    }

    const span = layerSpanOf(model, edge.source, edge.target);
    const lateDrop =
      span !== undefined && span.to - span.from === 1 && sy !== ty;
    const departGap = gapOfNode(edge.source, "depart");

    if (lateDrop) {
      // Its vertical is the entry column; the bend column it also gets is drawn
      // only if it jogs, so the bend candidate carries no rows.
      const rowId = arrivalRowIdOf(edge.target, ty);
      const row =
        arrivalRows.get(rowId) ??
        ({
          id: rowId,
          kind: "arrival",
          gapKey: arriveGap,
          leftRows: [],
          rightRows: [],
          jogEdges: [],
          targetId: edge.target,
          rowY: ty,
        } as ColumnCandidate & {
          leftRows: OrderRow[];
          rightRows: OrderRow[];
          jogEdges: string[];
        });
      row.leftRows.push({ y: sy, edgeId: edge.id, portX: sx });
      row.rightRows.push({ y: ty, edgeId: edge.id, portX: tx });
      row.jogEdges.push(edge.id);
      arrivalRows.set(rowId, row);
      add({
        id: bendIdOf(edge.id),
        kind: "bend",
        gapKey: departGap,
        leftRows: [],
        rightRows: [],
        jogEdges: [],
      });
      continue;
    }

    // A bend column. Drawn only when the ports differ in y; a straight edge
    // takes a slot in the fan with no rows.
    const jogs = willJog(edge, ports);
    const bends = sy !== ty;
    add({
      id: bendIdOf(edge.id),
      kind: "bend",
      gapKey: departGap,
      leftRows: bends ? [{ y: sy, edgeId: edge.id, portX: sx }] : [],
      rightRows: bends && !jogs ? [{ y: ty, edgeId: edge.id, portX: tx }] : [],
      jogEdges: bends ? [edge.id] : [],
    });
    if (jogs) {
      add({
        id: descentIdOf(edge.id),
        kind: "arrival",
        gapKey: arriveGap,
        leftRows: [],
        rightRows: [{ y: ty, edgeId: edge.id, portX: tx }],
        jogEdges: [edge.id],
        targetId: edge.target,
        rowY: ty,
        potential: true,
      });
    }
  }
  for (const row of arrivalRows.values()) add(row);

  return orderCandidates(candidates, gapByKey);
}

// -- Ordering ---------------------------------------------------------------

// The tie-break sense of each kind, left to right, the kinds in the order they
// stand in a gap (fan-outs, bends, arrivals, fan-ins):
//   fan-out  port row top first (the old slot order: slot 0 at the zone's left)
//   bend     target row with the from-above reversal, as the arrivals below
//   arrival  per card, the #151 sense (top row leftmost; rows dropped into
//            from above reverse among themselves)
//   fan-in   port row bottom first (slot 0, the top one, stands rightmost)
function portYOf(c: ColumnCandidate): number {
  if (c.kind === "fanOut") return c.leftRows[0]?.y ?? 0;
  if (c.kind === "fanIn") return c.rightRows[0]?.y ?? 0;
  if (c.kind === "arrival") return c.rowY ?? 0;
  return c.rightRows[0]?.y ?? c.leftRows[0]?.y ?? 0;
}

// Downward (from above): every left row lies above the right row it pairs
// with. A candidate with no rows counts as not from above.
function fromAbove(c: ColumnCandidate): boolean {
  const target = c.kind === "arrival" ? c.rowY : c.rightRows[0]?.y;
  if (target === undefined || c.leftRows.length === 0) return false;
  return c.leftRows.every((row) => row.y < target);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byEdgeOrder = (a: string, b: string): number =>
  routeIndex(a) - routeIndex(b) || byText(a, b);

// Sort a list by port row, then reverse the from-above members among their
// own positions: the #151 entry-column sense, stated once for bends and
// arrivals alike.
function senseOrder(list: ColumnCandidate[]): ColumnCandidate[] {
  const sorted = [...list].sort(
    (a, b) => portYOf(a) - portYOf(b) || byEdgeOrder(a.id, b.id),
  );
  const above = sorted.flatMap((c, i) => (fromAbove(c) ? [i] : []));
  const out = [...sorted];
  above.forEach((pos, j) => {
    out[pos] = sorted[above[above.length - 1 - j]!]!;
  });
  return out;
}

function tieOrder(list: ReadonlyArray<ColumnCandidate>): ColumnCandidate[] {
  const ofKind = (kind: ColumnKind) => list.filter((c) => c.kind === kind);
  const fanOuts = ofKind("fanOut").sort(
    (a, b) => portYOf(a) - portYOf(b) || byText(a.id, b.id),
  );
  const fanIns = ofKind("fanIn").sort(
    (a, b) => portYOf(b) - portYOf(a) || byText(b.id, a.id),
  );
  const bends = senseOrder(ofKind("bend"));
  // Arrivals keep their card's sense; cards top to bottom.
  const byCard = new Map<string, ColumnCandidate[]>();
  for (const c of ofKind("arrival")) {
    const key = c.targetId ?? "";
    byCard.set(key, [...(byCard.get(key) ?? []), c]);
  }
  const cards = [...byCard.values()]
    .map((rows) => senseOrder(rows))
    .sort(
      (a, b) =>
        Math.min(...a.map(portYOf)) - Math.min(...b.map(portYOf)) ||
        byText(a[0]!.id, b[0]!.id),
    );
  return [...fanOuts, ...bends, ...cards.flat(), ...fanIns];
}

// Does a left row of A lie within the floor of a right row of B? Rows of one
// edge never constrain each other: a line does not braid itself.
function constrains(a: ColumnCandidate, b: ColumnCandidate): boolean {
  return a.leftRows.some((l) =>
    b.rightRows.some(
      (r) => l.edgeId !== r.edgeId && Math.abs(l.y - r.y) < FORWARD_LEVEL_FLOOR,
    ),
  );
}

// Tarjan's strongly connected components, in a deterministic order.
function sccs(
  ids: ReadonlyArray<string>,
  out: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return result;
}

function orderCandidates(
  candidates: ReadonlyArray<ColumnCandidate>,
  gapByKey: ReadonlyMap<string, GapRecord>,
): GapColumnOrder {
  const byGap = new Map<string, ColumnCandidate[]>();
  const candidateById = new Map<string, ColumnCandidate>();
  for (const c of candidates) {
    candidateById.set(c.id, c);
    byGap.set(c.gapKey, [...(byGap.get(c.gapKey) ?? []), c]);
  }

  const leftOf = new Map<string, Set<string>>();
  const rightOf = new Map<string, Set<string>>();
  const cycleOwed = new Set<string>();
  const gapOrders = new Map<string, GapOrder>();
  const rank = new Map<string, number>();
  // Lane columns (see below), by candidate id.
  const laneX = new Map<string, number>();

  for (const [gapKey, list] of byGap) {
    const tie = tieOrder(list);
    const ids = tie.map((c) => c.id);
    const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
    for (const a of tie) {
      for (const b of tie) {
        if (a !== b && constrains(a, b)) out.get(a.id)!.add(b.id);
      }
    }

    // Break every cycle at its later-routed member: it owes a jog, and its
    // constraints stop binding the rest.
    for (;;) {
      const cyclic = sccs(ids, out).filter((component) => component.length > 1);
      if (cyclic.length === 0) break;
      let broke = false;
      for (const component of cyclic) {
        const members = new Set(component);
        // A member's jog-capable edges that take part in the cycle.
        const inCycle = (c: ColumnCandidate): string[] => {
          const edges = new Set<string>();
          for (const other of component) {
            if (other === c.id) continue;
            const o = candidateById.get(other)!;
            for (const l of c.leftRows) {
              if (
                o.rightRows.some(
                  (r) => Math.abs(l.y - r.y) < FORWARD_LEVEL_FLOOR,
                )
              ) {
                edges.add(l.edgeId);
              }
            }
            for (const r of c.rightRows) {
              if (
                o.leftRows.some(
                  (l) => Math.abs(l.y - r.y) < FORWARD_LEVEL_FLOOR,
                )
              ) {
                edges.add(r.edgeId);
              }
            }
          }
          return [...edges].filter((e) => c.jogEdges.includes(e));
        };
        let later: { id: string; edges: string[]; at: number } | undefined;
        for (const id of component) {
          const edges = inCycle(candidateById.get(id)!);
          if (edges.length === 0) continue;
          const at = Math.max(...edges.map(routeIndex));
          if (
            later === undefined ||
            at > later.at ||
            (at === later.at && byText(id, later.id) > 0)
          ) {
            later = { id, edges, at };
          }
        }
        if (later === undefined) continue;
        for (const edge of later.edges) cycleOwed.add(edge);
        out.set(
          later.id,
          new Set([...out.get(later.id)!].filter((b) => !members.has(b))),
        );
        for (const id of component) out.get(id)!.delete(later.id);
        broke = true;
      }
      // A cycle with no jog-capable member cannot be broken by a jog; Kahn
      // below then falls back to the tie-break for it.
      if (!broke) break;
    }

    // Kahn, taking the first eligible candidate in tie order at every step.
    const owed = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const [, targets] of out) {
      for (const b of targets) owed.set(b, owed.get(b)! + 1);
    }
    const ordered: ColumnCandidate[] = [];
    const left = new Set(ids);
    while (left.size > 0) {
      const next =
        tie.find((c) => left.has(c.id) && owed.get(c.id) === 0) ??
        tie.find((c) => left.has(c.id))!;
      left.delete(next.id);
      ordered.push(next);
      for (const b of out.get(next.id)!) owed.set(b, owed.get(b)! - 1);
    }
    ordered.forEach((c, i) => rank.set(c.id, i));

    for (const [a, targets] of out) {
      for (const b of targets) {
        // A constraint Kahn could not honour (an unbreakable cycle) is dropped
        // so every consumer reads one consistent relation.
        if (rank.get(a)! >= rank.get(b)!) continue;
        leftOf.set(a, (leftOf.get(a) ?? new Set()).add(b));
        rightOf.set(b, (rightOf.get(b) ?? new Set()).add(a));
      }
    }
    gapOrders.set(gapKey, {
      gapKey,
      ordered,
      rank: new Map(ordered.map((c, i) => [c.id, i])),
    });

    // The lanes: where rank beats a kind's anchor. A fan-out column stands at
    // the zone's left and a fan-in column at its right, so a column that must
    // stand left of a fan-out (or right of a fan-in) cannot be placed by its
    // own kind's rule. Those join the trunk's walk: every candidate from which
    // a fan-out is reachable walks from the zone's left in rank order, every
    // candidate reachable from a fan-in walks from its right, one trunk pitch
    // apart. Potential descents hold no slot and stay out.
    const zone = gapByKey.get(gapKey)?.columnZone;
    const reach = (
      from: string,
      dir: Map<string, Set<string>>,
    ): Set<string> => {
      const seen = new Set<string>([from]);
      const stack = [from];
      while (stack.length > 0) {
        for (const next of dir.get(stack.pop()!) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return seen;
    };
    const fanOutLane = new Set<string>();
    const fanInLane = new Set<string>();
    for (const c of ordered) {
      if (c.kind === "fanOut") {
        for (const id of reach(c.id, rightOf)) fanOutLane.add(id);
      }
    }
    for (const c of ordered) {
      if (c.kind !== "fanIn") continue;
      for (const id of reach(c.id, leftOf)) {
        if (!fanOutLane.has(id)) fanInLane.add(id);
      }
    }
    const walk = (ids: string[], x0: number, step: number): void => {
      ids.forEach((id, i) => laneX.set(id, x0 + step * i));
    };
    const inLane = (lane: Set<string>) =>
      ordered.filter((c) => lane.has(c.id) && !c.potential).map((c) => c.id);
    if (zone !== undefined) {
      walk(inLane(fanOutLane), zone.left + COLUMN_PITCH / 2, COLUMN_PITCH);
      walk(
        inLane(fanInLane).reverse(),
        zone.right - COLUMN_PITCH / 2,
        -COLUMN_PITCH,
      );
    }
  }

  const sameSideOwed = (
    columnX: (id: string) => number | undefined,
  ): Set<string> => {
    const owedEdges = new Set<string>();
    for (const order of gapOrders.values()) {
      const list = order.ordered;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!;
          const b = list[j]!;
          const xa = columnX(a.id);
          const xb = columnX(b.id);
          if (xa === undefined || xb === undefined) continue;
          const owe = (ra: OrderRow, rb: OrderRow, overlap: number): void => {
            if (ra.edgeId === rb.edgeId) return;
            if (Math.abs(ra.y - rb.y) >= FORWARD_LEVEL_FLOOR) return;
            if (overlap <= PORT_STUB) return;
            // Two runs on one port row of one card draw as one line on
            // purpose (the port-row waiver).
            if (ra.y === rb.y && ra.portX === rb.portX) return;
            // The later-routed of the two owes it; a member that cannot jog
            // (a bus-drawn trunk member) hands it to the other.
            const jogA = a.jogEdges.includes(ra.edgeId);
            const jogB = b.jogEdges.includes(rb.edgeId);
            const aLater = byEdgeOrder(ra.edgeId, rb.edgeId) > 0;
            const later = aLater ? ra.edgeId : rb.edgeId;
            const earlier = aLater ? rb.edgeId : ra.edgeId;
            if (aLater ? jogA : jogB) owedEdges.add(later);
            else if (aLater ? jogB : jogA) owedEdges.add(earlier);
          };
          for (const ra of a.leftRows) {
            for (const rb of b.leftRows) {
              owe(ra, rb, Math.min(xa, xb) - Math.max(ra.portX, rb.portX));
            }
          }
          for (const ra of a.rightRows) {
            for (const rb of b.rightRows) {
              owe(ra, rb, Math.min(ra.portX, rb.portX) - Math.max(xa, xb));
            }
          }
        }
      }
    }
    return owedEdges;
  };

  return {
    gaps: gapOrders,
    byId: candidateById,
    trunkId: trunkIdOf,
    bendId: bendIdOf,
    arrivalRowId: arrivalRowIdOf,
    descentId: descentIdOf,
    mustStandLeft: (a, b) => leftOf.get(a)?.has(b) ?? false,
    rightNeighbours: (id) => [...(leftOf.get(id) ?? [])],
    leftNeighbours: (id) => [...(rightOf.get(id) ?? [])],
    rankOf: (id) => rank.get(id),
    laneColumn: (id) => laneX.get(id),
    cycleOwed,
    sameSideOwed,
  };
}

// -- Placed columns and the proof ------------------------------------------

// Where every column of the order stands, read off the stamps the passes have
// left so far, which are the columns the drawer draws: a trunk's junction
// column (the walk column while no member carries it yet), a row's entry
// column, a bend's column (its jogged source column when it has one) and a
// jogged edge's descent. A column not placed yet is absent, so the jog pass
// can ask this before any edge has jogged.
export function placedColumns(
  order: GapColumnOrder,
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Map<string, number> {
  const byId = nodeIndexOf(nodes);
  const out = new Map<string, number>();
  for (const id of order.byId.keys()) {
    const lane = order.laneColumn(id);
    if (lane !== undefined) out.set(id, lane);
  }
  const number = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  for (const edge of edges) {
    const data = (edge.data ?? {}) as Record<string, unknown>;
    if (edge.type === "bus") {
      const key = data["trunkKey"];
      const x = number(data["junctionX"]);
      if (typeof key === "string" && x !== undefined) {
        out.set(order.trunkId(key), x);
      }
      continue;
    }
    if (edge.type !== "item") continue;
    const ports = edgePortsModel(edge, byId);
    if (ports === null) continue;
    const entryX = number(data["entryX"]);
    const row = order.arrivalRowId(edge.target, ports.ty);
    if (entryX !== undefined && order.byId.has(row) && !out.has(row)) {
      out.set(row, entryX);
    }
    const pinned =
      data["fanoutColumn"] === true || data["faninColumn"] === true;
    const bendX = number(data["srcColX"]) ?? number(data["bendX"]);
    const bend = order.bendId(edge.id);
    if (bendX !== undefined && !pinned && order.byId.has(bend)) {
      out.set(bend, bendX);
    }
    const descent = order.descentId(edge.id);
    if (number(data["legY"]) !== undefined && order.byId.has(descent)) {
      out.set(descent, number(data["jogDescentX"]) ?? ports.tx - PORT_STUB);
    }
  }
  return out;
}

// One constraint the drawn columns break: `left` must stand left of `right`
// in gap `gapKey`, and stands at or right of it.
export type OrderViolation = {
  gapKey: string;
  left: string;
  right: string;
  leftX: number;
  rightX: number;
};

// The proof the order is honoured: every constraint of every gap, checked
// against the columns as routed. A pair where either column is not drawn (a
// potential descent whose edge did not jog) has nothing to break.
export function columnOrderViolations(
  order: GapColumnOrder,
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): OrderViolation[] {
  const placed = placedColumns(order, nodes, edges);
  const out: OrderViolation[] = [];
  for (const [gapKey, gap] of order.gaps) {
    for (const c of gap.ordered) {
      const leftX = placed.get(c.id);
      if (leftX === undefined) continue;
      for (const right of order.rightNeighbours(c.id)) {
        const rightX = placed.get(right);
        if (rightX === undefined || leftX < rightX) continue;
        out.push({ gapKey, left: c.id, right, leftX, rightX });
      }
    }
  }
  return out;
}
