import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ReactFlowProvider,
  type NodeProps,
  type Node as RFNode,
} from "@xyflow/react";
import type { Item, Machine, Recipe } from "@aef/schema";
import RecipeNode from "../../src/canvas/RecipeNode";
import { itemColor } from "../../src/canvas/itemColor";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";

afterEach(() => {
  cleanup();
});

const recipe: Recipe = {
  id: "copper_powder",
  name: "Copper Powder",
  category: "smelt",
  icon: "copper_powder",
  row: 0,
  time: 1,
  in: [{ item: "copper_nugget", qty: 1 }],
  out: [{ item: "copper_powder", qty: 1 }],
  producers: ["smelter"],
};

// A two-input / one-output recipe for column / multi-row assertions. The
// item ids resolve to zh-CN names via the i18n index (default locale "zh").
const multiRowRecipe: Recipe = {
  id: "copper_powder",
  name: "Copper Powder",
  category: "smelt",
  icon: "copper_powder",
  row: 0,
  time: 1,
  in: [
    { item: "copper_nugget", qty: 1 },
    { item: "copper_ore-liquid_water", qty: 2 },
  ],
  out: [{ item: "copper_powder", qty: 1 }],
  producers: ["smelter"],
};

function makeMachine(id: string, icon?: string): Machine {
  return {
    id,
    name: id,
    icon: icon ?? id,
    speed: 1,
    powerType: "electric",
    powerKw: null,
    hideRate: false,
  };
}

function makeItem(id: string): Item {
  return {
    id,
    name: id,
    category: "intermediate",
    icon: id,
    row: 0,
    raw: false,
    transportKind: "belt",
  };
}

function makePackValue(opts: {
  machines?: Machine[];
  items?: Item[];
}): ItemPackContextValue {
  return {
    itemById: new Map((opts.items ?? []).map((i) => [i.id, i])),
    overrides: [],
    machineById: new Map((opts.machines ?? []).map((m) => [m.id, m])),
  };
}

type RecipeNodeData = {
  recipe: Recipe;
  multiplier?: number;
  expanded?: boolean;
  kind?: "recipe";
  inputOrder?: string[];
  outputOrder?: string[];
};
type RecipeNodeType = RFNode<RecipeNodeData, "recipe">;

function makeProps(data: RecipeNodeData): NodeProps<RecipeNodeType> {
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

function renderRecipe(
  data: RecipeNodeData,
  pack: ItemPackContextValue = makePackValue({
    // Default fixture covers the legacy `producers: ["smelter"]` shape.
    machines: [makeMachine("smelter")],
  }),
) {
  return render(
    <ItemPackProvider value={pack}>
      <ReactFlowProvider>
        <RecipeNode {...makeProps(data)} />
      </ReactFlowProvider>
    </ItemPackProvider>,
  );
}

describe("RecipeNode", () => {
  it("renders a kind: 'recipe' unit with the legacy multiplier badge when multiplier > 1 and not expanded", () => {
    // The count now also appears in the per-machine secondary line, so target
    // the corner badge element rather than a bare text match.
    const { container } = renderRecipe({
      recipe,
      kind: "recipe",
      multiplier: 3,
      expanded: false,
    });
    expect(container.querySelector(".rn-mult-badge")?.textContent).toBe("x3");
  });

  it("renders a kind: 'recipe' unit without a badge when multiplier is 1", () => {
    renderRecipe({
      recipe,
      kind: "recipe",
      multiplier: 1,
      expanded: false,
    });
    expect(screen.queryByText(/^x\d+$/)).toBeNull();
  });

  it("preserves backward-compat on-main shape: { recipe, multiplier, expanded } with no kind", () => {
    // The count now also appears in the per-machine secondary line, so target
    // the corner badge element rather than a bare text match.
    const { container } = renderRecipe({
      recipe,
      multiplier: 4,
      expanded: false,
    });
    expect(container.querySelector(".rn-mult-badge")?.textContent).toBe("x4");
  });

  it("hides legacy badge when expanded is true even if multiplier > 1", () => {
    renderRecipe({ recipe, multiplier: 5, expanded: true });
    expect(screen.queryByText(/^x\d+$/)).toBeNull();
  });

  it("outer wrapper width and minHeight match measureRecipe(recipe)", () => {
    const { container } = renderRecipe({
      recipe,
      kind: "recipe",
      multiplier: 1,
    });
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    const geom = measureRecipe(recipe);
    expect(wrapper?.style.width).toBe(`${geom.width}px`);
    expect(wrapper?.style.minHeight).toBe(`${geom.height}px`);
  });

  it("renders input rows inside .rn-body > .rn-side.in and output rows inside .rn-side.out", () => {
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    const body = container.querySelector(".rn-body");
    expect(body).not.toBeNull();
    const inSide = body!.querySelector(":scope > .rn-side.in");
    const outSide = body!.querySelector(":scope > .rn-side.out");
    expect(inSide).not.toBeNull();
    expect(outSide).not.toBeNull();
    const inputRows = inSide!.querySelectorAll(".rn-row.input");
    const outputRows = outSide!.querySelectorAll(".rn-row.output");
    expect(inputRows.length).toBe(2);
    expect(outputRows.length).toBe(1);
    // Each row has ico / lbl / rate children.
    for (const row of inputRows) {
      expect(row.querySelector(".ico")).not.toBeNull();
      expect(row.querySelector(".lbl")).not.toBeNull();
      expect(row.querySelector(".rate")).not.toBeNull();
    }
    for (const row of outputRows) {
      expect(row.querySelector(".ico")).not.toBeNull();
      expect(row.querySelector(".lbl")).not.toBeNull();
      expect(row.querySelector(".rate")).not.toBeNull();
    }
  });

  it("fallback path (no inputOrder): per-row handles keep declaration order at measureRecipe(recipe).in/outHandleYs[i]", () => {
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    const inputHandles = container.querySelectorAll<HTMLElement>(
      'div[data-handlepos="left"]',
    );
    const outputHandles = container.querySelectorAll<HTMLElement>(
      'div[data-handlepos="right"]',
    );
    expect(inputHandles.length).toBe(2);
    expect(outputHandles.length).toBe(1);

    const geom = measureRecipe(multiRowRecipe);
    const expectedInIds = ["in:copper_nugget", "in:copper_ore-liquid_water"];
    inputHandles.forEach((handle, i) => {
      expect(handle.getAttribute("data-handleid")).toBe(expectedInIds[i]);
      expect(handle.style.top).toBe(`${geom.inHandleYs[i]}px`);
    });
    expect(outputHandles[0]!.getAttribute("data-handleid")).toBe(
      "out:copper_powder",
    );
    expect(outputHandles[0]!.style.top).toBe(`${geom.outHandleYs[0]}px`);
  });

  it("reordered path (inputOrder present): handles and rows follow the resolved order, rates track each item", () => {
    // The resolved order reverses the declaration order [copper_nugget,
    // copper_ore-liquid_water]. The handle at slot i and the row at slot i must
    // both describe the item at inputOrder[i], and each row keeps its own qty
    // (copper_nugget qty=1 -> 60/min, copper_ore-liquid_water qty=2 -> 120/min).
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
      inputOrder: ["copper_ore-liquid_water", "copper_nugget"],
    });
    const inputHandles = container.querySelectorAll<HTMLElement>(
      'div[data-handlepos="left"]',
    );
    expect(inputHandles.length).toBe(2);
    const geom = measureRecipe(multiRowRecipe);
    const expectedInIds = ["in:copper_ore-liquid_water", "in:copper_nugget"];
    inputHandles.forEach((handle, i) => {
      expect(handle.getAttribute("data-handleid")).toBe(expectedInIds[i]);
      expect(handle.style.top).toBe(`${geom.inHandleYs[i]}px`);
    });
    // Rows in the same reversed order, each paired with its own rate.
    const inputLbls = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .lbl"),
    ).map((el) => el.textContent);
    const inputRates = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .rate"),
    ).map((el) => el.textContent);
    expect(inputLbls).toEqual(["赤铜矿", "赤铜块"]);
    expect(inputRates).toEqual(["120", "60"]);
  });

  it("each row's .lbl shows the zh-CN item name and .rate shows the per-min formatted value", () => {
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    // qty=1, time=1, multiplier=1 -> 60/min; qty=2, time=1 -> 120/min.
    const inputLbls = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .lbl"),
    ).map((el) => el.textContent);
    const outputLbls = Array.from(
      container.querySelectorAll(".rn-side.out .rn-row.output .lbl"),
    ).map((el) => el.textContent);
    expect(inputLbls).toEqual(["赤铜块", "赤铜矿"]);
    expect(outputLbls).toEqual(["赤铜粉末"]);

    const inputRates = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .rate"),
    ).map((el) => el.textContent);
    const outputRates = Array.from(
      container.querySelectorAll(".rn-side.out .rn-row.output .rate"),
    ).map((el) => el.textContent);
    expect(inputRates).toEqual(["60", "120"]);
    expect(outputRates).toEqual(["60"]);
  });

  it("tints each row's --row-accent custom property to the item color", () => {
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    // Rows render in declaration order here (no inputOrder). Each row's inline
    // --row-accent must equal itemColor(item) so canvas.css can tint the accent
    // tab; the custom property is stored verbatim, so a direct string compare
    // holds.
    const inputAccents = Array.from(
      container.querySelectorAll<HTMLElement>(".rn-side.in .rn-row.input"),
    ).map((r) => r.style.getPropertyValue("--row-accent"));
    expect(inputAccents).toEqual([
      itemColor("copper_nugget"),
      itemColor("copper_ore-liquid_water"),
    ]);
    const outputAccents = Array.from(
      container.querySelectorAll<HTMLElement>(".rn-side.out .rn-row.output"),
    ).map((r) => r.style.getPropertyValue("--row-accent"));
    expect(outputAccents).toEqual([itemColor("copper_powder")]);
  });

  describe("footer", () => {
    it("renders cycle-time text inside .rn-footer .cycle with an empty .pwr placeholder", () => {
      const footerRecipe: Recipe = {
        id: "copper_powder",
        name: "Copper Powder",
        category: "smelt",
        icon: "copper_powder",
        row: 0,
        time: 2.4,
        in: [{ item: "copper_nugget", qty: 1 }],
        out: [{ item: "copper_powder", qty: 1 }],
        producers: ["smelter"],
      };
      const { container } = renderRecipe({
        recipe: footerRecipe,
        kind: "recipe",
        multiplier: 1,
      });
      const footer = container.querySelector(".rn-footer");
      expect(footer).not.toBeNull();
      const cycle = footer!.querySelector(".cycle");
      expect(cycle).not.toBeNull();
      expect(cycle!.textContent).toBe("2.4s · cycle");
      const pwr = footer!.querySelector(".pwr");
      expect(pwr).not.toBeNull();
      expect(pwr!.textContent).toBe("");
    });
  });

  describe("header three-line structure", () => {
    // Synthetic recipe whose producer id encodes a tier suffix.
    const tieredRecipe: Recipe = {
      id: "iron-plate",
      name: "Iron Plate",
      category: "assemble",
      icon: "iron-plate",
      row: 0,
      time: 2,
      in: [{ item: "iron-ore", qty: 1 }],
      out: [{ item: "iron-plate", qty: 1 }],
      producers: ["assembler-t1"],
    };
    // Same shape, no tier suffix on producer id.
    const untieredRecipe: Recipe = {
      id: "iron-plate",
      name: "Iron Plate",
      category: "assemble",
      icon: "iron-plate",
      row: 0,
      time: 2,
      in: [{ item: "iron-ore", qty: 1 }],
      out: [{ item: "iron-plate", qty: 1 }],
      producers: ["mixer"],
    };

    it("renders machine-icon data attribute, .product, .cn, and .tier for a tiered producer", () => {
      const machine = makeMachine("assembler-t1", "asm-icon");
      const { container } = renderRecipe(
        { recipe: tieredRecipe, kind: "recipe", multiplier: 1 },
        makePackValue({
          machines: [machine],
          items: [makeItem("iron-plate"), makeItem("iron-ore")],
        }),
      );
      const head = container.querySelector(".rn-head");
      expect(head).not.toBeNull();
      const icon = head!.querySelector(".machine-icon");
      expect(icon).not.toBeNull();
      expect(icon!.getAttribute("data-machine-icon")).toBe("asm-icon");
      // .product = output[0] zh-CN name (fallback to id when missing entry).
      expect(head!.querySelector(".product")?.textContent).toBe("iron-plate");
      const nameRow = head!.querySelector(".machine-name");
      expect(nameRow).not.toBeNull();
      expect(nameRow!.querySelector(".cn")?.textContent).toBe("assembler-t1");
      expect(nameRow!.querySelector(".tier")?.textContent).toBe("T1");
      // The raw machine id line is dropped in favor of the localized name.
      expect(head!.querySelector(".machine-mid")).toBeNull();
    });

    it("omits the .tier chip when machine id has no -t\\d+ suffix", () => {
      const machine = makeMachine("mixer");
      const { container } = renderRecipe(
        { recipe: untieredRecipe, kind: "recipe", multiplier: 1 },
        makePackValue({
          machines: [machine],
          items: [makeItem("iron-plate"), makeItem("iron-ore")],
        }),
      );
      const head = container.querySelector(".rn-head");
      expect(head!.querySelector(".machine-name .tier")).toBeNull();
      // .cn still rendered; the raw machine id line is gone.
      expect(head!.querySelector(".machine-name .cn")?.textContent).toBe(
        "mixer",
      );
      expect(head!.querySelector(".machine-mid")).toBeNull();
    });

    it("falls back to producers[0] for machine-icon data attribute when machine icon is absent and skips name/mid lines", () => {
      // Provide a machine with empty icon to confirm fallback to id, then a
      // separate scenario where machineById has no entry at all.
      const headlessRecipe: Recipe = {
        ...tieredRecipe,
        producers: ["ghost-machine"],
      };
      const { container } = renderRecipe(
        { recipe: headlessRecipe, kind: "recipe", multiplier: 1 },
        makePackValue({
          // No machine entry for "ghost-machine".
          machines: [],
          items: [makeItem("iron-plate"), makeItem("iron-ore")],
        }),
      );
      const head = container.querySelector(".rn-head");
      const icon = head!.querySelector(".machine-icon");
      expect(icon!.getAttribute("data-machine-icon")).toBe("ghost-machine");
      // Graceful degrade: .machine-name and .machine-mid omitted.
      expect(head!.querySelector(".machine-name")).toBeNull();
      expect(head!.querySelector(".machine-mid")).toBeNull();
      // .product still rendered.
      expect(head!.querySelector(".product")?.textContent).toBe("iron-plate");
    });
  });
});
