// The drop's gap records on every corpus plan. At rest the measure-only
// records are the layout's own and the drop replay is the layout, so a drop
// that moves nothing changes nothing. After a drag that shortens a trunk's
// aggregate run -- the fan-out's source card dragged right, the fan-in's target
// card dragged left -- no aggregate chip stands on a card or its port
// furniture: the drop routes against zones measured where the cards now are,
// and an aggregate its run can no longer hold demotes instead of being pushed
// over the port.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { rerouteAfterDrop, type RFAnyNode } from "../../src/canvas/layout";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  ROOT_SCOPE,
  measureGapRecords,
  type GapRecord,
} from "../../src/canvas/layerModel";
import {
  cardRectsFor,
  portKeepOutRect,
  seatedChipBoxes,
} from "../../src/canvas/chipSeating";
import { nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { SCENARIOS } from "../e2e/scenarios";

// How far the card owning a trunk aggregate is dragged, inward.
const DRAG_DX = 80;
// Overlap slack: a box touching an obstacle's edge does not stand on it.
const EPS = 0.5;

const moveBy = (
  nodes: ReadonlyArray<RFAnyNode>,
  id: string,
  dx: number,
): RFAnyNode[] =>
  nodes.map((n) =>
    n.id === id
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y } }
      : n,
  );

function aggregatesOnFurniture(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): string[] {
  // Container slabs are a tint behind a whole group, not a label surface.
  const rects = cardRectsFor(
    nodes.filter((n) => n.type !== "group"),
    nodeIndexOf(nodes),
  ).flatMap((card) => [
    { name: `card ${card.id}`, ...card },
    { name: `source ports ${card.id}`, ...portKeepOutRect(card, "source") },
    { name: `target ports ${card.id}`, ...portKeepOutRect(card, "target") },
  ]);
  const hits: string[] = [];
  for (const box of seatedChipBoxes(nodes, edges)) {
    if (box.family !== "fanout-agg") continue;
    for (const r of rects) {
      if (
        box.x + box.halfW > r.left + EPS &&
        box.x - box.halfW < r.right - EPS &&
        box.y + box.halfH > r.top + EPS &&
        box.y - box.halfH < r.bottom - EPS
      ) {
        hits.push(`${box.edgeId} on ${r.name}`);
      }
    }
  }
  return hits;
}

describe("drop gap records on the corpus", () => {
  it("match the layout at rest and keep aggregates off cards after a drag", async () => {
    let drags = 0;
    for (const scenario of SCENARIOS) {
      const { nodes, edges, gaps, baseEdges } = await layoutSolved(
        solveForRender({
          targets: scenario.targets.map((t) => ({
            itemId: t.itemId,
            ratePerSec: t.ratePerSec,
          })),
          pack,
        }),
      );

      expect(measureGapRecords(nodes, baseEdges), scenario.id).toEqual(gaps);
      const still = rerouteAfterDrop(nodes, baseEdges);
      expect(still.gaps, scenario.id).toEqual(gaps);
      expect(still.edges, scenario.id).toEqual(edges);

      // Every card that owns a drawn aggregate, dragged toward its trunk.
      const dragged = new Map<string, number>();
      for (const edge of edges) {
        const data = edge.data as
          | { fanout?: boolean; fanin?: boolean; busChipOwner?: boolean }
          | undefined;
        if (edge.type !== "bus" || data?.busChipOwner === false) continue;
        if (data?.fanout === true) dragged.set(edge.source, DRAG_DX);
        else if (data?.fanin === true) dragged.set(edge.target, -DRAG_DX);
      }
      for (const [id, dx] of dragged) {
        const moved = moveBy(nodes, id, dx);
        const drop = rerouteAfterDrop(moved, baseEdges);
        expect(drop.gaps).toEqual(measureGapRecords(moved, baseEdges));
        expect(
          aggregatesOnFurniture(moved, drop.edges),
          `${scenario.id}: ${id} dragged by ${dx}`,
        ).toEqual([]);
        drags += 1;
      }
    }
    expect(drags).toBeGreaterThan(0);
  }, 600_000);

  // A recipe card inside a loop box keeps a parent-relative position, and its
  // own scope's gaps are the container's. A drop measures those records where
  // the card now stands, whether it stays inside the box or leaves it, and never
  // re-widens or moves the box: the drop changes no layout.
  it("re-measure a loop container's own scope when its card is dragged", async () => {
    const { nodes, baseEdges } = await layoutSolved(
      solveForRender({
        targets: SCENARIOS.find((s) => s.id === "battery5")!.targets.map(
          (t) => ({ itemId: t.itemId, ratePerSec: t.ratePerSec }),
        ),
        pack,
      }),
    );
    const loop = nodes.find(
      (n) =>
        n.type === "group" &&
        (n.data as { containerKind?: string }).containerKind === "loop-box",
    )!;
    expect(loop).toBeDefined();
    const card = nodes.find(
      (n) => n.parentId === loop.id && n.type === "recipe",
    )!;
    expect(card).toBeDefined();
    const atRest = measureGapRecords(nodes, baseEdges);
    expect(atRest.some((g) => g.scope === loop.id)).toBe(true);
    const box = { ...loop, style: { ...loop.style } };

    // Inside the box, then past its right wall.
    for (const dx of [DRAG_DX, (loop.width ?? 0) + DRAG_DX]) {
      const moved = moveBy(nodes, card.id, dx);
      const drop = rerouteAfterDrop(moved, baseEdges);
      const fresh = measureGapRecords(moved, baseEdges);
      expect(drop.gaps, `dx ${dx}`).toEqual(fresh);
      // The box keeps its interval in the root scope, so only its own scope's
      // records follow the card.
      const ofScope = (gaps: ReadonlyArray<GapRecord>, scope: string) =>
        gaps.filter((g) => g.scope === scope);
      expect(ofScope(drop.gaps, ROOT_SCOPE), `dx ${dx}`).toEqual(
        ofScope(atRest, ROOT_SCOPE),
      );
      expect(ofScope(drop.gaps, loop.id), `dx ${dx}`).not.toEqual(
        ofScope(atRest, loop.id),
      );
      expect(moved.find((n) => n.id === loop.id)).toEqual(box);
    }
  }, 600_000);
});
