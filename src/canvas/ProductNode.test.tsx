// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, render } from "@testing-library/react";
import ProductNode from "./ProductNode";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

const PACK = {
  itemById: new Map([["ore", { id: "ore", icon: "ore", raw: true }]]),
  overrides: [],
  machineById: new Map(),
} as unknown as ItemPackContextValue;

function wrap(ui: ReactNode, locale: "en" | "zh" = "en") {
  return render(
    <ReactFlowProvider>
      <LocaleProvider locale={locale}>
        <ItemPackProvider value={PACK}>{ui}</ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
}

function inputProps(selected?: boolean) {
  return {
    data: {
      kind: "inputProduct",
      itemId: "ore",
      rate: { num: "1", denom: "1" },
    },
    selected,
  } as unknown as ComponentProps<typeof ProductNode>;
}

// React Flow passes the wrapper's `selected` flag as a NodeProp; the inner
// .product-node must forward it so the card gets a visible selection treatment.
test("selected prop forwards the selected class onto the card", () => {
  const { container } = wrap(<ProductNode {...inputProps(true)} />);
  expect(container.querySelector(".product-node")?.className).toContain(
    "selected",
  );
});

test("an unselected product node carries no selected class", () => {
  const { container } = wrap(<ProductNode {...inputProps()} />);
  expect(container.querySelector(".product-node")?.className).not.toContain(
    "selected",
  );
});

// UX-20: the "In / raw" caption is a node internal that must localize. In zh
// the direction and classification words come from the i18n table.
test("input caption localizes the direction and classification in zh", () => {
  const { container } = wrap(<ProductNode {...inputProps()} />, "zh");
  const kind = container.querySelector(".pn-kind")?.textContent ?? "";
  expect(kind).toContain("输入");
  expect(kind).toContain("原料");
  expect(kind).not.toMatch(/In|raw/);
});
