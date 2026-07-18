import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { useMemo } from "react";
import {
  FlowChip,
  LABEL_MIN_ZOOM,
  edgeStrokeWidth,
  strokeForKind,
  type ItemEdgeData,
} from "./ItemEdge";
import { BUS_LONG_RUN_THRESHOLD, type BusEdgeData } from "./busRouting";
import {
  chamferBusPath,
  chamferFanoutPath,
  routingHintsFromData,
} from "./edgePath";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin, formatRatePerMin } from "../data/rate-format";

// Radius of the junction dot each bus edge draws at its own branch point, where
// it leaves the shared trunk lane to rise into its target, in graph units.
const JUNCTION_RADIUS = 3;

// Junction-dot screen-radius bounds, in physical px. The dot is drawn in graph
// units, so the pane zoom scales it (on-screen radius = r * zoom): at the
// dense-plan fit zoom a 3-unit dot is a sub-pixel speck. Counter-scale it like
// ItemEdge's stroke clamp so the dot holds a legible on-screen radius clamped to
// this range across zoom.
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
  // Narrow the union on the `fanout` discriminant so each arm reads only its own
  // fields: the fan-out member carries junction / fanout* offsets and no laneY;
  // the lane member carries laneY / busChipX / busDropDy / busChipDy.
  const fanoutData = edgeData?.fanout === true ? edgeData : undefined;
  const laneData =
    edgeData !== undefined && edgeData.fanout !== true ? edgeData : undefined;
  // Fall back to targetY if laneY is somehow missing, which collapses the run to
  // a sane orthogonal drop-and-rise (the rise vertical vanishes) rather than
  // throwing.
  const laneY = laneData?.laneY ?? targetY;
  const isFanout = fanoutData !== undefined;
  // Fan-out members draw the short in-corridor trunk (source port -> shared
  // junction column -> branch to the target); lane members drop into the shared
  // band and rise at their column. Both expose one aggregate chip anchor (the
  // trunk / drop) and one per-member chip anchor (the branch / rise), so the chip
  // markup below is shared.
  // Memoized on the endpoints and edge data: the geometry does not depend on
  // zoom, and the zoom subscription above re-renders every edge each zoom tick.
  const { fan, bus } = useMemo(
    () =>
      isFanout
        ? {
            fan: chamferFanoutPath({
              sourceX,
              sourceY,
              targetX,
              targetY,
              ...routingHintsFromData(edgeData),
            }),
            bus: null,
          }
        : {
            fan: null,
            bus: chamferBusPath({
              sourceX,
              sourceY,
              targetX,
              targetY,
              laneY,
              ...routingHintsFromData(edgeData),
            }),
          },
    [isFanout, sourceX, sourceY, targetX, targetY, laneY, edgeData],
  );
  const path = fan?.path ?? bus!.path;
  const junction = fan?.junction ?? bus!.junction;
  // Aggregate chip anchor: the fan-out trunk-segment midpoint, or the lane drop
  // column. Per-member chip anchor: the fan-out branch-leg midpoint, or the lane
  // rise slot. Each carries its own de-confliction offset (fanout* on the fan-out
  // arm, busDropDy / busChipDy on the lane arm).
  const aggX = fan
    ? fan.trunkAnchor.x + (fanoutData?.fanoutAggDx ?? 0)
    : bus!.dropX;
  const aggY = fan
    ? fan.trunkAnchor.y + (fanoutData?.fanoutAggDy ?? 0)
    : laneY + (laneData?.busDropDy ?? 0);

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
  // The owner's aggregate (drop / trunk) chip is EXEMPT from the label zoom gate:
  // it always renders (counter-scaled) so a trunk's summed total survives at the
  // dense-plan fit zoom, where per-member chips would be illegible clutter. The
  // per-member (rise / branch) chip keeps the gate, so it appears only once the
  // reader has zoomed into that trunk.
  const showAggChip = edgeData !== undefined;

  // Drop chip: only the elected trunk owner draws it, and it shows the summed
  // trunk rate (busTotalRate), prefixed by a sum glyph when the trunk has
  // several members. The glyph says "this is an aggregate", where the old
  // " xN" count marker read as multiplication and collided with the machine
  // count badge's x-notation. A lone member is its own owner, so it reads
  // exactly like a plain item edge. Non-owner members suppress the drop chip,
  // which is what collapses the old N-deep stack of one-member-share chips
  // into a single truthful total on the shared lane.
  const isOwner = edgeData?.busChipOwner ?? true;
  const totalRate = edgeData?.busTotalRate ?? edgeData?.rate;
  const memberCount = edgeData?.busMemberCount ?? 1;
  // Per-member (rise / branch) chip gate: zoom-gated by default, but a lone
  // member on a long lane detour exempts it so the far consumer end stays
  // labeled at fit zoom (#32). Requiring busChipX to be ABSENT keys the
  // exemption to routeBusEdges' own long-run decision (it skips the lane slot
  // for exactly these members, so the chip anchor below falls to the rise
  // column at the consumer end): the gate never exempts a chip that would
  // render mid-lane. Long-span members always clear the threshold; its real
  // work is keeping short feeders and hairpins (run 0) gated. Fan-out members
  // carry no lane run (bus === null).
  const busRunLength = bus ? Math.abs(bus.riseX - bus.dropX) : 0;
  const longSingleRun =
    memberCount === 1 &&
    laneData?.busChipX === undefined &&
    busRunLength > BUS_LONG_RUN_THRESHOLD;
  const showMemberChip =
    edgeData !== undefined && (zoom >= LABEL_MIN_ZOOM || longSingleRun);
  const dropRateStr = totalRate ? formatRatePerMin(totalRate) : "";
  const sumMarker = memberCount > 1 ? "Σ" : "";
  const dropText =
    showAggChip && dropRateStr ? `${sumMarker}${dropRateStr}${unit}` : "";
  const dropLabel =
    edgeData && dropRateStr
      ? `${i18n.displayName(edgeData.item)} x ${sumMarker}${dropRateStr}${unit}`
      : "";
  const dropTitle =
    edgeData && dropRateStr && totalRate
      ? `${i18n.displayName(edgeData.item)} x ${sumMarker}${formatRateExactPerMin(totalRate)}${unit}`
      : "";

  // Rise chip: each member draws its own, showing that member's share. Its x is
  // the trunk's evenly distributed lane slot (busChipX) so members feeding the
  // same layer spread along the lane instead of stacking at a shared rise vertex;
  // it falls back to the geometric rise column when the slot is absent (a
  // manually built edge). The chip sits on the lane at laneY. A fan-out member
  // flagged fanoutBranchHidden draws no branch chip at all: the seating pass
  // found no chip/card-clear point on its own polyline, and an off-line chip
  // would float in empty canvas (the share stays on the target card's row and
  // this edge's hover tooltip below). The hide only holds while the live
  // branch anchor still matches the one it was stamped at: nodes stay
  // mouse-draggable and the seating pass does not rerun on drag, so once the
  // anchors diverge the hide is stale and the chip returns. The stamp comes
  // from the seating pass's port reconstruction, which disagrees with React
  // Flow's measured handles by up to ~1 unit, so the divergence threshold sits
  // well above that noise and well below any drag that frees seating room
  // (half a max-scale chip box height).
  const HIDE_STALE_EPS = 24;
  const hiddenAt = fanoutData?.fanoutBranchHiddenAt;
  const branchHidden =
    fanoutData?.fanoutBranchHidden === true &&
    (hiddenAt === undefined ||
      (fan !== null &&
        Math.abs(fan.branchAnchor.x - hiddenAt.x) < HIDE_STALE_EPS &&
        Math.abs(fan.branchAnchor.y - hiddenAt.y) < HIDE_STALE_EPS));
  const memberRateStr = edgeData ? formatRatePerMin(edgeData.rate) : "";
  const riseText =
    showMemberChip && memberRateStr && !branchHidden
      ? `${memberRateStr}${unit}`
      : "";
  const riseLabel =
    edgeData && memberRateStr
      ? `${i18n.displayName(edgeData.item)} x ${memberRateStr}${unit}`
      : "";
  const riseTitle =
    edgeData && memberRateStr
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(edgeData.rate)}${unit}`
      : "";
  // Per-member chip anchor: fan-out branch-leg midpoint (plus its offset), or the
  // lane rise slot (busChipX, the trunk's evenly distributed lane x, falling back
  // to the geometric rise column on a manually built edge or a lone long-run
  // member, whose slot routeBusEdges deliberately omits so this chip sits at the
  // consumer end) at laneY plus its lane nudge.
  const branchX = fan
    ? fan.branchAnchor.x + (fanoutData?.fanoutBranchDx ?? 0)
    : (laneData?.busChipX ?? bus!.riseX);
  const branchY = fan
    ? fan.branchAnchor.y + (fanoutData?.fanoutBranchDy ?? 0)
    : laneY + (laneData?.busChipDy ?? 0);

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
      {/* A hidden branch chip was this member's only exact-rate tooltip
          carrier, so keep the share reachable on the edge itself: a transparent
          hover path over the same geometry carries the native SVG tooltip. */}
      {branchHidden && riseTitle ? (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          pointerEvents="stroke"
        >
          <title>{riseTitle}</title>
        </path>
      ) : null}
      {/* Junction dot in the HTML label layer (not an SVG circle in the edge
          group) so it shares the chips' stacking context. It sits BELOW the flow
          chips (.bus-junction z-index: 1 vs .flow-chip z-index: 2 in canvas.css):
          the aggregate chip's digits win, and an overlapping chip hides the dot
          behind it. Sized in graph units via junctionRadius so the pane zoom
          renders it at a screen radius clamped to [JUNCTION_MIN_PX,
          JUNCTION_MAX_PX]. Threads the same `dimmed` state the chips do (the
          label layer portals outside the edge wrapper, so the wrapper's dim never
          reaches it). */}
      <EdgeLabelRenderer>
        <div
          data-testid={`bus-junction-${id}`}
          aria-hidden="true"
          className={"bus-junction" + (edgeData?.dimmed ? " dimmed" : "")}
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${junction.x}px, ${junction.y}px)`,
            width: `${2 * junctionRadius(zoom)}px`,
            height: `${2 * junctionRadius(zoom)}px`,
            background: kindStyle.stroke,
          }}
        />
      </EdgeLabelRenderer>
      {isOwner && dropText
        ? renderChip("drop", aggX, aggY, dropText, dropLabel, dropTitle)
        : null}
      {riseText
        ? renderChip("rise", branchX, branchY, riseText, riseLabel, riseTitle)
        : null}
    </>
  );
}
