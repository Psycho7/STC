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
// there is no distinguishing tail, or the tail plus the minimum head cannot
// fit -- CSS tail ellipsis stays the fallback in every one of those cases.
const RAW_CASES: ReadonlyArray<readonly [string, number]> = [
  ["Cuprium Bottle(Jincao Solution)", 248], // fits whole (31 chars x 8px)
  ["Cuprium Bottle(Jincao Solution)", 168], // suffix + min head + ellipsis too wide
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
    // Budgets quantise DOWN to the bucket, never up past the caller's px.
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
