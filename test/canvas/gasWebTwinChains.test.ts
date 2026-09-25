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
import { properCross } from "../../src/canvas/crossings";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";

type Pt = readonly [number, number];

// The exam plan (test/e2e/scenarios.ts, "gas-web").
const GAS_WEB_TARGETS: ItemTarget[] = [
  { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_copper_enr2", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_inert", ratePerSec: { num: "1", denom: "4" } },
];

const crossCount = (a: ReadonlyArray<Pt>, b: ReadonlyArray<Pt>): number => {
  let hits = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (properCross(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) hits++;
    }
  }
  return hits;
};

describe("gas-web twin chains", () => {
  it("draw the two chains without crossing each other", async () => {
    // layoutSolved builds recipeById from the raw pack, as App.tsx does.
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets: GAS_WEB_TARGETS, pack }),
    );
    const byId = nodeIndexOf(nodes);

    const polyline = (source: string, target: string): ReadonlyArray<Pt> => {
      const edge = edges.find(
        (e: Edge) => e.source === source && e.target === target,
      );
      expect(edge, `${source} -> ${target}`).toBeDefined();
      const ports = drawnPortsOf(edge!, byId);
      expect(ports).not.toBeNull();
      return drawnEdge(ports!, edge!.type, edge!.data).pts;
    };

    // Solid-Gas -> Packaging, one per chain.
    expect(
      crossCount(
        polyline("u:class:q:0", "u:class:q:5"),
        polyline("u:class:q:1", "u:class:q:6"),
      ),
    ).toBe(0);
    // Packaging -> Purification, one per chain.
    expect(
      crossCount(
        polyline("u:class:q:5", "u:class:q:2"),
        polyline("u:class:q:6", "u:class:q:4"),
      ),
    ).toBe(0);
  });
});
