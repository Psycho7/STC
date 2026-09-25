// rerouteEdges replays the ROUTING_PASSES fold at drag-stop over live node
// positions and the stored post-ELK, pre-pass edges. On the default plan's
// laid-out graph, a translated recipe card must:
//   (a) route exactly as a fresh ROUTING_PASSES fold over the same inputs;
//   (b) enter every target port from the corridor side: the final segment of
//       each incident edge's drawn polyline (reconstructed through
//       drawnPortsOf + drawnEdge, the seam deconflictChipAnchors reads) never
//       crosses the target card rect;
//   (c) not be a no-op: on the incident edges, at least one position-dependent
//       hint differs from its pre-drag value.

import { describe, it, expect, beforeAll } from "vitest";
import type { Edge } from "@xyflow/react";

import {
  ROUTING_PASSES,
  rerouteEdges,
  type RFAnyNode,
} from "../../src/canvas/layout";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge } from "../../src/canvas/edgePath";
import { cardRectsFor, type CardRect } from "../../src/canvas/chipSeating";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import { defaultTargets } from "../../src/data/targets";
import { segmentEntersRect, type Pt } from "../e2e/geometry";

// Boundary slack, the audits' own: an approach leg touching the port-side
// boundary grazes the border and does not enter the card body.
const EPS = 0.5;

// The position-dependent routing hints the passes stamp (the D1 list: the
// absolute-coordinate keys the edge renderers read unclamped). The fold's own
// stamps (chipX / chipY, crossing cues) are deconflictChipAnchors' business
// and are exercised by the fold equality above.
const HINT_KEYS = [
  "bendX",
  "entryX",
  "legY",
  "jogDescentX",
  "srcColX",
  "railY",
  "railXLeft",
  "railXRight",
  "junctionX",
  "faninJoinX",
] as const;

// The two drags the plan prescribes: sideways (the D1 overshoot direction, a
// target dragged left of its stale descent column) and vertical (a new row
// level for every leg).
const DRAGS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: -60, dy: 0 },
  { dx: 0, dy: 60 },
];

const dataOf = (
  edges: ReadonlyArray<Edge>,
  id: string,
): Record<string, unknown> =>
  edges.find((e) => e.id === id)!.data as Record<string, unknown>;

describe("rerouteEdges (the drag-stop replay)", () => {
  // Shared across the drag cases: the default plan, laid out exactly the way
  // the app lays it out, plus the recipe card both drags move.
  let nodes: RFAnyNode[];
  let baseEdges: Edge[];
  let gaps: Awaited<ReturnType<typeof layoutSolved>>["gaps"];
  let movedId: string;

  beforeAll(async () => {
    const laid = await layoutSolved(
      solveForRender({ targets: defaultTargets(), pack }),
    );
    nodes = laid.nodes;
    baseEdges = laid.baseEdges;
    gaps = laid.gaps;
    // A recipe card with traffic on both sides, so each drag exercises the
    // target-side and source-side halves of the fold.
    movedId = nodes.find(
      (n) =>
        n.type === "recipe" &&
        baseEdges.some((e) => e.target === n.id) &&
        baseEdges.some((e) => e.source === n.id),
    )!.id;
    expect(movedId).toBeDefined();
  }, 300_000);

  const movedBy = ({ dx, dy }: { dx: number; dy: number }): RFAnyNode[] =>
    nodes.map((n) =>
      n.id === movedId
        ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        : n,
    );

  // (b) For every edge incident to the moved card, the drawn polyline's final
  // segment stops at the target port: it does not cross the target card rect.
  // Group slabs are skipped (no edge targets one; a run legitimately lives
  // inside its own container).
  const targetPierces = (
    moved: ReadonlyArray<RFAnyNode>,
    edges: ReadonlyArray<Edge>,
  ): string[] => {
    const byId = nodeIndexOf(moved);
    const rectById = new Map<string, CardRect>(
      cardRectsFor(moved).map((r) => [r.id, r]),
    );
    const hits: string[] = [];
    for (const edge of edges) {
      if (edge.source !== movedId && edge.target !== movedId) continue;
      const target = rectById.get(edge.target);
      if (target === undefined) continue;
      const ports = drawnPortsOf(edge, byId);
      if (ports === null) continue;
      const pts = drawnEdge(ports, edge.type, edge.data).pts;
      if (pts.length < 2) continue;
      const final: [Pt, Pt] = [pts[pts.length - 2]!, pts[pts.length - 1]!];
      if (segmentEntersRect(final[0], final[1], target, EPS)) {
        hits.push(
          `${edge.id} final seg (${final[0][0]},${final[0][1]})-(${final[1][0]},${final[1][1]}) enters ${edge.target}`,
        );
      }
    }
    return hits;
  };

  for (const drag of DRAGS) {
    it(`routes a recipe card dragged by (${drag.dx}, ${drag.dy}) like a fresh fold, clear of its targets`, async () => {
      const moved = movedBy(drag);
      const replay = rerouteEdges(moved, baseEdges, { gaps });

      // (a) The replay IS the fold: rerouteEdges equals a fresh ROUTING_PASSES
      // left fold over the same nodes and pristine edges, so a drag-stop can
      // never drift from what a fresh layout would have routed.
      const fresh = ROUTING_PASSES.reduce<Edge[]>(
        (routed, pass) => pass.run(moved, routed, { gaps }),
        baseEdges,
      );
      expect(replay).toEqual(fresh);

      // (b) The sideways case is the reported defect: the final segment must
      // enter the target port from the corridor side, never cross the card.
      expect(targetPierces(moved, replay)).toEqual([]);

      // (c) Sanity: the replay is not a no-op -- on the edges incident to the
      // moved card, at least one position-dependent hint differs from its
      // pre-drag value, so the passes really answered the move.
      const changed = replay.filter((edge) => {
        if (edge.source !== movedId && edge.target !== movedId) return false;
        const before = dataOf(baseEdges, edge.id);
        const after = dataOf(replay, edge.id);
        return HINT_KEYS.some((key) => before[key] !== after[key]);
      });
      expect(changed.length).toBeGreaterThan(0);
    }, 300_000);
  }
});
