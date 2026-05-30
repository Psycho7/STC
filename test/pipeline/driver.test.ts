import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { buildRenderPlan } from "../../src/pipeline/driver";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import { defaultTargets } from "../../src/data/targets";

describe("pipeline driver: default AEF targets", () => {
  it("produces a render plan with at least one unit and one edge", () => {
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const targets = defaultTargets();
    const { plan, machineGraph, containers } = buildRenderPlan({
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
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
      itemOverrides: [],
      targets,
      pack,
    });

    expect(plan.units.length).toBeGreaterThan(0);
    expect(plan.edges.length).toBeGreaterThan(0);
    // No-fold render emits one unit per machine vertex (recipe or loop) plus
    // boundary product units.
    for (const u of plan.units) {
      expect(["recipe", "loop", "inputProduct", "outputProduct"]).toContain(
        u.kind,
      );
    }
    expect(machineGraph.vertices.length).toBeGreaterThan(0);
    const hasNonzeroRate = plan.edges.some((e) => !e.rate.equals(0));
    expect(hasNonzeroRate).toBe(true);
    for (const c of containers.containers) {
      expect(["blueprint-group", "loop-box"]).toContain(c.kind);
    }
  });

  it("emits a target output edge for a target whose recipe is in a multi-recipe SCC (per-stamp spare capacity)", () => {
    // plant_grass_seed_1 produces Jincao Seed which is BOTH the user's target
    // AND an input to plant_grass_1 (the planting recipe). Pre-fix, the
    // boundary-products pass skipped every replica with an outgoing internal
    // edge, leaving the target port orphaned and routing the full net delivery
    // to surplus instead. The per-stamp spare-capacity rule emits one target
    // edge per replica with positive spare and proportionally distributes the
    // declared target rate.
    const targetRecipeId = "plant_grass_seed_1";
    const targetRatePerSec = { num: "2", denom: "1" }; // 120/min
    const targets = [
      { recipeId: targetRecipeId, ratePerSec: targetRatePerSec },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const { plan } = buildRenderPlan({
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
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
      itemOverrides: [],
      targets,
      pack,
    });

    const targetRecipe = pack.recipes.find((r) => r.id === targetRecipeId);
    if (!targetRecipe) throw new Error("test fixture missing");
    const targetItem = targetRecipe.out[0]!.item;
    const targetUnitId = `u:out:${targetItem}`;

    // The output product unit itself must be present (separate from the bug).
    expect(plan.units.some((u) => u.id === targetUnitId)).toBe(true);

    // The bug: no edges land on the target port. After the fix, at least one
    // edge from the recipe's render unit(s) routes the declared rate.
    const edgesToTarget = plan.edges.filter((e) => e.toUnit === targetUnitId);
    expect(edgesToTarget.length).toBeGreaterThan(0);

    // Mass conservation: the sum of incoming edge rates equals the declared
    // target rate (2 items per second).
    const totalIncoming = edgesToTarget.reduce(
      (acc, e) => acc.add(e.rate),
      new Fraction(0),
    );
    expect(totalIncoming.equals(new Fraction(2))).toBe(true);
  });

  // End-to-end Sandleaf plan targeting plant_moss_3 (tier-3 sandleaf SCC).
  // The loop renders two distinct planter render units (looper + deliverer)
  // plus one picker, with the looper carrying the intra-SCC tear arc and the
  // deliverer carrying the boundary-output to u:out:plant_moss_3.
  it("Sandleaf (plant_moss_3) target splits planter into looper + deliverer", () => {
    const targetRecipeId = "plant_moss_3";
    const targetItem = "plant_moss_3";
    const pickerRecipeId = "plant_moss_seed_3";
    // 1 plant/sec delivered cross-boundary; symmetric Sandleaf gives
    // planter exec = 2/sec, picker exec = 1/sec.
    const targets = [
      { recipeId: targetRecipeId, ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );

    // Mass-balance invariant: sum of split planter executionRates equals the
    // pre-split recipe rate (rates.get(plant_moss_3) == 2).
    const planterReplicas = full.replicas.filter(
      (r) => r.recipeId === targetRecipeId,
    );
    expect(planterReplicas.length).toBe(2);
    const splitSum = planterReplicas.reduce(
      (acc, r) => acc.add(r.executionRate),
      new Fraction(0),
    );
    expect(splitSum.equals(full.rates.get(targetRecipeId)!)).toBe(true);
    expect(full.rates.get(targetRecipeId)!.equals(new Fraction(2))).toBe(true);

    // Multiplier sum invariant: assignMultipliers ceil semantics applied per
    // role still sum to the pre-split aggregate (symmetric Sandleaf hits an
    // integer multiplier on each role: 2 + 2 = 4 == ceil(2 * 2 / 1)).
    const splitMultSum = planterReplicas.reduce(
      (acc, r) => acc + (full.multipliers.get(r.id) ?? 0),
      0,
    );
    expect(splitMultSum).toBe(4);

    // Bisim distinctness: full.replicas is already the quotient (one Replica
    // per equivalence class). Two quotient replicas for the same recipe id
    // prove the split landed in two distinct classes (the bisim refiner pins
    // SCC members as singleton classes and the split assigned them distinct
    // ids).
    expect(planterReplicas[0]!.id).not.toBe(planterReplicas[1]!.id);

    // Pipeline render: expect two recipe render units for the planter
    // (distinct replica ids) plus one for the picker.
    const { plan } = buildRenderPlan({
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
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
      itemOverrides: [],
      targets,
      pack,
    });
    const planterUnits = plan.units.filter(
      (u) => u.kind === "recipe" && u.recipeId === targetRecipeId,
    );
    const pickerUnits = plan.units.filter(
      (u) => u.kind === "recipe" && u.recipeId === pickerRecipeId,
    );
    expect(planterUnits.length).toBe(2);
    expect(pickerUnits.length).toBe(1);

    // Boundary output: declared 1 plant/sec routes through ONE of the two
    // planter units (the deliverer). Mass equals declared target rate.
    const targetUnitId = `u:out:${targetItem}`;
    const targetEdges = plan.edges.filter((e) => e.toUnit === targetUnitId);
    expect(targetEdges.length).toBeGreaterThan(0);
    const totalTargetRate = targetEdges.reduce(
      (acc, e) => acc.add(e.rate),
      new Fraction(0),
    );
    expect(totalTargetRate.equals(new Fraction(1))).toBe(true);

    // The deliverer is whichever planter unit FROMs a target edge; the looper
    // is the other one. Looper has an outgoing edge to the picker; deliverer
    // does not (only the target boundary edge).
    const delivererUnitId = targetEdges[0]!.fromUnit;
    const looperUnitId = planterUnits.find((u) => u.id !== delivererUnitId)!.id;
    const looperToPickerEdges = plan.edges.filter(
      (e) =>
        e.fromUnit === looperUnitId &&
        pickerUnits.some((p) => p.id === e.toUnit),
    );
    expect(looperToPickerEdges.length).toBeGreaterThan(0);
    const delivererToPickerEdges = plan.edges.filter(
      (e) =>
        e.fromUnit === delivererUnitId &&
        pickerUnits.some((p) => p.id === e.toUnit),
    );
    expect(delivererToPickerEdges.length).toBe(0);
  });
});
