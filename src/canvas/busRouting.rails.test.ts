// The backward-rail clamp: busRouting's clampBackwardRails threading a rail
// that clears the cards between a recycle edge's endpoints. Lives here rather
// than in edgePath's suite because the pass under test is busRouting's.

import { expect, test } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";
import { clampBackwardRails } from "./busRouting";
import type { RFAnyNode } from "./layout";

test("clampBackwardRails threads a clear railY onto a card-crossing recycle edge", () => {
  // A backward edge (target left of source) whose midway rail would cut through
  // a card sitting between them.
  const nodes = [
    {
      id: "src",
      type: "product",
      position: { x: 800, y: 0 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "tgt",
      type: "product",
      position: { x: 0, y: 0 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "mid",
      type: "product",
      position: { x: 400, y: 0 },
      width: 148,
      height: 200,
      data: { kind: "inputProduct", itemId: "water" },
    },
  ] as unknown as RFAnyNode[];
  const edges: Edge[] = [
    {
      id: "e:1",
      source: "src",
      target: "tgt",
      type: "item",
      data: { item: "water", rate: new Fraction(1) },
    },
  ];
  const out = clampBackwardRails(nodes, edges);
  const railY = (out[0]!.data as { railY?: number }).railY;
  expect(railY).toBeDefined();
  // The threaded rail clears the mid card's y-extent (top 0, bottom 200).
  expect(railY! < 0 || railY! > 200).toBe(true);
});
