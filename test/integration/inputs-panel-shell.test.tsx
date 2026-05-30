import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App";
import { pack } from "../../src/data/load";
import { defaultPlan, encodePlan } from "../../src/data/plan";
import type { Plan } from "../../src/data/plan";

beforeEach(() => {
  history.replaceState(null, "", window.location.pathname);
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", window.location.pathname);
  vi.clearAllMocks();
});

describe("inputs-panel-shell: side-panel layout", () => {
  it("renders both TargetsPanel and InputsPanel inside the side-panel container", async () => {
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );
    const sidePanel = screen.getByTestId("side-panel");
    expect(within(sidePanel).getByText("目标")).toBeInTheDocument();
    expect(within(sidePanel).getByText("输入")).toBeInTheDocument();
  });

  it("editing an input row's rate triggers a re-solve that updates the URL", async () => {
    const seed: Plan = {
      ...defaultPlan(pack),
      itemOverrides: [{ itemId: "copper_ore" }],
    };
    history.replaceState(null, "", "#" + (await encodePlan(seed)));

    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("input-row").length).toBe(1);
      },
      { timeout: 10000 },
    );
    const hashBefore = window.location.hash;

    vi.useFakeTimers();
    try {
      const rateInputs = screen.getAllByLabelText("速率");
      const inputRate = rateInputs[rateInputs.length - 1]!;
      fireEvent.change(inputRate, { target: { value: "300" } });
      await vi.advanceTimersByTimeAsync(150);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(
      () => {
        expect(window.location.hash).not.toBe(hashBefore);
      },
      { timeout: 10000 },
    );
  });
});

describe("inputs-panel-shell: mutationError placement", () => {
  it("renders mutationError inside the header strip, not the side panel", async () => {
    const solverModule = await import("../../src/solver");
    const spy = vi.spyOn(solverModule, "solvePlanWithIntermediates");

    const user = userEvent.setup();
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );

    spy.mockImplementationOnce(() => {
      throw new Error("forced-solver-failure");
    });

    const removes = screen.getAllByTestId("remove-target");
    await user.click(removes[0]!);

    const alert = await screen.findByText(
      /forced-solver-failure/,
      {},
      { timeout: 5000 },
    );
    const header = screen.getByTestId("header-strip");
    const sidePanel = screen.queryByTestId("side-panel");
    expect(header.contains(alert)).toBe(true);
    if (sidePanel) expect(sidePanel.contains(alert)).toBe(false);

    spy.mockRestore();
  });
});
