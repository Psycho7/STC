import type { Recipe } from "@aef/schema";
import type {
  LogicalEdge,
  LogicalGraph,
  LogicalGroupNode,
  LogicalRecipeNode,
} from "../canvas/layout";
import type {
  Condensation,
  RecipeGraph,
  Replica,
  ReplicaId,
  TornEdge,
} from "./types";
import { wireConnections } from "./wiring";
import { logicalNodeIdForReplica } from "./replicate";

/**
 * Translates the solver's output (replicas, multipliers, torn edges) into the
 * LogicalGraph the canvas consumes: one group per unique blueprintGroupId, one
 * recipe node per surviving replica, one edge per (producer-replica,
 * consumer-replica, item), and one return-arc edge per torn SCC edge.
 */
export function assembleLogicalGraph(args: {
  replicas: Replica[];
  multipliers: Map<ReplicaId, number>;
  condensation: Condensation;
  recipeById: Map<string, Recipe>;
  g: RecipeGraph;
  torn: TornEdge[];
}): LogicalGraph {
  const { replicas, multipliers, condensation, recipeById, g, torn } = args;

  // Keep only replicas that survived the multiplier pass; zero-rate ones never
  // made it into the multipliers map and are dropped here.
  const surviving = replicas.filter((r) => multipliers.has(r.id));
  const survivingIds = new Set(surviving.map((r) => r.id));

  // One group node per unique blueprintGroupId.
  const groupIds = new Set<string>();
  for (const r of surviving) {
    if (r.blueprintGroupId) groupIds.add(r.blueprintGroupId);
  }
  const groupNodes: LogicalGroupNode[] = [];
  for (const gid of groupIds) {
    groupNodes.push({
      kind: "group",
      id: gid,
      label: labelForGroup(gid, recipeById),
    });
  }

  // One recipe node per surviving replica.
  const recipeNodes: LogicalRecipeNode[] = [];
  for (const r of surviving) {
    const recipe = recipeById.get(r.recipeId);
    if (!recipe) continue;
    const node: LogicalRecipeNode = {
      kind: "recipe",
      id: logicalNodeIdForReplica(r.id),
      recipe,
      multiplier: multipliers.get(r.id) ?? 1,
      expanded: false,
    };
    if (r.blueprintGroupId) node.parentId = r.blueprintGroupId;
    recipeNodes.push(node);
  }

  // Wire the replication edges through the shared replica-wiring rule (see
  // wiring.ts for the routing semantics: filter ownership, shared fan-out,
  // consumerPath designation, split-sibling fan, torn return arcs, and the
  // dropped-stamp re-route pass), then render each connection as a LogicalEdge.
  const connections = wireConnections(g, replicas, {
    live: (id) => survivingIds.has(id),
    torn,
    condensation,
  });
  const edges: LogicalEdge[] = connections.map((c) =>
    c.kind === "returnArc"
      ? buildReturnArc(c.producerId, c.consumerId, c.item)
      : buildEdge(c.producerId, c.consumerId, c.item),
  );

  return { nodes: [...groupNodes, ...recipeNodes], edges };
}

function buildEdge(pId: ReplicaId, cId: ReplicaId, item: string): LogicalEdge {
  const source = logicalNodeIdForReplica(pId);
  const target = logicalNodeIdForReplica(cId);
  return {
    id: `${source}->${target}:${item}`,
    source,
    target,
    sourcePort: `out:${item}`,
    targetPort: `in:${item}`,
  };
}

function buildReturnArc(
  pId: ReplicaId,
  cId: ReplicaId,
  item: string,
): LogicalEdge {
  const source = logicalNodeIdForReplica(pId);
  const target = logicalNodeIdForReplica(cId);
  return {
    id: `${source}->return->${target}:${item}`,
    source,
    target,
    sourcePort: `out:${item}`,
    targetPort: `in:${item}`,
  };
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
    // Two shapes: "shared:<recipeId>" for an articulation-shared replica from
    // replicate.ts, and "shared:<recipeId>#<classIndex>" for a bisim cross-group
    // merged class. Strip any trailing "#<digits>" to recover the recipeId.
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
