import type { Recipe } from "@aef/schema";
import {
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_WIDTH,
  recipeHeight,
} from "./dimensions";

// One measurement record per recipe-node. Both the React component
// (RecipeNode.tsx) and the ELK layout (layout.ts) read it, so the rule that the
// rendered height matches the laid-out height has a single source of truth
// instead of three call sites each reaching into the raw constants.
//
// Invariants:
//   inHandleYs.length === recipe.in.length
//   outHandleYs.length === recipe.out.length
// Each array indexes by row position within its own side's column (input rows
// start at row 0 on the left, output rows at row 0 on the right), not by some
// shared row index. When iterating recipe.in or recipe.out, callers can read
// inHandleYs[i] or outHandleYs[i] directly without a bounds check.
//
// Catalyst rows are the one place row count and handle count part ways. A
// catalyst is cycled rather than consumed, so RecipeNode draws it as an extra
// row at the BOTTOM of the input column with no handle and no edge. Those rows
// count toward `height` (the card has to be tall enough to hold them) but never
// toward the handle arrays, and because they come last, every port's y is the
// same as it would be on the same recipe without a catalyst.
export type RecipeGeometry = {
  width: number;
  height: number;
  // y-offsets (in node-local pixels) of each row's mid-line for the input and
  // output ports, in the same order as recipe.in and recipe.out. Empty when the
  // recipe has no ports on that side.
  inHandleYs: number[];
  outHandleYs: number[];
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
  const geometry: RecipeGeometry = {
    width: RECIPE_WIDTH,
    height: recipeHeight(inCount + catalystCount, outCount),
    inHandleYs: Array.from({ length: inCount }, (_, i) => rowHandleY(i)),
    outHandleYs: Array.from({ length: outCount }, (_, i) => rowHandleY(i)),
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
