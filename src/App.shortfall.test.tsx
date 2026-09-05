// @vitest-environment jsdom
//
// A plan the LP cannot fully satisfy must say so. Capping a raw input below
// what the targets need is not an LP infeasibility -- the model funds a deficit
// column and returns a partial plan -- so nothing throws and the header would
// otherwise read READY over a graph that delivers less than it declares. The
// production check is the render-side compare of declared target rate against
// inbound edge rate, surfaced as a non-dismissible status strip.
//
// DEV is stubbed off for the whole file: the DEV-only render-invariant hook
// throws on exactly these plans, which would mask the production surface under
// test. layoutRenderPlan is mocked away and Canvas is stubbed; neither is part
// of the behaviour here.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

import App from "./App";
import { defaultPlan, encodePlan, validatePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";

// copper_jar at 1/s needs more inert gas than the 1/2 per second cap allows,
// and no recipe produces gas_inert, so the shortfall cannot be routed around.
const CAPPED: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "copper_jar", ratePerSec: { num: "1", denom: "1" } }],
  itemOverrides: [
    { itemId: "gas_inert", ratePerSec: { num: "1", denom: "2" } },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("DEV", false);
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.location.hash = "";
});

test("a target fed below its declared rate raises a status strip naming it", async () => {
  expect(validatePlan(CAPPED, pack)).toBeNull();
  window.location.hash = "#" + (await encodePlan(CAPPED));
  render(<App />);

  await screen.findAllByTestId("target-row");

  // The strip names the under-delivered target, which is what the compare
  // yields; the cap that starved it is one row down in the Inputs panel.
  const strip = await screen.findByRole("status");
  const jarName = loadI18n("en").displayName("copper_jar");
  expect(strip.textContent).toContain(jarName);
  // The plan still draws: this is a warning about the graph, not a failure
  // that replaces it.
  expect(screen.getAllByTestId("target-row").length).toBe(1);
  // It is not the dismissible error banner, and it does not mark the canvas
  // stale: the render matches the solve, the solve just falls short.
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a satisfiable plan raises no status strip", async () => {
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("status")).toBeNull();
});
