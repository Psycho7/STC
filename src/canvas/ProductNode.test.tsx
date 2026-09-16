// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, render } from "@testing-library/react";
import ProductNode from "./ProductNode";
import { ItemPackProvider } from "./itemPackContext";
import { makeItem, makePackValue, makeProductNodeProps } from "./node.testkit";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

const PACK = makePackValue({ items: [makeItem("ore", true)] });

function wrap(ui: ReactNode, locale: "en" | "zh" = "en") {
  return render(
    <ReactFlowProvider>
      <LocaleProvider locale={locale}>
        <ItemPackProvider value={PACK}>{ui}</ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
}

function inputProps(selected = false) {
  return makeProductNodeProps(
    {
      kind: "inputProduct",
      itemId: "ore",
      rate: { num: "1", denom: "1" },
    },
    selected,
  );
}

function outputProps() {
  return makeProductNodeProps({
    kind: "outputProduct",
    itemId: "ore",
    rate: { num: "2", denom: "1" },
    flavor: "target",
  });
}

function fanoutInputProps() {
  return makeProductNodeProps({
    kind: "inputProduct",
    itemId: "ore",
    rate: { num: "1", denom: "2" },
    rateCap: { num: "1", denom: "1" },
    isFanout: true,
    parentRate: { num: "9", denom: "2" },
  });
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

// UX-20: the "In / raw" words are a node internal that must localize. The card
// no longer draws them (ruling I5/I10), so they are read off the spoken label,
// which comes from the same i18n table.
test("the spoken label localizes the direction and classification in zh", () => {
  const { container } = wrap(<ProductNode {...inputProps()} />, "zh");
  const label =
    container.querySelector(".product-node")?.getAttribute("aria-label") ?? "";
  expect(label).toContain("输入");
  expect(label).toContain("原料");
  expect(label).not.toMatch(/In|raw/);
});

// The rate unit on the boundary card is canvas chrome, so it must come from the
// i18n table rather than a hardcoded English suffix.
test("pn-rate unit is localized in zh", () => {
  const { container } = wrap(<ProductNode {...inputProps()} />, "zh");
  const rate = container.querySelector(".pn-rate");
  expect(rate).not.toBeNull();
  expect(rate!.textContent).toContain("/分");
  expect(rate!.textContent).not.toMatch(/min/i);
});

// Surface-level gate: a fanout input lights up every fine-print line at once
// (rate, tap share), so scanning the whole card catches any rate unit that
// skipped the i18n table. The catalyst card joins it because it now draws a word
// of its own (ruling R3): under zh that word must be the localized 催化, never
// the Latin CATALYST. The output card covers the target/surplus arm.
test("zh product cards render no Latin min anywhere", () => {
  const { container } = wrap(<ProductNode {...fanoutInputProps()} />, "zh");
  expect(container.textContent).not.toMatch(/min/i);
  cleanup();
  const catalyst = wrap(
    <ProductNode
      {...makeProductNodeProps({
        kind: "inputProduct",
        itemId: "ore",
        rate: { num: "1", denom: "1" },
        role: "catalyst",
      })}
    />,
    "zh",
  );
  expect(catalyst.container.textContent).not.toMatch(/min/i);
  expect(catalyst.container.textContent).not.toMatch(/catalyst/i);
  cleanup();
  const out = wrap(<ProductNode {...outputProps()} />, "zh");
  expect(out.container.textContent).not.toMatch(/min/i);
});
