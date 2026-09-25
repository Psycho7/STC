// After a card is dragged and the routing passes replay, every edge incident
// to the moved card must be clear of every card it can route around: no drawn
// segment entering a foreign card, and none running back through the moved
// card's own body (the overshoot-and-return a leftward drag produces when the
// entry legs' descent columns stay behind). This is the drag-state twin of
// cardPierces.corpus.test.ts: same rect source, same layout pipeline, same
// zero -- asserted only on the moved card's incident edges, because a dragged
// card can legitimately land on a foreign edge's routed corridor when no
// reroute of that edge is possible.
//
// Runs offline so a routing change that puts a dragged card's edge through a
// card fails in seconds instead of waiting for a browser run, and names the
// plan and the card when it does.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { rerouteEdges, type RFAnyNode } from "../../src/canvas/layout";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge } from "../../src/canvas/edgePath";
import { cardRectsFor } from "../../src/canvas/chipSeating";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";
import {
  auditOwnCardPierces,
  auditSegmentsVsCards,
  type NodeRect,
  type RawEdge,
} from "../e2e/geometry";

// How far the chosen recipe card moves left, per plan.
const DRAG_DX = -80;

describe("no drawn segment of a dragged card's edges enters a card", () => {
  it("holds on every corpus plan after an 80-unit left drag and replay", async () => {
    const pierces: string[] = [];
    let plansRouted = 0;

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { nodes, baseEdges, gaps } = await layoutSolved(
        solveForRender({ targets, pack }),
      );

      // A recipe card with traffic on both sides where the plan offers one
      // (else any recipe card with traffic), lowest id first, so the dragged
      // card is deterministic per plan and exercises the target-side and
      // source-side halves of the replay.
      const recipes = nodes
        .filter((n) => n.type === "recipe")
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const moved =
        recipes.find(
          (n) =>
            baseEdges.some((e) => e.target === n.id) &&
            baseEdges.some((e) => e.source === n.id),
        ) ??
        recipes.find((n) =>
          baseEdges.some((e) => e.target === n.id || e.source === n.id),
        );
      expect(
        moved,
        `${scenario.id}: no recipe card with traffic`,
      ).toBeDefined();

      const movedNodes: RFAnyNode[] = nodes.map((n) =>
        n.id === moved!.id
          ? { ...n, position: { x: n.position.x + DRAG_DX, y: n.position.y } }
          : n,
      );
      const rerouted = rerouteEdges(movedNodes, baseEdges, { gaps });

      const movedById = nodeIndexOf(movedNodes);
      const rects: NodeRect[] = cardRectsFor(movedNodes).map((c) => ({
        nodeId: c.id,
        type: movedById.get(c.id)?.type ?? "",
        left: c.left,
        top: c.top,
        right: c.right,
        bottom: c.bottom,
      }));

      // The drawn polylines of the moved card's incident edges only, rebuilt
      // the way the render rebuilds them (drawnPortsOf + drawnEdge).
      const incident: RawEdge[] = [];
      for (const edge of rerouted as Edge[]) {
        if (edge.source !== moved!.id && edge.target !== moved!.id) continue;
        const ports = drawnPortsOf(edge, movedById);
        if (ports === null) continue;
        const drawn = drawnEdge(ports, edge.type, edge.data);
        if (drawn.pts.length === 0) continue;
        incident.push({
          id: edge.id,
          d: drawn.path,
          source: edge.source,
          target: edge.target,
          item: edge.id,
        });
      }
      // Premise: the drag really was exercised, so the empty lists below are
      // verdicts rather than an empty scan.
      expect(
        incident.length,
        `${scenario.id}: no incident edges on ${moved!.id}`,
      ).toBeGreaterThan(0);
      plansRouted += 1;

      for (const v of auditSegmentsVsCards(incident, rects)) {
        pierces.push(
          `${scenario.id} ${v.edgeId} seg enters foreign card ${v.card}`,
        );
      }
      for (const v of auditOwnCardPierces(incident, rects)) {
        pierces.push(
          `${scenario.id} ${v.edgeId} seg runs inside own ${v.role} card ${v.card}`,
        );
      }
    }

    expect(plansRouted).toBe(SCENARIOS.length);
    expect(pierces).toEqual([]);
  }, 600_000);
});
