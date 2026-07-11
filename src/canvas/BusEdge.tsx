import { BaseEdge, useStore, type EdgeProps } from "@xyflow/react";
import {
  FlowChip,
  LABEL_MIN_ZOOM,
  edgeStrokeWidth,
  strokeForKind,
  type ItemEdgeData,
} from "./ItemEdge";
import type { BusEdgeData } from "./busRouting";
import {
  chamferBusPath,
  chamferFanoutPath,
  routingHintsFromData,
} from "./edgePath";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";

// Radius of the junction dot each bus edge draws at its own branch point, where
// it leaves the shared trunk lane to rise into its target.
const JUNCTION_RADIUS = 3;

// BusEdge renders a bus-trunk member via chamferBusPath: exit the source
// rightward, chamfer down into the shared lane, run along it, then chamfer up
// (or down) at the rise column and enter the target with a final rightward stub.
// Every edge of one trunk shares the same laneY, so their lane runs overlap and
// the trunk visually draws once without any cross-edge coordination. Each edge
// draws its own junction dot at the lane branch point (just before its rise).
// Stroke reuses ItemEdge's strokeForKind; the markerEnd arrow stays at the
// target. The rate chip (icon + rate/min) draws twice, at the drop and rise
// columns on the lane, reusing ItemEdge's flow-chip markup and zoom gate so a
// bus member reads the same as a plain item edge near what it feeds.
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
  // Fall back to targetY if laneY is somehow missing, which collapses the run to
  // a sane orthogonal drop-and-rise (the rise vertical vanishes) rather than
  // throwing.
  const laneY = edgeData?.laneY ?? targetY;
  const isFanout = edgeData?.fanout === true;
  // Fan-out members draw the short in-corridor trunk (source port -> shared
  // junction column -> branch to the target); lane members drop into the shared
  // band and rise at their column. Both expose one aggregate chip anchor (the
  // trunk / drop) and one per-member chip anchor (the branch / rise), so the chip
  // markup below is shared.
  const fan = isFanout
    ? chamferFanoutPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        ...routingHintsFromData(edgeData),
      })
    : null;
  const bus = isFanout
    ? null
    : chamferBusPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        laneY,
        ...routingHintsFromData(edgeData),
      });
  const path = fan?.path ?? bus!.path;
  const junction = fan?.junction ?? bus!.junction;
  const dropX = bus?.dropX ?? 0;
  const riseX = bus?.riseX ?? 0;
  // Aggregate chip anchor: the fan-out trunk-segment midpoint, or the lane drop
  // column. Per-member chip anchor: the fan-out branch-leg midpoint, or the lane
  // rise slot. Each carries its own de-confliction offset.
  const aggX =
    (fan ? fan.trunkAnchor.x : dropX) + (edgeData?.fanoutAggDx ?? 0);
  const aggY =
    (fan ? fan.trunkAnchor.y : laneY) +
    (fan ? (edgeData?.fanoutAggDy ?? 0) : (edgeData?.busDropDy ?? 0));

  const kindStyle = strokeForKind(edgeData?.transportKind, edgeData?.item);
  // Zoom-compensated base width published as --edge-base-width, matching
  // ItemEdge. A caller-supplied style still wins over these defaults.
  const mergedStyle: React.CSSProperties = {
    ...kindStyle,
    ["--edge-base-width" as string]: `${edgeStrokeWidth(zoom)}px`,
    strokeWidth: "var(--edge-base-width)",
    ...(style ?? {}),
  };

  const unit = i18n.t("canvas.rate.unit");
  const showChips = edgeData !== undefined && zoom >= LABEL_MIN_ZOOM;

  // Drop chip: only the elected trunk owner draws it, and it shows the summed
  // trunk rate (busTotalRate) plus a count marker when the trunk has several
  // members. A lone member is its own owner with count 1, so it reads exactly
  // like a plain item edge. Non-owner members suppress the drop chip, which is
  // what collapses the old N-deep stack of one-member-share chips into a single
  // truthful total on the shared lane.
  const isOwner = edgeData?.busChipOwner ?? true;
  const totalRate = edgeData?.busTotalRate ?? edgeData?.rate;
  const memberCount = edgeData?.busMemberCount ?? 1;
  const dropRateStr = totalRate ? formatRatePerMin(totalRate) : "";
  const countMarker = memberCount > 1 ? ` x${memberCount}` : "";
  const dropText =
    showChips && dropRateStr ? `${dropRateStr}${unit}${countMarker}` : "";
  const dropLabel =
    edgeData && dropRateStr
      ? `${i18n.displayName(edgeData.item)} x ${dropRateStr}${unit}${countMarker}`
      : "";
  const dropTitle =
    edgeData && dropRateStr && totalRate
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(totalRate)}${unit}${countMarker}`
      : "";

  // Rise chip: each member draws its own, showing that member's share. Its x is
  // the trunk's evenly distributed lane slot (busChipX) so members feeding the
  // same layer spread along the lane instead of stacking at a shared rise vertex;
  // it falls back to the geometric rise column when the slot is absent (a
  // manually built edge). The chip sits on the lane at laneY.
  const memberRateStr = edgeData ? formatRatePerMin(edgeData.rate) : "";
  const riseText = showChips && memberRateStr ? `${memberRateStr}${unit}` : "";
  const riseLabel =
    edgeData && memberRateStr
      ? `${i18n.displayName(edgeData.item)} x ${memberRateStr}${unit}`
      : "";
  const riseTitle =
    edgeData && memberRateStr
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(edgeData.rate)}${unit}`
      : "";
  const riseChipX = edgeData?.busChipX ?? riseX;
  // Per-member chip anchor: fan-out branch-leg midpoint (plus its offset), or the
  // lane rise slot at laneY.
  const branchX =
    (fan ? fan.branchAnchor.x : riseChipX) +
    (fan ? (edgeData?.fanoutBranchDx ?? 0) : 0);
  const branchY =
    (fan ? fan.branchAnchor.y : laneY) +
    (fan ? (edgeData?.fanoutBranchDy ?? 0) : (edgeData?.busChipDy ?? 0));

  // One chip at the drop point (where the flow enters the trunk) and one at the
  // rise point (where it leaves toward the target). Both sit on the lane.
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
      tear={edgeData?.isTearEdge}
      dimmed={edgeData?.dimmed}
      zoom={zoom}
    />
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={mergedStyle}
        {...(riseLabel ? { "aria-label": riseLabel } : {})}
        {...(markerEnd ? { markerEnd } : {})}
      />
      <circle
        className="bus-junction"
        cx={junction.x}
        cy={junction.y}
        r={JUNCTION_RADIUS}
        fill={kindStyle.stroke}
      />
      {isOwner && dropText
        ? renderChip("drop", aggX, aggY, dropText, dropLabel, dropTitle)
        : null}
      {riseText
        ? renderChip("rise", branchX, branchY, riseText, riseLabel, riseTitle)
        : null}
    </>
  );
}
