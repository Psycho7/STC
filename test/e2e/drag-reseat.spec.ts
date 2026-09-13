// App re-seats every chip when a node drag ends. Drag the default plan's ore
// input card down so its legs change shape, then assert the placement rule
// again on the plan that landed: every chip standing on a horizontal run of
// its own new polyline, and no chip over its own card's port furniture. A
// stale anchor shows as a chip off the run it was measured on.
import { test, expect, type Page } from "@playwright/test";
import {
  CENSUS_ZOOM,
  loadCensusScenario,
  waitForStableViewport,
} from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";
import {
  auditChipPortCover,
  auditChipsOnOwnPath,
  toRawEdges,
  type ChipRect,
  type PortFurnitureRect,
} from "./geometry";
import { collectGeometry } from "./collect";

const DRAGGED_NODE = "u:in:copper_ore";

// Park the dragged card in the middle of the pane before reaching for it. The
// census camera centres the PLAN, which on a wide plan can leave this card
// under the side panel, and a pointer-down there lands on the panel instead of
// on the card: the drag then never starts. The zoom is unchanged, so every
// chip the audits read is the same chip at the same size.
async function centreOnDraggedCard(page: Page): Promise<void> {
  await page.evaluate(
    ([nodeId, zoom]: [string, number]) => {
      const pane = document
        .querySelector<HTMLElement>(".react-flow")!
        .getBoundingClientRect();
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
      const card = document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)!
        .getBoundingClientRect();
      const worldCx = (card.x + card.width / 2 - pane.x - m.e) / m.a;
      const worldCy = (card.y + card.height / 2 - pane.y - m.f) / m.a;
      window.__stcExam!.setViewport({
        x: pane.width / 2 - worldCx * zoom,
        y: pane.height / 2 - worldCy * zoom,
        zoom,
      });
    },
    [DRAGGED_NODE, CENSUS_ZOOM] as [string, number],
  );
  await waitForStableViewport(page);
}
// Far enough that every leg off the card re-bends, short enough to stay clear
// of the card below it.
const DRAG_DY_GRAPH = 60;
// The sideways arm, well past the stale-stamp threshold: an input card is in
// the leftmost column, so dragging it further left re-bends every leg off it
// without walking into a neighbour. A drag on x alone leaves every port ROW
// where it was, which is the case the y-anchored staleness rules cannot see.
const DRAG_DX_GRAPH = -60;
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
    offRule: auditChipsOnOwnPath(chips, rawEdges),
  };
}

const DRAGS = [
  { name: "downward", dx: 0, dy: DRAG_DY_GRAPH },
  { name: "sideways", dx: DRAG_DX_GRAPH, dy: 0 },
] as const;

for (const drag of DRAGS) {
  test(`chips re-seat after a ${drag.name} node drag`, async ({ page }) => {
    const scenario = SCENARIOS.find((s) => s.id === "default")!;
    await loadCensusScenario(page, await scenarioHash(scenario), {
      locale: "en",
    });

    await centreOnDraggedCard(page);

    const before = await seatAudits(page);
    expect(before.portCover, "laid-out plan covers no port").toEqual([]);
    expect(
      before.offRule,
      "laid-out plan stands every chip on a horizontal run of its own line",
    ).toEqual([]);

    // Drag the tap by its top strip, in steps so React Flow sees a real drag
    // rather than a click. Screen px = graph units * zoom.
    const card = page.locator(`.react-flow__node[data-id="${DRAGGED_NODE}"]`);
    const box = (await card.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + 8;
    const dxPx = drag.dx * CENSUS_ZOOM;
    const dyPx = drag.dy * CENSUS_ZOOM;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(startX + (dxPx * i) / 10, startY + (dyPx * i) / 10);
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
    const travelled = Math.abs(moved.x - box.x) + Math.abs(moved.y - box.y);
    expect(travelled, "the card actually moved").toBeGreaterThan(
      Math.abs(dxPx) + Math.abs(dyPx) - DRAG_SLACK_PX,
    );

    const after = await seatAudits(page);
    expect(after.chipCount).toBe(before.chipCount);
    expect(after.portCover, "no chip covers a port after the drag").toEqual([]);
    expect(
      after.offRule,
      "every chip stands on a horizontal run of its own line after the drag",
    ).toEqual([]);
  });
}
