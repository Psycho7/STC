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
// still create LogicalGraph instances, which feed renderPlanFromSolve before
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
  jogForwardLegs,
  routeBusEdges,
  routeFanoutEdges,
} from "./busRouting";
import { deconflictChipAnchors } from "./chipSeating";
// Type-only: ItemEdge.tsx declares the canvas edge payload this module stamps.
// Erased at compile time, so it adds no runtime or bundler edge, and ItemEdge
// imports none of layout / busRouting / chipSeating, so there is no cycle.
import type { ItemEdgeData } from "./ItemEdge";
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
// (`renderPlanFromSolve`). They live in this file because the canvas is what reads
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

export type LogicalGroupNode = {
  kind: "group";
  id: GroupId;
  label: string;
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
  // When explicitly false, routeBusEdges and routeFanoutEdges are skipped so
  // every edge renders as a plain item edge. Absent or true runs both passes.
  busLanesEnabled?: boolean;
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
// arrival-sorted INPUT port order comes from: ELK reorders the west ports so the
// entering edges approach in parallel instead of braiding in front of the node.
// The resolved order is read back after layout in resolveInputOrder and handed
// to the node components as inputOrder. The OUTPUT side deliberately keeps no
// stamped order (ruling R4): output rows read in the recipe's own declared
// order, so two cards of one recipe read alike; ELK still crossing-minimises
// the east ports internally, but nothing downstream reads that order back.
//
// Do NOT flip this to FIXED_ORDER to force the output order: elk.port.index is
// a per-side index that ELK reads as a whole-node sequence, so FIXED_ORDER
// would also freeze the west ports and break the crossing-free input order.
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
// `inputOrder` carries the ELK-resolved west port order (the item id of each
// input port, top to bottom). The node components render their input rows,
// Handles and glyphs in this order so the y-slot of each entering edge lines up
// with its arrival, instead of the recipe's declaration order. There is no
// output counterpart (ruling R4): output rows read in the recipe's own declared
// order on every card. Optional: paths that build a node without a laid-out ELK
// graph (older fixtures and tests) omit inputOrder, and the component falls
// back to declaration order.
export type RFRecipeNode = RFNode<
  {
    recipe: Recipe;
    kind: "recipe";
    portTransportKinds: PortTransportKinds;
    multiplicity: RationalString;
    inputOrder?: ItemId[];
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
  },
  "loop"
>;
export type RFContainerNode = RFNode<
  {
    containerKind: Container["kind"];
    containerId: ContainerId;
    memberCount: number;
    // Primary output of each member recipe, deduped in plan order. The caption
    // resolves these ids to names at render time, so switching locale never
    // forces a relayout. Absent when no member resolves to a recipe.
    titleItems?: ItemId[];
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
        // Slab interiors do not inherit the root spacing pair: without these
        // the members pack at ELK's default spacing (~36 measured) and the
        // corridor cannot hold a rate chip (chips are ~99-110 units wide), so
        // every chip in a slab buries its own endpoint card. Mirror the root
        // values so a slab corridor equals an open-layout corridor.
        "elk.spacing.nodeNode": String(NODE_NODE_SPACING),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(
          BETWEEN_LAYERS_SPACING,
        ),
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
// resolved slot i. An input slot comes from the ELK-resolved inputOrder; an
// output slot is the declaration index (ruling R4: output rows read in the
// recipe's declared order, so no ELK output order is read back). The lockstep
// guarantee between layout and rendering is therefore about the outer box and
// those per-side slot assignments, not the absolute per-port y ELK reports.
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

  // Caption items per container: the primary output of each member recipe,
  // deduped and in plan order (not ELK child order, which layout may permute).
  const titleItemsByContainer = new Map<ContainerId, ItemId[]>();
  for (const u of plan.units) {
    if (u.kind !== "recipe" || u.containerId === undefined) continue;
    const item = recipeById.get(u.recipeId)?.out[0]?.item;
    if (item === undefined) continue;
    const items = titleItemsByContainer.get(u.containerId) ?? [];
    if (!items.includes(item)) items.push(item);
    titleItemsByContainer.set(u.containerId, items);
  }

  const nodes: RFAnyNode[] = [];

  for (const top of laid.children ?? []) {
    const container = containerById.get(top.id);
    if (container) {
      const w = top.width ?? 0;
      const h = top.height ?? 0;
      const memberCount = (top.children ?? []).filter((child) =>
        unitById.has(child.id),
      ).length;
      const titleItems = titleItemsByContainer.get(container.id);
      nodes.push({
        id: container.id,
        type: "group",
        position: { x: top.x ?? 0, y: top.y ?? 0 },
        data: {
          containerKind: container.kind,
          containerId: container.id,
          memberCount,
          ...(titleItems !== undefined && titleItems.length > 0
            ? { titleItems }
            : {}),
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
    const edgeData: ItemEdgeData = {
      item: itemId,
      rate,
    };
    if (renderEdge?.transportKind !== undefined) {
      edgeData.transportKind = renderEdge.transportKind;
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

// Read the ELK-resolved west port order back off a laid-out node. Under
// FIXED_SIDE ELK assigns each port a y within the node (relative to the node
// origin) that reflects the crossing-minimized order it chose; sorting the west
// ports by that y gives the top-to-bottom input order. The item id is recovered
// from the port id ("<unitId>.in:<item>" -> "<item>"); ports whose id is not
// ".in:" are ignored -- the east ports are skipped on purpose (ruling R4:
// output rows read in the recipe's own declared order, so no ELK output order
// exists to read back).
//
// Ports without a numeric y (synthetic ELK graphs in unit tests never run the
// real layout, so their ports keep no coordinates) fall back to y=0, which makes
// the sort stable and preserves the emitted declaration order. That keeps the
// resolved order equal to declaration order on those paths.
function resolveInputOrder(node: ElkNode): {
  inputOrder: ItemId[];
} {
  const ins: { item: ItemId; y: number }[] = [];
  for (const p of node.ports ?? []) {
    const id = p.id ?? "";
    const dot = id.indexOf(".");
    const handleId = dot >= 0 ? id.slice(dot + 1) : id;
    const y = typeof p.y === "number" ? p.y : 0;
    if (handleId.startsWith("in:")) {
      ins.push({ item: handleId.slice("in:".length), y });
    }
  }
  ins.sort((a, b) => a.y - b.y);
  return {
    inputOrder: ins.map((e) => e.item),
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
      const { inputOrder } = resolveInputOrder(laidChild);
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
        },
      } satisfies RFRecipeNode;
    }
    case "loop": {
      const interior =
        interiorByLoopId.get(unit.sccId) ?? DEFAULT_LOOP_INTERIOR;
      const { inputOrder } = resolveInputOrder(laidChild);
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
        ...(unit.parentRate !== undefined
          ? { parentRate: unit.parentRate }
          : {}),
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

// One post-layout routing pass: nodes in their final absolute positions plus the
// edges so far, and a new edge array out. Passes are pure -- they never mutate
// the inputs or the input edges' `data` -- and an empty edge array is legal, on
// which every pass is a no-op. No pass throws; an unrecognised or unstamped edge
// passes through unchanged.
export type RoutingPass = (
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<RFEdge>,
) => RFEdge[];

// The post-layout routing passes, in the order layoutRenderPlan runs them.
// ARRAY ORDER IS THE CONTRACT: each entry consumes the stamps every earlier
// entry left. Nothing makes a reorder a compile error -- all eight passes share
// one signature -- so the order is pinned by test/canvas/layout-pass-order.test.ts
// instead, and reordering these entries silently changes routing geometry.
export const ROUTING_PASSES: ReadonlyArray<{
  readonly name: string;
  readonly run: RoutingPass;
}> = [
  // Classify long-span edges into bus trunks, each on a lane in a top or
  // bottom band.
  { name: "routeBusEdges", run: routeBusEdges },
  // Consolidate N >= 2 same-source-port edges in one layer gap onto a shared
  // junction column (a fan-out trunk, retyped bus but off-lane).
  { name: "routeFanoutEdges", run: routeFanoutEdges },
  // Stake out per-target entry-gutter columns so backward rails and bus rises
  // into one node stay parallel.
  { name: "assignEntryColumns", run: assignEntryColumns },
  // Move bus drop / rise verticals clear of any foreign card / gutter (starts
  // from the entry stagger).
  { name: "clearBusColumns", run: clearBusColumns },
  // Stagger the remaining item edges' bend columns so their verticals fan out
  // (clamped clear of gutters).
  { name: "assignBendColumns", run: assignBendColumns },
  // Bend a blocked forward final leg to a clear y so it does not cross an
  // intervening card (reads bendX).
  { name: "jogForwardLegs", run: jogForwardLegs },
  // Move the backward detour rails clear of the cards they span.
  { name: "clampBackwardRails", run: clampBackwardRails },
  // Stack crowded chips (entry, bus, midpoint) so none coincide.
  { name: "deconflictChipAnchors", run: deconflictChipAnchors },
];

// layoutRenderPlan: one elk.layout() call per cycle.

const elk = new ELK();

export async function layoutRenderPlan(input: LayoutInput): Promise<{
  nodes: RFAnyNode[];
  edges: RFEdge[];
}> {
  const elkGraph = renderPlanToElkGraph(input);
  const laid = (await elk.layout(elkGraph)) as ElkGraph;
  const { nodes, edges } = fromElkRenderLayout(laid, input);
  // With bus lanes off, drop the two passes that stamp bus formations; the
  // remaining passes are no-ops on unstamped edges, so no other change is
  // needed. Matched by function identity so a pass rename cannot silently
  // defeat the filter.
  const passes =
    input.busLanesEnabled === false
      ? ROUTING_PASSES.filter(
          (p) => p.run !== routeBusEdges && p.run !== routeFanoutEdges,
        )
      : ROUTING_PASSES;
  // Left fold over the passes: every pass sees the SAME nodes array
  // fromElkRenderLayout returned (final absolute positions), never a re-derived
  // one, plus the previous pass's output edges.
  return {
    nodes,
    edges: passes.reduce<RFEdge[]>((routed, pass) => pass.run(nodes, routed), edges),
  };
}
