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
// Constraint. A column is its left runs (port to column, on its left rows), its
// vertical (the span of all its rows) and its right runs (column to port, on
// its right rows). Put X left of Y: X's right runs pass Y's column and Y's
// left runs pass X's column, and the two share the stretch between them. That
// order costs one FLOOR break per X right row and Y left row within
// FORWARD_LEVEL_FLOOR, and one CROSSING per passing run strictly inside the
// other's vertical. The two orders of a pair compare by (floor, crossing),
// lexicographically, and the cheaper one is the constraint:
//
//     floor: B's right row r, A's left row r'     A    B
//     |r - r'| < floor, so A must stand left:   --+    +--
//
// Floor first: two runs within the floor merge and read as one line, which no
// reader can undo, while a crossing is drawn with a cue and stays legible.
//
// Nesting falls out of it. Two rising bends with the lower one left cross
// twice (its right run crosses the upper's vertical, the upper's left run
// crosses the lower's), so the upper stands left; two falling bends, the lower.
//
// Only an exact tie with a cost is UNAVOIDABLE: counted, and left
// unconstrained. Two free orders say nothing either.
//
// Order. Kahn over the constraints; the tie-break is each kind's existing
// sense, so wherever no constraint speaks the columns keep the order they had.
// Only constraint edges carry meaning: a consumer placing a column honours its
// constraints, not its tie-break neighbours.
//
// Cycles. Pairwise choices need not be transitive, so the constraints can
// close a cycle, which no order satisfies. Its later-routed member (numeric
// ELK edge index) owes a jog and drops its constraints; the rest are ordered. That is "the one routed later jogs".
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
  // The one edge a bend or descent column draws; its routing index breaks
  // ties. Arrival rows and trunks, shared by several edges, carry none.
  edgeId?: string;
  // Arrival candidates: the target card and the port row they drop onto.
  targetId?: string;
  rowY?: number;
  // An arrival that exists only if its edge jogs. It holds no column of its
  // own; the arrival allocator keeps a slot for it only where a constraint
  // puts it right of one of its card's rows.
  potential?: boolean;
};

export type GapOrder = {
  // Left to right.
  ordered: ReadonlyArray<ColumnCandidate>;
};

export type UnavoidablePair = { gapKey: string; a: string; b: string };

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
  // Constraint cycles found, broken or not, over every gap.
  cycles: number;
  // Pairs whose two orders cost exactly the same, `a` before `b` in tie order.
  unavoidable: ReadonlyArray<UnavoidablePair>;
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
    // The port row is tagged with a member drawn on this trunk where there is
    // one: a member drawn on the other trunk (a dual member) only hands over
    // to this column, so the row is not its line.
    let portRow: OrderRow | undefined;
    let drawnPortRow: OrderRow | undefined;
    for (const id of trunk.members) {
      const member = edgeById.get(id);
      if (member === undefined) continue;
      const ports = edgePortsModel(member, byId);
      if (ports === null) continue;
      const reach = reachOf.get(id)?.[trunk.kind];
      const row: OrderRow = fanOut
        ? { y: ports.sy, edgeId: id, portX: ports.sx }
        : { y: ports.ty, edgeId: id, portX: ports.tx };
      portRow ??= row;
      if (drawnOn(id) === trunk.kind) drawnPortRow ??= row;
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
    portRow = drawnPortRow ?? portRow;
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
          edgeId: edge.id,
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
        edgeId: edge.id,
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
      edgeId: edge.id,
      kind: "bend",
      gapKey: departGap,
      leftRows: bends ? [{ y: sy, edgeId: edge.id, portX: sx }] : [],
      rightRows: bends && !jogs ? [{ y: ty, edgeId: edge.id, portX: tx }] : [],
      jogEdges: bends ? [edge.id] : [],
    });
    if (jogs) {
      add({
        id: descentIdOf(edge.id),
        edgeId: edge.id,
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
// Rank of a candidate's edge; one without an edge ranks after all, and two of
// those (Infinity - Infinity is NaN, which is falsy) fall through to text.
const rankOfEdge = (c: ColumnCandidate): number =>
  c.edgeId === undefined ? Infinity : routeIndex(c.edgeId);
const byCandidateEdge = (a: ColumnCandidate, b: ColumnCandidate): number =>
  rankOfEdge(a) - rankOfEdge(b) || byText(a.id, b.id);
const byEdgeOrder = (a: string, b: string): number =>
  routeIndex(a) - routeIndex(b) || byText(a, b);

// Reverse the from-above members of a port-row-sorted list among their own
// positions: the #151 entry-column sense.
export function reverseFromAbove<T>(
  sorted: ReadonlyArray<T>,
  isAbove: (item: T) => boolean,
): T[] {
  const above = sorted.flatMap((item, i) => (isAbove(item) ? [i] : []));
  const out = [...sorted];
  above.forEach((pos, j) => {
    out[pos] = sorted[above[above.length - 1 - j]!]!;
  });
  return out;
}

// Sort a list by port row, then apply the from-above reversal: the sense,
// stated once for bends and arrivals alike.
function senseOrder(list: ColumnCandidate[]): ColumnCandidate[] {
  const sorted = [...list].sort(
    (a, b) => portYOf(a) - portYOf(b) || byCandidateEdge(a, b),
  );
  return reverseFromAbove(sorted, fromAbove);
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

// What one order of a pair costs, and the edges of each column its breaks
// involve (a cycle's jog is owed by one of them).
type Breaks = {
  floor: number;
  cross: number;
  left: Set<string>;
  right: Set<string>;
};

const rowsOf = (c: ColumnCandidate): ReadonlyArray<OrderRow> => [
  ...c.leftRows,
  ...c.rightRows,
];

// Does a run on row y cross the vertical of `c`? Only strictly inside its
// span: a run on an end row meets the column's own run there, which the
// floor (or the same-side check) speaks for. A run of one of c's own edges
// never crosses it: a line does not braid itself.
function crossesVertical(run: OrderRow, c: ColumnCandidate): boolean {
  const rows = rowsOf(c);
  if (rows.some((r) => r.edgeId === run.edgeId)) return false;
  const ys = rows.map((r) => r.y);
  return Math.min(...ys) < run.y && run.y < Math.max(...ys);
}

// The cost of `left` standing left of `right`: left's right runs pass right's
// column, right's left runs pass left's column, and those runs share the
// stretch between the two columns.
function breaksWhen(left: ColumnCandidate, right: ColumnCandidate): Breaks {
  const out: Breaks = { floor: 0, cross: 0, left: new Set(), right: new Set() };
  const allOf = (c: ColumnCandidate, into: Set<string>): void => {
    for (const r of rowsOf(c)) into.add(r.edgeId);
  };
  for (const run of left.rightRows) {
    if (!crossesVertical(run, right)) continue;
    out.cross += 1;
    out.left.add(run.edgeId);
    allOf(right, out.right);
  }
  for (const run of right.leftRows) {
    if (!crossesVertical(run, left)) continue;
    out.cross += 1;
    out.right.add(run.edgeId);
    allOf(left, out.left);
  }
  for (const r of left.rightRows) {
    for (const l of right.leftRows) {
      if (r.edgeId === l.edgeId) continue;
      if (Math.abs(r.y - l.y) >= FORWARD_LEVEL_FLOOR) continue;
      out.floor += 1;
      out.left.add(r.edgeId);
      out.right.add(l.edgeId);
    }
  }
  return out;
}

// Negative when order x is cheaper than order y: floor breaks, then crossings.
const byCost = (x: Breaks, y: Breaks): number =>
  x.floor - y.floor || x.cross - y.cross;

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
  const unavoidable: UnavoidablePair[] = [];
  // Cycles as first found, before any is broken.
  let cycles = 0;
  const gapOrders = new Map<string, GapOrder>();
  const rank = new Map<string, number>();
  // Lane columns (see below), by candidate id.
  const laneX = new Map<string, number>();

  for (const [gapKey, list] of byGap) {
    const tie = tieOrder(list);
    const ids = tie.map((c) => c.id);
    const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
    // Per constraint a -> b, the cost of the ruled-out order (b left of a):
    // a cycle's jog is owed by one of the edges it involves.
    const why = new Map<string, Map<string, Breaks>>();
    tie.forEach((a, i) => {
      for (const b of tie.slice(i + 1)) {
        const aLeft = breaksWhen(a, b);
        const bLeft = breaksWhen(b, a);
        const cmp = byCost(aLeft, bLeft);
        if (cmp === 0) {
          if (aLeft.floor + aLeft.cross > 0) {
            unavoidable.push({ gapKey, a: a.id, b: b.id });
          }
          continue;
        }
        if (cmp < 0) {
          out.get(a.id)!.add(b.id);
          why.set(a.id, (why.get(a.id) ?? new Map()).set(b.id, bLeft));
        } else {
          out.get(b.id)!.add(a.id);
          why.set(b.id, (why.get(b.id) ?? new Map()).set(a.id, aLeft));
        }
      }
    });

    // Break every cycle at its later-routed member: it owes a jog, and its
    // constraints stop binding the rest.
    for (let pass = 0; ; pass += 1) {
      const cyclic = sccs(ids, out).filter((component) => component.length > 1);
      if (cyclic.length === 0) break;
      if (pass === 0) cycles += cyclic.length;
      let broke = false;
      for (const component of cyclic) {
        const members = new Set(component);
        // A member's jog-capable edges that take part in the cycle.
        // In a constraint c -> o the ruled-out order has o on the left, so c
        // is its `right` side; in o -> c, its `left` side.
        const inCycle = (c: ColumnCandidate): string[] => {
          const edges = new Set<string>();
          for (const other of component) {
            if (other === c.id) continue;
            for (const e of why.get(c.id)?.get(other)?.right ?? []) {
              edges.add(e);
            }
            for (const e of why.get(other)?.get(c.id)?.left ?? []) {
              edges.add(e);
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
    gapOrders.set(gapKey, { ordered });

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
    cycles,
    unavoidable,
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
