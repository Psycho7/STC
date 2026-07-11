// Edge-span census. Two parts:
//   1. computeEdgeSpans unit test on a synthetic 3-node fixture (one container
//      child) that pins the absolute-position resolution and the floor-at-0.
//   2. A repro-plan census that runs the real decode -> pipeline -> ELK layout
//      chain and records the phase-1a long-edge baseline. Task 7 tightens the
//      assertion to zero once the bus-lane phase lands.

import { describe, it, expect } from "vitest";
import {
  computeEdgeSpans,
  SPAN_THRESHOLD,
  type SpanNode,
  type SpanEdge,
} from "./edgeSpans";
import { directCorridorClear } from "../../src/canvas/busRouting";
import { loadPlan } from "../../src/data/plan";
import { planToSolverArgs } from "../../src/solver/planToSolverArgs";
import { solvePlanWithIntermediates } from "../../src/solver";
import { renderPlanFromSolve } from "../../src/pipeline/driver";
import { layoutRenderPlan } from "../../src/canvas/layout";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";

describe("computeEdgeSpans", () => {
  it("derives SPAN_THRESHOLD from layout constants (2 * (110 + 300) = 820)", () => {
    expect(SPAN_THRESHOLD).toBe(820);
  });

  it("resolves one level of parentId for absolute positions and floors at 0", () => {
    // a: top-level, right edge at x = 0 + 100 = 100.
    // grp: container at x = 500.
    // b: child of grp, parent-relative x = 50, so absolute left = 550.
    const nodes: SpanNode[] = [
      { id: "a", position: { x: 0 }, width: 100 },
      { id: "grp", position: { x: 500 }, width: 200 },
      { id: "b", parentId: "grp", position: { x: 50 }, width: 100 },
    ];
    // Forward edge a -> b: 550 (target abs left) - 100 (source right) = 450.
    // Backward edge b -> a: 0 - (550 + 100) is negative, floored to 0.
    const edges: SpanEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ];

    expect(computeEdgeSpans(nodes, edges)).toEqual([450, 0]);
  });
});

// The repro fragment (gzip + urlsafe-base64 plan JSON), sans leading '#'. Decoded
// through the same loadPlan -> planToSolverArgs -> solve -> render -> layout chain
// the app runs at mount time.
const REPRO_FRAGMENT =
  "v1.H4sIAAAAAAAAChXNQQ6CMBAF0Lv8dVUsoLQ3cGfikhBSZqamEaGWsiLc3bB7u7chOvrAtpCJfZCRT-RGunhHeU5hHt0AheKsoVB5qm7aVI0X42-15kEXum5MXTI3TIUZSvZk7ugUcsijwAIK2aW35AW23ZCEQpQHw0J-a4j9QinE3Ff9ESSX5SnpJQS7YVq_sLhCgWWaD-sC-97tfxzbj6i0AAAA";

describe("edge-span census: repro plan", () => {
  it("every long non-bus edge has a provably clear direct corridor", async () => {
    const outcome = await loadPlan(REPRO_FRAGMENT, pack);
    if (outcome.kind === "error") {
      throw new Error(`repro fragment failed to load: ${JSON.stringify(outcome.error)}`);
    }
    const { targets, itemOverrides, recipeCosts } = planToSolverArgs(
      outcome.plan,
    );
    const tConfig = loadTransportConfig(defaultTransportConfig, pack);
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      tConfig,
      itemOverrides,
      recipeCosts,
    );
    const itemById = new Map(pack.items.map((i) => [i.id, i]));
    const { plan } = renderPlanFromSolve(full, pack, targets, itemOverrides);
    // Time the layout + bus-routing pass (routeBusEdges runs inside
    // layoutRenderPlan). Spec acceptance: under 2 s on the repro plan.
    const layoutStart = performance.now();
    const laid = await layoutRenderPlan({
      plan,
      recipeById: full.recipeById,
      itemById,
    });
    const layoutMs = performance.now() - layoutStart;

    // Full-census spans (all edges) for the record.
    const spans = computeEdgeSpans(laid.nodes, laid.edges);
    const sortedDesc = [...spans].sort((a, b) => b - a);
    const longSpans = sortedDesc.filter((s) => s > SPAN_THRESHOLD);

    // Bus lanes carry the crossing routes; the criterion applies to the
    // free-routed (non-bus) remainder. Retype pass sets edge.type === "bus".
    const busEdges = laid.edges.filter((e) => e.type === "bus");
    const nonBusEdges = laid.edges.filter((e) => e.type !== "bus");

    // A non-bus edge may now legitimately span past the threshold: Task 12
    // deliberately leaves a single-member trunk whose DIRECT corridor is clear
    // as a plain item edge rather than detouring it onto a bus lane. The
    // criterion below is the successor to the old "zero long non-bus edges":
    // any layout satisfying the old zero-count satisfies this one vacuously,
    // and it additionally admits exactly the long edges whose direct corridor
    // is provably clear (recomputed with the same gate routeBusEdges demotes
    // on). A blocked long non-bus edge -- what the old zero-count guarded
    // against -- still fails, and the check stays fully structural.
    const longNonBus = nonBusEdges.filter(
      (e) => (computeEdgeSpans(laid.nodes, [e])[0] ?? 0) > SPAN_THRESHOLD,
    );
    const blocked = longNonBus.filter(
      (e) => !directCorridorClear(laid.nodes, laid.edges, e),
    );

    // Census log (surfaces in the commit body): total edges, bus count, long
    // count over the full census, long non-bus count, blocked count, max span.
    console.log(
      `[edge-span census] total=${spans.length} bus=${busEdges.length} long(>${SPAN_THRESHOLD})=${longSpans.length} longNonBus=${longNonBus.length} blocked=${blocked.length} max=${Math.round(sortedDesc[0] ?? 0)} layoutMs=${Math.round(layoutMs)} longSpans=${JSON.stringify(longSpans.map((s) => Math.round(s)))}`,
    );

    // Criterion: no free-routed (non-bus) edge spans past the threshold with a
    // blocked corridor -- every long item edge that survived is one demotion left
    // as plain because its direct route is clear.
    expect(blocked.map((e) => e.id)).toEqual([]);
    // Spec perf criterion: layout plus bus routing stays under 2 s.
    expect(layoutMs).toBeLessThan(2000);
  });
});
