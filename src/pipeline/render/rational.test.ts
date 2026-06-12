import { expect, test } from "vitest";
import Fraction from "fraction.js";
import { rationalFromString, rationalToString } from "./rational";

test("rationalToString serializes a non-negative Fraction", () => {
  expect(rationalToString(new Fraction(3, 4))).toEqual({
    num: "3",
    denom: "4",
  });
  expect(rationalToString(new Fraction(0))).toEqual({ num: "0", denom: "1" });
});

test("rationalToString round-trips through rationalFromString", () => {
  const f = new Fraction("40/27");
  expect(rationalFromString(rationalToString(f)).equals(f)).toBe(true);
});

test("rationalToString throws on a negative Fraction", () => {
  // fraction.js v5 keeps the sign in .s with .n absolute; serializing .n/.d
  // alone would silently mint "3/4" from -3/4. RationalString is contractually
  // non-negative, so a negative input must fail loud at the boundary.
  expect(() => rationalToString(new Fraction(-3, 4))).toThrow(/negative/);
});
