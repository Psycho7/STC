import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import App from "../../src/App";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import { defaultTargets } from "../../src/data/targets";
import { RENDER_UNIT_KINDS } from "../../src/pipeline/types";

beforeEach(() => {
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "zh");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

describe("integration: App boots end-to-end via the new pipeline", () => {
  it("renders at least one React Flow node without console errors", async () => {
    const consoleErrors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    try {
      const result = render(<App />);
      // The loading splash clears as soon as the plan solves, but React Flow
      // nodes only mount after the async layout pass lands, so poll for the
      // nodes themselves instead of asserting once after the splash goes away.
      await waitFor(
        () => {
          expect(result.queryByText("正在加载布局...")).toBeNull();
          const nodes = result.container.querySelectorAll(
            ".react-flow__node[data-id]",
          );
          expect(nodes.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      expect(consoleErrors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("integration: render plan emits only MVP unit kinds", () => {
  it("contains no fold-era or other legacy unit kinds", () => {
    const { plan } = solveForRender({ targets: defaultTargets(), pack });
    const allowed = new Set<string>(RENDER_UNIT_KINDS);
    for (const u of plan.units) {
      expect(allowed.has(u.kind)).toBe(true);
    }
  });
});
