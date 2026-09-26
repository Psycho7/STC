import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { bootExamPage, waitForCanvasReady } from "./viewport";
import { planHash } from "./plan-hash";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "../../src/data/storage-keys";

test.use({ viewport: { width: 1600, height: 1000 } });

// The event-cohort end-to-end story (#144's T7): a shared link whose target
// only an event recipe produces, opened in a browser whose stored overrides
// switch that cohort off, is adopted into the panels under a localized banner
// that names the item and the cohort - never the damaged-link splash. Flipping
// the cohort back on in Settings is the recovery that keeps the link: the same
// plan solves and the banner clears.
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
// not resolve from the plain-node side Playwright runs specs in. The blocked
// sentence interpolates the lung's display name from the pack's i18n sidecar.
const TEXT = {
  openSettings: "打开设置",
  switchV15: "切换 v1.5 活动",
  lungName: "息壤龙泡泡",
  lungCohortBlocked:
    "物品 息壤龙泡泡 仅由 v1.5 活动配方生产，该活动当前未开启。",
  blockedHint: "可在设置中更改区域或活动。",
  corrupt: "此分享链接已损坏，或来自更新版本的规划器。",
  reset: "从新方案开始",
} as const;

// The lung target, shared by the chain check and the blocked-link story below.
const LUNG_TARGETS = [
  { itemId: "activity_xiranite_lung", ratePerSec: { num: "1", denom: "2" } },
];

// The two event recipes the lung is built from. With the cohort on, both have
// to be on the canvas: that is #144's first acceptance line, and the DOM is
// where the solve becomes observable (every recipe card carries its id).
const LUNG_CHAIN = [
  "activity_xiranite_lung",
  "activity_xiranite_box",
  "activity_copper_xiranite_tool",
] as const;

async function recipeIdsOnCanvas(page: Page): Promise<string[]> {
  return page
    .locator("[data-recipe-id]")
    .evaluateAll((els) =>
      els
        .map((el) => el.getAttribute("data-recipe-id"))
        .filter((id): id is string => id !== null),
    );
}

test("with the v1.5 cohort on, the lung target solves through its event chain", async ({
  page,
}) => {
  const log = attachConsoleListener(page);
  const hash = await planHash({ targets: LUNG_TARGETS });

  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "nodes",
    settle: "none",
    eventOverrides: { "v1.5": true },
  });
  await waitForCanvasReady(page);

  const drawn = await recipeIdsOnCanvas(page);
  for (const id of LUNG_CHAIN) expect(drawn).toContain(id);
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});

// The coupon target is the one shipped plan that reaches event content without
// being event content: with the cohort on the LP buys coupons through the
// event chain, so it is the plan where a leak would show.
const COUPON_TARGETS = [
  { itemId: "jinlong_coupon", ratePerSec: { num: "1", denom: "1" } },
];

test("with the v1.5 cohort off, no activity_ recipe reaches the canvas", async ({
  page,
}) => {
  const log = attachConsoleListener(page);
  const hash = await planHash({ targets: COUPON_TARGETS });

  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "nodes",
    settle: "none",
    eventOverrides: { "v1.5": false },
  });
  await waitForCanvasReady(page);

  const drawn = await recipeIdsOnCanvas(page);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.filter((id) => id.includes("activity_"))).toEqual([]);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});

// The control for the check above: the same plan with the cohort on DOES draw
// event recipes, so the empty list there is the switch working, not the plan
// never wanting one.
test("with the v1.5 cohort on, the same coupon plan does draw activity_ recipes", async ({
  page,
}) => {
  const hash = await planHash({ targets: COUPON_TARGETS });

  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "nodes",
    settle: "none",
    eventOverrides: { "v1.5": true },
  });
  await waitForCanvasReady(page);

  const drawn = await recipeIdsOnCanvas(page);
  expect(drawn.filter((id) => id.includes("activity_")).length).toBeGreaterThan(
    0,
  );
});

// #144's last acceptance line: the switch writes localStorage, and a reload
// comes back in the flipped state rather than the version-rule default.
test("a flipped cohort round-trips through localStorage and survives a reload", async ({
  page,
}) => {
  await bootExamPage(page, {
    url: "/",
    readiness: "nodes",
    settle: "none",
  });
  await waitForCanvasReady(page);

  // Fresh browser: nothing stored, so the pack's own cohort is on.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const cohortSwitch = page
    .getByRole("dialog")
    .getByRole("switch", { name: TEXT.switchV15 });
  await expect(cohortSwitch).toBeChecked();

  await cohortSwitch.click();
  await expect(cohortSwitch).not.toBeChecked();
  const stored = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
  );
  expect(JSON.parse(stored ?? "null")).toEqual({ "v1.5": false });

  await page.reload();
  await waitForCanvasReady(page);
  const afterReload = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
  );
  expect(JSON.parse(afterReload ?? "null")).toEqual({ "v1.5": false });

  // And the panel reads the stored state back, not the default.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  await expect(
    page.getByRole("dialog").getByRole("switch", { name: TEXT.switchV15 }),
  ).not.toBeChecked();
});

test("a blocked event link is adopted under a banner and recovers through the settings panel", async ({
  page,
}) => {
  const log = attachConsoleListener(page);

  // The lung is v1.5 event content whose only producer is the event recipe of
  // the same id, so with the cohort seeded off the plan cannot be built.
  const hash = await planHash({ targets: LUNG_TARGETS });
  // readiness "none": nothing is solved for a blocked plan, so no canvas node
  // ever appears for waitForCanvasReady to gate on.
  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "none",
    settle: "none",
    eventOverrides: { "v1.5": false },
  });

  // The link is plan state: the panels hold it, and the damaged-link splash
  // never shows.
  await expect(page.getByTestId("header-strip")).toBeVisible();
  const rows = page.getByTestId("target-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(TEXT.lungName);
  await expect(page.getByText(TEXT.corrupt)).toHaveCount(0);
  await expect(page.getByRole("button", { name: TEXT.reset })).toHaveCount(0);

  // The banner says why: the item by display name and the switched-off
  // cohort, and it points at Settings.
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(TEXT.lungCohortBlocked);
  await expect(alert).not.toContainText("activity_xiranite_lung");
  await expect(alert).toContainText(TEXT.blockedHint);

  // The topbar gear opens the panel on the cohort's row, its switch in the
  // stored-off state.
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

  // Recovery: the adopted plan re-solves under the flipped availability -
  // canvas nodes, the READY annotation, the same target, no banner.
  await waitForCanvasReady(page);
  await expect(
    page.locator(".canvas-annot.bottom-right", { hasText: "READY" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(TEXT.lungName);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});
