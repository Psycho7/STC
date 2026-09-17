// The post-ELK layer model, the topological trunk classifier, the per-gap chip
// reserves and the gap-widening pre-pass.
//
// ELK sizes an inter-layer gap from BETWEEN_LAYERS_SPACING and the edges it has
// to route through it. It knows nothing about the chips the canvas draws in that
// gap, so a gap can come back too narrow to hold them and every chip in it then
// has to be squeezed, collapsed or hidden. This module measures what each gap
// owes and widens it once, BEFORE any routing pass runs:
//
//   layer k          gap k                       layer k+1
//   +------+ | sourceZone | columnZone | targetZone | +------+
//   | card |-+------------+-----+------+------------+-| card |
//   +------+                    |                     +------+
//                        trunk columns
//
//   sourceZone  the widest chip any edge leaving layer k owes beside its source
//               port, plus its pads
//   columnZone  the shared junction columns the trunks in this gap need, plus
//               one pitch floor per staggered 1-to-1 bend column, so the
//               routing passes can keep the floor between any two columns
//   targetZone  the widest chip any edge entering layer k+1 owes beside its
//               target port, plus its pads
//
// Layers, gaps and reserves are all per SCOPE (the root, and each container
// interior -- see Scope below), and the widening runs bottom-up: a container's
// interior is arranged first and its box grows by what that cost, then the
// parent scope sees the grown box as one interval.
//
// This is the ONLY place nodes move after ELK, and it is pure: it returns new
// node objects and never touches the input array or its positions. Every routing
// pass runs on the widened nodes and keeps its read-only contract.
//
// Membership in a trunk is TOPOLOGICAL, not geometric: any (item, unit) port
// with two or more edges is a trunk whatever the gap widths are. routeTrunkEdges
// takes its trunks from classifyTrunks here, so the trunks the reserves are
// measured for are exactly the ones that get routed.

import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { pushInto } from "../util/multimap";

import { DOT_KEEPOFF } from "./dimensions";
import { CHAMFER, FORWARD_STEP_BUDGET, PORT_STUB } from "./edgePath";
import {
  aggregateChipText,
  chipNaturalWidth,
  rateChipText,
  type ChipText,
} from "./chipMetrics";
import {
  absoluteLeft,
  edgeItem,
  edgeRate,
  flowKeyOf,
  nodeIndexOf,
  nodeWidth,
} from "./nodeGeometry";
import type { RFAnyNode } from "./layout";

// The two pads around one reserved chip box, and the spacing between two trunk
// columns in one gap. These three are the tuning knobs of the whole reserve
// model, so they live together: the card-side pad matches the port stub the edge
// leaves the card on, the column-side pad matches the keep-off a chip already
// owes a junction dot, and two columns sit two keep-offs apart so neither dot's
// keep-off laps the other's column.
export const RESERVE_CARD_PAD = PORT_STUB;
export const RESERVE_COLUMN_PAD = DOT_KEEPOFF;
export const COLUMN_PITCH = 2 * DOT_KEEPOFF;

// The floor between the centres of ANY two columns in one gap, trunk columns
// included: two columns closer than this have touching bevels and read as one
// thick line. busRouting re-exports it as ENTRY_SLOT_PITCH (the pitch a target's
// own arrival columns already stood at) and enforces it; the reserve below
// charges the column zone for it, because a floor is only keepable in a gap wide
// enough to hold every column it owes at that spacing. It lives here, not in
// busRouting, so both the reserve and the passes read one value -- busRouting
// imports this module, never the other way round.
export const COLUMN_MIN_PITCH = 2 * CHAMFER;

// One layer of one SCOPE: a maximal run of that scope's direct children whose
// x-intervals overlap transitively. `left` is the leftmost left edge over the
// members, `right` the rightmost right edge.
export type Layer = {
  readonly index: number;
  readonly left: number;
  readonly right: number;
  readonly members: ReadonlyArray<string>;
};

// A SCOPE is one coordinate frame the layering is meaningful in: the root, and
// the interior of every container. Its members are its DIRECT children -- leaf
// cards, and a child container as a single interval covering its whole box.
//
// Layering globally is wrong once containers exist. A loop container's interior
// has its own left-to-right order, and a root card standing beside the container
// can overlap both the container's first interior column and its second, which
// merges the two into one global layer: the corridor inside the box then reads
// as no corridor at all, every edge across it as a zero-distance (backward) one,
// and the reserve model never widens it.
//
//   root scope:      [ product ]      [ ---- container ---- ]   [ card ]
//   container scope:                   [ seed ] gap [ planter ]
//
// The two frames overlap in x and are independent: a gap of one is not a gap of
// the other, which is why every gap record carries the scope it belongs to.
export type Scope = {
  readonly id: string;
  readonly layers: ReadonlyArray<Layer>;
  // The scope's DIRECT children only, each mapped to its layer index here.
  readonly layerByNodeId: ReadonlyMap<string, number>;
};

// The root scope's id. A container's scope id is the container node's id.
export const ROOT_SCOPE = "";

export type LayerModel = {
  // Root first, then every container interior, in node order.
  readonly scopes: ReadonlyMap<string, Scope>;
  // Every node (containers included) to the scope it is a direct child of.
  readonly scopeByNodeId: ReadonlyMap<string, string>;
};

// A horizontal band in absolute x.
export type Zone = { readonly left: number; readonly right: number };

// Gap k of one scope, between layer k's right edge and layer k+1's left edge,
// with the three zones laid out inside it: the source zone flush against layer
// k, the target zone flush against layer k+1, the column zone in between (it
// absorbs any slack ELK left over the requirement).
export type GapRecord = {
  readonly scope: string;
  readonly index: number;
  readonly left: number;
  readonly right: number;
  readonly sourceZone: Zone;
  readonly columnZone: Zone;
  readonly targetZone: Zone;
  readonly columns: number;
};

export type TrunkKind = "fanOut" | "fanIn";

// One topological trunk: every edge of one item leaving a single source unit
// (fan-out) or entering a single target unit (fan-in), N >= 2. `owner` is the
// lex-smallest member edge id, the same election routeTrunkEdges runs, so a
// consumer can key per-trunk state on one member without re-electing.
export type Trunk = {
  readonly kind: TrunkKind;
  readonly key: string;
  readonly item: string;
  readonly unit: string;
  readonly members: ReadonlyArray<string>;
  readonly owner: string;
  readonly total: Fraction;
};

// A complete bipartite same-item component: every source feeds every target.
// Only such a component is a web -- a partially connected N-to-M component reads
// as a fan-out plus a fan-in instead.
export type Web = {
  readonly item: string;
  readonly sources: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<string>;
  readonly members: ReadonlyArray<string>;
};

export type TrunkClassification = {
  readonly trunks: ReadonlyArray<Trunk>;
  readonly webs: ReadonlyArray<Web>;
  // Per edge id, the trunk it belongs to on each side (absent on a 1-to-1 edge).
  readonly trunkByEdgeId: ReadonlyMap<
    string,
    { readonly fanOut?: Trunk; readonly fanIn?: Trunk }
  >;
};

// What one scope's gap k owes, before any node moves. Zone widths, not
// coordinates.
export type GapRequirement = {
  readonly scope: string;
  readonly index: number;
  readonly sourceZone: number;
  readonly columnZone: number;
  readonly targetZone: number;
  readonly columns: number;
  readonly required: number;
};

// Slack allowed when deciding whether two leaf nodes belong to one layer, in
// graph units. ELK hands back fractional lefts (574.5999), so an exact
// comparison is a knife edge: two cards of one visual layer at 574.4 and 574.6
// would become two layers with a spurious near-zero gap between them. A real
// inter-layer gap is BETWEEN_LAYERS_SPACING wide, orders of magnitude above this.
const LAYER_MERGE_TOLERANCE = 0.5;

// The scope every node is a direct child of: its container, or the root.
function scopeByNodeIdOf(nodes: ReadonlyArray<RFAnyNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) out.set(node.id, node.parentId ?? ROOT_SCOPE);
  return out;
}

// The scope ids that hold members, root first and then the containers in node
// order, so every walk over the model is deterministic.
function scopeIdsOf(
  nodes: ReadonlyArray<RFAnyNode>,
  scopeByNodeId: ReadonlyMap<string, string>,
): string[] {
  const ids = [ROOT_SCOPE];
  for (const node of nodes) {
    const scope = scopeByNodeId.get(node.id)!;
    if (scope !== ROOT_SCOPE && !ids.includes(scope)) ids.push(scope);
  }
  return ids;
}

// Cluster one scope's direct children into layers by OVERLAPPING x-intervals,
// not by equal left edges: ELK centres a narrow node (a 148-wide product card, a
// loop box) inside a layer whose width is the widest member, so the members of
// one layer do not share a left edge at all. A node joins the running cluster
// when its left edge is at or left of the cluster's right edge, so a layer is a
// maximal transitively overlapping run and every gap between two layers is
// non-negative by construction.
function layersOfScope(
  members: ReadonlyArray<RFAnyNode>,
  byId: ReadonlyMap<string, RFAnyNode>,
  widthOf: (node: RFAnyNode) => number = nodeWidth,
): Layer[] {
  const intervals = members
    .map((node) => {
      const left = absoluteLeft(node, byId);
      return { id: node.id, left, right: left + widthOf(node) };
    })
    .sort((a, b) => a.left - b.left);

  const clusters: { left: number; right: number; members: string[] }[] = [];
  for (const interval of intervals) {
    const open = clusters[clusters.length - 1];
    if (
      open === undefined ||
      interval.left > open.right + LAYER_MERGE_TOLERANCE
    ) {
      clusters.push({
        left: interval.left,
        right: interval.right,
        members: [interval.id],
      });
      continue;
    }
    open.right = Math.max(open.right, interval.right);
    open.members.push(interval.id);
  }

  return clusters.map((cluster, index) => ({ index, ...cluster }));
}

function scopeOf(id: string, layers: ReadonlyArray<Layer>): Scope {
  const layerByNodeId = new Map<string, number>();
  for (const layer of layers) {
    for (const member of layer.members) layerByNodeId.set(member, layer.index);
  }
  return { id, layers, layerByNodeId };
}

// The layer model of a placement: one scope for the root and one per container
// interior, each layered in its own frame.
//
// Memoized per nodes ARRAY: every routing pass of one fold is handed the same
// array and asks for its model several times. That holds only while nobody
// moves a node inside an array whose model was already taken; the one
// in-place mover, widenLayerGaps, builds its own model after its last move.
const layerModelByNodes = new WeakMap<ReadonlyArray<RFAnyNode>, LayerModel>();

export function buildLayerModel(nodes: ReadonlyArray<RFAnyNode>): LayerModel {
  const cached = layerModelByNodes.get(nodes);
  if (cached !== undefined) return cached;
  const model = layerModelOf(nodes);
  layerModelByNodes.set(nodes, model);
  return model;
}

function layerModelOf(nodes: ReadonlyArray<RFAnyNode>): LayerModel {
  const byId = nodeIndexOf(nodes);
  const scopeByNodeId = scopeByNodeIdOf(nodes);
  const scopes = new Map<string, Scope>();
  for (const id of scopeIdsOf(nodes, scopeByNodeId)) {
    const members = nodes.filter((node) => scopeByNodeId.get(node.id) === id);
    scopes.set(id, scopeOf(id, layersOfScope(members, byId)));
  }
  return { scopes, scopeByNodeId };
}

// The scope chain of a node: the scope it sits in, then that scope's own scope,
// up to the root. A node the model does not know has an empty chain.
function scopeChainOf(model: LayerModel, id: string): string[] {
  const chain: string[] = [];
  let scope = model.scopeByNodeId.get(id);
  while (scope !== undefined) {
    chain.push(scope);
    if (scope === ROOT_SCOPE) break;
    scope = model.scopeByNodeId.get(scope);
  }
  return chain;
}

// The LOWEST COMMON SCOPE of a set of nodes: the innermost frame all of them are
// placed in, which is the frame an edge's (or a whole trunk's) layer distance,
// gaps and columns are all measured in.
function commonScopeOfAll(
  model: LayerModel,
  ids: ReadonlyArray<string>,
): string | undefined {
  const chains = ids.map((id) => scopeChainOf(model, id));
  const first = chains[0];
  if (first === undefined) return undefined;
  return first.find((scope) => chains.every((chain) => chain.includes(scope)));
}

function commonScopeOf(
  model: LayerModel,
  a: string,
  b: string,
): string | undefined {
  return commonScopeOfAll(model, [a, b]);
}

// The layer index of a node's representative inside `scope`: the node itself
// when it is a direct child, otherwise the ancestor container that is.
export function layerIndexIn(
  model: LayerModel,
  scope: string,
  id: string,
): number | undefined {
  let node: string | undefined = id;
  while (node !== undefined && model.scopeByNodeId.get(node) !== scope) {
    node = model.scopeByNodeId.get(node);
    if (node === ROOT_SCOPE) return undefined;
  }
  if (node === undefined) return undefined;
  return model.scopes.get(scope)?.layerByNodeId.get(node);
}

// The HOME layer of a node: its own scope and its index there. This is the frame
// a node's own furniture lives in -- the cards it shares a left edge with, the
// gap its entering runs cross -- as opposed to the frame of any one edge.
export function homeLayerOf(
  model: LayerModel,
  id: string,
): { readonly scope: string; readonly index: number } | undefined {
  const scope = model.scopeByNodeId.get(id);
  if (scope === undefined) return undefined;
  const index = layerIndexIn(model, scope, id);
  return index === undefined ? undefined : { scope, index };
}

// Where one edge stands in the model: the scope its two endpoints share and the
// layer indices of their representatives there.
export type LayerSpan = {
  readonly scope: string;
  readonly from: number;
  readonly to: number;
};

export function layerSpanOf(
  model: LayerModel,
  sourceId: string,
  targetId: string,
): LayerSpan | undefined {
  const scope = commonScopeOf(model, sourceId, targetId);
  if (scope === undefined) return undefined;
  const from = layerIndexIn(model, scope, sourceId);
  const to = layerIndexIn(model, scope, targetId);
  if (from === undefined || to === undefined) return undefined;
  return { scope, from, to };
}

// The key a gap is looked up by: one scope's gap k. A root gap and a container
// interior gap can cover the same x band, so an index alone would collide.
export function gapKeyOf(gap: { scope: string; index: number }): string {
  return `${gap.scope}#${gap.index}`;
}

// The gap keys one node's DEPARTING (or ARRIVING) runs could stand in, innermost
// scope first: the gap right of (left of) the node's own layer, then the same
// question asked of its container in the parent scope, up to the root.
//
// A run out of a card nested in a container crosses that container's interior
// corridor before it reaches any root gap, so the innermost gap that EXISTS is
// the one it stands in. The walk ends at the scope the edge's two endpoints
// share, which is the outermost frame the run can be measured in at all.
export function gapKeysFor(
  model: LayerModel,
  nodeId: string,
  side: "depart" | "arrive",
): string[] {
  const keys: string[] = [];
  let node: string | undefined = nodeId;
  while (node !== undefined) {
    const scope = model.scopeByNodeId.get(node);
    if (scope === undefined) break;
    const index = model.scopes.get(scope)?.layerByNodeId.get(node);
    if (index !== undefined) {
      keys.push(
        gapKeyOf({ scope, index: side === "depart" ? index : index - 1 }),
      );
    }
    if (scope === ROOT_SCOPE) break;
    node = scope;
  }
  return keys;
}

export type GapSpan = {
  readonly scope: string;
  readonly index: number;
  readonly left: number;
  readonly right: number;
};

// The inter-layer gaps of every scope: gap k spans layer k's right edge to layer
// k+1's left edge. A scope with fewer than two layers has no gaps.
export function gapSpansOf(model: LayerModel): ReadonlyArray<GapSpan> {
  const spans: GapSpan[] = [];
  for (const scope of model.scopes.values()) {
    for (let k = 0; k + 1 < scope.layers.length; k += 1) {
      spans.push({
        scope: scope.id,
        index: k,
        left: scope.layers[k]!.right,
        right: scope.layers[k + 1]!.left,
      });
    }
  }
  return spans;
}

// Edges that carry an item and whose both endpoints are placed. Everything in
// this module reasons over exactly these.
function itemEdgesOf(
  edges: ReadonlyArray<Edge>,
  byId: ReadonlyMap<string, RFAnyNode>,
): Edge[] {
  return edges.filter(
    (edge) =>
      edgeItem(edge) !== undefined &&
      byId.has(edge.source) &&
      byId.has(edge.target),
  );
}

type Bucket = {
  item: string;
  unit: string;
  members: Edge[];
  counterparts: Set<string>;
};

function bucketTrunks(buckets: Map<string, Bucket>, kind: TrunkKind): Trunk[] {
  const trunks: Trunk[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.counterparts.size < 2) continue;
    let total = new Fraction(0);
    let owner = bucket.members[0]!.id;
    for (const edge of bucket.members) {
      total = total.add(edgeRate(edge) ?? new Fraction(0));
      if (edge.id < owner) owner = edge.id;
    }
    trunks.push({
      kind,
      key,
      item: bucket.item,
      unit: bucket.unit,
      members: bucket.members.map((e) => e.id),
      owner,
      total,
    });
  }
  return trunks;
}

// Same-item connected components over the bipartite (source, target) graph, by
// union-find on tagged endpoints ("s:<id>" / "t:<id>"). A unit that both
// produces and consumes one item tags twice, so a chain a->b->c stays two
// components rather than collapsing into one.
function sameItemComponents(edges: ReadonlyArray<Edge>): Web[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const tagged = edges.map((edge) => {
    const item = edgeItem(edge)!;
    return {
      edge,
      source: `${item}|s:${edge.source}`,
      target: `${item}|t:${edge.target}`,
    };
  });
  for (const t of tagged) union(t.source, t.target);

  const components = new Map<
    string,
    {
      item: string;
      sources: Set<string>;
      targets: Set<string>;
      members: string[];
    }
  >();
  for (const t of tagged) {
    const root = find(t.source);
    const found = components.get(root) ?? {
      item: edgeItem(t.edge)!,
      sources: new Set<string>(),
      targets: new Set<string>(),
      members: [],
    };
    found.sources.add(t.edge.source);
    found.targets.add(t.edge.target);
    found.members.push(t.edge.id);
    components.set(root, found);
  }

  return [...components.values()].map((c) => ({
    item: c.item,
    sources: [...c.sources],
    targets: [...c.targets],
    members: c.members,
  }));
}

// Is a same-item component an N-to-M web? N >= 2 sources, M >= 2 targets, and
// every source-target pair present (so the member count is exactly N * M).
function isWeb(component: Web): boolean {
  return (
    component.sources.length >= 2 &&
    component.targets.length >= 2 &&
    component.members.length ===
      component.sources.length * component.targets.length
  );
}

// Is a same-item component N-to-M at all, web or not? The census counts both.
export function isNToM(component: Web): boolean {
  return component.sources.length >= 2 && component.targets.length >= 2;
}

// Every same-item component of the graph, for the census. Webs are the subset
// satisfying isWeb.
export function sameItemComponentsOf(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): ReadonlyArray<Web> {
  return sameItemComponents(itemEdgesOf(edges, nodeIndexOf(nodes)));
}

export function classifyTrunks(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): TrunkClassification {
  const byId = nodeIndexOf(nodes);
  const items = itemEdgesOf(edges, byId);

  const outBuckets = new Map<string, Bucket>();
  const inBuckets = new Map<string, Bucket>();
  const bucket = (
    buckets: Map<string, Bucket>,
    key: string,
    item: string,
    unit: string,
  ): Bucket => {
    const found = buckets.get(key) ?? {
      item,
      unit,
      members: [],
      counterparts: new Set<string>(),
    };
    buckets.set(key, found);
    return found;
  };

  for (const edge of items) {
    const item = edgeItem(edge)!;
    const out = bucket(
      outBuckets,
      flowKeyOf(item, edge.source),
      item,
      edge.source,
    );
    out.members.push(edge);
    out.counterparts.add(edge.target);

    const into = bucket(
      inBuckets,
      flowKeyOf(item, edge.target),
      item,
      edge.target,
    );
    into.members.push(edge);
    into.counterparts.add(edge.source);
  }

  const fanOut = bucketTrunks(outBuckets, "fanOut");
  const fanIn = bucketTrunks(inBuckets, "fanIn");
  const trunks = [...fanOut, ...fanIn];

  const trunkByEdgeId = new Map<string, { fanOut?: Trunk; fanIn?: Trunk }>();
  for (const trunk of trunks) {
    for (const id of trunk.members) {
      const entry = trunkByEdgeId.get(id) ?? {};
      if (trunk.kind === "fanOut") entry.fanOut = trunk;
      else entry.fanIn = trunk;
      trunkByEdgeId.set(id, entry);
    }
  }

  return {
    trunks,
    webs: sameItemComponents(items).filter(isWeb),
    trunkByEdgeId,
  };
}

// The chip one edge owes on one side of the gap it crosses. A fan-out member's
// source stub carries the trunk's AGGREGATE total (the drop chip BusEdge draws),
// a fan-in member's target leg carries the fan-in total, and every other end --
// a 1-to-1 edge, or the free end of a member that is a trunk on its other side
// only -- carries the edge's own rate chip. A web member is both, which is
// exactly the per-source total on its stub and the per-target total on its leg.
function chipTextForSide(
  edge: Edge,
  side: "source" | "target",
  trunkByEdgeId: ReadonlyMap<string, { fanOut?: Trunk; fanIn?: Trunk }>,
): ChipText | undefined {
  const entry = trunkByEdgeId.get(edge.id);
  const trunk = side === "source" ? entry?.fanOut : entry?.fanIn;
  if (trunk === undefined) return rateChipText(edge);
  // Reuse the production aggregate builder rather than re-format the total: the
  // reserve has to measure the string the chip will really draw. The pass runs
  // before routeTrunkEdges stamps busTotalRate, so the total is handed in here.
  return aggregateChipText({
    ...edge,
    data: { ...edge.data, busTotalRate: trunk.total },
  });
}

// The width one reserved chip box takes in a gap: the card-side pad, the chip at
// its natural width, and the column-side pad.
function reserveWidth(text: ChipText | undefined): number {
  return RESERVE_CARD_PAD + chipNaturalWidth(text) + RESERVE_COLUMN_PAD;
}

// The scope a whole TRUNK is measured in: the lowest common scope of its unit
// and every counterpart. One trunk draws one junction column, so it stands in
// one scope's gap however its members are nested.
export function trunkScopeOf(
  model: LayerModel,
  trunk: Trunk,
  edges: ReadonlyMap<string, Edge>,
): string | undefined {
  const ids = [trunk.unit];
  for (const id of trunk.members) {
    const edge = edges.get(id);
    if (edge === undefined) continue;
    ids.push(trunk.kind === "fanOut" ? edge.target : edge.source);
  }
  return commonScopeOfAll(model, ids);
}

// What every gap owes, measured on the layer model as ELK left it.
//
// Which gap a reserve falls in: an edge from layer i to layer j OF ITS OWN SCOPE
// owes its source reserve to gap i (the gap right of its source) and its target
// reserve to gap j-1 (the gap left of its target). That one rule covers a
// backward edge too -- ELK reverses cycles, so j <= i there, and the two
// reserves simply land on either side of the endpoints instead of inside one
// gap. A reserve whose gap index falls outside the layer range (the source of
// the last layer, the target of the first) has no gap to sit in and is dropped.
export function gapRequirements(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): ReadonlyArray<GapRequirement> {
  return requirementsOf(buildLayerModel(nodes), nodes, edges);
}

function requirementsOf(
  model: LayerModel,
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): ReadonlyArray<GapRequirement> {
  const byId = nodeIndexOf(nodes);
  const spans = gapSpansOf(model);
  if (spans.length === 0) return [];
  const known = new Set(spans.map(gapKeyOf));

  const { trunks, trunkByEdgeId } = classifyTrunks(nodes, edges);
  const sourceZone = new Map<string, number>();
  const targetZone = new Map<string, number>();
  const columns = new Map<string, number>();
  // Staggered 1-to-1 bend columns, counted apart from the trunk columns: they
  // stand at the floor rather than the whole COLUMN_PITCH a trunk column owes
  // its neighbours.
  const bendColumns = new Map<string, number>();

  const charge = (
    zone: Map<string, number>,
    scope: string,
    index: number,
    width: number,
  ): void => {
    const key = gapKeyOf({ scope, index });
    if (!known.has(key)) return;
    zone.set(key, Math.max(zone.get(key) ?? 0, width));
  };
  const count = (
    zone: Map<string, number>,
    scope: string,
    index: number,
  ): void => {
    const key = gapKeyOf({ scope, index });
    if (!known.has(key)) return;
    zone.set(key, (zone.get(key) ?? 0) + 1);
  };

  for (const edge of itemEdgesOf(edges, byId)) {
    const span = layerSpanOf(model, edge.source, edge.target);
    if (span === undefined) continue;
    const { scope, from, to } = span;
    charge(
      sourceZone,
      scope,
      from,
      reserveWidth(chipTextForSide(edge, "source", trunkByEdgeId)),
    );
    charge(
      targetZone,
      scope,
      to - 1,
      reserveWidth(chipTextForSide(edge, "target", trunkByEdgeId)),
    );
    // A forward 1-to-1 edge takes its own staggered bend column in the gap right
    // of its source layer. A trunk member takes none: the trunk router puts it
    // on its trunk's shared column, charged below.
    if (to > from && !trunkByEdgeId.has(edge.id)) {
      count(bendColumns, scope, from);
    }
  }

  // One shared junction column per trunk, in the gap beside the unit it fans
  // from or into. EVERY trunk counts, webs included: the drawn web shape is
  // deferred, so routeTrunkEdges gives each member trunk of a web its own
  // column like any other, and the reserve has to match what the routing pass
  // will place. The classification still reports the webs for later.
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const trunk of trunks) {
    const scope = trunkScopeOf(model, trunk, edgeById);
    if (scope === undefined) continue;
    const layer = layerIndexIn(model, scope, trunk.unit);
    if (layer === undefined) continue;
    count(columns, scope, trunk.kind === "fanOut" ? layer : layer - 1);
  }

  return spans.map((span) => {
    const key = gapKeyOf(span);
    const source = sourceZone.get(key) ?? 0;
    const target = targetZone.get(key) ?? 0;
    const trunkColumns = columns.get(key) ?? 0;
    const bends = bendColumns.get(key) ?? 0;
    // A gap no edge crosses owes nothing and keeps the width ELK gave it.
    if (source === 0 && target === 0 && trunkColumns === 0) {
      return {
        scope: span.scope,
        index: span.index,
        sourceZone: 0,
        columnZone: 0,
        targetZone: 0,
        columns: 0,
        required: 0,
      };
    }
    // The zone holds one COLUMN_PITCH per trunk column plus one floor per
    // staggered bend column, so the fan can keep the floor between every pair
    // instead of squeezing them together. A trunk column's own pitch already
    // covers the floor its two neighbours owe it.
    const columnZone =
      FORWARD_STEP_BUDGET +
      COLUMN_PITCH * trunkColumns +
      COLUMN_MIN_PITCH * bends;
    return {
      scope: span.scope,
      index: span.index,
      sourceZone: source,
      columnZone,
      targetZone: target,
      columns: trunkColumns,
      required: source + columnZone + target,
    };
  });
}

// A node clone whose position object is its own, so the widening can move it
// without touching the input.
type WorkingNode = RFAnyNode & { position: { x: number; y: number } };

function cloneNodes(nodes: ReadonlyArray<RFAnyNode>): WorkingNode[] {
  return nodes.map(
    (node) =>
      ({
        ...node,
        position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
      }) as WorkingNode,
  );
}

// The narrowest gap a layer whose own content GREW may be left with. A gap of
// exactly zero would let the clustering merge the two layers on the next pass,
// which is the very confusion the scoped model exists to prevent; anything above
// LAYER_MERGE_TOLERANCE keeps them apart.
const MIN_GROWN_LAYER_GAP = 1;

// The per-layer right shift one scope's gaps owe, accumulated before anything
// moves: widening gap k shifts every layer from k+1 on, so later gaps are
// measured against the spans those shifts produce. Since a shift is uniform over
// a whole layer, no node ever changes layer and one clustering describes both
// sides of the pass.
//
// `grownRight[k]` is layer k's right edge AFTER the growth its own containers
// took from their interiors. The clustering is done on the pre-growth intervals
// -- that is the arrangement ELK chose -- and the growth is then charged to the
// gap right of the layer, so a container that swelled past its neighbour's
// column pushes that column right instead of merging with it.
function shiftsForScope(
  layers: ReadonlyArray<Layer>,
  grownRight: ReadonlyArray<number>,
  requirements: ReadonlyArray<GapRequirement>,
): number[] {
  const shiftByLayer = new Array<number>(layers.length).fill(0);
  for (let k = 0; k + 1 < layers.length; k += 1) {
    const required = requirements.find((r) => r.index === k)?.required ?? 0;
    const grew = grownRight[k]! > layers[k]!.right;
    const floor = grew ? Math.max(required, MIN_GROWN_LAYER_GAP) : required;
    const widened =
      layers[k + 1]!.left +
      shiftByLayer[k + 1]! -
      (grownRight[k]! + shiftByLayer[k]!);
    const delta = Math.max(0, floor - widened);
    for (let layer = k + 1; layer < shiftByLayer.length; layer += 1) {
      shiftByLayer[layer] = shiftByLayer[layer]! + delta;
    }
  }
  return shiftByLayer;
}

// Widen every gap that owes more than ELK gave it and report where each gap's
// zones ended up.
//
// BOTTOM-UP over the scopes: a container's interior is arranged first, the
// container's box grows by the growth its interior took (its children keep their
// parent-relative positions, so they travel with it), and only then does the
// parent scope cluster its own layers -- against the box the child has already
// grown to. Working deepest-first is what makes one pass enough: no scope is
// measured before the intervals it is made of are final.
export function widenLayerGaps(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): { nodes: RFAnyNode[]; gaps: GapRecord[] } {
  const working = cloneNodes(nodes);
  const byId = nodeIndexOf(working);
  const scopeByNodeId = scopeByNodeIdOf(working);
  const membersByScope = new Map<string, WorkingNode[]>();
  for (const node of working) {
    const scope = scopeByNodeId.get(node.id)!;
    pushInto(membersByScope, scope, node);
  }

  // Deepest scope first. A scope's depth is its container's depth plus one.
  const depthOf = (scope: string): number => {
    let depth = 0;
    let at = scope;
    while (at !== ROOT_SCOPE) {
      depth += 1;
      at = scopeByNodeId.get(at) ?? ROOT_SCOPE;
    }
    return depth;
  };
  const order = scopeIdsOf(working, scopeByNodeId).sort(
    (a, b) => depthOf(b) - depthOf(a),
  );

  // How much each container's box has already grown, so its parent scope can
  // charge that growth to the container's own interval rather than re-measuring
  // an interior it does not own.
  const growthById = new Map<string, number>();

  for (const scope of order) {
    const members = membersByScope.get(scope) ?? [];
    const grownBy = (node: RFAnyNode): number => growthById.get(node.id) ?? 0;
    const layers = layersOfScope(
      members,
      byId,
      (node) => nodeWidth(node) - grownBy(node),
    );
    const layered = scopeOf(scope, layers);
    const grownRight = layers.map((layer) =>
      Math.max(
        ...layer.members.map((id) => {
          const node = byId.get(id)!;
          return absoluteLeft(node, byId) + nodeWidth(node);
        }),
      ),
    );
    const model: LayerModel = {
      scopes: new Map([[scope, layered]]),
      scopeByNodeId,
    };
    const shiftByLayer = shiftsForScope(
      layers,
      grownRight,
      requirementsOf(model, working, edges),
    );

    let growth = 0;
    for (const member of members) {
      const layer = layered.layerByNodeId.get(member.id);
      const shift = layer === undefined ? 0 : (shiftByLayer[layer] ?? 0);
      if (shift !== 0) {
        member.position = {
          x: member.position.x + shift,
          y: member.position.y,
        };
      }
      growth = Math.max(growth, shift + (growthById.get(member.id) ?? 0));
    }

    if (scope === ROOT_SCOPE || growth <= 0) continue;
    const container = byId.get(scope) as WorkingNode | undefined;
    if (container === undefined) continue;
    const width = (container.width ?? 0) + growth;
    container.width = width;
    container.style = { ...container.style, width };
    growthById.set(scope, growth);
  }

  // The records come off the FINAL placement: a within-scope shift is uniform
  // over a layer and an ancestor's shift translates a whole subtree, so the
  // clustering below is the one each scope was widened against.
  const model = buildLayerModel(working);
  const spans = new Map(
    gapSpansOf(model).map((span) => [gapKeyOf(span), span]),
  );
  const gaps: GapRecord[] = requirementsOf(model, working, edges).map(
    (requirement) => {
      const span = spans.get(gapKeyOf(requirement))!;
      const sourceRight = span.left + requirement.sourceZone;
      const targetLeft = span.right - requirement.targetZone;
      return {
        scope: requirement.scope,
        index: requirement.index,
        left: span.left,
        right: span.right,
        sourceZone: { left: span.left, right: sourceRight },
        columnZone: { left: sourceRight, right: targetLeft },
        targetZone: { left: targetLeft, right: span.right },
        columns: requirement.columns,
      };
    },
  );

  return { nodes: working, gaps };
}
