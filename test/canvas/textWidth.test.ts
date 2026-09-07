// Upper-bound width estimator for canvas label elision. The estimator is
// deliberately font-metric-free: it must never UNDER-estimate a rendered
// string, because eliding slightly early only costs a few pixels of name
// while under-estimating recreates the clipped-label defect. The in-browser
// ground truth used here is the measurement recorded next to CHIP_GLYPH_PX
// in chipSeating.ts: across the app's number-font stack at 11px / weight
// 700, the WIDEST ASCII digit measures 6.89px in the live webfont and
// 6.50px in generic monospace substitution.
import { describe, it, expect } from "vitest";
import {
  estimateCharWidth,
  estimateTextWidth,
} from "../../src/canvas/textWidth";

const CHIP_GLYPH_LIVE_PX = 6.89;
const CHIP_GLYPH_FALLBACK_PX = 6.5;

describe("canvas/textWidth", () => {
  it("charges every ASCII digit at or above the in-browser chip bound", () => {
    for (const d of "0123456789") {
      const w = estimateCharWidth(d, { fontSize: 11, weight: 700 });
      expect(w).toBeGreaterThanOrEqual(CHIP_GLYPH_LIVE_PX);
      expect(w).toBeGreaterThanOrEqual(CHIP_GLYPH_FALLBACK_PX);
    }
  });

  it("charges every Cyrillic class at or above the measured in-browser bound", () => {
    const font = { fontSize: 12, weight: 400 };
    // Per-char advances measured in the live label font and its
    // substitution faces (Liberation Sans = Arial metrics, Liberation
    // Mono, generic sans/serif; recorded in the textWidth.ts header):
    // widest non-wide lowercase 7.5px (U+044A), plain lowercase 7.2px in
    // the mono substitution, non-wide uppercase 9.5px (U+042A), wide
    // lowercase 9.88px (U+0449/U+0444), wide uppercase 11.09px (U+0416),
    // extra-wide uppercase 12.34px (U+042E in the serif fallback).
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["\u044a", 7.5],
      ["\u043e", 7.2],
      ["\u042a", 9.5],
      ["\u0449", 9.88],
      ["\u0444", 9.88],
      ["\u0416", 11.09],
      ["\u042e", 12.34],
    ];
    for (const [ch, bound] of cases) {
      expect(estimateCharWidth(ch, font), ch).toBeGreaterThanOrEqual(bound);
    }
  });

  it("counts CJK and fullwidth characters as exactly one em", () => {
    const font = { fontSize: 12, weight: 400 };
    // Han, kana, fullwidth Latin, fullwidth punctuation.
    for (const ch of ["\u6f22", "\u30ab", "\uff21", "\uff01"]) {
      expect(estimateCharWidth(ch, font)).toBe(12);
    }
    // One em at any size, so budgets scale with the font.
    expect(estimateCharWidth("\u6f22", { fontSize: 17, weight: 600 })).toBe(
      17,
    );
    expect(estimateCharWidth("\u30ab", { fontSize: 11, weight: 500 })).toBe(
      11,
    );
  });

  it("scales linearly with font size and adds up per character", () => {
    const half = estimateTextWidth("Cuprium", { fontSize: 6, weight: 400 });
    const full = estimateTextWidth("Cuprium", { fontSize: 12, weight: 400 });
    expect(full).toBeCloseTo(half * 2, 5);
    const font = { fontSize: 12, weight: 400 };
    const a = estimateTextWidth("Cuprium", font);
    const b = estimateTextWidth(" Bottle", font);
    expect(estimateTextWidth("Cuprium Bottle", font)).toBeCloseTo(a + b, 5);
  });

  it("never returns zero or negative width for printable input", () => {
    for (const text of ["a", "0", ".", " ", "\u2026", "\u8d64\u94dc\u74f6"]) {
      expect(
        estimateTextWidth(text, { fontSize: 12, weight: 400 }),
      ).toBeGreaterThan(0);
    }
  });
});
