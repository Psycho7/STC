// The post-layout routing pass order, pinned. This test is the ONLY enforcement
// of the ordering constraint: all six passes share one
// (nodes, edges) => Edge[] signature, so a reorder compiles cleanly and the type
// system cannot object. Each pass consumes the stamps every earlier pass left,
// so a swap here silently moves drawn geometry that no other unit test sees.
// Changing this list means changing the render, not just the test.

import { describe, it, expect } from "vitest";

import { LAYOUT_PREPASS, ROUTING_PASSES } from "../../src/canvas/layout";

describe("canvas/ROUTING_PASSES", () => {
  it("runs the six routing passes in the documented order", () => {
    expect(ROUTING_PASSES.map((p) => p.name)).toEqual([
      "routeFanoutEdges",
      "assignEntryColumns",
      "assignBendColumns",
      "jogForwardLegs",
      "clampBackwardRails",
      "deconflictChipAnchors",
    ]);
    // Pin the run identities too: the entry names above are free-form strings,
    // so a mislabelled entry would still pass the list check while running a
    // different pass.
    expect(ROUTING_PASSES.map((p) => p.run.name)).toEqual([
      "routeFanoutEdges",
      "assignEntryColumns",
      "assignBendColumns",
      "jogForwardLegs",
      "clampBackwardRails",
      "deconflictChipAnchors",
    ]);
  });

  it("runs the gap-widening pre-pass ahead of all six", () => {
    expect([LAYOUT_PREPASS.name, ...ROUTING_PASSES.map((p) => p.name)]).toEqual(
      [
        "widenLayerGaps",
        "routeFanoutEdges",
        "assignEntryColumns",
        "assignBendColumns",
        "jogForwardLegs",
        "clampBackwardRails",
        "deconflictChipAnchors",
      ],
    );
    expect(LAYOUT_PREPASS.run.name).toBe("widenLayerGaps");
    // The pre-pass moves nodes and returns no edges, so it is not one of the
    // routing entries and must never be folded in with them.
    expect(ROUTING_PASSES.map((p) => p.name)).not.toContain(
      LAYOUT_PREPASS.name,
    );
  });

  it("is a no-op chain on an empty edge list", () => {
    let edges: ReturnType<(typeof ROUTING_PASSES)[number]["run"]> = [];
    for (const pass of ROUTING_PASSES) edges = pass.run([], edges);
    expect(edges).toEqual([]);
  });
});
