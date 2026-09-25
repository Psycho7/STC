// Width census for the gap-widening pre-pass: every exam-corpus plan laid out
// twice, once on ELK's own gaps and once on the widened ones, so the cost of the
// chip reserves is a measured number per plan rather than an estimate.
//
// This suite is a MEASUREMENT, not a gate: it asserts only that widening never
// narrows a plan and that no gap ends up narrower than it owes. The width ratio
// it tables is for the reader -- the reserve pads and the column pitch are tuned
// against it, so no threshold on it is asserted here.
//
// The column zone holds the trunk columns at COLUMN_PITCH and the staggered
// 1-to-1 bend columns at COLUMN_MIN_PITCH, the floor the routing passes keep
// between any two columns of one gap. Both pitches ride in the report header, so
// a row's ratio can be read against what the columns were charged for; the floor
// cost the corpus between 3% and 13% of plan width when it was introduced
// (widest: multi6).

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  isNToM,
  buildLayerModel,
  classifyTrunks,
  gapKeyOf,
  gapSpansOf,
  gapRequirements,
  sameItemComponentsOf,
  COLUMN_MIN_PITCH,
  COLUMN_PITCH,
  RESERVE_CARD_PAD,
  RESERVE_COLUMN_PAD,
} from "../../src/canvas/layerModel";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  absoluteLeft,
  edgeTargetSide,
  nodeWidth,
} from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack when comparing a measured span against its requirement:
// both sides are sums of the same fractional chip widths, so they agree to well
// inside a pixel, and this only keeps the last binary digit from failing the
// suite.
const SPAN_TOLERANCE = 1e-6;

const OUT =
  "/tmp/claude-1000/-home-rins-workspace-STC-workspace-STC/a0f99249-1eb8-4705-b511-edeea31a8f21/scratchpad/layer-width-census.json";

// Laid-out width of a plan: the leaf nodes' bounding span in x. Containers are
// skipped because they only wrap their children.
function plannedWidth(nodes: ReadonlyArray<RFAnyNode>): number {
  let left = Infinity;
  let right = -Infinity;
  for (const node of nodes) {
    const l = absoluteLeft(node);
    left = Math.min(left, l);
    right = Math.max(right, l + nodeWidth(node));
  }
  return Number.isFinite(left) ? right - left : 0;
}

type Row = {
  plan: string;
  widthBefore: number;
  widthAfter: number;
  ratio: number;
  gapsWidened: number;
  largestDelta: number;
  webs: number;
  nonWebNToM: number;
};

describe("layer-gap widening: width census over the exam corpus", () => {
  it("never narrows a plan, and writes the table", async () => {
    const rows: Row[] = [];

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const solved = solveForRender({ targets, pack });
      const before = await layoutSolved(solved, { widenGaps: false });
      const after = await layoutSolved(solved, { widenGaps: true });

      const widthBefore = plannedWidth(before.nodes);
      const widthAfter = plannedWidth(after.nodes);

      // Per-gap delta: the widened span against ELK's own span at the same gap,
      // keyed by scope and index (a root gap and a container interior gap can
      // cover one x band). The before layout carries no gap records (the pre-pass
      // is off), so its spans come straight off its layer model.
      const beforeGaps = gapSpans(before.nodes);
      let gapsWidened = 0;
      let largestDelta = 0;
      for (const gap of after.gaps) {
        const baseline = beforeGaps.get(gapKeyOf(gap));
        if (baseline === undefined) continue;
        const delta = gap.right - gap.left - baseline;
        if (delta <= 0) continue;
        gapsWidened += 1;
        largestDelta = Math.max(largestDelta, delta);
      }

      // The pre-pass's own contract, on real layouts: no gap comes out narrower
      // than what it owes. The requirements are re-measured on the WIDENED nodes
      // (a uniform per-layer shift leaves layer membership, and so every
      // requirement, unchanged), and compared against the spans it reported.
      const required = new Map(
        gapRequirements(after.nodes, after.edges).map((gap) => [
          gapKeyOf(gap),
          gap.required,
        ]),
      );
      expect(required.size).toBe(after.gaps.length);
      const short = after.gaps
        .map((gap) => ({
          gap: gapKeyOf(gap),
          span: gap.right - gap.left,
          required: required.get(gapKeyOf(gap))!,
        }))
        .filter((row) => row.span + SPAN_TOLERANCE < row.required);
      expect({ plan: scenario.id, short }).toEqual({
        plan: scenario.id,
        short: [],
      });

      const components = sameItemComponentsOf(before.nodes, before.edges);
      const webs = classifyTrunks(before.nodes, before.edges).webs.length;

      rows.push({
        plan: scenario.id,
        widthBefore,
        widthAfter,
        ratio: Number((widthAfter / widthBefore).toFixed(3)),
        gapsWidened,
        largestDelta,
        webs,
        nonWebNToM: components.filter(isNToM).length - webs,
      });

      expect(widthAfter).toBeGreaterThanOrEqual(widthBefore);
    }

    const report = {
      reserveCardPad: RESERVE_CARD_PAD,
      reserveColumnPad: RESERVE_COLUMN_PAD,
      columnPitch: COLUMN_PITCH,
      columnMinPitch: COLUMN_MIN_PITCH,
      rows,
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  }, 600_000);
});

// A card takes one item on an input row and on a catalyst row through two
// separate ports, so the two arrivals are two trunk candidates: a fan-in trunk
// whose members do not all enter on one row kind would draw one merge column and
// one aggregate total for flows that never meet (issue #154).
describe("fan-in trunks over the exam corpus", () => {
  it("never mixes a card's input row with its catalyst row", async () => {
    const mixed: Array<{ plan: string; trunk: string; members: string[] }> = [];
    let fanIns = 0;

    for (const scenario of SCENARIOS) {
      const targets: ItemTarget[] = scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { nodes, edges } = await layoutSolved(
        solveForRender({ targets, pack }),
      );
      const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

      for (const trunk of classifyTrunks(nodes, edges).trunks) {
        if (trunk.kind !== "fanIn") continue;
        fanIns += 1;
        const sides = new Set(
          trunk.members.map((id) => edgeTargetSide(edgeById.get(id)!)),
        );
        if (sides.size === 1) continue;
        mixed.push({
          plan: scenario.id,
          trunk: trunk.key,
          members: [...trunk.members],
        });
      }
    }

    // Premise: the corpus really does build fan-in trunks, so the empty list
    // below is a verdict rather than an empty scan.
    expect(fanIns).toBeGreaterThan(0);
    expect(mixed).toEqual([]);
  }, 600_000);
});

// The inter-layer gap widths of a laid-out plan, by gap key. Needed for the
// before layout, which runs with the pre-pass off and so reports no gap records.
function gapSpans(nodes: ReadonlyArray<RFAnyNode>): Map<string, number> {
  return new Map(
    gapSpansOf(buildLayerModel(nodes)).map((gap) => [
      gapKeyOf(gap),
      gap.right - gap.left,
    ]),
  );
}
