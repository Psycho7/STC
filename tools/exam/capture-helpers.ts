// Pure helpers for the render-exam capture: the URL it opens, the name a
// corrective shot is written under, the camera assertion each shot is checked
// with, and the provenance validation the run gates on.
//
// Split out of capture.ts for the reason probe-analysis.ts is split out of
// probe.ts. These four are the whole of what the unit tests reach, so the
// boundary is the one the test file already draws, and importing them from here
// keeps a 7 ms test suite from loading Playwright and a browser driver to read
// four functions. Nothing in here touches a page, a file or a clock.

import { UNKNOWN_COMMIT } from "../build/commit-stamp";

// How far the achieved zoom may sit from the commanded one before the capture is
// called a failure, RELATIVE to the commanded zoom (floored at 1 so sub-1 zooms
// keep the absolute slack). The transform is assigned verbatim by d3-zoom, so
// this is not a tolerance for clamping - but the achieved value is read back out
// of getComputedStyle, which Chromium serialises to 6 significant digits, and
// that quantisation is the dominant term: at zoom 1.2345678 the read-back is
// 1.23457, already 2.2e-6 off. A future reader must not tighten this on the
// belief that the slack is float noise; scaling with the commanded value is what
// keeps a zoom above 1 from failing a capture that was in fact exact.
const ZOOM_EPS_RELATIVE = 1e-5;

// The query string must precede the fragment: the app reads `?exam=1` from
// window.location.search, and anything after the `#` is fragment, not query.
export function examUrl(baseUrl: string, hash: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const frag = hash.startsWith("#") ? hash.slice(1) : hash;
  return `${base}/?exam=1#${frag}`;
}

// Element ids come from the DOM and carry separators a path cannot; keep the
// mapping total and stable so two runs name the same file.
function slug(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "element" : cleaned.slice(0, 80);
}

// The file one corrective shot writes to. The slug alone is not enough: it is
// truncated, and ids that differ only past the cut collide - bus chip ids are
// "bus-edge-label-<edgeId>-drop" and "...-rise", so the two chips of one long
// edge id slug identically. Two records would then name one image and one of
// them would describe a picture that no longer exists. The index makes the name
// unique whatever the ids are, because no two corrective shots share one; the
// slug stays on for the reader.
export function correctiveFileName(index: number, id: string): string {
  return `20-corrective-${String(index).padStart(3, "0")}-${slug(id)}.png`;
}

// The commanded viewport is supposed to land verbatim: setViewport forwards to
// d3-zoom's zoom.transform, and the scale extent binds gestures and fitView, not
// that path. If it ever does not, nothing downstream notices on its own - tile
// rects and element rects are both derived from the ACHIEVED transform, so the
// coverage math stays self-consistent and still reports "complete" while the
// document swears the images are at the commanded zoom and the evaluator reads
// LOD tier off that number. There is no honest ledger to write for a clamped
// shot, so the run fails instead.
export function assertZoomAchieved(
  file: string,
  commanded: number,
  achieved: number,
): void {
  if (
    Math.abs(achieved - commanded) <=
    ZOOM_EPS_RELATIVE * Math.max(1, commanded)
  ) {
    return;
  }
  throw new Error(
    `${file}: commanded zoom ${commanded} but the viewport achieved ${achieved}; ` +
      `the camera was clamped or ignored, so no image can be labelled with the commanded zoom`,
  );
}

// What the page says it was built from. Both halves are required on a scene:
// an unattributed capture cannot be checked against the tip under exam or
// against the pack ledger afterwards, and by the time anyone notices the images
// are already on disk with nothing to tie them to.
export type Provenance = {
  commit: string;
  pack: { sourceCommit: string; gameVersion: string };
};

// Validate the pair read off the exam hook. Returns the provenance, or a
// message naming the one field that fails - which field it is, is the whole
// diagnosis, so a message that only said "pack" would send an operator looking
// through both halves. Split out from the capture so these cases are pinned
// without a browser.
//
// The parameter is looser than the hook's own type on purpose. Every build that
// installs the hook installs the provenance pair, but the page under exam may be
// a deployment old enough to predate it, and that case has to be detectable at
// runtime rather than assumed away by the type.
export function readProvenance(raw: {
  commit?: string | undefined;
  // Null as well as undefined: the hook builds this from the loaded pack, and a
  // page with nothing to report hands back a null rather than omitting the key.
  pack?: { sourceCommit: string; gameVersion: string } | null | undefined;
}): Provenance | string {
  const commit = raw.commit;
  const pack = raw.pack;
  if (typeof commit !== "string" || commit === "") {
    return "window.__stcExam.commit is missing";
  }
  // The stamp helper emits this literal when git could not answer at build
  // time. The field is present, so nothing downstream would complain, but it
  // attributes the scene to no build at all - which is exactly the outcome
  // reading provenance exists to prevent, so it is rejected like an absent one.
  if (commit === UNKNOWN_COMMIT) {
    return `window.__stcExam.commit is "${UNKNOWN_COMMIT}": the build could not name itself`;
  }
  // Null and undefined alike: an absent pack is one diagnosis, and letting the
  // null through would report a missing sourceCommit instead, sending an
  // operator to look inside an object that is not there.
  if (pack === undefined || pack === null) {
    return "window.__stcExam.pack is missing";
  }
  if (typeof pack.sourceCommit !== "string" || pack.sourceCommit === "") {
    return "window.__stcExam.pack.sourceCommit is missing";
  }
  if (typeof pack.gameVersion !== "string" || pack.gameVersion === "") {
    return "window.__stcExam.pack.gameVersion is missing";
  }
  return {
    commit,
    pack: { sourceCommit: pack.sourceCommit, gameVersion: pack.gameVersion },
  };
}
