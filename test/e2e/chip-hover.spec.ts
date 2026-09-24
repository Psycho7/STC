// A rate chip is a hover source for the edge it labels. The chip is drawn
// through a DOM portal, so only a real browser can show that pointing at its
// box lights the owning edge: React resolves the enter along the fiber tree,
// which no jsdom hit-test exercises and no static capture can show.
//
// The second spec is the other half of that: which SEGMENT of a trunk member
// the pointer lands on decides the set, and only a browser hit-tests the
// transparent stretch path against the stroke and the chips stacked on it.
import { test, expect, type Page } from "@playwright/test";

import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

test.use({ viewport: { width: 1920, height: 1080 } });

// The chips are the hover sources this spec points at, so the boot is not done
// until one of them is on screen: they are portalled in a pass after the nodes.
async function waitForChips(page: Page): Promise<void> {
  await expect(page.locator(".flow-chip[data-edge-id]").first()).toBeVisible({
    timeout: 30_000,
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

// Empty graph background, clear of the targets panel, the HUD strip and the
// controls.
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
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    readiness: "nodes",
    settle: "both",
  });
  await waitForChips(page);

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

test("a trunk's shared stretch lights the trunk, its branch chip one edge", async ({
  page,
}) => {
  const scenario = SCENARIOS.find((s) => s.id === "default")!;
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    readiness: "nodes",
    settle: "both",
  });
  await waitForChips(page);

  // A shared stretch the pointer can actually reach, with the trunk it belongs
  // to and every member drawing that same stretch. The group key is read off
  // the owning edge's id rather than parsed out of the testid, which carries
  // separators of its own.
  const pick = await page.evaluate(() => {
    const paths = [
      ...document.querySelectorAll<SVGPathElement>(
        '[data-testid^="edge-shared-"]',
      ),
    ];
    const groupOf = (
      path: SVGPathElement,
    ): { edgeId: string; group: string } => {
      const edgeId =
        path.closest(".react-flow__edge")?.getAttribute("data-id") ?? "";
      const testId = path.dataset.testid ?? "";
      return {
        edgeId,
        group: testId.slice(`edge-shared-${edgeId}-`.length),
      };
    };
    // A point ON the stretch that nothing is stacked over: the aggregate chip
    // and the junction dot both stand on this run, so its mid-point is often
    // taken. The run is horizontal, so walking its box across is enough.
    const reachable = (
      path: SVGPathElement,
    ): { x: number; y: number } | null => {
      const r = path.getBoundingClientRect();
      const y = r.top + r.height / 2;
      for (let i = 1; i < 10; i += 1) {
        const x = r.left + (r.width * i) / 10;
        if (document.elementFromPoint(x, y) === path) return { x, y };
      }
      return null;
    };
    for (const path of paths) {
      const { edgeId, group } = groupOf(path);
      if (edgeId === "" || group === "") continue;
      const siblings = paths
        .map(groupOf)
        .filter((g) => g.group === group)
        .map((g) => g.edgeId);
      if (siblings.length < 2) continue;
      // The trunk has to state a total somewhere for the chip exemption below
      // to have a subject. A few trunks draw none (every near member dual, or
      // none near at all); those are not the case under test here.
      const drawsTotal = siblings.some(
        (id) =>
          document.querySelector(
            `.flow-chip[data-edge-id="${id}"][data-testid$="-drop"]`,
          ) !== null,
      );
      if (!drawsTotal) continue;
      const at = reachable(path);
      if (at === null) continue;
      return { edgeId, siblings, cx: at.x, cy: at.y };
    }
    return null;
  });
  expect(
    pick,
    "a reachable shared stretch of a multi-member trunk on the default plan",
  ).not.toBeNull();
  const siblings = pick!.siblings;

  const pane = await panePoint(page);
  await page.mouse.move(pane.x, pane.y);
  await page.waitForTimeout(400);

  // On the shared stretch: every member of that trunk stays lit.
  await page.mouse.move(pick!.cx, pick!.cy);
  await page.waitForTimeout(500);
  let state = await edgeState(page, siblings);
  expect(state.hoverActive).toBe(true);
  for (const id of siblings) {
    expect(state.edges[id], id).toBe(false);
  }

  // A member chip of this trunk the pointer can reach: it states ONE member's
  // rate, so it is a branch hover whichever member draws it. The aggregate chip
  // is excluded -- that one reports the trunk.
  const branch = await page.evaluate((ids: string[]) => {
    for (const edgeId of ids) {
      const chips = [
        ...document.querySelectorAll<HTMLElement>(
          `.flow-chip[data-edge-id="${edgeId}"]`,
        ),
      ].filter((el) => !(el.dataset.testid ?? "").endsWith("-drop"));
      for (const chip of chips) {
        const r = chip.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (document.elementFromPoint(cx, cy)?.closest(".flow-chip") !== chip) {
          continue;
        }
        return { edgeId, cx, cy };
      }
    }
    return null;
  }, siblings);
  expect(branch, "a reachable member chip on this trunk").not.toBeNull();

  await page.mouse.move(branch!.cx, branch!.cy);
  await page.waitForTimeout(500);
  state = await edgeState(page, siblings);
  expect(state.hoverActive).toBe(true);
  expect(state.edges[branch!.edgeId]).toBe(false);
  for (const id of siblings.filter((s) => s !== branch!.edgeId)) {
    expect(state.edges[id], id).toBe(true);
  }
  // The trunk's aggregate chip is exempt from that dim.
  const dropDimmed = await page.evaluate((ids: string[]) => {
    for (const id of ids) {
      const chip = document.querySelector<HTMLElement>(
        `.flow-chip[data-edge-id="${id}"][data-testid$="-drop"]`,
      );
      if (chip !== null) return chip.classList.contains("dimmed");
    }
    return null;
  }, siblings);
  expect(dropDimmed).toBe(false);
});
