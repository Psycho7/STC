import { describe, expect, it } from "vitest";
import {
  contrastAgainstCanvas,
  floorLightness,
  itemColor,
} from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// The floor implementation and this test share one luminance/contrast
// definition (contrastAgainstCanvas is exported from itemColor), so a scoring
// drift cannot let a failing color slip past.
const MIN_CONTRAST = 4.5;

type Hsl = { h: number; s: number; l: number };

function parseHsl(color: string): Hsl {
  const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color);
  if (match === null) throw new Error(`unparseable color: ${color}`);
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

describe("canvas/itemColor contrast floor", () => {
  it("clears 4.5:1 against the canvas background for every pack item", () => {
    for (const item of pack.items) {
      const { h, s, l } = parseHsl(itemColor(item.id));
      const contrast = contrastAgainstCanvas(h, s, l);
      expect(
        contrast,
        `${item.id} hsl(${h} ${s}% ${l}%) contrast ${contrast.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("clears 4.5:1 for both floored fallback rungs across the whole hue circle", () => {
    // The two fallback rungs (saturated 65/60, near-gray 12/62) serve every
    // hue: icon-only ids span the circle and synthetic ids hash anywhere. Each
    // must clear the floor once floorLightness has lifted it.
    for (let h = 0; h < 360; h++) {
      for (const [s, baseL] of [
        [65, 60],
        [12, 62],
      ] as const) {
        const l = floorLightness(h, s, baseL);
        const contrast = contrastAgainstCanvas(h, s, l);
        expect(
          contrast,
          `fallback hsl(${h} ${s}% ${l}%) contrast ${contrast.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    }
  });
});
