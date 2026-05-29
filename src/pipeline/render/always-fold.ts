import Fraction from "fraction.js";
import type {
  MachineRecipeVertex,
  MachineSccVertex,
  MachineVertexId,
  RenderEdge,
  RenderPlan,
  RenderPolicy,
  RenderUnit,
  RenderUnitId,
  RenderUnitLoop,
  RenderUnitRecipe,
  ReplicaId,
  TransportKindId,
} from "../types";
import { isMachineRecipeVertex, isMachineSccVertex } from "../types";
import { assignLabelSides } from "./policy";
import { deriveBoundaryProducts } from "./boundary-products";
import { rationalToString } from "./rational";

const unitIdForClass = (replicaId: ReplicaId): RenderUnitId =>
  `u:class:${replicaId}`;
const unitIdForScc = (v: MachineSccVertex): RenderUnitId => `u:scc:${v.sccId}`;

/**
 * Always-fold render policy. Groups MachineRecipeVertex by replicaId and emits
 * one RenderUnitRecipe per equivalence class, carrying a rational
 * `multiplicity` badge sourced from `idealCount`. SCC vertices collapse by
 * sccId the same way the legacy policy does. Machine edges are aggregated by
 * (fromUnit, toUnit, item) and self-edges within a class are suppressed.
 * Boundary product units and their edges come from the shared
 * `deriveBoundaryProducts` helper, so AlwaysFoldRender and NoFoldRender emit
 * identical boundary units for the same input.
 */
export const AlwaysFoldRender: RenderPolicy = (input): RenderPlan => {
  const { containers, machineGraph, idealCount } = input;

  // Group MachineRecipeVertex by replicaId.
  const verticesByReplica = new Map<ReplicaId, MachineRecipeVertex[]>();
  const sccVertices: MachineSccVertex[] = [];

  for (const v of machineGraph.vertices) {
    if (isMachineRecipeVertex(v)) {
      const bucket = verticesByReplica.get(v.replicaId);
      if (bucket) bucket.push(v);
      else verticesByReplica.set(v.replicaId, [v]);
    } else if (isMachineSccVertex(v)) {
      sccVertices.push(v);
    }
  }

  const units: RenderUnit[] = [];
  const unitIdByVertex = new Map<MachineVertexId, RenderUnitId>();

  // Emit one RenderUnitRecipe per replica class, sorted by replicaId for
  // deterministic output.
  const sortedReplicaIds = [...verticesByReplica.keys()].sort();
  for (const replicaId of sortedReplicaIds) {
    const members = verticesByReplica.get(replicaId)!;
    const representative = members[0]!;
    const ideal = idealCount.get(replicaId);
    if (!ideal) {
      throw new Error(
        `AlwaysFoldRender: missing idealCount for replicaId=${replicaId}; assignIdealMultipliers must run before this policy`,
      );
    }
    const unitId = unitIdForClass(replicaId);
    const base: Omit<RenderUnitRecipe, "containerId"> = {
      id: unitId,
      kind: "recipe",
      recipeId: representative.recipeId,
      count: 1,
      multiplicity: rationalToString(ideal),
    };
    const containerId = representative.containerId;
    units.push(containerId !== undefined ? { ...base, containerId } : base);
    for (const m of members) unitIdByVertex.set(m.id, unitId);
  }

  // SCC vertices: collapse by sccId so all members map to one loop unit.
  const sccEmitted = new Set<RenderUnitId>();
  const sortedScc = sccVertices
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const v of sortedScc) {
    const id = unitIdForScc(v);
    unitIdByVertex.set(v.id, id);
    if (sccEmitted.has(id)) continue;
    sccEmitted.add(id);
    const base: Omit<RenderUnitLoop, "containerId"> = {
      id,
      kind: "loop",
      sccId: v.sccId,
      count: 1,
      netIO: v.netIO,
    };
    units.push(
      v.containerId !== undefined
        ? { ...base, containerId: v.containerId }
        : base,
    );
  }

  // Aggregate machine edges by (fromUnit, toUnit, item) within the class graph.
  type EdgeKey = string;
  const keyFor = (
    fromUnit: RenderUnitId,
    toUnit: RenderUnitId,
    item: string,
  ): EdgeKey => `${fromUnit}\0${toUnit}\0${item}`;

  const edgeAccum = new Map<
    EdgeKey,
    {
      fromUnit: RenderUnitId;
      toUnit: RenderUnitId;
      item: string;
      rate: Fraction;
      transportKind: TransportKindId;
    }
  >();
  const accumEdge = (e: {
    fromUnit: RenderUnitId;
    toUnit: RenderUnitId;
    item: string;
    rate: Fraction;
    transportKind: TransportKindId;
  }): void => {
    if (e.fromUnit === e.toUnit) return; // self-edges suppressed
    const k = keyFor(e.fromUnit, e.toUnit, e.item);
    const existing = edgeAccum.get(k);
    if (existing) {
      existing.rate = existing.rate.add(e.rate);
    } else {
      edgeAccum.set(k, { ...e });
    }
  };
  for (const me of machineGraph.edges) {
    const fromUnit = unitIdByVertex.get(me.from);
    const toUnit = unitIdByVertex.get(me.to);
    if (!fromUnit || !toUnit) continue;
    accumEdge({
      fromUnit,
      toUnit,
      item: me.item,
      rate: me.rate,
      transportKind: me.transportKind,
    });
  }

  // Boundary edges (input -> class, class -> target output, class -> surplus
  // output) are derived per-machine in deriveBoundaryProducts and must fold
  // through the same (fromUnit, toUnit, item) aggregation so the displayed
  // class-level chip reflects the total flow across the class, matching the
  // class-to-class machine-edge aggregation above. Without this, an 8-stamp
  // producer of a byproduct surfaces 8 duplicate per-stamp chips instead of
  // one aggregate chip.
  const { inputProducts, outputProducts, boundaryEdges } =
    deriveBoundaryProducts({
      machineGraph: input.machineGraph,
      targets: input.targets,
      itemOverrides: input.itemOverrides,
      itemById: input.itemById,
      recipeById: input.recipeById,
      pack: input.pack,
      unitIdByVertex,
    });
  for (const be of boundaryEdges) accumEdge(be);

  const edges: RenderEdge[] = [];
  const sortedKeys = [...edgeAccum.keys()].sort();
  for (const k of sortedKeys) {
    const a = edgeAccum.get(k)!;
    edges.push({
      fromUnit: a.fromUnit,
      toUnit: a.toUnit,
      item: a.item,
      rate: a.rate,
      transportKind: a.transportKind,
    });
  }

  assignLabelSides(edges);

  return {
    units: [...units, ...inputProducts, ...outputProducts],
    edges,
    containers: containers.containers,
  };
};
