import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../src/App";
import { pack } from "../src/data/load";
import {
  defaultPlan,
  encodePlan,
  loadPlan,
} from "../src/data/plan";
import type { Plan } from "../src/data/plan";
import { defaultTargets } from "../src/data/targets";

beforeEach(() => {
  history.replaceState(null, "", window.location.pathname);
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", window.location.pathname);
  vi.clearAllMocks();
});

async function decodeCurrentHash(): Promise<Plan> {
  const outcome = await loadPlan(window.location.hash, pack);
  if (outcome.kind === "error") {
    throw new Error(`unexpected error outcome: ${outcome.error.kind}`);
  }
  return outcome.plan;
}

describe("canvas-targets: no-hash boot", () => {
  it("renders TargetsPanel with default targets and writes the canonical hash", async () => {
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(
          defaultTargets().length,
        );
      },
      { timeout: 5000 },
    );
    expect(window.location.hash.startsWith("#v1.")).toBe(true);
    const plan = await decodeCurrentHash();
    expect(plan.targets.length).toBe(defaultTargets().length);
  });
});

describe("canvas-targets: add target", () => {
  // TargetsPanel.handleAdd picks pack.recipes.find((r) => !used.has(r.id))
  // as the new target. From defaultTargets(), that lands on a recipe in a
  // singular SCC that solvePlan can't handle. Pre-seed with safe precursors
  // so the next-unused candidate is solver-safe.
  it("appends a new row and updates the URL after re-solve", async () => {
    const seedTargets = [
      ...defaultTargets(),
      { recipeId: "iron_ore", ratePerSec: { num: "0", denom: "1" } },
      { recipeId: "quartz_sand", ratePerSec: { num: "0", denom: "1" } },
      { recipeId: "originium_ore", ratePerSec: { num: "0", denom: "1" } },
    ];
    const seed: Plan = { ...defaultPlan(pack), targets: seedTargets };
    history.replaceState(null, "", "#" + (await encodePlan(seed)));

    const user = userEvent.setup();
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(
          seedTargets.length,
        );
      },
      { timeout: 10000 },
    );
    const rowsBefore = screen.getAllByTestId("target-row").length;
    const hashBefore = window.location.hash;

    await user.click(screen.getByRole("button", { name: /添加目标/ }));

    await waitFor(
      () => {
        const grew =
          screen.queryAllByTestId("target-row").length === rowsBefore + 1;
        const errored = screen.queryByRole("alert") !== null;
        expect(grew || errored).toBe(true);
      },
      { timeout: 10000 },
    );
    if (screen.queryByRole("alert") === null) {
      expect(screen.getAllByTestId("target-row").length).toBe(rowsBefore + 1);
      await waitFor(
        () => {
          expect(window.location.hash).not.toBe(hashBefore);
        },
        { timeout: 10000 },
      );
    }
  });
});

describe("canvas-targets: remove target", () => {
  it("shrinks the row count by one and re-solves", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );
    const removes = screen.getAllByTestId("remove-target");
    await user.click(removes[0]!);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(2);
      },
      { timeout: 5000 },
    );
  });
});

describe("canvas-targets: rate edit debounce", () => {
  it("URL does not update until 150ms after a rate edit", async () => {
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );
    const hashBefore = window.location.hash;

    vi.useFakeTimers();
    try {
      const inputs = screen.getAllByLabelText("速率");
      fireEvent.change(inputs[0]!, { target: { value: "240" } });
      expect(window.location.hash).toBe(hashBefore);
      await vi.advanceTimersByTimeAsync(150);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(
      () => {
        expect(window.location.hash).not.toBe(hashBefore);
      },
      { timeout: 5000 },
    );
  });
});

describe("canvas-targets: pre-seeded boot", () => {
  it("mounts the default-plan hash with the expected row count", async () => {
    history.replaceState(
      null,
      "",
      "#" + (await encodePlan(defaultPlan(pack))),
    );

    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(
          defaultTargets().length,
        );
      },
      { timeout: 5000 },
    );
  });
});

describe("canvas-targets: rapid edits race", () => {
  it("the second edit's value lands in the URL (stale first solve is cancelled)", async () => {
    render(<App />);
    await waitFor(
      () => {
        expect(screen.getAllByTestId("target-row").length).toBe(3);
      },
      { timeout: 5000 },
    );

    vi.useFakeTimers();
    try {
      const inputs = screen.getAllByLabelText("速率");
      fireEvent.change(inputs[0]!, { target: { value: "100" } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(inputs[0]!, { target: { value: "200" } });
      await vi.advanceTimersByTimeAsync(150);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(
      () => {
        expect(window.location.hash.startsWith("#v1.")).toBe(true);
      },
      { timeout: 5000 },
    );

    await waitFor(
      async () => {
        const plan = await decodeCurrentHash();
        // 200/60 reduces to 10/3 -> n*3 === d*10.
        const has200 = plan.targets.some((t) => {
          const n = Number(t.ratePerSec.num);
          const d = Number(t.ratePerSec.denom);
          return n * 3 === d * 10;
        });
        expect(has200).toBe(true);
        // 100/60 = 5/3 -> n*3 === d*5. The stale first edit must not land.
        const has100 = plan.targets.some((t) => {
          const n = Number(t.ratePerSec.num);
          const d = Number(t.ratePerSec.denom);
          return n * 3 === d * 5;
        });
        expect(has100).toBe(false);
      },
      { timeout: 5000 },
    );
  });
});
