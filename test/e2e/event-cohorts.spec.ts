import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { bootExamPage, waitForCanvasReady } from "./viewport";
import { planHash } from "./plan-hash";

test.use({ viewport: { width: 1600, height: 1000 } });

// The event-cohort end-to-end story (#144's T7): a shared link whose target
// only an event recipe produces, opened in a browser whose stored overrides
// switch that cohort off, must land on the localized error splash - and the
// settings panel must be reachable FROM that splash, because flipping the
// cohort back on is the one recovery that keeps the link. Flipping the switch
// re-runs the pending hash load, which lands on the solved plan.
//
// Runs against the built preview like every spec in this suite, so the boot
// path exercised is the production one: seeded localStorage, init-script-free
// app code, real solver.

type ConsoleLog = { errors: string[] };
const CONSOLE_ALLOWLIST: ReadonlyArray<string | RegExp> = [];

function attachConsoleListener(page: Page): ConsoleLog {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    const allowed = CONSOLE_ALLOWLIST.some((p) =>
      typeof p === "string" ? text.includes(p) : p.test(text),
    );
    if (allowed) return;
    if (msg.type() === "error") errors.push(text);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors };
}

// Default locale is zh; UI strings come from src/data/i18n.ts. Hardcoded the
// same way inputs-panel.spec.ts pins its copy: loadI18n cannot be imported
// from a spec because it runtime-imports @aef/data, a vite alias that does
// not resolve from the plain-node side Playwright runs specs in. The error
// sentence is the raw-template interpolation for the lung target (item ids
// interpolate untranslated).
const TEXT = {
  openSettings: "打开设置",
  switchV15: "切换 v1.5 活动",
  lungCohortError:
    "物品 activity_xiranite_lung 仅由 v1.5 活动配方生产，该活动当前未开启。",
} as const;

test("a rejected event link recovers through the settings panel on the splash", async ({
  page,
}) => {
  const log = attachConsoleListener(page);

  // The lung is v1.5 event content whose only producer is the event recipe of
  // the same id, so with the cohort seeded off the link cannot validate.
  const hash = await planHash({
    targets: [
      {
        itemId: "activity_xiranite_lung",
        ratePerSec: { num: "1", denom: "2" },
      },
    ],
  });
  // readiness "none": this boot is expected to land on the splash, where no
  // canvas node ever appears for waitForCanvasReady to gate on.
  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "none",
    settle: "none",
    eventOverrides: { "v1.5": false },
  });

  // The splash owns the viewport: the localized producer-unavailable error
  // names the raw item id and the switched-off cohort.
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(TEXT.lungCohortError);
  await expect(alert).toContainText("v1.5");
  await expect(page.locator(".react-flow")).toHaveCount(0);

  // The splash hosts the same gear the topbar does; the panel it opens shows
  // the cohort's row with its switch in the stored-off state.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("v1.5");
  const cohortSwitch = dialog.getByRole("switch", { name: TEXT.switchV15 });
  await expect(cohortSwitch).toBeVisible();
  await expect(cohortSwitch).not.toBeChecked();

  // Flip the cohort on and close the panel; Escape is one of its close paths.
  await cohortSwitch.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Recovery: the pending hash re-loads under the flipped availability, so
  // the linked plan solves - canvas nodes, the READY annotation, no splash.
  await waitForCanvasReady(page);
  await expect(
    page.locator(".canvas-annot.bottom-right", { hasText: "READY" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});
