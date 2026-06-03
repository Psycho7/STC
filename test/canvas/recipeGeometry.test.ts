import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
  RECIPE_WIDTH,
  recipeHeight,
} from "../../src/canvas/dimensions";

function fakeRecipe(inCount: number, outCount: number): Recipe {
  return {
    id: "fake",
    name: "Fake",
    category: "smelt",
    icon: "fake",
    row: 0,
    time: 1,
    in: Array.from({ length: inCount }, (_, i) => ({
      item: `i${i}`,
      qty: 1,
    })),
    out: Array.from({ length: outCount }, (_, i) => ({
      item: `o${i}`,
      qty: 1,
    })),
    producers: ["smelter"],
  } as Recipe;
}

describe("measureRecipe", () => {
  it("width matches RECIPE_WIDTH", () => {
    expect(measureRecipe(fakeRecipe(1, 1)).width).toBe(RECIPE_WIDTH);
  });

  it("height equals recipeHeight(inCount, outCount) for matched and unmatched port counts", () => {
    const g11 = measureRecipe(fakeRecipe(1, 1));
    expect(g11.height).toBe(recipeHeight(1, 1));
    const g31 = measureRecipe(fakeRecipe(3, 1));
    expect(g31.height).toBe(recipeHeight(3, 1));
    const g13 = measureRecipe(fakeRecipe(1, 3));
    expect(g13.height).toBe(recipeHeight(1, 3));
  });

  it("inHandleYs has one entry per input port, sitting at the row mid-line", () => {
    const g = measureRecipe(fakeRecipe(3, 0));
    expect(g.inHandleYs).toHaveLength(3);
    expect(g.inHandleYs[0]).toBe(RECIPE_HEADER_HEIGHT + RECIPE_ROW_HEIGHT / 2);
    expect(g.inHandleYs[2]).toBe(
      RECIPE_HEADER_HEIGHT + 2 * RECIPE_ROW_HEIGHT + RECIPE_ROW_HEIGHT / 2,
    );
  });

  it("outHandleYs uses the same row spacing as inHandleYs", () => {
    const g = measureRecipe(fakeRecipe(0, 2));
    expect(g.outHandleYs).toEqual([
      RECIPE_HEADER_HEIGHT + RECIPE_ROW_HEIGHT / 2,
      RECIPE_HEADER_HEIGHT + RECIPE_ROW_HEIGHT + RECIPE_ROW_HEIGHT / 2,
    ]);
  });

  it("empty handle arrays when a recipe has no ports of that side", () => {
    expect(measureRecipe(fakeRecipe(0, 1)).inHandleYs).toEqual([]);
    expect(measureRecipe(fakeRecipe(1, 0)).outHandleYs).toEqual([]);
  });
});
