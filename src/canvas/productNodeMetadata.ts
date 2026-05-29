import type { Item } from "@aef/schema";
import { formatRationalPerMin } from "../data/rate-format";
import type { ItemOverride } from "../data/plan";
import type { ProductNodeData } from "./ProductNode";

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
