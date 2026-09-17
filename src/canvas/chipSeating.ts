// Chip placement bookkeeping: the whole-graph pass that runs after routing and
// stamps what a chip's own edge cannot know, plus the card geometry the audits
// share with it.
//
// WHERE A CHIP SITS is not decided here. Every chip anchor is a RULE on the
// drawn polyline, resolved in edgePath.ts where the path is built (a 1-to-1
// chip on the centre of its longest horizontal run, a trunk chip a port stub
// out of the port it labels, on the run that is its own), so the renderers read
// the anchor straight off drawnEdge and nothing hides or collapses a chip after
// the fact. The one input that rule needs and a single edge cannot see is the
// card rects: the card-clear slide below computes the 1-to-1 seat from them and
// hands it back as a hint, and edgePath applies it -- so the rule still lives in
// one place and the stamp is an input to it, not an override of it.
//
// What is left is the bookkeeping no single edge can answer, because it is a
// property of a GROUP of edges:
//   - the declined fan-out's divergence dot: where N coincident same-flow item
//     edges first peel apart, stamped on one elected owner edge;
//   - the crossing cues: where two DIFFERENT flows properly cross, stamped on
//     one edge of the pair so its renderer can mask a gap in its own stroke;
//   - the fan-in convergence dot of a trunk whose members are all FAR: they are
//     drawn as plain item edges pinned to one column, so no BusEdge draws the
//     trunk's merge dot, and one elected member carries it instead. Such a
//     trunk still draws NO aggregate chip -- the aggregate rides a retyped near
//     member's leg, and there is none; the target card states the total;
//   - the card-clear seat of a 1-to-1 chip whose longest run passes over a
//     card: the slide is a deterministic function of the run and the card
//     rects, and the rects are what a single edge cannot see.
// Both are pure functions of the reconstructed polylines, and the
// reconstruction goes through drawnEdge -- the same seam the renderers draw
// through -- so this pass cannot answer a different polyline than the one on
// screen.
//
// contentBounds, at the bottom, is the camera-fit reader of the same rule: it
// unions the node cards with every chip box at its rule anchor.

import type { Edge } from "@xyflow/react";

import { GLYPH_SIDE_OFFSET } from "./dimensions";
import {
  CHAMFER,
  cardClearRunAnchor,
  chipBoxClearsCards,
  drawnEdge,
  itemAnchor,
  routingHintsFromData,
} from "./edgePath";
import {
  properCrossPoint,
  type CrossingCue,
  type CrossingCuePartner,
} from "./crossings";
import {
  isTrunkOwner,
  type FaninBusEdgeData,
  type FanoutBusEdgeData,
} from "./busRouting";
import {
  absoluteLeft,
  absoluteTop,
  drawnPortsOf,
  edgeItem,
  flowKeyOf as busFlowKey,
  nodeIndexOf,
  nodeRectOf,
  type Rect,
} from "./nodeGeometry";
import { pushInto } from "../util/multimap";
// Type-only: ItemEdge.tsx declares the base canvas edge payload this pass
// stamps. Erased at compile time, so it adds no runtime or bundler edge.
import type { ItemEdgeData } from "./ItemEdge";
import type { RFAnyNode } from "./layout";
// The chip BOX: how wide a chip is and what it says. The camera fit frames that
// box at the anchor the path builder put it on.
import {
  CHIP_HALF_H,
  aggregateChipText,
  branchChipText,
  chipSeatHalfW,
  rateChipText,
} from "./chipMetrics";

// A raw card rect a chip's box must stay clear of (the P3 hard invariant), in
// the DRAWN frame: the rendered border box, which is what the browser paints and
// what the e2e audit measures (see CARD_GROWTH). `border` is the card's frame
// width (cardBorder): the port furniture anchors on the row edge, one border
// inside the drawn edge.
export type CardRect = Rect & { id: string; border: number };

// Port-adjacent exemption depth (issue #10). An edge-label chip is ~2x wider
// than the inter-card corridor it labels, so a chip on its own line necessarily
// pokes its wide box into its own source / target card near the port -- that is
// the normal, on-line state, not a defect. The #10 defect is a chip whose CENTRE
// (its icon + rate text, the readable payload) lands ON the card body, well past
// the port, burying the label in the card ("~2 box-widths into the consumer
// card"). So the exemption is on the chip CENTRE, not the box: a chip is exempt
// from its own card while its centre stays within PORT_ZONE_DEPTH of the port
// edge (in the corridor or a hair inside), and enters the body once the centre
// crosses deeper. Depth is the recipe row's port-side inset (canvas.css
// .rn-row.input padding-left / .rn-row.output padding-right, both 8px) -- the
// strip between the ROW edge and the row's item glyph, so an exempt chip's
// centre stops at the glyph's leading edge and never sits on the glyph itself.
// The row sits inside the card's border, so the strip is measured from the card
// edge inward by CARD_BORDER first (the card rects are drawn border boxes).
// Re-derive it whenever that row padding changes. A box-overlap rule instead
// would flag every on-line chip (box wider than corridor) and fling it off its
// line -- the issue-#9 orphaned-chip regression this narrowing must avoid.
export const PORT_ZONE_DEPTH = 8;

// How far the port furniture (the PortGlyph, which reaches past the handle)
// hangs outside the row edge, in graph units.
const PORT_FURNITURE_OUT = GLYPH_SIDE_OFFSET;

// The port keep-out band: the full-height x-strip straddling one own endpoint
// card's port edge, from the glyph's outer edge to the port strip's inner
// edge. Full card height because a step edge anchors at mid(sy,ty), so a
// row-height band would let a wide box land on a neighbouring row's text.
//
// Exported for the port-zone suite, which asserts the band reaches the drawn
// glyph's outer edge on each card kind.
export function portKeepOutRect(
  card: CardRect,
  side: PortZoneSide,
): PortZoneRect {
  const out = PORT_FURNITURE_OUT - card.border;
  const depth = card.border + PORT_ZONE_DEPTH;
  return side === "target"
    ? {
        left: card.left - out,
        right: card.left + depth,
        top: card.top,
        bottom: card.bottom,
      }
    : {
        left: card.right - depth,
        right: card.right + out,
        top: card.top,
        bottom: card.bottom,
      };
}

export type PortZoneSide = "source" | "target";

type PortZoneRect = Rect;

// Does `chip`'s CENTRE sit ON the OWN endpoint `card`'s body, past its
// port-adjacent strip? True = the chip is seated on the card body (a #10
// violation the seat must escape); false = no vertical overlap with the card, or
// the centre is still in the corridor / port strip (the normal on-line state).
// `side` selects the port edge ("source" hugs the card's right edge / out-port,
// "target" its left edge / in-port). The e2e chip/card audit scores chips with
// it; it is stated here, beside the card rects it is measured against.
//
// Callers pass DRAWN card rects -- the audit reads them off the DOM, cardRectsFor
// grows the model box by CARD_GROWTH -- so the strip starts one CARD_BORDER
// inside the rect, where the row the depth is derived from begins.
export function chipEntersOwnCardBody(
  chip: PortZoneRect,
  card: PortZoneRect,
  side: PortZoneSide,
  eps = 0.5,
): boolean {
  const oy = Math.min(chip.bottom, card.bottom) - Math.max(chip.top, card.top);
  if (oy <= eps) return false; // not even level with the card: never on its body
  const cx = (chip.left + chip.right) / 2;
  // CARD_BORDER is declared further down this file, next to the CARD_GROWTH
  // table it is derived with (the port-side counterpart, PORT_DRIFT, lives with
  // drawnPortsOf in nodeGeometry.ts); hoisting makes it readable here.
  const depth = CARD_BORDER + PORT_ZONE_DEPTH;
  return side === "target" ? cx > card.left + depth : cx < card.right - depth;
}

// The card border, in graph units per side: the 1px frame a rendered card draws
// around its content box (canvas.css .recipe-node / .product-node). It is the
// same discrepancy nodeGeometry's PORT_DRIFT.recipe derives its handle offsets
// from, seen from the box side instead of the port side, so the two must be
// re-derived together, in their two homes.
export const CARD_BORDER = 1;

// How much WIDER and TALLER a node's DRAWN border box is than the model box the
// layout positions it by, per node kind. Its origin never moves: the wrapper
// sits at the model position and the border grows the box on the right and the
// bottom only.
//   recipe: the card is content-box RECIPE_WIDTH (240) with a CARD_BORDER frame
//     per side, so the drawn box is 242 wide and two units taller than
//     recipeHeight -- exactly the offset nodeGeometry's PORT_DRIFT.recipe
//     derivation records.
//   product: the model width ALREADY counts the card's borders (124 content +
//     20 padding + 1 border + a 3 accent border = the 148 layout assigns), so
//     the drawn box is the model box.
//   loop / container: sized by inline width / height in model units, so the
//     border stays inside the box and likewise adds no growth.
// Measured in-browser across the seven corpus scenarios (recipe 242 x
// recipeHeight+2 everywhere, product 148x78, group == its model size, no loop
// node in any corpus plan). Re-derive alongside nodeGeometry's PORT_DRIFT
// whenever a card's border or box-sizing changes.
const CARD_GROWTH: Record<"recipe" | "product" | "other", number> = {
  recipe: 2 * CARD_BORDER,
  product: 0,
  other: 0,
};

// The drawn-vs-model box growth for one node kind, keyed by the `type` string
// React Flow carries on the node (and the e2e audit reads off the DOM), so the
// audit can state the same contract against the rendered card.
export function cardGrowth(type: string | undefined): number {
  if (type === "recipe") return CARD_GROWTH.recipe;
  if (type === "product") return CARD_GROWTH.product;
  return CARD_GROWTH.other;
}

// The frame width one node kind draws per side (half its growth).
function cardBorder(type: string | undefined): number {
  return type === "recipe" ? CARD_BORDER : 0;
}

// The raw card rects the chip/card audit scores against, one per node: recipe /
// product / loop cards and group slabs alike.
//
// These are DRAWN border boxes, the same frame drawnPortsOf reconstructs the
// polylines in: the model box grown by CARD_GROWTH, which is zero for every
// kind but the recipe card, whose 1px border makes it 242 wide against the
// model's 240 (see CARD_BORDER). The audit collects the rendered card rect
// straight off the DOM, so measuring the model box here would leave the two
// frames two units apart on every recipe.
//
// An environment recipe needs no extra term: its plate is a row of the card
// (ruling I9), so measureRecipe's height already covers it and the box here is
// the box the DOM paints, same as every other card's.
//
// Exported so a unit test can observe the growth actually being applied: the
// e2e card-frame criterion rebuilds the same constants and so cannot see this
// call site at all.
export function cardRectsFor(
  nodes: ReadonlyArray<RFAnyNode>,
  byId: ReadonlyMap<string, RFAnyNode>,
): CardRect[] {
  return nodes.map((n) => {
    const r = nodeRectOf(n, byId);
    const growth = cardGrowth(n.type);
    return {
      id: n.id,
      left: r.left,
      top: r.top,
      right: r.right + growth,
      bottom: r.bottom + growth,
      border: cardBorder(n.type),
    };
  });
}

// A reconstructed edge polyline, as the crossing-cue pass reads it: the owning
// edge's id, the FLOW it belongs to (same item|source is one visual line, so a
// pair of them crossing is not a crossing at all) and its segments.
type EdgeSegments = {
  id: string;
  flowKey: string;
  segs: ReadonlyArray<readonly [number, number, number, number]>;
};

// Every edge-data field this pass stamps. Picking them off the types that
// declare them makes a rename at the declaration a build error here.
type StampKey =
  | "fanoutJunctionX"
  | "fanoutJunctionY"
  | "faninJunctionX"
  | "faninJunctionY"
  | "chipX"
  | "chipY"
  | "crossingCues";
type PickStampKeys<T> = Pick<T, Extract<StampKey, keyof T>>;
type StampPatch = Partial<
  PickStampKeys<ItemEdgeData> &
    PickStampKeys<FanoutBusEdgeData> &
    PickStampKeys<FaninBusEdgeData>
>;

export function deconflictChipAnchors(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Edge[] {
  const byId = nodeIndexOf(nodes);
  const flowKeyOf = (edge: Edge): string =>
    busFlowKey(edgeItem(edge), edge.source);

  // One drawn shape per edge, from the same seam the renderers draw through:
  // the hint spread, the fan-out discriminant and the parse of `d` all resolve
  // there. Item edges keep their vertex list for the divergence pass below;
  // every edge contributes its segments to the crossing-cue pass.
  const edgeSegments: EdgeSegments[] = [];
  // The edges-array index of each edgeSegments entry, parallel to it: the
  // crossing-cue pass keys each edge's stamped cue list by it, while the
  // segment list skips edges with unresolvable endpoints.
  const edgeIndexOfSegment: number[] = [];
  const itemPtsById = new Map<
    string,
    ReadonlyArray<readonly [number, number]>
  >();
  // The drawn target row of each reconstructed edge, for the fan-in dot below:
  // that dot sits on the target row of the trunk it marks.
  const targetYById = new Map<string, number>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item" && edge.type !== "bus") return;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) return;
    targetYById.set(edge.id, ends.targetY);
    const drawn = drawnEdge(ends, edge.type, edge.data);
    if (drawn.shape === "item") itemPtsById.set(edge.id, drawn.pts);
    const segs: Array<readonly [number, number, number, number]> = [];
    for (let i = 1; i < drawn.pts.length; i++) {
      segs.push([
        drawn.pts[i - 1]![0],
        drawn.pts[i - 1]![1],
        drawn.pts[i]![0],
        drawn.pts[i]![1],
      ]);
    }
    edgeSegments.push({ id: edge.id, flowKey: flowKeyOf(edge), segs });
    edgeIndexOfSegment.push(index);
  });

  // CROSSING CUES (unmarked-same-item-crossing). Where two
  // reconstructed polylines of DIFFERENT flows (different item|source)
  // properly cross, the pair reads as a bare X -- and a bare X of two
  // strokes is indistinguishable from a join, which is exactly the confusion
  // the merge dot exists to prevent on the other side. Stamp the crossing
  // point on ONE edge of the pair: that edge's renderer masks its own stroke
  // out around the point (see CrossingCueMask), so the other edge's stroke
  // shows through the gap and the pair reads as one flow passing under the
  // other.
  //
  // WHY a mask on one edge rather than a background-coloured disk on the
  // edge painting above: a gap cut out of a stroke is transparent, so it
  // leaves the container slab tint, the bus band tint and their hairlines
  // untouched, and it reads the same whichever edge paints above. React
  // Flow renders every edge in its own <svg style={{zIndex}}> whose z folds
  // in the endpoint NODES' z, and a SELECTED node is lifted to z 1000 (a
  // default, and a drag auto-selects), so "which edge paints above" is not
  // a rest-time constant; a masked gap needs no such ruling, because the
  // continuous stroke is the only one drawn there in either order. The
  // stamped edge is simply the earlier one in the edges array: any
  // consistent choice draws the same picture, and where several members of
  // one trunk cross a foreign edge at one shared point (overlapping trunk
  // runs), the mixture of stamps still reads right -- a member's gap is
  // covered by its unstamped siblings' continuous runs, and the foreign
  // edge's gap is the one that shows.
  //
  // The pass is presentational only -- no edge is retyped, no chip moves, no
  // routing changes -- and the CROSSING ratchet above the routing passes is
  // untouched: this adds cues, not crossings.
  //
  // Why properCross semantics are the whole safety argument (the negative
  // tests pin each clause): a strict-interior crossing can never fire on
  //   - a collinear fan-in merge run (collinear overlap, not opposite
  //     orientations), or
  //   - a shared fan-out trunk (the members leave the junction from one
  //     shared vertex, so every intersection is an endpoint touch), or its
  //     FAR members, the item edges pinned to the same junction column: their
  //     verticals overlap collinearly on that column and they are same-flow
  //     besides, so neither clause can fire between two members of one trunk,
  // so the cue cannot mark a real merge or a trunk as a crossing. Same-flow
  // pairs are skipped outright: one flow is one visual line (the flowKey
  // doctrine the chip clearance tiers already apply).
  //
  // O(S^2) over segment pairs of different flows, the same shape as the e2e
  // crossing census. Points are rounded to the emitted paths' two decimals and
  // deduped per edge: the members of one trunk share a run exactly, so their
  // crossings with one foreign edge land on the same point and one gap must
  // draw there, not six stacked cut-outs. Each stamp carries every partner
  // edge crossing there -- its id and endpoint NODE anchors (see
  // crossingPartnerBits): the render-side staleness rule needs the OTHER
  // side's identity to drop the cue once a drag moves every partner off the
  // crossing, which the point alone cannot express, and it must not drop
  // the gap while a sibling partner still crosses there.
  const crossingCuesByIndex = new Map<number, Array<CrossingCue>>();
  {
    // The partner record for one segment entry: its edge id plus its two
    // endpoint node ABSOLUTE origins (rounded to the stamp's two decimals).
    // Every segment entry resolved its endpoints (drawnPortsOf returned
    // non-null), so both nodes exist here.
    const partnerStampOf = (segIdx: number): CrossingCuePartner => {
      const edge = edges[edgeIndexOfSegment[segIdx]!]!;
      const anchorOf = (nodeId: string): { x: number; y: number } => {
        const node = byId.get(nodeId)!;
        return {
          x: Math.round(absoluteLeft(node, byId) * 100) / 100,
          y: Math.round(absoluteTop(node, byId) * 100) / 100,
        };
      };
      return {
        edgeId: edgeSegments[segIdx]!.id,
        source: anchorOf(edge.source),
        target: anchorOf(edge.target),
      };
    };
    // Cue by (stamped edge, point), so a second partner crossing the same
    // point joins the existing cue's partner list instead of stacking a
    // second cut-out.
    const cueByKey = new Map<
      string,
      { cue: CrossingCue; partners: Array<CrossingCuePartner> }
    >();
    for (let i = 0; i < edgeSegments.length; i++) {
      for (let j = i + 1; j < edgeSegments.length; j++) {
        const si = edgeSegments[i]!;
        const sj = edgeSegments[j]!;
        if (si.flowKey === sj.flowKey) continue;
        for (const sa of si.segs) {
          for (const sb of sj.segs) {
            const p = properCrossPoint(
              [sa[0], sa[1]],
              [sa[2], sa[3]],
              [sb[0], sb[1]],
              [sb[2], sb[3]],
            );
            if (p === null) continue;
            const x = Math.round(p[0] * 100) / 100;
            const y = Math.round(p[1] * 100) / 100;
            // The earlier edge carries the gap; the later one is a partner.
            const stampIndex = edgeIndexOfSegment[i]!;
            const key = `${stampIndex}|${x}|${y}`;
            let entry = cueByKey.get(key);
            if (entry === undefined) {
              const partners: Array<CrossingCuePartner> = [];
              entry = { cue: { x, y, partners }, partners };
              cueByKey.set(key, entry);
              pushInto(crossingCuesByIndex, stampIndex, entry.cue);
            }
            entry.partners.push(partnerStampOf(j));
          }
        }
      }
    }
  }

  // The row tolerance the divergence derivation compares against: every
  // comparison is in the DRAWN frame (drawnPortsOf, the same reconstruction the
  // polylines came from), so a unit of slack is a real collinearity tolerance
  // rather than a budget already spent on a frame mismatch.
  const ROW_EPS = 1;

  // DIVERGENCE DOTS for declined fan-outs (#43): N >= 2 same-(item, source)
  // item edges into >= 2 distinct targets whose gap fell outside
  // routeTrunkEdges' span band stay plain ItemEdges. They leave the shared out-port coincident and
  // peel off one at a time, so the reader sees ONE line and takes a member's
  // rate for the whole flow. Mark the split with a junction dot on one owner
  // edge -- the counterpart of the fan-in merge dot above, and of the dot a real
  // fan-out trunk draws from BusEdge. Bus-typed members never reach here (they
  // have no item geometry), so an accepted trunk is not double-marked. No
  // aggregate chip rides along: a total would sit a few pixels from the source
  // card's own output row, which already states it (#39), and a declined
  // fan-out's shared prefix is too short to hold the box anyway. Presentational
  // only -- no edge is retyped.
  const fanoutJunctionByIndex = new Map<number, { x: number; y: number }>();
  type DivergenceMember = {
    index: number;
    id: string;
    target: string;
    sx: number;
    sy: number;
    // x of the last vertex still on the source row, i.e. where this member
    // peels off. Undefined for a member that never leaves the row.
    bendX: number | undefined;
  };
  const divergenceGroups = new Map<string, DivergenceMember[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const pts = itemPtsById.get(edge.id);
    if (pts === undefined) return;
    if (pts.length < 2) return;
    const sx = pts[0]![0];
    const sy = pts[0]![1];
    // A backward member leaves through its own detour rail rather than sharing
    // a forward prefix, so it neither carries the dot nor counts as a target of
    // the split.
    if (pts[pts.length - 1]![0] <= sx) return;
    let bendX: number | undefined;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]![1] - sy) > ROW_EPS) {
        bendX = pts[i - 1]![0];
        break;
      }
    }
    const key = flowKeyOf(edge);
    pushInto(divergenceGroups, key, {
      index,
      id: edge.id,
      target: edge.target,
      sx,
      sy,
      bendX,
    });
  });
  for (const members of divergenceGroups.values()) {
    if (members.length < 2) continue;
    // Same-(item, source) edges into ONE unit are a parallel bundle drawn as a
    // single line, not a split -- the mirror of the fan-in distinct-sources rule.
    if (new Set(members.map((m) => m.target)).size < 2) continue;
    // The split becomes visible where the FIRST member peels off; before that
    // every member is still on the shared row. A group where nobody bends draws
    // no visible divergence at all, so it gets no dot.
    const bends = members.filter((m) => m.bendX !== undefined);
    if (bends.length === 0) continue;
    const junctionX = Math.min(...bends.map((m) => m.bendX!));
    // The owner is elected among the BENDING members only: the column above is
    // one of their peel-offs, and a straight member whose target stops short of
    // it would carry a stamp off its own line, which the render layer's
    // on-own-polyline gate then hides while the keep-offs still push chips away
    // from the invisible dot.
    const owner = bends.reduce((a, b) => (a.id <= b.id ? a : b));
    // A dot at the port itself would read as part of the source card's own
    // output row, not as a split in the run.
    if (junctionX <= owner.sx) continue;
    fanoutJunctionByIndex.set(owner.index, { x: junctionX, y: owner.sy });
  }

  // FAN-IN CONVERGENCE DOT for a trunk drawn entirely from FAR members. A
  // fan-in member reaching its target from the next layer back is retyped bus
  // and BusEdge draws the trunk's merge dot; a member further back stays a
  // plain item edge pinned to the trunk's column (faninColumn beside bendX),
  // and where every member is such a one no BusEdge exists to draw it. The
  // members still converge -- they all run into the same port along the same
  // row -- so the reader sees several lines become one with nothing marking
  // the merge, the very confusion the dot exists to prevent. One elected member
  // carries it, the mirror of the declined-fan-out divergence dot above.
  //
  // The dot sits where the retyped shape would put it: one chamfer past the
  // trunk's column on the target row (chamferFaninPath's junction). Members
  // that jog may already run collinear left of it, from their source-side jog
  // columns on; the dot still marks the trunk column, not that earlier
  // coincidence. The point lies on every member's own final run, so each
  // member's renderer can
  // corroborate the stamp against the line it drew.
  const faninJunctionByIndex = new Map<number, { x: number; y: number }>();
  type FaninMember = { index: number; id: string; x: number; y: number };
  const faninGroups = new Map<string, FaninMember[]>();
  edges.forEach((edge, index) => {
    if (edge.type !== "item") return;
    const column = (edge.data as { faninColumn?: boolean } | undefined)
      ?.faninColumn;
    const bendX = routingHintsFromData(edge.data).bendX;
    if (column !== true || bendX === undefined) return;
    const ty = targetYById.get(edge.id);
    if (ty === undefined) return;
    // One trunk is one (item, target port) with one column, the same key
    // routeTrunkEdges pinned the column by.
    const key = `${edgeItem(edge) ?? ""}|${edge.target}|${bendX}`;
    pushInto(faninGroups, key, {
      index,
      id: edge.id,
      x: bendX + CHAMFER,
      y: ty,
    });
  });
  for (const members of faninGroups.values()) {
    if (members.length < 2) continue;
    const owner = members.reduce((a, b) => (a.id <= b.id ? a : b));
    faninJunctionByIndex.set(owner.index, { x: owner.x, y: owner.y });
  }

  // CARD-CLEAR SEAT of an item chip. The rule seat is the centre of the
  // polyline's longest horizontal run for a 1-to-1 chip, and one port stub off
  // the port on its own named run for a far trunk member; either can stand over
  // a card, where the box reads as that card's own label rather than as the
  // line's rate. A far member's named run is the one that gets too short for
  // its box: a jogged leg starts just past the card it dodged, so the seat one
  // stub back from the port hangs off the run's near end and over that card.
  //
  // Both fall back the same way: cardClearRunAnchor slides the box along the
  // member's OWN runs, longest first, to the nearest card-clear position, a
  // deterministic function of the runs and the raw card rects. Only the rects
  // need the node list, which is why the slide is computed here and handed to
  // the drawer as a point; the drawer keeps it only while it still lies on a
  // horizontal run of the live polyline. A rule seat that is already clear is
  // left alone, and so is a member no run of which can hold a clear box -- it
  // keeps the named seat, which at least states which port the rate belongs to.
  //
  // The surface it slides against is the cards PLUS their port furniture
  // (portKeepOutRect): the PortGlyph reaches outside the card edge, so a box
  // seated flush against that edge clears the card and still buries every glyph
  // on it. Where the reserve model widened the corridor (every gap-crossing
  // edge) a run holds the box past the furniture; where it did not -- two cards
  // of ONE layer standing a few dozen units apart, a pair no gap was ever
  // charged for -- no seat on the run clears the strips, and the slide falls
  // back to the cards alone rather than giving up and leaving the box on a card.
  const chipSeatByIndex = new Map<number, { x: number; y: number }>();
  {
    const cards = cardRectsFor(
      nodes.filter((node) => node.type !== "group"),
      byId,
    );
    const withFurniture: PortZoneRect[] = cards.flatMap((card) => [
      card,
      portKeepOutRect(card, "source"),
      portKeepOutRect(card, "target"),
    ]);
    const boxHits = (
      x: number,
      y: number,
      halfW: number,
      blockers: ReadonlyArray<PortZoneRect>,
    ): boolean => !chipBoxClearsCards(x, y, halfW, blockers);
    edges.forEach((edge, index) => {
      if (edge.type !== "item") return;
      const pts = itemPtsById.get(edge.id);
      if (pts === undefined || pts.length < 2) return;
      const ports = drawnPortsOf(edge, byId);
      if (ports === null) return;
      const halfW = chipSeatHalfW(rateChipText(edge), false);
      const [ruleX, ruleY] = itemAnchor(
        pts,
        { ...routingHintsFromData(edge.data), memberHalfW: halfW },
        ports.sourceX,
        ports.targetX,
      );
      if (!boxHits(ruleX, ruleY, halfW, withFurniture)) return;
      // The slide against one obstacle tier, or nothing when no run of this
      // polyline can hold a box clear of it.
      const slide = (
        blockers: ReadonlyArray<PortZoneRect>,
      ): { x: number; y: number } | undefined => {
        const [x, y] = cardClearRunAnchor(pts, halfW, blockers);
        return boxHits(x, y, halfW, blockers) ? undefined : { x, y };
      };
      const seat = slide(withFurniture) ?? slide(cards);
      if (seat === undefined) return;
      if (seat.x === ruleX && seat.y === ruleY) return;
      chipSeatByIndex.set(index, seat);
    });
  }

  // Stamp both passes' verdicts onto one patch object, then decide by the
  // patch: an edge nothing stamped is returned BY REFERENCE (the routing passes
  // and their tests read that identity as "untouched"), and every other edge
  // gets exactly the keys that were set.
  return edges.map((edge, index) => {
    const patch: StampPatch = {};
    const fanoutJunction = fanoutJunctionByIndex.get(index);
    if (fanoutJunction !== undefined) {
      patch.fanoutJunctionX = fanoutJunction.x;
      patch.fanoutJunctionY = fanoutJunction.y;
    }
    const faninJunction = faninJunctionByIndex.get(index);
    if (faninJunction !== undefined) {
      patch.faninJunctionX = faninJunction.x;
      patch.faninJunctionY = faninJunction.y;
    }
    const seat = chipSeatByIndex.get(index);
    if (seat !== undefined) {
      patch.chipX = seat.x;
      patch.chipY = seat.y;
    }
    // Crossing cues read by ItemEdge AND BusEdge (the field lives on the shared
    // ItemEdgeData payload both render). Absolute graph points; the renderers
    // drop any whose own polyline has since moved off them.
    const cues = crossingCuesByIndex.get(index);
    if (cues !== undefined) patch.crossingCues = cues;
    if (Object.keys(patch).length === 0) return edge;
    return { ...edge, data: { ...edge.data, ...patch } };
  });
}

// A flow-coordinate rectangle, the shape React Flow's fitBounds consumes.
export type ContentRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// The edge-data fields contentBounds needs to know which chip families an edge
// draws. Picked from the declaring type rather than restated, so renaming a
// field there breaks this build instead of silently leaving a reader behind.
type ChipAnchorData = Partial<
  Pick<FanoutBusEdgeData, "busMemberCount" | "busChipOwner">
  // `fanout` and `fanin` are the only names this view declares itself: the two
  // payload types type them `true`, so the Pick cannot take either as optional.
> & { fanout?: boolean; fanin?: boolean };

// One seated chip's drawn box, at the anchor its render component draws and
// the size its seat reserved: halfW is the same per-family chipSeatHalfW the
// seat reserved (the max counter-scale box the chip paints, so the box here is
// never narrower than the box the browser shows), halfH the chip pitch height
// every family shares. Hidden chips draw nothing, so they enumerate none.
// Exported for the seating suites, which assert chip/obstacle clearance
// against the boxes the renderers actually draw.
export type SeatedChipBox = {
  edgeId: string;
  family: "label" | "fanout-agg" | "fanout-branch";
  source: string;
  target: string;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
};

// Every chip family, anchored exactly as its render component anchors it:
// rebuild the polyline with the same builder and hints, then read the rule
// anchor off it. contentBounds folds these into the camera frame; the suites
// read them individually.
export function seatedChipBoxes(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): SeatedChipBox[] {
  const byId = nodeIndexOf(nodes);
  const out: SeatedChipBox[] = [];
  const push = (
    edge: Edge,
    family: SeatedChipBox["family"],
    cx: number,
    cy: number,
    halfW: number,
  ): void => {
    out.push({
      edgeId: edge.id,
      family,
      source: edge.source,
      target: edge.target,
      x: cx,
      y: cy,
      halfW,
      halfH: CHIP_HALF_H,
    });
  };
  for (const edge of edges) {
    const data = edge.data as ChipAnchorData | undefined;
    // The canvas draws two edge types (Canvas's edgeTypes map); anything else
    // carries no chip family to draw, and drawnEdge would answer it with the
    // item shape, so it is skipped before the per-shape arms below.
    if (edge.type !== "item" && edge.type !== "bus") continue;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const drawn = drawnEdge(ends, edge.type, edge.data);
    if (drawn.shape === "item") {
      push(
        edge,
        "label",
        drawn.labelAnchor.x,
        drawn.labelAnchor.y,
        chipSeatHalfW(rateChipText(edge), false),
      );
      continue;
    }
    // Every trunk draws one aggregate chip, on its owner, and every member its
    // own rate on the stretch that is its alone.
    if (isTrunkOwner(data)) {
      push(
        edge,
        "fanout-agg",
        drawn.trunkAnchor.x,
        drawn.trunkAnchor.y,
        chipSeatHalfW(aggregateChipText(edge), false),
      );
    }
    push(
      edge,
      "fanout-branch",
      drawn.branchAnchor.x,
      drawn.branchAnchor.y,
      chipSeatHalfW(branchChipText(edge), false),
    );
  }
  return out;
}

// Content bounding box (flow coords) covering both the node cards AND every
// chip box, for the camera fit. React Flow's fitView frames node cards only, so
// a chip standing on a routed leg outside the cards lands outside the framed
// region and clips at the viewport rim. This unions the node cards with each
// chip's box at its RULE anchor: the anchor comes from the same path builder
// the render component calls, so every unioned box is a drawn box. Padding
// instead by a worst-case pad framed all four sides as if the widest chip
// existed at every corner, which depressed the fit zoom on dense plans. Pure
// and deterministic, and recomputing the anchors here rather than reading a
// stamped centre keeps the rect right after a node drag. Null for an empty
// graph.
export function contentBounds(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): ContentRect | null {
  if (nodes.length === 0) return null;
  const byId = nodeIndexOf(nodes);

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const n of nodes) {
    const r = nodeRectOf(n, byId);
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }

  // One chip box each, at the rule anchor its render component draws it at. The
  // half-width is the box that chip's own text draws, the same reservation the
  // anchor rule seats by -- not the widest box a chip may ever take.
  for (const chip of seatedChipBoxes(nodes, edges)) {
    left = Math.min(left, chip.x - chip.halfW);
    right = Math.max(right, chip.x + chip.halfW);
    top = Math.min(top, chip.y - chip.halfH);
    bottom = Math.max(bottom, chip.y + chip.halfH);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
