import Fraction from "fraction.js";
import {
  rationalFromString,
  type RationalString,
} from "../data/targets";

export function formatMultiplicityBadge(m: RationalString): string | null {
  const f = rationalFromString(m);

  if (f.equals(0)) {
    console.warn(
      "formatMultiplicityBadge: multiplicity is zero; class should not exist",
    );
    return "x0";
  }

  if (f.equals(1)) return null;

  // Whole number K: show it as `xK` with no decimals.
  if (f.d === 1n) return `x${f.n.toString()}`;

  // Round half-up to two decimals using integer math, which dodges the
  // floating-point drift you'd see on values like 4.755.
  const scaled = f.mul(100);
  const rounded = scaled.add(new Fraction(1, 2)).floor();
  // A nonzero multiplicity below 1/200 rounds to zero here, but "x0.00" would
  // contradict the x0 guard above: the unit exists. Mark it as below the
  // two-decimal resolution instead.
  if (rounded.equals(0)) return "x<0.01";
  const whole = rounded.div(100).floor();
  const fractional = rounded.sub(whole.mul(100));
  const fractionalStr = fractional.n.toString().padStart(2, "0");
  return `x${whole.n.toString()}.${fractionalStr}`;
}
