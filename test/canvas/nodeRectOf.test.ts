import { expect, it } from "vitest";
import { nodeRectOf } from "../../src/canvas/nodeGeometry";
import { productNode } from "./busRouting.testkit";

it("nodeRectOf returns the absolute box", () => {
  const node = productNode("p", 100, 50, 400, 300);
  expect(nodeRectOf(node)).toEqual({
    left: 100,
    right: 500,
    top: 50,
    bottom: 350,
  });
});
