import { expect, test } from "vitest";
import Fraction from "fraction.js";
import {
  formatRateExactPerMin,
  formatRatePerMin,
  formatRationalPerMin,
  parsePerMinToRatePerSec,
  ratePerSecToPerMin,
} from "./rate-format";

test("formatRateExactPerMin reveals the un-rounded value the display rounds", () => {
  // 1/7 per sec * 60 = 60/7 = 8.571428..., which formatRatePerMin rounds to
  // "8.57"; the exact tooltip shows the full-precision decimal instead.
  expect(formatRateExactPerMin(new Fraction(1, 7))).toBe(String(60 / 7));
  // A tiny rate the display would show as a fraction still reads exactly.
  expect(formatRateExactPerMin(new Fraction("1").div("12000"))).toBe(
    String((1 / 12000) * 60),
  );
});

test("formatRateExactPerMin returns empty for exact zero", () => {
  expect(formatRateExactPerMin(new Fraction(0))).toBe("");
});

test("formatRateExactPerMin never returns exponential text", () => {
  // 1/600000000 per sec * 60 = 1e-7 per min; String() would go exponential, so
  // the exact fraction form is used instead.
  const out = formatRateExactPerMin(new Fraction("1").div("600000000"));
  expect(out.includes("e")).toBe(false);
  expect(out.includes("E")).toBe(false);
});

test("formatRationalPerMin rounds a non-terminating rate to the shared decimal", () => {
  // 40/27 per sec * 60 = 800/9 = 88.888.../min. The rational readout now uses
  // the same decimal core as the canvas chips instead of a vulgar fraction.
  expect(formatRationalPerMin({ num: "40", denom: "27" })).toBe("88.89");
  // Whole per-minute values collapse to a plain integer.
  expect(formatRationalPerMin({ num: "2", denom: "1" })).toBe("120");
});

test("formatRatePerMin and formatRationalPerMin agree on the same rate", () => {
  // The chip (Fraction) and sidebar (RationalString) formatters share one core,
  // so a screen never mixes "6/5" with a decimal for the same value.
  expect(formatRatePerMin(new Fraction(1, 7))).toBe(
    formatRationalPerMin({ num: "1", denom: "7" }),
  );
  expect(formatRatePerMin(new Fraction("1").div("12500"))).toBe(
    formatRationalPerMin({ num: "1", denom: "12500" }),
  );
});

test("formatRatePerMin uses significant digits below 0.01, never a slash", () => {
  // 1/12000 per sec * 60 = 0.005/min. toFixed(2) rounded this to "0.01" (2x the
  // real flow); significant digits keep it honest and slash-free.
  expect(formatRatePerMin(new Fraction("1").div("12000"))).toBe("0.005");
  // 1/12500 per sec * 60 = 0.0048/min, which used to flip to "3/625".
  const tiny = formatRatePerMin(new Fraction("1").div("12500"));
  expect(tiny).toBe("0.0048");
  expect(tiny.includes("/")).toBe(false);
});

test("formatRationalPerMin never emits a slash (no double-slash unit text)", () => {
  // A non-terminating rational used to render "3/625", composing to "3/625/min".
  expect(formatRationalPerMin({ num: "1", denom: "12500" }).includes("/")).toBe(
    false,
  );
});

test("formatRatePerMin keeps a normal sub-unit rate unchanged", () => {
  // 1/600 per sec * 60 = 0.1 per min.
  expect(formatRatePerMin(new Fraction("1").div("600"))).toBe("0.1");
});

test("formatRatePerMin rounds a >1 non-whole per-minute value to two decimals", () => {
  // 1/7 per sec * 60 = 60/7 = 8.5714..., toFixed(2) then trailing-zero trim.
  expect(formatRatePerMin(new Fraction(1, 7))).toBe("8.57");
});

test("formatRationalPerMin does not suppress an exact-zero rational", () => {
  // The rational layer renders "0" rather than the empty-string suppression
  // formatRatePerMin applies to Fraction zero.
  expect(formatRationalPerMin({ num: "0", denom: "1" })).toBe("0");
});

test("formatRatePerMin returns empty for exact zero", () => {
  expect(formatRatePerMin(new Fraction(0))).toBe("");
});

test("formatRatePerMin never collapses a tiny nonzero rate to 0", () => {
  // 1/20000 per sec * 60 = 0.003 per min, below toFixed(2) resolution. The
  // significant-digit path keeps the magnitude as a decimal instead of "0".
  expect(formatRatePerMin(new Fraction("1").div("20000"))).toBe("0.003");
});

test("formatRatePerMin never renders -0 for a tiny negative rate", () => {
  // -0.003/min keeps its sign and magnitude as a decimal.
  expect(formatRatePerMin(new Fraction("-1").div("20000"))).toBe("-0.003");
});

test("formatRatePerMin keeps the sign on a negative whole per-minute rate", () => {
  // fraction.js v5 keeps the sign in .s with .n absolute; the integer branch
  // must not read .n alone or -2/s would render as "120".
  expect(formatRatePerMin(new Fraction(-2))).toBe("-120");
  // Negative non-integer rates already go through the sign-correct decimal branch.
  expect(formatRatePerMin(new Fraction("-1").div("40"))).toBe("-1.5");
});

test("ratePerSecToPerMin converts a per-sec rational to per-minute input text", () => {
  expect(ratePerSecToPerMin({ num: "2", denom: "1" })).toBe("120");
  expect(ratePerSecToPerMin({ num: "1", denom: "3" })).toBe("20");
  // Ordinary fractional rates stay plain decimals.
  expect(ratePerSecToPerMin({ num: "1", denom: "40" })).toBe("1.5");
});

// The panel parsers (new Fraction(text)) reject exponent notation, so the
// display text must never go exponential or the next edit silently reverts.
// Tiny values fall back to the exact fraction form ("1/10000000"), which the
// parsers accept; huge integers stringify in full digits.
test("ratePerSecToPerMin round-trips a tiny rate through the panel parser", () => {
  // per-min 0.0000001 -> per-sec 1/600000000. Number stringification would
  // emit "1e-7", which Fraction cannot parse.
  const rps = { num: "1", denom: "600000000" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(reparsed.equals(new Fraction("1/600000000"))).toBe(true);
});

test("ratePerSecToPerMin round-trips a huge rate through the panel parser", () => {
  // per-min 1e21 -> Number stringification would emit "1e+21".
  const rps = { num: "1000000000000000000000", denom: "60" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(
    reparsed.equals(new Fraction("1000000000000000000000").div(60)),
  ).toBe(true);
});

test("ratePerSecToPerMin round-trips a beyond-double rate through the panel parser", () => {
  // per-min 1e309 overflows Number to Infinity; String(Infinity) = "Infinity"
  // has no exponent marker, so the e/E check alone would emit text the panel
  // parsers reject. Must fall back to the exact fraction form.
  const perMinDigits = `1${"0".repeat(309)}`;
  const rps = { num: perMinDigits, denom: "60" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(reparsed.equals(new Fraction(perMinDigits).div(60))).toBe(true);
});

test("parsePerMinToRatePerSec parses integer, decimal, and rational text", () => {
  // 120/min = 2/s; 30.5/min = 61/120 per sec; "1/3"/min = 1/180 per sec.
  expect(parsePerMinToRatePerSec("120")).toEqual({ num: "2", denom: "1" });
  expect(parsePerMinToRatePerSec("30.5")).toEqual({ num: "61", denom: "120" });
  expect(parsePerMinToRatePerSec("1/3")).toEqual({ num: "1", denom: "180" });
  // A whole-number result still carries an explicit "1" denominator.
  expect(parsePerMinToRatePerSec("0")).toEqual({ num: "0", denom: "1" });
});

test("parsePerMinToRatePerSec rejects negatives, garbage, and empty text", () => {
  expect(parsePerMinToRatePerSec("-5")).toBeUndefined();
  expect(parsePerMinToRatePerSec("abc")).toBeUndefined();
  // Fraction throws on the empty string; what "no text" means stays with the
  // caller (useRateEdit's emptyMeans).
  expect(parsePerMinToRatePerSec("")).toBeUndefined();
  expect(parsePerMinToRatePerSec("   ")).toBeUndefined();
});
