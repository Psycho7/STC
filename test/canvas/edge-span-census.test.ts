// Edge-span census: computeEdgeSpans on a synthetic 2-node fixture, pinning the
// absolute-position span, the floor-at-0 and the long-edge threshold every span
// fixture is written against.

import { describe, it, expect } from "vitest";
import {
  computeEdgeSpans,
  SPAN_THRESHOLD,
  type SpanNode,
  type SpanEdge,
} from "./edgeSpans";
import {
  BETWEEN_LAYERS_SPACING,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";

describe("computeEdgeSpans", () => {
  it("pins the current long-edge threshold at 700 so span fixtures stay valid", () => {
    // Every span fixture in the routing suites is written against this number;
    // a spacing change that moves it has to move them too. Two full layers:
    // 2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH).
    expect(SPAN_THRESHOLD).toBe(2 * (BETWEEN_LAYERS_SPACING + RECIPE_WIDTH));
    expect(SPAN_THRESHOLD).toBe(700);
  });

  it("measures the gap between absolute positions and floors at 0", () => {
    // a: right edge at x = 0 + 100 = 100.
    // b: left edge at x = 550.
    const nodes: SpanNode[] = [
      { id: "a", position: { x: 0 }, width: 100 },
      { id: "b", position: { x: 550 }, width: 100 },
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
