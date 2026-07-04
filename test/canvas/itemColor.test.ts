import { describe, expect, it } from "vitest";
import { itemColor, itemHue } from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

describe("canvas/itemColor", () => {
  it("returns the same color for the same item id", () => {
    expect(itemColor("Iron Plate")).toBe(itemColor("Iron Plate"));
    expect(itemHue("Copper Plate")).toBe(itemHue("Copper Plate"));
  });

  it("returns different hues for two icon families", () => {
    // belt derives hue 22 from its icon, carbon_powder derives hue 180.
    expect(itemHue("belt")).toBe(22);
    expect(itemHue("carbon_powder")).toBe(180);
    expect(itemHue("belt")).not.toBe(itemHue("carbon_powder"));
  });

  it("pins the exact hsl string for unknown item ids so the fallback cannot drift", () => {
    // These synthetic ids are absent from both the icon set and the recipe pack,
    // so they exercise the djb2 fallback path; the hues match the original
    // pre-golden-angle mapping.
    expect(itemColor("Iron Plate")).toBe("hsl(163 65% 60%)");
    expect(itemColor("Copper Plate")).toBe("hsl(76 65% 60%)");
  });

  it("pins the saturated icon branch", () => {
    // belt icon #db9166 -> h 22, s 62 (>= 25) -> legible colored band.
    expect(itemColor("belt")).toBe("hsl(22 65% 60%)");
  });

  it("pins the near-gray icon branch", () => {
    // carbon_powder icon #4c4e4e -> h 180, s 1 (< 25) -> light gray band.
    expect(itemColor("carbon_powder")).toBe("hsl(180 12% 62%)");
  });

  it("keeps the hue within 0-359", () => {
    const ids = [
      "Iron Plate",
      "Copper Plate",
      "belt",
      "Gear",
      "",
      ...pack.items.map((item) => item.id),
    ];
    for (const id of ids) {
      const hue = itemHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it("keeps every pack item color on the legible saturation/lightness band", () => {
    // Every pack item resolves to one of the two normalized bands: the colored
    // band (65% 60%) for saturated icons and the fallback, or the near-gray band
    // (12% 62%) for near-gray icons. No raw icon color leaks through.
    for (const item of pack.items) {
      expect(itemColor(item.id)).toMatch(/^hsl\(\d+ (65% 60%|12% 62%)\)$/);
    }
  });
});
