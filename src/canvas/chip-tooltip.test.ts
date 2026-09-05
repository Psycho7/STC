import { expect, test } from "vitest";

import { cssBlock } from "../../test/canvas/cssContract";

// The chip tooltip only shows if the chip itself accepts pointer events; the
// edgelabel-renderer that portals the chip sets pointer-events:none, so the
// .flow-chip rule must re-enable them explicitly.
test("flow chips re-enable pointer events for the hover tooltip", () => {
  expect(cssBlock(".flow-chip")).toMatch(/pointer-events:\s*auto/);
});
