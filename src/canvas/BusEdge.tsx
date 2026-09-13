import { useStore, type EdgeProps } from "@xyflow/react";
import { useMemo } from "react";
import {
  FlowChip,
  HoverTitlePath,
  JunctionDot,
  LABEL_MIN_ZOOM,
  MaskedEdge,
  edgeStrokeStyle,
  junctionRadius,
  rateLabel,
  type ItemEdgeData,
} from "./ItemEdge";
import { isTrunkOwner, type BusEdgeData } from "./busRouting";
import { drawnEdge } from "./edgePath";
import { anchorStampLive } from "./dimensions";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";

// The junction dot markup and its zoom-clamped radius are shared with ItemEdge
// (the fan-in merge dot reuses them); junctionRadius is re-exported so existing
// importers that reach for it via BusEdge keep working.
export { junctionRadius };

// BusEdge renders a fan-out trunk member via chamferFanoutPath: exit the source
// rightward to the trunk's shared junction column, then branch up (or down) that
// column to the target and enter it with a final rightward stub. Every member of
// one trunk shares the same junction column, so their trunk segments overlap and
// the trunk visually draws once without any cross-edge coordination. Every member
// draws its own junction dot at the branch point.
// Stroke reuses ItemEdge's strokeForKind; the markerEnd arrow stays at the
// target. A lone-member trunk labels itself with the rate chip (icon +
// rate/min), reusing ItemEdge's flow-chip markup and zoom gate so a bus member
// reads the same as a plain item edge near what it feeds. A fan-out member's
// branch chip shows that member's own rate.
export default function BusEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const edgeData = data as (ItemEdgeData & BusEdgeData) | undefined;
  const zoom = useStore((state) => state.transform[2]);
  const i18n = useI18n();
  // The fan-out member's own stamps (junction / fanout* offsets), read off the
  // `fanout` discriminant.
  const fanoutData = edgeData?.fanout === true ? edgeData : undefined;
  // A fan-out member draws the short in-corridor trunk (source port -> shared
  // junction column -> branch to the target). It exposes one aggregate chip
  // anchor (the trunk segment) and one per-member chip anchor (the branch leg).
  // drawnEdge resolves the routing hints and the branch-leg slice.
  // Memoized on the endpoints and edge data: the geometry does not depend on
  // zoom, and the zoom subscription above re-renders every edge each zoom tick.
  const drawn = useMemo(
    () => drawnEdge({ sourceX, sourceY, targetX, targetY }, "bus", edgeData),
    [sourceX, sourceY, targetX, targetY, edgeData],
  );
  // This component renders the "bus" edge type alone (Canvas's edgeTypes map),
  // and routeFanoutEdges is its only producer, so drawnEdge always answers the
  // fan-out shape. An edge that is bus-typed without the stamp draws nothing
  // rather than being forced into a shape its data does not describe.
  const fan = drawn.shape === "fanout" ? drawn : null;
  const path = drawn.path;
  // Aggregate chip anchor: the trunk-segment midpoint. Per-member chip anchor:
  // the branch-leg midpoint. Each carries its own de-confliction offset
  // (fanoutAgg* / fanoutBranch*).
  const aggX = (fan?.trunkAnchor.x ?? 0) + (fanoutData?.fanoutAggDx ?? 0);
  const aggY = (fan?.trunkAnchor.y ?? 0) + (fanoutData?.fanoutAggDy ?? 0);

  const { stroke, style: mergedStyle } = edgeStrokeStyle(
    edgeData?.transportKind,
    edgeData?.item,
    zoom,
    style,
  );

  const unit = i18n.t("canvas.rate.unit");
  // The drop (trunk) chip is EXEMPT from the label zoom gate: it always renders
  // (counter-scaled) so a lone member's rate survives at the dense-plan fit
  // zoom, where per-member chips would be illegible clutter. The per-member
  // (branch) chip keeps the gate, so it appears only once the reader has
  // zoomed into that trunk.
  const showAggChip = edgeData !== undefined;

  // Drop chip: drawn only on a SINGLE-member trunk, where it is that edge's
  // plain rate label at the junction. A multi-member trunk draws no aggregate:
  // the summed total restated the source card's own rate while reading as one
  // more flow, so the members' own chips and the card rates carry the
  // information (issue #39). The junction dot still marks the trunk.
  const isOwner = isTrunkOwner(edgeData);
  const totalRate = edgeData?.busTotalRate ?? edgeData?.rate;
  const memberCount = edgeData?.busMemberCount ?? 1;
  // Per-member (branch) chip gate: zoom-gated, except that a hover-lit member is
  // exempt -- the hover asks for this member's rate, so the zoom gate must not
  // swallow the answer.
  const showMemberChip =
    edgeData !== undefined &&
    (zoom >= LABEL_MIN_ZOOM || edgeData.focused === true);
  // Every rate string this member can show, formatted once per (member rate,
  // trunk total) instead of once per render: the chip formats the trunk's EXACT
  // total, rounded once, the same way the boundary cards format it, so a chip
  // total and a card total never disagree (members rounded independently can
  // still sum a cent off that number, and the tooltips below keep the exact rate
  // either way). The formatting is BigInt Fraction work and the zoom
  // subscription above re-renders every member on every zoom tick, so the memo
  // keeps the digits off the tick.
  const { memberRateStr, memberExactStr, dropRateStr, totalExactStr } = useMemo(
    () => ({
      memberRateStr: edgeData ? formatRatePerMin(edgeData.rate) : "",
      memberExactStr: edgeData ? formatRateExactPerMin(edgeData.rate) : "",
      dropRateStr: totalRate ? formatRatePerMin(totalRate) : "",
      totalExactStr: totalRate ? formatRateExactPerMin(totalRate) : "",
    }),
    [edgeData, totalRate],
  );
  // Item name for every label and tooltip below; empty on a data-less edge, the
  // same case each string already guards.
  const itemName = edgeData ? i18n.displayName(edgeData.item) : "";
  const dropText = showAggChip && dropRateStr ? `${dropRateStr}${unit}` : "";
  const dropLabel =
    edgeData && dropRateStr ? rateLabel(itemName, `${dropRateStr}${unit}`) : "";
  const dropTitle =
    edgeData && dropRateStr && totalRate
      ? rateLabel(itemName, `${totalExactStr}${unit}`)
      : "";

  // Branch chip: each member draws its own, showing that member's rate. A member
  // flagged fanoutBranchHidden draws no branch chip at all: the seating pass
  // found no chip/card-clear point on its own polyline, and an off-line chip
  // would float in empty canvas (the rate stays on the target card's row and
  // this edge's hover tooltip below). The hide was taken at this member's own
  // branch anchor, so it is checked against the anchor rebuilt from the live
  // props -- and only when there is one: a null fan path leaves nothing to
  // compare, and a stamped hide with no live anchor drops.
  const hiddenAt = fanoutData?.fanoutBranchHiddenAt;
  const branchHidden =
    fanoutData?.fanoutBranchHidden === true &&
    (hiddenAt === undefined ||
      (fan !== null && anchorStampLive(hiddenAt, fan.branchAnchor)));
  const memberChipHidden = branchHidden;
  // Branch chip text: this member's own rate plus the unit, the same reading
  // as the plain item edges beside it. The trunk total prints on the aggregate
  // chip alone.
  const plainRate = `${memberRateStr}${unit}`;
  const riseText =
    showMemberChip && memberRateStr && !memberChipHidden ? plainRate : "";
  const riseLabel =
    edgeData && memberRateStr ? rateLabel(itemName, plainRate) : "";
  const riseTitle =
    edgeData && memberRateStr
      ? rateLabel(itemName, `${memberExactStr}${unit}`)
      : "";
  // Per-member chip anchor: the branch-leg midpoint plus its offset.
  const branchX =
    (fan?.branchAnchor.x ?? 0) + (fanoutData?.fanoutBranchDx ?? 0);
  const branchY =
    (fan?.branchAnchor.y ?? 0) + (fanoutData?.fanoutBranchDy ?? 0);

  // One chip on the trunk segment (where the flow enters the trunk) and one on
  // the branch leg (where it leaves toward the target).
  // `compact` collapses a chip to its item sprite at every zoom: the seating
  // pass stamps it on a fan-out branch whose leg is shorter than one chip box,
  // where the full box has no seat that keeps it off the trunk's split dot. The
  // rate stays readable on the chip's label and title.
  const renderChip = (
    suffix: string,
    x: number,
    y: number,
    text: string,
    label: string,
    title: string,
    compact = false,
    scaleCap?: number,
  ) => (
    <FlowChip
      testId={`bus-edge-label-${id}-${suffix}`}
      edgeId={id}
      x={x}
      y={y}
      item={edgeData?.item}
      text={text}
      label={label}
      title={title}
      dimmed={edgeData?.dimmed}
      focused={edgeData?.focused}
      compact={compact}
      scaleCap={scaleCap}
      zoom={zoom}
    />
  );

  return (
    <>
      <MaskedEdge
        id={id}
        path={path}
        style={mergedStyle}
        cues={edgeData?.crossingCues}
        zoom={zoom}
        ariaLabel={riseLabel}
        transportKind={edgeData?.transportKind}
        markerEnd={markerEnd}
      />
      {/* A hidden branch chip was this
          member's only exact-rate tooltip carrier, so keep the rate reachable
          on the edge itself: a transparent hover path over the same geometry
          carries the native SVG tooltip. */}
      {memberChipHidden && riseTitle ? (
        <HoverTitlePath d={path} title={riseTitle} />
      ) : null}
      {/* Junction dot at the branch point, reusing the shared JunctionDot
          markup. It sits BELOW the flow chips in the shared edgelabel-renderer
          layer, so the aggregate chip's digits win. Fan-out members always
          branch (N >= 2), so every member draws one. */}
      {fan !== null ? (
        <JunctionDot
          testId={`bus-junction-${id}`}
          family="fanout"
          x={fan.junction.x}
          y={fan.junction.y}
          color={stroke}
          dimmed={edgeData?.dimmed}
          zoom={zoom}
        />
      ) : null}
      {isOwner && memberCount === 1 && dropText
        ? renderChip("drop", aggX, aggY, dropText, dropLabel, dropTitle)
        : null}
      {riseText
        ? renderChip(
            "rise",
            branchX,
            branchY,
            riseText,
            riseLabel,
            riseTitle,
            fanoutData?.fanoutBranchIconOnly === true,
            fanoutData?.fanoutBranchScaleCap,
          )
        : null}
    </>
  );
}
