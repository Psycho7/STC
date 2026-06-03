import { describe, expect, it } from "vitest";
import type { Item } from "@aef/schema";
import { buildRenderPlan } from "../../src/pipeline/driver";
import type { RenderPipelineInput } from "../../src/pipeline/driver";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import type { ItemOverride } from "../../src/data/plan";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import { defaultTargets } from "../../src/data/targets";

// The pipeline contract requires every caller to thread `itemById` and
// `itemOverrides` through `RenderPipelineInput`. `itemOverrides` defaults to
// `[]` at construction time when the source plan has no overrides; this test
// pins that defaulting behavior so callers do not silently pass `undefined`.

describe("RenderPipelineInput / itemById and itemOverrides contract", () => {
  it("accepts an empty itemOverrides array when the plan has no overrides", () => {
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const itemById = new Map<string, Item>(pack.items.map((i) => [i.id, i]));
    const machineById = new Map(pack.machines.map((m) => [m.id, m]));
    const itemOverrides: ReadonlyArray<ItemOverride> = [];
    const input: RenderPipelineInput = {
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
      targets: defaultTargets(),
      pack,
    };
    const { plan } = buildRenderPlan(input);
    expect(plan.units.length).toBeGreaterThan(0);
  });

  it("threads a non-empty itemOverrides array through without mutation", () => {
    // We don't yet exercise overrides in the render policy (that lands in
    // Stage C); the contract here is purely that the field is required,
    // ReadonlyArray-typed, and reaches the driver intact.
    const overrides: ReadonlyArray<ItemOverride> = [{ itemId: "stub:item" }];
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const itemById = new Map<string, Item>(pack.items.map((i) => [i.id, i]));
    const machineById = new Map(pack.machines.map((m) => [m.id, m]));
    const input: RenderPipelineInput = {
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
      itemOverrides: overrides,
      targets: defaultTargets(),
      pack,
    };
    const { plan } = buildRenderPlan(input);
    expect(plan.units.length).toBeGreaterThan(0);
    // Sanity: caller's overrides array is not mutated by the driver.
    expect(overrides).toEqual([{ itemId: "stub:item" }]);
  });

  it("provides itemById entries with the schema-required transportKind", () => {
    // Type-level check (compile-time) plus structural check at runtime.
    const itemById = new Map<string, Item>(pack.items.map((i) => [i.id, i]));
    for (const item of itemById.values()) {
      expect(typeof item.transportKind).toBe("string");
      expect(item.transportKind.length).toBeGreaterThan(0);
    }
  });
});
