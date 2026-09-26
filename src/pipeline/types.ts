import type Fraction from "fraction.js";
import type { TransportKindId } from "@aef/schema";
import type { RationalString } from "../data/targets";
import type {
  ItemId,
  RecipeId,
  ReplicaId,
  SccId,
  GroupId,
} from "../solver/types";

export type { ItemId, RecipeId, ReplicaId, SccId, GroupId };
export type { TransportKindId };
export type { RationalString };

export type ContainerId = string;
export type MachineVertexId = string;

export type NetIODirection = "in" | "out";

export type NetIOPort = {
  item: ItemId;
  direction: NetIODirection;
  rate: Fraction;
};

export type BlueprintGroupContainer = {
  kind: "blueprint-group";
  id: ContainerId;
  members: ReadonlyArray<ReplicaId>;
};

export type LoopBoxContainer = {
  kind: "loop-box";
  id: ContainerId;
  members: ReadonlyArray<ReplicaId>;
  sccId: SccId;
};

export type Container = BlueprintGroupContainer | LoopBoxContainer;

export type ContainerSet = {
  containers: ReadonlyArray<Container>;
  containerByMember: ReadonlyMap<ReplicaId, ContainerId>;
};

// One machine vertex per surviving replica: the shipped materialisation
// (expandAggregate) emits the replica's whole execution rate on a single
// vertex. `stampIndex` and `partial` belong to the retained per-machine stamp
// path (expandMultipliers), which materializes a replica into its full stamps
// plus at most one partial one and orders them by index inside the replica;
// nothing the render draws reads either field.
export type MachineRecipeVertex = {
  kind: "machine";
  id: MachineVertexId;
  replicaId: ReplicaId;
  recipeId: RecipeId;
  stampIndex?: number;
  // Execution rate carried by this vertex: the replica's whole rate
  // (idealCount * machine speed) on the shipped path, one machine's share of it
  // on a stamp. The render policy uses it to figure out boundary edge rates for
  // raw inputs that end the solver walk. Those items never appear in the
  // logical graph, so they have no MachineEdge, and the policy has to compute
  // their rate itself as perVertexRate = executionRate * recipe.in[item].qty.
  executionRate: Fraction;
  containerId?: ContainerId;
  // Stamp path only: true on the leftover fraction from splitting idealCount
  // into N full machines plus a partial one. The exam counts partial machine
  // counts off the render plan's multiplicity badges instead.
  partial?: boolean;
  // Catalyst draw of this vertex, in items per second, one entry per catalyst
  // item of the recipe. A catalyst is held per machine rather than consumed
  // per cycle, so the rate comes from the vertex's machine count ceiled to a
  // whole machine, not from executionRate. Absent - never an empty array - on
  // a recipe without a catalyst and when no machine speed is available to
  // compute it from.
  catalystCharge?: ReadonlyArray<{ item: ItemId; rate: Fraction }>;
};

export type MachineSccVertex = {
  kind: "scc-box";
  id: MachineVertexId;
  sccId: SccId;
  netIO: ReadonlyArray<NetIOPort>;
  containerId?: ContainerId;
};

export type MachineVertex = MachineRecipeVertex | MachineSccVertex;

export type MachineEdge = {
  from: MachineVertexId;
  to: MachineVertexId;
  item: ItemId;
  rate: Fraction;
  transportKind: TransportKindId;
};

export type MachineGraph = {
  vertices: ReadonlyArray<MachineVertex>;
  edges: ReadonlyArray<MachineEdge>;
};

export type RenderUnitId = string;

export type RenderUnitRecipe = {
  id: RenderUnitId;
  kind: "recipe";
  recipeId: RecipeId;
  count: 1;
  containerId?: ContainerId;
  // Rational machine count for this equivalence class -- the idealCount that
  // assignIdealMultipliers produced.
  multiplicity: RationalString;
};

export type RenderUnitLoop = {
  id: RenderUnitId;
  kind: "loop";
  sccId: SccId;
  count: 1;
  containerId?: ContainerId;
  netIO: ReadonlyArray<NetIOPort>;
};

// Boundary product nodes the render policy emits. An input product stands for a
// raw item that enters the plan from outside and was not promoted to "walk
// through" by ItemOverride.plan === true; its rateCap is the optional cap the
// user gave via ItemOverride.ratePerSec. An output product stands for a target
// item the user wants to make. We spell flavor out as an enum so that adding a
// "surplus" variant later is a deliberate opt-in rather than something that
// slips in by default.
//
// `rate` is the actual demand per second, the sum of this item's outbound
// boundary-edge rates. It is always set: every input product carries its
// computed demand so the node shows a real number instead of an "uncapped"
// placeholder. `rateCap` stays optional and only appears when the user actually
// limited the supply.
//
// `isFanout` is true only when the node is a per-container slice sitting below
// an aggregate input node. A fanout slice has one inbound edge from the
// aggregate and outbound edges to the consumers in its own container; a
// container needs its own card because an edge must enter a compound node
// once. Consumers in no container draw straight from the aggregate and get no
// slice card. The aggregate is pinned to FIRST_SEPARATE -- its own layer just
// before FIRST -- which keeps the aggregate-to-fanout edge a valid downhill
// edge, while the fanouts themselves float and settle near their containers.
// Not set on aggregate nodes or on single-bucket plans.
//
// `isAggregate` is true only when the node is the aggregate feeding one or more
// fanout slices for the same item. Layout reads it to put the node on the
// FIRST_SEPARATE layer so the aggregate-to-fanout edges stay valid.
export type RenderUnitInputProduct = {
  id: RenderUnitId;
  kind: "inputProduct";
  itemId: ItemId;
  count: 1;
  rate: RationalString;
  rateCap?: RationalString;
  // Set on the boundary nodes of the catalyst pool (`u:cat:<item>` and its
  // container slices), which feed `cat:` ports only. Absent on an ordinary
  // node, whose rate is ordinary consumption and never a cycled charge. The
  // two pools of one item are accounted separately, so an item can carry a
  // node of each.
  role?: "catalyst";
  isFanout?: true;
  isAggregate?: true;
  // The parent aggregate's total realized rate, stamped on every fanout slice
  // so the card can show its share of the source it taps.
  parentRate?: RationalString;
};

export type RenderUnitOutputProduct = {
  id: RenderUnitId;
  kind: "outputProduct";
  itemId: ItemId;
  count: 1;
  rate: RationalString;
  // "target" means an item the user picked, where the produced rate matches
  // what they asked for. "surplus" means a byproduct the graph makes that
  // nothing downstream consumes (or doesn't fully consume); its rate is the
  // per-item overproduction.
  flavor: "target" | "surplus";
  // The rate the plan actually feeds a "target" card, set only when that is
  // below the declared `rate` (the targetOutputShortfalls predicate the
  // shortfall strip reads). Absent on a fed target and on every surplus card.
  delivered?: RationalString;
};

export type RenderUnit =
  | RenderUnitRecipe
  | RenderUnitLoop
  | RenderUnitInputProduct
  | RenderUnitOutputProduct;

// The one canonical list of RenderUnit.kind strings. The tests import it, so a
// new kind only ever has to be added in this one spot.
export const RENDER_UNIT_KINDS = [
  "recipe",
  "loop",
  "inputProduct",
  "outputProduct",
] as const;
export type RenderUnitKind = (typeof RENDER_UNIT_KINDS)[number];

export type RenderEdge = {
  fromUnit: RenderUnitId;
  toUnit: RenderUnitId;
  item: ItemId;
  rate: Fraction;
  transportKind: TransportKindId;
  labelSide?: "source" | "target";
  // Which port on `toUnit` the edge lands on. Absent means the ordinary
  // `in:<item>` port. "catalyst" means the `cat:<item>` port of a catalyst
  // row, which a card can carry for an item it ALSO consumes as an input, so
  // the two edges are told apart by this discriminator rather than by item.
  toPortKind?: "catalyst";
  // Which boundary pool the edge LEAVES. "catalyst" means `fromUnit` is a
  // catalyst pool node (`u:cat:<item>`, single or aggregate, or one of its
  // container slices), which the renderer draws with a dashed stroke. It
  // is not the mirror of `toPortKind`: an aggregate-to-slice edge inside the
  // pool lands on no catalyst row yet still leaves the pool.
  fromPool?: "catalyst";
};

export type RenderPlan = {
  units: ReadonlyArray<RenderUnit>;
  edges: ReadonlyArray<RenderEdge>;
  containers: ReadonlyArray<Container>;
};

export const isRecipeUnit = (u: RenderUnit): u is RenderUnitRecipe =>
  u.kind === "recipe";
export const isLoopUnit = (u: RenderUnit): u is RenderUnitLoop =>
  u.kind === "loop";
export const isInputProductUnit = (
  u: RenderUnit,
): u is RenderUnitInputProduct => u.kind === "inputProduct";
export const isOutputProductUnit = (
  u: RenderUnit,
): u is RenderUnitOutputProduct => u.kind === "outputProduct";

export const isMachineRecipeVertex = (
  v: MachineVertex,
): v is MachineRecipeVertex => v.kind === "machine";
export const isMachineSccVertex = (v: MachineVertex): v is MachineSccVertex =>
  v.kind === "scc-box";

import type { LogicalGraph } from "../canvas/layout";

export type ClusteringPolicyInput = {
  logical: LogicalGraph;
  replicas: ReadonlyArray<import("../solver/types").Replica>;
  condensation: import("../solver/types").Condensation;
};

export type ClusteringPolicy = (input: ClusteringPolicyInput) => ContainerSet;

export type RenderPolicyInput = {
  containers: ContainerSet;
  machineGraph: MachineGraph;
  // The plan context the policy needs in order to emit boundary product units.
  // The driver fills these in; tests that only exercise the older units-only
  // path can hand over empty collections and maps.
  targets: ReadonlyArray<import("../data/targets").ItemTarget>;
  itemOverrides: ReadonlyArray<import("../data/plan").ItemOverride>;
  itemById: ReadonlyMap<ItemId, import("@aef/schema").Item>;
  recipeById: ReadonlyMap<RecipeId, import("@aef/schema").Recipe>;
  // Effective supply per item, resolved once by the driver from the RAW pack's
  // items and the same overrides as `itemOverrides`. The policy passes it on to
  // deriveBoundaryProducts; nothing here reads the pack itself.
  supply: import("../solver/effectiveSupply").SupplyTable;
  // The per-replica rational machine count from assignIdealMultipliers. The
  // always-fold policy reads it to set RenderUnitRecipe.multiplicity: one
  // rational badge per equivalence class, so machine count is stated rather than
  // counted off the vertices.
  idealCount: ReadonlyMap<ReplicaId, Fraction>;
  // Per finite-capped item the LP drew from the boundary: the fraction of its
  // consumption in-graph producers cover (boundaryResidualShare). Missing
  // entries mean share 1 (no boundary contribution). deriveBoundaryProducts
  // sizes each boundary import as totalDemand * (1 - share) and skips emission
  // entirely for finite-capped items with no entry (realized draw 0).
  boundaryShare: ReadonlyMap<ItemId, Fraction>;
  // The LP's boundary draw per finite-capped item. deriveBoundaryProducts feeds
  // a capped target's export from what the draw has left after the item's
  // in-plan consumers.
  draws: ReadonlyMap<ItemId, Fraction>;
};

export type RenderPolicy = (input: RenderPolicyInput) => RenderPlan;
