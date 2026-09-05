import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/data/plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/plan")>();
  return {
    ...actual,
    loadPlan: vi.fn(actual.loadPlan),
  };
});

import App from "../src/App";
import { pack } from "../src/data/load";
import { defaultPlan, encodePlan, loadPlan } from "../src/data/plan";

beforeEach(() => {
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "zh");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", window.location.pathname);
  vi.clearAllMocks();
});

async function waitForCanvasReady() {
  await waitFor(() => {
    expect(screen.queryByText("正在加载布局...")).toBeNull();
  });
}

describe("canvas-share: load on mount", () => {
  it("decodes an inbound hash and routes through loadPlan", async () => {
    const plan = defaultPlan(pack);
    const hash = await encodePlan(plan);
    history.replaceState(null, "", "#" + hash);

    render(<App />);
    await waitForCanvasReady();

    await waitFor(() => {
      expect(screen.getAllByTestId("target-row").length).toBe(
        plan.targets.length,
      );
    });
    expect(loadPlan).toHaveBeenCalledTimes(1);
  });
});
