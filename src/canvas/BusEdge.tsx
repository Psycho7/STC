import { useStore, type EdgeProps } from "@xyflow/react";
import { useMemo } from "react";
import {
  FlowChip,
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
import { useExportMode } from "./exportMode";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";

// The junction dot markup and its zoom-clamped radius are shared with ItemEdge
// (the divergence dot reuses them); junctionRadius is re-exported so existing
// importers that reach for it via BusEdge keep working.
export { junctionRadius };

// BusEdge renders a TRUNK member, fan-out or fan-in, through the matching path
// builder:
//   fan-out (chamferFanoutPath) exit the source rightward to the trunk's shared
//           junction column, branch up (or down) that column to the target and
//           enter it with a final rightward stub;
//   fan-in  (chamferFaninPath) the mirror -- run out of the source to the
//           trunk's shared merge column, descend it to the target row, and
//           finish on the leg every member of the trunk shares into the port.
// Every member of one trunk is drawn with the same column, so the shared part
// overlaps into one line and the trunk draws once without any cross-edge
// coordination, and every member draws the trunk's junction dot at the point
// they all coincide (the split for a fan-out, the merge for a fan-in).
// Stroke reuses ItemEdge's edgeStrokeStyle; the markerEnd arrow stays at the
// target. Two chips: the trunk's ONE aggregate, drawn by the elected owner on
// the shared stretch, and each member's own rate on the stretch that is its
// alone -- which for a fan-out member is its branch leg into the target and for
// a fan-in member its stub out of the source.
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
  const liveZoom = useStore((state) => state.transform[2]);
  // The PNG export rasterizes at unit scale, so every zoom gate below reads 1
  // and the image keeps full detail whatever the camera was parked at.
  const exporting = useExportMode();
  const zoom = exporting ? 1 : liveZoom;
  const i18n = useI18n();
  // Either shape exposes one aggregate chip anchor (the shared stretch) and one
  // per-member chip anchor (the member's own stretch). drawnEdge resolves the
  // routing hints, the shape and the own-stretch slice.
  // Memoized on the endpoints and edge data: the geometry does not depend on
  // zoom, and the zoom subscription above re-renders every edge each zoom tick.
  const drawn = useMemo(
    () => drawnEdge({ sourceX, sourceY, targetX, targetY }, "bus", edgeData),
    [sourceX, sourceY, targetX, targetY, edgeData],
  );
  // This component renders the "bus" edge type alone (Canvas's edgeTypes map),
  // and routeTrunkEdges is its only producer, so drawnEdge answers one of the
  // two trunk shapes. An edge that is bus-typed without either stamp draws
  // nothing rather than being forced into a shape its data does not describe.
  const fan =
    drawn.shape === "fanout" || drawn.shape === "fanin" ? drawn : null;
  const path = drawn.path;
  // Aggregate chip anchor: the rule seat on the stretch the trunk shares. The
  // path builder put it there; nothing moves it afterwards.
  const aggX = fan?.trunkAnchor.x ?? 0;
  const aggY = fan?.trunkAnchor.y ?? 0;

  const { stroke, style: mergedStyle } = edgeStrokeStyle(
    edgeData?.transportKind,
    edgeData?.item,
    zoom,
    style,
  );

  const unit = i18n.t("canvas.rate.unit");
  // The aggregate (drop) chip takes the same mount gate as every other chip --
  // no family is exempt -- and a hover-lit edge is the one thing that lifts it,
  // because the hover is the reader asking for that rate.
  const showAggChip =
    edgeData !== undefined &&
    (zoom >= LABEL_MIN_ZOOM || edgeData.focused === true);

  // Drop chip: the trunk's ONE aggregate, drawn by the elected owner on the
  // shared trunk segment. It shows the whole port's total -- on a single-member
  // trunk that is simply that edge's own rate. The gap the trunk runs through
  // was widened for this chip before routing, so it has room beside the
  // members' own chips.
  const isOwner = isTrunkOwner(edgeData);
  const totalRate = edgeData?.busTotalRate ?? edgeData?.rate;
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

  // Branch chip text: this member's own rate plus the unit, the same reading
  // as the plain item edges beside it. The trunk total prints on the aggregate
  // chip alone.
  const plainRate = `${memberRateStr}${unit}`;
  const riseText = showMemberChip && memberRateStr ? plainRate : "";
  const riseLabel =
    edgeData && memberRateStr ? rateLabel(itemName, plainRate) : "";
  const riseTitle =
    edgeData && memberRateStr
      ? rateLabel(itemName, `${memberExactStr}${unit}`)
      : "";
  // Per-member chip anchor: the rule seat on the stretch that is this member's
  // alone.
  const branchX = fan?.branchAnchor.x ?? 0;
  const branchY = fan?.branchAnchor.y ?? 0;

  // One chip on the trunk segment (where the flow enters the trunk) and one on
  // the branch leg (where it leaves toward the target).
  const renderChip = (
    suffix: string,
    x: number,
    y: number,
    text: string,
    label: string,
    title: string,
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
        fromPool={edgeData?.fromPool}
        markerEnd={markerEnd}
      />
      {/* Junction dot where the trunk's members coincide -- the split for a
          fan-out, the merge for a fan-in -- reusing the shared JunctionDot
          markup. It sits BELOW the flow chips in the shared edgelabel-renderer
          layer, so the aggregate chip's digits win. Every member of a trunk
          draws it at the same point, coincident by construction. */}
      {fan !== null ? (
        <JunctionDot
          testId={
            fan.shape === "fanin"
              ? `fanin-junction-${id}`
              : `bus-junction-${id}`
          }
          family={fan.shape === "fanin" ? "fanin" : "fanout"}
          x={fan.junction.x}
          y={fan.junction.y}
          color={stroke}
          dimmed={edgeData?.dimmed}
          zoom={zoom}
        />
      ) : null}
      {isOwner && dropText
        ? renderChip("drop", aggX, aggY, dropText, dropLabel, dropTitle)
        : null}
      {riseText
        ? renderChip("rise", branchX, branchY, riseText, riseLabel, riseTitle)
        : null}
    </>
  );
}
