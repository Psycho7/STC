import Fraction from "fraction.js";
import type { LogicalGraph } from "../canvas/layout";
import type { Recipe, RecipePack } from "@aef/schema";
import type { TransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { augmentGraphWithLpSupport, buildRecipeGraphMulti } from "./graph";
import { tarjanScc, condense } from "./scc";
import { solveLp, type LpResult, type LpSolver } from "./lp";
import { articulationPoints } from "./bctree";
import { pickTearEdges } from "./tear";
import { replicatePerConsumer } from "./replicate";
import { assignIdealMultipliers, assignMultipliers } from "./multiplier";
import { ffdPack } from "./ffd";
import { assembleLogicalGraph } from "./assemble";
import { bisimQuotient, deriveReplicaEdges, type ClassId } from "./bisim";
import { assertInvariants } from "./invariants";
import type {
  Condensation,
  ItemId,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  TornEdge,
} from "./types";

// Turn the LP outcome into a hard error for the unsolvable cases. "empty" (a
// feasible optimum running no recipe) and "feasible" both proceed; only
// "infeasible"/"unbounded" abort.
function assertSolvable(status: LpResult["status"]): void {
  switch (status) {
    case "infeasible":
      throw new Error("LP solver: infeasible problem");
    case "unbounded":
      throw new Error("LP solver: unbounded objective");
    case "empty":
    case "feasible":
      return;
  }
}

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
  // targetClass, item). We don't thread that into SolvePlanFull: downstream
  // stages rebuild per-pair flow rates from assembleLogicalGraph's edge list. It
  // stays on the bisim public API for a future K-stamps count badge.
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
 * Full solver output, returned by `solvePlanWithIntermediates` for callers that
 * feed the render pipeline. `logical` is the LogicalGraph `solvePlan` returns;
 * the extra fields expose the intermediates the cluster, expand, bisim, and
 * render stages need.
 */
export type SolvePlanFull = {
  logical: LogicalGraph;
  replicas: Replica[];
  multipliers: Map<ReplicaId, number>;
  condensation: Condensation;
  torn: TornEdge[];
  recipeById: Map<RecipeId, Recipe>;
  /**
   * Per-recipe execution rate from the LP solver. Zero-rate recipes drop out of
   * `replicas` (gated by the multipliers map), but this map stays complete so
   * callers can derive per-edge rates without re-running the flow solve.
   */
  rates: Map<RecipeId, Fraction>;
  /**
   * Exact rational machine count per replica, before the ceiling. Runs in
   * parallel with `multipliers` (the ceiled integer count) so downstream stages
   * can fold equivalent replicas on the pre-ceiling rate.
   */
  idealCount: Map<ReplicaId, Fraction>;
  classByReplicaId: Map<ReplicaId, ClassId>;
  /** ClassId -> quotient replica id ("q:N"). Paired with classByReplicaId so
   *  canvas highlighting can map a hovered quotient node back to the original
   *  replica ids in its class.
   */
  classToQuotient: Map<ClassId, ReplicaId>;
  /**
   * Feasibility summary from the LP result. `softFeasible` is false when any
   * material demand stayed unmet; `deficits` lists each unmet item and its
   * shortfall. Surfaced so the render/UI layer can show an unsatisfiable plan
   * instead of silent success.
   */
  feasibility: {
    softFeasible: boolean;
    deficits: Map<ItemId, Fraction>;
  };
  /**
   * Committed producer-recipe -> consumer-recipe item flow (items/s), keyed by
   * `supplyShareKey` from replicate.ts. Recorded for SHARED producers only;
   * the render driver uses it as the per-consumer demand-split weight in
   * computeEdgeRates (absent keys fall back to production-share weighting).
   */
  supplyShares: Map<string, Fraction>;
};

// Shared pipeline behind both entry points. Runs the full solve (graph build,
// SCC condensation, LP solve, replication, bisim, multiplier assignment, FFD
// packing, tear-edge rebuild, logical-graph assembly) and returns the assembled
// SolvePlanFull plus the raw LpResult. It does NOT run the dev-only invariant
// assertions; those stay with solvePlanWithIntermediates so solvePlan keeps its
// lighter contract.
//
// The TornEdge[] is rebuilt here because the LP solver returns no torn-edge
// metadata; return-arc rendering needs the full TornEdge objects with their
// .edge and .sccId fields. AEF has only a handful of non-trivial SCCs, so re-
// running pickTearEdges costs almost nothing.
function runSolvePipeline(
  targets: Target[],
  pack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides: ItemOverride[] | undefined,
  recipeCosts: Map<RecipeId, number> | undefined,
  solver: LpSolver,
): { full: SolvePlanFull; lpResult: LpResult } {
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  const g = buildRecipeGraphMulti(targets, pack, itemOverrides);
  const lpResult = solver({
    targets,
    pack,
    itemOverrides: itemOverrides ?? [],
    ...(recipeCosts !== undefined && { recipeCosts }),
  });
  assertSolvable(lpResult.status);
  const rates = lpResult.rates;
  // Close graph membership over the LP support before any graph-derived
  // structure is computed: a disposal absorber the LP runs is unreachable from
  // the target cone and would otherwise be missing from the render entirely.
  const augmented = augmentGraphWithLpSupport(
    g,
    rates,
    pack,
    targets,
    itemOverrides,
  );
  const sccs = tarjanScc(g);
  const c = condense(g, sccs);
  if (import.meta.env.DEV && augmented.size > 0) {
    // The seeding path treats augmented nodes as singleton SCCs. A mutual cycle
    // among augmented nodes would route them into the SCC machinery unseeded;
    // fail loud instead of replicating it wrong.
    for (const scc of sccs) {
      if (scc.recipeIds.length <= 1) continue;
      const hit = scc.recipeIds.find((id) => augmented.has(id));
      if (hit !== undefined) {
        throw new Error(
          `augmented LP-support recipe ${hit} inside multi-member SCC ${scc.id}`,
        );
      }
    }
  }
  const aps = articulationPoints(g);
  const { replicas: rawReplicas, supplyShares } = replicatePerConsumer({
    g,
    articulation: aps,
    rates,
    condensation: c,
    targets,
    augmented,
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
    tornEdges: torn.map((t) => t.id),
    condensation: c,
    recipeById,
    g,
    torn,
  });

  const full: SolvePlanFull = {
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
    feasibility: {
      softFeasible: lpResult.softFeasible,
      deficits: lpResult.deficit,
    },
    supplyShares,
  };

  return { full, lpResult };
}

/**
 * Solve a plan and return just the assembled LogicalGraph. Lighter entry point
 * for callers that don't need the render-pipeline intermediates; it skips the
 * dev-only invariant assertions that solvePlanWithIntermediates runs.
 */
export function solvePlan(
  targets: Target[],
  pack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides?: ItemOverride[],
  recipeCosts?: Map<RecipeId, number>,
  solver: LpSolver = solveLp,
): LogicalGraph {
  return runSolvePipeline(
    targets,
    pack,
    tConfig,
    itemOverrides,
    recipeCosts,
    solver,
  ).full.logical;
}

/**
 * Like `solvePlan` but also returns the intermediate artifacts the render
 * pipeline (cluster, expand, bisim, render) needs, and runs the reference-free
 * invariant assertions in dev/test builds.
 */
export function solvePlanWithIntermediates(
  targets: Target[],
  pack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides?: ItemOverride[],
  recipeCosts?: Map<RecipeId, number>,
  solver: LpSolver = solveLp,
): SolvePlanFull {
  const { full, lpResult } = runSolvePipeline(
    targets,
    pack,
    tConfig,
    itemOverrides,
    recipeCosts,
    solver,
  );

  if (import.meta.env.DEV) {
    assertInvariants(full, lpResult, pack, targets, itemOverrides ?? []);
  }

  return full;
}
