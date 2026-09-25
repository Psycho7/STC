// Custom orthogonal edge-path builder for the blueprint canvas.
//
// Replaces React Flow's getSmoothStepPath with a chamfered variant: every turn
// is a 45-degree corner cut instead of a rounded arc, and edges leave and enter
// ports through a minimum straight stub. Routing semantics (which edges exist)
// are decided elsewhere; this module only decides how a given (source, target)
// pair is drawn as a polyline.
//
// Every function is pure (no React, no Date/random, no input mutation) and
// rounds coordinates to two decimals so pinned test strings stay stable.
//
// Handle geometry the whole module relies on: sources are always Position.Right
// and targets always Position.Left (see RecipeNode/ProductNode/LoopNode). So a
// path always leaves rightward and must approach the target horizontally
// rightward into its Left handle, in every case, so the ArrowClosed marker
// (orient=auto) points right.

import { DOT_KEEPOFF } from "./dimensions";
import {
  CHIP_HALF_H,
  CHIP_HALF_W_WIDE,
  chipHalfWidthsOf,
  memberHalfWOf,
} from "./chipMetrics";
import { faninKeyOf, flowKeyOf, type Rect } from "./nodeGeometry";
import type { Edge } from "@xyflow/react";

// Minimum straight run leaving a source's Right handle and entering a target's
// Left handle. Keeps the arrow head from sprouting directly out of a corner.
export const PORT_STUB = 24;
// Leg length of the 45-degree corner cut. A corner at point P is replaced by two
// points: one CHAMFER back along the incoming edge and one CHAMFER forward along
// the outgoing edge, so the join reads as a diagonal bevel.
export const CHAMFER = 8;
// Upper bound on an enlarged corner chamfer (P6 aesthetic). When a forward bend
// carries a corridor budget (chamferBudget, stamped by assignBendColumns) its
// two corner bevels grow from the base CHAMFER toward this cap for a PCB-style
// long 45-degree cut, without dominating the run. The chamfer never exceeds this,
// half the shorter adjacent leg, or the stamped budget (see chamferStepPath).
export const MAX_CHAMFER = 24;

// Gap budget for a full symmetric forward shape: one PORT_STUB plus one CHAMFER
// on each side. Below it the forward builders scale their stub and chamfer down
// proportionally (chamferStepPath) and the shape degenerates -- no distinct
// bend column. The routing passes predict that degeneration (whether a member
// claims a gutter column), so they must read this same constant: the drawer
// owns the threshold.
export const FORWARD_STEP_BUDGET = 2 * (PORT_STUB + CHAMFER);

// Round to two decimals so degraded/scaled geometry does not produce long
// floating tails in the emitted `d` string (keeps pinned tests stable).
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

type Vertex = readonly [number, number];

// One emitted vertex, rounded as the `d` string prints it. `+ 0` folds -0 to 0,
// so the tuple equals what parsePathPoints reads back from that string.
function vertex(x: number, y: number): Vertex {
  return [r(x) + 0, r(y) + 0];
}

// Does a coordinate print as the plain decimal parsePathPoints matches? Every
// finite double below 1e21 does, and reads back as the same number.
function printsPlain(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) < 1e21;
}

// A builder's vertex list and the `d` string joined from it once. The vertices
// stand in for a parse of `d`; a coordinate the parser would not read back
// (never emitted in practice) falls back to that parse.
function emitted(pts: Vertex[]): { d: string; pts: ReadonlyArray<Vertex> } {
  const d = "M " + pts.map(([x, y]) => `${x},${y}`).join(" L ");
  const exact = pts.every(([x, y]) => printsPlain(x) && printsPlain(y));
  return { d, pts: exact ? pts : parsePathPoints(d) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Forward-step column geometry shared by the drawer (chamferStepPath's forward
// branch) and the routing passes that must predict where the drawn bend column
// lands (jogForwardLegs). Scales the stub+chamfer budget down proportionally
// when the gap is too narrow for the full symmetric shape, then resolves the
// bend column: the caller's bendX clamped into [lo, hi], or the corridor
// midpoint when the hint is absent or the corridor is too tight to host a
// distinct column. Keeping producer and consumer on one derivation is what
// makes a stamped legY / descentX line up with the drawn path.
export function forwardStepGeometry(
  sx: number,
  tx: number,
  bendX: number | undefined,
): { stub: number; chamfer: number; lo: number; hi: number; bx: number } {
  const gap = tx - sx;
  const scale = gap >= FORWARD_STEP_BUDGET ? 1 : gap / FORWARD_STEP_BUDGET;
  const stub = PORT_STUB * scale;
  const chamfer = CHAMFER * scale;
  const lo = sx + stub + chamfer;
  const hi = tx - stub - chamfer;
  const mid = (sx + tx) / 2;
  const bx = lo < hi && bendX !== undefined ? clamp(bendX, lo, hi) : mid;
  return { stub, chamfer, lo, hi, bx };
}

// THE LATE DROP: the column a forward step's vertical really stands on, given
// the geometry above and the edge's hints. A plain step keeps the SOURCE row
// across the whole gap and drops to the target row at the target's entry column
// (entryX, one slot per entering port row), so two edges into adjacent rows of
// one card share only the approach band right of that column -- the port stub
// plus the chip reserve the gap was widened for -- instead of running one row
// pitch apart the whole way. A jog-cleared source column wins over it:
// jogForwardLegs proved that shape clear of a card and entryX did not. Absent
// both, the staggered bend column stands and the drawn shape is what it was.
//
// An entry column outside the corridor is DECLINED rather than clamped onto its
// margin: the margin is one x for every edge that reaches it, so clamping puts
// two drops that the allocation spaced a slot apart back on one line, while the
// bend column is staggered clear of every pinned column already.
//
// jogForwardLegs has to predict this column -- the long horizontal it tests for
// cards runs from the source port to it -- so, like forwardStepGeometry, the
// drawer and the pass share the one derivation.
export function forwardDropX(
  geom: { lo: number; hi: number; bx: number },
  hints: RoutingHints,
): number {
  if (hints.srcColX !== undefined) return hints.srcColX;
  if (hints.entryX === undefined) return geom.bx;
  const inside = hints.entryX > geom.lo && hints.entryX < geom.hi;
  return inside ? hints.entryX : geom.bx;
}

// Default column and rail geometry of a BACKWARD detour (the target sits at or
// left of the source, so the edge routes right out of the source, along a rail,
// then back into the target's Left port). chamferStepPath draws from these
// unless a routing hint overrides one, and clampBackwardRails resolves its
// clearances starting from the same three values -- so the clamp always begins
// at the shape the drawer would otherwise produce.
//   xr     one stub right of the source port
//   xl     the staggered entry column when the gutter pass staked one out, else
//          one stub before the target port
//   railY  midway between the two port levels; endpoints sharing a y would put
//          the rail on top of both stubs, so it drops below them instead
export function backwardRailDefaults(args: {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  entryX?: number | undefined;
}): { xr: number; xl: number; railY: number } {
  const { sx, sy, tx, ty, entryX } = args;
  return {
    xr: sx + PORT_STUB,
    xl: entryX ?? tx - PORT_STUB,
    railY: sy === ty ? sy + PORT_STUB + 2 * CHAMFER : (sy + ty) / 2,
  };
}

// An axis-aligned card rectangle in absolute graph coordinates, for rail
// obstacle avoidance.
export type ObstacleRect = Rect & {
  // A container slab (group / loop box), not a plain card. clearRailY keeps a
  // detour rail a wider gap off these so the rail no longer hugs the slab border
  // in a near-identical gray (#29). Absent / false on cards and gutters.
  container?: boolean;
};

// Optional per-edge routing hints. The routing passes (busRouting) merge these
// onto edge data, and every consumer of a path builder -- ItemEdge, BusEdge, AND
// the offline chip reconstruction in deconflictChipAnchors -- extracts them with
// routingHintsFromData below. That single extraction point is the lockstep
// contract: a new hint added here and in routingHintsFromData threads to the
// render components and the reconstruction pass at once, instead of silently
// reaching one but not the other.
//   bendX:  bend-column x for a forward step (assignBendColumns), the column it
//           drops at when the target staked out no entry column for it. Absent ->
//           the corridor midpoint.
//   legY:   clear horizontal y for a blocked forward final leg (jogForwardLegs).
//           Present -> the normal forward step bends to this y, runs the long
//           horizontal there clear of any intervening card, then descends /
//           ascends to the target y in the target's entry gutter (jogDescentX,
//           else entryX, else one stub before the port) before the final
//           rightward stub. Absent -> the final leg runs straight at the target
//           y, byte-identical for direct callers.
//   jogDescentX: obstacle-cleared descent column for a jogged forward leg
//           (jogForwardLegs). The vertical run from legY down / up to the target
//           port. Overrides entryX for the jog's descent when present. Absent ->
//           entryX, or one stub before the port.
//   srcColX: obstacle-cleared SOURCE-side column for a forward step whose
//           source horizontal at sy is blocked (jogForwardLegs). Replaces the
//           bend column outright -- the step leaves sy at this column instead
//           of bendX -- and is used unclamped (the routing pass proved it
//           clear; the drawer's [lo, hi] clamp could push it back into the
//           blocked band). Absent -> the clamped bendX / midpoint default.
//   entryX: entry column x (assignEntryColumns), the vertical run into the
//           target's Left port: one slot per entering port row, shared by every
//           edge that arrives on that row. A FORWARD step drops to the target
//           row here (the late drop) instead of at its bend column, and a
//           backward rail ends its left column here. Absent -> the bend column
//           for a forward step, one stub before the port for a rail.
//   railY:  backward-detour rail y (clampBackwardRails) clearing spanned cards.
//           Absent -> midway between the endpoints.
//   railXRight/railXLeft: obstacle-cleared backward-rail verticals
//           (clampBackwardRails). railXRight is the source-side column, absent ->
//           one stub out of the source port. railXLeft is the target-side column
//           and overrides entryX when present, absent -> entryX, or one stub
//           before the target port.
//   junctionX: shared junction column for a trunk member (routeTrunkEdges).
//           Every member of one (item, source) fan-out shares this column:
//           their trunk segments (source port out to the junction) overlap into
//           one line, and each branches off it up / down to its own target. A
//           fan-in member reads it mirrored: each member descends this column
//           to the target row and they share the aggregate leg from there into
//           the port. Absent -> the corridor midpoint (a plain step).
//   faninJoinX: the fan-in column a DUAL member (a fan-out member whose target
//           port also carries a fan-in trunk) hands its flow over at. The drawn
//           polyline is unchanged -- the member's own stretch simply ends
//           there, so its chip anchor is the middle of the run at the target
//           row BETWEEN the two columns instead of the whole final leg. Absent
//           -> the whole leg, byte-identical for a plain fan-out member.
//   faninColumn: this forward item edge's bendX is a SHARED fan-in column
//           (routeTrunkEdges pinned every far member of one (item, target-port)
//           fan-in to it). The mirror of fanoutColumn below: here the FINAL leg
//           at the target row is the one the members share (it is the trunk's
//           aggregate leg), so the label anchor moves onto the middle of this
//           member's own SOURCE horizontal instead. Absent -> the bend-column
//           anchor. The drawn path never changes.
//   fanoutColumn: this forward item edge's bendX is a SHARED fan-out column
//           (routeTrunkEdges pinned every same-(item, source-port) member to
//           it), not a staggered one of its own. Present -> the step's label
//           anchor moves off the shared vertical onto the middle of this
//           member's own final horizontal leg, so the members' chips spread
//           along their legs instead of stacking on the one column. Absent ->
//           the bend-column anchor, byte-identical for direct callers. The
//           drawn path never changes.
//   chipX / chipY: the card-clear seat deconflictChipAnchors found for a 1-to-1
//           chip whose rule seat (the longest run's centre) stood over a card.
//           The pass knows the card rects and this module does not, so the
//           slide is computed there and handed back as a point; it is used only
//           while it still lies on a horizontal run of the polyline this call
//           built, so a drag that moves the line out from under it falls back
//           to the rule seat instead of floating the chip. Absent -> the rule
//           seat, byte-identical for direct callers.
//   chamferBudget: per-bend corridor room available for enlarging a forward
//           step's corner bevels (assignBendColumns). Half the stagger pitch, so
//           an edge's fattened chamfer never reaches a sibling column's vertical.
//           Present -> the forward step's two corner chamfers grow from the base
//           CHAMFER toward MAX_CHAMFER, capped by half the shorter adjacent leg
//           and by this budget. Absent -> the base CHAMFER, byte-identical for
//           direct callers.
export type RoutingHints = {
  bendX?: number;
  legY?: number;
  jogDescentX?: number;
  srcColX?: number;
  entryX?: number;
  railY?: number;
  railXRight?: number;
  railXLeft?: number;
  junctionX?: number;
  faninJoinX?: number;
  faninColumn?: boolean;
  fanoutColumn?: boolean;
  chipX?: number;
  chipY?: number;
  chamferBudget?: number;
};

// Pick the routing hints off an edge's `data`, omitting absent ones so each
// path builder's documented default kicks in. Shared by ItemEdge, BusEdge, and
// deconflictChipAnchors (see RoutingHints above).
const HINT_KEYS = [
  "bendX",
  "legY",
  "jogDescentX",
  "srcColX",
  "entryX",
  "railY",
  "railXRight",
  "railXLeft",
  "junctionX",
  "faninJoinX",
  "chipX",
  "chipY",
  "chamferBudget",
] as const satisfies ReadonlyArray<keyof RoutingHints>;

// The hints carried as flags rather than coordinates, extracted the same way
// but type-checked as booleans (an absent or non-boolean value is dropped, so a
// stray string cannot switch a shape on).
const FLAG_HINT_KEYS = [
  "fanoutColumn",
  "faninColumn",
] as const satisfies ReadonlyArray<keyof RoutingHints>;

export function routingHintsFromData(data: unknown): RoutingHints {
  const d = data as Record<string, unknown> | undefined;
  const hints: RoutingHints = {};
  for (const key of HINT_KEYS) {
    const v = d?.[key];
    if (typeof v === "number") hints[key] = v;
  }
  for (const key of FLAG_HINT_KEYS) {
    const v = d?.[key];
    if (typeof v === "boolean") hints[key] = v;
  }
  return hints;
}

// Choose a backward-detour rail y clear of every obstacle the rail horizontally
// spans -- but only the CONNECTED BAND of them around preferredY. The rail runs
// at `preferredY` between xLo and xHi; an obstacle whose x-range overlaps
// [xLo, xHi] and whose strike band contains preferredY would be sliced (or, for
// a container slab, hugged). The escaping rail then clears the band: the strike
// intervals of the obstacles transitively touching the one that contains
// preferredY (overlapping intervals merge, so a chain of cards and slab moats
// moves as one block), taken as a unit -- just above the band (min top - its
// gap) or just below it (max bottom + its gap), whichever is the smaller move.
// Obstacles in OTHER bands -- an x-overlapping card rows away, above or below --
// do not drag the rail: escaping over EVERY x-overlapping rect at once hoisted a
// loop return clear across the graph (an unrelated enclosure card lifted the
// multi6 Sandleaf return's rail from its preferred 393 to -4), and the upward
// escape landed graphTop - 16, inside the top bus band whose bottom sits at
// graphTop - 8. Should the nearer escape land within gap clearance of an
// obstacle the band did not cover, that obstacle's own band joins and the
// escapes recompute, so the returned y clears every spanned rect by its own
// gap, as the old whole-graph rule did. Plain obstacles use `gap` for both
// the strike test and the clearance; container slabs (o.container) use the
// wider `containerGap` for both, so a rail preferred anywhere inside the
// container's clearance band -- including the moat between the padded border
// and the band edge -- is pushed out to the full band (#29). Obstacles
// outside the x-span are ignored because the horizontal rail never reaches
// them. Pure.
export function clearRailY(
  preferredY: number,
  xLo: number,
  xHi: number,
  obstacles: ReadonlyArray<ObstacleRect>,
  gap = CHAMFER,
  // Wider gap applied to container-slab obstacles (o.container). Defaults to the
  // plain gap, so a non-container-aware caller is byte-identical to before.
  containerGap = gap,
): number {
  const lo = Math.min(xLo, xHi);
  const hi = Math.max(xLo, xHi);
  const spanned = obstacles.filter((o) => o.right > lo && o.left < hi);
  if (spanned.length === 0) return preferredY;
  // Strike band: the rect itself for plain obstacles; widened by the extra
  // container clearance for slabs, so a rail preferred in the moat between the
  // padded border and the full band still counts as a strike and gets pushed
  // out, instead of being left hugging the border.
  const reach = (o: ObstacleRect): number =>
    o.container ? containerGap - gap : 0;
  const strikeLo = (o: ObstacleRect): number => o.top - reach(o);
  const strikeHi = (o: ObstacleRect): number => o.bottom + reach(o);
  const hits = spanned.some(
    (o) => preferredY >= strikeLo(o) && preferredY <= strikeHi(o),
  );
  if (!hits) return preferredY;
  const gapOf = (o: ObstacleRect): number => (o.container ? containerGap : gap);
  // Seed the band with every obstacle whose strike interval contains
  // preferredY, then escape over it (growing transitively) in the loop helper.
  const band = new Set(
    spanned.filter(
      (o) => preferredY >= strikeLo(o) && preferredY <= strikeHi(o),
    ),
  );
  return clearRailYBand(preferredY, spanned, band, strikeLo, strikeHi, gapOf);
}

// The escape loop over the connected band around preferredY: grow the band
// transitively (overlapping strike intervals merge, so a chain of cards and
// slab moats moves as one block), take the nearer of just-above / just-below
// the whole band, and -- should that escape land within gap clearance of a
// spanned obstacle the band did not cover, the same padding the escapes
// themselves apply, so a landing 1..gap off a card re-merges instead of
// parking there -- merge that obstacle's band and recompute. Each round
// the band strictly grows and the whole-graph limit is the old behaviour, so
// the loop terminates. Pure.
function clearRailYBand(
  preferredY: number,
  spanned: ReadonlyArray<ObstacleRect>,
  band: Set<ObstacleRect>,
  strikeLo: (o: ObstacleRect) => number,
  strikeHi: (o: ObstacleRect) => number,
  gapOf: (o: ObstacleRect) => number,
): number {
  for (;;) {
    let bandLo = Infinity;
    let bandHi = -Infinity;
    for (const o of band) {
      bandLo = Math.min(bandLo, strikeLo(o));
      bandHi = Math.max(bandHi, strikeHi(o));
    }
    for (const o of spanned) {
      if (band.has(o)) continue;
      if (strikeLo(o) <= bandHi && strikeHi(o) >= bandLo) band.add(o);
    }
    const members = [...band];
    const aboveY = Math.min(...members.map((o) => o.top - gapOf(o)));
    const belowY = Math.max(...members.map((o) => o.bottom + gapOf(o)));
    const pick = preferredY - aboveY <= belowY - preferredY ? aboveY : belowY;
    const struckOutside = spanned.filter(
      (o) =>
        !band.has(o) && pick >= o.top - gapOf(o) && pick <= o.bottom + gapOf(o),
    );
    if (struckOutside.length === 0) return pick;
    for (const o of struckOutside) band.add(o);
  }
}

// Does a column of height dy with these bevels draw as one diagonal instead of
// bevel, vertical, bevel? It does when the straight run left between the two
// bevels would come out shorter than one CHAMFER: at the 22-unit row pitch the
// full shape is bevel 8, vertical 6, bevel 8, which reads as a zigzag rather
// than a step. One rule for every column the module emits.
function collapsesToDiagonal(dy: number, chamfer: number): boolean {
  return Math.abs(dy) - 2 * chamfer < CHAMFER;
}

// One chamfered vertical column, entered at y0 and exited at y1: horizontal into
// the column, chamfer, vertical run, chamfer out. entryDir/exitDir pick which
// side each horizontal leg leaves on (-1 = left, +1 = right): the entry point is
// (x + entryDir*chamfer, y0) and the exit point (x + exitDir*chamfer, y1). The
// defaults (-1, +1) enter from the left and exit to the right, matching the
// forward step. The backward detour columns pass
// (-1, -1) and (+1, +1) so both legs stay on one side. When collapsesToDiagonal
// holds the column becomes a two-point diagonal (a flat horizontal when
// y0 === y1), skipping the run.
function chamferColumn(
  out: Vertex[],
  x: number,
  y0: number,
  y1: number,
  chamfer: number,
  entryDir = -1,
  exitDir = 1,
): void {
  if (collapsesToDiagonal(y1 - y0, chamfer)) {
    out.push(
      vertex(x + entryDir * chamfer, y0),
      vertex(x + exitDir * chamfer, y1),
    );
    return;
  }
  const dir = y1 > y0 ? 1 : -1;
  out.push(
    vertex(x + entryDir * chamfer, y0),
    vertex(x, y0 + dir * chamfer),
    vertex(x, y1 - dir * chamfer),
    vertex(x + exitDir * chamfer, y1),
  );
}

// Every "x,y" coordinate pair of an absolute "M x,y L x,y ..." path string
// (the only form this module emits), as [x, y] tuples in order. The one parser
// for the emitted `d` grammar; callers that probe a path repeatedly parse once
// here and interpolate with pathPointAtPts.
export function parsePathPoints(
  d: string,
): ReadonlyArray<readonly [number, number]> {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as const,
  );
}

// pathPointAtPts: the point at `frac` (0..1) of the cumulative polyline length
// of an already-parsed vertex list, as produced by parsePathPoints from an
// absolute "M x,y L x,y ..." path string (the only form this module emits).
// Walks the segments accumulating length until the fraction of the total is
// covered, then interpolates within the covering segment. Coordinates come back
// through r() so anchors stay as stable as the path coordinates they derive
// from. The anchor rule reads the 0.5 fraction to break a tie between two runs
// of equal length; callers that probe a path repeatedly parse once above.
export function pathPointAtPts(
  pts: ReadonlyArray<readonly [number, number]>,
  frac: number,
): [number, number] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
  }
  let remaining = total * Math.min(1, Math.max(0, frac));
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg >= remaining) {
      const t = seg === 0 ? 0 : remaining / seg;
      return [r(x0 + t * (x1 - x0)), r(y0 + t * (y1 - y0))];
    }
    remaining -= seg;
  }
  // Zero-length path (never emitted here): fall back to the first point.
  return [r(pts[0]![0]), r(pts[0]![1])];
}

// One maximal HORIZONTAL run of a polyline: the x-interval [lo, hi] at row y
// spanned by consecutive vertices that all sit on that row. Adjacent horizontal
// segments at one y merge into a single run, so a run is the stretch a chip can
// actually stand on, not an emitted segment.
export type HorizontalRun = { lo: number; hi: number; y: number };

export function horizontalRuns(
  pts: ReadonlyArray<readonly [number, number]>,
): HorizontalRun[] {
  const runs: HorizontalRun[] = [];
  let i = 1;
  while (i < pts.length) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (y1 !== y0) {
      i++;
      continue;
    }
    let lo = Math.min(x0, x1);
    let hi = Math.max(x0, x1);
    let j = i + 1;
    while (j < pts.length && pts[j]![1] === y0) {
      lo = Math.min(lo, pts[j]![0]);
      hi = Math.max(hi, pts[j]![0]);
      j++;
    }
    runs.push({ lo, hi, y: y0 });
    i = j;
  }
  return runs;
}

// THE anchor rule for a chip that labels a whole polyline (every 1-to-1 edge:
// forward step, small-dy diagonal, straight line, backward detour, and a far
// trunk member routed as a plain item edge): the CENTRE of the polyline's
// LONGEST horizontal run. Ties -- two runs of equal length, which the symmetric
// forward step produces whenever the two horizontals come out the same -- go to
// the run whose centre is nearest the polyline's arc-length midpoint, so the
// chip lands on the middle of the line rather than at one end.
//
// The centre of a horizontal run is on the drawn polyline by construction, and
// the rule reads the polyline alone: no branch of the builder gets a special
// anchor, so there is no boundary a one-pixel disagreement between the live
// handles and an offline port model can teleport the chip across. A polyline
// with no horizontal run at all (never emitted here: every shape leaves its
// source port along one) falls back to the arc midpoint.
export function longestRunAnchor(
  pts: ReadonlyArray<readonly [number, number]>,
): [x: number, y: number] {
  return longestRunAnchorIn(pts, horizontalRuns(pts));
}

// longestRunAnchor over runs the caller already took off `pts`.
function longestRunAnchorIn(
  pts: ReadonlyArray<readonly [number, number]>,
  runs: ReadonlyArray<HorizontalRun>,
): [x: number, y: number] {
  const best = runsByPreference(pts, runs)[0];
  if (best === undefined) return pathPointAtPts(pts, 0.5);
  return [r((best.lo + best.hi) / 2), r(best.y)];
}

// The chip box a chip of half-width halfW draws when anchored at (x, y), as an
// axis-aligned rect. One derivation for the card-clear slide below and for the
// suites that measure the same box.
export function chipBoxAt(
  x: number,
  y: number,
  halfW: number,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: x - halfW,
    right: x + halfW,
    top: y - CHIP_HALF_H,
    bottom: y + CHIP_HALF_H,
  };
}

// Do two rects overlap in their strict interiors? Touching edges are not an
// intersection: a chip box flush against a card border still reads as beside
// the card, and the slide below seats exactly flush.
function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    a.right > b.left + BOX_EPS &&
    a.left < b.right - BOX_EPS &&
    a.bottom > b.top + BOX_EPS &&
    a.top < b.bottom - BOX_EPS
  );
}

// Tolerance for the card-clear box tests. The anchors and the card rects are
// sums of the same fractional layout coordinates, so a seat computed to stand
// exactly flush against a card edge must not read back as intersecting it.
const BOX_EPS = 1e-6;

// The runs of a polyline in the order the card-clear rule tries them: longest
// first, ties by the run centre nearest the polyline's arc midpoint -- the same
// order longestRunAnchor picks its single winner in, so the first run of this
// list IS that winner and a chip that needs no slide never moves.
function runsByPreference(
  pts: ReadonlyArray<readonly [number, number]>,
  runs: ReadonlyArray<HorizontalRun> = horizontalRuns(pts),
): HorizontalRun[] {
  const [mx, my] = pathPointAtPts(pts, 0.5);
  return runs
    .map((run) => ({
      run,
      len: run.hi - run.lo,
      gap: Math.hypot((run.lo + run.hi) / 2 - mx, run.y - my),
    }))
    .sort((a, b) => b.len - a.len || a.gap - b.gap)
    .map((entry) => entry.run);
}

// THE card-clear rule for a 1-to-1 chip (rule 5 of the placement model): the
// chip stands at the centre of its longest horizontal run, but a run may pass
// over a card, and a box standing on a card reads as that card's own label.
// So: on the chosen run, if the box at the run centre intersects a card, slide
// it ALONG that run to the nearest position whose box clears every card;
// if no position on the run clears, take the next-longest run and repeat; if no
// run clears, keep the longest run's centre.
//
// The candidate positions are a deterministic function of the run and the card
// rects -- the box seated flush against each blocking card's left or right edge
// -- with no scoring, no field and no windows: for every card the box could
// stand on, the two places it just clears it, filtered to the ones that clear
// every other card too, nearest to the centre winning (ties to the smaller x).
// The anchor stays within the run, so the chip never leaves its own line.
//
// `cards` are the RAW drawn card rects (recipe / product / loop boxes, no
// padding); container slabs are not cards. The caller supplies them because
// this module sees one edge at a time and never the node list.
// Does a chip box at (x, y) enter any of these cards? The seating pass asks it
// of a RULE seat before deciding to slide, and the slide below asks it of every
// candidate, so both read the same definition of "on a card".
export function chipBoxClearsCards(
  x: number,
  y: number,
  halfW: number,
  cards: ReadonlyArray<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
): boolean {
  return !cards.some((card) => rectsOverlap(chipBoxAt(x, y, halfW), card));
}

export function cardClearRunAnchor(
  pts: ReadonlyArray<readonly [number, number]>,
  halfW: number,
  cards: ReadonlyArray<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
): [x: number, y: number] {
  const runs = runsByPreference(pts);
  if (runs.length === 0) return pathPointAtPts(pts, 0.5);
  const clears = (x: number, y: number, blockers: typeof cards): boolean =>
    chipBoxClearsCards(x, y, halfW, blockers);

  for (const run of runs) {
    const centre = (run.lo + run.hi) / 2;
    // Only the cards this run's chip ROW can meet matter; the rest can never
    // be hit however far the box slides along it.
    const blockers = cards.filter(
      (card) =>
        card.bottom > run.y - CHIP_HALF_H + BOX_EPS &&
        card.top < run.y + CHIP_HALF_H - BOX_EPS,
    );
    if (clears(centre, run.y, blockers)) return [r(centre), r(run.y)];
    const seats = blockers
      .flatMap((card) => [card.left - halfW, card.right + halfW])
      .filter((x) => x >= run.lo && x <= run.hi && clears(x, run.y, blockers))
      .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    const seat = seats[0];
    if (seat !== undefined) return [r(seat), r(run.y)];
  }
  const [x, y] = longestRunAnchor(pts);
  return [x, y];
}

// Is a point ON a horizontal run of this polyline? The gate the stamped
// card-clear seat passes before the drawer uses it: the pass that computed it
// read the same geometry, so at rest it always holds, and a drag that moves
// the line out from under the stamp drops back to the rule seat rather than
// floating the chip off its own line.
function onHorizontalRun(
  runs: ReadonlyArray<HorizontalRun>,
  x: number,
  y: number,
): boolean {
  return runs.some(
    (run) =>
      Math.abs(run.y - y) <= BOX_EPS &&
      x >= run.lo - BOX_EPS &&
      x <= run.hi + BOX_EPS,
  );
}

// THE chip anchor of an item-shaped polyline, the one rule every arm of
// chamferStepPath exits through. Three cases, in order:
//
//   far fan-out member (fanoutColumn, and a dual far member carrying both
//     flags): its LAST horizontal run -- its own leg into the target -- seated
//     one port stub back from the target port, the same seat a retyped fan-out
//     member takes on the same leg. Everything left of it is the column its
//     siblings share, where every member's chip would stack. A far member takes
//     no entry column (it keeps its trunk's shared line), so the late drop never
//     moves this run.
//   far fan-in member (faninColumn alone): its FIRST horizontal run -- its own
//     source stub -- seated one port stub out of the source port. The stub
//     stands in the gap's source chip reserve, which was widened for exactly
//     this box; the run at the target row is the trunk's aggregate leg, shared
//     with every sibling.
//   everything else (1-to-1 forward, rail, straight line, diagonal): the
//     longest run's centre.
//
// The card-clear seat the seating pass slid the chip to wins over all three,
// for a far member as much as for a 1-to-1 chip: a named run can be shorter
// than the box it has to carry (a jogged member's leg starts just past the card
// it dodged), and a box hanging off the end of such a run reads as the label of
// whatever it hangs over. The stamp is only taken while it still lies on a
// horizontal run of the live polyline, so a dragged node drops back to the rule
// seat. The far-member seats read the member's own chip box (memberHalfW),
// defaulting to the worst case for a direct caller that reserves none.
export function itemAnchor(
  pts: ReadonlyArray<readonly [number, number]>,
  args: RoutingHints & ChipBoxes,
  sx: number,
  tx: number,
): [x: number, y: number] {
  const runs = horizontalRuns(pts);
  const halfW = args.memberHalfW ?? CHIP_HALF_W_WIDE;
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (
    args.chipX !== undefined &&
    args.chipY !== undefined &&
    onHorizontalRun(runs, args.chipX, args.chipY)
  ) {
    return [r(args.chipX), r(args.chipY)];
  }
  if (args.fanoutColumn === true && last !== undefined) {
    return [r(reserveSeatX(tx, null, halfW, last.lo, last.hi)), r(last.y)];
  }
  if (args.faninColumn === true && first !== undefined) {
    return [r(reserveSeatX(sx, null, halfW, first.lo, first.hi)), r(first.y)];
  }
  return longestRunAnchorIn(pts, runs);
}

// chamferStepPath: forward step, small-dy diagonal, narrow-gap degradation, and
// backward S/C detour, all sharing the same chamfer convention. A forward step
// runs its long horizontal at the SOURCE row and drops to the target row at the
// target's entry column (see LATE DROP below). Returns the SVG
// path plus the chip anchor longestRunAnchor puts on it -- the centre of the
// polyline's longest horizontal run, one rule for every branch below, read off
// the path this call just built. The final segment is always a rightward
// horizontal into the target.
export function chamferStepPath(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
  } & RoutingHints &
    ChipBoxes,
): [path: string, labelX: number, labelY: number] {
  const { path, x, y } = chamferStepShape(args);
  return [path, x, y];
}

// chamferStepPath with the vertex list it drew, so drawnEdge need not parse
// the path back.
function chamferStepShape(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
  } & RoutingHints &
    ChipBoxes,
): { path: string; pts: ReadonlyArray<Vertex>; x: number; y: number } {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, bendX } = args;
  const gap = tx - sx;
  // One exit for every branch: the emitted path plus its rule anchor.
  const anchored = (
    vertices: Vertex[],
  ): { path: string; pts: ReadonlyArray<Vertex>; x: number; y: number } => {
    const { d, pts } = emitted(vertices);
    const [x, y] = itemAnchor(pts, args, sx, tx);
    return { path: d, pts, x, y };
  };

  // Backward: the target sits at or left of the source (ELK breaks cycles by
  // reversing edges, so targetX can be <= sourceX). Route right out of the
  // source, down/up to a detour rail midway between the endpoints, left past the
  // target, then back to the target level and a final rightward stub in.
  if (gap <= 0) {
    // The drawn shape is the shared defaults with any routing hint substituted
    // in. clampBackwardRails moves a column clear of a foreign card / gutter
    // (railXRight / railXLeft, the latter also overriding the entry stagger) and
    // moves the rail clear of the cards it spans (railY); absent every hint this
    // is byte-identical for direct callers.
    const base = backwardRailDefaults({
      sx,
      sy,
      tx,
      ty,
      entryX: args.entryX,
    });
    const xr = args.railXRight ?? base.xr;
    const xl = args.railXLeft ?? base.xl;
    const railY = args.railY ?? base.railY;
    // Small detour height: the rail sits within a chamfer of the source level,
    // so a full chamfered column would invert and backtrack (a zigzag spike).
    // Collapse each column to a single apex bevel (peak out at the column x, no
    // vertical run), mirroring the forward small-dy diagonal. The sy===ty case
    // offsets the rail past this threshold, so it keeps the full shape.
    if (Math.abs(railY - sy) <= 2 * CHAMFER) {
      return anchored([
        vertex(sx, sy),
        vertex(xr - CHAMFER, sy),
        vertex(xr, (sy + railY) / 2),
        vertex(xr - CHAMFER, railY),
        vertex(xl + CHAMFER, railY),
        vertex(xl, (railY + ty) / 2),
        vertex(xl + CHAMFER, ty),
        vertex(tx, ty),
      ]);
    }
    // Right column exits leftward (-1, -1) onto the rail, left column enters
    // leftward (+1, +1) off it; the leftward rail run is the implicit segment
    // between the right column's exit and the left column's entry.
    const detour = [vertex(sx, sy)];
    chamferColumn(detour, xr, sy, railY, CHAMFER, -1, -1);
    chamferColumn(detour, xl, railY, ty, CHAMFER, 1, 1);
    detour.push(vertex(tx, ty));
    return anchored(detour);
  }

  // Forward. forwardStepGeometry scales the stub+chamfer budget down
  // proportionally when the gap is too narrow to fit a full symmetric shape
  // (bottoming out at a plain step) and resolves the bend column: default
  // midpoint, or the caller's bendX clamped to the margins, falling back to the
  // midpoint when the corridor is too tight to host a bend. A srcColX hint
  // (jogForwardLegs, blocked source leg) replaces the column outright and is
  // used unclamped: the routing pass proved it clear, and the clamp could push
  // it back into the blocked band.
  const geom = forwardStepGeometry(sx, tx, bendX);
  const { chamfer, bx: stepBx } = geom;
  const bx = args.srcColX ?? stepBx;
  const dropX = forwardDropX(geom, args);

  // The jog: when a leg at the target y would cross an intervening card,
  // jogForwardLegs stamps a clear legY: bend to it, run the long horizontal
  // there (clear of the card), then descend / ascend to the target y in the
  // target's entry gutter (descentX) before the final rightward stub. The bend
  // column already sits in a node-free corridor, so its vertical is clear at any
  // legY. The hint comes FIRST, before the straight-line and diagonal
  // shortcuts: a same-row or small-dy edge cannot dodge a card in either of
  // those shapes, and jogForwardLegs only stamps one it proved clear. Absent
  // the hint the shapes below stand, byte-identical.
  if (args.legY !== undefined) {
    const descentX = args.jogDescentX ?? args.entryX ?? tx - PORT_STUB;
    const jog = [vertex(sx, sy)];
    chamferColumn(jog, bx, sy, args.legY, chamfer);
    chamferColumn(jog, descentX, args.legY, ty, chamfer);
    jog.push(vertex(tx, ty));
    return anchored(jog);
  }

  // Same rail: a plain straight line, no vertical offset at all -- one long
  // horizontal run, which is also where its chip anchors.
  if (sy === ty) {
    return anchored([vertex(sx, sy), vertex(tx, ty)]);
  }

  // Small dy: the straight run left between the two chamfers would be shorter
  // than a CHAMFER, so join the two horizontal runs with a single diagonal (no
  // vertical segment). The enlarged-bevel arm below runs the same rule on
  // stepChamfer inside chamferColumn.
  if (collapsesToDiagonal(ty - sy, chamfer)) {
    return anchored([
      vertex(sx, sy),
      vertex(dropX - chamfer, sy),
      vertex(dropX + chamfer, ty),
      vertex(tx, ty),
    ]);
  }

  // Normal forward step: H run at the source row, chamfer, V run at the drop
  // column, chamfer, H run into target.
  // Enlarge the two corner bevels toward MAX_CHAMFER when the bend carries a
  // corridor budget (P6 PCB-style long chamfers). Cap by half the shorter
  // adjacent leg -- the source-side horizontal, the target-side horizontal, and
  // the vertical run (|ty - sy|) -- so a bevel never overruns its own legs, and
  // by the stamped budget so it never reaches a sibling column's vertical.
  // Absent the budget the base chamfer stands and the path is byte-identical.
  // The half-leg cap already shrinks in a narrow corridor, so it composes with
  // the narrow-gap scaling above.
  // The budget's sibling-envelope invariant was proven for the STAGGER column at
  // bendX (half the stagger pitch keeps a fattened bevel off the neighbour's
  // vertical). It holds for neither of the two columns that replace it: a
  // jog-cleared source column carries only a CHAMFER of margin, and an entry
  // column stands one slot pitch from the next row's -- so any drop column other
  // than the staggered one keeps the base chamfer whatever the stamped budget.
  const stepChamfer =
    args.chamferBudget === undefined || dropX !== stepBx
      ? chamfer
      : Math.min(
          MAX_CHAMFER,
          Math.min(dropX - sx, tx - dropX, Math.abs(ty - sy)) / 2,
          args.chamferBudget,
        );
  const step = [vertex(sx, sy)];
  chamferColumn(step, dropX, sy, ty, stepChamfer);
  step.push(vertex(tx, ty));
  return anchored(step);
}

// The half-widths of a trunk member's two chips. drawnEdge reads them off the
// edge payload; a direct caller that omits them reserves the worst-case box.
export type ChipBoxes = { aggHalfW?: number; memberHalfW?: number };

// Where one TRUNK chip stands on the horizontal run that is its own: the
// reserve model lays every gap out as
//   [card | RESERVE_CARD_PAD | chip | RESERVE_COLUMN_PAD | columns | ... ]
// (layerModel widens each gap to fit exactly that), so a trunk chip seats with
// its BOX one PORT_STUB out of the port it labels -- RESERVE_CARD_PAD is that
// stub -- which lands it inside the reserve zone the gap was widened for.
//   portX     the port end of the run, the end the chip is measured from
//   inwardX   the column end of the run: a junction dot ON this chip's row, to
//             be cleared by DOT_KEEPOFF (the column-side pad, same value).
//             Null when the trunk's dot sits on another row, where the chip
//             clears it in y and owes it nothing in x.
//   halfW     half the box this chip draws
// The dot clearance wins on a run too short for both, and the result is finally
// clamped onto [min, max] of the run itself, so the anchor is ON the drawn
// polyline in every degenerate corridor.
function reserveSeatX(
  portX: number,
  inwardX: number | null,
  halfW: number,
  runLo: number,
  runHi: number,
): number {
  // The port is one END of the run, so which way the chip steps inward off it
  // is decided by which end it is.
  const away = portX <= Math.min(runLo, runHi) ? 1 : -1;
  const fromPort = portX + away * (PORT_STUB + halfW);
  const seat =
    inwardX === null
      ? fromPort
      : away > 0
        ? Math.min(fromPort, inwardX - (DOT_KEEPOFF + halfW))
        : Math.max(fromPort, inwardX + DOT_KEEPOFF + halfW);
  return clamp(seat, Math.min(runLo, runHi), Math.max(runLo, runHi));
}

// Chip anchor of a DUAL member -- a fan-out member whose target port also
// carries a fan-in trunk (faninJoinX, the fan-in column). The run from this
// member's own fan-out column across to the fan-in junction is the last stretch
// that belongs to it alone: everything right of that junction is the aggregate
// leg every fan-in member shares. Null when there is no such hand-over, or when
// the two columns leave no run between them (the member then keeps the ordinary
// fan-out anchor). The drawn polyline is unchanged either way.
function dualAnchorOf(
  args: RoutingHints,
  jx: number,
  ty: number,
): { x: number; y: number } | null {
  if (args.faninJoinX === undefined) return null;
  const joinX = args.faninJoinX + CHAMFER;
  const ownRunLo = jx + CHAMFER;
  if (joinX <= ownRunLo) return null;
  return { x: r((ownRunLo + joinX) / 2), y: r(ty) };
}

// The junction column a fan-out / fan-in member is actually DRAWN on: the
// routing pass's shared column, clamped into the corridor (one stub + chamfer
// inside each port) so both the trunk segment and the branch leg stay well
// formed. When the corridor is too tight to host a distinct column, the
// midpoint stands in and the member draws a plain step. Both builders below
// share it, and so does routeTrunkEdges, which has to test the runs this
// column produces before it commits a member to the trunk shape.
export function fanJunctionX(
  sx: number,
  tx: number,
  junctionX: number | undefined,
): number {
  const lo = sx + PORT_STUB + CHAMFER;
  const hi = tx - PORT_STUB - CHAMFER;
  const mid = (sx + tx) / 2;
  return lo < hi ? clamp(junctionX ?? mid, lo, hi) : mid;
}

// chamferFanoutPath: one member of a fan-out trunk (routeTrunkEdges). N members
// share a source PORT (same item, same source unit) and fan out to N targets one
// layer over. Every member is drawn with the SAME junction column, so their
// shared trunk segment -- the horizontal from the source port out to the junction
// -- overlaps into one line and the trunk visually draws once. Each member then
// branches off the junction, up or down its own column to its target port, and
// finishes with the rightward stub into the Left handle.
//
// This is a plain forward step whose bend column is pinned to the shared
// junction (never staggered), returning the geometry the render / seating layers
// need: the junction point (trunk meets branches, where the dot draws), the
// trunk-segment anchor (where the owner's aggregate chip seats), and the branch-
// leg anchor (where this member's own branch chip seats). Same degenerate guards
// as chamferStepPath's forward branch: a shared-y member draws a straight trunk
// with no branch vertical, a small-dy member a single diagonal. Pure.
export function chamferFanoutPath(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
  } & RoutingHints &
    ChipBoxes,
): {
  path: string;
  pts: ReadonlyArray<readonly [number, number]>;
  junction: { x: number; y: number };
  trunkAnchor: { x: number; y: number };
  branchAnchor: { x: number; y: number };
} {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = args;
  const jx = fanJunctionX(sx, tx, args.junctionX);
  // The junction dot marks the split, so it must sit ON the drawn geometry.
  // The sharp corner (jx, sy) is cut away by the branch chamfer; the last
  // point every member still shares is one chamfer before the column, on the
  // trunk horizontal -- for a branching member, a small-dy diagonal, AND a
  // shared-y straight trunk alike, so all members of one trunk agree on it.
  const junction = { x: r(jx - CHAMFER), y: r(sy) };
  // Aggregate chip rides the shared trunk horizontal, seated a port stub out of
  // the source port and clear of the split dot at the run's far end.
  const aggHalfW = args.aggHalfW ?? CHIP_HALF_W_WIDE;
  const memberHalfW = args.memberHalfW ?? CHIP_HALF_W_WIDE;
  const trunkAnchor = {
    x: r(reserveSeatX(sx, junction.x, aggHalfW, sx, junction.x)),
    y: r(sy),
  };

  // The member's own chip rides the LAST horizontal leg, the run from the
  // branch's outgoing chamfer into the target port -- for a branching member, a
  // small-dy diagonal and a shared-y straight trunk alike -- seated a port stub
  // back from the target port. A dual member hands its flow over at the fan-in
  // column, so its own run ends there instead.
  const legLo = Math.min(jx + CHAMFER, tx);
  const branchAnchor = dualAnchorOf(args, jx, ty) ?? {
    x: r(
      reserveSeatX(
        tx,
        // The split dot sits on the SOURCE row, so it constrains this leg only
        // when the member runs at that row (a shared-y straight trunk).
        sy === ty ? junction.x : null,
        memberHalfW,
        legLo,
        tx,
      ),
    ),
    y: r(ty),
  };

  const shaped = (vertices: Vertex[]) => {
    const { d, pts } = emitted(vertices);
    return { path: d, pts, junction, trunkAnchor, branchAnchor };
  };

  // Shared-y member: a straight trunk with no branch vertical.
  if (sy === ty) {
    return shaped([vertex(sx, sy), vertex(tx, ty)]);
  }

  // Small dy: the run left between the two chamfers would be shorter than a
  // CHAMFER, so join the two horizontals with a single diagonal at the junction
  // column.
  if (collapsesToDiagonal(ty - sy, CHAMFER)) {
    return shaped([
      vertex(sx, sy),
      vertex(jx - CHAMFER, sy),
      vertex(jx + CHAMFER, ty),
      vertex(tx, ty),
    ]);
  }

  // Normal branch: trunk horizontal, chamfer, branch vertical, chamfer, final
  // rightward stub into the target.
  const branch = [vertex(sx, sy)];
  chamferColumn(branch, jx, sy, ty, CHAMFER);
  branch.push(vertex(tx, ty));
  return shaped(branch);
}

// chamferFaninPath: one member of a fan-in trunk (routeTrunkEdges), the mirror
// of chamferFanoutPath above. N members feed one target PORT (same item, same
// target unit) from N sources one layer back. Every member is drawn with the
// SAME junction column, so their final legs -- the horizontal from the junction
// into the target port -- overlap into one line and the trunk's aggregate leg
// visually draws once. Each member reaches that column along its own source
// stub and turns down (or up) it to the target row.
//
// The polyline family is the fan-out's, so the shape is built by the same
// clamp and the same chamfered column; what differs is which parts are shared
// and therefore where the three points sit:
//   junction     (jx + CHAMFER, ty) -- the first vertex every member shares,
//                one chamfer past the column on the target row;
//   trunkAnchor  the middle of the aggregate leg, junction to the target port,
//                where the owner's aggregate chip seats;
//   branchAnchor the middle of this member's own source stub, where its own
//                rate chip seats.
// Same degenerate guards as chamferFanoutPath: a shared-y member draws a
// straight line with no descent, a small-dy member a single diagonal. Pure.
export function chamferFaninPath(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
  } & RoutingHints &
    ChipBoxes,
): {
  path: string;
  pts: ReadonlyArray<readonly [number, number]>;
  junction: { x: number; y: number };
  trunkAnchor: { x: number; y: number };
  branchAnchor: { x: number; y: number };
} {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = args;
  const jx = fanJunctionX(sx, tx, args.junctionX);
  // The merge dot sits on the drawn geometry at the point the members first
  // coincide: the outgoing chamfer's end on the target row, which every
  // branching, small-dy and shared-y member alike emits (or, for a straight
  // member, lies on).
  const junction = { x: r(jx + CHAMFER), y: r(ty) };
  // Aggregate chip rides the shared leg from the merge dot into the target
  // port, seated a port stub back from that port -- the fan-out trunk seat read
  // from the other end. Member chip rides this member's own stub, from its
  // source port out to the column's incoming chamfer, a port stub out of it.
  const aggHalfW = args.aggHalfW ?? CHIP_HALF_W_WIDE;
  const memberHalfW = args.memberHalfW ?? CHIP_HALF_W_WIDE;
  const legLo = Math.min(junction.x, tx);
  const trunkAnchor = {
    x: r(reserveSeatX(tx, junction.x, aggHalfW, legLo, tx)),
    y: r(ty),
  };
  const stubHi = Math.max(jx - CHAMFER, sx);
  const branchAnchor = {
    x: r(
      reserveSeatX(
        sx,
        // The merge dot sits on the TARGET row, so it constrains this stub only
        // when the member runs at that row (a shared-y straight member).
        sy === ty ? junction.x : null,
        memberHalfW,
        sx,
        stubHi,
      ),
    ),
    y: r(sy),
  };

  const shaped = (vertices: Vertex[]) => {
    const { d, pts } = emitted(vertices);
    return { path: d, pts, junction, trunkAnchor, branchAnchor };
  };

  if (sy === ty) {
    return shaped([vertex(sx, sy), vertex(tx, ty)]);
  }

  if (collapsesToDiagonal(ty - sy, CHAMFER)) {
    return shaped([
      vertex(sx, sy),
      vertex(jx - CHAMFER, sy),
      vertex(jx + CHAMFER, ty),
      vertex(tx, ty),
    ]);
  }

  const merge = [vertex(sx, sy)];
  chamferColumn(merge, jx, sy, ty, CHAMFER);
  merge.push(vertex(tx, ty));
  return shaped(merge);
}

// The sub-polyline a fan-out member's BRANCH chip draws on: the suffix from
// the trunk's junction point onward (junction -> branch column -> target
// port), the branch-side counterpart of the aggregate seat's trunk-prefix
// truncation below. The full polyline includes the shared trunk prefix, and
// the branch seat's slide walks BOTH directions from the anchor, so a branch
// chip seated on the full polyline can walk back across the junction onto the
// shared trunk -- the box then reads as a trunk label and buries the split
// dot from the side the reader approaches it. Every fan-out path starts with
// the horizontal run all members share, and the junction point sits ON that
// run as an exact polyline vertex for branching and small-dy (diagonal)
// members alike (chamferFanoutPath emits `jx - CHAMFER, sy` as the first
// turn), so the slice is the member's own leg plus, for a shared-y member,
// its post-junction run -- the junction vertex is prepended there because a
// straight path has no vertex of its own at that x. The source-port vertex at
// index 0 is always strictly left of the junction (the corridor clamps the
// junction column a stub-plus-chamfer out), so the scan starts past it.
//
// Exported for the trunk suites, which read a member's own leg extent through
// the same slice the drawn shape carries.
export function branchLegAfterJunction(
  pts: ReadonlyArray<readonly [number, number]>,
  junction: { x: number; y: number },
): ReadonlyArray<readonly [number, number]> {
  let i = 1;
  while (i < pts.length && pts[i]![0] < junction.x) i++;
  const rest = pts.slice(i);
  const head = rest[0];
  if (
    head !== undefined &&
    rest.length >= 2 &&
    Math.abs(head[0] - junction.x) <= 1 &&
    Math.abs(head[1] - junction.y) <= 1
  ) {
    return rest;
  }
  return [[junction.x, junction.y] as const, ...rest];
}

// The sub-polyline a fan-in member's OWN chip draws on: the prefix up to the
// trunk's junction point (source port -> column -> junction), the mirror of
// branchLegAfterJunction above. Everything past the junction is the aggregate
// leg every member of the trunk draws, so a chip allowed to slide there would
// read as the trunk's total and bury the merge dot from the right. The scan
// walks back from the end while the vertices sit right of the junction; the
// junction is appended when the prefix does not already end on it (a shared-y
// member draws a straight line with no vertex of its own at that x).
function stubBeforeJunction(
  pts: ReadonlyArray<readonly [number, number]>,
  junction: { x: number; y: number },
): ReadonlyArray<readonly [number, number]> {
  let i = pts.length - 1;
  while (i > 0 && pts[i]![0] > junction.x) i--;
  const head = pts.slice(0, i + 1);
  const tail = head[head.length - 1];
  if (
    tail !== undefined &&
    head.length >= 2 &&
    Math.abs(tail[0] - junction.x) <= 1 &&
    Math.abs(tail[1] - junction.y) <= 1
  ) {
    return head;
  }
  return [...head, [junction.x, junction.y] as const];
}

// The DRAWN edge: given one edge's drawn ports, its type and its stamped data,
// the polyline the canvas paints and every anchor that rides it. The one place
// that resolves the routing hints, the fan-out discriminant, the parse of `d`
// into vertices, the chip boxes the anchor rule seats by, and the fan-out
// branch-leg slice -- so the renderers (endpoints from React Flow props) and
// the bookkeeping pass's reconstruction (endpoints from drawnPortsOf) cannot
// disagree about any of it. A new routing hint threaded through RoutingHints
// and routingHintsFromData therefore reaches render and deconflictChipAnchors
// at once, by construction rather than by convention.
//
// The anchors here ARE where the chips draw: no later pass moves, collapses or
// hides one. Frame: DRAWN, never model. Comparing any of these coordinates
// against a model rect is wrong by the port drift, exactly at the thresholds
// the ratchets live on. `pts` is the parse of `path`, so no caller re-parses;
// every returned anchor lies on a horizontal segment of `pts`. Pure, total,
// deterministic: an unrecognised type or unstamped data yields the item shape
// with the builders' default hints, the same way an unrecognised edge passes a
// routing pass through unchanged.
export type DrawnPorts = {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

type Anchor = { x: number; y: number };

export type DrawnEdge =
  | {
      shape: "item";
      path: string;
      pts: ReadonlyArray<readonly [number, number]>;
      labelAnchor: Anchor;
      // Present only on the elected FAR owner of a fan-out trunk with no near
      // member (routeTrunkEdges stamps busChipOwner beside fanoutColumn): where
      // that trunk's total stands, on this member's own source stub in the gap's
      // source reserve -- the seat a retyped member's aggregate chip takes, so a
      // trunk of far members states its total like every other fan-out. Absent
      // on every other item shape.
      trunkAnchor?: Anchor;
    }
  | {
      shape: "fanout";
      path: string;
      pts: ReadonlyArray<readonly [number, number]>;
      branchPts: ReadonlyArray<readonly [number, number]>;
      junction: Anchor;
      trunkAnchor: Anchor;
      branchAnchor: Anchor;
    }
  | {
      shape: "fanin";
      path: string;
      pts: ReadonlyArray<readonly [number, number]>;
      // The member's OWN stretch, source port up to the merge dot. Named as
      // the fan-out arm's branchPts is, because both answer the same question:
      // which part of this polyline is not shared with the rest of the trunk.
      branchPts: ReadonlyArray<readonly [number, number]>;
      junction: Anchor;
      trunkAnchor: Anchor;
      branchAnchor: Anchor;
    };

export function drawnEdge(
  ports: DrawnPorts,
  edgeType: string | undefined,
  data: unknown,
): DrawnEdge {
  const hints = routingHintsFromData(data);
  const d = data as Record<string, unknown> | undefined;

  if (edgeType === "bus" && d?.fanin === true) {
    const fan = chamferFaninPath({
      ...ports,
      ...hints,
      ...chipHalfWidthsOf(d),
    });
    const pts = fan.pts;
    return {
      shape: "fanin",
      path: fan.path,
      pts,
      branchPts: stubBeforeJunction(pts, fan.junction),
      junction: fan.junction,
      trunkAnchor: fan.trunkAnchor,
      branchAnchor: fan.branchAnchor,
    };
  }

  if (edgeType === "bus" && d?.fanout === true) {
    const fan = chamferFanoutPath({
      ...ports,
      ...hints,
      ...chipHalfWidthsOf(d),
    });
    const pts = fan.pts;
    return {
      shape: "fanout",
      path: fan.path,
      pts,
      branchPts: branchLegAfterJunction(pts, fan.junction),
      junction: fan.junction,
      trunkAnchor: fan.trunkAnchor,
      branchAnchor: fan.branchAnchor,
    };
  }

  // An item shape seats only its own rate chip (itemAnchor reads memberHalfW),
  // so the aggregate width is measured here for one shape alone: the far owner
  // of an otherwise ownerless fan-out trunk, whose total rides its SOURCE stub
  // (the polyline's first run) one port stub out of the port, the reserve seat
  // every trunk chip takes. The trunk's divergence dot stands at the borrowed
  // column, so the column end of the stub -- one chamfer before the bend -- is
  // what the seat clears by DOT_KEEPOFF; with no bend the run's own end stands
  // in, and reserveSeatX clamps the anchor onto the run either way.
  const step = chamferStepShape({
    ...ports,
    ...hints,
    memberHalfW: memberHalfWOf(d),
  });
  let trunkAnchor: Anchor | undefined;
  if (hints.fanoutColumn === true && d?.busChipOwner === true) {
    const stub = horizontalRuns(step.pts)[0];
    if (stub !== undefined) {
      const inward =
        hints.bendX === undefined
          ? stub.hi
          : Math.min(stub.hi, hints.bendX - CHAMFER);
      trunkAnchor = {
        x: r(
          reserveSeatX(
            ports.sourceX,
            inward,
            chipHalfWidthsOf(d).aggHalfW,
            stub.lo,
            stub.hi,
          ),
        ),
        y: r(stub.y),
      };
    }
  }
  return {
    shape: "item",
    path: step.path,
    pts: step.pts,
    labelAnchor: { x: step.x, y: step.y },
    ...(trunkAnchor !== undefined ? { trunkAnchor } : {}),
  };
}

// One stretch of a drawn edge that belongs to a whole TRUNK rather than to this
// member: the run every member of that trunk draws over the same x-interval at
// the same row, so the ink under the pointer there is the trunk's line and not
// this edge's.
export type SharedStretch = { group: string; run: HorizontalRun };

// Which runs of a drawn edge are shared, and with which trunk. The hover rule
// reads it to tell "the pointer is on the trunk" (light every member) from "the
// pointer is on this member's own leg" (light this edge alone), and the corpus
// test reads the same function, so the two cannot drift.
//
// Every stretch is a sub-interval of a run the edge already drew (the runs of
// `pts`), so it lies on the drawn line by construction. Per member shape:
//   near fan-out      the first run, source port to the split;
//   near fan-in       the last run, the merge into the target port;
//   dual              both: the first run for its fan-out trunk and, past the
//                     fan-in merge column, the tail of the last run for its
//                     fan-in trunk. The middle leg between them is its own;
//   far member        the borrowed column makes its source stub (fan-out) or its
//                     final leg (fan-in) the trunk's line;
//   backward member   the same two ends of its detour rail, which leaves the
//                     port on the trunk's column.
// The run is CLIPPED at the trunk's column, because a run does not always end
// there: a shared-y member draws one straight run from port to port, a far
// member that jogs (or drops at its own source column) runs on the trunk's row
// well past -- or well before -- the column, and everything beyond the column
// is that member's own leg. The clip column is the junction the builder placed
// for a bus shape, and the stamped column one chamfer inward for an item shape
// (where chamferStepShape leaves the row; the far-only dots in chipSeating
// stand at the same point). An item-shape clip can miss the drawn corner by the
// chamfer scaling of a narrow corridor, which only shortens the stretch.
// Two carve-outs come out empty-handed by construction, and neither falls back
// to whole-group hover:
//   - a member far on BOTH sides carries two keys but borrows ONE column (the
//     fan-out's), so its fan-in trunk has no stretch on this edge;
//   - a member routeTrunkEdges could stamp membership on but no geometry for
//     (its trunk was dropped for want of a drawable column) has none at all.
// A key is emitted only when this edge is really a member of it, so a stray
// stamp cannot invent a group.
export function sharedStretches(
  drawn: DrawnEdge,
  edge: { source: string; target: string; data?: unknown },
): SharedStretch[] {
  const d = edge.data as Record<string, unknown> | undefined;
  const groups = Array.isArray(d?.trunkGroups)
    ? (d.trunkGroups as string[])
    : [];
  if (groups.length === 0) return [];

  // The trunk keys this edge could be a member of, built by the two key
  // helpers classifyTrunks buckets with, so neither the separator nor the
  // target-row spelling can drift between the classification and this reader.
  const item = typeof d?.item === "string" ? d.item : undefined;
  const fanoutKey = flowKeyOf(item, edge.source);
  const faninKey = faninKeyOf(item, edge as unknown as Edge);
  const runs = horizontalRuns(drawn.pts);
  const first = runs[0];
  const last = runs[runs.length - 1];

  const out: SharedStretch[] = [];
  const add = (group: string, run: HorizontalRun | undefined): void => {
    if (run === undefined || run.hi <= run.lo) return;
    if (!groups.includes(group)) return;
    out.push({ group, run });
  };
  // The part of a run on the trunk's side of a column: left of a split, right
  // of a merge. A column off the run leaves it empty, which `add` drops.
  const upTo = (run: HorizontalRun | undefined, x: number) =>
    run === undefined
      ? undefined
      : { lo: run.lo, hi: Math.min(run.hi, x), y: run.y };
  const from = (run: HorizontalRun | undefined, x: number) =>
    run === undefined
      ? undefined
      : { lo: Math.max(run.lo, x), hi: run.hi, y: run.y };

  if (drawn.shape === "fanout") {
    add(fanoutKey, upTo(first, drawn.junction.x));
    // Dual member: the fan-in trunk's members all meet one chamfer past their
    // merge column, so the stretch this edge shares with them is whatever of its
    // last run lies right of that point. A column that leaves no such tail --
    // the case dualAnchorOf answers with no middle run -- makes this a plain
    // fan-out member for hover.
    const joinX = (d as RoutingHints | undefined)?.faninJoinX;
    if (joinX !== undefined) {
      const mergeX = joinX + CHAMFER;
      if (mergeX > drawn.junction.x) {
        add(faninKey, from(last, mergeX));
      }
    }
    return out;
  }

  if (drawn.shape === "fanin") {
    add(faninKey, from(last, drawn.junction.x));
    return out;
  }

  // Item shape: the column is a stamp, the borrowed bend column of a far member
  // or the rail column of a backward one, and the members' lines part one
  // chamfer inward of it.
  const hints = routingHintsFromData(d);
  const splitX = hints.fanoutColumn === true ? hints.bendX : hints.railXRight;
  if (splitX !== undefined) {
    add(fanoutKey, upTo(first, splitX - CHAMFER));
  }
  const mergeX = hints.faninColumn === true ? hints.bendX : hints.railXLeft;
  if (mergeX !== undefined) {
    add(faninKey, from(last, mergeX + CHAMFER));
  }
  return out;
}
