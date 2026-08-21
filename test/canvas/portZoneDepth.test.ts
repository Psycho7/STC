// PORT_ZONE_DEPTH is derived from the rendered recipe row, not chosen freely:
// it is the row's port-side inset, the strip between the card edge and the item
// glyph. The chip-seat exemption reads that constant while the browser reads the
// CSS, so the two must move together. This pins them side by side: editing the
// padding without the constant (or the reverse) fails here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PORT_ZONE_DEPTH } from "../../src/canvas/chipSeating";

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
