import { expect, test } from "vitest";
import Fraction from "fraction.js";
import {
  formatRatePerMin,
  formatRationalPerMin,
  ratePerSecToPerMin,
} from "./rate-format";

test("formatRationalPerMin shows a non-terminating rate as an exact fraction", () => {
  // 40/27 per sec * 60 = 800/9 per min (non-terminating decimal).
  expect(formatRationalPerMin({ num: "40", denom: "27" })).toBe("800/9");
  // Whole per-minute values collapse to a plain integer.
  expect(formatRationalPerMin({ num: "2", denom: "1" })).toBe("120");
});

test("formatRatePerMin keeps a normal sub-unit rate unchanged", () => {
  // 1/600 per sec * 60 = 0.1 per min.
  expect(formatRatePerMin(new Fraction("1").div("600"))).toBe("0.1");
});

test("formatRatePerMin returns empty for exact zero", () => {
  expect(formatRatePerMin(new Fraction(0))).toBe("");
});

test("formatRatePerMin never collapses a tiny nonzero rate to 0", () => {
  // 1/20000 per sec * 60 = 0.003 per min, below toFixed(2) resolution. Must
  // fall back to the exact fraction instead of rendering a "0/min" chip.
  expect(formatRatePerMin(new Fraction("1").div("20000"))).toBe("3/1000");
});

test("formatRatePerMin never renders -0 for a tiny negative rate", () => {
  // toFixed(2) on -0.003 yields "-0"; the exact-fraction fallback keeps the
  // sign and the magnitude.
  expect(formatRatePerMin(new Fraction("-1").div("20000"))).toBe("-3/1000");
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
