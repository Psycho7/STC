import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import type Fraction from "fraction.js";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";
import { ENTRY_CHIP_OFFSET, MAX_CHIP_SCALE } from "./dimensions";
import { chamferStepPath, routingHintsFromData } from "./edgePath";
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
  // Fan-in/fan-out side hint stamped by assignLabelSides in the render
  // pipeline. Nothing reads it anymore: the rate chip always sits at the path
  // midpoint chamferStepPath reports. Retained on the data only for potential
  // future routing use.
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
  // Backward-detour rail y staked out by clampBackwardRails so the rail clears
  // the cards it spans. chamferStepPath reads it in its backward branch.
  // Optional: absent for forward edges and un-clamped backward edges.
  railY?: number;
  // Set by fromElkRenderLayout when this edge's consumer (target unit) has two
  // or more inputs. It gates the icon-only entry chip pinned at the target port,
  // which names the entering line right at the node where several inputs meet.
  // Single-input consumers leave it unset, so their lone entering line needs no
  // extra identity chip. Optional and defaults to falsy.
  multiInputTarget?: true;
  // Vertical stack offset for the entry chip, assigned by deconflictChipAnchors
  // when several arrivals at one target node would otherwise pin their entry
  // chips to overlapping anchors. Added to the port y so the chips stack in
  // arrival order instead of coinciding. Optional and defaults to 0.
  entryChipDy?: number;
  // Vertical nudge for the midpoint rate chip, assigned by deconflictChipAnchors
  // when the chip would otherwise land on top of another edge's chip. Added to
  // the label y so the two chips clear each other. Optional and defaults to 0.
  labelDy?: number;
  // Set by Canvas's hover focus on every non-focused edge. The chips read it
  // because EdgeLabelRenderer portals them outside the edge wrapper that carries
  // the `dimmed` class, so the wrapper's fade never reaches them; the chip's own
  // .flow-chip.dimmed rule does. Optional and defaults to falsy (idle / lit).
  dimmed?: boolean;
};

// Anchor for an entry chip: one inset left of the target port, at the port y
// plus the stack offset deconflictChipAnchors assigned (0 when the chip is the
// only arrival, so it stays pinned to its port). Pure so it can be unit-tested.
export function entryChipAnchor(
  targetX: number,
  targetY: number,
  stackDy = 0,
): { x: number; y: number } {
  return { x: targetX - ENTRY_CHIP_OFFSET, y: targetY + stackDy };
}

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

// Below this zoom the rate chips are dropped. Dense plans now fit at roughly
// 0.35-0.55, so the gate sits just under that band: chips appear at the new
// dense-plan fit zooms instead of only after zooming in. Below the gate the
// overview reads as clean lines. Reading transform[2] (zoom only) re-renders the
// edge on zoom changes but not on pan.
export const LABEL_MIN_ZOOM = 0.35;

// Physical stroke-width bounds. Edge strokes are drawn in graph units, so the
// pane zoom scales them: at fit zoom a 1-unit stroke is a sub-pixel hairline. To
// keep edges visible the width is set to 1/zoom (so it renders near-constant on
// screen), clamped to this physical-pixel range so it neither vanishes at low
// zoom nor bloats into a slab. Exposed on the path as --edge-base-width so the
// hover emphasis rule can scale relative to it.
const MIN_EDGE_PX = 1;
const MAX_EDGE_PX = 3;

// Zoom-compensated stroke width in physical px, clamped to [MIN_EDGE_PX,
// MAX_EDGE_PX]. At zoom 1 this is 1px (unchanged from the default).
export function edgeStrokeWidth(zoom: number): number {
  return Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, 1 / zoom));
}

// Counter-scale for edge-label chips below zoom 1. Chips live in the
// EdgeLabelRenderer, which scales with the pane, so at fit zoom a 16px chip
// shrinks below legibility. Scaling by 1/zoom keeps the on-screen size roughly
// constant; the clamp caps the boost so chips never balloon on tiny plans. At
// the LABEL_MIN_ZOOM gate (0.35) the 2x cap yields ~11px effective, above the
// ~10px legibility floor.
export function chipCounterScale(zoom: number): number {
  return zoom < 1 ? Math.min(MAX_CHIP_SCALE, 1 / zoom) : 1;
}

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
// chip's "entry"); `dimmed` appends the `dimmed` class so a chip fades with its
// edge under the hover ego-network (the edge wrapper's own dim never reaches the
// portaled chip).
export function FlowChip({
  testId,
  x,
  y,
  item,
  text,
  label,
  title,
  tear,
  extraClass,
  dimmed,
  zoom,
}: {
  testId: string;
  x: number;
  y: number;
  item?: ItemId | undefined;
  text?: string | undefined;
  label: string;
  // Hover-tooltip text. Defaults to `label`; edges pass the exact, un-rounded
  // rate here so hovering reveals the precise value the rounded chip text hides.
  title?: string | undefined;
  tear?: boolean | undefined;
  extraClass?: string | undefined;
  dimmed?: boolean | undefined;
  // Live pane zoom, used to counter-scale the chip so it stays legible at the
  // dense-plan fit zoom. Optional: callers without a zoom leave the chip at its
  // natural size (scale 1).
  zoom?: number | undefined;
}) {
  const pos = item !== undefined ? iconPosition(item) : undefined;
  // Counter-scale about the chip centre. translate(-50%,-50%) translate(x,y)
  // already centres the box on (x, y); appending scale() with the default
  // (centre) transform-origin keeps that anchor and only grows the chip.
  const scale = zoom !== undefined ? chipCounterScale(zoom) : 1;
  const scalePart = scale !== 1 ? ` scale(${scale})` : "";
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        className={
          "nodrag nopan flow-chip" +
          (tear ? " red" : "") +
          (extraClass !== undefined ? ` ${extraClass}` : "") +
          (dimmed ? " dimmed" : "")
        }
        aria-label={label}
        title={title ?? label}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)${scalePart}`,
          whiteSpace: "nowrap",
          ...chipAccentStyle(item),
        }}
      >
        {pos !== undefined ? (
          <span className="ico ico-16">
            <span className="spr" style={{ backgroundPosition: pos }} />
          </span>
        ) : null}
        {/* The text rides in its own span so the .flow-chip max-width clamp can
            ellipsize it (text-overflow does not reach a bare text node inside a
            flex container). The title attribute above keeps the full value. */}
        {text ? <span className="chip-text">{text}</span> : null}
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
  // The chip body shows the icon plus the rounded rate and unit, nothing more.
  // The full "Name x rate/min" string rides on aria-label so a screen reader can
  // name the item, and a separate tooltip carries the exact, un-rounded rate the
  // rounding hides (chips now accept pointer events, so hovering shows it).
  const chipText =
    edgeData && rateStr && zoom >= LABEL_MIN_ZOOM ? `${rateStr}${unit}` : "";
  const fullLabel =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${rateStr}${unit}`
      : "";
  const exactTitle =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(edgeData.rate)}${unit}`
      : "";

  // The path builder anchors the label at the geometric midpoint of the drawn
  // polyline (50% of cumulative length), so the chip always sits on the line
  // it labels. Earlier versions nudged the chip toward the source or target
  // based on labelSide, which pinned it onto a port stub and off the visible
  // run of the path; labelSide is no longer read here or anywhere else, and is
  // retained on the edge data only for potential future routing.
  const [edgePath, labelX, labelY] = chamferStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    ...routingHintsFromData(edgeData),
  });

  const kindStyle = strokeForKind(edgeData?.transportKind, edgeData?.item);
  // Zoom-compensated base width, published as --edge-base-width so the hover
  // emphasis CSS can scale relative to it. A caller-supplied style wins over
  // these defaults, so later overrides for hover, tear edges, or cross-group
  // edges take effect without this file having to know about them.
  const mergedStyle: React.CSSProperties = {
    ...kindStyle,
    ["--edge-base-width" as string]: `${edgeStrokeWidth(zoom)}px`,
    strokeWidth: "var(--edge-base-width)",
    ...(style ?? {}),
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={mergedStyle}
        {...(fullLabel ? { "aria-label": fullLabel } : {})}
        {...(edgeData?.transportKind !== undefined
          ? { "data-transport-kind": edgeData.transportKind }
          : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
      {chipText ? (
        <FlowChip
          testId={`item-edge-label-${id}`}
          x={labelX}
          y={labelY + (edgeData?.labelDy ?? 0)}
          item={edgeData?.item}
          text={chipText}
          label={fullLabel}
          title={exactTitle}
          tear={edgeData?.isTearEdge}
          dimmed={edgeData?.dimmed}
          zoom={zoom}
        />
      ) : null}
      {/* Entry chip: an icon-only mini chip pinned at the target port, rendered
          only when the consumer has two or more inputs (multiInputTarget) and
          the zoom is above the same LABEL_MIN_ZOOM gate the rate chip uses. It
          reuses the flow-chip + sprite idiom but drops the rate text; the full
          "Name x rate/min" rides on aria-label and the exact rate on the hover
          tooltip so hovering or a screen reader names the item. The rate chip at
          the bend column is
          untouched: this chip only adds identity at the node where several
          inputs braid together. --chip-accent tints it to the item so the chip,
          the entering line, and the matching input row all read as one color. */}
      {edgeData?.multiInputTarget && zoom >= LABEL_MIN_ZOOM ? (
        <FlowChip
          testId={`item-edge-entry-${id}`}
          {...entryChipAnchor(targetX, targetY, edgeData.entryChipDy)}
          item={edgeData.item}
          label={fullLabel}
          title={exactTitle}
          extraClass="entry"
          dimmed={edgeData.dimmed}
          zoom={zoom}
        />
      ) : null}
    </>
  );
}
