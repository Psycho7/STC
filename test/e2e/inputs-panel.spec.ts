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
} as const;

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
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "2" } },
    ],
  });
}

function inputRows(page: Page) {
  return page.locator('[data-testid="input-row"]');
}

async function clickAddInput(page: Page): Promise<void> {
  await page.getByRole("button", { name: TEXT.addInput }).click();
}

// Add now opens the picker instead of committing a row, so every "add a row"
// preamble is two steps: click Add, then click the item's tile. The locator is
// scoped to the dialog because data-item-id is also on canvas nodes and rows.
async function addInputRow(page: Page, itemId: string): Promise<void> {
  await clickAddInput(page);
  await page.locator(`.recipe-picker [data-item-id="${itemId}"]`).click();
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
  test("Test 1: Add opens the picker and a pick appends an uncapped override", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await clickAddInput(page);
    // No row yet: the picker is open and nothing has been committed.
    await expect(inputRows(page)).toHaveCount(initialCount);
    await expect(page.locator(".recipe-picker")).toBeVisible();
    const urlBefore = page.url();

    await page.locator('.recipe-picker [data-item-id="copper_powder"]').click();
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
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
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
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    await addInputRow(page, "copper_powder");
    await addInputRow(page, "iron_powder");
    await expect(inputRows(page)).toHaveCount(initialCount + 2);

    // Open the picker from the second row: the item the first row claims is
    // dimmed, so a duplicate cannot be picked at all.
    const secondRow = inputRows(page).nth(initialCount + 1);
    await secondRow.getByRole("button", { name: TEXT.itemLabel }).click();
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
    await page.goto(`/#${await makeDualListedPlanHash()}`, {
      waitUntil: "load",
    });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    const initialCount = await inputRows(page).count();
    // Use copper_powder: a target output of the seeded plan that is also
    // consumed by liquid_copper, so the override renders an input node. The
    // dual-listing render is asserted in Test 6; here we only check rate commit.
    await addInputRow(page, "copper_powder");
    const newRow = inputRows(page).nth(initialCount);

    const rateInput = newRow.getByRole("textbox", { name: TEXT.rateLabel });

    // Set a rate of 120/min. Once the commit lands the URL hash updates and
    // the input ProductNode renders with the cap badge.
    //
    // The value is deliberately at or above copper_powder's total demand. A cap
    // BELOW demand does not produce a partial import: the solver has to run the
    // in-graph producer for the shortfall anyway, and once that producer is on,
    // it makes the whole amount and draws nothing across the boundary, so no
    // input node exists to assert on. Only a cap the solver can satisfy
    // entirely by importing keeps the boundary node.
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
    await expect(copperPowderInput).toBeAttached();
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
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);
    await waitForInputsPanel(page);

    // copper_ore is a raw boundary input for the default plan, so it is an
    // auto-row and its tile is dimmed in the Add picker. Cap it by typing into
    // the auto-row instead. The value stays well above the actual demand
    // (roughly 270/min), which is the premise of this test.
    const autoRow = page.locator(
      '[data-testid="input-auto-row"][data-item-id="copper_ore"]',
    );
    await expect(autoRow).toHaveCount(1);

    const urlBeforeCap = page.url();
    const rateInput = autoRow.getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("9999");
    // fill() does not blur, and the panel commits only on blur or Enter.
    await rateInput.press("Enter");

    // Typing a cap promotes the auto-row into a real override row.
    await expect(
      page.locator('[data-testid="input-row"][data-item-id="copper_ore"]'),
    ).toHaveCount(1);
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeCap);

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

    // copper_powder is a target output AND is consumed by liquid_copper in the
    // seeded plan. An uncapped input override on it triggers the dual-emission
    // rule: both the input ProductNode (cyan) and the output ProductNode (lime)
    // must render.
    //
    // Uncapped is the load-bearing part, not an omission. With unlimited supply
    // the solver imports the whole amount and runs no in-graph producer, which
    // is what puts copper_powder across the boundary. Any finite cap it cannot
    // meet on its own forces the producer on, and the producer then covers the
    // whole demand and draws nothing across the boundary, so the input node
    // disappears.
    const urlBefore = page.url();
    await addInputRow(page, "copper_powder");

    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);

    await waitForCanvasReady(page);

    // A free-supply target item now also gets a dedicated passthrough import
    // unit (u:in:copper_powder:target) feeding its export directly, so a bare
    // inputProduct locator matches two nodes. Pin each input unit by its exact
    // React Flow data-id: the consumer-feeding input must render, and so must
    // the intentional target-feed passthrough.
    const copperPowderInput = page
      .locator('.react-flow__node[data-id="u:in:copper_powder"]')
      .locator(
        '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
      );
    const copperPowderTargetFeed = page
      .locator('.react-flow__node[data-id="u:in:copper_powder:target"]')
      .locator(
        '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_powder"]',
      );
    const copperPowderOutput = page.locator(
      '[data-testid="product-node"][data-flavor="outputProduct"][data-item-id="copper_powder"]',
    );

    await expect(copperPowderInput).toBeAttached();
    await expect(copperPowderTargetFeed).toBeAttached();
    await expect(copperPowderOutput).toBeAttached();

    await expectNoConsoleErrors(log);
  });
});
