import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { renderPlanFromSolve } from "../../src/pipeline/driver";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import {
  defaultTargets,
  rationalFromString,
} from "../../src/data/targets";

describe("pipeline driver: default AEF targets", () => {
  it("produces a render plan with at least one unit and one edge", () => {
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const targets = defaultTargets();
    const { plan, machineGraph, containers } = renderPlanFromSolve(
      full,
      pack,
      targets,
      [],
    );

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
      { itemId: "plant_grass_seed_1", ratePerSec: targetRatePerSec },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);

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
      { itemId: targetItem, ratePerSec: { num: "1", denom: "1" } },
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
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
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

// D06 pin: stamping is capped per replica class, and the cap is invisible in
// the folded plan. Scaling one target by 1000 pushes several classes past the
// cap; the render plan that comes out must have the same units and the same
// edges as the x1 plan, with every rate scaled by exactly 1000.
describe("pipeline driver: stamp cap is invisible after folding", () => {
  const solve = (ratePerSec: { num: string; denom: string }) => {
    const targets = [{ itemId: "proc_battery_5", ratePerSec }];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    return { full, ...renderPlanFromSolve(full, pack, targets, []) };
  };

  const SCALE = 1000;
  const one = solve({ num: "1", denom: "2" }); // 30/min
  const kilo = solve({ num: String(SCALE), denom: "2" }); // 30,000/min

  const unitKeys = (p: (typeof one)["plan"]) =>
    p.units.map((u) => `${u.kind} ${u.id}`);
  const edgeKeys = (p: (typeof one)["plan"]) =>
    p.edges.map((e) => `${e.fromUnit} -> ${e.toUnit} ${e.item}`);

  const census = (r: typeof one) => {
    const stampsByReplica = new Map<string, number>();
    for (const v of r.machineGraph.vertices) {
      if (v.kind !== "machine") continue;
      stampsByReplica.set(
        v.replicaId,
        (stampsByReplica.get(v.replicaId) ?? 0) + 1,
      );
    }
    const ideals = [...stampsByReplica.keys()].map((id) =>
      Number(r.full.idealCount.get(id)?.valueOf() ?? 0),
    );
    return {
      maxStamps: Math.max(...stampsByReplica.values()),
      maxIdeal: Math.max(...ideals),
    };
  };

  it("stamps x1 in full and collapses x1000 past the cap", () => {
    // x1 is the uncapped side: every machine of the busiest class gets its own
    // stamp. x1000 asks for orders of magnitude more machines and still hands
    // out a bounded number of stamps, so the two sides below are a capped plan
    // compared against an uncapped one.
    const small = census(one);
    expect(small.maxStamps).toBe(Math.ceil(small.maxIdeal));
    const large = census(kilo);
    expect(large.maxIdeal).toBeGreaterThan(1000);
    expect(large.maxStamps).toBeLessThanOrEqual(65);
  });

  it("emits the same units and edges at x1 and x1000", () => {
    expect(unitKeys(kilo.plan)).toEqual(unitKeys(one.plan));
    expect(edgeKeys(kilo.plan)).toEqual(edgeKeys(one.plan));
  });

  it("scales every folded rate by exactly 1000", () => {
    for (const [i, e] of one.plan.edges.entries()) {
      const scaled = kilo.plan.edges[i]!;
      expect(scaled.rate.equals(e.rate.mul(SCALE))).toBe(true);
    }
    for (const [i, u] of one.plan.units.entries()) {
      const scaled = kilo.plan.units[i]!;
      if (u.kind !== "recipe" || scaled.kind !== "recipe") continue;
      expect(
        rationalFromString(scaled.multiplicity).equals(
          rationalFromString(u.multiplicity).mul(SCALE),
        ),
      ).toBe(true);
    }
  });
});
