import iconsMeta from "@aef/icons/data.json";
import { pack } from "../data/load";

// Stable per-item edge color. The same item id always maps to the same hue, so
// one item stays visually traceable across local edges, trunks, and branches.
// The hue comes from the item's icon dominant color; saturation and lightness
// are normalized into legible bands for the existing cyan-on-dark theme. The
// mapping is pinned by tests so it cannot drift silently.
//
// Hue comes from the item's own icon. Each icon in the metadata ships a
// precomputed dominant color (a hex string); we convert that color to HSL once
// at module load and key items by their icon id. Deriving the hue from the icon
// keeps every item's edge/chip color tied to its recognizable identity, which
// the earlier synthetic golden-angle palette threw away.
//
// The raw icon color itself is not usable as the edge color: many icons are too
// dark or too gray to read against the dark canvas. We normalize with a hybrid
// rule keyed on the icon's saturation:
//   - saturated icons (s >= 25%): render the icon hue in the theme's legible
//     colored band (65% saturation base).
//   - near-gray icons (s < 25%, e.g. carbon/iron/glass families): render as a
//     light gray (12% saturation base), staying gray like the icon.
//
// Icons of one product family share a dominant color, so on hue alone family
// members would collide (copper_ore and copper_powder are 3 degrees apart).
// To keep members similar but visually distinct, pack items whose hues fall
// inside a band-specific visual window are separated in saturation/lightness:
// each item keeps its icon hue but takes a distinct rung from a small ladder
// of (saturation, lightness) pairs chosen to be pairwise distinguishable and
// legible. Rungs are assigned greedily over items sorted by (hue, id), so the
// assignment is deterministic for a given recipe pack. Deliberate tradeoff:
// an item's rung depends on its hue-window neighbors, so a pack update that
// adds, renames, or removes an item can reshuffle the rungs of nearby items.
// Per-item color stability across pack versions is intentionally not
// guaranteed; guaranteed pairwise distinctness within a window is impossible
// to combine with neighbor-independent assignment (pigeonhole).
//
// Item ids with no icon entry (synthetic test ids and the like) fall back to a
// djb2 hash folded to 0-359, so itemHue never throws on an unknown id. Every
// real pack item has an icon entry, so the hash only ever serves synthetic ids.
// Icon ids that are not pack items (machines, transports) skip the separation
// pass and keep the base band color.

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

// Visual windows: two same-band hues closer than this read as the same hue on
// the canvas, so the items must differ in saturation or lightness instead. The
// gray band's window is wider because at 12-22% saturation the hue tint is
// much weaker.
const SAT_HUE_WINDOW = 10;
const GRAY_HUE_WINDOW = 24;

// (saturation, lightness) rung ladders, ordered so early rungs stay closest to
// the band's base look. Every pair of rungs within a ladder differs by a
// lightness step >= 8 or a saturation step >= 10, so any two rungs are
// distinguishable at the same hue. Ladder capacity covers the densest hue
// cluster in the current pack (10 copper-family items within one window); a
// pack that outgrows a ladder gets spread repeats (see assignRungs) and fails
// the no-identical-colors test.
const SAT_RUNGS: readonly (readonly [number, number])[] = [
  [65, 60],
  [65, 70],
  [65, 50],
  [85, 64],
  [45, 64],
  [85, 54],
  [45, 54],
  [85, 74],
  [45, 74],
  [65, 78],
];
const GRAY_RUNGS: readonly (readonly [number, number])[] = [
  [12, 62],
  [12, 70],
  [12, 54],
  [22, 66],
  [22, 58],
  [12, 78],
  [22, 74],
  [22, 50],
  [12, 46],
];

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

// Greedily hand out rungs over entries sorted by (hue, id) and return the
// finished hsl string per item id: each entry keeps its own hue and takes the
// first rung not already held by an assigned entry within the hue window.
// Sorting makes the result deterministic for a given pack. The ladder is sized
// so real pack data never exhausts it; if a future pack does, overflow entries
// cycle through the ladder by neighbor count (spread repeats instead of all
// colliding on rung 0) and the no-identical-colors test fails loudly.
function assignRungs(
  entries: readonly { id: string; h: number }[],
  window: number,
  rungs: readonly (readonly [number, number])[],
): Map<string, string> {
  const sorted = [...entries].sort(
    (a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assigned: { h: number; rung: number }[] = [];
  const out = new Map<string, string>();
  for (const entry of sorted) {
    const used = new Set<number>();
    let neighbors = 0;
    for (const prior of assigned) {
      if (circularHueDistance(entry.h, prior.h) < window) {
        used.add(prior.rung);
        neighbors++;
      }
    }
    let rung = neighbors % rungs.length;
    for (let i = 0; i < rungs.length; i++) {
      if (!used.has(i)) {
        rung = i;
        break;
      }
    }
    assigned.push({ h: entry.h, rung });
    const [s, l] = rungs[rung]!;
    out.set(entry.id, `hsl(${entry.h} ${s}% ${l}%)`);
  }
  return out;
}

// Final color per pack item id, built once at module load: split pack items
// into the two bands, separate hue-neighbors within each band, and render the
// icon hue at the assigned rung.
const packColorById: ReadonlyMap<string, string> = (() => {
  const saturated: { id: string; h: number }[] = [];
  const gray: { id: string; h: number }[] = [];
  for (const item of pack.items) {
    const iconHS = iconHSById.get(item.id);
    if (iconHS === undefined) continue;
    const list = iconHS.s >= COLOR_SATURATION_MIN ? saturated : gray;
    list.push({ id: item.id, h: iconHS.h });
  }
  const out = new Map<string, string>();
  for (const [entries, window, rungs] of [
    [saturated, SAT_HUE_WINDOW, SAT_RUNGS],
    [gray, GRAY_HUE_WINDOW, GRAY_RUNGS],
  ] as const) {
    for (const [id, color] of assignRungs(entries, window, rungs)) {
      out.set(id, color);
    }
  }
  return out;
})();

export function itemHue(itemId: string): number {
  const iconHS = iconHSById.get(itemId);
  if (iconHS !== undefined) {
    return iconHS.h;
  }
  return hashItemId(itemId) % 360;
}

export function itemColor(itemId: string): string {
  const packColor = packColorById.get(itemId);
  if (packColor !== undefined) {
    return packColor;
  }
  const iconHS = iconHSById.get(itemId);
  if (iconHS !== undefined) {
    return iconHS.s >= COLOR_SATURATION_MIN
      ? `hsl(${iconHS.h} 65% 60%)`
      : `hsl(${iconHS.h} 12% 62%)`;
  }
  return `hsl(${itemHue(itemId)} 65% 60%)`;
}
