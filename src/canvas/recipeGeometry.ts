import type { Recipe } from "@aef/schema";
import {
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROW_HEIGHT,
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
export type RecipeGeometry = {
  width: number;
  height: number;
  // y-offsets (in node-local pixels) of each row's mid-line for the input and
  // output ports, in the same order as recipe.in and recipe.out. Empty when the
  // recipe has no ports on that side.
  inHandleYs: number[];
  outHandleYs: number[];
};

export function measureRecipe(recipe: Recipe): RecipeGeometry {
  const inCount = recipe.in.length;
  const outCount = recipe.out.length;
  return {
    width: RECIPE_WIDTH,
    height: recipeHeight(inCount, outCount),
    inHandleYs: Array.from({ length: inCount }, (_, i) => rowHandleY(i)),
    outHandleYs: Array.from({ length: outCount }, (_, i) => rowHandleY(i)),
  };
}

function rowHandleY(rowIndex: number): number {
  return (
    RECIPE_HEADER_HEIGHT + rowIndex * RECIPE_ROW_HEIGHT + RECIPE_ROW_HEIGHT / 2
  );
}
