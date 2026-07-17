// Turns solver output into something the canvas can draw. Chains the three
// pipeline stages -- clustering, multiplier expansion, always-fold render -- so
// App.tsx makes one call.
//
// The final stage folds parallel replicas of the same recipe into one unit with
// a rational multiplicity. We keep the full machine-graph data (MachineGraph,
// MachineVertex with its stampIndex, MachineEdge) between expansion and
// rendering so the render policy still sees the per-replica edges before they
// fold together.

import Fraction from "fraction.js";
import type { Item, Machine, Recipe, RecipePack } from "@aef/schema";
import type { LogicalGraph } from "../canvas/layout";
import type { ItemOverride } from "../data/plan";
import type { Target, ItemTarget } from "../data/targets";
import type { SolvePlanFull } from "../solver";
import type {
  Condensation,
  ItemId,
  RecipeId,
  Replica,
  ReplicaId,
  SccId,
  TornEdge,
} from "../solver/types";
import { PillarsOnly } from "./cluster";
import { expandMultipliers } from "./expand";
import { computeEdgeRates } from "./expand/edge-rates";
import { AlwaysFoldRender } from "./render";
import { assertRenderInvariants } from "./render/invariants";
import type {
  ContainerId,
  ContainerSet,
  MachineEdge,
  MachineGraph,
  MachineRecipeVertex,
  MachineSccVertex,
  MachineVertex,
  NetIOPort,
  RenderPlan,
} from "./types";

export type RenderPipelineInput = {
  logical: LogicalGraph;
  replicas: ReadonlyArray<Replica>;
  multipliers: ReadonlyMap<ReplicaId, number>;
  /** Rational machine count per replica (no ceiling). */
  idealCount: ReadonlyMap<ReplicaId, Fraction>;
  condensation: Condensation;
  torn: ReadonlyArray<TornEdge>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  rates: ReadonlyMap<RecipeId, Fraction>;
  /**
   * Committed producer-recipe -> consumer-recipe item flow (items/s), keyed by
   * `supplyShareKey`. Recorded for shared producers only; computeEdgeRates uses
   * it as the per-consumer demand-split weight.
   */
  supplyShares: ReadonlyMap<string, Fraction>;
  /**
   * Per finite-capped item the LP drew from the boundary: the fraction of its
   * consumption in-graph producers cover (`boundaryResidualShare`). Missing
   * entries mean share 1. computeEdgeRates nets each consumer's demand by it;
   * deriveBoundaryProducts sizes the boundary import as the complement.
   */
  boundaryShare: ReadonlyMap<ItemId, Fraction>;
  itemById: ReadonlyMap<ItemId, Item>;
  machineById: ReadonlyMap<string, Machine>;
  itemOverrides: ReadonlyArray<ItemOverride>;
  targets: ReadonlyArray<Target & ItemTarget>;
  // The solver hands class ids out as opaque branded strings. Both maps pass
  // through untouched so canvas highlighting can go from a replica id to its
  // bisimulation class and back to whichever quotient replica stands in for it.
  classByReplicaId: ReadonlyMap<ReplicaId, string>;
  classToQuotient: ReadonlyMap<string, ReplicaId>;
  // Just the pack slice the render policy needs: it only reads `pack.items` for
  // effective supply. Passing it saves rebuilding it from `itemById`.
  pack: Pick<RecipePack, "items">;
};

export type RenderPipelineOutput = {
  plan: RenderPlan;
  machineGraph: MachineGraph;
  containers: ContainerSet;
  classByReplicaId: ReadonlyMap<ReplicaId, string>;
  classToQuotient: ReadonlyMap<string, ReplicaId>;
};

/**
 * Run the pipeline over the solver's intermediate results and return a
 * RenderPlan that layoutRenderPlan() consumes directly.
 */
export function buildRenderPlan(
  input: RenderPipelineInput,
): RenderPipelineOutput {
  const {
    logical,
    replicas,
    multipliers,
    idealCount,
    condensation,
    torn,
    recipeById,
    rates,
    supplyShares,
    boundaryShare,
    itemById,
    machineById,
    itemOverrides,
    targets,
    classByReplicaId,
    classToQuotient,
    pack,
  } = input;

  // Keep only surviving replicas. assembleLogicalGraph already dropped zero-rate
  // replicas from the multipliers map, and the pipeline works from that set.
  const surviving = replicas.filter((r) => multipliers.has(r.id));

  const containers = PillarsOnly({
    logical,
    replicas: surviving,
    condensation,
  });

  const edgeRatesByLogicalEdgeId = computeEdgeRates({
    logical,
    replicas: surviving,
    recipeById,
    rates,
    supplyShares,
    boundaryShare,
  });

  const sccByLogicalNodeId = computeSccNetIO({
    condensation,
    torn,
    rates,
    recipeById,
  });

  const machineGraph = expandMultipliers({
    logical,
    replicas: surviving,
    edgeRatesByLogicalEdgeId,
    sccByLogicalNodeId,
    itemById,
    idealCount,
    machineById,
  });

  // Tag every machine vertex with its containerId. Recipe vertices read it from
  // PillarsOnly's containerByMember map (ReplicaId to ContainerId). SCC vertices
  // resolve through their sccId, since an SCC container's id is `loop:<sccId>`.
  const sccContainerIdBySccId = new Map<SccId, ContainerId>();
  for (const c of containers.containers) {
    if (c.kind === "loop-box") sccContainerIdBySccId.set(c.sccId, c.id);
  }

  const vertices: MachineVertex[] = machineGraph.vertices.map((v) => {
    if (v.kind === "machine") {
      const containerId = containers.containerByMember.get(v.replicaId);
      if (containerId === undefined) return v;
      const next: MachineRecipeVertex = { ...v, containerId };
      return next;
    }
    const containerId = sccContainerIdBySccId.get(v.sccId);
    if (containerId === undefined) return v;
    const next: MachineSccVertex = { ...v, containerId };
    return next;
  });

  const containerAwareGraph: MachineGraph = {
    vertices,
    edges: machineGraph.edges,
  };

  const plan = AlwaysFoldRender({
    containers,
    machineGraph: containerAwareGraph,
    targets,
    itemOverrides,
    itemById,
    recipeById,
    pack,
    idealCount,
    boundaryShare,
  });

  return {
    plan,
    machineGraph: containerAwareGraph,
    containers,
    classByReplicaId,
    classToQuotient,
  };
}

/**
 * Builds metadata for SCC stand-in nodes. assembleLogicalGraph never collapses
 * SCC members into one node -- each shows as its own recipe vertex inside a
 * loop-box container -- so there is nothing to describe and this returns an
 * empty map. If the upstream layer ever emits a single stand-in node per
 * non-trivial SCC, fill this map keyed by that node's id.
 */
function computeSccNetIO(args: {
  condensation: Condensation;
  torn: ReadonlyArray<TornEdge>;
  rates: ReadonlyMap<RecipeId, Fraction>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
}): ReadonlyMap<string, { sccId: SccId; netIO: ReadonlyArray<NetIOPort> }> {
  void args;
  return new Map();
}

/**
 * Assemble a RenderPipelineInput from solver output and run buildRenderPlan.
 * Shared by App.tsx and any CLI surface needing the same render assembly.
 */
export function renderPlanFromSolve(
  full: SolvePlanFull,
  pack: RecipePack,
  targets: ReadonlyArray<Target & ItemTarget>,
  itemOverrides: ReadonlyArray<ItemOverride>,
): RenderPipelineOutput {
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const output = buildRenderPlan({
    logical: full.logical,
    replicas: full.replicas,
    multipliers: full.multipliers,
    idealCount: full.idealCount,
    classByReplicaId: full.classByReplicaId,
    classToQuotient: full.classToQuotient,
    condensation: full.condensation,
    torn: full.torn,
    recipeById: full.recipeById,
    rates: full.rates,
    supplyShares: full.supplyShares,
    boundaryShare: full.boundaryShare,
    itemById,
    machineById,
    itemOverrides,
    targets,
    pack,
  });

  // Dev/test-only: assert render invariants, tree-shaken out of production
  // builds (parity with the solver hook in src/solver/index.ts).
  if (import.meta.env.DEV) {
    assertRenderInvariants({
      plan: output.plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides,
    });
  }

  return output;
}

// Re-exported so callers can grab MachineEdge without reaching into
// pipeline/types.
export type { MachineEdge };
