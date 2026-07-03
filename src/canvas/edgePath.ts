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

// One chamfered vertical column, entered from the left at y0 and exited to the
// right at y1: horizontal into the column, chamfer, vertical run, chamfer out.
// Shared by the forward step and both bus lane transitions (drop and rise); the
// backward-detour columns exit leftward instead and stay inline.
function chamferColumn(x: number, y0: number, y1: number, chamfer: number): string {
  const dir = y1 > y0 ? 1 : -1;
  return (
    ` L ${r(x - chamfer)},${r(y0)}` +
    ` L ${r(x)},${r(y0 + dir * chamfer)}` +
    ` L ${r(x)},${r(y1 - dir * chamfer)}` +
    ` L ${r(x + chamfer)},${r(y1)}`
  );
}

// chamferStepPath: forward step, small-dy diagonal, narrow-gap degradation, and
// backward S/C detour, all sharing the same chamfer convention. Returns the SVG
// path plus a fallback label anchor (the caller may override the y via
// labelSide). The final segment is always a rightward horizontal into target.
export function chamferStepPath(args: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  bendX?: number;
}): [path: string, labelX: number, labelY: number] {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, bendX } = args;
  const gap = tx - sx;

  // Backward: the target sits at or left of the source (ELK breaks cycles by
  // reversing edges, so targetX can be <= sourceX). Route right out of the
  // source, down/up to a detour rail midway between the endpoints, left past the
  // target, then back to the target level and a final rightward stub in.
  if (gap <= 0) {
    const xr = sx + PORT_STUB; // right vertical column, one stub out of source
    const xl = tx - PORT_STUB; // left vertical column, one stub before target
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
      return [d, r((xr + xl) / 2), r(railY)];
    }
    const dir1 = railY > sy ? 1 : -1; // source stub -> rail
    const dir2 = ty > railY ? 1 : -1; // rail -> target level
    const d =
      `M ${r(sx)},${r(sy)}` +
      ` L ${r(xr - CHAMFER)},${r(sy)}` +
      ` L ${r(xr)},${r(sy + dir1 * CHAMFER)}` +
      ` L ${r(xr)},${r(railY - dir1 * CHAMFER)}` +
      ` L ${r(xr - CHAMFER)},${r(railY)}` +
      ` L ${r(xl + CHAMFER)},${r(railY)}` +
      ` L ${r(xl)},${r(railY + dir2 * CHAMFER)}` +
      ` L ${r(xl)},${r(ty - dir2 * CHAMFER)}` +
      ` L ${r(xl + CHAMFER)},${r(ty)}` +
      ` L ${r(tx)},${r(ty)}`;
    // Label rides the leftward detour rail, at its midpoint.
    return [d, r((xr + xl) / 2), r(railY)];
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
  const midY = (sy + ty) / 2;

  // Same rail: a plain straight line, no vertical offset at all.
  if (sy === ty) {
    return [`M ${r(sx)},${r(sy)} L ${r(tx)},${r(ty)}`, r(bx), r(sy)];
  }

  // Small dy: a vertical run plus two chamfers will not fit between the rails, so
  // join the two horizontal runs with a single diagonal (no vertical segment).
  if (Math.abs(ty - sy) <= 2 * chamfer) {
    const d =
      `M ${r(sx)},${r(sy)}` +
      ` L ${r(bx - chamfer)},${r(sy)}` +
      ` L ${r(bx + chamfer)},${r(ty)}` +
      ` L ${r(tx)},${r(ty)}`;
    return [d, r(bx), r(midY)];
  }

  // Normal forward step: H run, chamfer, V run, chamfer, H run into target.
  const d =
    `M ${r(sx)},${r(sy)}` + chamferColumn(bx, sy, ty, chamfer) + ` L ${r(tx)},${r(ty)}`;
  return [d, r(bx), r(midY)];
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
}): {
  path: string;
  dropX: number;
  riseX: number;
  junction: { x: number; y: number };
} {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, laneY } = args;
  // Drop and rise columns sit one stub plus one chamfer inside each port, so the
  // horizontal run leaving/entering the handle is exactly PORT_STUB long.
  const dropX = sx + PORT_STUB + CHAMFER;
  const riseX = tx - PORT_STUB - CHAMFER;
  // Normally the lane is below both endpoints (drop down, rise up). When targetY
  // is at or below the lane the rise simply chamfers the other way; there is
  // never a turn at the port itself. chamferColumn derives each turn direction
  // from its own y0 -> y1.
  const path =
    `M ${r(sx)},${r(sy)}` +
    chamferColumn(dropX, sy, laneY, CHAMFER) +
    chamferColumn(riseX, laneY, ty, CHAMFER) +
    ` L ${r(tx)},${r(ty)}`;
  return {
    path,
    dropX: r(dropX),
    riseX: r(riseX),
    junction: { x: r(riseX - CHAMFER), y: r(laneY) },
  };
}
