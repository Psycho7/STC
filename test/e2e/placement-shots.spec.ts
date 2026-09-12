import { test, expect } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { MAX_HASH_PAYLOAD_LEN } from "../../src/data/plan";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Fixed viewport so the fit-view camera frames each graph identically across
// machines; the audit captured at 1920x1080.
test.use({ viewport: { width: 1920, height: 1080 } });

test.describe("placement screenshot harness", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      // Payload is everything after "v1."; keep it under the loader's cap.
      expect(
        hash.length - "v1.".length,
        `${scenario.id} payload within hash cap`,
      ).toBeLessThanOrEqual(MAX_HASH_PAYLOAD_LEN);

      // English so labels and their text metrics stay stable; lanes on because
      // the audit corpus polices the bus machinery, and the app default (off
      // since the bus-lanes flip) is a product decision this suite does not
      // re-test. Settled on both counts: the webfonts move text-driven layout,
      // and the cold-load re-fit lands about a debounce after the first fit,
      // longer than the two matching frames toHaveScreenshot waits for.
      await bootExamPage(page, {
        url: `/#${hash}`,
        locale: "en",
        busLanes: "on",
        readiness: "nodes",
        settle: "both",
      });

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
