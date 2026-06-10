import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type {
  Condensation,
  GroupId,
  RecipeEdge,
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
 * Walk rules:
 *  - Start at each target and recurse upstream over the recipe graph.
 *  - Stop at articulation-point recipes; each emits one shared replica that
 *    every downstream consumer reuses.
 *  - SCC members are always shared: each non-trivial SCC emits one replica per
 *    member, lazily on first reach. Recursing past the SCC follows its boundary
 *    input edges (edges entering from non-SCC sources).
 *  - A byproduct-shared producer (supplies a multi-member SCC member across the
 *    boundary via a non-primary output) emits one shared replica at its full LP
 *    rate, like an AP. Every reach routes here, so primary and boundary paths
 *    converge on the single replica.
 *  - Any other producer replicates per consumer: each consumer call creates its
 *    own Replica with that consumer's rate share.
 *
 * The walker is iterative to dodge JS recursion-depth limits on real packs.
 *
 * `replicatePerConsumer` is the only entry point used outside this module. It
 * hands off to four sub-orchestrators:
 *   - walkFromTargets    seed and iterative drain
 *   - ensureSccReplicas  per-SCC emission; calls assignSplitRoles per member
 *   - assignSplitRoles   pure looper/deliverer decision
 *   - propagateGroups    pure GroupId derivation
 *
 * plus a private helper `processProducer`, called once per traversed edge to
 * dispatch the four producer roles (SCC member, AP-shared, byproduct-shared,
 * per-consumer). It's stateful glue, not a public seam.
 *
 * `assignSplitRoles` and `propagateGroups` are exported so tests can exercise
 * the pure rules without a full RecipeGraph fixture.
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

// Mutable working storage the sub-orchestrators share. `createReplicateState`
// builds it once; the functions below mutate its caches, replica list, and
// worklists in place.
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
  readonly byproductShared: Map<RecipeId, Replica>;
  // Non-SCC target recipes seeded as a full-rate replica in walkFromTargets. A
  // target is the authoritative full-LP-rate replica of its recipe (the LP rate
  // already covers the target's own output plus every internal consumer), so a
  // later reach of it as a producer reuses this replica instead of minting a
  // second copy. Without it a target that is also an upstream producer of another
  // target over-replicates its whole chain ~2x.
  readonly targetSeeded: Map<RecipeId, Replica>;
  readonly targetDraw: Map<RecipeId, Fraction>;
  readonly sccMemberReplicas: Map<SccId, Map<RecipeId, ReplicaId>>;

  // Lookup tables.
  readonly sccById: Map<SccId, Condensation["sccs"][number]>;
  readonly targetRecipeIds: Set<RecipeId>;
  // Producers that feed an SCC member across the boundary for a non-primary
  // output (a byproduct supply). Their rate is fixed by their primary-output
  // demand, so they emit once as a shared replica at full LP rate (AP-shared
  // discipline) and their inputs are walked once. Stops the boundary byproduct
  // demand from minting extra per-consumer copies and re-walking the producer's
  // input chain.
  readonly byproductSharedSources: Set<RecipeId>;

  // Worklists.
  readonly stack: Frame[];
  readonly boundaryEdges: BoundaryEdge[];
};

// A work item for the iterative walk: process the inputs of `consumerId`,
// treating `consumerReplicaId` as the consumer's representative replica.
// Non-shared producers reached from here inherit `blueprintGroupId` and extend
// `consumerPath`. `consumerRate` is this replica's per-replica execution rate,
// so the upstream traversal scales by this replica's share rather than the
// recipe's global rate (which sums across every consumer).
type Frame = {
  consumerId: RecipeId;
  consumerReplicaId: ReplicaId;
  consumerRate: Fraction;
  blueprintGroupId: GroupId;
  consumerPath: ReplicaId[];
};

// A boundary edge found while emitting an SCC. Processed after each SCC
// emission so the iterative walk stays flat.
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

  // Precompute the byproduct-supplier set so dispatch is order-independent:
  // every reach of such a producer (primary path or boundary) shares the one
  // replica. A producer qualifies when it feeds a multi-member SCC member across
  // the boundary for an item that is not its own primary output.
  //
  // Membership controls dispatch for EVERY reach of the producer, including a
  // non-byproduct edge to a non-SCC consumer. That holds only because the LP
  // fixes the producer's rate globally, so emitting once at full LP rate yields
  // the same replica and rate that per-consumer scaling would in the
  // single-producer case.
  const byproductSharedSources = new Set<RecipeId>();
  for (const s of args.condensation.sccs) {
    if (s.recipeIds.length <= 1) continue;
    const members = new Set(s.recipeIds);
    for (const memberId of s.recipeIds) {
      for (const e of args.g.incoming.get(memberId) ?? []) {
        if (members.has(e.source)) continue;
        const producer = args.g.nodes.get(e.source);
        const primaryOut = producer?.out[0]?.item;
        if (primaryOut !== undefined && e.item !== primaryOut) {
          byproductSharedSources.add(e.source);
        }
      }
    }
  }

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
    byproductShared: new Map(),
    targetSeeded: new Map(),
    targetDraw: new Map(),
    sccMemberReplicas: new Map(),
    sccById,
    targetRecipeIds,
    byproductSharedSources,
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
// splitConsumerDemand: proportional per-producer demand split
// ---------------------------------------------------------------------------

// Split a consumer's per-input demand across each input item's producers by LP
// rate share. For each input item, candidate producer edges are weighted by
// (producer rate * produced qty); each producer gets that fraction of
// `consumerRate`. One producer takes the full rate (share 1); multiple
// producers divide it instead of each being sized to the full demand. Both the
// normal stack walk (all incoming edges) and the SCC boundary walk (external
// incoming only) route through this, so the boundary path no longer
// over-produces a multi-producer input.
//
// `targetDraw` deducts a seeded-target producer's declared draw (production
// claimed by the target output product) from its split weight, so co-producing
// siblings carry the residual demand at full LP rate instead of a proportional
// share that would leave the item under-produced.
//
// `intraSupplyByItem` (flow units per input item) is demand already covered
// by intra-SCC producers over the torn arc. It converts to rate units via the
// input qty and is deducted from `consumerRate` per item, clamped at zero, so
// external candidates cover only the demand the loop does not supply.
export function splitConsumerDemand(
  nodes: Map<RecipeId, Recipe>,
  rates: Map<RecipeId, Fraction>,
  consumer: Recipe,
  candidateEdges: ReadonlyArray<RecipeEdge>,
  consumerRate: Fraction,
  targetDraw?: ReadonlyMap<RecipeId, Fraction>,
  intraSupplyByItem?: ReadonlyMap<string, Fraction>,
): Array<{ edge: RecipeEdge; consumerRate: Fraction }> {
  const out: Array<{ edge: RecipeEdge; consumerRate: Fraction }> = [];
  for (const inItem of consumer.in) {
    const matching = candidateEdges.filter((e) => e.item === inItem.item);
    if (matching.length === 0) continue;

    // Net out the intra-SCC supply of this item before splitting: external
    // producers cover memberDemand minus the torn-arc share, never the
    // consumer's full rate. Fully-covered items emit no frame at all.
    let itemRate = consumerRate;
    const intra = intraSupplyByItem?.get(inItem.item);
    if (intra !== undefined && inItem.qty > 0) {
      itemRate = itemRate.sub(intra.div(new Fraction(inItem.qty)));
      if (itemRate.compare(0) < 0) itemRate = new Fraction(0);
    }
    if (itemRate.equals(0)) continue;

    // Weight each producer by its produced flow (rate * out qty); its share of
    // the consumer's demand is its weight over the per-item total.
    let total = new Fraction(0);
    const contribs: Array<{ edge: RecipeEdge; contrib: Fraction }> = [];
    for (const e of matching) {
      const producer = nodes.get(e.source);
      const outQty = producer?.out.find((o) => o.item === e.item)?.qty ?? 0;
      const rate = rates.get(e.source) ?? new Fraction(0);
      let contrib = rate.mul(outQty);
      // A seeded-target producer keeps its full LP rate (the targetSeeded pin
      // in processProducer), and its declared target draw claims that
      // production first. Weight it by the remainder only, so co-producing
      // siblings carry the residual demand at full rate instead of a
      // proportional share that leaves the item under-produced.
      const draw = targetDraw?.get(e.source);
      if (draw !== undefined && producer?.out[0]?.item === e.item) {
        const avail = contrib.sub(draw);
        contrib = avail.compare(0) > 0 ? avail : new Fraction(0);
      }
      contribs.push({ edge: e, contrib });
      total = total.add(contrib);
    }
    if (total.equals(0)) continue;

    for (const { edge, contrib } of contribs) {
      const share = contrib.div(total);
      if (share.equals(0)) continue;
      out.push({ edge, consumerRate: itemRate.mul(share) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// propagateGroups: GroupId derivation
// ---------------------------------------------------------------------------

// A replica's blueprintGroupId follows from how it was reached:
//   - SCC member  -> `scc:${sid}`     (every member of one SCC shares a group)
//   - AP-shared   -> `shared:${rid}`  (one shared replica per AP recipe)
//   - Target seed -> `target:${rid}`  (a per-target tree)
//   - Non-shared  -> inherits the consumer's group (a per-consumer tree)
// One function so the grouping policy is auditable in one place.
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
// and a deliverer). On a split it returns the per-role execution rates and the
// outgoingEdgeFilter sets for building those replicas.
//
// The split balances on one "split-driving" output item: one the recipe both
// feeds intra-SCC and ships cross-boundary. isTarget adds a synthetic cross
// consumer on the primary output, so a target's primary output can be
// split-driving. outQtys gives per-item produced quantities for the
// produced-flow computation; primaryOutItem is the recipe's primary output and
// the count==0 fallback balance item when nothing is split-driving. The >=2
// split-driving case (a co-product role-split) is deferred and guarded by a
// dev-only assertion.
//
// Mass-balance contract: on a `split`, looperRate + delivererRate equals the
// input `recipeRate` (apart from a defensive negative-cross clamp the
// exact-rational solver makes unreachable in practice).
//
// Pure on purpose. The role classification is the load-bearing part and the
// highest-value thing to test in isolation. Callers own the RecipeGraph and
// resolve each edge's consumer rate and in-qty up front, so no graph access
// lives here and tests can drive it with hand-built records.
export type RoleEdge = { item: string; target: RecipeId };

// An intra-SCC outgoing edge with its consumer's per-edge stoichiometry
// resolved. The caller multiplies `consumerRate * consumerInQty` per edge for
// the intra-side flow share; edges with no resolvable consumer are dropped by
// the caller, so they never contribute to intraFlow.
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
  primaryOutItem: string; // recipe.out[0].item, or "" when recipe has no outputs
  outQtys: Map<string, number>; // produced qty per output item
  intraEdges: ResolvedIntraEdge[];
  crossEdges: RoleEdge[];
  isTarget: boolean;
}): SplitDecision {
  const { recipeRate, primaryOutItem, outQtys, intraEdges, crossEdges, isTarget } =
    args;
  const shouldSplit =
    intraEdges.length > 0 &&
    (crossEdges.length > 0 || isTarget) &&
    recipeRate.compare(0) > 0;
  if (!shouldSplit) return { kind: "single" };

  // Balance the looper/deliverer split PER OUTPUT ITEM, not over the lumped flow
  // of every outgoing edge. Otherwise a co-product recipe whose intra edges
  // include a secondary output would have that secondary's intra flow wrongly
  // subtracted from the primary's produced flow, collapsing the primary cross
  // flow to 0 and zeroing the deliverer.
  //
  // An output item is "split-driving" iff it has at least one intra consumer
  // AND at least one cross consumer. The synthetic target-output role counts as
  // a cross consumer on the primary output item. The >=2 split-driving case
  // (deferred co-product role-split) is unreached by any current plan.
  const intraItems = new Set(intraEdges.map((e) => e.item));
  const crossItems = new Set(crossEdges.map((e) => e.item));
  if (isTarget && primaryOutItem) crossItems.add(primaryOutItem);
  const drivingItems = [...intraItems].filter((i) => crossItems.has(i));

  if (drivingItems.length >= 2) {
    if (import.meta.env.DEV) {
      throw new Error(
        `assignSplitRoles: recipe producing "${primaryOutItem}" has ${drivingItems.length} ` +
          `split-driving output items [${drivingItems.join(", ")}]; the co-product ` +
          `role-split (decision STC-0007) is deferred and only a single split-driving ` +
          `item is supported.`,
      );
    }
    // Production fallback only (assertion tree-shaken in prod): the DEV
    // assertion is the real guard, so this never fires there. Pick one driving
    // item below deterministically so mass balance still holds without crashing.
  }

  // Pick the item to balance on:
  // - count>=1: a split-driving item. Prefer primaryOutItem when it is itself
  //   split-driving; else take the first driving item (deterministic, reached
  //   only in the DEV-asserted >=2 fallback above).
  // - count==0 (no split-driving item, but shouldSplit still held): fall back to
  //   primaryOutItem and balance its own intra flow against its produced flow.
  const driver = drivingItems.includes(primaryOutItem)
    ? primaryOutItem
    : (drivingItems[0] ?? primaryOutItem);

  // Driver item's intra flow: sum over its intra edges of
  // (consumer rate * in-qty).
  let intraFlow = new Fraction(0);
  for (const ie of intraEdges) {
    if (ie.item !== driver) continue;
    intraFlow = intraFlow.add(
      ie.consumerRate.mul(new Fraction(ie.consumerInQty)),
    );
  }
  // Produced rate of the driver output item.
  const driverOutQty = outQtys.get(driver) ?? 0;
  const producedFlow =
    driverOutQty > 0
      ? recipeRate.mul(new Fraction(driverOutQty))
      : new Fraction(0);
  // cross-flow is the driver's produced flow minus its intra flow, covering
  // both its graph-cross edges and the synthetic target output. The SCC linear
  // solve guarantees produced == intra + cross for the driver.
  let crossFlow = producedFlow.sub(intraFlow);
  // Clamp any tiny negative a solver round trip could in principle introduce.
  // The exact-rational flow solve makes this unreachable in practice; the clamp
  // records the invariant instead of silently dropping rate.
  if (crossFlow.compare(0) < 0) crossFlow = new Fraction(0);
  const totalFlow = intraFlow.add(crossFlow);

  const looperRate = totalFlow.equals(0)
    ? new Fraction(0)
    : recipeRate.mul(intraFlow).div(totalFlow);
  const delivererRate = recipeRate.sub(looperRate);

  // Filters are built in two passes, keyed by output item:
  //   - DRIVER item: keep the intra/cross split (intra edges -> looper, cross
  //     edges -> deliverer). The driver's intra consumers map to the loop
  //     fraction and its cross consumers to the ship fraction of the SAME item,
  //     so the split is rate-correct and preserves every currently-clean plan.
  //   - NON-DRIVER (co-product) items: route ALL of the item's edges (intra and
  //     cross) to the LIVE role -- deliverer when delivererRate>0, else looper.
  //     Routing a co-product by its OWN intra/cross class can land its edges on
  //     a rate-0 split (e.g. looperRate==0 when the driver has no intra flow),
  //     starving the co-product consumer of the live replica's share and
  //     surfacing the live producer's output as a phantom surplus. No current
  //     co-product is consumed BOTH intra and cross, so one live-role assignment
  //     is unambiguous; both roles would double-feed (tripping the over-fed check).
  const looperFilter = new Set<string>();
  const delivererFilter = new Set<string>();
  // liveFilter is the live role's filter: deliverer when delivererRate>0, else
  // looper. Under the shouldSplit gate at least one role rate is positive, so
  // liveFilter always points at a live replica. Non-driver (co-product) edges
  // all route here.
  const liveIsDeliverer = delivererRate.compare(0) > 0;
  const liveFilter = liveIsDeliverer ? delivererFilter : looperFilter;
  for (const ie of intraEdges) {
    if (ie.item === driver) {
      looperFilter.add(outgoingEdgeKey(ie.item, ie.target));
    } else {
      liveFilter.add(outgoingEdgeKey(ie.item, ie.target));
    }
  }
  for (const ce of crossEdges) {
    if (ce.item === driver) {
      delivererFilter.add(outgoingEdgeKey(ce.item, ce.target));
    } else {
      liveFilter.add(outgoingEdgeKey(ce.item, ce.target));
    }
  }
  // When isTarget is true with no cross edges, delivererFilter ends up empty.
  // The deliverer still owns the target-output role; the boundary-products pass
  // routes the target edge off this replica's stamps on its own.
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

// Emits an SCC's shared replicas once, returning the per-member replica ids
// keyed by recipe id; later calls return the cached mapping.
//
// When an SCC member has both an intra-SCC outgoing edge and a cross-boundary
// one (or is itself a target, so the boundary-products pass synthesizes a
// target output edge from its stamps), assignSplitRoles returns a split and this
// emits two replicas with distinct ids: a "looper" carrying the intra-SCC role
// and a "deliverer" carrying the cross-boundary role. Each replica's
// outgoingEdgeFilter scopes its edge fan-out to its role's edges. The returned
// map holds one replica id per recipe (the canonical "inputs-consumer", the
// looper when one exists); the second split replica goes into the replicas array
// as its own entry so assembleLogicalGraph and deriveReplicaEdges find it through
// the recipeId index.
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
  // Intra-SCC supply per (consumer member, item), in flow units. Filled while
  // walking each member's resolved intra edges below; the boundary recursion
  // hands it to splitConsumerDemand so external producers are minted net of
  // what the loop already supplies over the torn arc.
  const intraSupplyByMember = new Map<RecipeId, Map<string, Fraction>>();

  for (const rid of scc.recipeIds) {
    // Split the recipe's outgoing edges into intra-SCC and cross-boundary roles.
    // Intra edges resolve their consumer's per-edge rate and in-qty here so
    // assignSplitRoles stays graph-free. The target-output role is a virtual
    // cross-boundary signal that fires when this recipe is a user-declared target
    // (the boundary-products pass later synthesizes a target output edge from its
    // stamps). An edge whose consumer can't be resolved (missing node or no
    // matching in-stoich) is emitted with zero stoichiometry, so the looperFilter
    // still gets the edge key while the flow loop sees a zero contribution -
    // identical to the earlier null-skip-but-always-include-in-filter behavior.
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
    const primaryOutItem = recipe?.out[0]?.item ?? "";
    const outQtys = new Map<string, number>();
    for (const o of recipe?.out ?? []) outQtys.set(o.item, o.qty);
    // Accumulate this member's intra supply to its intra consumers. An item's
    // available intra flow is the member's production net of its declared
    // target draw (the target output claims production first, mirroring the
    // splitConsumerDemand weight deduction), capped by the intra consumers'
    // total demand; multiple intra consumers split it in proportion to their
    // demand. Demand-less items contribute nothing.
    // Output shipped cross-boundary is not subtracted here: the split model
    // feeds intra consumers first (mirroring assignSplitRoles' intraFlow), so
    // cross flow is the remainder after intra demand, never a prior claim.
    const intraEdgesByItem = new Map<string, ResolvedIntraEdge[]>();
    for (const ie of intraEdges) {
      const arr = intraEdgesByItem.get(ie.item) ?? [];
      arr.push(ie);
      intraEdgesByItem.set(ie.item, arr);
    }
    for (const [item, ies] of intraEdgesByItem) {
      let totalDemand = new Fraction(0);
      for (const ie of ies) {
        totalDemand = totalDemand.add(
          ie.consumerRate.mul(new Fraction(ie.consumerInQty)),
        );
      }
      if (totalDemand.compare(0) <= 0) continue;
      let netProd = recipeRate.mul(new Fraction(outQtys.get(item) ?? 0));
      const draw = state.targetDraw.get(rid);
      if (draw !== undefined && primaryOutItem === item) {
        netProd = netProd.sub(draw);
        if (netProd.compare(0) < 0) netProd = new Fraction(0);
      }
      const avail =
        netProd.compare(totalDemand) < 0 ? netProd : totalDemand;
      if (avail.compare(0) <= 0) continue;
      for (const ie of ies) {
        const share = ie.consumerRate
          .mul(new Fraction(ie.consumerInQty))
          .div(totalDemand);
        const perItem =
          intraSupplyByMember.get(ie.target) ?? new Map<string, Fraction>();
        perItem.set(
          item,
          (perItem.get(item) ?? new Fraction(0)).add(avail.mul(share)),
        );
        intraSupplyByMember.set(ie.target, perItem);
      }
    }
    const decision = assignSplitRoles({
      recipeRate,
      primaryOutItem,
      outQtys,
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
    // below use it to walk upstream. The deliverer is still its own replica, and
    // assembleLogicalGraph picks it up through the recipeId index.
    map.set(rid, looper.id);
  }

  state.sccMemberReplicas.set(sid, map);
  state.sccCreated.add(sid);

  // Queue the boundary-input recursion: for each member, split its demand across
  // the EXTERNAL producers of each input item (sources outside this SCC) by LP
  // rate share, then enqueue one frame per producer. The split keeps a member fed
  // by a multi-producer input from over-producing: each external producer gets
  // its share, not the full rate. Intra-SCC producers are served by the
  // looper/deliverer split above and excluded from the boundary frames.
  // Demand already supplied intra-SCC (the torn-arc share, accumulated above)
  // is deducted per item, so an external producer of a dual-fed input covers
  // only the residual demand.
  for (const memberId of scc.recipeIds) {
    const memberReplicaId = map.get(memberId)!;
    const memberNode = state.g.nodes.get(memberId);
    if (!memberNode) continue;
    const memberRate = state.rates.get(memberId) ?? new Fraction(0);
    const external = (state.g.incoming.get(memberId) ?? []).filter(
      (e) => !members.has(e.source),
    );
    for (const { edge, consumerRate } of splitConsumerDemand(
      state.g.nodes,
      state.rates,
      memberNode,
      external,
      memberRate,
      state.targetDraw,
      intraSupplyByMember.get(memberId),
    )) {
      state.boundaryEdges.push({
        producerId: edge.source,
        producerItem: edge.item,
        consumerId: memberId,
        consumerReplicaId: memberReplicaId,
        consumerRate,
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

// Handles one (producer, consumer, item) edge, called once per traversed edge by
// walkFromTargets. Not a public seam: it owns the four producer cases and their
// state mutations, and sits above walkFromTargets so top-to-bottom reading
// matches call order. Dispatch order: SCC, AP, byproduct-shared, non-shared.
//
// The four cases:
//   - SCC member: hand off to ensureSccReplicas for lazy emission; it enqueues
//                 boundary edges as needed.
//   - AP-shared:  emit one shared replica on first reach and push one upstream
//                 frame.
//   - Byproduct-shared: supplies a multi-member SCC member across the boundary
//                 via a non-primary output. Emit one shared replica at full LP
//                 rate and push one upstream frame, like the AP-shared branch.
//   - Non-shared: emit a per-consumer replica scaled by this consumer's share,
//                 then push an upstream frame inheriting the consumer's group.
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

  // Seeded-target producer: this recipe is also a target, already materialized
  // once at the full LP rate (which covers its own target output plus every
  // internal consumer). Reuse that replica and mark it shared so
  // assembleLogicalGraph fans its output to this consumer too, instead of minting
  // a second copy that would double-produce the item and spill the leftover as a
  // phantom surplus. Covers a target that is also an articulation point or a
  // plain per-consumer producer; the byproduct-shared overlap is deduped at seed.
  const seededTarget = state.targetSeeded.get(producerId);
  if (seededTarget) {
    seededTarget.sharedAtArticulation = true;
    return;
  }

  // SCC producer: emit the shared SCC member replicas lazily. No per-consumer
  // recursion into individual members; ensureSccReplicas queues the boundary
  // edges.
  if (isInScc(state, producerId)) {
    const sid = sccIdOf(state, producerId);
    if (!state.sccCreated.has(sid)) {
      ensureSccReplicas(state, sid);
    }
    return;
  }

  // Articulation-point producer: emit one shared replica, then walk its inputs
  // once.
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
      // Walk upstream from this shared producer once.
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

  // Byproduct-supplier producer: feeds an SCC member across the boundary for a
  // byproduct output, so its run rate is set by primary-output demand, not the
  // byproduct demand. Emit one shared replica at full LP rate (no
  // outgoingEdgeFilter, so assembleLogicalGraph fans it to every consumer,
  // primary and byproduct alike) and walk its inputs once, like the AP-shared
  // branch. Every reach routes here, so the primary path and the boundary path
  // converge on the one shared replica instead of double-minting per-consumer
  // copies and re-walking its input chain.
  if (state.byproductSharedSources.has(producerId)) {
    let shared = state.byproductShared.get(producerId);
    if (!shared) {
      const sharedRate = state.rates.get(producerId) ?? new Fraction(0);
      // Reuse the apShared group role: both have emit-once shared semantics, and
      // blueprintGroupId is only for grouping (not dispatch), so the resulting
      // `shared:<id>` group id is fine and needs no new GroupRole variant.
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
      state.byproductShared.set(producerId, shared);
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

  // Non-shared producer: a per-consumer replica scaled by this consumer
  // replica's share, not the recipe's global rate.
  const inItem = consumerRecipe.in.find((x) => x.item === producerItem);
  const outItem = producerRecipe.out.find((x) => x.item === producerItem);
  if (!inItem || !outItem) return;
  // Guard malformed data: a zero/negative/NaN output qty would throw on the
  // divide below. Mirrors the floor-pin guard in lp.ts.
  if (!(outItem.qty > 0)) return;
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

// Drives the whole replication. Seeds a replica per target (or shares the
// member's SCC when the target lives inside one), then drains the frame stack
// and the boundary-edge queue interleaved. Each frame runs its consumer's inputs
// through processProducer.
function walkFromTargets(state: ReplicateState): void {
  // Declared draw per seeded target recipe: production claimed by the target
  // output product. splitConsumerDemand deducts it from that producer's weight,
  // matching the full-rate pin the targetSeeded guard applies in
  // processProducer. SCC-resident targets are included too: the looper/deliverer
  // decision rates derive from the SCC flow solve (intra vs cross flow), so a
  // target whose output is fully looped ships zero across the boundary to
  // non-target consumers. Without the deduct its full LP rate is counted as a
  // split weight there, share-shrinking a co-producing external sibling that
  // must carry the residual demand at its full LP rate.
  for (const t of state.targets) {
    const recipeId = t.recipeId;
    if (!state.g.nodes.has(recipeId)) continue;
    const declared = new Fraction(
      `${t.ratePerSec.num}/${t.ratePerSec.denom}`,
    );
    state.targetDraw.set(
      recipeId,
      (state.targetDraw.get(recipeId) ?? new Fraction(0)).add(declared),
    );
  }

  // Seed the walk: emit a replica per target (or its SCC group) and enqueue the
  // upstream recursion.
  for (const t of state.targets) {
    const recipeId = t.recipeId;
    if (!state.g.nodes.has(recipeId)) continue;
    if (isInScc(state, recipeId)) {
      const sid = sccIdOf(state, recipeId);
      if (!state.sccCreated.has(sid)) {
        ensureSccReplicas(state, sid);
      }
      // The target is the SCC member's replica; ensureSccReplicas already queued
      // the boundary-edge work.
      continue;
    }
    const targetGroupId = propagateGroups({ kind: "target", recipeId });
    const targetRate = state.rates.get(recipeId) ?? new Fraction(0);
    // A target recipe can ALSO be a byproduct-shared source: a non-primary
    // output feeds a multi-member SCC across the boundary (e.g. copper_enr is a
    // target while its byproduct liquid_sewage feeds the liquid_xiranite loop).
    // Without this guard the target is seeded here AND minted again by the
    // byproduct-shared branch in processProducer when the SCC boundary reaches
    // it, so its whole upstream chain replicates twice. Emit it once as a shared
    // replica and register it in the byproductShared cache so a later reach
    // reuses it instead of re-walking the chain; the shared flag also fans its
    // byproduct output to every SCC consumer.
    //
    // The byproduct-shared overlap is deduped here so the shared flag is set
    // before the SCC boundary reach. Every OTHER target-that-is-also-a-producer
    // overlap (the target is an articulation point, or a plain per-consumer
    // producer) is deduped lazily by the targetSeeded guard at the top of
    // processProducer, which reuses this replica and marks it shared on first
    // reach instead of minting a second copy.
    const isByproductShared = state.byproductSharedSources.has(recipeId);
    const rep: Replica = {
      id: newReplicaId(state, `r:${recipeId}`),
      recipeId,
      executionRate: targetRate,
      consumerPath: [],
      blueprintGroupId: targetGroupId,
      sharedAtArticulation: isByproductShared,
    };
    state.replicas.push(rep);
    if (isByproductShared) state.byproductShared.set(recipeId, rep);
    state.targetSeeded.set(recipeId, rep);
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
    // Clear pending boundary edges (from SCC emissions) first so the SCC
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
    const incoming = state.g.incoming.get(frame.consumerId) ?? [];
    // Split this consumer's demand across each input item's producers by LP rate
    // share; single-producer items degenerate to the full rate.
    for (const { edge, consumerRate } of splitConsumerDemand(
      state.g.nodes,
      state.rates,
      consumer,
      incoming,
      frame.consumerRate,
      state.targetDraw,
    )) {
      processProducer(state, {
        producerId: edge.source,
        producerItem: edge.item,
        consumerId: frame.consumerId,
        consumerReplicaId: frame.consumerReplicaId,
        consumerRate,
        consumerGroupId: frame.blueprintGroupId,
        consumerPath: frame.consumerPath,
      });
    }
  }
}
