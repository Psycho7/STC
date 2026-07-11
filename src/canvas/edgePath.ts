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

// Round to two decimals so degraded/scaled geometry does not produce long
// floating tails in the emitted `d` string (keeps pinned tests stable).
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// An axis-aligned card rectangle in absolute graph coordinates, for rail
// obstacle avoidance.
export type ObstacleRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
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
  chamferBudget?: number;
};

// Pick the routing hints off an edge's `data`, omitting absent ones so each
// path builder's documented default kicks in. Shared by ItemEdge, BusEdge, and
// deconflictChipAnchors (see RoutingHints above).
export function routingHintsFromData(data: unknown): RoutingHints {
  const d = data as
    | {
        bendX?: unknown;
        legY?: unknown;
        jogDescentX?: unknown;
        srcColX?: unknown;
        entryX?: unknown;
        railY?: unknown;
        dropX?: unknown;
        riseX?: unknown;
        railXRight?: unknown;
        railXLeft?: unknown;
        junctionX?: unknown;
        chamferBudget?: unknown;
      }
    | undefined;
  return {
    ...(typeof d?.bendX === "number" ? { bendX: d.bendX } : {}),
    ...(typeof d?.legY === "number" ? { legY: d.legY } : {}),
    ...(typeof d?.jogDescentX === "number"
      ? { jogDescentX: d.jogDescentX }
      : {}),
    ...(typeof d?.srcColX === "number" ? { srcColX: d.srcColX } : {}),
    ...(typeof d?.entryX === "number" ? { entryX: d.entryX } : {}),
    ...(typeof d?.railY === "number" ? { railY: d.railY } : {}),
    ...(typeof d?.dropX === "number" ? { dropX: d.dropX } : {}),
    ...(typeof d?.riseX === "number" ? { riseX: d.riseX } : {}),
    ...(typeof d?.railXRight === "number" ? { railXRight: d.railXRight } : {}),
    ...(typeof d?.railXLeft === "number" ? { railXLeft: d.railXLeft } : {}),
    ...(typeof d?.junctionX === "number" ? { junctionX: d.junctionX } : {}),
    ...(typeof d?.chamferBudget === "number"
      ? { chamferBudget: d.chamferBudget }
      : {}),
  };
}

// Choose a backward-detour rail y clear of every card the rail horizontally
// spans. The rail runs at `preferredY` between xLo and xHi; a card whose x-range
// overlaps [xLo, xHi] and whose y-extent contains preferredY would be sliced.
// When that happens the rail moves to just above every spanned card
// (min top - gap) or just below every spanned card (max bottom + gap), whichever
// is the smaller move, so it clears all of them at once -- the same idea as the
// bus lane band, which sits clear of the nodes it would otherwise cross. Cards
// outside the x-span are ignored because the horizontal rail never reaches them.
// Pure.
export function clearRailY(
  preferredY: number,
  xLo: number,
  xHi: number,
  obstacles: ReadonlyArray<ObstacleRect>,
  gap = CHAMFER,
): number {
  const lo = Math.min(xLo, xHi);
  const hi = Math.max(xLo, xHi);
  const spanned = obstacles.filter((o) => o.right > lo && o.left < hi);
  if (spanned.length === 0) return preferredY;
  const hits = spanned.some(
    (o) => preferredY >= o.top && preferredY <= o.bottom,
  );
  if (!hits) return preferredY;
  const aboveY = Math.min(...spanned.map((o) => o.top)) - gap;
  const belowY = Math.max(...spanned.map((o) => o.bottom)) + gap;
  return preferredY - aboveY <= belowY - preferredY ? aboveY : belowY;
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

// pathPointAt: the point at `frac` (0..1) of the cumulative polyline length of
// an absolute "M x,y L x,y ..." path string, the only form this module emits.
// Walks the segments accumulating length until the fraction of the total is
// covered, then interpolates within the covering segment. Coordinates come back
// through r() so anchors stay as stable as the path coordinates they derive
// from. The chip de-confliction pass uses off-midpoint fractions to slide a
// blocked label along its own line.
export function pathPointAt(d: string, frac: number): [number, number] {
  const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as const,
  );
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

// pathMidpoint: pathPointAt at 50%; a single-segment path degenerates to that
// segment's center.
export function pathMidpoint(d: string): [number, number] {
  return pathPointAt(d, 0.5);
}

// chamferStepPath: forward step, small-dy diagonal, narrow-gap degradation, and
// backward S/C detour, all sharing the same chamfer convention. Returns the SVG
// path plus the label anchor on the polyline's PREFERRED CLEAR SEGMENT (2B): a
// forward step anchors on its bend-column vertical (or, when the final leg is
// jogged around a card, on the jog-descent vertical), a backward detour on its
// source-side rail vertical, and the degenerate shapes with no vertical (a
// same-rail straight line or a small-dy diagonal) fall back to the geometric
// midpoint. The corridor legs are vertically long and horizontally clear, so a
// chip there sits off the card rows the target-side horizontal midpoint used to
// cross, and a downward de-confliction nudge slides ALONG the vertical, keeping
// the chip on its own line. Every returned anchor lies on the drawn polyline.
// The final segment is always a rightward horizontal into target.
//
// The anchor is derived from the SAME branch geometry that builds the `d` (the
// bend column bx, the jog descentX, the rail column xr are all in hand), never
// re-parsed, so render and reconstruction agree by construction.
//
// New routing hint? Thread it through RoutingHints (and routingHintsFromData)
// so render and deconflictChipAnchors stay in lockstep.
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
    // Right vertical column, one stub out of the source. clampBackwardRails may
    // move it clear of a foreign card / gutter (railXRight); absent that hint it
    // falls back to the plain stub column, byte-identical for direct callers.
    const xr = args.railXRight ?? sx + PORT_STUB;
    // Left vertical column, the run that enters the target's Left port. The
    // entry-gutter pass (assignEntryColumns in busRouting) stakes this out as a
    // per-edge staggered column so two backward rails into one node never
    // overlap, and clampBackwardRails may then move it clear of a foreign card /
    // gutter (railXLeft, which overrides the stagger). Absent both hints it falls
    // back to a single stub before the port, which keeps every direct (un-routed)
    // caller and its pinned test byte for byte identical.
    const xl = args.railXLeft ?? args.entryX ?? tx - PORT_STUB;
    // Rail midway between the endpoints. When they share a y the midpoint would
    // sit on top of both stubs, so drop the rail below to keep it visible. A
    // threaded railY (from clampBackwardRails) overrides this to clear spanned
    // cards.
    const railY =
      args.railY ?? (sy === ty ? sy + PORT_STUB + 2 * CHAMFER : (sy + ty) / 2);
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
      return [d, ...pathMidpoint(d)];
    }
    // Right column exits leftward (-1, -1) onto the rail, left column enters
    // leftward (+1, +1) off it; the leftward lane run is the implicit segment
    // between the right column's exit and the left column's entry.
    const d =
      `M ${r(sx)},${r(sy)}` +
      chamferColumn(xr, sy, railY, CHAMFER, -1, -1) +
      chamferColumn(xl, railY, ty, CHAMFER, 1, 1) +
      ` L ${r(tx)},${r(ty)}`;
    // Clear-segment anchor: the source-side detour vertical (xr) run midpoint.
    // The chip rides this vertical corridor leg instead of the leftward rail, so
    // a downward de-confliction nudge slides it ALONG the vertical (staying on
    // its own line) and it sits on the clean source side, clear of the target's
    // entry gutter where the arrival chips crowd.
    return [d, r(xr), r((sy + railY) / 2)];
  }

  // Forward. Scale the stub+chamfer budget down proportionally when the gap is
  // too narrow to fit a full symmetric shape, bottoming out at a plain step.
  const budget = 2 * (PORT_STUB + CHAMFER);
  const scale = gap >= budget ? 1 : gap / budget;
  const stub = PORT_STUB * scale;
  const chamfer = CHAMFER * scale;
  // Bend column: default midpoint, or the caller's bendX clamped to the margins.
  // When the corridor is too tight to host a bend (scaled range collapses), fall
  // back to the midpoint. A srcColX hint (jogForwardLegs, blocked source leg)
  // replaces the column outright and is used unclamped: the routing pass proved
  // it clear, and the clamp could push it back into the blocked band.
  const lo = sx + stub + chamfer;
  const hi = tx - stub - chamfer;
  const mid = (sx + tx) / 2;
  const bx =
    args.srcColX ??
    (lo < hi ? (bendX !== undefined ? clamp(bendX, lo, hi) : mid) : mid);

  // Same rail: a plain straight line, no vertical offset at all.
  if (sy === ty) {
    const d = `M ${r(sx)},${r(sy)} L ${r(tx)},${r(ty)}`;
    return [d, ...pathMidpoint(d)];
  }

  // Small dy: a vertical run plus two chamfers will not fit between the rails, so
  // join the two horizontal runs with a single diagonal (no vertical segment).
  if (Math.abs(ty - sy) <= 2 * chamfer) {
    const d =
      `M ${r(sx)},${r(sy)}` +
      ` L ${r(bx - chamfer)},${r(sy)}` +
      ` L ${r(bx + chamfer)},${r(ty)}` +
      ` L ${r(tx)},${r(ty)}`;
    return [d, ...pathMidpoint(d)];
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
// New routing hint? Thread it through RoutingHints (and routingHintsFromData) so
// render and deconflictChipAnchors stay in lockstep.
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
  const budget = 2 * (PORT_STUB + CHAMFER);

  // Backward: target at or left of source. Drop one stub+chamfer inside the
  // source, run the lane leftward, rise one stub+chamfer inside the target. The
  // lane run reverses (riseX < dropX) but the final stub into the target still
  // finishes rightward. laneDir flips the junction to the lane's leftward side.
  if (gap <= 0) {
    // Drop column, the run that dives off the source into the lane.
    // clearBusColumns may move it clear of a foreign card / gutter (dropX);
    // absent that hint it falls back to one stub+chamfer inside the source port.
    const dropX = args.dropX ?? sx + PORT_STUB + CHAMFER;
    // Rise column, the run that climbs the target's Left-port gutter off the
    // lane. The entry-gutter pass stakes it out as a per-edge staggered column
    // (see assignEntryColumns) so two rises into one node never coincide, and
    // clearBusColumns may then move it clear of a foreign card / gutter (riseX,
    // which overrides the stagger). Absent both hints it falls back to one
    // stub+chamfer inside the port, keeping every direct caller and its pinned
    // test byte for byte identical.
    const riseX = args.riseX ?? args.entryX ?? tx - PORT_STUB - CHAMFER;
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
  // (dropX); absent that hint it falls back to one stub+chamfer inside the source
  // port, keeping direct callers and pinned tests byte for byte identical.
  const dropX = args.dropX ?? sx + PORT_STUB + CHAMFER;
  // Rise column: the entry-gutter pass may stagger it (see assignEntryColumns)
  // and clearBusColumns may then move it clear of a foreign card / gutter (riseX,
  // which overrides the stagger); absent both hints it falls back to one
  // stub+chamfer inside the target port, keeping direct callers and pinned tests
  // byte for byte identical.
  const riseX = args.riseX ?? args.entryX ?? tx - PORT_STUB - CHAMFER;
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
// leg anchor (where this member's own share chip seats). Same degenerate guards
// as chamferStepPath's forward branch: a shared-y member draws a straight trunk
// with no branch vertical, a small-dy member a single diagonal. Pure.
//
// New routing hint? Thread it through RoutingHints (and routingHintsFromData) so
// render and deconflictChipAnchors stay in lockstep.
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
  const junction = { x: r(jx), y: r(sy) };
  // Aggregate chip rides the shared trunk horizontal (source port -> junction);
  // its midpoint sits left of the junction's incoming chamfer by construction
  // (jx is at least a stub+chamfer right of the source).
  const trunkAnchor = { x: r((sx + jx) / 2), y: r(sy) };

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
