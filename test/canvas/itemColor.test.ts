import { describe, expect, it } from "vitest";
import iconsMeta from "@aef/icons/data.json";
import {
  deltaE,
  hslToLab,
  itemColor,
  itemHue,
} from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// Perceptual floors two pack colors must clear to read as different lines,
// split by band (measured 2026-09-07): two saturated-band items clear 15, and
// any pair involving the gray band - gray-gray or cross-band - clears 8. A
// uniform 15 is unreachable on this pack even with the gray band deleted
// (ceiling 13.65), so the gray-involved tier sits at the measured reachable 8.
// The metric comes from the implementation (deltaE/hslToLab are exported) so a
// scoring drift cannot let a failing pair slip past.
const SATURATED_FLOOR = 15;
const GRAY_FLOOR = 8;

// Largest hue offset the separation may apply to an item whose icon hue could
// not clear its floor on the widened saturation/lightness grid alone.
const HUE_NUDGE_CAP = 15;

// Icon-saturation threshold that splits the colored and gray bands; mirrors
// COLOR_SATURATION_MIN in the implementation.
const COLOR_SATURATION_MIN = 25;

type Hsl = { h: number; s: number; l: number };

function parseHsl(color: string): Hsl {
  const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color);
  if (match === null) throw new Error(`unparseable color: ${color}`);
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

// Hue of an icon's dominant color, derived here from the vendor metadata so the
// expectation does not borrow the implementation's own lookup.
function iconHue(iconId: string): number {
  const icons = (iconsMeta as { icons: { id: string; color: string }[] }).icons;
  const icon = icons.find((entry) => entry.id === iconId);
  if (icon === undefined) throw new Error(`no icon metadata for ${iconId}`);
  const hex = icon.color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sector =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return ((Math.round(sector * 60) % 360) + 360) % 360;
}

function labOf(itemId: string): [number, number, number] {
  const { h, s, l } = parseHsl(itemColor(itemId));
  return hslToLab(h, s, l);
}

// Icon dominant hex -> rounded saturation percent, mirroring the
// module-private conversion in itemColor.ts. The tests classify a band by the
// item's icon (the band policy's input), not by the placed saturation (an
// output the widened gray cap can push past the icon threshold).
function iconSaturation(hex: string): number {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation =
    delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return Math.round(saturation * 100);
}

const grayBandIds: ReadonlySet<string> = new Set(
  (iconsMeta as { icons: { id: string; color: string }[] }).icons
    .filter((icon) => iconSaturation(icon.color) < COLOR_SATURATION_MIN)
    .map((icon) => icon.id),
);

// Icon an item draws its color from. Upstream renamed some item icons, so
// item.id === item.icon no longer holds pack-wide; the band lookup has to go
// through the icon the color path itself reads or a renamed item silently
// falls back to its own id and lands in the wrong band.
const iconIdByItemId: ReadonlyMap<string, string> = new Map(
  pack.items.map((item) => [item.id, item.icon]),
);

function grayBanded(itemId: string): boolean {
  return grayBandIds.has(iconIdByItemId.get(itemId) ?? itemId);
}

// Floor for a pair: saturated-saturated clears 15; any pair involving a
// gray-band item clears 8.
function floorForPair(aId: string, bId: string): number {
  return grayBanded(aId) || grayBanded(bId) ? GRAY_FLOOR : SATURATED_FLOOR;
}

// Circular hue distance 0-180.
function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

// FNV-1a over the canonical placement string: "<id>|<h> <s> <l>" lines, ids in
// plain < order, joined with newlines. tools/color/ledger.ts prints the same
// fingerprint so a working tree can be cross-checked outside the suite, and its
// --map output names exactly which entries a changed hash involves.
function placementFingerprint(): string {
  const canonical = pack.items
    .map((item) => ({ id: item.id, color: parseHsl(itemColor(item.id)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => `${row.id}|${row.color.h} ${row.color.s} ${row.color.l}`)
    .join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("canvas/itemColor", () => {
  it("returns the same color for the same item id", () => {
    expect(itemColor("Iron Plate")).toBe(itemColor("Iron Plate"));
    expect(itemHue("Copper Plate")).toBe(itemHue("Copper Plate"));
  });

  it("returns different hues for two icon families", () => {
    // belt derives hue 22 from its icon, carbon_powder derives hue 30.
    expect(itemHue("belt")).toBe(22);
    expect(itemHue("carbon_powder")).toBe(30);
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
    // carbon_powder icon #4e4d4c -> h 30, s 1 (< 25) -> light gray band,
    // which now tops out at saturation 34 (still a tint that reads gray).
    expect(parseHsl(itemColor("carbon_powder")).h).toBe(30);
    expect(parseHsl(itemColor("carbon_powder")).s).toBeLessThanOrEqual(34);
  });

  it("colors items whose icon id differs from their own id through that icon", () => {
    // Upstream renamed some item icons to opaque ids, so item.id === item.icon
    // no longer holds pack-wide. Those items must keep their icon-family hue
    // instead of dropping to the djb2 fallback, which puts unrelated items on
    // arbitrary hues and can collide two members of one family.
    const renamed = pack.items.filter((item) => item.icon !== item.id);
    expect(renamed.map((item) => item.id)).toEqual([
      "iron_bottle-liquid_plant_grass_1",
      "iron_bottle-liquid_plant_grass_2",
      "copper_bottle-liquid_plant_grass_1",
      "copper_bottle-liquid_plant_grass_2",
    ]);
    for (const item of renamed) {
      expect(itemHue(item.id), item.id).toBe(iconHue(item.icon));
    }
    const d = deltaE(
      labOf("iron_bottle-liquid_plant_grass_1"),
      labOf("iron_bottle-liquid_plant_grass_2"),
    );
    expect(d, `iron bottle pair deltaE ${d.toFixed(2)}`).toBeGreaterThanOrEqual(
      floorForPair(
        "iron_bottle-liquid_plant_grass_1",
        "iron_bottle-liquid_plant_grass_2",
      ),
    );
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

  it("pins the whole placement map so a reshuffle cannot land silently", () => {
    // A changed fingerprint means some item's hsl moved. The accepted causes
    // are the gray-band saturation cap widening and the repair pass for
    // sub-floor pairs; any other change is a reshuffle the commit that ships
    // it must explain. tools/color/ledger.ts --map names the moved entries.
    // 0d710d7f is the placement after the gray cap rose from 24 to 34 (the
    // one accepted full reshuffle: 57 of 113 entries moved through the
    // placement pass's accumulated priors); ff166069 was the pre-widening
    // placement.
    expect(placementFingerprint()).toBe("0d710d7f");
  });

  it("keeps every pair of pack item colors perceptually distinct", () => {
    // Channel deltas are not a perceptual metric: hsl(233 12% 70%) and
    // hsl(258 12% 70%) differ by 25 degrees of hue and read as one gray. Each
    // pair clears the floor for its band pair: 15 for two saturated-band
    // items, 8 once the gray band is involved. Every violation is collected
    // into one assertion so a red run lists the full offender set, matching
    // the ledger's pairs-below-floor list.
    const labs = pack.items.map((item) => {
      const { h, s, l } = parseHsl(itemColor(item.id));
      return { id: item.id, lab: hslToLab(h, s, l) };
    });
    const violations: string[] = [];
    for (const [i, a] of labs.entries()) {
      for (const b of labs.slice(i + 1)) {
        const floor = floorForPair(a.id, b.id);
        const d = deltaE(a.lab, b.lab);
        if (d < floor) {
          violations.push(
            `${a.id} vs ${b.id} deltaE ${d.toFixed(2)} under floor ${floor}`,
          );
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });

  it("separates the item families the render exam could not trace", () => {
    // Regression pins for the corridors the 2026-07-18 render exam could not
    // follow by color; a future pack or candidate-set change must not put any
    // of these back on top of each other. Each pair clears its band tier's
    // floor, same rule as the all-pairs test above.
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
        floorForPair(aId, bId),
      );
    }
  });

  it("keeps every pack item's hue within 15 degrees of its icon hue", () => {
    // Separation moves saturation and lightness freely; hue may only nudge -
    // by at most 15 degrees, and only for an item whose floor could not be
    // cleared on the widened grid at its icon hue - so an edge still reads as
    // its product family.
    for (const item of pack.items) {
      const h = parseHsl(itemColor(item.id)).h;
      const offset = hueDistance(itemHue(item.id), h);
      expect(
        offset,
        `${item.id} icon hue ${itemHue(item.id)} placed ${h}`,
      ).toBeLessThanOrEqual(HUE_NUDGE_CAP);
    }
  });

  it("pins the items whose hue sits off their icon hue", () => {
    // The nudge is a last resort, so the moved set is pinned outright: a pack
    // update cannot start nudging items silently. Each entry names the item
    // and its offset from the icon hue.
    const nudged = pack.items
      .map((item) => ({
        id: item.id,
        offset: hueDistance(itemHue(item.id), parseHsl(itemColor(item.id)).h),
      }))
      .filter((row) => row.offset !== 0)
      .map((row) => `${row.id} +${row.offset}`);
    expect(nudged.join(", ")).toBe("");
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
    // Every placed color stays inside its own band's legible window: a
    // saturated-band item keeps a clearly colored saturation (>= 35, the floor
    // of SAT_CANDIDATES), and a gray-band item stays a tint that still reads
    // gray on the dark canvas (<= 34, the band's widened cap). Checking each
    // item against its own band keeps this a real guard: the two windows now
    // abut, so a single combined `s >= 35 || s <= 34` bound would admit every
    // saturation and assert nothing. Band membership comes from the icon, the
    // input the placement policy keys on, not from the placed saturation.
    // The lightness bounds are computed per color by the contrast floor rather
    // than picked from a list, so they are what proves no raw icon color leaks.
    for (const item of pack.items) {
      const { s, l } = parseHsl(itemColor(item.id));
      if (grayBanded(item.id)) {
        expect(s, `${item.id} gray-band saturation ${s}`).toBeLessThanOrEqual(
          34,
        );
      } else {
        expect(
          s,
          `${item.id} saturated-band saturation ${s}`,
        ).toBeGreaterThanOrEqual(35);
      }
      expect(l, `${item.id} lightness ${l}`).toBeGreaterThanOrEqual(46);
      expect(l, `${item.id} lightness ${l}`).toBeLessThanOrEqual(90);
    }
  });
});
