// App re-seats every chip when a node drag ends. Drag the default plan's ore
// tap down until its leg is one straight run: without the re-seat the stale
// dogleg offset would park the chip well below the line.
import { test, expect, type Page } from "@playwright/test";
import {
  CENSUS_ZOOM,
  loadCensusScenario,
  waitForStableViewport,
} from "./viewport";
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
    await loadCensusScenario(page, await scenarioHash(scenario));

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
