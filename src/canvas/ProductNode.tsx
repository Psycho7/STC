import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Item } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import type { I18nIndex } from "../data/i18n";
import { formatRationalPerMin } from "../data/rate-format";
import type { RationalString } from "../pipeline/types";
import { PortGlyph } from "./PortGlyph";
import { useItemPack } from "./itemPackContext";
import type { PortTransportKinds } from "./layout";
import { iconPosition } from "./iconSprite";
import { Sprite } from "./RecipeNode";

// Data shape accepted by ProductNode. The component branches on `kind` (and on
// `flavor` for outputs) to pick the look and handle direction:
//  - inputProduct (cyan): one right-side source handle for downstream consumer
//    recipes. `rate` is the realized demand, always present; `rateCap` is an
//    optional user-set cap shown as a secondary chip.
//  - outputProduct, "target" (lime): one left-side target handle for upstream
//    producer recipes. `rate` always present.
//  - outputProduct, "surplus" (amber): same shape as target, for byproducts
//    produced but not fully consumed.
export type ProductNodeData =
  | {
      kind: "inputProduct";
      itemId: string;
      rate: RationalString;
      rateCap?: RationalString;
      // Set on the nodes of the item's catalyst pool, whose rate is the cycled
      // per-machine charge rather than ordinary consumption.
      role?: "catalyst";
      // Which supply pool the item's whole charge was billed to. Item-level
      // accounting, so it is stamped on the aggregate or single-bucket
      // catalyst card only, never on a per-container slice.
      catalystBreakdown?: {
        fromCatalyst: RationalString;
        fromGeneral: RationalString;
        unmet: RationalString;
      };
      // Per-container fanout slices have an inbound edge from the item's
      // aggregate node, so they render an extra left target handle to receive
      // it.
      isFanout?: boolean;
      // Total realized rate of the aggregate this slice taps, shown as an
      // "of <total>/min" share chip. Fanout slices only.
      parentRate?: RationalString;
      portTransportKinds?: PortTransportKinds;
    }
  | {
      kind: "outputProduct";
      itemId: string;
      rate: RationalString;
      flavor: "target" | "surplus";
      portTransportKinds?: PortTransportKinds;
    };

export type ProductNodeType = Node<ProductNodeData, "product">;

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
// For an inputProduct, a card of the item's catalyst pool states the pool
// rather than the item's provenance ("In · catalyst"): the charge is cycled,
// not consumed, and the same item can carry an ordinary card beside it. Any
// other card reads "tap" when it is a fanout slice of an aggregate, otherwise
// "raw" when item.raw is true and "import" when it is not. A fanout slice OF a
// catalyst card keeps both words ("In · catalyst · tap"), since a slice of the
// pool is still catalyst supply. For an outputProduct, the classification is
// data.flavor ("target" or "surplus").
//
// The NBSP after each middle dot keeps a wrapped caption from stranding the
// dot at line end; a break lands before the dot instead.
export function buildPnKind(
  data: ProductNodeData,
  item: Item,
  i18n: I18nIndex,
): string {
  if (data.kind === "inputProduct") {
    const words = [i18n.t("product.dir.in")];
    if (data.role === "catalyst") {
      words.push(i18n.t("product.class.catalyst"));
    }
    if (data.isFanout) {
      words.push(i18n.t("product.class.tap"));
    } else if (data.role !== "catalyst") {
      words.push(
        i18n.t(item.raw ? "product.class.raw" : "product.class.import"),
      );
    }
    return words.join(` ·\u00A0`);
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

// Name tooltip of a product card: the display name, plus the catalyst pool
// breakdown on the card that owns the item's whole charge.
//
// The breakdown is item-level accounting (which pool the charge was billed to),
// so a per-container fanout slice gets the plain name: its own share of the
// split has no meaning. The shortage line only appears when a charge went
// unmet, so a plan that covers its catalysts says nothing about shortage.
function buildPnNameTitle(data: ProductNodeData, i18n: I18nIndex): string {
  const name = i18n.displayName(data.itemId);
  if (data.kind !== "inputProduct") return name;
  const breakdown = data.catalystBreakdown;
  if (breakdown === undefined || data.isFanout) return name;

  const lines = [
    i18n.t("product.catalyst.fromCatalyst", {
      rate: formatRationalPerMin(breakdown.fromCatalyst),
    }),
    i18n.t("product.catalyst.fromGeneral", {
      rate: formatRationalPerMin(breakdown.fromGeneral),
    }),
  ];
  if (breakdown.unmet.num !== "0") {
    lines.push(
      i18n.t("product.catalyst.short", {
        rate: formatRationalPerMin(breakdown.unmet),
      }),
    );
  }
  return [name, ...lines].join("\n");
}

function chromeClasses(data: ProductNodeData): string {
  if (data.kind === "inputProduct") {
    // A fanout slice is a derived view of the item's aggregate card, not an
    // independent source; the tap class mutes it (issue 40).
    return data.isFanout ? "product-node input tap" : "product-node input";
  }
  return `product-node output ${data.flavor}`;
}

function flavorMarker(data: ProductNodeData): string {
  if (data.kind === "inputProduct") return "inputProduct";
  if (data.flavor === "surplus") return "outputProduct-surplus";
  return "outputProduct";
}

export default function ProductNode({
  data,
  selected,
}: NodeProps<ProductNodeType>) {
  const i18n = useI18n();
  const { itemById } = useItemPack();
  const item = itemById.get(data.itemId);
  const displayName = i18n.displayName(data.itemId);
  const nameTitle = buildPnNameTitle(data, i18n);
  const isInput = data.kind === "inputProduct";
  // Sprite key: the item's own icon id, falling back to the item id itself for
  // pack entries that declare none.
  const iconId = item?.icon ?? data.itemId;

  // The pn-kind caption comes from the helper above. If the item is missing
  // from the pack (corrupt data), fall back to nothing.
  const pnKindText = item ? buildPnKind(data, item, i18n) : null;
  // Trailing rate segment of the caption, outputs only. Rendered in a child
  // span joined by the same dot+NBSP glue so the caption's total text is
  // unchanged; the span drops the caption's uppercase transform so the
  // localized unit keeps its casing beside the uppercased label words
  // (unit-casing-mix family).
  const pnKindRate = item ? buildPnKindRate(data, i18n) : null;

  // Primary rate. For inputs this is realized demand; for outputs the target or
  // surplus rate.
  const rateValue = formatRationalPerMin(data.rate);
  // Secondary cap chip, inputs only. Present when the user set a finite
  // ratePerSec via an ItemOverride.
  const capValue =
    isInput && data.rateCap !== undefined
      ? formatRationalPerMin(data.rateCap)
      : null;
  // Share of the parent aggregate, fanout slices only: "of <total>/min" points
  // the reader back at the source card this tap draws from.
  const shareOf =
    isInput && data.isFanout && data.parentRate !== undefined
      ? formatRationalPerMin(data.parentRate)
      : null;

  return (
    <div
      data-testid="product-node"
      data-flavor={flavorMarker(data)}
      data-item-id={data.itemId}
      {...(isInput && data.role !== undefined
        ? { "data-role": data.role }
        : {})}
      className={
        selected ? `${chromeClasses(data)} selected` : chromeClasses(data)
      }
    >
      {isInput ? (
        <>
          {data.isFanout ? (
            <>
              <Handle
                id={`in:${data.itemId}`}
                type="target"
                position={Position.Left}
              />
              <PortGlyph
                kind={data.portTransportKinds?.get(`in:${data.itemId}`)}
                side="left"
              />
            </>
          ) : null}
          <Handle
            id={`out:${data.itemId}`}
            type="source"
            position={Position.Right}
          />
          <PortGlyph
            kind={data.portTransportKinds?.get(`out:${data.itemId}`)}
            side="right"
          />
        </>
      ) : (
        <>
          <Handle
            id={`in:${data.itemId}`}
            type="target"
            position={Position.Left}
          />
          <PortGlyph
            kind={data.portTransportKinds?.get(`in:${data.itemId}`)}
            side="left"
          />
        </>
      )}
      <div className="pn-head">
        {/* An item with no sprite still contributes an empty child, so the
            head keeps its two flex items and the gap between them; dropping
            the element would slide the name column left by that gap. */}
        {iconPosition(iconId) !== undefined ? (
          <Sprite iconId={iconId} size={28} />
        ) : (
          <div />
        )}
        <div>
          <div className="pn-name" title={nameTitle}>
            {displayName}
          </div>
          {pnKindText !== null ? (
            <div className="pn-kind">
              {pnKindText}
              {pnKindRate !== null ? (
                <span className="pn-kind__rate">{` ·\u00A0${pnKindRate}`}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="pn-rate">
        {rateValue}
        <span className="unit">{i18n.t("canvas.rate.unit")}</span>
        {capValue !== null ? (
          <span className="pn-rate__cap">
            {i18n.t("inputs.rate.cap", { rate: capValue })}
          </span>
        ) : null}
        {shareOf !== null ? (
          <span className="pn-rate__of">
            {i18n.t("product.tap.share", { rate: shareOf })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
