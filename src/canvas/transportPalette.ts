// Per-transport-kind accent colors, shared by the edge strokes (ItemEdge) and
// the port glyphs (PortGlyph) so a phase reads the same on the line and at the
// port it enters. Belt is the neutral gray of the default stroke; pipe is the
// cyan of the input-product accent; gas is a lighter cyan, so the two fluid
// carriers read as related media of different density. Both consumers use these
// only as the no-item FALLBACK: with an item id the color comes from itemColor.
export const BELT_COLOR = "#666";
export const PIPE_COLOR = "#0891b2";
export const GAS_COLOR = "#22d3ee";
