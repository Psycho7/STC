import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Item } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import type { I18nIndex } from "../data/i18n";
import { formatRationalPerMin } from "../data/rate-format";
import type { RationalString } from "../pipeline/types";
import { portId } from "../pipeline/render/port-ids";
import { PortGlyph } from "./PortGlyph";
import { useItemPack } from "./itemPackContext";
import type { CatalystBreakdown, PortTransportKinds } from "./layout";
import { elideName } from "./elide";
import {
  measureTextWidth,
  useFontMetrics,
  widthFnFor,
  type MeasuredFont,
} from "./measureText";
import { iconIdForItem, iconPosition } from "./iconSprite";
import { Sprite } from "./RecipeNode";

// Data shape accepted by ProductNode. The component branches on `kind` (and on
// `flavor` for outputs) to pick the look and handle direction:
//  - inputProduct (cyan): one right-side source handle for downstream consumer
//    recipes. `rate` is the realized demand, always present; `rateCap` is an
//    optional user-set cap carried as data only — it draws nothing (ruling
//    R9), so capped and uncapped cards look identical.
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
      // Which supply pool the item's whole charge was billed to.
      catalystBreakdown?: CatalystBreakdown;
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
      // What an under-delivered target actually receives; `rate` stays declared.
      delivered?: RationalString | undefined;
      flavor: "target" | "surplus";
      portTransportKinds?: PortTransportKinds;
    };

export type ProductNodeType = Node<ProductNodeData, "product">;

// Word separator of the spoken label below. A comma gives a screen reader a
// pause between the direction and the classification without spelling out a
// piece of punctuation the way the deleted caption's middle dot did.
const LABEL_SEP = ", ";

// Spoken identity of a boundary card: direction plus classification, localized
// through the i18n table.
//
// The card draws none of these words any more. Direction reads from the side
// the accent tab sits on and from the column the card stands in, and the
// classification from the tab's own treatment (solid for a plain input, dashed
// for a tap, ticked for the catalyst pool). None of that reaches a screen
// reader, so the same words ride the card root's aria-label.
//
// Direction is "In" for an inputProduct and "Out" for an outputProduct. For an
// inputProduct, a card of the item's catalyst pool states the pool rather than
// the item's provenance: the same item can carry an ordinary card beside it.
// Any other card reads "tap" when it is a fanout slice of an aggregate,
// otherwise "raw" when item.raw is true and "import" when it is not. A fanout
// slice OF a catalyst card keeps both words, since a slice of the pool is
// still catalyst supply. For an outputProduct, the classification is
// data.flavor ("target" or "surplus"). An item missing from the pack
// contributes no provenance word rather than a guessed one.
function buildPnAriaLabel(
  data: ProductNodeData,
  item: Item | undefined,
  i18n: I18nIndex,
): string {
  if (data.kind === "outputProduct") {
    const flavor = i18n.t(
      data.flavor === "surplus"
        ? "product.flavor.surplus"
        : "product.flavor.target",
    );
    return `${i18n.t("product.dir.out")}${LABEL_SEP}${flavor}`;
  }

  const words = [i18n.t("product.dir.in")];
  if (data.role === "catalyst") {
    words.push(i18n.t("product.class.catalyst"));
  }
  if (data.isFanout) {
    words.push(i18n.t("product.class.tap"));
  } else if (data.role !== "catalyst" && item !== undefined) {
    words.push(i18n.t(item.raw ? "product.class.raw" : "product.class.import"));
  }
  return words.join(LABEL_SEP);
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

// Name-row budget of a boundary card, pinned to canvas.css: .product-node is a
// 124px content column (the PRODUCT_WIDTH box less its 10px of side padding,
// the 1px border and the 3px accent tab), the head row spends 28px on the item
// sprite when the card draws one and 8px of gap, and on a catalyst card the
// CATALYST badge rides the name's own line box with a 6px margin and 10px of
// chrome (2x4px padding + 2x1px border) around its measured text. The visible name elides against
// whatever is left, so the row stays one line the way every other elided
// surface does; the width estimates err high, so the elision errs early --
// the safe direction for a line that must not overflow.
const PN_NAME_COLUMN_PX = 124;
const PN_HEAD_SPRITE_PX = 28;
const PN_HEAD_GAP_PX = 8;
const PN_NAME_FONT: MeasuredFont = {
  fontSize: 12,
  weight: 700,
  family: "--font-ui",
};
const PN_BADGE_FONT: MeasuredFont = {
  fontSize: 9,
  weight: 500,
  family: "--font-mono",
  letterSpacingEm: 0.05,
};
const PN_BADGE_GAP_PX = 6;
const PN_BADGE_CHROME_PX = 10;

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
  // Re-render when the resolved faces arrive: the badge measurement and the
  // name elision below answer to the metrics in effect, and a face landing
  // late changes both.
  useFontMetrics();
  const item = itemById.get(data.itemId);
  const displayName = i18n.displayName(data.itemId);
  const nameTitle = buildPnNameTitle(data, i18n);
  const isInput = data.kind === "inputProduct";
  // Sprite key: the item's own icon id, falling back to the item id itself for
  // pack entries that declare none.
  const iconId = iconIdForItem(data.itemId);
  const hasSprite = iconPosition(iconId) !== undefined;

  // Direction and classification, spoken rather than drawn.
  const ariaLabel = buildPnAriaLabel(data, item, i18n);

  // The catalyst boundary card's one drawn word (ruling R3): a yellow boxed
  // CATALYST after the name. It is aria-hidden because the spoken label above
  // already names the pool. Every card's visible name elides against the name
  // column, less the badge's margin, chrome and measured text when there is
  // one, so a long name keeps its head on one line instead of wrapping.
  const badgeText =
    isInput && data.role === "catalyst"
      ? i18n.t("inputs.catalyst.badge")
      : null;
  const badgePx =
    badgeText === null
      ? 0
      : PN_BADGE_GAP_PX +
        measureTextWidth(badgeText, PN_BADGE_FONT) +
        PN_BADGE_CHROME_PX;
  const visibleName = elideName(
    displayName,
    PN_NAME_COLUMN_PX -
      (hasSprite ? PN_HEAD_SPRITE_PX : 0) -
      PN_HEAD_GAP_PX -
      badgePx,
    widthFnFor(PN_NAME_FONT),
    "pn-name-12",
  );

  // Primary rate. For inputs this is realized demand; for outputs the target or
  // surplus rate, except an under-delivered target, which leads with what
  // actually arrives.
  const delivered = isInput ? undefined : data.delivered;
  const rateValue = formatRationalPerMin(delivered ?? data.rate);
  // Share of the parent aggregate, fanout slices only: "of <total>/min" points
  // the reader back at the source card this tap draws from. An under-delivered
  // target states its declared rate in the same chip.
  const shareOf =
    isInput && data.isFanout && data.parentRate !== undefined
      ? formatRationalPerMin(data.parentRate)
      : delivered !== undefined
        ? formatRationalPerMin(data.rate)
        : null;
  const rateTitle =
    delivered !== undefined && shareOf !== null
      ? i18n.t("product.target.delivered", {
          delivered: rateValue,
          declared: shareOf,
        })
      : undefined;

  return (
    <div
      data-testid="product-node"
      aria-label={ariaLabel}
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
                id={portId("in", data.itemId)}
                type="target"
                position={Position.Left}
              />
              <PortGlyph
                kind={data.portTransportKinds?.get(portId("in", data.itemId))}
                side="left"
              />
            </>
          ) : null}
          <Handle
            id={portId("out", data.itemId)}
            type="source"
            position={Position.Right}
          />
          <PortGlyph
            kind={data.portTransportKinds?.get(portId("out", data.itemId))}
            side="right"
          />
        </>
      ) : (
        <>
          <Handle
            id={portId("in", data.itemId)}
            type="target"
            position={Position.Left}
          />
          <PortGlyph
            kind={data.portTransportKinds?.get(portId("in", data.itemId))}
            side="left"
          />
        </>
      )}
      <div className="pn-head">
        {/* An item with no sprite still contributes an empty child, so the
            head keeps its two flex items and the gap between them; dropping
            the element would slide the name column left by that gap. */}
        {hasSprite ? <Sprite iconId={iconId} size={28} /> : <div />}
        <div className="pn-name" title={nameTitle}>
          {visibleName}
          {badgeText !== null ? (
            <span
              className="pn-badge"
              data-testid="pn-catalyst-badge"
              aria-hidden="true"
            >
              {badgeText}
            </span>
          ) : null}
        </div>
      </div>
      <div className="pn-rate" title={rateTitle}>
        {rateValue}
        <span className="unit">{i18n.t("canvas.rate.unit")}</span>
        {shareOf !== null ? (
          <span className="pn-rate__of">
            {i18n.t("product.tap.share", { rate: shareOf })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
