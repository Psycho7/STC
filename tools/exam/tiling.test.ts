import { describe, expect, test } from "vitest";
import {
  safeRegion,
  viewportFor,
  tileGrid,
  computeCoverage,
  type Rect,
} from "./tiling";

const PANE: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe("safeRegion", () => {
  test("subtracts a bottom-left overlay by raising the floor", () => {
    const controls: Rect = { x: 0, y: 1000, width: 40, height: 80 };
    const safe = safeRegion(PANE, [controls], 0);
    expect(safe.height).toBe(1000);
    expect(safe.y).toBe(0);
  });

  test("applies the inset on all four sides", () => {
    const safe = safeRegion(PANE, [], 10);
    expect(safe).toEqual({ x: 10, y: 10, width: 1900, height: 1060 });
  });

  test("ignores an overlay that touches no pane edge", () => {
    const floating: Rect = { x: 800, y: 400, width: 100, height: 100 };
    expect(safeRegion(PANE, [floating], 0)).toEqual(PANE);
  });

  // The real React Flow chrome: controls bottom-left, minimap bottom-right,
  // attribution bottom-right under the minimap. All three sit on the floor, so
  // the safe region must keep its full width and only lose height.
  test("keeps full width when the whole chrome row sits on the floor", () => {
    const controls: Rect = { x: 0, y: 1000, width: 40, height: 80 };
    const minimap: Rect = { x: 1700, y: 880, width: 220, height: 200 };
    const attribution: Rect = { x: 1830, y: 1060, width: 90, height: 20 };
    const safe = safeRegion(PANE, [controls, minimap, attribution], 0);
    expect(safe).toEqual({ x: 0, y: 0, width: 1920, height: 880 });
  });

  test("cuts the side when a full-height overlay hugs the left edge", () => {
    const sidebar: Rect = { x: 0, y: 0, width: 200, height: 1080 };
    expect(safeRegion(PANE, [sidebar], 0)).toEqual({
      x: 200,
      y: 0,
      width: 1720,
      height: 1080,
    });
  });

  test("raises the floor for a full-width bottom bar", () => {
    const bar: Rect = { x: 0, y: 1020, width: 1920, height: 60 };
    expect(safeRegion(PANE, [bar], 0)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1020,
    });
  });
});

describe("viewportFor", () => {
  test("places the world centre at the centre of the safe region", () => {
    const safe: Rect = { x: 20, y: 20, width: 1880, height: 1040 };
    const vp = viewportFor({ x: 500, y: 300 }, 0.75, safe);
    expect(500 * vp.zoom + vp.x).toBeCloseTo(safe.x + safe.width / 2, 6);
    expect(300 * vp.zoom + vp.y).toBeCloseTo(safe.y + safe.height / 2, 6);
    expect(vp.zoom).toBe(0.75);
  });
});

describe("tileGrid", () => {
  const safe: Rect = { x: 0, y: 0, width: 1000, height: 1000 };

  test("returns a single tile when content fits", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 100, height: 100 }, safe, 1, 0.15);
    expect(grid).toHaveLength(1);
    expect(grid[0]!.row).toBe(0);
    expect(grid[0]!.col).toBe(0);
  });

  test("tiles a plan four times wider than one tile", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 4000, height: 1000 }, safe, 1, 0.15);
    const cols = new Set(grid.map((t) => t.col));
    expect(cols.size).toBeGreaterThanOrEqual(4);
    expect(new Set(grid.map((t) => t.row)).size).toBe(1);
  });

  test("neighbouring tiles overlap by the requested fraction", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 4000, height: 1000 }, safe, 1, 0.15);
    const a = grid.find((t) => t.col === 0)!;
    const b = grid.find((t) => t.col === 1)!;
    const overlap = a.worldRect.x + a.worldRect.width - b.worldRect.x;
    expect(overlap).toBeCloseTo(1000 * 0.15, 6);
  });

  test("tile world size scales inversely with target zoom", () => {
    const at1 = tileGrid({ x: 0, y: 0, width: 10, height: 10 }, safe, 1, 0.15)[0]!;
    const at05 = tileGrid({ x: 0, y: 0, width: 10, height: 10 }, safe, 0.5, 0.15)[0]!;
    expect(at05.worldRect.width).toBeCloseTo(at1.worldRect.width * 2, 6);
  });

  // The grid is centred on the content, so a plan smaller than one tile is
  // framed in the middle of the shot instead of pinned to its top-left corner.
  test("centres the tile band on the content", () => {
    const grid = tileGrid({ x: 200, y: 300, width: 100, height: 100 }, safe, 1, 0.15);
    expect(grid[0]!.center.x).toBeCloseTo(250, 6);
    expect(grid[0]!.center.y).toBeCloseTo(350, 6);
  });

  test("the tile band spans the whole content on both axes", () => {
    const content: Rect = { x: -500, y: -200, width: 4000, height: 2600 };
    const grid = tileGrid(content, safe, 1, 0.15);
    const left = Math.min(...grid.map((t) => t.worldRect.x));
    const right = Math.max(...grid.map((t) => t.worldRect.x + t.worldRect.width));
    const top = Math.min(...grid.map((t) => t.worldRect.y));
    const bottom = Math.max(...grid.map((t) => t.worldRect.y + t.worldRect.height));
    expect(left).toBeLessThanOrEqual(content.x);
    expect(right).toBeGreaterThanOrEqual(content.x + content.width);
    expect(top).toBeLessThanOrEqual(content.y);
    expect(bottom).toBeGreaterThanOrEqual(content.y + content.height);
    expect(grid).toHaveLength(
      new Set(grid.map((t) => t.row)).size * new Set(grid.map((t) => t.col)).size,
    );
  });
});

describe("computeCoverage", () => {
  const tile: Rect = { x: 0, y: 0, width: 100, height: 100 };

  test("a point element fully inside one tile is covered", () => {
    const r = computeCoverage(
      [{ id: "chip-1", kind: "point", worldRect: { x: 10, y: 10, width: 5, height: 5 } }],
      [tile],
      0,
    );
    expect(r.covered).toEqual(["chip-1"]);
    expect(r.uncovered).toEqual([]);
  });

  test("a point element straddling every tile boundary is uncovered", () => {
    const r = computeCoverage(
      [{ id: "chip-2", kind: "point", worldRect: { x: 95, y: 10, width: 20, height: 5 } }],
      [tile, { x: 100, y: 0, width: 100, height: 100 }],
      0,
    );
    expect(r.covered).toEqual([]);
    expect(r.uncovered[0]!.id).toBe("chip-2");
  });

  test("an extended element split across two tiles is covered by the union", () => {
    const r = computeCoverage(
      [
        {
          id: "e:1",
          kind: "extended",
          worldRect: { x: 0, y: 50, width: 200, height: 1 },
          polyline: [
            [0, 50],
            [200, 50],
          ],
        },
      ],
      [tile, { x: 90, y: 0, width: 110, height: 100 }],
      5,
    );
    expect(r.covered).toEqual(["e:1"]);
  });

  test("an extended element leaving the union is uncovered", () => {
    const r = computeCoverage(
      [
        {
          id: "e:2",
          kind: "extended",
          worldRect: { x: 0, y: 50, width: 300, height: 1 },
          polyline: [
            [0, 50],
            [300, 50],
          ],
        },
      ],
      [tile],
      0,
    );
    expect(r.uncovered[0]!.id).toBe("e:2");
  });

  // A gap in the middle of the union is the case a naive bounding-box test
  // would wave through: both ends land in a tile, the middle lands in neither.
  test("an extended element crossing a gap between tiles is uncovered", () => {
    const r = computeCoverage(
      [
        {
          id: "e:gap",
          kind: "extended",
          worldRect: { x: 0, y: 50, width: 300, height: 1 },
          polyline: [
            [0, 50],
            [300, 50],
          ],
        },
      ],
      [tile, { x: 150, y: 0, width: 150, height: 100 }],
      0,
    );
    expect(r.covered).toEqual([]);
    expect(r.uncovered[0]!.id).toBe("e:gap");
    expect(r.uncovered[0]!.reason).toMatch(/union/);
  });

  // The seam margin is what stops a shot from "covering" an element only in the
  // few pixels before its own edge. The same element and the same tiles flip
  // from covered to uncovered when the margin no longer fits anywhere.
  describe("seam margin", () => {
    const seamTiles: readonly Rect[] = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 95, y: 0, width: 100, height: 100 },
    ];
    const straddler = {
      id: "e:seam",
      kind: "extended" as const,
      worldRect: { x: 92, y: 50, width: 11, height: 1 },
      polyline: [
        [92, 50],
        [103, 50],
      ] as Array<[number, number]>,
    };

    test("is covered when a tile can show it with the requested slack", () => {
      const r = computeCoverage([straddler], seamTiles, 2);
      expect(r.covered).toEqual(["e:seam"]);
    });

    test("is uncovered when no tile shows it that far from its own edge", () => {
      const r = computeCoverage([straddler], seamTiles, 10);
      expect(r.covered).toEqual([]);
      expect(r.uncovered[0]!.id).toBe("e:seam");
      expect(r.uncovered[0]!.kind).toBe("extended");
      // The union does hold it, so the margin is the only thing that failed.
      expect(r.uncovered[0]!.reason).toMatch(/edge/);
    });
  });

  test("falls back to the world rect when an extended element has no polyline", () => {
    const wide = {
      id: "e:norect",
      kind: "extended" as const,
      worldRect: { x: 0, y: 0, width: 300, height: 10 },
    };
    expect(computeCoverage([wide], [tile], 0).covered).toEqual([]);
    expect(
      computeCoverage([wide], [{ x: 0, y: 0, width: 400, height: 100 }], 5).covered,
    ).toEqual(["e:norect"]);
  });
});
