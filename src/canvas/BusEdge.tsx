import { BaseEdge, EdgeLabelRenderer, useStore, type EdgeProps } from "@xyflow/react";
import {
  LABEL_MIN_ZOOM,
  chipAccentStyle,
  strokeForKind,
  type ItemEdgeData,
} from "./ItemEdge";
import type { BusEdgeData } from "./busRouting";
import { chamferBusPath } from "./edgePath";
import { useI18n } from "../data/i18n-context";
import { formatRatePerMin } from "../data/rate-format";
import { iconPosition } from "./iconSprite";

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
  const { path, dropX, riseX, junction } = chamferBusPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    laneY,
  });

  const kindStyle = strokeForKind(edgeData?.transportKind, edgeData?.item);
  // A caller-supplied style wins over the kind default, matching ItemEdge.
  const mergedStyle: React.CSSProperties = { ...kindStyle, ...(style ?? {}) };

  const rateStr = edgeData ? formatRatePerMin(edgeData.rate) : "";
  const unit = i18n.t("canvas.rate.unit");
  // The chip body shows the icon plus rate and unit; the full "Name x rate/min"
  // string goes onto aria-label and title, matching ItemEdge.
  const chipText =
    edgeData && rateStr && zoom >= LABEL_MIN_ZOOM ? `${rateStr}${unit}` : "";
  const fullLabel =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${rateStr}${unit}`
      : "";

  const iconPos = edgeData ? iconPosition(edgeData.item) : undefined;

  // One chip at the drop point (where the flow enters the trunk) and one at the
  // rise point (where it leaves toward the target). Both sit on the lane.
  const renderChip = (suffix: string, x: number, y: number) => (
    <EdgeLabelRenderer>
      <div
        data-testid={`bus-edge-label-${id}-${suffix}`}
        className={"nodrag nopan flow-chip" + (edgeData?.isTearEdge ? " red" : "")}
        aria-label={fullLabel}
        title={fullLabel}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          whiteSpace: "nowrap",
          ...chipAccentStyle(edgeData?.item),
        }}
      >
        {iconPos !== undefined ? (
          <span className="ico ico-16">
            <span className="spr" style={{ backgroundPosition: iconPos }} />
          </span>
        ) : null}
        {chipText}
      </div>
    </EdgeLabelRenderer>
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={mergedStyle}
        {...(markerEnd ? { markerEnd } : {})}
      />
      <circle
        className="bus-junction"
        cx={junction.x}
        cy={junction.y}
        r={JUNCTION_RADIUS}
        fill={kindStyle.stroke}
      />
      {chipText ? (
        <>
          {renderChip("drop", dropX, laneY)}
          {renderChip("rise", riseX, laneY)}
        </>
      ) : null}
    </>
  );
}
