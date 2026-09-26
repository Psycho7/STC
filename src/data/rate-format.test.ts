import { expect, test } from "vitest";
import Fraction from "fraction.js";
import {
  formatDeliveredPerMin,
  formatFractionPerMin,
  formatRateExactPerMin,
  formatRatePerMin,
  formatRationalPerMin,
  groupRateDigits,
  parsePerMinToRatePerSec,
  parseRateText,
  RATE_ERROR_KEY,
  rateErrorText,
  ratePerSecToPerMin,
} from "./rate-format";
import { loadI18n } from "./i18n";

test("formatRateExactPerMin reveals the un-rounded value the display rounds", () => {
  // 1/7 per sec * 60 = 60/7 = 8.571428..., which formatRatePerMin rounds to
  // "8.6"; the exact tooltip shows the full-precision decimal instead.
  expect(formatRateExactPerMin(new Fraction(1, 7))).toBe(String(60 / 7));
  // A tiny rate the display would show as a fraction still reads exactly.
  expect(formatRateExactPerMin(new Fraction("1").div("12000"))).toBe(
    String((1 / 12000) * 60),
  );
});

test("formatRateExactPerMin returns empty for exact zero", () => {
  expect(formatRateExactPerMin(new Fraction(0))).toBe("");
});

test("formatRateExactPerMin never returns exponential text", () => {
  // 1/600000000 per sec * 60 = 1e-7 per min; String() would go exponential, so
  // the exact fraction form is used instead.
  const out = formatRateExactPerMin(new Fraction("1").div("600000000"));
  expect(out.includes("e")).toBe(false);
  expect(out.includes("E")).toBe(false);
});

test("formatRationalPerMin rounds a non-terminating rate to the shared decimal", () => {
  // 40/27 per sec * 60 = 800/9 = 88.888.../min. The rational readout uses the
  // same decimal core as the canvas chips instead of a vulgar fraction, and
  // that core caps a displayed rate at one fractional digit.
  expect(formatRationalPerMin({ num: "40", denom: "27" })).toBe("88.9");
  // Whole per-minute values collapse to a plain integer.
  expect(formatRationalPerMin({ num: "2", denom: "1" })).toBe("120");
});

test("formatRatePerMin and formatRationalPerMin agree on the same rate", () => {
  // The chip (Fraction) and sidebar (RationalString) formatters share one core,
  // so a screen never mixes "6/5" with a decimal for the same value.
  expect(formatRatePerMin(new Fraction(1, 7))).toBe(
    formatRationalPerMin({ num: "1", denom: "7" }),
  );
  expect(formatRatePerMin(new Fraction("1").div("12500"))).toBe(
    formatRationalPerMin({ num: "1", denom: "12500" }),
  );
});

test("formatRatePerMin uses significant digits below 0.01, never a slash", () => {
  // 1/12000 per sec * 60 = 0.005/min. toFixed(2) rounded this to "0.01" (2x the
  // real flow); significant digits keep it honest and slash-free.
  expect(formatRatePerMin(new Fraction("1").div("12000"))).toBe("0.005");
  // 1/12500 per sec * 60 = 0.0048/min, which used to flip to "3/625".
  const tiny = formatRatePerMin(new Fraction("1").div("12500"));
  expect(tiny).toBe("0.0048");
  expect(tiny.includes("/")).toBe(false);
});

test("formatRationalPerMin never emits a slash (no double-slash unit text)", () => {
  // A non-terminating rational used to render "3/625", composing to "3/625/min".
  expect(formatRationalPerMin({ num: "1", denom: "12500" }).includes("/")).toBe(
    false,
  );
});

test("formatRatePerMin keeps a normal sub-unit rate unchanged", () => {
  // 1/600 per sec * 60 = 0.1 per min.
  expect(formatRatePerMin(new Fraction("1").div("600"))).toBe("0.1");
});

// The one-digit cap stops where one digit would BE the value: a 0.06/min plan
// rate must not read as 0.1/min, so the significant-digit ladder owns
// everything below 0.1.
test("formatRatePerMin keeps two significant figures below 0.1", () => {
  expect(formatRatePerMin(new Fraction("1").div("1000"))).toBe("0.06");
  expect(formatRationalPerMin({ num: "1", denom: "1000" })).toBe("0.06");
});

test("formatRatePerMin rounds a >1 non-whole per-minute value to one decimal", () => {
  // 1/7 per sec * 60 = 60/7 = 8.5714..., toFixed(1) then trailing-zero trim.
  expect(formatRatePerMin(new Fraction(1, 7))).toBe("8.6");
  // The trim still collapses a rounded-away digit to a bare integer.
  expect(formatRatePerMin(new Fraction("599").div("600"))).toBe("59.9");
  expect(formatRatePerMin(new Fraction("5999").div("6000"))).toBe("60");
});

test("formatRationalPerMin does not suppress an exact-zero rational", () => {
  // The rational layer renders "0" rather than the empty-string suppression
  // formatRatePerMin applies to Fraction zero.
  expect(formatRationalPerMin({ num: "0", denom: "1" })).toBe("0");
});

test("formatRatePerMin returns empty for exact zero", () => {
  expect(formatRatePerMin(new Fraction(0))).toBe("");
});

test("formatRatePerMin never collapses a tiny nonzero rate to 0", () => {
  // 1/20000 per sec * 60 = 0.003 per min, below toFixed(2) resolution. The
  // significant-digit path keeps the magnitude as a decimal instead of "0".
  expect(formatRatePerMin(new Fraction("1").div("20000"))).toBe("0.003");
});

test("formatRatePerMin never renders -0 for a tiny negative rate", () => {
  // -0.003/min keeps its sign and magnitude as a decimal.
  expect(formatRatePerMin(new Fraction("-1").div("20000"))).toBe("-0.003");
});

test("formatRatePerMin keeps the sign on a negative whole per-minute rate", () => {
  // fraction.js v5 keeps the sign in .s with .n absolute; the integer branch
  // must not read .n alone or -2/s would render as "120".
  expect(formatRatePerMin(new Fraction(-2))).toBe("-120");
  // Negative non-integer rates already go through the sign-correct decimal branch.
  expect(formatRatePerMin(new Fraction("-1").div("40"))).toBe("-1.5");
});

test("ratePerSecToPerMin converts a per-sec rational to per-minute input text", () => {
  expect(ratePerSecToPerMin({ num: "2", denom: "1" })).toBe("120");
  expect(ratePerSecToPerMin({ num: "1", denom: "3" })).toBe("20");
  // Ordinary fractional rates stay plain decimals.
  expect(ratePerSecToPerMin({ num: "1", denom: "40" })).toBe("1.5");
});

// The panel parsers (new Fraction(text)) reject exponent notation, so the
// display text must never go exponential or the next edit silently reverts.
// Tiny values fall back to the exact fraction form ("1/10000000"), which the
// parsers accept; huge integers stringify in full digits.
test("ratePerSecToPerMin round-trips a tiny rate through the panel parser", () => {
  // per-min 0.0000001 -> per-sec 1/600000000. Number stringification would
  // emit "1e-7", which Fraction cannot parse.
  const rps = { num: "1", denom: "600000000" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(reparsed.equals(new Fraction("1/600000000"))).toBe(true);
});

test("ratePerSecToPerMin round-trips a huge rate through the panel parser", () => {
  // per-min 1e21 -> Number stringification would emit "1e+21".
  const rps = { num: "1000000000000000000000", denom: "60" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(reparsed.equals(new Fraction("1000000000000000000000").div(60))).toBe(
    true,
  );
});

test("ratePerSecToPerMin round-trips a beyond-double rate through the panel parser", () => {
  // per-min 1e309 overflows Number to Infinity; String(Infinity) = "Infinity"
  // has no exponent marker, so the e/E check alone would emit text the panel
  // parsers reject. Must fall back to the exact fraction form.
  const perMinDigits = `1${"0".repeat(309)}`;
  const rps = { num: perMinDigits, denom: "60" };
  const text = ratePerSecToPerMin(rps);
  const reparsed = new Fraction(text).div(60);
  expect(reparsed.equals(new Fraction(perMinDigits).div(60))).toBe(true);
});

test("parsePerMinToRatePerSec parses integer, decimal, and rational text", () => {
  // 120/min = 2/s; 30.5/min = 61/120 per sec; "1/3"/min = 1/180 per sec.
  expect(parsePerMinToRatePerSec("120")).toEqual({ num: "2", denom: "1" });
  expect(parsePerMinToRatePerSec("30.5")).toEqual({ num: "61", denom: "120" });
  expect(parsePerMinToRatePerSec("1/3")).toEqual({ num: "1", denom: "180" });
  // A whole-number result still carries an explicit "1" denominator.
  expect(parsePerMinToRatePerSec("0")).toEqual({ num: "0", denom: "1" });
});

test("parsePerMinToRatePerSec rejects negatives, garbage, and empty text", () => {
  expect(parsePerMinToRatePerSec("-5")).toBeUndefined();
  expect(parsePerMinToRatePerSec("abc")).toBeUndefined();
  // Fraction throws on the empty string; what "no text" means stays with the
  // caller (useRateEdit's emptyMeans).
  expect(parsePerMinToRatePerSec("")).toBeUndefined();
  expect(parsePerMinToRatePerSec("   ")).toBeUndefined();
});

test("formatFractionPerMin matches formatRationalPerMin, zero rule included", () => {
  const rates: [string, string][] = [
    ["0", "1"],
    ["1", "7"],
    ["2", "1"],
    ["40", "27"],
    ["1", "12500"],
    ["1", "1000"],
  ];
  for (const [num, denom] of rates) {
    expect(formatFractionPerMin(new Fraction(`${num}/${denom}`))).toBe(
      formatRationalPerMin({ num, denom }),
    );
  }
  expect(formatFractionPerMin(new Fraction(0))).toBe("0");
});

// A reloaded rate must show what the user typed: a non-terminating per-minute
// value prints as its exact fraction, a terminating one as its exact decimal.
test("ratePerSecToPerMin prints a non-terminating per-minute rate as a fraction", () => {
  // 1/3 per min = 1/180 per sec.
  expect(ratePerSecToPerMin({ num: "1", denom: "180" })).toBe("1/3");
  // 7/3 per min = 7/180 per sec: a mixed value stays an improper fraction.
  expect(ratePerSecToPerMin({ num: "7", denom: "180" })).toBe("7/3");
});

test("ratePerSecToPerMin prints a terminating per-minute rate as its exact decimal", () => {
  // 1/1024 per min = 1/61440 per sec.
  expect(ratePerSecToPerMin({ num: "1", denom: "61440" })).toBe("0.0009765625");
  // 1/2^30 per min: every digit, no float rounding, no exponent.
  expect(ratePerSecToPerMin({ num: "1", denom: String(60n * 2n ** 30n) })).toBe(
    "0.000000000931322574615478515625",
  );
});

test("ratePerSecToPerMin pins the exact decimal text across signs and sizes", () => {
  // Per-minute value -> expected text. The per-second input is value / 60.
  const table: [string, string, string][] = [
    ["1", "1024", "0.0009765625"],
    ["-7", "80", "-0.0875"],
    ["12345678901234567890123", "1024", "12056327051986882705.1982421875"],
    ["0", "1", "0"],
    ["120", "1", "120"],
    ["-3", "1", "-3"],
  ];
  for (const [num, denom, expected] of table) {
    const perSec = new Fraction(`${num}/${denom}`).div(60);
    const [n, d] = perSec.toFraction(false).split("/");
    expect(ratePerSecToPerMin({ num: n!, denom: d ?? "1" })).toBe(expected);
  }
});

test("parseRateText trims before parsing", () => {
  expect(parseRateText(" 45 ", "invalid")).toEqual({
    kind: "rate",
    rate: { num: "3", denom: "4" },
  });
  expect(parseRateText(" 45 ", "uncap")).toEqual({
    kind: "rate",
    rate: { num: "3", denom: "4" },
  });
});

test("parseRateText refuses zero only in invalid mode", () => {
  expect(parseRateText("0", "invalid")).toEqual({
    kind: "error",
    error: "zero",
  });
  expect(parseRateText("0/5", "invalid")).toEqual({
    kind: "error",
    error: "zero",
  });
  expect(parseRateText("0", "uncap")).toEqual({
    kind: "rate",
    rate: { num: "0", denom: "1" },
  });
});

test("parseRateText gives empty text its mode's meaning", () => {
  expect(parseRateText("  ", "uncap")).toEqual({ kind: "empty" });
  expect(parseRateText("  ", "invalid")).toEqual({
    kind: "error",
    error: "notNumber",
  });
});

test("parseRateText tells non-numeric and negative text apart", () => {
  for (const mode of ["invalid", "uncap"] as const) {
    expect(parseRateText("abc", mode)).toEqual({
      kind: "error",
      error: "notNumber",
    });
    expect(parseRateText("-5", mode)).toEqual({
      kind: "error",
      error: "negative",
    });
  }
});

test("each rate error has its own message in en and zh", () => {
  for (const locale of ["en", "zh"] as const) {
    const i18n = loadI18n(locale);
    const messages = (["notNumber", "zero", "negative"] as const).map((error) =>
      i18n.t(RATE_ERROR_KEY[error]),
    );
    expect(new Set(messages).size).toBe(3);
  }
});

test("parseRateText reads full-width digits through NFKC", () => {
  // U+FF11 U+FF12 U+FF10 is a full-width "120": 120/min = 2/s.
  expect(parseRateText("１２０", "invalid")).toEqual({
    kind: "rate",
    rate: { num: "2", denom: "1" },
  });
  // Full-width solidus and minus fold too, so the reasons still apply.
  expect(parseRateText("１／３", "invalid")).toEqual({
    kind: "rate",
    rate: { num: "1", denom: "180" },
  });
  expect(parseRateText("－５", "uncap")).toEqual({
    kind: "error",
    error: "negative",
  });
});

test("parseRateText accepts exponent notation", () => {
  // 1e6/min = 50000/3 per sec; 2.5E3/min = 125/3 per sec.
  expect(parseRateText("1e6", "invalid")).toEqual({
    kind: "rate",
    rate: { num: "50000", denom: "3" },
  });
  expect(parseRateText("2.5E3", "invalid")).toEqual({
    kind: "rate",
    rate: { num: "125", denom: "3" },
  });
  // 6e-1/min = 1/100 per sec, 1.2e+2 is 120.
  expect(parseRateText("6e-1", "uncap")).toEqual({
    kind: "rate",
    rate: { num: "1", denom: "100" },
  });
  expect(parseRateText("1.2e+2", "uncap")).toEqual({
    kind: "rate",
    rate: { num: "2", denom: "1" },
  });
  // A zero mantissa is zero whatever the exponent.
  expect(parseRateText("0e999999999999", "invalid")).toEqual({
    kind: "error",
    error: "zero",
  });
  expect(parseRateText("-1e999999999999", "uncap")).toEqual({
    kind: "error",
    error: "negative",
  });
  // Half an exponent is not a number.
  for (const text of ["1e", "e5", "1e2.5", "1/3e2"]) {
    expect(parseRateText(text, "uncap")).toEqual({
      kind: "error",
      error: "notNumber",
    });
  }
});

test("exponent text still goes through the digit caps", () => {
  // 1e-500 needs a 500-digit denominator, past the 400-digit cap.
  expect(parseRateText("1e-500", "uncap")).toEqual({
    kind: "error",
    error: "notNumber",
  });
  // An exponent too long for a Number is refused without hanging.
  expect(parseRateText(`1e-${"9".repeat(40)}`, "uncap")).toEqual({
    kind: "error",
    error: "notNumber",
  });
  // A long decimal written as plain text is refused as before.
  expect(parseRateText(`0.${"1".repeat(500)}`, "uncap")).toEqual({
    kind: "error",
    error: "notNumber",
  });
});

test("parseRateText bounds a rate at 1,000,000 per minute", () => {
  for (const mode of ["invalid", "uncap"] as const) {
    // At and just under the bound.
    expect(parseRateText("1000000", mode)).toEqual({
      kind: "rate",
      rate: { num: "50000", denom: "3" },
    });
    expect(parseRateText("999999.9", mode).kind).toBe("rate");
    // Just over it, in every spelling.
    for (const text of ["1000000.1", "1000001", "10000001/10", "1.0000001e6"]) {
      expect(parseRateText(text, mode)).toEqual({
        kind: "error",
        error: "tooLarge",
      });
    }
    // Far over it reads as too large, not as a digit-cap refusal.
    expect(parseRateText("1e400", mode)).toEqual({
      kind: "error",
      error: "tooLarge",
    });
    expect(parseRateText(`1e${"9".repeat(40)}`, mode)).toEqual({
      kind: "error",
      error: "tooLarge",
    });
  }
});

test("the too-large reason has its own message in en and zh", () => {
  for (const locale of ["en", "zh"] as const) {
    const i18n = loadI18n(locale);
    const tooLarge = rateErrorText(i18n, "tooLarge");
    const others = (["notNumber", "zero", "negative"] as const).map((error) =>
      rateErrorText(i18n, error),
    );
    expect(tooLarge).not.toBe(RATE_ERROR_KEY.tooLarge);
    expect(others).not.toContain(tooLarge);
    // The bound comes from the rule's constant, not from the copy.
    expect(tooLarge).toContain("1,000,000");
    expect(tooLarge).not.toContain("{max}");
  }
});

test("groupRateDigits groups the integer part only", () => {
  expect(groupRateDigits("1000000")).toBe("1,000,000");
  expect(groupRateDigits("1234567.5")).toBe("1,234,567.5");
  expect(groupRateDigits("-12345")).toBe("-12,345");
  expect(groupRateDigits("999")).toBe("999");
  expect(groupRateDigits("0")).toBe("0");
  // Fraction digits are never grouped.
  expect(groupRateDigits("0.0012345")).toBe("0.0012345");
  // An exact-fraction fallback groups each side.
  expect(groupRateDigits("1000001/3")).toBe("1,000,001/3");
});

// A shortfall smaller than the display resolution must not read "120 of 120".
test("formatDeliveredPerMin keeps the plain figure when it already differs", () => {
  const declared = { num: "2", denom: "1" };
  expect(formatDeliveredPerMin({ num: "7", denom: "12" }, declared)).toBe("35");
  expect(formatDeliveredPerMin({ num: "40", denom: "27" }, declared)).toBe(
    formatRationalPerMin({ num: "40", denom: "27" }),
  );
});

test("formatDeliveredPerMin adds decimals until the figure differs", () => {
  const declared = { num: "2", denom: "1" };
  // 119.96/min and 119.999/min both round to "120" at one decimal.
  expect(formatDeliveredPerMin({ num: "2999", denom: "1500" }, declared)).toBe(
    "119.96",
  );
  expect(
    formatDeliveredPerMin({ num: "119999", denom: "60000" }, declared),
  ).toBe("119.999");
  // Four extra decimals is the cap: 119.99999/min still fits it.
  expect(
    formatDeliveredPerMin({ num: "11999999", denom: "6000000" }, declared),
  ).toBe("119.99999");
});

test("formatDeliveredPerMin reads <declared when four extra decimals still tie", () => {
  const declared = { num: "2", denom: "1" };
  // 119.999999/min rounds to 120 at five decimals.
  expect(
    formatDeliveredPerMin({ num: "119999999", denom: "60000000" }, declared),
  ).toBe("<120");
});
