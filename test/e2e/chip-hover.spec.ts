// A rate chip is a hover source for the edge it labels. The chip is drawn
// through a DOM portal, so only a real browser can show that pointing at its
// box lights the owning edge: React resolves the enter along the fiber tree,
// which no jsdom hit-test exercises and no static capture can show.
import { test, expect, type Page } from "@playwright/test";

import { SCENARIOS, scenarioHash } from "./scenarios";

test.use({ viewport: { width: 1920, height: 1080 } });

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await expect(page.locator(".flow-chip[data-edge-id]").first()).toBeVisible({
    timeout: 10_000,
  });
}

// The state the dim rules read: which edges carry `dimmed`, and whether the
// canvas is in a hover at all.
async function edgeState(
  page: Page,
  ids: string[],
): Promise<{
  edges: Record<string, boolean | null>;
  hoverActive: boolean;
  dimmedCount: number;
}> {
  return page.evaluate((wanted: string[]) => {
    const edges: Record<string, boolean | null> = {};
    for (const id of wanted) {
      const g = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
      edges[id] = g ? g.classList.contains("dimmed") : null;
    }
    const theme = document.querySelector(".ak-canvas-theme");
    return {
      edges,
      hoverActive: theme ? theme.classList.contains("hover-active") : false,
      dimmedCount: document.querySelectorAll(".react-flow__edge.dimmed").length,
    };
  }, ids);
}

// Empty graph background, clear of the targets panel, the HUD strip, the
// controls and the minimap.
async function panePoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const cand = [
      { x: 900, y: 900 },
      { x: 1500, y: 950 },
      { x: 960, y: 540 },
      { x: 1200, y: 300 },
      { x: 700, y: 200 },
    ];
    for (const p of cand) {
      const e = document.elementFromPoint(p.x, p.y);
      if (e && e.classList.contains("react-flow__pane")) return p;
    }
    throw new Error("no empty pane point on this plan");
  });
}

test("a rate chip lights the edge it labels", async ({ page }) => {
  const scenario = SCENARIOS.find((s) => s.id === "default")!;
  await page.goto(`/#${await scenarioHash(scenario)}`, { waitUntil: "load" });
  await waitForCanvasReady(page);

  // An item-edge chip whose box the pointer can actually reach. Its owner is a
  // plain edge on no trunk, so every other edge on the plan is unrelated to it
  // and must dim.
  const pick = await page.evaluate(() => {
    const chips = [
      ...document.querySelectorAll<HTMLElement>(".flow-chip[data-edge-id]"),
    ].filter((el) => (el.dataset.testid ?? "").startsWith("item-edge-label-"));
    for (const chip of chips) {
      const r = chip.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (document.elementFromPoint(cx, cy)?.closest(".flow-chip") !== chip)
        continue;
      const owner = chip.dataset.edgeId ?? "";
      const other = [...document.querySelectorAll(".react-flow__edge")]
        .map((g) => g.getAttribute("data-id") ?? "")
        .find((id) => id !== "" && id !== owner);
      if (!other) continue;
      return { testId: chip.dataset.testid ?? "", owner, other, cx, cy };
    }
    return null;
  });
  expect(
    pick,
    "a reachable item-edge rate chip on the default plan",
  ).not.toBeNull();

  // Park over empty pane first, so the assertions below cannot inherit an
  // earlier hover.
  const pane = await panePoint(page);
  await page.mouse.move(pane.x, pane.y);
  await page.waitForTimeout(400);
  let state = await edgeState(page, [pick!.owner, pick!.other]);
  expect(state.hoverActive).toBe(false);
  expect(state.dimmedCount).toBe(0);

  // Point at the chip box itself, not at any stroke.
  await page.mouse.move(pick!.cx, pick!.cy);
  await page.waitForTimeout(500);
  state = await edgeState(page, [pick!.owner, pick!.other]);
  expect(state.hoverActive).toBe(true);
  expect(state.edges[pick!.owner]).toBe(false);
  expect(state.edges[pick!.other]).toBe(true);

  // Off the chip and back onto the pane: the hover clears.
  await page.mouse.move(pane.x, pane.y);
  await page.waitForTimeout(500);
  state = await edgeState(page, [pick!.owner, pick!.other]);
  expect(state.hoverActive).toBe(false);
  expect(state.dimmedCount).toBe(0);
});
