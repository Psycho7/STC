// gas-web carries two twin chains built by per-consumer replication:
//
//   q:0 (Solid-Gas) -> q:5 (Packaging) -> q:2 (Purification)
//   q:1 (Solid-Gas) -> q:6 (Packaging) -> q:4 (Purification)
//
// With INCLUDE_CHILDREN, ELK reads only the hierarchical greedy switch, which
// is off by default, so the layer sweep once left the twins stacked crosswise
// and each chain drew an X over its sibling. The chains must read side by side.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";
import { countCrossings } from "../e2e/geometry";

describe("gas-web twin chains", () => {
  it("draw the two chains without crossing each other", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "gas-web")!;
    const targets: ItemTarget[] = scenario.targets.map((t) => ({
      itemId: t.itemId,
      ratePerSec: t.ratePerSec,
    }));
    // layoutSolved builds recipeById from the raw pack, as App.tsx does.
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets, pack }),
    );
    const byId = nodeIndexOf(nodes);

    const drawn = (source: string, target: string) => {
      const edge = edges.find(
        (e: Edge) => e.source === source && e.target === target,
      );
      expect(edge, `${source} -> ${target}`).toBeDefined();
      const ports = drawnPortsOf(edge!, byId);
      expect(ports).not.toBeNull();
      return {
        id: edge!.id,
        d: drawnEdge(ports!, edge!.type, edge!.data).path,
      };
    };

    // Solid-Gas -> Packaging, one per chain.
    expect(
      countCrossings([
        drawn("u:class:q:0", "u:class:q:5"),
        drawn("u:class:q:1", "u:class:q:6"),
      ]),
    ).toBe(0);
    // Packaging -> Purification, one per chain.
    expect(
      countCrossings([
        drawn("u:class:q:5", "u:class:q:2"),
        drawn("u:class:q:6", "u:class:q:4"),
      ]),
    ).toBe(0);
  });
});
