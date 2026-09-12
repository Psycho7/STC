import { type Page } from "@playwright/test";

import {
  BUS_LANES_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
} from "../../src/data/storage-keys";

// The camera settles in two steps on a cold load: the fit that runs once the
// nodes are measured, then a debounced re-fit from the canvas resize observer
// when the header reflows around it (webfont swap, status strip). Holding for
// longer than that debounce is what makes the read deterministic; two matching
// animation frames can fall inside the debounce window and read the stale fit.
const STABLE_WINDOW_MS = 250;

// Block until the viewport transform has held one value for STABLE_WINDOW_MS.
// Measuring mid-camera-move would read stale rects.
export async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(
    (windowMs) => {
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (vp === null) return false;
      const state = vp as unknown as {
        __auditPrevTransform?: string;
        __auditStableSince?: number;
      };
      const now = vp.style.transform;
      if (now === "" || state.__auditPrevTransform !== now) {
        state.__auditPrevTransform = now;
        state.__auditStableSince = performance.now();
        return false;
      }
      return performance.now() - (state.__auditStableSince ?? 0) >= windowMs;
    },
    STABLE_WINDOW_MS,
    { timeout: 10_000, polling: "raf" },
  );
}

// document.fonts.ready resolves as soon as no face is loading, which on a cold
// load is BEFORE the Google Fonts stylesheet has arrived and asked for any. A
// chip measured then carries fallback-face metrics and can differ by a pixel
// from the same chip under the webfont. So: wait for the stylesheet, then for
// every face it started loading. A blocked CDN never gets there, so the wait is
// bounded and the reading proceeds on the fallback faces the app designs for.
const WEBFONT_WAIT_MS = 8_000;

export async function waitForWebfonts(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const link = document.querySelector<HTMLLinkElement>(
          'link[rel="stylesheet"][href*="fonts.googleapis"]',
        );
        if (link !== null && link.sheet === null) return false;
        if (document.fonts.status !== "loaded") return false;
        let anyLoaded = false;
        for (const face of document.fonts) {
          if (face.status === "loading") return false;
          if (face.status === "loaded") anyLoaded = true;
        }
        return link === null || anyLoaded;
      },
      undefined,
      { timeout: WEBFONT_WAIT_MS, polling: "raf" },
    )
    .catch(() => undefined);
}

// The pipeline node kinds the render policy can emit. One of them on screen is
// the proof that a solve and a layout both completed, which is the readiness
// every spec and both exam CLIs gate on. One spelling, so a selector that
// drifts cannot leave some callers waiting for a node the app stopped drawing.
export const CANVAS_NODE_SELECTOR =
  ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product";

// One leash for every boot stage. A shorter one buys nothing: it only turns a
// slow machine into a red spec.
const BOOT_TIMEOUT_MS = 30_000;

export async function waitForCanvasReady(
  page: Page,
  timeoutMs: number = BOOT_TIMEOUT_MS,
): Promise<void> {
  await page
    .locator(".react-flow")
    .locator(CANVAS_NODE_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

// The locale the page boots in. Omitting it writes NO key, which leaves the app
// on its own default - the state the zh-asserting specs rely on.
export type BootLocale = "en" | "zh";
// The bus-lane preference. A missing key reads as off, so omitting it and
// passing "off" are the same render; the specs that want lanes say so.
export type BootLaneMode = "on" | "off";
// "nodes" is a laid-out graph; "ready" additionally waits for the READY
// annotation the exam CLIs judge a page examinable by.
export type BootReadiness = "nodes" | "ready";
// Which post-load waits run before the boot resolves. A spec that only clicks
// needs none; anything that MEASURES wants the webfonts in and the camera
// parked, because both move text and rects after the nodes appear.
export type BootSettle = "none" | "webfonts" | "viewport" | "both";

export type BootExamPageOptions = {
  // Exactly what page.goto takes: relative for a spec (resolved against the
  // config's baseURL), absolute for a CLI pointed at a deployed preview.
  url: string;
  locale?: BootLocale | undefined;
  busLanes?: BootLaneMode | undefined;
  readiness: BootReadiness;
  settle: BootSettle;
  nodeTimeoutMs?: number | undefined;
};

// `?exam=1` only installs window.__stcExam and changes nothing the app draws,
// so every boot carries it and no caller can be the one that forgot it before
// reaching for the hook. The query has to precede the fragment: the app reads
// the flag out of location.search, and anything after the "#" is fragment.
function withExamFlag(url: string): string {
  const hashAt = url.indexOf("#");
  const head = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  if (head.includes("exam=1")) return url;
  return `${head}${head.includes("?") ? "&" : "?"}exam=1${fragment}`;
}

// Seed the view preferences, open the page, and hold until it is as settled as
// the caller asked for. The page belongs to the caller: nothing here creates or
// closes a page or a context, so a per-spec viewport keeps working untouched.
//
// The storage keys travel as an ARGUMENT, never as captured module constants:
// page.addInitScript serialises the callback source and evaluates it in the
// page, so nothing from this module's scope reaches it and a captured import
// would be a fresh ReferenceError inside the browser rather than a compile
// error here. Passing them in is what makes a rename a compile error on both
// sides of the browser boundary.
//
// No expect() anywhere below, so this module stays importable from a CLI that
// is not running the Playwright test runner.
export async function bootExamPage(
  page: Page,
  opts: BootExamPageOptions,
): Promise<void> {
  const timeout = opts.nodeTimeoutMs ?? BOOT_TIMEOUT_MS;

  await page.addInitScript(
    (seed: {
      localeKey: string;
      locale?: string | undefined;
      busLanesKey: string;
      busLanes?: string | undefined;
    }) => {
      if (seed.locale !== undefined) {
        window.localStorage.setItem(seed.localeKey, seed.locale);
      }
      if (seed.busLanes !== undefined) {
        window.localStorage.setItem(seed.busLanesKey, seed.busLanes);
      }
    },
    {
      localeKey: LOCALE_STORAGE_KEY,
      locale: opts.locale,
      busLanesKey: BUS_LANES_STORAGE_KEY,
      busLanes: opts.busLanes,
    },
  );

  await page.goto(withExamFlag(opts.url), { waitUntil: "load" });

  await waitForCanvasReady(page, timeout);
  if (opts.readiness === "ready") {
    await page
      .locator(".canvas-annot.bottom-right", { hasText: "READY" })
      .waitFor({ state: "visible", timeout });
  }

  if (opts.settle === "webfonts" || opts.settle === "both") {
    await waitForWebfonts(page);
  }
  if (opts.settle === "viewport" || opts.settle === "both") {
    await waitForStableViewport(page);
  }
}

// The camera every seating census reads at; re-measure the tables if it moves.
export const CENSUS_ZOOM = 0.6;

// Load a scenario and park the camera at CENSUS_ZOOM about the pane centre.
export async function loadCensusScenario(
  page: Page,
  hash: string,
  seed: {
    locale?: BootLocale | undefined;
    busLanes?: BootLaneMode | undefined;
  } = {},
): Promise<void> {
  await bootExamPage(page, {
    url: `/#${hash}`,
    locale: seed.locale,
    busLanes: seed.busLanes,
    readiness: "nodes",
    settle: "both",
  });
  await page.waitForFunction(() => window.__stcExam !== undefined, undefined, {
    timeout: 10_000,
  });
  await page.evaluate((zoom) => {
    const hook = window.__stcExam!;
    const pane = document
      .querySelector<HTMLElement>(".react-flow")!
      .getBoundingClientRect();
    const vp = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    const worldCx = (pane.width / 2 - m.e) / m.a;
    const worldCy = (pane.height / 2 - m.f) / m.a;
    hook.setViewport({
      x: pane.width / 2 - worldCx * zoom,
      y: pane.height / 2 - worldCy * zoom,
      zoom,
    });
  }, CENSUS_ZOOM);
  await waitForStableViewport(page);
}
