// The hand-built cameras, measurement and finding the triage tests run on.
//
// Shared rather than local to one test file because two suites must exercise
// the SAME shapes: triage.test.ts checks the module, and workflow-parity.test.ts
// checks that the copy inlined in the workflow script answers identically. A
// fixture that drifted between them would weaken the parity check without
// failing anything.
//
// The arithmetic is deliberately redoable by a reader: every transform has zoom
// 2 and a whole-number offset, so the projected position of the one measurement
// below can be stated in a test rather than computed from the code under test.
// That matters here more than usual - the join's failure mode is a silent miss,
// and a test that derived its expected rect from the same projection code would
// agree with a broken projection by construction.

import type { Measurement } from "./scene";
import type { Rect } from "./tiling";
import type { Finding, TileFrame } from "./triage";

export const SAFE: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

// Two cameras over the same world. A footprint at world (100, 100) lands at
// image (300, 250) through TILE_A and at (1100, 250) through TILE_B, so the two
// frames disagree by 800 px about where the same measurement is.
export const TILE_A: TileFrame = {
  file: "10-tile-r0c0.png",
  kind: "tile",
  viewportTransform: { x: 100, y: 50, zoom: 2 },
  safeRegion: SAFE,
};
export const TILE_B: TileFrame = {
  file: "10-tile-r0c1.png",
  kind: "tile",
  viewportTransform: { x: 900, y: 50, zoom: 2 },
  safeRegion: SAFE,
};
// Deliberately the SAME transform as TILE_A, so nothing but `kind` can refuse a
// join through it: the fit overview is a different camera, and the measurements
// were all taken at the target zoom.
export const TILE_FIT: TileFrame = {
  file: "00-fit.png",
  kind: "fit",
  viewportTransform: { x: 100, y: 50, zoom: 2 },
  safeRegion: SAFE,
};
export const TILES = [TILE_A, TILE_B];

// World (100, 100) to (120, 110). Through TILE_A: image (300, 250) to (340, 270).
export const CHIP: Measurement = {
  kind: "chip-off-own-path",
  elementIds: ["chip:7", "e:0:A->B:iron"],
  footprint: { x: 100, y: 100, width: 20, height: 10 },
  detail: 'label chip of e:0:A->B:iron ("30/min") sits 84.0 world units off its own polyline',
};

// The placement tier's OTHER kind, at the same place again. The placement row
// holds two measurement kinds and a table that only ever exercises the first
// cannot see the second fall out of it, so this fixture is what makes the kind
// axis testable for `chip-vs-card` at all.
export const CARD: Measurement = {
  kind: "chip-vs-card",
  elementIds: ["chip:7", "B"],
  footprint: { x: 100, y: 100, width: 20, height: 10 },
  detail: 'label chip of e:0:A->B:iron ("30/min") overlaps the card of node B',
};

// The same place as CHIP, different tiers. Both sit at world (100, 100), inside
// the default finding's evidence rect through TILE_A, so a join test using them
// isolates the kind axis: co-location and proportionality both pass, and only
// the compatibility table can refuse. SEG is segment-tier (witnesses a routing
// claim), XING is the collision kind (witnesses a collision claim); neither may
// ever corroborate a placement claim, however perfect the overlap.
export const SEG: Measurement = {
  kind: "segment-vs-card",
  elementIds: ["e:0:A->B:iron", "B"],
  footprint: { x: 100, y: 100, width: 40, height: 0 },
  detail: "edge e:0:A->B:iron segment enters the padding of card B",
};
export const XING: Measurement = {
  kind: "chip-vs-segment",
  elementIds: ["e:0:A->B:iron", "chip:7"],
  footprint: { x: 100, y: 100, width: 1, height: 10 },
  detail: "edge e:0:A->B:iron crosses the chip of e:1",
};

export function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    planId: "copper",
    title: "chip floats free of its line",
    observation: 'the "30/min" chip sits well away from any edge',
    claimType: "geometric-placement",
    evidence: [
      { image: TILE_A.file, rect: [290, 240, 60, 40], where: "on edge e:0:A->B:iron" },
    ],
    severity: "major",
    aspect: "comprehension",
    falsifier: {
      op: "chip-binding",
      args: { id: "chip:7" },
      expectedIfFalse: "the chip's centre lies on its owning polyline",
    },
    ...over,
  };
}

// exactOptionalPropertyTypes is on for the tools project, so a finding that
// carries no falsifier is one with the key ABSENT, not one holding undefined.
// That is also what arrives from an evaluator's JSON.
export function withoutFalsifier(base: Finding): Finding {
  const clone: Finding = { ...base };
  delete clone.falsifier;
  return clone;
}

// A finding with a REQUIRED key absent, which the type system says cannot happen
// and an evaluator's JSON produces anyway. The cast is the point of the helper:
// it is confined here rather than repeated at every call site.
export function without(base: Finding, key: keyof Finding): Finding {
  const clone: Record<string, unknown> = { ...base };
  delete clone[key];
  return clone as unknown as Finding;
}
