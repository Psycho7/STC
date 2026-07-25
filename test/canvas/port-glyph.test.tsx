import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type Node as RFNode,
  type NodeProps,
} from "@xyflow/react";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import RecipeNode from "../../src/canvas/RecipeNode";
import { PortGlyph } from "../../src/canvas/PortGlyph";
import { itemColor } from "../../src/canvas/itemColor";
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

// jsdom serializes an hsl(...) color to its rgb(...) form when it lands on a
// standard property (background / border-color). Push the expected itemColor
// through the same DOM normalization so the assertion compares like for like.
function normalizeColor(css: string): string {
  const el = document.createElement("div");
  el.style.background = css;
  return el.style.background;
}

describe("PortGlyph item color", () => {
  it("colors a belt glyph's fill by itemColor while keeping the square shape", () => {
    const { container } = render(
      <PortGlyph kind="belt" side="left" top={10} item="copper_nugget" />,
    );
    const glyph = container.querySelector<HTMLElement>('[data-glyph="belt"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.style.background).toBe(
      normalizeColor(itemColor("copper_nugget")),
    );
    // Square shape: no border-radius applied.
    expect(glyph!.style.borderRadius).toBe("");
  });

  it("colors a pipe glyph's border by itemColor while keeping the circle shape", () => {
    const { container } = render(
      <PortGlyph kind="pipe" side="right" top={10} item="water" />,
    );
    const glyph = container.querySelector<HTMLElement>('[data-glyph="pipe"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.style.borderColor).toBe(normalizeColor(itemColor("water")));
    // Circle shape preserved.
    expect(glyph!.style.borderRadius).toBe("50%");
    expect(glyph!.style.background).toBe("transparent");
  });

  it("falls back to the neutral belt fill when item is omitted (shape by kind)", () => {
    const { container } = render(
      <PortGlyph kind="belt" side="left" top={10} />,
    );
    const glyph = container.querySelector<HTMLElement>('[data-glyph="belt"]');
    expect(glyph).not.toBeNull();
    // #666 default, normalized by jsdom to rgb form.
    expect(glyph!.style.background).toBe(normalizeColor("#666"));
  });

  it("colors a gas glyph's border by itemColor while keeping the diamond shape", () => {
    const { container } = render(
      <PortGlyph kind="gas" side="right" top={10} item="gas_water" />,
    );
    const glyph = container.querySelector<HTMLElement>('[data-glyph="gas"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.style.borderColor).toBe(
      normalizeColor(itemColor("gas_water")),
    );
    // Diamond: a rotated square, so hollow like the pipe circle but with no
    // border-radius and a 45 degree rotation.
    expect(glyph!.style.borderRadius).toBe("");
    expect(glyph!.style.background).toBe("transparent");
    expect(glyph!.style.transform).toContain("rotate(45deg)");
  });

  it("sizes the gas diamond so its diagonal matches the pipe circle", () => {
    const { container } = render(<PortGlyph kind="gas" side="left" top={10} />);
    const glyph = container.querySelector<HTMLElement>('[data-glyph="gas"]');
    expect(glyph).not.toBeNull();
    // A square rotated 45 degrees presents its diagonal, so a same-sized box
    // would out-mass the 8px circle by a factor of sqrt(2). 6px keeps the
    // presented diagonal at ~8.49px.
    expect(glyph!.style.width).toBe("6px");
    expect(glyph!.style.height).toBe("6px");
    // Centered on the same handle y as its 8px siblings: 10 - 6/2 = 7.
    expect(glyph!.style.top).toBe("7px");
  });

  it("keeps the gas rotation composed with the row-centering transform", () => {
    // The `top`-less mode centers on the DOM row via translateY(-50%). The
    // rotation has to compose with it, not replace it, or the glyph drops half
    // its height off the row.
    const { container } = render(<PortGlyph kind="gas" side="left" />);
    const glyph = container.querySelector<HTMLElement>('[data-glyph="gas"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.style.top).toBe("50%");
    expect(glyph!.style.transform).toContain("translateY(-50%)");
    expect(glyph!.style.transform).toContain("rotate(45deg)");
  });

  it("keeps shape driven by kind even when item is present (pipe stays a circle)", () => {
    const { container } = render(
      <PortGlyph kind="pipe" side="left" top={10} item="copper_nugget" />,
    );
    expect(
      container.querySelector('[data-glyph="pipe"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-glyph="belt"]')).toBeNull();
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

  it("centers every glyph on the node's vertical middle, where the handle sits", () => {
    // The product node's Handles carry no explicit top, so React Flow's default
    // CSS centers them at 50% of the node height. The glyph must use the same
    // anchor: a fixed pixel top drifts off the handle whenever the node height
    // changes (a stale top=16 once parked glyphs near the top corner of the
    // 78px card).
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:copper_ore", "belt"],
      ["out:copper_ore", "belt"],
    ]);
    const { container } = renderProduct({
      kind: "inputProduct",
      itemId: "copper_ore",
      rate: { num: "1", denom: "1" },
      isFanout: true,
      portTransportKinds,
    });
    const glyphs = container.querySelectorAll<HTMLElement>("[data-glyph]");
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.style.top).toBe("50%");
      expect(glyph.style.transform).toContain("translateY(-50%)");
    }
  });
});

describe("port handle chrome", () => {
  // React Flow's stock .react-flow__handle is a white-bordered ring the theme
  // never designed. At a pipe port it lands 2px from the hollow PortGlyph ring
  // and the two 8px circles read as one figure-eight; at a belt port it covers
  // the row's item-tinted accent tab. canvas.css must neutralize its paint.
  it("neutralizes the stock React Flow handle ring", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/canvas/canvas.css"),
      "utf8",
    );
    const block = css.match(
      /\.ak-canvas-theme\s+\.react-flow__handle\s*\{[^}]*\}/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/background-color:\s*transparent/);
    // border-color, not `border: 0`: the 8x8 measured box must survive so the
    // handle's rect (and every edge endpoint measured from it) does not move.
    expect(block![0]).toMatch(/border-color:\s*transparent/);
    expect(block![0]).not.toMatch(/border:\s*(0|none)/);
  });
});
