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

// Build the pn-kind caption words shown on a ProductNode.
//
// Every card reads "<Direction> <Classification>"; the parts are joined by a
// middle-dot separator and localized through the i18n table. An output's rate
// used to ride this string and now comes from buildPnKindRate below, because
// .pn-kind runs the words through text-transform: uppercase and the rate's
// localized unit ("/min", the Russian per-minute string) must keep its own
// casing (unit-casing-mix family).
//
// Direction is "In" for an inputProduct and "Out" for an outputProduct.
// For an inputProduct, the classification is "tap" when the node is a fanout
// slice of an aggregate input card, otherwise "raw" when item.raw is true and
// "import" when it is not. For an outputProduct, it is data.flavor ("target"
// or "surplus").
//
// The NBSP after each middle dot keeps a wrapped caption from stranding the
// dot at line end; a break lands before the dot instead.
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
    return `${i18n.t("product.dir.in")} ·\u00A0${classification}`;
  }
  const flavor = i18n.t(
    data.flavor === "surplus"
      ? "product.flavor.surplus"
      : "product.flavor.target",
  );
  return `${i18n.t("product.dir.out")} ·\u00A0${flavor}`;
}

// Build the trailing rate segment of an output's pn-kind caption: the
// formatted rate followed by the locale's canvas.rate.unit string
// (formatRationalPerMin(rate) + "/min" under en). Inputs carry no rate in the
// caption, mirroring buildPnKind's input branch, so the helper returns null
// and the caller renders no span.
//
// The caller joins this to the caption words with the same "space, middle
// dot, NBSP" glue and renders it inside a span the caption's uppercase
// transform does not reach, so the composed caption's text is unchanged.
export function buildPnKindRate(
  data: ProductNodeData,
  i18n: I18nIndex,
): string | null {
  if (data.kind === "inputProduct") return null;
  return `${formatRationalPerMin(data.rate)}${i18n.t("canvas.rate.unit")}`;
}
