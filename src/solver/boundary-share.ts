import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import type { ItemId, RecipeId } from "./types";

const ZERO = new Fraction(0);
const ONE = new Fraction(1);

/**
 * The one proration rule for finite-supply boundary draws: for each item the
 * LP drew from the boundary (draw > 0), the fraction of its consumption that
 * IN-GRAPH producers must still cover.
 *
 *   cons_i  = sum over recipes of inQty_i(r) * rate(r)   (exact rationals)
 *   share_i = clamp((cons_i - draw_i) / cons_i, 0, 1)
 *
 * Items with draw 0 (or no consumption) get no entry; callers default a
 * missing entry to share 1 (in-graph producers cover everything, the boundary
 * contributes nothing). Every consumer of a drawn item takes share_i of its
 * per-item demand from in-graph producers and (1 - share_i) from the boundary,
 * identically across replicate, edge billing, and boundary-product emission,
 * so all layers agree on one definition of the cap.
 */
export function boundaryResidualShare(
  recipes: ReadonlyArray<Recipe>,
  rates: ReadonlyMap<RecipeId, Fraction>,
  draws: ReadonlyMap<ItemId, Fraction>,
): Map<ItemId, Fraction> {
  const result = new Map<ItemId, Fraction>();
  if (draws.size === 0) return result;

  // Exact consumption per drawn item over the active rates.
  const consumption = new Map<ItemId, Fraction>();
  for (const r of recipes) {
    const rate = rates.get(r.id);
    if (rate === undefined || rate.compare(ZERO) <= 0) continue;
    for (const inp of r.in) {
      if (!draws.has(inp.item) || inp.qty <= 0) continue;
      consumption.set(
        inp.item,
        (consumption.get(inp.item) ?? ZERO).add(rate.mul(new Fraction(inp.qty))),
      );
    }
  }

  for (const [itemId, draw] of draws) {
    if (draw.compare(ZERO) <= 0) continue;
    const cons = consumption.get(itemId);
    if (cons === undefined || cons.compare(ZERO) <= 0) continue;
    let share = cons.sub(draw).div(cons);
    if (share.compare(ZERO) < 0) share = ZERO;
    if (share.compare(ONE) > 0) share = ONE;
    result.set(itemId, share);
  }
  return result;
}
