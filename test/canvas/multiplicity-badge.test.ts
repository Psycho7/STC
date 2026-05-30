import { describe, it, expect, vi } from "vitest";
import { formatMultiplicityBadge } from "../../src/canvas/multiplicity-badge";

describe("formatMultiplicityBadge", () => {
  it("returns null for K = 1 (suppressed badge)", () => {
    expect(formatMultiplicityBadge({ num: "1", denom: "1" })).toBeNull();
  });

  it("renders integer K as xK without decimals", () => {
    expect(formatMultiplicityBadge({ num: "4", denom: "1" })).toBe("x4");
    expect(formatMultiplicityBadge({ num: "12", denom: "1" })).toBe("x12");
  });

  it("renders fractional K as xK.KK with two decimals, round-half-up", () => {
    expect(formatMultiplicityBadge({ num: "47", denom: "10" })).toBe("x4.70");
    expect(formatMultiplicityBadge({ num: "473", denom: "100" })).toBe("x4.73");
    expect(formatMultiplicityBadge({ num: "475", denom: "100" })).toBe("x4.75");
    expect(formatMultiplicityBadge({ num: "4755", denom: "1000" })).toBe(
      "x4.76",
    );
    expect(formatMultiplicityBadge({ num: "4754", denom: "1000" })).toBe(
      "x4.75",
    );
  });

  it("rounds recurring decimals to two places", () => {
    // 4/3 = 1.333...
    expect(formatMultiplicityBadge({ num: "4", denom: "3" })).toBe("x1.33");
    // 1/7 = 0.142857...
    expect(formatMultiplicityBadge({ num: "1", denom: "7" })).toBe("x0.14");
  });

  it("renders sub-machine K (0 < K < 1)", () => {
    expect(formatMultiplicityBadge({ num: "7", denom: "10" })).toBe("x0.70");
    expect(formatMultiplicityBadge({ num: "1", denom: "2" })).toBe("x0.50");
  });

  it("returns 'x0' with console.warn for K = 0 (defensive)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(formatMultiplicityBadge({ num: "0", denom: "1" })).toBe("x0");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
