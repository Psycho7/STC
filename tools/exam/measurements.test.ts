// The measurement pass, exercised on a hand-built scene rather than a browser.
//
// The fixture is laid out so each measurement kind is produced exactly once, by
// a named piece of geometry, which is what lets the assertions below check the
// FOOTPRINT and not just the count. A footprint is the only thing that can tie a
// measurement back to a place on an image, so an entry whose rect is nowhere
// near the geometry that produced it would invite a false join later.
//
// Nothing here asserts that a count should be zero: these are measurements of
// whatever the layout did, and the repo's ratchets are the place where a number
// becomes a judgement.

import { describe, expect, test } from "vitest";
import { measurementsFor, type Measurement } from "./scene";
import type { Geometry, SceneCollection } from "../../test/e2e/collect";

const E_IRON = "e:0:A->B:iron";
const E_WATER = "e:1:D->E:water";

// A: source of E_IRON. B: its target. C: a card neither edge owns. D / E: the
// endpoints of E_WATER.
const geometry = (): Geometry => ({
  nodes: [
    { nodeId: "A", type: "recipe", left: 0, top: 0, right: 100, bottom: 50 },
    { nodeId: "B", type: "recipe", left: 400, top: 0, right: 500, bottom: 50 },
    {
      nodeId: "C",
      type: "recipe",
      left: 200,
      top: 200,
      right: 260,
      bottom: 260,
    },
    { nodeId: "D", type: "recipe", left: 0, top: 400, right: 100, bottom: 450 },
    {
      nodeId: "E",
      type: "recipe",
      left: 400,
      top: 400,
      right: 500,
      bottom: 450,
    },
  ],
  edges: [
    // Second segment runs along y=250 through card C.
    { id: E_IRON, d: "M 100,25 L 100,250 L 400,250" },
    // First segment runs down inside its own source card D; the x=300 leg
    // crosses E_IRON's y=250 leg.
    { id: E_WATER, d: "M 50,425 L 50,500 L 300,500 L 300,150 L 400,150" },
  ],
  chips: [
    // Far from its own edge's polyline and clear of everything else.
    {
      edgeId: E_IRON,
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
      label: "water rise",
      kind: "bus",
      left: 90,
      top: 100,
      right: 130,
      bottom: 120,
    },
  ],
});

const CHIP_RATE_ID = "chip-rate-iron";
const CHIP_DROP_ID = "bus-edge-label-water-drop";
const CHIP_RISE_ID = "bus-edge-label-water-rise";

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

    // The y=250 leg through C, not the whole edge: an evidence rect at the
    // edge's other end must not join to this.
    expect(only(measurements, "segment-vs-card").footprint).toEqual({
      x: 100,
      y: 250,
      width: 300,
      height: 0,
    });
    // The leg inside D, not the four other legs of the same edge.
    expect(only(measurements, "own-card-pierce").footprint).toEqual({
      x: 50,
      y: 425,
      width: 0,
      height: 75,
    });
    // The piercing segment, which is E_IRON's x=100 leg.
    expect(only(measurements, "chip-vs-segment").footprint).toEqual({
      x: 100,
      y: 25,
      width: 0,
      height: 225,
    });
    // Chip box intersected with card C: the chip lies wholly inside it.
    expect(only(measurements, "chip-vs-card").footprint).toEqual({
      x: 210,
      y: 205,
      width: 40,
      height: 20,
    });
    // The chip's own box; the audit reports a distance and no place.
    expect(only(measurements, "chip-off-own-path").footprint).toEqual({
      x: 700,
      y: 600,
      width: 60,
      height: 20,
    });

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
      expect(m.elementIds).not.toContain("");
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
      expect(m.elementIds).not.toContain("");
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

    // The x=300 leg of E_WATER crosses the y=250 leg of E_IRON.
    expect(crossingCensus).toEqual({ count: 1 });
    // A crossing has no participating ids and no place, so it can never be a
    // located measurement.
    for (const m of measurements) {
      expect(m.kind).not.toMatch(/cross/);
    }
  });
});
