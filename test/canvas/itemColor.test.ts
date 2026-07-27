import { describe, expect, it } from "vitest";
import {
  deltaE,
  hslToLab,
  itemColor,
  itemHue,
} from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// Perceptual floor two pack colors must clear to read as different lines. The
// metric comes from the implementation (deltaE/hslToLab are exported) so a
// scoring drift cannot let a failing pair slip past.
const MIN_DELTA_E = 6;

type Hsl = { h: number; s: number; l: number };

function parseHsl(color: string): Hsl {
  const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color);
  if (match === null) throw new Error(`unparseable color: ${color}`);
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

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
    expect(parseHsl(itemColor("carbon_powder")).h).toBe(180);
    expect(parseHsl(itemColor("carbon_powder")).s).toBeLessThan(25);
  });

  it("never returns the identical color for two different pack items", () => {
    const byColor = new Map<string, string>();
    for (const item of pack.items) {
      const color = itemColor(item.id);
      const holder = byColor.get(color);
      expect(holder, `${item.id} and ${holder} share ${color}`).toBeUndefined();
      byColor.set(color, item.id);
    }
  });

  it("keeps every pair of pack item colors perceptually distinct", () => {
    // Channel deltas are not a perceptual metric: hsl(233 12% 70%) and
    // hsl(258 12% 70%) differ by 25 degrees of hue and read as one gray.
    const labs = pack.items.map((item) => {
      const { h, s, l } = parseHsl(itemColor(item.id));
      return { id: item.id, lab: hslToLab(h, s, l) };
    });
    for (const [i, a] of labs.entries()) {
      for (const b of labs.slice(i + 1)) {
        const d = deltaE(a.lab, b.lab);
        expect(
          d,
          `${a.id} vs ${b.id} deltaE ${d.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(MIN_DELTA_E);
      }
    }
  });

  it("separates the item families the render exam could not trace", () => {
    // Regression pins for the corridors the 2026-07-18 render exam could not
    // follow by color; a future pack or candidate-set change must not put any
    // of these back on top of each other.
    const pairs: readonly (readonly [string, string])[] = [
      ["copper_nugget", "copper_cmpt"],
      ["liquid_plant_grass_1", "xiranite_enr_powder"],
      ["gas_xiranite", "bottled_food_1"],
      ["xiranite_powder", "gas_xiranite"],
      ["equip_script_1", "glass_bottle"],
    ];
    for (const [aId, bId] of pairs) {
      const a = parseHsl(itemColor(aId));
      const b = parseHsl(itemColor(bId));
      const d = deltaE(hslToLab(a.h, a.s, a.l), hslToLab(b.h, b.s, b.l));
      expect(d, `${aId} vs ${bId} deltaE ${d.toFixed(2)}`).toBeGreaterThanOrEqual(
        MIN_DELTA_E,
      );
    }
  });

  it("keeps every pack item's hue pinned to its icon hue", () => {
    // Separation only moves saturation/lightness; the hue stays the item's
    // icon-derived family hue so edges remain recognizable by product family.
    for (const item of pack.items) {
      expect(parseHsl(itemColor(item.id)).h).toBe(itemHue(item.id));
    }
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

  it("keeps every pack item color inside the legible range", () => {
    // Saturated icons stay clearly colored (s >= 35), near-gray icons stay
    // gray-ish (s <= 24, under the COLOR_SATURATION_MIN threshold), and every
    // lightness lands where it reads against the dark canvas. No raw icon color
    // leaks through.
    for (const item of pack.items) {
      const { s, l } = parseHsl(itemColor(item.id));
      expect(s >= 35 || s <= 24, `${item.id} saturation ${s}`).toBe(true);
      expect(l, `${item.id} lightness ${l}`).toBeGreaterThanOrEqual(46);
      expect(l, `${item.id} lightness ${l}`).toBeLessThanOrEqual(90);
    }
  });
});
