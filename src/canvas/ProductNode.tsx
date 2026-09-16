import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Item } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import type { I18nIndex } from "../data/i18n";
import { formatRationalPerMin } from "../data/rate-format";
import type { RationalString } from "../pipeline/types";
import { PortGlyph } from "./PortGlyph";
import { useItemPack } from "./itemPackContext";
import type { CatalystBreakdown, PortTransportKinds } from "./layout";
import { iconPosition } from "./iconSprite";
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

  // Direction and classification, spoken rather than drawn.
  const ariaLabel = buildPnAriaLabel(data, item, i18n);

  // Primary rate. For inputs this is realized demand; for outputs the target or
  // surplus rate.
  const rateValue = formatRationalPerMin(data.rate);
  // Share of the parent aggregate, fanout slices only: "of <total>/min" points
  // the reader back at the source card this tap draws from.
  const shareOf =
    isInput && data.isFanout && data.parentRate !== undefined
      ? formatRationalPerMin(data.parentRate)
      : null;

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
        <div className="pn-name" title={nameTitle}>
          {displayName}
        </div>
      </div>
      <div className="pn-rate">
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
