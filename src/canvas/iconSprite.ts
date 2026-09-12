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
