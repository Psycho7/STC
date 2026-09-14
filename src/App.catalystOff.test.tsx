// @vitest-environment jsdom
//
// The CATALYST_SUPPLY_EDGES=false half of the supply-row contract. With the
// flag off no product node carries the cycled draw, so the panel is the only
// place it can surface and App adds the solve's catalyst need onto the row.
// Both numbers match the ON twin in App.catalyst.test.tsx; only where they
// come from differs.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./flags", () => ({ CATALYST_SUPPLY_EDGES: false }));

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

test("the panel supplies the whole row for a non-raw catalyst item", async () => {
  window.location.hash = "#" + (await encodePlan(TRANSMUTER));
  render(<App />);

  await waitFor(
    () => {
      expect(autoRow("liquid_xiranite")).toBeDefined();
    },
    { timeout: 10000 },
  );
  // No product node is laid out at all, so the rate can only have come from
  // the catalyst draw: 1/10 per second is 6 per minute.
  const row = autoRow("liquid_xiranite")!;
  expect(
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  ).toBe("needed 6/min");
  expect(screen.getAllByTestId("input-auto-row").length).toBe(2);
});

test("the panel adds the catalyst draw to a raw item's balanced demand", async () => {
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
