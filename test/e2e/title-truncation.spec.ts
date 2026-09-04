import { expect, test } from "@playwright/test";

// Issue #38: every card carrying a multiplier chip clipped its machine name
// even though the header had slack locked in unused grid-column reservations.
// The default plan carries both chip-bearing and chip-free cards, so an empty
// clipped list here means the title column can reclaim the slack.
test("default plan machine titles do not truncate", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("aef.locale", "en");
    // The audit corpus polices the bus machinery, so every spec opts the
    // toggle on explicitly; the app default (off since the bus-lanes flip)
    // is a product decision this suite does not re-test.
    window.localStorage.setItem("aef.busLanes", "on");
  });
  await page.goto("/");
  await page.waitForSelector(".machine-title .cn");
  const clipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".machine-title .cn"))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent ?? ""),
  );
  expect(clipped).toEqual([]);
});
