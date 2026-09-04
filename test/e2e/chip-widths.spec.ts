import { test, expect, type Page } from "@playwright/test";
import { SCENARIOS, scenarioHash, type Scenario } from "./scenarios";
import { CHIP_BOX_HEIGHT } from "../../src/canvas/dimensions";

// The committed four-locale seat-width check: "drawn <= reserved at rest" is
// the load-bearing premise of the realistic seat box, and this spec is what
// fails when the .flow-chip CSS, the number font, or a locale's unit string
// drifts out from under the estimator constants (CHIP_GLYPH_PX,
// CHIP_UNIT_MAX_PX). Every rendered chip box at zoom 1 (scale 1, all zoom
// gates open) must fit inside the natural-scale width its seat reserved, as
// reported per testId by window.__stcExam.chipReservations(). An icon-only
// (compact) chip reserves the exact square icon box instead, so it is checked
// against CHIP_BOX_HEIGHT rather than the estimate.
//
// The chip bodies are locale-independent ASCII digits, so the full scenario
// corpus runs in en only; the other locales vary just the appended unit
// string, and two dense scenarios cover them. The pinned unit strings double
// as a composition check: each drawn chip text must be exactly body + unit,
// so a render that composes chip text differently fails here rather than
// silently invalidating the estimator's split.

test.use({ viewport: { width: 1920, height: 1080 } });

// Locale rate units as rendered (canvas.rate.unit in src/data/i18n.ts). A
// deliberate pin: a new or changed unit string must re-justify
// CHIP_UNIT_MAX_PX, and this spec failing is the reminder.
const UNITS = { en: "/min", ja: "/分", ru: "/мин", zh: "/分" } as const;
type LocaleId = keyof typeof UNITS;

// Sub-pixel slack on client rects; real drift is glyph-sized (>1px).
const WIDTH_EPS_PX = 0.5;

const DENSE_IDS = ["battery5", "multi6"];
const DENSE_SCENARIOS = SCENARIOS.filter((s) => DENSE_IDS.includes(s.id));

type MeasuredChip = {
  testId: string;
  width: number;
  iconOnly: boolean;
  text: string;
};
type Reservation = {
  testId: string;
  body: string;
  unit: boolean;
  reservedPx: number;
};

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 30_000 });
}

// Block until the viewport transform holds identical across two animation
// frames (same idiom as geometry-audit.spec.ts): measuring mid-camera-move
// would read stale rects.
async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (vp === null) return false;
      const now = vp.style.transform;
      const prev = (vp as unknown as { __auditPrevTransform?: string })
        .__auditPrevTransform;
      (
        vp as unknown as { __auditPrevTransform?: string }
      ).__auditPrevTransform = now;
      return prev !== undefined && prev === now && now !== "";
    },
    undefined,
    { timeout: 10_000, polling: "raf" },
  );
}

async function measureAtRest(
  page: Page,
): Promise<{ chips: MeasuredChip[]; reservations: Reservation[] }> {
  await waitForCanvasReady(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await waitForStableViewport(page);
  // "At rest" is zoom 1: chips render at scale 1 with every zoom gate open
  // (LABEL_MIN_ZOOM, the icon-only band), so the member chips the fit zoom
  // hides are measured too. Only `compact` chips stay icon-only here.
  await page.evaluate(() => {
    window.__stcExam!.setViewport({ x: 0, y: 0, zoom: 1 });
  });
  await page.waitForFunction(
    () => {
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
      return vp !== null && /scale\(1\)$/.test(vp.style.transform);
    },
    undefined,
    { timeout: 10_000, polling: "raf" },
  );
  await waitForStableViewport(page);
  return page.evaluate(() => {
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>(".flow-chip"),
    ).map((el) => ({
      testId: el.getAttribute("data-testid") ?? "(chip)",
      width: el.getBoundingClientRect().width,
      iconOnly: el.classList.contains("icon-only"),
      text: el.textContent ?? "",
    }));
    return { chips, reservations: window.__stcExam!.chipReservations() };
  });
}

function auditChips(
  chips: MeasuredChip[],
  reservations: Reservation[],
  unit: string,
): string[] {
  const byTestId = new Map(reservations.map((r) => [r.testId, r]));
  const violations: string[] = [];
  for (const chip of chips) {
    if (chip.iconOnly) {
      // Exact square icon box (CHIP_HALF_W_ICON), not an estimate.
      if (chip.width > CHIP_BOX_HEIGHT + WIDTH_EPS_PX) {
        violations.push(
          `${chip.testId}: icon-only box ${chip.width.toFixed(2)}px > ` +
            `${CHIP_BOX_HEIGHT}px`,
        );
      }
      continue;
    }
    const r = byTestId.get(chip.testId);
    if (r === undefined) {
      violations.push(
        `${chip.testId}: rendered chip has no reservation (new chip family ` +
          `not covered by examChipReservations / the estimator)`,
      );
      continue;
    }
    const expectedText = r.body + (r.unit ? unit : "");
    if (chip.text !== expectedText) {
      violations.push(
        `${chip.testId}: drawn text "${chip.text}" != body+unit ` +
          `"${expectedText}" (chip composition drifted from the builders)`,
      );
    }
    if (chip.width > r.reservedPx + WIDTH_EPS_PX) {
      violations.push(
        `${chip.testId}: drawn ${chip.width.toFixed(2)}px > reserved ` +
          `${r.reservedPx.toFixed(2)}px for "${expectedText}"`,
      );
    }
  }
  return violations;
}

function defineCheck(locale: LocaleId, scenario: Scenario): void {
  test(`${locale} ${scenario.id}`, async ({ page }) => {
    await page.addInitScript((l) => {
      window.localStorage.setItem("aef.locale", l);
      // The audit corpus polices the bus machinery, so every spec opts the
      // toggle on explicitly; the app default (off since the bus-lanes flip)
      // is a product decision this suite does not re-test.
      window.localStorage.setItem("aef.busLanes", "on");
    }, locale);
    const hash = await scenarioHash(scenario);
    await page.goto(`/?exam=1#${hash}`, { waitUntil: "load" });
    const { chips, reservations } = await measureAtRest(page);

    // Selector-drift guard: an audit that measures nothing proves nothing.
    const fullChips = chips.filter((c) => !c.iconOnly);
    expect(fullChips.length).toBeGreaterThan(0);

    const violations = auditChips(chips, reservations, UNITS[locale]);
    expect(
      violations,
      `chip width bound (drawn <= reserved) violated:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
}

test.describe("chip seat-width bound", () => {
  for (const scenario of SCENARIOS) defineCheck("en", scenario);
  for (const locale of ["ja", "ru", "zh"] as const)
    for (const scenario of DENSE_SCENARIOS) defineCheck(locale, scenario);
});
