import iconsMeta from "@aef/icons/data.json";
import { pack } from "../data/load";
import { iconIdForItem } from "./iconSprite";

// Stable per-item edge color. The same item id always maps to the same hue, so
// one item stays visually traceable across local edges, trunks, and branches.
// The hue comes from the item's icon dominant color; saturation and lightness
// are normalized into legible bands for the existing cyan-on-dark theme. Every
// emitted color clears a WCAG 4.5:1 contrast floor against the canvas
// background (lightness is raised per hue until it clears); a contrast test
// enforces that floor and a perceptual-distance test enforces the pairwise
// distinctness, so neither can drift silently.
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
//     colored band (35-95% saturation, 65% for the fallback).
//   - near-gray icons (s < 25%, e.g. carbon/iron/glass families): render as a
//     light gray (8-24% saturation, 12% for the fallback), staying gray like
//     the icon.
//
// Icons of one product family share a dominant color, so on hue alone family
// members would collide (copper_ore and copper_powder are 3 degrees apart).
// To keep members similar but visually distinct, each pack item keeps its icon
// hue but is placed at the (saturation, lightness) pair furthest in CIE Lab
// from every color already placed. Lab distance is the metric
// because per-channel hsl deltas are not perceptual: two colors 25 degrees of
// hue apart at 12% saturation read as one gray. See assignColors for the
// placement and its determinism/stability tradeoff, and
// repairOffendingPairs for the floor-enforcing pass that follows it: pairs the
// max-min placement left under the two-tier separation floor get their
// later-placed member re-placed on a finer grid at the same icon hue, so only
// offenders ever move.
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

function iconHSFor(itemId: string): IconHS | undefined {
  return iconHSById.get(iconIdForItem(itemId) ?? itemId);
}

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

// Legibility floor and ceiling for assigned lightness: below the floor the
// color sinks into the canvas, above the ceiling it washes out against light UI
// surfaces (chip fills, hover cards). Matches the range test.
const LIGHT_FLOOR = 46;
const LIGHT_CAP = 90;
// Lightness granularity of the placement search. Step 2 halves the candidate
// count without measurably changing the resulting separation.
const LIGHT_STEP = 2;

// Saturation candidates per band, ordered so ties fall to the first entry. The
// gray band's ladder keeps its step-4 rhythm and clamps its top rung to the 34
// gray ceiling - past the icon-saturation threshold, but a saturation that
// still reads as a gray tint on the dark canvas - so the crowded band has room
// to clear its floor of 8 against its own members.
const SAT_CANDIDATES: readonly number[] = [35, 45, 55, 65, 75, 85, 95];
const GRAY_SAT_CEILING = 34;
const GRAY_CANDIDATES: readonly number[] = [
  8, 12, 16, 20, 24, 28, 32, GRAY_SAT_CEILING,
];

// Two-tier separation floor the repair pass enforces (measured 2026-09-07):
// two saturated-band items must clear 15, and any pair involving the gray band
// - gray-gray or cross-band - must clear 8. A uniform 15 is unreachable on
// this pack even with the gray band deleted (ceiling 13.65), so pairs the
// gray band takes part in sit at the measured reachable 8.
const SATURATED_PAIR_FLOOR = 15;
const GRAY_PAIR_FLOOR = 8;

// Repair-grid shape, for the pass that re-places pairs the max-min placement
// left under those floors. Saturation steps by 5 within the item's band; the
// gray band's rungs start at 5 and always include the 34 ceiling. Lightness
// runs by 1 up to a cap near the contrast-safe maximum: contrast against the
// near-black canvas is monotone in lightness and no consumer paints these
// colors on a light surface, so the binding limit at the top is the hue still
// reading - at lightness 96 the chroma factor is 8 percent, about where a
// color starts washing to white. The sweep bound is belt-and-braces: every
// accepted move clears the mover against all others, so the offender set can
// only shrink and the pass terminates regardless.
const REPAIR_SAT_STEP = 5;
const REPAIR_GRAY_SAT_MIN = 5;
const REPAIR_LIGHT_CAP = 96;
const REPAIR_MAX_SWEEPS = 8;

// Canvas background the edge colors and chips sit on (--ak-bg-canvas). The floor
// below keeps every color readable against this near-black. Exported so the CSS
// contract test can pin it against the custom property the browser actually
// paints: every contrast result here is wrong if the two drift apart.
export const CANVAS_BG_HEX = "#0f1114";
// WCAG AA text-contrast target. Edges and chip borders are thin strokes, so we
// hold every item color to at least this ratio against the canvas background.
const MIN_CONTRAST = 4.5;

// sRGB -> linear channel, the WCAG gamma expansion. Shared by both luminance
// entry points so hex and hsl luminance agree to the last digit.
function linearizeChannel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// WCAG relative luminance of an sRGB triple with channels already in 0..1.
function srgbRelativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

// hsl() color (h 0-359, s/l 0-100) to an sRGB triple with channels in 0..1.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m];
}

// WCAG relative luminance of an hsl() color (h 0-359, s/l 0-100). Feeds
// contrastAgainstCanvas, the single contrast definition shared by the runtime
// floor and the contrast test. Module-private.
function hslRelativeLuminance(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l);
  return srgbRelativeLuminance(r, g, b);
}

// CIE Lab (D65) of an hsl() color. Lab is roughly perceptually uniform, so a
// Euclidean distance in it approximates how different two colors look, which
// per-channel hsl deltas do not.
export function hslToLab(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const rgb = hslToRgb(h, s, l);
  const r = linearizeChannel(rgb[0]);
  const g = linearizeChannel(rgb[1]);
  const b = linearizeChannel(rgb[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Squared CIE76 difference. The placement search only compares distances, so
// it stays on the square and keeps the sqrt out of its inner loop.
function deltaESq(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

// CIE76 color difference: Euclidean distance in Lab. Exported for the same
// reason contrastAgainstCanvas is: the distinctness test scores with the
// implementation's own metric, so a scoring drift cannot hide a failure.
export function deltaE(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.sqrt(deltaESq(a, b));
}

const CANVAS_BG_LUMINANCE: number = (() => {
  const hex = CANVAS_BG_HEX.startsWith("#")
    ? CANVAS_BG_HEX.slice(1)
    : CANVAS_BG_HEX;
  return srgbRelativeLuminance(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  );
})();

// WCAG contrast ratio of an hsl() color against the canvas background. Item
// colors are always lighter than the near-black canvas, so the background is
// the darker term. Exported for the contrast test.
export function contrastAgainstCanvas(h: number, s: number, l: number): number {
  return (
    (hslRelativeLuminance(h, s, l) + 0.05) / (CANVAS_BG_LUMINANCE + 0.05)
  );
}

// Smallest integer lightness >= l that clears MIN_CONTRAST at this hue and
// saturation. Lightness is the contrast knob and the required lift is hue- and
// saturation-adaptive: greens already clear the floor near their base rung,
// while a dark blue or deep red must climb well above it.
export function floorLightness(h: number, s: number, l: number): number {
  let out = l;
  while (out < 100 && contrastAgainstCanvas(h, s, out) < MIN_CONTRAST) {
    out++;
  }
  return out;
}

// Place one band's entries greedily over entries sorted by (hue, id), writing
// the finished hsl string per item id into out. Each entry keeps its own hue
// and takes the (saturation, lightness) candidate whose Lab color is furthest
// from the nearest color already placed - a max-min placement. Every prior
// counts, with no hue filter: hue distance means one thing at 85% saturation
// and almost nothing at 12%, so a single hue window cannot express "these two
// read as one line" and any pair it exempted could land on top of another.
// Priors accumulate across both bands so a muted colored item cannot collide
// with a tinted gray one. Candidates under the contrast floor are never
// offered, which is what keeps the floor from collapsing two placements onto
// one color. Sorting plus first-wins tie-breaking (lowest saturation index,
// then lowest lightness) makes the result deterministic for a given pack.
//
// Deliberate tradeoff, unchanged from the rung ladders this replaces: an
// entry's color depends on the entries placed before it, so a pack update that
// adds, renames, or removes an item can shift the colors of others. Per-item
// stability across pack versions is not guaranteed.
// One placed pack item: its icon hue, the band it placed in, the chosen
// saturation/lightness, and the Lab point the searches compare. The repair
// pass re-places these records in placement order.
type PlacedItem = {
  id: string;
  h: number;
  gray: boolean;
  s: number;
  l: number;
  lab: [number, number, number];
};

function assignColors(
  entries: readonly { id: string; h: number; gray: boolean }[],
  saturations: readonly number[],
  assigned: [number, number, number][],
  out: Map<string, string>,
  placed: PlacedItem[],
): void {
  const sorted = [...entries].sort(
    (a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const entry of sorted) {
    let bestS = saturations[0]!;
    let bestL = LIGHT_FLOOR;
    let bestScore = -1;
    for (const s of saturations) {
      // Contrast rises with lightness, so one floorLightness call per
      // saturation bounds the whole lane instead of a ratio per candidate.
      const lo = floorLightness(entry.h, s, LIGHT_FLOOR);
      for (let l = LIGHT_FLOOR; l <= LIGHT_CAP; l += LIGHT_STEP) {
        if (l < lo) continue;
        const lab = hslToLab(entry.h, s, l);
        // Distances are only ever compared, so the search stays on the
        // squared metric and never takes a sqrt in the inner loop.
        let score = Infinity;
        for (const prior of assigned) {
          const d = deltaESq(lab, prior);
          if (d < score) {
            score = d;
            // Already no better than the incumbent, so nothing further in
            // this candidate can change the outcome.
            if (score <= bestScore) break;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestS = s;
          bestL = l;
        }
      }
    }
    const lab = hslToLab(entry.h, bestS, bestL);
    assigned.push(lab);
    placed.push({
      id: entry.id,
      h: entry.h,
      gray: entry.gray,
      s: bestS,
      l: bestL,
      lab,
    });
    out.set(entry.id, `hsl(${entry.h} ${bestS}% ${bestL}%)`);
  }
}

// The floor one placed pair must clear: 15 between two saturated-band items,
// 8 once the gray band is involved.
function pairFloor(a: PlacedItem, b: PlacedItem): number {
  return a.gray || b.gray ? GRAY_PAIR_FLOOR : SATURATED_PAIR_FLOOR;
}

// Saturation rungs of the repair grid for one band: every REPAIR_SAT_STEP
// from the band's lowest rung to its ceiling, with the ceiling always a rung
// even when the step does not land on it (the gray band tops out at 34).
function repairSaturationRungs(gray: boolean): number[] {
  const first = gray ? REPAIR_GRAY_SAT_MIN : SAT_CANDIDATES[0]!;
  const cap = gray ? GRAY_SAT_CEILING : SAT_CANDIDATES[SAT_CANDIDATES.length - 1]!;
  const rungs: number[] = [];
  for (let s = first; s <= cap; s += REPAIR_SAT_STEP) {
    rungs.push(s);
  }
  if (rungs[rungs.length - 1] !== cap) {
    rungs.push(cap);
  }
  return rungs;
}

type RepairCandidate = {
  s: number;
  l: number;
  lab: [number, number, number];
  minDistanceSq: number;
};

// Best eligible repair point for one item at its own icon hue, against every
// other placed item. A candidate is eligible only if it clears the pair floor
// against all of them (and lightness never starts below the contrast floor),
// so accepting a candidate cannot break a pair that already cleared; among
// eligible candidates the largest minimum squared distance wins, and strict
// comparison keeps the first in grid order (lowest saturation, then lowest
// lightness) on ties, so the search is deterministic.
function searchRepairGrid(
  mover: PlacedItem,
  others: readonly PlacedItem[],
): RepairCandidate | undefined {
  let best: RepairCandidate | undefined;
  for (const s of repairSaturationRungs(mover.gray)) {
    const lo = floorLightness(mover.h, s, LIGHT_FLOOR);
    for (let l = lo; l <= REPAIR_LIGHT_CAP; l++) {
      const lab = hslToLab(mover.h, s, l);
      let minSq = Infinity;
      let eligible = true;
      for (const other of others) {
        const d = deltaESq(lab, other.lab);
        if (d < pairFloor(mover, other) ** 2) {
          eligible = false;
          break;
        }
        if (d < minSq) {
          minSq = d;
        }
      }
      if (eligible && (best === undefined || minSq > best.minDistanceSq)) {
        best = { s, l, lab, minDistanceSq: minSq };
      }
    }
  }
  return best;
}

// Repair pass over the finished placement: walk the pairs still under their
// floor in placement order and re-place only the later-placed member. The
// placement maximizes the worst distance but guarantees no floor; this pass
// supplies one, moving as few items as the grid allows. Every move is an
// offender - the later member of an offending pair - so items already at or
// above their floor keep their exact hsl. Sweeps repeat because one move can
// expose a better fix for the next; they stop when a sweep moves nothing, and
// the sweep bound backs the loop with a hard cap.
function repairOffendingPairs(
  placed: PlacedItem[],
  out: Map<string, string>,
): void {
  for (let sweep = 0; sweep < REPAIR_MAX_SWEEPS; sweep++) {
    const offenders: { earlier: number; later: number }[] = [];
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        if (deltaE(a.lab, b.lab) < pairFloor(a, b)) {
          offenders.push({ earlier: i, later: j });
        }
      }
    }
    if (offenders.length === 0) {
      return;
    }
    offenders.sort((x, y) => x.later - y.later || x.earlier - y.earlier);
    let moved = false;
    for (const { earlier, later } of offenders) {
      // A move earlier in this sweep may already have cleared this pair.
      const a = placed[earlier]!;
      const mover = placed[later]!;
      if (deltaE(a.lab, mover.lab) >= pairFloor(a, mover)) {
        continue;
      }
      const others = placed.filter((_, index) => index !== later);
      const best = searchRepairGrid(mover, others);
      if (best === undefined) {
        continue;
      }
      placed[later] = { ...mover, s: best.s, l: best.l, lab: best.lab };
      out.set(mover.id, `hsl(${mover.h} ${best.s}% ${best.l}%)`);
      moved = true;
    }
    if (!moved) {
      return;
    }
  }
}

// Final color per pack item id, built once at module load: split pack items
// into the two bands and place both apart in Lab at their own icon hue. The
// gray band goes first because it is the crowded one - it holds most of the
// pack inside the narrowest saturation range, so it gets first pick of the
// room. The placement maximizes the worst distance but guarantees no floor,
// so a repair pass follows it, re-placing only the members of pairs still
// under the two-tier floor.
const packColorById: ReadonlyMap<string, string> = (() => {
  const saturated: { id: string; h: number; gray: boolean }[] = [];
  const gray: { id: string; h: number; gray: boolean }[] = [];
  for (const item of pack.items) {
    const iconHS = iconHSFor(item.id);
    if (iconHS === undefined) continue;
    const list = iconHS.s >= COLOR_SATURATION_MIN ? saturated : gray;
    list.push({ id: item.id, h: iconHS.h, gray: list === gray });
  }
  const out = new Map<string, string>();
  const assigned: [number, number, number][] = [];
  const placed: PlacedItem[] = [];
  for (const [entries, saturations] of [
    [gray, GRAY_CANDIDATES],
    [saturated, SAT_CANDIDATES],
  ] as const) {
    assignColors(entries, saturations, assigned, out, placed);
  }
  repairOffendingPairs(placed, out);
  return out;
})();

export function itemHue(itemId: string): number {
  const iconHS = iconHSFor(itemId);
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
  // Fallback rungs for ids without a pack color (icon-only ids and synthetic
  // ids). Pack colors are floored once at module load; these are floored here at
  // call time so an off-pack blue or deep-red icon still clears the contrast
  // floor instead of leaking a dark base rung.
  const iconHS = iconHSFor(itemId);
  if (iconHS !== undefined) {
    const [s, baseL] =
      iconHS.s >= COLOR_SATURATION_MIN ? ([65, 60] as const) : ([12, 62] as const);
    return `hsl(${iconHS.h} ${s}% ${floorLightness(iconHS.h, s, baseL)}%)`;
  }
  const h = itemHue(itemId);
  return `hsl(${h} 65% ${floorLightness(h, 65, 60)}%)`;
}
