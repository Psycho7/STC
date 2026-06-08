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
import type { Target } from "../data/targets";
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

// Replica ids separate their counter with `#`, which the canvas layout treats
// as a stamp-suffix marker, so assembleLogicalGraph swaps `#` for `~` before
// using the id as a logical node id. Same swap here, so the driver can match a
// logical-edge endpoint string back to its replica.
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
 * Works out the demand rate on each edge.
 *
 * Input-side edges (consumer recipe lists X as an input): a consumer STAMP C
 * demands `C.executionRate * inQty(X)`. When several producer edges feed the
 * same (stamp, item) group, the demand splits across them in proportion to each
 * source replica's output of X (`srcStamp.executionRate * outQty(X)`). A single
 * inbound edge gets share/sum = 1 and carries the full stamp demand, keeping
 * single-producer wiring bit-identical. The split makes inbound rates sum to
 * exactly the stamp demand and never overfeed. Degenerate groups with no
 * positive producer share fall back to an even demand/k split.
 *
 * Output-side edges (consumer lists X only as an output) keep producer-side
 * billing: `producerRate * outQty(X)`.
 *
 * Return-arc torn edges (id contains "->return->") use the same rules; the SCC
 * member executionRate the flow solve assigned already matches the torn-flow
 * rate once the loop converges.
 */
function computeEdgeRates(args: {
  logical: LogicalGraph;
  replicas: ReadonlyArray<Replica>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  rates: ReadonlyMap<RecipeId, Fraction>;
}): Map<string, Fraction> {
  const { logical, replicas, recipeById, rates } = args;
  const replicaBySafeId = new Map<string, Replica>();
  for (const r of replicas) replicaBySafeId.set(safeId(r.id), r);

  const result = new Map<string, Fraction>();
  const ZERO = new Fraction(0);

  const itemFor = (port: string): string =>
    port.startsWith("in:") ? port.slice("in:".length) : port;

  // Pre-pass: group INPUT edges (consumer treats the item as a recipe input) by
  // (consumer replica safeId, item). Each consumer STAMP's demand for an item
  // splits across its inbound edges in proportion to each source replica's
  // output of that item. A single inbound edge collapses to share/sum = 1,
  // leaving single-producer wiring bit-identical; several edges apportion the
  // stamp demand so inbound rates sum to exactly the demand and never overfeed.
  // Output-side edges (consumer carries the item only as an output) keep
  // producer-side billing in the loop below.
  const inputEdgesByGroup = new Map<
    string,
    { edges: typeof logical.edges; inQty: number }
  >();
  const groupKey = (target: string, item: string): string => `${target}\0${item}`;
  for (const e of logical.edges) {
    const item = itemFor(e.targetPort);
    const consumer = replicaBySafeId.get(e.target);
    if (!consumer) continue;
    const recipe = recipeById.get(consumer.recipeId);
    if (!recipe) continue;
    const inStoich = recipe.in.find((s) => s.item === item);
    if (!inStoich) continue;
    const key = groupKey(e.target, item);
    const existing = inputEdgesByGroup.get(key);
    if (existing) existing.edges.push(e);
    else inputEdgesByGroup.set(key, { edges: [e], inQty: inStoich.qty });
  }

  // Per-group producer-share split for the input edges.
  const outputShare = (producer: Replica | undefined, item: string): Fraction => {
    if (!producer) return ZERO;
    const prodRecipe = recipeById.get(producer.recipeId);
    const outStoich = prodRecipe?.out.find((s) => s.item === item);
    if (!outStoich) return ZERO;
    return producer.executionRate.mul(new Fraction(outStoich.qty));
  };
  for (const [key, group] of inputEdgesByGroup) {
    const sep = key.indexOf("\0");
    const targetSafeId = key.slice(0, sep);
    const item = key.slice(sep + 1);
    const consumer = replicaBySafeId.get(targetSafeId)!;
    const demand = consumer.executionRate.mul(new Fraction(group.inQty));
    const shares = group.edges.map((e) =>
      outputShare(replicaBySafeId.get(e.source), item),
    );
    const shareSum = shares.reduce((acc, s) => acc.add(s), ZERO);
    const k = group.edges.length;
    for (let i = 0; i < group.edges.length; i++) {
      const e = group.edges[i]!;
      const rate =
        shareSum.compare(ZERO) > 0
          ? demand.mul(shares[i]!).div(shareSum)
          : demand.div(new Fraction(k));
      result.set(e.id, rate);
    }
  }

  // Remaining edges, two buckets:
  //   - consumer/recipe unresolvable, OR the consumer lists the item as an
  //     OUTPUT (not an input). The output-side case bills the producer.
  //   - everything else stays ZERO.
  for (const e of logical.edges) {
    if (result.has(e.id)) continue;
    const item = itemFor(e.targetPort);
    let rate = ZERO;
    const consumer = replicaBySafeId.get(e.target);
    const consumerRecipe = consumer
      ? recipeById.get(consumer.recipeId)
      : undefined;
    if (consumer && consumerRecipe) {
      // Output-side billing: producer delivers its own output of the item.
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
  targets: ReadonlyArray<Target>,
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
