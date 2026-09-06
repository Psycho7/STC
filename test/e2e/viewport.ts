import { expect, type Page } from "@playwright/test";

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

export async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 30_000 });
}

// The camera every seating census reads at; re-measure the tables if it moves.
export const CENSUS_ZOOM = 0.6;

// Load a scenario and park the camera at CENSUS_ZOOM about the pane centre.
export async function loadCensusScenario(
  page: Page,
  hash: string,
): Promise<void> {
  await page.goto(`/?exam=1#${hash}`, { waitUntil: "load" });
  await waitForCanvasReady(page);
  await waitForWebfonts(page);
  await waitForStableViewport(page);
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
