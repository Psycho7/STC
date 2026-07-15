import { describe, expect, it } from "vitest";
import { itemColor, itemHue } from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// Mirror of the implementation's visual-window constants: two same-band items
// whose hues are closer than the window read as the same hue, so they must be
// separated in saturation or lightness instead.
const SAT_HUE_WINDOW = 10;
const GRAY_HUE_WINDOW = 24;

type Hsl = { h: number; s: number; l: number };

function parseHsl(color: string): Hsl {
  const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color);
  if (match === null) throw new Error(`unparseable color: ${color}`);
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
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

  it("separates hue-neighbor pack items in saturation or lightness", () => {
    // Two same-band items whose hues sit inside the visual window are
    // indistinguishable by hue alone, so they must differ by a visible
    // lightness step (>= 8) or saturation step (>= 10).
    const parsed = pack.items.map((item) => ({
      id: item.id,
      ...parseHsl(itemColor(item.id)),
    }));
    for (const [i, a] of parsed.entries()) {
      for (const b of parsed.slice(i + 1)) {
        const sameBand = a.s >= 25 === b.s >= 25;
        const window = a.s >= 25 ? SAT_HUE_WINDOW : GRAY_HUE_WINDOW;
        if (!sameBand || circularHueDistance(a.h, b.h) >= window) continue;
        const distinct = Math.abs(a.l - b.l) >= 8 || Math.abs(a.s - b.s) >= 10;
        expect(
          distinct,
          `${a.id} hsl(${a.h} ${a.s}% ${a.l}%) vs ${b.id} hsl(${b.h} ${b.s}% ${b.l}%)`,
        ).toBe(true);
      }
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
    // Saturated icons stay clearly colored (s >= 45), near-gray icons stay
    // gray-ish (s <= 22), and every lightness lands where it reads against the
    // dark canvas. No raw icon color leaks through. The upper bound is 90, not
    // the old rung ceiling of 78: the contrast floor plus its upward re-spread
    // can lift a crowded deep-red rung into the pale band to hold both the
    // 4.5:1 floor and the >= 8 lightness gap from its hue-window neighbors.
    for (const item of pack.items) {
      const { s, l } = parseHsl(itemColor(item.id));
      expect(s >= 45 || s <= 22, `${item.id} saturation ${s}`).toBe(true);
      expect(l, `${item.id} lightness ${l}`).toBeGreaterThanOrEqual(46);
      expect(l, `${item.id} lightness ${l}`).toBeLessThanOrEqual(90);
    }
  });
});
