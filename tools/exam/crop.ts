// Evidence cropper for the render-quality exam.
// Usage:
//   bun run tools/exam/crop.ts --image <png> --rect x,y,w,h --out <png> [...]
//                              [--margin <px>]
//   bun run tools/exam/crop.ts --verdicts <run.json>
//                              [--exam-dir .artifacts/exam]
//                              [--out-dir .artifacts/exam/crops]
//                              [--margin <px>]
//
// --margin is the context kept on all four sides of every rect in the run: 0 by
// default for explicit triples, MARGIN_PX for --verdicts, and whatever is passed
// in either mode. A crop cut to the rect alone shows that the marked thing
// exists; a few hundred pixels of margin show what it sits next to, which is
// what a claim about overlap or drift is actually ruled on.
//
// A finding is filed with a crop of the tile it was seen in, because a reader
// handed a 1920x1080 tile and a sentence has to hunt for the thing being
// complained about. Every exam so far re-derived the same recipe by hand, so it
// lives here instead.
//
// Why a browser does the cutting. This box has no ImageMagick and no PIL, and
// none may be added; Playwright's Chromium is already a project dependency and
// already decodes PNG. The image is laid out at its natural size in a page whose
// viewport is exactly that size, and the crop is a clip screenshot of it. The
// page is built with `setContent` over a data: URI rather than a `file://` load:
// Chromium wraps a directly navigated image in an image DOCUMENT that centres,
// scales and re-backgrounds it, so the pixels that come back are not the pixels
// that went in.
//
// Coordinate frame. A rect is in the IMAGE's own pixels. The capture CLI shoots
// every tile with `scale: "css"`, so image pixels are the pane's CSS pixels and
// an evidence rect from a finding, or an element rect quoted out of scene.json,
// needs no conversion. The page here renders at deviceScaleFactor 1 for the same
// reason: one image pixel in, one output pixel out.
//
// --verdicts reads the workflow's saved return and crops everything a person
// has to look at: the FILE and FILE_SYMPTOM_ONLY dispositions, the HUMAN_REVIEW
// verdicts a refuter could not settle, and the `humanRuling` findings that never
// reached a refuter, every evidence entry of each, with a standing margin so the
// crop shows the thing in its surroundings rather than a rect with no context.
// The rulings are cut BEFORE they are made: the 2026-09-03 exam ruled on sixteen
// subjective findings from prose alone because only the filed ones had crops. A
// DROP is not evidence and is not cut.
//
// Exit codes:
//   0  every requested crop was written
//   1  harness failure (bad flags, unreadable run file, browser error), or at
//      least one requested crop was not written - whether it failed in the
//      browser or was skipped before a job was ever built for it
//
// A malformed evidence entry is skipped and named in the report rather than
// failing the run: one unusable rect among twenty must not cost the other
// nineteen their crops. It still counts against the exit code and against `ok`,
// because a skip is a piece of evidence with no picture, which is the same hole
// in the record as a crop that failed.

import { chromium, type Browser } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Rect } from "./tiling";

// Context kept around every evidence rect in --verdicts mode when --margin says
// nothing. A 24 px cut shows that a chip exists, not what it overlaps: every
// exam recut its majors at 400-600 px by hand before ruling, and nobody opened
// the tight set. So the standing margin is the readable one, and an issue body
// that wants the tight cut asks for `--margin 24`.
export const MARGIN_PX = 400;
export const DEFAULT_EXAM_DIR = ".artifacts/exam";
export const DEFAULT_OUT_DIR = ".artifacts/exam/crops";

export type CropJob = {
  image: string;
  // The requested rect, before the margin and before any clamp: what the caller
  // asked for is reported alongside what was actually cut.
  rect: Rect;
  margin: number;
  out: string;
  // What this crop is of, for the report. The filename carries the finding id;
  // this carries the evidence entry's own words.
  label: string;
};

export type Options =
  | { mode: "explicit"; jobs: CropJob[] }
  | {
      mode: "verdicts";
      verdicts: string;
      examDir: string;
      outDir: string;
      margin: number;
    };

// ---------------------------------------------------------------------------
// PNG header
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The image's own dimensions, straight off the header: signature, then a chunk
// whose type must be IHDR and whose payload opens with two big-endian uint32s.
// Read here rather than in the page because the clamp is where a bad rect is
// caught, and a clamp that can be unit tested is worth more than one that can
// only be exercised through a browser.
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  );
  if (type !== "IHDR") return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// Rect and naming
// ---------------------------------------------------------------------------

// The rect actually handed to the browser: grown by the margin, clamped to the
// image, and snapped OUTWARDS to whole pixels so the requested area is never
// shaved and the clip is not a fractional box the screenshot would round on its
// own. An integer rect at zero margin therefore comes back unchanged, which is
// what makes "crop 300x40 and get a 300x40 PNG" checkable.
//
// Null when nothing survives: a rect off the side of the image, a zero-area
// rect, or a non-finite one. Returning a plausible box instead would hand the
// reader a picture of somewhere else.
export function cropRect(
  rect: Rect,
  margin: number,
  image: { width: number; height: number },
): Rect | null {
  const finite =
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height);
  if (!finite || rect.width <= 0 || rect.height <= 0) return null;
  const x0 = Math.max(0, Math.floor(rect.x - margin));
  const y0 = Math.max(0, Math.floor(rect.y - margin));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width + margin));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height + margin));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// `<findingId>-<n>.png`, with the id's namespace colon flattened. Finding ids
// are agent-authored (`<planId>:<slug>`) and this one names a file under
// --out-dir, so every character outside the safe set goes the same way as the
// colon: a slug carrying a separator must not be able to write outside that
// directory. `n` is the evidence entry's 1-based position in the finding.
export function cropFileName(findingId: string, index: number): string {
  return `${findingId.replace(/[^A-Za-z0-9._-]/g, "-")}-${index}.png`;
}

// ---------------------------------------------------------------------------
// The verdicts join
// ---------------------------------------------------------------------------

// The dispositions a person acts on, and so the ones that need a picture: the
// two that get filed and the one that awaits a ruling.
const CUT = new Set(["FILE", "FILE_SYMPTOM_ONLY", "HUMAN_REVIEW"]);

type LooseEvidence = { image?: unknown; rect?: unknown; where?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A rect only when all four numbers are there and finite. The workflow already
// validates findings, but this CLI is also pointed at hand-edited run files.
function rectFromTuple(tuple: unknown): Rect | null {
  if (!Array.isArray(tuple) || tuple.length !== 4) return null;
  const [x, y, width, height] = tuple as unknown[];
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n)))
    return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
  };
}

// Joins the saved verdicts to the findings they judged and produces one job per
// evidence entry of everything the exam decided to file.
//
// Returns a string when the run file is not shaped like a workflow return at
// all, because that is a mistake about which file was passed and there is no
// partial answer worth printing. Everything smaller - a verdict naming no
// finding, an entry with an unreadable rect - comes back in `skipped`, so the
// caller sees exactly which evidence has no crop.
export function cropJobsFromRun(
  run: unknown,
  opts: { examDir: string; outDir: string; margin?: number },
): { jobs: CropJob[]; skipped: string[] } | string {
  const margin = opts.margin ?? MARGIN_PX;
  if (!isRecord(run)) return "error: the run file is not a JSON object";
  const findings: unknown = run.findings;
  const verdicts: unknown = run.verdicts;
  if (!Array.isArray(findings)) {
    return "error: the run file carries no findings array";
  }
  if (!Array.isArray(verdicts)) {
    return "error: the run file carries no verdicts array";
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const finding of findings as unknown[]) {
    if (!isRecord(finding)) continue;
    const id = finding.id;
    if (typeof id === "string" && id !== "") byId.set(id, finding);
  }

  const jobs: CropJob[] = [];
  const skipped: string[] = [];

  // One job per evidence entry of one finding. Shared by the verdict pass and
  // the humanRuling pass below, so a ruling's crop sits in the same series and
  // is named the same way as a filed one.
  const cutFinding = (findingId: string, finding: Record<string, unknown>) => {
    // The finding's own planId, not the verdict's: the evidence images belong to
    // the finding, and the two carry the same value in every workflow return.
    const planId = finding.planId;
    if (typeof planId !== "string" || planId === "") {
      skipped.push(`${findingId}: the finding names no planId`);
      return;
    }
    const evidence: unknown = finding.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      skipped.push(`${findingId}: the finding carries no evidence`);
      return;
    }
    evidence.forEach((raw: unknown, i: number) => {
      // Numbered by POSITION, so a skipped entry burns its number instead of
      // shifting the ones after it: a crop's name has to keep pointing at the
      // evidence entry it was made from.
      const n = i + 1;
      const entry: LooseEvidence = isRecord(raw) ? raw : {};
      const image = entry.image;
      if (typeof image !== "string" || image === "") {
        skipped.push(`${findingId}: evidence[${i}] names no image`);
        return;
      }
      const rect = rectFromTuple(entry.rect);
      if (rect === null) {
        skipped.push(
          `${findingId}: evidence[${i}] rect is not a finite [x, y, width, height] with a positive extent`,
        );
        return;
      }
      const where = typeof entry.where === "string" ? entry.where : "";
      jobs.push({
        image: path.join(opts.examDir, planId, "images", image),
        rect,
        margin,
        out: path.join(opts.outDir, cropFileName(findingId, n)),
        label:
          where === ""
            ? `${findingId} evidence[${i}]`
            : `${findingId}: ${where}`,
      });
    });
  };

  for (const verdict of verdicts as unknown[]) {
    if (!isRecord(verdict)) {
      skipped.push("a verdict entry is not an object");
      continue;
    }
    const findingId = verdict.findingId;
    if (typeof findingId !== "string" || findingId === "") {
      skipped.push("a verdict entry names no findingId");
      continue;
    }
    if (
      typeof verdict.disposition !== "string" ||
      !CUT.has(verdict.disposition)
    ) {
      continue;
    }
    const finding = byId.get(findingId);
    if (finding === undefined) {
      skipped.push(`${findingId}: no finding with that id is in the run file`);
      continue;
    }
    cutFinding(findingId, finding);
  }

  // Subjective findings never reach a refuter, so they have no verdict row and
  // live only in `humanRuling`, as whole findings. A run file without the array
  // (an older return, or a hand-cut one) simply has none to cut.
  const rulings: unknown = run.humanRuling;
  if (Array.isArray(rulings)) {
    for (const ruling of rulings as unknown[]) {
      if (!isRecord(ruling)) {
        skipped.push("a humanRuling entry is not an object");
        continue;
      }
      const id = ruling.id;
      if (typeof id !== "string" || id === "") {
        skipped.push("a humanRuling entry names no id");
        continue;
      }
      cutFinding(id, ruling);
    }
  }
  return { jobs, skipped };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseRect(spec: string): Rect | null {
  const parts = spec.split(",");
  // Each part must be a number that was actually written. Number("") is 0 and
  // finite, so "10,20,30," would otherwise parse as a zero-height rect the
  // caller never asked for.
  if (parts.length !== 4) return null;
  if (parts.some((p) => p.trim() === "" || !Number.isFinite(Number(p))))
    return null;
  const [x, y, width, height] = parts.map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function parseArgs(argv: string[]): Options | string {
  const jobs: CropJob[] = [];
  let image: string | null = null;
  let rect: Rect | null = null;
  let verdicts: string | null = null;
  let examDir: string | null = null;
  let outDir: string | null = null;
  let margin: number | null = null;

  const value = (i: number): string | null => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = value(i);
    switch (a) {
      case "--image":
        if (v === null) return "error: --image requires a file path";
        if (image !== null)
          return "error: each --image needs its own --rect and --out before the next one";
        image = argv[++i]!;
        break;
      case "--rect": {
        if (v === null) return 'error: --rect requires "x,y,w,h"';
        const parsed = parseRect(argv[++i]!);
        if (parsed === null)
          return `error: --rect must be "x,y,w,h" with a positive width and height, got "${v}"`;
        if (rect !== null)
          return "error: each --rect needs its own --out before the next one";
        rect = parsed;
        break;
      }
      case "--out": {
        if (v === null) return "error: --out requires a file path";
        const out = argv[++i]!;
        if (image === null) return "error: --out with no --image before it";
        if (rect === null) return "error: --out with no --rect before it";
        // Explicit crops take no margin unless --margin asks for one: the
        // caller asked for a rect and gets exactly that rect, which is what
        // makes the size checkable. The margin is applied below, once, so it
        // reaches triples written before the flag as well as after it.
        jobs.push({ image, rect, margin: 0, out, label: image });
        image = null;
        rect = null;
        break;
      }
      case "--verdicts":
        if (v === null) return "error: --verdicts requires a file path";
        verdicts = argv[++i]!;
        break;
      case "--exam-dir":
        if (v === null) return "error: --exam-dir requires a directory";
        examDir = argv[++i]!;
        break;
      case "--out-dir":
        if (v === null) return "error: --out-dir requires a directory";
        outDir = argv[++i]!;
        break;
      case "--margin": {
        if (v === null) return "error: --margin requires a pixel count";
        const raw = argv[++i]!;
        // Whole pixels only, and zero is a legitimate ask: a fractional margin
        // would be snapped outwards by the clamp anyway, so accepting one would
        // silently hand back a rect nobody asked for. The blank is checked
        // first because Number("") is 0, and an empty value is a mistake about
        // the command line rather than a request for no margin.
        const px = raw.trim() === "" ? Number.NaN : Number(raw);
        if (!Number.isInteger(px) || px < 0)
          return `error: --margin must be a whole number of pixels, zero or more, got "${v}"`;
        margin = px;
        break;
      }
      default:
        return `error: unknown argument "${a}"`;
    }
  }

  if (image !== null && rect === null) return "error: --image with no --rect";
  if (image !== null) return "error: --image and --rect with no --out";
  if (rect !== null) return "error: --rect with no --image before it";

  if (verdicts !== null) {
    if (jobs.length > 0)
      return "error: --verdicts crops a whole run; it takes no --image";
    return {
      mode: "verdicts",
      verdicts,
      examDir: examDir ?? DEFAULT_EXAM_DIR,
      outDir: outDir ?? DEFAULT_OUT_DIR,
      margin: margin ?? MARGIN_PX,
    };
  }
  if (examDir !== null)
    return "error: --exam-dir is only meaningful with --verdicts";
  if (outDir !== null)
    return "error: --out-dir is only meaningful with --verdicts";
  if (jobs.length === 0)
    return "error: nothing to crop; pass --image/--rect/--out or --verdicts";
  return {
    mode: "explicit",
    jobs: margin === null ? jobs : jobs.map((job) => ({ ...job, margin })),
  };
}

// ---------------------------------------------------------------------------
// Cropping
// ---------------------------------------------------------------------------

export type CropReport = {
  out: string;
  image: string;
  label: string;
  // What was cut, after the margin and the clamp, in image pixels.
  rect: Rect;
  width: number;
  height: number;
};

// How long the page is given to decode the image. Local bytes into an already
// launched browser; anything past this is a hang, not a slow decode.
const DECODE_TIMEOUT_MS = 15_000;

async function crop(browser: Browser, job: CropJob): Promise<CropReport> {
  const bytes = await readFile(job.image);
  const size = pngSize(bytes);
  if (size === null) {
    throw new Error(`${job.image} is not a PNG this tool can read`);
  }
  const rect = cropRect(job.rect, job.margin, size);
  if (rect === null) {
    throw new Error(
      `${job.image}: the rect ${JSON.stringify(job.rect)} does not overlap the ` +
        `${size.width}x${size.height} image`,
    );
  }

  // Viewport exactly the image, scale factor 1: the clip rect, the image's
  // pixels and the output's pixels are then all the same units.
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });
  try {
    const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:#000}` +
        `img{display:block;width:${size.width}px;height:${size.height}px}</style>` +
        `<img alt="" src="${dataUri}">`,
    );
    // `complete` alone is true for a broken image, so the decoded width is what
    // is waited on: a screenshot of a page whose image never arrived is a
    // picture of the backdrop, and it would be written without complaint.
    await page.waitForFunction(
      () => {
        const img = document.querySelector("img");
        return img !== null && img.complete && img.naturalWidth > 0;
      },
      undefined,
      { timeout: DECODE_TIMEOUT_MS },
    );
    await mkdir(path.dirname(path.resolve(job.out)), { recursive: true });
    await page.screenshot({ path: job.out, clip: rect, scale: "css" });
  } finally {
    await page.close();
  }

  return {
    out: job.out,
    image: job.image,
    label: job.label,
    rect,
    width: rect.width,
    height: rect.height,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function jobsFor(
  opts: Options,
): Promise<{ jobs: CropJob[]; skipped: string[] }> {
  if (opts.mode === "explicit") return { jobs: opts.jobs, skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(opts.verdicts, "utf8"));
  } catch (err: unknown) {
    throw new Error(
      `cannot read ${opts.verdicts}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const built = cropJobsFromRun(parsed, {
    examDir: opts.examDir,
    outDir: opts.outDir,
    margin: opts.margin,
  });
  if (typeof built === "string") throw new Error(built);
  return built;
}

// Whether the run delivered everything that was asked of it. A skip counts
// against it exactly as a failure does: both leave a piece of evidence with no
// picture, and the caller that reads `ok` is deciding whether to go looking for
// files on disk.
export function cropRunOk(result: {
  skipped: string[];
  failed: string[];
}): boolean {
  return result.failed.length === 0 && result.skipped.length === 0;
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(1);
  }

  let work: { jobs: CropJob[]; skipped: string[] };
  try {
    work = await jobsFor(parsed);
  } catch (err: unknown) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const crops: CropReport[] = [];
  const failed: string[] = [];
  const browser = await chromium.launch();
  try {
    for (const job of work.jobs) {
      try {
        crops.push(await crop(browser, job));
      } catch (err: unknown) {
        // Named and carried on. One unusable rect among twenty must not cost the
        // other nineteen their crops, and the reader has to be told which piece
        // of evidence has no picture.
        failed.push(
          `${job.out}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  const ok = cropRunOk({ skipped: work.skipped, failed });
  console.log(
    JSON.stringify({ ok, crops, skipped: work.skipped, failed }, null, 2),
  );
  process.exit(ok ? 0 : 1);
}
