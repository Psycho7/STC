// The CATALYST_SUPPLY_EDGES=false half of the catalyst row contract: with the
// flag off the row is what it was before catalyst edges existed -- no port, no
// edge, and the catalyst disc standing where a reader's eye expects one. The
// flag module is mocked for the whole file, so this suite is the OFF twin of
// the catalyst rows described in RecipeNode.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Recipe } from "@aef/schema";

vi.mock("../../src/flags", () => ({ CATALYST_SUPPLY_EDGES: false }));

import RecipeNode from "../../src/canvas/RecipeNode";
import type { PortTransportKinds } from "../../src/canvas/layout";
import { LocaleProvider } from "../../src/data/i18n-context";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import {
  makeMachine,
  makePackValue,
  makeRecipeNodeProps,
  type RecipeNodeData,
} from "../../src/canvas/node.testkit";

afterEach(() => {
  cleanup();
});

const catalystRecipe: Recipe = {
  id: "copper_powder",
  name: "Copper Powder",
  category: "smelt",
  icon: "copper_powder",
  row: 0,
  time: 10,
  in: [
    { item: "copper_nugget", qty: 1 },
    { item: "liquid_water", qty: 2 },
  ],
  out: [{ item: "copper_powder", qty: 1 }],
  catalyst: [{ item: "gas_xiranite", qty: 1 }],
  producers: ["smelter"],
};

const portTransportKinds: PortTransportKinds = new Map([
  ["in:copper_nugget", "belt"],
  ["in:liquid_water", "pipe"],
  ["cat:gas_xiranite", "gas"],
  ["out:copper_powder", "belt"],
]);

function renderRecipe(
  data: RecipeNodeData,
  pack: ItemPackContextValue = makePackValue({
    machines: [makeMachine("smelter")],
  }),
) {
  return render(
    <LocaleProvider locale="zh">
      <ItemPackProvider value={pack}>
        <ReactFlowProvider>
          <RecipeNode {...makeRecipeNodeProps(data)} />
        </ReactFlowProvider>
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

describe("catalyst rows with CATALYST_SUPPLY_EDGES off", () => {
  it("hangs no handle on the catalyst row", () => {
    const { container } = renderRecipe({
      recipe: catalystRecipe,
      kind: "recipe",
      multiplier: 1,
      portTransportKinds,
    });
    const row = container.querySelector(".rn-row.catalyst")!;
    expect(row.querySelectorAll("[data-handleid]")).toHaveLength(0);
    expect(container.querySelectorAll('[data-handlepos="left"]')).toHaveLength(
      2,
    );
    expect(container.querySelectorAll("[data-handleid]")).toHaveLength(3);
  });

  it("wears the catalyst disc rather than a transport glyph", () => {
    const { container } = renderRecipe({
      recipe: catalystRecipe,
      kind: "recipe",
      multiplier: 1,
      portTransportKinds,
    });
    const glyph = container.querySelector(".rn-row.catalyst [data-glyph]");
    expect(glyph?.getAttribute("data-glyph")).toBe("catalyst");
  });
});
