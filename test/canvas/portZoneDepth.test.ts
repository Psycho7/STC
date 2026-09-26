// The TS<->CSS geometry contract. dimensions.ts calls itself the single source
// of truth for the offline layout model and the rendered DOM alike, but only the
// TypeScript half is compiled: the browser reads canvas.css, and nothing stopped
// a card from being resized on one side of the pair alone. Every number both
// sides declare is pinned here, so editing the stylesheet without the constant
// (or the reverse) fails.
//
// PORT_ZONE_DEPTH is the leading case: the row's port-side inset, the strip
// between the card edge and the item glyph, read by the chip-seat exemption on
// the TS side and by the browser on the CSS side.

import { describe, expect, it } from "vitest";

import {
  CARD_BORDER,
  PORT_ZONE_DEPTH,
  cardRectsFor,
  chipEntersOwnCardBody,
  portKeepOutRect,
} from "../../src/canvas/chipSeating";
import {
  CATALYST_BLOCK_GAP,
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  PRODUCT_HEIGHT,
  PRODUCT_WIDTH,
  RECIPE_HEAD_ICON_COL,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_ROW_HEIGHT,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import { CANVAS_BG_HEX } from "../../src/canvas/itemColor";
import { nodeHeight, portOffsetY } from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, productNode, recipeNode } from "./busRouting.testkit";
import {
  cssBlock,
  cssPx,
  cssSelectorsMatching,
  cssValue,
} from "../../src/canvas/cssContract.testkit";

describe("PORT_ZONE_DEPTH is coupled to the recipe row inset", () => {
  it("matches .rn-row.input padding-left", () => {
    expect(cssPx(".rn-row.input", "padding-left")).toBe(PORT_ZONE_DEPTH);
  });

  it("matches .rn-row.output padding-right", () => {
    expect(cssPx(".rn-row.output", "padding-right")).toBe(PORT_ZONE_DEPTH);
  });

  it("holds the current value", () => {
    // Second anchor: the CSS-vs-constant pair could be edited in lockstep by a
    // find-and-replace and still silently move the exemption depth.
    expect(PORT_ZONE_DEPTH).toBe(8);
  });
});

describe("the port strip is measured inside the drawn card border", () => {
  it("matches the .recipe-node border width", () => {
    expect(cssPx(".recipe-node", "border")).toBe(CARD_BORDER);
  });

  // The DRAWN recipe card: origin at the model position, a CARD_BORDER frame
  // around the RECIPE_WIDTH content box, so its row spans left+1 .. right-1.
  const card = {
    left: 1000,
    top: 0,
    right: 1000 + RECIPE_WIDTH + 2 * CARD_BORDER,
    bottom: 100,
  };
  const chipAt = (cx: number): typeof card => ({
    left: cx - 60,
    top: 20,
    right: cx + 60,
    bottom: 60,
  });

  it("exempts a target-side centre out to the row's glyph edge", () => {
    const glyph = card.left + CARD_BORDER + PORT_ZONE_DEPTH;
    expect(chipEntersOwnCardBody(chipAt(glyph), card, "target")).toBe(false);
    expect(chipEntersOwnCardBody(chipAt(glyph + 1), card, "target")).toBe(true);
  });

  it("exempts a source-side centre out to the row's glyph edge", () => {
    const glyph = card.right - CARD_BORDER - PORT_ZONE_DEPTH;
    expect(chipEntersOwnCardBody(chipAt(glyph), card, "source")).toBe(false);
    expect(chipEntersOwnCardBody(chipAt(glyph - 1), card, "source")).toBe(true);
  });
});

// The obstacle rects the seating pass runs against, straight from the function
// deconflictChipAnchors builds them with. The e2e card-frame criterion rebuilds
// RECIPE_WIDTH + cardGrowth from the same constants, so it agrees whether or not
// the growth is applied here; only this test observes the application itself.
describe("cardRectsFor grows the model box into the drawn frame", () => {
  it("grows a recipe card by one border per side, origin fixed", () => {
    const node = recipeNode("r", 1000, 400, mkRecipe("r", ["a"], ["b"]));
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const [rect] = cardRectsFor(nodes, byId);

    expect(rect).toEqual({
      id: "r",
      left: 1000,
      top: 400,
      right: 1000 + RECIPE_WIDTH + 2 * CARD_BORDER,
      bottom: 400 + nodeHeight(node) + 2 * CARD_BORDER,
      border: CARD_BORDER,
    });
    // Stated absolutely too, so a change to CARD_BORDER cannot move the frame
    // while both sides of the comparison shift with it.
    expect(rect!.right - rect!.left).toBe(RECIPE_WIDTH + 2 * CARD_BORDER);
    expect(rect!.right - rect!.left).toBe(242);
    expect(rect!.bottom - rect!.top).toBe(nodeHeight(node) + 2);
  });

  it("leaves a product card at its model box", () => {
    const node = productNode("p", 200, 60, PRODUCT_WIDTH, PRODUCT_HEIGHT);
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Absolute, like the recipe case above: the model box IS the drawn box for
    // a product, so a growth applied here would show up as a moved edge.
    expect(cardRectsFor(nodes, byId)).toEqual([
      { id: "p", left: 200, top: 60, right: 348, bottom: 60 + 71, border: 0 },
    ]);
  });
});

// portKeepOutRect's outer edge is the drawn glyph's edge per kind: the glyph
// hangs GLYPH_SIDE_OFFSET off the row edge, one CARD_BORDER inside the drawn
// edge on a recipe and at it on a product.
describe("portKeepOutRect covers the drawn port furniture", () => {
  const recipeCard: Parameters<typeof portKeepOutRect>[0] = {
    id: "r",
    left: 1000,
    top: 400,
    right: 1000 + RECIPE_WIDTH + 2 * CARD_BORDER,
    bottom: 500,
    border: CARD_BORDER,
  };
  const productCard: Parameters<typeof portKeepOutRect>[0] = {
    id: "p",
    left: 200,
    top: 60,
    right: 348,
    bottom: 60 + PRODUCT_HEIGHT,
    border: 0,
  };

  it("a recipe target band reaches the glyph edge at L-9, full height", () => {
    expect(portKeepOutRect(recipeCard, "target")).toEqual({
      left: 1000 - 9,
      right: 1000 + CARD_BORDER + PORT_ZONE_DEPTH,
      top: 400,
      bottom: 500,
    });
  });

  it("a recipe source band reaches the glyph edge at L+251, full height", () => {
    const r = portKeepOutRect(recipeCard, "source");
    expect(r.left).toBe(recipeCard.right - CARD_BORDER - PORT_ZONE_DEPTH);
    // The drawn glyph edge: row right (L+241) + GLYPH_SIZE + 2.
    expect(r.right).toBe(1000 + RECIPE_WIDTH + CARD_BORDER + 10);
    expect(r.right).toBe(1251);
  });

  it("a product target band reaches the glyph edge at L-10", () => {
    const r = portKeepOutRect(productCard, "target");
    expect(r.left).toBe(200 - 10);
    expect(r.right).toBe(200 + PORT_ZONE_DEPTH);
  });

  it("a product source band reaches the glyph edge at L+158", () => {
    const r = portKeepOutRect(productCard, "source");
    expect(r.left).toBe(348 - PORT_ZONE_DEPTH);
    expect(r.right).toBe(358);
  });
});

// The rest of the contract. Each case reads the constant and the stylesheet and
// compares them; the CSS side is extracted by the shared anchored reader so a
// descendant selector cannot be mistaken for the rule that carries the geometry.
describe("the recipe card's box is declared the same in TS and in CSS", () => {
  it("sizes .recipe-node at RECIPE_WIDTH", () => {
    expect(cssPx(".recipe-node", "width")).toBe(RECIPE_WIDTH);
  });

  it("sizes .rn-head at RECIPE_HEADER_HEIGHT", () => {
    // The header is the one row whose height the LOD bands may not collapse:
    // recipeHeight adds it unconditionally, so a shrunken .rn-head would put
    // every port below the model's y-slot at low zoom.
    expect(cssPx(".rn-head", "height")).toBe(RECIPE_HEADER_HEIGHT);
  });

  it("sizes .machine-icon at 40px and sums it to RECIPE_HEAD_ICON_COL", () => {
    // The icon is the card's identity at fit zoom, so both the sprite box and
    // the column it fills are pinned: the icon plus the machine block's
    // 2x6px horizontal padding and 1px right border is the whole column.
    const icon = cssPx(".rn-head .rn-machine-block .machine-icon", "width");
    expect(icon).toBe(40);
    expect(cssPx(".rn-head .rn-machine-block .machine-icon", "height")).toBe(
      40,
    );
    const padX = cssPx(".rn-head .rn-machine-block", "padding", 1);
    const border = cssPx(".rn-head .rn-machine-block", "border-right");
    expect(icon + 2 * padX + border).toBe(RECIPE_HEAD_ICON_COL);
  });

  it("sizes .rn-row at RECIPE_ROW_HEIGHT", () => {
    expect(cssPx(".rn-row", "height")).toBe(RECIPE_ROW_HEIGHT);
  });

  it("pads .rn-side by RECIPE_ROWS_TOP_PAD above and below the rows", () => {
    // Shorthand: the first length is the vertical pad, and recipeHeight counts
    // it twice because the same padding repeats under the last row.
    expect(cssPx(".rn-side", "padding")).toBe(RECIPE_ROWS_TOP_PAD);
  });
});

describe("the row rate is a grid cell drawn at rest on every row", () => {
  it("keeps the rate in the row flow, with no backdrop to hide a name under", () => {
    // I1: the rate used to be an absolute overlay with an opaque backdrop, so
    // it painted over the label tail. It is a column of the row grid now, and
    // the label budget pays for it instead.
    expect(cssValue(".rn-row .rate", "position")).toBe("static");
    expect(cssBlock(".rn-row .rate")).not.toMatch(/background/);
  });

  it("lays the row out as sprite, name, rate with the name the only flexible column", () => {
    expect(cssValue(".rn-row", "display")).toBe("grid");
    expect(cssValue(".rn-row", "grid-template-columns")).toBe(
      "auto minmax(0, 1fr) auto",
    );
    expect(cssValue(".rn-row .ico", "grid-column")).toBe("1");
    expect(cssValue(".rn-row .lbl", "grid-column")).toBe("2");
    expect(cssValue(".rn-row .rate", "grid-column")).toBe("3");
    // The output side mirrors the same three tracks, so its rate sits at the
    // card's inner end and its sprite on the card edge.
    expect(cssValue(".rn-row.output .ico", "grid-column")).toBe("3");
    expect(cssValue(".rn-row.output .rate", "grid-column")).toBe("1");
    // Digits never wrap or ellipsize: the rate is drawn whole.
    expect(cssValue(".rn-row .rate", "white-space")).toBe("nowrap");
  });

  it("shows the rate at rest", () => {
    expect(cssValue(".rn-row .rate", "display")).toBe("block");
  });

  it("makes no rate rule depend on hover or selection", () => {
    const selectors = cssSelectorsMatching(/\.rn-row.*\.rate/);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).not.toMatch(/:hover/);
      expect(selector).not.toMatch(/\.selected/);
    }
  });

  it("keeps the overlay suppressed under zoom-low", () => {
    expect(
      cssValue(
        ".ak-canvas-theme.zoom-low .recipe-node .rn-row .rate",
        "display",
      ),
    ).toBe("none");
  });

  it("keeps each side's rate colour", () => {
    expect(cssValue(".rn-row.input .rate", "color")).toBe(
      "var(--ak-text-secondary)",
    );
    expect(cssValue(".rn-row.output .rate", "color")).toBe(
      "var(--ak-accent-cyan-soft)",
    );
  });
});

// I3 / A2: catalyst rows are their own block on the card -- full ink, a ticked
// accent tab in the item hue, and a hairline divider above the block. The tab
// is a pattern, not a new colour.
describe("the catalyst block reads apart from the input rows", () => {
  it("gives the catalyst tab the input tab's box", () => {
    for (const property of ["top", "transform", "width", "height", "left"]) {
      expect(cssValue(".rn-row.catalyst::before", property)).toBe(
        cssValue(".rn-row.input::before", property),
      );
    }
  });

  it("ticks the catalyst tab where the input tab is a solid bar", () => {
    const catalyst = cssValue(".rn-row.catalyst::before", "background");
    expect(catalyst).toContain("repeating-linear-gradient");
    expect(catalyst).toContain("--row-accent");
    expect(catalyst).not.toBe(cssValue(".rn-row.input::before", "background"));
  });

  it("draws the block divider in the body divider's colour", () => {
    expect(cssValue(".rn-row.catalyst.cat-first::after", "background")).toBe(
      cssValue(".rn-body::before", "background"),
    );
  });

  it("opens the block with a half-row gap", () => {
    expect(cssPx(".rn-row.catalyst.cat-first", "margin-top")).toBe(
      CATALYST_BLOCK_GAP,
    );
  });

  it("leaves the catalyst label at full ink", () => {
    expect(cssSelectorsMatching(/^\.rn-row\.catalyst \.lbl$/)).toEqual([]);
  });
});

describe("the product card's drawn width is what the layout assigns", () => {
  it("adds up to PRODUCT_WIDTH from the content column and its chrome", () => {
    // The model width already counts the card's borders, and the widest of the
    // two is the accent border a direction modifier swaps in on one edge. The
    // sum is only the drawn width while the card stays content-box: under
    // border-box the same declarations draw 124, and every product endpoint
    // would move while this arithmetic still landed on 148.
    const content = cssPx(".product-node", "width");
    const padX = cssPx(".product-node", "padding", 1);
    const border = cssPx(".product-node", "border");
    const accent = cssPx(".product-node.input", "border-left");

    expect(cssBlock(".product-node")).not.toMatch(/box-sizing:/);
    expect(content + 2 * padX + border + accent).toBe(PRODUCT_WIDTH);
  });

  it("sums the drawn chrome to PRODUCT_HEIGHT", () => {
    // The card is a column of two rows. Every term is declared in canvas.css --
    // the line boxes in pixels rather than as ratios -- so the sum is the
    // browser's drawn height and not an estimate of it. The head is the taller
    // of the item sprite and the name's line.
    const border = cssPx(".product-node", "border");
    const padTop = cssPx(".product-node", "padding");
    const padBottom = cssPx(".product-node", "padding", 2);
    const gap = cssPx(".product-node", "gap");
    const head = Math.max(
      cssPx(".ico-28", "height"),
      cssPx(".pn-name", "line-height"),
    );
    const rate =
      cssPx(".pn-rate", "margin-top") + cssPx(".pn-rate", "line-height");

    expect(2 * border + padTop + padBottom + head + gap + rate).toBe(
      PRODUCT_HEIGHT,
    );
  });

  it("puts React Flow's top:50% handle on the port y the model assigns", () => {
    // A product resolves no row, so portOffsetY falls back to the node's
    // vertical centre; the drawn handle sits at 50% of the same drawn box only
    // while PRODUCT_HEIGHT is that box's height.
    const node = productNode("p", 200, 60, PRODUCT_WIDTH, PRODUCT_HEIGHT);

    expect(portOffsetY(node, "ore", "in")).toBe(PRODUCT_HEIGHT / 2);
  });

  it("gives every direction modifier the same accent width", () => {
    // Inputs accent on the left, outputs on the right, and the layout assigns
    // one PRODUCT_WIDTH to all of them; a modifier with its own accent width
    // would draw a card the model does not know about.
    const accent = cssPx(".product-node.input", "border-left");

    expect(cssPx(".product-node.output.target", "border-right")).toBe(accent);
    expect(cssPx(".product-node.output.surplus", "border-right")).toBe(accent);
  });
});

describe("the chip box bounds the widest and tallest rendered chip", () => {
  it("clamps .flow-chip at CHIP_BOX_WIDTH", () => {
    // The de-confliction pass guarantees no overlap only up to this width, so
    // the runtime clamp is what makes the guarantee true of an off-corpus rate.
    expect(cssPx(".flow-chip", "max-width")).toBe(CHIP_BOX_WIDTH);
  });

  it("adds up to CHIP_BOX_HEIGHT from the sprite and the chip chrome", () => {
    // Tallest variant: a 16px item sprite with the chip's vertical padding and
    // border on each side. border-box is what makes the sum the on-screen box.
    const sprite = cssPx(".ico-16", "height");
    const padY = cssPx(".flow-chip", "padding");
    const border = cssPx(".flow-chip", "border");

    expect(cssValue(".flow-chip", "box-sizing")).toBe("border-box");
    expect(sprite + 2 * padY + 2 * border).toBe(CHIP_BOX_HEIGHT);
  });
});

describe("the contrast floor is computed against the painted background", () => {
  it("matches the --ak-bg-canvas custom property", () => {
    // itemColor derives every item hue's lightness lift from this one value.
    // If the stylesheet's ground moves, every contrast result is stale.
    expect(cssValue(":root", "--ak-bg-canvas")).toBe(CANVAS_BG_HEX);
  });
});
