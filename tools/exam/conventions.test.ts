// The render-conventions doc is the evaluator's only briefing on what the canvas
// is TRYING to draw, and the workflow splices it in whole through
// `args.conventions`. Nothing else checks it: a heading renamed here silently
// drops the section the prompt promises, and a rule that drifted from the code
// teaches a cold evaluator to file the intended behaviour as a defect.
//
// So this pins the two things a reader of the doc cannot verify by reading it:
// the sections the prompt refers to are present and in order, and the rules that
// were corrected against the renderer are still stated.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// From the repo root, which is Vitest's own root here.
const DOC_PATH = resolve(process.cwd(), "docs/render-conventions.md");

const doc = (): string => readFileSync(DOC_PATH, "utf8");

// The doc is hard-wrapped prose, so a sentence it states is split across lines
// at a width nobody should have to preserve to keep this test green. Every
// phrase below is matched against the collapsed text instead.
const flat = (text: string): string => text.replace(/\s+/g, " ");

// The section names the workflow's evaluator prompt and the skill both name.
const SECTIONS = [
  "Cards",
  "Edges",
  "Bus lanes",
  "Fan-out and fan-in",
  "Rate chips",
  "Intentional behaviours",
  "Locale notes",
];

const headingLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.startsWith("#"));

describe("docs/render-conventions.md", () => {
  test("carries every section the prompt refers to, in order", () => {
    const found = headingLines(doc())
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    expect(found).toEqual(SECTIONS);
  });

  // The body deliberately carries CJK examples; a heading must not, because it
  // is what the prompt and this test address a section by.
  test("keeps every heading ASCII", () => {
    for (const line of headingLines(doc())) {
      // eslint-disable-next-line no-control-regex
      expect({ line, ascii: /^[\x00-\x7F]*$/.test(line) }).toEqual({
        line,
        ascii: true,
      });
    }
  });

  // The lone-trunk rule, as BusEdge renders it. The earlier prompt said the
  // chip draws twice, which is only the short-run half.
  test("states the lone-trunk rule the renderer actually follows", () => {
    const text = flat(doc());
    expect(text).toContain("A lone lane trunk draws no junction dot");
    expect(text).toContain("only the rise chip draws");
    expect(text).toContain("both the rise and the drop chip draw");
    expect(text).toContain(
      "the drop chip returns whenever the rise chip is hidden",
    );
  });

  // The second cause of a collapsed branch chip, alongside the short leg.
  test("names the contested fan-out corridor as a second icon-only cause", () => {
    const text = flat(doc());
    expect(text).toContain("the corridor is contested");
    expect(text).toContain("closer together than a chip is wide");
    expect(text).toContain("render icon-only");
    expect(text).toContain("rates stay on the target cards");
  });
});
