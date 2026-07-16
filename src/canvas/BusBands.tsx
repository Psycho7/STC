import { ViewportPortal, type Edge, type Node } from "@xyflow/react";
import { useMemo } from "react";
import { busBandRegions } from "./busRouting";
import type { RFAnyNode } from "./layout";

// BusBands: the faint bus-lane band marking, rendered BENEATH the edges via
// ViewportPortal so it shares the node/edge coordinate system (it pans and zooms
// with them). ViewportPortal injects into the LAST child of the viewport, which
// paints above the edges by default, so each band carries zIndex: -1 to drop it
// below the edges SVG (z-index auto = 0) and the nodes while staying above the
// pane background. NON-DOMINANT is a hard constraint: the tint and hairlines and
// tag are all faint (see canvas.css .bus-band).
export default function BusBands({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}) {
  const regions = useMemo(
    () => busBandRegions(nodes as unknown as RFAnyNode[], edges),
    [nodes, edges],
  );
  if (regions.length === 0) return null;
  return (
    <ViewportPortal>
      {regions.map((region) => (
        <div
          key={region.band}
          className="bus-band"
          data-testid={`bus-band-${region.band}`}
          aria-hidden="true"
          style={{
            position: "absolute",
            left: region.x,
            top: region.y,
            width: region.width,
            height: region.height,
            zIndex: -1,
          }}
        >
          <span className="bus-band-tag">BUS</span>
        </div>
      ))}
    </ViewportPortal>
  );
}
