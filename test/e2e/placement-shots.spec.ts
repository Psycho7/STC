import { test, expect, type Page } from "@playwright/test";
import { waitForStableViewport, waitForWebfonts } from "./viewport";
import { MAX_HASH_PAYLOAD_LEN } from "../../src/data/plan";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Fixed viewport so the fit-view camera frames each graph identically across
// machines; the audit captured at 1920x1080.
test.use({ viewport: { width: 1920, height: 1080 } });

// The render pipeline emits one recipe/loop unit per machine plus product chips;
// waiting on the first such node gates the shot on a completed solve + layout.
async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 30_000 });
}

test.describe("placement screenshot harness", () => {
  test.beforeEach(async ({ page }) => {
    // Pin English before the app boots (the locale is read from localStorage in
    // the provider's initial state) so labels and text metrics stay stable.
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      // The audit corpus polices the bus machinery, so every spec opts the
      // toggle on explicitly; the app default (off since the bus-lanes flip)
      // is a product decision this suite does not re-test.
      window.localStorage.setItem("aef.busLanes", "on");
    });
  });

  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      // Payload is everything after "v1."; keep it under the loader's cap.
      expect(
        hash.length - "v1.".length,
        `${scenario.id} payload within hash cap`,
      ).toBeLessThanOrEqual(MAX_HASH_PAYLOAD_LEN);

      await page.goto(`/#${hash}`, { waitUntil: "load" });
      await waitForCanvasReady(page);

      // Let webfonts finish so text-driven layout settles before the shot, then
      // hold until the camera has stopped moving: the cold-load re-fit lands
      // about a debounce after the first fit, longer than the two matching
      // frames toHaveScreenshot waits for on its own.
      await waitForWebfonts(page);
      await waitForStableViewport(page);

      const canvas = page.locator(".react-flow");
      // Per-scenario pixel budget from the fixture data: exact match for the
      // sparse graphs, a bounded anti-aliasing allowance for the dense ones.
      // Exact geometry is gated separately by DOM-rect assertions, not pixels.
      await expect(canvas).toHaveScreenshot(`${scenario.id}.png`, {
        threshold: 0.25,
        maxDiffPixels: scenario.maxDiffPixels,
      });
    });
  }
});
