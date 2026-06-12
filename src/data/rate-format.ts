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

// Numeric items-per-minute value (per-second rational x60) for editable rate
// inputs, whose <input> must hold a plain parseable number. Read-only readouts
// use formatRationalPerMin instead so they stay exact and match the canvas.
export function ratePerSecToPerMin(rps: {
  num: string;
  denom: string;
}): number {
  return Number(perMinFromRational(rps).valueOf());
}
