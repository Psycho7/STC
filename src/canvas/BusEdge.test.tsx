// @vitest-environment jsdom
import { expect, test } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";
import { routeBusEdges } from "./busRouting";
import { deconflictChipAnchors } from "./chipSeating";
import { CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "./dimensions";
import type { RFAnyNode } from "./layout";

// A far-apart product source and several product targets, so every source->target
// edge clears the bus span threshold and gets classified into one (item, source)
// trunk. Product nodes carry explicit width/height so nodeHeight needs no recipe.
function productNode(id: string, x: number): RFAnyNode {
  return {
    id,
    type: "product",
    position: { x, y: 0 },
    width: 148,
    height: 60,
    data: { kind: "inputProduct", itemId: "water" },
  } as unknown as RFAnyNode;
}

function busMemberEdge(id: string, target: string, rate: Fraction): Edge {
  return {
    id,
    source: "s",
    target,
    data: { item: "water", rate },
  };
}

test("routeBusEdges aggregates one trunk into a single owner chip with the summed rate", () => {
  const nodes = [
    productNode("s", 0),
    productNode("t1", 5000),
    productNode("t2", 5000),
    productNode("t3", 5000),
  ];
  const edges = [
    busMemberEdge("e:1", "t1", new Fraction(400)),
    busMemberEdge("e:3", "t2", new Fraction(400)),
    busMemberEdge("e:2", "t3", new Fraction(700)),
  ];

  const routed = routeBusEdges(nodes, edges);
  const owners = routed.filter(
    (e) => (e.data as { busChipOwner?: boolean }).busChipOwner,
  );
  // Exactly one member of the trunk owns the drop chip.
  expect(owners).toHaveLength(1);
  // Election is deterministic: the lexicographically smallest edge id wins.
  expect(owners[0]!.id).toBe("e:1");
  const ownerData = owners[0]!.data as {
    busTotalRate?: Fraction;
    busMemberCount?: number;
  };
  // The owner carries the exact trunk total (400 + 400 + 700) and the count.
  expect(ownerData.busTotalRate!.equals(new Fraction(1500))).toBe(true);
  expect(ownerData.busMemberCount).toBe(3);
  // Non-owner members are flagged so BusEdge suppresses their drop chip.
  for (const e of routed) {
    if (e.id === "e:1") continue;
    expect((e.data as { busChipOwner?: boolean }).busChipOwner).toBe(false);
  }
});

test("routeBusEdges leaves a lone trunk member as its own owner with count 1", () => {
  const nodes = [productNode("s", 0), productNode("t1", 5000)];
  const edges = [busMemberEdge("e:1", "t1", new Fraction(400))];
  const routed = routeBusEdges(nodes, edges);
  const d = routed[0]!.data as {
    busChipOwner?: boolean;
    busMemberCount?: number;
    busTotalRate?: Fraction;
  };
  expect(d.busChipOwner).toBe(true);
  expect(d.busMemberCount).toBe(1);
  expect(d.busTotalRate!.equals(new Fraction(400))).toBe(true);
});

test("routeBusEdges gives two members feeding one target distinct rise-chip slots", () => {
  // Two bus members feeding the same far target would rise at the same column and
  // stack their rise chips. routeBusEdges instead assigns each member a distinct
  // lane x-slot, so their rise chips spread along the lane. Ordering is by edge
  // id (e:1 before e:2).
  const nodes = [productNode("s", 0), productNode("t1", 5000)];
  const edges = [
    busMemberEdge("e:1", "t1", new Fraction(400)),
    busMemberEdge("e:2", "t1", new Fraction(400)),
  ];
  const out = routeBusEdges(nodes, edges);
  const slots = out.map(
    (e) => (e.data as { busChipX?: number }).busChipX,
  );
  for (const x of slots) expect(typeof x).toBe("number");
  expect(new Set(slots).size).toBe(2);
  const byId = new Map(
    out.map((e) => [e.id, (e.data as { busChipX: number }).busChipX]),
  );
  expect(byId.get("e:1")!).toBeLessThan(byId.get("e:2")!);
});

test("deconflictChipAnchors separates two coincident item midpoint chips along their line", () => {
  // Two forward item edges with identical endpoint geometry produce coincident
  // midpoint anchors. The graze tier keeps both chips ON the shared line
  // (leaving the line is a last resort), so the second chip slides along it by
  // at least a full max-scale chip-box width instead of lifting vertically.
  const nodes = [
    productNode("sA", 0),
    productNode("tA", 2000),
    productNode("sB", 0),
    productNode("tB", 2000),
  ];
  const edges: Edge[] = [
    {
      id: "e:1",
      source: "sA",
      target: "tA",
      type: "item",
      data: { item: "water", rate: new Fraction(400) },
    },
    {
      id: "e:2",
      source: "sB",
      target: "tB",
      type: "item",
      data: { item: "water", rate: new Fraction(300) },
    },
  ];
  const out = deconflictChipAnchors(nodes, edges);
  const seats = out.map((e) => {
    const d = e.data as { labelDx?: number; labelDy?: number };
    return { dx: d.labelDx ?? 0, dy: d.labelDy ?? 0 };
  });
  // Both chips stay on the shared horizontal line...
  for (const s of seats) expect(s.dy).toBe(0);
  // ...separated along it by a full max-scale chip-box width.
  expect(Math.abs(seats[0]!.dx - seats[1]!.dx)).toBeGreaterThanOrEqual(
    MAX_CHIP_SCALE * CHIP_BOX_WIDTH,
  );
});
