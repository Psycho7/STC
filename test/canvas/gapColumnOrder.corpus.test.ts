// The gap column order is honoured on the corpus: every constraint of every
// gap, checked against the columns as routed (columnOrderViolations). This
// check, not each column pass's own logic, is the proof that the passes read
// one order.
//
// The list below is what no pass can keep. coupon-web's sewage bend e:8 once
// stood right of the descent of e:29 that it must precede; under the pairwise
// cost relation the bend is ordered in its gap as well (it now stands at 1034,
// left of the copper_nugget trunk's walk) and the descent keeps right of it.
//
// gas-web gap #2: e:12's arrival row on q:6 (left row 328, right row 449) must
// stand left of e:5's bend (left row 470, right row 343), since the other order
// runs 328 and 343 within the floor. The arrival stands at 1713, inside the
// entry gutter of q:5 and q:6, and the bend corridor ends at that gutter's
// wall, so the bend keeps its fan column 1685. Both lines draw exactly as on
// the base; the pair is inverted there too.
//
// multi6 gap #3: the order predicts e:82's jog off its drawn target row and
// ranks its descent, so the arrival rows of q:17 and q:49 take the slot one
// pitch further left (3233.5). The descents of e:71 and e:82 must stand right
// of a column at 3249.5, but the zone ends at 3289.5 and 3277.5 is taken, so
// no pitch is free and both keep their next free slot, 3053.5.

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
  "gas-web: a:u:class:q:6@44900 -> b:e:5:u:class:q:16->u:class:q:2:gas_copper",
  "multi6: a:u:class:q:17@158100 -> d:e:82:u:in:liquid_water->u:class:q:9:liquid_water",
  "multi6: a:u:class:q:49@15000 -> d:e:71:u:in:gas_inert->u:class:q:32:gas_inert",
];

// Constraint cycles per plan (GapColumnOrder.cycles), before any is broken.
// None on the corpus; gapColumnOrder.test.ts builds one synthetically.
const EXPECTED_CYCLES: Readonly<Record<string, number>> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
  "copper-script43": 0,
  "script43-xiranite": 0,
  "rot-jinlong_coupon": 0,
};

describe("the gap column order is honoured", () => {
  it("breaks only the listed constraints on the corpus", async () => {
    const found: string[] = [];
    const cycles: Record<string, number> = {};
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
      cycles[plan.id] = order.cycles;
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
    expect(cycles).toEqual(EXPECTED_CYCLES);
  }, 600_000);
});
