import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { bootExamPage, waitForCanvasReady } from "./viewport";
import { planHash } from "./plan-hash";
import { SCENARIOS, scenarioHash } from "./scenarios";

test.use({ viewport: { width: 1600, height: 1000 } });

// Mirrors the listener pattern in raw-and-transport.spec.ts so console-error
// gating stays consistent across the e2e suite. Warnings are also captured so
// regressions like `Handle: No node id` surface.
type ConsoleLog = { errors: string[]; warnings: string[] };
const CONSOLE_ALLOWLIST: ReadonlyArray<string | RegExp> = [];

function attachConsoleListener(page: Page): ConsoleLog {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    const allowed = CONSOLE_ALLOWLIST.some((p) =>
      typeof p === "string" ? text.includes(p) : p.test(text),
    );
    if (allowed) return;
    if (msg.type() === "error") errors.push(text);
    else if (msg.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors, warnings };
}

// Wait for the side-panel InputsPanel to mount. PlanV2 is bootstrapped on first
// load; until the panel exists, locators that target input rows are racy. The
// rail is one scroll body with two sticky heads, so there is nothing to click
// to reach the inputs: scroll their section into view instead.
async function waitForInputsPanel(page: Page): Promise<void> {
  await page.getByTestId("inputs-head").waitFor({ timeout: 10_000 });
  // Scrolled through the DOM rather than with scrollIntoViewIfNeeded: the
  // canvas beside the rail keeps settling, and the action's stability wait
  // would block on it.
  await page
    .getByTestId("inputs-section")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("button", { name: "添加输入" })).toBeVisible({
    timeout: 10_000,
  });
}

// Default locale is zh; UI strings come from src/data/i18n.ts. Centralising the
// localised button text keeps the spec readable and easy to retarget when the
// locale switcher is exercised.
const TEXT = {
  addInput: "添加输入",
  removeInput: "移除",
  itemLabel: "物品",
  rateLabel: "速率",
} as const;

// ---------------------------------------------------------------------------
// Dual-listed-plan seeding (Tests 4, 6 and 7).
//
// The dual-emission rule renders an item as BOTH a boundary input (FIRST layer)
// and an output product (LAST layer) only when that item is genuinely consumed
// inside the plan. copper_powder is consumed solely by the liquid_copper
// recipe, which the default plan never instantiates, so on the default plan an
// override on copper_powder produces no input node. We seed a plan whose
// targets include both copper_powder and liquid_copper, which puts the
// liquid_copper recipe in play.
//
// What the override's rate does next is not a matter of degree. Unlimited
// supply is a structural fork: it drops copper_powder's mass-balance row and
// its producer chain, which makes the liquid_copper recipe the cheap route and
// is what actually puts the item across the boundary. Any finite cap restores
// the row, the solver switches to phase_trans_1-liquid_copper (which consumes
// no copper_powder), and nothing in-graph consumes the item, so no input node
// is emitted. Only a cap the solver can meet entirely by importing keeps one.
// Test 6 takes the uncapped case, Test 4 the import-covered cap, Test 7 the
// below-demand cap.
//
// Targets [copper_powder, liquid_copper] make copper_powder dual-listable:
// produced as a target, and consumed by liquid_copper whenever the solver picks
// that recipe. Which nodes surface depends on the override's rate; see the
// block comment above.
async function makeDualListedPlanHash(): Promise<string> {
  return planHash({
    targets: [
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "2" } },
    ],
  });
}

function inputRows(page: Page) {
  return page.locator('[data-testid="input-row"]');
}

// A plan whose transmuters cycle both xiranite catalysts (the battery5-xiranite
// scenario). gas_xiranite is also consumed as an ordinary input here, so its
// general side keeps a number of its own after a catalyst row is split off;
// liquid_xiranite is cycled and nothing else, so its general side has nothing
// left to show once the charge moves to the catalyst pool. Tests 8 and 9 need
// one of each.
async function makeTransmuterPlanHash(): Promise<string> {
  return planHash({
    targets: [
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } },
    ],
  });
}

function autoRow(page: Page, itemId: string) {
  return page.locator(
    `[data-testid="input-auto-row"][data-item-id="${itemId}"]`,
  );
}

function catalystRow(page: Page, itemId: string) {
  return page.locator(
    `[data-testid="input-row"][data-item-id="${itemId}"][data-role="catalyst"]`,
  );
}

function generalRow(page: Page, itemId: string) {
  return page.locator(
    `[data-testid="input-row"][data-item-id="${itemId}"]:not([data-role])`,
  );
}

async function clickAddInput(page: Page): Promise<void> {
  await page.getByRole("button", { name: TEXT.addInput }).click();
}

// Add goes picker-then-amount (R5), so every "add a row" preamble is three
// steps: click Add, click the item's tile, then confirm the empty prompt with
// Enter (an uncapped row). The tile locator is scoped to the dialog because
// data-item-id is also on canvas nodes and rows.
async function addInputRow(page: Page, itemId: string): Promise<void> {
  await clickAddInput(page);
  await page.locator(`.recipe-picker [data-item-id="${itemId}"]`).click();
  await page.getByTestId("rate-prompt-input").press("Enter");
}

async function expectNoConsoleErrors(log: ConsoleLog): Promise<void> {
  expect(
    log.errors,
    `unexpected console errors:\n${log.errors.join("\n")}`,
  ).toEqual([]);
  const handleNoIdWarning = log.warnings.filter((w) =>
    /Handle:\s*No node id/i.test(w),
  );
  expect(
    handleNoIdWarning,
    `unexpected 'Handle: No node id' warnings:\n${handleNoIdWarning.join("\n")}`,
  ).toEqual([]);
}

test.describe("InputsPanel golden-path coverage", () => {
  test("Test 1: Add opens the picker; the pick's amount prompt commits an uncapped override on Enter", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    // No row yet: the picker is open and nothing has been committed.
    await expect(inputRows(page)).toHaveCount(initialCount);
    await expect(page.locator(".recipe-picker")).toBeVisible();
    const urlBefore = page.url();

    await page.locator('.recipe-picker [data-item-id="copper_powder"]').click();
    // The amount prompt sits between the pick and the row (R5): it names the
    // picked item and the pick alone still commits nothing.
    const promptInput = page.getByTestId("rate-prompt-input");
    await expect(promptInput).toBeVisible();
    await expect(page.locator(".rate-prompt")).toContainText("赤铜粉末");
    await expect(inputRows(page)).toHaveCount(initialCount);

    // Confirming empty commits the uncapped override.
    await promptInput.press("Enter");
    await expect(inputRows(page)).toHaveCount(initialCount + 1);
    // Pin the identity of the committed row, not merely that some row appeared.
    await expect(
      page.locator('[data-testid="input-row"][data-item-id="copper_powder"]'),
    ).toHaveCount(1);
    // An uncapped override: the rate field is empty.
    await expect(
      inputRows(page).nth(initialCount).locator("input"),
    ).toHaveValue("");
    // The hash is rewritten after the solve settles, so poll rather than read.
    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);

    await expectNoConsoleErrors(log);
  });

  test("Test 2: Remove input row drops the row and refreshes the canvas", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    // Two different items: the first pick disables its own tile.
    await addInputRow(page, "copper_powder");
    await addInputRow(page, "iron_powder");
    await expect(inputRows(page)).toHaveCount(initialCount + 2);

    const urlBefore = page.url();

    // Remove the FIRST of the two rows we just added (index = initialCount).
    await inputRows(page)
      .nth(initialCount)
      .locator('[data-testid="remove-input"]')
      .click();

    await expect(inputRows(page)).toHaveCount(initialCount + 1);

    // Canvas re-renders: the URL hash updates via history.replaceState (which
    // does NOT fire `hashchange`, so we wait on the URL value instead).
    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);

    // Canvas still has nodes after the re-solve.
    await waitForCanvasReady(page);

    await expectNoConsoleErrors(log);
  });

  test("Test 3: A claimed item's tile is disabled in the picker", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await addInputRow(page, "copper_powder");
    await addInputRow(page, "iron_powder");
    await expect(inputRows(page)).toHaveCount(initialCount + 2);

    // Open the picker from the second row: the item the first row claims is
    // dimmed, so a duplicate cannot be picked at all.
    const secondRow = inputRows(page).nth(initialCount + 1);
    // exact: false - the trigger's accessible name is the label plus the
    // row's item, so it never equals the bare label.
    await secondRow
      .getByRole("button", { name: TEXT.itemLabel, exact: false })
      .click();
    await expect(
      page.locator('.recipe-picker [data-item-id="copper_powder"]'),
    ).toBeDisabled();
    // The row's own item stays enabled, as a confirm.
    await expect(
      page.locator('.recipe-picker [data-item-id="iron_powder"]'),
    ).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(page.locator(".recipe-picker")).toHaveCount(0);

    await expectNoConsoleErrors(log);
  });

  test("Test 4: Cap a rate, then clear it (commits as uncap)", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    // Seed the dual-listed plan so copper_powder is consumed in-graph (by
    // liquid_copper) and an input override on it surfaces a boundary input node.
    await bootExamPage(page, {
      url: `/#${await makeDualListedPlanHash()}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    // Use copper_powder: a target output of the seeded plan that is also
    // consumed by liquid_copper, so the override renders an input node. The
    // dual-listing render is asserted in Test 6; here we only check rate commit.
    const urlBeforeAdd = page.url();
    await addInputRow(page, "copper_powder");
    const newRow = inputRows(page).nth(initialCount);

    // Let the add's own hash rewrite land before baselining the cap's. Reading
    // the URL straight after the pick can capture it pre-rewrite, and then the
    // cap poll below is satisfied by the ADD's rewrite instead: the assertions
    // that follow would sample a canvas that is still uncapped.
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeAdd);

    const rateInput = newRow.getByRole("textbox", { name: TEXT.rateLabel });

    // Set a rate of 120/min. Once the commit lands the URL hash updates and
    // the input ProductNode renders with the cap badge.
    //
    // The value is deliberately at or above copper_powder's total demand. A cap
    // BELOW demand does not produce a partial import, it flips the route: with
    // copper_powder no longer free, the cheap liquid_copper recipe that eats it
    // stops being optimal and the solver switches to the phase-transfer recipe,
    // which consumes none. Nothing in-graph consumes copper_powder then, and a
    // boundary input node is only emitted for an item an in-graph machine
    // consumes, so there is no node left to assert on. Only a cap the solver
    // can satisfy entirely by importing keeps the boundary node.
    const urlAfterItem = page.url();
    await rateInput.fill("120");
    // fill() does not blur, and the panel commits only on blur or Enter.
    await rateInput.press("Enter");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterItem);

    const copperPowderInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
    );
    // Count first, not toBeAttached: a capped item has exactly one import unit,
    // and asserting the count makes a stray second node report as a count
    // mismatch rather than as a strict-mode violation on the next assertion.
    await expect(copperPowderInput).toHaveCount(1);
    // The node renders the cap (120/min) once the override commits.
    await expect(copperPowderInput).toContainText("/分");

    const urlAfterCap = page.url();

    // Clear the rate field: empty string commits as uncap (override remains
    // but without ratePerSec). URL hash should change again.
    await rateInput.fill("");
    await rateInput.press("Enter");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterCap);

    // Wait for the canvas to settle before sampling the boundary node.
    await waitForCanvasReady(page);
    // Either the input node disappears (consumed by in-graph producer with no
    // boundary surfacing) or it remains without a rate label. Both are
    // valid for "uncap". The load-bearing assertion is that no error banner
    // is shown.
    const errorBanner = page.locator('[role="alert"]', {
      hasText: /solver|load/i,
    });
    await expect(errorBanner).toHaveCount(0);

    await expectNoConsoleErrors(log);
  });

  test("Test 5: Cap exceeding demand commits cleanly with no error banner", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, { url: "/", readiness: "nodes", settle: "none" });
    await waitForInputsPanel(page);

    // copper_ore is a raw boundary input for the default plan, so it sits in
    // the Assumed unlimited block and its tile is dimmed in the Add picker.
    // Promote it with its own "set cap" button, then cap it well above the
    // actual demand (roughly 270/min), which is the premise of this test.
    const assumedRow = page.locator(
      '[data-testid="input-auto-row"][data-item-id="copper_ore"]',
    );
    await expect(assumedRow).toHaveCount(1);
    await expect(assumedRow.getByTestId("input-set-cap")).toBeVisible();
    // The Assumed row offers no rate field at all: promotion is the only way
    // in, and it is a click.
    await expect(
      assumedRow.getByRole("textbox", { name: TEXT.rateLabel }),
    ).toHaveCount(0);

    const urlBeforeCap = page.url();
    await assumedRow.getByTestId("input-set-cap").click();

    // The promotion opens a focused, empty field on the Assumed row itself.
    // Nothing is committed yet, so the plan and its hash are untouched: the
    // item keeps the unlimited supply this block advertises.
    const rateInput = assumedRow.getByTestId("input-pending-cap");
    await expect(rateInput).toBeFocused();
    await expect(rateInput).toHaveValue("");
    await expect(
      page
        .getByTestId("inputs-supplies-body")
        .locator('[data-item-id="copper_ore"]'),
    ).toHaveCount(0);
    expect(page.url()).toBe(urlBeforeCap);

    await rateInput.fill("9999");
    // fill() does not blur, and the panel commits only on blur or Enter.
    await rateInput.press("Enter");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeCap);

    // The committed cap moves the row out of Assumed unlimited and into
    // Supplies as a real override row.
    await expect(
      page
        .getByTestId("inputs-supplies-body")
        .locator('[data-testid="input-row"][data-item-id="copper_ore"]'),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("inputs-assumed-body")
        .locator('[data-item-id="copper_ore"]'),
    ).toHaveCount(0);

    // The input ProductNode for copper_ore still renders, no error banner.
    // Capping the ore gives it a mass-balance row, and no producer can cover it
    // (the only recipe that makes it runs on a map deposit), so the whole demand
    // arrives at the boundary and each consumer gets its own tap alongside the
    // boundary node. Take the first: this case is about the node existing.
    const copperOreInput = page
      .locator(
        '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_ore"]',
      )
      .first();
    await expect(copperOreInput).toBeAttached();

    // No solver-error banner appears: solver-error and load-error banners
    // both use role="alert"; the per-row duplicate alert sits inside an
    // input-row, so scope the negative assertion to top-level alerts.
    const headerErrors = page
      .locator('[data-testid="header-strip"]')
      .getByRole("alert");
    await expect(headerErrors).toHaveCount(0);

    await expectNoConsoleErrors(log);
  });

  test("Test 6: Dual-listed item renders both input and output nodes", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    // Seed a plan whose targets are copper_powder and liquid_copper, the latter
    // consuming copper_powder so the item is both produced and consumed.
    await bootExamPage(page, {
      url: `/#${await makeDualListedPlanHash()}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    // copper_powder is a target output AND is consumed by liquid_copper in the
    // seeded plan. An uncapped input override on it triggers the dual-emission
    // rule: both the input ProductNode (cyan) and the output ProductNode (lime)
    // must render.
    //
    // Uncapped is the load-bearing part, not an omission. Unlimited supply is a
    // structural fork, not a large number: it drops the item's mass-balance row
    // and its producer chain, which makes the liquid_copper recipe that eats
    // copper_powder the cheap route, and that in-graph consumption is what puts
    // the item across the boundary. Free supply also lets the target's export
    // draw from that same input card, so the item gets one merged input card;
    // finite-supply items never share it. Any finite cap flips the route to the
    // phase-transfer recipe, which consumes no copper_powder, and the input card
    // disappears.
    const urlBefore = page.url();
    await addInputRow(page, "copper_powder");

    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);

    await waitForCanvasReady(page);

    // A free-supply target item's export draws from the same input card as its
    // in-graph consumers: one input node for the item, pinned by its exact
    // React Flow data-id, with the export's share on the same card.
    const copperPowderInputs = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
    );
    const copperPowderInput = page
      .locator('.react-flow__node[data-id="u:in:copper_powder"]')
      .locator(
        '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
      );
    const copperPowderOutput = page.locator(
      '[data-testid="product-node"][data-flavor="outputProduct"][data-item-id="copper_powder"]',
    );

    await expect(copperPowderInputs).toHaveCount(1);
    await expect(copperPowderInput).toBeAttached();
    await expect(copperPowderOutput).toBeAttached();

    await expectNoConsoleErrors(log);
  });

  test("Test 7: A below-demand cap drops the item's boundary input node", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, {
      url: `/#${await makeDualListedPlanHash()}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    // This pins current behaviour, it does not endorse it. Tests 4 and 6 pick
    // cap values that keep their boundary nodes; this one takes the third case,
    // which neither covers and which nothing else in the suite would notice
    // changing.
    //
    // With copper_powder capped below its demand the solver abandons the
    // liquid_copper recipe that consumes it for the phase-transfer route, which
    // consumes none, so no in-graph machine consumes copper_powder and no
    // boundary input node is emitted for it. The LP still reports a nonzero
    // draw for the item that never reaches the canvas: the output node below
    // ends up claiming the full target rate with nothing feeding it.
    const initialCount = await inputRows(page).count();
    const urlBeforeAdd = page.url();
    await addInputRow(page, "copper_powder");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeAdd);

    const urlAfterItem = page.url();
    const rateInput = inputRows(page)
      .nth(initialCount)
      .getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("30"); // 30/min == 0.5/s, under total demand.
    await rateInput.press("Enter");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterItem);
    await waitForCanvasReady(page);

    await expect(
      page.locator(
        '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
      ),
    ).toHaveCount(0);
    // The output node stays: copper_powder is still a target.
    await expect(
      page.locator(
        '[data-testid="product-node"][data-flavor="outputProduct"][data-item-id="copper_powder"]',
      ),
    ).toHaveCount(1);

    await expectNoConsoleErrors(log);
  });

  test("Test 8: The catalyst checkbox splits an auto-row into a catalyst row", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, {
      url: `/#${await makeTransmuterPlanHash()}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    // gas_xiranite arrives on the general side as an auto-row: the plan both
    // consumes it as an ordinary input and cycles it as a catalyst, and the
    // charge is billed to the general pool while no catalyst row exists.
    const row = autoRow(page, "gas_xiranite");
    await expect(row).toHaveCount(1);
    await expect(catalystRow(page, "gas_xiranite")).toHaveCount(0);
    const urlBefore = page.url();

    await row.getByTestId("input-catalyst-toggle").click();

    // The catalyst row is a real override row, badged and addressable by role.
    const cRow = catalystRow(page, "gas_xiranite");
    await expect(cRow).toHaveCount(1);
    await expect(cRow.getByTestId("input-catalyst-badge")).toBeVisible();
    await expect(cRow.getByTestId("input-catalyst-toggle")).toBeChecked();

    // The general side still has a number to show - its ordinary consumption -
    // so it comes back as an auto-row rather than disappearing with the charge.
    await expect(autoRow(page, "gas_xiranite")).toHaveCount(1);
    await expect(
      autoRow(page, "gas_xiranite").getByTestId("input-catalyst-toggle"),
    ).not.toBeChecked();

    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);
    await waitForCanvasReady(page);

    await expectNoConsoleErrors(log);
  });

  test("Test 9: A catalyst cap below the need reports the shortage, and unticking keeps it", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await bootExamPage(page, {
      url: `/#${await makeTransmuterPlanHash()}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    // liquid_xiranite is cycled by the liquid-gas transmuters and consumed by
    // nothing, so the whole 48/min charge is the row's number and the general
    // pool is the only thing covering it until the catalyst row takes over.
    await autoRow(page, "liquid_xiranite")
      .getByTestId("input-catalyst-toggle")
      .click();
    const cRow = catalystRow(page, "liquid_xiranite");
    await expect(cRow).toHaveCount(1);

    // Uncapped, the catalyst pool holds the whole charge: nothing is short.
    await expect(cRow.getByTestId("rate-catalyst-short")).toHaveCount(0);

    const urlBeforeCap = page.url();
    const rateInput = cRow.getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("6");
    await rateInput.press("Enter");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeCap);

    // 6/min of a 48/min need, and the general pool has no headroom left for a
    // non-raw item it does not otherwise import, so 42/min is unmet.
    const shortage = catalystRow(page, "liquid_xiranite").getByTestId(
      "rate-catalyst-short",
    );
    await expect(shortage).toBeVisible();
    await expect(shortage).toContainText("42");

    // Unticking converts the row back to the general pool and carries the cap.
    await catalystRow(page, "liquid_xiranite")
      .getByTestId("input-catalyst-toggle")
      .click();
    const gRow = generalRow(page, "liquid_xiranite");
    await expect(gRow).toHaveCount(1);
    await expect(catalystRow(page, "liquid_xiranite")).toHaveCount(0);
    await expect(gRow.getByTestId("input-catalyst-badge")).toHaveCount(0);
    await expect(
      gRow.getByRole("textbox", { name: TEXT.rateLabel }),
    ).toHaveValue("6");

    await waitForCanvasReady(page);
    await expectNoConsoleErrors(log);
  });

  test("Test 10: both section heads keep their counts in view at every scroll offset", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    // multi6, not the default plan: sticky heads only prove anything on a rail
    // that scrolls, and the default plan's three assumed rows and empty
    // Supplies block leave the rail exactly as tall as its viewport, so the
    // loop below would pass without a single head ever being pinned. multi6's
    // six targets and seven assumed inputs overflow it by ~600px.
    const scenario = SCENARIOS.find((s) => s.id === "multi6")!;
    await bootExamPage(page, {
      url: `/#${await scenarioHash(scenario)}`,
      readiness: "nodes",
      settle: "none",
    });
    await waitForInputsPanel(page);

    // The pill nav is gone; what replaces it are two stacked sticky heads, and
    // the whole point of the stack is that neither count can scroll away.
    await expect(page.locator('[data-testid="side-panel"] nav')).toHaveCount(0);

    const rail = page.locator(".side-panel-scroll");
    const railBox = (await rail.boundingBox())!;
    const maxScroll = await rail.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    // A rail short enough not to scroll would pass the loop below for the
    // wrong reason.
    expect(maxScroll).toBeGreaterThan(0);

    for (const offset of [0, Math.floor(maxScroll / 2), maxScroll]) {
      await rail.evaluate((el, top) => {
        el.scrollTop = top;
      }, offset);
      for (const headId of ["targets-head", "inputs-head"]) {
        const count = page.getByTestId(headId).locator(".count .v");
        await expect(count).toBeVisible();
        const box = (await count.boundingBox())!;
        expect(
          box.y,
          `${headId} count above the rail at scrollTop ${offset}`,
        ).toBeGreaterThanOrEqual(railBox.y - 1);
        expect(
          box.y + box.height,
          `${headId} count below the rail at scrollTop ${offset}`,
        ).toBeLessThanOrEqual(railBox.y + railBox.height + 1);
      }
    }

    await expectNoConsoleErrors(log);
  });
});
