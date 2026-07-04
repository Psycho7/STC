import iconsMeta from "@aef/icons/data.json";

// Stable per-item edge color. The same item id always maps to the same hue, so
// one item stays visually traceable across local edges, trunks, and branches.
// The hue comes from the item's icon dominant color; saturation and lightness
// are normalized into one of two fixed bands chosen for legibility on the
// existing cyan-on-dark theme. The exact hue values are pinned by tests so the
// mapping cannot drift silently.
//
// Hue comes from the item's own icon. Each icon in the metadata ships a
// precomputed dominant color (a hex string); we convert that color to HSL once
// at module load and key items by their icon id. Deriving the hue from the icon
// keeps every item's edge/chip color tied to its recognizable identity, which
// the earlier synthetic golden-angle palette threw away. Icons of one product
// family share a hue by design (they share a dominant color), so family members
// intentionally collide rather than fanning across the wheel.
//
// The raw icon color itself is not usable as the edge color: many icons are too
// dark or too gray to read against the dark canvas. We normalize with a hybrid
// rule keyed on the icon's saturation:
//   - saturated icons (s >= 25%): render the icon hue in the theme's legible
//     65% / 60% saturation-lightness band.
//   - near-gray icons (s < 25%, e.g. carbon/iron/glass families): render at
//     12% / 62%, staying gray like the icon but light enough to read.
//
// Item ids with no icon entry (synthetic test ids and the like) fall back to a
// djb2 hash folded to 0-359, so itemHue never throws on an unknown id. Every
// real pack item has an icon entry, so the hash only ever serves synthetic ids.

// Saturation threshold (rounded percent) at or above which an icon keeps its
// vivid hue in the colored band. Icons below it render as a light gray so the
// near-gray icon families do not read as saturated color.
const COLOR_SATURATION_MIN = 25;

// Icon dominant color reduced to the two channels we use: hue and saturation.
type IconHS = { h: number; s: number };

// Parse "#rrggbb" (with or without leading '#') into an {h, s} pair. Hue is an
// integer 0-359 from the standard max/min formula; saturation is a rounded
// 0-100 percent. Lightness is discarded because the theme fixes it. Pure and
// module-private.
function hexToHS(hex: string): IconHS {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
    hue %= 360;
  }

  const saturation =
    delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return { h: hue, s: Math.round(saturation * 100) };
}

// Map every icon id to its dominant color's hue and saturation, built once at
// module load from the icon metadata.
type IconEntry = { id: string; color: string };
const iconHSById: ReadonlyMap<string, IconHS> = new Map(
  (iconsMeta as { icons: IconEntry[] }).icons.map((icon) => [
    icon.id,
    hexToHS(icon.color),
  ]),
);

// djb2: hash * 33 + c, folded to an unsigned 32-bit int each step so the result
// is stable regardless of platform integer width. The only fallback for item
// ids without an icon entry (for example synthetic test ids), so itemHue never
// throws on an unknown id.
function hashItemId(itemId: string): number {
  let hash = 5381;
  for (let i = 0; i < itemId.length; i++) {
    hash = (hash * 33 + itemId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function itemHue(itemId: string): number {
  const iconHS = iconHSById.get(itemId);
  if (iconHS !== undefined) {
    return iconHS.h;
  }
  return hashItemId(itemId) % 360;
}

export function itemColor(itemId: string): string {
  const iconHS = iconHSById.get(itemId);
  if (iconHS !== undefined) {
    return iconHS.s >= COLOR_SATURATION_MIN
      ? `hsl(${iconHS.h} 65% 60%)`
      : `hsl(${iconHS.h} 12% 62%)`;
  }
  return `hsl(${itemHue(itemId)} 65% 60%)`;
}
