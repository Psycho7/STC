import type { CSSProperties } from "react";
import type { TransportKindId } from "../pipeline/types";

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

function baseStyle(side: PortGlyphSide, top: number): CSSProperties {
  return {
    position: "absolute",
    top: top - GLYPH_SIZE / 2,
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
}: {
  kind: TransportKindId | undefined;
  side: PortGlyphSide;
  top: number;
}) {
  const g = glyphKind(kind);
  if (g === null) return null;
  const style: CSSProperties =
    g === "belt"
      ? {
          ...baseStyle(side, top),
          background: BELT_FILL,
        }
      : {
          ...baseStyle(side, top),
          background: "transparent",
          border: `1.5px solid ${PIPE_STROKE}`,
          borderRadius: "50%",
        };
  return <span data-glyph={g} style={style} />;
}
