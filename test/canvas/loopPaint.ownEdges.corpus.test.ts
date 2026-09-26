// The loop paint reads as the loop's drawing: the member cards AND the strokes
// of the loop's own edges, forward and return, as the canvas draws them. So on
// all 18 corpus plans:
//
// - every drawn segment of every loop-internal edge lies inside its loop's
//   paint, with air around the stroke rather than the stroke tracing the tint
//   edge or running outside it;
// - every loop's paint is one connected region;
// - a backward rail the loop does not own keeps LOOP_PAINT_AIR off the paint,
//   and two loops' paints keep LOOP_PAINT_AIR apart (they never merge);
// - no card outside the cycle lies under the paint.
//
// The paint follows a drag: it is rebuilt from the live node positions through
// the same drawn geometry the edges render with, so the moved strokes stay
// inside it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import type { RFAnyNode } from "../../src/canvas/layout";
import { drawnEdge } from "../../src/canvas/edgePath";
import {
  LOOP_PAINT_AIR,
  loopPaints,
  type LoopPaint,
} from "../../src/canvas/loopPaint";
import {
  drawnPortsOf,
  nodeIndexOf,
  nodeRectOf,
  type Rect,
} from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import {
  readStoredEventOverrides,
  unavailableCauses,
  unavailableRecipeIds,
} from "../../src/data/availability";
import { SCENARIOS, type Scenario } from "../e2e/scenarios";

const rotating = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "fixtures/levelOccupancy/rotating.json"),
    "utf8",
  ),
) as Scenario[];

// The fifteen scenarios, the two rotating loop plans and rot-jinlong_coupon.
const PLANS: ReadonlyArray<Pick<Scenario, "id" | "targets" | "area">> = [
  ...SCENARIOS,
  ...rotating,
  {
    id: "rot-jinlong_coupon",
    targets: [
      { itemId: "jinlong_coupon", ratePerSec: { num: "1", denom: "2" } },
    ],
  },
];

// Air a stroke keeps inside its paint on every side. The paint pads a stroke
// by LOOP_PAINT_PAD and yields only toward a foreign card or another loop's
// paint, so the air never drops this low on the corpus; a stroke on or outside
// the tint edge has none.
const STROKE_INSET = 4;

// Sample pitch along a stroke, in graph units.
const STEP = 1;

type Pt = readonly [number, number];

const layouts = new Map<
  string,
  Promise<{ nodes: RFAnyNode[]; edges: Edge[] }>
>();

function layOut(
  plan: (typeof PLANS)[number],
): Promise<{ nodes: RFAnyNode[]; edges: Edge[] }> {
  let hit = layouts.get(plan.id);
  if (hit === undefined) {
    const area = plan.area;
    hit = layoutSolved(
      solveForRender({
        targets: plan.targets.map((t) => ({
          itemId: t.itemId,
          ratePerSec: t.ratePerSec,
        })),
        pack,
        ...(area !== undefined
          ? {
              unavailableRecipeIds: unavailableRecipeIds(
                unavailableCauses(pack, {
                  eventOverrides: readStoredEventOverrides(),
                  area,
                }),
              ),
            }
          : {}),
      }),
    ).then(({ nodes, edges }) => ({ nodes, edges }));
    layouts.set(plan.id, hit);
  }
  return hit;
}

function* samples(a: Pt, b: Pt): Generator<Pt> {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP));
  for (let i = 0; i <= n; i++) {
    yield [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
  }
}

const covered = (x: number, y: number, rects: ReadonlyArray<Rect>): boolean =>
  rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

const pointToRect = (x: number, y: number, r: Rect): number =>
  Math.hypot(
    Math.max(r.left - x, 0, x - r.right),
    Math.max(r.top - y, 0, y - r.bottom),
  );

const rectGap = (a: Rect, b: Rect): number =>
  Math.hypot(
    Math.max(a.left - b.right, b.left - a.right, 0),
    Math.max(a.top - b.bottom, b.top - a.bottom, 0),
  );

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Connected components of a union of rects: two rects join when they overlap
// or share a stretch of border.
function regions(rects: ReadonlyArray<Rect>): number {
  const parent = rects.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w >= 0 && h >= 0 && (w > 0 || h > 0)) parent[find(i)] = find(j);
    }
  }
  return new Set(rects.map((_, i) => find(i))).size;
}

const short = (id: string): string => /^(e:\d+)/.exec(id)?.[1] ?? id;

const owns = (paint: LoopPaint, edge: Edge): boolean =>
  paint.members.includes(edge.source) && paint.members.includes(edge.target);

type Drawn = { edge: Edge; pts: ReadonlyArray<Pt>; backward: boolean };

function drawnEdges(nodes: RFAnyNode[], edges: Edge[]): Drawn[] {
  const byId = nodeIndexOf(nodes);
  const out: Drawn[] = [];
  for (const edge of edges) {
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    out.push({
      edge,
      pts: drawnEdge(ends, edge.type, edge.data).pts,
      backward: ends.targetX <= ends.sourceX,
    });
  }
  return out;
}

// Samples of the loop's own strokes that sit outside the paint or closer than
// STROKE_INSET to its edge, counted per edge.
function ownStrokesOutside(
  paint: LoopPaint,
  drawn: ReadonlyArray<Drawn>,
): string[] {
  const out: string[] = [];
  for (const d of drawn) {
    if (!owns(paint, d.edge)) continue;
    let bad = 0;
    for (let i = 1; i < d.pts.length; i++) {
      for (const [x, y] of samples(d.pts[i - 1]!, d.pts[i]!)) {
        const inside = [
          [0, 0],
          [STROKE_INSET, 0],
          [-STROKE_INSET, 0],
          [0, STROKE_INSET],
          [0, -STROKE_INSET],
        ].every(([dx, dy]) => covered(x + dx!, y + dy!, paint.rects));
        if (!inside) bad++;
      }
    }
    if (bad > 0) out.push(`${short(d.edge.id)} (${bad} samples)`);
  }
  return out;
}

describe("the loop paint encloses the loop's own edges", () => {
  it("covers every drawn segment of every loop-internal edge, on all 18 plans", async () => {
    const outside: string[] = [];
    const looped: string[] = [];
    for (const plan of PLANS) {
      const { nodes, edges } = await layOut(plan);
      const drawn = drawnEdges(nodes, edges);
      const paints = loopPaints(nodes, edges);
      if (paints.length > 0) looped.push(plan.id);
      for (const paint of paints) {
        for (const hit of ownStrokesOutside(paint, drawn)) {
          outside.push(`${plan.id} ${paint.members[0]}: ${hit}`);
        }
      }
    }
    // Premise: the corpus has loops to check.
    expect(looped.length).toBeGreaterThanOrEqual(9);
    expect(outside).toEqual([]);
  }, 1_200_000);

  it("paints every loop as one connected region", async () => {
    const split: string[] = [];
    for (const plan of PLANS) {
      const { nodes, edges } = await layOut(plan);
      for (const paint of loopPaints(nodes, edges)) {
        const n = regions(paint.rects);
        if (n !== 1) split.push(`${plan.id} ${paint.members[0]}: ${n} regions`);
      }
    }
    expect(split).toEqual([]);
  }, 1_200_000);

  it("keeps foreign rails, other loops' paints and foreign cards off the paint", async () => {
    const railHits: string[] = [];
    const merges: string[] = [];
    const cardHits: string[] = [];
    for (const plan of PLANS) {
      const { nodes, edges } = await layOut(plan);
      const drawn = drawnEdges(nodes, edges);
      const paints = loopPaints(nodes, edges);
      for (const paint of paints) {
        for (const d of drawn) {
          if (!d.backward || owns(paint, d.edge)) continue;
          let nearest = Infinity;
          for (let i = 1; i < d.pts.length; i++) {
            for (const [x, y] of samples(d.pts[i - 1]!, d.pts[i]!)) {
              for (const r of paint.rects) {
                nearest = Math.min(nearest, pointToRect(x, y, r));
              }
            }
          }
          if (nearest < LOOP_PAINT_AIR) {
            railHits.push(
              `${plan.id} ${short(d.edge.id)} ${nearest.toFixed(1)} off ${paint.members[0]}`,
            );
          }
        }
        for (const card of nodes) {
          if (card.type !== "recipe" && card.type !== "product") continue;
          if (paint.members.includes(card.id)) continue;
          const rect = nodeRectOf(card);
          if (paint.rects.some((r) => overlaps(r, rect))) {
            cardHits.push(`${plan.id}: ${card.id} under ${paint.members[0]}`);
          }
        }
      }
      for (let i = 0; i < paints.length; i++) {
        for (let j = i + 1; j < paints.length; j++) {
          let gap = Infinity;
          for (const a of paints[i]!.rects) {
            for (const b of paints[j]!.rects)
              gap = Math.min(gap, rectGap(a, b));
          }
          if (gap < LOOP_PAINT_AIR) {
            merges.push(
              `${plan.id} ${paints[i]!.members[0]} / ${paints[j]!.members[0]}: ${gap}`,
            );
          }
        }
      }
    }
    expect(LOOP_PAINT_AIR).toBeGreaterThan(0);
    expect(railHits).toEqual([]);
    expect(merges).toEqual([]);
    expect(cardHits).toEqual([]);
  }, 1_200_000);

  it("seats no caption on a rail", async () => {
    // A rail is a backward edge's horizontal run; the caption text would sit
    // on the stroke. Forward runs may cross the tint band like any stroke.
    const onRail: string[] = [];
    for (const plan of PLANS) {
      const { nodes, edges } = await layOut(plan);
      const drawn = drawnEdges(nodes, edges).filter((d) => d.backward);
      for (const paint of loopPaints(nodes, edges)) {
        const band = paint.caption;
        if (band === undefined) continue;
        for (const d of drawn) {
          for (let i = 1; i < d.pts.length; i++) {
            const [x0, y0] = d.pts[i - 1]!;
            const [x1, y1] = d.pts[i]!;
            if (y0 !== y1 || y0 < band.top || y0 > band.bottom) continue;
            const lo = Math.min(x0, x1);
            const hi = Math.max(x0, x1);
            if (Math.min(hi, band.right) > Math.max(lo, band.left)) {
              onRail.push(
                `${plan.id} ${paint.members[0]}: ${short(d.edge.id)}`,
              );
            }
          }
        }
      }
    }
    expect(onRail).toEqual([]);
  }, 1_200_000);

  it("follows a dragged member: the moved strokes stay inside the rebuilt paint", async () => {
    const { nodes, edges } = await layOut(
      PLANS.find((p) => p.id === "battery5")!,
    );
    const rest = loopPaints(nodes, edges);
    const dragged = rest[0]!.members[0]!;
    const moved = nodes.map((n) =>
      n.id === dragged
        ? { ...n, position: { x: n.position.x + 40, y: n.position.y + 60 } }
        : n,
    ) as RFAnyNode[];

    const paints = loopPaints(moved, edges);
    expect(paints[0]!.rects).not.toEqual(rest[0]!.rects);
    const drawn = drawnEdges(moved, edges);
    for (const paint of paints) {
      expect(ownStrokesOutside(paint, drawn)).toEqual([]);
      expect(regions(paint.rects)).toBe(1);
    }
  }, 300_000);
});
