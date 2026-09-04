// The measurement pass, exercised on a hand-built scene rather than a browser.
//
// The fixture is laid out so each measurement kind is produced exactly once, by
// a named piece of geometry, which is what lets the assertions below check the
// FOOTPRINT and not just the count. A footprint is the only thing that can tie a
// measurement back to a place on an image, so an entry whose rect is nowhere
// near the geometry that produced it would invite a false join later - and one
// LARGER than the geometry that produced it is the same failure by degrees, so
// every footprint below is pinned to the sub-segment or overlap, never the run.
//
// Nothing here asserts that a count should be zero: these are measurements of
// whatever the layout did, and the repo's ratchets are the place where a number
// becomes a judgement.

import { describe, expect, test } from "vitest";
import { measurementsFor, type Measurement } from "./scene";
import type { Geometry, SceneCollection } from "../../test/e2e/collect";
import type { Rect } from "./tiling";

// A clipped footprint is computed through a parametric window, so its corners
// carry float dust (166 arrives as 166.00000000000003). Compared to six decimal
// places: far tighter than any distance that could move a join, and loose enough
// that the assertions state the geometry rather than the arithmetic.
function rect(x: number, y: number, width: number, height: number): Rect {
  return {
    x: expect.closeTo(x, 6) as unknown as number,
    y: expect.closeTo(y, 6) as unknown as number,
    width: expect.closeTo(width, 6) as unknown as number,
    height: expect.closeTo(height, 6) as unknown as number,
  };
}

const E_IRON = "e:0:A->B:iron";
const E_WATER = "e:1:D->E:water";

// A: source of E_IRON. B: its target. C: a card neither edge owns. D / E: the
// endpoints of E_WATER.
// The cards below carry no ports: the measurement pass reads rects only, and an
// invented port list would put item ids in the fixture that no edge here names.
const geometry = (): Geometry => ({
  nodes: [
    {
      nodeId: "A",
      type: "recipe",
      left: 0,
      top: 0,
      right: 100,
      bottom: 50,
      inPorts: [],
      outPorts: [],
    },
    {
      nodeId: "B",
      type: "recipe",
      left: 400,
      top: 0,
      right: 500,
      bottom: 50,
      inPorts: [],
      outPorts: [],
    },
    {
      nodeId: "C",
      type: "recipe",
      left: 200,
      top: 200,
      right: 260,
      bottom: 260,
      inPorts: [],
      outPorts: [],
    },
    {
      nodeId: "D",
      type: "recipe",
      left: 0,
      top: 400,
      right: 100,
      bottom: 450,
      inPorts: [],
      outPorts: [],
    },
    {
      nodeId: "E",
      type: "recipe",
      left: 400,
      top: 400,
      right: 500,
      bottom: 450,
      inPorts: [],
      outPorts: [],
    },
  ],
  edges: [
    // Second segment runs along y=250 through card C. z 0: a top-level edge
    // pair, the common case the paint tiebreak resolves by array order.
    { id: E_IRON, d: "M 100,25 L 100,250 L 400,250", z: 0 },
    // First segment runs down inside its own source card D; the x=300 leg
    // crosses E_IRON's y=250 leg.
    { id: E_WATER, d: "M 50,425 L 50,500 L 300,500 L 300,150 L 400,150", z: 0 },
  ],
  chips: [
    // Far from its own edge's polyline and clear of everything else.
    {
      edgeId: E_IRON,
      testId: CHIP_RATE_ID,
      label: "12/min",
      kind: "label",
      left: 700,
      top: 600,
      right: 760,
      bottom: 620,
    },
    // Seated inside foreign card C, above the y=250 leg that crosses it.
    {
      edgeId: E_WATER,
      testId: CHIP_DROP_ID,
      label: "water",
      kind: "bus-drop",
      left: 210,
      top: 205,
      right: 250,
      bottom: 225,
    },
    // Straddles E_IRON's x=100 leg.
    {
      edgeId: E_WATER,
      testId: CHIP_RISE_ID,
      label: "water rise",
      kind: "bus",
      left: 90,
      top: 100,
      right: 130,
      bottom: 120,
    },
  ],
  dots: [],
  bands: [],
  crossingCues: [],
  zoom: 1,
});

const CHIP_RATE_ID = "chip-rate-iron";
const CHIP_DROP_ID = "bus-edge-label-water-drop";
const CHIP_RISE_ID = "bus-edge-label-water-rise";
// Chips added by single tests, not by the shared fixture.
const CHIP_PARTIAL_ID = "bus-edge-label-water-partial";
const CHIP_PAST_ID = "chip-rate-water-past";

// Everything a measurement is allowed to name in this fixture: the two edges,
// the five cards, the three chips.
const KNOWN_IDS = new Set([
  E_IRON,
  E_WATER,
  "A",
  "B",
  "C",
  "D",
  "E",
  CHIP_RATE_ID,
  CHIP_DROP_ID,
  CHIP_RISE_ID,
]);

// The camera sits at zoom 1 with no translation, so world and pane frames
// coincide and a chip's worldRect here is literally its geometry rect - which is
// what the chip join keys on.
const sceneCollection = (): SceneCollection => {
  const el = (
    id: string,
    kind: "node" | "chip",
    x: number,
    y: number,
    width: number,
    height: number,
  ): SceneCollection["elements"][number] => ({
    id,
    kind,
    clientRect: { x, y, width, height },
    worldRect: { x, y, width, height },
  });
  return {
    transform: { x: 0, y: 0, zoom: 1 },
    paneRect: { x: 0, y: 0, width: 1920, height: 1080 },
    overlays: [],
    elements: [
      el("C", "node", 200, 200, 60, 60),
      el(CHIP_RATE_ID, "chip", 700, 600, 60, 20),
      el(CHIP_DROP_ID, "chip", 210, 205, 40, 20),
      el(CHIP_RISE_ID, "chip", 90, 100, 40, 20),
    ],
  };
};

function only(
  measurements: Measurement[],
  kind: Measurement["kind"],
): Measurement {
  const hits = measurements.filter((m) => m.kind === kind);
  expect(hits, `exactly one ${kind}`).toHaveLength(1);
  return hits[0]!;
}

describe("measurementsFor", () => {
  test("records one measurement per kind, each with a located footprint", () => {
    const { measurements } = measurementsFor(geometry(), sceneCollection());

    expect(measurements.map((m) => m.kind).sort()).toEqual([
      "chip-off-own-path",
      "chip-vs-card",
      "chip-vs-segment",
      "own-card-pierce",
      "segment-vs-card",
    ]);

    // The part of the y=250 leg inside C's PADDED box (x 166..284), not the
    // 300-unit leg and not the whole edge: an evidence rect elsewhere along that
    // leg must not join to this.
    expect(only(measurements, "segment-vs-card").footprint).toEqual(
      rect(166, 250, 118, 0),
    );
    // The part of the leg inside D (y 425..450), not the 75-unit leg whose
    // lower two thirds run below the card.
    expect(only(measurements, "own-card-pierce").footprint).toEqual(
      rect(50, 425, 0, 25),
    );
    // The part of E_IRON's 225-unit x=100 leg inside the chip box (y 100..120).
    expect(only(measurements, "chip-vs-segment").footprint).toEqual(
      rect(100, 100, 0, 20),
    );
    // Chip box intersected with card C: the chip lies wholly inside it.
    expect(only(measurements, "chip-vs-card").footprint).toEqual(
      rect(210, 205, 40, 20),
    );
    // The chip's own box; the audit reports a distance and no place.
    expect(only(measurements, "chip-off-own-path").footprint).toEqual(
      rect(700, 600, 60, 20),
    );

    for (const m of measurements) {
      const f = m.footprint;
      for (const n of [f.x, f.y, f.width, f.height]) {
        expect(Number.isFinite(n), `${m.kind} footprint is finite`).toBe(true);
      }
      // A segment footprint is flat in one axis by construction (a line has no
      // area), so extent is asserted as a sum, not per axis.
      expect(
        f.width + f.height,
        `${m.kind} footprint has extent`,
      ).toBeGreaterThan(0);
      expect(m.elementIds.length, `${m.kind} names elements`).toBeGreaterThan(
        0,
      );
      // Every named id must be one a reader can look up: a scene element id or
      // an edge id. A chip label, a rect key, or an id the fixture does not have
      // would point a join at nothing.
      for (const id of m.elementIds) {
        expect(KNOWN_IDS.has(id), `${m.kind} names ${id}, which is real`).toBe(
          true,
        );
      }
      expect(m.detail.length, `${m.kind} explains itself`).toBeGreaterThan(0);
    }
  });

  test("names the scene element ids of the chips and cards involved", () => {
    const { measurements } = measurementsFor(geometry(), sceneCollection());

    expect(only(measurements, "chip-vs-card").elementIds).toEqual(
      expect.arrayContaining([CHIP_DROP_ID, E_WATER, "C"]),
    );
    expect(only(measurements, "chip-vs-segment").elementIds).toEqual(
      expect.arrayContaining([CHIP_RISE_ID, E_WATER, E_IRON]),
    );
    expect(only(measurements, "chip-off-own-path").elementIds).toEqual(
      expect.arrayContaining([CHIP_RATE_ID, E_IRON]),
    );
    expect(only(measurements, "segment-vs-card").elementIds).toEqual([
      E_IRON,
      "C",
    ]);
    expect(only(measurements, "own-card-pierce").elementIds).toEqual([
      E_WATER,
      "D",
    ]);
  });

  test("still names the owning edge when a chip has no scene element", () => {
    const scene = sceneCollection();
    scene.elements = scene.elements.filter((e) => e.kind !== "chip");
    const { measurements } = measurementsFor(geometry(), scene);

    expect(measurements).toHaveLength(5);
    for (const m of measurements) {
      expect(m.elementIds.length).toBeGreaterThan(0);
    }
    expect(only(measurements, "chip-off-own-path").elementIds).toEqual([
      E_IRON,
    ]);
  });

  test("keeps the crossing count out of the measurements", () => {
    const { measurements, crossingCensus } = measurementsFor(
      geometry(),
      sceneCollection(),
    );

    // The x=300 leg of E_WATER crosses the y=250 leg of E_IRON. cued 0: the
    // fixture's collected geometry carries no drawn cue disks (the census
    // scorer counts them off geom.crossingCues), so the one counted crossing
    // stands uncued in this hand-built scene.
    expect(crossingCensus).toEqual({ count: 1, cued: 0 });
    // A crossing has no participating ids and no place, so it contributes no
    // measurement: the list is still exactly the five the rest of the geometry
    // produces, and none of them is explained by that crossing.
    expect(measurements).toHaveLength(5);
    for (const m of measurements) {
      expect(m.detail).not.toMatch(/cross/i);
    }
  });

  // A long run past a small card: a whole-segment rect would claim thousands of
  // units of edge that show nothing, and would corroborate a finding marked
  // anywhere along it.
  test("bounds a card occurrence by the card, not by the segment", () => {
    const geom: Geometry = {
      nodes: [
        {
          nodeId: "A",
          type: "recipe",
          left: 0,
          top: 0,
          right: 100,
          bottom: 50,
          inPorts: [],
          outPorts: [],
        },
        {
          nodeId: "B",
          type: "recipe",
          left: 4000,
          top: 0,
          right: 4100,
          bottom: 50,
          inPorts: [],
          outPorts: [],
        },
        {
          nodeId: "C",
          type: "recipe",
          left: 2000,
          top: 200,
          right: 2060,
          bottom: 260,
          inPorts: [],
          outPorts: [],
        },
      ],
      edges: [{ id: E_IRON, d: "M 100,25 L 100,250 L 4000,250", z: 0 }],
      chips: [],
      dots: [],
      bands: [],
      crossingCues: [],
      zoom: 1,
    };
    const scene: SceneCollection = {
      transform: { x: 0, y: 0, zoom: 1 },
      paneRect: { x: 0, y: 0, width: 1920, height: 1080 },
      overlays: [],
      elements: [],
    };

    const { measurements } = measurementsFor(geom, scene);

    // C padded spans x 1966..2084. The leg it grazes is 3900 long.
    expect(only(measurements, "segment-vs-card").footprint).toEqual(
      rect(1966, 250, 118, 0),
    );
  });

  test("clips a chip-vs-card footprint to the chip's overlap with the card", () => {
    const geom = geometry();
    // A bus-drop chip hanging off the bottom-right corner of foreign card C.
    geom.chips.push({
      edgeId: E_WATER,
      testId: CHIP_PARTIAL_ID,
      label: "water partial",
      kind: "bus-drop",
      left: 240,
      top: 250,
      right: 280,
      bottom: 270,
    });
    const scene = sceneCollection();
    scene.elements.push({
      id: CHIP_PARTIAL_ID,
      kind: "chip",
      clientRect: { x: 240, y: 250, width: 40, height: 20 },
      worldRect: { x: 240, y: 250, width: 40, height: 20 },
    });

    const { measurements } = measurementsFor(geom, scene);
    const hits = measurements.filter(
      (m) =>
        m.kind === "chip-vs-card" && m.elementIds.includes(CHIP_PARTIAL_ID),
    );

    expect(hits).toHaveLength(1);
    // The quarter of the chip that is on the card, not the whole chip.
    expect(hits[0]!.footprint).toEqual(rect(240, 250, 20, 10));
  });

  test("keeps the chip box when a flagged chip does not touch its own card", () => {
    const geom = geometry();
    // Owned by E_WATER, level with its target card E but wholly to the right of
    // it: the own-card tier fires on the centre being past the port strip, so
    // there is no overlap to intersect.
    geom.chips.push({
      edgeId: E_WATER,
      testId: CHIP_PAST_ID,
      label: "water past strip",
      kind: "label",
      left: 520,
      top: 410,
      right: 560,
      bottom: 430,
    });
    const scene = sceneCollection();
    scene.elements.push({
      id: CHIP_PAST_ID,
      kind: "chip",
      clientRect: { x: 520, y: 410, width: 40, height: 20 },
      worldRect: { x: 520, y: 410, width: 40, height: 20 },
    });

    const { measurements } = measurementsFor(geom, scene);
    const hits = measurements.filter(
      (m) => m.kind === "chip-vs-card" && m.elementIds.includes(CHIP_PAST_ID),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]!.elementIds).toEqual(
      expect.arrayContaining([CHIP_PAST_ID, "E"]),
    );
    expect(hits[0]!.footprint).toEqual(rect(520, 410, 40, 20));
    // The wording must not claim an overlap the geometry does not have.
    expect(hits[0]!.detail).not.toMatch(/overlaps card/);
  });
});
