import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  RECIPE_FOOTER_HEIGHT,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_ROW_HEIGHT,
  RECIPE_WIDTH,
  recipeHeight,
} from "../../src/canvas/dimensions";

// The model is pinned to the rendered DOM (canvas.css): .rn-head is height:80px,
// .rn-side has a 6px top/bottom pad, .rn-row is 22px, .rn-footer is 26px. A row
// mid-line therefore sits at header + side pad + i*row + half-row; the browser
// (zoom 1) puts the real handle center one further pixel down (the node's own
// 1px border, which the model leaves out on both height and handle Y).
const rowMid = (i: number) =>
  RECIPE_HEADER_HEIGHT +
  RECIPE_ROWS_TOP_PAD +
  i * RECIPE_ROW_HEIGHT +
  RECIPE_ROW_HEIGHT / 2;

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
    expect(g.inHandleYs[0]).toBe(rowMid(0));
    expect(g.inHandleYs[2]).toBe(rowMid(2));
    // Concrete pinned values (80 + 6 + i*22 + 11) so a constant change re-pins.
    expect(g.inHandleYs).toEqual([97, 119, 141]);
  });

  it("outHandleYs uses the same row spacing as inHandleYs", () => {
    const g = measureRecipe(fakeRecipe(0, 2));
    expect(g.outHandleYs).toEqual([rowMid(0), rowMid(1)]);
    expect(g.outHandleYs).toEqual([97, 119]);
  });

  it("height counts header, both side pads, the taller side's rows, and footer", () => {
    // 1x1: 80 header + 12 side pads + 22 row + 26 footer = 140.
    expect(measureRecipe(fakeRecipe(1, 1)).height).toBe(
      RECIPE_HEADER_HEIGHT +
        RECIPE_ROWS_TOP_PAD * 2 +
        RECIPE_ROW_HEIGHT +
        RECIPE_FOOTER_HEIGHT,
    );
    expect(measureRecipe(fakeRecipe(1, 1)).height).toBe(140);
  });

  it("empty handle arrays when a recipe has no ports of that side", () => {
    expect(measureRecipe(fakeRecipe(0, 1)).inHandleYs).toEqual([]);
    expect(measureRecipe(fakeRecipe(1, 0)).outHandleYs).toEqual([]);
  });
});
