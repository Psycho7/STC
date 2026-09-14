import { expect, test } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Row rates draw at rest: every rate span on every card carries its digits
// with no pointer anywhere near it, and hover is not a reveal trigger any
// more. The probe measures computed display per card, so a React-state or
// CSS rewrite that puts the numbers back behind a hover fails here even
// though it could keep the selectors green in the unit contracts.

// One card per recipe is all this spec needs; the rule is per card, not
// per plan shape.
const scenario = SCENARIOS.find((s) => s.id === "default")!;

test("row rates draw at rest and hover changes nothing", async ({ page }) => {
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    locale: "en",
    readiness: "nodes",
    settle: "webfonts",
  });
  await page
    .locator(".rn-row .rate")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // At rest every rate on the page is drawn, and the page has rates to draw
  // (selector-drift guard: measuring nothing proves nothing).
  const rest = await page.evaluate(() => {
    const displays = [...document.querySelectorAll(".rn-row .rate")].map(
      (el) => getComputedStyle(el).display,
    );
    return {
      rows: document.querySelectorAll(".rn-row").length,
      displays,
      texts: [...document.querySelectorAll(".rn-row .rate")].map((el) =>
        (el.textContent ?? "").trim(),
      ),
    };
  });
  expect(rest.rows).toBeGreaterThan(0);
  expect(rest.displays.length).toBeGreaterThan(0);
  expect(rest.displays.filter((d) => d === "none")).toHaveLength(0);
  expect(rest.texts.filter((t) => t === "")).toHaveLength(0);

  // Hover the first card's box. Plain :hover has no intent delay, so any
  // display change is already in effect once the mouse settles; the
  // bounding-box read is the deterministic tick.
  const card = page.locator(".recipe-node").first();
  await card.hover();
  await card.boundingBox();

  const hovered = await page.evaluate(() => {
    return [...document.querySelectorAll(".rn-row .rate")].map(
      (el) => getComputedStyle(el).display,
    );
  });
  expect(hovered).toEqual(rest.displays);

  // The overlay lands inside its card's bounds: over the label tail, never
  // past the card edge.
  const cardBox = await card.boundingBox();
  const rateBox = await card.locator(".rn-row .rate").first().boundingBox();
  expect(cardBox).not.toBeNull();
  expect(rateBox).not.toBeNull();
  expect(rateBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(rateBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
  expect(rateBox!.x + rateBox!.width).toBeLessThanOrEqual(
    cardBox!.x + cardBox!.width,
  );
  expect(rateBox!.y + rateBox!.height).toBeLessThanOrEqual(
    cardBox!.y + cardBox!.height,
  );
});
