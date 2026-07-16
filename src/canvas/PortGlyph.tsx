import type { CSSProperties } from "react";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { itemColor } from "./itemColor";

// An 8px overlay glyph drawn next to each React Flow Handle. Its shape depends
// on the port's transportKind:
//   belt -> filled square dot
//   pipe -> hollow circle
//   anything else, including undefined -> nothing at all
//
// It is an absolutely-positioned <span> inside the node, so the host component
// sets the (top, left or right) offset relative to its handle. Pointer events
// are off so the glyph never steals clicks meant for the Handle underneath.

const GLYPH_SIZE = 8;
// Belt color matches the default edge stroke; pipe reuses the cyan accent from
// the input-product flavor. Nothing new is introduced.
const BELT_FILL = "#666";
const PIPE_STROKE = "#0891b2";

export type PortGlyphSide = "left" | "right";

export function glyphKind(
  kind: TransportKindId | undefined,
): "belt" | "pipe" | null {
  if (kind === "belt") return "belt";
  if (kind === "pipe") return "pipe";
  return null;
}

function baseStyle(
  side: PortGlyphSide,
  top: number | undefined,
): CSSProperties {
  // With an explicit `top` the glyph sits at that absolute node-local y (minus
  // half its size to center on the handle); callers that omit `top` nest the
  // glyph inside a position:relative row and let it center on the DOM row
  // middle via top:50%, so the anchor tracks the real row instead of a computed
  // offset.
  const vertical: CSSProperties =
    top === undefined
      ? { top: "50%", transform: "translateY(-50%)" }
      : { top: top - GLYPH_SIZE / 2 };
  return {
    position: "absolute",
    ...vertical,
    [side === "left" ? "left" : "right"]: -GLYPH_SIZE - 2,
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    pointerEvents: "none",
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
  // shape still comes from the transport kind (belt square / pipe circle); only
  // the fill (belt) or border color (pipe) changes. Absent on older fixtures and
  // tests, which keep the neutral gray / cyan defaults.
  item?: ItemId;
}) {
  const g = glyphKind(kind);
  if (g === null) return null;
  const accent = item !== undefined ? itemColor(item) : undefined;
  const style: CSSProperties =
    g === "belt"
      ? {
          ...baseStyle(side, top),
          background: accent ?? BELT_FILL,
        }
      : {
          ...baseStyle(side, top),
          background: "transparent",
          border: `1.5px solid ${accent ?? PIPE_STROKE}`,
          borderRadius: "50%",
        };
  return <span data-glyph={g} style={style} />;
}
