import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

// Wait for the React Flow canvas to render at least one pipeline node. Without
// this gate, panel mutations race the initial solver/render pass.
async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 20_000 });
}

// Wait for the side-panel InputsPanel to mount. PlanV2 is bootstrapped on first
// load; until the panel exists, locators that target input rows are racy. The
// side panel ships with the Targets tab active by default, so the Inputs tab
// must be activated before its body becomes visible (the panel body is hidden
// when its tab isn't active).
async function waitForInputsPanel(page: Page): Promise<void> {
  await page.getByTestId("side-panel-tab-inputs").click();
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
  duplicateAlert: "该物品已声明",
} as const;

// The first lex-sorted item id in the AEF recipe pack. Asserted by Test 1 to
// pin the Add behaviour (first unused id, lex-sorted) to a concrete value
// rather than just "any unused id". Pinned to the upstream submodule SHA at
// the time of writing; if the pack reshuffles the lex ordering, update here.
const FIRST_LEX_ITEM_ID = "bottled_food_1";
const SECOND_LEX_ITEM_ID = "bottled_food_2";

// Debounce inside InputsPanel.commitRate. Tests waiting on a rate-cap commit
// must outlast this delay; the App's solver re-run then follows.
const COMMIT_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Dual-listed-plan seeding (Tests 4 and 6).
//
// The dual-emission rule renders an item as BOTH a boundary input (the imported
// cap, FIRST layer) and an output product (LAST layer) only when that item is
// genuinely consumed inside the plan. copper_powder is consumed solely by the
// liquid_copper recipe, which the default plan never instantiates, so on the
// default plan an override on copper_powder produces no input node. We seed a
// plan whose targets include both copper_powder and liquid_copper: copper_powder
// is then produced (its own target) and consumed (by liquid_copper), so a cap
// below its total demand surfaces both nodes.
//
// The wire encoder and pack self-read mirror raw-and-transport.spec.ts so this
// spec stays self-contained and does not pull SPA modules through the bundler.
function findParentRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "data/aef/recipe-pack.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    "Cannot locate parent root containing data/aef/recipe-pack.json",
  );
}

// Pack triple for the wire envelope. loadPlan validates only schemaVersion, so
// the third element (legacy submoduleSha, now sourceCommit) is informational.
const PACK_META = (() => {
  const parentRoot = findParentRoot(resolve(import.meta.dirname));
  const raw = JSON.parse(
    readFileSync(join(parentRoot, "data/aef/recipe-pack.json"), "utf8"),
  ) as {
    schemaVersion: string;
    source: { name: string; sourceCommit?: string };
  };
  return {
    id: raw.source.name,
    schemaVersion: raw.schemaVersion,
    sourceCommit: raw.source.sourceCommit ?? "",
  };
})();

async function encodePlanWireToHash(wire: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const buf = await new Response(
    readable.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const arr = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i] as number);
  }
  const b64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `v1.${b64}`;
}

// Targets [copper_powder, liquid_copper] make copper_powder dual-listed:
// produced as a target and consumed by liquid_copper. copper_powder total
// demand is liquid_copper's draw plus the copper_powder target rate, so any
// cap below that surfaces an input node beside the target output node.
async function makeDualListedPlanHash(): Promise<string> {
  return encodePlanWireToHash({
    pack: [PACK_META.id, PACK_META.schemaVersion, PACK_META.sourceCommit],
    title: "",
    targets: [
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { recipeId: "liquid_copper", ratePerSec: { num: "1", denom: "2" } },
    ],
  });
}

function inputRows(page: Page) {
  return page.locator('[data-testid="input-row"]');
}

async function clickAddInput(page: Page): Promise<void> {
  await page.getByRole("button", { name: TEXT.addInput }).click();
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
  test("Test 1: Add input row defaults to first unused itemId (lex-sorted)", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    await expect(inputRows(page)).toHaveCount(initialCount + 1);

    // The new row is appended at the end; its item picker defaults to the
    // first lex-sorted unused id. The default plan ships no itemOverrides, so
    // the first lex item in the pack is the expected pick.
    const newRow = inputRows(page).nth(initialCount);
    const select = newRow.getByRole("combobox", { name: TEXT.itemLabel });
    await expect(select).toHaveValue(FIRST_LEX_ITEM_ID);

    await expectNoConsoleErrors(log);
  });

  test("Test 2: Remove input row drops the row and refreshes the canvas", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    await clickAddInput(page);
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

  test("Test 3: Duplicate-guard surfaces error and does not propagate", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    await clickAddInput(page);
    await expect(inputRows(page)).toHaveCount(initialCount + 2);

    // First added row already holds FIRST_LEX_ITEM_ID (default pick).
    // Second added row holds SECOND_LEX_ITEM_ID (next unused lex id).
    // Force the second row's picker to FIRST_LEX_ITEM_ID to trigger the dup.
    const secondAddedRow = inputRows(page).nth(initialCount + 1);
    const secondSelect = secondAddedRow.getByRole("combobox", {
      name: TEXT.itemLabel,
    });

    // Sanity: confirm second row is the SECOND lex id (paired-default rule).
    await expect(secondSelect).toHaveValue(SECOND_LEX_ITEM_ID);

    const urlBefore = page.url();

    await secondSelect.selectOption(FIRST_LEX_ITEM_ID);

    // Per-row duplicate alert appears on the offending row.
    const alert = secondAddedRow.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(TEXT.duplicateAlert);

    // onChange did NOT propagate: URL hash unchanged after the duplicate pick.
    // Give the App a tick to debounce, then re-verify.
    await page.waitForTimeout(COMMIT_DEBOUNCE_MS);
    expect(page.url()).toBe(urlBefore);

    // The select control itself reflects the user's literal click (browser
    // <select> updates its DOM value even though onChange was rejected). The
    // load-bearing assertion is the unchanged URL above.

    await expectNoConsoleErrors(log);
  });

  test("Test 4: Cap a rate, then clear it (commits as uncap)", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    // Seed the dual-listed plan so copper_powder is consumed in-graph (by
    // liquid_copper) and an input override on it surfaces a boundary input node.
    await page.goto(`/#${await makeDualListedPlanHash()}`, {
      waitUntil: "load",
    });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    const newRow = inputRows(page).nth(initialCount);

    // Use copper_powder: a target output of the seeded plan that is also
    // consumed by liquid_copper, so the override renders an input node. The
    // dual-listing render is asserted in Test 6; here we only check rate commit.
    const select = newRow.getByRole("combobox", { name: TEXT.itemLabel });
    await select.selectOption("copper_powder");

    const rateInput = newRow.getByRole("textbox", { name: TEXT.rateLabel });

    // Set a rate of 30/min. After debounce the URL hash updates and
    // the input ProductNode renders with the cap badge.
    const urlAfterItem = page.url();
    await rateInput.fill("30");
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterItem);

    const copperPowderInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
    );
    await expect(copperPowderInput).toBeAttached();
    // The node renders the cap (30/min) once the override commits.
    await expect(copperPowderInput).toContainText("/分");

    const urlAfterCap = page.url();

    // Clear the rate field: empty string commits as uncap (override remains
    // but without ratePerSec). URL hash should change again.
    await rateInput.fill("");
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
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    const newRow = inputRows(page).nth(initialCount);

    // copper_ore is a raw boundary input for the default plan; set a cap well
    // above the actual demand (default copper_bottle demand is small).
    const select = newRow.getByRole("combobox", { name: TEXT.itemLabel });
    await select.selectOption("copper_ore");

    const urlAfterItem = page.url();

    const rateInput = newRow.getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("9999");

    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterItem);

    // The input ProductNode for copper_ore still renders, no error banner.
    const copperOreInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_ore"]',
    );
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
    await page.goto(`/#${await makeDualListedPlanHash()}`, {
      waitUntil: "load",
    });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    const newRow = inputRows(page).nth(initialCount);

    // copper_powder is a target output AND is consumed by liquid_copper in the
    // seeded plan. Adding it as an input override with a finite rate cap (below
    // its total demand) triggers the dual-emission rule: both the input
    // ProductNode (cyan) and the output ProductNode (lime) must render.
    const select = newRow.getByRole("combobox", { name: TEXT.itemLabel });
    await select.selectOption("copper_powder");

    const urlAfterItem = page.url();
    const rateInput = newRow.getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("6"); // 6/min == 0.1/s, well under default demand.

    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlAfterItem);

    await waitForCanvasReady(page);

    const copperPowderInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
    );
    const copperPowderOutput = page.locator(
      '[data-testid="product-node"][data-flavor="outputProduct"][data-item-id="copper_powder"]',
    );

    await expect(copperPowderInput).toBeAttached();
    await expect(copperPowderOutput).toBeAttached();

    await expectNoConsoleErrors(log);
  });
});
