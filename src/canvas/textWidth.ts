// Char-class width estimator for canvas label elision. The repo has no
// runtime text measurement (jsdom returns 0 for scrollWidth and rects), so
// the elision helper needs a numeric width and this module supplies an
// UPPER BOUND by design: it must never under-estimate a rendered string,
// because eliding slightly early only costs a few pixels of name, while
// under-estimating hands the string back to CSS ellipsis and recreates the
// clipped-label defect the helper exists to fix.
//
// Each ratio below is the widest plausible advance of its class across the
// font stacks the elided surfaces render in -- the UI sans ("Noto Sans
// SC" / "Source Han Sans" / "PingFang SC" / generic sans), the display
// serif ("Noto Serif SC" stack), and the number face for rate estimates
// ("Space Grotesk" / "JetBrains Mono" / monospace) -- including the case
// where a remote webfont never arrives and the browser substitutes. The
// ground truth for the digit ratio is the in-browser measurement recorded
// next to CHIP_GLYPH_PX in chipSeating.ts: the widest ASCII digit at
// 11px / weight 700 measures 6.89px live and 6.50px under substitution,
// i.e. 0.626em. CJK, kana, Hangul, fullwidth forms, CJK punctuation and
// the Roman-numeral code points are exactly one em in every Han font, so
// they are charged one em; the bold factor does NOT apply to them (Han
// faces keep the same advance across weights, and the elision unit test
// pins one em exactly). Anything unclassified also charges one em: the
// safest wrong answer for an unknown glyph is a full square.
//
// A per-class upper bound inflates a long run of mixed-width letters
// (~20-25% over its true width), so tail preservation conservatively
// declines on the longest latin tails; that is the safe direction. This
// module is deliberately independent of chipSeating.ts: chips keep their
// own digit-only bound (frozen surface), while this table answers to the
// label elision budgets only.

export type TextWidthFont = {
  fontSize: number;
  weight: number;
};

// Class ratios in em. See the header: each bounds the widest plausible
// advance of its class across the app's font stacks.
const RATIO_DIGIT = 0.65;
const RATIO_LATIN_LOWER = 0.65;
const RATIO_LATIN_UPPER = 0.8;
// m/w and their uppercase forms are the widest Latin letters in every
// stack that matters (up to ~0.99em in the sans fallbacks).
const RATIO_LATIN_WIDE = 1;
const RATIO_CYRILLIC_LOWER = 0.7;
const RATIO_CYRILLIC_UPPER = 0.84;
// The wide Cyrillic letters (zh, sh, shch, yu, y and their uppercase
// forms) reach a full em in the fallbacks.
const RATIO_CYRILLIC_WIDE = 1;
const RATIO_SPACE = 0.42;
// Punctuation must cover the monospace fallbacks (0.6em advance for every
// glyph, including "." in rate estimates).
const RATIO_PUNCT = 0.62;
// A few marks render near a full em everywhere.
const RATIO_PUNCT_WIDE = 1;
// The horizontal ellipsis renders FULL WIDTH (1em) in the Han faces; the
// Latin stacks are narrower, so 1em bounds both.
const RATIO_ONE_EM = 1;
// Small bold factor for the proportional classes between 400 and 700.
const BOLD_FACTOR = 1.06;
const BOLD_MIN_WEIGHT = 600;

const LATIN_WIDE_CHARS = new Set("mMwW");
const CYRILLIC_WIDE_CHARS = new Set(
  "\u0436\u043c\u0448\u0449\u044e\u044b\u0416\u041c\u0428\u0429\u042e\u042b",
);
const PUNCT_WIDE_CHARS = new Set("@&%");

// One-em code points: CJK, kana, Hangul, fullwidth forms, Roman numerals.
// Shared with the elision helper, which uses the class to pick the minimum
// readable head (two code points for a CJK base, four otherwise).
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, kana, Han, Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
    (cp >= 0x2160 && cp <= 0x2183) // Roman numerals
  );
}

// Width of ONE code point (the first in `ch`) in px, an upper bound. Treat
// an empty string as zero-width; callers pass single characters.
export function estimateCharWidth(ch: string, font: TextWidthFont): number {
  const first = ch.codePointAt(0);
  if (first === undefined) return 0;
  let ratio: number;
  // Wide glyphs and the ellipsis are exactly one em at every weight; the
  // bold factor does not apply to them.
  let boldable = false;
  if (isWideCodePoint(first) || first === 0x2026) {
    ratio = RATIO_ONE_EM;
  } else if (first === 0x20 || first === 0xa0) {
    ratio = RATIO_SPACE;
    boldable = true;
  } else if (first >= 0x30 && first <= 0x39) {
    ratio = RATIO_DIGIT;
    boldable = true;
  } else if (first >= 0x61 && first <= 0x7a) {
    ratio = LATIN_WIDE_CHARS.has(ch) ? RATIO_LATIN_WIDE : RATIO_LATIN_LOWER;
    boldable = true;
  } else if (first >= 0x41 && first <= 0x5a) {
    ratio = LATIN_WIDE_CHARS.has(ch) ? RATIO_LATIN_WIDE : RATIO_LATIN_UPPER;
    boldable = true;
  } else if (first >= 0x400 && first <= 0x4ff) {
    if (CYRILLIC_WIDE_CHARS.has(ch)) ratio = RATIO_CYRILLIC_WIDE;
    else if (first >= 0x41d) ratio = RATIO_CYRILLIC_UPPER;
    else ratio = RATIO_CYRILLIC_LOWER;
    boldable = true;
  } else if (first >= 0x20 && first <= 0x7e) {
    // Remaining printable ASCII: punctuation and symbols.
    ratio = PUNCT_WIDE_CHARS.has(ch) ? RATIO_PUNCT_WIDE : RATIO_PUNCT;
    boldable = true;
  } else {
    // Unknown script: charge a full em.
    ratio = RATIO_ONE_EM;
  }
  if (boldable && font.weight >= BOLD_MIN_WEIGHT) ratio *= BOLD_FACTOR;
  return ratio * font.fontSize;
}

// Width of a whole string in px: the sum of its code points' bounds. No
// kerning, ligatures or letter-spacing tracking is credited (negative
// tracking only narrows), so the sum stays an upper bound.
export function estimateTextWidth(text: string, font: TextWidthFont): number {
  let w = 0;
  for (const ch of text) w += estimateCharWidth(ch, font);
  return w;
}
