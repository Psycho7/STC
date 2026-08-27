// Turns solver output into something the canvas can draw. Chains the three
// pipeline stages -- clustering, multiplier expansion, always-fold render -- so
// App.tsx makes one call.
//
// The final stage folds parallel replicas of the same recipe into one unit with
// a rational multiplicity. We keep the full machine-graph data (MachineGraph,
// MachineVertex with its stampIndex, MachineEdge) between expansion and
// rendering so the render policy still sees the per-replica edges before they
// fold together.

import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { ItemTarget } from "../data/targets";
import type { SolvePlanFull } from "../solver";
import type { SccId } from "../solver/types";
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
  RenderPlan,
} from "./types";

export type RenderPipelineOutput = {
  plan: RenderPlan;
  /** Container-tagged: every vertex carries containerId where one applies. */
  machineGraph: MachineGraph;
  containers: ContainerSet;
};

/**
 * Run the pipeline over the solver's intermediate results and return a
 * RenderPlan that layoutRenderPlan() consumes directly.
 *
 * `pack` must be the RAW pack and `targets`/`itemOverrides` must be the same
 * values handed to the solvePlanWithIntermediates call that produced `full`;
 * the DEV invariant hook checks the plan against them.
 *
 * Stage order is internal: cluster -> edge rates -> expand -> container tagging
 * -> AlwaysFoldRender. The tagging phase mutates vertices into a shape the type
 * system cannot distinguish from the untagged one, which is why it stays inside
 * this function instead of being reachable from a caller.
 */
export function renderPlanFromSolve(
  full: SolvePlanFull,
  pack: RecipePack,
  targets: ReadonlyArray<ItemTarget>,
  itemOverrides: ReadonlyArray<ItemOverride>,
): RenderPipelineOutput {
  const {
    logical,
    replicas,
    multipliers,
    idealCount,
    condensation,
    recipeById,
    rates,
    supplyShares,
    boundaryShare,
  } = full;

  // Raw versus netted, and both are used deliberately. `recipeById` above is
  // the NETTED recipe map (netSelfConsumption ran before the solver built it),
  // so downstream rates match what the LP solved. `pack` is the RAW pack, and
  // the itemById/machineById maps below are built from it; the render policy
  // also reads `pack.items` raw for effective supply. Never rebuild these two
  // maps from `recipeById`, and never pass a netted pack in: the result is a
  // silently wrong-stoichiometry render, not a crash.
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));

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

  const machineGraph = expandMultipliers({
    logical,
    replicas: surviving,
    edgeRatesByLogicalEdgeId,
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

  // Dev/test-only: assert render invariants, tree-shaken out of production
  // builds (parity with the solver hook in src/solver/index.ts).
  if (import.meta.env.DEV) {
    assertRenderInvariants({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
    });
  }

  return { plan, machineGraph: containerAwareGraph, containers };
}

// Re-exported so callers can grab MachineEdge without reaching into
// pipeline/types.
export type { MachineEdge };
