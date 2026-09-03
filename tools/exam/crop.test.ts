import { describe, expect, test } from "vitest";
import {
  cropFileName,
  cropJobsFromRun,
  cropRect,
  cropRunOk,
  parseArgs,
  pngSize,
  DEFAULT_EXAM_DIR,
  DEFAULT_OUT_DIR,
  MARGIN_PX,
} from "./crop";

const IMAGE = { width: 1920, height: 1080 };

// A PNG header only: signature, then a length-13 IHDR chunk whose first eight
// payload bytes are the dimensions. Nothing downstream of the header is read.
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("pngSize", () => {
  test("reads width and height from the IHDR chunk", () => {
    expect(pngSize(pngHeader(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test("rejects a file that is not a PNG", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(pngSize(jpeg)).toBeNull();
  });

  test("rejects a PNG whose first chunk is not IHDR", () => {
    const bytes = pngHeader(10, 10);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    expect(pngSize(bytes)).toBeNull();
  });

  test("rejects a file too short to carry a header", () => {
    expect(pngSize(pngHeader(10, 10).slice(0, 20))).toBeNull();
  });

  test("rejects a header that declares a zero dimension", () => {
    expect(pngSize(pngHeader(0, 1080))).toBeNull();
  });
});

describe("cropRect", () => {
  test("returns the rect unchanged at zero margin", () => {
    expect(
      cropRect({ x: 100, y: 200, width: 300, height: 40 }, 0, IMAGE),
    ).toEqual({ x: 100, y: 200, width: 300, height: 40 });
  });

  test("grows the rect by the margin on all four sides", () => {
    expect(
      cropRect({ x: 100, y: 200, width: 300, height: 40 }, 24, IMAGE),
    ).toEqual({ x: 76, y: 176, width: 348, height: 88 });
  });

  test("clamps a margin that would run off the top-left corner", () => {
    expect(cropRect({ x: 4, y: 0, width: 50, height: 50 }, 24, IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 78,
      height: 74,
    });
  });

  test("clamps a margin that would run off the bottom-right corner", () => {
    expect(
      cropRect({ x: 1900, y: 1060, width: 20, height: 20 }, 24, IMAGE),
    ).toEqual({ x: 1876, y: 1036, width: 44, height: 44 });
  });

  // The margin a reader asks for when a 128x70 crop showed only that a chip
  // exists. It is allowed to swallow the image; what comes back is the whole
  // picture, not a refusal.
  test("clamps a margin wider than the image to the image", () => {
    expect(
      cropRect({ x: 900, y: 500, width: 100, height: 50 }, 4000, IMAGE),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  test("clamps a rect that itself overhangs the image", () => {
    expect(
      cropRect({ x: 1800, y: 1000, width: 400, height: 400 }, 0, IMAGE),
    ).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
  });

  // The whole image is a legitimate crop; the clamp must not shave it.
  test("keeps a full-image rect whole", () => {
    expect(
      cropRect({ x: 0, y: 0, width: 1920, height: 1080 }, 24, IMAGE),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  // Rounded outwards so the requested area is never cut, and so the clip handed
  // to the browser is whole pixels.
  test("rounds a fractional rect outwards", () => {
    expect(
      cropRect({ x: 10.4, y: 10.6, width: 5.2, height: 5.2 }, 0, IMAGE),
    ).toEqual({ x: 10, y: 10, width: 6, height: 6 });
  });

  test("declines a rect that lies entirely outside the image", () => {
    expect(
      cropRect({ x: 2400, y: 20, width: 40, height: 40 }, 24, IMAGE),
    ).toBeNull();
  });

  test("declines a rect that is not finite", () => {
    expect(
      cropRect({ x: 0, y: 0, width: Number.NaN, height: 40 }, 0, IMAGE),
    ).toBeNull();
  });

  test("declines a zero-area rect", () => {
    expect(
      cropRect({ x: 10, y: 10, width: 0, height: 40 }, 0, IMAGE),
    ).toBeNull();
  });
});

describe("cropFileName", () => {
  test("replaces the id's namespace colon", () => {
    expect(cropFileName("multi6:chip-overlap", 1)).toBe(
      "multi6-chip-overlap-1.png",
    );
  });

  test("numbers the evidence entries", () => {
    expect(cropFileName("multi6:chip-overlap", 3)).toBe(
      "multi6-chip-overlap-3.png",
    );
  });

  // An id is agent-authored text, and it names a file under --out-dir. A slug
  // carrying a separator must not be able to write outside that directory.
  test("neutralises path separators in the id", () => {
    expect(cropFileName("a/../b:c", 1)).toBe("a-..-b-c-1.png");
    expect(cropFileName("a\\b:c", 1)).toBe("a-b-c-1.png");
  });
});

// A run.json shaped like the workflow's return, cut down to the fields the join
// reads.
function run(): unknown {
  return {
    findings: [
      {
        id: "multi6:chip-overlap",
        planId: "multi6",
        evidence: [
          {
            image: "10-tile-r0c1.png",
            rect: [100, 200, 300, 40],
            where: "chip",
          },
          {
            image: "00-fit.png",
            rect: [10, 20, 30, 40],
            where: "same chip, fit",
          },
        ],
      },
      {
        id: "multi6:dropped-edge",
        planId: "multi6",
        evidence: [{ image: "00-fit.png", rect: [1, 2, 3, 4], where: "edge" }],
      },
      {
        id: "battery5:tap-column",
        planId: "battery5",
        evidence: [
          { image: "10-tile-r1c0.png", rect: [5, 6, 7, 8], where: "tap" },
        ],
      },
      {
        id: "battery5:subjective",
        planId: "battery5",
        evidence: [{ image: "00-fit.png", rect: [0, 0, 10, 10], where: "all" }],
      },
    ],
    verdicts: [
      {
        findingId: "multi6:chip-overlap",
        planId: "multi6",
        disposition: "FILE",
      },
      {
        findingId: "multi6:dropped-edge",
        planId: "multi6",
        disposition: "DROP",
      },
      {
        findingId: "battery5:tap-column",
        planId: "battery5",
        disposition: "FILE_SYMPTOM_ONLY",
      },
      {
        findingId: "battery5:subjective",
        planId: "battery5",
        disposition: "HUMAN_REVIEW",
      },
    ],
  };
}

const OPTS = { examDir: ".artifacts/exam", outDir: ".artifacts/exam/crops" };

function jobsOf(value: unknown) {
  const built = cropJobsFromRun(value, OPTS);
  if (typeof built === "string") throw new Error(built);
  return built;
}

describe("cropJobsFromRun", () => {
  test("crops only the filed dispositions", () => {
    const { jobs } = jobsOf(run());
    expect(jobs.map((j) => j.out)).toEqual([
      ".artifacts/exam/crops/multi6-chip-overlap-1.png",
      ".artifacts/exam/crops/multi6-chip-overlap-2.png",
      ".artifacts/exam/crops/battery5-tap-column-1.png",
    ]);
  });

  test("resolves the image under the finding's plan directory", () => {
    const { jobs } = jobsOf(run());
    expect(jobs[0]!.image).toBe(
      ".artifacts/exam/multi6/images/10-tile-r0c1.png",
    );
    expect(jobs[2]!.image).toBe(
      ".artifacts/exam/battery5/images/10-tile-r1c0.png",
    );
  });

  test("carries the evidence rect and the standing margin", () => {
    const { jobs } = jobsOf(run());
    expect(jobs[0]!.rect).toEqual({ x: 100, y: 200, width: 300, height: 40 });
    expect(jobs[0]!.margin).toBe(MARGIN_PX);
  });

  test("carries a caller's margin to every job", () => {
    const built = cropJobsFromRun(run(), { ...OPTS, margin: 400 });
    if (typeof built === "string") throw new Error(built);
    expect(built.jobs.map((j) => j.margin)).toEqual([400, 400, 400]);
  });

  test("skips a verdict whose finding is missing, and says so", () => {
    const value = run() as { verdicts: Array<{ findingId: string }> };
    value.verdicts[0]!.findingId = "multi6:not-a-finding";
    const { jobs, skipped } = jobsOf(value);
    expect(jobs).toHaveLength(1);
    expect(skipped.join(" ")).toContain("multi6:not-a-finding");
  });

  // The name has to keep pointing at the evidence entry it came from, so a
  // malformed entry burns its number rather than shifting the ones after it.
  test("skips a malformed evidence entry without renumbering the rest", () => {
    const value = run() as {
      findings: Array<{ evidence: Array<{ rect: unknown }> }>;
    };
    value.findings[0]!.evidence[0]!.rect = [100, 200, 300];
    const { jobs, skipped } = jobsOf(value);
    expect(jobs.map((j) => j.out)).toEqual([
      ".artifacts/exam/crops/multi6-chip-overlap-2.png",
      ".artifacts/exam/crops/battery5-tap-column-1.png",
    ]);
    expect(skipped.join(" ")).toContain("evidence[0]");
  });

  test("skips an evidence entry that names no image", () => {
    const value = run() as {
      findings: Array<{ evidence: Array<{ image?: unknown }> }>;
    };
    value.findings[2]!.evidence[0]!.image = "";
    const { jobs, skipped } = jobsOf(value);
    expect(jobs).toHaveLength(2);
    expect(skipped.join(" ")).toContain("battery5:tap-column");
  });

  test("reports a run file that carries no arrays", () => {
    expect(typeof cropJobsFromRun({ verdicts: [] }, OPTS)).toBe("string");
    expect(typeof cropJobsFromRun(null, OPTS)).toBe("string");
  });

  test("reads an empty verdict list as no work rather than an error", () => {
    const { jobs } = jobsOf({ findings: [], verdicts: [] });
    expect(jobs).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("reads one image, rect and output", () => {
    const parsed = parseArgs([
      "--image",
      "a.png",
      "--rect",
      "10,20,30,40",
      "--out",
      "b.png",
    ]);
    expect(parsed).toEqual({
      mode: "explicit",
      jobs: [
        {
          image: "a.png",
          rect: { x: 10, y: 20, width: 30, height: 40 },
          margin: 0,
          out: "b.png",
          label: "a.png",
        },
      ],
    });
  });

  test("reads a repeated triple", () => {
    const parsed = parseArgs([
      "--image",
      "a.png",
      "--rect",
      "0,0,10,10",
      "--out",
      "a-crop.png",
      "--image",
      "b.png",
      "--rect",
      "5,5,10,10",
      "--out",
      "b-crop.png",
    ]);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.mode).toBe("explicit");
    expect(parsed.mode === "explicit" && parsed.jobs).toHaveLength(2);
  });

  test("defaults the verdicts directories", () => {
    expect(parseArgs(["--verdicts", "run.json"])).toEqual({
      mode: "verdicts",
      verdicts: "run.json",
      examDir: DEFAULT_EXAM_DIR,
      outDir: DEFAULT_OUT_DIR,
      margin: MARGIN_PX,
    });
  });

  test("takes an exam directory and an output directory", () => {
    expect(
      parseArgs([
        "--verdicts",
        "run.json",
        "--exam-dir",
        "/tmp/exam",
        "--out-dir",
        "/tmp/crops",
      ]),
    ).toEqual({
      mode: "verdicts",
      verdicts: "run.json",
      examDir: "/tmp/exam",
      outDir: "/tmp/crops",
      margin: MARGIN_PX,
    });
  });

  test("rejects an incomplete triple", () => {
    expect(parseArgs(["--image", "a.png", "--rect", "0,0,10,10"])).toMatch(
      /--out/,
    );
    expect(parseArgs(["--rect", "0,0,10,10", "--out", "b.png"])).toMatch(
      /--image/,
    );
    expect(parseArgs(["--image", "a.png", "--out", "b.png"])).toMatch(/--rect/);
  });

  test("rejects a second --image before the first triple closes", () => {
    expect(parseArgs(["--image", "a.png", "--image", "b.png"])).toMatch(
      /--image/,
    );
  });

  // Number("") is 0 and finite, so "10,20,30," would otherwise parse as a
  // zero-height rect the caller never asked for.
  test("rejects a rect that is not four numbers", () => {
    expect(parseArgs(["--image", "a.png", "--rect", "10,20,30"])).toMatch(
      /--rect/,
    );
    expect(parseArgs(["--image", "a.png", "--rect", "10,20,30,"])).toMatch(
      /--rect/,
    );
    expect(parseArgs(["--image", "a.png", "--rect", "10,20,30,x"])).toMatch(
      /--rect/,
    );
  });

  test("rejects a rect with a negative extent", () => {
    expect(parseArgs(["--image", "a.png", "--rect", "10,20,-5,40"])).toMatch(
      /--rect/,
    );
  });

  test("rejects mixing the two modes", () => {
    expect(
      parseArgs([
        "--verdicts",
        "run.json",
        "--image",
        "a.png",
        "--rect",
        "0,0,1,1",
        "--out",
        "b.png",
      ]),
    ).toMatch(/--verdicts/);
  });

  test("rejects the exam directories outside verdicts mode", () => {
    expect(
      parseArgs([
        "--image",
        "a.png",
        "--rect",
        "0,0,1,1",
        "--out",
        "b.png",
        "--exam-dir",
        "/tmp/exam",
      ]),
    ).toMatch(/--exam-dir/);
  });

  test("rejects an empty argument list", () => {
    expect(parseArgs([])).toMatch(/--image|--verdicts/);
  });

  test("rejects an unknown argument", () => {
    expect(parseArgs(["--nope"])).toMatch(/--nope/);
  });

  test("rejects a flag with no value", () => {
    expect(parseArgs(["--image", "--rect", "0,0,1,1"])).toMatch(/--image/);
  });

  // A margin given alongside explicit triples applies to all of them, wherever
  // in the line it was written: it is a property of the run, not of the triple
  // it happens to follow.
  test("applies an explicit margin to every triple", () => {
    const parsed = parseArgs([
      "--image",
      "a.png",
      "--rect",
      "0,0,10,10",
      "--out",
      "a-crop.png",
      "--margin",
      "500",
      "--image",
      "b.png",
      "--rect",
      "5,5,10,10",
      "--out",
      "b-crop.png",
    ]);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.mode === "explicit" && parsed.jobs.map((j) => j.margin)).toEqual([
      500, 500,
    ]);
  });

  test("overrides the standing margin in verdicts mode", () => {
    expect(parseArgs(["--verdicts", "run.json", "--margin", "0"])).toEqual({
      mode: "verdicts",
      verdicts: "run.json",
      examDir: DEFAULT_EXAM_DIR,
      outDir: DEFAULT_OUT_DIR,
      margin: 0,
    });
    expect(parseArgs(["--verdicts", "run.json"])).toEqual({
      mode: "verdicts",
      verdicts: "run.json",
      examDir: DEFAULT_EXAM_DIR,
      outDir: DEFAULT_OUT_DIR,
      margin: MARGIN_PX,
    });
  });

  test("rejects a margin that is not a non-negative whole number", () => {
    for (const bad of ["-4", "4.5", "wide", ""]) {
      expect(parseArgs(["--verdicts", "run.json", "--margin", bad])).toMatch(
        /--margin/,
      );
    }
    expect(parseArgs(["--margin", "--verdicts", "run.json"])).toMatch(
      /--margin/,
    );
  });
});

// A skipped entry is a crop the caller asked for and did not get, which is the
// same hole in the evidence as a failed one. Reporting ok on it sent a reader
// looking for a file that was never written.
describe("cropRunOk", () => {
  test("is true only when nothing was skipped and nothing failed", () => {
    expect(cropRunOk({ skipped: [], failed: [] })).toBe(true);
    expect(cropRunOk({ skipped: [], failed: ["a.png: no overlap"] })).toBe(
      false,
    );
    expect(cropRunOk({ skipped: ["x: no evidence"], failed: [] })).toBe(false);
    expect(
      cropRunOk({ skipped: ["x: no evidence"], failed: ["a.png: no overlap"] }),
    ).toBe(false);
  });
});
