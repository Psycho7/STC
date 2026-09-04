// @vitest-environment jsdom
//
// Bus-lanes toggle wiring: the topbar switch drives layoutRenderPlan's
// busLanesEnabled input through the solve path, persists to localStorage, and
// never touches the plan hash (a view preference, not plan state).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

import App from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";

function lastLayoutArg(): { busLanesEnabled?: boolean } {
  const calls = vi.mocked(layoutRenderPlan).mock.calls;
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  window.localStorage.clear();
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function renderReady(): Promise<void> {
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });
}

test("defaults to disabled and passes busLanesEnabled: false to layout", async () => {
  await renderReady();
  expect(lastLayoutArg().busLanesEnabled).toBe(false);
  expect(screen.getByTestId("bus-lanes-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("clicking the toggle re-lays-out with busLanesEnabled: true and persists", async () => {
  await renderReady();
  const hashBefore = window.location.hash;

  fireEvent.click(screen.getByTestId("bus-lanes-toggle"));

  await waitFor(() => {
    expect(lastLayoutArg().busLanesEnabled).toBe(true);
  });
  expect(screen.getByTestId("bus-lanes-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(window.localStorage.getItem("aef.busLanes")).toBe("on");
  // View preference only: the plan hash is untouched by the flip.
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });
  expect(window.location.hash).toBe(hashBefore);

  // And back off.
  fireEvent.click(screen.getByTestId("bus-lanes-toggle"));
  await waitFor(() => {
    expect(lastLayoutArg().busLanesEnabled).toBe(false);
  });
  expect(window.localStorage.getItem("aef.busLanes")).toBe("off");
});

test("a stored 'on' preference enables bus lanes from the first layout", async () => {
  window.localStorage.setItem("aef.busLanes", "on");
  await renderReady();
  expect(lastLayoutArg().busLanesEnabled).toBe(true);
  expect(screen.getByTestId("bus-lanes-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
