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
} from "../../src/canvas/chipSeating";
import {
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  CONTAINER_CAPTION_BAND,
  PRODUCT_HEIGHT,
  PRODUCT_WIDTH,
  RECIPE_FOOTER_HEIGHT,
  RECIPE_HEADER_HEIGHT,
  RECIPE_ROWS_TOP_PAD,
  RECIPE_ROW_HEIGHT,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import { CANVAS_BG_HEX } from "../../src/canvas/itemColor";
import { nodeHeight } from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, productNode, recipeNode } from "./busRouting.testkit";
import { cssBlock, cssPx, cssValue } from "./cssContract";

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
    });
    // Stated absolutely too, so a change to CARD_BORDER cannot move the frame
    // while both sides of the comparison shift with it.
    expect(rect!.right - rect!.left).toBe(302);
    expect(rect!.bottom - rect!.top).toBe(nodeHeight(node) + 2);
  });

  it("leaves a product card at its model box", () => {
    const node = productNode("p", 200, 60, PRODUCT_WIDTH, PRODUCT_HEIGHT);
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Absolute, like the recipe case above: the model box IS the drawn box for
    // a product, so a growth applied here would show up as a moved edge.
    expect(cardRectsFor(nodes, byId)).toEqual([
      { id: "p", left: 200, top: 60, right: 348, bottom: 138 },
    ]);
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

  it("sizes .rn-row at RECIPE_ROW_HEIGHT", () => {
    expect(cssPx(".rn-row", "height")).toBe(RECIPE_ROW_HEIGHT);
  });

  it("sizes .rn-footer at RECIPE_FOOTER_HEIGHT", () => {
    expect(cssPx(".rn-footer", "height")).toBe(RECIPE_FOOTER_HEIGHT);
  });

  it("pads .rn-side by RECIPE_ROWS_TOP_PAD above and below the rows", () => {
    // Shorthand: the first length is the vertical pad, and recipeHeight counts
    // it twice because the same padding repeats under the last row.
    expect(cssPx(".rn-side", "padding")).toBe(RECIPE_ROWS_TOP_PAD);
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

describe("a container's top band clears its caption strip", () => {
  it("reserves at least the .rf-group-caption height", () => {
    // An inequality, not a pair: the band is ELK padding and the surplus is
    // breathing room above the strip. Only a band SHORTER than the caption is
    // a defect -- a member card would then be laid out under the label.
    expect(CONTAINER_CAPTION_BAND).toBeGreaterThanOrEqual(
      cssPx(".rf-group-caption", "height"),
    );
  });
});

describe("the contrast floor is computed against the painted background", () => {
  it("matches the --ak-bg-canvas custom property", () => {
    // itemColor derives every item hue's lightness lift from this one value.
    // If the stylesheet's ground moves, every contrast result is stale.
    expect(cssValue(":root", "--ak-bg-canvas")).toBe(CANVAS_BG_HEX);
  });
});
