import Fraction from "fraction.js";
import type { LogicalGraph } from "../canvas/layout";
import type { Recipe, RecipePack } from "@aef/schema";
import type { TransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { buildRecipeGraph } from "./graph";
import { tarjanScc, condense } from "./scc";
import { topologicalOrder } from "./topo";
import { walkAndSolve } from "./walk";
import { articulationPoints } from "./bctree";
import { pickTearEdges } from "./tear";
import { replicatePerConsumer } from "./replicate";
import { assignIdealMultipliers, assignMultipliers } from "./multiplier";
import { ffdPack } from "./ffd";
import { assembleLogicalGraph } from "./assemble";
import { bisimQuotient, deriveReplicaEdges, type ClassId } from "./bisim";
import type {
  Condensation,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  TornEdge,
} from "./types";

function runBisim(
  g: RecipeGraph,
  rawReplicas: Replica[],
): {
  replicas: Replica[];
  classByReplicaId: Map<ReplicaId, ClassId>;
  classToQuotient: Map<ClassId, ReplicaId>;
} {
  const rawEdges = deriveReplicaEdges(g, rawReplicas);
  const pinnedReplicaIds = new Set(
    rawReplicas.filter((r) => r.sharedAtArticulation).map((r) => r.id),
  );
  // bisimQuotient also produces `quotientEdges` aggregated over (sourceClass,
  // targetClass, item). We don't thread that into SolvePlanFull right now,
  // since downstream stages rebuild per-pair flow rates from
  // assembleLogicalGraph's edge list. It stays on the bisim public API because
  // the planned K-stamps count badge will want it.
  const { quotientReplicas, classByReplicaId, classToQuotient } = bisimQuotient(
    {
      replicas: rawReplicas,
      edges: rawEdges,
      pinnedReplicaIds,
    },
  );
  return { replicas: quotientReplicas, classByReplicaId, classToQuotient };
}

/**
 * Full solver output, returned by `solvePlanWithIntermediates` for callers
 * that feed the render pipeline. `logical` is the same LogicalGraph `solvePlan`
 * returns; the extra fields expose the intermediates the cluster, expand,
 * bisim, and render stages need.
 */
export type SolvePlanFull = {
  logical: LogicalGraph;
  replicas: Replica[];
  multipliers: Map<ReplicaId, number>;
  condensation: Condensation;
  torn: TornEdge[];
  recipeById: Map<RecipeId, Recipe>;
  /**
   * Per-recipe execution rate from walkAndSolve. Zero-rate recipes drop out of
   * `replicas` (the multipliers map gates them), but this map stays complete so
   * callers can derive per-edge rates without re-running the flow solve.
   */
  rates: Map<RecipeId, Fraction>;
  /**
   * Exact rational machine count per replica, before the ceiling is taken.
   * It runs in parallel with `multipliers` (which holds the ceiled integer
   * count) so downstream stages can fold equivalent replicas on the
   * pre-ceiling rate.
   */
  idealCount: Map<ReplicaId, Fraction>;
  classByReplicaId: Map<ReplicaId, ClassId>;
  /** ClassId -> quotient replica id ("q:N"). Paired with classByReplicaId so
   *  canvas highlighting can map a hovered quotient node back to the set of
   *  original replica ids in its class.
   */
  classToQuotient: Map<ClassId, ReplicaId>;
};

export function solvePlan(
  targets: Target[],
  pack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides?: ItemOverride[],
): LogicalGraph {
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  const g = buildRecipeGraph(targets, pack, itemOverrides);
  const sccs = tarjanScc(g);
  const c = condense(g, sccs);
  const topo = topologicalOrder(c);
  const { rates, tornFlow } = walkAndSolve({
    g,
    condensation: c,
    topo,
    targets,
    pack,
    itemOverrides: itemOverrides ?? [],
  });
  const aps = articulationPoints(g);
  const rawReplicas = replicatePerConsumer({
    g,
    articulation: aps,
    rates,
    condensation: c,
    targets,
  });
  const { replicas } = runBisim(g, rawReplicas);
  const multipliers = assignMultipliers(replicas, machineById, recipeById);
  // solvePlan skips assignIdealMultipliers (and its idealCount map) on
  // purpose: this entry point returns only a LogicalGraph and never feeds the
  // render pipeline's expandMultipliers stage, so the fractional ideal count
  // would just be thrown away. solvePlanWithIntermediates is the one that needs
  // both maps.
  const lanes = ffdPack(replicas, itemById, recipeById, tConfig);

  // Rebuild the TornEdge[] that assembleLogicalGraph needs. walkAndSolve only
  // hands back tornFlow values keyed by id, but return-arc rendering needs the
  // full TornEdge objects with their .edge and .sccId fields. AEF has just a
  // handful of non-trivial SCCs, so re-running pickTearEdges costs almost
  // nothing.
  const torn: TornEdge[] = [];
  for (const scc of sccs) {
    if (scc.recipeIds.length > 1) {
      torn.push(...pickTearEdges(scc, g));
    }
  }

  return assembleLogicalGraph({
    replicas,
    multipliers,
    lanes,
    tornEdges: [...tornFlow.keys()],
    condensation: c,
    recipeById,
    g,
    torn,
  });
}

/**
 * Mirrors `solvePlan` but also returns the intermediate artifacts the render
 * pipeline (cluster, expand, bisim, render) needs. It's a separate entry point
 * so existing callers and tests of `solvePlan` stay untouched; the computation
 * is the same and only the return shape differs.
 */
export function solvePlanWithIntermediates(
  targets: Target[],
  pack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides?: ItemOverride[],
): SolvePlanFull {
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  const g = buildRecipeGraph(targets, pack, itemOverrides);
  const sccs = tarjanScc(g);
  const c = condense(g, sccs);
  const topo = topologicalOrder(c);
  const { rates, tornFlow } = walkAndSolve({
    g,
    condensation: c,
    topo,
    targets,
    pack,
    itemOverrides: itemOverrides ?? [],
  });
  const aps = articulationPoints(g);
  const rawReplicas = replicatePerConsumer({
    g,
    articulation: aps,
    rates,
    condensation: c,
    targets,
  });
  const { replicas, classByReplicaId, classToQuotient } = runBisim(
    g,
    rawReplicas,
  );
  const multipliers = assignMultipliers(replicas, machineById, recipeById);
  const idealCount = assignIdealMultipliers(replicas, machineById, recipeById);
  const lanes = ffdPack(replicas, itemById, recipeById, tConfig);

  const torn: TornEdge[] = [];
  for (const scc of sccs) {
    if (scc.recipeIds.length > 1) {
      torn.push(...pickTearEdges(scc, g));
    }
  }

  const logical = assembleLogicalGraph({
    replicas,
    multipliers,
    lanes,
    tornEdges: [...tornFlow.keys()],
    condensation: c,
    recipeById,
    g,
    torn,
  });

  return {
    logical,
    replicas,
    multipliers,
    condensation: c,
    torn,
    recipeById,
    rates,
    idealCount,
    classByReplicaId,
    classToQuotient,
  };
}
