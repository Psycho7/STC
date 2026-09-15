import type { Recipe } from "@aef/schema";
import {
  CATALYST_BLOCK_GAP,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_WIDTH,
  recipeHeight,
} from "./dimensions";
import { ENV_ROW_HEIGHT } from "./envBanner";

// One measurement record per recipe-node. Both the React component
// (RecipeNode.tsx) and the ELK layout (layout.ts) read it, so the rule that the
// rendered height matches the laid-out height has a single source of truth
// instead of three call sites each reaching into the raw constants.
//
// Invariants:
//   inHandleYs.length === recipe.in.length
//   outHandleYs.length === recipe.out.length
//   catHandleYs.length === (recipe.catalyst?.length ?? 0)
// Each array indexes by row position within its own side's column (input rows
// start at row 0 on the left, output rows at row 0 on the right), not by some
// shared row index. When iterating recipe.in or recipe.out, callers can read
// inHandleYs[i] or outHandleYs[i] directly without a bounds check.
//
// A recipe with an environment draws the plate as the card's first row, above
// the header, so its height carries one ENV_ROW_HEIGHT more than the same
// recipe without one and every handle y here is shifted down by it.
//
// Catalyst rows share the left column with the input rows but keep their own
// array. They are appended at the BOTTOM of that column, so their row indices
// continue where the input rows stop (row inCount + i, offset by the block gap
// the card opens above them) and every input port's y is the same as it would
// be on the same recipe without a catalyst. A card
// can carry one item on an input row AND a catalyst row, so a lookup by item
// alone is ambiguous: callers pick the array, never search both.
export type RecipeGeometry = {
  width: number;
  height: number;
  // y-offsets (in node-local pixels) of each row's mid-line for the input and
  // output ports, in the same order as recipe.in and recipe.out. Empty when the
  // recipe has no ports on that side.
  inHandleYs: number[];
  outHandleYs: number[];
  // y-offsets of the catalyst rows, in recipe.catalyst order, continuing the
  // input column below the last input row.
  catHandleYs: number[];
};

// Memoized per recipe object: the geometry is a pure function of the recipe's
// port counts, and the routing passes call this for the endpoints of nearly
// every edge in each pass. Callers treat the record as read-only.
const geometryByRecipe = new WeakMap<Recipe, RecipeGeometry>();

export function measureRecipe(recipe: Recipe): RecipeGeometry {
  const cached = geometryByRecipe.get(recipe);
  if (cached !== undefined) return cached;
  const inCount = recipe.in.length;
  const outCount = recipe.out.length;
  const catalystCount = recipe.catalyst?.length ?? 0;
  const hasCatalystBlock = catalystCount > 0;
  // The environment plate is the card's first row, above the header, so it
  // shifts every row below it -- input, catalyst and output alike -- and the
  // card box grows by it.
  const plate = recipe.environment === undefined ? 0 : ENV_ROW_HEIGHT;
  const geometry: RecipeGeometry = {
    width: RECIPE_WIDTH,
    height: recipeHeight(
      inCount + catalystCount,
      outCount,
      hasCatalystBlock,
      plate > 0,
    ),
    inHandleYs: Array.from(
      { length: inCount },
      (_, i) => plate + rowHandleY(i),
    ),
    outHandleYs: Array.from(
      { length: outCount },
      (_, i) => plate + rowHandleY(i),
    ),
    // The block gap sits above the first catalyst row, so every catalyst row
    // is pushed down by it while the input rows above keep their y.
    catHandleYs: Array.from(
      { length: catalystCount },
      (_, i) => plate + rowHandleY(inCount + i) + CATALYST_BLOCK_GAP,
    ),
  };
  geometryByRecipe.set(recipe, geometry);
  return geometry;
}

function rowHandleY(rowIndex: number): number {
  return (
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD +
    rowIndex * RECIPE_ROW_HEIGHT +
    RECIPE_ROW_HEIGHT / 2
  );
}
