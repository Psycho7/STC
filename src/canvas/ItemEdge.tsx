import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type Fraction from "fraction.js";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { useI18n } from "../data/i18n-context";
import { formatRatePerMin } from "../data/rate-format";
import { iconPosition } from "./iconSprite";

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
};

// Stroke style per transport kind. Belt is the default solid stroke; pipe is a
// dashed cyan stroke that reuses the input-product accent color. Unknown kinds
// fall through to the belt default on purpose. The real guard against bad data
// happens at load time; this render-time fallback just keeps the UI alive.
const BELT_STROKE = "#666";
const PIPE_STROKE = "#0891b2";
const PIPE_DASH = "4 2";

type StrokeStyle = { stroke: string; strokeDasharray?: string };

function strokeForKind(kind: TransportKindId | undefined): StrokeStyle {
  if (kind === "pipe") {
    return { stroke: PIPE_STROKE, strokeDasharray: PIPE_DASH };
  }
  return { stroke: BELT_STROKE };
}

export default function ItemEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const edgeData = data as ItemEdgeData | undefined;
  const i18n = useI18n();
  const rateStr = edgeData ? formatRatePerMin(edgeData.rate) : "";
  const unit = i18n.t("canvas.rate.unit");
  // The chip body shows the icon plus rate and unit, nothing more. The full
  // "Name x rate/min" string goes onto aria-label and title so screen readers
  // and the browser's hover tooltip still name the item.
  const chipText = edgeData && rateStr ? `${rateStr}${unit}` : "";
  const fullLabel =
    edgeData && rateStr
      ? `${i18n.displayName(edgeData.item)} x ${rateStr}${unit}`
      : "";

  const [edgePath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Center the label in the corridor between layers, at the smooth-step
  // midpoint. An earlier version nudged the chip toward the source or target
  // based on labelSide, which left chips touching the neighboring node and hard
  // to read. Once the corridor is wide enough, the midpoint sits cleanly in the
  // gap. labelSide still rides along on the edge data for routing logic later,
  // but it no longer moves the label's x/y here. Pinning labelY keeps the chip
  // on the source's horizontal line so a vertically routed smooth-step does not
  // drop the label into the bend.
  const useTargetY = edgeData?.labelSide === "target";
  const useSourceY = edgeData?.labelSide === "source";
  const labelX = fallbackLabelX;
  const labelY = useTargetY ? targetY : useSourceY ? sourceY : fallbackLabelY;

  const kindStyle = strokeForKind(edgeData?.transportKind);
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
        <EdgeLabelRenderer>
          <div
            data-testid={`item-edge-label-${id}`}
            className={
              "nodrag nopan flow-chip" + (edgeData?.isTearEdge ? " red" : "")
            }
            aria-label={fullLabel}
            title={fullLabel}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              whiteSpace: "nowrap",
            }}
          >
            {edgeData
              ? (() => {
                  const pos = iconPosition(edgeData.item);
                  return pos !== undefined ? (
                    <span className="ico ico-16">
                      <span
                        className="spr"
                        style={{ backgroundPosition: pos }}
                      />
                    </span>
                  ) : null;
                })()
              : null}
            {chipText}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
