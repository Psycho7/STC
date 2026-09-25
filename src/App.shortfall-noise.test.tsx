// @vitest-environment jsdom
//
// The noise twin of App.shortfall.test.tsx. A plan whose targets the tolerant
// compare (targetOutputShortfalls, relSlack) holds as delivered can still
// carry a sub-tolerance entry in the LP's raw deficit map - the 1/666660 per
// second iron_powder residue the snapped recipe rate leaves behind is the
// model. The status gate reads the same tolerant under-delivery list the strip
// attribution does, so such a plan stays READY with no strip; the raw deficit
// map would flip it to SHORTFALL over float noise.
//
// The residue is injected at the solve seam because it is LP arithmetic noise,
// not a property of any shipped plan: the default plan solves clean in its
// default settlement, and wrapping solveFromPlan keeps every other layer
// (validation, availability, render) real. DEV, layout and Canvas are handled
// exactly as in App.shortfall.test.tsx, for the same reasons.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import Fraction from "fraction.js";

vi.mock("./pipeline/solveForRender", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("./pipeline/solveForRender")>();
  return {
    ...orig,
    solveFromPlan: (...args: Parameters<typeof orig.solveFromPlan>) => {
      const out = orig.solveFromPlan(...args);
      out.full.feasibility.deficits = new Map(
        out.full.feasibility.deficits,
      ).set("iron_powder", new Fraction(1, 666660));
      return out;
    },
  };
});

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
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";

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
  window.localStorage.clear();
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.location.hash = "";
  window.localStorage.clear();
});

test("a within-tolerance deficit keeps a met plan READY with no strip", async () => {
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  // Settle on a drawn-plan status first, so a wrong one fails by assertion
  // rather than by timeout.
  await waitFor(() =>
    expect(["READY", "SHORTFALL"]).toContain(canvasSpy.status),
  );
  expect(canvasSpy.status).toBe("READY");
  expect(screen.queryByRole("status")).toBeNull();
});
