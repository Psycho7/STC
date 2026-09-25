// Shared fixtures for the busRouting test suite, split across
// busRouting.classify / busRouting.columns / busRouting.chips. The node and
// edge builders live in src/canvas/levelOccupancy.testkit.ts, because the
// levelOccupancy suite sits beside its module and may not import from test/;
// they are re-exported here so the borrowed suites keep one import path. No
// assertions here -- just constructors.

export {
  emptyPorts,
  inputProductNode,
  mkEdge,
  mkRecipe,
  orderedRecipeNode,
  productNode,
  recipeNode,
} from "../../src/canvas/levelOccupancy.testkit";
