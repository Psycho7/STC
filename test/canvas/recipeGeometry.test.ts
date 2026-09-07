import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import { portOffsetY } from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
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

function fakeRecipe(
  inCount: number,
  outCount: number,
  catalystCount = 0,
): Recipe {
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
    ...(catalystCount > 0
      ? {
          catalyst: Array.from({ length: catalystCount }, (_, i) => ({
            item: `c${i}`,
            qty: 1,
          })),
        }
      : {}),
    producers: ["smelter"],
  } as Recipe;
}

// A recipe node standing in for what the routing passes hand portOffsetY. Only
// the type discriminator and the recipe are read on this path.
function fakeNode(recipe: Recipe): RFAnyNode {
  return {
    id: "n",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe },
  } as unknown as RFAnyNode;
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

  // A catalyst is drawn on the input side as an extra row with no handle, so it
  // occupies a row of card height while adding nothing to the handle arrays.
  // Height counts in + catalyst against the output side; the invariant on
  // inHandleYs stays on recipe.in alone.
  it("counts catalyst rows in the height and leaves the handle arrays on the port counts", () => {
    const g = measureRecipe(fakeRecipe(2, 1, 1));
    expect(g.height).toBe(recipeHeight(3, 1));
    expect(g.inHandleYs).toHaveLength(2);
    expect(g.outHandleYs).toHaveLength(1);
    // 80 header + 12 side pads + 3 * 22 rows + 26 footer.
    expect(g.height).toBe(184);
  });

  // The rows append AFTER the ports, so no port moves. This is the property the
  // whole placement of catalyst rows at the bottom exists to preserve: every
  // routed edge endpoint on a transmuter card lands where it did before.
  it("leaves every port y unchanged when a catalyst row is added", () => {
    const plain = measureRecipe(fakeRecipe(2, 1));
    const withCatalyst = measureRecipe(fakeRecipe(2, 1, 1));
    expect(withCatalyst.inHandleYs).toEqual(plain.inHandleYs);
    expect(withCatalyst.outHandleYs).toEqual(plain.outHandleYs);
  });

  // portOffsetY is what the routing and seating passes actually call; it reads
  // the handle arrays above, so the invariance has to hold end to end.
  it("portOffsetY answers the same row y with and without a catalyst", () => {
    const plain = fakeRecipe(2, 1);
    const withCatalyst = fakeRecipe(2, 1, 1);
    for (const item of ["i0", "i1"]) {
      expect(portOffsetY(fakeNode(withCatalyst), item, "in")).toBe(
        portOffsetY(fakeNode(plain), item, "in"),
      );
    }
    expect(portOffsetY(fakeNode(withCatalyst), "o0", "out")).toBe(
      portOffsetY(fakeNode(plain), "o0", "out"),
    );
    // A catalyst item is not a port: it resolves to the centre fallback, which
    // on a 3-row card is 92 and can never collide with a row mid-line.
    expect(portOffsetY(fakeNode(withCatalyst), "c0", "in")).toBe(92);
  });
});
