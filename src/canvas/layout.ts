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
  PRODUCT_HEIGHT,
  PRODUCT_WIDTH,
  loopBoxDimensions,
} from "./dimensions";
import { measureRecipe } from "./recipeGeometry";
import {
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  jogForwardLegs,
  parseElkEdgeIndex,
  routeTrunkEdges,
} from "./busRouting";
import { deconflictChipAnchors } from "./chipSeating";
import { widenLayerGaps, type GapRecord } from "./layerModel";
import { buildGapColumnOrder, type GapColumnOrder } from "./gapColumnOrder";
// Type-only: ItemEdge.tsx declares the canvas edge payload this module stamps.
// Erased at compile time, so it adds no runtime or bundler edge, and ItemEdge
// imports none of layout / busRouting / chipSeating, so there is no cycle.
import type { ItemEdgeData } from "./ItemEdge";
import type { LoopNodeData } from "./LoopNode";
import type { ProductNodeData } from "./ProductNode";
import type { RecipeNodeData } from "./RecipeNode";
import type {
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
import type { RawRecipeMap } from "../solver/net-self";
import type { CatalystAccount } from "../solver/catalyst";
import { rationalToString } from "../pipeline/render/rational";
import { itemOfPort, parsePort, portId } from "../pipeline/render/port-ids";
import { pushInto } from "../util/multimap";
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
  // The RAW pack's stoichiometry: every node row is drawn from it. The
  // RawRecipeMap brand rejects the solve's own netted map, which would drop
  // the self-consumed input rows the player has to loop back by hand.
  recipeById: RawRecipeMap;
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
  // Run the gap-widening pre-pass? Defaults to true. False lays the plan out on
  // ELK's own gaps, which is the before side of the width census.
  widenGaps?: boolean;
  // Which supply pool each item's catalyst charge was billed to, straight off
  // the solve. Geometry never reads it: it rides onto the aggregate or
  // single-bucket catalyst card as tooltip copy. Absent in the fixtures that
  // lay a plan out without solving one.
  catalystAccount?: CatalystAccount;
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
  // No node is compound (loop members sit at the root, see
  // renderPlanToElkGraph), yet the mode still decides how ELK breaks cycles:
  // without it ELK reverses the other edge of each planter 2-cycle, and on
  // multi6 the return rail's stub then pierces four foreign cards.
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
  // Greedy-switch refinement after the layer sweep. Under INCLUDE_CHILDREN ELK
  // reads only the hierarchical variant, which defaults to OFF, so without this
  // the sweep's local minimum stands. On gas-web that left the twin Solid-Gas
  // -> Packaging -> Purification chains stacked crosswise (two X crossings).
  "org.eclipse.elk.layered.crossingMinimization.greedySwitchHierarchical.type":
    "TWO_SIDED",
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
export const ELK_LAYER_LAST = "LAST";

// Per-port transport-kind lookup attached to every render-pipeline RF node.
// Keys are the React Flow Handle ids (for example "in:copper_ore" or
// "out:copper_powder"), and values are the item's transportKind resolved while
// laying out. If the input never supplied it, this map is empty and the node
// draws no port glyphs.
export type PortTransportKinds = ReadonlyMap<string, TransportKindId>;

// React Flow node typings for the pipeline. Each card's data shape is declared
// once, beside the component that renders it, with the optionality older
// fixtures and tests build against; the production paths always provide
// `portTransportKinds` and `inputOrder` through `unitToRFNode`.
export type RFRecipeNode = RFNode<RecipeNodeData, "recipe">;
export type RFLoopNode = RFNode<LoopNodeData, "loop">;
// Which pool covered an item's catalyst charge, for the card's name tooltip.
// Item-level accounting, carried on the item's one catalyst card.
export type CatalystBreakdown = {
  fromCatalyst: RationalString;
  fromGeneral: RationalString;
  unmet: RationalString;
};

export type RFProductNode = RFNode<ProductNodeData, "product">;

export type RFAnyNode = RFRecipeNode | RFLoopNode | RFProductNode;

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
    pushInto(unitsByContainer, key, u);
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

  // A container is no ELK node: its members go to the root as ordinary cards,
  // container by container and ahead of the standalone units, the order ELK
  // got them in when each container was a compound node. The loop is marked
  // after routing by a paint nothing lays out or routes around (loopPaint.ts).
  for (const container of plan.containers) {
    const members = unitsByContainer.get(container.id) ?? [];
    rootChildren.push(...members.map(unitToElk));
  }

  // Then the standalone units (no containerId), in plan order.
  for (const u of unitsByContainer.get("__root__") ?? []) {
    rootChildren.push(unitToElk(u));
  }

  const elkEdges: ElkExtendedEdge[] = plan.edges.map((e, i) =>
    renderEdgeToElk(e, i),
  );

  return {
    id: "root",
    layoutOptions: ROOT_LAYOUT_OPTIONS,
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
// so declaration order is only the starting point. No port carries coordinates:
// every node box IS the card box, and elkjs recomputes whatever we hand it
// anyway. On the React side the Handle takes its visual top offset from
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
      makePort(`${unitId}.${portId("in", p.item)}`, "WEST", i, p.item, kindOf),
    ),
    // Catalyst rows take a WEST port too: their edge comes from the item's
    // catalyst boundary card, exactly like an input row's. The port id uses the
    // `cat:` namespace because a card can carry one item on both an input row
    // and a catalyst row.
    ...(recipe.catalyst ?? []).map((p, i) =>
      makePort(
        `${unitId}.${portId("cat", p.item)}`,
        "WEST",
        recipe.in.length + i,
        p.item,
        kindOf,
      ),
    ),
    ...recipe.out.map((p, i) =>
      makePort(`${unitId}.${portId("out", p.item)}`, "EAST", i, p.item, kindOf),
    ),
  ];
}

// Every recipe's ELK box is its CARD box. An environment recipe draws its
// plate as the card's first row (ruling I9), so measureRecipe already counts
// it and no box anywhere grows past what the DOM paints.
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
  // An input product sits on the leftmost layer with a single source port on
  // the east side.
  return {
    id: u.id,
    width: PRODUCT_WIDTH,
    height: PRODUCT_HEIGHT,
    layoutOptions: {
      ...RECIPE_LAYOUT_OPTIONS,
      [ELK_LAYER_CONSTRAINT_KEY]: ELK_LAYER_FIRST,
    },
    ports: [productPort(u.id, "out", u.itemId, 0, kindOf)],
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
    `${unitId}.${portId(direction, item)}`,
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
        makePort(`${u.id}.${portId("in", p.item)}`, "WEST", i, p.item, kindOf),
      ),
      ...outs.map((p, i) =>
        makePort(`${u.id}.${portId("out", p.item)}`, "EAST", i, p.item, kindOf),
      ),
    ],
  };
}

// A catalyst edge lands on the `cat:` port; every other edge on the `in:` port.
// The item alone cannot decide it: one card can carry both rows for one item.
function renderEdgeToElk(e: RenderEdge, index: number): ElkExtendedEdge {
  const targetPort = portId(e.toPortKind === "catalyst" ? "cat" : "in", e.item);
  return {
    id: `e:${index}:${e.fromUnit}->${e.toUnit}:${e.item}`,
    sources: [`${e.fromUnit}.${portId("out", e.item)}`],
    targets: [`${e.toUnit}.${targetPort}`],
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

  // Every laid-out child is a unit card at the root: the graph builder emits
  // no container node.
  const nodes: RFAnyNode[] = [];
  for (const top of laid.children ?? []) {
    const unit = unitById.get(top.id);
    if (!unit) continue;
    nodes.push(
      unitToRFNode(
        top,
        unit,
        recipeById,
        interiorByLoopId,
        input.catalystAccount,
      ),
    );
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
    const itemId = renderEdge?.item ?? itemOfPort(sourcePort);
    const rate = renderEdge?.rate ?? new Fraction(0);
    const edgeData: ItemEdgeData = {
      item: itemId,
      rate,
    };
    if (renderEdge?.transportKind !== undefined) {
      edgeData.transportKind = renderEdge.transportKind;
    }
    // The geometry readers resolve the target row by side, and this is the only
    // thing telling them the edge lands on a catalyst row.
    if (renderEdge?.toPortKind !== undefined) {
      edgeData.toPortKind = renderEdge.toPortKind;
    }
    // The pool the edge leaves, which is what the ticked catalyst stroke reads.
    if (renderEdge?.fromPool !== undefined) {
      edgeData.fromPool = renderEdge.fromPool;
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
// "in:copper_ore", "cat:gas_xiranite" or "out:copper_powder", the same shape the
// node components use when they build `<Handle id={...} />`.
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
// exists to read back), and so are the west `cat:` ports, whose rows are pinned
// below every input row and never take part in the input ordering.
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
    const port = parsePort(handleId);
    if (port?.side === "in") {
      ins.push({ item: port.item, y });
    }
  }
  ins.sort((a, b) => a.y - b.y);
  return {
    inputOrder: ins.map((e) => e.item),
  };
}

// The catalyst pool split for one input card, in the spread-in shape the
// product data uses for its other optional fields.
//
// The account is item-level, and so is the split: the item's one catalyst card
// carries it.
function catalystBreakdownOf(
  unit: RenderUnitInputProduct,
  catalystAccount: CatalystAccount | undefined,
): Pick<
  Extract<RFProductNode["data"], { kind: "inputProduct" }>,
  "catalystBreakdown"
> {
  if (unit.role !== "catalyst") return {};
  const entry = catalystAccount?.get(unit.itemId);
  if (entry === undefined) return {};
  return {
    catalystBreakdown: {
      fromCatalyst: rationalToString(entry.fromCatalyst),
      fromGeneral: rationalToString(entry.fromGeneral),
      unmet: rationalToString(entry.unmet),
    },
  };
}

function unitToRFNode(
  laidChild: ElkNode,
  unit: RenderUnit,
  recipeById: ReadonlyMap<RecipeId, Recipe>,
  interiorByLoopId: ReadonlyMap<SccId, LoopInteriorSize>,
  catalystAccount: CatalystAccount | undefined,
): RFAnyNode {
  // Every ELK box is the card box, so ELK's top-left IS the card's.
  const position = { x: laidChild.x ?? 0, y: laidChild.y ?? 0 };
  const base = { position };
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
        ...(unit.role !== undefined ? { role: unit.role } : {}),
        ...catalystBreakdownOf(unit, catalystAccount),
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
  ctx?: RoutingCtx,
) => RFEdge[];

// What the layout hands every routing pass beside the nodes and edges: the gap
// records the pre-pass produced, so a pass that needs a corridor reads the zone
// it was widened for instead of re-deriving one from the node columns. Optional
// on the signature because every pass predating it ignores the argument.
//
// `order` is the one column order per gap (gapColumnOrder.ts), built from the
// same placement and the pre-pass edges before the first routing pass, so every
// column pass reads one order instead of a sort key of its own. A pass handed
// no order (a hand-built fixture) builds it from what it was given.
export type RoutingCtx = {
  readonly gaps: ReadonlyArray<GapRecord>;
  readonly order?: GapColumnOrder;
};

// The one pre-pass: it runs BEFORE every routing pass and is the only step that
// moves a node after ELK. It widens each inter-layer gap of the root graph (the
// only scope; there are no container interiors) to the chip reserves that gap
// owes, so every pass below routes through corridors that already have room for
// the chips they will carry. Pinned ahead of ROUTING_PASSES by
// test/canvas/layout-pass-order.test.ts.
export const LAYOUT_PREPASS: {
  readonly name: string;
  readonly run: typeof widenLayerGaps;
  readonly because: string;
} = {
  name: "widenLayerGaps",
  run: widenLayerGaps,
  because:
    "Consumes no stamp and produces no edge: it reads the ELK placement and " +
    "moves nodes. Every routing pass below reads the widened positions, so it " +
    "cannot run after any of them.",
};

// The post-layout routing passes, in the order layoutRenderPlan runs them.
// ARRAY ORDER IS THE CONTRACT: each entry consumes the stamps every earlier
// entry left. Nothing makes a reorder a compile error -- all six passes share
// one signature -- so the order is pinned by test/canvas/layout-pass-order.test.ts
// instead, and reordering these entries silently changes routing geometry.
// `because` says what each entry needs from the entries above it, so the reason
// for the order lives beside the order; the pass headers in busRouting.ts and
// chipSeating.ts point here rather than restating it.
export const ROUTING_PASSES: ReadonlyArray<{
  readonly name: string;
  readonly run: RoutingPass;
  readonly because: string;
}> = [
  // Put every trunk of the layer model -- fan-out and fan-in alike -- on one
  // shared junction column, taken from its gap's reserved column zone (members
  // reaching the neighbouring layer retyped bus, the ones further away pinned to
  // the same column, backward ones given it as their rail column).
  {
    name: "routeTrunkEdges",
    run: routeTrunkEdges,
    because:
      "Consumes no stamp: it reads the placed nodes and the pre-pass's gap " +
      'records alone. It writes the type: "bus" retype and the junction ' +
      "column every pass below keys on.",
  },
  // Stake out per-target entry-gutter columns so backward rails into one node
  // stay parallel.
  {
    name: "assignEntryColumns",
    run: assignEntryColumns,
    because:
      "Reads the bus retype from routeTrunkEdges, so a fan-out member is " +
      "excluded from its target's gutter columns and a fan-in member counts " +
      "as one, and the fan-in columns it must not seat a gutter column on. " +
      "Writes entryX.",
  },
  // Stagger the remaining item edges' bend columns so their verticals fan out
  // (clamped clear of gutters).
  {
    name: "assignBendColumns",
    run: assignBendColumns,
    because:
      'Reads the bus retype from routeTrunkEdges (it fans only still-"item" ' +
      "edges) and leaves the bendX routeTrunkEdges pinned on a far member " +
      "alone, plus the pre-pass's gap records, whose column zone is the " +
      "corridor it fans across. Writes bendX for everything else.",
  },
  // Bend a blocked forward final leg to a clear y so it does not cross an
  // intervening card, and hold the horizontal level floor between two forward
  // runs that share an x-corridor (reads bendX).
  {
    name: "jogForwardLegs",
    run: jogForwardLegs,
    because:
      "Reads each edge's FINAL bendX from assignBendColumns, because the leg " +
      "it jogs starts at that column, and the entry columns assignEntryColumns " +
      "already staked at the target, because a jog descent takes the next free " +
      "slot left of them. The level floor it also holds needs every forward " +
      "edge's drawn geometry, so it is the last pass that moves a forward run: " +
      "the bands it measures against are seeded from the three passes above " +
      "and refreshed as it goes.",
  },
  // Move the backward detour rails clear of the cards they span.
  {
    name: "clampBackwardRails",
    run: clampBackwardRails,
    because:
      "Reads entryX from assignEntryColumns, which fixes the rail's left end " +
      "before the rail level is clamped, and the rail columns routeTrunkEdges " +
      "pre-stamped on a trunk's backward members, which it keeps as given. " +
      "It also rescans each rail against the forward runs jogForwardLegs " +
      "leaves behind, so it must run after that pass: a rail yields to a " +
      "forward run, and only there are those runs final.",
  },
  // Stack crowded chips (entry, bus, midpoint) so none coincide.
  {
    name: "deconflictChipAnchors",
    run: deconflictChipAnchors,
    because:
      "Reads every stamp above (entryX, junctionX, bendX, legY, railY) to " +
      "reconstruct the drawn polylines a chip must avoid, so it can only run " +
      "once they are final.",
  },
];

// The drag-stop replay: the same left fold layoutRenderPlan's tail runs, over
// live node positions and the stored post-ELK, pre-pass edges. App keeps the
// pristine array beside `gaps` for exactly this call (ruling R1: a drop re-runs
// the routing passes; nothing re-routes per frame). Replaying from baseEdges
// rather than the routed edges avoids having to un-stamp the hint keys and
// un-retype bus edges, and cannot drift from a fresh layout. Because
// deconflictChipAnchors is the last entry of ROUTING_PASSES, chips, junction
// dots and crossing cues re-seat on the fresh route in the same call.
export function rerouteEdges(
  nodes: ReadonlyArray<RFAnyNode>,
  baseEdges: RFEdge[],
  ctx?: RoutingCtx,
): RFEdge[] {
  // Left fold over the passes: every pass sees the SAME nodes array, never a
  // re-derived one, plus the previous pass's output edges.
  // The column order is built once per fold, after the gaps are final and
  // before the first pass, so a drag-stop replay rebuilds it too.
  const routing: RoutingCtx = {
    gaps: ctx?.gaps ?? [],
    order: buildGapColumnOrder(nodes, baseEdges, ctx?.gaps ?? []),
  };
  return ROUTING_PASSES.reduce<RFEdge[]>(
    (routed, pass) => pass.run(nodes, routed, routing),
    baseEdges,
  );
}

// layoutRenderPlan: one elk.layout() call per cycle.

const elk = new ELK();

export async function layoutRenderPlan(input: LayoutInput): Promise<{
  nodes: RFAnyNode[];
  edges: RFEdge[];
  gaps: ReadonlyArray<GapRecord>;
  // Post-ELK, pre-pass, pre-retype: the array the routing fold starts from,
  // handed back so App can store it and replay the fold at drag-stop (see
  // rerouteEdges).
  baseEdges: RFEdge[];
}> {
  const elkGraph = renderPlanToElkGraph(input);
  const laid = (await elk.layout(elkGraph)) as ElkGraph;
  const placed = fromElkRenderLayout(laid, input);
  // Gap widening first, so the passes below see the final positions. With the
  // pre-pass switched off the nodes stay exactly where ELK put them and there
  // are no gap records to read -- the census measures that baseline.
  const widened =
    input.widenGaps === false
      ? { nodes: placed.nodes, gaps: [] as GapRecord[] }
      : LAYOUT_PREPASS.run(placed.nodes, placed.edges);
  const { nodes, gaps } = widened;
  return {
    nodes,
    gaps,
    edges: rerouteEdges(nodes, placed.edges, { gaps }),
    baseEdges: placed.edges,
  };
}
