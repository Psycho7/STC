// Every shipped locale's rate unit stays inside the width the seat reserves for
// it. CHIP_UNIT_MAX_PX is one number standing in for every locale's
// canvas.rate.unit, measured in a browser; jsdom cannot measure px, so this is
// an explicit PROXY on the glyph count the measurement was taken at, and the
// Playwright width-bound spec stays the real check. It closes a hole that spec
// cannot: chip-widths pins its unit strings as a literal two-entry map, so a
// third locale is invisible to it.

import { describe, it, expect } from "vitest";

import { loadI18n, type Locale } from "../../src/data/i18n";
import { CHIP_UNIT_MAX_PX } from "../../src/canvas/chipMetrics";

// Exhaustive by construction: Record<Locale, ...> stops compiling when Locale
// gains a member, so a new locale cannot reach the canvas without passing
// through this table.
const ALL_LOCALES: Record<Locale, true> = { en: true, zh: true };
const LOCALES = Object.keys(ALL_LOCALES) as Locale[];

// What the 34px bound was measured at: a slash plus three Latin or Cyrillic
// letters, or a slash plus one Han glyph (roughly twice as wide each).
const MAX_LATIN_GLYPHS = 4;
const MAX_CJK_GLYPHS = 2;
const CJK =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

describe("every supported locale's rate unit stays inside the reserved width", () => {
  for (const locale of LOCALES) {
    it(`${locale} draws a unit the ${CHIP_UNIT_MAX_PX}px bound was measured at`, () => {
      const unit = loadI18n(locale).t("canvas.rate.unit");
      const glyphs = [...unit].length;
      const limit = CJK.test(unit) ? MAX_CJK_GLYPHS : MAX_LATIN_GLYPHS;

      expect(
        glyphs,
        `${locale} canvas.rate.unit is "${unit}" (${glyphs} glyphs), wider than ` +
          `the ${limit} CHIP_UNIT_MAX_PX was measured at: re-justify the ` +
          `constant against a browser measurement before shipping this locale`,
      ).toBeLessThanOrEqual(limit);
    });
  }
});
