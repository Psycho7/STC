import Fraction from "fraction.js";
import type { Machine, Recipe, Stoich } from "@aef/schema";

/**
 * Per-machine catalyst charge in items per second.
 *
 * The game charges a catalyst per machine, not per cycle: a transmuter holds
 * its whole charge while it runs, so throttling it does not lower the draw and
 * a fractional machine count still occupies a whole machine. Hence the ceil:
 * 3.3 machines draw 4 machines' worth.
 *
 *   ceil(machines) * qty * speed / time
 *
 * `qty`, `speed` and `time` are pack numbers; they go through Fraction the
 * same way assignIdealMultipliers converts them, so a pack qty of 0.2 stays
 * exactly 1/5.
 */
export function catalystChargeOf(
  machines: Fraction,
  stoich: Stoich,
  recipe: Pick<Recipe, "time">,
  machine: Pick<Machine, "speed">,
): Fraction {
  const wholeMachines = machines.ceil(0);
  const perMachine = new Fraction(stoich.qty)
    .mul(new Fraction(machine.speed))
    .div(new Fraction(recipe.time));
  return wholeMachines.mul(perMachine);
}
