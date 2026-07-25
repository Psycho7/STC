import type { CSSProperties } from "react";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { itemColor } from "./itemColor";

// An overlay glyph drawn next to each React Flow Handle. Its shape depends on
// the port's transportKind:
//   belt -> filled square dot
//   pipe -> hollow circle
//   gas  -> hollow diamond (a square rotated 45 degrees)
//   anything else, including undefined -> nothing at all
//
// It is an absolutely-positioned <span> inside the node, so the host component
// sets the (top, left or right) offset relative to its handle. Pointer events
// are off so the glyph never steals clicks meant for the Handle underneath.

const GLYPH_SIZE = 8;
// A square rotated 45 degrees presents its diagonal, so a gas glyph drawn at
// GLYPH_SIZE would occupy sqrt(2) times the span of its siblings and crowd the
// handle it annotates. 6px presents a ~8.49px diagonal, matching the 8px circle.
const GAS_GLYPH_SIZE = 6;
// Belt color matches the default edge stroke; pipe reuses the cyan accent from
// the input-product flavor; gas takes the lighter cyan its edges fall back to.
const BELT_FILL = "#666";
const PIPE_STROKE = "#0891b2";
const GAS_STROKE = "#22d3ee";

export type PortGlyphSide = "left" | "right";

export function glyphKind(
  kind: TransportKindId | undefined,
): "belt" | "pipe" | "gas" | null {
  if (kind === "belt") return "belt";
  if (kind === "pipe") return "pipe";
  if (kind === "gas") return "gas";
  return null;
}

function baseStyle(
  side: PortGlyphSide,
  top: number | undefined,
  size: number = GLYPH_SIZE,
): CSSProperties {
  // With an explicit `top` the glyph sits at that absolute node-local y (minus
  // half its size to center on the handle); callers that omit `top` nest the
  // glyph inside a position:relative row and let it center on the DOM row
  // middle via top:50%, so the anchor tracks the real row instead of a computed
  // offset.
  const vertical: CSSProperties =
    top === undefined
      ? { top: "50%", transform: "translateY(-50%)" }
      : { top: top - size / 2 };
  return {
    position: "absolute",
    ...vertical,
    // The side offset stays on GLYPH_SIZE for every kind so a smaller box does
    // not drift toward the handle; the gas diamond's corners still clear it.
    [side === "left" ? "left" : "right"]: -GLYPH_SIZE - 2,
    width: size,
    height: size,
    pointerEvents: "none",
  };
}

// Compose the 45 degree rotation onto whatever transform baseStyle produced.
// The row-centered mode already carries translateY(-50%), and replacing it
// instead of appending drops the glyph half its height off the row.
function withRotation(base: CSSProperties): CSSProperties {
  const existing = base.transform;
  return {
    ...base,
    transform: existing ? `${existing} rotate(45deg)` : "rotate(45deg)",
  };
}

export function PortGlyph({
  kind,
  side,
  top,
  item,
}: {
  kind: TransportKindId | undefined;
  side: PortGlyphSide;
  // Absolute node-local y of the handle center. Omit it to nest the glyph in a
  // position:relative row and center it on the DOM row middle (top:50%).
  top?: number;
  // When present, the glyph tints to the item's stable color so the port pairs
  // by hue with its entering / leaving edge and the matching node row. The
  // shape still comes from the transport kind (belt square / pipe circle / gas
  // diamond); only the fill (belt) or border color (pipe, gas) changes. Absent
  // on older fixtures and tests, which keep the neutral gray / cyan defaults.
  item?: ItemId;
}) {
  const g = glyphKind(kind);
  if (g === null) return null;
  const accent = item !== undefined ? itemColor(item) : undefined;
  let style: CSSProperties;
  if (g === "belt") {
    style = {
      ...baseStyle(side, top),
      background: accent ?? BELT_FILL,
    };
  } else if (g === "gas") {
    style = {
      ...withRotation(baseStyle(side, top, GAS_GLYPH_SIZE)),
      background: "transparent",
      border: `1.5px solid ${accent ?? GAS_STROKE}`,
    };
  } else {
    style = {
      ...baseStyle(side, top),
      background: "transparent",
      border: `1.5px solid ${accent ?? PIPE_STROKE}`,
      borderRadius: "50%",
    };
  }
  return <span data-glyph={g} style={style} />;
}
