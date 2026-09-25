// The gap column order is honoured on the corpus: every constraint of every
// gap, checked against the columns as routed (columnOrderViolations). This
// check, not each column pass's own logic, is the proof that the passes read
// one order.
//
// The list below is what no pass can keep. coupon-web's sewage bend e:8 must
// stand left of the descent of e:29, but the only room right of the bend in
// that gap's column zone is held by e:3's descent into the same card, which is
// routed first; the descent takes the nearest free slot and the pair stays
// inverted.

import { describe, it, expect } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  buildGapColumnOrder,
  columnOrderViolations,
} from "../../src/canvas/gapColumnOrder";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS } from "../e2e/scenarios";

// rot-jinlong_coupon, the plan whose two arrival-column pairs issue #192
// names, pinned by its targets rather than by a rotating exam file.
const PLANS = [
  ...SCENARIOS.map((s) => ({ id: s.id, targets: s.targets })),
  {
    id: "rot-jinlong_coupon",
    targets: [
      { itemId: "jinlong_coupon", ratePerSec: { num: "1", denom: "2" } },
    ],
  },
];

const EXPECTED: ReadonlyArray<string> = [
  "coupon-web: b:e:8:u:class:q:10->u:surplus:liquid_sewage:liquid_sewage" +
    " -> d:e:29:u:in:gas_xiranite->u:class:q:7:gas_xiranite",
];

describe("the gap column order is honoured", () => {
  it("breaks only the listed constraints on the corpus", async () => {
    const found: string[] = [];
    let constraints = 0;
    for (const plan of PLANS) {
      const targets: ItemTarget[] = plan.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      }));
      const { nodes, edges, baseEdges, gaps } = await layoutSolved(
        solveForRender({ targets, pack }),
      );
      const order = buildGapColumnOrder(nodes, baseEdges, gaps);
      for (const c of order.byId.values()) {
        constraints += order.rightNeighbours(c.id).length;
      }
      for (const v of columnOrderViolations(order, nodes, edges)) {
        found.push(`${plan.id}: ${v.left} -> ${v.right}`);
      }
    }

    // Premise: the corpus has constraints to break, so the list is a verdict.
    expect(constraints).toBeGreaterThan(0);
    expect(found.sort()).toEqual([...EXPECTED].sort());
  }, 600_000);
});
