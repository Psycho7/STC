// Tiling and coverage math for the render-quality exam harness.
//
// Pure geometry: no Playwright, no DOM, no I/O, so it stays unit-testable in
// jsdom. The screenshot CLI imports these and drives the browser around them.
//
// Coordinate contract. Two frames appear here and they must not be mixed:
//   - CSS px, PANE-RELATIVE: the .react-flow pane's own box, origin at its
//     top-left corner. `safeRegion`'s pane and overlays, and the offset half of
//     a `Viewport`, all live here. The scene collector already reports overlay
//     rects and element clientRects in this frame.
//   - WORLD (flow / graph) px: the coordinates nodes and edge paths are laid
//     out in, independent of the camera. Tile rects and coverage elements live
//     here.
// React Flow maps one to the other with `screen = world * zoom + offset`, where
// `screen` is pane-relative CSS px. `viewportFor` produces exactly that offset,
// which is why the safe region it centres on must be pane-relative too.

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };
export type TileSpec = {
  row: number;
  col: number;
  center: { x: number; y: number };
  worldRect: Rect;
};

// Float slop for edge-touch and containment tests. World coordinates come out
// of a layout engine and a matrix multiply, so exact comparisons on a shared
// boundary are not reliable.
const EPS = 1e-9;

// The sub-rectangle of the pane a camera may frame content in: the pane minus
// the screen-fixed chrome that occludes it, minus a rim inset.
//
// Both `pane` and `overlays` must be in the SAME frame, which in practice means
// the pane-relative one: pass `{ x: 0, y: 0, width, height }` for the pane, and
// overlay rects exactly as the scene collector reports them (already relative to
// the pane's top-left). Do not offset the overlays by the pane's page position.
//
// An overlay is subtracted by pushing in the pane edge it is anchored to. Only
// an overlay that touches an edge can be subtracted at all: one floating in the
// middle would split the region in two, and the result has to stay a rectangle.
// When an overlay touches several edges, prefer raising the floor or lowering
// the ceiling over cutting a flank, because React Flow's chrome (controls,
// minimap, attribution) all hugs the bottom - one horizontal cut clears the lot,
// whereas per-overlay side cuts would eat both flanks of the viewport. A cut
// that would collapse the region is rejected in favour of the other axis, which
// is what keeps a full-height sidebar from erasing everything.
export function safeRegion(
  pane: Rect,
  overlays: readonly Rect[],
  inset: number,
): Rect {
  let safe = pane;
  for (const overlay of overlays) {
    // Test each overlay against what is left, not against the original pane: an
    // overlay already outside the shrunken region occludes nothing, and one that
    // still pokes in is anchored to the current edge, not the pane's.
    const clipped = intersect(safe, overlay);
    if (clipped === null) continue;
    safe = cutOverlay(safe, clipped) ?? safe;
  }
  return insetRect(safe, inset);
}

// Try the horizontal cuts first, then the vertical ones; the first candidate
// that leaves a non-degenerate region wins. Returns null when the overlay
// touches no edge, or when every cut it does justify would collapse the region.
function cutOverlay(region: Rect, overlay: Rect): Rect | null {
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const overlayRight = overlay.x + overlay.width;
  const overlayBottom = overlay.y + overlay.height;

  const candidates: Rect[] = [];
  if (overlayBottom >= bottom - EPS) {
    candidates.push({ ...region, height: overlay.y - region.y });
  }
  if (overlay.y <= region.y + EPS) {
    candidates.push({ ...region, y: overlayBottom, height: bottom - overlayBottom });
  }
  if (overlayRight >= right - EPS) {
    candidates.push({ ...region, width: overlay.x - region.x });
  }
  if (overlay.x <= region.x + EPS) {
    candidates.push({ ...region, x: overlayRight, width: right - overlayRight });
  }
  return candidates.find((r) => r.width > EPS && r.height > EPS) ?? null;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function insetRect(rect: Rect, inset: number): Rect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - 2 * inset,
    height: rect.height - 2 * inset,
  };
}

// The React Flow transform that puts `center` (world) at the centre of `safe`
// (pane-relative CSS px) at the given zoom.
export function viewportFor(
  center: { x: number; y: number },
  zoom: number,
  safe: Rect,
): Viewport {
  return {
    x: safe.x + safe.width / 2 - center.x * zoom,
    y: safe.y + safe.height / 2 - center.y * zoom,
    zoom,
  };
}

// Cover `content` with camera tiles. One tile shows `safe.width / targetZoom` by
// `safe.height / targetZoom` of world, since the safe region is the only part of
// the pane a reviewer can actually read. Neighbours step by `(1 - overlap)` of a
// tile so anything sitting on a seam still lands whole inside a neighbour.
//
// The band is centred on the content rather than pinned to its top-left corner,
// so a plan smaller than one tile is framed in the middle of the shot. There is
// always at least one tile, even for empty content.
export function tileGrid(
  content: Rect,
  safe: Rect,
  targetZoom: number,
  overlap: number,
): TileSpec[] {
  const tileW = safe.width / targetZoom;
  const tileH = safe.height / targetZoom;
  const stepX = tileW * (1 - overlap);
  const stepY = tileH * (1 - overlap);

  const cols = countTiles(content.width, tileW, stepX);
  const rows = countTiles(content.height, tileH, stepY);

  // Spread the band's surplus evenly on both sides of the content.
  const startX = content.x - (tileW + (cols - 1) * stepX - content.width) / 2;
  const startY = content.y - (tileH + (rows - 1) * stepY - content.height) / 2;

  const tiles: TileSpec[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const worldRect: Rect = {
        x: startX + col * stepX,
        y: startY + row * stepY,
        width: tileW,
        height: tileH,
      };
      tiles.push({
        row,
        col,
        center: {
          x: worldRect.x + worldRect.width / 2,
          y: worldRect.y + worldRect.height / 2,
        },
        worldRect,
      });
    }
  }
  return tiles;
}

function countTiles(span: number, tile: number, step: number): number {
  if (span <= tile + EPS || step <= EPS) return 1;
  return Math.ceil((span - tile) / step - EPS) + 1;
}

export type CoverageElement = {
  id: string;
  kind: "point" | "extended";
  worldRect: Rect;
  polyline?: Array<[number, number]>;
};
export type CoverageResult = {
  covered: string[];
  uncovered: Array<{ id: string; kind: string; reason: string }>;
};

// Did the tiles that were actually shot show every element in full?
//
// A `point` element (a chip, a glyph, a node) is only useful when one single
// shot holds all of it: half a chip in one tile and half in another is two
// unreadable halves, so it must fit inside one tile rect.
//
// An `extended` element (an edge polyline, a group slab) is allowed to be read
// across shots, so it counts as covered when the tile union contains every
// point of it. The seam margin is the second half of that bargain: at least one
// tile must show part of it sitting `seamMarginWorld` clear of that tile's own
// border, otherwise the only evidence of the element is a sliver hugging a shot
// edge, which a reviewer cannot judge. A larger margin therefore demands more
// context, not less.
export function computeCoverage(
  elements: readonly CoverageElement[],
  tileWorldRects: readonly Rect[],
  seamMarginWorld: number,
): CoverageResult {
  const covered: string[] = [];
  const uncovered: CoverageResult["uncovered"] = [];

  for (const element of elements) {
    const reason = uncoveredReason(element, tileWorldRects, seamMarginWorld);
    if (reason === null) covered.push(element.id);
    else uncovered.push({ id: element.id, kind: element.kind, reason });
  }
  return { covered, uncovered };
}

function uncoveredReason(
  element: CoverageElement,
  tiles: readonly Rect[],
  seamMargin: number,
): string | null {
  if (element.kind === "point") {
    return tiles.some((tile) => containsRect(tile, element.worldRect))
      ? null
      : "no single tile holds the whole element";
  }

  const segments = element.polyline
    ? polylineSegments(element.polyline)
    : rectSegments(element.worldRect);
  if (!segments.every((seg) => segmentInUnion(seg, tiles))) {
    return "part of the element falls outside the tile union";
  }

  const insetTiles = tiles
    .map((tile) => insetRect(tile, seamMargin))
    .filter((tile) => tile.width > EPS && tile.height > EPS);
  const shown = insetTiles.some((tile) =>
    segments.some((seg) => segmentTouchesRect(seg, tile)),
  );
  return shown ? null : "no tile shows the element clear of its own edge";
}

type Segment = { ax: number; ay: number; bx: number; by: number };

function polylineSegments(points: ReadonlyArray<readonly [number, number]>): Segment[] {
  if (points.length === 1) {
    const [x, y] = points[0]!;
    return [{ ax: x, ay: y, bx: x, by: y }];
  }
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    segments.push({ ax, ay, bx, by });
  }
  return segments;
}

// Without a polyline the world rect is all there is; its outline is a
// conservative stand-in, since a rect is inside the union exactly when its four
// sides are.
function rectSegments(rect: Rect): Segment[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    { ax: rect.x, ay: rect.y, bx: right, by: rect.y },
    { ax: right, ay: rect.y, bx: right, by: bottom },
    { ax: right, ay: bottom, bx: rect.x, by: bottom },
    { ax: rect.x, ay: bottom, bx: rect.x, by: rect.y },
  ];
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

// A segment is inside the union of rects when the parameter intervals it spends
// inside each rect, merged, cover the whole of [0, 1]. Testing the union rather
// than any single rect is the point: an edge that crosses a seam is inside no
// one tile, yet leaves nothing unseen.
function segmentInUnion(seg: Segment, tiles: readonly Rect[]): boolean {
  const spans: Array<[number, number]> = [];
  for (const tile of tiles) {
    const span = clipSegment(seg, tile);
    if (span !== null) spans.push(span);
  }
  spans.sort((a, b) => a[0] - b[0]);

  let reached = 0;
  for (const [start, end] of spans) {
    if (start > reached + EPS) return false;
    if (end > reached) reached = end;
    if (reached >= 1 - EPS) return true;
  }
  return reached >= 1 - EPS;
}

function segmentTouchesRect(seg: Segment, rect: Rect): boolean {
  return clipSegment(seg, rect) !== null;
}

// Liang-Barsky: the [t0, t1] slice of the segment that lies inside the rect, or
// null when it misses entirely.
function clipSegment(seg: Segment, rect: Rect): [number, number] | null {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < EPS) return q >= -EPS;
    const t = q / p;
    if (p < 0) {
      if (t > t1 + EPS) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0 - EPS) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };

  const inside =
    clip(-dx, seg.ax - rect.x) &&
    clip(dx, rect.x + rect.width - seg.ax) &&
    clip(-dy, seg.ay - rect.y) &&
    clip(dy, rect.y + rect.height - seg.ay);
  if (!inside || t0 > t1 + EPS) return null;
  return [t0, Math.max(t0, t1)];
}
