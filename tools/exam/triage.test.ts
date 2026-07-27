// The corroboration join, exercised on hand-built tiles and measurements.
//
// The fixture is arithmetic a reader can redo: every transform has zoom 2 and a
// whole-number offset, so the projected position of the one measurement below is
// stated in each test rather than computed from the module under test. That
// matters here more than usual - the join's failure mode is a silent miss, and a
// test that derived its expected rect from the same projection code would agree
// with a broken projection by construction.
//
// What these tests are guarding is a FALSE corroboration, which lets an
// unverified claim skip refutation and get filed. So the negative cases (rect
// moved along the same element, wrong tile's transform, incompatible claim type,
// projection under the chrome) carry the weight, and each one is the same
// finding as a passing case with exactly one thing changed.

import { describe, expect, test } from "vitest";
import {
  corroborationsFor,
  routeFinding,
  validateFinding,
  type Finding,
  type TileFrame,
} from "./triage";
import type { Measurement } from "./scene";
import type { Rect } from "./tiling";

const SAFE: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

// Two cameras over the same world. A footprint at world (100, 100) lands at
// image (300, 250) through TILE_A and at (1100, 250) through TILE_B, so the two
// frames disagree by 800 px about where the same measurement is.
const TILE_A: TileFrame = {
  file: "10-tile-r0c0.png",
  viewportTransform: { x: 100, y: 50, zoom: 2 },
  safeRegion: SAFE,
};
const TILE_B: TileFrame = {
  file: "10-tile-r0c1.png",
  viewportTransform: { x: 900, y: 50, zoom: 2 },
  safeRegion: SAFE,
};
const TILES = [TILE_A, TILE_B];

// World (100, 100) to (120, 110). Through TILE_A: image (300, 250) to (340, 270).
const CHIP: Measurement = {
  kind: "chip-off-own-path",
  elementIds: ["chip:7", "e:0:A->B:iron"],
  footprint: { x: 100, y: 100, width: 20, height: 10 },
  detail: 'label chip of e:0:A->B:iron ("30/min") sits 84.0 world units off its own polyline',
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    planId: "copper",
    title: "chip floats free of its line",
    observation: 'the "30/min" chip sits well away from any edge',
    claimType: "geometric",
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
function withoutFalsifier(base: Finding): Finding {
  const clone: Finding = { ...base };
  delete clone.falsifier;
  return clone;
}

describe("corroborationsFor", () => {
  test("joins a geometric finding whose evidence rect overlaps the projected footprint", () => {
    expect(corroborationsFor(finding(), [CHIP], TILES)).toEqual([CHIP]);
  });

  // The pair that is the whole point of the co-location condition. Same finding,
  // same measurement, same element named in `where` - only the marked place
  // moved. A join on shared element ids would pass this and manufacture support
  // for clutter hundreds of pixels away on the same long edge.
  test("does not join when the rect sits 500 px away on the same element", () => {
    const far = finding({
      evidence: [
        { image: TILE_A.file, rect: [790, 240, 60, 40], where: "on edge e:0:A->B:iron" },
      ],
    });
    expect(corroborationsFor(far, [CHIP], TILES)).toEqual([]);
  });

  // A footprint is in world units, so it has no image position until a tile's
  // transform is applied. Citing tile B and marking the place the measurement
  // occupies in tile A is naming a spot where tile B shows something else.
  test("projects through the cited tile's transform only", () => {
    const citesB = finding({
      evidence: [
        { image: TILE_B.file, rect: [290, 240, 60, 40], where: "left of centre" },
      ],
    });
    expect(corroborationsFor(citesB, [CHIP], TILES)).toEqual([]);

    const citesBWhereItIs = finding({
      evidence: [
        { image: TILE_B.file, rect: [1090, 240, 60, 40], where: "right of centre" },
      ],
    });
    expect(corroborationsFor(citesBWhereItIs, [CHIP], TILES)).toEqual([CHIP]);
  });

  test("does not join through a tile the capture never wrote", () => {
    const unknown = finding({
      evidence: [{ image: "99-nope.png", rect: [290, 240, 60, 40], where: "middle" }],
    });
    expect(corroborationsFor(unknown, [CHIP], TILES)).toEqual([]);
  });

  // The geometry audits measure what they measure; none of them can witness a
  // hover that does nothing, a thing that is missing, or two colours being
  // confusable. A rect that overlaps perfectly buys these nothing.
  test.each(["interaction", "absence", "subjective"] as const)(
    "never corroborates a %s claim, however well the rect overlaps",
    (claimType) => {
      expect(corroborationsFor(finding({ claimType }), [CHIP], TILES)).toEqual([]);
    },
  );

  test("ignores an unknown claimType rather than treating it as geometric", () => {
    const bogus = finding({ claimType: "vibes" as Finding["claimType"] });
    expect(corroborationsFor(bogus, [CHIP], TILES)).toEqual([]);
  });

  // An element reaching the pane only under the minimap or the zoom controls is
  // in the image and outside the safe region, and the evaluator was told to read
  // only the safe region. Support there is support for something nobody saw.
  test("does not join a footprint that projects outside the tile's safe region", () => {
    const occluded: TileFrame = {
      ...TILE_A,
      safeRegion: { x: 0, y: 0, width: 1920, height: 200 },
    };
    const marked = finding({
      evidence: [
        { image: TILE_A.file, rect: [290, 240, 60, 40], where: "bottom-left" },
      ],
    });
    expect(corroborationsFor(marked, [CHIP], [occluded])).toEqual([]);
  });

  // An orthogonal run has zero thickness, so a strict area test would refuse
  // every segment-tier measurement against a rect drawn around the visible ink.
  test("joins a zero-thickness segment footprint to a rect around the stroke", () => {
    const seg: Measurement = {
      kind: "segment-vs-card",
      elementIds: ["e:0:A->B:iron", "B"],
      footprint: { x: 100, y: 100, width: 40, height: 0 },
      detail: "edge e:0:A->B:iron segment enters the padding of card B",
    };
    const marked = finding({
      evidence: [
        { image: TILE_A.file, rect: [310, 244, 20, 12], where: "over card B" },
      ],
    });
    expect(corroborationsFor(marked, [seg], TILES)).toEqual([seg]);
  });

  test("reports a measurement once even when several evidence rects reach it", () => {
    const twice = finding({
      evidence: [
        { image: TILE_A.file, rect: [290, 240, 60, 40], where: "left" },
        { image: TILE_A.file, rect: [330, 260, 60, 40], where: "right" },
      ],
    });
    expect(corroborationsFor(twice, [CHIP], TILES)).toEqual([CHIP]);
  });

  test("keeps only the measurements that actually co-locate", () => {
    const elsewhere: Measurement = {
      ...CHIP,
      kind: "chip-vs-card",
      footprint: { x: 800, y: 800, width: 20, height: 10 },
    };
    expect(corroborationsFor(finding(), [elsewhere, CHIP], TILES)).toEqual([CHIP]);
  });

  test("returns nothing when the plan measured clean", () => {
    expect(corroborationsFor(finding(), [], TILES)).toEqual([]);
  });

  test("skips a malformed evidence rect instead of joining on NaN", () => {
    const broken = finding({
      evidence: [
        { image: TILE_A.file, rect: [NaN, 240, 60, 40], where: "somewhere" },
      ],
    });
    expect(corroborationsFor(broken, [CHIP], TILES)).toEqual([]);
  });
});

describe("routeFinding", () => {
  test("sends a corroborated geometric finding to CORROBORATED", () => {
    expect(routeFinding(finding(), [CHIP])).toBe("CORROBORATED");
  });

  test("sends an uncorroborated major to an individual refuter", () => {
    expect(routeFinding(finding(), [])).toBe("REFUTE_INDIVIDUAL");
  });

  test("sends an uncorroborated minor to the batch refuter", () => {
    expect(routeFinding(finding({ severity: "minor" }), [])).toBe("REFUTE_BATCH");
    expect(routeFinding(finding({ severity: "nit" }), [])).toBe("REFUTE_BATCH");
  });

  test("sends a subjective finding to a human", () => {
    const subjective = withoutFalsifier(
      finding({ claimType: "subjective", severity: "minor" }),
    );
    expect(routeFinding(subjective, [])).toBe("HUMAN_RULING");
  });

  test.each(["absence", "interaction"] as const)(
    "sends a %s claim to an individual refuter whatever its severity",
    (claimType) => {
      expect(routeFinding(finding({ claimType, severity: "nit" }), [])).toBe(
        "REFUTE_INDIVIDUAL",
      );
    },
  );

  // A stated mechanism is a claim about the code, and no footprint can check it.
  // The two earlier exams that filed a wrong mechanism both had geometry that
  // was real, so corroboration must not buy the mechanism a pass.
  test("sends a finding with a mechanism hypothesis to an individual refuter", () => {
    const withMechanism = finding({
      severity: "nit",
      mechanismHypothesis: "the chip anchor is stamped before the route is chamfered",
    });
    expect(routeFinding(withMechanism, [CHIP])).toBe("REFUTE_INDIVIDUAL");
  });

  // A caller can hand routeFinding any list; the claim type still decides.
  // Corroboration is only ever an answer to a geometric question.
  test("still refutes a non-geometric claim handed a non-empty corroboration list", () => {
    expect(routeFinding(finding({ claimType: "interaction" }), [CHIP])).toBe(
      "REFUTE_INDIVIDUAL",
    );
    expect(routeFinding(finding({ claimType: "absence" }), [CHIP])).toBe(
      "REFUTE_INDIVIDUAL",
    );
    const subjective = withoutFalsifier(finding({ claimType: "subjective" }));
    expect(routeFinding(subjective, [CHIP])).toBe("HUMAN_RULING");
  });
});

describe("validateFinding", () => {
  test("passes a well-formed finding", () => {
    expect(validateFinding(finding())).toEqual([]);
  });

  test("passes a subjective finding with no falsifier", () => {
    const subjective = withoutFalsifier(finding({ claimType: "subjective" }));
    expect(validateFinding(subjective)).toEqual([]);
  });

  test.each(["geometric", "interaction", "absence"] as const)(
    "requires a falsifier for a %s claim",
    (claimType) => {
      const violations = validateFinding(withoutFalsifier(finding({ claimType })));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("falsifier");
    },
  );

  test("requires a falsifier when a mechanism is hypothesised", () => {
    const subjective = withoutFalsifier(
      finding({
        claimType: "subjective",
        mechanismHypothesis: "the anchor is stamped too early",
      }),
    );
    const violations = validateFinding(subjective);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("falsifier");
  });

  test("forbids a falsifier on a subjective claim", () => {
    const violations = validateFinding(finding({ claimType: "subjective" }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("falsifier");
  });

  test("rejects an empty observation", () => {
    expect(validateFinding(finding({ observation: "   " }))).toEqual([
      "observation is empty",
    ]);
  });

  test("rejects empty evidence", () => {
    expect(validateFinding(finding({ evidence: [] }))).toEqual(["evidence is empty"]);
  });

  // An evidence entry that cannot be projected is not a cosmetic defect: it
  // joins to nothing, and a finding that joins to nothing reads as merely
  // uncorroborated rather than as unreadable.
  test("rejects an evidence entry with no image or a malformed rect", () => {
    const broken = finding({
      evidence: [
        { image: "", rect: [0, 0, 10, 10], where: "left" },
        { image: TILE_A.file, rect: [0, 0, -10, 10], where: "right" },
        { image: TILE_A.file, rect: [0, Infinity, 10, 10], where: "below" },
      ],
    });
    expect(validateFinding(broken)).toHaveLength(3);
  });

  test("rejects values outside the enumerations", () => {
    const bogus = finding({
      claimType: "vibes" as Finding["claimType"],
      severity: "blocker" as Finding["severity"],
      aspect: "taste" as Finding["aspect"],
    });
    expect(validateFinding(bogus)).toHaveLength(3);
  });

  test("reports every violation at once", () => {
    const bad = withoutFalsifier(finding({ observation: "", evidence: [] }));
    expect(validateFinding(bad)).toHaveLength(3);
  });
});
