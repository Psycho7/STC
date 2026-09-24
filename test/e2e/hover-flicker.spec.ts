// A lit edge's emphasis must not eat its own hit target. The hover rule
// thickens the lit ink, and the invisible hit paths (React Flow's interaction
// path, the shared-stretch paths) carry stroke-width 20 precisely so a pointer
// a few pixels off the centreline still counts as "on the edge". If the
// emphasis also restyles those hit paths, a pointer parked just off the
// centreline loops leave -> clearHover -> regrow -> re-enter, roughly one
// cycle per 200 ms. A MutationObserver on the theme root's class attribute is
// the only vantage that sees every cycle of that loop.
import { expect, test, type Page } from "@playwright/test";

import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

test.use({ viewport: { width: 1920, height: 1080 } });

const scenario = SCENARIOS.find((s) => s.id === "default")!;

// The probe measured the flicker band at 2-5 px off the centreline; 3 px sits
// mid-band, outside every possible shrunk half-width (the lit stroke is at
// most 4.8 px) and well inside the 20 px hit band that must be left alone.
const OFFSET_PX = 3;
// One flicker cycle is ~200 ms, so two seconds of parking collect ~10 toggles
// from a live flicker and exactly one (the enter) from a stable hover.
const PARK_MS = 2000;
// Window corner, far from every edge and chip, where the hover is off.
const REST_POINT = { x: 5, y: 5 };

type ParkTarget = {
  edgeId: string;
  midX: number;
  midY: number;
  offX: number;
  offY: number;
};

// Count hover-active toggles on the theme root from here on. The counter
// lives on window because the observer callback runs in the page.
async function installToggleCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector(".ak-canvas-theme");
    if (root === null) throw new Error("no .ak-canvas-theme on the page");
    const w = window as { __hoverToggles?: number };
    w.__hoverToggles = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== root) continue;
        const on = root.classList.contains("hover-active");
        const prev = (record.oldValue ?? "")
          .split(" ")
          .includes("hover-active");
        if (on !== prev) w.__hoverToggles = (w.__hoverToggles ?? 0) + 1;
      }
    }).observe(root, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
  });
}

// A park point 3 px off the mid-point of the first hit path whose offset
// point actually falls inside its own edge group: nothing is stacked over it,
// so the edge (not a card or a chip) owns the hover there.
async function pickParkTarget(
  page: Page,
  selector: string,
): Promise<ParkTarget | null> {
  return page.evaluate(
    ({ sel, offset }: { sel: string; offset: number }) => {
      for (const p of document.querySelectorAll<SVGPathElement>(sel)) {
        const group = p.closest(".react-flow__edge");
        if (group === null) continue;
        const len = p.getTotalLength();
        const ctm = p.getScreenCTM();
        if (len === 0 || ctm === null) continue;
        const at = (l: number) => {
          const q = p.getPointAtLength(l).matrixTransform(ctm);
          return { x: q.x, y: q.y };
        };
        const mid = at(len / 2);
        const ahead = at(len / 2 + 2);
        const span = Math.hypot(ahead.x - mid.x, ahead.y - mid.y) || 1;
        const offX = mid.x - ((ahead.y - mid.y) / span) * offset;
        const offY = mid.y + ((ahead.x - mid.x) / span) * offset;
        const hit = document.elementFromPoint(offX, offY);
        if (hit !== null && hit.closest(".react-flow__edge") === group) {
          return {
            edgeId: group.getAttribute("data-id") ?? "",
            midX: mid.x,
            midY: mid.y,
            offX,
            offY,
          };
        }
      }
      return null;
    },
    { sel: selector, offset: OFFSET_PX },
  );
}

// Rest, zero the counter, park at (x, y) for PARK_MS, return the toggle
// count. The park move fires one event at the destination only: intermediate
// points could cross other edges, and each crossing would add its own
// enter/leave pair to the count.
async function parkAndCount(page: Page, x: number, y: number): Promise<number> {
  await page.mouse.move(REST_POINT.x, REST_POINT.y);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (window as { __hoverToggles?: number }).__hoverToggles = 0;
  });
  await page.mouse.move(x, y);
  await page.waitForTimeout(PARK_MS);
  return page.evaluate(
    () => (window as { __hoverToggles?: number }).__hoverToggles ?? 0,
  );
}

test("parking just off a lit edge's centreline holds the hover", async ({
  page,
}) => {
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    readiness: "nodes",
    settle: "both",
  });
  // "attached", not "visible": a hit path carries no ink, and a horizontal
  // stretch has a zero-height box, so Playwright would call it hidden.
  await page.waitForSelector("path.react-flow__edge-interaction", {
    state: "attached",
    timeout: 30_000,
  });
  await installToggleCounter(page);

  const pick = await pickParkTarget(page, "path.react-flow__edge-interaction");
  expect(pick, "a reachable edge hit path on the default plan").not.toBeNull();

  const toggles = await parkAndCount(page, pick!.offX, pick!.offY);
  // Exactly one toggle is the enter; a stable hover adds none after it. The
  // lower bound proves the gesture engaged the hover at all, so a pointer
  // that never reached any edge cannot pass this spec.
  expect(toggles).toBeGreaterThanOrEqual(1);
  expect(
    toggles,
    `edge ${pick!.edgeId}: hover-active toggles in ${PARK_MS} ms`,
  ).toBeLessThanOrEqual(1);

  // The ink path keeps its lit width while hovered: park ON the centreline
  // (a stable hover on both sides of the fix) and read the computed stroke
  // while hover-active is on. No existing spec covers the lit width.
  await page.mouse.move(REST_POINT.x, REST_POINT.y);
  await page.waitForTimeout(300);
  await page.mouse.move(pick!.midX, pick!.midY);
  await page.waitForTimeout(500);
  const litWidth = await page.evaluate((edgeId: string) => {
    const root = document.querySelector(".ak-canvas-theme");
    const ink = document.querySelector(
      `.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`,
    );
    if (root === null || ink === null) return null;
    if (!root.classList.contains("hover-active")) return null;
    return parseFloat(getComputedStyle(ink).strokeWidth);
  }, pick!.edgeId);
  expect(
    litWidth,
    "lit ink stroke-width readable while hover-active",
  ).not.toBeNull();
  expect(litWidth!).toBeGreaterThanOrEqual(2.25);
});

test("parking just off a shared stretch holds the hover", async ({ page }) => {
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    readiness: "nodes",
    settle: "both",
  });
  await page.waitForSelector('[data-testid^="edge-shared-"]', {
    state: "attached",
    timeout: 30_000,
  });
  await installToggleCounter(page);

  const pick = await pickParkTarget(page, '[data-testid^="edge-shared-"]');
  expect(
    pick,
    "a reachable shared-stretch hit path on the default plan",
  ).not.toBeNull();

  const toggles = await parkAndCount(page, pick!.offX, pick!.offY);
  expect(toggles).toBeGreaterThanOrEqual(1);
  expect(
    toggles,
    `shared stretch of edge ${pick!.edgeId}: hover-active toggles in ${PARK_MS} ms`,
  ).toBeLessThanOrEqual(1);
});
