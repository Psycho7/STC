import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { bootExamPage, waitForCanvasReady } from "./viewport";
import { planHash } from "./plan-hash";
import { AREA_STORAGE_KEY } from "../../src/data/storage-keys";

test.use({ viewport: { width: 1600, height: 1000 } });

// The area-restriction story (#124), the sibling of event-cohorts.spec.ts: a
// settlement seeded before boot decides which recipes exist, and a settlement
// chosen in the panel is still chosen after a reload. Runs against the built
// preview, so the boot path is the production one - seeded localStorage, real
// solver, no init-script shims in the app itself.

type ConsoleLog = { errors: string[] };

function attachConsoleListener(page: Page): ConsoleLog {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors };
}

// Default locale is zh; the strings are pinned here the way the sibling spec
// pins its copy, because loadI18n cannot be imported from a spec (it pulls the
// @aef/data vite alias, which does not resolve on the plain-node side the
// Playwright runner lives on). The settlement names come from the pack's i18n
// sidecar, the rest from src/data/i18n.ts.
const TEXT = {
  openSettings: "打开设置",
  area: "区域",
  tundra: "四号谷地",
  jinlong: "武陵",
  copperName: "赤铜溶液",
  blockedHint: "可在设置中更改区域或活动。",
  corrupt: "此分享链接已损坏，或来自更新版本的规划器。",
  reset: "从新方案开始",
} as const;

// Liquid copper is made in two mix pools, both of which exist only in 武陵: the
// cleanest copper target for the rule, since the tundra leaves it with no
// producer at all rather than merely a longer chain.
const COPPER_TARGETS = [
  { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "1" } },
];

test("with the tundra seeded, a copper link is adopted under a banner naming the item and the area", async ({
  page,
}) => {
  const log = attachConsoleListener(page);
  const hash = await planHash({ targets: COPPER_TARGETS });

  // readiness "none": nothing is solved for a blocked plan, so no canvas node
  // ever appears for waitForCanvasReady to gate on.
  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "none",
    settle: "none",
    area: "tundra",
  });

  // The link is plan state: the panels hold it, and the damaged-link splash
  // never shows.
  await expect(page.getByTestId("header-strip")).toBeVisible();
  const rows = page.getByTestId("target-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(TEXT.copperName);
  await expect(page.getByText(TEXT.corrupt)).toHaveCount(0);
  await expect(page.getByRole("button", { name: TEXT.reset })).toHaveCount(0);

  // The banner says why: the item by display name, and the settlement the way
  // the panel names it, not by pack id - and it points at Settings.
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(TEXT.copperName);
  await expect(alert).not.toContainText("liquid_copper");
  await expect(alert).toContainText(TEXT.tundra);
  await expect(alert).not.toContainText("tundra");
  await expect(alert).toContainText(TEXT.blockedHint);

  // Recovery: choosing the settlement that builds copper solves the same plan
  // and clears the banner.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: TEXT.jinlong }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await waitForCanvasReady(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(rows).toHaveCount(1);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});

// The control: the same plan with no area seeded opens on the latest
// settlement, 武陵, and solves, so the banner above is the area rule biting
// rather than the plan being broken.
test("with no area seeded, the same copper plan solves", async ({ page }) => {
  const log = attachConsoleListener(page);
  const hash = await planHash({ targets: COPPER_TARGETS });

  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "nodes",
    settle: "none",
  });
  await waitForCanvasReady(page);

  await expect(page.getByRole("alert")).toHaveCount(0);
  const stored = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    AREA_STORAGE_KEY,
  );
  // The default is read, not written: booting must not store it, so a pack
  // that adds a newer settlement still moves this browser onto it.
  expect(stored).toBeNull();

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});

// Seeding before boot proves the read side only. This proves the write side:
// the choice made in the panel is what a reloaded page comes back on.
test("an area chosen in the panel survives a reload", async ({ page }) => {
  await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });
  await waitForCanvasReady(page);

  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const dialog = page.getByRole("dialog");
  // Settlements only, and the latest one pressed on a fresh browser.
  await expect(
    dialog.getByRole("group", { name: TEXT.area }).getByRole("button"),
  ).toHaveText([TEXT.tundra, TEXT.jinlong]);
  await expect(
    dialog.getByRole("button", { name: TEXT.jinlong }),
  ).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: TEXT.tundra }).click();
  await expect(
    dialog.getByRole("button", { name: TEXT.tundra }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AREA_STORAGE_KEY,
    ),
  ).toBe("tundra");

  await page.reload();
  await waitForCanvasReady(page);
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AREA_STORAGE_KEY,
    ),
  ).toBe("tundra");

  // And the panel reads the stored settlement back, not the default.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const reopened = page.getByRole("dialog");
  await expect(
    reopened.getByRole("button", { name: TEXT.tundra }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reopened.getByRole("button", { name: TEXT.jinlong }),
  ).toHaveAttribute("aria-pressed", "false");
});
