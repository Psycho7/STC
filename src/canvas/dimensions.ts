// Fixed dimensions for the canvas render pipeline. This is the single source of
// truth for both the React node components and the ELK layout call: layout and
// rendering both read these constants directly so they stay locked together,
// with no CSS-in-JS or build step in between.

// The environment plate's height. It is one banner row, so the number lives
// with the banner geometry it is measured from; the card height below spends
// it because the plate is a row of the card.
import { ENV_ROW_HEIGHT } from "./envBanner";

// Recipe-node geometry. .recipe-node is 240px wide. These constants are the
// contract the rendered DOM is pinned to, not approximations of an auto-sized
// layout: .rn-head carries an explicit height:56px (box-sizing:border-box),
// each .rn-row is a fixed 22px, rows sit RECIPE_ROWS_TOP_PAD below the header
// and the same padding repeats at the bottom of the side column, and there is
// no footer -- so the offline model here matches the browser exactly at every
// zoom band.
export const RECIPE_WIDTH = 240;
export const RECIPE_HEADER_HEIGHT = 56;
export const RECIPE_ROW_HEIGHT = 22;
export const RECIPE_ROWS_TOP_PAD = 6;

// Card-header grid columns, pinned (ruling R3) so the title budget is
// deterministic instead of depending on what the auto columns happen to hold.
// The icon column is the machine block's full box (40px icon + 2x6px
// horizontal padding + 1px right border); the title column takes the
// remainder. RECIPE_HEAD_BLOCK_PAD_X is the .rn-recipe-block horizontal
// padding subtracted from the title column to get the name budget
// (RecipeNode). canvas.css hardcodes the same numbers; keep them in step.
export const RECIPE_HEAD_ICON_COL = 53;
export const RECIPE_HEAD_TITLE_COL = RECIPE_WIDTH - RECIPE_HEAD_ICON_COL;
export const RECIPE_HEAD_BLOCK_PAD_X = 8;

// Half-row of air above the first catalyst row: the catalyst rows form their
// own block on the card (ruling I3), and the gap plus the hairline divider
// drawn in it is what separates the block from the supplied rows above. Only a
// card that carries catalysts spends it. canvas.css repeats the number as the
// first catalyst row's margin-top; keep them in step.
export const CATALYST_BLOCK_GAP = RECIPE_ROW_HEIGHT / 2;

// Card height from the two side columns' row counts. The left count is ROWS,
// not ports: a catalyst row is drawn without a handle and still takes a row's
// worth of height. The right side has only port rows, so its count is both.
// `hasCatalystBlock` charges the left column the block gap on top of its rows,
// and `hasEnvironmentPlate` charges the whole card the environment plate: it is
// the card's first row, drawn above the header (ruling I9), so it grows the box
// and pushes every row below it down by ENV_ROW_HEIGHT.
export function recipeHeight(
  inRows: number,
  outPorts: number,
  hasCatalystBlock = false,
  hasEnvironmentPlate = false,
): number {
  const leftColumn =
    inRows * RECIPE_ROW_HEIGHT + (hasCatalystBlock ? CATALYST_BLOCK_GAP : 0);
  const rightColumn = outPorts * RECIPE_ROW_HEIGHT;
  return (
    (hasEnvironmentPlate ? ENV_ROW_HEIGHT : 0) +
    RECIPE_HEADER_HEIGHT +
    RECIPE_ROWS_TOP_PAD * 2 +
    Math.max(leftColumn, rightColumn)
  );
}

export const PORT_WIDTH = 8;
export const PORT_HEIGHT = 8;

// The height of every edge-label chip box, in graph units AND in px: a chip
// draws at its natural CSS size at every zoom, so the two are the same number.
// It is the .flow-chip rule in canvas.css added up -- a 16px item sprite plus
// 1px of vertical padding and a 1px border on each side -- and the icon-only
// variant is the same number square. Kept just under RECIPE_ROW_HEIGHT so two
// chips seated on adjacent rows of one card cannot touch. busRouting (stack
// pitch, midpoint collision box and nudge step) and the seating pass read it,
// so the no-overlap guarantee stays coupled to one source of truth.
export const CHIP_BOX_HEIGHT = 20;

// The PortGlyph box beside each handle, and how far its outer edge hangs
// outside the row edge. The seating pass keeps chips clear of that reach.
export const GLYPH_SIZE = 8;
export const GLYPH_SIDE_OFFSET = GLYPH_SIZE + 2;

// How far a stamped divergence dot may drift from the live port row before the
// stamp is treated as stale and the dot is dropped. The bookkeeping pass stamps
// the dot at the source-port row it was derived on, and nodes stay
// mouse-draggable with a re-run only at the drop, so a drag in flight moves the
// geometry out from under a decision nothing recomputes yet: past this
// threshold a floating marker is worse than an unmarked split, and the renderer
// drops it. The threshold sits well above the ~1-unit port-model disagreement
// between the pass's reconstruction and React Flow's measured handles, and well
// below any drag that moves a row -- half the height of a chip box. Note the
// coupling: changing the chip-box height moves this threshold with it.
// Exported for the divergence-dot suite, which drags a node exactly to the
// threshold and one unit inside it.
export const STAMP_ROW_EPS = CHIP_BOX_HEIGHT / 2;

// Does the port row a stamp was taken on still describe the live geometry? An
// ABSENT stamp answers yes -- nothing contradicts the decision, so it stands --
// and this is the only place that default is stated.
export function portRowStampLive(
  stampY: number | undefined,
  liveY: number,
): boolean {
  return stampY === undefined || Math.abs(stampY - liveY) < STAMP_ROW_EPS;
}

// Horizontal chip-box metrics, the x-axis analogs of CHIP_BOX_HEIGHT, in the
// same graph-units-are-px terms. CHIP_BOX_WIDTH bounds the box of a WIDE chip:
// the rendered body is the 16px item sprite plus the rounded rate text and
// optional count marker (e.g. an icon followed by "222.22/min x2"; the
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
// reached this far left of the port (a 12 inset plus half a 22-wide box at the
// counter-scale those chips took); the pad keeps that footprint so arrival
// corridors stay uncluttered and the routing geometry is unchanged by the
// chips' removal.
export const ENTRY_GUTTER_OVERHANG = 34;

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

// Zoom LOD gates, the same three bands for EVERY chip family: at or above
// CHIP_ICON_ONLY_MAX_ZOOM a chip draws in full, between the two gates it draws
// as its item icon alone, and below LABEL_MIN_ZOOM it is not drawn at all. A
// hover-lit chip is the one exception: it keeps its digits and stays drawn at
// any zoom, because the hover is the reader asking for that rate.
//
// The mount gate. Below it the overview reads as clean lines; the rate stays on
// the boundary cards and on the edge's hover tooltip. ItemEdge and BusEdge read
// transform[2] (zoom only) so an edge re-renders on zoom changes but not on pan.
export const LABEL_MIN_ZOOM = 0.35;

// The digits gate, ABOVE the mount gate so the LOD stays monotonic: a chip
// mounts as an icon first and earns its digits only further in. Below it a chip
// draws the item icon alone, which keeps the "something flows here" signal while
// a dense cluster stops blanketing at fit zoom; the rate stays reachable on the
// chip's hover tooltip. A chip draws at its natural size at every zoom, so its
// digits go sub-legible well before the box itself does -- which is what puts
// this gate above the mount gate rather than below it. The corpus fit zooms
// measured in-browser at 1920x1080 are the calibration record: multi6 0.21,
// battery5-xiranite 0.35, equip4 0.44, battery5 0.45, crystal 0.50, tundra
// 0.66, default 0.90 -- so multi6 opens with no chips, the next three open
// icon-only and the last three open in full.
export const CHIP_ICON_ONLY_MAX_ZOOM = 0.5;

// Delay before a hover registers, so sweeping the pointer across the canvas does
// not strobe the dim state on every element crossed. A leave within the window
// cancels the pending hover. Lives here rather than in Canvas so the exam CLIs
// can wait past it without copying the number.
export const HOVER_INTENT_MS = 150;

// Fixed sizes for product units in ELK. The width is the DRAWN box: .product-node
// is a 124px content column plus 10px of padding per side, a 1px border and the
// 3px accent border the direction modifier swaps in on one edge, which is why the
// card-growth table treats a product's model box as already including its border.
// PRODUCT_HEIGHT is the drawn height of that chrome, summed from canvas.css:
// 2x1px border + 8px top and 9px bottom padding + the 28px head (the item
// sprite, taller than the name's 16px line) + the 4px column gap + the rate
// row's 2px margin and 18px line. The card lost its caption row with ruling
// I5/I10, and the constant gave up the slack it used to carry over the drawn
// box along with it (78 -> 71). Equality with the drawn box is what
// puts React Flow's default top:50% handle on the port y the layout model
// assigns; test/canvas/ProductNode.test.tsx re-derives it from the stylesheet.
export const PRODUCT_WIDTH = 148;
export const PRODUCT_HEIGHT = 71;
