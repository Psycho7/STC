import Fraction from "fraction.js";
import type { RationalString } from "../types";

export function rationalFromString(r: RationalString): Fraction {
  return new Fraction(`${r.num}/${r.denom}`);
}

export function rationalToString(f: Fraction): RationalString {
  // fraction.js v5 keeps the sign in .s with .n absolute. RationalString is
  // contractually non-negative (isValidRational accepts digits only), so a
  // negative input is a caller bug: fail loud instead of dropping the sign.
  if (f.s < 0n) {
    throw new Error(
      `rationalToString: negative Fraction ${f.toFraction(false)} violates the non-negative RationalString contract`,
    );
  }
  return { num: f.n.toString(), denom: f.d.toString() };
}
