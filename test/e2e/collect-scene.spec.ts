import { test, expect } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";
import { collectScene } from "./collect";

// collectScene runs in page context, so it can only be exercised through a real
// browser. This spec is the contract the capture CLI relies on: every rendered
// element kind is inventoried, the counts match what the page actually renders,
// every element carries a stable non-fallback id, and both coordinate spaces are
// finite. battery5-xiranite is the densest scenario, the one plan that renders
// all seven element kinds at once.
//
// Counts are cross-checked against Playwright locators rather than against the
// collection itself, so a selector that drifts out from under collectScene makes
// this spec fail instead of silently shrinking the inventory.

test.use({ viewport: { width: 1920, height: 1080 } });

test("collectScene inventories every element kind on a dense plan", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("aef.locale", "en");
    // The audit corpus polices the bus machinery, so every spec opts the
    // toggle on explicitly; the app default (off since the bus-lanes flip)
    // is a product decision this suite does not re-test.
    window.localStorage.setItem("aef.busLanes", "on");
  });
  const scenario = SCENARIOS.find((s) => s.id === "battery5-xiranite")!;
  const hash = await scenarioHash(scenario);
  await page.goto(`/#${hash}`, { waitUntil: "load" });
  await expect(
    page.locator(".react-flow").locator(".react-flow__node-recipe").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const scene = await page.evaluate(collectScene);
  const countOf = (kind: string): number =>
    scene.elements.filter((e) => e.kind === kind).length;

  // All seven kinds render on this plan; none may go missing.
  for (const kind of [
    "node",
    "edge",
    "chip",
    "junction",
    "band",
    "glyph",
    "group",
  ]) {
    expect(countOf(kind), `no ${kind} elements collected`).toBeGreaterThan(0);
  }

  // Independent oracle: the same families counted through Playwright locators.
  expect(countOf("node")).toBe(await page.locator(".react-flow__node").count());
  expect(countOf("edge")).toBe(
    await page.locator(".react-flow__edge-path").count(),
  );
  expect(countOf("chip")).toBe(await page.locator(".flow-chip").count());
  expect(countOf("junction")).toBe(await page.locator(".bus-junction").count());
  expect(countOf("band")).toBe(await page.locator(".bus-band").count());
  expect(countOf("glyph")).toBe(await page.locator("[data-glyph]").count());
  expect(countOf("group")).toBe(
    await page.locator('.rf-group-box, [data-testid="loop-node"]').count(),
  );

  // Ids must come from the DOM hook each family emits, not from the positional
  // fallback: a fallback id means the hook stopped resolving.
  for (const e of scene.elements) {
    if (e.kind === "node") expect(e.id).not.toMatch(/^node-\d+$/);
    if (e.kind === "edge") expect(e.id).not.toMatch(/^edge-\d+$/);
    // Bands carry BusBands' own data-testid, which is lane-indexed.
    if (e.kind === "band") expect(e.id).toMatch(/^bus-band-/);
  }
  expect(new Set(scene.elements.map((e) => e.id)).size).toBe(
    scene.elements.length,
  );

  expect(scene.overlays.some((o) => o.name === "controls")).toBe(true);
  // Canvas sets no proOptions, so React Flow paints its attribution badge in the
  // bottom-right of the pane. Overlay rects are pane-relative, so the badge's
  // right edge lands on the pane width, not past it.
  const attribution = scene.overlays.find((o) => o.name === "attribution")!;
  expect(attribution).toBeDefined();
  expect(attribution.x).toBeGreaterThanOrEqual(0);
  expect(attribution.x + attribution.width).toBeLessThanOrEqual(
    scene.paneRect.width + 1,
  );

  expect(scene.transform.zoom).toBeGreaterThan(0);
  for (const e of scene.elements) {
    for (const v of [
      e.worldRect.x,
      e.worldRect.y,
      e.worldRect.width,
      e.worldRect.height,
      e.clientRect.x,
      e.clientRect.y,
      e.clientRect.width,
      e.clientRect.height,
    ]) {
      expect(Number.isFinite(v), `non-finite rect on ${e.kind} ${e.id}`).toBe(
        true,
      );
    }
  }
});
