// Turns solver output into something the canvas can draw. Chains the three
// pipeline stages -- clustering, multiplier expansion, always-fold render -- so
// App.tsx makes one call.
//
// The final stage folds parallel replicas of the same recipe into one unit with
// a rational multiplicity. We keep the machine-graph data (MachineGraph,
// MachineVertex, MachineEdge) between expansion and rendering so the render
// policy still sees the per-replica vertices and edges, plus the container
// tagging, before they fold together.

import type { ItemOverride } from "../data/plan";
import type { ItemTarget } from "../data/targets";
import type { SolvePlanFull } from "../solver";
import type { RawPack } from "../solver/net-self";
import { packIndex } from "../data/pack-index";
import type { SccId } from "../solver/types";
import { buildSupplyTable } from "../solver/effectiveSupply";
import { PillarsOnly } from "./cluster";
import { expandAggregate, expandMultipliers } from "./expand";
import { computeEdgeRates } from "./expand/edge-rates";
import { AlwaysFoldRender } from "./render";
import { assertRenderInvariants } from "./render/invariants";
import { devAsserts } from "../util/dev-asserts";
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

/**
 * Which materialisation the run uses. "aggregate" is the shipped one: one
 * machine vertex per replica. "stamped" is the retained per-machine stamp path
 * (src/pipeline/expand/materialize.ts), driven only by the parity sweep in
 * src/pipeline/render/render-corpus.test.ts, which renders both and asserts the
 * two RenderPlans are equal as exact rationals.
 */
export type RenderPipelineOptions = {
  expansion?: "aggregate" | "stamped";
};

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
 * `pack` is the RAW pack (the RawPack brand enforces it) and
 * `targets`/`itemOverrides` must be the same
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
  pack: RawPack,
  targets: ReadonlyArray<ItemTarget>,
  itemOverrides: ReadonlyArray<ItemOverride>,
  options: RenderPipelineOptions = {},
): RenderPipelineOutput {
  const {
    logical,
    replicas,
    multipliers,
    idealCount,
    condensation,
    nettedRecipeById,
    rates,
    supplyShares,
    boundaryShare,
  } = full;

  // Raw versus netted, and both are used deliberately. `nettedRecipeById`
  // above is the NETTED recipe map (netSelfConsumption ran before the solver
  // built it), so downstream rates match what the LP solved. `pack` is the RAW
  // pack, and the itemById/machineById maps below are built from it. Never
  // rebuild these two maps from `nettedRecipeById`, and never pass a netted
  // pack in: the result is a silently wrong-stoichiometry render, not a crash.
  // Both rules are now typed, not just written here. The supply table is the
  // exception - it reads `pack.items` only, so the solve half's table and this
  // one agree whichever pack variant each was built from.
  const { itemById, machineById } = packIndex(pack);
  const supply = buildSupplyTable(pack, itemOverrides);

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
    recipeById: nettedRecipeById,
    rates,
    supplyShares,
    boundaryShare,
  });

  const expand =
    options.expansion === "stamped" ? expandMultipliers : expandAggregate;
  const machineGraph = expand({
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
    recipeById: nettedRecipeById,
    supply,
    idealCount,
    boundaryShare,
  });

  // Dev/test-only: assert render invariants, skipped in production builds and
  // armed under Bun only by the validation flag (parity with the solver hook in
  // src/solver/index.ts).
  if (devAsserts()) {
    assertRenderInvariants({
      plan,
      rates,
      pack,
      targets,
      itemOverrides,
      catalystAccount: full.catalystAccount,
    });
  }

  return { plan, machineGraph: containerAwareGraph, containers };
}

// Re-exported so callers can grab MachineEdge without reaching into
// pipeline/types.
export type { MachineEdge };
