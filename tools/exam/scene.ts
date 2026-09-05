// The exam's on-disk evidence document: `scene.json`, plus the measurement pass
// that fills its geometry section.
//
// No browser: everything here is a pure function of an already-collected
// snapshot. It is deliberately verdict-free. Everything it carries is a
// measurement or a provenance record; whether a number is a defect is a
// judgement the repo's existing ratchets already make, with written rulings
// behind large accepted counts, so nothing here may be read as an accusation.
//
// Coordinate contract, restated because a reader of the JSON has no other
// source for it: every rect is CSS pixels relative to the `.react-flow` pane's
// top-left, EXCEPT the fields named `worldRect`, `contentRect` and `footprint`,
// which are React Flow world units. A tile's `elements` rects are CSS pixels
// within that tile's own image, which is the same frame because each image is a
// screenshot of the pane itself at `scale: "css"`.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditOwnCardPierces,
  auditSegmentsVsCards,
  auditSegmentsVsChips,
  clipSegmentToRect,
  countCrossings,
  crossingCueCoverage,
  fmtSeg,
  paddedCard,
  segmentEntersRect,
  toRawEdges,
  type ChipRect,
  type NodeRect,
  type Pt,
  type RawRect,
} from "../../test/e2e/geometry";
import type { Geometry, SceneCollection } from "../../test/e2e/collect";
import type { Rect, Viewport } from "./tiling";

export type OverlayMask = { name: string } & Rect;

// One captured image plus everything needed to place what it shows. `row` and
// `col` exist only for grid tiles: the fit overview and the corrective shots are
// not on the grid, and inventing coordinates for them would put two different
// meanings behind one field.
//
// `file` is a BARE file name, not a path: it is the join key an evaluator's
// evidence entry is matched against, and an evaluator is handed the image
// directory itself, so the only name it can cite is the bare one. Resolve an
// image as `<scene.json's directory>/<imagesDir>/<file>`.
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

// What the geometry audits count. The names are the audits' own subject matter,
// not charges: the ratchet spec permits large per-scenario counts of every one
// of these behind hand-written rulings, so an entry here says only "this
// occurrence exists at this place".
export type MeasurementKind =
  | "chip-off-own-path"
  | "chip-vs-card"
  | "segment-vs-card"
  | "own-card-pierce"
  | "chip-vs-segment";

// A raw geometry occurrence with a location, so a reported finding can be
// joined to it by footprint. The measurement pass runs on every capture, so an
// empty array means "measured and clean" - a plan whose layout produced no
// occurrence of any kind - and not "not measured". A consumer must therefore
// treat [] as a live answer: a finding with no measurement to join to is
// uncorroborated, not merely unchecked.
//
// `footprint` is the place the occurrence occupies, which for a segment-vs-box
// kind is the clipped run inside that box and NOT the whole segment. A footprint
// wider than the phenomenon would join an evidence rect that happens to sit
// somewhere else on the same long edge, and manufacture corroboration.
export type Measurement = {
  kind: MeasurementKind;
  elementIds: string[];
  footprint: Rect;
  detail: string;
};

// `correctiveReserve` is how many tiles the corrective pass was allowed to spend
// ABOVE the grid cap. It is recorded because `capHit` alone does not say how
// much rope the corrective pass had, and a reader comparing two captures needs
// to know whether a `partial` ran out of budget or ran out of ideas.
export type SceneCoverage = {
  targetZoom: number;
  coveredCount: number;
  uncovered: Array<{ id: string; kind: string; reason: string }>;
  correctiveTiles: number;
  correctiveReserve: number;
  capHit: boolean;
};

export type SceneDoc = {
  planId: string;
  hash: string;
  url: string;
  locale: string;
  // Which build these images came from, read off the running page rather than
  // off this machine: the exam drives a deployed preview by default, and a
  // deploy that lagged or failed would otherwise leave a capture of an older
  // build indistinguishable from a capture of the tip. `commit` is the app's git
  // commit (`-dirty` when the build came from a modified worktree, "unknown"
  // when it was built with no git to ask); `pack` is the recipe pack's vendor
  // fingerprint, comparable against the disk-side hashes ledger.
  commit: string;
  pack: { sourceCommit: string; gameVersion: string };
  // Directory the images live in, relative to this document. It is a separate
  // directory from the one holding this document on purpose: an evaluator is
  // given the image directory and must judge the pixels without the geometry
  // below, and a directory that holds only images cannot be listed into the
  // measurements. Recorded rather than assumed so a consumer resolves an image
  // from the document instead of hardcoding the layout.
  imagesDir: string;
  status: "complete" | "partial";
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    screenshotScale: "css";
  };
  fit: Viewport;
  contentRect: Rect;
  // The zoom every `tile` and `corrective` image was shot at. A capture that
  // could not achieve it fails rather than writing this field, so a reader may
  // treat it as a measurement and not as a request.
  targetZoom: number;
  lodGates: { labelMinZoom: number; chipIconOnlyMaxZoom: number };
  tiles: TileRecord[];
  elements: Record<string, SceneElementRecord>;
  edges: Array<{ id: string; d: string }>;
  chips: Array<{ id: string; edgeId?: string; text: string; worldRect: Rect }>;
  measurements: Measurement[];
  // Always written: the measurement pass runs on every capture, so `{ count: 0 }`
  // here is a counted zero and can be read as one. Required rather than optional
  // so a capture that somehow skipped the pass fails to compile instead of
  // emitting a document whose silence is ambiguous.
  // `cued` (Task 9): of the counted crossings between DIFFERENT flows, how many
  // carry a drawn crossing cue on either edge of the pair. Same-flow crossings
  // (one flow's own trunk / fan-out runs) are one visual line and never cued,
  // so `cued` counts a subset of `count` and the two are expected to differ.
  crossingCensus: { count: number; cued: number };
  coverage: SceneCoverage;
  consoleErrors: string[];
};

// ---------------------------------------------------------------------------
// The measurement pass
// ---------------------------------------------------------------------------

// The boundary eps the audits default to, passed explicitly to every audit call
// below and to the chip-resolution test that repeats one of them, so the
// agreement is in the code and not in two literals that happen to match.
// auditChipsOnOwnPath is the exception: its third parameter is an off-path
// DISTANCE tolerance in world units, not a boundary eps, so it keeps its own
// default.
//
// Not used when clipping a footprint. The eps exists to ignore a graze of a box
// boundary while DETECTING; a footprint is a PLACE, and shrinking the place by
// the detector's tolerance would report a run half a unit shorter at each end
// than the one an image shows.
const AUDIT_EPS = 0.5;

// Bounding rect of one polyline segment. An orthogonal run is flat in one axis,
// so the rect it yields has zero thickness there. That is the honest extent of a
// line: a consumer joining an evidence rect to a footprint must use an inclusive
// intersection test with its own tolerance rather than demanding overlap area.
function segFootprint(seg: readonly [Pt, Pt]): Rect {
  const [a, b] = seg;
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(b[0] - a[0]),
    height: Math.abs(b[1] - a[1]),
  };
}

// The place a segment-vs-box occurrence occupies: the run of the segment that
// lies inside the box the audit tested it against. The whole segment is the
// fallback, for the case a clip comes back empty - an occurrence the audit
// reported still has to name a place, and a coarse rect joins where an empty one
// joins to nothing. That fallback is unreachable while the caller clips against
// the same box the audit hit, since clipping at eps 0 widens the window the
// audit already found non-empty at AUDIT_EPS.
function clippedSegFootprint(seg: readonly [Pt, Pt], box: RawRect): Rect {
  return segFootprint(clipSegmentToRect(seg[0], seg[1], box, 0) ?? seg);
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function boxFootprint(box: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): Rect {
  return {
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

// Where two boxes actually meet, falling back to `a` when they do not meet at
// all. The fallback keeps a footprint that is merely coarse from becoming one
// that is empty, which would join to nothing and read as "no such place".
function intersectionOr(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return a;
  return { x, y, width: right - x, height: bottom - y };
}

// The join key between the two in-page collectors' views of one box. Valid only
// within a single camera: both collections are then taken with nothing changing
// in between, so the two views agree to the pixel. Across cameras they do not -
// getBoundingClientRect is subpixel-quantised, and a hundredth of a world unit
// is enough to move a rounded key.
export function worldRectKey(
  left: number,
  top: number,
  right: number,
  bottom: number,
): string {
  return [left, top, right, bottom].map((n) => n.toFixed(2)).join(",");
}

// Scene element id per chip box. A key claimed by two chips is dropped rather
// than resolved arbitrarily: naming the wrong chip would point a later join at
// the wrong place, which is worse than naming no chip at all.
function chipIdsByRect(scene: SceneCollection): Map<string, string> {
  const byKey = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const el of scene.elements) {
    if (el.kind !== "chip") continue;
    const r = el.worldRect;
    const key = worldRectKey(r.x, r.y, r.x + r.width, r.y + r.height);
    if (byKey.has(key)) {
      ambiguous.push(key);
      continue;
    }
    byKey.set(key, el.id);
  }
  for (const key of ambiguous) byKey.delete(key);
  return byKey;
}

function idList(...values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((v): v is string => v !== undefined && v !== "")),
  ];
}

// Run the geometry audits over one camera's snapshot and record every occurrence
// they report, each pinned to a world-unit footprint.
//
// These are MEASUREMENTS, not findings. The ratchet spec that owns these same
// audits accepts large nonzero counts of every kind below, per scenario, behind
// hand-written rulings; treating an entry here as a defect would re-file conditions
// that have already been ruled on individually. A finding becomes a finding when
// a baseline is exceeded, which is that spec's job and not this one's. What a
// footprint is for is the opposite direction: deciding whether a finding someone
// else reported has independent geometric support AT THE PLACE THEY MARKED, which
// is why a long edge measured at one end must not carry the whole edge's rect.
//
// The counts here are NOT comparable to those baselines, and a difference is not
// a regression: the baselines are taken at the app's fit camera, these at the
// exam's target zoom. Chips counter-scale, so a chip's world footprint grows as
// zoom falls; the same layout therefore yields fewer chip-tier occurrences at the
// higher target zoom than at a lower fit. Comparing the two numbers can only
// mislead - compare a capture against another capture at the same target zoom.
//
// `geom` and `scene` must come from the SAME camera: chip identity is recovered
// by matching world rects between the two collectors, and that join only holds
// within one shot.
export function measurementsFor(
  geom: Geometry,
  scene: SceneCollection,
): {
  measurements: Measurement[];
  crossingCensus: { count: number; cued: number };
} {
  const edges = toRawEdges(geom.edges);
  const nodes: NodeRect[] = geom.nodes;
  const chips: ChipRect[] = geom.chips;
  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const chipIds = chipIdsByRect(scene);
  const chipIdOf = (chip: ChipRect): string | undefined =>
    chipIds.get(worldRectKey(chip.left, chip.top, chip.right, chip.bottom));

  const measurements: Measurement[] = [];

  // Clipped to the PADDED card, which is the box this audit tests against; the
  // `raw` flag says the run also reaches the unpadded body, but the occurrence
  // as reported is the entry into the padded box.
  for (const v of auditSegmentsVsCards(edges, nodes, AUDIT_EPS)) {
    measurements.push({
      kind: "segment-vs-card",
      elementIds: idList(v.edgeId, v.card),
      footprint: clippedSegFootprint(v.seg, paddedCard(nodeById.get(v.card)!)),
      detail: `edge ${v.edgeId} segment ${fmtSeg(v.seg)} enters ${
        v.raw ? "the raw box of" : "the padding of"
      } card ${v.card}`,
    });
  }

  // Clipped to the raw card body, which is what this audit tests against.
  for (const v of auditOwnCardPierces(edges, nodes, AUDIT_EPS)) {
    measurements.push({
      kind: "own-card-pierce",
      elementIds: idList(v.edgeId, v.card),
      footprint: clippedSegFootprint(v.seg, nodeById.get(v.card)!),
      detail: `edge ${v.edgeId} segment ${fmtSeg(v.seg)} runs inside its own ${v.role} card ${v.card}`,
    });
  }

  // The chip is identified by owner and label only, which two chips of one edge
  // can share, so the candidate set is narrowed by the reported segment: the one
  // chip that segment actually enters. Still ambiguous means no chip id.
  for (const v of auditSegmentsVsChips(edges, chips, nodes, AUDIT_EPS)) {
    const candidates = chips.filter(
      (c) =>
        c.edgeId === v.chipEdgeId &&
        c.label === v.chipLabel &&
        segmentEntersRect(v.seg[0], v.seg[1], c, AUDIT_EPS),
    );
    const chipId =
      candidates.length === 1 ? chipIdOf(candidates[0]!) : undefined;
    // The place is the run inside the chip box, not the whole segment. An
    // ambiguous candidate set is ambiguous about WHICH chip, not about where:
    // the segment enters every candidate, so the union of the clipped runs is
    // still bounded by those chips.
    const clips = candidates.map((c) => clippedSegFootprint(v.seg, c));
    const footprint =
      clips.length === 0 ? segFootprint(v.seg) : clips.reduce(unionRect);
    measurements.push({
      kind: "chip-vs-segment",
      elementIds: idList(chipId, v.chipEdgeId, v.edgeId),
      footprint,
      detail: `edge ${v.edgeId} segment ${fmtSeg(v.seg)} enters the chip of ${v.chipEdgeId} ("${v.chipLabel}")`,
    });
  }

  // Chip-keyed audits are run one chip at a time. Both are per-chip loops with
  // no cross-chip state, so a singleton call reports exactly what the batch call
  // would - and it hands back WHICH chip each occurrence belongs to, which their
  // payloads (owner id plus label, and for the off-path tier a bare distance) do
  // not otherwise pin down.
  for (const chip of chips) {
    const chipRect = boxFootprint(chip);
    const chipId = chipIdOf(chip);

    // The detail stays neutral about HOW the card was reached. Two conditions
    // feed this tier: a foreign card the chip box overlaps, and the chip's OWN
    // endpoint card whose body its CENTRE sits on past the port strip - and the
    // second can fire with no box overlap at all, so claiming an overlap here
    // would assert something the geometry need not support.
    for (const v of auditChipsVsCards([chip], edges, nodes, AUDIT_EPS)) {
      const card = nodeById.get(v.card)!;
      measurements.push({
        kind: "chip-vs-card",
        elementIds: idList(chipId, v.chipEdgeId, v.card),
        footprint: intersectionOr(chipRect, boxFootprint(card)),
        detail: `${v.chipKind} chip of ${v.chipEdgeId} ("${v.chipLabel}") is flagged against card ${v.card} (foreign-card box overlap, or own-card centre past the port strip)`,
      });
    }

    for (const v of auditChipsOnOwnPath([chip], edges)) {
      measurements.push({
        kind: "chip-off-own-path",
        elementIds: idList(chipId, v.chipEdgeId),
        footprint: chipRect,
        detail: `label chip of ${v.chipEdgeId} ("${v.chipLabel}") sits ${v.distance.toFixed(1)} world units off its own polyline`,
      });
    }
  }

  // Kept out of `measurements` on purpose: countCrossings returns a bare number
  // with no participating ids and no place, so there is no footprint to give it
  // and nothing it could ever corroborate. `cued` comes from the same shared
  // coverage scorer the geometry audit asserts with (crossingCueCoverage),
  // so the exam's scene docs and the audit's ratchet can never disagree about
  // what a cued crossing is.
  return {
    measurements,
    crossingCensus: {
      count: countCrossings(geom.edges),
      cued: crossingCueCoverage(geom.edges, geom.crossingCues).cued,
    },
  };
}

// Write `<dir>/scene.json` and return the path it landed at. The directory is
// created if it does not exist, because the images are already on disk in a
// subdirectory of it and a missing directory at this point would lose the ledger
// for shots that were taken.
export async function writeScene(dir: string, doc: SceneDoc): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "scene.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}
