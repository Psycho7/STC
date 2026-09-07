import type { CSSProperties } from "react";
import type { ItemId } from "../pipeline/types";
import { itemColor } from "./itemColor";
import { GLYPH_SIDE_OFFSET } from "./dimensions";

// The mark a catalyst row wears in the slot a port row gives its PortGlyph. A
// catalyst is drawn from the plan boundary and handed straight back every
// cycle, so the row it annotates has no Handle and no edge; this glyph is the
// only thing standing where a reader's eye expects a port, and its job is to
// say "accounted for, nothing arrives here" rather than to name a transport.
//
// Shape: a filled disc, deliberately none of the three transport shapes
// PortGlyph draws (belt filled square, pipe hollow circle, gas hollow diamond),
// so a catalyst row cannot be misread as a port whose edge failed to route. It
// tints to the item color like the port glyphs do, since the same item can
// carry real edges elsewhere on the plan and should read as one item.
//
// Sized under GLYPH_SIZE, at the gas diamond's 6px: the disc has no corners to
// fill its box, so at a full 8 it reads heavier than the belt square it sits a
// row below. The side offset stays on GLYPH_SIDE_OFFSET so the mark lines up
// in x with the port glyphs above it instead of drifting toward the card.
const CATALYST_GLYPH_SIZE = 6;

export function CatalystGlyph({ item }: { item: ItemId }) {
  // Nested in a position:relative row and centered on the DOM row middle, the
  // same anchor rule the row-nested PortGlyph uses.
  const style: CSSProperties = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    left: -GLYPH_SIDE_OFFSET,
    width: CATALYST_GLYPH_SIZE,
    height: CATALYST_GLYPH_SIZE,
    borderRadius: "50%",
    background: itemColor(item),
    pointerEvents: "none",
  };
  return <span data-glyph="catalyst" style={style} />;
}
