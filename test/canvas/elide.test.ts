// Tail-preserving label elision (issue #84): distinct item names must stay
// distinct after truncation on recipe cards. The helper owns the visible
// string; CSS ellipsis is only the fallback for names with no distinguishing
// tail. The five en name families (copper/iron solution bottles, the two
// canned-food bracket families, the syringe bracket family) and their ru,
// ja and zh forms are exercised with a monospace stub estimator so the
// assertions are pure string math, not font metrics.
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

// (name, budget px, expected visible string). Every elided row keeps its
// distinguishing tail whole and puts the ellipsis in front of it.
const CASES: ReadonlyArray<readonly [string, number, string]> = [
  // Parenthesis family, en: suffix "(...)" preserved, base head-truncated.
  ["Cuprium Bottle(Jincao Solution)", 208, `Cuprium${ELLIPSIS}(Jincao Solution)`],
  ["Cuprium Bottle(Jincao Solution)", 176, `Cupr${ELLIPSIS}(Jincao Solution)`],
  ["Cuprium Bottle(Yazhen Solution)", 208, `Cuprium${ELLIPSIS}(Yazhen Solution)`],
  ["Ferrium Bottle(Jincao Solution)", 208, `Ferrium${ELLIPSIS}(Jincao Solution)`],
  // Bracket family, en: the leading space rides with the "[X]" suffix.
  ["Canned Citrome [C]", 104, `Canned C${ELLIPSIS} [C]`],
  ["Canned Citrome [B]", 104, `Canned C${ELLIPSIS} [B]`],
  ["Buck Capsule [C]", 96, `Buck Ca${ELLIPSIS} [C]`],
  ["Yazhen Syringe [C]", 104, `Yazhen S${ELLIPSIS} [C]`],
  // Parenthesis family, ru: Cyrillic base, ASCII parens, same rule.
  [
    "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)",
    208,
    `\u041a\u0443\u043f\u0440\u0438\u0435\u0432${ELLIPSIS}(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)`,
  ],
  [
    "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u044f\u0447\u0436\u044d\u043d\u044f)",
    208,
    `\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f${ELLIPSIS}(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u044f\u0447\u0436\u044d\u043d\u044f)`,
  ],
  [
    "\u0413\u0440\u0435\u0447\u0435\u043a\u0430\u043f\u0441\u0443\u043b\u0430 [C]",
    96,
    `\u0413\u0440\u0435\u0447\u0435\u043a\u0430${ELLIPSIS} [C]`,
  ],
  // ja: no brackets in the canned family -- the trailing Roman-numeral code
  // point is the distinguishing tail and survives alone.
  [
    "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160",
    64,
    `\u30b7\u30c8\u30ed${ELLIPSIS}\u2160`,
  ],
  [
    "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2161",
    64,
    `\u30b7\u30c8\u30ed${ELLIPSIS}\u2161`,
  ],
  // ja parenthesis family: CJK base with a two-CJK-char minimum head.
  [
    "\u8d64\u9285\u30dc\u30c8\u30eb(\u9326\u8349\u30a8\u30ad\u30b9)",
    112,
    `\u8d64\u9285${ELLIPSIS}(\u9326\u8349\u30a8\u30ad\u30b9)`,
  ],
  [
    "\u8d64\u9285\u30dc\u30c8\u30eb(\u82bd\u91dd\u30a8\u30ad\u30b9)",
    112,
    `\u8d64\u9285${ELLIPSIS}(\u82bd\u91dd\u30a8\u30ad\u30b9)`,
  ],
  // zh parenthesis family: same shape as en.
  [
    "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)",
    96,
    `\u8d64\u94dc${ELLIPSIS}(\u9526\u8349\u6eb6\u6db2)`,
  ],
  // A plain two-word name still keeps its last word (the rule fires
  // whenever a name has a distinguishing tail, not only on brackets).
  ["Stabilized Carbon", 96, `Stabi${ELLIPSIS}Carbon`],
];

// Names returned UNCHANGED at the given budget: either the whole name fits,
// there is no distinguishing tail, or no window respecting the minimum
// grapheme floors can fit -- CSS tail ellipsis stays the fallback in every
// one of those cases. (R5: a budget that fits a partial window no longer
// returns the raw string; @168 below became "Cupr...(Jincao Solution" and
// moved into the windowed regime.)
const RAW_CASES: ReadonlyArray<readonly [string, number]> = [
  ["Cuprium Bottle(Jincao Solution)", 248], // fits whole (31 chars x 8px)
  ["Cuprium Bottle(Jincao Solution)", 64], // window below the 4-grapheme floor
  ["Canned Citrome [C]", 144], // fits whole
  ["\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160", 112], // fits whole (9 wide x 12px)
  ["\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160", 40], // roman tail + 2-CJK head too wide
  // zh tier prefixes are a leading affix a tail rule cannot protect (R2):
  // no distinguishing tail, raw string at every budget. Recorded gap.
  ["\u4f18\u8d28\u67d1\u5b9e\u7f50\u5934", 72],
  ["\u4f18\u8d28\u67d1\u5b9e\u7f50\u5934", 48],
  ["Carbon", 24], // single token: the tail IS the name
  ["\u8d64\u9285\u30dc\u30c8\u30eb", 100], // single CJK token
];

describe("canvas/elide", () => {
  it("keeps the distinguishing tail and elides the head", () => {
    for (const [name, budget, expected] of CASES) {
      expect(elideName(name, budget, monoStub, "mono"), `${name} @${budget}`).toBe(
        expected,
      );
    }
  });

  it("returns the raw string when elision cannot preserve a tail", () => {
    for (const [name, budget] of RAW_CASES) {
      expect(elideName(name, budget, monoStub, "mono"), `${name} @${budget}`).toBe(
        name,
      );
    }
  });

  it("keeps family members pairwise distinct at a shared budget", () => {
    const families: ReadonlyArray<readonly [number, readonly string[]]> = [
      [
        208,
        [
          "Cuprium Bottle(Jincao Solution)",
          "Cuprium Bottle(Yazhen Solution)",
          "Ferrium Bottle(Jincao Solution)",
          "Ferrium Bottle(Yazhen Solution)",
        ],
      ],
      [
        104,
        ["Canned Citrome [A]", "Canned Citrome [B]", "Canned Citrome [C]"],
      ],
      [
        64,
        [
          "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160",
          "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2161",
          "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2162",
        ],
      ],
      [
        112,
        [
          "\u8d64\u9285\u30dc\u30c8\u30eb(\u9326\u8349\u30a8\u30ad\u30b9)",
          "\u8d64\u9285\u30dc\u30c8\u30eb(\u82bd\u91dd\u30a8\u30ad\u30b9)",
        ],
      ],
      [
        96,
        ["\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)", "\u8d64\u94dc\u74f6(\u82bd\u9488\u6eb6\u6db2)"],
      ],
    ];
    for (const [budget, names] of families) {
      const visible = names.map((n) => elideName(n, budget, monoStub, "mono"));
      expect(new Set(visible).size, `@${budget}`).toBe(names.length);
      // Each member still ends in its own distinguishing tail.
      for (let i = 0; i < names.length; i++) {
        const vis = visible[i]!;
        const nm = names[i]!;
        expect(vis, nm).toContain(nm.slice(nm.search(/[[(\u2160]/)));
      }
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
        (w, ch) =>
          w +
          (isWideCodePoint(ch.codePointAt(0)!) ? 100 : NARROW_PX),
        0,
      );
    // A tail of wide code points busts the budget under the wide-heavy
    // estimator, so a font-key-blind cache would wrongly replay the elided
    // mono entry computed one line earlier at the same budget.
    const zhParen = "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)";
    expect(elideName(zhParen, 96, monoStub, "mono")).toBe(
      `\u8d64\u94dc${ELLIPSIS}(\u9526\u8349\u6eb6\u6db2)`,
    );
    expect(elideName(zhParen, 96, wideHeavy, "mono-wide")).toBe(zhParen);
  });
});

// Real-budget battery: the production estimator against budgets derived
// from the pinned card geometry exactly the way RecipeNode derives them.
// The refinement-round review found every helper test ran at 96-208px
// while the real row budget is ~86px (the REAL label box on a rate-150
// sprite row; the helper's estimate-derived budget is 81.2px on those rows
// and 89.5px on rate-60 rows). This battery pins the production regime.
describe("canvas/elide real-budget battery", () => {
  const ROW_FONT: TextWidthFont = { fontSize: 12, weight: 400 };
  const RATE_FONT: TextWidthFont = { fontSize: 12, weight: 700 };
  const TITLE_FONT: TextWidthFont = { fontSize: 17, weight: 600 };
  const PRODUCTS_FONT: TextWidthFont = { fontSize: 11, weight: 500 };
  const est = (t: string, font: TextWidthFont) => estimateTextWidth(t, font);

  // Mirrors RecipeNode.elideRowLabel: half of the 300px card body minus
  // the row's 14px horizontal padding, minus the 20px sprite and one 5px
  // gap when a sprite renders, minus one more gap and the upper-bound
  // rate estimate in the number face. rowBudget("150") = 81.196 ->
  // bucket 81; rowBudget("60") = 89.464 -> bucket 89.
  const rowBudget = (rate: string, hasSprite = true): number =>
    150 - 14 - (hasSprite ? 25 : 0) - 5 - est(rate, RATE_FONT);

  // Header budgets from the pinned grid columns (ruling R3).
  const headerContentWidth =
    RECIPE_HEAD_TITLE_COL - 2 * RECIPE_HEAD_BLOCK_PAD_X; // 185

  const elideRow = (name: string, rate: string): string =>
    elideName(name, rowBudget(rate), (t) => est(t, ROW_FONT), "row-12");

  it("keeps the parenthesis-bottle goal pairs distinct at the 86px row budget", () => {
    // The review's headline defect: the two copper bottles may never read
    // the same. Exact expected strings document the window policy (lead
    // window for Latin/CJK brackets, trailing window for Cyrillic).
    const cases: ReadonlyArray<readonly [number, readonly string[], string[]]> =
      [
        [
          86,
          ["Cuprium Bottle(Jincao Solution)", "Cuprium Bottle(Yazhen Solution)"],
          [`Cupr${ELLIPSIS}(Jinc`, `Cupr${ELLIPSIS}(Yazh`],
        ],
        [
          86,
          [
            "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)",
            "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u044f\u0447\u0436\u044d\u043d\u044f)",
          ],
          [
            `\u041a\u0443\u043f\u0440${ELLIPSIS}\u0446\u0430\u043e)`,
            `\u041a\u0443\u043f\u0440${ELLIPSIS}\u044d\u043d\u044f)`,
          ],
        ],
        [
          86,
          [
            "\u8d64\u9285\u30dc\u30c8\u30eb(\u9326\u8349\u30a8\u30ad\u30b9)",
            "\u8d64\u9285\u30dc\u30c8\u30eb(\u82bd\u91dd\u30a8\u30ad\u30b9)",
          ],
          [
            `\u8d64\u9285${ELLIPSIS}(\u9326\u8349\u30a8`,
            `\u8d64\u9285${ELLIPSIS}(\u82bd\u91dd\u30a8`,
          ],
        ],
        [
          86,
          ["\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)", "\u8d64\u94dc\u74f6(\u82bd\u9488\u6eb6\u6db2)"],
          [
            `\u8d64\u94dc${ELLIPSIS}(\u9526\u8349\u6eb6`,
            `\u8d64\u94dc${ELLIPSIS}(\u82bd\u9488\u6eb6`,
          ],
        ],
      ];
    for (const [budget, names, expected] of cases) {
      const visible = names.map((n) =>
        elideName(n, budget, (t) => est(t, ROW_FONT), "row-12"),
      );
      expect(new Set(visible).size, `@${budget}`).toBe(names.length);
      expect(visible).toEqual(expected);
    }
  });

  it("keeps the four-bottle families and the residue goal families distinct at the derived row budgets", () => {
    const families: ReadonlyArray<readonly [string, readonly string[]]> = [
      // multi6 rows carry the bottles at rate 150 (budget 81.196).
      [
        "150",
        [
          "Cuprium Bottle(Jincao Solution)",
          "Cuprium Bottle(Yazhen Solution)",
          "Ferrium Bottle(Jincao Solution)",
          "Ferrium Bottle(Yazhen Solution)",
        ],
      ],
      [
        "150",
        [
          "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)",
          "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u044f\u0447\u0436\u044d\u043d\u044f)",
          // The plain bottle stays raw (its window would fall below the
          // floor) and is still distinct from the windowed solutions.
          "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430",
        ],
      ],
      // Bracket family at rate 300: whole-tail tier.
      ["300", ["Canned Citrome [C]", "Canned Citrome [B]"]],
      // The ru residue families from the validation round, at their real
      // co-rendering rates.
      [
        "60",
        [
          "\u041c\u0435\u043b\u043a\u043e\u043c\u043e\u043b\u043e\u0442\u0430\u044f \u043e\u0440\u0438\u0434\u0436\u0435\u043e\u0434\u0430",
          "\u041c\u0435\u043b\u043a\u043e\u043c\u043e\u043b\u043e\u0442\u044b\u0439 \u043e\u0440\u0438\u0434\u0436\u0438\u043d\u0438\u0439",
        ],
      ],
      [
        "120",
        [
          "\u041c\u0435\u043b\u043a\u043e\u043c\u043e\u043b\u043e\u0442\u0430\u044f \u043e\u0440\u0438\u0434\u0436\u0435\u043e\u0434\u0430",
          "\u041c\u0435\u043b\u043a\u043e\u043c\u043e\u043b\u043e\u0442\u044b\u0439 \u043e\u0440\u0438\u0434\u0436\u0438\u043d\u0438\u0439",
        ],
      ],
      [
        "300",
        [
          "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0434\u0435\u0442\u0430\u043b\u044c",
          "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0440\u0443\u0434\u0430",
        ],
      ],
      [
        "30",
        [
          "\u041f\u0438\u0440\u0440\u043e\u043b\u0438\u0442\u043e\u0432\u0430\u044f \u0434\u0435\u0442\u0430\u043b\u044c",
          "\u041f\u0438\u0440\u0440\u043e\u043b\u0438\u0442\u043e\u0432\u044b\u0439 \u043a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442",
        ],
      ],
      [
        "30",
        [
          "\u0422\u044f\u0436\u0435\u043b\u044b\u0439 \u043a\u0441\u0438\u0440\u0430\u0433\u0435\u043d",
          "\u0422\u044f\u0436\u0435\u043b\u044b\u0439 \u043a\u0441\u0438\u0440\u0430\u043d\u0438\u0442",
        ],
      ],
      // ja sandleaf at rate 600: the powder windows, the seed stays raw
      // (whole tail does not fit, window below the CJK floor) -- distinct.
      [
        "600",
        [
          "\u30b5\u30f3\u30c9\u30ea\u30fc\u30d5\u7c89\u672b",
          "\u30b5\u30f3\u30c9\u30ea\u30fc\u30d5\u306e\u7a2e",
          "\u30b5\u30f3\u30c9\u30ea\u30fc\u30d5",
        ],
      ],
    ];
    for (const [rate, names] of families) {
      const visible = names.map((n) => elideRow(n, rate));
      expect(
        new Set(visible).size,
        `@rate ${rate}: ${visible.join(" | ")}`,
      ).toBe(names.length);
    }
  });

  it("returns no-suffix and guarded names raw at the row budget", () => {
    // No suffix to preserve (CSS tail ellipsis stays the fallback)...
    const raw: ReadonlyArray<readonly [string, string]> = [
      ["300", "Ferrium Powder"],
      ["300", "\u4f18\u8d28\u67d1\u5b9e\u7f50\u5934"],
      // ...and the measured guards: a multi-word base whose last word is
      // the shared generic noun (en powders), and an all-ideograph CJK
      // name with no kana boundary (ja powders) -- both are distinct under
      // the raw clip and must not be windowed.
      ["60", "Dense Originium Powder"],
      ["60", "Dense Crystal Powder"],
      ["120", "\u9ad8\u5bc6\u5ea6\u7d50\u6676\u7c89\u672b"],
      ["120", "\u9ad8\u5bc6\u5ea6\u6e90\u77f3\u7c89\u672b"],
    ];
    for (const [rate, name] of raw) {
      expect(elideRow(name, rate), `${name} @rate ${rate}`).toBe(name);
    }
  });

  it("elides the title surface through the same tiers at the pinned header budget", () => {
    const budget = headerContentWidth; // 201 - 2*8, from dimensions.ts
    const visible = [
      "Cuprium Bottle(Jincao Solution)",
      "Cuprium Bottle(Yazhen Solution)",
    ].map((n) => elideName(n, budget, (t) => est(t, TITLE_FONT), "title-17"));
    expect(new Set(visible).size).toBe(2);
    expect(visible[0]).toBe(`Cupr${ELLIPSIS}(Jincao So`);
    expect(visible[1]).toBe(`Cupr${ELLIPSIS}(Yazhen So`);
    // The zh gate pair fits the whole title column (the jsdom title test
    // covers the chip-bearing, narrower budget).
    expect(
      elideName(
        "\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)",
        budget,
        (t) => est(t, TITLE_FONT),
        "title-17",
      ),
    ).toBe("\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)");
  });

  it("elides the products surface whole-tail at the pinned header budget", () => {
    const budget = headerContentWidth;
    const visible = [
      "Cuprium Bottle(Jincao Solution)",
      "Cuprium Bottle(Yazhen Solution)",
    ].map((n) =>
      elideName(n, budget, (t) => est(t, PRODUCTS_FONT), "products-11"),
    );
    expect(visible[0]).toBe(`Cupriu${ELLIPSIS}(Jincao Solution)`);
    expect(visible[1]).toBe(`Cupriu${ELLIPSIS}(Yazhen Solution)`);
    expect(new Set(visible).size).toBe(2);
  });
});
