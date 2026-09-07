import iconsMeta from "@aef/icons/data.json";
import iconsUrl from "@aef/icons/icons.webp?url";
import { pack } from "../data/load";

type IconEntry = { id: string; position: string };

const positionById = new Map<string, string>(
  (iconsMeta as { icons: IconEntry[] }).icons.map((i) => [i.id, i.position]),
);

// A pack item's icon id is not always its own id: upstream renames some icons
// to opaque ids. Callers that hold only an item id resolve it here first; the
// fallback to the id itself keeps icon-only ids (machines, transports) and
// synthetic ids resolving the way they always did.
const iconIdByItemId = new Map<string, string>(
  pack.items.map((item) => [item.id, item.icon]),
);

export const iconSheetUrl = iconsUrl;

export function iconPosition(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return positionById.get(id);
}

export function iconIdForItem(itemId: string | undefined): string | undefined {
  if (itemId === undefined) return undefined;
  return iconIdByItemId.get(itemId) ?? itemId;
}

// The environment banner band. Upstream records a recipe's gas-environment
// requirement nowhere in its data: the only marker is a colored strip baked
// into the recipe icon, spanning the full tile width at rows 5..14 of the 64px
// tile and identical across every icon of the same environment. The badge is
// that strip drawn at native scale, so a card shows the same mark the game
// does. These three numbers are the one place the band's geometry is written;
// the .env-badge rule in canvas.css is pinned to them by test.
export const ENV_BAND_WIDTH = 64;
export const ENV_BAND_HEIGHT = 10;
export const ENV_BAND_TOP = 5;

// The background position that shows an icon's banner band at the top-left of a
// band-sized element. A CSS background-position of "-Xpx -Ypx" puts sheet pixel
// (X, Y) at the element's origin, so skipping the tile's first ENV_BAND_TOP
// rows means moving y that many pixels further negative. Returns undefined when
// the icon or its position string is unknown, so the slot collapses instead of
// showing an arbitrary slice of the sheet.
export function envBandPosition(id: string | undefined): string | undefined {
  const pos = iconPosition(id);
  if (pos === undefined) return undefined;
  const parts = pos.match(/^(-?[\d.]+)px (-?[\d.]+)px$/);
  if (parts === null) return undefined;
  return `${parts[1]}px ${Number(parts[2]) - ENV_BAND_TOP}px`;
}
