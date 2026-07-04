import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// The chip tooltip only shows if the chip itself accepts pointer events; the
// edgelabel-renderer that portals the chip sets pointer-events:none, so the
// .flow-chip rule must re-enable them explicitly.
test("flow chips re-enable pointer events for the hover tooltip", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/canvas/canvas.css"),
    "utf8",
  );
  const block = css.match(/\.flow-chip\s*\{[^}]*\}/);
  expect(block).not.toBeNull();
  expect(block![0]).toMatch(/pointer-events:\s*auto/);
});
