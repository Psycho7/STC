import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { PortTransportKinds } from "../../src/canvas/layout";
import type { Recipe } from "@aef/schema";
import RecipeNode from "../../src/canvas/RecipeNode";
import { LocaleProvider } from "../../src/data/i18n-context";
import { itemColor } from "../../src/canvas/itemColor";
import { iconPosition } from "../../src/canvas/iconSprite";
import { pack } from "../../src/data/load";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import {
  makeItem,
  makeMachine,
  makePackValue,
  makeRecipeNodeProps,
  type RecipeNodeData,
} from "../../src/canvas/node.testkit";

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
    { item: "liquid_water", qty: 2 },
  ],
  out: [{ item: "copper_powder", qty: 1 }],
  producers: ["smelter"],
};

// Upstream does not guarantee that a pack item's icon id equals its item id:
// the 1.5.3 snapshot renamed the bottled-plant-grass icons to opaque hashes.
// A recipe built from those items exercises the row sprite lookup.
const HASHED_IN_ITEM = "iron_bottle-liquid_plant_grass_1";
const HASHED_OUT_ITEM = "copper_bottle-liquid_plant_grass_1";

const hashedIconRecipe: Recipe = {
  id: "hashed_icon",
  name: "Hashed Icon",
  category: "craft",
  icon: "copper_powder",
  row: 0,
  time: 1,
  in: [{ item: HASHED_IN_ITEM, qty: 1 }],
  out: [{ item: HASHED_OUT_ITEM, qty: 1 }],
  producers: ["smelter"],
};

function renderRecipe(
  data: RecipeNodeData,
  pack: ItemPackContextValue = makePackValue({
    // Default fixture covers the legacy `producers: ["smelter"]` shape.
    machines: [makeMachine("smelter")],
  }),
) {
  // Several assertions read zh names and units, so pin the locale instead of
  // leaning on whatever the no-provider fallback happens to be.
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

describe("RecipeNode", () => {
  it("renders a kind: 'recipe' unit with the header multiplier chip when multiplier > 1 and not expanded", () => {
    // The multiplier is promoted to one reserved .rn-head grid cell; target that
    // chip rather than a bare text match.
    const { container } = renderRecipe({
      recipe,
      kind: "recipe",
      multiplier: 3,
      expanded: false,
    });
    expect(container.querySelector(".rn-mult-chip")?.textContent).toBe("x3");
    expect(container.querySelector(".rn-mult-badge")).toBeNull();
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
    // The multiplier is promoted to one reserved .rn-head grid cell; target that
    // chip rather than a bare text match.
    const { container } = renderRecipe({
      recipe,
      multiplier: 4,
      expanded: false,
    });
    expect(container.querySelector(".rn-mult-chip")?.textContent).toBe("x4");
    expect(container.querySelector(".rn-mult-badge")).toBeNull();
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

  it("draws row sprites for items whose icon id is not their item id", () => {
    const iconOf = (id: string) => pack.items.find((i) => i.id === id)?.icon;
    const inIcon = iconOf(HASHED_IN_ITEM);
    const outIcon = iconOf(HASHED_OUT_ITEM);
    // Premise guard: the fixture only exercises the lookup while the shipped
    // pack still keeps these icon ids apart from their item ids.
    expect(inIcon).toBeDefined();
    expect(inIcon).not.toBe(HASHED_IN_ITEM);
    expect(outIcon).not.toBe(HASHED_OUT_ITEM);
    expect(iconPosition(HASHED_IN_ITEM)).toBeUndefined();

    const { container } = renderRecipe({
      recipe: hashedIconRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    const inSpr = container.querySelector<HTMLElement>(
      ".rn-side.in .rn-row.input .ico .spr",
    );
    const outSpr = container.querySelector<HTMLElement>(
      ".rn-side.out .rn-row.output .ico .spr",
    );
    expect(inSpr).not.toBeNull();
    expect(outSpr).not.toBeNull();
    expect(inSpr!.style.backgroundPosition).toBe(iconPosition(inIcon));
    expect(outSpr!.style.backgroundPosition).toBe(iconPosition(outIcon));
  });

  it("fallback path (no inputOrder): each handle nests in its own row in declaration order with no computed inline top", () => {
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

    // Each handle is a DOM descendant of exactly the .rn-row at its slot, and
    // the anchor is the DOM row center (CSS top:50%), so no computed inline top
    // is stamped on the handle.
    const inputRows =
      container.querySelectorAll<HTMLElement>(".rn-side.in .rn-row.input");
    const outputRows = container.querySelectorAll<HTMLElement>(
      ".rn-side.out .rn-row.output",
    );
    const expectedInIds = ["in:copper_nugget", "in:liquid_water"];
    inputHandles.forEach((handle, i) => {
      expect(handle.getAttribute("data-handleid")).toBe(expectedInIds[i]);
      expect(handle.style.top).toBe("");
      expect(inputRows[i]!.contains(handle)).toBe(true);
    });
    expect(outputHandles[0]!.getAttribute("data-handleid")).toBe(
      "out:copper_powder",
    );
    expect(outputHandles[0]!.style.top).toBe("");
    expect(outputRows[0]!.contains(outputHandles[0]!)).toBe(true);
  });

  it("reordered path (inputOrder present): handles nest in their rows following the resolved order, rates track each item", () => {
    // The resolved order reverses the declaration order [copper_nugget,
    // liquid_water]. The handle at slot i and the row at slot i must both
    // describe the item at inputOrder[i], and each row keeps its own qty
    // (copper_nugget qty=1 -> 60/min, liquid_water qty=2 -> 120/min).
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
      inputOrder: ["liquid_water", "copper_nugget"],
    });
    const inputRows =
      container.querySelectorAll<HTMLElement>(".rn-side.in .rn-row.input");
    expect(inputRows.length).toBe(2);
    const expectedInIds = ["in:liquid_water", "in:copper_nugget"];
    // The handle inside each row (slot i) matches the resolved item at slot i.
    inputRows.forEach((row, i) => {
      const handle = row.querySelector<HTMLElement>("[data-handleid]");
      expect(handle).not.toBeNull();
      expect(handle!.getAttribute("data-handleid")).toBe(expectedInIds[i]);
    });
    // Rows in the same reversed order, each paired with its own rate.
    const inputLbls = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .lbl"),
    ).map((el) => el.textContent);
    const inputRates = Array.from(
      container.querySelectorAll(".rn-side.in .rn-row.input .rate"),
    ).map((el) => el.textContent);
    expect(inputLbls).toEqual(["清水", "赤铜块"]);
    expect(inputRates).toEqual(["120", "60"]);
  });

  it("renders output rows in the recipe's declared order, matching the .rn-products subtitle", () => {
    // R4 (recipe-row-order-unstable): output rows read in the recipe's own
    // declared order -- the layout stamps no output side order -- so two cards
    // of one recipe list their outputs alike. The header subtitle
    // (.rn-products) already reads declaration order; the side rows must agree
    // with it item for item.
    const twoOutRecipe: Recipe = {
      ...multiRowRecipe,
      out: [
        { item: "copper_powder", qty: 1 },
        { item: "liquid_sewage", qty: 1 },
      ],
    };
    const { container } = renderRecipe({
      recipe: twoOutRecipe,
      kind: "recipe",
      multiplier: 1,
    });
    const outLbls = Array.from(
      container.querySelectorAll(".rn-side.out .rn-row.output .lbl"),
    ).map((el) => el.textContent);
    expect(outLbls).toEqual(["赤铜粉末", "污水"]);
    // The subtitle is the declaration-order join of the same display names,
    // so it reads in the same order as the rows.
    expect(container.querySelector(".rn-products")?.textContent).toBe(
      outLbls.join(" ·\u00A0"),
    );
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
    expect(inputLbls).toEqual(["赤铜块", "清水"]);
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
      itemColor("liquid_water"),
    ]);
    const outputAccents = Array.from(
      container.querySelectorAll<HTMLElement>(".rn-side.out .rn-row.output"),
    ).map((r) => r.style.getPropertyValue("--row-accent"));
    expect(outputAccents).toEqual([itemColor("copper_powder")]);
  });

  it("nests both the Handle and the PortGlyph inside the .rn-row for each port", () => {
    const portTransportKinds: PortTransportKinds = new Map([
      ["in:copper_nugget", "belt"],
      ["in:liquid_water", "pipe"],
      ["out:copper_powder", "belt"],
    ]);
    const { container } = renderRecipe({
      recipe: multiRowRecipe,
      kind: "recipe",
      multiplier: 1,
      portTransportKinds,
    });
    // Per-side handle count is unchanged by the move.
    expect(
      container.querySelectorAll('[data-handlepos="left"]').length,
    ).toBe(2);
    expect(
      container.querySelectorAll('[data-handlepos="right"]').length,
    ).toBe(1);

    // Each input row owns exactly its handle and its glyph; declaration order
    // pairs row slot i with expectedInIds[i].
    const inputRows =
      container.querySelectorAll<HTMLElement>(".rn-side.in .rn-row.input");
    const expectedInIds = ["in:copper_nugget", "in:liquid_water"];
    inputRows.forEach((row, i) => {
      const handles = row.querySelectorAll<HTMLElement>("[data-handleid]");
      expect(handles.length).toBe(1);
      expect(handles[0]!.getAttribute("data-handleid")).toBe(expectedInIds[i]);
      expect(row.querySelectorAll("[data-glyph]").length).toBe(1);
    });

    const outputRows = container.querySelectorAll<HTMLElement>(
      ".rn-side.out .rn-row.output",
    );
    expect(outputRows.length).toBe(1);
    const outHandles =
      outputRows[0]!.querySelectorAll<HTMLElement>("[data-handleid]");
    expect(outHandles.length).toBe(1);
    expect(outHandles[0]!.getAttribute("data-handleid")).toBe(
      "out:copper_powder",
    );
    expect(outputRows[0]!.querySelectorAll("[data-glyph]").length).toBe(1);

    // No stray handles or glyphs outside the rows.
    expect(container.querySelectorAll("[data-handleid]").length).toBe(3);
    expect(container.querySelectorAll("[data-glyph]").length).toBe(3);
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
      // The cycle caption localizes; the harness renders under the default zh
      // locale, so the label reads in zh.
      expect(cycle!.textContent).toBe("2.4秒 · 周期");
      const pwr = footer!.querySelector(".pwr");
      expect(pwr).not.toBeNull();
      expect(pwr!.textContent).toBe("");
    });
  });

  // Tail-preserving row-label elision (issue #84): the four solution-bottle
  // recipes and the bracket-family syringes render under the en locale, where
  // their long shared prefixes are exactly the collision the helper exists to
  // break. The bottles' parenthesis tails cannot fit the row budget whole,
  // so those rows keep a PARTIAL tail window (ruling R5) and must read
  // distinctly; the syringes' "[A]"/"[C]" tails fit whole, so those rows
  // elide head-first and end in their distinguishing tail.
  describe("row label elision", () => {
    function renderEn(data: RecipeNodeData) {
      return render(
        <LocaleProvider locale="en">
          <ItemPackProvider
            value={makePackValue({
              machines: [makeMachine("smelter")],
            })}
          >
            <ReactFlowProvider>
              <RecipeNode {...makeRecipeNodeProps(data)} />
            </ReactFlowProvider>
          </ItemPackProvider>
        </LocaleProvider>,
      );
    }

    function bottleRecipe(bottle: string, solution: string): Recipe {
      return {
        id: `${bottle}-${solution}`,
        name: "Bottling",
        category: "assemble",
        icon: bottle,
        row: 0,
        time: 2,
        in: [
          { item: bottle, qty: 1 },
          { item: solution, qty: 1 },
        ],
        out: [{ item: `${bottle}-${solution}`, qty: 1 }],
        producers: ["smelter"],
      } as unknown as Recipe;
    }

    function outputLabels(container: HTMLElement): string[] {
      return Array.from(
        container.querySelectorAll(".rn-side.out .rn-row.output .lbl"),
      ).map((el) => el.textContent ?? "");
    }

    it("keeps the four solution-bottle rows distinct with the full name on title", () => {
      const recipes = [
        bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
        bottleRecipe("copper_bottle", "liquid_plant_grass_2"),
        bottleRecipe("iron_bottle", "liquid_plant_grass_1"),
        bottleRecipe("iron_bottle", "liquid_plant_grass_2"),
      ];
      const visible: string[] = [];
      const titles: string[] = [];
      for (const recipe of recipes) {
        const { container } = renderEn({ recipe, kind: "recipe" });
        const labels = container.querySelectorAll(
          ".rn-side.out .rn-row.output .lbl",
        );
        expect(labels.length).toBe(1);
        const el = labels[0]!;
        // The full name stays reachable on hover whatever the visible string.
        expect(el.getAttribute("title")).toContain("Solution)");
        titles.push(el.getAttribute("title") ?? "");
        visible.push(el.textContent ?? "");
      }
      // No two of the four names render the same visible string, and every
      // tooltip carries its own full name.
      expect(new Set(visible).size).toBe(4);
      expect(new Set(titles).size).toBe(4);
    });

    it("elides a bracket-family row to its distinguishing tail", () => {
      const syringe = (item: string): Recipe =>
        ({
          ...bottleRecipe("copper_cmpt", "liquid_plant_grass_1"),
          id: item,
          out: [{ item, qty: 1 }],
        }) as unknown as Recipe;
      const first = renderEn({ recipe: syringe("bottled_rec_hp_4"), kind: "recipe" });
      const second = renderEn({ recipe: syringe("bottled_rec_hp_5"), kind: "recipe" });
      const [visA, visC] = [outputLabels(first.container)[0]!, outputLabels(second.container)[0]!];
      // Both elide head-first and end in their own bracket tail.
      expect(visA).toContain("\u2026");
      expect(visA.endsWith("[C]")).toBe(true);
      expect(visC.endsWith("[A]")).toBe(true);
      expect(visA).not.toBe(visC);
    });

    it("shows both bottle tails in the products subtitle", () => {
      const twoBottles = {
        ...bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
        out: [
          { item: "copper_bottle-liquid_plant_grass_1", qty: 1 },
          { item: "copper_bottle-liquid_plant_grass_2", qty: 1 },
        ],
      } as unknown as Recipe;
      const { container } = renderEn({
        recipe: twoBottles,
        kind: "recipe",
      });
      const subtitle = container.querySelector(".rn-products");
      expect(subtitle).not.toBeNull();
      const text = subtitle!.textContent ?? "";
      expect(text).toContain("(Jincao Solution)");
      expect(text).toContain("(Yazhen Solution)");
      expect(text).toContain("\u2026");
      // The full join stays on the title attribute.
      expect(subtitle!.getAttribute("title")).toBe(
        "Cuprium Bottle(Jincao Solution) \u00b7\u00a0Cuprium Bottle(Yazhen Solution)",
      );
    });

    it("keeps a colliding machine-title pair distinct with tails intact (zh gates)", () => {
      // The two Purification Node machines differ only in their parenthesis
      // tail; under the pinned title budget the visible titles elide
      // head-first and keep it.
      const gate = (id: string): RecipeNodeData => ({
        recipe: {
          ...bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
          id,
          producers: [id],
        } as unknown as Recipe,
        kind: "recipe",
      });
      const first = renderRecipe(gate("liquid_clean_gate"), makePackValue({
        machines: [makeMachine("liquid_clean_gate"), makeMachine("liquid_recycle_gate")],
      }));
      const second = renderRecipe(gate("liquid_recycle_gate"), makePackValue({
        machines: [makeMachine("liquid_clean_gate"), makeMachine("liquid_recycle_gate")],
      }));
      const t = (c: HTMLElement) =>
        c.querySelector(".machine-title .cn")?.textContent ?? "";
      const a = t(first.container as HTMLElement);
      const b = t(second.container as HTMLElement);
      expect(a).not.toBe(b);
      expect(a.endsWith("(\u6c61\u6c34\u63a5\u5165\u53e3)")).toBe(true);
      expect(b.endsWith("(\u4ea7\u7269\u6392\u51fa\u53e3)")).toBe(true);
      // The full machine names stay on the title attributes.
      expect(
        first.container.querySelector(".machine-title .cn")?.getAttribute("title"),
      ).toBe("\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)");
    });
  });

  describe("header title structure", () => {
    const plateRecipe: Recipe = {
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

    it("titles the header with the machine name and renders the machine-icon data attribute", () => {
      const machine = makeMachine("mixer", { icon: "asm-icon" });
      const { container } = renderRecipe(
        { recipe: plateRecipe, kind: "recipe", multiplier: 1 },
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
      // Title = machine display name (fallback to id when missing entry).
      expect(head!.querySelector(".machine-title .cn")?.textContent).toBe(
        "mixer",
      );
      // The products ride the secondary line; the old .product title line and
      // the raw machine id line are gone.
      expect(head!.querySelector(".rn-products")?.textContent).toBe(
        "iron-plate",
      );
      expect(head!.querySelector(".product")).toBeNull();
      expect(head!.querySelector(".machine-mid")).toBeNull();
    });

    it("falls back to producers[0] for the machine-icon data attribute and the title when the machine record is absent", () => {
      const headlessRecipe: Recipe = {
        ...plateRecipe,
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
      // Graceful degrade: the title falls back to the raw producer id.
      expect(head!.querySelector(".machine-title .cn")?.textContent).toBe(
        "ghost-machine",
      );
      expect(head!.querySelector(".machine-mid")).toBeNull();
    });
  });
});
