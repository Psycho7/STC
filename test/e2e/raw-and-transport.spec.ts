import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import type { ItemOverride } from "../../src/data/plan";
import { planHash } from "./plan-hash";

test.use({ viewport: { width: 1600, height: 1000 } });

async function makeHashForCopperNugget(
  itemOverrides?: ItemOverride[],
): Promise<string> {
  const targets = [
    { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
  ];
  return planHash(
    itemOverrides && itemOverrides.length > 0
      ? { targets, itemOverrides }
      : { targets },
  );
}

// Mirrors the existing render-pipeline spec: capture console errors AND
// console warnings (the `Handle: No node id` regression class shows up at
// warning level, not error).
type ConsoleLog = { errors: string[]; warnings: string[] };
const CONSOLE_ALLOWLIST: ReadonlyArray<string | RegExp> = [
  // Vite injects a `[vite] connecting...` info message; not relevant here.
];

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

// Wait for the React Flow canvas to render at least one node so subsequent
// assertions don't race the initial pipeline pass.
async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 20_000 });
}

test.describe("raw-product boundaries and transport-kind styling", () => {
  test("default plan with target copper_nugget: copper_ore input product visible, miner_4 recipe NOT visible", async ({
    page,
  }, testInfo) => {
    const log = attachConsoleListener(page);
    const hash = await makeHashForCopperNugget();
    await page.goto(`/#${hash}`, { waitUntil: "load" });

    await waitForCanvasReady(page);

    // copper_ore is raw -> input ProductNode renders at the boundary. Use
    // toBeAttached because React Flow may pan/zoom such that the node is in
    // the DOM but outside the visible viewport.
    const copperOreInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_ore"]',
    );
    await expect(copperOreInput).toBeAttached();

    // liquid_water is raw -> also an input product, with a pipe glyph.
    const liquidWaterInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="liquid_water"]',
    );
    await expect(liquidWaterInput).toBeAttached();

    // The miner_4 producer's recipe (id: copper_ore-liquid_water) is NOT in
    // the graph: the walk terminates at the raw items above. React Flow tags
    // each node with data-id=<unitId>; recipe unit ids are u:<recipeId>.
    const minerRecipeNode = page.locator(
      '.react-flow__node[data-id^="u:r:copper_ore-liquid_water"]',
    );
    await expect(minerRecipeNode).toHaveCount(0);

    const png = await page.screenshot({
      path: "test-results/raw-and-transport-default.png",
      fullPage: false,
    });
    await testInfo.attach("raw-and-transport-default.png", {
      body: png,
      contentType: "image/png",
    });

    expect(
      log.errors,
      `unexpected console errors:\n${log.errors.join("\n")}`,
    ).toEqual([]);
  });

  test("override copper_ore plan:true: no miner_4 recipe, the plan takes the gas route", async ({
    page,
  }, testInfo) => {
    const log = attachConsoleListener(page);
    const hash = await makeHashForCopperNugget([
      { itemId: "copper_ore", plan: true },
    ]);
    await page.goto(`/#${hash}`, { waitUntil: "load" });

    await waitForCanvasReady(page);

    // Asking for copper_ore to be built pulls in no producer: the only recipe
    // that makes it runs on miner_4, a machine placed on a map deposit rather
    // than on the factory floor, and no plan may build one. After the bisim
    // hash-cons stage replica ids are rewritten to synthetic quotient ids
    // (`q:N`), so match on the recipe-node's `data-recipe-id` attribute
    // (stamped by RecipeNode.tsx), which survives that rewrite.
    const minerRecipeNode = page.locator(
      '[data-testid="recipe-node"][data-recipe-id="copper_ore-liquid_water"]',
    );
    await expect(minerRecipeNode).toHaveCount(0);

    // The ore is neither built nor imported - plan:true asked for it to be
    // built - so it leaves the plan together with the furnace route it fed, and
    // draws no boundary node of its own. What is left is the phase-transition
    // route, whose xiranite draw is covered by the next assertion. The rest of
    // the demand goes unmet, which the stats strip reports.
    const copperOreInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="copper_ore"]',
    );
    await expect(copperOreInput).toHaveCount(0);

    // The phase-transition route's only gas_xiranite use is the transmuter
    // catalyst, which is charged against the item cap rather than routed as a
    // material input, so it draws no boundary node. The draw surfaces in the
    // inputs panel instead, as an auto supply row on the item.
    const gasXiraniteInput = page.locator(
      '[data-testid="product-node"][data-flavor="inputProduct"][data-item-id="gas_xiranite"]',
    );
    await expect(gasXiraniteInput).toHaveCount(0);

    await page.getByTestId("side-panel-tab-inputs").click();
    const gasXiraniteSupply = page.locator(
      '[data-testid="input-auto-row"][data-item-id="gas_xiranite"]',
    );
    await expect(gasXiraniteSupply).toBeVisible();

    const png = await page.screenshot({
      path: "test-results/raw-and-transport-override.png",
      fullPage: false,
    });
    await testInfo.attach("raw-and-transport-override.png", {
      body: png,
      contentType: "image/png",
    });

    expect(
      log.errors,
      `unexpected console errors:\n${log.errors.join("\n")}`,
    ).toEqual([]);
  });

  test("edge stroke differentiates belt vs pipe by data-transport-kind", async ({
    page,
  }) => {
    // The default plan (copper_bottle + copper_powder + liquid_cleaner_1-sewage)
    // produces both edge kinds: copper_nugget / copper_powder edges run on
    // belts; liquid_sewage / liquid_water edges run on pipes. Using the
    // default plan keeps this test independent of the override-walk path.
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);

    // At least one belt edge and one pipe edge should be rendered. The
    // data-transport-kind attribute sits on the inner <path> via BaseEdge
    // prop-spread.
    const beltEdge = page
      .locator('.react-flow__edge-path[data-transport-kind="belt"]')
      .first();
    const pipeEdge = page
      .locator('.react-flow__edge-path[data-transport-kind="pipe"]')
      .first();

    await expect(beltEdge).toBeAttached();
    await expect(pipeEdge).toBeAttached();

    // Computed-style sanity: pipe edges carry a dasharray; belt edges do not.
    // The exact stroke color is encoded in ItemEdge.tsx and is intentionally
    // asserted via attribute rather than hex value so the test stays robust
    // to palette tweaks.
    const beltDash = await beltEdge.evaluate(
      (el) => getComputedStyle(el).strokeDasharray,
    );
    const pipeDash = await pipeEdge.evaluate(
      (el) => getComputedStyle(el).strokeDasharray,
    );
    expect(pipeDash).not.toEqual(beltDash);
    // Pipe dasharray must be a non-`none` value; belt is `none` or empty.
    expect(
      pipeDash === "none" || pipeDash === "" ? null : pipeDash,
    ).not.toBeNull();
  });

  test("console clean: no errors or warnings (including 'Handle: No node id') after load", async ({
    page,
  }) => {
    const log = attachConsoleListener(page);
    // Use the default plan: it boots the full pipeline (recipes, loops if
    // any, input products, output products, edges of both transport kinds)
    // without depending on the override-walk path. Any Handle / Node-context
    // regressions surface here.
    await page.goto("/", { waitUntil: "load" });
    await waitForCanvasReady(page);

    // Give React/React Flow a tick to flush any post-mount warnings before
    // we snapshot the console buffer.
    await page.waitForLoadState("networkidle");

    expect(
      log.errors,
      `unexpected console errors:\n${log.errors.join("\n")}`,
    ).toEqual([]);

    // Regression class to guard: React Flow logs `Handle: No node id` when a
    // <Handle> renders outside a Node context. ProductNode keeps its Handles
    // inside the node body, but assert explicitly so future refactors that
    // move Handles outside fail loud.
    const handleNoIdWarning = log.warnings.filter((w) =>
      /Handle:\s*No node id/i.test(w),
    );
    expect(
      handleNoIdWarning,
      `unexpected 'Handle: No node id' warnings:\n${handleNoIdWarning.join("\n")}`,
    ).toEqual([]);

    // All other warnings are also surfaced; we treat any warning as a
    // regression. If a benign warning shows up later, add it to
    // CONSOLE_ALLOWLIST rather than weakening this assertion.
    expect(
      log.warnings,
      `unexpected console warnings:\n${log.warnings.join("\n")}`,
    ).toEqual([]);
  });
});
