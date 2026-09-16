import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import { nodeHeight, portOffsetY } from "../../src/canvas/nodeGeometry";
import { ENV_ROW_HEIGHT } from "../../src/canvas/envBanner";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  CATALYST_BLOCK_GAP,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_ROW_HEIGHT,
  RECIPE_WIDTH,
  recipeHeight,
} from "../../src/canvas/dimensions";

// The model is pinned to the rendered DOM (canvas.css): .rn-head is height:56px,
// .rn-side has a 6px top/bottom pad, .rn-row is 22px, and there is no footer.
// A row mid-line therefore sits at header + side pad + i*row + half-row; the
// browser (zoom 1) puts the real handle center one further pixel down (the
// node's own 1px border, which the model leaves out on both height and
// handle Y).
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

// The same recipe, gas-gated: the only field the plate row turns on.
function withEnvironment(recipe: Recipe): Recipe {
  return { ...recipe, environment: "stable" } as Recipe;
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
    // Concrete pinned values (56 + 6 + i*22 + 11) so a constant change re-pins.
    expect(g.inHandleYs).toEqual([73, 95, 117]);
  });

  it("outHandleYs uses the same row spacing as inHandleYs", () => {
    const g = measureRecipe(fakeRecipe(0, 2));
    expect(g.outHandleYs).toEqual([rowMid(0), rowMid(1)]);
    expect(g.outHandleYs).toEqual([73, 95]);
  });

  it("height counts header, both side pads, and the taller side's rows", () => {
    // 1x1: 56 header + 12 side pads + 22 row = 90.
    expect(measureRecipe(fakeRecipe(1, 1)).height).toBe(
      RECIPE_HEADER_HEIGHT + RECIPE_ROWS_TOP_PAD * 2 + RECIPE_ROW_HEIGHT,
    );
    expect(measureRecipe(fakeRecipe(1, 1)).height).toBe(90);
  });

  it("empty handle arrays when a recipe has no ports of that side", () => {
    expect(measureRecipe(fakeRecipe(0, 1)).inHandleYs).toEqual([]);
    expect(measureRecipe(fakeRecipe(1, 0)).outHandleYs).toEqual([]);
  });

  // A catalyst row sits at the bottom of the input column and carries its own
  // handle, so it gets its own array: inHandleYs stays on recipe.in alone and
  // catHandleYs continues the same row sequence.
  it("counts catalyst rows and their block gap in the height, keeping them out of inHandleYs", () => {
    const g = measureRecipe(fakeRecipe(2, 1, 1));
    expect(g.height).toBe(recipeHeight(3, 1, true));
    expect(g.inHandleYs).toHaveLength(2);
    expect(g.outHandleYs).toHaveLength(1);
    // 56 header + 12 side pads + 3 * 22 rows + the 11px block gap.
    expect(g.height).toBe(145);
    // The gap is charged only when the card carries a catalyst block.
    expect(recipeHeight(3, 1)).toBe(134);
  });

  it("puts catHandleYs on the rows after the input rows, below the block gap", () => {
    const g = measureRecipe(fakeRecipe(2, 1, 2));
    expect(g.catHandleYs).toEqual([
      rowMid(2) + CATALYST_BLOCK_GAP,
      rowMid(3) + CATALYST_BLOCK_GAP,
    ]);
    expect(g.catHandleYs).toEqual([128, 150]);
    expect(measureRecipe(fakeRecipe(2, 1)).catHandleYs).toEqual([]);
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
    // A catalyst item is on no input row: asked for side "in" it resolves to
    // the centre fallback, which on a 3-row card carrying a catalyst block is
    // 72.5 and can never collide with a row mid-line.
    expect(portOffsetY(fakeNode(withCatalyst), "c0", "in")).toBe(72.5);
  });

  // Side "cat" is what a catalyst edge's target end resolves with: the row is
  // read off recipe.catalyst, never off the input rows, so a card carrying the
  // same item on both sides answers each side with its own row.
  it("portOffsetY resolves side 'cat' on the catalyst rows", () => {
    const withCatalyst = fakeRecipe(2, 1, 1);
    const geom = measureRecipe(withCatalyst);
    expect(portOffsetY(fakeNode(withCatalyst), "c0", "cat")).toBe(
      geom.catHandleYs[0],
    );
    // An input item is on no catalyst row: centre fallback.
    expect(portOffsetY(fakeNode(withCatalyst), "i0", "cat")).toBe(72.5);
  });

  // The environment plate is the card's first row (ruling I9): it grows the
  // box by one ENV_ROW_HEIGHT and pushes every row below it down by the same,
  // so the ELK box the layout hands out IS the box the DOM paints.
  it("charges the environment plate to the height and shifts every handle by it", () => {
    const plain = measureRecipe(fakeRecipe(2, 1, 1));
    const env = measureRecipe(withEnvironment(fakeRecipe(2, 1, 1)));

    expect(env.height).toBe(plain.height + ENV_ROW_HEIGHT);
    expect(env.height).toBe(recipeHeight(3, 1, true, true));
    expect(env.width).toBe(plain.width);

    const shifted = (ys: number[]) => ys.map((y) => y + ENV_ROW_HEIGHT);
    expect(env.inHandleYs).toEqual(shifted(plain.inHandleYs));
    expect(env.outHandleYs).toEqual(shifted(plain.outHandleYs));
    expect(env.catHandleYs).toEqual(shifted(plain.catHandleYs));
  });

  it("nodeHeight of an environment card is recipeHeight plus the plate", () => {
    const recipe = withEnvironment(fakeRecipe(2, 3));
    expect(nodeHeight(fakeNode(recipe))).toBe(recipeHeight(2, 3, false, true));
    expect(nodeHeight(fakeNode(recipe))).toBe(
      recipeHeight(2, 3) + ENV_ROW_HEIGHT,
    );
  });

  // The plate moves the rows AND the card centre, so the row-vs-centre
  // discriminator portRowResolved rests on has to survive it (nodeGeometry's
  // header contract, item 4).
  it("keeps the centre fallback off every row on an environment card", () => {
    for (const [ins, outs, cats] of [
      [1, 1, 0],
      [3, 1, 0],
      [2, 1, 1],
      [4, 2, 2],
    ] as const) {
      const recipe = withEnvironment(fakeRecipe(ins, outs, cats));
      const geom = measureRecipe(recipe);
      const centre = geom.height / 2;
      for (const y of [
        ...geom.inHandleYs,
        ...geom.outHandleYs,
        ...geom.catHandleYs,
      ]) {
        expect(y, `${ins}x${outs}+${cats}`).not.toBe(centre);
      }
    }
  });

  it("keeps the two sides apart when one item is both an input and a catalyst", () => {
    const shared = {
      ...fakeRecipe(2, 1, 1),
      catalyst: [{ item: "i0", qty: 1 }],
    } as Recipe;
    const geom = measureRecipe(shared);
    expect(portOffsetY(fakeNode(shared), "i0", "in")).toBe(geom.inHandleYs[0]);
    expect(portOffsetY(fakeNode(shared), "i0", "cat")).toBe(
      geom.catHandleYs[0],
    );
  });
});
