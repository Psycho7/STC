import { expect, test } from "vitest";
import type { Node } from "@xyflow/react";
import { buildRealizedRateByItem } from "./productNodeMetadata";

// Minimal stand-in for the React Flow product nodes the layout layer writes.
// Only the fields buildRealizedRateByItem reads are populated; the helper
// ignores everything else.
function inputNode(
  id: string,
  itemId: string,
  num: string,
  flags?: { isFanout?: true },
): Node {
  return {
    id,
    type: "product",
    position: { x: 0, y: 0 },
    data: {
      kind: "inputProduct",
      itemId,
      rate: { num, denom: "1" },
      ...(flags?.isFanout ? { isFanout: true } : {}),
    },
  } as Node;
}

test("aggregate total wins over fanout slices for the same item", () => {
  // liquid_water-shaped case: one aggregate carrying 240/min (4/1 per-sec) plus
  // two slices that each carry a partial rate. The aggregate has no fanout flag
  // (the layout layer drops isAggregate), the slices carry isFanout.
  const nodes: Node[] = [
    inputNode("agg", "liquid_water", "4"),
    inputNode("slice-a", "liquid_water", "1", { isFanout: true }),
    inputNode("slice-b", "liquid_water", "3", { isFanout: true }),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("liquid_water")).toEqual({ num: "4", denom: "1" });
});

test("a single-bucket input (no flags) reports its own rate", () => {
  const nodes: Node[] = [inputNode("solo", "plant_moss_seed", "2")];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("plant_moss_seed")).toEqual({ num: "2", denom: "1" });
});

test("two different items keep independent entries", () => {
  const nodes: Node[] = [
    inputNode("a", "liquid_water", "4"),
    inputNode("a-slice", "liquid_water", "1", { isFanout: true }),
    inputNode("b", "plant_moss_seed", "2"),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("liquid_water")).toEqual({ num: "4", denom: "1" });
  expect(map.get("plant_moss_seed")).toEqual({ num: "2", denom: "1" });
});

test("non-input nodes are ignored", () => {
  const nodes: Node[] = [
    {
      id: "out",
      type: "product",
      position: { x: 0, y: 0 },
      data: {
        kind: "outputProduct",
        itemId: "liquid_water",
        rate: { num: "9", denom: "1" },
        flavor: "target",
      },
    } as Node,
    inputNode("in", "liquid_water", "4"),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("liquid_water")).toEqual({ num: "4", denom: "1" });
});
