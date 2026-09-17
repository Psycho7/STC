import { expect, it } from "vitest";
import { nodeIndexOf, nodeRectOf } from "../../src/canvas/nodeGeometry";
import { productNode } from "./busRouting.testkit";

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
