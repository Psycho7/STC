// Top-level entry point for turning solver output into something the canvas can
// draw. It chains the three pipeline stages -- clustering, multiplier expansion,
// then the always-fold render -- so App.tsx only has to make one call.
//
// The final stage folds parallel replicas of the same recipe back into a single
// unit carrying a rational multiplicity. We keep the full machine-graph data
// around (MachineGraph, MachineVertex with its stampIndex, MachineEdge) between
// expansion and rendering so the render policy can still see the individual
// per-replica edges before they get folded together.

import Fraction from "fraction.js";
import type { Item, Machine, Recipe, RecipePack } from "@aef/schema";
import type { LogicalGraph } from "../canvas/layout";
import type { ItemOverride } from "../data/plan";
import type { Target } from "../data/targets";
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
import { AlwaysFoldRender } from "./render";
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

// Replica ids separate their counter with `#`, which the canvas layout treats
// as a stamp-suffix marker, so assembleLogicalGraph swaps every `#` for a `~`
// before using the id as a logical node id. We do the same swap here so the
// driver can match a logical-edge endpoint string back to its replica.
function safeId(replicaId: ReplicaId): string {
  return replicaId.replace(/#/g, "~");
}

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
  itemById: ReadonlyMap<ItemId, Item>;
  machineById: ReadonlyMap<string, Machine>;
  itemOverrides: ReadonlyArray<ItemOverride>;
  targets: ReadonlyArray<Target>;
  // The solver hands class ids out as opaque branded strings. We pass both maps
  // straight through untouched so canvas highlighting can go from a replica id
  // to its bisimulation class and back to whichever quotient replica stands in
  // for that class.
  classByReplicaId: ReadonlyMap<ReplicaId, string>;
  classToQuotient: ReadonlyMap<string, ReplicaId>;
  // Just the slice of the pack the render policy needs: it only ever reads
  // `pack.items` when computing effective supply. Passing it in here saves the
  // policy from having to rebuild it out of `itemById`.
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
 * RenderPlan that layoutRenderPlan() can consume directly.
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
    itemById,
    machineById,
    itemOverrides,
    targets,
    classByReplicaId,
    classToQuotient,
    pack,
  } = input;

  // Keep only the replicas that survived. assembleLogicalGraph already dropped
  // zero-rate replicas from the multipliers map, and the pipeline has to work
  // from that exact same set.
  const surviving = replicas.filter((r) => multipliers.has(r.id));

  const containers = PillarsOnly({
    logical,
    replicas: surviving,
    condensation,
  });

  const edgeRatesByLogicalEdgeId = computeEdgeRates({
    logical,
    replicas: surviving,
    multipliers,
    recipeById,
    rates,
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

  // Tag every machine vertex with its containerId. For recipe vertices that
  // comes straight from PillarsOnly's containerByMember map (ReplicaId to
  // ContainerId). SCC vertices instead resolve through their sccId, since each
  // SCC container's id is just `loop:<sccId>`.
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
 * Works out the demand rate on each edge. For an edge from producer P to
 * consumer C carrying item X, we take the consumer side: how much C needs,
 * `C.executionRate * C.recipe.in[X].qty`. That is the items/sec the consumer
 * pulls and therefore the rate the producer has to deliver. Scoping everything
 * per consumer is what keeps producer and consumer matched 1:1 once replication
 * fans things out.
 *
 * Return-arc torn edges (their id contains "->return->") use the same formula.
 * Here the consumer is an SCC member, and the executionRate the flow solve gave
 * it already agrees with the torn-flow rate once the loop converges.
 */
function computeEdgeRates(args: {
  logical: LogicalGraph;
  replicas: ReadonlyArray<Replica>;
  multipliers: ReadonlyMap<ReplicaId, number>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  rates: ReadonlyMap<RecipeId, Fraction>;
}): Map<string, Fraction> {
  const { logical, replicas, recipeById, rates } = args;
  const replicaBySafeId = new Map<string, Replica>();
  for (const r of replicas) replicaBySafeId.set(safeId(r.id), r);

  const result = new Map<string, Fraction>();
  const ZERO = new Fraction(0);
  for (const e of logical.edges) {
    const item = e.targetPort.startsWith("in:")
      ? e.targetPort.slice("in:".length)
      : e.targetPort;
    const consumer = replicaBySafeId.get(e.target);
    if (!consumer) {
      result.set(e.id, ZERO);
      continue;
    }
    const recipe = recipeById.get(consumer.recipeId);
    if (!recipe) {
      result.set(e.id, ZERO);
      continue;
    }
    const inStoich = recipe.in.find((s) => s.item === item);
    let rate = ZERO;
    if (inStoich) {
      // When an SCC member consumer has been split, it only accounts for its
      // own share of the recipe's execution rate. So whenever the replica
      // carries a split filter -- or otherwise has a per-replica rate that
      // differs from the recipe aggregate -- trust its own `executionRate`.
      // Without a split, fall back to the recipe-aggregate rate; that keeps the
      // non-split SCC member, the per-consumer producer, and the target paths
      // producing bit-identical results to before.
      const consumerRate = consumer.outgoingEdgeFilter
        ? consumer.executionRate
        : (rates.get(consumer.recipeId) ?? consumer.executionRate ?? ZERO);
      rate = consumerRate.mul(new Fraction(inStoich.qty));
    } else {
      const producer = replicaBySafeId.get(e.source);
      if (producer) {
        const prodRecipe = recipeById.get(producer.recipeId);
        const outStoich = prodRecipe?.out.find((s) => s.item === item);
        if (outStoich) {
          const producerRate = producer.outgoingEdgeFilter
            ? producer.executionRate
            : (rates.get(producer.recipeId) ?? producer.executionRate ?? ZERO);
          rate = producerRate.mul(new Fraction(outStoich.qty));
        }
      }
    }
    result.set(e.id, rate);
  }
  return result;
}

/**
 * Builds the metadata for SCC stand-in nodes. Right now assembleLogicalGraph
 * never collapses SCC members into one node -- they each show up as their own
 * recipe vertex inside a loop-box container -- so there is nothing to describe
 * and this returns an empty map. If the upstream layer ever starts emitting a
 * single stand-in node per non-trivial SCC, fill this map in keyed by that
 * node's id.
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

// Re-exported here so callers can grab MachineEdge without reaching into
// pipeline/types themselves.
export type { MachineEdge };
