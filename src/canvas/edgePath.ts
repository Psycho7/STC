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

// Round to two decimals so degraded/scaled geometry does not produce long
// floating tails in the emitted `d` string (keeps pinned tests stable).
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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

// pathMidpoint: the point at 50% of the cumulative polyline length of an
// absolute "M x,y L x,y ..." path string, the only form this module emits.
// Walks the segments accumulating length until half the total is covered, then
// interpolates within the covering segment; a single-segment path degenerates
// to that segment's center. Coordinates come back through r() so anchors stay
// as stable as the path coordinates they derive from.
export function pathMidpoint(d: string): [number, number] {
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
  let remaining = total / 2;
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
// path plus the label anchor at the geometric midpoint of the drawn polyline
// (50% of cumulative length, via pathMidpoint), so the chip always sits on the
// line it labels. The final segment is always a rightward horizontal into
// target.
export function chamferStepPath(args: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  bendX?: number;
  entryX?: number;
}): [path: string, labelX: number, labelY: number] {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, bendX } = args;
  const gap = tx - sx;

  // Backward: the target sits at or left of the source (ELK breaks cycles by
  // reversing edges, so targetX can be <= sourceX). Route right out of the
  // source, down/up to a detour rail midway between the endpoints, left past the
  // target, then back to the target level and a final rightward stub in.
  if (gap <= 0) {
    const xr = sx + PORT_STUB; // right vertical column, one stub out of source
    // Left vertical column, the run that enters the target's Left port. The
    // entry-gutter pass (assignEntryColumns in busRouting) stakes this out as a
    // per-edge staggered column so two backward rails into one node never
    // overlap; absent that hint it falls back to a single stub before the port,
    // which keeps every direct (un-routed) caller and its pinned test byte for
    // byte identical.
    const xl = args.entryX ?? tx - PORT_STUB;
    // Rail midway between the endpoints. When they share a y the midpoint would
    // sit on top of both stubs, so drop the rail below to keep it visible.
    const railY = sy === ty ? sy + PORT_STUB + 2 * CHAMFER : (sy + ty) / 2;
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
    // Anchor at the length midpoint; on a typical detour (long leftward rail,
    // short end columns) that puts the label on the rail.
    return [d, ...pathMidpoint(d)];
  }

  // Forward. Scale the stub+chamfer budget down proportionally when the gap is
  // too narrow to fit a full symmetric shape, bottoming out at a plain step.
  const budget = 2 * (PORT_STUB + CHAMFER);
  const scale = gap >= budget ? 1 : gap / budget;
  const stub = PORT_STUB * scale;
  const chamfer = CHAMFER * scale;
  // Bend column: default midpoint, or the caller's bendX clamped to the margins.
  // When the corridor is too tight to host a bend (scaled range collapses), fall
  // back to the midpoint.
  const lo = sx + stub + chamfer;
  const hi = tx - stub - chamfer;
  const mid = (sx + tx) / 2;
  const bx = lo < hi ? (bendX !== undefined ? clamp(bendX, lo, hi) : mid) : mid;

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
  const d =
    `M ${r(sx)},${r(sy)}` + chamferColumn(bx, sy, ty, chamfer) + ` L ${r(tx)},${r(ty)}`;
  return [d, ...pathMidpoint(d)];
}

// chamferBusPath: a bus-trunk member. Exits the source rightward, chamfers down
// into the shared lane, runs along it, then chamfers up (or down) at the rise
// column and enters the target with a final rightward stub. Returns the drop and
// rise columns (where BusEdge draws its two chips) and the junction point (where
// BusEdge draws its dot, on the lane just before the rise chamfer).
export function chamferBusPath(args: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  laneY: number;
  entryX?: number;
}): {
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
    const dropX = sx + PORT_STUB + CHAMFER;
    // Rise column, the run that climbs the target's Left-port gutter off the
    // lane. The entry-gutter pass stakes it out as a per-edge staggered column
    // (see assignEntryColumns) so two rises into one node never coincide; absent
    // that hint it falls back to one stub+chamfer inside the port, keeping every
    // direct caller and its pinned test byte for byte identical.
    const riseX = args.entryX ?? tx - PORT_STUB - CHAMFER;
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
  const dropX = sx + PORT_STUB + CHAMFER;
  // Rise column: the entry-gutter pass may stagger it (see assignEntryColumns);
  // absent that hint it falls back to one stub+chamfer inside the target port,
  // keeping direct callers and pinned tests byte for byte identical.
  const riseX = args.entryX ?? tx - PORT_STUB - CHAMFER;
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
