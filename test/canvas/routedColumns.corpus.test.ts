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
// The second property is the same reserve seen from the CHIP's side: a 1-to-1
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
