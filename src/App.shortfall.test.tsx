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

vi.mock("./canvas/Canvas", async () => {
  const { canvasSpy } = await import("./App.testkit");
  return {
    default: (props: { status?: string }) => {
      canvasSpy.status = props.status ?? "";
      return null;
    },
  };
});

import App from "./App";
import { defaultPlan, encodePlan, validatePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { AREA_STORAGE_KEY } from "./data/storage-keys";
import { canvasSpy, flipStoredArea } from "./App.testkit";

const en = loadI18n("en");
// The sentence the strip used to print for every shortfall, cause unknown or
// not. Asserted against so no case silently returns to blaming supply caps.
const OLD_CAP_WORDING = "Raise the supply caps";

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

test("an exhausted cap is named as the shortfall's cause", async () => {
  expect(validatePlan(CAPPED, pack)).toBeNull();
  window.location.hash = "#" + (await encodePlan(CAPPED));
  render(<App />);

  await screen.findAllByTestId("target-row");

  // Ruling R9: a drawn plan with unmet demand is a SHORTFALL, deliberate cap
  // included - not READY.
  await waitFor(() => expect(canvasSpy.status).toBe("SHORTFALL"));

  // The strip names the under-delivered target, which is what the compare
  // yields, and the cap it may blame: the plan pulls the whole 1/2 per second
  // gas_inert allowance, so that cap demonstrably binds.
  const strip = await screen.findByRole("status");
  expect(strip.textContent).toContain(en.displayName("copper_jar"));
  expect(strip.textContent).toContain(
    en.t("app.shortfall.cause.cap", { items: en.displayName("gas_inert") }),
  );
  // The plan still draws: this is a warning about the graph, not a failure
  // that replaces it.
  expect(screen.getAllByTestId("target-row").length).toBe(1);
  // It is not the dismissible error banner, and it does not mark the canvas
  // stale: the render matches the solve, the solve just falls short.
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a satisfiable plan raises no status strip", async () => {
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("status")).toBeNull();
});

// The C1 regression, as the review probe found it: under tundra two of the
// default plan's targets come up short, every one of their direct producers
// is available, and no cap is declared at all. There is no evidence for any
// explanation, so the strip may only state what is unmet. (iron_powder, the
// third target, is met exactly now that the LP rejects a tie-break pass that
// breaks its balance row.)
test("an area-caused shortfall with available direct producers stays neutral", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "tundra");
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("SHORTFALL"));

  const strip = await screen.findByRole("status");
  expect(strip.textContent).not.toContain(OLD_CAP_WORDING);
  expect(strip.textContent).toBe(
    en.t("app.shortfall.unmet", {
      items: ["copper_bottle", "copper_powder"]
        .map((id) => en.displayName(id))
        .join(", "),
    }),
  );
  // Neither the settlement nor the item it actually blocks (copper_nugget,
  // which carries no deficit) may be named: the one-hop lookup cannot tie
  // either to these two targets.
  expect(strip.textContent).not.toContain(en.displayName("tundra"));
  expect(strip.textContent).not.toContain(
    en.t("app.shortfall.cause.area", {
      items: en.displayName("copper_nugget"),
      area: en.displayName("tundra"),
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("resolving the shortage returns the status to READY", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "tundra");
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("SHORTFALL"));

  // Another tab clears the settlement: the same plan now solves in full, so
  // the strip has to go with the shortfall it described.
  flipStoredArea(undefined);

  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("status")).toBeNull();
});

// A rejection is not a shortfall: nothing solved, so the status is ERROR and
// the dismissible banner - not the strip - carries the reason.
test("an availability change that rejects the plan reports ERROR", async () => {
  const NUGGET: Plan = {
    ...defaultPlan(pack),
    targets: [
      { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    ],
  };
  window.location.hash = "#" + (await encodePlan(NUGGET));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  // copper_nugget has no producer that can be built in tundra, so selecting it
  // invalidates the committed plan.
  flipStoredArea("tundra");

  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    en.displayName("tundra"),
  );
  expect(screen.queryByRole("status")).toBeNull();
});
