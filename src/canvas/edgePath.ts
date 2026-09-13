// Custom orthogonal edge-path builder for the blueprint canvas.
//
// Replaces React Flow's getSmoothStepPath with a chamfered variant: every turn
// is a 45-degree corner cut instead of a rounded arc, edges leave and enter
// ports through a minimum straight stub, and bus members exit horizontally
// before diving to their lane. Routing semantics (which edges exist, their
// lanes and taps) are decided elsewhere; this module only decides how a given
// (source, target[, lane]) pair is drawn as a polyline.
//
// Every function is pure (no React, no Date/random, no input mutation) and
// rounds coordinates to two decimals so pinned test strings stay stable.
//
// Handle geometry the whole module relies on: sources are always Position.Right
// and targets always Position.Left (see RecipeNode/ProductNode/LoopNode). So a
// path always leaves rightward and must approach the target horizontally
// rightward into its Left handle, in every case, so the ArrowClosed marker
// (orient=auto) points right.

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
// proportionally (chamferStepPath, chamferBusPath) and the shape degenerates --
// no distinct bend / drop / rise column. The routing passes predict that
// degeneration (whether a member claims a gutter column, whether a bus column
// needs clearing), so they must read this same constant: the drawer owns the
// threshold.
export const FORWARD_STEP_BUDGET = 2 * (PORT_STUB + CHAMFER);

// Base bus drop column: one stub + chamfer off the source's Right port (its
// right edge at sourceRight). The single definition every consumer shares --
// chamferBusPath's default, routeBusEdges' rise-chip spread, clearBusColumns'
// dodge base, and busBandRegions' run fold -- so the drop basis can never
// drift between the drawer and the routing passes.
export function busDropBase(sourceRight: number): number {
  return sourceRight + PORT_STUB + CHAMFER;
}

// Base bus rise column: the staggered entryX when the entry-gutter pass staked
// one out, else one stub + chamfer inside the target's Left port (its left edge
// at targetLeft). Shared by the same consumers as busDropBase, same rationale.
export function busRiseBase(targetLeft: number, entryX?: number): number {
  return entryX ?? targetLeft - PORT_STUB - CHAMFER;
}

// Round to two decimals so degraded/scaled geometry does not produce long
// floating tails in the emitted `d` string (keeps pinned tests stable).
function r(n: number): number {
  return Math.round(n * 100) / 100;
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
export type ObstacleRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
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
//   bendX:  bend-column x for a forward step (assignBendColumns). Absent ->
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
//   entryX: entry-gutter column x (assignEntryColumns), the vertical run into
//           the target's Left port for backward rails and bus rises. Absent ->
//           one stub before the port.
//   railY:  backward-detour rail y (clampBackwardRails) clearing spanned cards.
//           Absent -> midway between the endpoints.
//   dropX:  obstacle-cleared bus drop column (clearBusColumns), the vertical run
//           from the source down to the lane. Absent -> one stub+chamfer inside
//           the source port.
//   riseX:  obstacle-cleared bus rise column (clearBusColumns), the vertical run
//           from the lane up to the target port. Overrides entryX when present.
//           Absent -> entryX, or one stub+chamfer inside the target port.
//   railXRight/railXLeft: obstacle-cleared backward-rail verticals
//           (clampBackwardRails). railXRight is the source-side column, absent ->
//           one stub out of the source port. railXLeft is the target-side column
//           and overrides entryX when present, absent -> entryX, or one stub
//           before the target port.
//   junctionX: shared junction column for a fan-out trunk member
//           (routeFanoutEdges). Every member of one (item, source) fan-out
//           shares this column: their trunk segments (source port out to the
//           junction) overlap into one line, and each branches off it up / down
//           to its own target. Absent -> the corridor midpoint (a plain step).
//   fanoutColumn: this forward item edge's bendX is a SHARED fan-out column
//           (routeFanoutEdges pinned every same-(item, source-port) member to
//           it), not a staggered one of its own. Present -> the step's label
//           anchor moves off the shared vertical onto the middle of this
//           member's own final horizontal leg, so the members' chips spread
//           along their legs instead of stacking on the one column. Absent ->
//           the bend-column anchor, byte-identical for direct callers. The
//           drawn path never changes.
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
  dropX?: number;
  riseX?: number;
  railXRight?: number;
  railXLeft?: number;
  junctionX?: number;
  fanoutColumn?: boolean;
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
  "dropX",
  "riseX",
  "railXRight",
  "railXLeft",
  "junctionX",
  "chamferBudget",
] as const satisfies ReadonlyArray<keyof RoutingHints>;

// The hints carried as flags rather than coordinates, extracted the same way
// but type-checked as booleans (an absent or non-boolean value is dropped, so a
// stray string cannot switch a shape on).
const FLAG_HINT_KEYS = ["fanoutColumn"] as const satisfies ReadonlyArray<
  keyof RoutingHints
>;

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

// One chamfered vertical column, entered at y0 and exited at y1: horizontal into
// the column, chamfer, vertical run, chamfer out. entryDir/exitDir pick which
// side each horizontal leg leaves on (-1 = left, +1 = right): the entry point is
// (x + entryDir*chamfer, y0) and the exit point (x + exitDir*chamfer, y1). The
// defaults (-1, +1) enter from the left and exit to the right, matching the
// forward step and the wide bus drop/rise. The backward detour columns pass
// (-1, -1) and (+1, +1) so both legs stay on one side. When the vertical run is
// too short to fit two chamfers (|y1 - y0| <= 2*chamfer) the column collapses to
// a two-point diagonal (a flat horizontal when y0 === y1), skipping the run.
function chamferColumn(
  x: number,
  y0: number,
  y1: number,
  chamfer: number,
  entryDir = -1,
  exitDir = 1,
): string {
  if (Math.abs(y1 - y0) <= 2 * chamfer) {
    return (
      ` L ${r(x + entryDir * chamfer)},${r(y0)}` +
      ` L ${r(x + exitDir * chamfer)},${r(y1)}`
    );
  }
  const dir = y1 > y0 ? 1 : -1;
  return (
    ` L ${r(x + entryDir * chamfer)},${r(y0)}` +
    ` L ${r(x)},${r(y0 + dir * chamfer)}` +
    ` L ${r(x)},${r(y1 - dir * chamfer)}` +
    ` L ${r(x + exitDir * chamfer)},${r(y1)}`
  );
}

// Join a point list into an SVG path string, rounding every coordinate and
// skipping consecutive duplicates (degenerate hairpin legs can land two points
// on the same vertex, and a repeated point would be a stray zero-length
// segment in the emitted `d`).
function pathFromPoints(pts: ReadonlyArray<readonly [number, number]>): string {
  let path = "";
  let px = NaN;
  let py = NaN;
  for (const [x, y] of pts) {
    const rx = r(x);
    const ry = r(y);
    if (rx === px && ry === py) continue;
    path += path === "" ? `M ${rx},${ry}` : ` L ${rx},${ry}`;
    px = rx;
    py = ry;
  }
  return path;
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
// from. The chip de-confliction pass uses off-midpoint fractions to slide a
// blocked label along its own line; it probes dozens of candidates per path and
// hoists the parse to one parsePathPoints call per edge.
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

// chamferStepPath: forward step, small-dy diagonal, narrow-gap degradation, and
// backward S/C detour, all sharing the same chamfer convention. Returns the SVG
// path plus the label anchor on the polyline's PREFERRED CLEAR SEGMENT (2B):
// every forward shape -- the full step, the small-dy diagonal, and the
// same-rail straight line -- anchors at the bend column (bx, mid(sy, ty)) (or,
// when the final leg is jogged around a card, on the jog-descent vertical), and
// a backward detour anchors on its source-side rail vertical, apex included, so
// the anchor is CONTINUOUS across every branch boundary: a one-pixel port-model
// disagreement between the live handles and the seating reconstruction cannot
// teleport it. The corridor legs are vertically long and horizontally clear, so
// a chip there sits off the card rows the target-side horizontal midpoint used
// to cross, and a downward de-confliction nudge slides ALONG the vertical,
// keeping the chip on its own line. Every returned anchor lies on the drawn
// polyline. The final segment is always a rightward horizontal into target.
//
// The anchor is derived from the SAME branch geometry that builds the `d` (the
// bend column bx, the jog descentX, the rail column xr are all in hand), never
// re-parsed, so render and reconstruction agree by construction.
export function chamferStepPath(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
  } & RoutingHints,
): [path: string, labelX: number, labelY: number] {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, bendX } = args;
  const gap = tx - sx;

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
    // Backward chip anchor: on the rail's HORIZONTAL run (at railY), one stub in
    // from the source-side corner but never past the run midpoint, so it rides
    // the clean source half clear of the target entry gutter at xl. The rail is
    // held a wide gap off any container slab (clampBackwardRails, CONTAINER_RAIL_GAP),
    // so a chip here no longer hugs a slab border the way the source-vertical
    // midpoint (sy..railY) could when the rail clamps just outside a loop box (#29).
    // Both detour branches below share this anchor, so it stays CONTINUOUS across
    // the apex/full boundary -- a one-pixel port-model disagreement between the
    // live handles and the seating reconstruction cannot teleport it.
    const railRunSourceX = xr - CHAMFER;
    const railRunTargetX = xl + CHAMFER;
    const labelX = Math.max(
      (railRunSourceX + railRunTargetX) / 2,
      railRunSourceX - PORT_STUB,
    );
    // Small detour height: the rail sits within a chamfer of the source level,
    // so a full chamfered column would invert and backtrack (a zigzag spike).
    // Collapse each column to a single apex bevel (peak out at the column x, no
    // vertical run), mirroring the forward small-dy diagonal. The sy===ty case
    // offsets the rail past this threshold, so it keeps the full shape.
    if (Math.abs(railY - sy) <= 2 * CHAMFER) {
      const d =
        `M ${r(sx)},${r(sy)}` +
        ` L ${r(xr - CHAMFER)},${r(sy)}` +
        ` L ${r(xr)},${r((sy + railY) / 2)}` +
        ` L ${r(xr - CHAMFER)},${r(railY)}` +
        ` L ${r(xl + CHAMFER)},${r(railY)}` +
        ` L ${r(xl)},${r((railY + ty) / 2)}` +
        ` L ${r(xl + CHAMFER)},${r(ty)}` +
        ` L ${r(tx)},${r(ty)}`;
      // Anchor on the rail horizontal run (labelX, railY) -- shared with the full
      // rail below so it is CONTINUOUS across this branch boundary. A one-pixel
      // disagreement between the live handle coordinates and the seating pass's
      // offline port model can flip which branch each side takes; a discontinuous
      // anchor then applies the seat's offsets to a far-away point and strands the
      // chip off its line (and inside a card).
      return [d, r(labelX), r(railY)];
    }
    // Right column exits leftward (-1, -1) onto the rail, left column enters
    // leftward (+1, +1) off it; the leftward lane run is the implicit segment
    // between the right column's exit and the left column's entry.
    const d =
      `M ${r(sx)},${r(sy)}` +
      chamferColumn(xr, sy, railY, CHAMFER, -1, -1) +
      chamferColumn(xl, railY, ty, CHAMFER, 1, 1) +
      ` L ${r(tx)},${r(ty)}`;
    // Clear-segment anchor: the rail's leftward horizontal run, source side
    // (labelX, railY). The chip rides this rail leg -- held a wide gap off any
    // container slab -- so it sits off the source vertical whose midpoint can hug
    // a loop-box border; a de-confliction slide runs ALONG the rail, and the
    // source-side clamp keeps it clear of the target entry gutter at xl where the
    // arrival chips crowd.
    return [d, r(labelX), r(railY)];
  }

  // Forward. forwardStepGeometry scales the stub+chamfer budget down
  // proportionally when the gap is too narrow to fit a full symmetric shape
  // (bottoming out at a plain step) and resolves the bend column: default
  // midpoint, or the caller's bendX clamped to the margins, falling back to the
  // midpoint when the corridor is too tight to host a bend. A srcColX hint
  // (jogForwardLegs, blocked source leg) replaces the column outright and is
  // used unclamped: the routing pass proved it clear, and the clamp could push
  // it back into the blocked band.
  const { chamfer, bx: stepBx } = forwardStepGeometry(sx, tx, bendX);
  const bx = args.srcColX ?? stepBx;

  // Shared fan-out column (fanoutColumn): every member of one (item, source
  // port) formation draws its vertical at the SAME bx, so the bend-column
  // anchor below would stack all their chips on the one line. Such a member
  // anchors at the middle of its own final horizontal leg instead -- the run
  // from the bend's outgoing chamfer to the target port, which is the member's
  // alone. Clamped to the leg so a degenerate (or unclamped srcColX) column
  // cannot push the anchor off the drawn polyline.
  const legAnchorX = (cornerChamfer: number): number =>
    (Math.min(bx + cornerChamfer, tx) + tx) / 2;
  const fanoutLeg = args.fanoutColumn === true;

  // Same rail: a plain straight line, no vertical offset at all. The anchor
  // sits at the bend column (on the line by construction), NOT the geometric
  // midpoint: the three forward shapes (straight, small-dy diagonal, full
  // step) all anchor at (bx, mid(sy, ty)) so the anchor is CONTINUOUS across
  // their branch boundaries. Live handle coordinates and the seating pass's
  // offline port model can disagree by a pixel; if that pixel flips the branch,
  // a discontinuous anchor applies the seat's labelDx/labelDy to a point
  // hundreds of units away and strands the chip off its line (the food-tundra
  // own-card chip defect). Unhinted callers see no change: the default bend
  // column IS the corridor midpoint.
  if (sy === ty) {
    const d = `M ${r(sx)},${r(sy)} L ${r(tx)},${r(ty)}`;
    return [d, r(fanoutLeg ? legAnchorX(chamfer) : bx), r(sy)];
  }

  // Small dy: a vertical run plus two chamfers will not fit between the rails, so
  // join the two horizontal runs with a single diagonal (no vertical segment).
  // Anchor at the diagonal's midpoint (bx, mid(sy, ty)) -- the same bend-column
  // rule as the full step below (anchor continuity, see the same-rail comment).
  // The diagonal still closes on a long horizontal at ty, so a blocked small-dy
  // leg carries a stamped legY (jogForwardLegs) and skips this branch for the
  // jog shape below; absent the hint the diagonal is byte-identical.
  if (args.legY === undefined && Math.abs(ty - sy) <= 2 * chamfer) {
    const d =
      `M ${r(sx)},${r(sy)}` +
      ` L ${r(bx - chamfer)},${r(sy)}` +
      ` L ${r(bx + chamfer)},${r(ty)}` +
      ` L ${r(tx)},${r(ty)}`;
    return fanoutLeg
      ? [d, r(legAnchorX(chamfer)), r(ty)]
      : [d, r(bx), r((sy + ty) / 2)];
  }

  // Normal forward step: H run, chamfer, V run, chamfer, H run into target.
  // When the final leg at the target y would cross an intervening card,
  // jogForwardLegs stamps a clear legY: bend to it, run the long horizontal
  // there (clear of the card), then descend / ascend to the target y in the
  // target's entry gutter (descentX) before the final rightward stub. The bend
  // column already sits in a node-free corridor, so its vertical is clear at any
  // legY. Absent the hint the leg runs straight at ty, byte-identical.
  if (args.legY !== undefined) {
    const descentX = args.jogDescentX ?? args.entryX ?? tx - PORT_STUB;
    const jog =
      `M ${r(sx)},${r(sy)}` +
      chamferColumn(bx, sy, args.legY, chamfer) +
      chamferColumn(descentX, args.legY, ty, chamfer) +
      ` L ${r(tx)},${r(ty)}`;
    // A member pinned to a shared fan-out column anchors on the JOG's clear
    // horizontal (the run at legY from the bend to the descent column) instead:
    // the descent vertical is fine for a lone edge, but here the run this member
    // shares with its siblings is the bend vertical, and a chip that slid back
    // to it would stand on every sibling's stroke. The run at legY is this
    // member's alone. Falls through to the descent anchor when the jog leaves no
    // horizontal between the two chamfers (a descent column right beside the
    // bend).
    const runLo = bx + chamfer;
    const runHi = descentX - chamfer;
    if (fanoutLeg && runHi > runLo) {
      return [jog, r((runLo + runHi) / 2), r(args.legY)];
    }
    // Clear-segment anchor: the jog-descent vertical (descentX) run midpoint --
    // the corridor leg carrying the edge down into the target after the leg has
    // cleared the intervening card.
    return [jog, r(descentX), r((args.legY + ty) / 2)];
  }
  // Enlarge the two corner bevels toward MAX_CHAMFER when the bend carries a
  // corridor budget (P6 PCB-style long chamfers). Cap by half the shorter
  // adjacent leg -- the source-side horizontal (bx - sx), the target-side
  // horizontal (tx - bx), and the vertical run (|ty - sy|) -- so a bevel never
  // overruns its own legs, and by the stamped budget so it never reaches a
  // sibling column's vertical. Absent the budget the base chamfer stands and the
  // path is byte-identical. The half-leg cap already shrinks in a narrow
  // corridor, so it composes with the narrow-gap scaling above. The anchor rides
  // the bend column at the run midpoint, which stays on the polyline for any
  // chamfer (it is the mid of the vertical run, or of the collapsed diagonal when
  // the cap reaches half the vertical leg).
  // The budget's sibling-envelope invariant was proven for the stagger column at
  // bendX (half the stagger pitch keeps a fattened bevel off the neighbour's
  // vertical). A srcColX hint replaces the column outright with a jog-cleared
  // one carrying only a CHAMFER of margin, where that invariant does not hold --
  // so a jogged source column keeps the base chamfer regardless of any stamped
  // budget.
  const stepChamfer =
    args.chamferBudget === undefined || args.srcColX !== undefined
      ? chamfer
      : Math.min(
          MAX_CHAMFER,
          Math.min(bx - sx, tx - bx, Math.abs(ty - sy)) / 2,
          args.chamferBudget,
        );
  const d =
    `M ${r(sx)},${r(sy)}` +
    chamferColumn(bx, sy, ty, stepChamfer) +
    ` L ${r(tx)},${r(ty)}`;
  if (fanoutLeg) return [d, r(legAnchorX(stepChamfer)), r(ty)];
  // Clear-segment anchor: the bend-column vertical (bx) run midpoint. The old
  // geometric midpoint often landed on the target-side horizontal, which cuts
  // across foreign card rows; this vertical corridor leg is clear of them.
  return [d, r(bx), r((sy + ty) / 2)];
}

// chamferBusPath: a bus-trunk member. Exits the source rightward, chamfers down
// into the shared lane, runs along it, then chamfers up (or down) at the rise
// column and enters the target with a final rightward stub. Returns the drop and
// rise columns (where BusEdge draws its two chips) and the junction point (where
// BusEdge draws its dot, on the lane just before the rise chamfer).
//
// Accepts the full RoutingHints so callers can spread routingHintsFromData; a
// bus run reads only the bus-relevant hints (entryX, dropX, riseX) and ignores
// the rest (bendX / legY / railY apply to the forward step and backward rail).
export function chamferBusPath(
  args: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    laneY: number;
  } & RoutingHints,
): {
  path: string;
  dropX: number;
  riseX: number;
  junction: { x: number; y: number };
} {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, laneY } = args;
  const gap = tx - sx;
  // Budget for a full symmetric shape: a stub plus a chamfer on each side.
  const budget = FORWARD_STEP_BUDGET;

  // Backward: target at or left of source. Drop one stub+chamfer inside the
  // source, run the lane leftward, rise one stub+chamfer inside the target. The
  // lane run reverses (riseX < dropX) but the final stub into the target still
  // finishes rightward. laneDir flips the junction to the lane's leftward side.
  if (gap <= 0) {
    // Drop column, the run that dives off the source into the lane.
    // clearBusColumns may move it clear of a foreign card / gutter (dropX);
    // absent that hint it falls back to the shared base (busDropBase).
    const dropX = args.dropX ?? busDropBase(sx);
    // Rise column, the run that climbs the target's Left-port gutter off the
    // lane. The entry-gutter pass stakes it out as a per-edge staggered column
    // (see assignEntryColumns) so two rises into one node never coincide, and
    // clearBusColumns may then move it clear of a foreign card / gutter (riseX,
    // which overrides the stagger). Absent that hint it falls back to the
    // shared base (busRiseBase, which itself prefers the stagger), keeping
    // every direct caller and its pinned test byte for byte identical.
    const riseX = args.riseX ?? busRiseBase(tx, args.entryX);
    const laneDir = -1;
    const path =
      `M ${r(sx)},${r(sy)}` +
      chamferColumn(dropX, sy, laneY, CHAMFER, -1, -1) +
      chamferColumn(riseX, laneY, ty, CHAMFER, 1, 1) +
      ` L ${r(tx)},${r(ty)}`;
    return {
      path,
      dropX: r(dropX),
      riseX: r(riseX),
      junction: { x: r(riseX - laneDir * CHAMFER), y: r(laneY) },
    };
  }

  // Narrow forward gap: too little room for two full stub+chamfer columns and a
  // lane run between them, so scale the chamfer by gap/budget (same idiom as the
  // forward step) and collapse both columns onto the corridor midpoint
  // (dropX === riseX), drawing a hairpin at x = mid: chamfer in, straight down
  // to the lane apex, straight back up the same column, chamfer out. The up-leg
  // exactly overlaps the down-leg along x = mid, so it strokes as one line
  // (an offset bevel there would read as a zero-area spur). Each chamfer is
  // dropped when its vertical leg is too short to fit one (same guard as
  // chamferColumn), going straight into/out of the column instead.
  if (gap < budget) {
    const scale = gap / budget;
    const chamfer = CHAMFER * scale;
    const mid = (sx + tx) / 2;
    const dirDown = laneY > sy ? 1 : -1; // source level -> lane apex
    const dirUp = ty > laneY ? 1 : -1; // lane apex -> target level
    const pts: Array<readonly [number, number]> = [[sx, sy]];
    if (Math.abs(laneY - sy) > 2 * chamfer) {
      pts.push([mid - chamfer, sy], [mid, sy + dirDown * chamfer]);
    } else {
      pts.push([mid, sy]);
    }
    pts.push([mid, laneY]);
    if (Math.abs(ty - laneY) > 2 * chamfer) {
      pts.push([mid, ty - dirUp * chamfer], [mid + chamfer, ty]);
    } else {
      pts.push([mid, ty]);
    }
    pts.push([tx, ty]);
    return {
      path: pathFromPoints(pts),
      dropX: r(mid),
      riseX: r(mid),
      // The junction dot sits on the actual hairpin apex vertex.
      junction: { x: r(mid), y: r(laneY) },
    };
  }

  // Wide forward gap: full symmetric drop-lane-rise. Drop and rise columns sit
  // one stub plus one chamfer inside each port, so the horizontal run
  // leaving/entering the handle is exactly PORT_STUB long. Normally the lane is
  // below both endpoints (drop down, rise up); when targetY is at or below the
  // lane the rise simply chamfers the other way. chamferColumn derives each turn
  // direction from its own y0 -> y1.
  // Drop column: clearBusColumns may move it clear of a foreign card / gutter
  // (dropX); absent that hint it falls back to the shared base (busDropBase),
  // keeping direct callers and pinned tests byte for byte identical.
  const dropX = args.dropX ?? busDropBase(sx);
  // Rise column: the entry-gutter pass may stagger it (see assignEntryColumns)
  // and clearBusColumns may then move it clear of a foreign card / gutter (riseX,
  // which overrides the stagger); absent that hint it falls back to the shared
  // base (busRiseBase, which itself prefers the stagger), keeping direct callers
  // and pinned tests byte for byte identical.
  const riseX = args.riseX ?? busRiseBase(tx, args.entryX);
  const laneDir = 1;
  const path =
    `M ${r(sx)},${r(sy)}` +
    chamferColumn(dropX, sy, laneY, CHAMFER) +
    chamferColumn(riseX, laneY, ty, CHAMFER) +
    ` L ${r(tx)},${r(ty)}`;
  return {
    path,
    dropX: r(dropX),
    riseX: r(riseX),
    junction: { x: r(riseX - laneDir * CHAMFER), y: r(laneY) },
  };
}

// chamferFanoutPath: one member of a fan-out trunk (routeFanoutEdges). N members
// share a source PORT (same item, same source unit) and fan out to N targets one
// layer over. Every member is drawn with the SAME junction column, so their
// shared trunk segment -- the horizontal from the source port out to the junction
// -- overlaps into one line and the trunk visually draws once (exactly as a bus
// lane draws once from its members' overlapping lane runs). Each member then
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
  } & RoutingHints,
): {
  path: string;
  junction: { x: number; y: number };
  trunkAnchor: { x: number; y: number };
  branchAnchor: { x: number; y: number };
} {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = args;
  // Junction column: the classifier's shared column, clamped into the corridor
  // (one stub + chamfer inside each port) so both the trunk segment and the
  // branch leg stay well formed. When the corridor is too tight to host a
  // distinct column, fall back to the midpoint (a plain step).
  const lo = sx + PORT_STUB + CHAMFER;
  const hi = tx - PORT_STUB - CHAMFER;
  const mid = (sx + tx) / 2;
  const desired = args.junctionX ?? mid;
  const jx = lo < hi ? clamp(desired, lo, hi) : mid;
  // The junction dot marks the split, so it must sit ON the drawn geometry.
  // The sharp corner (jx, sy) is cut away by the branch chamfer; the last
  // point every member still shares is one chamfer before the column, on the
  // trunk horizontal -- for a branching member, a small-dy diagonal, AND a
  // shared-y straight trunk alike, so all members of one trunk agree on it.
  const junction = { x: r(jx - CHAMFER), y: r(sy) };
  // Aggregate chip rides the shared trunk horizontal, centered on the run from
  // the source port to the junction DOT (jx - CHAMFER, above), not the cut
  // corner. Centering on the dot-terminated run keeps the anchor at or left of
  // the seating pass's keep-off-truncated slide end (keepoff is at most half
  // the source-to-dot span) up to r()'s rounding, whose sub-pixel overhang the
  // seat clamps away, so an uncrowded aggregate seats at its anchor with no
  // stamped offset.
  const trunkAnchor = { x: r((sx + jx - CHAMFER) / 2), y: r(sy) };

  // Shared-y member: a straight trunk with no branch vertical. The branch chip
  // has no vertical to ride, so it falls back to the trunk midpoint.
  if (sy === ty) {
    const d = `M ${r(sx)},${r(sy)} L ${r(tx)},${r(ty)}`;
    return {
      path: d,
      junction,
      trunkAnchor,
      branchAnchor: { x: r(mid), y: r(sy) },
    };
  }

  const branchAnchor = { x: r(jx), y: r((sy + ty) / 2) };

  // Small dy: a vertical run plus two chamfers will not fit, so join the two
  // horizontals with a single diagonal at the junction column.
  if (Math.abs(ty - sy) <= 2 * CHAMFER) {
    const d =
      `M ${r(sx)},${r(sy)}` +
      ` L ${r(jx - CHAMFER)},${r(sy)}` +
      ` L ${r(jx + CHAMFER)},${r(ty)}` +
      ` L ${r(tx)},${r(ty)}`;
    return { path: d, junction, trunkAnchor, branchAnchor };
  }

  // Normal branch: trunk horizontal, chamfer, branch vertical, chamfer, final
  // rightward stub into the target.
  const d =
    `M ${r(sx)},${r(sy)}` +
    chamferColumn(jx, sy, ty, CHAMFER) +
    ` L ${r(tx)},${r(ty)}`;
  return { path: d, junction, trunkAnchor, branchAnchor };
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
// Exported for the seating pass, whose branch seat slices the same leg, and
// for the short-leg suite, which measures a member's leg extent with this
// slice so its premise reads the leg the branch rule gates on.
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

// The DRAWN edge: given one edge's drawn ports, its type and its stamped data,
// the polyline the canvas paints and every anchor that rides it. The one place
// that resolves the routing hints, the bus / fan-out discriminants, the lane-row
// fallback, the parse of `d` into vertices, and the fan-out branch-leg slice --
// so the renderers (endpoints from React Flow props) and the chip-seating
// reconstruction (endpoints from drawnPortsOf) cannot disagree about any of it.
// A new routing hint threaded through RoutingHints and routingHintsFromData
// therefore reaches render and deconflictChipAnchors at once, by construction
// rather than by convention.
//
// Frame: DRAWN, never model. Comparing any of these coordinates against a model
// rect is wrong by the port drift, exactly at the thresholds the ratchets live
// on. `pts` is the parse of `path`, so no caller re-parses; every returned
// anchor lies on `pts`. Pure, total, deterministic: an unrecognised type or
// unstamped data yields the item shape with the builders' default hints, the
// same way an unrecognised edge passes a routing pass through unchanged.
//
// What stays outside: the seat offsets (labelDx/Dy, fanoutBranch*, busChipDy),
// the hide flags and the dot families are stamps on edge data. This answers
// where the line and its anchors are, never where a chip ended up.
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
      shape: "lane";
      path: string;
      pts: ReadonlyArray<readonly [number, number]>;
      laneY: number;
      dropX: number;
      riseX: number;
      junction: Anchor;
    };

export function drawnEdge(
  ports: DrawnPorts,
  edgeType: string | undefined,
  data: unknown,
): DrawnEdge {
  const hints = routingHintsFromData(data);
  const d = data as Record<string, unknown> | undefined;

  if (edgeType === "bus" && d?.fanout === true) {
    const fan = chamferFanoutPath({ ...ports, ...hints });
    const pts = parsePathPoints(fan.path);
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

  if (edgeType === "bus") {
    // Narrow on `"laneY" in` (the discriminant the lane bands and the census
    // helpers use) rather than a cast: this bus edge is the lane variant only
    // because the fan-out arm above did not claim it. A member whose lane is
    // unstamped rides its own target row.
    const laneY =
      d !== undefined && "laneY" in d && typeof d.laneY === "number"
        ? d.laneY
        : ports.targetY;
    const lane = chamferBusPath({ ...ports, laneY, ...hints });
    return {
      shape: "lane",
      path: lane.path,
      pts: parsePathPoints(lane.path),
      laneY,
      dropX: lane.dropX,
      riseX: lane.riseX,
      junction: lane.junction,
    };
  }

  const [path, labelX, labelY] = chamferStepPath({ ...ports, ...hints });
  return {
    shape: "item",
    path,
    pts: parsePathPoints(path),
    labelAnchor: { x: labelX, y: labelY },
  };
}
