import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Item } from "@aef/schema";
import ProductNode from "../../src/canvas/ProductNode";
import { LocaleProvider } from "../../src/data/i18n-context";
import { ItemPackProvider } from "../../src/canvas/itemPackContext";
import {
  cssBlock,
  cssPx,
  cssSelectorsMatching,
  cssValue,
} from "../../src/canvas/cssContract.testkit";
import { PRODUCT_HEIGHT } from "../../src/canvas/dimensions";
import { iconIdForItem, iconPosition } from "../../src/canvas/iconSprite";
import {
  measureTextWidth,
  type MeasuredFont,
} from "../../src/canvas/measureText";
import {
  makeItem,
  makePackValue,
  makeProductNodeProps,
  type ProductNodeData,
} from "../../src/canvas/node.testkit";

afterEach(() => cleanup());

function renderProduct(
  data: ProductNodeData,
  items: Item[] = [],
  locale: "en" | "zh" = "en",
) {
  return render(
    <LocaleProvider locale={locale}>
      <ItemPackProvider value={makePackValue({ items })}>
        <ReactFlowProvider>
          <ProductNode {...makeProductNodeProps(data)} />
        </ReactFlowProvider>
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

// The card shows `fullName`: whole on the hover title, and as the visible text
// or its elided head. jsdom has no canvas metrics, so elision runs on the
// char-class upper bound there and cuts names that fit in a browser.
function expectNameShown(container: HTMLElement, fullName: string): void {
  const name = container.querySelector(".pn-name");
  expect(name?.getAttribute("title")).toBe(fullName);
  const head = (name?.textContent ?? "").replace(/\u2026$/, "");
  expect(head.length).toBeGreaterThan(0);
  expect(fullName.startsWith(head)).toBe(true);
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
    expectNameShown(container, "Cuprium Ore");
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

  // The card draws no caption words any more (ruling I5/I10): what is left is
  // the name row and the figure row. This helper is the gate -- card text minus
  // those two strings has to come out empty, whatever chrome is added later.
  const leftoverText = (container: HTMLElement): string => {
    const card = container.querySelector(".product-node");
    if (card === null) throw new Error("no product card rendered");
    const name = card.querySelector(".pn-name")?.textContent ?? "";
    const figure = card.querySelector(".pn-rate")?.textContent ?? "";
    return (card.textContent ?? "").replace(name, "").replace(figure, "");
  };

  it("draws nothing but the name and the figure on an input card", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "2", denom: "1" },
        rateCap: { num: "4", denom: "1" },
      },
      [makeItem("copper_ore", true)],
    );
    expect(container.querySelector(".pn-kind")).toBeNull();
    expect(leftoverText(container)).toBe("");
  });

  it("draws nothing but the name and the figure on target and surplus cards", () => {
    for (const flavor of ["target", "surplus"] as const) {
      const { container } = renderProduct(
        {
          kind: "outputProduct",
          itemId: "copper_nugget",
          rate: { num: "2", denom: "1" },
          flavor,
        },
        [makeItem("copper_nugget", false)],
      );
      expect(container.querySelector(".pn-kind")).toBeNull();
      expect(leftoverText(container)).toBe("");
      cleanup();
    }
  });

  it("draws nothing but the name and the figure on a tap card", () => {
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
    expect(container.querySelector(".pn-kind")).toBeNull();
    expect(leftoverText(container)).toBe("");
  });

  it("speaks the direction and class of an input card in en and zh", () => {
    const label = (locale: "en" | "zh"): string => {
      const { container } = renderProduct(
        {
          kind: "inputProduct",
          itemId: "copper_ore",
          rate: { num: "2", denom: "1" },
        },
        [makeItem("copper_ore", true)],
        locale,
      );
      const text =
        container
          .querySelector("[data-testid='product-node']")
          ?.getAttribute("aria-label") ?? "";
      cleanup();
      return text;
    };
    expect(label("en")).toBe("In, raw");
    const zh = label("zh");
    expect(zh).toBe("输入, 原料");
    expect(zh).not.toMatch(/In|raw/);
  });

  it("speaks the direction and class of a target output in en and zh", () => {
    const en = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "target",
      },
      [makeItem("copper_nugget", false)],
    );
    expect(
      en.container
        .querySelector("[data-testid='product-node']")
        ?.getAttribute("aria-label"),
    ).toBe("Out, target");
    cleanup();
    const zh = renderProduct(
      {
        kind: "outputProduct",
        itemId: "copper_nugget",
        rate: { num: "2", denom: "1" },
        flavor: "surplus",
      },
      [makeItem("copper_nugget", false)],
      "zh",
    );
    expect(
      zh.container
        .querySelector("[data-testid='product-node']")
        ?.getAttribute("aria-label"),
    ).toBe("输出, 过剩");
  });

  // The general rule (ruling R9): the cap chip is dropped outright, so a card
  // with rateCap set renders the exact DOM of one without, and the realized
  // rate stands alone as the primary row.
  it("renders the realized rate primary row and never a cap chip", () => {
    const cardHtml = (rateCap: { num: string; denom: string } | undefined) => {
      const { container } = renderProduct(
        rateCap === undefined
          ? {
              kind: "inputProduct",
              itemId: "copper_ore",
              rate: { num: "4", denom: "1" },
            }
          : {
              kind: "inputProduct",
              itemId: "copper_ore",
              rate: { num: "4", denom: "1" },
              rateCap,
            },
        [makeItem("copper_ore", true)],
      );
      const html =
        container.querySelector("[data-testid='product-node']")?.innerHTML ??
        "";
      cleanup();
      return html;
    };
    const uncapped = cardHtml(undefined);
    expect(cardHtml({ num: "1", denom: "2" })).toBe(uncapped);
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "copper_ore",
        rate: { num: "4", denom: "1" },
        rateCap: { num: "1", denom: "2" },
      },
      [makeItem("copper_ore", true)],
    );
    const rate = container.querySelector(".pn-rate");
    expect(rate).not.toBeNull();
    // 4/s * 60 = 240/min; rendered as primary content with /min unit.
    expect(rate?.textContent).toBe("240/min");
    expect(rate?.querySelector(".unit")?.textContent).toBe("/min");
    // The unit span is the row's only child: no secondary chip element.
    expect(rate?.querySelectorAll("span")).toHaveLength(1);
    // Guard against the deleted "uncapped" branch.
    expect(rate?.classList.contains("uncapped")).toBe(false);
    expect(container.textContent ?? "").not.toContain("uncapped");
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
    expect(node?.getAttribute("aria-label")).toBe("In, tap");
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

  // The catalyst pool has boundary cards of its own (u:cat:*). They draw the
  // same box as an ordinary input: the pool shows in the ticked left tab and in
  // the spoken label, the card carries a role marker for selectors, and the
  // item-level split of the charge rides the name tooltip rather than another
  // line of chrome.
  describe("catalyst nodes", () => {
    const catalystData = (
      extra: Partial<ProductNodeData> = {},
    ): ProductNodeData =>
      ({
        kind: "inputProduct",
        itemId: "gas_xiranite",
        rate: { num: "1", denom: "10" },
        role: "catalyst",
        ...extra,
      }) as ProductNodeData;

    it("speaks the catalyst word in place of raw/import in en and zh", () => {
      const label = (locale: "en" | "zh"): string => {
        const { container } = renderProduct(
          catalystData(),
          [makeItem("gas_xiranite", true)],
          locale,
        );
        const text =
          container
            .querySelector("[data-testid='product-node']")
            ?.getAttribute("aria-label") ?? "";
        cleanup();
        return text;
      };
      expect(label("en")).toBe("In, catalyst");
      const zh = label("zh");
      expect(zh).toContain("催化");
      expect(zh).not.toMatch(/raw|import|catalyst/);
    });

    it("keeps the catalyst word on a fanout slice of the pool in en and zh", () => {
      // A per-container slice of a catalyst card is still catalyst supply, so
      // the tap word joins the catalyst word instead of replacing it.
      const slice = catalystData({ isFanout: true });
      const en = renderProduct(slice, [makeItem("gas_xiranite", true)]);
      expect(
        en.container
          .querySelector("[data-testid='product-node']")
          ?.getAttribute("aria-label"),
      ).toBe("In, catalyst, tap");
      cleanup();
      const zh = renderProduct(slice, [makeItem("gas_xiranite", true)], "zh");
      expect(
        zh.container
          .querySelector("[data-testid='product-node']")
          ?.getAttribute("aria-label"),
      ).toBe("输入, 催化, 分接");
    });

    it("marks the card with data-role=catalyst and leaves an ordinary card unmarked", () => {
      const { container } = renderProduct(catalystData(), [
        makeItem("gas_xiranite", true),
      ]);
      expect(
        container
          .querySelector("[data-testid='product-node']")
          ?.getAttribute("data-role"),
      ).toBe("catalyst");
      cleanup();
      const plain = renderProduct(
        {
          kind: "inputProduct",
          itemId: "gas_xiranite",
          rate: { num: "1", denom: "10" },
        },
        [makeItem("gas_xiranite", true)],
      );
      expect(
        plain.container
          .querySelector("[data-testid='product-node']")
          ?.hasAttribute("data-role"),
      ).toBe(false);
    });

    it("appends the pool breakdown to the name tooltip of an aggregate or single card", () => {
      const { container } = renderProduct(
        catalystData({
          catalystBreakdown: {
            fromCatalyst: { num: "1", denom: "20" },
            fromGeneral: { num: "1", denom: "30" },
            unmet: { num: "1", denom: "60" },
          },
        }),
        [makeItem("gas_xiranite", true)],
      );
      const title =
        container.querySelector(".pn-name")?.getAttribute("title") ?? "";
      // 1/20 per sec = 3/min, 1/30 = 2/min, 1/60 = 1/min.
      expect(title).toContain("from catalyst supply 3/min");
      expect(title).toContain("from general supply 2/min");
      expect(title).toContain("catalyst short by 1/min");
      // The name still leads the tooltip.
      expect(title.startsWith("Xiragen")).toBe(true);
    });

    it("drops the shortage line from the tooltip when nothing is unmet", () => {
      const { container } = renderProduct(
        catalystData({
          catalystBreakdown: {
            fromCatalyst: { num: "1", denom: "10" },
            fromGeneral: { num: "0", denom: "1" },
            unmet: { num: "0", denom: "1" },
          },
        }),
        [makeItem("gas_xiranite", true)],
      );
      const title =
        container.querySelector(".pn-name")?.getAttribute("title") ?? "";
      expect(title).toContain("from catalyst supply 6/min");
      expect(title).not.toContain("short");
    });

    it("leaves a fanout slice's name tooltip plain", () => {
      // The split is item-level accounting; a per-container slice has no share
      // of it, so its tooltip is the bare display name.
      const { container } = renderProduct(
        catalystData({
          isFanout: true,
          parentRate: { num: "1", denom: "5" },
          catalystBreakdown: {
            fromCatalyst: { num: "1", denom: "20" },
            fromGeneral: { num: "0", denom: "1" },
            unmet: { num: "0", denom: "1" },
          },
        }),
        [makeItem("gas_xiranite", true)],
      );
      expect(container.querySelector(".pn-name")?.getAttribute("title")).toBe(
        "Xiragen",
      );
    });

    it("draws the ordinary box plus the one ruled word: element skeleton, one height constant", () => {
      // Height is the layout constant PRODUCT_HEIGHT, which has no role arm,
      // so the only way a catalyst card could grow is by adding chrome. Pin
      // the rendered element skeleton against the ordinary capped card: same
      // elements, same classes, same order, with exactly one addition -- the
      // CATALYST badge in the name row. That word is ruling R3's deliberate
      // exception to ruling I5's no-words rule (2026-09-16); any other chrome
      // the catalyst card grows is a defect.
      const skeleton = (root: Element): string[] =>
        Array.from(root.querySelectorAll("*")).map(
          (el) => `${el.tagName}.${el.className}`,
        );
      const plain = renderProduct(
        {
          kind: "inputProduct",
          itemId: "gas_xiranite",
          rate: { num: "1", denom: "10" },
          rateCap: { num: "1", denom: "2" },
        },
        [makeItem("gas_xiranite", true)],
      );
      const ordinary = skeleton(plain.container);
      const nameAt = ordinary.indexOf("DIV.pn-name");
      expect(nameAt).toBeGreaterThanOrEqual(0);
      const withBadge = [
        ...ordinary.slice(0, nameAt + 1),
        "SPAN.pn-badge",
        ...ordinary.slice(nameAt + 1),
      ];
      cleanup();
      const { container } = renderProduct(
        catalystData({
          rateCap: { num: "1", denom: "2" },
          catalystBreakdown: {
            fromCatalyst: { num: "1", denom: "20" },
            fromGeneral: { num: "1", denom: "20" },
            unmet: { num: "0", denom: "1" },
          },
        }),
        [makeItem("gas_xiranite", true)],
      );
      expect(skeleton(container)).toEqual(withBadge);
      expect(PRODUCT_HEIGHT).toBe(71);
    });

    it("wears a ticked left tab of the plain input's width", () => {
      // The catalyst mark is a pattern, not a colour: the tab is the input
      // accent's width, painted as a repeating stripe, recoloured to the
      // catalyst yellow -- the tab's alone, since the catalyst edges, rows and
      // chips keep the item hue (ruling R2). Both halves are read out of
      // canvas.css, so a rule renamed or dropped in the stylesheet fails here.
      const plain = cssBlock(".product-node.input");
      const catalyst = cssBlock('.product-node.input[data-role="catalyst"]');
      expect(catalyst).not.toBe(plain);
      expect(catalyst).toMatch(/repeating-linear-gradient/);
      const ticks = cssValue(
        '.product-node.input[data-role="catalyst"]',
        "background-image",
      );
      expect(ticks).toContain("--ak-accent-yellow");
      expect(ticks).not.toContain("--ak-accent-cyan");
      // Width parity with the solid tab, and the 4px tick pitch.
      expect(
        cssPx('.product-node.input[data-role="catalyst"]', "background-size"),
      ).toBe(cssPx(".product-node.input", "border-left"));
      expect(ticks).toContain("0 2px");
      expect(ticks).toContain("2px 4px");
    });

    it("carries the ruled CATALYST word as an aria-hidden badge in en and zh", () => {
      // Ruling R3: the mark is the string inputs.catalyst.badge, drawn once on
      // the boundary card and spoken once by its aria-label -- so the badge
      // itself is hidden from the reader. No new i18n key: the word is the
      // one the inputs panel already pins to the catalyst pool.
      const en = renderProduct(catalystData(), [
        makeItem("gas_xiranite", true),
      ]);
      const enBadge = en.container.querySelector(".pn-badge");
      expect(enBadge).not.toBeNull();
      expect(enBadge).toHaveAttribute("aria-hidden", "true");
      expect(enBadge?.textContent).toBe("CATALYST");
      // The badge rides the name row, after the name.
      expect(en.container.querySelector(".pn-name")?.textContent).toContain(
        "CATALYST",
      );
      cleanup();
      const zh = renderProduct(
        catalystData(),
        [makeItem("gas_xiranite", true)],
        "zh",
      );
      const zhBadge = zh.container.querySelector(".pn-badge");
      expect(zhBadge).not.toBeNull();
      expect(zhBadge).toHaveAttribute("aria-hidden", "true");
      expect(zhBadge?.textContent).toBe("催化");
    });

    // The badge rides the name's line box, so its margin, chrome and measured
    // text come out of the name budget. The card is sprite-less on purpose: in
    // jsdom a sprite card's badged budget is under the ellipsis's own width,
    // so elideName hands the whole name back and nothing visibly elides. The
    // id is grown until it overruns the badged budget but still fits the
    // unbadged one, so the cut only happens if the badge is charged.
    it("elides a badged card's name against the column less the badge", () => {
      const nameFont: MeasuredFont = {
        fontSize: 12,
        weight: 700,
        family: "--font-ui",
      };
      const badgeFont: MeasuredFont = {
        fontSize: 9,
        weight: 500,
        family: "--font-mono",
        letterSpacingEm: 0.05,
      };
      const unbadgedBudget = 124 - 8;
      const badgedBudget =
        unbadgedBudget - (6 + measureTextWidth("CATALYST", badgeFont) + 10);
      let itemId = "no_sprite_";
      while (measureTextWidth(itemId, nameFont) <= badgedBudget) {
        itemId += "x";
      }
      expect(iconPosition(iconIdForItem(itemId))).toBeUndefined();
      expect(measureTextWidth(itemId, nameFont)).toBeLessThanOrEqual(
        unbadgedBudget,
      );

      const { container } = renderProduct(catalystData({ itemId }), [
        makeItem(itemId, true),
      ]);
      const name = container.querySelector(".pn-name");
      expect(name?.querySelector(".pn-badge")?.textContent).toBe("CATALYST");
      expect(name?.getAttribute("title")).toBe(itemId);
      const visible = name?.firstChild?.textContent ?? "";
      expect(visible.endsWith("…")).toBe(true);
      const head = visible.slice(0, -1);
      expect(head.length).toBeGreaterThan(0);
      expect(itemId.startsWith(head)).toBe(true);
    });

    it("leaves an ordinary input card without the badge", () => {
      const { container } = renderProduct(
        {
          kind: "inputProduct",
          itemId: "gas_xiranite",
          rate: { num: "1", denom: "10" },
        },
        [makeItem("gas_xiranite", true)],
      );
      expect(container.querySelector(".pn-badge")).toBeNull();
      expect(
        container.querySelector("[data-testid='pn-catalyst-badge']"),
      ).toBeNull();
    });

    it("keeps the pool's name at full ink even on a tap slice", () => {
      expect(
        cssValue('.product-node.input[data-role="catalyst"] .pn-name', "color"),
      ).toBe("var(--ak-text-primary)");
    });
  });

  // One elision rule on every name surface: a plain card whose name overruns
  // the name column keeps its head plus an ellipsis, like the badged card, and
  // the hover title keeps the whole name. "Buck Capsule [C]" is the en name
  // that wrapped onto two lines on rot-bottled_rec_hp_1's output card.
  it("elides a plain card's long name to its head and keeps the full name on the title", () => {
    const { container } = renderProduct(
      {
        kind: "outputProduct",
        itemId: "bottled_rec_hp_1",
        rate: { num: "1", denom: "1" },
        flavor: "target",
      },
      [makeItem("bottled_rec_hp_1", false)],
    );
    const name = container.querySelector(".pn-name");
    expect(name?.getAttribute("title")).toBe("Buck Capsule [C]");
    const visible = name?.textContent ?? "";
    expect(visible.endsWith("\u2026")).toBe(true);
    const head = visible.slice(0, -1);
    expect(head.length).toBeGreaterThan(0);
    expect(head.length).toBeLessThan("Buck Capsule [C]".length);
    expect("Buck Capsule [C]".startsWith(head)).toBe(true);
  });

  // A sprite-less card draws an empty head child, not the 28px sprite, so its
  // name has the whole column less the 8px head gap. The id is grown until it
  // overruns the sprite card's 88px budget but still fits the 116px one.
  it("does not charge the sprite width to a sprite-less card's name budget", () => {
    const nameFont: MeasuredFont = {
      fontSize: 12,
      weight: 700,
      family: "--font-ui",
    };
    let itemId = "no_sprite_";
    while (measureTextWidth(itemId, nameFont) <= 88) {
      itemId += "x";
    }
    expect(iconPosition(iconIdForItem(itemId))).toBeUndefined();
    expect(measureTextWidth(itemId, nameFont)).toBeLessThanOrEqual(116);

    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId,
        rate: { num: "1", denom: "1" },
      },
      [makeItem(itemId, true)],
    );
    expect(container.querySelector(".pn-name")?.textContent).toBe(itemId);
  });

  // The two rows of the card split the width differently: the name row clips
  // (elision plus an ellipsis fallback), the rate row never does. A wrapped rate
  // row, e.g. a share chip pushed onto a second line, grows the card past
  // PRODUCT_HEIGHT, and a clipped one hides a number the reader needs.
  it("keeps the name row clipping and the rate row on one unclipped line", () => {
    expect(cssValue(".pn-name", "min-width")).toBe("0");
    expect(cssValue(".pn-name", "white-space")).toBe("nowrap");
    expect(cssValue(".pn-name", "overflow")).toBe("hidden");
    expect(cssValue(".pn-name", "text-overflow")).toBe("ellipsis");

    expect(cssValue(".pn-rate", "white-space")).toBe("nowrap");
    const rateRules = cssSelectorsMatching(/\.pn-rate/);
    expect(rateRules.length).toBeGreaterThan(0);
    for (const selector of rateRules) {
      expect(cssBlock(selector), selector).not.toMatch(/[;{]\s*overflow/);
      expect(cssBlock(selector), selector).not.toMatch(/text-overflow/);
    }
  });

  it("falls back to the raw id when i18n has no translation for the item", () => {
    const { container } = renderProduct(
      {
        kind: "inputProduct",
        itemId: "no-such-item",
        rate: { num: "0", denom: "1" },
      },
      [makeItem("no-such-item", true)],
    );
    expectNameShown(container, "no-such-item");
  });
});
