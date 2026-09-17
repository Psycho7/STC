import type { ItemId } from "../types";

// One home for the port id grammar: `<side>:<item>`, the handle id a node
// component renders and the port id the logical graph and ELK carry (ELK
// prefixes it with `<unitId>.`). `cat:` is its own side because one card can
// carry the same item on an input row and a catalyst row.

export type PortSide = "in" | "cat" | "out";

const ALL_SIDES: ReadonlyArray<PortSide> = ["in", "cat", "out"];

export const portId = (side: PortSide, item: ItemId): string =>
  `${side}:${item}`;

// Side and item of a port id; undefined for a bare item id or any other shape.
export function parsePort(
  port: string,
): { side: PortSide; item: ItemId } | undefined {
  for (const side of ALL_SIDES) {
    const prefix = `${side}:`;
    if (port.startsWith(prefix)) {
      return { side, item: port.slice(prefix.length) };
    }
  }
  return undefined;
}

// The item a port carries. A port whose side is not in `sides`, and a bare or
// unknown id, comes back unchanged: older synthetic graphs use the bare item id
// as the port.
export function itemOfPort(
  port: string,
  sides: ReadonlyArray<PortSide> = ALL_SIDES,
): ItemId {
  const parsed = parsePort(port);
  return parsed !== undefined && sides.includes(parsed.side)
    ? parsed.item
    : port;
}
