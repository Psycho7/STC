// Chip placement over routed trunks: which member draws a trunk's aggregate
// chip and where the two trunk chips stand on the drawn shape. Fixtures come
// from ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { routeTrunkEdges } from "../../src/canvas/busRouting";
import { drawnEdge, PORT_STUB } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { branchChipText, chipSeatHalfW } from "../../src/canvas/chipMetrics";
import {
  BETWEEN_LAYERS_SPACING,
  DOT_KEEPOFF,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, mkEdge } from "./busRouting.testkit";

describe("chip placement: fan-out trunk chips", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // One layer over: a card plus the 110-unit gap right of the source.
  const oneGap = RECIPE_WIDTH + BETWEEN_LAYERS_SPACING;

  const dataOf = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      busChipOwner?: boolean;
    };

  // The two-member fan-out both cases below run on.
  const fixture = (): { nodes: RFAnyNode[]; edges: Edge[] } => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    return { nodes, edges: routeTrunkEdges(nodes, edges) };
  };

  it("marks one owner, and the bookkeeping pass leaves both members alone", () => {
    // Every trunk draws one aggregate chip, on its owner. Where that chip
    // stands is the path builder's rule, so the pass stamps neither member with
    // anything about it -- an untouched edge comes back by reference.
    const { nodes, edges } = fixture();
    expect(dataOf(edges, "e0").busChipOwner).toBe(true);
    expect(dataOf(edges, "e1").busChipOwner).toBe(false);

    const out = deconflictChipAnchors(nodes, edges);
    expect(out[0]).toBe(edges[0]);
    expect(out[1]).toBe(edges[1]);
  });

  it("stands both trunk chips on their own run, off the split dot", () => {
    // The aggregate on the shared trunk run, its box a port stub out of the
    // source port; the member's own chip on its last horizontal leg, its box a
    // port stub back from the target port. This fixture's gap is narrower than
    // one chip box -- the reserve pre-pass is not run here -- so the aggregate
    // takes the end of its short run rather than both pads; the whole-corpus
    // suite pins the pads on gaps the pre-pass widened.
    const { nodes, edges } = fixture();
    const byId = nodeIndexOf(nodes);
    const owner = edges.find((e) => e.id === "e0")!;
    const ends = drawnPortsOf(owner, byId)!;
    const drawn = drawnEdge(ends, "bus", owner.data);
    expect(drawn.shape).toBe("fanout");
    if (drawn.shape !== "fanout") return;

    const memberHalfW = chipSeatHalfW(branchChipText(owner), false);
    expect(drawn.trunkAnchor.y).toBe(ends.sourceY);
    expect(drawn.branchAnchor.y).toBe(ends.targetY);
    // Both anchors stay ON their own run: the aggregate between the source port
    // and the dot, the member between the branch chamfer and the target port.
    expect(drawn.trunkAnchor.x).toBeGreaterThanOrEqual(ends.sourceX);
    expect(drawn.trunkAnchor.x).toBeLessThanOrEqual(drawn.junction.x);
    expect(drawn.branchAnchor.x).toBeLessThanOrEqual(ends.targetX);
    // The member's chip is measured from the target port: one stub back, or the
    // dot keep-off when the leg is shorter than that.
    expect(drawn.branchAnchor.x + memberHalfW).toBeLessThanOrEqual(
      ends.targetX - PORT_STUB + 2 * memberHalfW,
    );
    // The member's leg is a row below the trunk, so its chip clears the split
    // dot in y whatever the corridor does.
    expect(Math.abs(drawn.branchAnchor.y - drawn.junction.y)).toBeGreaterThan(
      DOT_KEEPOFF,
    );
  });
});
