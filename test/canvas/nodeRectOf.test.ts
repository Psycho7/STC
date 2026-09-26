import { expect, it } from "vitest";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
import {
  CARD_BORDER,
  nodeHeight,
  nodeRectOf,
  nodeWidth,
} from "../../src/canvas/nodeGeometry";
import { mkRecipe, productNode, recipeNode } from "./busRouting.testkit";

it("nodeRectOf returns the absolute box", () => {
  const node = productNode("p", 100, 50, 400, 300);
  expect(nodeRectOf(node)).toEqual({
    left: 100,
    right: 500,
    top: 50,
    bottom: 350,
  });
});

it("nodeRectOf returns a recipe card's drawn border box, grown right and down", () => {
  const node = recipeNode("r", 100, 50, mkRecipe("r", ["a"], ["b"]));
  expect(nodeRectOf(node)).toEqual({
    left: 100,
    right: 100 + RECIPE_WIDTH + 2 * CARD_BORDER,
    top: 50,
    bottom: 50 + nodeHeight(node) + 2 * CARD_BORDER,
  });
  // The model sizes stay the content box ELK and the ports are placed by.
  expect(nodeWidth(node)).toBe(RECIPE_WIDTH);
});
