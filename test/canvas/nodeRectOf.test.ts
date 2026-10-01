import { expect, it } from "vitest";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
import {
  CARD_BORDER,
  nodeHeight,
  nodeIndexOf,
  nodeRectOf,
  nodeWidth,
} from "../../src/canvas/nodeGeometry";
import {
  containerNode,
  inContainer,
  mkRecipe,
  productNode,
  recipeNode,
} from "./busRouting.testkit";

it("nodeRectOf returns the absolute box, resolving one parent hop", () => {
  const parent = productNode("p", 100, 50, 400, 300);
  const child = { ...productNode("c", 10, 20, 148, 78), parentId: "p" };
  const byId = nodeIndexOf([parent, child]);
  expect(nodeRectOf(parent, byId)).toEqual({
    left: 100,
    right: 500,
    top: 50,
    bottom: 350,
  });
  expect(nodeRectOf(child, byId)).toEqual({
    left: 110,
    right: 258,
    top: 70,
    bottom: 148,
  });
});

it("nodeRectOf returns a recipe card's drawn border box, grown right and down", () => {
  const node = recipeNode("r", 100, 50, mkRecipe("r", ["a"], ["b"]));
  expect(nodeRectOf(node, nodeIndexOf([node]))).toEqual({
    left: 100,
    right: 100 + RECIPE_WIDTH + 2 * CARD_BORDER,
    top: 50,
    bottom: 50 + nodeHeight(node) + 2 * CARD_BORDER,
  });
  // The model sizes stay the content box ELK and the ports are placed by.
  expect(nodeWidth(node)).toBe(RECIPE_WIDTH);
});

it("nodeRectOf grows a recipe card inside a container and leaves the container's box alone", () => {
  const container = containerNode("g", 300, 200, 600, 400);
  const child = inContainer(
    recipeNode("r", 40, 60, mkRecipe("r", ["a"], ["b"])),
    "g",
  );
  const byId = nodeIndexOf([container, child]);
  expect(nodeRectOf(container, byId)).toEqual({
    left: 300,
    right: 900,
    top: 200,
    bottom: 600,
  });
  expect(nodeRectOf(child, byId)).toEqual({
    left: 340,
    right: 340 + RECIPE_WIDTH + 2 * CARD_BORDER,
    top: 260,
    bottom: 260 + nodeHeight(child) + 2 * CARD_BORDER,
  });
});
