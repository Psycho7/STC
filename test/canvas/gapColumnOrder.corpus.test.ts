// The gap column order is honoured on the corpus: every constraint of every
// gap, checked against the columns as routed (columnOrderViolations). This
// check, not each column pass's own logic, is the proof that the passes read
// one order.
//
// The list below is what no pass can keep. coupon-web's
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

const EXPECTED: ReadonlyArray<string> = [
  // #195 residual (one boundary card per imported item moved gas-web's Inergen
  // pool card, and with it these rows). In gap #2, column zone [1609, 1753],
  // the bend of e:5 (q:16 -> q:2, a layer-skipping gas_copper run) must stand
  // right of q:6's arrival row at y 449 and left of q:6's arrival row at
  // y 471. assignEntryColumns runs before assignBendColumns and packs the
  // three arrival columns of that end at one entry pitch: 1713 (q:6 @449),
  // 1729 (q:5 @310) and 1745 (q:6 @471). The bend's allowed x is therefore
  // [1713 + 16, 1745 - 16] = the single point 1729, which q:5's arrival column
  // already holds, and the entry columns cut it out of the bend fan's free
  // spans. No pitch fits, so the bend keeps its fan column, 1685, left of
  // 1713. Flat loops changes nothing here (no gas-web path moves).
  "gas-web: a:u:class:q:6@44900 -> b:e:5:u:class:q:16->u:class:q:2:gas_copper",
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
