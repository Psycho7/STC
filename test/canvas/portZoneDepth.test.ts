// PORT_ZONE_DEPTH is derived from the rendered recipe row, not chosen freely:
// it is the row's port-side inset, the strip between the card edge and the item
// glyph. The chip-seat exemption reads that constant while the browser reads the
// CSS, so the two must move together. This pins them side by side: editing the
// padding without the constant (or the reverse) fails here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CARD_BORDER,
  PORT_ZONE_DEPTH,
  chipEntersOwnCardBody,
} from "../../src/canvas/chipSeating";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";

const css = readFileSync(
  resolve(process.cwd(), "src/canvas/canvas.css"),
  "utf8",
);

const insetOf = (selector: string, property: string): number => {
  const escaped = selector.replace(/\./g, "\\.");
  const block = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  expect(block, `${selector} rule not found in canvas.css`).not.toBeNull();
  const decl = block![0].match(new RegExp(`${property}:\\s*(\\d+)px`));
  expect(decl, `${selector} has no ${property} in px`).not.toBeNull();
  return Number(decl![1]);
};

describe("PORT_ZONE_DEPTH is coupled to the recipe row inset", () => {
  it("matches .rn-row.input padding-left", () => {
    expect(insetOf(".rn-row.input", "padding-left")).toBe(PORT_ZONE_DEPTH);
  });

  it("matches .rn-row.output padding-right", () => {
    expect(insetOf(".rn-row.output", "padding-right")).toBe(PORT_ZONE_DEPTH);
  });

  it("holds the current value", () => {
    // Second anchor: the CSS-vs-constant pair could be edited in lockstep by a
    // find-and-replace and still silently move the exemption depth.
    expect(PORT_ZONE_DEPTH).toBe(8);
  });
});

describe("the port strip is measured inside the drawn card border", () => {
  it("matches the .recipe-node border width", () => {
    // Anchored at a line start, unlike insetOf above: ".recipe-node" also
    // appears as the tail of the zoom-LOD descendant selectors, which carry no
    // border and would be matched first.
    const block = css.match(/^\.recipe-node\s*\{[^}]*\}/m);
    expect(block, ".recipe-node rule not found in canvas.css").not.toBeNull();
    const decl = block![0].match(/border:\s*(\d+)px/);
    expect(decl, ".recipe-node has no border width in px").not.toBeNull();
    expect(Number(decl![1])).toBe(CARD_BORDER);
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
