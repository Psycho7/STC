import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useI18n } from "../data/i18n-context";
import { formatRationalPerMin } from "../data/rate-format";
import type { RationalString } from "../pipeline/types";
import { PortGlyph } from "./PortGlyph";
import { useItemPack } from "./itemPackContext";
import { buildPnKind } from "./productNodeMetadata";
import type { PortTransportKinds } from "./layout";
import { iconPosition } from "./iconSprite";

// Data shape accepted by ProductNode. The component branches on `kind`, and for
// outputs on `flavor`, to choose the look and the handle direction:
//  - inputProduct (cyan): one right-side source handle that downstream consumer
//    recipes connect to. `rate` is the realized demand and is always present;
//    `rateCap` is an optional user-set cap shown as a secondary chip next to the
//    primary rate.
//  - outputProduct, flavor "target" (lime): one left-side target handle that
//    upstream producer recipes connect to. `rate` is always present.
//  - outputProduct, flavor "surplus" (amber): same shape as target, used for
//    byproducts that are produced but not fully consumed.
export type ProductNodeData =
  | {
      kind: "inputProduct";
      itemId: string;
      rate: RationalString;
      rateCap?: RationalString;
      // Per-container fanout slices have an inbound edge from the item's
      // aggregate node, so they render an extra target handle on the left to
      // receive that edge.
      isFanout?: boolean;
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
    return "product-node input";
  }
  return `product-node output ${data.flavor}`;
}

function flavorMarker(data: ProductNodeData): string {
  if (data.kind === "inputProduct") return "inputProduct";
  if (data.flavor === "surplus") return "outputProduct-surplus";
  return "outputProduct";
}

export default function ProductNode({ data }: NodeProps<ProductNodeType>) {
  const i18n = useI18n();
  const { itemById, overrides } = useItemPack();
  const item = itemById.get(data.itemId);
  const displayName = i18n.displayName(data.itemId);
  const isInput = data.kind === "inputProduct";

  // The pn-kind caption comes from the shared helper. If the item is missing
  // from the pack (corrupt data), fall back to nothing rather than break.
  const pnKindText = item ? buildPnKind(data, item, overrides) : null;

  // Primary rate value. For inputs this is the realized demand; for outputs it
  // is the target or surplus rate.
  const rateValue = formatRationalPerMin(data.rate);
  // Secondary cap chip, inputs only. Shows up when the user set a finite
  // ratePerSec through an ItemOverride.
  const capValue =
    isInput && data.rateCap !== undefined
      ? formatRationalPerMin(data.rateCap)
      : null;

  return (
    <div
      data-testid="product-node"
      data-flavor={flavorMarker(data)}
      data-item-id={data.itemId}
      className={chromeClasses(data)}
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
                top={16}
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
            top={16}
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
            top={16}
          />
        </>
      )}
      <div className="pn-head">
        {(() => {
          const pos = iconPosition(item?.icon ?? data.itemId);
          return pos !== undefined ? (
            <span className="ico ico-28 pn-icon">
              <span className="spr" style={{ backgroundPosition: pos }} />
            </span>
          ) : (
            <div className="pn-icon" />
          );
        })()}
        <div>
          <div className="pn-name">{displayName}</div>
          {pnKindText !== null ? (
            <div className="pn-kind">{pnKindText}</div>
          ) : null}
        </div>
      </div>
      <div className="pn-rate">
        {rateValue}
        <span className="unit">/min</span>
        {capValue !== null ? (
          <span className="pn-rate__cap">
            {i18n.t("inputs.rate.cap", { rate: capValue })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
