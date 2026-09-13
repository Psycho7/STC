// Edge-span census: computeEdgeSpans on a synthetic 3-node fixture (one
// container child), pinning the absolute-position resolution, the floor-at-0 and
// the long-edge threshold every span fixture is written against.

import { describe, it, expect } from "vitest";
import {
  computeEdgeSpans,
  SPAN_THRESHOLD,
  type SpanNode,
  type SpanEdge,
} from "./edgeSpans";

describe("computeEdgeSpans", () => {
  it("pins the current long-edge threshold at 820 so span fixtures stay valid", () => {
    // Every span fixture in the routing suites is written against this number;
    // a spacing change that moves it has to move them too.
    expect(SPAN_THRESHOLD).toBe(820);
  });

  it("resolves one level of parentId for absolute positions and floors at 0", () => {
    // a: top-level, right edge at x = 0 + 100 = 100.
    // grp: container at x = 500.
    // b: child of grp, parent-relative x = 50, so absolute left = 550.
    const nodes: SpanNode[] = [
      { id: "a", position: { x: 0 }, width: 100 },
      { id: "grp", position: { x: 500 }, width: 200 },
      { id: "b", parentId: "grp", position: { x: 50 }, width: 100 },
    ];
    // Forward edge a -> b: 550 (target abs left) - 100 (source right) = 450.
    // Backward edge b -> a: 0 - (550 + 100) is negative, floored to 0.
    const edges: SpanEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ];

    expect(computeEdgeSpans(nodes, edges)).toEqual([450, 0]);
  });
});
