// @vitest-environment jsdom
//
// Hash navigation guard: pasting a different plan's #v1.* URL into the address
// bar (hash-only navigation, no reload) must swap the rendered plan; a
// malformed hash must surface the dismissible error banner and keep the old
// plan; and app-initiated hash writes must never re-trigger a load.
//
// jsdom fires a real async hashchange event when window.location.hash is
// assigned, so the navigation tests exercise the same event path a browser
// does. layoutRenderPlan is mocked to an instantly-resolving spy so "how many
// solves ran" is observable as its call count.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const layoutSpy = vi.hoisted(() => ({
  calls: 0,
}));

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => {
      layoutSpy.calls += 1;
      return { nodes: [], edges: [] };
    }),
  };
});

import App from "./App";
import { defaultPlan, encodePlan, validatePlan } from "./data/plan";
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
  layoutSpy.calls = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

// Plan B: the default plan minus its last target. Cheap to solve and clearly
// distinguishable from plan A by target-row count.
async function encodePlanB(): Promise<string> {
  const a = defaultPlan(pack);
  const b = { ...a, targets: a.targets.slice(0, a.targets.length - 1) };
  if (validatePlan(b, pack)) throw new Error("plan B unexpectedly invalid");
  return "#" + (await encodePlan(b));
}

test("hashchange navigation to another plan's hash swaps the rendered plan", async () => {
  render(<App />);

  // Initial load seeds the default plan and writes its hash.
  const rowsA = await screen.findAllByTestId("target-row");
  expect(rowsA.length).toBe(3);
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  const hashB = await encodePlanB();
  expect(hashB).not.toBe(window.location.hash);
  // Address-bar navigation: jsdom fires hashchange asynchronously.
  window.location.hash = hashB;

  await waitFor(() =>
    expect(screen.getAllByTestId("target-row").length).toBe(2),
  );
});

test("malformed hash via hashchange shows the error banner and keeps the plan", async () => {
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  window.location.hash = "#v1.%%%not-base64%%%";

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toMatch(/hash|plan|load|solver/i);
  // Old plan still rendered.
  expect(screen.getAllByTestId("target-row").length).toBe(3);
});

test("hashchange to a valid hash recovers from a bad mount hash", async () => {
  // Mount with a malformed hash: the initial-load error screen takes over.
  window.location.hash = "#v1.%%%not-base64%%%";
  render(<App />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/hash|plan|load|solver/i);

  // Address-bar navigation to a valid plan hash must leave the error screen
  // and render that plan.
  window.location.hash = await encodePlanB();

  await waitFor(() =>
    expect(screen.getAllByTestId("target-row").length).toBe(2),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("app-initiated hash writes do not re-trigger a load", async () => {
  render(<App />);

  // Initial load: exactly one solve+layout, and the app writes the hash via
  // replaceState (which fires no hashchange).
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  expect(layoutSpy.calls).toBe(1);

  // A spurious hashchange event for the app-written hash (location.hash
  // already equals what the app wrote) must be ignored by the guard.
  window.dispatchEvent(
    new HashChangeEvent("hashchange", {
      oldURL: window.location.href,
      newURL: window.location.href,
    }),
  );
  await new Promise((r) => setTimeout(r, 25));
  expect(layoutSpy.calls).toBe(1);
});
