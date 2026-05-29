import Fraction from "fraction.js";
import type {
  Item,
  Machine,
  Recipe,
  RecipePack,
  TransportKindId,
} from "@aef/schema";

export type RecipeId = string;
export type ItemId = string;
export type SccId = string;
export type ReplicaId = string;
export type TornEdgeId = string;
export type GroupId = string;

export type RecipeEdge = {
  id: string;
  source: RecipeId;
  target: RecipeId;
  item: ItemId;
};

export type RecipeGraph = {
  nodes: Map<RecipeId, Recipe>;
  outgoing: Map<RecipeId, RecipeEdge[]>;
  incoming: Map<RecipeId, RecipeEdge[]>;
  // Raw-distance ranking maps that buildRecipeGraph fills in so pickProducer
  // can rank candidate producers. An excluded recipe (isExcludedProducer ===
  // true) gets no entry in depthToRecipe. Items reachable only through
  // excluded producers or closed cycles stay at Number.POSITIVE_INFINITY.
  depthToItem: Map<ItemId, number>;
  depthToRecipe: Map<RecipeId, number>;
};

export type Scc = {
  id: SccId;
  recipeIds: ReadonlyArray<RecipeId>;
};

export type Condensation = {
  sccs: ReadonlyArray<Scc>;
  sccOfRecipe: Map<RecipeId, SccId>;
  outgoing: Map<SccId, Set<SccId>>;
  incoming: Map<SccId, Set<SccId>>;
};

export type TornEdge = {
  id: TornEdgeId;
  edge: RecipeEdge;
  sccId: SccId;
};

export type Replica = {
  id: ReplicaId;
  recipeId: RecipeId;
  executionRate: Fraction;
  consumerPath: ReadonlyArray<ReplicaId>;
  blueprintGroupId: GroupId;
  sharedAtArticulation: boolean;
  // When an SCC member recipe carries both an intra-SCC and a cross-boundary
  // outgoing-edge role (or is itself a target whose output crosses the SCC
  // boundary), `replicatePerConsumer` emits two split replicas for it. Each
  // split lists the (item, target-recipe) keys it owns in
  // `outgoingEdgeFilter`. Any downstream stage that fans a shared producer out
  // to its consumers (assembleLogicalGraph, deriveReplicaEdges, and the
  // boundary-edge emission in replicate.ts) has to intersect against this
  // filter so a split replica projects only its own role's edges. When it is
  // undefined, the replica owns every outgoing recipe-graph edge of its recipe
  // (the single-role, non-split case).
  outgoingEdgeFilter?: ReadonlySet<string>;
};

/**
 * Builds the canonical key used in `Replica.outgoingEdgeFilter`. Pairing the
 * carried item with the consumer recipe id lets a planter that has several
 * outgoing-edge roles route each per-role replica exactly.
 */
export const outgoingEdgeKey = (item: ItemId, target: RecipeId): string =>
  `${item}|${target}`;

export type PackedLane = {
  groupId: GroupId;
  carrier: TransportKindId;
  laneIndex: number;
  overflow: boolean;
  streams: ReadonlyArray<{
    replicaId: ReplicaId;
    itemId: ItemId;
    itemsPerSec: Fraction;
  }>;
};

export type SolverInputs = {
  pack: RecipePack;
  machineById: Map<string, Machine>;
  itemById: Map<string, Item>;
};

export class UnknownRecipeError extends Error {
  constructor(
    public recipeId: RecipeId,
    reason: string = `unknown recipe in target: ${recipeId}`,
  ) {
    super(reason);
    this.name = "UnknownRecipeError";
  }
}

export class SingularSccError extends Error {
  constructor(public sccId: SccId) {
    super(`SCC ${sccId} is under-determined; mass-balance system is singular`);
    this.name = "SingularSccError";
  }
}

export class InconsistentSccError extends Error {
  constructor(public sccId: SccId) {
    super(
      `SCC ${sccId} mass-balance system is inconsistent (over-constrained)`,
    );
    this.name = "InconsistentSccError";
  }
}

export class MissingMachineError extends Error {
  constructor(
    public recipeId: RecipeId,
    public producerId: string | undefined,
  ) {
    super(
      `recipe ${recipeId} has no resolvable producer (${producerId ?? "<empty>"})`,
    );
    this.name = "MissingMachineError";
  }
}

export class StreamExceedsLaneCapacityError extends Error {
  constructor(
    public replicaId: ReplicaId,
    public itemId: ItemId,
    public itemsPerSec: Fraction,
  ) {
    super(
      `stream ${replicaId}/${itemId} at ${itemsPerSec.toFraction()} exceeds single-lane capacity`,
    );
    this.name = "StreamExceedsLaneCapacityError";
  }
}

export class MultiProducerSccCapError extends Error {
  constructor(
    public sccId: SccId,
    public itemId: ItemId,
    public producerIds: ReadonlyArray<RecipeId>,
  ) {
    super(
      `SCC ${sccId} has multiple internal producers of item ${itemId} ` +
        `(${producerIds.join(", ")}) with at least one external consumer; ` +
        `Layer 2 SCC pre-subtraction cap model is single-producer-per-item.`,
    );
    this.name = "MultiProducerSccCapError";
  }
}

export class UnknownCarrierError extends Error {
  constructor(
    public itemId: ItemId | null,
    public kind: TransportKindId,
  ) {
    super(
      itemId === null
        ? `unknown carrier kind '${kind}'`
        : `unknown carrier kind '${kind}' for item '${itemId}'`,
    );
    this.name = "UnknownCarrierError";
  }
}
