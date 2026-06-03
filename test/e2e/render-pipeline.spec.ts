import { test, expect, type ConsoleMessage } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1000 } });

const CONSOLE_ERROR_ALLOWLIST: ReadonlyArray<string | RegExp> = [];

function attachConsoleErrorListener(page: import("@playwright/test").Page): {
  errors: string[];
} {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const allowed = CONSOLE_ERROR_ALLOWLIST.some((p) =>
      typeof p === "string" ? text.includes(p) : p.test(text),
    );
    if (!allowed) errors.push(text);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return { errors };
}

test.describe("render pipeline e2e gate", () => {
  test("boots default AEF plan, renders pipeline nodes, edges with item-rate labels, no console errors", async ({
    page,
  }, testInfo) => {
    const { errors } = attachConsoleErrorListener(page);

    await page.goto("/", { waitUntil: "load" });

    const canvas = page.locator(".react-flow");
    // Without the fold pipeline, the render policy emits one unit per machine
    // vertex; recipe and loop are the only pipeline node kinds.
    const pipelineNode = canvas
      .locator(".react-flow__node-recipe, .react-flow__node-loop")
      .first();
    await expect(pipelineNode).toBeVisible({ timeout: 20_000 });

    const itemEdgeLabel = canvas
      .locator('[data-testid^="item-edge-label-"]')
      .first();
    await expect(itemEdgeLabel).toBeVisible();
    await expect(itemEdgeLabel).toContainText("/分");

    const rowsBefore = await page.locator('[data-testid="target-row"]').count();
    const addBtn = page.getByRole("button", { name: "添加目标" });
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.locator('[data-testid="target-row"]')).toHaveCount(
      rowsBefore + 1,
    );
    await expect(pipelineNode).toBeVisible();

    const png = await page.screenshot({
      path: "test-results/render-pipeline-default.png",
      fullPage: false,
    });
    await testInfo.attach("render-pipeline.png", {
      body: png,
      contentType: "image/png",
    });

    expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual(
      [],
    );
  });
});
