import Fraction from "fraction.js";
import type { LogicalGraph } from "../canvas/layout";
import type { Recipe, RecipePack } from "@aef/schema";
import type { TransportConfig } from "../data/transport-config";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { augmentGraphWithLpSupport, buildRecipeGraphMulti } from "./graph";
import { tarjanScc, condense } from "./scc";
import { solveLp, type LpResult, type LpSolver } from "./lp";
import { boundaryResidualShare } from "./boundary-share";
import { articulationPoints } from "./bctree";
import { pickTearEdges } from "./tear";
import { replicatePerConsumer } from "./replicate";
import { assignIdealMultipliers, assignMultipliers } from "./multiplier";
import { ffdPack } from "./ffd";
import { assembleLogicalGraph } from "./assemble";
import { bisimQuotient, deriveReplicaEdges, type ClassId } from "./bisim";
import { assertInvariants } from "./invariants";
import { netSelfConsumption } from "./net-self";
import type {
  Condensation,
  ItemId,
  RecipeGraph,
  RecipeId,
  Replica,
  ReplicaId,
  TornEdge,
} from "./types";

// Thrown when the LP has no feasible solution. Carries the best-effort set of
// implicated ids so the UI can name what went wrong, but holds NO user-facing
// strings itself: the presentation layer localizes these ids. `cappedItemIds`
// are the finite supply caps present in the model (a too-low cap is the common
// cause); `targetItemIds` are the requested target outputs.
export class LpInfeasibleError extends Error {
  readonly cappedItemIds: readonly string[];
  readonly targetItemIds: readonly string[];
  constructor(
    cappedItemIds: readonly string[],
    targetItemIds: readonly string[],
  ) {
    super("LP solver: infeasible problem");
    this.name = "LpInfeasibleError";
    this.cappedItemIds = cappedItemIds;
    this.targetItemIds = targetItemIds;
  }
}

// Turn the LP outcome into a hard error for the unsolvable cases. "empty" (a
// feasible optimum running no recipe) and "feasible" both proceed; only
// "infeasible"/"unbounded" abort. The infeasible case derives a cheap,
// best-effort list of implicated items from the model inputs (no solver
// diagnostics rebuild): the finite supply caps and the target outputs.
function assertSolvable(
  status: LpResult["status"],
  targets: ReadonlyArray<ItemTarget>,
  itemOverrides: ItemOverride[] | undefined,
): void {
  switch (status) {
    case "infeasible": {
      const cappedItemIds = (itemOverrides ?? [])
        .filter((o) => o.ratePerSec !== undefined)
        .map((o) => o.itemId);
      const targetItemIds = targets.map((t) => t.itemId);
      throw new LpInfeasibleError(cappedItemIds, targetItemIds);
    }
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
 * feed the render pipeline. `logical` is the assembled LogicalGraph; the extra
 * fields expose the intermediates the cluster, expand, bisim, and render stages
 * need.
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
  /**
   * Per finite-capped item the LP drew from the boundary: the fraction of its
   * consumption in-graph producers cover (`boundaryResidualShare`). Missing
   * entries mean share 1 (no boundary contribution). The render driver nets
   * consumer demand and boundary-product emission by this map so all layers
   * share one definition of the cap.
   */
  boundaryShare: Map<ItemId, Fraction>;
};

// Shared pipeline behind the public entry point. Runs the full solve (graph
// build, SCC condensation, LP solve, replication, bisim, multiplier assignment,
// FFD packing, tear-edge rebuild, logical-graph assembly) and returns the
// assembled SolvePlanFull plus the raw LpResult. It does NOT run the dev-only
// invariant assertions; those stay with solvePlanWithIntermediates.
//
// The TornEdge[] is rebuilt here because the LP solver returns no torn-edge
// metadata; return-arc rendering needs the full TornEdge objects with their
// .edge and .sccId fields. AEF has only a handful of non-trivial SCCs, so re-
// running pickTearEdges costs almost nothing.
function runSolvePipeline(
  targets: ReadonlyArray<ItemTarget>,
  rawPack: RecipePack,
  tConfig: TransportConfig,
  itemOverrides: ItemOverride[] | undefined,
  recipeCosts: Map<RecipeId, number> | undefined,
  solver: LpSolver,
): { full: SolvePlanFull; lpResult: LpResult } {
  // Everything below (graph walk, LP, replication, assembly, and the
  // recipeById map that feeds the render pipeline) must see the netted form;
  // only display layers go back to the raw pack.
  const pack = netSelfConsumption(rawPack);
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
  assertSolvable(lpResult.status, targets, itemOverrides);
  const rates = lpResult.rates;
  // Residual share per finite-capped item the LP drew from the boundary. The
  // walk nets each consumer's per-item demand by it so replica rates (and the
  // machine counts derived from them) reconcile with the LP solution.
  const boundaryShare = boundaryResidualShare(
    pack.recipes,
    rates,
    lpResult.draws,
  );
  // Close graph membership over the LP support before any graph-derived
  // structure is computed: a disposal absorber the LP runs is unreachable from
  // the target cone and would otherwise be missing from the render entirely.
  const augmented = augmentGraphWithLpSupport(g, rates, pack, itemOverrides);
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
    boundaryShare,
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
    boundaryShare,
  };

  return { full, lpResult };
}

/**
 * Solve a plan and return the assembled LogicalGraph together with the
 * intermediate artifacts the render pipeline (cluster, expand, bisim, render)
 * needs. Runs the reference-free invariant assertions in dev/test builds.
 */
export function solvePlanWithIntermediates(
  targets: ReadonlyArray<ItemTarget>,
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
    // Check against the same netted form the pipeline solved; raw
    // self-consuming stoichiometry would flag phantom deficits on flows the
    // netting already folded away.
    assertInvariants(full, lpResult, netSelfConsumption(pack), targets, itemOverrides ?? []);
  }

  return full;
}
