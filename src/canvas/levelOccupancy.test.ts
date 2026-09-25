// The level-occupancy module, unit by unit.
//
// Everything here is a pure function of the geometry handed in, so every case
// below builds that geometry by hand rather than routing a plan. The corpus
// proof that the extraction moved nothing lives in levelOccupancy.equivalence
// .test.ts; this file pins what the module itself promises.

import { describe, it, expect } from "vitest";

import {
  FORWARD_LEVEL_FLOOR,
  chooseLevel,
  chooseLevelByCost,
  levelCandidates,
  levelCrossingCost,
  levelNearCardCount,
  levelPassesDot,
  runBandsOfEdge,
  runFloorHit,
  sharesPortRow,
  type LevelPorts,
  type RunBand,
} from "./levelOccupancy";
import { PORT_STUB, drawnEdge, horizontalRuns } from "./edgePath";
import { drawnPortsOf, nodeIndexOf } from "./nodeGeometry";
import type { RFAnyNode } from "./layout";
import {
  inputProductNode,
  mkEdge,
  orderedRecipeNode,
} from "./levelOccupancy.testkit";

// A band at `y` spanning [left, right], for the queries that take bands as
// data. The port rows default to values no `self` below coincides with, so a
// case that wants the waiver has to ask for it.
const bandAt = (
  y: number,
  left: number,
  right: number,
  ports: Partial<LevelPorts> = {},
): RunBand => ({
  edgeId: "band",
  y,
  top: y - FORWARD_LEVEL_FLOOR,
  bottom: y + FORWARD_LEVEL_FLOOR,
  left,
  right,
  source: "other-source",
  target: "other-target",
  sy: -1000,
  ty: -1000,
  ...ports,
});

const SELF: LevelPorts = { source: "s", target: "t", sy: 100, ty: 300 };

describe("run bands are the drawn horizontals of one edge", () => {
  const nodes: RFAnyNode[] = [
    inputProductNode("src", "w", 0, 0),
    orderedRecipeNode("dst", 700, 260, ["w"]),
  ];
  const byId = nodeIndexOf(nodes);
  const edge = mkEdge("e1", "src", "dst", "w");

  it("grows every horizontal run of the polyline by the floor", () => {
    const ends = drawnPortsOf(edge, byId)!;
    const runs = horizontalRuns(drawnEdge(ends, edge.type, edge.data).pts);
    const bands = runBandsOfEdge(edge, byId);

    // Premise: this fixture really does draw horizontals to band.
    expect(runs.length).toBeGreaterThan(0);
    expect(bands.length).toBe(runs.length);
    for (const band of bands) {
      expect(band.edgeId).toBe("e1");
      expect(band.top).toBe(band.y - FORWARD_LEVEL_FLOOR);
      expect(band.bottom).toBe(band.y + FORWARD_LEVEL_FLOOR);
      // The band carries the edge's two port rows, which is what the waiver
      // needs; it holds the run's own x span.
      expect(band.source).toBe("src");
      expect(band.target).toBe("dst");
      expect(band.sy).toBe(ends.sourceY);
      expect(band.ty).toBe(ends.targetY);
      expect(
        runs.some(
          (run) =>
            run.y === band.y && run.lo === band.left && run.hi === band.right,
        ),
      ).toBe(true);
    }
  });

  it("gives a backward edge none, because its level is the rail pass's", () => {
    const backward: RFAnyNode[] = [
      inputProductNode("src", "w", 900, 0),
      orderedRecipeNode("dst", 0, 260, ["w"]),
    ];
    expect(runBandsOfEdge(edge, nodeIndexOf(backward))).toEqual([]);
  });
});

describe("the port-row waiver", () => {
  it("waives a band that coincides on a shared source row", () => {
    const band = bandAt(100, 0, 500, { source: "s", sy: 100 });
    expect(sharesPortRow(band, SELF, 100)).toBe(true);
  });

  it("waives a band that coincides on a shared target row", () => {
    const band = bandAt(300, 0, 500, { target: "t", ty: 300 });
    expect(sharesPortRow(band, SELF, 300)).toBe(true);
  });

  it("does not waive a band at the row of a card the two edges share", () => {
    // Same target CARD, different target ROW: a recipe fed one item as a raw
    // input and as a catalyst charge takes it on two rows, and those are two
    // lines, not one.
    const band = bandAt(220, 0, 500, { target: "t", ty: 220 });
    expect(sharesPortRow(band, SELF, 220)).toBe(false);
  });

  it("does not waive a band the query is not level with", () => {
    const band = bandAt(100, 0, 500, { source: "s", sy: 100 });
    expect(sharesPortRow(band, SELF, 101)).toBe(false);
  });
});

describe("the run floor", () => {
  it("is struck inside a band over more than a port stub of shared span", () => {
    const band = bandAt(100, 0, 500);
    expect(runFloorHit([band], SELF, 108, 0, 500)).toBe(true);
  });

  it("is clear at the band edge, because the test is the strict interior", () => {
    const band = bandAt(100, 0, 500);
    expect(runFloorHit([band], SELF, 100 + FORWARD_LEVEL_FLOOR, 0, 500)).toBe(
      false,
    );
    expect(runFloorHit([band], SELF, 100 - FORWARD_LEVEL_FLOOR, 0, 500)).toBe(
      false,
    );
  });

  it("ignores an overlap no longer than a port stub", () => {
    // A corner meeting a line, not one smeared line.
    const band = bandAt(100, 0, 500);
    expect(runFloorHit([band], SELF, 108, 500 - PORT_STUB, 900)).toBe(false);
    expect(runFloorHit([band], SELF, 108, 500 - PORT_STUB - 1, 900)).toBe(true);
  });

  it("reads the span in either direction", () => {
    const band = bandAt(100, 0, 500);
    expect(runFloorHit([band], SELF, 108, 500, 0)).toBe(true);
  });

  it("waives the band it shares a port row with", () => {
    const shared = bandAt(100, 0, 500, { source: "s", sy: 100 });
    expect(runFloorHit([shared], SELF, 100, 0, 500)).toBe(false);
    // The waiver is per level, not per band: the same band still floors a run
    // that is merely near it.
    expect(runFloorHit([shared], SELF, 104, 0, 500)).toBe(true);
  });
});

describe("candidate levels", () => {
  const card = { left: 0, right: 500, top: 200, bottom: 300 };

  it("offers each spanned card its padded escapes", () => {
    expect(
      levelCandidates({
        anchorY: 250,
        x0: 0,
        x1: 500,
        drawnX0: 0,
        drawnX1: 500,
        bands: [],
        cards: [card],
        pad: 8,
      }),
    ).toEqual([192, 308]);
  });

  it("offers a band its own edges and those edges padded", () => {
    const band = bandAt(100, 0, 500);
    expect(
      levelCandidates({
        anchorY: 100,
        x0: 0,
        x1: 500,
        drawnX0: 0,
        drawnX1: 500,
        bands: [band],
        cards: [],
        pad: 8,
      }),
    ).toEqual([
      100 - FORWARD_LEVEL_FLOOR,
      100 + FORWARD_LEVEL_FLOOR,
      100 - FORWARD_LEVEL_FLOOR - 8,
      100 + FORWARD_LEVEL_FLOOR + 8,
    ]);
  });

  it("orders nearest to the anchor first", () => {
    const far = { left: 0, right: 500, top: 1000, bottom: 1100 };
    const levels = levelCandidates({
      anchorY: 250,
      x0: 0,
      x1: 500,
      drawnX0: 0,
      drawnX1: 500,
      bands: [],
      cards: [far, card],
      pad: 8,
    });
    expect(levels).toEqual([192, 308, 992, 1108]);
  });

  it("breaks a distance tie by the row value, so the order is total", () => {
    // Both escapes of this card are 50 from the anchor. The lower row wins,
    // whichever way round the obstacles were handed in.
    const symmetric = { left: 0, right: 500, top: 208, bottom: 292 };
    const args = {
      anchorY: 250,
      x0: 0,
      x1: 500,
      drawnX0: 0,
      drawnX1: 500,
      bands: [],
      pad: 8,
    };
    expect(levelCandidates({ ...args, cards: [symmetric] })).toEqual([
      200, 300,
    ]);
    expect(levelCandidates({ ...args, cards: [symmetric, card] })).toEqual([
      200, 300, 192, 308,
    ]);
  });

  it("deduplicates levels two obstacles agree on", () => {
    const twin = { ...card };
    expect(
      levelCandidates({
        anchorY: 250,
        x0: 0,
        x1: 500,
        drawnX0: 0,
        drawnX1: 500,
        bands: [],
        cards: [card, twin],
        pad: 8,
      }),
    ).toEqual([192, 308]);
  });

  it("spans the drawn bands with the drawn span and the model rects with the model one", () => {
    // A run whose drawn span sits 5 right of its model span: a band only the
    // drawn span reaches offers its levels, a card only the model span reaches
    // offers its escapes, and neither is filtered by the other frame's span.
    const bandOnlyDrawn = bandAt(100, 502, 700);
    const cardOnlyModel = { left: 496, right: 498, top: 200, bottom: 300 };
    expect(
      levelCandidates({
        anchorY: 100,
        x0: 0,
        x1: 500,
        drawnX0: 5,
        drawnX1: 505,
        bands: [bandOnlyDrawn],
        cards: [cardOnlyModel],
        pad: 8,
      }),
    ).toEqual([
      100 - FORWARD_LEVEL_FLOOR,
      100 + FORWARD_LEVEL_FLOOR,
      100 - FORWARD_LEVEL_FLOOR - 8,
      100 + FORWARD_LEVEL_FLOOR + 8,
      192,
      308,
    ]);
  });

  it("skips an obstacle the span does not reach", () => {
    const elsewhere = { left: 900, right: 1200, top: 200, bottom: 300 };
    expect(
      levelCandidates({
        anchorY: 250,
        x0: 0,
        x1: 500,
        drawnX0: 0,
        drawnX1: 500,
        bands: [bandAt(100, 900, 1200)],
        cards: [elsewhere],
        pad: 8,
      }),
    ).toEqual([]);
  });
});

describe("choosing a level", () => {
  it("takes the first candidate the consumer accepts", () => {
    expect(chooseLevel(50, [10, 20, 30], (y) => y >= 20)).toBe(20);
  });

  it("skips a candidate the consumer's own clearance would move again", () => {
    // The rail rescan's acceptance, in miniature: a candidate is taken only
    // where it is floor-clear AND a fixed point of the card clearance. 120 is
    // clear of the floor around 60 but stands in a card the clearance escapes
    // to 208, so the rescan walks past it to the next floor-clear level. The
    // module supplies the order and decides nothing else.
    const cardClear = (y: number): number => (y > 100 && y < 200 ? 208 : y);
    const floorClear = (y: number): boolean => Math.abs(y - 60) >= 20;
    expect(
      chooseLevel(
        60,
        [120, 40, 300],
        (y) => cardClear(y) === y && floorClear(y),
      ),
    ).toBe(40);
  });

  it("keeps the preferred level when no candidate is accepted", () => {
    expect(chooseLevel(50, [10, 20, 30], () => false)).toBe(50);
  });

  it("keeps the preferred level when there are no candidates at all", () => {
    expect(chooseLevel(50, [], () => true)).toBe(50);
  });
});

describe("the crossings a jog level draws", () => {
  // A jog leaving its source row 0 at column C = 100, running at R = 200 out to
  // the descent D = 500, and descending to its target row 300.
  const SHAPE = { sy: 0, C: 100, R: 200, D: 500, ty: 300 };
  const column = (x: number, top: number, bottom: number) => ({
    left: x,
    top,
    bottom,
  });
  const run = (y: number, left: number, right: number) => ({ y, left, right });

  it("counts a vertical strictly inside [C, D] that spans R once", () => {
    expect(levelCrossingCost(SHAPE, [column(300, 150, 250)], [])).toBe(1);
  });

  it("does not count a vertical that only touches the run", () => {
    // One ends on R, one stands on the descent column itself.
    expect(
      levelCrossingCost(
        SHAPE,
        [column(300, 200, 250), column(500, 150, 250)],
        [],
      ),
    ).toBe(0);
  });

  it("does not count a horizontal run that stops short of the stub", () => {
    expect(levelCrossingCost(SHAPE, [], [run(100, 0, 90)])).toBe(0);
    // Premise: the same run reaching past C is a crossing.
    expect(levelCrossingCost(SHAPE, [], [run(100, 0, 150)])).toBe(1);
  });

  it("counts a run crossing the descent", () => {
    expect(levelCrossingCost(SHAPE, [], [run(250, 450, 700)])).toBe(1);
  });

  it("adds the crossings of two verticals", () => {
    expect(
      levelCrossingCost(
        SHAPE,
        [column(250, 150, 250), column(350, 0, 400)],
        [],
      ),
    ).toBe(2);
  });
});

describe("the dots a jog level passes", () => {
  // The same jog as above: column C = 100 from row 0 down to R = 200, the run
  // at R out to D = 500, the descent at D down to row 300.
  const SHAPE = { sy: 0, C: 100, R: 200, D: 500, ty: 300 };
  const CLEARANCE = 16;

  it("passes a dot beside the run inside the clearance", () => {
    expect(levelPassesDot(SHAPE, [{ x: 300, y: 197.5 }], CLEARANCE)).toBe(true);
  });

  it("passes a dot beside either column inside the clearance", () => {
    expect(levelPassesDot(SHAPE, [{ x: 90, y: 50 }], CLEARANCE)).toBe(true);
    expect(levelPassesDot(SHAPE, [{ x: 510, y: 250 }], CLEARANCE)).toBe(true);
  });

  it("does not pass a dot exactly one clearance off", () => {
    expect(levelPassesDot(SHAPE, [{ x: 300, y: 216 }], CLEARANCE)).toBe(false);
  });

  it("does not pass a dot beyond the run's ends", () => {
    // Past D on the run's row, and past the column's foot below R.
    expect(levelPassesDot(SHAPE, [{ x: 520, y: 200 }], CLEARANCE)).toBe(false);
    expect(levelPassesDot(SHAPE, [{ x: 100, y: -20 }], CLEARANCE)).toBe(false);
  });
});

describe("the cards a jog level passes close to", () => {
  // A run from x 100 to 500 at level R; cards as the router pads them.
  const card = (left: number, right: number, top: number, bottom: number) => ({
    left,
    right,
    top,
    bottom,
  });
  const PAD = 8;

  it("counts a card whose bottom lies within the pad of the level", () => {
    expect(
      levelNearCardCount(205, 100, 500, [card(200, 300, 0, 200)], PAD),
    ).toBe(1);
  });

  it("counts a card whose top lies within the pad of the level", () => {
    expect(
      levelNearCardCount(95, 100, 500, [card(200, 300, 100, 200)], PAD),
    ).toBe(1);
  });

  it("does not count the card's own escape level, one pad off its edge", () => {
    expect(
      levelNearCardCount(208, 100, 500, [card(200, 300, 0, 200)], PAD),
    ).toBe(0);
  });

  it("does not count a card outside the run's x-extent", () => {
    expect(
      levelNearCardCount(205, 100, 500, [card(600, 700, 0, 200)], PAD),
    ).toBe(0);
  });

  it("counts each near card once", () => {
    expect(
      levelNearCardCount(
        205,
        500,
        100,
        [card(150, 250, 0, 200), card(300, 400, 210, 300)],
        PAD,
      ),
    ).toBe(2);
  });
});

describe("choosing a level by its crossings", () => {
  it("takes a farther level that crosses fewer lines", () => {
    // Nearest first: 209.5 crosses 8 lines, 77 crosses 3.
    const cost = (y: number): number[] => [y === 209.5 ? 8 : 3, 0];
    expect(chooseLevelByCost([209.5, 77], cost)).toBe(77);
  });

  it("keeps the nearer level on a tie", () => {
    expect(chooseLevelByCost([209.5, 77], () => [3, 0])).toBe(209.5);
  });

  it("breaks a crossing tie by the cards a level passes close to", () => {
    // 958 and 965 cross two lines each; 958 runs a unit under a card.
    const cost = (y: number): number[] => [2, y === 958 ? 1 : 0];
    expect(chooseLevelByCost([958, 965], cost)).toBe(965);
  });

  it("never trades a crossing for a near card", () => {
    const cost = (y: number): number[] => (y === 958 ? [2, 1] : [3, 0]);
    expect(chooseLevelByCost([958, 965], cost)).toBe(958);
  });

  it("has no answer when nothing was accepted", () => {
    expect(chooseLevelByCost([], () => [0, 0])).toBeUndefined();
  });
});
