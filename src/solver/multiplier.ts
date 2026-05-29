import Fraction from "fraction.js";
import type { Machine, Recipe } from "@aef/schema";
import type { Replica, ReplicaId } from "./types";
import { MissingMachineError } from "./types";

export function assignMultipliers(
  replicas: Replica[],
  machineById: Map<string, Machine>,
  recipeById: Map<string, Recipe>,
): Map<ReplicaId, number> {
  const result = new Map<ReplicaId, number>();
  for (const r of replicas) {
    if (r.executionRate.equals(0)) continue;
    const recipe = recipeById.get(r.recipeId);
    if (!recipe) throw new MissingMachineError(r.recipeId, undefined);
    const producerId = recipe.producers[0];
    if (!producerId) throw new MissingMachineError(r.recipeId, undefined);
    const machine = machineById.get(producerId);
    if (!machine) throw new MissingMachineError(r.recipeId, producerId);
    const speedFrac = new Fraction(machine.speed);
    const timeFrac = new Fraction(recipe.time);
    const ideal = r.executionRate.mul(timeFrac).div(speedFrac);
    // ceil(0) rounds up to a whole number and valueOf() hands back a JS
    // number. We already skipped zero-rate replicas, so executionRate is
    // positive here and the ceiling is always at least 1.
    result.set(r.id, Number(ideal.ceil(0).valueOf()));
  }
  return result;
}

/**
 * Same calculation as assignMultipliers, but returns the exact rational ideal
 * count without taking the ceiling. Downstream stages use the fractional
 * ideals to fold equivalent replicas during bisim hash-consing before any
 * rounding happens.
 */
export function assignIdealMultipliers(
  replicas: Replica[],
  machineById: Map<string, Machine>,
  recipeById: Map<string, Recipe>,
): Map<ReplicaId, Fraction> {
  const result = new Map<ReplicaId, Fraction>();
  for (const r of replicas) {
    if (r.executionRate.equals(0)) continue;
    const recipe = recipeById.get(r.recipeId);
    if (!recipe) throw new MissingMachineError(r.recipeId, undefined);
    const producerId = recipe.producers[0];
    if (!producerId) throw new MissingMachineError(r.recipeId, undefined);
    const machine = machineById.get(producerId);
    if (!machine) throw new MissingMachineError(r.recipeId, producerId);
    const speedFrac = new Fraction(machine.speed);
    const timeFrac = new Fraction(recipe.time);
    const ideal = r.executionRate.mul(timeFrac).div(speedFrac);
    result.set(r.id, ideal);
  }
  return result;
}
