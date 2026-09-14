// Every routed COLUMN of every corpus plan stands in the zone its gap reserved
// for columns.
//
// The pre-pass splits each inter-layer gap into a source chip reserve, a column
// zone and a target chip reserve, then widens the gap so all three fit. That
// only buys anything while the passes that place vertical runs respect it: a
// junction column, an arrival column or a backward rail's column parked inside
// one of the chip reserves stands exactly where the chips it was widened for
// have to draw. This suite is the whole-corpus check on that -- the unit
// fixtures pin each pass's own rule, this one pins that no pass breaks the
// split on a real plan.
//
// Columns are read off the stamps the passes emit, in the MODEL frame the
// records are in. A column that falls outside every gap (in front of the first
// layer, behind the last, or inside a layer's own x-band) is not this rule's
// business and is skipped. jogForwardLegs' last-resort tier parks a column in a
// layer's own band ON PURPOSE -- the only way past a card that shares a layer
// with the endpoint it stands in front of -- and such a column takes no room
// this rule is about, since every reserve it guards lives in a gap.
//
// The second property is the pitch FLOOR between the column families that share
// one gap: a trunk column, an arrival column, a jogged leg's two columns and the
// staggered 1-to-1 bend columns are placed by different passes, and two of them
// a few units apart read as one thick line. Members of one trunk are exempt --
// they share a column on purpose, which is the whole point of a trunk. Verticals
// whose y-spans do not overlap may share an x: they draw on different rows.
//
// The third property is the same reserve seen from the CHIP's side: a 1-to-1
// edge draws its own rate chip on one of its horizontal runs, and the gap was
// widened so the runs beside its two ports can hold that box. So each of those
// two runs must measure at least the port stub the chip seats past plus the
// chip's own natural width -- which is what a bend column standing right of the
// source reserve and left of the target reserve buys.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  PORT_STUB,
  drawnEdge,
  horizontalRuns,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { chipNaturalWidth, rateChipText } from "../../src/canvas/chipMetrics";
import { ENTRY_SLOT_PITCH } from "../../src/canvas/busRouting";
import {
  buildLayerModel,
  classifyTrunks,
  type GapRecord,
} from "../../src/canvas/layerModel";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: the zone bounds and the columns are sums of the same
// fractional layout coordinates, so they agree well inside a pixel.
const EPS = 1e-6;

type Column = { edge: string; kind: string; x: number };

// The columns one edge's stamps put in the gaps: the trunk column a bus member
// shares, the staggered bend column of a forward item edge, the arrival columns
// of a rail and a jogged descent, the SOURCE-side column of a jog, and a
// backward rail's two verticals.
function columnsOf(edge: Edge): Column[] {
  const data = edge.data as Record<string, unknown> | undefined;
  const hints = routingHintsFromData(data);
  const out: Column[] = [];
  const push = (kind: string, x: number | undefined): void => {
    if (x !== undefined) out.push({ edge: edge.id, kind, x });
  };
  if (edge.type === "bus" && (data?.fanout === true || data?.fanin === true)) {
    push(
      data?.fanin === true ? "fanin junctionX" : "fanout junctionX",
      hints.junctionX,
    );
  }
  if (edge.type === "item") push("bendX", hints.bendX);
  push("entryX", hints.entryX);
  push("jogDescentX", hints.jogDescentX);
  push("srcColX", hints.srcColX);
  push("railXLeft", hints.railXLeft);
  push("railXRight", hints.railXRight);
  return out;
}

const gapAt = (
  gaps: ReadonlyArray<GapRecord>,
  x: number,
): GapRecord | undefined => gaps.find((g) => x > g.left && x < g.right);

describe("routed columns stay inside their gap's column zone", () => {
  it("holds on every corpus plan", async () => {
    const outside: Array<Column & { plan: string; zone: [number, number] }> =
      [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { edges, gaps } = await layoutSolved(
        solveForRender({ targets, pack }),
      );

      for (const edge of edges) {
        for (const column of columnsOf(edge)) {
          const gap = gapAt(gaps, column.x);
          // A column outside every gap -- in front of the first layer, behind
          // the last, or inside a layer's own x-band -- is not this rule's
          // business.
          if (gap === undefined) continue;
          checked += 1;
          if (
            column.x >= gap.columnZone.left - EPS &&
            column.x <= gap.columnZone.right + EPS
          ) {
            continue;
          }
          outside.push({
            plan: scenario.id,
            ...column,
            zone: [gap.columnZone.left, gap.columnZone.right],
          });
        }
      }
    }

    // Premise: the corpus really does route columns through its gaps, so the
    // empty list below is a verdict rather than an empty scan.
    expect(checked).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  }, 600_000);
});

// One drawn vertical segment of one edge: the column it stands on and the rows
// it spans. Read off the DRAWN polyline rather than the stamps, so the rule
// judges the lines the user sees -- a chamfered column's bevels are excluded and
// a one-row diagonal contributes no vertical at all.
type Vertical = { edge: string; x: number; top: number; bottom: number };

function verticalsOf(
  edge: Edge,
  byId: ReturnType<typeof nodeIndexOf>,
): Vertical[] {
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return [];
  const { pts } = drawnEdge(ends, edge.type, edge.data);
  const out: Vertical[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (x0 !== x1 || y0 === y1) continue;
    out.push({
      edge: edge.id,
      x: x0,
      top: Math.min(y0, y1),
      bottom: Math.max(y0, y1),
    });
  }
  return out;
}

describe("two verticals in one gap keep the column pitch floor", () => {
  it("holds on every corpus plan", async () => {
    const tight: Array<{
      plan: string;
      gap: number;
      a: string;
      b: string;
      dx: number;
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
      const { trunkByEdgeId } = classifyTrunks(nodes, edges);
      // Two members of one trunk draw on the trunk's shared column by design.
      const sharesTrunk = (a: string, b: string): boolean => {
        const keysOf = (id: string): string[] => {
          const sides = trunkByEdgeId.get(id);
          return [sides?.fanOut?.key, sides?.fanIn?.key].filter(
            (key): key is string => key !== undefined,
          );
        };
        const keys = keysOf(b);
        return keysOf(a).some((key) => keys.includes(key));
      };

      // Bucket by gap: the floor is a rule about the columns of ONE gap, and a
      // vertical standing in no gap (a jog's last-resort column inside a layer's
      // own band) is not this rule's business, exactly as above.
      const byGap = new Map<number, Vertical[]>();
      for (const edge of edges) {
        for (const vertical of verticalsOf(edge, byId)) {
          const gap = gapAt(gaps, vertical.x);
          if (gap === undefined) continue;
          const list = byGap.get(gap.index) ?? [];
          list.push(vertical);
          byGap.set(gap.index, list);
        }
      }

      for (const [index, list] of byGap) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const a = list[i]!;
            const b = list[j]!;
            if (a.edge === b.edge) continue;
            if (sharesTrunk(a.edge, b.edge)) continue;
            // Disjoint rows: the two columns never draw beside each other.
            if (a.bottom <= b.top || b.bottom <= a.top) continue;
            checked += 1;
            const dx = Math.abs(a.x - b.x);
            if (dx >= ENTRY_SLOT_PITCH - EPS) continue;
            tight.push({
              plan: scenario.id,
              gap: index,
              a: `${a.edge}@${a.x}`,
              b: `${b.edge}@${b.x}`,
              dx,
            });
          }
        }
      }
    }

    // Premise: the corpus really does put verticals of different edges beside
    // each other in one gap, so the empty list is a verdict.
    expect(checked).toBeGreaterThan(0);
    expect(tight).toEqual([]);
  }, 600_000);
});

// The room one 1-to-1 chip needs on the run it seats against: the port stub it
// steps past plus the box it draws at its natural width. Both ends of the edge
// owe it, which is exactly the reserve gapRequirements charged there.
const chipRoom = (edge: Edge): number =>
  PORT_STUB + chipNaturalWidth(rateChipText(edge));

describe("a 1-to-1 edge keeps chip room on its first and last run", () => {
  it("holds on every corpus plan", async () => {
    const short: Array<{
      plan: string;
      edge: string;
      end: "first" | "last";
      length: number;
      needs: number;
    }> = [];
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
      const { trunkByEdgeId } = classifyTrunks(nodes, edges);
      const { layerByNodeId } = buildLayerModel(nodes);

      for (const edge of edges) {
        // 1-to-1 means TOPOLOGICALLY 1-to-1: a trunk member's ends carry the
        // trunk's aggregate chip under the reserve model, not this box.
        if (edge.type !== "item") continue;
        if (trunkByEdgeId.has(edge.id)) continue;
        // Both endpoints in ONE layer: a layer is a maximal run of overlapping
        // x-intervals, so two cards of one layer can stand a few dozen units
        // apart and no gap was ever charged for the pair. The reserve model
        // does not reach that corridor and neither does any column pass, so the
        // rule is about the edges that cross a layer boundary.
        const sourceLayer = layerByNodeId.get(edge.source);
        const targetLayer = layerByNodeId.get(edge.target);
        if (sourceLayer === undefined || targetLayer === undefined) continue;
        if (sourceLayer === targetLayer) continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        if (ends.targetX <= ends.sourceX) continue; // backward detour
        const drawn = drawnEdge(ends, edge.type, edge.data);
        const runs = horizontalRuns(drawn.pts);
        if (runs.length === 0) continue;
        const needs = chipRoom(edge);
        const ownRuns: Array<["first" | "last", number]> = [
          ["first", runs[0]!.hi - runs[0]!.lo],
          ["last", runs[runs.length - 1]!.hi - runs[runs.length - 1]!.lo],
        ];
        for (const [end, length] of ownRuns) {
          checked += 1;
          if (length >= needs - EPS) continue;
          short.push({ plan: scenario.id, edge: edge.id, end, length, needs });
        }
      }
    }

    // Premise: the corpus really does draw 1-to-1 edges.
    expect(checked).toBeGreaterThan(0);
    expect(short).toEqual([]);
  }, 600_000);
});
