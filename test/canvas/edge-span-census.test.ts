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
  it("routes every long edge onto a bus lane (zero non-bus edges span > 820)", async () => {
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

    // Bus lanes carry the long routes; the spec criterion applies only to the
    // free-routed (non-bus) remainder. Retype pass sets edge.type === "bus".
    const busEdges = laid.edges.filter((e) => e.type === "bus");
    const nonBusEdges = laid.edges.filter((e) => e.type !== "bus");
    const nonBusSpans = computeEdgeSpans(laid.nodes, nonBusEdges);
    const nonBusLong = nonBusSpans.filter((s) => s > SPAN_THRESHOLD);

    // Census log (surfaces in the commit body): total edges, bus count, long
    // count over the full census, non-bus long count, max span, sorted spans.
    console.log(
      `[edge-span census] total=${spans.length} bus=${busEdges.length} long(>${SPAN_THRESHOLD})=${longSpans.length} nonBusLong=${nonBusLong.length} max=${Math.round(sortedDesc[0] ?? 0)} layoutMs=${Math.round(layoutMs)} longSpans=${JSON.stringify(longSpans.map((s) => Math.round(s)))}`,
    );

    // Spec criterion: every long edge is classified onto a bus lane, so no
    // free-routed (non-bus) edge may span beyond the threshold.
    expect(nonBusLong.length).toBe(0);
    // Spec perf criterion: layout plus bus routing stays under 2 s.
    expect(layoutMs).toBeLessThan(2000);
  });
});
