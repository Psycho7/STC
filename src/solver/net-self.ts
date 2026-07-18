import Fraction from "fraction.js";
import type { Recipe, RecipePack, Stoich } from "@aef/schema";

// Net away self-consumption (the same item on a recipe's in AND out side)
// before the pack enters the solve pipeline. The pack keeps the raw in-game
// stoichiometry for display; every flow-math layer (graph walk, LP, replicate,
// edge derivation, invariant checkers) sees the steady-state-equivalent net
// form instead, so a self-consuming recipe never materializes a self-edge.
// Without this, a singleton self-loop reaches replicate's per-consumer branch
// and trips its fail-loud guard.
//
// Per overlapping item: net = out.qty - in.qty. Positive nets stay on the out
// side, negative nets on the in side, zero nets drop the item from both.
// Arithmetic runs through Fraction so decimal quantities (e.g. 1 - 0.2) net
// exactly instead of accumulating float error.
export function netSelfConsumption(pack: RecipePack): RecipePack {
  let changed = false;
  const recipes = pack.recipes.map((r) => {
    const outByItem = new Map(r.out.map((s) => [s.item, s]));
    if (!r.in.some((s) => outByItem.has(s.item))) return r;
    changed = true;
    return netRecipe(r, outByItem);
  });
  return changed ? { ...pack, recipes } : pack;
}

function netRecipe(r: Recipe, outByItem: ReadonlyMap<string, Stoich>): Recipe {
  const inByItem = new Map(r.in.map((s) => [s.item, s]));
  const nettedIn: Stoich[] = [];
  const nettedOut: Stoich[] = [];
  for (const s of r.in) {
    const out = outByItem.get(s.item);
    if (!out) {
      nettedIn.push(s);
      continue;
    }
    const net = new Fraction(out.qty).sub(new Fraction(s.qty));
    if (net.compare(0) < 0) nettedIn.push({ item: s.item, qty: Number(net.neg().valueOf()) });
  }
  for (const s of r.out) {
    const inp = inByItem.get(s.item);
    if (!inp) {
      nettedOut.push(s);
      continue;
    }
    const net = new Fraction(s.qty).sub(new Fraction(inp.qty));
    if (net.compare(0) > 0) nettedOut.push({ item: s.item, qty: Number(net.valueOf()) });
  }
  return { ...r, in: nettedIn, out: nettedOut };
}
