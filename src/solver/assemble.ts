import type { Recipe } from "@aef/schema";
import type {
  LaneMetadata,
  LogicalEdge,
  LogicalGraph,
  LogicalGroupNode,
  LogicalRecipeNode,
} from "../canvas/layout";
import type {
  Condensation,
  PackedLane,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  TornEdge,
  TornEdgeId,
} from "./types";
import { outgoingEdgeKey } from "./types";

/**
 * The replication pass mints replica ids of the form `r:<recipeId>#<counter>`,
 * using `#` as the separator. The canvas layout treats `#` as a stamp suffix
 * marker (see stripStampSuffix in src/canvas/layout.ts), so handing a replica
 * id straight through as LogicalRecipeNode.id breaks node lookup once layout
 * runs. Swapping `#` for `~`, which the layout pipeline ignores, sidesteps the
 * collision.
 */
function safeId(replicaId: ReplicaId): string {
  return replicaId.replace(/#/g, "~");
}

/**
 * Translates the solver's output (replicas, multipliers, torn edges) into the
 * LogicalGraph the canvas consumes. The result has one group per unique
 * blueprintGroupId, one recipe node per surviving replica, one edge per
 * (producer-replica, consumer-replica, item) pairing, and one extra return-arc
 * edge for each torn SCC edge.
 */
export function assembleLogicalGraph(args: {
  replicas: Replica[];
  multipliers: Map<ReplicaId, number>;
  lanes: PackedLane[];
  tornEdges: TornEdgeId[];
  condensation: Condensation;
  recipeById: Map<string, Recipe>;
  g: RecipeGraph;
  torn: TornEdge[];
}): LogicalGraph {
  const { replicas, multipliers, lanes, condensation, recipeById, g, torn } =
    args;
  void args.tornEdges;

  // Keep only the replicas that survived the multiplier pass; zero-rate ones
  // never made it into the multipliers map and are dropped here.
  const surviving = replicas.filter((r) => multipliers.has(r.id));
  const survivingIds = new Set(surviving.map((r) => r.id));

  // Bucket the packed lanes by group so each LogicalGroupNode can carry its
  // own lane metadata. A lane whose only stream was dropped along with its
  // replica still comes back from ffdPack, so filter to surviving streams.
  const lanesByGroup = new Map<string, LaneMetadata[]>();
  for (const lane of lanes) {
    const liveStreams = lane.streams.filter((s) =>
      survivingIds.has(s.replicaId),
    );
    if (liveStreams.length === 0) continue;
    const meta: LaneMetadata = {
      carrier: lane.carrier,
      laneIndex: lane.laneIndex,
      overflow: lane.overflow,
      streams: liveStreams.map((s) => ({
        replicaId: s.replicaId,
        itemId: s.itemId,
        itemsPerSec: s.itemsPerSec.toFraction(),
      })),
    };
    const arr = lanesByGroup.get(lane.groupId) ?? [];
    arr.push(meta);
    lanesByGroup.set(lane.groupId, arr);
  }

  // Build the group nodes, one per unique blueprintGroupId, attaching lane
  // metadata whenever the packer produced lanes for that group.
  const groupIds = new Set<string>();
  for (const r of surviving) {
    if (r.blueprintGroupId) groupIds.add(r.blueprintGroupId);
  }
  const groupNodes: LogicalGroupNode[] = [];
  for (const gid of groupIds) {
    const node: LogicalGroupNode = {
      kind: "group",
      id: gid,
      label: labelForGroup(gid, recipeById),
    };
    const groupLanes = lanesByGroup.get(gid);
    if (groupLanes && groupLanes.length > 0) node.lanes = groupLanes;
    groupNodes.push(node);
  }

  // One recipe node per surviving replica.
  const recipeNodes: LogicalRecipeNode[] = [];
  for (const r of surviving) {
    const recipe = recipeById.get(r.recipeId);
    if (!recipe) continue;
    const node: LogicalRecipeNode = {
      kind: "recipe",
      id: safeId(r.id),
      recipe,
      multiplier: multipliers.get(r.id) ?? 1,
      expanded: false,
    };
    if (r.blueprintGroupId) node.parentId = r.blueprintGroupId;
    recipeNodes.push(node);
  }

  // Index the surviving replicas by recipeId so edge wiring can look them up.
  const replicasByRecipeId = new Map<RecipeId, Replica[]>();
  for (const r of surviving) {
    const arr = replicasByRecipeId.get(r.recipeId) ?? [];
    arr.push(r);
    replicasByRecipeId.set(r.recipeId, arr);
  }

  // Track torn edges so we don't emit them twice, once as a normal edge and
  // once as a return arc. The key is (sccId, source, target, item).
  const tornKey = (
    sccId: string,
    source: string,
    target: string,
    item: string,
  ): string => `${sccId}|${source}|${target}|${item}`;
  const tornSet = new Set<string>();
  for (const te of torn) {
    tornSet.add(
      tornKey(te.sccId, te.edge.source, te.edge.target, te.edge.item),
    );
  }

  // Helpers for asking which SCC a recipe belongs to, and whether two recipes
  // sit in the same non-trivial SCC.
  const sccOf = (rid: RecipeId): string | undefined =>
    condensation.sccOfRecipe.get(rid);
  const isSameScc = (a: RecipeId, b: RecipeId): boolean => {
    const sa = sccOf(a);
    const sb = sccOf(b);
    if (sa === undefined || sb === undefined) return false;
    if (sa !== sb) return false;
    const scc = condensation.sccs.find((s) => s.id === sa);
    return !!scc && scc.recipeIds.length > 1;
  };

  // Wire up the replication edges: walk the graph edges and pair each
  // producer replica with the consumer replica it feeds, respecting
  // per-consumer scoping.
  const edges: LogicalEdge[] = [];
  for (const [pRid, outEdges] of g.outgoing) {
    for (const e of outEdges) {
      const cRid = e.target;
      const item = e.item;
      const producers = replicasByRecipeId.get(pRid) ?? [];
      const consumers = replicasByRecipeId.get(cRid) ?? [];
      if (producers.length === 0 || consumers.length === 0) continue;

      // A torn SCC edge gets emitted below as a return arc, so skip it here.
      const sharedScc = isSameScc(pRid, cRid) ? sccOf(pRid) : undefined;
      if (
        sharedScc !== undefined &&
        tornSet.has(tornKey(sharedScc, pRid, cRid, item))
      ) {
        continue;
      }

      for (const P of producers) {
        if (!survivingIds.has(P.id)) continue;
        // An SCC-member replica may have been split by outgoing-edge role.
        // When `outgoingEdgeFilter` is set, the replica owns only the listed
        // (item, target-recipe) edges, so skip any edge it does not own.
        if (
          P.outgoingEdgeFilter !== undefined &&
          !P.outgoingEdgeFilter.has(outgoingEdgeKey(item, cRid))
        ) {
          continue;
        }
        if (P.sharedAtArticulation) {
          // A shared producer (articulation point or SCC member) feeds every
          // consumer replica for this recipe.
          for (const C of consumers) {
            if (!survivingIds.has(C.id)) continue;
            edges.push(buildEdge(P.id, C.id, item));
          }
        } else {
          // A per-consumer producer only feeds the one consumer replica it
          // was created for.
          const last = P.consumerPath[P.consumerPath.length - 1];
          if (!last) continue;
          const C = consumers.find((c) => c.id === last);
          if (!C || !survivingIds.has(C.id)) continue;
          edges.push(buildEdge(P.id, C.id, item));
        }
      }
    }
  }

  // Finally, emit one return-arc edge for each torn SCC edge.
  for (const te of torn) {
    const srcReplica = pickSccMemberReplica(
      te.edge.source,
      replicasByRecipeId,
      te.edge.item,
      te.edge.target,
    );
    const tgtReplica = pickSccMemberReplica(te.edge.target, replicasByRecipeId);
    if (!srcReplica || !tgtReplica) continue;
    if (!survivingIds.has(srcReplica.id) || !survivingIds.has(tgtReplica.id))
      continue;
    const source = safeId(srcReplica.id);
    const target = safeId(tgtReplica.id);
    edges.push({
      id: `${source}->return->${target}:${te.edge.item}`,
      source,
      target,
      sourcePort: `out:${te.edge.item}`,
      targetPort: `in:${te.edge.item}`,
    });
  }

  return { nodes: [...groupNodes, ...recipeNodes], edges };
}

function buildEdge(pId: ReplicaId, cId: ReplicaId, item: string): LogicalEdge {
  const source = safeId(pId);
  const target = safeId(cId);
  return {
    id: `${source}->${target}:${item}`,
    source,
    target,
    sourcePort: `out:${item}`,
    targetPort: `in:${item}`,
  };
}

function pickSccMemberReplica(
  recipeId: RecipeId,
  replicasByRecipeId: Map<RecipeId, Replica[]>,
  edgeItem?: string,
  edgeTarget?: RecipeId,
): Replica | undefined {
  const arr = replicasByRecipeId.get(recipeId);
  if (!arr || arr.length === 0) return undefined;
  // SCC member replicas are emitted once per recipe with
  // sharedAtArticulation=true. When the caller supplies an edge context
  // (item, target), pick the split replica whose outgoingEdgeFilter owns that
  // edge; this is how a torn-edge return arc attaches to the looper replica
  // that actually carries the loop edge.
  if (edgeItem !== undefined && edgeTarget !== undefined) {
    const key = outgoingEdgeKey(edgeItem, edgeTarget);
    const owner = arr.find(
      (r) =>
        r.sharedAtArticulation &&
        r.outgoingEdgeFilter !== undefined &&
        r.outgoingEdgeFilter.has(key),
    );
    if (owner) return owner;
  }
  const shared = arr.find((r) => r.sharedAtArticulation);
  return shared ?? arr[0];
}

function labelForGroup(
  groupId: string,
  recipeById: Map<string, Recipe>,
): string {
  if (groupId.startsWith("target:")) {
    const rid = groupId.slice("target:".length);
    return recipeById.get(rid)?.name ?? groupId;
  }
  if (groupId.startsWith("shared:")) {
    // The id comes in two shapes: "shared:<recipeId>" for an
    // articulation-shared replica from replicate.ts, and
    // "shared:<recipeId>#<classIndex>" for a bisim cross-group merged class.
    // Strip any trailing "#<digits>" to recover the recipeId.
    const rid = groupId.slice("shared:".length).replace(/#\d+$/, "");
    const name = recipeById.get(rid)?.name;
    return name ? `Shared: ${name}` : groupId;
  }
  if (groupId.startsWith("scc:")) {
    const sid = groupId.slice("scc:".length);
    return `Loop: ${sid}`;
  }
  return groupId;
}
