// The exam's on-disk evidence document: `scene.json`.
//
// This module owns the document shape and the write, and nothing else - no
// browser, no geometry math. It is deliberately verdict-free. Everything it
// carries is a measurement or a provenance record; whether a number is a defect
// is a judgement the repo's existing ratchets already make, with written
// rulings behind large accepted counts, so nothing here may be read as an
// accusation.
//
// Coordinate contract, restated because a reader of the JSON has no other
// source for it: every rect is CSS pixels relative to the `.react-flow` pane's
// top-left, EXCEPT the fields named `worldRect`, `contentRect` and `footprint`,
// which are React Flow world units. A tile's `elements` rects are CSS pixels
// within that tile's own image, which is the same frame because each image is a
// screenshot of the pane itself at `scale: "css"`.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Rect, Viewport } from "./tiling";

export type OverlayMask = { name: string } & Rect;

// One captured image plus everything needed to place what it shows. `row` and
// `col` exist only for grid tiles: the fit overview and the corrective shots are
// not on the grid, and inventing coordinates for them would put two different
// meanings behind one field.
export type TileRecord = {
  file: string;
  kind: "fit" | "tile" | "corrective";
  row?: number;
  col?: number;
  viewportTransform: Viewport;
  safeRegion: Rect;
  overlayMasks: OverlayMask[];
  elements: Record<string, Rect>;
};

export type SceneElementRecord = {
  kind: string;
  itemId?: string;
  label?: string;
  worldRect: Rect;
};

// A raw geometry occurrence with a location, so a reported finding can be
// joined to it by footprint. The measurement pass fills these in; a plain
// capture emits none, which is why an empty array means "not measured" rather
// than "measured and clean".
export type SceneMeasurement = {
  kind: string;
  elementIds: string[];
  footprint: Rect;
  detail: string;
};

export type SceneCoverage = {
  targetZoom: number;
  coveredCount: number;
  uncovered: Array<{ id: string; kind: string; reason: string }>;
  correctiveTiles: number;
  capHit: boolean;
};

export type SceneDoc = {
  planId: string;
  hash: string;
  url: string;
  locale: string;
  status: "complete" | "partial";
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    screenshotScale: "css";
  };
  fit: Viewport;
  contentRect: Rect;
  targetZoom: number;
  lodGates: { labelMinZoom: number; chipIconOnlyMaxZoom: number };
  tiles: TileRecord[];
  elements: Record<string, SceneElementRecord>;
  edges: Array<{ id: string; d: string }>;
  chips: Array<{ id: string; edgeId?: string; text: string; worldRect: Rect }>;
  measurements: SceneMeasurement[];
  // Absent until the measurement pass computes it. Emitting `{ count: 0 }` from
  // a capture that never counted anything would be indistinguishable from a
  // genuine zero, so the field is left off instead.
  crossingCensus?: { count: number };
  coverage: SceneCoverage;
  consoleErrors: string[];
};

// Write `<dir>/scene.json` and return the path it landed at. The directory is
// created if it does not exist, because the caller has already been writing
// images into it and a missing directory at this point would lose the ledger for
// shots that are already on disk.
export async function writeScene(dir: string, doc: SceneDoc): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "scene.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}
