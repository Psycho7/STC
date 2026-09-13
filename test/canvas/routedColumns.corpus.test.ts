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
// business and is skipped.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { routingHintsFromData } from "../../src/canvas/edgePath";
import type { GapRecord } from "../../src/canvas/layerModel";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: the zone bounds and the columns are sums of the same
// fractional layout coordinates, so they agree well inside a pixel.
const EPS = 1e-6;

type Column = { edge: string; kind: string; x: number };

// The columns one edge's stamps put in the gaps: the trunk column a bus member
// shares, the arrival columns of a rail and a jogged descent, and a backward
// rail's two verticals.
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
  push("entryX", hints.entryX);
  push("jogDescentX", hints.jogDescentX);
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
