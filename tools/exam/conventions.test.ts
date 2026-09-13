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
  "Fan-out and fan-in",
  "Rate chips",
  "Intentional behaviours",
  "Locale notes",
];

const headingLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.startsWith("#"));

// The body under one `## ` heading, up to the next one. Which section a rule
// sits in is itself a claim the doc makes: an evaluator reading an `en` capture
// is told to skip Locale notes, so a rule parked there is a rule it never sees.
const section = (text: string, name: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

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

  // The unit mix is visible in `en` on its own: the kind row is uppercased by
  // CSS, so `/MIN` can sit beside `/min` with no locale involved. The rule
  // therefore belongs in Rate chips; in Locale notes an `en` evaluator, told to
  // skip that section, would never be briefed on it.
  test("states the one-unit rule where an en evaluator reads it", () => {
    const chips = flat(section(doc(), "Rate chips"));
    expect(chips).toContain("all draw from one formatter");
    expect(chips).toContain("`/min` beside `/MIN`");
    expect(chips).toContain("is a defect and not a style");
    expect(flat(section(doc(), "Locale notes"))).not.toContain("`/MIN`");
  });

  // The placement rule, per chip kind. An evaluator that has not been told it
  // reads a chip standing off-centre on its run as a seating failure.
  test("states the placement rule per chip kind", () => {
    const chips = flat(section(doc(), "Rate chips"));
    expect(chips).toContain("the centre of the longest horizontal run");
    expect(chips).toContain("one port stub out of the port it labels");
    expect(chips).toContain("the stretch that is the member's alone");
    expect(chips).toContain(
      "a chip on a vertical or on a chamfered corner is a defect",
    );
  });

  // The reserve model is why a trunk chip stands out from its port with empty
  // corridor beside it - the shape most likely to be filed as a stray chip.
  test("states the reserve model a trunk chip stands in", () => {
    const chips = flat(section(doc(), "Rate chips"));
    expect(chips).toContain("each gap between two layers is widened");
    expect(chips).toContain("a dot keep-off on the column side");
    expect(chips).toContain("inside its own side's zone");
    expect(chips).toContain("a trunk chip out among the columns");
  });

  // The three LOD bands, and the fact that nothing else removes a chip: an
  // icon-only square is the level of detail, not a lost rate.
  test("states the three zoom bands and the single cause of them", () => {
    const chips = flat(section(doc(), "Rate chips"));
    expect(chips).toContain("from zoom 0.5 up a chip draws in full");
    expect(chips).toContain("between 0.35 and 0.5 it draws as its item icon");
    expect(chips).toContain("below 0.35 it is not drawn at all");
    expect(chips).toContain("no chip is hidden for lack of room");
  });

  // Mechanisms the renderer no longer has. A doc that still describes one
  // teaches an evaluator to look for a shape the canvas cannot draw.
  test("describes no chip collapse the renderer cannot produce", () => {
    const text = flat(doc());
    expect(text).not.toContain("contested");
    expect(text).not.toContain("too short for its box");
    expect(text).not.toContain("deliberately hidden");
  });
});
