// @vitest-environment jsdom
//
// Error-surface behaviour: a solver exception during a mutation maps to a
// localized banner that names the implicated item (not raw dev-speak), and the
// stale-canvas ERROR status persists after the banner is dismissed until the
// next successful solve. layoutRenderPlan is mocked to resolve instantly and
// Canvas is stubbed to expose the status prop.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

const canvasSpy = vi.hoisted(() => ({ status: "" }));
vi.mock("./canvas/Canvas", () => ({
  default: (props: { status?: string }) => {
    canvasSpy.status = props.status ?? "";
    return null;
  },
}));

// Delegate to the real solver, but throw an LpInfeasibleError on demand so a
// mutation can fail deterministically (real packs never go infeasible).
const solverGate = vi.hoisted(() => ({ throwNext: false }));
vi.mock("./solver", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./solver")>();
  return {
    ...orig,
    solvePlanWithIntermediates: (
      ...args: Parameters<typeof orig.solvePlanWithIntermediates>
    ) => {
      if (solverGate.throwNext) {
        throw new orig.LpInfeasibleError(["liquid_water"], ["copper_bottle"]);
      }
      return orig.solvePlanWithIntermediates(...args);
    },
  };
});

import App from "./App";
import { loadI18n } from "./data/i18n";

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
  window.localStorage.setItem("aef.locale", "en");
  solverGate.throwNext = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  solverGate.throwNext = false;
  window.location.hash = "";
});

function editFirstTargetRate(value: string) {
  const targetsSection = screen.getByTestId("targets-section");
  const inputs = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  fireEvent.change(inputs[0]!, { target: { value } });
  fireEvent.blur(inputs[0]!);
}

test("an infeasible mutation banner names the implicated item, not dev-speak", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  solverGate.throwNext = true;
  editFirstTargetRate("240");

  const banner = await screen.findByRole("alert");
  const waterName = loadI18n("en").displayName("liquid_water");
  expect(banner.textContent).toContain(waterName);
  // No raw solver dev-speak leaks through.
  expect(banner.textContent).not.toContain("LP solver");
  expect(banner.textContent).not.toContain("infeasible problem");
});

test("stale ERROR status persists after dismiss, then clears on a successful solve", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  solverGate.throwNext = true;
  editFirstTargetRate("240");

  await screen.findByRole("alert");
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  // Dismiss the banner: it disappears but the stale ERROR marker remains.
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(canvasSpy.status).toBe("ERROR");
  expect(screen.getByTestId("header-strip").textContent).toContain("ERROR");

  // A successful solve clears the stale marker back to READY.
  solverGate.throwNext = false;
  editFirstTargetRate("120");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a load failure routes through the load wrapper, not the solver wrapper", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  window.location.hash = "#v1.%%%not-base64%%%";
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  const banner = await screen.findByRole("alert");
  // The load wrapper ("Failed to load plan: ...") - never the solver wrapper.
  expect(banner.textContent).toContain("Failed to load plan");
  expect(banner.textContent).not.toContain("Solver error");
});
