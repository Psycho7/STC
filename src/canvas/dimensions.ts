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

// Card-header grid columns, pinned (ruling R3) so the title and products
// budgets are deterministic instead of depending on what the auto columns
// happen to hold. The icon column is the machine block's full box (28px
// icon + 8px 6px padding + 1px right border); the rate column holds the
// widest rate figure and localized unit label across the locales (the ru
// "шт/мин" mono label at 0.1em tracking, inside the block's 8px-per-side
// padding). The title column takes the remainder -- at least as wide as the
// old auto layout ever gave the default plan in en, so no chip-bearing
// title that fit before pins clips now. RECIPE_HEAD_BLOCK_PAD_X is the
// .rn-recipe-block horizontal padding subtracted from the title column to
// get the name budget (RecipeNode). canvas.css hardcodes the same numbers;
// keep them in step.
export const RECIPE_HEAD_ICON_COL = 41;
export const RECIPE_HEAD_RATE_COL = 58;
export const RECIPE_HEAD_TITLE_COL =
  RECIPE_WIDTH - RECIPE_HEAD_ICON_COL - RECIPE_HEAD_RATE_COL;
export const RECIPE_HEAD_BLOCK_PAD_X = 8;

// Card height from the two side columns' row counts. The left count is ROWS,
// not ports: a catalyst row is drawn without a handle and still takes a row's
// worth of height. The right side has only port rows, so its count is both.
export function recipeHeight(inRows: number, outPorts: number): number {
  return (
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD * 2 +
    Math.max(inRows, outPorts) * RECIPE_ROW_HEIGHT +
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

// The PortGlyph box beside each handle, and how far its outer edge hangs
// outside the row edge. The seating pass keeps chips clear of that reach.
export const GLYPH_SIZE = 8;
export const GLYPH_SIDE_OFFSET = GLYPH_SIZE + 2;

// How far a stamped hide anchor may drift from the live one before the hide is
// treated as stale and the chip comes back. The seating pass stamps the anchor
// a hide was decided at, and nodes stay mouse-draggable with a re-seat only at
// the drop, so a drag in flight moves the geometry out from under a decision
// nothing recomputes yet: past
// this threshold a floating marker or a wrongly hidden chip is worse than an
// unmarked merge, and the renderers drop the hide. The threshold sits well
// above the ~1-unit port-model disagreement between the seating pass's
// reconstruction and React Flow's measured handles, and well below any drag
// that frees real seating room -- half the height of a chip box at its
// counter-scale cap. Note the coupling: changing either chip-box constant moves
// this threshold with it.
export const HIDE_STALE_EPS = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;

// The two shapes of the staleness question, stated here beside the threshold
// that sizes them so no caller restates the rule. Both answer the same thing:
// does the anchor a decision was stamped at still describe the live geometry?
// An ABSENT stamp answers yes -- nothing contradicts the seating decision, so
// the decision stands -- and this is the only place that default is stated.
// faninHideLive is the 1-D form for a decision anchored to a port row (the
// fan-in hide and both junction-dot families compare a stamped y against the
// live port y). anchorStampLive is the 2-D form for a decision anchored to a
// point, and it is per-axis rather than Euclidean because what the stamp
// records is "this chip box was clear here": a box is a rectangle, so
// rectangular drift is what invalidates it.
export function faninHideLive(
  stampY: number | undefined,
  liveY: number,
): boolean {
  return stampY === undefined || Math.abs(stampY - liveY) < HIDE_STALE_EPS;
}

export function anchorStampLive(
  stamp: { x: number; y: number } | undefined,
  liveAnchor: { x: number; y: number },
): boolean {
  return (
    stamp === undefined ||
    (Math.abs(stamp.x - liveAnchor.x) < HIDE_STALE_EPS &&
      Math.abs(stamp.y - liveAnchor.y) < HIDE_STALE_EPS)
  );
}

// Horizontal chip-box metrics, the x-axis analogs of CHIP_BOX_HEIGHT. A chip's
// on-screen width is roughly constant at low zoom (it counter-scales by 1/zoom,
// capped at MAX_CHIP_SCALE), so in graph units its box is at most
// MAX_CHIP_SCALE * CHIP_BOX_WIDTH wide. CHIP_BOX_WIDTH bounds the natural box of
// a WIDE chip: the rendered body is the 16px item sprite plus the rounded rate
// text and optional count marker (e.g. an icon followed by "222.22/min x2"; the
// item name rides only on aria-label/title, never in the box). The widest corpus
// chip measured ~115px; 120 adds headroom, and the .flow-chip max-width clamp in
// canvas.css enforces the bound at runtime by ellipsizing any off-corpus rate
// string that would exceed it. busRouting's chip de-confliction reads it so its
// horizontal collision floor tracks the true rendered width instead of a stale
// guess.
export const CHIP_BOX_WIDTH = 120;

// Half-extent of the keep-off square a junction dot claims, in graph units. A
// dot renders at a screen radius clamped to 3-5px (junctionRadius in
// ItemEdge.tsx), so in graph units its radius is 3 / zoom below zoom 1: about 3
// units at a sparse plan's 0.9 fit and about 14 at the densest corpus plan's
// 0.21 fit. Seating runs before the camera exists and cannot know the zoom, so
// the keep-off is sized for the widest of those plus a couple of units, keeping
// the dot clear of the chip's edge rather than flush against it. Re-derive it if
// JUNCTION_MIN_PX / JUNCTION_RADIUS change or the fit floor drops much below
// 0.2. Read by the chip seating pass (which keeps every chip out of the square)
// and by the fan-out column placement (whose leg floor must leave a member's
// chip room past the split dot).
export const DOT_KEEPOFF = 16;

// Left overhang a routed vertical (rise / bend / rail column) keeps clear of a
// target's Left port, in graph units. The retired icon-only entry chips
// reached this far left of the port (a 12 inset plus half a 22-wide max-scale
// box); the pad keeps that footprint so arrival corridors stay uncluttered and
// the routing geometry is unchanged by the chips' removal.
export const ENTRY_GUTTER_OVERHANG = 34;

export const NODE_NODE_SPACING = 30;

// How far an environment recipe card's FRAME reaches beyond its card box, per
// side: the banner plates and haze RecipeNode draws on .rn-env (inset
// -36px -8px -22px). The card box itself never grows -- measureRecipe and the
// DOM stay card-sized -- but two things have to reserve the frame rectangle:
// the ELK adapter hands ELK the grown box (so the default nodeNode spacing
// keeps neighbours off the plates) and maps positions back to the frame's
// inner rectangle, and the chip-seating obstacles grow by the same extents so
// no chip seats on a plate. Both read this one constant.
//
//   +--------------------------+   ^
//   | 36 (top plate + glyph)   |   |
//   |   +------------------+   |   | frame
//   | 8 |    card box      | 8 |   |
//   |   +------------------+   |   |
//   | 22 (bottom plate)        |   v
//   +--------------------------+
export const ENV_FRAME_EXTENTS = {
  top: 36,
  bottom: 22,
  left: 8,
  right: 8,
} as const;

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

// Zoom LOD gates. Below LABEL_MIN_ZOOM the rate chips are dropped. Dense plans
// fit at roughly 0.35-0.55, so the gate sits just under that band: chips appear
// at the dense-plan fit zooms instead of only after zooming in. Below the gate
// the overview reads as clean lines. ItemEdge and BusEdge read transform[2]
// (zoom only) so an edge re-renders on zoom changes but not on pan.
export const LABEL_MIN_ZOOM = 0.35;

// Second, lower zoom LOD gate. Below it the chips that are EXEMPT from
// LABEL_MIN_ZOOM (the bus aggregate drop chip and a lone member's long-detour
// rise chip) collapse to icon-only: the item icon alone, with the rate digits
// dropped. This preserves the "something flows here" signal while un-blanketing
// dense clusters at fit zoom; the exact rate stays reachable on the chip's hover
// tooltip. Calibrated against the corpus fit zooms measured in-browser at
// 1920x1080: the gate sits in the gap between the one plan that must collapse
// (multi6, 0.21) and the densest plan that must stay full (battery5-xiranite,
// 0.35 - just above LABEL_MIN_ZOOM, so nothing on it collapses either). The
// remaining plans sit well clear: equip4 0.44, battery5 0.45, crystal 0.50,
// tundra 0.66, default 0.90. Kept below LABEL_MIN_ZOOM so the LOD stays
// monotonic: per-member chips drop first, then the surviving aggregates shed
// their digits.
export const CHIP_ICON_ONLY_MAX_ZOOM = 0.32;

// Delay before a hover registers, so sweeping the pointer across the canvas does
// not strobe the dim state on every element crossed. A leave within the window
// cancels the pending hover. Lives here rather than in Canvas so the exam CLIs
// can wait past it without copying the number.
export const HOVER_INTENT_MS = 150;

// Fixed sizes for product units in ELK. The width is the DRAWN box: .product-node
// is a 124px content column plus 10px of padding per side, a 1px border and the
// 3px accent border the direction modifier swaps in on one edge, which is why the
// card-growth table treats a product's model box as already including its border.
// PRODUCT_HEIGHT is kept tight to the actual ProductNode chrome (icon row + rate
// row + padding) so that React Flow's default Handle position of top:50% falls
// inside the visible card instead of below it.
export const PRODUCT_WIDTH = 148;
export const PRODUCT_HEIGHT = 78;

// Top padding ELK reserves inside a container so a member card flush against the
// corner cannot cover the slab's caption strip. Must stay at or above the
// .rf-group-caption height in canvas.css; the surplus is breathing room, so the
// pin is an inequality rather than an equality.
export const CONTAINER_CAPTION_BAND = 28;
