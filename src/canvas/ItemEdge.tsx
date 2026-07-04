import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import type Fraction from "fraction.js";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { useI18n } from "../data/i18n-context";
import { formatRatePerMin } from "../data/rate-format";
import { chamferStepPath } from "./edgePath";
import { iconPosition } from "./iconSprite";
import { itemColor } from "./itemColor";

export type ItemEdgeData = {
  item: ItemId;
  rate: Fraction;
  // Per-edge transport phase (belt or pipe, with room to grow). Picks the
  // stroke and dash pattern below. It is optional so callers that have not
  // wired it through yet, including older fixtures and tests, still render with
  // the belt default; an unknown value also lands on the belt default instead
  // of throwing.
  transportKind?: TransportKindId;
  labelSide?: "source" | "target";
  // Set when this edge is the chosen tear edge of an SCC, which switches the
  // label chip to its red variant. It is optional and defaults to falsy.
  // Nothing sets it yet because SCC self-edges currently collapse into the loop
  // unit, so this is here ahead of the producer wiring that will fill it in.
  isTearEdge?: boolean;
  // Bend column x assigned by the stagger pass (assignBendColumns). Optional:
  // when absent the path builder centers the bend at the corridor midpoint.
  bendX?: number;
  // Entry-gutter column x assigned by the stagger pass (assignEntryColumns).
  // Two consumers read it: chamferStepPath places a backward edge's left rail
  // here, and chamferBusPath (via BusEdge) places a bus member's rise column
  // here. Optional: when absent each path builder falls back to its default
  // column just before the target port.
  entryX?: number;
  // Set by fromElkRenderLayout when this edge's consumer (target unit) has two
  // or more inputs. It gates the icon-only entry chip pinned at the target port,
  // which names the entering line right at the node where several inputs meet.
  // Single-input consumers leave it unset, so their lone entering line needs no
  // extra identity chip. Optional and defaults to falsy.
  multiInputTarget?: true;
};

// Horizontal inset of the entry chip from the target port, in graph units. The
// chip sits just outside the node on the entering leg so it reads as belonging
// to that line without overlapping the port glyph.
const ENTRY_CHIP_OFFSET = 12;

// Fallback stroke per transport kind, used only when an edge carries no item id
// (older fixtures and tests). Belt is a solid gray stroke; pipe is a dashed cyan
// stroke that reuses the input-product accent color. When an item id is present
// the stroke color instead comes from itemColor so the same item reads the same
// on every edge kind; the pipe dash is preserved either way. Unknown kinds fall
// through to the belt default on purpose. The real guard against bad data
// happens at load time; this render-time fallback just keeps the UI alive.
const BELT_STROKE = "#666";
const PIPE_STROKE = "#0891b2";
const PIPE_DASH = "4 2";

// Below this zoom the rate chips are dropped. On a dense plan the fit-to-view
// zoom lands well under this, so the overview reads as clean lines; zooming in
// to inspect a section brings the chips back. Reading transform[2] (zoom only)
// re-renders the edge on zoom changes but not on pan.
export const LABEL_MIN_ZOOM = 0.6;

// Inline style carrying the chip's accent color as the --chip-accent custom
// property, or an empty object when there is no item to color by. Both edge
// components spread this onto their flow-chip so the chip tints to the item.
export function chipAccentStyle(item?: ItemId): React.CSSProperties {
  return item !== undefined
    ? { ["--chip-accent" as string]: itemColor(item) }
    : {};
}

// FlowChip: the shared EdgeLabelRenderer chip every edge label uses -- the rate
// chip at ItemEdge's bend column, the icon-only entry chip at a multi-input
// target port, and BusEdge's drop / rise chips on the trunk lane. One place
// owns the DOM contract: a nodrag/nopan .flow-chip div centered on (x, y) by
// the double translate, tinted to the item through chipAccentStyle, carrying
// the full "Name x rate/min" string on aria-label and title, with an optional
// 16px item sprite followed by the optional chip text. `tear` switches to the
// red tear-edge variant; `extraClass` appends a modifier class (the entry
// chip's "entry").
export function FlowChip({
  testId,
  x,
  y,
  item,
  text,
  label,
  tear,
  extraClass,
}: {
  testId: string;
  x: number;
  y: number;
  item?: ItemId | undefined;
  text?: string | undefined;
  label: string;
  tear?: boolean | undefined;
  extraClass?: string | undefined;
}) {
  const pos = item !== undefined ? iconPosition(item) : undefined;
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        className={
          "nodrag nopan flow-chip" +
          (tear ? " red" : "") +
          (extraClass !== undefined ? ` ${extraClass}` : "")
        }
        aria-label={label}
        title={label}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          whiteSpace: "nowrap",
          ...chipAccentStyle(item),
        }}
      >
        {pos !== undefined ? (
          <span className="ico ico-16">
            <span className="spr" style={{ backgroundPosition: pos }} />
          </span>
        ) : null}
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

type StrokeStyle = { stroke: string; strokeDasharray?: string };

export function strokeForKind(
  kind: TransportKindId | undefined,
  itemId?: ItemId,
): StrokeStyle {
  const stroke = itemId !== undefined ? itemColor(itemId) : undefined;
  if (kind === "pipe") {
    return { stroke: stroke ?? PIPE_STROKE, strokeDasharray: PIPE_DASH };
  }
  return { stroke: stroke ?? BELT_STROKE };
}

export default function ItemEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const edgeData = data as ItemEdgeData | undefined;
  const zoom = useStore((state) => state.transform[2]);
  const i18n = useI18n();
  const rateStr = edgeData ? formatRatePerMin(edgeData.rate) : "";
  const unit = i18n.t("canvas.rate.unit");
  // The chip body shows the icon plus rate and unit, nothing more. The full
  // "Name x rate/min" string goes onto aria-label and title so screen readers
  // and the browser's hover tooltip still name the item.
  const chipText =
    edgeData && rateStr && zoom >= LABEL_MIN_ZOOM ? `${rateStr}${unit}` : "";
  const fullLabel =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${rateStr}${unit}`
      : "";

  const [edgePath, fallbackLabelX, fallbackLabelY] = chamferStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    ...(edgeData?.bendX !== undefined ? { bendX: edgeData.bendX } : {}),
    ...(edgeData?.entryX !== undefined ? { entryX: edgeData.entryX } : {}),
  });

  // Center the label in the corridor between layers, at the bend column the
  // path builder reports. An earlier version nudged the chip toward the source
  // or target based on labelSide, which left chips touching the neighboring node
  // and hard to read. Once the corridor is wide enough, the bend column sits
  // cleanly in the gap. labelSide still rides along on the edge data for routing
  // logic later, but it no longer moves the label's x/y here. Pinning labelY
  // keeps the chip on the source's or target's horizontal line so a vertically
  // routed step does not drop the label into the bend.
  const useTargetY = edgeData?.labelSide === "target";
  const useSourceY = edgeData?.labelSide === "source";
  const labelX = fallbackLabelX;
  const labelY = useTargetY ? targetY : useSourceY ? sourceY : fallbackLabelY;

  const kindStyle = strokeForKind(edgeData?.transportKind, edgeData?.item);
  // A caller-supplied style wins over the kind default, so later overrides for
  // hover, tear edges, or cross-group edges take effect without this file
  // having to know about them.
  const mergedStyle: React.CSSProperties = { ...kindStyle, ...(style ?? {}) };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={mergedStyle}
        {...(edgeData?.transportKind !== undefined
          ? { "data-transport-kind": edgeData.transportKind }
          : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
      {chipText ? (
        <FlowChip
          testId={`item-edge-label-${id}`}
          x={labelX}
          y={labelY}
          item={edgeData?.item}
          text={chipText}
          label={fullLabel}
          tear={edgeData?.isTearEdge}
        />
      ) : null}
      {/* Entry chip: an icon-only mini chip pinned at the target port, rendered
          only when the consumer has two or more inputs (multiInputTarget) and
          the zoom is above the same LABEL_MIN_ZOOM gate the rate chip uses. It
          reuses the flow-chip + sprite idiom but drops the rate text; the full
          "Name x rate/min" still rides on title / aria-label so hovering or a
          screen reader names the item. The rate chip at the bend column is
          untouched: this chip only adds identity at the node where several
          inputs braid together. --chip-accent tints it to the item so the chip,
          the entering line, and the matching input row all read as one color. */}
      {edgeData?.multiInputTarget && zoom >= LABEL_MIN_ZOOM ? (
        <FlowChip
          testId={`item-edge-entry-${id}`}
          x={targetX - ENTRY_CHIP_OFFSET}
          y={targetY}
          item={edgeData.item}
          label={fullLabel}
          extraClass="entry"
        />
      ) : null}
    </>
  );
}
