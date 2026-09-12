// Shared reader for the canvas.css side of the TS<->CSS geometry contracts.
//
// Seven suites pin a rule in canvas.css against a TypeScript constant, and each
// used to hand-roll its own readFileSync + regex extractor: an unanchored
// ".recipe-node" matched the zoom-LOD descendant selectors before the card rule,
// and an unescaped selector let every "." match any character. Rather than a
// stricter regex, this parses the stylesheet into rules once and matches whole
// selector-list entries, which is exact by construction and also sees a selector
// that shares a rule with others.

import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// canvas.css with its block comments stripped. Prose goes first so a property
// merely NAMED in a comment cannot stand in for the declaration: .rn-head
// documents its own height:80px, and the controls-button rule quotes the
// vendor's "padding:4px / border:none" it is overriding.
const CSS = readFileSync(
  resolve(process.cwd(), "src/canvas/canvas.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const collapse = (text: string): string => text.trim().replace(/\s+/g, " ");

// Every rule in the stylesheet, as its selector-list entries plus its own text.
// The flat brace scan holds because canvas.css has no nested block (no @media,
// @supports or @layer); a nested one would simply not be indexed here, and the
// selector inside it would read as missing rather than as a wrong match.
const RULES: ReadonlyArray<{ selectors: string[]; text: string }> = [
  ...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g),
].map((m) => ({
  selectors: m[1]!.split(",").map(collapse).filter(Boolean),
  text: m[0]!.trim(),
}));

// The whole rule carrying `selector`, selector list and body, exactly as the
// stylesheet writes it. Whole-entry matching is what keeps ".recipe-node" off
// the zoom-band rules that merely end in it, and the exactly-one check is what
// keeps a later same-selector override from quietly winning in the browser
// while the pin still reads the first rule.
export function cssBlock(selector: string): string {
  const wanted = collapse(selector);
  const hits = RULES.filter((r) => r.selectors.includes(wanted));
  expect(
    hits.length,
    `expected exactly one ${selector} rule in canvas.css, found ${hits.length}`,
  ).toBe(1);
  return hits[0]!.text;
}

// The declared value of one property inside `selector`'s rule. The leading
// brace-or-semicolon boundary keeps a request for "border" off "border-left".
export function cssValue(selector: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = cssBlock(selector).match(
    new RegExp(`[;{]\\s*${escaped}:\\s*([^;}]*)`),
  );
  expect(
    decl,
    `${selector} declares no ${property} in canvas.css`,
  ).not.toBeNull();
  return collapse(decl![1]!);
}

// The nth length in that value, so a shorthand can be read positionally
// (padding: 8px 10px 9px -> index 1 is the horizontal pad). A bare 0 counts as
// a length, so "padding: 0 6px" reads 0 at index 0 instead of silently sliding
// the whole shorthand one place left.
export function cssPx(selector: string, property: string, index = 0): number {
  const lengths = cssValue(selector, property)
    .split(" ")
    .filter((token) => /^-?\d+(?:\.\d+)?px$/.test(token) || token === "0")
    .map((token) => Number.parseFloat(token));
  const value = lengths[index];
  expect(
    value,
    `${selector} ${property} has no length at position ${index}`,
  ).toBeDefined();
  return value!;
}
