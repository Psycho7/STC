import Fraction from "fraction.js";
import type { Recipe, TransportKindId } from "@aef/schema";

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
  // outgoing-edge role (or is a target whose output crosses the SCC boundary),
  // `replicatePerConsumer` emits two split replicas for it. Each split lists the
  // (item, target-recipe) keys it owns in `outgoingEdgeFilter`. Any downstream
  // stage that fans a shared producer out to its consumers (assembleLogicalGraph,
  // deriveReplicaEdges, the boundary-edge emission in replicate.ts) must
  // intersect against this filter so a split replica projects only its own role's
  // edges. When undefined, the replica owns every outgoing recipe-graph edge of
  // its recipe (the single-role, non-split case).
  outgoingEdgeFilter?: ReadonlySet<string>;
};

/**
 * Builds the canonical key used in `Replica.outgoingEdgeFilter`. Pairing the
 * carried item with the consumer recipe id lets a producer with several
 * outgoing-edge roles route each per-role replica exactly.
 */
export const outgoingEdgeKey = (item: ItemId, target: RecipeId): string =>
  `${item}|${target}`;

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
