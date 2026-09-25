import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type Edge,
  type EdgeProps,
  type ReactFlowState,
} from "@xyflow/react";
import { useCallback, useMemo } from "react";
import type Fraction from "fraction.js";
import type { ItemId, TransportKindId } from "../pipeline/types";
import { useI18n } from "../data/i18n-context";
import { formatRateExactPerMin } from "../data/rate-format";
import { aggregateChipText, rateChipText } from "./chipMetrics";
// Type-only: the trunk-aggregate stamps routeTrunkEdges puts on a far owner,
// plus the trunk membership it stamps on every member. Erased at compile time,
// so it adds no runtime or bundler edge.
import type { BusAggregate, TrunkMembership } from "./busRouting";
import {
  CHIP_ICON_ONLY_MAX_ZOOM,
  LABEL_MIN_ZOOM,
  portRowStampLive,
} from "./dimensions";
import {
  drawnEdge,
  parsePathPoints,
  sharedStretches,
  type DrawnEdge,
  type RoutingHints,
  type SharedStretch,
} from "./edgePath";
import { useSegmentHover } from "./hoverSegment";
import { useEffectiveZoomSelect } from "./exportMode";
import {
  crossingCueRadius,
  crossingPartnerBits,
  liveCrossingCues,
  stampOnOwnPolyline,
  type CrossingCue,
} from "./crossings";
import { iconIdForItem } from "./iconSprite";
import { itemColor } from "./itemColor";
import { Sprite } from "./RecipeNode";
import { BELT_COLOR, GAS_COLOR, PIPE_COLOR } from "./transportPalette";

// The stamped routing hints (and their docs) live in edgePath's RoutingHints.
// The trunk-aggregate fields intersected in at the end are set on at most ONE
// item edge per fan-out trunk: the far owner routeTrunkEdges elects for a trunk
// with no near member, which draws that trunk's total beside its own rate.
export type ItemEdgeData = RoutingHints & {
  item: ItemId;
  rate: Fraction;
  // Per-edge transport phase (belt, pipe, or gas, with room to grow). Picks the
  // no-item fallback stroke colour below; the drawn line is the same for every
  // kind. It is optional so callers that have not wired it through yet,
  // including older fixtures and tests, still render with the belt default; an
  // unknown value also lands on the belt default instead of throwing.
  transportKind?: TransportKindId;
  // Set only on an edge landing on a catalyst row's `cat:` port, mirroring
  // RenderEdge.toPortKind. The geometry readers pick the target row's column
  // from it: a card can carry the same item on an input row and a catalyst row,
  // so the item alone cannot say which row an edge arrives at.
  toPortKind?: "catalyst";
  // Set on every edge leaving the catalyst boundary pool, mirroring
  // RenderEdge.fromPool. It dashes the stroke (CATALYST_DASH), so a cycled
  // charge is told from a raw draw of the same item without a second colour.
  // Not the mirror of toPortKind: the pool's aggregate-to-slice edge lands on
  // no catalyst row and still carries it.
  fromPool?: "catalyst";
  // Set by Canvas's hover focus on every non-focused edge. The chips read it
  // because EdgeLabelRenderer portals them outside the edge wrapper that carries
  // the `dimmed` class, so the wrapper's fade never reaches them; the chip's own
  // .flow-chip.dimmed rule does. Optional and defaults to falsy (idle / lit).
  dimmed?: boolean;
  // Set by Canvas's hover focus on every LIT edge. The chips read it to survive
  // the zoom LOD gates, so the hover answers the rate question it asks instead
  // of lighting an edge that shows no number. Optional, defaults to falsy.
  focused?: boolean;
  // Set beside `dimmed` on the member that DRAWS a trunk's aggregate while a
  // branch of that trunk is hovered. The member is not part of the branch's
  // focus set -- its stroke fades with every other sibling -- but the trunk's
  // total and its junction dot are still what the reader is looking at, so those
  // two keep full opacity. Deliberately not `focused`: that would un-dim the
  // stroke and lift the zoom gate as well.
  aggregateLit?: boolean;
  // Declined fan-out marker (deconflictChipAnchors, #43). Where N >= 2 edges of
  // the same (item, source) run to >= 2 distinct targets but their span falls
  // outside routeTrunkEdges' band, no bus trunk forms: the members stay plain
  // item edges that leave the shared out-port coincident and peel off one at a
  // time, so the run reads as a single line carrying one member's rate. These
  // fields are stamped on the ONE elected owner item edge of such a group (the
  // point is on every member's line, so any of them could draw it) and mark the
  // x where the first member leaves the source row, at the source port y. A
  // group whose members all bind to one target is a parallel bundle, not a
  // split, and gets nothing; nor does one where no member ever leaves the row.
  fanoutJunctionX?: number;
  fanoutJunctionY?: number;
  // Fan-in convergence marker (deconflictChipAnchors), the mirror of the pair
  // above. A fan-in trunk whose members ALL reach their target from two or more
  // layers back is drawn from plain item edges pinned to one column, so no
  // BusEdge draws its merge dot: these fields are stamped on the ONE elected
  // member and mark the trunk's merge point -- one chamfer past the shared
  // column, on the target port's row, exactly where a
  // retyped member's shape would put it. A trunk with a single far member gets
  // nothing: one line merges with nothing.
  faninJunctionX?: number;
  faninJunctionY?: number;
  // Crossing cues (deconflictChipAnchors). Where this edge's polyline
  // properly crosses a DIFFERENT flow's polyline (different item|source),
  // the seating pass stamps the crossing point on ONE edge of the pair --
  // this one -- with every edge crossing it there as a partner. The
  // renderer masks this edge's own stroke out around each point (see
  // CrossingCueMask): the gap is transparent, so the other stroke shows
  // through it and this flow reads as passing under, and nothing beneath
  // the pair (a slab tint, a band tint, their hairlines) is painted over.
  // A transparent gap reads the same whichever edge paints above, so no z
  // ruling is taken at seating and none can be flipped by a selection
  // lifting a node's edges (React Flow elevates a selected node to z 1000
  // by default, and a drag auto-selects). A bare X of two continuous
  // strokes reads as a join; the gap is what says "crossing, not a merge".
  // Strict-interior crossing semantics (crossings.ts) mean a collinear
  // fan-in run and a shared fan-out trunk -- including the far members
  // riding its junction column as plain item edges, whose verticals overlap
  // collinearly on that column -- can never produce a stamp. Cues render
  // only while the crossing
  // still stands on BOTH sides: the stamp must sit on this edge's own live
  // polyline (the shared stale-stamp rule) AND at least one recorded
  // partner edge must still exist with both endpoints within the stale eps
  // of the stamped anchors (see useLiveCrossingCues), so a node drag on
  // EITHER side of the pair drops the gap instead of floating it.
  crossingCues?: ReadonlyArray<CrossingCue>;
} & Partial<BusAggregate> &
  TrunkMembership;

// Physical stroke-width bounds. Edge strokes are drawn in graph units, so the
// pane zoom scales them: at fit zoom a 1-unit stroke is a sub-pixel hairline. To
// keep edges visible the width is set to 1/zoom (so it renders near-constant on
// screen), clamped to this physical-pixel range so it neither vanishes at low
// zoom nor bloats into a slab. Published by Canvas on its theme container as
// --edge-base-width, so a zoom tick restyles every edge without re-rendering
// one, and the hover emphasis rule scales relative to it.
const MIN_EDGE_PX = 1;
const MAX_EDGE_PX = 3;

// Zoom-compensated stroke width in physical px, clamped to [MIN_EDGE_PX,
// MAX_EDGE_PX]. At zoom 1 this is 1px (unchanged from the default).
export function edgeStrokeWidth(zoom: number): number {
  return Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, 1 / zoom));
}

// Canvas's hover focus stamps `dimmed` / `focused` onto a copy of an edge's
// data, so every hover change hands each edge a new data object. Nothing the
// edge memoizes reads either flag, so the memos key on the data the copy was
// made from (focusSourceOf) and a hover change leaves the geometry and the
// rate strings alone.
const focusSources = new WeakMap<object, object>();

export function withFocusFlags(
  data: Record<string, unknown> | undefined,
  flags:
    | { dimmed: true }
    | { focused: true }
    | { dimmed: true; aggregateLit: true },
): Record<string, unknown> {
  const copy = { ...data, ...flags };
  if (data !== undefined) focusSources.set(copy, data);
  return copy;
}

export function focusSourceOf<T>(data: T): T {
  if (typeof data !== "object" || data === null) return data;
  return (focusSources.get(data) as T | undefined) ?? data;
}

// Hit width of a shared-stretch path, in graph units. React Flow draws its own
// invisible interaction path over every edge at this width (BaseEdge's
// `interactionWidth` default), and the stretch paths must be exactly as easy to
// point at as the stroke they sit on, so they take the same number.
const EDGE_INTERACTION_WIDTH = 20;

// The transparent hit targets that say "the pointer is on the trunk here": one
// per stretch this edge shares with a trunk (see sharedStretches). They are
// drawn AFTER the stroke so they win the hit test over React Flow's own
// interaction path, carry no ink, and report through the segment-hover context;
// the edge's own enter still fires underneath them, so the segment report only
// refines which part of the edge is under the pointer. A leave without an enter
// on another stretch is the pointer moving onto the member's own leg, which is
// branch mode.
export function SharedStretchPaths({
  edgeId,
  stretches,
}: {
  edgeId: string;
  stretches: ReadonlyArray<SharedStretch>;
}) {
  const segment = useSegmentHover();
  return (
    <>
      {stretches.map(({ group, run }) => (
        <path
          key={group}
          data-testid={`edge-shared-${edgeId}-${group}`}
          d={`M ${run.lo},${run.y} L ${run.hi},${run.y}`}
          fill="none"
          stroke="transparent"
          strokeWidth={EDGE_INTERACTION_WIDTH}
          style={{ pointerEvents: "stroke" }}
          onMouseEnter={() => segment.enter(edgeId, group)}
          onMouseLeave={() => segment.leave(edgeId)}
        />
      ))}
    </>
  );
}

// Inline style carrying the chip's accent color as the --chip-accent custom
// property, or an empty object when there is no item to color by. Both edge
// components spread this onto their flow-chip so the chip tints to the item.
function chipAccentStyle(item?: ItemId): React.CSSProperties {
  return item !== undefined
    ? { ["--chip-accent" as string]: itemColor(item) }
    : {};
}

// FlowChip: the shared EdgeLabelRenderer chip every edge label uses -- the rate
// chip at ItemEdge's bend column and BusEdge's drop / rise chips on the trunk. One place owns the DOM contract: a nodrag/nopan .flow-chip div centered
// on (x, y) by the double translate, tinted to the item through
// chipAccentStyle, carrying the full "Name x rate/min" string on aria-label and
// title, with an optional 16px item sprite followed by the optional chip text.
// `dimmed` appends the `dimmed` class so a chip fades with its edge under the
// hover ego-network (the edge wrapper's own dim never reaches the portaled
// chip).
export function FlowChip({
  testId,
  edgeId,
  x,
  y,
  item,
  text,
  label,
  title,
  dimmed,
  focused,
  belowDigitsGate,
  onMouseEnter,
  onMouseLeave,
}: {
  testId: string;
  // Owning edge id, emitted as data-edge-id so the geometry audit can exempt an
  // edge's own chips when testing edge segments against foreign chip boxes.
  edgeId?: string | undefined;
  x: number;
  y: number;
  item?: ItemId | undefined;
  text?: string | undefined;
  label: string;
  // Hover-tooltip text. Defaults to `label`; edges pass the exact, un-rounded
  // rate here so hovering reveals the precise value the rounded chip text hides.
  title?: string | undefined;
  dimmed?: boolean | undefined;
  // Set on a hover-lit edge's chip: it keeps its digits below the icon-only
  // zoom so the hover surfaces the rate.
  focused?: boolean | undefined;
  // True while the live pane zoom sits below CHIP_ICON_ONLY_MAX_ZOOM, read only
  // for the digits gate: a chip draws its box at its natural size at every
  // zoom. Optional -- a caller without it draws the full chip.
  belowDigitsGate?: boolean | undefined;
  // Set by the aggregate chips alone. A chip's enter reaches its own edge's
  // handler through the portal's fiber chain, which is branch mode -- right for
  // a chip stating one member's rate, wrong for one stating the TRUNK's total.
  // Those two pass the trunk's segment report here instead.
  onMouseEnter?: (() => void) | undefined;
  onMouseLeave?: (() => void) | undefined;
}) {
  // Below the digits gate every chip sheds its rate digits and renders as the
  // bare item icon, so a dense fit view stops blanketing. The exact rate stays
  // on the title tooltip. Chips below the mount gate never reach here: their
  // call sites drop them. The hover reveal overrides the gate, so no chip is
  // permanently rate-less.
  const iconOnly = belowDigitsGate === true && !focused;
  const bodyText = iconOnly ? "" : text;
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        {...(edgeId !== undefined ? { "data-edge-id": edgeId } : {})}
        className={
          "nodrag nopan flow-chip" +
          (iconOnly ? " icon-only" : "") +
          (dimmed ? " dimmed" : "")
        }
        aria-label={label}
        title={title ?? label}
        {...(onMouseEnter !== undefined ? { onMouseEnter } : {})}
        {...(onMouseLeave !== undefined ? { onMouseLeave } : {})}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          whiteSpace: "nowrap",
          ...chipAccentStyle(item),
        }}
      >
        {/* An icon-less item that collapses leaves the box EMPTY on purpose: it
            stays a tinted hover target carrying title/aria-label. */}
        <Sprite iconId={iconIdForItem(item)} size={16} />
        {/* The text rides in its own span so the .flow-chip max-width clamp can
            ellipsize it (text-overflow does not reach a bare text node inside a
            flex container). The title attribute above keeps the full value. An
            icon-only chip has no body at all. */}
        {bodyText ? <span className="chip-text">{bodyText}</span> : null}
      </div>
    </EdgeLabelRenderer>
  );
}

// Radius of a junction dot -- the small filled circle a trunk member draws
// where its own line joins the stretch its trunk shares -- in graph units.
const JUNCTION_RADIUS = 3;

// Junction-dot screen-radius bounds, in physical px. The dot is drawn in graph
// units, so the pane zoom scales it (on-screen radius = r * zoom): at the
// dense-plan fit zoom a 3-unit dot is a sub-pixel speck. Counter-scale it like
// the stroke clamp so the dot holds a legible on-screen radius clamped to this
// range across zoom.
const JUNCTION_MIN_PX = 3;
const JUNCTION_MAX_PX = 5;

// Graph-unit radius that renders the junction dot at a screen radius clamped to
// [JUNCTION_MIN_PX, JUNCTION_MAX_PX]. At zoom 1 this is the natural
// JUNCTION_RADIUS; below it the graph radius grows to hold the pixel floor,
// above it the dot stops growing at the pixel cap. zoom is always > 0 (the pane
// clamps minZoom well above zero).
export function junctionRadius(zoom: number): number {
  const screen = Math.min(
    JUNCTION_MAX_PX,
    Math.max(JUNCTION_MIN_PX, JUNCTION_RADIUS * zoom),
  );
  return screen / zoom;
}

// Crossing-cue mask: the cut-outs an edge renderer applies to its OWN
// stroke at every point where its polyline properly crosses a DIFFERENT
// flow's and the seating pass stamped this edge as the one passing under
// (see chipSeating Phase 0c). An SVG <mask> in the edge's own group -- a
// white field with a black disc per cue -- applied to the path group, so
// the stroke simply is not drawn inside the disc: the crossing stroke shows
// through a transparent gap and everything painted beneath the pair (slab
// and band tints, hairlines) stays intact, which a background-coloured
// disc drawn over the crossing could not promise. Because the gap is a
// hole in this stroke rather than paint over the other, the picture is the
// same whichever edge's svg paints above. Radius via crossingCueRadius so
// the gap holds a clamped on-screen width across zoom like the junction
// dot. The disc keeps the edge-crossing-cue testid: it is the drawn cue's
// location, read by the e2e cue coverage audit. Shared by ItemEdge and
// BusEdge; the mask id is derived from the edge id so it is unique per
// edge and stable across renders.
const CUE_MASK_EXTENT = 1_000_000;

function crossingCueMaskId(edgeId: string): string {
  return `cue-mask-${edgeId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function CrossingCueMask({
  id,
  cues,
}: {
  id: string;
  cues: ReadonlyArray<{ x: number; y: number }>;
}) {
  // The radius follows the zoom continuously, so the mask subscribes to it
  // itself rather than re-rendering its whole edge on every tick. A cue-less
  // mask selects a constant and never re-renders for zoom.
  const r = useEffectiveZoomSelect((zoom) =>
    cues.length === 0 ? 0 : crossingCueRadius(zoom),
  );
  if (cues.length === 0) return null;
  const half = CUE_MASK_EXTENT / 2;
  return (
    <defs>
      <mask
        id={id}
        maskUnits="userSpaceOnUse"
        x={-half}
        y={-half}
        width={CUE_MASK_EXTENT}
        height={CUE_MASK_EXTENT}
      >
        <rect
          x={-half}
          y={-half}
          width={CUE_MASK_EXTENT}
          height={CUE_MASK_EXTENT}
          fill="white"
        />
        {cues.map((c, i) => (
          <circle
            key={`${c.x},${c.y}` + (i === 0 ? "" : `#${i}`)}
            data-testid="edge-crossing-cue"
            cx={c.x}
            cy={c.y}
            r={r}
            fill="black"
          />
        ))}
      </mask>
    </defs>
  );
}

// Value equality for the partner-bits subscription below. The default
// Object.is would see a fresh array on every store tick; comparing by
// content means an edge re-renders only when one of its cues' partner bits
// actually FLIPS -- once per partner drag, at the moment the drift crosses
// the eps -- not on every position update of the drag.
const partnerBitsEqual = (
  a: ReadonlyArray<boolean>,
  b: ReadonlyArray<boolean>,
): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// The cue-liveness filter with its store-fed half: liveCrossingCues checks
// each stamp against this edge's OWN polyline (pure geometry, no store), and
// the partner bits come from a narrow React Flow store subscription -- one
// Map.get per partner for its edge, then one per endpoint node, no
// store-wide iteration -- so an edge re-renders exactly when a partner's
// existence or anchor liveness changes. Without the partner half, a dragged
// partner edge left this edge's gap cut where nothing crosses anymore (the
// seating pass reruns only at the drop). A cue-less edge -- almost every edge
// -- pays nothing per store tick: its selector returns one shared empty
// array, so the equality check short-circuits on identity, and the filter
// result is memoized so the per-render geometry runs only when a stamp, the
// polyline or a partner bit actually changed. Shared by ItemEdge and
// BusEdge; see crossingPartnerBits (crossings.ts) for the eps and the
// record shape.
const NO_BITS: ReadonlyArray<boolean> = [];

function useLiveCrossingCues(
  cues: ReadonlyArray<CrossingCue> | undefined,
  ownPts: ReadonlyArray<readonly [number, number]>,
): Array<{ x: number; y: number }> {
  const selector = useCallback(
    (state: ReactFlowState) =>
      cues === undefined || cues.length === 0
        ? NO_BITS
        : crossingPartnerBits(cues, state),
    [cues],
  );
  const bits = useStore(selector, partnerBitsEqual);
  return useMemo(
    () => liveCrossingCues(cues, ownPts, (_, i) => bits[i] === true),
    [cues, ownPts, bits],
  );
}

// Stable empty vertex list for MaskedEdge's memoized cue parse below (shared by
// both edge components): a cue-less edge returns it instead of allocating, and
// the consumer has already answered "no stamp" by then, so the shared identity
// is all that matters.
const NO_CUE_PTS: ReadonlyArray<readonly [number, number]> = [];

// Which family of junction a dot marks. The testid alone cannot tell them
// apart, so the geometry audit needs the family as its own hook. Same three
// names chipSeating's junction-dot kind uses; declared here rather than
// imported to keep that type unexported.
export type JunctionFamily = "fanout" | "fanin" | "divergence";

// The merge junction dot, portaled into the shared edgelabel-renderer layer (not
// an SVG circle in the edge group) so it shares the chips' stacking context: it
// sits BELOW the flow chips (.bus-junction z-index 1 vs .flow-chip z-index 2 in
// canvas.css), so an overlapping aggregate chip's digits win. Sized in graph
// units via junctionRadius so the pane zoom renders it at a clamped screen
// radius. Threads the same `dimmed` state the chips do. Shared by BusEdge (the
// two trunk dots) and ItemEdge (the declined-fan-out divergence dot).
export function JunctionDot({
  testId,
  family,
  x,
  y,
  color,
  dimmed,
}: {
  testId: string;
  family: JunctionFamily;
  x: number;
  y: number;
  color: string;
  dimmed?: boolean | undefined;
}) {
  // Subscribed here rather than in the owning edge: the radius follows the
  // zoom continuously, and only the dot needs to redraw for it.
  const radius = useEffectiveZoomSelect(junctionRadius);
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={testId}
        data-family={family}
        aria-hidden="true"
        className={"bus-junction" + (dimmed ? " dimmed" : "")}
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          width: `${2 * radius}px`,
          height: `${2 * radius}px`,
          background: color,
        }}
      />
    </EdgeLabelRenderer>
  );
}

// Line style says ROLE, not carrier: every edge that moves material is drawn
// solid, belt, pipe and gas alike, and only a catalyst supply edge is dashed
// (see CATALYST_DASH). Transport kind is carried by the port glyph instead.
// So the kind decides colour and nothing else here, and even that only as a
// fallback: with an item id the colour comes from itemColor, so the same item
// reads the same on every edge, and the transport palette shows through only on
// the item-less edges older fixtures and tests build. Unknown kinds fall
// through to the belt default on purpose. The real guard against bad data
// happens at load time; this render-time fallback just keeps the UI alive.
export function strokeColorForKind(
  kind: TransportKindId | undefined,
  itemId?: ItemId,
): string {
  if (itemId !== undefined) {
    return itemColor(itemId);
  }
  if (kind === "gas") {
    return GAS_COLOR;
  }
  if (kind === "pipe") {
    return PIPE_COLOR;
  }
  return BELT_COLOR;
}

// The drawn stroke style both edge components hand to BaseEdge: the kind's
// stroke colour, plus the zoom-compensated base width Canvas publishes as
// --edge-base-width (see edgeStrokeWidth). A caller-supplied style wins over
// these defaults, so later overrides for hover, tear edges or cross-group edges
// take effect without this file knowing about them. The stroke colour is returned alongside because both components also
// paint their junction dots with it.
export function edgeStrokeStyle(
  kind: TransportKindId | undefined,
  itemId: ItemId | undefined,
  style: React.CSSProperties | undefined,
): { stroke: string; style: React.CSSProperties } {
  const stroke = strokeColorForKind(kind, itemId);
  return {
    stroke,
    style: {
      stroke,
      strokeWidth: "var(--edge-base-width)",
      ...(style ?? {}),
    },
  };
}

// The catalyst pool's mark on the line: a supply edge keeps its item colour and
// is dashed, while every material edge stays solid. The lengths are graph units
// like the geometry around them, so the pattern holds its proportion to the
// path across zoom, and butt caps (the SVG default, nothing overrides linecap
// on an edge path) keep the gaps square rather than closing them at width.
const CATALYST_DASH = "5 3";

// The painted edge line, shared by ItemEdge and BusEdge. It owns the whole
// drawn-stroke contract: the crossing-cue mask (this edge's stroke is cut out
// around every proper crossing it was stamped as passing under, so the other
// flow's stroke shows through a transparent gap and nothing beneath the pair is
// painted over), the aria-label, the markerEnd arrow, and the
// data-transport-kind / data-pool stamps selectors and the exam probes read the
// edge's phase and pool from. The cue stamps are filtered here rather than by
// the callers, so both components pay the same one-parse-per-edge-per-path cost
// and neither can drift from the stale-stamp rule. data-transport-kind is
// omitted entirely when the edge carries no kind, so a selector can still tell
// a real belt from an unclassified legacy edge.
export function MaskedEdge({
  id,
  path,
  style,
  cues,
  ariaLabel,
  transportKind,
  fromPool,
  markerEnd,
}: {
  id: string;
  path: string;
  style: React.CSSProperties;
  cues: ReadonlyArray<CrossingCue> | undefined;
  ariaLabel?: string | undefined;
  transportKind?: TransportKindId | undefined;
  // Source boundary pool, stamped on the base path as data-pool and, for the
  // catalyst pool, drawn as CATALYST_DASH. The dash is applied here rather than
  // in edgeStrokeStyle so both of the pool's marks sit at one site; it also
  // means it beats a caller-supplied strokeDasharray, which no caller sets.
  fromPool?: "catalyst" | undefined;
  markerEnd?: string | undefined;
}) {
  // Parse the own polyline for the cue filter once per (path, cue stamp),
  // never once per render: the callers re-render on every endpoint move and
  // zoom-gate flip, and with the parse in argument position every render
  // re-ran it -- a regex matchAll plus a tuple per vertex -- on
  // every mounted edge, cue-carrying or not, before the callee's cue early-out
  // could skip it. The stamp gate runs first (a cue-less edge never parses at
  // all) and the memo holds the survivors' parse across those renders; the same
  // one-parse-per-edge hoist the seating pass documents on pathPointAtPts.
  const cuePts = useMemo(
    () => (cues?.length ? parsePathPoints(path) : NO_CUE_PTS),
    [path, cues],
  );
  // Filtered to the stamps whose crossing still stands on BOTH sides -- the
  // stamp sits on THIS edge's live polyline (the stale-stamp rule) and a
  // stamped partner edge has not moved or vanished (see useLiveCrossingCues).
  const liveCues = useLiveCrossingCues(cues, cuePts);
  const maskId = crossingCueMaskId(id);
  return (
    <>
      <CrossingCueMask id={maskId} cues={liveCues} />
      <g mask={liveCues.length > 0 ? `url(#${maskId})` : undefined}>
        <BaseEdge
          id={id}
          path={path}
          style={
            fromPool === "catalyst"
              ? { ...style, strokeDasharray: CATALYST_DASH }
              : style
          }
          {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
          {...(transportKind !== undefined
            ? { "data-transport-kind": transportKind }
            : {})}
          {...(fromPool !== undefined ? { "data-pool": fromPool } : {})}
          {...(markerEnd ? { markerEnd } : {})}
        />
      </g>
    </>
  );
}

// The "Name x value" composition every chip label and tooltip is built from.
// The value half differs per chip -- a rounded rate with its unit, the exact
// rate, or a localized share phrase -- so it arrives already composed; only the
// separator lives here, and it is byte-identical across all of them.
export function rateLabel(name: string, value: string): string {
  return `${name} x ${value}`;
}

export default function ItemEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const edgeData = data as ItemEdgeData | undefined;
  const sourceData = focusSourceOf(edgeData);
  const segment = useSegmentHover();
  // The PNG export rasterizes at unit scale, so every zoom gate below reads 1
  // and the image keeps full detail whatever the camera was parked at.
  const labelsShown = useEffectiveZoomSelect((zoom) => zoom >= LABEL_MIN_ZOOM);
  const belowDigitsGate = useEffectiveZoomSelect(
    (zoom) => zoom < CHIP_ICON_ONLY_MAX_ZOOM,
  );
  const i18n = useI18n();
  // The chip body comes from the builder the seat reserves its box by, so the
  // drawn text and the reserved width cannot disagree.
  const rateStr = useMemo(
    () =>
      rateChipText({ id: "", source: "", target: "", data: sourceData } as Edge)
        ?.body ?? "",
    [sourceData],
  );
  const unit = i18n.t("canvas.rate.unit");
  // The chip body shows the icon plus the rounded rate and unit, nothing more.
  // The full "Name x rate/min" string rides on aria-label so a screen reader can
  // name the item, and a separate tooltip carries the exact, un-rounded rate the
  // rounding hides (chips now accept pointer events, so hovering shows it).
  // The declined fan-out dot sits at the SOURCE port row, so it is checked
  // against the live source y.
  const fanoutMarkerLive =
    edgeData?.fanoutJunctionY !== undefined &&
    portRowStampLive(edgeData.fanoutJunctionY, sourceY);
  // The fan-in convergence dot sits at the TARGET port row, so it is checked
  // against the live target y.
  const faninMarkerLive =
    edgeData?.faninJunctionY !== undefined &&
    portRowStampLive(edgeData.faninJunctionY, targetY);
  // The label pair is BigInt Fraction work (the exact half re-formats the
  // rational in full), and the edge re-renders on every endpoint move and
  // zoom-gate flip, so it is memoized on what it actually reads: this edge's
  // item and rate, and the locale that names and formats them.
  const item = edgeData?.item;
  const rate = edgeData?.rate;
  const { fullLabel, exactTitle } = useMemo(
    () =>
      item !== undefined && rate !== undefined && rateStr
        ? {
            fullLabel: rateLabel(i18n.displayName(item), `${rateStr}${unit}`),
            exactTitle: rateLabel(
              i18n.displayName(item),
              `${formatRateExactPerMin(rate)}${unit}`,
            ),
          }
        : { fullLabel: "", exactTitle: "" },
    [item, rate, rateStr, unit, i18n],
  );

  // The trunk total this edge carries when it is the elected far owner of a
  // fan-out with no near member: the same builder, wording and unit BusEdge's
  // drop chip uses, so the two states of one contract read alike. Empty on
  // every other item edge, where the payload carries no total.
  const totalStr = useMemo(
    () =>
      aggregateChipText({
        id: "",
        source: "",
        target: "",
        data: sourceData,
      } as Edge)?.body ?? "",
    [sourceData],
  );
  const total = (sourceData as ItemEdgeData | undefined)?.busTotalRate;
  const { totalLabel, totalTitle } = useMemo(
    () =>
      item !== undefined && total !== undefined && totalStr
        ? {
            totalLabel: rateLabel(i18n.displayName(item), `${totalStr}${unit}`),
            totalTitle: rateLabel(
              i18n.displayName(item),
              `${formatRateExactPerMin(total)}${unit}`,
            ),
          }
        : { totalLabel: "", totalTitle: "" },
    [item, total, totalStr, unit, i18n],
  );

  // The drawn shape of this edge: the polyline, its vertices and its label
  // anchor, resolved by drawnEdge from the live React Flow endpoints and this
  // edge's stamped data, so the render and the bookkeeping pass's
  // reconstruction read one derivation. The anchor is the centre of the
  // polyline's longest horizontal run, and that is where the chip draws:
  // nothing seats or moves it afterwards.
  // This component renders the "item" edge type alone (Canvas's edgeTypes map),
  // the type drawnEdge answers with the item shape, so the union's two bus arms
  // are unreachable here.
  // Memoized on the endpoints and edge data: the geometry does not depend on
  // zoom, and the zoom-gate subscriptions above re-render the edge when a gate
  // flips.
  const drawn = useMemo(
    () =>
      drawnEdge(
        { sourceX, sourceY, targetX, targetY },
        "item",
        sourceData,
      ) as Extract<DrawnEdge, { shape: "item" }>,
    [sourceX, sourceY, targetX, targetY, sourceData],
  );
  const edgePath = drawn.path;
  const { x: labelX, y: labelY } = drawn.labelAnchor;

  // The stretches this member shares with the trunks it belongs to: a far
  // member's borrowed column or a backward member's rail makes one end of its
  // line the trunk's own. Memoized on the drawn shape and the payload for the
  // same reason the shape is.
  const stretches = useMemo(
    () => sharedStretches(drawn, { source, target, data: sourceData }),
    [drawn, source, target, sourceData],
  );
  // The trunk's total and its junction dots survive the dim of a branch hover
  // elsewhere in the trunk; the member's own rate chip does not.
  const dimmed = edgeData?.dimmed === true;
  const trunkChromeDimmed = dimmed && edgeData?.aggregateLit !== true;

  // Both junction dots mark a point the seating pass found on a GROUP of edges
  // -- where the last member merges into one port, where the first member of a
  // declined fan-out peels off -- so neither is recomputable here: the group is
  // not reachable from an edge's own props. What this edge can still say is
  // whether the stamp is on the line it just drew, the same corroboration the
  // crossing cues get. That is what makes a drag on x alone visible: it leaves
  // the port ROW where it was, so the row checks above keep the dot, while the
  // line slides out from under the stamp and this drops it. The vertices come
  // from the drawn shape above, so the check costs no second parse of the path
  // this render just built.
  const dotPts = drawn.pts;
  const fanoutDotLive =
    fanoutMarkerLive &&
    edgeData?.fanoutJunctionX !== undefined &&
    stampOnOwnPolyline(
      [edgeData.fanoutJunctionX, edgeData.fanoutJunctionY!],
      dotPts,
    );
  const faninDotLive =
    faninMarkerLive &&
    edgeData?.faninJunctionX !== undefined &&
    stampOnOwnPolyline(
      [edgeData.faninJunctionX, edgeData.faninJunctionY!],
      dotPts,
    );

  // The zoom gate yields to the hover focus: a lit edge shows its rate at any
  // zoom. Nothing else can take a chip away: no chip is hidden for lack of
  // room.
  const chipText =
    edgeData && rateStr && (labelsShown || edgeData.focused === true)
      ? `${rateStr}${unit}`
      : "";
  // The trunk total draws only where the shape seated an anchor for it, under
  // the label chip's own gates: a drag that re-routes this member off the trunk
  // drops the anchor and the chip with it.
  const totalText =
    drawn.trunkAnchor !== undefined &&
    totalStr &&
    (labelsShown || edgeData?.focused === true)
      ? `${totalStr}${unit}`
      : "";

  const { stroke, style: mergedStyle } = edgeStrokeStyle(
    edgeData?.transportKind,
    edgeData?.item,
    style,
  );

  return (
    <>
      <MaskedEdge
        id={id}
        path={edgePath}
        style={mergedStyle}
        cues={edgeData?.crossingCues}
        ariaLabel={fullLabel}
        transportKind={edgeData?.transportKind}
        fromPool={edgeData?.fromPool}
        markerEnd={markerEnd}
      />
      <SharedStretchPaths edgeId={id} stretches={stretches} />
      {chipText ? (
        <FlowChip
          testId={`item-edge-label-${id}`}
          edgeId={id}
          x={labelX}
          y={labelY}
          item={edgeData?.item}
          text={chipText}
          label={fullLabel}
          title={exactTitle}
          dimmed={edgeData?.dimmed}
          focused={edgeData?.focused}
          belowDigitsGate={belowDigitsGate}
        />
      ) : null}
      {/* The trunk's aggregate, on the far owner's source stub: the counterpart
          of the drop chip a retyped member draws from BusEdge, on the one item
          shape that carries a trunk's aggregate stamps. */}
      {totalText && drawn.trunkAnchor !== undefined ? (
        <FlowChip
          testId={`item-edge-${id}-drop`}
          edgeId={id}
          x={drawn.trunkAnchor.x}
          y={drawn.trunkAnchor.y}
          item={edgeData?.item}
          text={totalText}
          label={totalLabel}
          title={totalTitle}
          dimmed={trunkChromeDimmed}
          focused={edgeData?.focused}
          belowDigitsGate={belowDigitsGate}
          {...(edgeData?.trunkKey !== undefined
            ? {
                onMouseEnter: () => segment.enter(id, edgeData.trunkKey!),
                onMouseLeave: () => segment.leave(id),
              }
            : {})}
        />
      ) : null}
      {/* Declined fan-out divergence dot (#43, owner only): where coincident
          same-flow item edges leave the shared out-port run for their own
          targets. Same markup and stacking as the fan-in merge dot; dropped
          while stale against the live source y or the live line. */}
      {fanoutDotLive && edgeData?.fanoutJunctionX !== undefined ? (
        <JunctionDot
          testId={`fanout-junction-${id}`}
          family="divergence"
          x={edgeData.fanoutJunctionX}
          y={edgeData.fanoutJunctionY!}
          color={stroke}
          dimmed={trunkChromeDimmed}
        />
      ) : null}
      {/* Fan-in convergence dot (owner only): where the far members of one
          trunk, drawn as plain item edges pinned to a shared column, first
          coincide on the target row. Same markup and stacking as the merge dot
          a retyped member draws from BusEdge; dropped while stale against the
          live target y or the live line. */}
      {faninDotLive && edgeData?.faninJunctionX !== undefined ? (
        <JunctionDot
          testId={`fanin-junction-${id}`}
          family="fanin"
          x={edgeData.faninJunctionX}
          y={edgeData.faninJunctionY!}
          color={stroke}
          dimmed={trunkChromeDimmed}
        />
      ) : null}
    </>
  );
}
