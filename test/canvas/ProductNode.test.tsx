import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ReactFlowProvider,
  type NodeProps,
  type Node as RFNode,
} from "@xyflow/react";
import type { Item } from "@aef/schema";
import ProductNode, {
  type ProductNodeData,
} from "../../src/canvas/ProductNode";
import { LocaleProvider } from "../../src/data/i18n-context";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";

afterEach(() => cleanup());

type ProductNodeType = RFNode<ProductNodeData, "product">;

function makeProps(data: ProductNodeData): NodeProps<ProductNodeType> {
  return {
    id: "product-test",
    type: "product",
    data,
    selected: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
    dragging: false,
    draggable: true,
    deletable: true,
    selectable: true,
  } as unknown as NodeProps<ProductNodeType>;
}

function makeItem(id: string, raw: boolean): Item {
  return {
    id,
    name: id,
    category: "intermediate",
    icon: id,
    row: 0,
    raw,
    transportKind: "belt",
  };
}

function makePackValue(items: Item[]): ItemPackContextValue {
  return {
    itemById: new Map(items.map((i) => [i.id, i])),
    overrides: [],
    machineById: new Map(),
  };
}

function renderProduct(data: ProductNodeData, items: Item[] = []) {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={makePackValue(items)}>
        <ReactFlowProvider>
          <ProductNode {...makeProps(data)} />
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
    expect(kind?.textContent).toBe("In · raw");
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
    expect(kind?.textContent).toBe("Out · target · 120/min");
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
