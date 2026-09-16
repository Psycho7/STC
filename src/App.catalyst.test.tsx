// @vitest-environment jsdom
//
// A catalyst charge is external supply like a raw draw, so it has to reach the
// inputs panel: a non-raw catalyst item gets a row the raw flag would never
// give it, and a raw catalyst item's general row shows the charge billed to it
// ADDED to its balanced demand, not in place of it.
//
// The fold that feeds those rows is keyed by ROW KEY, not by item: the
// u:in:<item> node lands under the item id and the u:cat:<item> node under
// "<item>#cat", so the general row reads its own ordinary rate and the
// catalyst part comes from the solve's catalystAccount. Summing the two nodes
// per item (the interim this replaces) would double-count the charge.
//
// layoutRenderPlan is mocked so the product nodes the fold reads are fixed by
// the test rather than by the layout pass, which keeps the assertion on the
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

// The "N/min catalyst" tag on a general row, as a number. It is the account's
// fromGeneral, which the solve computes for the real pack rather than the
// mocked layout, so the assertions below relate it to the node rates instead
// of pinning it.
function catalystPart(row: HTMLElement): number {
  const text =
    row.querySelector('[data-testid="input-catalyst-part"]')?.textContent ?? "";
  const m = /^([\d.]+)\/min catalyst$/.exec(text);
  if (m === null) throw new Error(`no catalyst tag: ${text}`);
  return Number(m[1]);
}

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

test("a non-raw catalyst item gets a supply row carrying its cycled charge", async () => {
  // The pipeline draws the cycled charge from a catalyst node of its own, and
  // that is the item's only node: the general row has no ordinary rate, so
  // what it shows is the charge the account billed to the general pool.
  vi.mocked(layoutRenderPlan).mockResolvedValue({
    nodes: [
      {
        id: "cat:liquid_xiranite",
        type: "product",
        position: { x: 0, y: 0 },
        data: {
          kind: "inputProduct",
          itemId: "liquid_xiranite",
          role: "catalyst",
          rate: { num: "1", denom: "10" },
        },
      },
    ],
    edges: [],
  } as unknown as Awaited<ReturnType<typeof layoutRenderPlan>>);

  window.location.hash = "#" + (await encodePlan(TRANSMUTER));
  render(<App />);

  await waitFor(
    () => {
      expect(autoRow("liquid_xiranite")).toBeDefined();
    },
    { timeout: 10000 },
  );
  // assumedRawItemIds keeps its item-id shape: the row is found by the bare
  // item id, and the item is not raw, so only the charge earns it.
  const row = autoRow("liquid_xiranite")!;
  expect(row.getAttribute("data-is-raw")).toBe("false");
  // The account reached the panel: the general row carries the "from catalyst"
  // tag, and with no ordinary rate under the item key the row total IS it.
  const part = catalystPart(row);
  expect(
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  ).toBe(`needed ${part}/min`);
  // The row is an ordinary supply row, so the stats strip counts it. Both of
  // the plan's catalysts earn one: the charge the general pool holds is a
  // general number even for the item this mocked layout gave no node.
  const strip = screen.getByTestId("stats-strip");
  expect(
    screen
      .getAllByTestId("input-auto-row")
      .map((r) => r.getAttribute("data-item-id")),
  ).toEqual(["gas_xiranite", "liquid_xiranite"]);
  expect(strip.querySelectorAll(".strip-stat .val")[1]?.textContent).toContain(
    "2",
  );
});

test("a raw catalyst item's general row reads its ordinary node, not both", async () => {
  // 1/2 per second of balanced gas_xiranite demand on the ordinary node plus
  // 1/10 per second of cycled charge on the catalyst node. The two land under
  // different row keys, so the general row shows 30/min of ordinary draw plus
  // the charge the account billed to the general pool - never the catalyst
  // node's rate as well, which is what the per-item sum used to add.
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
      {
        id: "cat:gas_xiranite",
        type: "product",
        position: { x: 0, y: 0 },
        data: {
          kind: "inputProduct",
          itemId: "gas_xiranite",
          role: "catalyst",
          rate: { num: "1", denom: "10" },
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
  const part = catalystPart(row);
  expect(
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  ).toBe(`needed ${30 + part}/min`);
});
