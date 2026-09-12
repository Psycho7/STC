// What bootExamPage's storage seeding is worth: that it still reaches the app.
// Nothing else pins it. The specs that ask for "en" would fail on their own
// text if the seeding broke, but the ones that rely on the zh default would
// keep passing, and the lanes-on corpus would silently start auditing
// lanes-off geometry - the exact silent drift src/data/storage-keys.ts warns
// about.
import { test, expect } from "@playwright/test";

import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

const VIEWPORT = { width: 1600, height: 1000 };
test.use({ viewport: VIEWPORT });

// The add-target button as each locale renders it (targets.add in
// src/data/i18n.ts): the earliest UI string that differs between the two.
const ADD_TARGET = { en: "Add target", zh: "添加目标" } as const;

// The densest plan, and the one collect-scene already relies on for rendering
// every element kind at once - so it certainly routes bus lanes when they are on.
const LANE_PLAN_ID = "battery5-xiranite";

test("an omitted locale leaves the app on its zh default", async ({ page }) => {
  await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });

  await expect(page.getByRole("button", { name: ADD_TARGET.zh })).toBeVisible();
  await expect(page.getByRole("button", { name: ADD_TARGET.en })).toHaveCount(
    0,
  );
});

test('locale "en" boots the app in English', async ({ page }) => {
  await bootExamPage(page, {
    url: "/",
    locale: "en",
    readiness: "nodes",
    settle: "none",
  });

  await expect(page.getByRole("button", { name: ADD_TARGET.en })).toBeVisible();
  await expect(page.getByRole("button", { name: ADD_TARGET.zh })).toHaveCount(
    0,
  );
});

// One page per boot: page.addInitScript has no counterpart that removes it, so
// a second boot on the same page would still carry the first boot's seed. The
// two lane modes therefore need two contexts, which is also how the exam
// capture calls the helper.
test("busLanes on draws the lane bands an omitted key leaves off", async ({
  browser,
  baseURL,
}) => {
  const hash = await scenarioHash(
    SCENARIOS.find((s) => s.id === LANE_PLAN_ID)!,
  );

  const bandsWith = async (busLanes?: "on" | undefined): Promise<number> => {
    // The config always sets baseURL; a context made by hand does not inherit
    // it the way the page fixture's does.
    const context = await browser.newContext({
      viewport: VIEWPORT,
      baseURL: baseURL!,
    });
    try {
      const page = await context.newPage();
      await bootExamPage(page, {
        url: `/#${hash}`,
        locale: "en",
        busLanes,
        readiness: "nodes",
        settle: "viewport",
      });
      return await page.locator(".bus-band").count();
    } finally {
      await context.close();
    }
  };

  expect(await bandsWith("on"), "lanes on draws bus bands").toBeGreaterThan(0);
  expect(await bandsWith(), "an omitted busLanes key draws none").toBe(0);
});
