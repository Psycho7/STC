import { pack } from "../data/load";

// Stable per-item edge color. The same item id always maps to the same hue, so
// one item stays visually traceable across local edges, trunks, and branches.
// Saturation and lightness are fixed to sit on the existing cyan-on-dark theme;
// only the hue varies. The exact hue values are pinned by tests so the mapping
// cannot drift silently.
//
// Hue assignment uses golden-angle spacing indexed by the item's position in
// the recipe pack's lexicographically sorted item-id list: successive indices
// step 137.508 degrees apart, which spreads a small set of neighbouring items
// as far around the wheel as possible. A plain hash (djb2) folded to 0-359 gave
// enough spread across the whole id space, but two items that happen to meet at
// the same consumer node could still land on near-identical hues (seen in the
// field: the xiranite-oven's two inputs rendered as purple vs magenta). Indexing
// by sorted position instead of by hash removes that particular collision mode
// while staying fully deterministic.

const GOLDEN_ANGLE = 137.508;

// Map every pack item id to its rank in the sorted id list. Built once at module
// load from a fresh copy of the id array so the sort does not disturb pack.items.
const packHueIndex: ReadonlyMap<string, number> = (() => {
  const sortedIds = pack.items.map((item) => item.id).sort();
  const index = new Map<string, number>();
  sortedIds.forEach((id, rank) => index.set(id, rank));
  return index;
})();

// djb2: hash * 33 + c, folded to an unsigned 32-bit int each step so the result
// is stable regardless of platform integer width. Retained as the fallback for
// item ids that are not present in the pack (for example synthetic test ids), so
// itemHue never throws on an unknown id.
function hashItemId(itemId: string): number {
  let hash = 5381;
  for (let i = 0; i < itemId.length; i++) {
    hash = (hash * 33 + itemId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function itemHue(itemId: string): number {
  const packIndex = packHueIndex.get(itemId);
  if (packIndex !== undefined) {
    // Round before folding to 0-359 so the hue is always an integer in range
    // even when the golden-angle product lands just below a multiple of 360.
    return Math.round(packIndex * GOLDEN_ANGLE) % 360;
  }
  return hashItemId(itemId) % 360;
}

export function itemColor(itemId: string): string {
  return `hsl(${itemHue(itemId)} 65% 60%)`;
}
