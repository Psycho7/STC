// layoutSolved feeds the layout the RAW pack's recipes, never the solve's own
// netted map. The catalyst split moved each transmuter's cycled input into a
// `catalyst` field (phase_trans_1-liquid_xiranite: gas in, liquid out, a
// fifth of the output cycled), so the row that has to survive the raw pass is
// the catalyst row: drawn from the plan boundary, so it has no supplier, no
// port and no edge, while the drawing still shows the flow the player must
// supply.

import { describe, it, expect } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { layoutRenderPlan, type RFRecipeNode } from "../../src/canvas/layout";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";

const CYCLING = "phase_trans_1-liquid_xiranite";
const SELF_ITEM = "liquid_xiranite";
const FED_ITEM = "gas_xiranite";

const targets: ItemTarget[] = [
  { itemId: SELF_ITEM, ratePerSec: { num: "1", denom: "1" } },
];

function recipeNodeOf(
  nodes: ReadonlyArray<{ id: string; data: unknown }>,
): RFRecipeNode {
  const found = nodes.find(
    (n) => (n.data as { recipe?: { id?: string } }).recipe?.id === CYCLING,
  );
  expect(found, `no node drew ${CYCLING}`).toBeDefined();
  return found as RFRecipeNode;
}

describe("layoutSolved on a catalyst-cycling recipe", () => {
  it("draws the cycled row with no incoming edge", async () => {
    const solved = solveForRender({ targets });
    const { nodes, edges } = await layoutSolved(solved, {
      busLanesEnabled: false,
    });

    const node = recipeNodeOf(nodes);
    // The raw in-game stoichiometry: gas in, a fifth of the output cycled
    // back as the catalyst.
    expect(node.data.recipe.in.map((s) => s.item)).toEqual([FED_ITEM]);
    expect(node.data.recipe.catalyst?.map((s) => s.item)).toEqual([SELF_ITEM]);
    // The cycled row takes no west port slot: no edge can arrive at it.
    expect(node.data.inputOrder).not.toContain(SELF_ITEM);

    const incoming = edges.filter((e) => e.target === node.id);
    // Premise: the gas row IS fed, so "no incoming edge" below is about the
    // cycled row and not about an unrouted card.
    expect(incoming.map((e) => e.targetHandle)).toContain(`in:${FED_ITEM}`);
    expect(incoming.map((e) => e.targetHandle)).not.toContain(
      `in:${SELF_ITEM}`,
    );
  }, 60000);

  it("loses that row when the recipe map comes from the netted solve", async () => {
    // The control the rule exists for: this is what the four canvas suites did
    // before layoutSolved, and it is what makes the assertion above meaningful.
    // The shipped pack no longer nets (the split emptied its self-consuming
    // set), so the control rides on the same recipe in its pre-split shape:
    // the cycled item back in `in`, where netting drops it from both sides.
    const preSplitPack = {
      ...pack,
      recipes: pack.recipes.map((r) => {
        if (r.id !== CYCLING) return r;
        const preSplit = {
          ...r,
          in: [...r.in, { item: SELF_ITEM, qty: 0.2 }],
        };
        delete preSplit.catalyst;
        return preSplit;
      }),
    };
    const solved = solveForRender({ targets, pack: preSplitPack });
    const { nodes } = await layoutRenderPlan({
      plan: solved.plan,
      // @ts-expect-error -- the RawRecipeMap brand rejects the solve's netted
      // map; this control passes it on purpose to show what it costs.
      recipeById: solved.full.nettedRecipeById,
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      busLanesEnabled: false,
    });

    const node = recipeNodeOf(nodes);
    expect(node.data.recipe.in.map((s) => s.item)).toEqual([FED_ITEM]);
    expect(node.data.recipe.catalyst).toBeUndefined();
  }, 60000);
});
