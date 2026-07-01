import Fraction from "fraction.js";

// Items-per-second to items-per-minute (x60 stays exact) formatted for display
// next to a `/min` suffix. Returns "" for zero so the caller can drop the label.
export function formatRatePerMin(itemsPerSec: Fraction): string {
  const perMin = itemsPerSec.mul(60);
  const value = perMin.valueOf();
  if (!Number.isFinite(value) || value === 0) return "";
  // toFraction keeps the sign; reading .n alone would drop it (fraction.js v5
  // keeps the sign in .s with .n absolute). For d === 1 this is the plain integer.
  if (perMin.d === 1n) return perMin.toFraction(false);
  const fixed = value.toFixed(2).replace(/\.?0+$/, "");
  // A nonzero rate below 0.005/min rounds to "0" (or "-0") here, which would
  // render a misleading "0/min" chip. Fall back to the exact fraction.
  if (fixed === "0" || fixed === "-0") return perMin.toFraction(false);
  return fixed;
}

// Per-minute Fraction from a per-second rational. x60 stays exact, so both the
// fraction and numeric formatters below build on this.
function perMinFromRational(rps: { num: string; denom: string }): Fraction {
  return new Fraction(rps.num).div(new Fraction(rps.denom)).mul(60);
}

// RationalString version, for the ProductNode rate-cap and target-rate display.
// Whole per-minute values come out as a plain integer; anything else as a
// reduced "num/denom" fraction.
export function formatRationalPerMin(rps: {
  num: string;
  denom: string;
}): string {
  return perMinFromRational(rps).toFraction(false);
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
