// Head-first label elision: a name that fits is returned untouched, a name
// that does not keeps the longest head prefix that fits beside the
// ellipsis. Nothing after the cut survives -- no tail, no bracket group,
// no window. Two names that differ only after the cut therefore read the
// same, which is the accepted cost of the rule; the full name stays on the
// `title` attribute. The en/ru/ja/zh families below are exercised with a
// monospace stub estimator so the assertions are pure string math, not
// font metrics.
//
// Supersedes the e2e title-truncation spec (issue #38): with the helper
// owning the title string against the pinned header budget, a DOM
// overflow check is vacuous -- the string is built to fit by construction.
import { describe, it, expect } from "vitest";
import { elideName } from "../../src/canvas/elide";
import {
  estimateTextWidth,
  type TextWidthFont,
} from "../../src/canvas/textWidth";
import {
  RECIPE_HEAD_TITLE_COL,
  RECIPE_HEAD_BLOCK_PAD_X,
} from "../../src/canvas/dimensions";

// Monospace stub: every narrow code point costs 8px, every wide one (CJK,
// kana, fullwidth forms, Roman-numeral code points) 12px, the ellipsis 8px.
// Budgets in the table are multiples of the helper's memo bucket so the
// expectations are exact.
const NARROW_PX = 8;
const WIDE_PX = 12;

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x2160 && cp <= 0x2183)
  );
}

function monoStub(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += isWideCodePoint(ch.codePointAt(0)!) ? WIDE_PX : NARROW_PX;
  }
  return w;
}

const ELLIPSIS = "\u2026";

// (name, budget px, expected visible string). Every elided row is a head
// prefix plus the ellipsis; a cut that would leave a trailing space gives
// the space back.
const CASES: ReadonlyArray<readonly [string, number, string]> = [
  // Parenthesis family, en: the tail goes, whatever it carried.
  [
    "Cuprium Bottle(Jincao Solution)",
    208,
    `Cuprium Bottle(Jincao Sol${ELLIPSIS}`,
  ],
  ["Cuprium Bottle(Jincao Solution)", 176, `Cuprium Bottle(Jincao${ELLIPSIS}`],
  // Bracket family, en: the "[X]" mark is past the cut and is dropped.
  ["Canned Citrome [C]", 104, `Canned Citro${ELLIPSIS}`],
  ["Buck Capsule [C]", 96, `Buck Capsul${ELLIPSIS}`],
  // Cyrillic base, same rule.
  [
    "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)",
    120,
    `\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b${ELLIPSIS}`,
  ],
  // ja: wide code points cost 12px, the trailing Roman numeral is dropped.
  [
    "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160",
    64,
    `\u30b7\u30c8\u30ed\u30fc${ELLIPSIS}`,
  ],
  // zh parenthesis family.
  [
    "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)",
    96,
    `\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6${ELLIPSIS}`,
  ],
  // A plain two-word name loses its last word rather than its head.
  ["Stabilized Carbon", 96, `Stabilized${ELLIPSIS}`],
];

// Names returned UNCHANGED at the given budget: the whole name fits, or
// not even one code point fits beside the ellipsis (then the raw string
// goes back and the CSS clip shows what the box allows).
const RAW_CASES: ReadonlyArray<readonly [string, number]> = [
  ["Cuprium Bottle(Jincao Solution)", 248], // fits whole (31 chars x 8px)
  ["Cuprium Bottle(Jincao Solution)", 8], // only the ellipsis itself fits
  ["Canned Citrome [C]", 144], // fits whole
  ["\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160", 112], // fits whole (9 wide x 12px)
  ["\u4f18\u8d28\u67d1\u5b9e\u7f50\u5934", 72], // fits whole (6 wide x 12px)
  ["Carbon", 48], // fits whole
];

describe("canvas/elide", () => {
  it("keeps the longest head prefix and appends the ellipsis", () => {
    for (const [name, budget, expected] of CASES) {
      expect(
        elideName(name, budget, monoStub, "mono"),
        `${name} @${budget}`,
      ).toBe(expected);
    }
  });

  it("returns the raw string when the name fits or nothing fits", () => {
    for (const [name, budget] of RAW_CASES) {
      expect(
        elideName(name, budget, monoStub, "mono"),
        `${name} @${budget}`,
      ).toBe(name);
    }
  });

  it("drops a distinguishing tail instead of keeping it", () => {
    // Ruling I8: titles elide their tail like everything else, so the
    // machine class word at the end is gone rather than the head.
    const visible = elideName(
      "Solid-Gas Transfer Unit",
      13 * NARROW_PX,
      monoStub,
      "mono",
    );
    expect(visible.endsWith(ELLIPSIS)).toBe(true);
    expect(visible).not.toContain("Unit");
    expect(visible).toBe(`Solid-Gas Tr${ELLIPSIS}`);
  });

  // The bottle [A]/[B]/[C] and solution-bottle distinctness batteries are
  // retired: their members differ only past the cut, so head-first elision
  // renders them identically by design (docs/plans/2026-09-15-catalyst-exam-fixes.md,
  // ruling I8). Distinctness is pinned only where the names differ inside
  // the surviving head.
  it("keeps family members distinct when they differ inside the head", () => {
    const families: ReadonlyArray<readonly [number, readonly string[]]> = [
      [64, ["Cuprium Bottle", "Ferrium Bottle"]],
      [
        96,
        [
          "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)",
          "\u8d64\u94dc\u7f50(\u9526\u8349\u6eb6\u6db2)",
        ],
      ],
    ];
    for (const [budget, names] of families) {
      const visible = names.map((n) => elideName(n, budget, monoStub, "mono"));
      expect(new Set(visible).size, `@${budget}`).toBe(names.length);
    }
  });

  it("memoises without letting budget or font keys collide", () => {
    const name = "Cuprium Bottle(Jincao Solution)";
    const a = elideName(name, 208, monoStub, "mono");
    expect(elideName(name, 208, monoStub, "mono")).toBe(a);
    expect(elideName(name, 176, monoStub, "mono")).not.toBe(a);
    // Budgets quantise DOWN to the bucket, never up past the caller's px
    // (the outputs agree here because no threshold sits between them).
    expect(elideName(name, 209, monoStub, "mono")).toBe(a);
    // The font key identifies the estimator: the same string at the same
    // budget under a different (wider) estimator must not reuse the entry.
    const wideHeavy = (text: string) =>
      [...text].reduce(
        (w, ch) => w + (isWideCodePoint(ch.codePointAt(0)!) ? 100 : NARROW_PX),
        0,
      );
    // Wide code points bust the budget under the wide-heavy estimator, so a
    // font-key-blind cache would wrongly replay the elided mono entry
    // computed one line earlier at the same budget.
    const zhParen = "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)";
    expect(elideName(zhParen, 96, monoStub, "mono")).toBe(
      `\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6${ELLIPSIS}`,
    );
    expect(elideName(zhParen, 96, wideHeavy, "mono-wide")).toBe(zhParen);
  });
});

// Real-budget battery: the production estimator against budgets derived
// from the pinned card geometry exactly the way RecipeNode derives them.
describe("canvas/elide real-budget battery", () => {
  const ROW_FONT: TextWidthFont = { fontSize: 12, weight: 400 };
  const TITLE_FONT: TextWidthFont = { fontSize: 17, weight: 600 };
  const est = (t: string, font: TextWidthFont) => estimateTextWidth(t, font);

  // Mirrors RecipeNode.elideRowLabel: half of the 240px card body minus
  // the row's 14px horizontal padding, minus the 20px sprite and one 5px
  // gap when a sprite renders. rowBudget(true) = 81.
  const rowBudget = (hasSprite = true): number =>
    120 - 14 - (hasSprite ? 25 : 0);

  // Header budget from the pinned grid columns (ruling R3).
  const headerContentWidth =
    RECIPE_HEAD_TITLE_COL - 2 * RECIPE_HEAD_BLOCK_PAD_X; // 171

  const elideRow = (name: string): string =>
    elideName(name, rowBudget(), (t) => est(t, ROW_FONT), "row-12");

  it("never returns a string wider than the row budget", () => {
    const names = [
      "Cuprium Bottle(Jincao Solution)",
      "Canned Citrome [C]",
      "Dense Originium Powder",
      "\u041c\u0435\u043b\u043a\u043e\u043c\u043e\u043b\u043e\u0442\u0430\u044f \u043e\u0440\u0438\u0434\u0436\u0435\u043e\u0434\u0430",
      "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)",
      "\u30b5\u30f3\u30c9\u30ea\u30fc\u30d5\u7c89\u672b",
    ];
    for (const name of names) {
      const visible = elideRow(name);
      expect(est(visible, ROW_FONT), name).toBeLessThanOrEqual(rowBudget());
      if (visible !== name) {
        expect(visible.endsWith("\u2026"), name).toBe(true);
      }
    }
  });

  it("keeps names distinct at the row budget when they diverge inside the head", () => {
    const families: ReadonlyArray<readonly string[]> = [
      ["Cuprium Bottle(Jincao Solution)", "Ferrium Bottle(Jincao Solution)"],
      ["Dense Originium Powder", "Dense Crystal Powder"],
      [
        "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0434\u0435\u0442\u0430\u043b\u044c",
        "\u041f\u0438\u0440\u0440\u043e\u043b\u0438\u0442\u043e\u0432\u0430\u044f \u0434\u0435\u0442\u0430\u043b\u044c",
      ],
      [
        "\u9ad8\u5bc6\u5ea6\u7d50\u6676\u7c89\u672b",
        "\u9ad8\u5bc6\u5ea6\u6e90\u77f3\u7c89\u672b",
      ],
    ];
    for (const names of families) {
      const visible = names.map((n) => elideRow(n));
      expect(new Set(visible).size, `${visible.join(" | ")}`).toBe(
        names.length,
      );
    }
  });

  it("collapses names that differ only past the cut", () => {
    // The accepted cost of ruling I8, pinned so it is a decision rather
    // than a surprise: these pairs read the same on the row and are told
    // apart by the `title` attribute alone.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["Cuprium Bottle(Jincao Solution)", "Cuprium Bottle(Yazhen Solution)"],
      // The heavy-xira residues: "ksiragen" / "ksiranit".
      [
        "\u0422\u044f\u0436\u0435\u043b\u044b\u0439 \u043a\u0441\u0438\u0440\u0430\u0433\u0435\u043d",
        "\u0422\u044f\u0436\u0435\u043b\u044b\u0439 \u043a\u0441\u0438\u0440\u0430\u043d\u0438\u0442",
      ],
    ];
    for (const [a, b] of pairs) {
      const visible = elideRow(a);
      expect(visible.endsWith("\u2026"), a).toBe(true);
      expect(visible, `${a} vs ${b}`).toBe(elideRow(b));
    }
  });

  it("elides the title surface head-first at the pinned header budget", () => {
    const budget = headerContentWidth; // 187 - 2*8, from dimensions.ts
    const visible = elideName(
      "Cuprium Bottle(Jincao Solution)",
      budget,
      (t) => est(t, TITLE_FONT),
      "title-17",
    );
    expect(visible.endsWith("\u2026")).toBe(true);
    expect(visible).not.toContain("Solution");
    expect(est(visible, TITLE_FONT)).toBeLessThanOrEqual(budget);
    // The zh gate pair diverges inside the head, so the titles stay apart.
    const zhTitle = (n: string) =>
      elideName(n, budget, (t) => est(t, TITLE_FONT), "title-17");
    expect(
      zhTitle("\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)"),
    ).not.toBe(
      zhTitle("\u6c61\u6c34\u8282\u70b9(\u4ea7\u7269\u6392\u51fa\u53e3)"),
    );
  });

  it("elides the ru module titles at the real x2.50 chip budget", () => {
    // The chip-bearing title budget cannot hold either module name, and
    // both diverge only past the cut ("Modul upakovki" / "Modul
    // formovki"), so both read "Modul..." and the `title` attribute
    // carries the difference. Budget derived exactly as RecipeNode
    // derives it for the "x2.50" chip.
    const CHIP_FONT: TextWidthFont = { fontSize: 12, weight: 700 };
    const badge = "x2.50";
    const budget =
      headerContentWidth -
      (est(badge, CHIP_FONT) +
        badge.length * 0.04 * CHIP_FONT.fontSize +
        12 + // chip box chrome (2x5px padding + 2x1px border)
        8); // title-to-chip gap
    const upak =
      "\u041c\u043e\u0434\u0443\u043b\u044c \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u0438"; // Packaging Module
    const form =
      "\u041c\u043e\u0434\u0443\u043b\u044c \u0444\u043e\u0440\u043c\u043e\u0432\u043a\u0438"; // Moulding Module
    const visible = [upak, form].map((n) =>
      elideName(n, budget, (t) => est(t, TITLE_FONT), "title-17"),
    );
    expect(budget).toBeCloseTo(107.6416, 3);
    expect(visible[0]).toBe(`\u041c\u043e\u0434\u0443\u043b\u044c\u2026`);
    expect(visible[1]).toBe(visible[0]);
    for (const v of visible) {
      expect(est(v!, TITLE_FONT)).toBeLessThanOrEqual(budget);
    }
  });
});
