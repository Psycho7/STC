// @vitest-environment jsdom
//
// End-to-end guard that App commits plan state synchronously: a second rate
// edit made while the first edit's solve is still in flight must not revert
// the first edit, and both edits must reach the encoded URL hash.
//
// The solve window is made deterministic by mocking layoutRenderPlan with a
// manually resolved deferred, so no real-timing race window is involved.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const layoutGate = vi.hoisted(() => ({
  pending: [] as Array<() => void>,
}));

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(
      () =>
        new Promise((resolve) => {
          layoutGate.pending.push(() => resolve({ nodes: [], edges: [] }));
        }),
    ),
  };
});

import App from "./App";
import { loadPlan } from "./data/plan";
import { pack } from "./data/load";

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none, and
  // without the stub React 19 tears the whole tree down on mount.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  layoutGate.pending.length = 0;
  window.location.hash = "";
});

test("second edit during an in-flight solve keeps both edits and the hash", async () => {
  render(<App />);

  // Initial load of the seeded default plan; release its layout.
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  const hashAfterLoad = window.location.hash;

  const targetsSection = screen.getByTestId("targets-section");
  const inputs = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  expect(inputs.length).toBe(3);
  expect(inputs[0]!.value).toBe("120"); // copper_bottle 2/s
  expect(inputs[1]!.value).toBe("30"); // copper_powder 1/2 per sec

  // Edit 1: row 0 -> 600/min. After the debounce the commit must land in plan
  // state synchronously, while the solve (gated layout) is still pending.
  fireEvent.change(inputs[0]!, { target: { value: "600" } });
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  expect(inputs[0]!.value).toBe("600");

  // Edit 2: row 1 -> 99/min while solve 1 has not landed.
  fireEvent.change(inputs[1]!, { target: { value: "99" } });
  await waitFor(() => expect(layoutGate.pending.length).toBe(2));
  expect(inputs[0]!.value).toBe("600");
  expect(inputs[1]!.value).toBe("99");

  // Release both solves in order; the newest generation wins.
  layoutGate.pending.shift()!();
  layoutGate.pending.shift()!();

  await waitFor(() => expect(window.location.hash).not.toBe(hashAfterLoad));
  const outcome = await loadPlan(window.location.hash, pack);
  expect(outcome.kind).toBe("loaded");
  if (outcome.kind !== "loaded") return;
  const byId = new Map(
    outcome.plan.targets.map((t) => [t.recipeId, t.ratePerSec]),
  );
  expect(byId.get("copper_bottle")).toEqual({ num: "10", denom: "1" });
  expect(byId.get("copper_powder")).toEqual({ num: "33", denom: "20" });
  expect(byId.get("iron_powder")).toEqual({ num: "1", denom: "4" });
  expect(inputs[0]!.value).toBe("600");
  expect(inputs[1]!.value).toBe("99");
});
