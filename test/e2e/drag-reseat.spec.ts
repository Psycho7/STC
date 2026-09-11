// App re-seats every chip when a node drag ends. Drag the default plan's ore
// input card down so its legs change shape: without the re-seat the stale
// dogleg offsets would park the chips off their lines.
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

const DRAGGED_NODE = "u:in:copper_ore";
// Far enough that every leg off the card re-bends, short enough to stay clear
// of the card below it.
const DRAG_DY_GRAPH = 60;
// React Flow swallows the first few pointer pixels as its drag threshold, so
// the card lands a little short of the pointer travel.
const DRAG_SLACK_PX = 8;
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
      dyPx - DRAG_SLACK_PX,
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
