import { describe, expect, it } from "vitest";
import { itemColor, itemHue } from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// Circular distance between two hues on the 0-359 wheel.
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("canvas/itemColor", () => {
  it("returns the same color for the same item id", () => {
    expect(itemColor("Iron Plate")).toBe(itemColor("Iron Plate"));
    expect(itemHue("Copper Plate")).toBe(itemHue("Copper Plate"));
  });

  it("returns different hues for two distinct item ids", () => {
    expect(itemHue("Iron Plate")).not.toBe(itemHue("Copper Plate"));
  });

  it("pins the exact hsl string for unknown item ids so the fallback cannot drift", () => {
    // These synthetic ids are not present in the recipe pack, so they exercise
    // the djb2 fallback path; the hues match the pre-golden-angle mapping.
    expect(itemColor("Iron Plate")).toBe("hsl(163 65% 60%)");
    expect(itemColor("Copper Plate")).toBe("hsl(76 65% 60%)");
  });

  it("pins golden-angle hues for the first sorted pack item ids", () => {
    const sortedIds = pack.items.map((item) => item.id).sort();
    // Golden-angle spacing: round(rank * 137.508) % 360 for ranks 0,1,2,3.
    expect(itemHue(sortedIds[0]!)).toBe(0);
    expect(itemHue(sortedIds[1]!)).toBe(138);
    expect(itemHue(sortedIds[2]!)).toBe(275);
    expect(itemHue(sortedIds[3]!)).toBe(53);
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

  it("keeps every recipe's input items above a minimum pairwise hue distance", () => {
    // Golden-angle spacing does not guarantee a large gap between the specific
    // items that share a single recipe's input list, so we assert only the floor
    // actually achieved across the whole pack. The measured minimum is 3 degrees
    // (recipe crystal_enr_powder-crystal_powder, inputs crystal_powder vs
    // plant_moss_powder_3); the floor sits just under that so the test flags a
    // regression without pretending the spacing is collision-free.
    const MIN_INPUT_HUE_DISTANCE = 2;
    let worst = Infinity;
    for (const recipe of pack.recipes) {
      const inputs = [...new Set(recipe.in.map((entry) => entry.item))];
      for (let a = 0; a < inputs.length; a++) {
        for (let b = a + 1; b < inputs.length; b++) {
          worst = Math.min(
            worst,
            hueDistance(itemHue(inputs[a]!), itemHue(inputs[b]!)),
          );
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(MIN_INPUT_HUE_DISTANCE);
  });
});
