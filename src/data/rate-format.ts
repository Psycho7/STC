import Fraction from "fraction.js";
import { MAX_RATIONAL_DIGITS } from "./plan";
import { rationalFromString, type RationalString } from "./targets";

// Strip a trailing fractional zero run (and a bare trailing dot) from a decimal
// string, leaving integers untouched. "0.0050" -> "0.005", "8.50" -> "8.5",
// "3.00" -> "3". Guarded on a "." so it never eats an integer's zeros.
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// One shared decimal formatter for every displayed per-minute rate, so chips,
// nodes, and the sidebar never disagree (a fraction next to a decimal) or
// overstate a tiny rate. At or above 0.1 ONE fractional digit is the cap
// (ruling A1): a card row draws its rate whole beside the name, and a second
// decimal buys precision nobody reads at the cost of the name's budget. Below
// that the one digit would be the whole number and the rounding would restate
// the rate ("0.1" for 0.06, "0.01" for 0.005) or, before this formatter
// existed, flip to a vulgar fraction ("3/625"), so pick enough decimals to
// keep roughly two significant figures instead -- never exponential, never a
// slash. The cap and the ladder meet at 0.1 for that reason: the ladder owns
// exactly the range where one digit cannot carry the value.
function formatDecimal(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 0.1) return trimZeros(value.toFixed(1));
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
// 1-decimal display formatter hides. Uses the plain decimal when stringifying it
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

// Per-minute Fraction from a per-second rational. x60 stays exact.
function perMinFromRational(rps: RationalString): Fraction {
  return rationalFromString(rps).mul(60);
}

// Readout version, for the ProductNode boundary cards, recipe port rows, and
// the sidebar demand lines. Routes through the same decimal core as the canvas
// chips so the two never disagree; an exact zero renders "0" (a definite
// readout) rather than the empty string the chip formatter uses.
export function formatFractionPerMin(itemsPerSec: Fraction): string {
  const perMin = itemsPerSec.mul(60);
  if (perMin.valueOf() === 0) return "0";
  return formatPerMin(perMin);
}

// The same readout for a per-second rational.
export function formatRationalPerMin(rps: {
  num: string;
  denom: string;
}): string {
  return formatFractionPerMin(rationalFromString(rps));
}

// Items-per-minute input text (per-second rational x60) for editable rate
// inputs, exact so a reloaded rate reads back as typed. A per-minute value
// whose reduced denominator is 2^a*5^b terminates, so it prints as its full
// decimal ("0.0009765625"); anything else prints as the reduced fraction
// ("1/3", "7/3") rather than a rounded float. Both forms reparse through the
// panel parsers (new Fraction(text)), which reject exponent notation, so the
// decimal is built from the BigInt parts and never goes through Number.
// Read-only readouts use formatRationalPerMin instead so they match the canvas.
export function ratePerSecToPerMin(rps: {
  num: string;
  denom: string;
}): string {
  const perMin = perMinFromRational(rps);
  const decimal = exactDecimal(perMin);
  return decimal ?? perMin.toFraction(false);
}

// The exact decimal text of a terminating fraction, or undefined when the
// reduced denominator has a prime factor other than 2 or 5.
function exactDecimal(f: Fraction): string | undefined {
  let rest = f.d;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }
  if (rest !== 1n) return undefined;

  // n/d = n * (10^k / d) / 10^k with k = max(twos, fives).
  const places = Math.max(twos, fives);
  const scaled = (f.n * 10n ** BigInt(places)) / f.d;
  const sign = f.s < 0n ? "-" : "";
  if (places === 0) return sign + scaled.toString();
  const digits = scaled.toString().padStart(places + 1, "0");
  const cut = digits.length - places;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
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
  // A pasted 400-digit decimal parses fine and would commit, write the hash,
  // and then fail to load again, since the loader caps rational digits. Refuse
  // it at the input instead of taking the plan down on the next reload.
  if (n!.length > MAX_RATIONAL_DIGITS || d!.length > MAX_RATIONAL_DIGITS) {
    return undefined;
  }
  return { num: n!, denom: d! };
}

// Why rate text was refused. Each reason has its own message.
export type RateTextError = "notNumber" | "zero" | "negative";

export const RATE_ERROR_KEY = {
  notNumber: "rate.invalid",
  zero: "rate.zero",
  negative: "rate.negative",
} as const satisfies Record<RateTextError, string>;

// What the text in a rate field means once committed. "empty" is only ever
// returned under emptyMeans "uncap" (the no-limit commit).
export type RateTextResult =
  | { kind: "empty" }
  | { kind: "rate"; rate: RationalString }
  | { kind: "error"; error: RateTextError };

// The one rule every rate field (panel rows and the add prompt) commits
// through. The text is trimmed first, so " 45 " is 45. emptyMeans picks the
// field family:
//  - "invalid" (targets): a target needs a positive rate, so empty text and
//    zero are refused.
//  - "uncap" (inputs): empty means no limit and 0 is a real zero cap.
// Negative and non-numeric text are refused in both.
export function parseRateText(
  text: string,
  emptyMeans: "invalid" | "uncap",
): RateTextResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return emptyMeans === "uncap"
      ? { kind: "empty" }
      : { kind: "error", error: "notNumber" };
  }

  let perMin: Fraction;
  try {
    perMin = new Fraction(trimmed);
  } catch {
    return { kind: "error", error: "notNumber" };
  }
  if (perMin.compare(0) < 0) return { kind: "error", error: "negative" };
  if (emptyMeans === "invalid" && perMin.compare(0) === 0) {
    return { kind: "error", error: "zero" };
  }

  // Past the checks above, the parser only refuses a value too long to store.
  const rate = parsePerMinToRatePerSec(trimmed);
  return rate === undefined
    ? { kind: "error", error: "notNumber" }
    : { kind: "rate", rate };
}
