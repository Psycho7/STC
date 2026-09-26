// No drawn segment of any corpus plan enters a card that is not its own.
//
// This is the node-side twin of the e2e placement audit's tier-1 hard gate
// (auditSegmentsVsCards, raw hits): same rect source, same exemption, same
// zero. It runs here so a routing change that puts a run through a card fails
// in seconds instead of waiting for a browser run, and so the fix for such a
// pierce has a test that names the plan and the card.
//
// Rects are the DRAWN card boxes (cardRectsFor), one per node -- recipe and
// product cards and group slabs alike, because a run through a slab reads as a
// run through that group's body just the same. Exempt: the edge's own source
// and target, plus any container whose box holds one of the polyline's
// endpoints (a run legitimately starts / ends inside its own group).
//
// Zero, no baseline: a pierce is never an acceptable residue.

import { describe, it, expect } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge } from "../../src/canvas/edgePath";
import { cardRectsFor } from "../../src/canvas/chipSeating";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";
import { segmentEntersRect, segmentsOf, type NodeRect } from "../e2e/geometry";

// Boundary slack, the audit's own: a leg that lands exactly on a card's port
// side touches the border and does not enter the body.
const EPS = 0.5;

const fmt = (n: number): string => n.toFixed(1);

describe("no drawn segment enters a foreign card", () => {
  it("holds on every corpus plan", async () => {
    const pierces: string[] = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { nodes, edges } = await layoutSolved(
        solveForRender({ targets, pack }),
      );
      const byId = nodeIndexOf(nodes);
      const rects: NodeRect[] = cardRectsFor(nodes).map((c) => ({
        nodeId: c.id,
        type: byId.get(c.id)?.type ?? "",
        left: c.left,
        top: c.top,
        right: c.right,
        bottom: c.bottom,
      }));

      for (const edge of edges) {
        const ports = drawnPortsOf(edge, byId);
        if (ports === null) continue;
        const drawn = drawnEdge(ports, edge.type, edge.data);
        const pts = drawn.pts;
        if (pts.length === 0) continue;

        const exempt = new Set<string>([edge.source, edge.target]);

        for (const [p0, p1] of segmentsOf(
          pts.map(([x, y]) => [x, y] as const),
        )) {
          checked += 1;
          for (const rect of rects) {
            if (exempt.has(rect.nodeId)) continue;
            if (!segmentEntersRect(p0, p1, rect, EPS)) continue;
            pierces.push(
              `${scenario.id} ${edge.id} seg (${fmt(p0[0])},${fmt(p0[1])})-(${fmt(p1[0])},${fmt(p1[1])}) enters ${rect.nodeId}`,
            );
          }
        }
      }
    }

    // Premise: the corpus really was walked, so the empty list below is a
    // verdict rather than an empty scan.
    expect(checked).toBeGreaterThan(0);
    expect(pierces).toEqual([]);
  }, 600_000);
});
