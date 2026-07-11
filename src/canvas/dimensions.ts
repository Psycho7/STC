// Fixed dimensions for the canvas render pipeline. This is the single source of
// truth for both the React node components and the ELK layout call: layout and
// rendering both read these constants directly so they stay locked together,
// with no CSS-in-JS or build step in between.

// Recipe-node geometry. .recipe-node is 300px wide. These constants are the
// contract the rendered DOM is pinned to, not approximations of an auto-sized
// layout: .rn-head carries an explicit height:80px (box-sizing:border-box), each
// .rn-row is a fixed 22px, and .rn-footer a fixed 26px, so the offline model
// here matches the browser exactly at every zoom band (the low-zoom LOD hides
// header children but the pinned height holds). RECIPE_ROWS_TOP_PAD is the
// .rn-side vertical padding: rows sit that far below the header, and the same
// padding repeats at the bottom of the side column.
export const RECIPE_WIDTH = 300;
export const RECIPE_HEADER_HEIGHT = 80;
export const RECIPE_ROW_HEIGHT = 22;
export const RECIPE_FOOTER_HEIGHT = 26;
export const RECIPE_ROWS_TOP_PAD = 6;

export function recipeHeight(inPorts: number, outPorts: number): number {
  return (
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD * 2 +
    Math.max(inPorts, outPorts) * RECIPE_ROW_HEIGHT +
    RECIPE_FOOTER_HEIGHT
  );
}

export const PORT_WIDTH = 8;
export const PORT_HEIGHT = 8;

// Shared chip metrics for the two edge-label chip families (entry-port stack and
// midpoint rate chips). CHIP_BOX_HEIGHT is the on-screen box height of the
// TALLEST chip variant at natural scale, the midpoint rate chip: a 16px item
// sprite plus 3px of padding and a 1px border on each side (see the .flow-chip
// rule in canvas.css). The compact entry variant (2px padding, 22px box) is
// covered with margin. MAX_CHIP_SCALE is the counter-scale cap the chips reach
// at the fit-zoom floor (they scale by 1/zoom about their centre, clamped
// here), so the tallest a chip ever renders is MAX_CHIP_SCALE * CHIP_BOX_HEIGHT.
// Both busRouting (stack pitch, midpoint collision box and nudge step) and
// ItemEdge (chip counter-scale) read these so the on-screen no-overlap
// guarantee stays coupled to one source of truth.
export const CHIP_BOX_HEIGHT = 24;
export const MAX_CHIP_SCALE = 2;

export const NODE_NODE_SPACING = 30;
// A generous column gap so each ItemEdge label chip (item icon + name + rate)
// has room to breathe and doesn't overlap the source or target node. The earlier
// 40px gap left labels jammed against the neighboring nodes and hard to read.
export const BETWEEN_LAYERS_SPACING = 110;

// Padding around an SCC interior so there is room for the box border and the
// net-IO port labels.
export const LOOP_BOX_PADDING = 24;

export function loopBoxDimensions(interiorLayout: {
  width: number;
  height: number;
}): { width: number; height: number } {
  return {
    width: interiorLayout.width + LOOP_BOX_PADDING * 2,
    height: interiorLayout.height + LOOP_BOX_PADDING * 2,
  };
}
