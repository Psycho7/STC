import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import {
  formatRatePerMin,
  formatRationalPerMin,
} from "../../src/data/rate-format";

describe("data/rate-format", () => {
  describe("formatRatePerMin", () => {
    it("returns an empty string for Fraction(0, 1) (suppress label)", () => {
      expect(formatRatePerMin(new Fraction(0, 1))).toBe("");
    });

    it("returns a bare integer when items-per-minute is whole", () => {
      // 0.5/s * 60 = 30/min
      expect(formatRatePerMin(new Fraction(1, 2))).toBe("30");
      // 2/s * 60 = 120/min
      expect(formatRatePerMin(new Fraction(2, 1))).toBe("120");
      // 1/30 /s * 60 = 2/min
      expect(formatRatePerMin(new Fraction(1, 30))).toBe("2");
    });

    it("formats non-whole per-minute values as two-decimal with trailing zeros trimmed", () => {
      // 1/7 /s * 60 = 60/7 = 8.5714...
      expect(formatRatePerMin(new Fraction(1, 7))).toBe("8.57");
      // 1/40 /s * 60 = 1.5
      expect(formatRatePerMin(new Fraction(1, 40))).toBe("1.5");
    });
  });

  describe("formatRationalPerMin", () => {
    it("returns '0' for a zero rational (no suppression at this layer)", () => {
      expect(formatRationalPerMin({ num: "0", denom: "1" })).toBe("0");
    });

    it("returns a bare integer when items-per-minute is whole", () => {
      // (1/30) * 60 = 2
      expect(formatRationalPerMin({ num: "1", denom: "30" })).toBe("2");
      // (1/2) * 60 = 30
      expect(formatRationalPerMin({ num: "1", denom: "2" })).toBe("30");
    });

    it("returns 'num/denom' form for non-whole per-minute rationals", () => {
      // (1/7) * 60 = 60/7
      expect(formatRationalPerMin({ num: "1", denom: "7" })).toBe("60/7");
    });

    it("simplifies fractions whose per-minute form reduces", () => {
      // (1/40) * 60 = 60/40 = 3/2
      expect(formatRationalPerMin({ num: "1", denom: "40" })).toBe("3/2");
    });
  });
});
