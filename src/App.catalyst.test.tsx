// @vitest-environment jsdom
//
// The catalyst draw the solver reports is external supply like a raw draw, so
// it has to reach the inputs panel as an ordinary supply row: a non-raw
// catalyst item gets a row the raw flag would never give it, and a raw
// catalyst item's row shows the cycled draw ADDED to its balanced demand, not
// in place of it.
//
// layoutRenderPlan is mocked so the product nodes the fold adds to are fixed
// by the test rather than by the layout pass, which keeps the assertion on the
// fold itself. Canvas is stubbed; it draws nothing this file reads.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

vi.mock("./canvas/Canvas", () => ({ default: () => null }));

import App from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { defaultPlan, encodePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";

// A liquid-gas transmuter target: liquid_copper comes off phase_trans_1, whose
// catalyst is the non-raw liquid_xiranite, and its gas_copper feed comes off a
// solid-gas transmuter whose catalyst is the raw gas_xiranite. At 1 per second
// each catalyst draws 1/10 per second, which is the 6 per minute per machine
// the pack declares.
const TRANSMUTER: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "liquid_copper", ratePerSec: { num: "1", denom: "1" } }],
  itemOverrides: [],
};

function autoRow(itemId: string): HTMLElement | undefined {
  return screen
    .getAllByTestId("input-auto-row")
    .find((r) => r.getAttribute("data-item-id") === itemId);
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
  // The DEV-only render-invariant hook is not part of the panel fold under
  // test here, and it runs over a render plan this file deliberately does not
  // lay out.
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

test("a non-raw catalyst item gets a supply row carrying its 6 per minute draw", async () => {
  window.location.hash = "#" + (await encodePlan(TRANSMUTER));
  render(<App />);

  await waitFor(
    () => {
      expect(autoRow("liquid_xiranite")).toBeDefined();
    },
    { timeout: 10000 },
  );
  // No product node carries liquid_xiranite (the solver expands no producer
  // for a catalyst), so the rate on the row can only have come from the
  // catalyst draw: 1/10 per second is 6 per minute.
  const row = autoRow("liquid_xiranite")!;
  expect(
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  ).toBe("needed 6/min");
  // The row is an ordinary supply row, so the stats strip counts it: with no
  // product nodes laid out, the two catalysts are the only supply rows on
  // screen.
  const strip = screen.getByTestId("stats-strip");
  expect(screen.getAllByTestId("input-auto-row").length).toBe(2);
  expect(strip.querySelectorAll(".strip-stat .val")[1]?.textContent).toContain(
    "2",
  );
});

test("a raw catalyst item's row adds the catalyst draw to its balanced demand", async () => {
  // 1/2 per second of balanced gas_xiranite demand from the render pass; the
  // solve adds 1/10 per second of catalyst draw on top, so the row must read
  // (1/2 + 1/10) * 60 = 36 per minute. An overwrite would read 30 or 6.
  vi.mocked(layoutRenderPlan).mockResolvedValue({
    nodes: [
      {
        id: "in:gas_xiranite",
        type: "product",
        position: { x: 0, y: 0 },
        data: {
          kind: "inputProduct",
          itemId: "gas_xiranite",
          rate: { num: "1", denom: "2" },
        },
      },
    ],
    edges: [],
    // The mocked layout stands in for a full pass; only the product nodes the
    // fold reads matter here.
  } as unknown as Awaited<ReturnType<typeof layoutRenderPlan>>);

  window.location.hash = "#" + (await encodePlan(TRANSMUTER));
  render(<App />);

  await waitFor(
    () => {
      expect(autoRow("gas_xiranite")).toBeDefined();
    },
    { timeout: 10000 },
  );
  const row = autoRow("gas_xiranite")!;
  expect(
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  ).toBe("needed 36/min");
});
