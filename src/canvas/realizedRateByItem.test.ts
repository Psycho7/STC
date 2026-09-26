import { expect, test } from "vitest";
import type { Node } from "@xyflow/react";
import { buildRealizedRateByItem } from "./realizedRateByItem";

// Minimal stand-in for the React Flow product nodes the layout layer writes.
// Only the fields buildRealizedRateByItem reads are populated; the helper
// ignores everything else.
function inputNode(
  id: string,
  itemId: string,
  num: string,
  flags?: { role?: "catalyst" },
): Node {
  return {
    id,
    type: "product",
    position: { x: 0, y: 0 },
    data: {
      kind: "inputProduct",
      itemId,
      rate: { num, denom: "1" },
      ...(flags?.role ? { role: flags.role } : {}),
    },
  } as Node;
}

test("a single-bucket input (no flags) reports its own rate", () => {
  const nodes: Node[] = [inputNode("solo", "plant_moss_seed", "2")];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("plant_moss_seed")?.ordinary).toEqual({
    num: "2",
    denom: "1",
  });
});

test("an ordinary node and a catalyst node for one item are both kept", () => {
  // gas_xiranite-shaped case: 1/2 per second consumed as a reagent on the
  // ordinary card and 1/10 per second cycled on the catalyst card. Keying by
  // item alone would let whichever came last erase the other.
  const nodes: Node[] = [
    inputNode("ord", "gas_xiranite", "1"),
    inputNode("cat", "gas_xiranite", "3", { role: "catalyst" }),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("gas_xiranite")).toEqual({
    ordinary: { num: "1", denom: "1" },
    catalyst: { num: "3", denom: "1" },
  });
});

test("a catalyst-only item reports a catalyst entry and no ordinary one", () => {
  const nodes: Node[] = [
    inputNode("cat", "liquid_xiranite", "1", { role: "catalyst" }),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("liquid_xiranite")).toEqual({
    catalyst: { num: "1", denom: "1" },
  });
});

test("two different items keep independent entries", () => {
  const nodes: Node[] = [
    inputNode("a", "liquid_water", "4"),
    inputNode("b", "plant_moss_seed", "2"),
  ];
  const map = buildRealizedRateByItem(nodes);
  expect(map.get("liquid_water")?.ordinary).toEqual({ num: "4", denom: "1" });
  expect(map.get("plant_moss_seed")?.ordinary).toEqual({
    num: "2",
    denom: "1",
  });
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
  expect(map.get("liquid_water")?.ordinary).toEqual({ num: "4", denom: "1" });
});
