import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1000 } });

// Sibling of inputs-panel Test 5 ("cap exceeding demand commits cleanly"),
// running the other half of the same gesture. Test 5 caps copper_ore well above
// demand and asserts nothing goes wrong; this one caps iron_ore well below it
// and asserts that something is said.
//
// The distinction only exists against a production build, which is what this
// suite runs. A below-demand cap on an item no recipe produces is not an LP
// infeasibility: the model funds a deficit column, returns a partial plan and
// throws nothing. The dev-only render-invariant hook would catch it, but it is
// compiled out here, so the strip is the only thing telling the user that the
// graph delivers a third of its declared iron_powder.

type ConsoleLog = { errors: string[]; warnings: string[] };

function attachConsoleListener(page: Page): ConsoleLog {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (msg.type() === "error") errors.push(text);
    else if (msg.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors, warnings };
}

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 20_000 });
}

async function waitForInputsPanel(page: Page): Promise<void> {
  await page.getByTestId("side-panel-tab-inputs").click();
  await expect(page.getByRole("button", { name: "添加输入" })).toBeVisible({
    timeout: 10_000,
  });
}

// Default locale is zh; these come from src/data/i18n.ts and the shipped pack
// name table, the same way inputs-panel.spec.ts pins its button text.
const TEXT = {
  rateLabel: "速率",
  ironPowder: "蓝铁粉末",
} as const;

test("a raw cap below demand warns instead of reporting READY", async ({
  page,
}) => {
  const log = attachConsoleListener(page);
  await page.goto("/", { waitUntil: "load" });
  await waitForCanvasReady(page);
  await waitForInputsPanel(page);

  // No strip on the default plan: every target is delivered in full.
  await expect(page.getByTestId("shortfall-strip")).toHaveCount(0);

  // iron_ore is a raw boundary input of the default plan, so it arrives as an
  // auto-row. The plan draws roughly 15/min; 5/min starves it, and no recipe
  // produces iron_ore, so the solver cannot route around the cap.
  const autoRow = page.locator(
    '[data-testid="input-auto-row"][data-item-id="iron_ore"]',
  );
  await expect(autoRow).toHaveCount(1);

  const urlBeforeCap = page.url();
  const rateInput = autoRow.getByRole("textbox", { name: TEXT.rateLabel });
  await rateInput.fill("5");
  // fill() does not blur, and the panel commits only on blur or Enter.
  await rateInput.press("Enter");

  await expect
    .poll(() => page.url(), { timeout: 5_000 })
    .not.toBe(urlBeforeCap);

  // The warning names the starved target, iron_powder.
  const strip = page.getByTestId("shortfall-strip");
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await expect(strip).toContainText(TEXT.ironPowder);

  // The partial plan still draws, and this is not the dismissible error
  // banner: nothing threw, so no share link lands on the damaged-link splash.
  await waitForCanvasReady(page);
  await expect(
    page.locator('[data-testid="header-strip"]').getByRole("alert"),
  ).toHaveCount(0);

  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
});
