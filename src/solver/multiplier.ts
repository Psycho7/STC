import Fraction from "fraction.js";
import type { Machine, Recipe } from "@aef/schema";
import type { Replica, ReplicaId } from "./types";
import { MissingMachineError } from "./types";

/**
 * Exact rational machine count per replica: executionRate * recipe time /
 * machine speed, with zero-rate replicas dropped. Downstream stages use the
 * fractional ideals to fold equivalent replicas during bisim hash-consing
 * before any rounding happens; the solve path ceils them into the integer
 * machine counts.
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
