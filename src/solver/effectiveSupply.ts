import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";

/**
 * Resolves the external boundary supply for an item given the active overrides.
 *
 * Returns `Infinity` when the item is a boundary with no finite cap (the
 * caller treats it as unlimited external supply and skips producer expansion
 * at this site). Returns a `Fraction` (possibly zero) when the caller should
 * treat external supply as a finite cap and build the deficit internally;
 * `Fraction(0)` means no external supply at all.
 *
 * Whether the item is `raw` (per `pack.items`) is part of the contract. Items
 * absent from `pack.items` are treated as non-raw.
 *
 * Resolution table:
 *   - No override entry, raw item:      `Infinity` (uncapped raw boundary).
 *   - No override entry, non-raw item:  `Fraction(0)` (fully built internally).
 *   - Override present, both fields absent (any item): `Infinity` (boundary
 *     marker; raw stays uncapped, non-raw gains unlimited external supply).
 *   - Override present, `plan: true`, raw item:     `Fraction(0)` (walk through
 *     raw, force build producers).
 *   - Override present, `plan: true`, non-raw item: `Infinity` (plan is
 *     silently ignored for non-raw; behaves as a boundary).
 *   - Override present, `ratePerSec` set:           parse `num`/`denom` into a
 *     `Fraction`. Zero forces internal build; positive caps external supply.
 *
 * O(n) over `overrides.length` plus the item lookup. Callers that hot-loop
 * can memoise via a `Map<ItemId, Fraction | typeof Infinity>` keyed on item id.
 */
export function effectiveSupply(
  itemId: string,
  pack: Pick<RecipePack, "items">,
  overrides: ItemOverride[],
): Fraction | typeof Infinity {
  const isRaw = pack.items.find((i) => i.id === itemId)?.raw === true;
  const override = overrides.find((o) => o.itemId === itemId);
  if (!override) {
    return isRaw ? Infinity : new Fraction(0);
  }
  if (override.ratePerSec !== undefined) {
    const { num, denom } = override.ratePerSec;
    return new Fraction(num).div(new Fraction(denom));
  }
  if (override.plan === true) {
    return isRaw ? new Fraction(0) : Infinity;
  }
  return Infinity;
}
