import type { Item } from "@aef/schema";
import type { Node } from "@xyflow/react";
import { formatRationalPerMin } from "../data/rate-format";
import type { ItemOverride } from "../data/plan";
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

// Build the pn-kind caption shown on a ProductNode.
//
// Inputs read "<Direction> <Classification>" (the rate now lives in its own
// pn-rate row rather than this caption); outputs read
// "<Direction> <Classification> <Rate>". The parts are joined by a middle-dot
// separator (the same character the format strings below use literally).
//
// Direction is "In" for an inputProduct and "Out" for an outputProduct.
// For an inputProduct, the classification is "raw" when item.raw is true and
// "import" otherwise. For an outputProduct, it is data.flavor ("target" or
// "surplus"), and the rate is formatRationalPerMin(rate) + "/min".
//
// `overrides` is accepted only to keep the signature stable for future captions
// built from per-item override metadata; the helper does not read it today.
export function buildPnKind(
  data: ProductNodeData,
  item: Item,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _overrides: ItemOverride[],
): string {
  if (data.kind === "inputProduct") {
    const classification = item.raw ? "raw" : "import";
    return `In · ${classification}`;
  }
  return `Out · ${data.flavor} · ${formatRationalPerMin(data.rate)}/min`;
}
