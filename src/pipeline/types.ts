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

// One machine vertex per replica. We hang on to `stampIndex` even though the
// no-fold render currently emits a single unit per vertex (so there is really
// only ever one stamp today); it carries the per-consumer expansion data that a
// future folding pass will need to partition over.
export type MachineRecipeVertex = {
  kind: "machine";
  id: MachineVertexId;
  replicaId: ReplicaId;
  recipeId: RecipeId;
  stampIndex: number;
  // Execution rate for this one stamp (replica.executionRate / multiplier). The
  // render policy uses it to figure out boundary edge rates for raw inputs that
  // end the solver walk. Those items never appear in the logical graph, so they
  // have no MachineEdge, and the policy has to compute their rate itself as
  // perVertexRate = executionRate * recipe.in[item].qty.
  executionRate: Fraction;
  containerId?: ContainerId;
  // True only when this stamp is the leftover fraction from splitting idealCount
  // into N full machines plus a partial one. The render layer gives these
  // partial stamps a distinct look.
  partial?: boolean;
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
// aggregate and outbound edges to the consumers in its own container. The
// aggregate is pinned to FIRST_SEPARATE -- its own layer just before FIRST --
// which keeps the aggregate-to-fanout edge a valid downhill edge, while the
// fanouts themselves float (or pin to FIRST for the loose bucket) and settle
// near their containers. Not set on aggregate nodes or on single-bucket plans.
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
  isFanout?: true;
  isAggregate?: true;
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
};

export type RenderUnit =
  | RenderUnitRecipe
  | RenderUnitLoop
  | RenderUnitInputProduct
  | RenderUnitOutputProduct;

// The one canonical list of RenderUnit.kind strings. The policy and the tests
// both import it, so a new kind only ever has to be added in this one spot.
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

export const isBlueprintGroupContainer = (
  c: Container,
): c is BlueprintGroupContainer => c.kind === "blueprint-group";
export const isLoopBoxContainer = (c: Container): c is LoopBoxContainer =>
  c.kind === "loop-box";

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
  targets: ReadonlyArray<import("../data/targets").Target>;
  itemOverrides: ReadonlyArray<import("../data/plan").ItemOverride>;
  itemById: ReadonlyMap<ItemId, import("@aef/schema").Item>;
  recipeById: ReadonlyMap<RecipeId, import("@aef/schema").Recipe>;
  // The bit of the pack the policy passes on to `effectiveSupply`, which only
  // reads `pack.items`. Narrowed to that one field so callers don't have to
  // supply a whole RecipePack just to satisfy the type.
  pack: Pick<import("@aef/schema").RecipePack, "items">;
  // The per-replica rational machine count from assignIdealMultipliers. The
  // always-fold policy reads it to set RenderUnitRecipe.multiplicity, giving one
  // rational badge per equivalence class instead of N separate stamp vertices.
  idealCount: ReadonlyMap<ReplicaId, Fraction>;
};

export type RenderPolicy = (input: RenderPolicyInput) => RenderPlan;
