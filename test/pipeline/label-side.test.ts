import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { assignLabelSides } from "../../src/pipeline/render/policy";
import type { RenderEdge } from "../../src/pipeline/types";

function edge(from: string, to: string, item: string): RenderEdge {
  return {
    fromUnit: from as RenderEdge["fromUnit"],
    toUnit: to as RenderEdge["toUnit"],
    item: item as RenderEdge["item"],
    rate: new Fraction(1),
    transportKind: "belt" as RenderEdge["transportKind"],
  };
}

describe("pipeline/render/policy/assignLabelSides", () => {
  it("stamps 'target' on every edge in a 1-to-N fan-out", () => {
    const edges: RenderEdge[] = [
      edge("src", "tgtA", "iron_plate"),
      edge("src", "tgtB", "iron_plate"),
      edge("src", "tgtC", "iron_plate"),
    ];
    assignLabelSides(edges);
    expect(edges.every((e) => e.labelSide === "target")).toBe(true);
  });

  it("stamps 'source' on every edge in an N-to-1 fan-in", () => {
    const edges: RenderEdge[] = [
      edge("srcA", "tgt", "iron_plate"),
      edge("srcB", "tgt", "iron_plate"),
      edge("srcC", "tgt", "iron_plate"),
    ];
    assignLabelSides(edges);
    expect(edges.every((e) => e.labelSide === "source")).toBe(true);
  });

  it("defaults to 'target' for a 1-to-1 edge", () => {
    const edges: RenderEdge[] = [edge("src", "tgt", "iron_plate")];
    assignLabelSides(edges);
    expect(edges[0]!.labelSide).toBe("target");
  });

  it("counts per-item independently (same source, different items)", () => {
    // src -> tgtA carries iron_plate (1-to-1 for iron_plate at src)
    // src -> tgtB carries copper_plate (1-to-1 for copper_plate at src)
    // Each item's outDeg at src is 1, not 2.
    const edges: RenderEdge[] = [
      edge("src", "tgtA", "iron_plate"),
      edge("src", "tgtB", "copper_plate"),
    ];
    assignLabelSides(edges);
    expect(edges[0]!.labelSide).toBe("target");
    expect(edges[1]!.labelSide).toBe("target");
  });

  it("picks the larger side and defaults to 'target' on tie for N-to-M", () => {
    // 2-to-2 of the same item: ties go to target.
    const edges: RenderEdge[] = [
      edge("srcA", "tgtX", "iron_plate"),
      edge("srcA", "tgtY", "iron_plate"),
      edge("srcB", "tgtX", "iron_plate"),
      edge("srcB", "tgtY", "iron_plate"),
    ];
    assignLabelSides(edges);
    // Per edge: outDeg(srcA, iron_plate) = 2, inDeg(tgtX, iron_plate) = 2 -> tie -> target
    expect(edges.every((e) => e.labelSide === "target")).toBe(true);
  });
});
