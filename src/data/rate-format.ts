import Fraction from "fraction.js";

// Convert items-per-second to items-per-minute (multiplying by 60 stays exact
// because 60 is an integer) and format it for display alongside a `/min`
// suffix. Returns "" for zero so the caller can drop the whole label.
export function formatRatePerMin(itemsPerSec: Fraction): string {
  const perMin = itemsPerSec.mul(60);
  const value = perMin.valueOf();
  if (!Number.isFinite(value) || value === 0) return "";
  if (perMin.d === 1n) return perMin.n.toString();
  return value.toFixed(2).replace(/\.?0+$/, "");
}

// Per-minute Fraction from a per-second rational. Multiplying by the integer 60
// stays exact, so both the fraction and numeric formatters below build on this.
function perMinFromRational(rps: { num: string; denom: string }): Fraction {
  return new Fraction(rps.num).div(new Fraction(rps.denom)).mul(60);
}

// The RationalString version, used for the ProductNode rate-cap and target-rate
// display. Whole per-minute values come out as a plain integer; anything else
// is shown as a reduced "num/denom" fraction.
export function formatRationalPerMin(rps: {
  num: string;
  denom: string;
}): string {
  return perMinFromRational(rps).toFraction(false);
}

// Numeric items-per-minute value (per-second rational times 60) for editable
// rate inputs, whose <input> must hold a plain parseable number rather than a
// formatted string. Read-only readouts use formatRationalPerMin instead so they
// stay exact and match the canvas nodes.
export function ratePerSecToPerMin(rps: {
  num: string;
  denom: string;
}): number {
  return Number(perMinFromRational(rps).valueOf());
}
