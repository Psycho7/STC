// Shared fixtures for the busRouting test suite, split across
// busRouting.classify / busRouting.columns / busRouting.chips. The node and
// edge builders live in src/canvas/levelOccupancy.testkit.ts, because the
// levelOccupancy suite sits beside its module and may not import from test/;
// they are re-exported here so the borrowed suites keep one import path. No
// assertions here -- just constructors.

import type {
  RFContainerNode,
  RFProductNode,
  RFRecipeNode,
} from "../../src/canvas/layout";

export {
  containerNode,
  emptyPorts,
  inputProductNode,
  mkEdge,
  mkRecipe,
  orderedRecipeNode,
  productNode,
  recipeNode,
} from "../../src/canvas/levelOccupancy.testkit";

// Re-parent a laid-out node into a container: the caller hands in the
// node's PARENT-RELATIVE position, the same frame ELK's children come back in.
export const inContainer = <
  T extends RFRecipeNode | RFProductNode | RFContainerNode,
>(
  node: T,
  parentId: string,
): T => ({ ...node, parentId });
