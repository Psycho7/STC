import iconsMeta from "@aef/icons/data.json";
import iconsUrl from "@aef/icons/icons.webp?url";

type IconEntry = { id: string; position: string };

const positionById = new Map<string, string>(
  (iconsMeta as { icons: IconEntry[] }).icons.map((i) => [i.id, i.position]),
);

export const iconSheetUrl = iconsUrl;

export function iconPosition(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return positionById.get(id);
}
