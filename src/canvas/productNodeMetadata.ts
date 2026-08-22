import type { Item } from "@aef/schema";
import type { Node } from "@xyflow/react";
import { formatRationalPerMin } from "../data/rate-format";
import type { ItemOverride } from "../data/plan";
import type { I18nIndex } from "../data/i18n";
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
// separator. The direction and classification words are localized through the
// i18n table; the numeric rate is literal and the unit comes from the locale's
// canvas.rate.unit string.
//
// Direction is "In" for an inputProduct and "Out" for an outputProduct.
// For an inputProduct, the classification is "tap" when the node is a fanout
// slice of an aggregate input card, otherwise "raw" when item.raw is true and
// "import" when it is not. For an outputProduct, it is data.flavor ("target" or
// "surplus"), and the rate is formatRationalPerMin(rate) followed by the
// locale's canvas.rate.unit string.
//
// `overrides` is accepted only to keep the signature stable for future captions
// built from per-item override metadata; the helper does not read it today.
export function buildPnKind(
  data: ProductNodeData,
  item: Item,
  _overrides: ItemOverride[],
  i18n: I18nIndex,
): string {
  if (data.kind === "inputProduct") {
    const classification = i18n.t(
      data.isFanout
        ? "product.class.tap"
        : item.raw
          ? "product.class.raw"
          : "product.class.import",
    );
    return `${i18n.t("product.dir.in")} · ${classification}`;
  }
  const flavor = i18n.t(
    data.flavor === "surplus"
      ? "product.flavor.surplus"
      : "product.flavor.target",
  );
  return `${i18n.t("product.dir.out")} · ${flavor} · ${formatRationalPerMin(data.rate)}${i18n.t("canvas.rate.unit")}`;
}
