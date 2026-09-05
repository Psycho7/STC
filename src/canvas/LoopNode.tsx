import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import { loopBoxDimensions, LOOP_BOX_PADDING } from "./dimensions";
import { useI18n } from "../data/i18n-context";
import { formatRatePerMin } from "../data/rate-format";
import { PortGlyph } from "./PortGlyph";
import { itemColor } from "./itemColor";
import type { PortTransportKinds } from "./layout";
import type { ItemId } from "../pipeline/types";
import { orderByItem } from "./orderByItem";

export type LoopNodeNetIO = {
  item: string;
  direction: "in" | "out";
  rate: Fraction;
};

export type LoopNodeData = {
  sccId: string;
  netIO: ReadonlyArray<LoopNodeNetIO>;
  interior: { width: number; height: number };
  // Simplified tear arc; coordinates are in the inner SVG (interior) space.
  tearArc?: { fromY: number; toY: number };
  // Per-port transport kind, keyed by Handle id ("in:<item>" / "out:<item>").
  portTransportKinds?: PortTransportKinds;
  // ELK-resolved west port order (item ids, top to bottom) attached by the
  // layout pass. In-port rows, Handles and glyphs render in this order so each
  // entering edge's y-slot matches its arrival order. Absent on older fixtures /
  // tests, where we fall back to netIO declaration order. There is no output
  // counterpart (ruling R4): out-port rows read in netIO declaration order.
  inputOrder?: ItemId[];
};

export type LoopNodeType = Node<LoopNodeData, "loop">;

export default function LoopNode({ data }: NodeProps<LoopNodeType>) {
  const { sccId, netIO, interior, tearArc, portTransportKinds, inputOrder } =
    data;
  const i18n = useI18n();
  const { width, height } = loopBoxDimensions(interior);
  // In-ports in ELK-resolved arrival order (falls back to declaration order);
  // out-ports in netIO declaration order (ruling R4). Row i, Handle i and
  // glyph i then describe the same item.
  const ins = orderByItem(
    netIO.filter((p) => p.direction === "in"),
    inputOrder,
  );
  const outs = netIO.filter((p) => p.direction === "out");

  // Tear-arc path: one quadratic curve drawn just inside the right edge of the
  // interior, joining two y-coordinates. The exact geometry is rough for now;
  // all that matters is that a single return arc is visible.
  const arc = tearArc
    ? buildTearArcPath(tearArc.fromY, tearArc.toY, interior.width)
    : null;

  // The header "label" slot wants a primary recipe or item name. The node prop
  // only carries an interior size, not the list of interior recipes, so for now
  // we fall back to the SCC id. Revisit once interior recipe ids reach the prop.
  const headerLabel = sccId;
  const rateUnit = i18n.t("canvas.rate.unit");

  return (
    <div
      data-testid="loop-node"
      data-scc-id={sccId}
      className="scc-box"
      style={{
        position: "relative",
        width,
        height,
        boxSizing: "border-box",
      }}
    >
      {/* canvas.css reads --stripe-warning for the header band but no
          stylesheet defines it, so the band paints as nothing. Supply it here
          from an existing accent, the same way the net-IO rows supply
          --row-accent. */}
      <div
        className="header"
        style={{ ["--stripe-warning" as string]: "var(--ak-accent-amber)" }}
      >
        <span className="seq">{sccId}</span>
        <span className="label">{headerLabel}</span>
        {/* The `.tag` slot is left out: LoopNodeData has no interior recipe
            list yet, so there is no honest "{N} RECIPES" count to show. Wire it
            up once interior recipe ids reach the node prop. */}
      </div>

      <div className="body">
        {/* LoopNodeData exposes only an aggregate interior size, not the
            interior recipes themselves. ELK places the real recipe nodes inside
            this box through the compound-graph parent/child link, so the body is
            empty here on purpose. */}
        <svg
          width={interior.width}
          height={interior.height}
          style={{
            position: "absolute",
            top: LOOP_BOX_PADDING,
            left: LOOP_BOX_PADDING,
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {arc ? (
            <path
              data-testid="tear-arc"
              d={arc}
              fill="none"
              stroke="var(--ak-accent-red, #a64ca6)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          ) : null}
        </svg>
      </div>

      <div className="net-ports">
        {ins.map((p) => (
          // --row-accent tints the port box's emphasized left border to the
          // item color (canvas.css reads it in .net-port.in) so the net-IO row
          // pairs by hue with its entering edge and port glyph.
          <div
            className="net-port in"
            key={`np-in:${p.item}`}
            style={{ ["--row-accent" as string]: itemColor(p.item) }}
          >
            <span className="lbl">{i18n.displayName(p.item)}</span>
            <span className="rate">
              {formatRatePerMin(p.rate)}
              {rateUnit}
            </span>
          </div>
        ))}
        {outs.map((p) => (
          // --row-accent tints the port box's emphasized right border to the
          // item color (canvas.css reads it in .net-port.out) so the net-IO row
          // pairs by hue with its leaving edge and port glyph.
          <div
            className="net-port out"
            key={`np-out:${p.item}`}
            style={{ ["--row-accent" as string]: itemColor(p.item) }}
          >
            <span className="lbl">{i18n.displayName(p.item)}</span>
            <span className="rate">
              {formatRatePerMin(p.rate)}
              {rateUnit}
            </span>
          </div>
        ))}
      </div>

      {/* Tear-return chip. We have the tearArc geometry but no torn-edge rate
          on the node prop, so the second row is dropped; the chip still flags
          that a tear edge exists. */}
      {tearArc ? (
        <div className="scc-return">
          <div className="tear-chip">
            <div className="row1">TEAR</div>
          </div>
        </div>
      ) : null}

      {/* React Flow handles plus transport-kind glyphs. The handle ids must
          stay stable ("in:<item>" and "out:<item>") so edge endpoints can find
          them. */}
      {ins.map((p, i) => (
        <Handle
          key={`in:${p.item}`}
          id={`in:${p.item}`}
          type="target"
          position={Position.Left}
          style={{ top: LOOP_BOX_PADDING + 8 + i * 18 }}
        />
      ))}
      {ins.map((p, i) => (
        <PortGlyph
          key={`in-glyph:${p.item}`}
          kind={portTransportKinds?.get(`in:${p.item}`)}
          side="left"
          top={LOOP_BOX_PADDING + 8 + i * 18}
          item={p.item}
        />
      ))}

      {outs.map((p, i) => (
        <Handle
          key={`out:${p.item}`}
          id={`out:${p.item}`}
          type="source"
          position={Position.Right}
          style={{ top: LOOP_BOX_PADDING + 8 + i * 18 }}
        />
      ))}
      {outs.map((p, i) => (
        <PortGlyph
          key={`out-glyph:${p.item}`}
          kind={portTransportKinds?.get(`out:${p.item}`)}
          side="right"
          top={LOOP_BOX_PADDING + 8 + i * 18}
          item={p.item}
        />
      ))}
    </div>
  );
}

function buildTearArcPath(
  fromY: number,
  toY: number,
  interiorWidth: number,
): string {
  // Anchor near the right edge of the interior and bulge a little further right
  // so the return arc reads as separate from the recipe nodes inside.
  const x = Math.max(0, interiorWidth - 8);
  const controlX = interiorWidth + 12;
  const controlY = (fromY + toY) / 2;
  return `M ${x} ${fromY} Q ${controlX} ${controlY} ${x} ${toY}`;
}
