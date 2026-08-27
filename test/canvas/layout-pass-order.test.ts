// The post-layout routing pass order, pinned. This test is the ONLY enforcement
// of the ordering constraint: all eight passes share one
// (nodes, edges) => Edge[] signature, so a reorder compiles cleanly and the type
// system cannot object. Each pass consumes the stamps every earlier pass left,
// so a swap here silently moves drawn geometry that no other unit test sees.
// Changing this list means changing the render, not just the test.

import { describe, it, expect } from "vitest";

import { ROUTING_PASSES } from "../../src/canvas/layout";

describe("canvas/ROUTING_PASSES", () => {
  it("runs the eight routing passes in the documented order", () => {
    expect(ROUTING_PASSES.map((p) => p.name)).toEqual([
      "routeBusEdges",
      "routeFanoutEdges",
      "assignEntryColumns",
      "clearBusColumns",
      "assignBendColumns",
      "jogForwardLegs",
      "clampBackwardRails",
      "deconflictChipAnchors",
    ]);
  });

  it("is a no-op chain on an empty edge list", () => {
    let edges: ReturnType<(typeof ROUTING_PASSES)[number]["run"]> = [];
    for (const pass of ROUTING_PASSES) edges = pass.run([], edges);
    expect(edges).toEqual([]);
  });
});
