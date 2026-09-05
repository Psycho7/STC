// @vitest-environment jsdom
//
// Error boundary: a throw in the render phase must degrade to a recoverable
// screen instead of a blank page. React unmounts the whole tree on an uncaught
// render error, so without a boundary the user is left with nothing and no way
// back. Canvas is mocked to throw because it is the deepest subtree App owns;
// the boundary is agnostic about where the throw came from.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

vi.mock("./canvas/Canvas", () => ({
  default: () => {
    throw new Error("canvas exploded");
  },
}));

import App from "./App";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // React and jsdom both log the caught render error; the boundary handling it
  // is the assertion, so keep the noise out of the run.
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

test("a render-phase throw lands on the themed recovery screen, not a blank page", async () => {
  render(<App />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/unexpected error/i);
  // Themed shell, not a bare white page.
  expect(alert.closest(".ak-app-shell")).not.toBeNull();
  // Localized through the provider the boundary sits inside, and with a way
  // out of the crash.
  expect(screen.getByRole("button", { name: /fresh plan/i })).not.toBeNull();
});
