import { expect, test } from "vitest";
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
