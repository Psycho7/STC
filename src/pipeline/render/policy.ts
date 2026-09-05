import type {
  MachineVertexId,
  RenderEdge,
  RenderPlan,
  RenderPolicy,
  RenderPolicyInput,
  RenderUnit,
  RenderUnitId,
  RenderUnitLoop,
  RenderUnitRecipe,
} from "../types";
import { isMachineRecipeVertex, isMachineSccVertex } from "../types";
import { deriveBoundaryProducts } from "./boundary-products";
import { unitIdForRecipe, unitIdForScc } from "./unit-ids";

// Assigns a labelSide to each edge based on the per-item degree at each
// endpoint. Runs in O(E) and mutates the input array in place.
export function assignLabelSides(edges: RenderEdge[]): void {
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    const oKey = `${e.fromUnit}\0${e.item}`;
    const iKey = `${e.toUnit}\0${e.item}`;
    outDeg.set(oKey, (outDeg.get(oKey) ?? 0) + 1);
    inDeg.set(iKey, (inDeg.get(iKey) ?? 0) + 1);
  }
  for (const e of edges) {
    const o = outDeg.get(`${e.fromUnit}\0${e.item}`) ?? 1;
    const i = inDeg.get(`${e.toUnit}\0${e.item}`) ?? 1;
    if (o > i) e.labelSide = "target";
    else if (i > o) e.labelSide = "source";
    else e.labelSide = "target"; // 1-to-1 and N-to-M tie
  }
}

/**
 * No-fold render policy. Emits one render unit per machine vertex (no stamps,
 * no badges, no equivalence classes) and one render edge per machine edge,
 * with SCC members collapsed to a single loop unit per sccId. Additionally
 * emits boundary product units:
 *  - one RenderUnitInputProduct for every item consumed in the plan whose
 *    `effectiveSupply` is Infinity or a positive Fraction (i.e. external
 *    supply is unbounded or finite-and-nonzero). Zero supply emits nothing
 *    and forces internal build. rateCap is populated from
 *    itemOverrides[i].ratePerSec when present.
 *  - one RenderUnitOutputProduct (flavor "target") for every target item.
 *  - a target item that also surfaces as a boundary input keeps both
 *    surfaces: its consumers stay boundary-fed and the declared export
 *    arrives via a dedicated passthrough import. Nothing suppresses an input
 *    product for being a target; only zero supply keeps one from existing.
 *
 * RETAINED DELIBERATELY: this policy has no production caller. It is kept as
 * the differential parity oracle for `deriveBoundaryProducts`. 18 tests in
 * test/pipeline/policy-product-units.test.ts drive
 * src/pipeline/render/boundary-products.ts through NoFoldRender, and
 * test/pipeline/render/always-fold.test.ts asserts AlwaysFoldRender emits
 * identical boundary product units for the same input. Deleting NoFoldRender
 * would cost that coverage: AlwaysFoldRender folds stamps, so its unit ids
 * differ and the tests cannot be re-pointed unchanged. RenderPolicy in
 * src/pipeline/types.ts is a real seam only for as long as this stays.
 */
export const NoFoldRender: RenderPolicy = (input): RenderPlan => {
  const {
    containers,
    machineGraph,
    targets,
    itemOverrides,
    itemById,
    recipeById,
    pack,
    boundaryShare,
  } = input;

  const units: RenderUnit[] = [];
  const unitIdByVertex = new Map<MachineVertexId, RenderUnitId>();
  const sccUnitEmitted = new Set<RenderUnitId>();

  const sortedVertices = machineGraph.vertices
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const v of sortedVertices) {
    if (isMachineRecipeVertex(v)) {
      const id = unitIdForRecipe(v.id);
      const base: Omit<RenderUnitRecipe, "containerId"> = {
        id,
        kind: "recipe",
        recipeId: v.recipeId,
        count: 1,
        multiplicity: { num: "1", denom: "1" },
      };
      units.push(
        v.containerId !== undefined
          ? { ...base, containerId: v.containerId }
          : base,
      );
      unitIdByVertex.set(v.id, id);
      continue;
    }
    if (isMachineSccVertex(v)) {
      const id = unitIdForScc(v.sccId);
      unitIdByVertex.set(v.id, id);
      if (sccUnitEmitted.has(id)) continue;
      sccUnitEmitted.add(id);
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
  }

  const { inputProducts, outputProducts, boundaryEdges } =
    deriveBoundaryProducts({
      machineGraph,
      targets,
      itemOverrides,
      itemById,
      recipeById,
      pack,
      unitIdByVertex,
      boundaryShare,
    });

  for (const u of inputProducts) units.push(u);
  for (const u of outputProducts) units.push(u);

  const sortedEdges = machineGraph.edges.slice().sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.item < b.item ? -1 : a.item > b.item ? 1 : 0;
  });

  const edges: RenderEdge[] = [];
  for (const e of sortedEdges) {
    const fromUnit = unitIdByVertex.get(e.from);
    const toUnit = unitIdByVertex.get(e.to);
    if (fromUnit === undefined || toUnit === undefined) continue;
    // SCC self-edges (members of the same sccId all map to one loop unit).
    if (fromUnit === toUnit) continue;
    edges.push({
      fromUnit,
      toUnit,
      item: e.item,
      rate: e.rate,
      transportKind: e.transportKind,
    });
  }

  edges.push(...boundaryEdges);

  assignLabelSides(edges);
  return {
    units,
    edges,
    containers: containers.containers,
  };
};

// Re-export the input shape for callers that build it directly (e.g. tests).
export type { RenderPolicyInput };
