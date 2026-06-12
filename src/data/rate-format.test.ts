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

test("ratePerSecToPerMin converts a per-sec rational to a per-minute number", () => {
  expect(ratePerSecToPerMin({ num: "2", denom: "1" })).toBe(120);
  expect(ratePerSecToPerMin({ num: "1", denom: "3" })).toBe(20);
});
