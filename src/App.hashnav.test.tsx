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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

// Stub Canvas so the test can read the layoutGeneration prop App threads into
// it. The real Canvas mounts React Flow, which is irrelevant to hash-nav
// behaviour and only slows these tests down.
const canvasSpy = vi.hoisted(() => ({ layoutGeneration: -1 }));
vi.mock("./canvas/Canvas", () => ({
  default: (props: { layoutGeneration?: number }) => {
    canvasSpy.layoutGeneration = props.layoutGeneration ?? -1;
    return null;
  },
}));

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

test("hash navigation bumps the layout generation", async () => {
  render(<App />);

  const rowsA = await screen.findAllByTestId("target-row");
  expect(rowsA.length).toBe(3);
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  const genAfterMount = canvasSpy.layoutGeneration;
  expect(genAfterMount).toBeGreaterThan(0);

  window.location.hash = await encodePlanB();
  await waitFor(() =>
    expect(screen.getAllByTestId("target-row").length).toBe(2),
  );
  expect(canvasSpy.layoutGeneration).toBeGreaterThan(genAfterMount);
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

test("a bad mount hash shows a themed recovery screen with a human message", async () => {
  window.location.hash = "#v1.%%%not-base64%%%";
  render(<App />);

  const alert = await screen.findByRole("alert");
  // Rendered inside the themed app shell, not a bare white page.
  expect(alert.closest(".ak-app-shell")).not.toBeNull();
  // Primary line is the human message, with the technical detail demoted but
  // still present.
  expect(alert.textContent).toContain("damaged");
  expect(alert.textContent).toMatch(/hash|parse/i);
  // Recovery action present.
  expect(
    screen.getByRole("button", { name: /fresh plan/i }),
  ).not.toBeNull();
});

test("the fresh-plan recovery action clears the hash and loads the default plan", async () => {
  window.location.hash = "#v1.%%%not-base64%%%";
  render(<App />);
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: /fresh plan/i }));

  await waitFor(() =>
    expect(screen.getAllByTestId("target-row").length).toBe(3),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(window.location.hash).not.toContain("%%%");
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

test("a second bad hash while the recovery screen is up refreshes the screen", async () => {
  // First bad hash on mount: nothing is rendered, so the failure owns the
  // whole viewport.
  window.location.hash = "#v1.%%%not-base64%%%";
  render(<App />);

  const first = await screen.findByRole("alert");
  expect(first.textContent).toMatch(/parse/i);

  // A second bad hash pasted over the recovery screen must update it. Routing
  // this to the dismissible banner instead would put the message on a surface
  // the recovery screen never renders, leaving the first message frozen.
  window.location.hash = "#v9.abcdef";

  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(/v9/),
  );
  // Still the full-screen recovery surface, recovery action included.
  expect(screen.getByRole("button", { name: /fresh plan/i })).not.toBeNull();
});
