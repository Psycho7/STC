import type { Node } from "@xyflow/react";
import type { RationalString } from "../pipeline/types";
import type { ProductNodeData } from "./ProductNode";

/**
 * The realized rate of one item's boundary nodes, one entry per pool.
 *
 * An item can be drawn twice over: as an ordinary reagent and as a cycled
 * catalyst charge, on two nodes that the panel shows as two rows. Nesting the
 * two under the item keeps each rate whole (a flat item-keyed map would let
 * whichever node came last overwrite the other) and lets a caller that still
 * wants the item total add them itself.
 */
export type RealizedRatesByRole = {
  ordinary?: RationalString;
  catalyst?: RationalString;
};

// Fold the realized demand per input item out of the React Flow product nodes
// the layout layer wrote: one node per item and pool, carrying the total.
export function buildRealizedRateByItem(
  nodes: readonly Node[],
): ReadonlyMap<string, RealizedRatesByRole> {
  const map = new Map<string, RealizedRatesByRole>();
  for (const n of nodes) {
    if (n.type !== "product") continue;
    const data = n.data as Partial<ProductNodeData>;
    if (data.kind !== "inputProduct") continue;
    if (data.itemId === undefined || data.rate === undefined) continue;
    const entry = map.get(data.itemId) ?? {};
    if (data.role === "catalyst") {
      entry.catalyst = data.rate;
    } else {
      entry.ordinary = data.rate;
    }
    map.set(data.itemId, entry);
  }
  return map;
}
