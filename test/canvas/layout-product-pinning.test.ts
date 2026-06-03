import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";

import {
  ELK_LAYER_CONSTRAINT_KEY,
  ELK_LAYER_FIRST,
  ELK_LAYER_LAST,
  layoutRenderPlan,
  renderPlanToElkGraph,
  type LayoutInput,
} from "../../src/canvas/layout";
import type {
  RenderPlan,
  RenderUnitInputProduct,
  RenderUnitOutputProduct,
  RenderUnitRecipe,
} from "../../src/pipeline/types";

const recipe: Recipe = {
  id: "smelt",
  name: "smelt",
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "plate", qty: 1 }],
  producers: [],
};

const recipeUnit: RenderUnitRecipe = {
  id: "u:r:smelt",
  kind: "recipe",
  recipeId: "smelt",
  count: 1,
  multiplicity: { num: "1", denom: "1" },
};

const inputUnit: RenderUnitInputProduct = {
  id: "u:in:ore",
  kind: "inputProduct",
  itemId: "ore",
  count: 1,
  rate: { num: "1", denom: "1" },
};

const outputUnit: RenderUnitOutputProduct = {
  id: "u:out:plate",
  kind: "outputProduct",
  itemId: "plate",
  count: 1,
  rate: { num: "1", denom: "1" },
  flavor: "target",
};

const plan: RenderPlan = {
  units: [recipeUnit, inputUnit, outputUnit],
  edges: [
    {
      fromUnit: inputUnit.id,
      toUnit: recipeUnit.id,
      item: "ore",
      rate: new Fraction(1),
      transportKind: "belt",
    },
    {
      fromUnit: recipeUnit.id,
      toUnit: outputUnit.id,
      item: "plate",
      rate: new Fraction(1),
      transportKind: "belt",
    },
  ],
  containers: [],
};

const layoutInput: LayoutInput = {
  plan,
  recipeById: new Map([[recipe.id, recipe]]),
  itemById: new Map(),
};

describe("layout / product-unit ELK layer pinning", () => {
  it("attaches layerConstraint=FIRST to input-product nodes and LAST to output-product nodes", () => {
    const elk = renderPlanToElkGraph(layoutInput);
    const byId = new Map<string, (typeof elk.children)[number]>();
    for (const c of elk.children) byId.set(c.id, c);

    const inputNode = byId.get(inputUnit.id);
    const outputNode = byId.get(outputUnit.id);
    const recipeNode = byId.get(recipeUnit.id);

    expect(inputNode).toBeDefined();
    expect(outputNode).toBeDefined();
    expect(recipeNode).toBeDefined();

    expect(inputNode!.layoutOptions?.[ELK_LAYER_CONSTRAINT_KEY]).toBe(
      ELK_LAYER_FIRST,
    );
    expect(outputNode!.layoutOptions?.[ELK_LAYER_CONSTRAINT_KEY]).toBe(
      ELK_LAYER_LAST,
    );
    // Recipe nodes should NOT carry the pin so ELK can place them mid-graph.
    expect(
      recipeNode!.layoutOptions?.[ELK_LAYER_CONSTRAINT_KEY],
    ).toBeUndefined();
  });

  it("end-to-end layout places input products in the leftmost column and output products in the rightmost column", async () => {
    const { nodes } = await layoutRenderPlan(layoutInput);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const input = byId.get(inputUnit.id);
    const output = byId.get(outputUnit.id);
    const middle = byId.get(recipeUnit.id);

    expect(input).toBeDefined();
    expect(output).toBeDefined();
    expect(middle).toBeDefined();

    const ix = input!.position.x;
    const mx = middle!.position.x;
    const ox = output!.position.x;
    expect(ix).toBeLessThan(mx);
    expect(mx).toBeLessThan(ox);
  });
});
