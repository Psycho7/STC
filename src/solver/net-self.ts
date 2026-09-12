import Fraction from "fraction.js";
import type { Recipe, RecipePack, Stoich } from "@aef/schema";

import type { RecipeId } from "./types";

// Phantom brand separating the two forms of a pack. It exists only in the type
// system (nothing ever writes the key) and stays here rather than in
// @aef/schema: RecipePack is the extractor's vendor-facing contract, and
// netting is a planner concept.
//
// NettedPack carries the key as `true`; RawPack carries it as optional-never.
// So a plain RecipePack is a RawPack (the key is absent) while a NettedPack is
// not, which is what makes "this parameter wants the raw pack" enforceable.
// No runtime predicate can tell the two apart: netSelfConsumption returns its
// argument unchanged both for an already-netted pack and for a raw pack with
// no self-consuming recipes.
declare const nettedBrand: unique symbol;

/** A pack whose self-consumption has been netted away. */
export type NettedPack = RecipePack & { readonly [nettedBrand]: true };

/** The in-game pack, as shipped. Every display layer wants this one. */
export type RawPack = RecipePack & { readonly [nettedBrand]?: never };

/** Recipe lookup built from a netted pack; carries the same brand. */
export type NettedRecipeMap = Map<RecipeId, Recipe> & {
  readonly [nettedBrand]: true;
};

/** Recipe lookup built from a raw pack, i.e. the in-game stoichiometry. */
export type RawRecipeMap = ReadonlyMap<RecipeId, Recipe> & {
  readonly [nettedBrand]?: never;
};

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
export function netSelfConsumption(pack: RecipePack): NettedPack {
  let changed = false;
  const recipes = pack.recipes.map((r) => {
    const outByItem = new Map(r.out.map((s) => [s.item, s]));
    if (!r.in.some((s) => outByItem.has(s.item))) return r;
    changed = true;
    return netRecipe(r, outByItem);
  });
  return (changed ? { ...pack, recipes } : pack) as NettedPack;
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
