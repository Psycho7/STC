import { BaseEdge, EdgeLabelRenderer, useStore, type EdgeProps } from "@xyflow/react";
import { LABEL_MIN_ZOOM, strokeForKind, type ItemEdgeData } from "./ItemEdge";
import type { BusEdgeData } from "./busRouting";
import { useI18n } from "../data/i18n-context";
import { formatRatePerMin } from "../data/rate-format";
import { iconPosition } from "./iconSprite";

// Radius of the junction dot each bus edge draws at its own branch point, where
// it leaves the shared trunk lane to rise into its target.
const JUNCTION_RADIUS = 3;

// BusEdge renders a bus-trunk member as an orthogonal drop -> trunk run -> rise:
//   M sourceX,sourceY  V laneY  H targetX  V targetY
// Every edge of one trunk shares the same laneY, so their horizontal runs
// overlap exactly and the trunk visually draws once without any cross-edge
// coordination. Each edge also draws its own junction dot at (targetX, laneY),
// its branch point off the shared lane. Stroke reuses ItemEdge's strokeForKind
// (Task 8 recolors both); the markerEnd arrow stays at the target. The rate chip
// (icon + rate/min) draws twice, at the drop point (sourceX, laneY) and the rise
// point (targetX, laneY), reusing ItemEdge's flow-chip markup and zoom gate so a
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
  // a plain orthogonal drop-and-rise rather than throwing.
  const laneY = edgeData?.laneY ?? targetY;
  const path = `M ${sourceX},${sourceY} V ${laneY} H ${targetX} V ${targetY}`;

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
        cx={targetX}
        cy={laneY}
        r={JUNCTION_RADIUS}
        fill={kindStyle.stroke}
      />
      {chipText ? (
        <>
          {renderChip("drop", sourceX, laneY)}
          {renderChip("rise", targetX, laneY)}
        </>
      ) : null}
    </>
  );
}
