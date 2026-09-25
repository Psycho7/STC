// The gap column order is honoured on the corpus: every constraint of every
// gap, checked against the columns as routed (columnOrderViolations). This
// check, not each column pass's own logic, is the proof that the passes read
// one order.
//
// The list below is what no pass can keep, and it is empty. coupon-web's
// sewage bend e:8 once stood right of the descent of e:29 that it must precede;
// under the pairwise cost relation the bend is ordered in its gap as well (it
// now stands at 1034, left of the copper_nugget trunk's walk) and the descent
// keeps right of it.

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

const EXPECTED: ReadonlyArray<string> = [];

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
