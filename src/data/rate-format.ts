import Fraction from "fraction.js";
import { MAX_RATIONAL_DIGITS } from "./plan";
import { rationalFromString, type RationalString } from "./targets";
import type { I18nIndex } from "./i18n";

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
// panel parsers exactly; the decimal is built from the BigInt parts and never
// goes through Number, which would round it or print it as an exponent.
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

// Mantissa and exponent of exponent-notation text: "1e6", "2.5E3", "6e-1".
const EXPONENT_TEXT = /^([+-]?(?:\d+\.?\d*|\.\d+))e([+-]?\d+)$/i;

// Per-minute text to an exact Fraction: whatever fraction.js reads (integer,
// decimal, "1/3") plus exponent notation, which it refuses. Undefined when the
// text does not parse.
function parsePerMinText(text: string): Fraction | undefined {
  const match = EXPONENT_TEXT.exec(text);
  try {
    if (match === null) return new Fraction(text);
    const mantissa = new Fraction(match[1]!);
    if (mantissa.equals(0)) return mantissa;

    // Clamp the exponent before 10n ** e so "1e999999999" cannot hang. Past
    // the clamp the verdict is already fixed: with a mantissa of L chars,
    // e > 400 + L puts the value far over the rate bound, and e < -(400 + L)
    // needs a denominator over the 400-digit cap.
    const clamp = MAX_RATIONAL_DIGITS + match[1]!.length + 1;
    const exponent = Math.max(-clamp, Math.min(clamp, Number(match[2])));
    const scale = new Fraction(10n ** BigInt(Math.abs(exponent)));
    return exponent < 0 ? mantissa.div(scale) : mantissa.mul(scale);
  } catch {
    return undefined;
  }
}

// The inverse of ratePerSecToPerMin: an items-per-minute value typed into a
// rate input, as an integer ("120"), decimal ("30.5"), rational ("1/3") or
// exponent ("2.5e3"), turned back into a per-second rational. Returns
// undefined if it can't parse or the result is negative. The empty string does
// not parse either (Fraction throws on it), so what "no text" means is left to
// the caller.
export function parsePerMinToRatePerSec(
  perMinStr: string,
): RationalString | undefined {
  const perMin = parsePerMinText(perMinStr);
  if (perMin === undefined) return undefined;
  const f = perMin.div(new Fraction(60));
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

// The largest rate a field takes, per minute. The fastest pack recipe makes
// 1200/min per machine and no shipped plan targets over 120/min, while the LP
// still solves at 1e9/s: the bound leaves room for any real build and refuses
// a slip of the keyboard long before the solver would.
const MAX_RATE_PER_MIN = 1_000_000;

// Why rate text was refused. Each reason has its own message.
export type RateTextError = "notNumber" | "zero" | "negative" | "tooLarge";

export const RATE_ERROR_KEY = {
  notNumber: "rate.invalid",
  zero: "rate.zero",
  negative: "rate.negative",
  tooLarge: "rate.tooLarge",
} as const satisfies Record<RateTextError, string>;

// The message for a refused rate. The bound is filled in from the constant so
// the copy in either locale cannot drift from the rule.
export function rateErrorText(
  i18n: Pick<I18nIndex, "t">,
  reason: RateTextError,
): string {
  return i18n.t(RATE_ERROR_KEY[reason], {
    max: MAX_RATE_PER_MIN.toLocaleString("en-US"),
  });
}

// The status line after a blur threw refused text away, naming the reason.
// Non-numeric text keeps its own wording; every other reason reuses its error
// message. Neutral about what the field shows now: an uncapped or auto row
// reverts to an empty field, not to a rate.
export function rateRevertedText(
  i18n: Pick<I18nIndex, "t">,
  reason: RateTextError,
): string {
  if (reason === "notNumber") return i18n.t("rate.reverted");
  return i18n.t("rate.revertedReason", {
    reason: rateErrorText(i18n, reason),
  });
}

// What the text in a rate field means once committed. "empty" is only ever
// returned under emptyMeans "uncap" (the no-limit commit).
export type RateTextResult =
  | { kind: "empty" }
  | { kind: "rate"; rate: RationalString }
  | { kind: "error"; error: RateTextError };

// The one rule every rate field (panel rows and the add prompt) commits
// through. The text is NFKC-normalized and trimmed first, so a full-width
// "\uFF11\uFF12\uFF10" is 120 and " 45 " is 45. emptyMeans picks the
// field family:
//  - "invalid" (targets): a target needs a positive rate, so empty text and
//    zero are refused.
//  - "uncap" (inputs): empty means no limit and 0 is a real zero cap.
// Negative, non-numeric and over-bound text are refused in both.
export function parseRateText(
  text: string,
  emptyMeans: "invalid" | "uncap",
): RateTextResult {
  const trimmed = text.normalize("NFKC").trim();
  if (trimmed === "") {
    return emptyMeans === "uncap"
      ? { kind: "empty" }
      : { kind: "error", error: "notNumber" };
  }

  const perMin = parsePerMinText(trimmed);
  if (perMin === undefined) return { kind: "error", error: "notNumber" };
  if (perMin.compare(0) < 0) return { kind: "error", error: "negative" };
  if (emptyMeans === "invalid" && perMin.compare(0) === 0) {
    return { kind: "error", error: "zero" };
  }
  if (perMin.compare(MAX_RATE_PER_MIN) > 0) {
    return { kind: "error", error: "tooLarge" };
  }

  // Past the checks above, the parser only refuses a value too long to store.
  const rate = parsePerMinToRatePerSec(trimmed);
  return rate === undefined
    ? { kind: "error", error: "notNumber" }
    : { kind: "rate", rate };
}
