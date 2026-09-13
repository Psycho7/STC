// Width census for the gap-widening pre-pass: every exam-corpus plan laid out
// twice, once on ELK's own gaps and once on the widened ones, so the cost of the
// chip reserves is a measured number per plan rather than an estimate.
//
// This suite is a MEASUREMENT, not a gate: it asserts only that widening never
// narrows a plan and that no gap ends up narrower than it owes. The width ratio
// it tables is for the reader -- the reserve pads and the column pitch are tuned
// against it, so no threshold on it is asserted here.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  isNToM,
  buildLayerModel,
  classifyTrunks,
  gapSpansOf,
  gapRequirements,
  sameItemComponentsOf,
  COLUMN_PITCH,
  RESERVE_CARD_PAD,
  RESERVE_COLUMN_PAD,
} from "../../src/canvas/layerModel";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  absoluteLeft,
  nodeIndexOf,
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
  "/tmp/claude-1000/-home-rins-workspace-STC-workspace-STC/4420d6c0-9b09-48da-8173-d55d95e33754/scratchpad/t2-width-census.json";

// Laid-out width of a plan: the leaf nodes' bounding span in x. Containers are
// skipped because they only wrap their children.
function plannedWidth(nodes: ReadonlyArray<RFAnyNode>): number {
  const byId = nodeIndexOf(nodes);
  let left = Infinity;
  let right = -Infinity;
  for (const node of nodes) {
    if (node.type === "group") continue;
    const l = absoluteLeft(node, byId);
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

      // Per-gap delta: the widened span against ELK's own span at the same gap
      // index. The before layout carries no gap records (the pre-pass is off), so
      // its spans come straight off its layer model.
      const beforeGaps = gapSpans(before.nodes);
      const afterGaps = after.gaps.map((g) => g.right - g.left);
      let gapsWidened = 0;
      let largestDelta = 0;
      afterGaps.forEach((width, index) => {
        const baseline = beforeGaps[index];
        if (baseline === undefined) return;
        const delta = width - baseline;
        if (delta <= 0) return;
        gapsWidened += 1;
        largestDelta = Math.max(largestDelta, delta);
      });

      // The pre-pass's own contract, on real layouts: no gap comes out narrower
      // than what it owes. The requirements are re-measured on the WIDENED nodes
      // (a uniform per-layer shift leaves layer membership, and so every
      // requirement, unchanged), and compared against the spans it reported.
      const required = gapRequirements(after.nodes, after.edges);
      expect(required).toHaveLength(after.gaps.length);
      const short = after.gaps
        .map((gap, index) => ({
          index,
          span: gap.right - gap.left,
          required: required[index]!.required,
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
      rows,
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  }, 600_000);
});

// The inter-layer gap widths of a laid-out plan, by gap index. Needed for the
// before layout, which runs with the pre-pass off and so reports no gap records.
function gapSpans(nodes: ReadonlyArray<RFAnyNode>): number[] {
  return gapSpansOf(buildLayerModel(nodes)).map((gap) => gap.right - gap.left);
}
