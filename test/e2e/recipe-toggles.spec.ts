import { test, expect } from "@playwright/test";
import { bootExamPage, waitForCanvasReady } from "./viewport";
import { planHash } from "./plan-hash";
import { DISABLED_RECIPES_STORAGE_KEY } from "../../src/data/storage-keys";

test.use({ viewport: { width: 1600, height: 1000 } });

// The manual recipe toggles (#125) end to end: switching off the only producer
// of a target is allowed, banners by name, and both the toggle and the banner
// are still there after a reload. Runs against the built preview, so the write
// side is the production one - no seeded key, the panel does the writing.

// Default locale is zh; the strings are pinned here the way the sibling specs
// pin theirs, because loadI18n cannot be imported from a spec (it pulls the
// @aef/data vite alias, which does not resolve on the plain-node side the
// Playwright runner lives on).
const TEXT = {
  openSettings: "打开设置",
  showAllRecipes: "显示全部配方",
  filter: "赤铜瓶",
} as const;

// The bottle's only producer is the recipe of the same id, so one toggle is
// the whole distance between a solved plan and a validation error.
const BOTTLE_TARGETS = [
  { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
];

const bottleRow =
  '[data-testid="settings-recipe-toggle"][data-recipe="copper_bottle"]';

test("a recipe switched off in the panel banners by name and survives a reload", async ({
  page,
}) => {
  const hash = await planHash({ targets: BOTTLE_TARGETS });
  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "nodes",
    settle: "none",
  });
  await waitForCanvasReady(page);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: TEXT.showAllRecipes }).click();
  await page.getByTestId("settings-recipe-filter").fill(TEXT.filter);
  const toggle = dialog
    .locator(bottleRow)
    .getByTestId("settings-recipe-checkbox");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  // The one writer persisted the set as a JSON array of ids.
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      DISABLED_RECIPES_STORAGE_KEY,
    ),
  ).toBe('["copper_bottle"]');

  // The committed plan revalidates: the banner names the item and the toggle
  // the user just flipped, rather than the solver throwing.
  await page.keyboard.press("Escape");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("copper_bottle");
  await expect(alert).toContainText(TEXT.filter);

  await page.reload();

  // Both halves hold across the reload: the plan still refuses by name, and
  // the panel still reads the toggle off.
  const reloaded = page.getByRole("alert");
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("copper_bottle");
  await expect(reloaded).toContainText(TEXT.filter);

  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const reopened = page.getByRole("dialog");
  await reopened.getByRole("button", { name: TEXT.showAllRecipes }).click();
  await page.getByTestId("settings-recipe-filter").fill(TEXT.filter);
  await expect(
    reopened.locator(bottleRow).getByTestId("settings-recipe-checkbox"),
  ).not.toBeChecked();
});
