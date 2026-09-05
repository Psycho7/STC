import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";

import {
  ELK_LAYER_CONSTRAINT_KEY,
  ROOT_LAYOUT_OPTIONS,
} from "../../src/canvas/layout";

// ELK silently ignores an option id it does not know, so a typo or an id
// retired by an elkjs bump costs a declutter knob with no error anywhere: the
// nine real-layout suites would fail on the shifted geometry without ever
// naming the option that went missing. This test asks ELK itself which ids it
// honours. Enum VALUES stay uncovered -- ELK reports a type, not the legal
// values -- so a bad value still only shows up as a geometry change.

// The option ids layout.ts sets outside ROOT_LAYOUT_OPTIONS. Container, recipe
// and port options live in object literals inside the graph builders rather
// than in an exported constant, so they are listed here by hand.
const PER_NODE_OPTION_IDS = [
  "org.eclipse.elk.padding",
  "org.eclipse.elk.portConstraints",
  "org.eclipse.elk.port.side",
  "org.eclipse.elk.port.index",
  // Wrapping options, applied only above WRAP_MIN_UNITS.
  "elk.aspectRatio",
  "elk.layered.wrapping.strategy",
  ELK_LAYER_CONSTRAINT_KEY,
];

// ELK's registry keys everything under the fully qualified prefix while it
// also accepts the "elk." shorthand layout.ts mostly writes, so normalize
// before the lookup.
function canonical(id: string): string {
  return id.startsWith("org.eclipse.elk.")
    ? id
    : id.replace(/^elk\./, "org.eclipse.elk.");
}

describe("layout ELK options", () => {
  it("every option id layout.ts sets is one ELK knows", async () => {
    const elk = new ELK();
    const known = new Set(
      (await elk.knownLayoutOptions()).map((o) => o.id).filter(Boolean),
    );
    // Guard against a stubbed or empty registry making this vacuous.
    expect(known.size).toBeGreaterThan(100);

    const used = [...Object.keys(ROOT_LAYOUT_OPTIONS), ...PER_NODE_OPTION_IDS];
    expect(used.length).toBeGreaterThan(15);

    const unknown = used.filter((id) => !known.has(canonical(id)));
    expect(unknown).toEqual([]);
  }, 30_000);
});
