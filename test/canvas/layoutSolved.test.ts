// layoutSolved feeds the layout the RAW pack's recipes, never the solve's own
// netted map. The shipped pack carries two self-consuming recipes
// (phase_trans_1-liquid_xiranite, phase_trans_2-gas_xiranite): the solver nets
// the self-consumed item off both sides so no self-edge materializes, and the
// drawing has to keep the in-game row so the player can see the flow they must
// loop back themselves.

import { describe, it, expect } from "vitest";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { layoutRenderPlan, type RFRecipeNode } from "../../src/canvas/layout";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";

const SELF_CONSUMING = "phase_trans_1-liquid_xiranite";
const SELF_ITEM = "liquid_xiranite";
const FED_ITEM = "gas_xiranite";

const targets: ItemTarget[] = [
  { itemId: SELF_ITEM, ratePerSec: { num: "1", denom: "1" } },
];

function recipeNodeOf(
  nodes: ReadonlyArray<{ id: string; data: unknown }>,
): RFRecipeNode {
  const found = nodes.find(
    (n) =>
      (n.data as { recipe?: { id?: string } }).recipe?.id === SELF_CONSUMING,
  );
  expect(found, `no node drew ${SELF_CONSUMING}`).toBeDefined();
  return found as RFRecipeNode;
}

describe("layoutSolved on a self-consuming recipe", () => {
  it("draws the self-consumed input row with no incoming edge", async () => {
    const solved = solveForRender({ targets });
    const { nodes, edges } = await layoutSolved(solved, {
      busLanesEnabled: false,
    });

    const node = recipeNodeOf(nodes);
    // The raw in-game stoichiometry: gas in, a fifth of the output looped back.
    expect(node.data.recipe.in.map((s) => s.item).sort()).toEqual([
      FED_ITEM,
      SELF_ITEM,
    ]);
    // The row really is drawn: it has an ELK-resolved west port slot.
    expect(node.data.inputOrder).toContain(SELF_ITEM);

    const incoming = edges.filter((e) => e.target === node.id);
    // Premise: the gas row IS fed, so "no incoming edge" below is about the
    // self-consumed row and not about an unrouted card.
    expect(incoming.map((e) => e.targetHandle)).toContain(`in:${FED_ITEM}`);
    expect(incoming.map((e) => e.targetHandle)).not.toContain(
      `in:${SELF_ITEM}`,
    );
  }, 60000);

  it("loses that row when the recipe map comes from the netted solve", async () => {
    // The control the rule exists for: this is what the four canvas suites did
    // before layoutSolved, and it is what makes the assertion above meaningful.
    const solved = solveForRender({ targets });
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
    expect(node.data.inputOrder).not.toContain(SELF_ITEM);
  }, 60000);
});
