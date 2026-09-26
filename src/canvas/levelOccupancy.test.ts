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
  levelCandidates,
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
        drawnX0: 0,
        drawnX1: 500,
        bands: [],
        cards: [card, twin],
        pad: 8,
      }),
    ).toEqual([192, 308]);
  });

  it("filters the bands and the cards by the one drawn span", () => {
    // A recipe source card at model x 0..240 draws 0..242, and its port draws
    // at 245. The run's drawn span starts at that port, so the card it leaves
    // offers nothing; a card and a band inside the span offer their levels.
    const sourceCard = { left: 0, right: 242, top: 400, bottom: 500 };
    const spanned = { left: 600, right: 700, top: 200, bottom: 300 };
    expect(
      levelCandidates({
        anchorY: 100,
        drawnX0: 245,
        drawnX1: 800,
        bands: [bandAt(100, 600, 800)],
        cards: [sourceCard, spanned],
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
