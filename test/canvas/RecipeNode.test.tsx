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
import { cssBlock, cssValue } from "../../src/canvas/cssContract.testkit";
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
const HASHED_CATALYST_ITEM = "iron_bottle-liquid_plant_grass_2";

const hashedIconRecipe: Recipe = {
  id: "hashed_icon",
  name: "Hashed Icon",
  category: "craft",
  icon: "copper_powder",
  row: 0,
  time: 1,
  in: [{ item: HASHED_IN_ITEM, qty: 1 }],
  out: [{ item: HASHED_OUT_ITEM, qty: 1 }],
  catalyst: [{ item: HASHED_CATALYST_ITEM, qty: 1 }],
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
    // The multiplier rides the header title line as the .rn-mult-chip; target
    // that chip rather than a bare text match.
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
    // The multiplier rides the header title line as the .rn-mult-chip; target
    // that chip rather than a bare text match.
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
    const catalystIcon = iconOf(HASHED_CATALYST_ITEM);
    // Premise guard: the fixture only exercises the lookup while the shipped
    // pack still keeps these icon ids apart from their item ids.
    expect(inIcon).toBeDefined();
    expect(inIcon).not.toBe(HASHED_IN_ITEM);
    expect(outIcon).not.toBe(HASHED_OUT_ITEM);
    expect(catalystIcon).not.toBe(HASHED_CATALYST_ITEM);
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
    // The catalyst row holds only an item id too, so it resolves the same way
    // the port rows do -- it just has no port to hang the lookup off.
    const catalystSpr = container.querySelector<HTMLElement>(
      ".rn-side.in .rn-row.catalyst .ico .spr",
    );
    expect(inSpr).not.toBeNull();
    expect(outSpr).not.toBeNull();
    expect(catalystSpr).not.toBeNull();
    expect(inSpr!.style.backgroundPosition).toBe(iconPosition(inIcon));
    expect(outSpr!.style.backgroundPosition).toBe(iconPosition(outIcon));
    expect(catalystSpr!.style.backgroundPosition).toBe(
      iconPosition(catalystIcon),
    );
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
    const inputRows = container.querySelectorAll<HTMLElement>(
      ".rn-side.in .rn-row.input",
    );
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
    const inputRows = container.querySelectorAll<HTMLElement>(
      ".rn-side.in .rn-row.input",
    );
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

  it("renders output rows in the recipe's declared order", () => {
    // R4 (recipe-row-order-unstable): output rows read in the recipe's own
    // declared order -- the layout stamps no output side order -- so two cards
    // of one recipe list their outputs alike.
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
    expect(container.querySelectorAll('[data-handlepos="left"]').length).toBe(
      2,
    );
    expect(container.querySelectorAll('[data-handlepos="right"]').length).toBe(
      1,
    );

    // Each input row owns exactly its handle and its glyph; declaration order
    // pairs row slot i with expectedInIds[i].
    const inputRows = container.querySelectorAll<HTMLElement>(
      ".rn-side.in .rn-row.input",
    );
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

  // A catalyst is an input the machine cycles rather than consumes: it is drawn
  // from the plan boundary and handed back every cycle. The card declares the
  // draw as an extra input-column row below every port row, and that row takes
  // a `cat:` port of its own so the edge from the catalyst boundary card can
  // land on it.
  describe("catalyst rows", () => {
    // qty 1 over a 10s cycle at speed 1 is the pack's 6/min catalyst draw.
    const catalystRecipe: Recipe = {
      ...multiRowRecipe,
      time: 10,
      catalyst: [{ item: "gas_xiranite", qty: 1 }],
    };

    const catalystPortKinds: PortTransportKinds = new Map([
      ["in:copper_nugget", "belt"],
      ["in:liquid_water", "pipe"],
      ["cat:gas_xiranite", "gas"],
      ["out:copper_powder", "belt"],
    ]);

    function renderCatalyst(multiplier = 1) {
      return renderRecipe({
        recipe: catalystRecipe,
        kind: "recipe",
        multiplier,
        portTransportKinds: catalystPortKinds,
      });
    }

    it("appends one .rn-row.catalyst below every port row in the input column", () => {
      const { container } = renderCatalyst();
      const inSide = container.querySelector(".rn-body > .rn-side.in")!;
      const rows = Array.from(inSide.querySelectorAll(".rn-row"));
      expect(rows).toHaveLength(3);
      expect(rows.slice(0, 2).map((r) => r.className)).toEqual([
        "rn-row input",
        "rn-row input",
      ]);
      // Last, and not an input row: the .input class draws the SOLID accent
      // tab; a catalyst row draws the ticked one off its own class. The first
      // row of the block also opens it (gap + divider).
      expect(rows[2]!.className).toBe("rn-row catalyst cat-first");
      expect(container.querySelectorAll(".rn-row.catalyst")).toHaveLength(1);
    });

    it("gives the catalyst row an icon, a label, a rate and the item's transport glyph", () => {
      const { container } = renderCatalyst();
      const row = container.querySelector(".rn-row.catalyst")!;
      expect(row.querySelector(".ico")).not.toBeNull();
      expect(row.querySelector(".lbl")?.textContent).not.toBe("");
      expect(row.querySelector(".rate")).not.toBeNull();
      // The row takes an edge now, so it wears the transport shape its port
      // carries instead of the catalyst disc.
      const glyph = row.querySelector("[data-glyph]");
      expect(glyph).not.toBeNull();
      expect(glyph!.getAttribute("data-glyph")).toBe("gas");
    });

    it("hangs a cat: handle on the catalyst row alongside the port handles", () => {
      const { container } = renderCatalyst();
      const row = container.querySelector(".rn-row.catalyst")!;
      const handles = row.querySelectorAll<HTMLElement>("[data-handleid]");
      expect(handles).toHaveLength(1);
      expect(handles[0]!.getAttribute("data-handleid")).toBe(
        "cat:gas_xiranite",
      );
      // The row's handle is a target on the left, exactly like an input row's,
      // and the input rows keep theirs.
      expect(handles[0]!.getAttribute("data-handlepos")).toBe("left");
      expect(
        container.querySelectorAll('[data-handlepos="left"]'),
      ).toHaveLength(3);
      expect(
        container.querySelectorAll('[data-handlepos="right"]'),
      ).toHaveLength(1);
      expect(container.querySelectorAll("[data-handleid]")).toHaveLength(4);
    });

    it("draws the catalyst rate as a bare number, no locale rate unit", () => {
      const { container } = renderCatalyst();
      expect(
        container.querySelector(".rn-row.catalyst .rate")?.textContent,
      ).toBe("6");
    });

    // Every row on the card carries the AGGREGATE flow across every machine,
    // catalyst included, so the figures on one card are all on one scale.
    it("scales the catalyst rate with the port rows", () => {
      const { container } = renderCatalyst(3);
      const inputRates = Array.from(
        container.querySelectorAll(".rn-side.in .rn-row.input .rate"),
      ).map((el) => el.textContent);
      expect(inputRates).toEqual(["18", "36"]);
      expect(
        container.querySelector(".rn-row.catalyst .rate")?.textContent,
      ).toBe("18");
    });

    // A transmuter holds its charge per MACHINE: a card running 2.5 machines
    // holds three machines' worth whether or not the third runs flat out.
    // The port rows keep the fractional scale; only the catalyst row ceils.
    it("counts whole machines in the catalyst rate while the port rows stay fractional", () => {
      const { container } = renderRecipe({
        recipe: catalystRecipe,
        kind: "recipe",
        multiplicity: { num: "5", denom: "2" },
        portTransportKinds: catalystPortKinds,
      });
      const inputRates = Array.from(
        container.querySelectorAll(".rn-side.in .rn-row.input .rate"),
      ).map((el) => el.textContent);
      expect(inputRates).toEqual(["15", "30"]);
      expect(
        container.querySelector(".rn-row.catalyst .rate")?.textContent,
      ).toBe("18");
    });

    // The aggregate answers "how much does this card hold"; the per-machine
    // figure the player builds against rides the row's tooltip.
    it("names the per-machine charge in the catalyst row's tooltip", () => {
      const { container } = renderCatalyst(3);
      const row = container.querySelector(".rn-row.catalyst");
      expect(row?.getAttribute("title")).toBe("每台 6/分");
    });

    it("sizes the card for the catalyst row and its block gap", () => {
      const { container } = renderCatalyst();
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.style.minHeight).toBe(
        `${measureRecipe(catalystRecipe).height}px`,
      );
      // 2 port rows + 1 catalyst row against 1 output row, plus the half-row
      // gap that opens the block.
      expect(measureRecipe(catalystRecipe).height).toBe(145);
    });

    it("styles the catalyst row in canvas.css", () => {
      expect(cssBlock(".rn-row.catalyst")).toContain("padding-left");
    });

    // I3: the block carries no word for what it is -- the ticked tab, the
    // divider and the gap are the whole statement -- so the row's text is the
    // item name and its figure, nothing else.
    it("renders no word label in the catalyst block", () => {
      const { container } = renderCatalyst();
      const row = container.querySelector(".rn-row.catalyst")!;
      const label = row.querySelector(".lbl")!.textContent ?? "";
      const rate = row.querySelector(".rate")!.textContent ?? "";
      expect((row.textContent ?? "").replace(label, "").replace(rate, "")).toBe(
        "",
      );
    });

    // I1: a catalyst row is elided like an input row. The label here is short
    // enough to survive whole, so the pin is on a long one.
    it("elides a long catalyst label at its tail", () => {
      const longCatalyst: Recipe = {
        ...catalystRecipe,
        catalyst: [{ item: "copper_bottle-liquid_plant_grass_1", qty: 1 }],
      } as unknown as Recipe;
      const { container } = renderRecipe({
        recipe: longCatalyst,
        kind: "recipe",
        multiplier: 1,
      });
      const label = container.querySelector(".rn-row.catalyst .lbl")!;
      const visible = label.textContent ?? "";
      expect(visible.endsWith("…"), visible).toBe(true);
      expect(label.getAttribute("title")).not.toBe(visible);
    });
  });

  // The environment frame against the real pack: the extractor's hand table
  // is what marks a recipe gas-gated, so the pack wiring is asserted here
  // while the component contract (layer properties, localisation, CSS) lives
  // in src/canvas/RecipeNode.test.tsx.
  describe("environment frame", () => {
    it("renders one aria-hidden .rn-env on the pack recipe the hand table marks acidic", () => {
      const envRecipe = pack.recipes.find((r) => r.id === "gas_copper_enr2");
      // Premise guard: the pack still marks exactly this recipe acidic.
      expect(envRecipe?.environment).toBe("acidic");
      const { container } = renderRecipe({
        recipe: envRecipe!,
        kind: "recipe",
        multiplier: 1,
      });
      const root = container.querySelector<HTMLElement>(
        '[data-testid="recipe-node"]',
      )!;
      expect(root.getAttribute("data-environment")).toBe("acidic");
      const frames = root.querySelectorAll(".rn-env");
      expect(frames).toHaveLength(1);
      expect(frames[0]!.getAttribute("aria-hidden")).toBe("true");
    });

    it("renders no frame and no data-environment on a plain pack recipe", () => {
      const plainRecipe = pack.recipes.find((r) => r.id === "plant_moss_1");
      expect(plainRecipe?.environment).toBeUndefined();
      const { container } = renderRecipe({
        recipe: plainRecipe!,
        kind: "recipe",
        multiplier: 1,
      });
      const root = container.querySelector<HTMLElement>(
        '[data-testid="recipe-node"]',
      )!;
      expect(root.hasAttribute("data-environment")).toBe(false);
      expect(container.querySelector(".rn-env")).toBeNull();
    });
  });

  // Head-first row-label elision (ruling I8): a row label that does not fit
  // keeps its head and drops everything after the cut, tail marks included.
  // The bracket-family "[A]"/"[C]" distinctness battery is retired with the
  // tail tiers (docs/plans/2026-09-15-catalyst-exam-fixes.md); what the rows
  // still owe the reader is the full name on the `title` attribute.
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

    it("elides the four solution-bottle rows head-first with the full name on title", () => {
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
      // Every row is cut to its head, so the four names read as two (the
      // solutions differ only past the cut); every tooltip still carries
      // its own full name.
      for (const v of visible) {
        expect(v.endsWith("\u2026"), v).toBe(true);
        expect(v, v).not.toContain("Solution");
      }
      expect(new Set(visible).size).toBe(2);
      expect(new Set(titles).size).toBe(4);
    });

    // I1: the rate is a grid cell now, so it is always drawn whole and the
    // label budget pays for its measured width instead of being painted over.
    it("draws a four-digit rate whole and takes the width out of the label", () => {
      const wide = (qty: number): Recipe =>
        ({
          ...bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
          time: 1,
          out: [{ item: "copper_bottle-liquid_plant_grass_1", qty }],
        }) as unknown as Recipe;
      // qty 20 over a 1s cycle at speed 1 is 1200/min; qty 1 is 60/min.
      const labelOf = (qty: number) => {
        const { container } = renderEn({ recipe: wide(qty), kind: "recipe" });
        const row = container.querySelector(".rn-side.out .rn-row.output")!;
        return {
          rate: row.querySelector(".rate")!.textContent ?? "",
          visible: row.querySelector(".lbl")!.textContent ?? "",
        };
      };
      const wide1200 = labelOf(20);
      const narrow60 = labelOf(1);
      expect(wide1200.rate).toBe("1200");
      expect(narrow60.rate).toBe("60");
      expect(wide1200.visible.endsWith("…"), wide1200.visible).toBe(true);
      // Same name, wider rate: the label gets less room, so it is cut shorter.
      expect(wide1200.visible.length).toBeLessThan(narrow60.visible.length);
    });

    // The DOM order is the reading order on the input side and mirrored on the
    // output side through the grid columns (canvas.css pins those).
    it("orders every row sprite, name, rate in the DOM", () => {
      const { container } = renderEn({
        recipe: bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
        kind: "recipe",
      });
      for (const row of container.querySelectorAll(".rn-row")) {
        const classes = [...row.children]
          .filter((el) => !el.hasAttribute("data-handleid"))
          .map((el) => el.className)
          .filter((c) => typeof c === "string" && c !== "");
        expect(classes).toEqual(["ico ico-20", "lbl", "rate"]);
      }
    });

    // The mirror is column placement over a DOM order that runs 1, 2, 3, so the
    // output rate asks for column 1 after the cursor has passed it. Without an
    // explicit row every cell must carry, auto-placement opens a second
    // implicit row and drops the rate under its own name.
    it("pins every row cell to grid row 1 in canvas.css", () => {
      for (const selector of [
        ".rn-row .ico",
        ".rn-row .lbl",
        ".rn-row .rate",
      ]) {
        expect(cssValue(selector, "grid-row"), selector).toBe("1");
      }
      // The output rules move the column only; a grid-row there would shadow
      // the pin above.
      for (const selector of [
        ".rn-row.output .ico",
        ".rn-row.output .lbl",
        ".rn-row.output .rate",
      ]) {
        expect(cssBlock(selector), selector).not.toContain("grid-row");
      }
    });

    it("elides a bracket-family row past its bracket mark", () => {
      const syringe = (item: string): Recipe =>
        ({
          ...bottleRecipe("copper_cmpt", "liquid_plant_grass_1"),
          id: item,
          out: [{ item, qty: 1 }],
        }) as unknown as Recipe;
      const first = renderEn({
        recipe: syringe("bottled_rec_hp_4"),
        kind: "recipe",
      });
      const second = renderEn({
        recipe: syringe("bottled_rec_hp_5"),
        kind: "recipe",
      });
      const labelOf = (c: HTMLElement) =>
        c.querySelector(".rn-side.out .rn-row.output .lbl")!;
      for (const c of [first.container, second.container] as HTMLElement[]) {
        const el = labelOf(c);
        const visible = el.textContent ?? "";
        // The mark is past the cut, so the row keeps the head only and the
        // full name lives on the tooltip.
        expect(visible.endsWith("\u2026"), visible).toBe(true);
        expect(visible, visible).not.toContain("[");
        expect(el.getAttribute("title"), visible).toContain("[");
      }
      expect(
        labelOf(first.container as HTMLElement).getAttribute("title"),
      ).not.toBe(
        labelOf(second.container as HTMLElement).getAttribute("title"),
      );
    });

    it("elides a machine-title pair head-first, full names on title (zh gates)", () => {
      // The two Purification Node machines differ only in their parenthesis
      // tail, which sits past the cut: the visible titles drop it and the
      // `title` attributes carry the full names.
      const gate = (id: string): RecipeNodeData => ({
        recipe: {
          ...bottleRecipe("copper_bottle", "liquid_plant_grass_1"),
          id,
          producers: [id],
        } as unknown as Recipe,
        kind: "recipe",
      });
      const first = renderRecipe(
        gate("liquid_clean_gate"),
        makePackValue({
          machines: [
            makeMachine("liquid_clean_gate"),
            makeMachine("liquid_recycle_gate"),
          ],
        }),
      );
      const second = renderRecipe(
        gate("liquid_recycle_gate"),
        makePackValue({
          machines: [
            makeMachine("liquid_clean_gate"),
            makeMachine("liquid_recycle_gate"),
          ],
        }),
      );
      const t = (c: HTMLElement) =>
        c.querySelector(".machine-title .cn")?.textContent ?? "";
      const a = t(first.container as HTMLElement);
      const b = t(second.container as HTMLElement);
      for (const visible of [a, b]) {
        // Cut mid-tail: the group never closes on screen.
        expect(visible.endsWith("\u2026"), visible).toBe(true);
        expect(visible, visible).not.toContain(")");
      }
      // These two diverge before the cut, so the rows still read apart.
      expect(a).not.toBe(b);
      // The full machine names stay on the title attributes.
      const titleAttr = (c: HTMLElement) =>
        c.querySelector(".machine-title .cn")?.getAttribute("title");
      expect(titleAttr(first.container as HTMLElement)).toBe(
        "\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)",
      );
      expect(titleAttr(second.container as HTMLElement)).not.toBe(
        titleAttr(first.container as HTMLElement),
      );
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
      // The old .product title line and the raw machine id line are gone.
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
