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

export type ClaimType = "geometric" | "interaction" | "absence" | "subjective";

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
export type TileFrame = {
  file: string;
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
const JOIN_SLACK_PX = 2;

// Which measurement kinds can witness which kind of claim.
//
// Only a geometric claim - one about where things are on the canvas - is the
// sort of thing these audits measure. An interaction claim (hover does nothing),
// an absence claim (this is missing) and a subjective one (these two colours are
// confusable) are not: no chip-off-own-path occurrence can confirm that two
// colours are hard to tell apart, however precisely it overlaps the rect the
// evaluator drew. Those go to a refuter or a human instead.
const ALL_MEASUREMENT_KINDS = {
  "chip-off-own-path": true,
  "chip-vs-card": true,
  "segment-vs-card": true,
  "own-card-pierce": true,
  "chip-vs-segment": true,
  // `satisfies` is the point of the object form: a new MeasurementKind fails to
  // compile here rather than silently dropping out of the geometric row.
} as const satisfies Record<MeasurementKind, true>;

const COMPATIBLE_KINDS: Record<ClaimType, readonly MeasurementKind[]> = {
  geometric: Object.keys(ALL_MEASUREMENT_KINDS) as MeasurementKind[],
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

// The measurements that support this finding AT THE PLACE IT MARKS.
//
// Both conditions must hold, and neither is worth anything alone:
//   - co-location: the footprint, projected through the transform of the tile
//     THAT PIECE of evidence names, meets that evidence rect inside the tile's
//     safe region;
//   - kind compatibility: the table above.
// A shared element id is deliberately not among them and is not even readable
// from a Finding: a long edge can be measured at one end while the evaluator
// marked unrelated clutter hundreds of pixels away on the same edge, and an
// id-keyed join would call that support.
//
// Everything unresolvable is dropped rather than guessed at: an evidence entry
// naming an image no tile wrote has no transform to project through, and one
// carrying a malformed rect has no place to test. Both come back as "no
// corroboration", which costs a refutation the evaluator's claim was going to
// deserve anyway.
export function corroborationsFor(
  finding: Finding,
  measurements: readonly Measurement[],
  tiles: readonly TileFrame[],
): Measurement[] {
  // A claimType outside the enumeration (findings arrive as agent-authored JSON)
  // gets the empty row, not the geometric one.
  const kinds = COMPATIBLE_KINDS[finding.claimType] ?? [];
  if (kinds.length === 0) return [];

  const places: Array<{ tile: TileFrame; rect: Rect }> = [];
  for (const evidence of finding.evidence) {
    const tile = tiles.find((t) => t.file === evidence.image);
    const rect = rectFromTuple(evidence.rect);
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

// Does this world-unit footprint reach the marked rect, in the frame of the
// image the mark was made on?
//
// The safe region is the third term because it is the only part of the image the
// evaluator was given to read: an element reaching the pane only under the
// minimap or the zoom controls is in the screenshot and excluded from the
// ledger's element map, so support there is support for something nobody could
// have seen.
function meets(footprint: Rect, tile: TileFrame, evidence: Rect): boolean {
  const projected = project(footprint, tile.viewportTransform);
  if (projected === null) return false;
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

function rectFromTuple(
  tuple: readonly [number, number, number, number],
): Rect | null {
  const [x, y, width, height] = tuple ?? [];
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
// never touched it"), so they always get their own refuter. Only then can a
// corroborated geometric finding be waved through, and only an uncorroborated
// finding is sorted by severity: majors are worth an individual refuter, the
// rest go to the batch.
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
  if (finding.claimType === "geometric" && corroborations.length > 0) {
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

  if (finding.observation.trim() === "") violations.push("observation is empty");

  if (finding.evidence.length === 0) {
    violations.push("evidence is empty");
  } else {
    finding.evidence.forEach((entry, i) => {
      if (entry.image.trim() === "") {
        violations.push(`evidence[${i}] names no image`);
      }
      if (rectFromTuple(entry.rect) === null) {
        violations.push(`evidence[${i}] rect is not a finite [x, y, width, height]`);
      }
    });
  }

  const needsFalsifier =
    finding.claimType === "geometric" ||
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
