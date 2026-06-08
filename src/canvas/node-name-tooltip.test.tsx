// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, render } from "@testing-library/react";
import type { Recipe } from "@aef/schema";
import RecipeNode from "./RecipeNode";
import ProductNode from "./ProductNode";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

const PACK = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map([["mk1", { id: "mk1", icon: "mk1" }]]),
} as unknown as ItemPackContextValue;

function wrap(ui: ReactNode) {
  return render(
    <ReactFlowProvider>
      <LocaleProvider locale="en">
        <ItemPackProvider value={PACK}>{ui}</ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
}

const RECIPE = {
  id: "widget_recipe",
  category: "assemble",
  time: 2,
  producers: ["mk1"],
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "widget", qty: 1 }],
} as unknown as Recipe;

// A truncated name in a node is unreadable without a hover tooltip, so each
// name-bearing span carries a title equal to its full text.
test("RecipeNode header and row labels expose the full name via title", () => {
  const props = { data: { recipe: RECIPE } } as unknown as ComponentProps<
    typeof RecipeNode
  >;
  const { container } = wrap(<RecipeNode {...props} />);

  const product = container.querySelector(".product");
  expect(product?.textContent).toBeTruthy();
  expect(product?.getAttribute("title")).toBe(product?.textContent);

  const labels = container.querySelectorAll(".rn-row .lbl");
  expect(labels.length).toBeGreaterThan(0);
  for (const lbl of labels) {
    expect(lbl.getAttribute("title")).toBe(lbl.textContent);
  }
});

test("ProductNode name exposes the full name via title", () => {
  const props = {
    data: {
      kind: "outputProduct",
      itemId: "widget",
      rate: { num: "1", denom: "1" },
      flavor: "target",
    },
  } as unknown as ComponentProps<typeof ProductNode>;
  const { container } = wrap(<ProductNode {...props} />);

  const name = container.querySelector(".pn-name");
  expect(name?.textContent).toBeTruthy();
  expect(name?.getAttribute("title")).toBe(name?.textContent);
});
