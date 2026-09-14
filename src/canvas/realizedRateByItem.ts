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
// the layout layer wrote. An input item that fans out across containers emits
// an aggregate node (item total, no fanout flag) followed by per-container
// fanout slices (partial rates, isFanout) that share the same itemId. Skipping
// the fanout slices keeps the item-level total: aggregate and single-bucket
// nodes both carry the total and neither carries isFanout.
export function buildRealizedRateByItem(
  nodes: readonly Node[],
): ReadonlyMap<string, RealizedRatesByRole> {
  const map = new Map<string, RealizedRatesByRole>();
  for (const n of nodes) {
    if (n.type !== "product") continue;
    const data = n.data as Partial<ProductNodeData>;
    if (data.kind !== "inputProduct") continue;
    // Fanout slices carry only a per-container partial rate; skip them so a
    // slice cannot overwrite the item's aggregate total.
    if (data.isFanout) continue;
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
