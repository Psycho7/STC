import { test, expect } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";
import { collectScene } from "./collect";

// collectScene runs in page context, so it can only be exercised through a real
// browser. This spec is the contract the capture CLI relies on: every rendered
// element kind is inventoried, every element carries a unique non-empty id, and
// both coordinate spaces are finite. battery5-xiranite is the densest scenario,
// the one plan that renders nodes, edges, chips and bus bands at once.

test.use({ viewport: { width: 1920, height: 1080 } });

test("collectScene inventories every element kind on a dense plan", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("aef.locale", "en");
  });
  const scenario = SCENARIOS.find((s) => s.id === "battery5-xiranite")!;
  const hash = await scenarioHash(scenario);
  await page.goto(`/#${hash}`, { waitUntil: "load" });
  await expect(
    page.locator(".react-flow").locator(".react-flow__node-recipe").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const scene = await page.evaluate(collectScene);

  const kinds = new Set(scene.elements.map((e) => e.kind));
  expect(kinds.has("node")).toBe(true);
  expect(kinds.has("edge")).toBe(true);
  expect(kinds.has("chip")).toBe(true);
  expect(kinds.has("band")).toBe(true);
  expect(scene.elements.every((e) => e.id !== "")).toBe(true);
  expect(new Set(scene.elements.map((e) => e.id)).size).toBe(
    scene.elements.length,
  );
  expect(scene.overlays.some((o) => o.name === "controls")).toBe(true);
  expect(scene.transform.zoom).toBeGreaterThan(0);
  for (const e of scene.elements) {
    expect(Number.isFinite(e.worldRect.x)).toBe(true);
    expect(Number.isFinite(e.clientRect.x)).toBe(true);
  }
});
