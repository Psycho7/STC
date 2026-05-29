// Fixed dimensions for the canvas render pipeline. This is the single source of
// truth for both the React node components and the ELK layout call: layout and
// rendering both read these constants directly so they stay locked together,
// with no CSS-in-JS or build step in between.

// Recipe-node geometry. .recipe-node is 268px wide. The header has no explicit
// height, but its recipe-block stack (product 17px + machine-name 11px +
// machine-mid 8.5px + roughly 10px of top/bottom padding) comes to about 80px.
// A row is 5+5 padding plus a 12px text line, so 22px. The footer is 6+6 padding
// plus a 9px line at about 1.4 line-height, so roughly 26px. Header and footer
// fall back to these reasonable defaults wherever flex auto-sizing would
// otherwise decide the height.
export const RECIPE_WIDTH = 268;
export const RECIPE_HEADER_HEIGHT = 80;
export const RECIPE_ROW_HEIGHT = 22;
export const RECIPE_FOOTER_HEIGHT = 26;

export function recipeHeight(inPorts: number, outPorts: number): number {
  return (
    RECIPE_HEADER_HEIGHT +
    Math.max(inPorts, outPorts) * RECIPE_ROW_HEIGHT +
    RECIPE_FOOTER_HEIGHT
  );
}

export const PORT_WIDTH = 8;
export const PORT_HEIGHT = 8;

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
