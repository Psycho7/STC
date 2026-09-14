// Two flows into one card stay parallel only over its approach band.
//
// A forward step used to run its long horizontal at the TARGET port row, so two
// edges into adjacent input rows of one card drew 22 units apart across the
// whole gap and read as one thick double line (finding 6: 赤铜矿 and 清水 into
// 精炼炉). The step now runs at the SOURCE row and drops at the target's entry
// column, so the only stretch the two share is what lies right of that column:
// the port stub plus the target chip reserve the gap was widened for, which is
// where the drop column stands by construction (arrivalModelOf).
//
// So: two horizontal runs of DISTINCT-ITEM edges into one card, one row pitch
// apart, may overlap in x by at most the card's own approach band: from the
// gap's target reserve to the card's Left ports, plus the port stub of slot
// depth the arrival columns stand at.
// Distinct items only -- the members of one trunk carry the same item and share
// their legs on purpose, which is what a trunk is.
//
// Judged over the edges the late drop governs, which is the ones that carry an
// entryX: a forward step between ADJACENT layers whose two ports sit on
// different rows and which is not pinned to a trunk's shared column
// (takesArrivalColumn). The three shapes left out cannot answer for the band and
// are not this rule's business:
//   ports on ONE row     -- drawn as a straight line, port to port; there is no
//     vertical to move, and two straight lines a row apart stay parallel however
//     the corridor is routed. A placement matter.
//   layer-SKIPPING       -- its drop column would span every row between the two
//     layers, braiding the drops of the cards in between, and the arrival band
//     holds no such column.
//   far trunk member     -- pinned to its trunk's shared line, which is the
//     formation the trunk exists to draw.
//
// Runs come off the DRAWN polylines, so the rule judges the lines the user sees.

import { describe, it, expect } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  PORT_STUB,
  drawnEdge,
  horizontalRuns,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { RECIPE_ROW_HEIGHT } from "../../src/canvas/dimensions";
import { buildLayerModel, type GapRecord } from "../../src/canvas/layerModel";
import {
  absoluteLeft,
  drawnPortsOf,
  edgeItem,
  nodeIndexOf,
} from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: rows and run ends are sums of the same fractional
// layout coordinates.
const EPS = 1e-6;

type Run = { edge: string; item: string; y: number; lo: number; hi: number };

describe("two flows into one card share only its approach band", () => {
  it("holds on every corpus plan", async () => {
    const wide: Array<{
      plan: string;
      target: string;
      a: string;
      b: string;
      overlap: number;
      allowed: number;
    }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { nodes, edges, gaps } = await layoutSolved(
        solveForRender({ targets, pack }),
      );
      const byId = nodeIndexOf(nodes);
      const { layerByNodeId } = buildLayerModel(nodes);
      const gapByIndex = new Map(gaps.map((gap) => [gap.index, gap]));
      // The gap in front of a target is the one left of its layer; that is the
      // gap whose target reserve the approach band crosses.
      const approachOf = (nodeId: string): GapRecord | undefined => {
        const layer = layerByNodeId.get(nodeId);
        return layer === undefined ? undefined : gapByIndex.get(layer - 1);
      };

      const runsByTarget = new Map<string, Run[]>();
      for (const edge of edges) {
        const item = edgeItem(edge);
        if (item === undefined) continue;
        const ports = drawnPortsOf(edge, byId);
        if (ports === null) continue;
        // Late-dropping edges only (see the header): a forward step with an
        // entry column of its own.
        if (ports.targetX <= ports.sourceX) continue;
        if (routingHintsFromData(edge.data).entryX === undefined) continue;
        const { pts } = drawnEdge(ports, edge.type, edge.data);
        const list = runsByTarget.get(edge.target) ?? [];
        for (const run of horizontalRuns(pts)) {
          list.push({ edge: edge.id, item, y: run.y, lo: run.lo, hi: run.hi });
        }
        runsByTarget.set(edge.target, list);
      }

      for (const [targetId, list] of runsByTarget) {
        const gap = approachOf(targetId);
        const target = byId.get(targetId);
        if (gap === undefined || target === undefined) continue;
        // The approach band of THIS card: from the gap's target reserve to its
        // own Left ports -- a card need not stand at its layer's left edge, and
        // whatever of its layer it sits behind is band the drop cannot skip --
        // plus the port stub of slot depth the arrival columns take.
        const allowed =
          PORT_STUB + (absoluteLeft(target, byId) - gap.targetZone.left);
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const a = list[i]!;
            const b = list[j]!;
            if (a.edge === b.edge) continue;
            if (a.item === b.item) continue;
            if (Math.abs(Math.abs(a.y - b.y) - RECIPE_ROW_HEIGHT) > EPS) {
              continue;
            }
            const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
            if (overlap <= 0) continue;
            checked += 1;
            if (overlap <= allowed + EPS) continue;
            wide.push({
              plan: scenario.id,
              target: targetId,
              a: `${a.edge}@${a.y}[${a.lo},${a.hi}]`,
              b: `${b.edge}@${b.y}[${b.lo},${b.hi}]`,
              overlap,
              allowed,
            });
          }
        }
      }
    }

    // Premise: the corpus really does run two flows into adjacent rows of one
    // card, so the empty list below is a verdict rather than an empty scan.
    expect(checked).toBeGreaterThan(0);
    expect(wide).toEqual([]);
  }, 600_000);
});
