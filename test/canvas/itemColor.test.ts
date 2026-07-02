import { describe, expect, it } from "vitest";
import { itemColor, itemHue } from "../../src/canvas/itemColor";

describe("canvas/itemColor", () => {
  it("returns the same color for the same item id", () => {
    expect(itemColor("Iron Plate")).toBe(itemColor("Iron Plate"));
    expect(itemHue("Copper Plate")).toBe(itemHue("Copper Plate"));
  });

  it("returns different hues for two distinct item ids", () => {
    expect(itemHue("Iron Plate")).not.toBe(itemHue("Copper Plate"));
  });

  it("pins the exact hsl string for known item ids so the hash cannot drift", () => {
    expect(itemColor("Iron Plate")).toBe("hsl(163 65% 60%)");
    expect(itemColor("Copper Plate")).toBe("hsl(76 65% 60%)");
  });

  it("keeps the hue within 0-359", () => {
    for (const id of ["Iron Plate", "Copper Plate", "belt", "Gear", ""]) {
      const hue = itemHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });
});
