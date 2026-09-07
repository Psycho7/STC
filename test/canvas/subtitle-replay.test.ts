// Offline replay of the PRODUCTS-SUBTITLE elision surface over the pinned
// corpus fixture (refinement round 2). The .rn-products box is a two-line
// -webkit-line-clamp that wraps, so the e2e rendered-prefix probe (a
// single-line binary search) cannot faithfully measure what the reader
// sees there; this replay is the subtitle guard instead, recorded in the
// elision plan. It replays every subtitle item name of every corpus page
// (12 fixed scenarios x 4 locales) through the real helper at the real
// budget -- the recipe block's content width, exactly as RecipeNode
// derives it -- and asserts no two DIFFERENT item ids render the same
// string on one page, beyond the recorded byte-identical data pair.
//
// Raw (unelided) outputs are compared by a conservative estimated clip at
// the same budget: the longest prefix whose upper-bound width plus the
// ellipsis fits. Because the estimator is an upper bound and the real box
// wraps to TWO lines (strictly more visible text), the estimate is a
// prefix of the real rendering: estimated-distinct implies real-distinct,
// estimated-identical is a conservative over-report.
//
// The fixture is GENERATED-AND-PINNED: for each corpus page, the deduped
// set of recipe.out item ids of every recipe card the plan renders (the
// same browser dump the row/title replays use; ids resolve to names from
// the pack at run time, so the fixture stays ASCII). Regenerate by
// dumping data-recipe-id per card per page (12 scenarios x 4 locales) and
// re-deriving the sets from recipe-pack.json; names or geometry changes
// that alter the rendered strings must show up here, not silent reuse.
import { describe, it, expect } from "vitest";
import { elideName } from "../../src/canvas/elide";
import { estimateTextWidth } from "../../src/canvas/textWidth";
import {
  RECIPE_HEAD_TITLE_COL,
  RECIPE_HEAD_BLOCK_PAD_X,
} from "../../src/canvas/dimensions";
import namesPack from "../../data/aef/recipe-pack.i18n.json";
import fixture from "./subtitle-replay.fixture.json";

const PRODUCTS_FONT = { fontSize: 11, weight: 500 };
const ELLIPSIS = "\u2026";
const budget = RECIPE_HEAD_TITLE_COL - 2 * RECIPE_HEAD_BLOCK_PAD_X; // 185

// Known data defect (see the elision plan): byte-identical display names
// in all four locales; no elision rule can separate them.
const KNOWN_IDENTICAL_PAIRS = new Set([
  "glass_bottle|transfer_tundra_glass_bottle",
  "transfer_tundra_glass_bottle|glass_bottle",
]);

const names = (
  namesPack as {
    names: Record<string, { items: Record<string, string> }>;
  }
).names;

function estClip(raw: string): string {
  const est = (t: string) => estimateTextWidth(t, PRODUCTS_FONT);
  if (est(raw) <= budget) return raw;
  const pts = [...raw];
  let used = 0;
  let keep = 0;
  const ellW = est(ELLIPSIS);
  for (let i = 0; i < pts.length; i++) {
    const w = est(pts[i]!);
    if (used + w + ellW > budget) break;
    used += w;
    keep = i + 1;
  }
  return pts.slice(0, keep).join("") + ELLIPSIS;
}

describe("canvas/subtitle corpus replay", () => {
  it("keeps subtitle item names per-page distinct beyond the identical pair", () => {
    const pages = fixture as Record<string, string[]>;
    const collisions: string[] = [];
    let replayed = 0;
    for (const [page, items] of Object.entries(pages)) {
      const locale = page.split("/")[1]!;
      const itemNames = names[locale]!.items;
      const seen = new Map<string, string>();
      for (const item of items) {
        const raw = itemNames[item];
        if (raw === undefined) continue;
        replayed++;
        const out = elideName(
          raw,
          budget,
          (t) => estimateTextWidth(t, PRODUCTS_FONT),
          "products-11",
        );
        const visible = out === raw ? estClip(raw) : out;
        const prev = seen.get(visible);
        if (prev === undefined) {
          seen.set(visible, item);
        } else if (
          prev !== item &&
          !KNOWN_IDENTICAL_PAIRS.has(`${prev}|${item}`)
        ) {
          collisions.push(`${page}: "${visible}" ${prev} vs ${item}`);
        }
      }
    }
    // Selector-drift guard: the fixture must still describe a corpus.
    expect(replayed).toBeGreaterThan(500);
    expect(
      collisions,
      `subtitle collisions (beyond the recorded identical-name pair):\n${collisions.join("\n")}`,
    ).toEqual([]);
  });
});
