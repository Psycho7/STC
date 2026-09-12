import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { ItemId } from "./types";
import { rationalFromString } from "../data/targets";

/** Resolved external boundary supply for one item. */
export type Supply = Fraction | typeof Infinity;

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
 * O(n) over `overrides.length` plus the item lookup. Callers reading more than
 * one item resolve the whole set once through `buildSupplyTable` instead.
 */
export function effectiveSupply(
  itemId: string,
  pack: Pick<RecipePack, "items">,
  overrides: ReadonlyArray<ItemOverride>,
): Supply {
  const isRaw = pack.items.find((i) => i.id === itemId)?.raw === true;
  const override = overrides.find((o) => o.itemId === itemId);
  if (!override) {
    return isRaw ? Infinity : new Fraction(0);
  }
  if (override.ratePerSec !== undefined) {
    return rationalFromString(override.ratePerSec);
  }
  if (override.plan === true) {
    return isRaw ? new Fraction(0) : Infinity;
  }
  return Infinity;
}

const FRAC_ZERO = new Fraction(0);

/**
 * Every item's effective supply, resolved once against one pack and one
 * override list.
 *
 * Resolution reads `pack.items` and nothing else in the pack, so a netted pack
 * and the raw original it came from produce identical tables: the solve half
 * and the render half can each build their own and still agree. That agreement
 * is a property of this type, not a convention the callers have to keep.
 *
 * Entries exist for `pack.items` plus every overridden item id, the latter
 * possibly absent from the pack. `supplyOf` for an id outside that set answers
 * `Fraction(0)`, matching the rule's treatment of an unknown item as non-raw
 * with no override. Queries never throw; a malformed `ratePerSec` throws while
 * the table is being built.
 *
 * The table is immutable once built and owns the memoisation, so no caller
 * memoises a second time.
 */
export type SupplyTable = {
  /** `Infinity` for a free boundary, otherwise a (possibly zero) cap. */
  supplyOf(itemId: ItemId): Supply;
  /**
   * True for an uncapped boundary item. `typeof Infinity` is `number`, so a
   * caller narrowing a `Supply` by hand must test the value type
   * (`typeof supply === "number"`) rather than `=== Infinity`; this predicate
   * exists so it does not have to.
   */
  isFree(itemId: ItemId): boolean;
  /** Every entry, pack items first, in pack order then override order. */
  entries(): IterableIterator<readonly [ItemId, Supply]>;
};

/** Resolves `effectiveSupply` for every item the pack and the overrides name. */
export function buildSupplyTable(
  pack: Pick<RecipePack, "items">,
  overrides: ReadonlyArray<ItemOverride>,
): SupplyTable {
  const byItem = new Map<ItemId, Supply>();
  for (const it of pack.items) {
    byItem.set(it.id, effectiveSupply(it.id, pack, overrides));
  }
  for (const ov of overrides) {
    if (byItem.has(ov.itemId)) continue;
    byItem.set(ov.itemId, effectiveSupply(ov.itemId, pack, overrides));
  }

  return {
    supplyOf: (itemId) => byItem.get(itemId) ?? FRAC_ZERO,
    isFree: (itemId) => byItem.get(itemId) === Infinity,
    entries: () => byItem.entries(),
  };
}
