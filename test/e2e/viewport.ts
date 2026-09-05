import type { Page } from "@playwright/test";

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
