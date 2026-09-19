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
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "zh");
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", window.location.pathname);
  vi.clearAllMocks();
});

describe("inputs-panel-shell: side-panel layout", () => {
  it("renders both section heads with their counts inside the side-panel container", async () => {
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        expect(screen.getAllByTestId("input-auto-row").length).toBeGreaterThan(
          0,
        );
      },
      { timeout: 10000 },
    );
    const sidePanel = screen.getByTestId("side-panel");
    const targetsHead = within(sidePanel).getByTestId("targets-head");
    const inputsHead = within(sidePanel).getByTestId("inputs-head");
    // Both heads are siblings of the one scroll body, which is what lets them
    // stack and keep both counts on screen at any scroll offset.
    expect(targetsHead.parentElement).toBe(inputsHead.parentElement);
    expect(targetsHead.parentElement?.className).toContain("side-panel-scroll");
    // The default plan has three targets; the supply count is whatever the
    // panel shows, and the point here is that both heads carry one.
    expect(targetsHead.querySelector(".count .v")?.textContent).toBe("3");
    const supplyCount = inputsHead.querySelector(".count .v")?.textContent;
    expect(Number(supplyCount)).toBeGreaterThan(0);

    // The supply section carries its two labelled blocks, each with its own
    // row count: no override is declared on the default plan, so everything
    // the plan draws sits under Assumed unlimited.
    const supplies = within(sidePanel).getByTestId("inputs-block-supplies");
    const assumed = within(sidePanel).getByTestId("inputs-block-assumed");
    expect(supplies.querySelector(".n")?.textContent).toBe("0 行");
    const assumedRows = screen.getAllByTestId("input-auto-row").length;
    expect(assumed.querySelector(".n")?.textContent).toBe(`${assumedRows} 行`);
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

    const rateFields = screen.getAllByLabelText("速率");
    const inputRate = rateFields[rateFields.length - 1]!;
    fireEvent.change(inputRate, { target: { value: "300" } });
    // Commit on blur re-solves and rewrites the URL.
    fireEvent.blur(inputRate);

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
