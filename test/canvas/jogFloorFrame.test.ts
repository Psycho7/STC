// The jog pass's level floor reads ONE frame. runBandsOfEdge builds every
// band off the drawn polyline, so the edge asking the floor question must ask
// it at its drawn port rows too. On multi6 the gray copper-bottle edge e:12
// leaves its source row at model y 1581, drawn 1582 (the recipe dy +1), and
// e:28's approach band is drawn at 1562, so [1542, 1582]. Asked in the model
// frame, 1581 < 1582 reads as a floor hit and the edge jogged down to 1722,
// through the green e:63 twice; in the drawn frame the gap is exactly the
// floor, no hit, and the edge runs straight into its row.

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

const GRAY_ID = "e:12:u:class:q:17->u:class:q:21:copper_bottle";
const GREEN_PREFIX = "e:63:";
// The deepest y the gray edge may reach: well above the 1722 detour level,
// below its own port rows.
const GRAY_MAX_Y = 1702;

describe("jog floor frame (multi6)", () => {
  it("e:12 runs straight into its row and never crosses e:63", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "multi6")!;
    const targets: ItemTarget[] = scenario.targets.map((t) => ({
      itemId: t.itemId,
      ratePerSec: t.ratePerSec,
    }));
    // layoutSolved lays out with the raw pack recipe map, as App.tsx does.
    const laid = await layoutSolved(solveForRender({ targets, pack }));
    const byId = nodeIndexOf(laid.nodes);
    const drawnOf = (edge: Edge) => {
      const ends = drawnPortsOf(edge, byId);
      expect(ends).not.toBeNull();
      return drawnEdge(ends!, edge.type, edge.data);
    };

    const gray = laid.edges.find((e) => e.id === GRAY_ID);
    const green = laid.edges.find((e) => e.id.startsWith(GREEN_PREFIX));
    expect(gray).toBeDefined();
    expect(green).toBeDefined();

    const grayDrawn = drawnOf(gray!);
    const greenDrawn = drawnOf(green!);
    const deepest = Math.max(...grayDrawn.pts.map((p) => p[1]));
    expect(deepest).toBeLessThanOrEqual(GRAY_MAX_Y);
    expect(
      countCrossings([
        { id: gray!.id, d: grayDrawn.path },
        { id: green!.id, d: greenDrawn.path },
      ]),
    ).toBe(0);
  }, 60_000);
});
