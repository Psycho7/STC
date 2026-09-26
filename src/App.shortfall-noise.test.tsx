// @vitest-environment jsdom
//
// The noise twin of App.shortfall.test.tsx. A plan whose targets the tolerant
// compare (targetOutputShortfalls, relSlack) holds as delivered can still
// carry a sub-tolerance entry in the LP's raw deficit map - a 1/2000000 per
// second iron_powder residue (strictly under the tolerance's 1e-6 slack) is
// the model. The status gate reads the same tolerant under-delivery list the strip
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

// The residue each test injects, as fraction-parseable strings. Set in the
// test body and read at solve time, so both cases below share one mock.
const injected = vi.hoisted(() => ({ deficits: [] as [string, string][] }));

vi.mock("./pipeline/solveForRender", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("./pipeline/solveForRender")>();
  return {
    ...orig,
    solveFromPlan: (...args: Parameters<typeof orig.solveFromPlan>) => {
      const out = orig.solveFromPlan(...args);
      const deficits = new Map(out.full.feasibility.deficits);
      for (const [item, rate] of injected.deficits) {
        deficits.set(item, new Fraction(rate));
      }
      out.full.feasibility.deficits = deficits;
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
import { loadI18n } from "./data/i18n";
import { AREA_STORAGE_KEY } from "./data/storage-keys";

const en = loadI18n("en");

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
  injected.deficits = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.location.hash = "";
  window.localStorage.clear();
});

test("a within-tolerance deficit keeps a met plan READY with no strip", async () => {
  injected.deficits = [["iron_powder", "1/2000000"]];
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

// The strip's cause attribution reads the same tolerance: a sub-tolerance
// residue on an item whose producers are ALL off (copper_nugget under tundra)
// is not a shortfall that item has, so no cause clause may name it.
test("a sub-tolerance deficit on an all-producers-off item names no cause", async () => {
  injected.deficits = [["copper_nugget", "1/1000000000"]];
  window.localStorage.setItem(AREA_STORAGE_KEY, "tundra");
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("SHORTFALL"));

  const strip = await screen.findByRole("status");
  // The exact sentence pins the item list too (copper_nugget's display name
  // is a prefix of copper_bottle's, so a containment check cannot).
  // iron_powder is met exactly under tundra, so it is not in the list.
  expect(strip.textContent).toBe(
    en.t("app.shortfall.unmet", {
      items: ["copper_bottle", "copper_powder"]
        .map((id) => en.displayName(id))
        .join(", "),
    }),
  );
  expect(strip.textContent).not.toContain(en.displayName("tundra"));
});
