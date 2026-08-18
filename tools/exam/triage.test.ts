// The corroboration join, exercised on hand-built tiles and measurements.
//
// The fixtures live in ./triage-fixtures because workflow-parity.test.ts runs
// the workflow's inlined copy of these rules over the same shapes; the comment
// there explains the arithmetic they are built around.
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
import {
  CARD,
  CHIP,
  SEG,
  TILES,
  TILE_A,
  TILE_B,
  TILE_FIT,
  XING,
  finding,
  without,
  withoutFalsifier,
} from "./triage-fixtures";
import type { Measurement } from "./scene";

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

  // The measurements were taken at the target zoom; the fit overview is a
  // different camera, and below the label LOD gate it does not even contain the
  // chips a chip-tier measurement describes. Citing the overview for a global
  // layout complaint is the natural thing for an evaluator to do, so this is the
  // join that would most often be false. TILE_FIT carries TILE_A's transform, so
  // the projection lands exactly where the passing case does and only `kind`
  // refuses it.
  test("does not join through the fit overview, whatever its transform", () => {
    const citesFit = finding({
      evidence: [
        { image: TILE_FIT.file, rect: [290, 240, 60, 40], where: "the dense band" },
      ],
    });
    expect(corroborationsFor(citesFit, [CHIP], [...TILES, TILE_FIT])).toEqual([]);
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

  // The geometric family splits by tier: a placement claim is about where a
  // chip sits, a routing claim about where an edge runs, a collision claim
  // about an edge crossing a chip. Each is witnessed only by its own tier's
  // geometry; every measurement here shares one location, so the kind axis
  // alone decides. Both placement kinds are listed: the row holds two, and a
  // table naming only one lets the other be retargeted unnoticed.
  test.each([
    ["geometric-placement", CHIP],
    ["geometric-placement", CARD],
    ["geometric-routing", SEG],
    ["geometric-collision", XING],
  ] as const)("joins a %s claim to its own tier's measurement", (claimType, m) => {
    expect(corroborationsFor(finding({ claimType }), [m], TILES)).toEqual([m]);
  });

  test.each([
    ["geometric-placement", SEG],
    ["geometric-placement", XING],
    ["geometric-routing", CHIP],
    ["geometric-collision", SEG],
  ] as const)(
    "never corroborates a %s claim from another tier, however well the rect overlaps",
    (claimType, m) => {
      expect(corroborationsFor(finding({ claimType }), [m], TILES)).toEqual([]);
    },
  );

  test("rejects the retired claim type geometric rather than mapping it", () => {
    const legacy = finding({ claimType: "geometric" as Finding["claimType"] });
    expect(corroborationsFor(legacy, [CHIP, SEG, XING], TILES)).toEqual([]);
  });

  test("ignores an unknown claimType rather than granting it a row", () => {
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
      claimType: "geometric-routing",
      evidence: [
        { image: TILE_A.file, rect: [310, 244, 20, 12], where: "over card B" },
      ],
    });
    expect(corroborationsFor(marked, [seg], TILES)).toEqual([seg]);
  });

  // The tolerance boundary, pinned on both sides. CHIP projects to image x
  // 300..340 through TILE_A, so a rect starting at 341, 342 and 343 sits 1, 2 and
  // 3 px clear of it. The slack is 2 px and the intersection is inclusive, which
  // together mean a closed interval: 2 px clear still joins, 3 px clear does not.
  // Widening the slack, narrowing it, or making the intersection strict each
  // breaks one of these three.
  test.each([
    [341, "1 px clear", true],
    [342, "2 px clear, exactly the slack", true],
    [343, "3 px clear", false],
  ] as const)("a rect at x=%d (%s) joins: %s", (x, _label, joins) => {
    const marked = finding({
      evidence: [{ image: TILE_A.file, rect: [x, 250, 60, 20], where: "right of it" }],
    });
    expect(corroborationsFor(marked, [CHIP], TILES)).toEqual(joins ? [CHIP] : []);
  });

  // A place, not a region. The rect below is a plausible mark round a node card
  // for a complaint about that card; the measurement is a thin graze of the same
  // card's padding. The occurrence is real and inside the mark, and it is still
  // not what the mark is about.
  test("does not join a card-sized mark to a thin graze inside it", () => {
    const graze: Measurement = {
      kind: "segment-vs-card",
      elementIds: ["e:0:A->B:iron", "B"],
      footprint: { x: 100, y: 100, width: 5, height: 0 },
      detail: "edge e:0:A->B:iron segment enters the padding of card B",
    };
    const wholeCard = finding({
      claimType: "geometric-routing",
      evidence: [
        { image: TILE_A.file, rect: [250, 200, 300, 200], where: "this card" },
      ],
    });
    expect(corroborationsFor(wholeCard, [graze], TILES)).toEqual([]);
  });

  // The proportionality constants, each pinned on both sides.
  //
  // CHIP projects to 40x20, below the 48 px floor, so its limit is the floor
  // times the ratio: 144. A 144-wide mark is commensurate with it, 145 is a
  // region that happens to contain it.
  test.each([
    [144, true],
    [145, false],
  ])("a %d px wide mark on a 40x20 footprint joins: %s", (width, joins) => {
    const marked = finding({
      evidence: [{ image: TILE_A.file, rect: [290, 240, width, 40], where: "here" }],
    });
    expect(corroborationsFor(marked, [CHIP], TILES)).toEqual(joins ? [CHIP] : []);
  });

  // A footprint of real size takes the ratio instead: 200x200 projected admits a
  // 600 px mark and refuses 601, which pins the ratio at 3 independently of the
  // floor.
  test.each([
    [600, true],
    [601, false],
  ])("a %d px wide mark on a 200x200 footprint joins: %s", (width, joins) => {
    const big: Measurement = {
      ...CHIP,
      kind: "own-card-pierce",
      footprint: { x: 100, y: 100, width: 100, height: 100 },
    };
    const marked = finding({
      claimType: "geometric-routing",
      evidence: [{ image: TILE_A.file, rect: [300, 250, width, 600], where: "here" }],
    });
    expect(corroborationsFor(marked, [big], TILES)).toEqual(joins ? [big] : []);
  });

  // Every evidence entry is a place, not just the first: an evaluator marking a
  // wide overview rect and then the spot itself must not lose the second mark.
  test("tests every evidence entry, not only the first", () => {
    const secondReaches = finding({
      evidence: [
        { image: TILE_A.file, rect: [790, 240, 60, 40], where: "500 px away" },
        { image: TILE_A.file, rect: [290, 240, 60, 40], where: "on the chip" },
      ],
    });
    expect(corroborationsFor(secondReaches, [CHIP], TILES)).toEqual([CHIP]);
  });

  test("keeps only the measurements that actually co-locate", () => {
    const elsewhere: Measurement = {
      ...CHIP,
      kind: "chip-vs-card",
      footprint: { x: 800, y: 800, width: 20, height: 10 },
    };
    expect(corroborationsFor(finding(), [elsewhere, CHIP], TILES)).toEqual([CHIP]);
  });

  test("skips a malformed evidence rect instead of joining on NaN", () => {
    const broken = finding({
      evidence: [
        { image: TILE_A.file, rect: [NaN, 240, 60, 40], where: "somewhere" },
      ],
    });
    expect(corroborationsFor(broken, [CHIP], TILES)).toEqual([]);
  });

  // Findings arrive as agent-authored JSON, so the declared shape is a hope. A
  // missing or unusable field costs a refutation; a TypeError here costs the
  // whole exam's triage.
  test("returns nothing rather than throwing when evidence is absent", () => {
    expect(corroborationsFor(without(finding(), "evidence"), [CHIP], TILES)).toEqual(
      [],
    );
  });

  test("ignores evidence entries that are not objects", () => {
    const junk = finding({
      evidence: [null, "over there"] as unknown as Finding["evidence"],
    });
    expect(corroborationsFor(junk, [CHIP], TILES)).toEqual([]);
  });

  test("ignores an evidence rect that is not a four-number tuple", () => {
    const junk = finding({
      evidence: [
        {
          image: TILE_A.file,
          rect: { x: 290, y: 240 } as unknown as [number, number, number, number],
          where: "somewhere",
        },
      ],
    });
    expect(corroborationsFor(junk, [CHIP], TILES)).toEqual([]);
  });

  // "constructor" and "hasOwnProperty" are legal strings for an agent to emit
  // and resolve through the prototype chain of any plain object, so a table
  // lookup for them returns a function whose `length` is not zero.
  test.each(["constructor", "hasOwnProperty"] as const)(
    "treats the inherited property name %s as no claim type at all",
    (name) => {
      const bogus = finding({ claimType: name as unknown as Finding["claimType"] });
      expect(corroborationsFor(bogus, [CHIP], TILES)).toEqual([]);
      expect(validateFinding(bogus)).toContain(
        `claimType "${name}" is not a claim type`,
      );
    },
  );
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

  test.each([
    "geometric-placement",
    "geometric-routing",
    "geometric-collision",
    "interaction",
    "absence",
  ] as const)(
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

  // The inputs this function exists for. A validator that throws on the exact
  // malformed JSON it polices takes the rest of the exam's findings down with
  // the bad one.
  test("reports a missing observation instead of throwing", () => {
    expect(validateFinding(without(finding(), "observation"))).toEqual([
      "observation is missing",
    ]);
  });

  test("reports missing evidence instead of throwing", () => {
    expect(validateFinding(without(finding(), "evidence"))).toEqual([
      "evidence is missing",
    ]);
  });

  test("reports an evidence entry that is not an object or carries no image", () => {
    const broken = finding({
      evidence: [
        null,
        { rect: [0, 0, 10, 10], where: "no image key" },
      ] as unknown as Finding["evidence"],
    });
    expect(validateFinding(broken)).toEqual([
      "evidence[0] is not an object",
      "evidence[1] names no image",
    ]);
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

// The live false corroboration from the first dry run: a chip-tier claim on
// plan crystal rode three segment-vs-card grazes of an unrelated edge to
// CORROBORATED and was filed unchecked. Scene data verbatim from
// .artifacts/exam/crystal/scene.json; the evidence rect is drawn over the
// projected footprints so co-location and proportionality both pass and only
// the kind axis can refuse.
describe("crystal dry-run regression: chip claim over segment grazes", () => {
  const tile: TileFrame = {
    file: "10-tile-r0c0.png",
    kind: "tile",
    viewportTransform: { x: 422.4, y: 309.375, zoom: 0.75 },
    safeRegion: { x: 8, y: 8, width: 1543, height: 926 },
  };
  const grazes: Measurement[] = [
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 345, y: 138, width: 23.5, height: 0 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (345.0,138.0)->(368.5,138.0) enters the padding of card u:class:q:5",
    },
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 368.5, y: 138, width: 3.5, height: 3.5 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (368.5,138.0)->(372.0,141.5) enters the padding of card u:class:q:5",
    },
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 372, y: 141.5, width: 0, height: 48.5 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (372.0,141.5)->(372.0,294.5) enters the padding of card u:class:q:5",
    },
  ];
  const chipClaim = finding({
    planId: "crystal",
    title: "rate chips overhang the target card",
    observation: "rate chips sit over the body of card u:class:q:5",
    claimType: "geometric-placement",
    evidence: [
      { image: tile.file, rect: [676, 408, 30, 12], where: "over card u:class:q:5" },
    ],
  });

  test("the segment grazes cannot corroborate the chip claim", () => {
    expect(corroborationsFor(chipClaim, grazes, [tile])).toEqual([]);
  });

  test("the finding goes to an individual refuter, not CORROBORATED", () => {
    const corroborations = corroborationsFor(chipClaim, grazes, [tile]);
    expect(routeFinding(chipClaim, corroborations)).toBe("REFUTE_INDIVIDUAL");
  });

  test("a routing claim at the same mark still joins all three grazes", () => {
    const routingClaim = finding({
      planId: "crystal",
      title: "edge grazes the planting card",
      observation: "edge e:7 runs through the padding of card u:class:q:5",
      claimType: "geometric-routing",
      evidence: [
        { image: tile.file, rect: [676, 408, 30, 12], where: "over card u:class:q:5" },
      ],
    });
    expect(corroborationsFor(routingClaim, grazes, [tile])).toEqual(grazes);
  });
});
