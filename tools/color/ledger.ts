// Color-separation ledger for the pack edge colors. Prints the pack-wide
// CIE76 delta-E distribution, the per-band and cross-band minima, the pairs
// below each tier's floor (saturated 15, gray and cross-band 8), and the items
// whose placed hue sits off their icon hue with the offset. Later tasks on the
// edge-color floor branch report their before/after against this output.
//
// Band membership comes from the icon's own saturation (the same rounded
// percent the color module derives from the icon metadata), not from the placed
// color: the placement may put a gray-band item at a saturation a cross-band
// reader could mistake for a colored one, while the band policy itself is keyed
// on the icon. The hue/saturation arithmetic below mirrors the module-private
// conversion in src/canvas/itemColor.ts; if that conversion ever changes, this
// mirror must follow or the ledger silently reclassifies.
//
// Usage: bun run tools/color/ledger.ts [--map]
//   --map  also print the full sorted id -> hsl map with band and hue offset,
//          one line per item, for diffing one task's map against the next.

import iconsMeta from "@aef/icons/data.json";
import {
  deltaE,
  hslToLab,
  itemColor,
  itemHue,
} from "../../src/canvas/itemColor";
import { pack } from "../../src/data/load";

// Tier floors the ledger reports against: two saturated items must clear 15;
// anything involving the gray band (gray-gray or cross-band) clears 8.
const SATURATED_FLOOR = 15;
const GRAY_FLOOR = 8;

// Icons at or above this rounded saturation percent keep a colored band; below
// it they place in the gray band. Mirrors COLOR_SATURATION_MIN.
const COLOR_SATURATION_MIN = 25;

type Entry = {
  id: string;
  h: number;
  s: number;
  l: number;
  lab: [number, number, number];
  gray: boolean;
  iconH: number;
};

function parseHsl(color: string): { h: number; s: number; l: number } {
  const match = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(color);
  if (match === null) throw new Error(`unparseable color: ${color}`);
  return { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) };
}

// Icon dominant hex -> rounded saturation percent (hue comes from itemHue, the
// module's own export, so only this half is mirrored here).
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

// Circular hue distance 0-180.
function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

// FNV-1a over the UTF-16 code units of the canonical map string, so the
// fingerprint is identical whether computed here or in the determinism
// snapshot test. The canonical string is "<id>|<h> <s> <l>" lines sorted by
// plain id compare.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const iconColorById = new Map(
  (iconsMeta as { icons: { id: string; color: string }[] }).icons.map(
    (icon) => [icon.id, icon.color] as const,
  ),
);

const entries: Entry[] = pack.items.map((item) => {
  const { h, s, l } = parseHsl(itemColor(item.id));
  const iconColor = iconColorById.get(item.id);
  const iconS = iconColor === undefined ? 0 : iconSaturation(iconColor);
  return {
    id: item.id,
    h,
    s,
    l,
    lab: hslToLab(h, s, l),
    gray: iconS < COLOR_SATURATION_MIN,
    iconH: itemHue(item.id),
  };
});

type Pair = { a: Entry; b: Entry; d: number; tier: number };
const pairs: Pair[] = [];
for (const [i, a] of entries.entries()) {
  for (const b of entries.slice(i + 1)) {
    const tier = a.gray || b.gray ? GRAY_FLOOR : SATURATED_FLOOR;
    pairs.push({ a, b, d: deltaE(a.lab, b.lab), tier });
  }
}
pairs.sort((x, y) => x.d - y.d || (x.a.id < y.a.id ? -1 : 1));

const bandMin = (bothGray: boolean, cross: boolean): number => {
  const list = pairs.filter((p) => {
    const isGrayGray = p.a.gray && p.b.gray;
    const isCross = p.a.gray !== p.b.gray;
    return cross ? isCross : bothGray ? isGrayGray : !isGrayGray && !isCross;
  });
  return list.length === 0 ? Infinity : Math.min(...list.map((p) => p.d));
};

const lines: string[] = [];
lines.push(`items: ${entries.length}`);
lines.push(
  `bands: saturated ${entries.filter((e) => !e.gray).length}, gray ${entries.filter((e) => e.gray).length}`,
);
lines.push(`pack-wide min deltaE: ${pairs[0]!.d.toFixed(2)}`);
for (const bound of [10, 12, 15, 20]) {
  lines.push(
    `pairs under ${bound}: ${pairs.filter((p) => p.d < bound).length}`,
  );
}
lines.push(`saturated-band min: ${bandMin(false, false).toFixed(2)}`);
lines.push(`gray-band min: ${bandMin(true, false).toFixed(2)}`);
lines.push(`cross-band min: ${bandMin(false, true).toFixed(2)}`);

const offenders = pairs.filter((p) => p.d < p.tier);
lines.push(`pairs below their tier floor: ${offenders.length}`);
for (const p of offenders) {
  const band = p.a.gray && p.b.gray ? "gray" : p.a.gray !== p.b.gray ? "cross" : "sat";
  lines.push(
    `  ${p.a.id} vs ${p.b.id}: ${p.d.toFixed(2)} (${band}, floor ${p.tier})`,
  );
}

const nudged = entries.filter((e) => e.h !== e.iconH);
lines.push(`hue moved off icon hue: ${nudged.length}`);
for (const e of nudged) {
  lines.push(
    `  ${e.id}: icon ${e.iconH} placed ${e.h} offset ${hueDistance(e.iconH, e.h)}`,
  );
}

const canonical = [...entries]
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((e) => `${e.id}|${e.h} ${e.s} ${e.l}`)
  .join("\n");
lines.push(`map fingerprint (fnv1a-32): ${fnv1a(canonical)}`);

console.log(lines.join("\n"));

if (process.argv.includes("--map")) {
  for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    console.log(
      `${e.id}\t${e.h} ${e.s} ${e.l}\t${e.gray ? "gray" : "sat"}\t${hueDistance(e.iconH, e.h)}`,
    );
  }
}
