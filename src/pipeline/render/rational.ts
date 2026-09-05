import type Fraction from "fraction.js";
import type { RationalString } from "../types";

// The parse lives beside the RationalString type in src/data/targets.ts so the
// solver can reach it without importing the render layer. Re-exported here so
// the render layer keeps its parse/emit pair in one module.
export { rationalFromString } from "../../data/targets";

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
