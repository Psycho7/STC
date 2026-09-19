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
  allAreas: "全部区域",
  tundra: "四号谷地",
  jinlong: "武陵",
} as const;

// Liquid copper is made in two mix pools, both of which exist only in 武陵: the
// cleanest copper target for the rule, since the tundra leaves it with no
// producer at all rather than merely a longer chain.
const COPPER_TARGETS = [
  { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "1" } },
];

test("with the tundra seeded, a copper target is refused by name", async ({
  page,
}) => {
  const log = attachConsoleListener(page);
  const hash = await planHash({ targets: COPPER_TARGETS });

  // readiness "none": this boot lands on the splash, where no canvas node ever
  // appears for waitForCanvasReady to gate on.
  await bootExamPage(page, {
    url: `/#${hash}`,
    readiness: "none",
    settle: "none",
    area: "tundra",
  });

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("liquid_copper");
  // The banner names the settlement the way the panel does, not by pack id.
  await expect(alert).toContainText(TEXT.tundra);
  await expect(alert).not.toContainText("tundra");
  await expect(page.locator(".react-flow")).toHaveCount(0);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});

// The control: the same plan with no area seeded is the all-areas default and
// solves, so the refusal above is the area rule biting rather than the plan
// being broken.
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
  // All areas is the ABSENCE of the key: booting must not write a sentinel.
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
  await expect(
    dialog.getByRole("radio", { name: TEXT.allAreas }),
  ).toHaveAttribute("aria-checked", "true");

  await dialog.getByRole("radio", { name: TEXT.jinlong }).click();
  await expect(
    dialog.getByRole("radio", { name: TEXT.jinlong }),
  ).toHaveAttribute("aria-checked", "true");
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AREA_STORAGE_KEY,
    ),
  ).toBe("jinlong");

  await page.reload();
  await waitForCanvasReady(page);
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AREA_STORAGE_KEY,
    ),
  ).toBe("jinlong");

  // And the panel reads the stored settlement back, not the default.
  await page.getByRole("button", { name: TEXT.openSettings }).click();
  const reopened = page.getByRole("dialog");
  await expect(
    reopened.getByRole("radio", { name: TEXT.jinlong }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    reopened.getByRole("radio", { name: TEXT.allAreas }),
  ).toHaveAttribute("aria-checked", "false");
});
