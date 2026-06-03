// Heuristic #9 (next-stage invariant): the render policy's output is consumed
// by ELK Layered. This test pipes AlwaysFoldRender's output through the same
// layoutRenderPlan() entry point the driver uses and asserts the resulting
// laid-out graph is well-formed. Until T13 wires AlwaysFoldRender into the
// driver, we re-invoke the policy directly on the same RenderPolicyInput the
// driver would assemble (containers + machineGraph from buildRenderPlan plus
// the original solver intermediates).

import { describe, it, expect } from "vitest";
import { solvePlanWithIntermediates } from "../../../src/solver";
import { buildRenderPlan } from "../../../src/pipeline/driver";
import { AlwaysFoldRender } from "../../../src/pipeline/render/always-fold";
import { layoutRenderPlan } from "../../../src/canvas/layout";
import { pack } from "../../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../../src/data/transport-config";
import { defaultTargets } from "../../../src/data/targets";
import type {
  RenderPolicyInput,
  RenderPlan,
} from "../../../src/pipeline/types";
import type { ItemOverride } from "../../../src/data/plan";

// Build a realistic RenderPolicyInput + RenderPlan via the default-targets
// plan. We use buildRenderPlan to obtain the post-cluster containers and the
// container-aware MachineGraph the driver feeds into the render stage, then
// hand both to AlwaysFoldRender directly. This isolates the test from T13
// (which will swap the driver's policy from NoFoldRender to AlwaysFoldRender).
function buildAlwaysFoldPlan(): RenderPlan {
  const targets = defaultTargets();
  const itemOverrides: ItemOverride[] = [];
  const tConfig = loadTransportConfig(defaultTransportConfig, pack);
  const full = solvePlanWithIntermediates(
    targets,
    pack,
    tConfig,
    itemOverrides,
  );
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const built = buildRenderPlan({
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
  const policyInput: RenderPolicyInput = {
    containers: built.containers,
    machineGraph: built.machineGraph,
    targets,
    itemOverrides,
    itemById,
    recipeById: full.recipeById,
    pack,
    idealCount: full.idealCount,
  };
  return AlwaysFoldRender(policyInput);
}

describe("AlwaysFoldRender -> ELK acceptance", () => {
  it("produces a layout with finite coordinates for every node on the default plan", async () => {
    const plan = buildAlwaysFoldPlan();
    expect(plan.units.length).toBeGreaterThan(0);

    const laid = await layoutRenderPlan({
      plan,
      recipeById: new Map(pack.recipes.map((r) => [r.id, r])),
      itemById: new Map(pack.items.map((i) => [i.id, i])),
    });

    expect(laid.nodes.length).toBeGreaterThan(0);
    for (const n of laid.nodes) {
      const x = n.position?.x;
      const y = n.position?.y;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("every render-plan edge endpoint resolves to a laid-out node", async () => {
    const plan = buildAlwaysFoldPlan();

    const laid = await layoutRenderPlan({
      plan,
      recipeById: new Map(pack.recipes.map((r) => [r.id, r])),
      itemById: new Map(pack.items.map((i) => [i.id, i])),
    });

    const nodeIds = new Set(laid.nodes.map((n) => n.id));
    // Cross-check: every unit emitted by AlwaysFoldRender shows up as a laid
    // node (catches "unit emitted but ELK dropped it" regressions). Container
    // wrappers are not units; AlwaysFoldRender's `units` array only contains
    // recipe / loop / input-product / output-product nodes, all of which ELK
    // must place.
    for (const u of plan.units) {
      expect(nodeIds.has(u.id)).toBe(true);
    }
    // And every edge endpoint resolves. This catches "AlwaysFoldRender emits
    // an edge whose fromUnit/toUnit doesn't exist in `units`" regressions.
    for (const e of plan.edges) {
      expect(nodeIds.has(e.fromUnit)).toBe(true);
      expect(nodeIds.has(e.toUnit)).toBe(true);
    }
  });
});
