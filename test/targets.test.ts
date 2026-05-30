import { describe, it, expect } from "vitest";
import { defaultTargets, type Target } from "../src/data/targets";

describe("defaultTargets", () => {
  it("returns three targets with known recipeIds", () => {
    const ts: Target[] = defaultTargets();
    expect(ts.map((t) => t.recipeId)).toEqual([
      "copper_bottle",
      "copper_powder",
      "iron_powder",
    ]);
  });
  it("rates are well-formed RationalStrings", () => {
    for (const t of defaultTargets()) {
      expect(typeof t.ratePerSec.num).toBe("string");
      expect(typeof t.ratePerSec.denom).toBe("string");
      expect(BigInt(t.ratePerSec.num) >= 0n).toBe(true);
      expect(BigInt(t.ratePerSec.denom) > 0n).toBe(true);
    }
  });
});
