// Stable per-item edge color. The same item id always maps to the same hue, so
// one item stays visually traceable across local edges, trunks, and branches.
// Saturation and lightness are fixed to sit on the existing cyan-on-dark theme;
// only the hue varies. A plain deterministic string hash (djb2) gives enough
// spread across the item-id space; the exact hue values are pinned by tests so
// the mapping cannot drift silently.

// djb2: hash * 33 + c, folded to an unsigned 32-bit int each step so the result
// is stable regardless of platform integer width.
function hashItemId(itemId: string): number {
  let hash = 5381;
  for (let i = 0; i < itemId.length; i++) {
    hash = (hash * 33 + itemId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function itemHue(itemId: string): number {
  return hashItemId(itemId) % 360;
}

export function itemColor(itemId: string): string {
  return `hsl(${itemHue(itemId)} 65% 60%)`;
}
