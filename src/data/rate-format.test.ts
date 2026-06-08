import { expect, test } from "vitest";
import { formatRationalPerMin, ratePerSecToPerMin } from "./rate-format";

test("formatRationalPerMin shows a non-terminating rate as an exact fraction", () => {
  // 40/27 per sec * 60 = 800/9 per min (non-terminating decimal).
  expect(formatRationalPerMin({ num: "40", denom: "27" })).toBe("800/9");
  // Whole per-minute values collapse to a plain integer.
  expect(formatRationalPerMin({ num: "2", denom: "1" })).toBe("120");
});

test("ratePerSecToPerMin converts a per-sec rational to a per-minute number", () => {
  expect(ratePerSecToPerMin({ num: "2", denom: "1" })).toBe(120);
  expect(ratePerSecToPerMin({ num: "1", denom: "3" })).toBe(20);
});
