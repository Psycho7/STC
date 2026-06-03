import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type Node as RFNode,
  type NodeProps,
} from "@xyflow/react";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import RecipeNode from "../../src/canvas/RecipeNode";
import LoopNode, {
  type LoopNodeData,
  type LoopNodeType,
} from "../../src/canvas/LoopNode";
import ProductNode, {
  type ProductNodeData,
} from "../../src/canvas/ProductNode";
import { LocaleProvider } from "../../src/data/i18n-context";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import type { PortTransportKinds } from "../../src/canvas/layout";

const EMPTY_PACK_VALUE: ItemPackContextValue = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map(),
};

afterEach(() => cleanup());

// --- RecipeNode harness -----------------------------------------------------

type RecipeNodeData = {
  recipe: Recipe;
  multiplier?: number;
  expanded?: boolean;
  kind?: "recipe";
  portTransportKinds?: PortTransportKinds;
};
type RecipeNodeType = RFNode<RecipeNodeData, "recipe">;

function makeRecipeProps(data: RecipeNodeData): NodeProps<RecipeNodeType> {
  return {
    id: "recipe-test",
    type: "recipe",
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
  } as unknown as NodeProps<RecipeNodeType>;
}

function renderRecipe(data: RecipeNodeData) {
  return render(
    <LocaleProvider>
      <ItemPackProvider value={EMPTY_PACK_VALUE}>
        <ReactFlowProvider>
          <RecipeNode {...makeRecipeProps(data)} />
        </ReactFlowProvider>
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

// --- LoopNode harness -------------------------------------------------------

function makeLoopProps(data: LoopNodeData): NodeProps<LoopNodeType> {
  return {
    id: "loop-test",
    type: "loop",
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
  } as unknown as NodeProps<LoopNodeType>;
}

function renderLoop(data: LoopNodeData) {
  return render(
    <LocaleProvider>
      <ReactFlowProvider>
        <LoopNode {...makeLoopProps(data)} />
      </ReactFlowProvider>
    </LocaleProvider>,
  );
}

// --- ProductNode harness ----------------------------------------------------

type ProductNodeType = RFNode<ProductNodeData, "product">;

function makeProductProps(data: ProductNodeData): NodeProps<ProductNodeType> {
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

function renderProduct(data: ProductNodeData) {
  return render(
    <LocaleProvider>
      <ItemPackProvider value={EMPTY_PACK_VALUE}>
        <ReactFlowProvider>
          <ProductNode {...makeProductProps(data)} />
        </ReactFlowProvider>
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

const baseRecipe: Recipe = {
  id: "mix",
  name: "Mix",
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: [
    { item: "copper_nugget", qty: 1 }, // belt
    { item: "water", qty: 1 }, // pipe
  ],
  out: [{ item: "alloy", qty: 1 }], // belt
  producers: [],
};

describe("RecipeNode port glyphs", () => {
  it("renders distinct glyph variants for belt and pipe ports", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:copper_nugget", "belt"],
      ["in:water", "pipe"],
      ["out:alloy", "belt"],
    ]);
    const { container } = renderRecipe({
      recipe: baseRecipe,
      kind: "recipe",
      portTransportKinds,
    });
    expect(container.querySelectorAll('[data-glyph="belt"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-glyph="pipe"]')).toHaveLength(1);
  });

  it("falls back to no glyph when transportKind is unknown without throwing", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:copper_nugget", "phantom"], // unknown - no glyph
      ["in:water", "pipe"], // recognised
      // out:alloy intentionally absent - no glyph
    ]);
    const { container } = renderRecipe({
      recipe: baseRecipe,
      kind: "recipe",
      portTransportKinds,
    });
    expect(container.querySelectorAll("[data-glyph]")).toHaveLength(1);
    expect(container.querySelector('[data-glyph="pipe"]')).not.toBeNull();
  });

  it("renders no glyphs when portTransportKinds is omitted", () => {
    const { container } = renderRecipe({ recipe: baseRecipe, kind: "recipe" });
    expect(container.querySelectorAll("[data-glyph]")).toHaveLength(0);
  });
});

describe("LoopNode port glyphs", () => {
  it("renders distinct glyph variants for belt and pipe net-IO ports", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:water", "pipe"],
      ["out:steam_oil", "belt"],
    ]);
    const data: LoopNodeData = {
      sccId: "scc:test",
      netIO: [
        { item: "water", direction: "in", rate: new Fraction(1) },
        { item: "steam_oil", direction: "out", rate: new Fraction(1) },
      ],
      interior: { width: 200, height: 150 },
      portTransportKinds,
    };
    const { container } = renderLoop(data);
    expect(container.querySelectorAll('[data-glyph="belt"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-glyph="pipe"]')).toHaveLength(1);
  });

  it("renders no glyphs when portTransportKinds is omitted", () => {
    const data: LoopNodeData = {
      sccId: "scc:test",
      netIO: [{ item: "water", direction: "in", rate: new Fraction(1) }],
      interior: { width: 200, height: 150 },
    };
    const { container } = renderLoop(data);
    expect(container.querySelectorAll("[data-glyph]")).toHaveLength(0);
  });
});

describe("ProductNode port glyphs", () => {
  it("renders a belt glyph for an input product whose item is belt-borne", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["out:copper_ore", "belt"],
    ]);
    const { container } = renderProduct({
      kind: "inputProduct",
      itemId: "copper_ore",
      rate: { num: "1", denom: "1" },
      portTransportKinds,
    });
    expect(container.querySelectorAll('[data-glyph="belt"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-glyph="pipe"]')).toHaveLength(0);
  });

  it("renders a pipe glyph for an output product whose item is pipe-borne", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:water", "pipe"],
    ]);
    const { container } = renderProduct({
      kind: "outputProduct",
      itemId: "water",
      rate: { num: "1", denom: "1" },
      flavor: "target",
      portTransportKinds,
    });
    expect(container.querySelectorAll('[data-glyph="pipe"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-glyph="belt"]')).toHaveLength(0);
  });

  it("renders no glyph when transportKind is unknown (no throw)", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["out:phantom", "phantom"],
    ]);
    const { container } = renderProduct({
      kind: "inputProduct",
      itemId: "phantom",
      rate: { num: "0", denom: "1" },
      portTransportKinds,
    });
    expect(container.querySelectorAll("[data-glyph]")).toHaveLength(0);
  });
});
