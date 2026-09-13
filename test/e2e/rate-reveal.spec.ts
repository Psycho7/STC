import { expect, test } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

// The row-rate overlay reveal: a card at rest carries no digits -- the rate
// spans are display:none overlays at the rows' inner ends -- and pointing
// at a card is one of the two reveal triggers (selection is the other; its
// cascade is pinned in jsdom). The probe measures computed display per
// card, so a React-state rewrite of the reveal fails here even though it
// could keep the selectors green in the unit contracts.

// One card per recipe is all this spec needs; the reveal is per card, not
// per plan shape.
const scenario = SCENARIOS.find((s) => s.id === "default")!;

test("row rates are hidden at rest and revealed only on the hovered card", async ({
  page,
}) => {
  await bootExamPage(page, {
    url: `/#${await scenarioHash(scenario)}`,
    locale: "en",
    readiness: "nodes",
    settle: "webfonts",
  });
  // The rates themselves are display:none at rest, so wait on a row label
  // (the model of row-collisions.spec.ts) rather than on the overlay.
  await page
    .locator(".rn-row .lbl")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // At rest every rate on the page is hidden, and the page has rows to
  // hide (selector-drift guard: measuring nothing proves nothing).
  const rest = await page.evaluate(() => {
    const rates = [...document.querySelectorAll(".rn-row .rate")];
    return {
      rows: document.querySelectorAll(".rn-row").length,
      rates: rates.length,
      hidden: rates.filter((el) => getComputedStyle(el).display === "none")
        .length,
    };
  });
  expect(rest.rows).toBeGreaterThan(0);
  expect(rest.rates).toBeGreaterThan(0);
  expect(rest.hidden).toBe(rest.rates);

  // Hover the first card's box. The reveal is plain :hover with no intent
  // delay, so it is already in effect by the time the next evaluate runs;
  // the waitForFunction is the deterministic tick either way.
  const card = page.locator(".recipe-node").first();
  await card.hover();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".rn-row .rate")].some(
        (el) => getComputedStyle(el).display === "block",
      ),
    undefined,
    { timeout: 5_000 },
  );

  const hovered = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".recipe-node")];
    const read = (root: ParentNode) =>
      [...root.querySelectorAll(".rn-row .rate")].map(
        (el) => getComputedStyle(el).display,
      );
    const first = cards[0]!;
    const otherRates = cards.slice(1).flatMap((c) => read(c));
    return {
      firstShown: read(first).filter((d) => d === "block").length,
      firstTotal: read(first).length,
      otherShown: otherRates.filter((d) => d === "block").length,
      otherTotal: otherRates.length,
    };
  });
  expect(hovered.firstTotal).toBeGreaterThan(0);
  expect(hovered.firstShown).toBe(hovered.firstTotal);
  expect(hovered.otherShown).toBe(0);

  // The overlay lands inside the hovered card's bounds: over the label
  // tail, never past the card edge.
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
