// A fan-in-pinned member descends at its pinned column. routeTrunkEdges stamps
// every far fan-in member with the trunk's column (bendX + faninColumn), and
// the fan-in dot is drawn there; a member the jog pass relocates must still
// turn onto the target row at that column, or the drawing merges somewhere
// the dot is not.
// - battery5-xiranite: e:7 into q:28 is pinned at 3766 but descended at the
//   next arrival slot (3718), joining the row 48 units before the dot with the
//   Ferrium e:5 vertical between.
// - multi6: the sewage members e:27 / e:31 took the target row itself as
//   their jog level and rode it ~3300 units to the fan-in column, undotted.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { CHAMFER, drawnEdge } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

async function layoutScenario(id: string) {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  // layoutSolved lays out with the raw pack recipe map, as App.tsx does.
  return layoutSolved(solveForRender({ targets, pack }));
}

// Where the member joins its target row: the start x of the polyline's final
// run at the port row (the chamfer foot of the descent).
function rowJoinX(edge: Edge, byId: ReturnType<typeof nodeIndexOf>): number {
  const ends = drawnPortsOf(edge, byId);
  expect(ends).not.toBeNull();
  const pts = drawnEdge(ends!, edge.type, edge.data).pts;
  const ty = pts[pts.length - 1]![1]!;
  let k = pts.length - 1;
  while (k > 0 && Math.abs(pts[k - 1]![1]! - ty) < 1e-6) k--;
  return pts[k]![0]!;
}

type DotData = {
  faninJunctionX?: number;
  fanin?: boolean;
  busChipOwner?: boolean;
};

// The fan-in dot of the trunk into `target`: stamped on an item member's data
// (faninJunctionX), or drawn at the junction of the bus member owning the
// trunk's chip.
function faninDotX(
  edges: ReadonlyArray<Edge>,
  target: string,
  byId: ReturnType<typeof nodeIndexOf>,
): number {
  for (const edge of edges) {
    if (edge.target !== target) continue;
    const data = edge.data as DotData | undefined;
    if (data?.faninJunctionX !== undefined) return data.faninJunctionX;
    if (edge.type !== "bus" || !data?.fanin || !data.busChipOwner) continue;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const drawn = drawnEdge(ends, edge.type, edge.data);
    if (drawn.shape === "fanin") return drawn.junction.x;
  }
  throw new Error(`no fan-in dot into ${target}`);
}

describe("fan-in pin survives the jog", () => {
  it("battery5-xiranite e:7 descends at the fan-in column of q:28", async () => {
    const laid = await layoutScenario("battery5-xiranite");
    const byId = nodeIndexOf(laid.nodes);
    const member = laid.edges.find((e) =>
      e.id.startsWith("e:7:u:class:q:14->u:class:q:28:"),
    );
    expect(member).toBeDefined();
    const dotX = faninDotX(laid.edges, "u:class:q:28", byId);
    expect(Math.abs(rowJoinX(member!, byId) - dotX)).toBeLessThanOrEqual(
      CHAMFER,
    );
  }, 60_000);

  it("multi6 sewage members join the row only at the fan-in column", async () => {
    const laid = await layoutScenario("multi6");
    const byId = nodeIndexOf(laid.nodes);
    const target = "u:surplus:liquid_sewage";
    const dotX = faninDotX(laid.edges, target, byId);
    for (const prefix of ["e:27:", "e:31:"]) {
      const member = laid.edges.find(
        (e) => e.id.startsWith(prefix) && e.target === target,
      );
      expect(member).toBeDefined();
      expect(Math.abs(rowJoinX(member!, byId) - dotX)).toBeLessThanOrEqual(
        CHAMFER,
      );
    }
  }, 60_000);
});
