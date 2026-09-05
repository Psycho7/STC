import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useI18n } from "../data/i18n-context";
import { formatRationalPerMin } from "../data/rate-format";
import type { RationalString } from "../pipeline/types";
import { PortGlyph } from "./PortGlyph";
import { useItemPack } from "./itemPackContext";
import { buildPnKind, buildPnKindRate } from "./productNodeMetadata";
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
  const { itemById, overrides } = useItemPack();
  const item = itemById.get(data.itemId);
  const displayName = i18n.displayName(data.itemId);
  const isInput = data.kind === "inputProduct";
  // Sprite key: the item's own icon id, falling back to the item id itself for
  // pack entries that declare none.
  const iconId = item?.icon ?? data.itemId;

  // The pn-kind caption comes from the shared helper. If the item is missing
  // from the pack (corrupt data), fall back to nothing.
  const pnKindText = item ? buildPnKind(data, item, overrides, i18n) : null;
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
          <div className="pn-name" title={displayName}>
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
