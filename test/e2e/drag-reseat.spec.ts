// A node drop replays the routing passes over the live positions, so the plan
// that lands after a drag must read as a fresh layout: every chip standing on
// a horizontal run of its own new polyline, no chip over its own card's port
// furniture, and — the half the chip audits cannot see — no drawn segment
// through a foreign card or back through the dragged card's own body. A stale
// anchor shows as a chip off the run it was measured on; a stale routing hint
// shows as a segment through the card it was routed around, the drawn defect a
// leftward drag reports: the moved card lands on corridors its neighbours
// kept, and without the replay nothing re-routes them around it.
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
  auditOwnCardPierces,
  auditSegmentsVsCards,
  toRawEdges,
  type ChipRect,
  type NodeRect,
  type PortFurnitureRect,
} from "./geometry";
import { collectGeometry } from "./collect";

// The boundary supply card the first two drags move.
const BOUNDARY_NODE = "u:in:copper_ore";
// The third drag moves a genuinely mid-graph recipe card of the gas-web plan,
// with traffic on both sides: a left drag crosses the corridors its neighbours
// were routed through, which is the stale-stamp state the polyline audits
// exist to catch (the routing passes replayed at drag-stop re-route those
// edges; a stale plan leaves them through the card). The plan step asked for
// the default plan's mid-graph card; there a 120-unit left drag provably lands
// on no kept corridor at all -- the stale picture is segment-for-segment the
// replayed one, so the case would assert nothing on develop -- and the only
// default corridor a longer arm can reach (277+ units out) seats its fanout
// chips over their own source ports even on the replayed plan. gas-web's card
// bites at exactly 120 and replays fully clean, landing window included.
const MIDGRAPH_SCENARIO = "gas-web";
const MIDGRAPH_NODE = "u:class:q:2";

// Park the dragged card in the middle of the pane before reaching for it. The
// census camera centres the PLAN, which on a wide plan can leave this card
// under the side panel, and a pointer-down there lands on the panel instead of
// on the card: the drag then never starts. The zoom is unchanged, so every
// chip the audits read is the same chip at the same size.
async function centreOnDraggedCard(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    ([id, zoom]: [string, number]) => {
      const pane = document
        .querySelector<HTMLElement>(".react-flow")!
        .getBoundingClientRect();
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
      const card = document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
        .getBoundingClientRect();
      const worldCx = (card.x + card.width / 2 - pane.x - m.e) / m.a;
      const worldCy = (card.y + card.height / 2 - pane.y - m.f) / m.a;
      window.__stcExam!.setViewport({
        x: pane.width / 2 - worldCx * zoom,
        y: pane.height / 2 - worldCy * zoom,
        zoom,
      });
    },
    [nodeId, CENSUS_ZOOM] as [string, number],
  );
  await waitForStableViewport(page);
}
// Far enough that every leg off the card re-bends, short enough to stay clear
// of the card below it.
const DRAG_DY_GRAPH = 60;
// The sideways arm on the boundary card, well past the stale-stamp threshold:
// an input card is in the leftmost column, so dragging it further left re-bends
// every leg off it without walking into a neighbour. A drag on x alone leaves
// every port ROW where it was, which is the case the y-anchored staleness rules
// cannot see.
const DRAG_DX_GRAPH = -60;
// The mid-graph arm, the plan-prescribed 120: on gas-web it drops the dragged
// card straight onto three corridors its neighbours kept, and every landing
// the drag threshold allows (107 to 120, see DRAG_SLACK_PX below) stays inside
// that biting span.
const DRAG_DX_MIDGRAPH = -120;
// React Flow swallows the first few pointer pixels as its drag threshold, so
// the card lands a little short of the pointer travel.
const DRAG_SLACK_PX = 8;
// The drag advances in steps of at most this many screen pixels. The swallow
// above eats one WHOLE step (the move that engages the drag), so the step size
// bounds how short of the pointer travel the card lands, and has to stay well
// under DRAG_SLACK_PX.
const DRAG_STEP_PX = 4;
async function seatAudits(page: Page) {
  const geom = await page.evaluate(collectGeometry);
  const chips = geom.chips as ChipRect[];
  const rawEdges = toRawEdges(geom.edges);
  const nodes = geom.nodes as NodeRect[];
  return {
    chipCount: chips.length,
    portCover: auditChipPortCover(
      chips,
      rawEdges,
      geom.portFurniture as PortFurnitureRect[],
    ),
    offRule: auditChipsOnOwnPath(chips, rawEdges),
    foreignPierces: auditSegmentsVsCards(rawEdges, nodes),
    ownPierces: auditOwnCardPierces(rawEdges, nodes),
  };
}

const DRAGS = [
  {
    name: "downward",
    scenario: "default",
    node: BOUNDARY_NODE,
    dx: 0,
    dy: DRAG_DY_GRAPH,
  },
  {
    name: "sideways",
    scenario: "default",
    node: BOUNDARY_NODE,
    dx: DRAG_DX_GRAPH,
    dy: 0,
  },
  {
    name: "mid-graph sideways",
    scenario: MIDGRAPH_SCENARIO,
    node: MIDGRAPH_NODE,
    dx: DRAG_DX_MIDGRAPH,
    dy: 0,
  },
] as const;

test.describe("drag reroute", () => {
  for (const drag of DRAGS) {
    test(`chips re-seat and polylines clear the cards after a ${drag.name} node drag (${drag.scenario} plan)`, async ({
      page,
    }) => {
      const scenario = SCENARIOS.find((s) => s.id === drag.scenario)!;
      await loadCensusScenario(
        page,
        await scenarioHash(scenario),
        CENSUS_ZOOM,
        {
          locale: "en",
        },
      );

      await centreOnDraggedCard(page, drag.node);

      const before = await seatAudits(page);
      expect(before.portCover, "laid-out plan covers no port").toEqual([]);
      expect(
        before.offRule,
        "laid-out plan stands every chip on a horizontal run of its own line",
      ).toEqual([]);
      expect(
        before.foreignPierces,
        "laid-out plan runs no segment through a foreign card",
      ).toEqual([]);
      expect(
        before.ownPierces,
        "laid-out plan runs no segment through its own card",
      ).toEqual([]);

      // Drag the card by its top strip, in steps so React Flow sees a real
      // drag rather than a click. Screen px = graph units * zoom.
      const card = page.locator(`.react-flow__node[data-id="${drag.node}"]`);
      const box = (await card.boundingBox())!;
      const startX = box.x + box.width / 2;
      const startY = box.y + 8;
      const dxPx = drag.dx * CENSUS_ZOOM;
      const dyPx = drag.dy * CENSUS_ZOOM;
      const steps = Math.max(
        10,
        Math.ceil(Math.hypot(dxPx, dyPx) / DRAG_STEP_PX),
      );
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          startX + (dxPx * i) / steps,
          startY + (dyPx * i) / steps,
        );
      }
      await page.mouse.up();
      // Park the pointer on empty canvas: a pointer resting on the dropped
      // card keeps its incident edges hover-focused, and a focused chip shows
      // its full text even when seated collapsed, which the audit would read
      // as a port cover. The audit measures the idle render.
      const pane = (await page.locator(".react-flow").boundingBox())!;
      await page.mouse.move(
        pane.x + pane.width - 40,
        pane.y + pane.height - 40,
      );
      await waitForStableViewport(page);
      const moved = (await card.boundingBox())!;
      const travelled = Math.abs(moved.x - box.x) + Math.abs(moved.y - box.y);
      expect(travelled, "the card actually moved").toBeGreaterThan(
        Math.abs(dxPx) + Math.abs(dyPx) - DRAG_SLACK_PX,
      );

      const after = await seatAudits(page);
      expect(after.chipCount).toBe(before.chipCount);
      // SOFT, one drag's drop being the expensive part: every tier reports, so
      // a red chip tier never hides what the polyline tiers below it have to
      // say about the same plan (the geometry-audit spec's stated rule).
      expect
        .soft(after.portCover, "no chip covers a port after the drag")
        .toEqual([]);
      expect
        .soft(
          after.offRule,
          "every chip stands on a horizontal run of its own line after the drag",
        )
        .toEqual([]);
      expect
        .soft(
          after.foreignPierces,
          "no drawn segment enters a foreign card after the drag",
        )
        .toEqual([]);
      expect
        .soft(
          after.ownPierces,
          "no segment runs through its own card's body after the drag",
        )
        .toEqual([]);
    });
  }
});
