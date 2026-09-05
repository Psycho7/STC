import Fraction from "fraction.js";
import {
  rationalFromString,
  type RationalString,
} from "./targets";

// Strip a trailing fractional zero run (and a bare trailing dot) from a decimal
// string, leaving integers untouched. "0.0050" -> "0.005", "8.50" -> "8.5",
// "3.00" -> "3". Guarded on a "." so it never eats an integer's zeros.
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// One shared decimal formatter for every displayed per-minute rate, so chips,
// nodes, and the sidebar never disagree (a fraction next to a decimal) or
// overstate a tiny rate. At or above 0.01 two decimals suffice; below it the
// rounding used to double the value ("0.01" for 0.005) or flip to a vulgar
// fraction ("3/625"), so pick enough decimals to keep roughly two significant
// figures instead -- never exponential, never a slash.
function formatDecimal(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 0.01) return trimZeros(value.toFixed(2));
  const decimals = Math.floor(-Math.log10(abs)) + 2;
  return trimZeros(value.toFixed(Math.min(decimals, 100)));
}

// Shared per-minute core: an exact integer stays exact (and keeps its sign --
// fraction.js v5 holds the sign in .s with .n absolute, so reading .n alone
// would drop it), a non-finite value falls back to the exact fraction, and
// everything else routes through the one decimal formatter.
function formatPerMin(perMin: Fraction): string {
  const value = perMin.valueOf();
  if (!Number.isFinite(value)) return perMin.toFraction(false);
  if (perMin.d === 1n) return perMin.toFraction(false);
  return formatDecimal(value);
}

// Items-per-second to items-per-minute (x60 stays exact) formatted for display
// next to a `/min` suffix. Returns "" for zero so the caller can drop the label.
export function formatRatePerMin(itemsPerSec: Fraction): string {
  const perMin = itemsPerSec.mul(60);
  if (perMin.valueOf() === 0) return "";
  return formatPerMin(perMin);
}

// Full-precision per-minute rate for hover tooltips: the un-rounded value the
// 2-decimal display formatter hides. Uses the plain decimal when stringifying it
// does not go exponential (the common case, a clean single value with no "/min"
// double-slash), else the exact reduced fraction. Returns "" for zero so the
// caller can drop the tooltip rate entirely.
export function formatRateExactPerMin(itemsPerSec: Fraction): string {
  const perMin = itemsPerSec.mul(60);
  const value = perMin.valueOf();
  if (!Number.isFinite(value) || value === 0) {
    return value === 0 ? "" : perMin.toFraction(false);
  }
  const text = String(value);
  return text.includes("e") || text.includes("E")
    ? perMin.toFraction(false)
    : text;
}

// Per-minute Fraction from a per-second rational. x60 stays exact, so both the
// fraction and numeric formatters below build on this.
function perMinFromRational(rps: RationalString): Fraction {
  return rationalFromString(rps).mul(60);
}

// RationalString version, for the ProductNode boundary cards, recipe port rows,
// and the sidebar demand lines. Routes through the same decimal core as the
// canvas chips so the two never disagree; an exact-zero rational renders "0"
// (a definite readout) rather than the empty string the chip formatter uses.
export function formatRationalPerMin(rps: {
  num: string;
  denom: string;
}): string {
  const perMin = perMinFromRational(rps);
  if (perMin.valueOf() === 0) return "0";
  return formatPerMin(perMin);
}

// Items-per-minute input text (per-second rational x60) for editable rate
// inputs. The panel parsers (new Fraction(text)) reject exponent notation and
// non-finite text, so when Number stringification would go exponential (below
// ~1e-6 or at 1e21 and beyond) or overflow to "Infinity" (at ~1.8e308 and
// beyond) fall back to the exact fraction form ("1/10000000"), which the
// parsers accept; otherwise a non-reparseable display silently reverts the
// next edit. Read-only readouts use formatRationalPerMin instead so they stay
// exact and match the canvas.
export function ratePerSecToPerMin(rps: {
  num: string;
  denom: string;
}): string {
  const perMin = perMinFromRational(rps);
  const value = perMin.valueOf();
  const text = String(value);
  if (Number.isFinite(value) && !text.includes("e") && !text.includes("E")) {
    return text;
  }
  return perMin.toFraction(false);
}

// The inverse of ratePerSecToPerMin: an items-per-minute value typed into a
// rate input, as an integer ("120"), decimal ("30.5"), or rational ("1/3"),
// turned back into a per-second rational. Returns undefined if it can't parse
// or the result is negative. The empty string does not parse either (Fraction
// throws on it), so what "no text" means is left to the caller.
export function parsePerMinToRatePerSec(
  perMinStr: string,
): RationalString | undefined {
  let f: Fraction;
  try {
    f = new Fraction(perMinStr).div(new Fraction(60));
  } catch {
    return undefined;
  }
  if (f.compare(0) < 0) return undefined;
  const s = f.toFraction(false);
  const [n, d] = s.includes("/") ? s.split("/") : [s, "1"];
  return { num: n!, denom: d! };
}
