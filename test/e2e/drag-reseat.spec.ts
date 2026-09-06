// A node drag keeps the live edge paths but not the layout-time seating
// stamps, so a dragged plan used to draw its chips at "live anchor plus a stale
// offset" (off their lines, over ports). App re-seats every chip when a drag
// ends. This spec drags the default plan's ore tap for the single refinery
// down until its port is level with the ore row: the leg turns from a dogleg
// into one straight run, the live anchor moves onto that run, and the stale
// slide offset the dogleg seat carried (34.5 units down the vertical run)
// would park the chip well below the line. With the re-seat the audits read
// as they do on the laid-out plan.
import { test, expect, type Page } from "@playwright/test";
import { waitForStableViewport, waitForWebfonts } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";
import {
  auditChipPortCover,
  auditChipSeatValidity,
  toRawEdges,
  type ChipRect,
  type PortFurnitureRect,
} from "./geometry";
import { collectGeometry } from "./collect";

const DRAGGED_NODE = "u:in:copper_ore:tap:u:class:q:3";
// The ore tap sits 69 graph units above the refinery row it feeds.
const DRAG_DY_GRAPH = 69;
const CENSUS_ZOOM = 0.6;

async function loadAtCensusZoom(page: Page, hash: string): Promise<void> {
  await page.goto(`/?exam=1#${hash}`, { waitUntil: "load" });
  await expect(
    page.locator(".react-flow .react-flow__node-recipe").first(),
  ).toBeVisible({ timeout: 30_000 });
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

async function seatAudits(page: Page) {
  const geom = await page.evaluate(collectGeometry);
  const chips = geom.chips as ChipRect[];
  const rawEdges = toRawEdges(geom.edges);
  return {
    chipCount: chips.length,
    portCover: auditChipPortCover(
      chips,
      rawEdges,
      geom.portFurniture as PortFurnitureRect[],
    ),
    invalid: auditChipSeatValidity(chips, geom.edges),
  };
}

for (const mode of ["on", "off"] as const) {
  test(`chips re-seat after a node drag (lanes ${mode})`, async ({ page }) => {
    await page.addInitScript((busLanes: string) => {
      window.localStorage.setItem("aef.locale", "en");
      window.localStorage.setItem("aef.busLanes", busLanes);
    }, mode);
    const scenario = SCENARIOS.find((s) => s.id === "default")!;
    await loadAtCensusZoom(page, await scenarioHash(scenario));

    const before = await seatAudits(page);
    expect(before.portCover, "laid-out plan covers no port").toEqual([]);
    expect(
      before.invalid,
      "laid-out plan seats every chip on its line",
    ).toEqual([]);

    // Drag the tap by its top strip, straight down, in steps so React Flow
    // sees a real drag rather than a click. Screen px = graph units * zoom.
    const card = page.locator(`.react-flow__node[data-id="${DRAGGED_NODE}"]`);
    const box = (await card.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + 8;
    const dyPx = DRAG_DY_GRAPH * CENSUS_ZOOM;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(startX, startY + (dyPx * i) / 10);
    }
    await page.mouse.up();
    // Park the pointer on empty canvas: a pointer resting on the dropped card
    // keeps its incident edges hover-focused, and a focused chip shows its
    // full text even when seated collapsed, which the audit would read as a
    // port cover. The audit measures the idle render.
    const pane = (await page.locator(".react-flow").boundingBox())!;
    await page.mouse.move(pane.x + pane.width - 40, pane.y + pane.height - 40);
    await waitForStableViewport(page);
    const moved = (await card.boundingBox())!;
    expect(moved.y - box.y, "the card actually moved").toBeGreaterThan(
      dyPx - 4,
    );

    const after = await seatAudits(page);
    expect(after.chipCount).toBe(before.chipCount);
    expect(after.portCover, "no chip covers a port after the drag").toEqual([]);
    expect(
      after.invalid,
      "every chip sits on its own line after the drag",
    ).toEqual([]);
  });
}
