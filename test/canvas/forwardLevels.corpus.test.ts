// Every horizontal run of every corpus plan keeps the level floor off the runs
// of the OTHER edges it shares a corridor with.
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
//
// A BACKWARD rail's horizontals are in scope too (canvas defect casebook,
// 2026-09-19, family D): a rail fused with the forward run it passes is the
// same smeared stroke, and the rail pass picks its level with no knowledge of
// the forward bands. The pairs that class already draws are allow-listed below
// rather than fixed, so a sixth one reddens this test.

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

// Pairs that do not satisfy the floor. Every entry is a finding on the record,
// not a silent pin: these five are the whole of family D of the canvas defect
// casebook (2026-09-19), a backward rail fused with a forward run it passes for
// the width of the graph. The rail pass places a rail without seeing the
// forward bands, which is a root cause held for the shared-level-field
// prototype rather than patched, so the list is frozen here and any SIXTH pair
// reddens this test.
//
// Each side is `<edge id>@<level>`, the same key the report below prints, so an
// entry names the one fusion it harvested: the same two edges fused again at
// another level is a new finding and reddens the test too.
const ALLOWED: ReadonlyArray<{ plan: string; a: string; b: string }> = [
  {
    plan: "battery5",
    a: "e:4:u:class:q:10->u:class:q:5:liquid_water@866",
    b: "e:16:u:class:q:5->u:surplus:copper_nugget:copper_nugget@856",
  },
  {
    plan: "battery5",
    a: "e:6:u:class:q:12->u:class:q:14:plant_moss_3@326",
    b: "e:24:u:in:originium_ore->u:class:q:1:originium_ore@323",
  },
  {
    plan: "battery5-xiranite",
    a: "e:9:u:class:q:16->u:class:q:9:liquid_water@952",
    b: "e:27:u:class:q:9->u:surplus:liquid_sewage:liquid_sewage@959.5",
  },
  {
    plan: "battery5-xiranite",
    a: "e:13:u:class:q:24->u:class:q:26:plant_moss_3@1096",
    b: "e:35:u:in:originium_ore->u:class:q:4:originium_ore@1093",
  },
  {
    plan: "multi6",
    a: "e:43:u:class:q:51->u:class:q:55:plant_grass_1@1014",
    b: "e:79:u:in:liquid_water->u:class:q:28:liquid_water@1014",
  },
];

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

// The drawn shape of one edge, or null where its ports cannot be resolved.
function drawnOf(
  edge: Edge,
  byId: ReturnType<typeof nodeIndexOf>,
): DrawnEdge | null {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return null;
  return drawnEdge(ends, edge.type, edge.data);
}

function runsOf(edge: Edge, byId: ReturnType<typeof nodeIndexOf>): Run[] {
  const drawn = drawnOf(edge, byId);
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

// One run, named by the line it belongs to and the level it holds.
const keyOf = (run: Run): string => `${run.edge}@${run.y}`;

describe("two runs in one corridor keep the level floor", () => {
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
      const runs = edges.flatMap((edge) => runsOf(edge, byId));
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
          const ka = keyOf(a);
          const kb = keyOf(b);
          if (
            ALLOWED.some(
              (entry) =>
                entry.plan === scenario.id &&
                ((entry.a === ka && entry.b === kb) ||
                  (entry.a === kb && entry.b === ka)),
            )
          ) {
            continue;
          }
          tight.push({
            plan: scenario.id,
            a: ka,
            b: kb,
            dy,
            overlap: overlapOf(a, b),
          });
        }
      }
    }

    // Premise: the corpus really does draw runs of different edges beside each
    // other, so the empty list below is a verdict.
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
        const rawRuns = runsOf(pair.raw, byId);
        const catRuns = runsOf(pair.catalyst, byId);
        for (const a of rawRuns) {
          for (const b of catRuns) {
            if (overlapOf(a, b) <= PORT_STUB) continue;
            if (Math.abs(a.y - b.y) >= ENTRY_SLOT_PITCH - EPS) continue;
            tight.push(`${a.edge}@${a.y} | ${b.edge}@${b.y}`);
          }
        }
        // The catalyst supply's own junction dot, where it draws one, must not
        // land on the raw supply's stroke.
        const drawn = drawnOf(pair.catalyst, byId);
        const rawDrawn = drawnOf(pair.raw, byId);
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
