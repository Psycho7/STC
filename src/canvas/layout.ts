// Turns a RenderPlan into an ELK graph and then into React Flow nodes and edges.
//
// This is the one place that talks to ELK for the render pipeline. Given a
// RenderPlan (units, edges, containers) and a recipe lookup, it builds an ELK
// graph that holds the layout steady:
//
// - a single root node with id "root"
// - the "layered" algorithm with INCLUDE_CHILDREN hierarchy handling
// - orthogonal edge routing
// - recipe, stamp, badge and port sizes pulled straight from ./dimensions
// - ports in fixed order, inputs on the west side and outputs on the east, each
//   given a non-zero size
// - node and between-layer spacing from NODE_NODE_SPACING and
//   BETWEEN_LAYERS_SPACING
//
// A loop unit's interior is laid out by its own recursive ELK call; the outer
// call only sees the loop as one node sized through loopBoxDimensions(interior).
// For now the caller hands in a precomputed interiorByLoopId map, and laying out
// the interior itself belongs to the SCC renderer rather than this module.
//
// The LogicalGraph types used to live in a separate layout module that no longer
// exists. They sit here now because both the solver and the fixture builder
// still create LogicalGraph instances, which feed buildRenderPlan before
// layoutRenderPlan ever runs.

import type { Item, Recipe } from "@aef/schema";
import type { ElkNode, ElkExtendedEdge, ElkPort } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  MarkerType,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import Fraction from "fraction.js";

import {
  BETWEEN_LAYERS_SPACING,
  NODE_NODE_SPACING,
  PORT_HEIGHT,
  PORT_WIDTH,
  loopBoxDimensions,
} from "./dimensions";
import { measureRecipe } from "./recipeGeometry";
import {
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearBusColumns,
  deconflictChipAnchors,
  jogForwardLegs,
  routeBusEdges,
} from "./busRouting";
import type {
  Container,
  ContainerId,
  GroupId,
  ItemId,
  RecipeId,
  RenderEdge,
  RenderPlan,
  RenderUnit,
  RenderUnitInputProduct,
  RenderUnitLoop,
  RenderUnitOutputProduct,
  RenderUnitRecipe,
  SccId,
  TransportKindId,
} from "../pipeline/types";
import type { RationalString } from "../data/targets";

// LogicalGraph types
//
// These sit between the solver (`assembleLogicalGraph`) and the render pipeline
// (`buildRenderPlan`). They live in this file because the canvas is what reads
// them; the solver just imports the types from here. `GroupId` is re-exported
// from pipeline/types (its real home is solver/types) so older importers that
// reach for `from "../canvas/layout"` keep working.

export type { GroupId };

export type LogicalRecipeNode = {
  kind: "recipe";
  id: RecipeId;
  recipe: Recipe;
  multiplier: number;
  expanded: boolean;
  parentId?: GroupId;
};

// Mirrors the solver's PackedLane shape but keeps itemsPerSec as a plain string,
// which lets the layout module avoid pulling in fraction.js.
export type LaneMetadata = {
  carrier: TransportKindId;
  laneIndex: number;
  overflow: boolean;
  streams: ReadonlyArray<{
    replicaId: string;
    itemId: string;
    itemsPerSec: string;
  }>;
};

export type LogicalGroupNode = {
  kind: "group";
  id: GroupId;
  label: string;
  lanes?: ReadonlyArray<LaneMetadata>;
};

export type LogicalNode = LogicalRecipeNode | LogicalGroupNode;

export type LogicalEdge = {
  id: string;
  source: RecipeId;
  target: RecipeId;
  sourcePort: string; // 'out:<itemId>'
  targetPort: string; // 'in:<itemId>'
};

export type LogicalGraph = {
  nodes: LogicalNode[];
  edges: LogicalEdge[];
};

// The RenderPlan-driven API.

export type ElkGraph = ElkNode & {
  children: ElkNode[];
  edges: ElkExtendedEdge[];
};

export type LoopInteriorSize = { width: number; height: number };

export type LayoutInput = {
  plan: RenderPlan;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  // Item lookup used to resolve each port's `transportKind`. It is required so
  // the type system forces callers to supply it; pass `new Map()` to take the
  // "no glyphs" path. Resolving the kind here lets the node components stay
  // simple: they read the per-port kind off their own `data` and never reach
  // into the recipe pack.
  itemById: ReadonlyMap<ItemId, Item>;
  // Precomputed interior dimensions keyed by loop sccId. A loop whose sccId is
  // missing from this map falls back to a default placeholder size; its real
  // interior gets laid out by the SCC renderer in a later pass.
  // TODO: swap the placeholder for the real size once SCC interior layout exists.
  interiorByLoopId?: ReadonlyMap<SccId, LoopInteriorSize>;
};

// An ELK port output with a transport kind tacked on. ELK happily carries
// arbitrary runtime properties, and this typed wrapper spells out that contract
// so the React Flow mapping step can read the field back without resolving items
// a second time.
type ElkPortWithKind = ElkPort & { transportKind?: TransportKindId };

// Stand-in size for a loop unit that has no precomputed interior yet. A loop's
// real dimensions follow from its interior, so until that is known this keeps
// the outer ELK call sized without pretending to model the inside.
const DEFAULT_LOOP_INTERIOR: LoopInteriorSize = { width: 200, height: 100 };

// Root-level ELK options, kept in one place so tests can assert the exact
// strings instead of copying the literals around.
export const ROOT_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "org.eclipse.elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": String(NODE_NODE_SPACING),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(BETWEEN_LAYERS_SPACING),
  // Declutter knobs for dense plans. Left-to-right layering plus per-item ports
  // otherwise fans out into long crossing edges on big graphs. Extra
  // thoroughness spends more sweep iterations minimizing crossings;
  // NETWORK_SIMPLEX node placement pulls layers tighter so edges span less
  // empty space; the edge spacing keeps routed edges clear of node bodies and
  // of each other so parallel runs read as separate lines.
  "elk.layered.thoroughness": "10",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "16",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
  // Cycle-breaking strategy. DEPTH_FIRST reverses fewer arcs than the default
  // GREEDY heuristic on this graph's recycle/byproduct family, so those edges
  // stay forward and span fewer layers. On the repro census this drops the
  // long-edge (>820px) count 14 -> 9 and the max span 5507 -> 4334.
  "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
};

// Wrapping folds an otherwise single wide band of layers into stacked rows to
// hit a target aspect ratio, so a dense plan lands close to the pane's ~1.6:1
// shape instead of a ~6:1 smear that fit-zooms below legibility. It only applies
// to large plans: a small chain already fits at a readable zoom, and wrapping it
// would fold a clean left-to-right flow into needless rows (and break the
// leftmost-input / rightmost-output reading). WRAP_MIN_UNITS is the size above
// which the flat band gets illegibly wide; below it the layered flow stays a
// single left-to-right band.
const WRAP_MIN_UNITS = 16;
const WRAP_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  "elk.aspectRatio": "1.6",
  "elk.layered.wrapping.strategy": "MULTI_EDGE",
};

// FIXED_SIDE pins each port to its declared side (WEST inputs / EAST outputs)
// but lets ELK choose the per-side vertical order to minimize edge crossings.
// Recipe and loop nodes carry multiple ports per side, so this is where the
// arrival-sorted port order comes from: ELK reorders the west/east ports so the
// entering edges approach in parallel instead of braiding in front of the node.
// The resolved order is read back after layout in resolvePortOrders and handed
// to the node components as inputOrder / outputOrder.
//
// Product units carry a single port per side, so FIXED_SIDE and FIXED_ORDER are
// behaviorally identical there. They share this one constant (least churn: no
// separate options object and no extra branch) and the per-port "elk.port.index"
// hint set in makePort is simply ignored under FIXED_SIDE.
const RECIPE_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  "org.eclipse.elk.portConstraints": "FIXED_SIDE",
};

// Per-node ELK layer constraints that pin boundary product units to the leftmost
// (input) and rightmost (output) layers. Exported as constants so tests can
// import the exact strings rather than spell them out again.
export const ELK_LAYER_CONSTRAINT_KEY =
  "org.eclipse.elk.layered.layering.layerConstraint";
export const ELK_LAYER_FIRST = "FIRST";
export const ELK_LAYER_FIRST_SEPARATE = "FIRST_SEPARATE";
export const ELK_LAYER_LAST = "LAST";

// Fixed sizes for product units in ELK. PRODUCT_HEIGHT is kept tight to the
// actual ProductNode chrome (icon row + rate row + padding) so that React
// Flow's default Handle position of top:50% falls inside the visible card
// instead of below it.
const PRODUCT_WIDTH = 148;
const PRODUCT_HEIGHT = 78;

// Per-port transport-kind lookup attached to every render-pipeline RF node.
// Keys are the React Flow Handle ids (for example "in:copper_ore" or
// "out:copper_powder"), and values are the item's transportKind resolved while
// laying out. If the input never supplied it, this map is empty and the node
// draws no port glyphs.
export type PortTransportKinds = ReadonlyMap<string, TransportKindId>;

// React Flow node typings for the pipeline. `portTransportKinds` is required at
// the layout-stage type level, and the production paths always provide it
// through `unitToRFNode`. Tests that want the "no glyphs" path should pass
// `new Map()` themselves.
// `inputOrder` / `outputOrder` carry the ELK-resolved per-side port order (the
// item id of each west / east port, top to bottom). The node components render
// their rows, Handles and glyphs in this order so the y-slot of each entering
// edge lines up with its arrival, instead of the recipe's declaration order.
// Optional: paths that build a node without a laid-out ELK graph (older fixtures
// and tests) omit them, and the components fall back to declaration order.
export type RFRecipeNode = RFNode<
  {
    recipe: Recipe;
    kind: "recipe";
    portTransportKinds: PortTransportKinds;
    multiplicity: RationalString;
    inputOrder?: ItemId[];
    outputOrder?: ItemId[];
  },
  "recipe"
>;
export type RFLoopNode = RFNode<
  {
    sccId: SccId;
    netIO: RenderUnitLoop["netIO"];
    interior: LoopInteriorSize;
    portTransportKinds: PortTransportKinds;
    inputOrder?: ItemId[];
    outputOrder?: ItemId[];
  },
  "loop"
>;
export type RFContainerNode = RFNode<
  {
    containerKind: Container["kind"];
    containerId: ContainerId;
    memberCount: number;
  },
  "group"
>;
export type RFProductNode = RFNode<
  {
    kind: "inputProduct" | "outputProduct";
    itemId: ItemId;
    // `rate` holds the realized rate for inputs and the target or surplus rate
    // for outputs. It is required on both kinds; the union in ProductNodeData
    // tells them apart by `kind`.
    rate: RenderUnitOutputProduct["rate"];
    rateCap?: RenderUnitInputProduct["rateCap"];
    flavor?: RenderUnitOutputProduct["flavor"];
    portTransportKinds: PortTransportKinds;
  },
  "product"
>;

export type RFAnyNode =
  | RFRecipeNode
  | RFLoopNode
  | RFContainerNode
  | RFProductNode;

// renderPlanToElkGraph: build the ELK graph from a RenderPlan.

export function renderPlanToElkGraph(input: LayoutInput): ElkGraph {
  const { plan, recipeById } = input;
  const interiorByLoopId =
    input.interiorByLoopId ?? new Map<SccId, LoopInteriorSize>();
  const kindOf = (itemId: ItemId): TransportKindId | undefined =>
    input.itemById.get(itemId)?.transportKind;

  const unitsByContainer = new Map<ContainerId | "__root__", RenderUnit[]>();
  for (const u of plan.units) {
    // Recipe and loop units may carry a containerId. Product units always sit
    // at the root: they are boundary nodes ELK pins to the FIRST or LAST layer,
    // so they don't belong to any blueprint group or loop box.
    const key =
      (u.kind === "recipe" || u.kind === "loop") && u.containerId !== undefined
        ? u.containerId
        : "__root__";
    const arr = unitsByContainer.get(key) ?? [];
    arr.push(u);
    unitsByContainer.set(key, arr);
  }

  const unitToElk = (u: RenderUnit): ElkNode => {
    switch (u.kind) {
      case "recipe":
        return recipeUnitToElk(
          u,
          requireRecipe(recipeById, u.recipeId),
          kindOf,
        );
      case "loop":
        return loopUnitToElk(
          u,
          interiorByLoopId.get(u.sccId) ?? DEFAULT_LOOP_INTERIOR,
          kindOf,
        );
      case "inputProduct":
        return inputProductUnitToElk(u, kindOf);
      case "outputProduct":
        return outputProductUnitToElk(u, kindOf);
    }
  };

  const rootChildren: ElkNode[] = [];

  // Add containers first so their order is preserved in the layout call.
  for (const container of plan.containers) {
    const members = unitsByContainer.get(container.id) ?? [];
    rootChildren.push({
      id: container.id,
      children: members.map(unitToElk),
      layoutOptions: {
        // Reserve a taller top band for the caption strip so a member card
        // flush against the corner cannot cover the "LOOP - N" label; keep the
        // other sides tight so members do not leave large empty quadrants.
        "org.eclipse.elk.padding": "[top=28,left=10,bottom=10,right=10]",
      },
    });
  }

  // Then the standalone units (no containerId), in plan order.
  for (const u of unitsByContainer.get("__root__") ?? []) {
    rootChildren.push(unitToElk(u));
  }

  const elkEdges: ElkExtendedEdge[] = plan.edges.map((e, i) =>
    renderEdgeToElk(e, i),
  );

  const wrap = plan.units.length >= WRAP_MIN_UNITS;
  return {
    id: "root",
    layoutOptions: {
      ...ROOT_LAYOUT_OPTIONS,
      ...(wrap ? WRAP_LAYOUT_OPTIONS : {}),
    },
    children: rootChildren,
    edges: elkEdges,
  };
}

function requireRecipe(
  recipeById: ReadonlyMap<RecipeId, Recipe>,
  id: RecipeId,
): Recipe {
  const r = recipeById.get(id);
  if (!r) {
    throw new Error(`renderPlanToElkGraph: missing recipe for id "${id}"`);
  }
  return r;
}

// Each port's `transportKind` is stamped onto the ELK port output through
// `ElkPortWithKind`. ELK ignores fields it doesn't know about while laying out,
// and the React Flow mapping step reads them back without resolving items again.
type KindOf = (itemId: ItemId) => TransportKindId | undefined;

function makePort(
  id: string,
  side: "WEST" | "EAST",
  index: number,
  itemId: ItemId,
  kindOf: KindOf,
): ElkPortWithKind {
  const port: ElkPortWithKind = {
    id,
    width: PORT_WIDTH,
    height: PORT_HEIGHT,
    layoutOptions: {
      "org.eclipse.elk.port.side": side,
      "org.eclipse.elk.port.index": String(index),
    },
  };
  const kind = kindOf(itemId);
  if (kind !== undefined) port.transportKind = kind;
  return port;
}

// Ports are emitted in recipe.in / recipe.out declaration order here; under
// FIXED_SIDE ELK is free to reorder them within each side to minimize crossings,
// so declaration order is only the starting point. We never set port.y. On the
// React side the Handle takes its visual top offset from
// `measureRecipe(recipe).inHandleYs[i] / outHandleYs[i]`, indexed by the
// resolved slot i, and the row at slot i shows whichever item resolvePortOrders
// assigned to that slot. The lockstep guarantee between layout and rendering is
// therefore about the outer box and the resolved per-side order, not the
// absolute per-port y that ELK reports.
function buildRecipePorts(
  unitId: string,
  recipe: Recipe,
  kindOf: KindOf,
): ElkPortWithKind[] {
  return [
    ...recipe.in.map((p, i) =>
      makePort(`${unitId}.in:${p.item}`, "WEST", i, p.item, kindOf),
    ),
    ...recipe.out.map((p, i) =>
      makePort(`${unitId}.out:${p.item}`, "EAST", i, p.item, kindOf),
    ),
  ];
}

function recipeUnitToElk(
  u: RenderUnitRecipe,
  recipe: Recipe,
  kindOf: KindOf,
): ElkNode {
  const geom = measureRecipe(recipe);
  return {
    id: u.id,
    width: geom.width,
    height: geom.height,
    layoutOptions: { ...RECIPE_LAYOUT_OPTIONS },
    ports: buildRecipePorts(u.id, recipe, kindOf),
  };
}

function inputProductUnitToElk(
  u: RenderUnitInputProduct,
  kindOf: KindOf,
): ElkNode {
  // Aggregate and single-bucket input products sit on the leftmost layer with a
  // single source port on the east side. Fanout slices skip the FIRST-layer
  // constraint so ELK can drop each one near its consumers, and they add a sink
  // port on the west side to receive the edge from the aggregate.
  //
  // So the input products fall into three tiers:
  //   - Aggregate (isAggregate): FIRST_SEPARATE, its own layer ahead of FIRST,
  //     so the aggregate -> fanout edge is a valid forward edge into FIRST or
  //     beyond. ELK does not support a FIRST-to-FIRST edge.
  //   - Fanout slice (isFanout): unconstrained, so ELK barycenters each slice
  //     (per-container or per-consumer tap) next to the consumers it feeds
  //     instead of pinning it beside the aggregate. This collapses the long
  //     boundary-supply edges.
  //   - Single-bucket input (neither isFanout nor isAggregate): FIRST, the older
  //     placement for items with one bucket or no fanouts at all.
  let layoutOptions: ElkNode["layoutOptions"];
  if (u.isAggregate) {
    layoutOptions = {
      ...RECIPE_LAYOUT_OPTIONS,
      [ELK_LAYER_CONSTRAINT_KEY]: ELK_LAYER_FIRST_SEPARATE,
    };
  } else if (!u.isFanout) {
    layoutOptions = {
      ...RECIPE_LAYOUT_OPTIONS,
      [ELK_LAYER_CONSTRAINT_KEY]: ELK_LAYER_FIRST,
    };
  } else {
    layoutOptions = { ...RECIPE_LAYOUT_OPTIONS };
  }
  const ports = u.isFanout
    ? [
        productPort(u.id, "in", u.itemId, 0, kindOf),
        productPort(u.id, "out", u.itemId, 0, kindOf),
      ]
    : [productPort(u.id, "out", u.itemId, 0, kindOf)];
  return {
    id: u.id,
    width: PRODUCT_WIDTH,
    height: PRODUCT_HEIGHT,
    layoutOptions,
    ports,
  };
}

function outputProductUnitToElk(
  u: RenderUnitOutputProduct,
  kindOf: KindOf,
): ElkNode {
  // Output products sit on the rightmost layer with a single sink port on the
  // west (left) side. Edges from upstream producers target `in:<item>`.
  return {
    id: u.id,
    width: PRODUCT_WIDTH,
    height: PRODUCT_HEIGHT,
    layoutOptions: {
      ...RECIPE_LAYOUT_OPTIONS,
      [ELK_LAYER_CONSTRAINT_KEY]: ELK_LAYER_LAST,
    },
    ports: [productPort(u.id, "in", u.itemId, 0, kindOf)],
  };
}

function productPort(
  unitId: string,
  direction: "in" | "out",
  item: ItemId,
  index: number,
  kindOf: KindOf,
): ElkPortWithKind {
  return makePort(
    `${unitId}.${direction}:${item}`,
    direction === "in" ? "WEST" : "EAST",
    index,
    item,
    kindOf,
  );
}

function loopUnitToElk(
  u: RenderUnitLoop,
  interior: LoopInteriorSize,
  kindOf: KindOf,
): ElkNode {
  const { width, height } = loopBoxDimensions(interior);
  const ins = u.netIO.filter((p) => p.direction === "in");
  const outs = u.netIO.filter((p) => p.direction === "out");
  return {
    id: u.id,
    width,
    height,
    layoutOptions: { ...RECIPE_LAYOUT_OPTIONS },
    ports: [
      ...ins.map((p, i) =>
        makePort(`${u.id}.in:${p.item}`, "WEST", i, p.item, kindOf),
      ),
      ...outs.map((p, i) =>
        makePort(`${u.id}.out:${p.item}`, "EAST", i, p.item, kindOf),
      ),
    ],
  };
}

function renderEdgeToElk(e: RenderEdge, index: number): ElkExtendedEdge {
  return {
    id: `e:${index}:${e.fromUnit}->${e.toUnit}:${e.item}`,
    sources: [`${e.fromUnit}.out:${e.item}`],
    targets: [`${e.toUnit}.in:${e.item}`],
  };
}

// fromElkRenderLayout: turn the laid-out ELK graph back into React Flow data.

export function fromElkRenderLayout(
  laid: ElkGraph,
  input: LayoutInput,
): { nodes: RFAnyNode[]; edges: RFEdge[] } {
  const { plan, recipeById } = input;
  const interiorByLoopId =
    input.interiorByLoopId ?? new Map<SccId, LoopInteriorSize>();

  const unitById = new Map<string, RenderUnit>();
  for (const u of plan.units) unitById.set(u.id, u);
  const containerById = new Map<ContainerId, Container>();
  for (const c of plan.containers) containerById.set(c.id, c);

  const nodes: RFAnyNode[] = [];

  for (const top of laid.children ?? []) {
    const container = containerById.get(top.id);
    if (container) {
      const w = top.width ?? 0;
      const h = top.height ?? 0;
      const memberCount = (top.children ?? []).filter((child) =>
        unitById.has(child.id),
      ).length;
      nodes.push({
        id: container.id,
        type: "group",
        position: { x: top.x ?? 0, y: top.y ?? 0 },
        data: {
          containerKind: container.kind,
          containerId: container.id,
          memberCount,
        },
        // Group bounding boxes carry their size both as top-level width/height
        // (what React Flow checks to treat the node as initialized) and on style.
        width: w,
        height: h,
        style: { width: w, height: h },
      } satisfies RFContainerNode);
      for (const child of top.children ?? []) {
        const childUnit = unitById.get(child.id);
        if (!childUnit) continue;
        nodes.push(
          unitToRFNode(
            child,
            childUnit,
            container.id,
            recipeById,
            interiorByLoopId,
          ),
        );
      }
    } else {
      const unit = unitById.get(top.id);
      if (!unit) continue;
      nodes.push(
        unitToRFNode(top, unit, undefined, recipeById, interiorByLoopId),
      );
    }
  }

  // Attach each RenderEdge's data to its ELK edge so ItemEdge can label it.
  // renderEdgeToElk builds the ELK id from the RenderEdge index, so we recover
  // the RenderEdge by parsing that index back out of the id. The raw item id
  // rides along on the edge, and ItemEdge translates it through useI18n at render
  // time, which means a locale switch never forces a relayout.
  const edges: RFEdge[] = (laid.edges ?? []).map((e) => {
    const [sourceNode, sourcePort] = splitPortRef(e.sources[0]!);
    const [targetNode, targetPort] = splitPortRef(e.targets[0]!);
    const idx = parseElkEdgeIndex(e.id);
    const renderEdge = idx !== null ? plan.edges[idx] : undefined;
    const itemId = renderEdge?.item ?? portToItem(sourcePort);
    const rate = renderEdge?.rate ?? new Fraction(0);
    const edgeData: {
      item: ItemId;
      rate: Fraction;
      transportKind?: TransportKindId;
      labelSide?: "source" | "target";
      multiInputTarget?: true;
    } = {
      item: itemId,
      rate,
    };
    if (renderEdge?.transportKind !== undefined) {
      edgeData.transportKind = renderEdge.transportKind;
    }
    if (renderEdge?.labelSide !== undefined) {
      edgeData.labelSide = renderEdge.labelSide;
    }
    // Flag edges whose consumer takes two or more inputs so ItemEdge can pin an
    // icon-only identity chip at the target port. The edge itself does not know
    // the consumer's in-degree, so we resolve it here from the target unit.
    // Bus members: every edge is still type "item" at this point; routeBusEdges
    // runs later (in layoutRenderPlan) and retypes long / boundary-feeder edges
    // to type "bus", which BusEdge renders. BusEdge's rise chip already sits
    // near the target, so a multiInputTarget flag left on a bus member is inert
    // (ItemEdge is the only reader). Setting it uniformly here keeps this pass
    // free of any bus-classification dependency.
    const targetUnit = unitById.get(targetNode);
    if (targetUnit !== undefined && inputCountOf(targetUnit, recipeById) >= 2) {
      edgeData.multiInputTarget = true;
    }
    return {
      id: e.id,
      type: "item",
      source: sourceNode,
      target: targetNode,
      sourceHandle: sourcePort,
      targetHandle: targetPort,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: edgeData,
    };
  });

  return { nodes, edges };
}

// Build the per-node Handle-id -> TransportKindId map from a laid-out ELK node's
// ports. Handle ids drop the leading `<unitId>.` prefix and read like
// "in:copper_ore" or "out:copper_powder", the same shape the node components use
// when they build `<Handle id={...} />`.
function portKindsFromElkNode(node: ElkNode): PortTransportKinds {
  const out = new Map<string, TransportKindId>();
  for (const p of node.ports ?? []) {
    const kind = (p as ElkPortWithKind).transportKind;
    if (kind === undefined) continue;
    const id = p.id ?? "";
    const dot = id.indexOf(".");
    const handleId = dot >= 0 ? id.slice(dot + 1) : id;
    out.set(handleId, kind);
  }
  return out;
}

// Read the ELK-resolved per-side port order back off a laid-out node. Under
// FIXED_SIDE ELK assigns each port a y within the node (relative to the node
// origin) that reflects the crossing-minimized order it chose; sorting the west
// ports by that y gives the top-to-bottom input order, and likewise for the east
// outputs. The item id is recovered from the port id ("<unitId>.in:<item>" ->
// "<item>"); ports whose id is neither ".in:" nor ".out:" are ignored.
//
// Ports without a numeric y (synthetic ELK graphs in unit tests never run the
// real layout, so their ports keep no coordinates) fall back to y=0, which makes
// the sort stable and preserves the emitted declaration order. That keeps the
// resolved order equal to declaration order on those paths.
function resolvePortOrders(node: ElkNode): {
  inputOrder: ItemId[];
  outputOrder: ItemId[];
} {
  const ins: { item: ItemId; y: number }[] = [];
  const outs: { item: ItemId; y: number }[] = [];
  for (const p of node.ports ?? []) {
    const id = p.id ?? "";
    const dot = id.indexOf(".");
    const handleId = dot >= 0 ? id.slice(dot + 1) : id;
    const y = typeof p.y === "number" ? p.y : 0;
    if (handleId.startsWith("in:")) {
      ins.push({ item: handleId.slice("in:".length), y });
    } else if (handleId.startsWith("out:")) {
      outs.push({ item: handleId.slice("out:".length), y });
    }
  }
  ins.sort((a, b) => a.y - b.y);
  outs.sort((a, b) => a.y - b.y);
  return {
    inputOrder: ins.map((e) => e.item),
    outputOrder: outs.map((e) => e.item),
  };
}

function parseElkEdgeIndex(id: string): number | null {
  // renderEdgeToElk writes ids shaped like "e:<index>:<from>-><to>:<item>".
  if (!id.startsWith("e:")) return null;
  const rest = id.slice(2);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const n = Number.parseInt(rest.slice(0, colon), 10);
  return Number.isFinite(n) ? n : null;
}

function portToItem(port: string): string {
  if (port.startsWith("out:")) return port.slice("out:".length);
  if (port.startsWith("in:")) return port.slice("in:".length);
  return port;
}

// Number of distinct inputs a unit consumes, used to decide whether its
// entering edges get an identity chip. Recipe units count their recipe.in
// ports; loop units count their net-IO "in" ports; product units are boundary
// sinks that never take two inputs, so they report zero.
function inputCountOf(
  unit: RenderUnit,
  recipeById: ReadonlyMap<RecipeId, Recipe>,
): number {
  switch (unit.kind) {
    case "recipe": {
      const recipe = recipeById.get(unit.recipeId);
      return recipe ? recipe.in.length : 0;
    }
    case "loop":
      return unit.netIO.filter((p) => p.direction === "in").length;
    case "inputProduct":
    case "outputProduct":
      return 0;
  }
}

function unitToRFNode(
  laidChild: ElkNode,
  unit: RenderUnit,
  parentId: ContainerId | undefined,
  recipeById: ReadonlyMap<RecipeId, Recipe>,
  interiorByLoopId: ReadonlyMap<SccId, LoopInteriorSize>,
): RFAnyNode {
  const position = { x: laidChild.x ?? 0, y: laidChild.y ?? 0 };
  const base = parentId !== undefined ? { position, parentId } : { position };
  const portTransportKinds = portKindsFromElkNode(laidChild);

  switch (unit.kind) {
    case "recipe": {
      const recipe = requireRecipe(recipeById, unit.recipeId);
      const { inputOrder, outputOrder } = resolvePortOrders(laidChild);
      return {
        id: unit.id,
        type: "recipe",
        ...base,
        data: {
          recipe,
          kind: "recipe",
          portTransportKinds,
          multiplicity: unit.multiplicity,
          inputOrder,
          outputOrder,
        },
      } satisfies RFRecipeNode;
    }
    case "loop": {
      const interior =
        interiorByLoopId.get(unit.sccId) ?? DEFAULT_LOOP_INTERIOR;
      const { inputOrder, outputOrder } = resolvePortOrders(laidChild);
      return {
        id: unit.id,
        type: "loop",
        ...base,
        data: {
          sccId: unit.sccId,
          netIO: unit.netIO,
          interior,
          portTransportKinds,
          inputOrder,
          outputOrder,
        },
      } satisfies RFLoopNode;
    }
    case "inputProduct": {
      const data: RFProductNode["data"] = {
        kind: "inputProduct",
        itemId: unit.itemId,
        rate: unit.rate,
        portTransportKinds,
        ...(unit.rateCap !== undefined ? { rateCap: unit.rateCap } : {}),
        ...(unit.isFanout ? { isFanout: true } : {}),
      };
      return {
        id: unit.id,
        type: "product",
        ...base,
        width: laidChild.width ?? PRODUCT_WIDTH,
        height: laidChild.height ?? PRODUCT_HEIGHT,
        data,
      } satisfies RFProductNode;
    }
    case "outputProduct": {
      return {
        id: unit.id,
        type: "product",
        ...base,
        width: laidChild.width ?? PRODUCT_WIDTH,
        height: laidChild.height ?? PRODUCT_HEIGHT,
        data: {
          kind: "outputProduct",
          itemId: unit.itemId,
          rate: unit.rate,
          flavor: unit.flavor,
          portTransportKinds,
        },
      } satisfies RFProductNode;
    }
  }
}

function splitPortRef(ref: string): [string, string] {
  // ELK port refs look like <nodeId>.<portId>, and portId can itself contain a
  // ':' (for example 'out:copper_nugget').
  const dot = ref.indexOf(".");
  if (dot === -1) return [ref, ""];
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}

// layoutRenderPlan: one elk.layout() call per cycle.

const elk = new ELK();

export async function layoutRenderPlan(input: LayoutInput): Promise<{
  nodes: RFAnyNode[];
  edges: RFEdge[];
}> {
  const elkGraph = renderPlanToElkGraph(input);
  const laid = (await elk.layout(elkGraph)) as ElkGraph;
  const { nodes, edges } = fromElkRenderLayout(laid, input);
  // Post-layout routing passes, in order (each consumes the previous ones'
  // stamps; final absolute node positions are known here):
  //   1. routeBusEdges       classify long / boundary-feeder edges into bus
  //                          trunks, each on a lane in a top or bottom band.
  //   2. assignEntryColumns  stake out per-target entry-gutter columns so
  //                          backward rails and bus rises into one node stay
  //                          parallel.
  //   3. clearBusColumns     move bus drop / rise verticals clear of any foreign
  //                          card / gutter (starts from the entry stagger).
  //   4. assignBendColumns   stagger the remaining item edges' bend columns so
  //                          their verticals fan out (clamped clear of gutters).
  //   5. jogForwardLegs      bend a blocked forward final leg to a clear y so it
  //                          does not cross an intervening card (reads bendX).
  //   6. clampBackwardRails  move the backward detour rails clear of the cards
  //                          they span.
  //   7. deconflictChipAnchors stack crowded chips (entry, bus, midpoint) so
  //                          none coincide.
  return {
    nodes,
    edges: deconflictChipAnchors(
      nodes,
      clampBackwardRails(
        nodes,
        jogForwardLegs(
          nodes,
          assignBendColumns(
            nodes,
            clearBusColumns(
              nodes,
              assignEntryColumns(nodes, routeBusEdges(nodes, edges)),
            ),
          ),
        ),
      ),
    ),
  };
}
