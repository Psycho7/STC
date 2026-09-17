import type { Item, Machine, Recipe, RecipePack } from "@aef/schema";

export type PackIndex = {
  itemById: ReadonlyMap<string, Item>;
  recipeById: ReadonlyMap<string, Recipe>;
  machineById: ReadonlyMap<string, Machine>;
};

// Id lookups over one pack object, built once per object. The cache is keyed
// on identity, so a raw pack and its netted copy (a different object whenever
// netting changed a recipe) never share an index. Last id wins on a duplicate.
const packIndexCache = new WeakMap<RecipePack, PackIndex>();

export function packIndex(pack: RecipePack): PackIndex {
  let index = packIndexCache.get(pack);
  if (index === undefined) {
    index = {
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      recipeById: new Map(pack.recipes.map((r) => [r.id, r])),
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
    };
    packIndexCache.set(pack, index);
  }
  return index;
}
