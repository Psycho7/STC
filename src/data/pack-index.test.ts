import { expect, it } from "vitest";
import { pack } from "./load";
import { packIndex } from "./pack-index";

it("packIndex indexes items, recipes and machines by id", () => {
  const index = packIndex(pack);
  const item = pack.items[0]!;
  const recipe = pack.recipes[0]!;
  const machine = pack.machines[0]!;
  expect(index.itemById.get(item.id)).toBe(item);
  expect(index.recipeById.get(recipe.id)).toBe(recipe);
  expect(index.machineById.get(machine.id)).toBe(machine);
  expect(index.itemById.size).toBe(new Set(pack.items.map((i) => i.id)).size);
});

it("packIndex is memoized per pack object", () => {
  expect(packIndex(pack)).toBe(packIndex(pack));
  expect(packIndex({ ...pack })).not.toBe(packIndex(pack));
});
