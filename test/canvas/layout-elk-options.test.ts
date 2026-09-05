import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";

// ELK silently ignores an option id it does not know, so a typo or an id
// retired by an elkjs bump costs a declutter knob with no error anywhere: the
// real-layout suites would fail on the shifted geometry without ever naming the
// option that went missing. This test asks ELK itself which ids it honours.
// Enum VALUES stay uncovered -- ELK reports a type, not the legal values -- so
// a bad value still only shows up as a geometry change.

const LAYOUT_SRC = join("src", "canvas", "layout.ts");

// Scan the source rather than import the option objects: only the root set is
// exported, and the container, recipe and port options live in object literals
// inside the graph builders. A comment mentioning an id is scanned too, which
// costs nothing -- a real id passes and a stale one is worth knowing about.
function optionIdsInLayoutSource(): string[] {
  const src = readFileSync(LAYOUT_SRC, "utf-8");
  const found =
    src.match(/"(?:org\.eclipse\.)?elk\.[A-Za-z][A-Za-z.]*"/g) ?? [];
  return [...new Set(found.map((m) => m.slice(1, -1)))].sort();
}

// ELK's registry keys everything under the fully qualified prefix while it also
// accepts the "elk." shorthand layout.ts mostly writes, so normalize before the
// lookup.
function canonical(id: string): string {
  return id.startsWith("org.eclipse.elk.")
    ? id
    : id.replace(/^elk\./, "org.eclipse.elk.");
}

describe("layout ELK options", () => {
  it("every option id named in layout.ts is one ELK knows", async () => {
    const elk = new ELK();
    const known = new Set(
      (await elk.knownLayoutOptions()).map((o) => o.id).filter(Boolean),
    );
    // Guard against a stubbed or empty registry making this vacuous.
    expect(known.size).toBeGreaterThan(100);

    const used = optionIdsInLayoutSource();
    // Guard against the scan silently matching nothing.
    expect(used.length).toBeGreaterThan(15);

    const unknown = used.filter((id) => !known.has(canonical(id)));
    expect(unknown).toEqual([]);
  }, 30_000);
});
