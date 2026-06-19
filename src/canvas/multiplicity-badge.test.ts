import { expect, test, vi } from "vitest";
import { formatMultiplicityBadge } from "./multiplicity-badge";

test("whole multiplicities show no decimals; exactly 1 hides the badge", () => {
  expect(formatMultiplicityBadge({ num: "3", denom: "1" })).toBe("x3");
  expect(formatMultiplicityBadge({ num: "1", denom: "1" })).toBeNull();
});

test("fractional multiplicities round half-up to two decimals", () => {
  expect(formatMultiplicityBadge({ num: "951", denom: "200" })).toBe("x4.76");
  expect(formatMultiplicityBadge({ num: "1", denom: "200" })).toBe("x0.01");
});

// A multiplicity below 1/200 rounds to zero at two decimals, but "x0.00"
// would contradict the explicit x0 guard: the unit exists. Chosen display
// form: "x<0.01", marking the value as a positive amount below resolution.
test("sub-1/200 multiplicities never display as x0.00", () => {
  expect(formatMultiplicityBadge({ num: "1", denom: "300" })).toBe("x<0.01");
  expect(formatMultiplicityBadge({ num: "1", denom: "100000" })).toBe(
    "x<0.01",
  );
});

test("near-1 multiplicities keep ordinary rounding", () => {
  // 999/1000 and 100001/100000 round to 1.00; that is plain rounding, not a
  // collapse to a contradictory value, so they stay "x1.00".
  expect(formatMultiplicityBadge({ num: "999", denom: "1000" })).toBe("x1.00");
  expect(formatMultiplicityBadge({ num: "100001", denom: "100000" })).toBe(
    "x1.00",
  );
});

test("recurring decimals round to two places", () => {
  // 4/3 = 1.333... and 1/7 = 0.142857... exercise the non-terminating-repetend
  // input class that the terminating fixtures above do not.
  expect(formatMultiplicityBadge({ num: "4", denom: "3" })).toBe("x1.33");
  expect(formatMultiplicityBadge({ num: "1", denom: "7" })).toBe("x0.14");
});

test("K = 0 returns 'x0' and warns (defensive zero guard)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(formatMultiplicityBadge({ num: "0", denom: "1" })).toBe("x0");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
