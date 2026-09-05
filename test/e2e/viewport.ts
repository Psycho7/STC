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
