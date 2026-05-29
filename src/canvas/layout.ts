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
};

const RECIPE_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  "org.eclipse.elk.portConstraints": "FIXED_ORDER",
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
export type RFRecipeNode = RFNode<
  {
    recipe: Recipe;
    kind: "recipe";
    portTransportKinds: PortTransportKinds;
    multiplicity: RationalString;
  },
  "recipe"
>;
export type RFLoopNode = RFNode<
  {
    sccId: SccId;
    netIO: RenderUnitLoop["netIO"];
    interior: LoopInteriorSize;
    portTransportKinds: PortTransportKinds;
  },
  "loop"
>;
export type RFContainerNode = RFNode<
  { containerKind: Container["kind"]; containerId: ContainerId },
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
        "org.eclipse.elk.padding": "[top=12,left=12,bottom=12,right=12]",
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

  return {
    id: "root",
    layoutOptions: { ...ROOT_LAYOUT_OPTIONS },
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

// FIXED_ORDER plus the per-port "elk.port.index" hint decide vertical
// placement, so we never set port.y here. On the React side the Handle takes its
// visual top offset from `measureRecipe(recipe).inHandleYs[i] / outHandleYs[i]`,
// and ELK is trusted to line ports up by index on each side. The lockstep
// guarantee between layout and rendering is therefore about the outer box and
// the port ordering, not the absolute per-port y that ELK reports.
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
  // constraint so ELK can drop each one near its container, and they add a sink
  // port on the west side to receive the edge from the aggregate.
  //
  // The "loose" fanout slice (no containerId; its consumers live outside any
  // blueprint group) has no container tugging it leftward, so the edges out to
  // its right-side consumers would otherwise let ELK shove it far right next to
  // them. Pinning loose slices to layer 1, just right of the aggregate on FIRST,
  // keeps them beside the aggregate as visual taps instead of drifting across
  // the canvas.
  //
  // So the input products fall into three tiers:
  //   - Aggregate (isAggregate): FIRST_SEPARATE, its own layer ahead of FIRST,
  //     so the aggregate -> fanout edge is a valid forward edge into FIRST or
  //     beyond. ELK does not support a FIRST-to-FIRST edge.
  //   - Loose fanout slice (isFanout, id ends with ":loose"): FIRST, pinned next
  //     to the aggregate so it doesn't drift right toward its loose consumers.
  //   - Clustered fanout slice (isFanout): unconstrained, so ELK settles it near
  //     its loop-box container on its own.
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
  } else if (u.id.endsWith(":loose")) {
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
      nodes.push({
        id: container.id,
        type: "group",
        position: { x: top.x ?? 0, y: top.y ?? 0 },
        data: { containerKind: container.kind, containerId: container.id },
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
      return {
        id: unit.id,
        type: "recipe",
        ...base,
        data: {
          recipe,
          kind: "recipe",
          portTransportKinds,
          multiplicity: unit.multiplicity,
        },
      } satisfies RFRecipeNode;
    }
    case "loop": {
      const interior =
        interiorByLoopId.get(unit.sccId) ?? DEFAULT_LOOP_INTERIOR;
      return {
        id: unit.id,
        type: "loop",
        ...base,
        data: {
          sccId: unit.sccId,
          netIO: unit.netIO,
          interior,
          portTransportKinds,
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
  return fromElkRenderLayout(laid, input);
}
