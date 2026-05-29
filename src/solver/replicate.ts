import Fraction from "fraction.js";
import type {
  Condensation,
  GroupId,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  SccId,
} from "./types";
import { outgoingEdgeKey } from "./types";
import type { Target } from "../data/targets";

/**
 * Per-consumer micro-pipeline replication.
 *
 * The walk follows a few rules:
 *  - Start at each target and recurse upstream over the initial recipe graph.
 *  - Stop recursing at articulation-point recipes; each emits one shared
 *    replica that every downstream consumer reuses.
 *  - SCC members are always shared: each non-trivial SCC emits exactly one
 *    replica per member, lazily on first reach. Recursing past the SCC follows
 *    its boundary input edges (the edges entering from non-SCC sources).
 *  - Any other producer (not an articulation point, not in an SCC) replicates
 *    per consumer: each consumer call creates its own Replica with that
 *    consumer's rate share.
 *
 * The walker is iterative to dodge JS recursion-depth limits on real packs.
 *
 * `replicatePerConsumer` is the only entry point used outside this module.
 * Internally it hands off to four named sub-orchestrators, one per concern:
 *   - walkFromTargets    seed and iterative drain
 *   - ensureSccReplicas  per-SCC emission; calls assignSplitRoles per member
 *   - assignSplitRoles   pure looper/deliverer decision
 *   - propagateGroups    pure GroupId derivation
 *
 * plus one private helper, `processProducer`, that walkFromTargets calls once
 * per traversed edge to dispatch the three producer roles (SCC member,
 * AP-shared, per-consumer). It isn't a public seam on purpose: it is stateful
 * glue rather than a concern of its own.
 *
 * `assignSplitRoles` and `propagateGroups` are exported alongside the public
 * entry so tests can exercise the pure rules without building a full
 * RecipeGraph fixture.
 */
export function replicatePerConsumer(args: {
  g: RecipeGraph;
  articulation: Set<RecipeId>;
  rates: Map<RecipeId, Fraction>;
  condensation: Condensation;
  targets: Target[];
}): Replica[] {
  const state = createReplicateState(args);
  walkFromTargets(state);
  return state.replicas;
}

// ---------------------------------------------------------------------------
// ReplicateState: shared mutable working set
// ---------------------------------------------------------------------------

// Every piece of mutable working storage the sub-orchestrators share.
// `createReplicateState` builds it once, and the functions below mutate its
// caches, replica list, and worklists in place.
type ReplicateState = {
  // Inputs, held as immutable references.
  readonly g: RecipeGraph;
  readonly articulation: Set<RecipeId>;
  readonly rates: Map<RecipeId, Fraction>;
  readonly condensation: Condensation;
  readonly targets: Target[];

  // Output accumulator.
  readonly replicas: Replica[];

  // Id minting.
  nextId: number;

  // Lazy emission caches.
  readonly sccCreated: Set<SccId>;
  readonly apShared: Map<RecipeId, Replica>;
  readonly sccMemberReplicas: Map<SccId, Map<RecipeId, ReplicaId>>;

  // Lookup tables.
  readonly sccById: Map<SccId, Condensation["sccs"][number]>;
  readonly targetRecipeIds: Set<RecipeId>;

  // Worklists.
  readonly stack: Frame[];
  readonly boundaryEdges: BoundaryEdge[];
};

// A work item for the iterative walk. Each entry tells the walker to process
// the inputs of `consumerId`, treating `consumerReplicaId` as the consumer's
// representative replica. Non-shared producers reached from this consumer
// inherit `blueprintGroupId` and extend `consumerPath`. `consumerRate` is the
// per-replica execution rate of `consumerReplicaId`; it is needed so the
// per-consumer upstream traversal scales by this replica's share rather than
// the recipe's global rate (which sums across every consumer).
type Frame = {
  consumerId: RecipeId;
  consumerReplicaId: ReplicaId;
  consumerRate: Fraction;
  blueprintGroupId: GroupId;
  consumerPath: ReplicaId[];
};

// A boundary edge found while emitting an SCC. These are processed after each
// SCC emission so the iterative walk stays flat.
type BoundaryEdge = {
  producerId: RecipeId;
  producerItem: string;
  consumerId: RecipeId;
  consumerReplicaId: ReplicaId;
  consumerRate: Fraction;
  consumerGroupId: GroupId;
  consumerPath: ReplicaId[];
};

function createReplicateState(args: {
  g: RecipeGraph;
  articulation: Set<RecipeId>;
  rates: Map<RecipeId, Fraction>;
  condensation: Condensation;
  targets: Target[];
}): ReplicateState {
  const sccById = new Map<SccId, Condensation["sccs"][number]>();
  for (const s of args.condensation.sccs) sccById.set(s.id, s);
  const targetRecipeIds = new Set<RecipeId>(
    args.targets.map((t) => t.recipeId),
  );
  return {
    g: args.g,
    articulation: args.articulation,
    rates: args.rates,
    condensation: args.condensation,
    targets: args.targets,
    replicas: [],
    nextId: 0,
    sccCreated: new Set(),
    apShared: new Map(),
    sccMemberReplicas: new Map(),
    sccById,
    targetRecipeIds,
    stack: [],
    boundaryEdges: [],
  };
}

function newReplicaId(state: ReplicateState, prefix: string): ReplicaId {
  return `${prefix}#${state.nextId++}`;
}

function isInScc(state: ReplicateState, rid: RecipeId): boolean {
  const sccId = state.condensation.sccOfRecipe.get(rid);
  if (sccId === undefined) return false;
  const scc = state.sccById.get(sccId);
  return !!scc && scc.recipeIds.length > 1;
}

function sccIdOf(state: ReplicateState, rid: RecipeId): SccId {
  return state.condensation.sccOfRecipe.get(rid)!;
}

// ---------------------------------------------------------------------------
// propagateGroups: GroupId derivation
// ---------------------------------------------------------------------------

// A replica's blueprintGroupId follows entirely from how it was reached:
//   - SCC member  -> `scc:${sid}`     (every member of one SCC shares a group)
//   - AP-shared   -> `shared:${rid}`  (one shared replica per AP recipe)
//   - Target seed -> `target:${rid}`  (a per-target tree)
//   - Non-shared  -> inherits the consumer's group (a per-consumer tree)
// Keeping the rule in one function makes the grouping policy easy to audit: a
// future change (say, nested groups) lives here and nowhere else.
export type GroupRole =
  | { kind: "scc"; sccId: SccId }
  | { kind: "apShared"; recipeId: RecipeId }
  | { kind: "target"; recipeId: RecipeId }
  | { kind: "inherit"; consumerGroupId: GroupId };

export function propagateGroups(role: GroupRole): GroupId {
  switch (role.kind) {
    case "scc":
      return `scc:${role.sccId}`;
    case "apShared":
      return `shared:${role.recipeId}`;
    case "target":
      return `target:${role.recipeId}`;
    case "inherit":
      return role.consumerGroupId;
  }
}

// ---------------------------------------------------------------------------
// assignSplitRoles: the looper/deliverer decision
// ---------------------------------------------------------------------------

// A pure decision: given an SCC member's outgoing edges already classified into
// intra-SCC and cross-boundary roles (plus whether the member is a user
// target), decide whether to emit ONE replica (single role) or TWO (a looper
// and a deliverer). When it splits, it returns the per-role execution rates
// and the outgoingEdgeFilter sets ready for building those replicas.
//
// Mass-balance contract: when the result is `split`, looperRate +
// delivererRate equals the input `recipeRate` (apart from a defensive
// negative-cross clamp that the exact-rational solver makes unreachable in
// practice).
//
// It's deliberately a pure function. The role classification is the
// load-bearing part of the split logic and the highest-value thing to test in
// isolation. Callers resolve each edge's consumer rate and in-qty once (they
// own the RecipeGraph) and pass the resolved data in, so no graph access lives
// here and tests can drive it with hand-built records and no fixtures.
export type RoleEdge = { item: string; target: RecipeId };

// An intra-SCC outgoing edge with its consumer's per-edge stoichiometry already
// resolved. The caller multiplies `consumerRate * consumerInQty` per edge to
// get the intra-side flow share; edges with no resolvable consumer are dropped
// by the caller, so they never contribute to intraFlow.
export type ResolvedIntraEdge = {
  item: string;
  target: RecipeId;
  consumerRate: Fraction;
  consumerInQty: number;
};

export type SplitDecision =
  | { kind: "single" }
  | {
      kind: "split";
      looperRate: Fraction;
      delivererRate: Fraction;
      looperFilter: Set<string>;
      delivererFilter: Set<string>;
    };

export function assignSplitRoles(args: {
  recipeRate: Fraction;
  primaryOutQty: number; // recipe.out[0].qty, or 0 when recipe has no outputs
  intraEdges: ResolvedIntraEdge[];
  crossEdges: RoleEdge[];
  isTarget: boolean;
}): SplitDecision {
  const { recipeRate, primaryOutQty, intraEdges, crossEdges, isTarget } = args;
  const shouldSplit =
    intraEdges.length > 0 &&
    (crossEdges.length > 0 || isTarget) &&
    recipeRate.compare(0) > 0;
  if (!shouldSplit) return { kind: "single" };

  // intra-flow is the sum over the intra-SCC outgoing edges of
  // (consumer rate * in-qty for the item).
  let intraFlow = new Fraction(0);
  for (const ie of intraEdges) {
    intraFlow = intraFlow.add(
      ie.consumerRate.mul(new Fraction(ie.consumerInQty)),
    );
  }
  // Total produced rate of this recipe's primary output. The split is a
  // rate-share on outgoing flow, and for AEF recipes the primary output
  // (recipe.out[0]) is the canonical role-carrier.
  const producedFlow =
    primaryOutQty > 0
      ? recipeRate.mul(new Fraction(primaryOutQty))
      : new Fraction(0);
  // cross-flow is total-produced minus intra-flow, which covers both the
  // graph-cross edges and the synthetic target output. Mass balance on the SCC
  // linear solve guarantees total-produced == intra-flow + cross-flow.
  let crossFlow = producedFlow.sub(intraFlow);
  // Clamp any tiny negative that a round trip through the solver could in
  // principle introduce. The exact-rational flow solve makes this unreachable
  // in practice; the clamp records the invariant instead of silently dropping
  // rate.
  if (crossFlow.compare(0) < 0) crossFlow = new Fraction(0);
  const totalFlow = intraFlow.add(crossFlow);

  const looperRate = totalFlow.equals(0)
    ? new Fraction(0)
    : recipeRate.mul(intraFlow).div(totalFlow);
  const delivererRate = recipeRate.sub(looperRate);

  const looperFilter = new Set<string>();
  for (const ie of intraEdges) {
    looperFilter.add(outgoingEdgeKey(ie.item, ie.target));
  }
  const delivererFilter = new Set<string>();
  for (const ce of crossEdges) {
    delivererFilter.add(outgoingEdgeKey(ce.item, ce.target));
  }
  // When isTarget is true and there are no cross edges, delivererFilter ends up
  // empty. The deliverer still owns the target-output role; the
  // boundary-products pass routes the target edge off this replica's stamps on
  // its own.
  return {
    kind: "split",
    looperRate,
    delivererRate,
    looperFilter,
    delivererFilter,
  };
}

// ---------------------------------------------------------------------------
// ensureSccReplicas: per-SCC emission
// ---------------------------------------------------------------------------

// Emits an SCC's shared replicas exactly once, returning the per-member replica
// ids keyed by recipe id; later calls return the cached mapping.
//
// When an SCC member has both an intra-SCC outgoing edge and a cross-boundary
// one (or is itself a target, so the boundary-products pass will synthesize a
// target output edge from its stamps), assignSplitRoles returns a split
// decision and this function emits two replicas with distinct ids: a "looper"
// carrying the intra-SCC role and a "deliverer" carrying the cross-boundary
// role. Each replica's outgoingEdgeFilter scopes its downstream edge fan-out to
// just its role's edges. The returned map still holds one replica id per recipe
// (the canonical "inputs-consumer" replica, which is the looper when one
// exists); the second split replica goes into the replicas array as its own
// entry so assembleLogicalGraph and deriveReplicaEdges find it through the
// recipeId index.
function ensureSccReplicas(
  state: ReplicateState,
  sid: SccId,
): Map<RecipeId, ReplicaId> {
  const existing = state.sccMemberReplicas.get(sid);
  if (existing) return existing;
  const scc = state.sccById.get(sid)!;
  const groupId = propagateGroups({ kind: "scc", sccId: sid });
  const members = new Set(scc.recipeIds);
  const map = new Map<RecipeId, ReplicaId>();

  for (const rid of scc.recipeIds) {
    // Split the recipe's outgoing recipe-graph edges into intra-SCC and
    // cross-boundary roles. Intra edges resolve their consumer's per-edge rate
    // and in-qty right here so assignSplitRoles can stay graph-free. The
    // target-output role acts as a virtual cross-boundary signal that fires
    // when this recipe is a user-declared target (later in the pipeline the
    // boundary-products pass synthesizes a target output edge from this
    // recipe's stamps). An edge whose consumer can't be resolved (missing node
    // or no matching in-stoich) is emitted with zero stoichiometry, so the
    // looperFilter still gets the edge key while the flow loop sees a zero
    // contribution; that keeps the malformed-graph handling identical to the
    // earlier null-skip-but-always-include-in-filter behavior.
    const intraEdges: ResolvedIntraEdge[] = [];
    const crossEdges: RoleEdge[] = [];
    for (const e of state.g.outgoing.get(rid) ?? []) {
      if (members.has(e.target)) {
        const consumer = state.g.nodes.get(e.target);
        const inStoich = consumer?.in.find((s) => s.item === e.item);
        intraEdges.push({
          item: e.item,
          target: e.target,
          consumerRate:
            consumer && inStoich
              ? (state.rates.get(e.target) ?? new Fraction(0))
              : new Fraction(0),
          consumerInQty: inStoich?.qty ?? 0,
        });
      } else {
        crossEdges.push({ item: e.item, target: e.target });
      }
    }
    const isTarget = state.targetRecipeIds.has(rid);
    const recipeRate = state.rates.get(rid) ?? new Fraction(0);
    const recipe = state.g.nodes.get(rid);
    const primaryOutQty = recipe?.out[0]?.qty ?? 0;
    const decision = assignSplitRoles({
      recipeRate,
      primaryOutQty,
      intraEdges,
      crossEdges,
      isTarget,
    });

    if (decision.kind === "single") {
      // Single role: emit one replica that owns all of the outgoing edges.
      const rep: Replica = {
        id: newReplicaId(state, `r:${rid}`),
        recipeId: rid,
        executionRate: recipeRate,
        consumerPath: [],
        blueprintGroupId: groupId,
        sharedAtArticulation: true,
      };
      state.replicas.push(rep);
      map.set(rid, rep.id);
      continue;
    }

    // Split role: emit a looper and a deliverer with proportional rates.
    const looper: Replica = {
      id: newReplicaId(state, `r:${rid}`),
      recipeId: rid,
      executionRate: decision.looperRate,
      consumerPath: [],
      blueprintGroupId: groupId,
      sharedAtArticulation: true,
      outgoingEdgeFilter: decision.looperFilter,
    };
    state.replicas.push(looper);
    const deliverer: Replica = {
      id: newReplicaId(state, `r:${rid}`),
      recipeId: rid,
      executionRate: decision.delivererRate,
      consumerPath: [],
      blueprintGroupId: groupId,
      sharedAtArticulation: true,
      outgoingEdgeFilter: decision.delivererFilter,
    };
    state.replicas.push(deliverer);
    // The looper is the canonical inputs-consumer; the boundary-edge frames
    // below use it to walk upstream producers. The deliverer is still its own
    // replica, and assembleLogicalGraph picks it up through the recipeId index
    // with no extra plumbing.
    map.set(rid, looper.id);
  }

  state.sccMemberReplicas.set(sid, map);
  state.sccCreated.add(sid);

  // Queue up the boundary-input recursion: for every boundary edge
  // (src, member) where src sits outside this SCC, enqueue a frame so the walk
  // continues into src's inputs.
  for (const memberId of scc.recipeIds) {
    const memberReplicaId = map.get(memberId)!;
    for (const e of state.g.incoming.get(memberId) ?? []) {
      if (members.has(e.source)) continue;
      state.boundaryEdges.push({
        producerId: e.source,
        producerItem: e.item,
        consumerId: memberId,
        consumerReplicaId: memberReplicaId,
        consumerRate: state.rates.get(memberId) ?? new Fraction(0),
        consumerGroupId: groupId,
        consumerPath: [],
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// processProducer: per-edge producer dispatch (private helper of walkFromTargets)
// ---------------------------------------------------------------------------

// Handles a single (producer, consumer, item) edge, called once per traversed
// edge by walkFromTargets. It isn't a public seam: it owns the three producer
// cases (SCC member, AP-shared, non-shared per-consumer) and the state
// mutations each one needs. It sits above walkFromTargets so reading the file
// top to bottom matches the call order.
//
// The three cases:
//   - SCC member: hand off to ensureSccReplicas for lazy emission and do
//                 nothing else here; ensureSccReplicas enqueues boundary edges
//                 as needed.
//   - AP-shared:  emit one shared replica the first time the AP is reached and
//                 push exactly one upstream frame.
//   - Non-shared: emit a per-consumer replica scaled by this consumer's share
//                 of the producer, then push an upstream frame that inherits
//                 the consumer's blueprint group.
function processProducer(
  state: ReplicateState,
  args: {
    producerId: RecipeId;
    producerItem: string;
    consumerId: RecipeId;
    consumerReplicaId: ReplicaId;
    consumerRate: Fraction;
    consumerGroupId: GroupId;
    consumerPath: ReplicaId[];
  },
): void {
  const {
    producerId,
    producerItem,
    consumerId,
    consumerReplicaId,
    consumerRate,
    consumerGroupId,
    consumerPath,
  } = args;
  const consumerRecipe = state.g.nodes.get(consumerId);
  const producerRecipe = state.g.nodes.get(producerId);
  if (!consumerRecipe || !producerRecipe) return;

  // SCC producer: emit the shared SCC member replicas lazily. There's no
  // per-consumer recursion into individual members; ensureSccReplicas queues
  // the boundary edges.
  if (isInScc(state, producerId)) {
    const sid = sccIdOf(state, producerId);
    if (!state.sccCreated.has(sid)) {
      ensureSccReplicas(state, sid);
    }
    return;
  }

  // Articulation-point producer: emit one shared replica, then walk its inputs
  // a single time.
  if (state.articulation.has(producerId)) {
    let shared = state.apShared.get(producerId);
    if (!shared) {
      const sharedRate = state.rates.get(producerId) ?? new Fraction(0);
      const sharedGroupId = propagateGroups({
        kind: "apShared",
        recipeId: producerId,
      });
      shared = {
        id: newReplicaId(state, `r:${producerId}`),
        recipeId: producerId,
        executionRate: sharedRate,
        consumerPath: [],
        blueprintGroupId: sharedGroupId,
        sharedAtArticulation: true,
      };
      state.replicas.push(shared);
      state.apShared.set(producerId, shared);
      // Walk upstream from this shared producer just once.
      state.stack.push({
        consumerId: producerId,
        consumerReplicaId: shared.id,
        consumerRate: sharedRate,
        blueprintGroupId: shared.blueprintGroupId,
        consumerPath: [],
      });
    }
    return;
  }

  // Non-shared producer: a per-consumer replica whose rate scales by this
  // consumer replica's share rather than the recipe's global rate.
  const inItem = consumerRecipe.in.find((x) => x.item === producerItem);
  const outItem = producerRecipe.out.find((x) => x.item === producerItem);
  if (!inItem || !outItem) return;
  const pRate = consumerRate
    .mul(new Fraction(inItem.qty))
    .div(new Fraction(outItem.qty));
  const groupId = propagateGroups({
    kind: "inherit",
    consumerGroupId,
  });
  const rep: Replica = {
    id: newReplicaId(state, `r:${producerId}`),
    recipeId: producerId,
    executionRate: pRate,
    consumerPath: [...consumerPath, consumerReplicaId],
    blueprintGroupId: groupId,
    sharedAtArticulation: false,
  };
  state.replicas.push(rep);
  state.stack.push({
    consumerId: producerId,
    consumerReplicaId: rep.id,
    consumerRate: pRate,
    blueprintGroupId: groupId,
    consumerPath: [...consumerPath, consumerReplicaId],
  });
}

// ---------------------------------------------------------------------------
// walkFromTargets: seed + iterative drain
// ---------------------------------------------------------------------------

// Drives the whole replication. It seeds a replica per target (or shares the
// member's SCC when the target lives inside one), then drains the frame stack
// and the boundary-edge queue interleaved. Each frame runs its consumer's
// inputs through processProducer, which covers the three producer cases
// (SCC member, AP-shared, non-shared per-consumer).
function walkFromTargets(state: ReplicateState): void {
  // Seed the walk: emit a replica for each target (or its SCC group) and
  // enqueue the upstream recursion.
  for (const t of state.targets) {
    const recipeId = t.recipeId;
    if (!state.g.nodes.has(recipeId)) continue;
    if (isInScc(state, recipeId)) {
      const sid = sccIdOf(state, recipeId);
      if (!state.sccCreated.has(sid)) {
        ensureSccReplicas(state, sid);
      }
      // The target simply is the SCC member's replica, and ensureSccReplicas
      // has already queued the boundary-edge work.
      continue;
    }
    const targetGroupId = propagateGroups({ kind: "target", recipeId });
    const targetRate = state.rates.get(recipeId) ?? new Fraction(0);
    const rep: Replica = {
      id: newReplicaId(state, `r:${recipeId}`),
      recipeId,
      executionRate: targetRate,
      consumerPath: [],
      blueprintGroupId: targetGroupId,
      sharedAtArticulation: false,
    };
    state.replicas.push(rep);
    state.stack.push({
      consumerId: recipeId,
      consumerReplicaId: rep.id,
      consumerRate: targetRate,
      blueprintGroupId: targetGroupId,
      consumerPath: [],
    });
  }

  // The iterative walk drains `stack` and `boundaryEdges` interleaved.
  while (state.stack.length > 0 || state.boundaryEdges.length > 0) {
    // Clear any pending boundary edges (from SCC emissions) first so the SCC
    // upstream work doesn't starve.
    while (state.boundaryEdges.length > 0) {
      const be = state.boundaryEdges.shift()!;
      processProducer(state, {
        producerId: be.producerId,
        producerItem: be.producerItem,
        consumerId: be.consumerId,
        consumerReplicaId: be.consumerReplicaId,
        consumerRate: be.consumerRate,
        consumerGroupId: be.consumerGroupId,
        consumerPath: be.consumerPath,
      });
    }
    if (state.stack.length === 0) continue;
    const frame = state.stack.pop()!;
    const consumer = state.g.nodes.get(frame.consumerId);
    if (!consumer) continue;
    for (const inItem of consumer.in) {
      // Find the producer edge for this input item. The recipe graph already
      // picked a single producer per item when it was built.
      const incoming = state.g.incoming.get(frame.consumerId) ?? [];
      const edge = incoming.find((e) => e.item === inItem.item);
      if (!edge) continue;
      processProducer(state, {
        producerId: edge.source,
        producerItem: edge.item,
        consumerId: frame.consumerId,
        consumerReplicaId: frame.consumerReplicaId,
        consumerRate: frame.consumerRate,
        consumerGroupId: frame.blueprintGroupId,
        consumerPath: frame.consumerPath,
      });
    }
  }
}
