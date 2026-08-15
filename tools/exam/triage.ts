// The corroboration join: which of an evaluator's findings have INDEPENDENT
// geometric support at the place the evaluator marked, and where the rest have
// to go.
//
// Pure: no Playwright, no DOM, no I/O, unit-testable in jsdom. It reads the
// measurement pass's output and an evaluator's findings and decides nothing
// about the app.
//
// What it is for. An evaluator critiques images cold, so what it reports is what
// a reader would see, which is exactly what makes it worth having and exactly
// why it cannot be filed unchecked: an earlier exam filed nine issues of which
// two were invalid premises and two named a wrong mechanism. A finding either
// gets support from a measurement taken independently of the evaluator, or it
// goes to a refuter whose job is to disprove it against the running app. So the
// expensive error here is a FALSE corroboration - it lets an unverified claim
// skip refutation entirely - and every rule below fails closed.
//
// WHAT A JOIN ESTABLISHES, stated exactly because the routing hangs off it: not
// "the finding is true" and not "the finding is corroborated" in any wider
// sense, but "a geometry occurrence of a kind compatible with this claim exists
// at the place the evaluator marked, in the image it named, at a size
// commensurate with the mark". Everything past that - whether the occurrence is
// the one being complained about, whether it is a defect at all - is outside
// what a footprint can say.
//
// COORDINATE FRAMES, the way this join is most easily got wrong. A measurement's
// `footprint` is in React Flow WORLD units. An evaluator's evidence rect is in
// IMAGE space: CSS pixels within one named tile screenshot, which is the pane's
// own frame because each image is a `scale: "css"` screenshot of the pane. The
// two are not comparable until the footprint is projected through the cited
// tile's transform (screen = world * zoom + offset). Comparing them raw does not
// throw and does not warn: it silently matches nothing, which reads as "nothing
// was corroborated" - the failure that looks like the system working.

import type { Measurement, MeasurementKind } from "./scene";
import type { Rect, Viewport } from "./tiling";

// The geometric family is split by what the audits can actually witness: a
// placement claim (where a chip or label sits) is settled by chip-tier
// geometry, a routing claim (where an edge runs) by segment-tier geometry, and
// a collision claim (a stroke through a chip) by the crossing kind. One
// undivided "geometric" row joined every kind to every claim, which let a
// chip-tier claim ride a segment graze past refutation.
export type GeometricClaimType =
  | "geometric-placement"
  | "geometric-routing"
  | "geometric-collision";

export type ClaimType =
  | GeometricClaimType
  | "interaction"
  | "absence"
  | "subjective";

// One evidence rect is `[x, y, width, height]` in the named image's CSS pixels,
// the same shape and frame as `tiles[].elements` in scene.json, so an evaluator
// quoting an element's rect from the ledger needs no conversion.
export type Finding = {
  id: string;
  planId: string;
  title: string;
  observation: string;
  claimType: ClaimType;
  evidence: Array<{ image: string; rect: [number, number, number, number]; where: string }>;
  severity: "major" | "minor" | "nit";
  aspect: "correctness" | "comprehension" | "ux";
  falsifier?: { op: string; args: Record<string, string>; expectedIfFalse: string };
  mechanismHypothesis?: string;
};

export type Route =
  | "CORROBORATED"
  | "REFUTE_INDIVIDUAL"
  | "REFUTE_BATCH"
  | "HUMAN_RULING";

// The part of a `TileRecord` this join needs. A TileRecord satisfies it, so the
// caller passes `scene.tiles` straight through.
//
// `kind` is here for one reason: the measurement pass runs ONCE, at the camera
// the last tile shot left behind, which is the target zoom. Only a `tile` or a
// `corrective` was shot there - the capture asserts the achieved zoom on every
// one of them - while `fit` is a different camera entirely. See `joinable`.
export type TileFrame = {
  file: string;
  kind: "fit" | "tile" | "corrective";
  viewportTransform: Viewport;
  safeRegion: Rect;
};

// Float slop for the intersection tests, small enough to be invisible against
// any distance that could move a join.
const EPS = 1e-9;

// Image-space slack, in CSS pixels, added around a projected footprint before it
// is tested against an evidence rect. A footprint is mathematical geometry and
// an orthogonal run of it has zero thickness, while the ink a reviewer drew a
// box around is a stroke a few pixels wide; without this a rect drawn tight
// around the visible line would miss the line's own centre. Kept at a stroke
// width rather than a comfortable margin: every pixel of it is a pixel of
// evidence rect that did not have to overlap.
//
// The slack sets the distance and the inclusive intersection closes the
// interval: a rect exactly JOIN_SLACK_PX clear of the projected footprint joins,
// one a pixel further out does not. Both halves are pinned by tests at 1, 2 and
// 3 px of clearance, so neither can be widened or dropped silently.
const JOIN_SLACK_PX = 2;

// Proportionality, the second half of co-location.
//
// Overlap alone says "a measured occurrence exists somewhere in this region". A
// finding claims something about a place, and a mark far larger than the thing
// measured inside it is not about that thing: a 300x200 box drawn round a node
// card to say "these labels are unreadable" would otherwise be corroborated by
// any thin edge graze of that card's padding, and skip refutation on it. So an
// evidence rect must be COMMENSURATE with the projected footprint before its
// overlap counts.
//
// Extent per axis, not area: an orthogonal footprint is flat in one axis, so any
// area ratio is either infinite or zero for the whole segment tier. Both axes
// must pass, because a mark that is right in one axis and pane-wide in the other
// is still a mark on something else.
//
// The floor is what a footprint with no size of its own is allowed to be marked
// with: a rate chip at the exam's target zoom is roughly 40x18 CSS px, and a
// hand-drawn box round one runs to about 60x40, so 48 px is a mark comfortably
// larger than the smallest thing anyone can point at without being a region.
// The ratio then admits a generous box round a phenomenon of real size - three
// times its extent - and refuses the region-sized mark: with the floor the
// smallest limit is 144x144, about 1% of a 1920x1080 pane.
const MAX_MARK_EXTENT_RATIO = 3;
const MIN_MARK_EXTENT_PX = 48;

// Which measurement kinds can witness which kind of claim.
//
// Only a geometric claim - one about where things are on the canvas - is the
// sort of thing these audits measure. An interaction claim (hover does nothing),
// an absence claim (this is missing) and a subjective one (these two colours are
// confusable) are not: no chip-off-own-path occurrence can confirm that two
// colours are hard to tell apart, however precisely it overlaps the rect the
// evaluator drew. Those go to a refuter or a human instead.
// Which geometric sub-claim each measurement kind can witness. `satisfies`
// keeps this exhaustive in both directions: a new MeasurementKind fails to
// compile here rather than silently joining no row, and the rows below are
// derived from this map so the two cannot drift.
const KIND_WITNESSES = {
  "chip-off-own-path": "geometric-placement",
  "chip-vs-card": "geometric-placement",
  "segment-vs-card": "geometric-routing",
  "own-card-pierce": "geometric-routing",
  "chip-vs-segment": "geometric-collision",
} as const satisfies Record<MeasurementKind, GeometricClaimType>;

const MEASUREMENT_KINDS = Object.keys(KIND_WITNESSES) as MeasurementKind[];

// Derived rather than listed so a sub-claim cannot exist without at least one
// kind that witnesses it.
const GEOMETRIC_CLAIM_TYPES = [
  ...new Set(Object.values(KIND_WITNESSES)),
] as GeometricClaimType[];

function isGeometricClaim(claimType: ClaimType): claimType is GeometricClaimType {
  return (GEOMETRIC_CLAIM_TYPES as readonly ClaimType[]).includes(claimType);
}

const COMPATIBLE_KINDS: Record<ClaimType, readonly MeasurementKind[]> = {
  "geometric-placement": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-placement",
  ),
  "geometric-routing": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-routing",
  ),
  "geometric-collision": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-collision",
  ),
  interaction: [],
  absence: [],
  subjective: [],
};

const CLAIM_TYPES = Object.keys(COMPATIBLE_KINDS) as ClaimType[];
const SEVERITIES: ReadonlyArray<Finding["severity"]> = ["major", "minor", "nit"];
const ASPECTS: ReadonlyArray<Finding["aspect"]> = [
  "correctness",
  "comprehension",
  "ux",
];

// The measurements that occur AT THE PLACE THIS FINDING MARKS.
//
// A non-empty result says a geometry occurrence of a compatible kind exists
// there, which is the most a footprint can establish; it does not say the
// occurrence is the one the evaluator is complaining about. All three conditions
// must hold, and none is worth anything alone:
//   - co-location: the footprint, projected through the transform of the tile
//     THAT PIECE of evidence names, meets that evidence rect inside the tile's
//     safe region;
//   - proportionality: the evidence rect is commensurate with the projected
//     footprint, so a region-sized mark cannot inherit a phenomenon inside it;
//   - kind compatibility: the table above.
// A shared element id is deliberately not among them and is not even readable
// from a Finding: a long edge can be measured at one end while the evaluator
// marked unrelated clutter hundreds of pixels away on the same edge, and an
// id-keyed join would call that support.
//
// Everything unresolvable is dropped rather than guessed at: an evidence entry
// naming an image no tile wrote has no transform to project through, one
// naming the fit overview was shot at a camera these measurements were not taken
// at, and one carrying a malformed rect has no place to test. All come back as
// "no corroboration", which costs a refutation the evaluator's claim was going
// to deserve anyway.
export function corroborationsFor(
  finding: Finding,
  measurements: readonly Measurement[],
  tiles: readonly TileFrame[],
): Measurement[] {
  // A claimType outside the enumeration (findings arrive as agent-authored JSON)
  // gets the empty row, not the geometric one. Membership is tested against the
  // key LIST rather than by indexing, so an inherited property name - the JSON
  // string "constructor" is a legal claimType to write - cannot resolve through
  // the prototype chain to something with a non-zero length.
  const kinds = CLAIM_TYPES.includes(finding.claimType)
    ? COMPATIBLE_KINDS[finding.claimType]
    : [];
  if (kinds.length === 0) return [];

  const places: Array<{ tile: TileFrame; rect: Rect }> = [];
  for (const entry of evidenceEntries(finding)) {
    const tile = tiles.find((t) => joinable(t) && t.file === entry.image);
    const rect = rectFromTuple(entry.rect);
    if (tile === undefined || rect === null) continue;
    places.push({ tile, rect });
  }
  if (places.length === 0) return [];

  return measurements.filter(
    (m) =>
      kinds.includes(m.kind) &&
      places.some((place) => meets(m.footprint, place.tile, place.rect)),
  );
}

// Can a measurement be projected into this tile at all?
//
// The measurement pass runs once, at the camera the last tile shot left behind,
// so a footprint is only a place in an image shot at THAT camera. `fit` is not:
// it is a whole-graph overview at a much lower zoom, where the LOD gates change
// what is mounted - below the label gate no rate chip exists in the picture at
// all - and where chips counter-scale, so a chip's world footprint recorded at
// the target zoom is the wrong size as well as of the wrong thing. Projecting
// into it would still land somewhere plausible, on whatever the overview happens
// to draw there, which is exactly the false corroboration this module exists to
// prevent. Excluding by `kind` rather than by comparing zooms because the
// capture already asserts the achieved zoom on every `tile` and `corrective`
// shot, so the kinds ARE the camera; an allowlist so an unrecognised kind is
// refused rather than admitted.
function joinable(tile: TileFrame): boolean {
  return tile.kind === "tile" || tile.kind === "corrective";
}

// Is the marked rect about the projected footprint, rather than merely a region
// containing it? See MAX_MARK_EXTENT_RATIO.
function commensurate(projected: Rect, evidence: Rect): boolean {
  const limit = (extent: number): number =>
    Math.max(extent, MIN_MARK_EXTENT_PX) * MAX_MARK_EXTENT_RATIO;
  return (
    evidence.width <= limit(projected.width) + EPS &&
    evidence.height <= limit(projected.height) + EPS
  );
}

// Does this world-unit footprint reach the marked rect, in the frame of the
// image the mark was made on, and is the mark about it?
//
// The safe region is a term because it is the only part of the image the
// evaluator was given to read. What it excludes is coarser than the chrome it
// stands for: `safeRegion` is a rectangle, not an occlusion mask, and the cut it
// prefers is a full-width horizontal one, so with bottom-anchored chrome mounted
// it raises the floor across the whole pane width and then insets by the rim. At
// 1920x1080 with the minimap up that is roughly the bottom 170 px of every tile,
// full width, where the real chrome covers two corners. A defect sitting low and
// centre is therefore visible in the image and outside this region, and its
// corroboration is wrongly refused. That costs one refuter run and never grants
// support, which is the direction this module errs in; the per-overlay rects are
// on the TileRecord as `overlayMasks` if a later exam wants the exact mask.
function meets(footprint: Rect, tile: TileFrame, evidence: Rect): boolean {
  const projected = project(footprint, tile.viewportTransform);
  if (projected === null) return false;
  if (!commensurate(projected, evidence)) return false;

  const marked = intersect(inflate(projected, JOIN_SLACK_PX), evidence);
  if (marked === null) return false;
  return intersect(marked, tile.safeRegion) !== null;
}

// world -> pane-relative CSS px, which for a tile is that image's own frame.
// Null when the result is not finite, which a zero or NaN zoom produces: an
// unplaceable footprint must not be compared to anything.
function project(rect: Rect, t: Viewport): Rect | null {
  const out = {
    x: rect.x * t.zoom + t.x,
    y: rect.y * t.zoom + t.y,
    width: rect.width * t.zoom,
    height: rect.height * t.zoom,
  };
  return isFiniteRect(out) && out.width >= 0 && out.height >= 0 ? out : null;
}

function inflate(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

// Inclusive: two rects that share only an edge, or a rect of zero extent lying
// inside another, do meet. An orthogonal footprint is flat in one axis, so
// demanding overlap AREA would refuse every segment-tier measurement.
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right < x - EPS || bottom < y - EPS) return null;
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function isFiniteRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

// ---------------------------------------------------------------------------
// Reading agent-authored JSON
//
// A Finding is what a WELL-FORMED finding looks like, not a promise about what
// arrives: these come from an evaluator as JSON, and the whole reason this
// module exists is that its output is untrusted. So every field is read through
// a loose view and shape-checked before use. The alternative is a TypeError,
// which aborts the triage of a whole exam over one bad finding - the opposite of
// what a validator that returns violations is for.
// ---------------------------------------------------------------------------

type LooseEvidence = { image?: unknown; rect?: unknown; where?: unknown };

// The evidence entries that are objects at all, in order. A missing or non-array
// `evidence` reads as none, which joins to nothing; validateFinding reports it.
function evidenceEntries(finding: Finding): LooseEvidence[] {
  const raw: unknown = finding.evidence;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (entry): entry is LooseEvidence => typeof entry === "object" && entry !== null,
  );
}

function rectFromTuple(tuple: unknown): Rect | null {
  if (!Array.isArray(tuple) || tuple.length !== 4) return null;
  const [x, y, width, height] = tuple as unknown[];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  const rect = { x, y, width, height };
  return isFiniteRect(rect) && width >= 0 && height >= 0 ? rect : null;
}

// Where a finding goes next.
//
// The order of the tests is the substance. A stated mechanism is a claim about
// the code, and no footprint can check one, so it outranks corroboration
// entirely - the earlier exam's two wrong mechanisms both sat on geometry that
// was real. Absence and interaction claims are unwitnessable by construction
// (nothing in a still image separates "the app does nothing" from "the capture
// never touched it"), so they always get their own refuter. Only then may a
// geometric finding be waved through on the strength of a compatible geometry
// occurrence at the place it marks, and only a finding with no such occurrence
// is sorted by severity: majors are worth an individual refuter, the rest go to
// the batch.
export function routeFinding(
  finding: Finding,
  corroborations: readonly Measurement[],
): Route {
  if (finding.claimType === "subjective") return "HUMAN_RULING";
  if (
    finding.claimType === "absence" ||
    finding.claimType === "interaction" ||
    finding.mechanismHypothesis !== undefined
  ) {
    return "REFUTE_INDIVIDUAL";
  }
  if (isGeometricClaim(finding.claimType) && corroborations.length > 0) {
    return "CORROBORATED";
  }
  return finding.severity === "major" ? "REFUTE_INDIVIDUAL" : "REFUTE_BATCH";
}

// Schema violations, empty when the finding is well formed.
//
// The rules exist so that a finding is disprovable by someone other than its
// author. A falsifier is the named probe op that would settle it, so every claim
// about the app owes one, and a hypothesised mechanism owes one whatever the
// claim type; a subjective claim owes none and may not carry one, because there
// is no probe output that settles a matter of taste and offering one invites a
// refuter to answer a question the finding did not ask.
//
// Evidence is checked for being USABLE, not merely present. An entry with no
// image or an unreadable rect joins to nothing, and a finding that joins to
// nothing is indistinguishable from one that was checked and found
// uncorroborated - so the malformed entry has to be a violation here rather than
// a silent miss later.
//
// Nothing here may throw. A finding whose `observation` or `evidence` is absent
// altogether is precisely the input this function is for, and a TypeError on it
// would abort the triage of every other finding in the exam.
export function validateFinding(finding: Finding): string[] {
  const violations: string[] = [];

  if (!CLAIM_TYPES.includes(finding.claimType)) {
    violations.push(`claimType "${String(finding.claimType)}" is not a claim type`);
  }
  if (!SEVERITIES.includes(finding.severity)) {
    violations.push(`severity "${String(finding.severity)}" is not a severity`);
  }
  if (!ASPECTS.includes(finding.aspect)) {
    violations.push(`aspect "${String(finding.aspect)}" is not an aspect`);
  }

  const observation: unknown = finding.observation;
  if (typeof observation !== "string") {
    violations.push("observation is missing");
  } else if (observation.trim() === "") {
    violations.push("observation is empty");
  }

  const evidence: unknown = finding.evidence;
  if (!Array.isArray(evidence)) {
    violations.push("evidence is missing");
  } else if (evidence.length === 0) {
    violations.push("evidence is empty");
  } else {
    (evidence as unknown[]).forEach((raw, i) => {
      if (typeof raw !== "object" || raw === null) {
        violations.push(`evidence[${i}] is not an object`);
        return;
      }
      const entry = raw as LooseEvidence;
      if (typeof entry.image !== "string" || entry.image.trim() === "") {
        violations.push(`evidence[${i}] names no image`);
      }
      if (rectFromTuple(entry.rect) === null) {
        violations.push(`evidence[${i}] rect is not a finite [x, y, width, height]`);
      }
    });
  }

  const needsFalsifier =
    isGeometricClaim(finding.claimType) ||
    finding.claimType === "interaction" ||
    finding.claimType === "absence" ||
    finding.mechanismHypothesis !== undefined;
  if (needsFalsifier && finding.falsifier === undefined) {
    violations.push(
      finding.mechanismHypothesis !== undefined && finding.claimType === "subjective"
        ? "a mechanismHypothesis requires a falsifier"
        : `claimType "${finding.claimType}" requires a falsifier`,
    );
  }
  if (finding.claimType === "subjective" && finding.falsifier !== undefined) {
    violations.push('claimType "subjective" must not carry a falsifier');
  }

  return violations;
}
