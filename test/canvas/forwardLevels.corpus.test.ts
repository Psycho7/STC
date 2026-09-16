// Every forward horizontal run of every corpus plan keeps the level floor off
// the forward runs of the OTHER edges it shares a corridor with.
//
// The column passes have kept a pitch floor on the x axis for a long time: two
// verticals of different edges standing a few units apart read as one thick
// line, so they are pushed a slot apart. Nothing held the y axis to the same
// rule, and the catalyst rows exam found the consequence -- on gas-web the raw
// supply into a recipe and the catalyst supply into the same recipe held levels
// 2 units apart for about a thousand units, drawn as one stroke carrying two
// rate chips, with the catalyst's fan-out dot sitting on the raw line.
//
// The rule is pairwise and geometric, read off the DRAWN polylines rather than
// the stamps, so it judges the lines the reader sees. Two runs that share no
// more than a port stub of x-span are a corner meeting a line, not one smeared
// line, and are not this rule's business. One pair is exempt: two runs that
// COINCIDE on a port row their edges share draw as one line on purpose -- the
// stub every edge leaving one output row draws, the approach every edge
// arriving on one input row draws. Sharing the card is not enough, because a
// recipe fed the same item as a raw input and as a catalyst charge takes it on
// two different rows.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  PORT_STUB,
  drawnEdge,
  horizontalRuns,
  type DrawnEdge,
} from "../../src/canvas/edgePath";
import { ENTRY_SLOT_PITCH } from "../../src/canvas/busRouting";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: the levels are sums of the same fractional layout
// coordinates, so a pair that holds the floor holds it well inside a pixel.
const EPS = 1e-6;

// Plans that cannot satisfy the floor. Empty: every corpus plan holds it. An
// entry here is a finding to report, not a silent pin.
const ALLOWED: ReadonlyArray<{ plan: string; a: string; b: string }> = [];

type Run = {
  edge: string;
  y: number;
  lo: number;
  hi: number;
  source: string;
  target: string;
  sy: number;
  ty: number;
};

// Do the two runs draw as one line on purpose? Only where they coincide on a
// port row their edges share -- see the header.
const sharesPortRow = (a: Run, b: Run): boolean => {
  if (a.y !== b.y) return false;
  if (a.source === b.source && a.sy === b.sy && a.y === a.sy) return true;
  return a.target === b.target && a.ty === b.ty && a.y === a.ty;
};

type Plan = Awaited<ReturnType<typeof layoutSolved>>;

async function layoutOf(id: string): Promise<Plan> {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  return layoutSolved(solveForRender({ targets, pack }));
}

// The drawn shape of one edge, or null where its ports cannot be resolved or it
// is a backward detour (whose level is clampBackwardRails' business).
function forwardDrawn(
  edge: Edge,
  byId: ReturnType<typeof nodeIndexOf>,
): DrawnEdge | null {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return null;
  if (ends.targetX <= ends.sourceX) return null;
  return drawnEdge(ends, edge.type, edge.data);
}

function forwardRunsOf(
  edge: Edge,
  byId: ReturnType<typeof nodeIndexOf>,
): Run[] {
  const drawn = forwardDrawn(edge, byId);
  if (drawn === null) return [];
  const ends = drawnPortsOf(edge, byId)!;
  return horizontalRuns(drawn.pts).map((run) => ({
    edge: edge.id,
    y: run.y,
    lo: run.lo,
    hi: run.hi,
    source: edge.source,
    target: edge.target,
    sy: ends.sourceY,
    ty: ends.targetY,
  }));
}

// The shared x-span of two runs. Positive only where both draw side by side.
const overlapOf = (a: Run, b: Run): number =>
  Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);

describe("two forward runs in one corridor keep the level floor", () => {
  it("holds on every corpus plan", async () => {
    const tight: Array<{
      plan: string;
      a: string;
      b: string;
      dy: number;
      overlap: number;
    }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layoutOf(scenario.id);
      const byId = nodeIndexOf(nodes);
      const runs = edges.flatMap((edge) => forwardRunsOf(edge, byId));
      for (let i = 0; i < runs.length; i += 1) {
        for (let j = i + 1; j < runs.length; j += 1) {
          const a = runs[i]!;
          const b = runs[j]!;
          if (a.edge === b.edge) continue;
          if (overlapOf(a, b) <= PORT_STUB) continue;
          if (sharesPortRow(a, b)) continue;
          checked += 1;
          const dy = Math.abs(a.y - b.y);
          if (dy >= ENTRY_SLOT_PITCH - EPS) continue;
          if (
            ALLOWED.some(
              (entry) =>
                entry.plan === scenario.id &&
                ((entry.a === a.edge && entry.b === b.edge) ||
                  (entry.a === b.edge && entry.b === a.edge)),
            )
          ) {
            continue;
          }
          tight.push({
            plan: scenario.id,
            a: `${a.edge}@${a.y}`,
            b: `${b.edge}@${b.y}`,
            dy,
            overlap: overlapOf(a, b),
          });
        }
      }
    }

    // Premise: the corpus really does draw forward runs of different edges
    // beside each other, so the empty list below is a verdict.
    expect(checked).toBeGreaterThan(0);
    expect(tight).toEqual([]);
  }, 600_000);
});

// The exam's own pair, named: a recipe fed the same item as a raw input and as
// a catalyst charge gets two supply lines from two boundary cards, and before
// the floor they were drawn on top of each other.
const XIRANITE_PLANS = ["gas-web", "copper-script43"] as const;

// Distance from a point to a segment, for the junction-on-a-stroke check below.
function distanceToSegment(
  px: number,
  py: number,
  [x0, y0]: readonly [number, number],
  [x1, y1]: readonly [number, number],
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

describe("the raw and catalyst supplies of one recipe stay apart", () => {
  for (const plan of XIRANITE_PLANS) {
    it(`holds on ${plan}`, async () => {
      const { nodes, edges } = await layoutOf(plan);
      const byId = nodeIndexOf(nodes);
      const raw = edges.filter((e) => e.source === "u:in:gas_xiranite");
      const catalyst = edges.filter((e) => e.source === "u:cat:gas_xiranite");
      const pairs = raw.flatMap((r) =>
        catalyst
          .filter((c) => c.target === r.target)
          .map((c) => ({ raw: r, catalyst: c })),
      );
      // Premise: this plan really does feed a recipe from both pools.
      expect(pairs.length).toBeGreaterThan(0);

      const tight: string[] = [];
      const buried: string[] = [];
      for (const pair of pairs) {
        const rawRuns = forwardRunsOf(pair.raw, byId);
        const catRuns = forwardRunsOf(pair.catalyst, byId);
        for (const a of rawRuns) {
          for (const b of catRuns) {
            if (overlapOf(a, b) <= PORT_STUB) continue;
            if (Math.abs(a.y - b.y) >= ENTRY_SLOT_PITCH - EPS) continue;
            tight.push(`${a.edge}@${a.y} | ${b.edge}@${b.y}`);
          }
        }
        // The catalyst supply's own junction dot, where it draws one, must not
        // land on the raw supply's stroke.
        const drawn = forwardDrawn(pair.catalyst, byId);
        const rawDrawn = forwardDrawn(pair.raw, byId);
        if (drawn === null || rawDrawn === null) continue;
        if (drawn.shape === "item") continue;
        for (let i = 1; i < rawDrawn.pts.length; i += 1) {
          const gap = distanceToSegment(
            drawn.junction.x,
            drawn.junction.y,
            rawDrawn.pts[i - 1]!,
            rawDrawn.pts[i]!,
          );
          if (gap >= ENTRY_SLOT_PITCH - EPS) continue;
          buried.push(
            `${pair.catalyst.id} junction ${gap} from ${pair.raw.id}`,
          );
        }
      }

      expect(tight).toEqual([]);
      expect(buried).toEqual([]);
    }, 600_000);
  }
});
