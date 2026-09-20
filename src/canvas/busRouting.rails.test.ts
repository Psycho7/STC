// The backward-rail clamp: busRouting's clampBackwardRails threading a rail
// that clears the cards between a recycle edge's endpoints. Lives here rather
// than in edgePath's suite because the pass under test is busRouting's.

import { expect, test } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";
import { clampBackwardRails } from "./busRouting";
import { FORWARD_LEVEL_FLOOR } from "./levelOccupancy";
import type { RFAnyNode } from "./layout";

const productNode = (
  id: string,
  x: number,
  y: number,
  height: number,
): RFAnyNode =>
  ({
    id,
    type: "product",
    position: { x, y },
    width: 148,
    height,
    data: { kind: "inputProduct", itemId: "water" },
  }) as unknown as RFAnyNode;

const itemEdge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  type: "item",
  data: { item: "water", rate: new Fraction(1) },
});

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

test("clampBackwardRails rescans a card-clear level that lands inside a forward run's floor", () => {
  // Same recycle edge, and this time a forward edge draws its run at exactly
  // the level the card clearance escapes to (-16, one chamfer above the mid
  // card's padded top). Its own cards stand outside the rail's corridor, so
  // the only thing at that level is the run.
  const nodes = [
    productNode("src", 800, 0, 60),
    productNode("tgt", 0, 0, 60),
    productNode("mid", 400, 0, 200),
    productNode("fwdSrc", -800, -46, 60),
    productNode("fwdTgt", 1400, -46, 60),
  ];
  const edges: Edge[] = [
    itemEdge("e:1", "src", "tgt"),
    itemEdge("e:2", "fwdSrc", "fwdTgt"),
  ];

  const out = clampBackwardRails(nodes, edges);
  const railY = (out[0]!.data as { railY?: number }).railY;

  // One floor above the run, which is the nearest candidate that is both
  // floor-clear and a fixed point of the card clearance. The nearer candidate
  // below the run (-16 + floor) is inside the mid card, so the clearance would
  // move it again and the rescan rejects it.
  expect(railY).toBe(-16 - FORWARD_LEVEL_FLOOR);
  // No chaining: the run's band is a floor and a candidate source, never an
  // obstacle. Were it fed to the card clearance it would merge with the mid
  // card into one escape band and the rail would leave from ITS far side
  // instead, a chamfer further out again.
  expect(railY).toBeGreaterThan(-16 - FORWARD_LEVEL_FLOOR - 8);
});
