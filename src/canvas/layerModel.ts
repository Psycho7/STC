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
//   columnZone  the shared junction columns the trunks in this gap need
//   targetZone  the widest chip any edge entering layer k+1 owes beside its
//               target port, plus its pads
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

import { DOT_KEEPOFF } from "./dimensions";
import { FORWARD_STEP_BUDGET, PORT_STUB } from "./edgePath";
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

// One layer of the laid-out graph: a maximal run of leaf nodes whose x-intervals
// overlap transitively. `left` is the leftmost left edge over the members,
// `right` the rightmost right edge. Container ("group") nodes are not members --
// a container spans the layers of its children, so it would only blur the
// boundaries.
export type Layer = {
  readonly index: number;
  readonly left: number;
  readonly right: number;
  readonly members: ReadonlyArray<string>;
};

export type LayerModel = {
  readonly layers: ReadonlyArray<Layer>;
  readonly layerByNodeId: ReadonlyMap<string, number>;
};

// A horizontal band in absolute x.
export type Zone = { readonly left: number; readonly right: number };

// Gap k, between layer k's right edge and layer k+1's left edge, with the three
// zones laid out inside it: the source zone flush against layer k, the target
// zone flush against layer k+1, the column zone in between (it absorbs any slack
// ELK left over the requirement).
export type GapRecord = {
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

// What gap k owes, before any node moves. Zone widths, not coordinates.
export type GapRequirement = {
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

// Cluster the leaf nodes into layers by OVERLAPPING x-intervals, not by equal
// left edges: ELK centres a narrow node (a 148-wide product card, a loop box)
// inside a layer whose width is the widest member, so the members of one layer
// do not share a left edge at all. A node joins the running cluster when its
// left edge is at or left of the cluster's right edge, so a layer is a maximal
// transitively overlapping run and every gap between two layers is non-negative
// by construction.
export function buildLayerModel(nodes: ReadonlyArray<RFAnyNode>): LayerModel {
  const byId = nodeIndexOf(nodes);
  const intervals = nodes
    .filter((node) => node.type !== "group")
    .map((node) => {
      const left = absoluteLeft(node, byId);
      return { id: node.id, left, right: left + nodeWidth(node) };
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

  const layers: Layer[] = clusters.map((cluster, index) => ({
    index,
    ...cluster,
  }));

  const layerByNodeId = new Map<string, number>();
  for (const layer of layers) {
    for (const id of layer.members) layerByNodeId.set(id, layer.index);
  }

  return { layers, layerByNodeId };
}

// The inter-layer gaps of a layer model: gap k spans layer k's right edge to
// layer k+1's left edge. A model with fewer than two layers has no gaps.
export function gapSpansOf(
  model: LayerModel,
): ReadonlyArray<{ index: number; left: number; right: number }> {
  const spans: { index: number; left: number; right: number }[] = [];
  for (let k = 0; k + 1 < model.layers.length; k += 1) {
    spans.push({
      index: k,
      left: model.layers[k]!.right,
      right: model.layers[k + 1]!.left,
    });
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

// What every gap owes, measured on the layer model as ELK left it.
//
// Which gap a reserve falls in: an edge from layer i to layer j owes its source
// reserve to gap i (the gap right of its source) and its target reserve to gap
// j-1 (the gap left of its target). That one rule covers a backward edge too --
// ELK reverses cycles, so j <= i there, and the two reserves simply land on
// either side of the endpoints instead of inside one gap. A reserve whose gap
// index falls outside the layer range (the source of the last layer, the target
// of the first) has no gap to sit in and is dropped.
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

  const { trunks, trunkByEdgeId } = classifyTrunks(nodes, edges);
  const sourceZone = new Array<number>(spans.length).fill(0);
  const targetZone = new Array<number>(spans.length).fill(0);
  const columns = new Array<number>(spans.length).fill(0);

  const charge = (zone: number[], index: number, width: number): void => {
    if (index < 0 || index >= spans.length) return;
    zone[index] = Math.max(zone[index]!, width);
  };

  for (const edge of itemEdgesOf(edges, byId)) {
    const i = model.layerByNodeId.get(edge.source);
    const j = model.layerByNodeId.get(edge.target);
    if (i === undefined || j === undefined) continue;
    charge(
      sourceZone,
      i,
      reserveWidth(chipTextForSide(edge, "source", trunkByEdgeId)),
    );
    charge(
      targetZone,
      j - 1,
      reserveWidth(chipTextForSide(edge, "target", trunkByEdgeId)),
    );
  }

  // One shared junction column per trunk, in the gap beside the unit it fans
  // from or into. EVERY trunk counts, webs included: the drawn web shape is
  // deferred, so routeTrunkEdges gives each member trunk of a web its own
  // column like any other, and the reserve has to match what the routing pass
  // will place. The classification still reports the webs for later.
  const addColumn = (index: number): void => {
    if (index < 0 || index >= spans.length) return;
    columns[index] = columns[index]! + 1;
  };
  for (const trunk of trunks) {
    const layer = model.layerByNodeId.get(trunk.unit);
    if (layer === undefined) continue;
    addColumn(trunk.kind === "fanOut" ? layer : layer - 1);
  }

  return spans.map((span) => {
    const source = sourceZone[span.index]!;
    const target = targetZone[span.index]!;
    const count = columns[span.index]!;
    // A gap no edge crosses owes nothing and keeps the width ELK gave it.
    if (source === 0 && target === 0 && count === 0) {
      return {
        index: span.index,
        sourceZone: 0,
        columnZone: 0,
        targetZone: 0,
        columns: 0,
        required: 0,
      };
    }
    const columnZone = FORWARD_STEP_BUDGET + COLUMN_PITCH * count;
    return {
      index: span.index,
      sourceZone: source,
      columnZone,
      targetZone: target,
      columns: count,
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

// Apply a per-layer right shift to a clone of the nodes. Membership decides, not
// an x comparison: a leaf node moves by its own layer's shift, so a layer that
// happens to sit on a fractional x can never be left behind by a boundary test.
// A container is positioned by its LEFTMOST child's layer -- every child then
// keeps the parent-relative x it came in with when the whole container moves as
// a unit -- and a container whose children straddle a widened gap grows by the
// shift its rightmost child took relative to its leftmost.
//
// The walk is recursive, so a container nested inside another container passes
// its children's shifts up its whole ancestor chain and every ancestor it
// straddles grows. fromElkRenderLayout emits a single level of nesting today (a
// container's children are units), so the recursion is what keeps the model
// correct rather than silently wrong if deeper nesting ever arrives.
function applyLayerShifts(
  working: WorkingNode[],
  layerByNodeId: ReadonlyMap<string, number>,
  shiftByLayer: ReadonlyArray<number>,
): void {
  const childrenByParent = new Map<string, WorkingNode[]>();
  for (const node of working) {
    if (node.parentId === undefined) continue;
    const kids = childrenByParent.get(node.parentId) ?? [];
    kids.push(node);
    childrenByParent.set(node.parentId, kids);
  }
  const shiftOf = (id: string): number => {
    const layer = layerByNodeId.get(id);
    return layer === undefined ? 0 : (shiftByLayer[layer] ?? 0);
  };
  const moveBy = (node: WorkingNode, delta: number): void => {
    if (delta === 0) return;
    node.position = { x: node.position.x + delta, y: node.position.y };
  };

  // Arrange one subtree's interior and report the shifts its own box owes: the
  // move its left edge takes (its parent applies it) and the move its right
  // edge takes. A leaf owes its layer's shift on both edges; a container owes
  // its leftmost child's shift on the left and its rightmost content's on the
  // right, and grows by the difference.
  const arrange = (node: WorkingNode): { left: number; right: number } => {
    const kids = childrenByParent.get(node.id);
    if (kids === undefined) {
      const shift = shiftOf(node.id);
      return { left: shift, right: shift };
    }
    const shifts = kids.map(arrange);
    const base = Math.min(...shifts.map((s) => s.left));
    kids.forEach((kid, index) => {
      moveBy(kid, shifts[index]!.left - base);
    });
    const growth = Math.max(...shifts.map((s) => s.right)) - base;
    if (growth > 0) {
      const width = (node.width ?? 0) + growth;
      node.width = width;
      node.style = { ...node.style, width };
    }
    return { left: base, right: base + growth };
  };

  for (const node of working) {
    if (node.parentId !== undefined) continue; // moves with its container
    moveBy(node, arrange(node).left);
  }
}

// Widen every gap that owes more than ELK gave it, left to right, and report
// where each gap's zones ended up.
//
// The deltas are accumulated per layer before anything moves: widening gap k
// shifts every layer from k+1 on, so later gaps are measured against the spans
// those shifts produce. Since a shift is uniform over a whole layer, no node ever
// changes layer and one model built on the ELK placement describes both sides.
export function widenLayerGaps(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): { nodes: RFAnyNode[]; gaps: GapRecord[] } {
  const model = buildLayerModel(nodes);
  const requirements = requirementsOf(model, nodes, edges);
  const spans = gapSpansOf(model);
  const shiftByLayer = new Array<number>(model.layers.length).fill(0);

  for (const requirement of requirements) {
    const span = spans[requirement.index]!;
    const widened =
      span.right +
      shiftByLayer[requirement.index + 1]! -
      (span.left + shiftByLayer[requirement.index]!);
    const delta = Math.max(0, requirement.required - widened);
    for (
      let layer = requirement.index + 1;
      layer < shiftByLayer.length;
      layer += 1
    ) {
      shiftByLayer[layer] = shiftByLayer[layer]! + delta;
    }
  }

  const working = cloneNodes(nodes);
  applyLayerShifts(working, model.layerByNodeId, shiftByLayer);

  const gaps: GapRecord[] = requirements.map((requirement) => {
    const span = spans[requirement.index]!;
    const left = span.left + shiftByLayer[requirement.index]!;
    const right = span.right + shiftByLayer[requirement.index + 1]!;
    const sourceRight = left + requirement.sourceZone;
    const targetLeft = right - requirement.targetZone;
    return {
      index: requirement.index,
      left,
      right,
      sourceZone: { left, right: sourceRight },
      columnZone: { left: sourceRight, right: targetLeft },
      targetZone: { left: targetLeft, right },
      columns: requirement.columns,
    };
  });

  return { nodes: working, gaps };
}
