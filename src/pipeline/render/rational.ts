import Fraction from "fraction.js";
import type { RationalString } from "../types";

export function rationalFromString(r: RationalString): Fraction {
  return new Fraction(`${r.num}/${r.denom}`);
}

export function rationalToString(f: Fraction): RationalString {
  return { num: f.n.toString(), denom: f.d.toString() };
}
