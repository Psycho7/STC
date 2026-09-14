import Fraction from "fraction.js";
import type { Machine, Recipe, Stoich } from "@aef/schema";
import type { SupplyTable } from "./effectiveSupply";
import type { ItemId, Replica, ReplicaId, RecipeId } from "./types";
import { MissingMachineError } from "./types";

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

const FRAC_ZERO = new Fraction(0);

const minOf = (a: Fraction, b: Fraction): Fraction =>
  a.compare(b) <= 0 ? a : b;

/** What one catalyst item's charge was billed to, in items per second. */
export type CatalystAccountEntry = {
  /** Total per-machine charge the plan holds, summed over every replica. */
  need: Fraction;
  /** Billed to pool C, the dedicated catalyst supply. */
  fromCatalyst: Fraction;
  /** Billed to pool G, the ordinary supply, out of what it had left. */
  fromGeneral: Fraction;
  /** Neither pool could hold this much. A report, never a solver state. */
  unmet: Fraction;
};

export type CatalystAccount = ReadonlyMap<ItemId, CatalystAccountEntry>;

export type CatalystAccountInput = {
  replicas: ReadonlyArray<Pick<Replica, "id" | "recipeId">>;
  /** Exact rational machine count per replica, pre-ceiling. */
  idealCount: ReadonlyMap<ReplicaId, Fraction>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  machineById: ReadonlyMap<string, Machine>;
  supply: SupplyTable;
  /** The LP's realized boundary draw per finite-positive-capped item. */
  draws: ReadonlyMap<ItemId, Fraction>;
};

/**
 * Headroom pool G leaves the catalyst, in items per second.
 *
 * A typed cap is finite and a supply the user never typed a cap for is not,
 * so the three ways `effectiveSupply` produces `Fraction(0)` split apart here:
 *
 *   G state                         | no C row   | C row present
 *   --------------------------------|------------|--------------
 *   free (supply Infinity)          | Infinity   | Infinity
 *   typed cap Y > 0                 | max(0, Y - ordinary)
 *   typed cap 0                     | 0          | 0
 *   plan:true raw / non-raw default | Infinity   | 0
 *
 * The last row is what keeps every default transmuter plan quiet: nobody
 * typed a limit, so nothing throttles the charge. Once the user configures a
 * catalyst pool, the ordinary supply is theirs to spend and only what it
 * openly left over feeds the catalyst.
 *
 * `ordinary` is the LP's draw, which exists only for a finite positive cap; a
 * free item has no cap to leave headroom in and a zero item draws nothing.
 * The clamp covers a snapped draw landing a hair above its own cap.
 */
function generalHeadroom(
  itemId: ItemId,
  supply: SupplyTable,
  draws: ReadonlyMap<ItemId, Fraction>,
  hasCatalystRow: boolean,
): Fraction | typeof Infinity {
  const general = supply.supplyOf(itemId);
  // `typeof Infinity` is `number`, so the free case narrows on the value type.
  if (typeof general === "number") return Infinity;
  if (!supply.hasTypedCap(itemId)) {
    return hasCatalystRow ? FRAC_ZERO : Infinity;
  }
  if (!(general.valueOf() > 0)) return FRAC_ZERO;
  const ordinary = draws.get(itemId) ?? FRAC_ZERO;
  const left = general.sub(ordinary);
  return left.compare(0) > 0 ? left : FRAC_ZERO;
}

/**
 * Post-solve catalyst account: what each catalyst item's charge costs and
 * which pool pays for it.
 *
 * The LP never sees a catalyst, so this runs entirely on its outputs: the
 * per-replica machine counts give the need, the supply table gives the two
 * pools, and the LP's own draws say how much of a typed cap the ordinary
 * consumption already spent. "C first" is an accounting order, not a
 * topology: the need is billed to C up to its cap, the remainder to G's
 * headroom, and whatever is left over is reported as `unmet`.
 *
 * Pure, and recomputable from the same inputs, which is how the invariant
 * checker can double-enter it. Items the plan cycles nothing of are omitted.
 */
export function buildCatalystAccount(
  input: CatalystAccountInput,
): Map<ItemId, CatalystAccountEntry> {
  const { idealCount, recipeById, machineById, supply, draws } = input;
  const recipeOfReplica = new Map(
    input.replicas.map((r) => [r.id, r.recipeId]),
  );

  const need = new Map<ItemId, Fraction>();
  for (const [replicaId, machines] of idealCount) {
    const recipeId = recipeOfReplica.get(replicaId);
    if (recipeId === undefined) continue;
    const recipe = recipeById.get(recipeId);
    const catalysts = recipe?.catalyst ?? [];
    if (recipe === undefined || catalysts.length === 0) continue;
    const producerId = recipe.producers[0];
    const machine =
      producerId === undefined ? undefined : machineById.get(producerId);
    if (machine === undefined) {
      throw new MissingMachineError(recipeId, producerId);
    }
    for (const stoich of catalysts) {
      const charge = catalystChargeOf(machines, stoich, recipe, machine);
      if (charge.compare(0) <= 0) continue;
      need.set(stoich.item, (need.get(stoich.item) ?? FRAC_ZERO).add(charge));
    }
  }

  const account = new Map<ItemId, CatalystAccountEntry>();
  for (const [itemId, total] of need) {
    const pool = supply.catalystSupplyOf(itemId);
    const fromCatalyst =
      pool === undefined
        ? FRAC_ZERO
        : typeof pool === "number"
          ? total
          : minOf(total, pool);
    const remainder = total.sub(fromCatalyst);
    const headroom = generalHeadroom(itemId, supply, draws, pool !== undefined);
    const fromGeneral =
      typeof headroom === "number" ? remainder : minOf(remainder, headroom);
    account.set(itemId, {
      need: total,
      fromCatalyst,
      fromGeneral,
      unmet: remainder.sub(fromGeneral),
    });
  }
  return account;
}
