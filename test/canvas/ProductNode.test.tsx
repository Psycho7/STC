import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Item } from "@aef/schema";
import ProductNode from "../../src/canvas/ProductNode";
import { LocaleProvider } from "../../src/data/i18n-context";
import { ItemPackProvider } from "../../src/canvas/itemPackContext";
import { cssBlock } from "./cssContract";
import {
  makeItem,
  makePackValue,
  makeProductNodeProps,
  type ProductNodeData,
} from "../../src/canvas/node.testkit";

afterEach(() => cleanup());

function renderProduct(data: ProductNodeData, items: Item[] = []) {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={makePackValue({ items })}>
        <ReactFlowProvider>
          <ProductNode {...makeProductNodeProps(data)} />
        </ReactFlowProvider>
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

describe("ProductNode", () => {
  it("renders input flavor with locale-aware display name, rate badge, and a source handle", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "1", denom: "2" },
        rateCap: { num: "1", denom: "2" },
      },
      [makeItem("copper_ore", true)],
    );
    // i18n.displayName under the pinned en locale maps copper_ore -> Cuprium Ore.
    expect(screen.queryByText("copper_ore")).toBeNull();
    expect(screen.getByText("Cuprium Ore")).toBeInTheDocument();
    // Rate badge. (1/2) /s * 60 = 30/min
    expect(screen.getByText("30")).toBeInTheDocument();
    // Flavor marker.
    const node = container.querySelector("[data-testid='product-node']");
    expect(node?.getAttribute("data-flavor")).toBe("inputProduct");
    expect(node?.getAttribute("data-item-id")).toBe("copper_ore");
  });

  it("applies the input chrome class for inputProduct without flavor", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "1", denom: "2" },
        rateCap: { num: "1", denom: "2" },
      },
      [makeItem("copper_ore", true)],
    );
    const node = container.querySelector("[data-testid='product-node']");
    expect(node?.className).toContain("product-node");
    expect(node?.className).toContain("input");
    expect(node?.className).not.toContain("output");
  });

  it("applies the output/target chrome class for target outputs", () => {
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "target",
      },
      [makeItem("copper_nugget", false)],
    );
    const node = container.querySelector("[data-testid='product-node']");
    expect(node?.className).toContain("product-node");
    expect(node?.className).toContain("output");
    expect(node?.className).toContain("target");
  });

  it("applies the output/surplus chrome class for surplus outputs", () => {
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "1", denom: "1" },
        flavor: "surplus",
      },
      [makeItem("copper_nugget", false)],
    );
    const node = container.querySelector("[data-testid='product-node']");
    expect(node?.className).toContain("product-node");
    expect(node?.className).toContain("output");
    expect(node?.className).toContain("surplus");
  });

  it("renders the pn-kind caption for an uncapped raw input via buildPnKind (no rate slot)", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "2", denom: "1" },
      },
      [makeItem("copper_ore", true)],
    );
    const kind = container.querySelector(".pn-kind");
    expect(kind?.textContent).toBe("In ·\u00A0raw");
  });

  it("renders the pn-kind caption for a target output via buildPnKind", () => {
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "target",
      },
      [makeItem("copper_nugget", false)],
    );
    const kind = container.querySelector(".pn-kind");
    expect(kind?.textContent).toBe("Out ·\u00A0target ·\u00A0120/min");
  });

  it("glues the interpunct to the following token in the composed caption", () => {
    // A wrapped meta line must never strand the middle dot at line end
    // (exam Z4a): the NBSP after the dot moves the break to before it. The
    // glue between the caption words and the rate segment is composed here in
    // the component, so the composed caption is what carries the assertion.
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "target",
      },
      [makeItem("copper_nugget", false)],
    );
    const caption = container.querySelector(".pn-kind")?.textContent ?? "";
    expect(caption).toContain(" ·\u00A0");
    expect(caption).not.toContain("· ");
  });

  it("keeps the caption's rate segment out of the uppercase run", () => {
    // The caption's label words run uppercase; the rate segment's localized
    // unit must not ride the transform (unit-casing-mix family). Inject the
    // real .pn-kind rules from canvas.css into jsdom and read the computed
    // cascade, mirroring the zoom-low probe in src/canvas/RecipeNode.test.tsx.
    const kindRule = cssBlock(".pn-kind");
    const rateRule = cssBlock(".pn-kind__rate");
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style id="pn-kind-casing-probe">${kindRule}${rateRule}</style>`,
    );
    try {
      const { container } = renderProduct(
        {
          kind: "outputProduct",
          itemId: "copper_nugget",
          rate: { num: "2", denom: "1" },
          flavor: "target",
        },
        [makeItem("copper_nugget", false)],
      );
      const caption = container.querySelector<HTMLElement>(".pn-kind");
      expect(caption).not.toBeNull();
      const rateSpan = caption!.querySelector<HTMLElement>(".pn-kind__rate");
      expect(rateSpan).not.toBeNull();
      expect(rateSpan!.textContent).toContain("120/min");
      expect(getComputedStyle(caption!).textTransform).toBe("uppercase");
      expect(getComputedStyle(rateSpan!).textTransform).toBe("none");
    } finally {
      document.getElementById("pn-kind-casing-probe")?.remove();
    }
  });

  it("renders the realized rate primary row (no uncapped literal, no cap chip) when rateCap is absent", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "2", denom: "1" },
      },
      [makeItem("copper_ore", true)],
    );
    const rate = container.querySelector(".pn-rate");
    expect(rate).not.toBeNull();
    // 2/s * 60 = 120/min; rendered as primary content with /min unit.
    expect(rate?.textContent).toBe("120/min");
    expect(rate?.querySelector(".unit")?.textContent).toBe("/min");
    // No cap chip when rateCap is absent.
    expect(rate?.querySelector(".pn-rate__cap")).toBeNull();
    // Guard against the deleted "uncapped" branch.
    expect(rate?.classList.contains("uncapped")).toBe(false);
    expect(container.textContent ?? "").not.toContain("uncapped");
  });

  it("renders the rate primary row plus the cap chip when rateCap is set", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "4", denom: "1" },
        rateCap: { num: "4", denom: "1" },
      },
      [makeItem("copper_ore", true)],
    );
    const rate = container.querySelector(".pn-rate");
    expect(rate?.classList.contains("uncapped")).toBe(false);
    // Primary rate text: 4/s * 60 = 240/min.
    expect(rate?.textContent).toContain("240/min");
    expect(rate?.querySelector(".unit")?.textContent).toBe("/min");
    // Secondary cap chip carries the per-min cap value.
    const cap = rate?.querySelector(".pn-rate__cap");
    expect(cap).not.toBeNull();
    expect(cap?.textContent).toContain("240");
  });

  it("renders a fanout slice with tap chrome and the parent share", () => {
    // rate 1/2 per sec = 30/min; parentRate 9/2 per sec = 270/min.
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "1", denom: "2" },
        isFanout: true,
        parentRate: { num: "9", denom: "2" },
      },
      [makeItem("copper_ore", true)],
    );
    const node = container.querySelector(".product-node");
    expect(node?.classList.contains("tap")).toBe(true);
    expect(container.querySelector(".pn-kind")?.textContent).toBe(
      "In ·\u00A0tap",
    );
    expect(container.querySelector(".pn-rate__of")?.textContent).toBe(
      "of 270/min",
    );
  });

  it("a non-fanout input keeps the raw chrome with no share chip", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "9", denom: "2" },
      },
      [makeItem("copper_ore", true)],
    );
    expect(
      container.querySelector(".product-node")?.classList.contains("tap"),
    ).toBe(false);
    expect(container.querySelector(".pn-kind")?.textContent).toBe(
      "In ·\u00A0raw",
    );
    expect(container.querySelector(".pn-rate__of")).toBeNull();
  });

  it("renders output flavor (target) with rate badge", () => {
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "target",
      },
      [makeItem("copper_nugget", false)],
    );
    expect(screen.getByText("Cuprium")).toBeInTheDocument();
    // 2/s * 60 = 120/min, value "120" + ".unit" span "/min"
    const rate = container.querySelector(".pn-rate");
    expect(rate?.textContent).toBe("120/min");
    const node = container.querySelector("[data-testid='product-node']");
    expect(node?.getAttribute("data-flavor")).toBe("outputProduct");
  });

  it("falls back to the raw id when i18n has no translation for the item", () => {
    renderProduct(
      {
        kind: "inputProduct",
        itemId: "no-such-item",
        rate: { num: "0", denom: "1" },
      },
      [makeItem("no-such-item", true)],
    );
    expect(screen.getByText("no-such-item")).toBeInTheDocument();
  });
});
