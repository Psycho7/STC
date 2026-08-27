import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { useMemo } from "react";
import type Fraction from "fraction.js";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";
import { HIDE_STALE_EPS, MAX_CHIP_SCALE } from "./dimensions";
import { chamferStepPath, routingHintsFromData } from "./edgePath";
import { iconPosition } from "./iconSprite";
import { itemColor } from "./itemColor";

export type ItemEdgeData = {
  item: ItemId;
  rate: Fraction;
  // Per-edge transport phase (belt, pipe, or gas, with room to grow). Picks the
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
  // Per-bend corridor budget (half the stagger pitch) assigned alongside bendX by
  // assignBendColumns. chamferStepPath grows the forward step's corner chamfers
  // toward MAX_CHAMFER, capped by this budget so a fattened bevel never reaches a
  // sibling column. Optional: when absent the base CHAMFER stands.
  chamferBudget?: number;
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
  // Clear horizontal y for a blocked forward final leg, stamped by
  // jogForwardLegs. chamferStepPath reads it in its forward normal-step branch
  // to bend the leg around an intervening card. Optional: absent for unblocked
  // forward edges and every backward edge.
  legY?: number;
  // Vertical nudge for the midpoint rate chip, assigned by deconflictChipAnchors
  // when the chip would otherwise land on top of another edge's chip. Added to
  // the label y so the two chips clear each other. Optional and defaults to 0.
  labelDy?: number;
  // Horizontal slide for the midpoint rate chip, assigned by
  // deconflictChipAnchors when the vertical cascade cannot clear a dense
  // corridor: together with labelDy it moves the chip to a clear point ALONG
  // its own polyline, so the label stays attached to the line it names. Added
  // to the label x. Optional and defaults to 0.
  labelDx?: number;
  // Stamped by the seating pass on an edge whose whole polyline is shorter
  // than one rendered chip: the chip renders icon-only (rate on hover) because
  // no seat on the line can hold the full box.
  chipIconOnly?: boolean;
  // Set by Canvas's hover focus on every non-focused edge. The chips read it
  // because EdgeLabelRenderer portals them outside the edge wrapper that carries
  // the `dimmed` class, so the wrapper's fade never reaches them; the chip's own
  // .flow-chip.dimmed rule does. Optional and defaults to falsy (idle / lit).
  dimmed?: boolean;
  // Set by Canvas's hover focus on every LIT edge. The chips read it to survive
  // the zoom LOD gates, so the hover answers the rate question it asks instead
  // of lighting an edge that shows no number. Optional, defaults to falsy.
  focused?: boolean;
  // Fan-in marker (deconflictChipAnchors). Where 2+ forward same-item edges enter
  // one target in-port their final legs run collinear at the port y from a merge
  // point to the port; fan-in is otherwise structurally unmodeled (all trunk keys
  // are (item, source), never (item, target)). This pair is stamped on the ONE
  // elected owner item edge of such a group so its ItemEdge draws the merge point
  // as a bus-junction dot. A port that also receives a same-item feed outside the
  // run (a lane-bus rise, a backward rail) gets no marker at all. Presentational
  // only: no edge is retyped and no member's own rate changes.
  faninJunctionX?: number;
  faninJunctionY?: number;
  // Set on a NON-OWNER fan-in member whose OWN rate chip would sit ON the shared
  // run (between the merge point and the port), where the owner's own rate chip
  // reads: ItemEdge then draws no rate chip, keeping the exact member rate on a
  // transparent hover path (and the target card's input row). Members whose chip
  // sits on their own PRE-merge leg keep it. Mirrors the bus member-hide.
  // faninChipHiddenAtY records the port y the hide was decided at, so the hide
  // (like the whole marker) drops once a drag moves the live port off the stamp.
  faninChipHidden?: boolean;
  faninChipHiddenAtY?: number;
  // Declined fan-out marker (deconflictChipAnchors, #43). Where N >= 2 edges of
  // the same (item, source) run to >= 2 distinct targets but their span falls
  // outside routeFanoutEdges' band, no bus trunk forms: the members stay plain
  // item edges that leave the shared out-port coincident and peel off one at a
  // time, so the run reads as a single line carrying one member's rate. These
  // fields are stamped on the ONE elected owner item edge of such a group (the
  // point is on every member's line, so any of them could draw it) and mark the
  // x where the first member leaves the source row, at the source port y. A
  // group whose members all bind to one target is a parallel bundle, not a
  // split, and gets nothing; nor does one where no member ever leaves the row.
  fanoutJunctionX?: number;
  fanoutJunctionY?: number;
};

// Fallback stroke per transport kind, used only when an edge carries no item id
// (older fixtures and tests). Belt is a solid gray stroke; pipe is a dashed cyan
// stroke that reuses the input-product accent color; gas is a dash-dot stroke in
// a lighter cyan, so the two fluid carriers read as related media of different
// density. When an item id is present the stroke color instead comes from
// itemColor so the same item reads the same on every edge kind; the dash pattern
// is preserved either way. Unknown kinds fall through to the belt default on
// purpose. The real guard against bad data happens at load time; this
// render-time fallback just keeps the UI alive.
const BELT_STROKE = "#666";
const PIPE_STROKE = "#0891b2";
const PIPE_DASH = "4 2";
const GAS_STROKE = "#22d3ee";
const GAS_DASH = "6 2 1 2";

// Below this zoom the rate chips are dropped. Dense plans now fit at roughly
// 0.35-0.55, so the gate sits just under that band: chips appear at the new
// dense-plan fit zooms instead of only after zooming in. Below the gate the
// overview reads as clean lines. Reading transform[2] (zoom only) re-renders the
// edge on zoom changes but not on pan.
export const LABEL_MIN_ZOOM = 0.35;

// Second, lower zoom LOD gate. Below it the chips that are EXEMPT from
// LABEL_MIN_ZOOM (the bus aggregate drop chip and a lone member's long-detour
// rise chip) collapse to icon-only: the item icon alone, with the rate digits
// dropped. This preserves the "something flows here" signal while un-blanketing
// dense clusters at fit zoom; the exact rate stays reachable on the chip's hover
// tooltip. Calibrated against the corpus fit zooms measured in-browser at
// 1920x1080: the gate sits in the gap between the one plan that must collapse
// (multi6, 0.21) and the densest plan that must stay full (battery5-xiranite,
// 0.35 - just above LABEL_MIN_ZOOM, so nothing on it collapses either). The
// remaining plans sit well clear: equip4 0.44, battery5 0.45, crystal 0.50,
// tundra 0.66, default 0.90. Kept below LABEL_MIN_ZOOM so the LOD stays
// monotonic: per-member chips drop first, then the surviving aggregates shed
// their digits.
export const CHIP_ICON_ONLY_MAX_ZOOM = 0.32;

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
// chip at ItemEdge's bend column and BusEdge's drop / rise chips on the trunk
// lane. One place owns the DOM contract: a nodrag/nopan .flow-chip div centered
// on (x, y) by the double translate, tinted to the item through
// chipAccentStyle, carrying the full "Name x rate/min" string on aria-label and
// title, with an optional 16px item sprite followed by the optional chip text.
// `tear` switches to the red tear-edge variant; `dimmed` appends the `dimmed`
// class so a chip fades with its edge under the hover ego-network (the edge
// wrapper's own dim never reaches the portaled chip).
export function FlowChip({
  testId,
  edgeId,
  x,
  y,
  item,
  text,
  label,
  title,
  tear,
  dimmed,
  focused,
  compact,
  zoom,
}: {
  testId: string;
  // Owning edge id, emitted as data-edge-id so the geometry audit can exempt an
  // edge's own chips when testing edge segments against foreign chip boxes.
  edgeId?: string | undefined;
  x: number;
  y: number;
  item?: ItemId | undefined;
  text?: string | undefined;
  label: string;
  // Hover-tooltip text. Defaults to `label`; edges pass the exact, un-rounded
  // rate here so hovering reveals the precise value the rounded chip text hides.
  title?: string | undefined;
  tear?: boolean | undefined;
  dimmed?: boolean | undefined;
  // Set on a hover-lit edge's chip: it keeps its digits below the icon-only
  // zoom so the hover surfaces the rate.
  focused?: boolean | undefined;
  // Set on a chip whose edge has no room for the full box at any zoom (a leg
  // shorter than one chip): it collapses to icon-only regardless of zoom. A
  // hover-lit chip still wins, so the rate stays one hover away.
  compact?: boolean | undefined;
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
  // Below the icon-only zoom the surviving (LABEL_MIN_ZOOM-exempt) chips shed
  // their rate digits and render as the bare item icon, so a dense fit view
  // stops blanketing. The exact rate stays on the title tooltip.
  // Zoom-gated member chips never reach here: they are already hidden by the
  // higher LABEL_MIN_ZOOM gate at their call sites. `compact` collapses a chip
  // at every zoom (its line is too short for the full box at any scale); the
  // hover reveal overrides both, so no chip is permanently rate-less.
  const iconOnly =
    (compact === true ||
      (zoom !== undefined && zoom < CHIP_ICON_ONLY_MAX_ZOOM)) &&
    !focused;
  const bodyText = iconOnly ? "" : text;
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        {...(edgeId !== undefined ? { "data-edge-id": edgeId } : {})}
        className={
          "nodrag nopan flow-chip" +
          (iconOnly ? " icon-only" : "") +
          (tear ? " red" : "") +
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
        {/* An icon-less item that collapses leaves the box EMPTY on purpose: it
            stays a tinted hover target carrying title/aria-label. */}
        {pos !== undefined ? (
          <span className="ico ico-16">
            <span className="spr" style={{ backgroundPosition: pos }} />
          </span>
        ) : null}
        {/* The text rides in its own span so the .flow-chip max-width clamp can
            ellipsize it (text-overflow does not reach a bare text node inside a
            flex container). The title attribute above keeps the full value. A
            collapsed chip has no body at all. */}
        {bodyText ? <span className="chip-text">{bodyText}</span> : null}
      </div>
    </EdgeLabelRenderer>
  );
}

// Radius of a merge junction dot -- the small filled circle a bus member or a
// fan-in owner draws where its own line joins a shared run -- in graph units.
const JUNCTION_RADIUS = 3;

// Junction-dot screen-radius bounds, in physical px. The dot is drawn in graph
// units, so the pane zoom scales it (on-screen radius = r * zoom): at the
// dense-plan fit zoom a 3-unit dot is a sub-pixel speck. Counter-scale it like
// the stroke clamp so the dot holds a legible on-screen radius clamped to this
// range across zoom.
const JUNCTION_MIN_PX = 3;
const JUNCTION_MAX_PX = 5;

// Graph-unit radius that renders the junction dot at a screen radius clamped to
// [JUNCTION_MIN_PX, JUNCTION_MAX_PX]. At zoom 1 this is the natural
// JUNCTION_RADIUS; below it the graph radius grows to hold the pixel floor,
// above it the dot stops growing at the pixel cap. zoom is always > 0 (the pane
// clamps minZoom well above zero).
export function junctionRadius(zoom: number): number {
  const screen = Math.min(
    JUNCTION_MAX_PX,
    Math.max(JUNCTION_MIN_PX, JUNCTION_RADIUS * zoom),
  );
  return screen / zoom;
}

// The merge junction dot, portaled into the shared edgelabel-renderer layer (not
// an SVG circle in the edge group) so it shares the chips' stacking context: it
// sits BELOW the flow chips (.bus-junction z-index 1 vs .flow-chip z-index 2 in
// canvas.css), so an overlapping aggregate chip's digits win. Sized in graph
// units via junctionRadius so the pane zoom renders it at a clamped screen
// radius. Threads the same `dimmed` state the chips do. Shared by BusEdge (lane /
// fan-out branch dots) and ItemEdge (fan-in merge dots).
export function JunctionDot({
  testId,
  x,
  y,
  color,
  dimmed,
  zoom,
}: {
  testId: string;
  x: number;
  y: number;
  color: string;
  dimmed?: boolean | undefined;
  zoom: number;
}) {
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        aria-hidden="true"
        className={"bus-junction" + (dimmed ? " dimmed" : "")}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          width: `${2 * junctionRadius(zoom)}px`,
          height: `${2 * junctionRadius(zoom)}px`,
          background: color,
        }}
      />
    </EdgeLabelRenderer>
  );
}

type StrokeStyle = { stroke: string; strokeDasharray?: string };

export function strokeForKind(
  kind: TransportKindId | undefined,
  itemId?: ItemId,
): StrokeStyle {
  const stroke = itemId !== undefined ? itemColor(itemId) : undefined;
  if (kind === "gas") {
    return { stroke: stroke ?? GAS_STROKE, strokeDasharray: GAS_DASH };
  }
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
  // Drag-staleness guard for the fan-in marker, mirroring BusEdge's
  // fanoutBranchHiddenAt pattern (the ratified issue-9 stale-hide rule): the
  // marker fields are stamped absolute coordinates from the seating pass, and
  // nodes stay mouse-draggable without a re-seat. Once the stamped port y
  // diverges from the LIVE target port y (the targetY prop) past the eps, the
  // dot and the member hide drop together -- a floating marker or a wrongly
  // hidden chip is worse than a temporarily unmarked merge. The threshold is
  // the shared HIDE_STALE_EPS, sized in dimensions.ts.
  const faninStale = (stampY: number | undefined): boolean =>
    stampY !== undefined && Math.abs(stampY - targetY) >= HIDE_STALE_EPS;
  // A non-owner fan-in member whose own rate chip would sit on the shared merged
  // run draws no rate chip -- the owner's own chip reads there instead. The exact
  // member rate stays reachable on the transparent hover path below (and the
  // target card's input row), mirroring the bus member-hide. The hide only holds
  // while the live port still matches the stamp (see the staleness guard above).
  const ownChipHidden =
    edgeData?.faninChipHidden === true &&
    !faninStale(edgeData.faninChipHiddenAtY);
  // The owner's merge dot follows the same staleness rule.
  const faninMarkerLive =
    edgeData?.faninJunctionY !== undefined &&
    !faninStale(edgeData.faninJunctionY);
  // The declined fan-out dot sits near the SOURCE port, so it is stale-checked
  // against the live source y instead of the target y -- same eps, same rule:
  // once a drag moves the port off the stamp, drop the dot rather than float it.
  const fanoutMarkerLive =
    edgeData?.fanoutJunctionY !== undefined &&
    Math.abs(edgeData.fanoutJunctionY - sourceY) < HIDE_STALE_EPS;
  // The zoom gate yields to the hover focus: a lit edge shows its rate at any
  // zoom. The overlap-driven hides above still win, since they are placement
  // rulings, not level of detail.
  const chipText =
    edgeData &&
    rateStr &&
    (zoom >= LABEL_MIN_ZOOM || edgeData.focused === true) &&
    !ownChipHidden
      ? `${rateStr}${unit}`
      : "";
  const fullLabel =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${rateStr}${unit}`
      : "";
  const exactTitle =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(edgeData.rate)}${unit}`
      : "";

  // chamferStepPath returns the label anchor on the polyline's PREFERRED CLEAR
  // SEGMENT (a corridor leg away from the card rows), not the geometric midpoint.
  // deconflictChipAnchors then seats the chip from there via labelDx/labelDy: it
  // slides along the polyline to a clear point and normally keeps the chip on the
  // line it labels, but its escape tier deliberately seats it OFF the line when
  // that is the only way to uphold the hard chip-vs-chip / chip-vs-card
  // invariants (the ratcheted off-path residue). labelSide is no longer read
  // here or anywhere else, and is retained on the edge data only for potential
  // future routing.
  // Memoized on the endpoints and edge data: the geometry does not depend on
  // zoom, and the zoom subscription above re-renders every edge each zoom tick.
  const [edgePath, labelX, labelY] = useMemo(
    () =>
      chamferStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        ...routingHintsFromData(edgeData),
      }),
    [sourceX, sourceY, targetX, targetY, edgeData],
  );

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
          edgeId={id}
          x={labelX + (edgeData?.labelDx ?? 0)}
          y={labelY + (edgeData?.labelDy ?? 0)}
          item={edgeData?.item}
          text={chipText}
          label={fullLabel}
          title={exactTitle}
          tear={edgeData?.isTearEdge}
          dimmed={edgeData?.dimmed}
          focused={edgeData?.focused}
          compact={edgeData?.chipIconOnly === true}
          zoom={zoom}
        />
      ) : null}
      {/* A hidden fan-in member drew no rate chip, so keep its exact rate
          reachable on the edge itself: a transparent hover path over the same
          geometry carries the native SVG tooltip (mirrors BusEdge). */}
      {ownChipHidden && exactTitle ? (
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          pointerEvents="stroke"
        >
          <title>{exactTitle}</title>
        </path>
      ) : null}
      {/* Fan-in merge dot (owner only): where the last same-item member joins the
          shared run into the target port. Reuses BusEdge's junction dot markup.
          Dropped while stale (see the staleness guard above). */}
      {faninMarkerLive && edgeData?.faninJunctionX !== undefined ? (
        <JunctionDot
          testId={`fanin-junction-${id}`}
          x={edgeData.faninJunctionX}
          y={edgeData.faninJunctionY!}
          color={kindStyle.stroke}
          dimmed={edgeData.dimmed}
          zoom={zoom}
        />
      ) : null}
      {/* Declined fan-out divergence dot (#43, owner only): where coincident
          same-flow item edges leave the shared out-port run for their own
          targets. Same markup and stacking as the fan-in merge dot; dropped
          while stale against the live source y. */}
      {fanoutMarkerLive && edgeData?.fanoutJunctionX !== undefined ? (
        <JunctionDot
          testId={`fanout-junction-${id}`}
          x={edgeData.fanoutJunctionX}
          y={edgeData.fanoutJunctionY!}
          color={kindStyle.stroke}
          dimmed={edgeData.dimmed}
          zoom={zoom}
        />
      ) : null}
    </>
  );
}
