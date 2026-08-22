import { test, expect } from "vitest";
import { loadI18n, type Locale } from "./i18n";

// Every locale's rate-bearing strings must carry that locale's own unit.
// zh/ja localize the unit as the CJK minute glyph and ru as the Cyrillic
// abbreviation; a Latin "min" leaking into those locales is the Z1 exam family.
const NON_LATIN_UNIT_LOCALES: Locale[] = ["zh", "ja", "ru"];
const RATE_KEYS = [
  "product.tap.share",
  "canvas.chip.share",
  "inputs.rate.cap",
  "inputs.needed",
] as const;

for (const locale of NON_LATIN_UNIT_LOCALES) {
  for (const key of RATE_KEYS) {
    test(`${locale} ${key} carries no Latin min`, () => {
      const s = loadI18n(locale).t(key, { rate: "1", total: "2" });
      expect(s).not.toMatch(/min/i);
    });
  }
}

test("en keeps the Latin unit", () => {
  expect(loadI18n("en").t("product.tap.share", { rate: "1" })).toBe("of 1/min");
});
