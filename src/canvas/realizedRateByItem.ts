import type { Node } from "@xyflow/react";
import type { RationalString } from "../pipeline/types";
import type { ProductNodeData } from "./ProductNode";

// Fold the realized demand per input item out of the React Flow product nodes
// the layout layer wrote. An input item that fans out across containers emits
// an aggregate node (item total, no fanout flag) followed by per-container
// fanout slices (partial rates, isFanout) that share the same itemId. Skipping
// the fanout slices keeps the item-level total: aggregate and single-bucket
// nodes both carry the total and neither carries isFanout.
export function buildRealizedRateByItem(
  nodes: readonly Node[],
): ReadonlyMap<string, RationalString> {
  const map = new Map<string, RationalString>();
  for (const n of nodes) {
    if (n.type !== "product") continue;
    const data = n.data as Partial<ProductNodeData>;
    if (data.kind !== "inputProduct") continue;
    // Fanout slices carry only a per-container partial rate; skip them so a
    // slice cannot overwrite the item's aggregate total.
    if (data.isFanout) continue;
    if (data.itemId === undefined || data.rate === undefined) continue;
    map.set(data.itemId, data.rate);
  }
  return map;
}
