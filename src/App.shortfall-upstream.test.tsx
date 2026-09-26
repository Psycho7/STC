// @vitest-environment jsdom
//
// The attribution case the shipped pack cannot state cleanly: a deficit sitting
// on a target whose OWN producer is available, because the restriction is one
// hop upstream of it. `make_mid` can only be built in the other settlement, so
// selecting `here` starves `prod` - and the strip must say only that `prod` is
// short, since the one-hop lookup cannot tie the blocked `mid` to it.
//
// The synthetic pack is mocked in over src/data/load so the whole app (plan
// validation, availability, solve, render) runs on this three-recipe chain. DEV
// is stubbed off for the same reason as App.shortfall.test.tsx: the DEV render
// invariant throws on exactly this class of plan.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Item, Machine, Recipe, RecipePack } from "@aef/schema";

const CHAIN_PACK: RecipePack = vi.hoisted(() => {
  const item = (id: string, raw: boolean) =>
    ({
      id,
      name: id,
      category: "material",
      icon: id,
      row: 0,
      stack: 100,
      raw,
      transportKind: "belt",
    }) as Item;
  const machine = (id: string, ...locations: string[]) =>
    ({
      id,
      name: id,
      icon: id,
      speed: 1,
      powerType: "electric",
      powerKw: 1,
      hideRate: false,
      locations,
    }) as Machine;
  const recipe = (
    id: string,
    inItem: string,
    outItem: string,
    producer: string,
  ) =>
    ({
      id,
      name: id,
      category: "material",
      icon: outItem,
      row: 0,
      time: 1,
      in: [{ item: inItem, qty: 1 }],
      out: [{ item: outItem, qty: 1 }],
      producers: [producer],
    }) as Recipe;
  return {
    schemaVersion: "0.2",
    source: {
      name: "chain",
      sourceRepo: "",
      sourceCommit: "0",
      gameVersion: "v1.5",
      extractedAt: "",
    },
    categories: [{ id: "material", name: "material", icon: "material" }],
    locations: [
      { id: "here", name: "here", icon: "here" },
      { id: "far", name: "far", icon: "far" },
      { id: "hub", name: "hub", icon: "hub" },
    ],
    items: [item("ore", true), item("mid", false), item("prod", false)],
    // hub builds both machines, so the READY control below has a settlement to
    // run in now that the app always restricts to one (#163).
    machines: [
      machine("m_here", "here", "hub"),
      machine("m_far", "far", "hub"),
    ],
    transports: [],
    recipes: [
      recipe("make_mid", "ore", "mid", "m_far"),
      recipe("make_prod", "mid", "prod", "m_here"),
    ],
  } as RecipePack;
});

vi.mock("./data/load", () => ({ pack: CHAIN_PACK }));

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
import { encodePlan, validatePlan, type Plan } from "./data/plan";
import { loadI18n } from "./data/i18n";
import { AREA_STORAGE_KEY } from "./data/storage-keys";
import { canvasSpy } from "./App.testkit";

const en = loadI18n("en");
const OLD_CAP_WORDING = "Raise the supply caps";

const PROD_PLAN: Plan = {
  version: 1,
  pack: { id: "chain", schemaVersion: "0.2", submoduleSha: "0" },
  title: "",
  targets: [{ itemId: "prod", ratePerSec: { num: "1", denom: "1" } }],
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
  canvasSpy.status = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.location.hash = "";
  window.localStorage.clear();
});

test("a restriction one hop upstream leaves the strip on neutral wording", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "here");
  // The target itself stays valid: make_prod can be built here, so nothing is
  // rejected - the plan solves and draws short.
  expect(validatePlan(PROD_PLAN, CHAIN_PACK)).toBeNull();
  window.location.hash = "#" + (await encodePlan(PROD_PLAN));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("SHORTFALL"));

  const strip = await screen.findByRole("status");
  expect(strip.textContent).not.toContain(OLD_CAP_WORDING);
  expect(strip.textContent).toBe(
    en.t("app.shortfall.unmet", { items: "prod" }),
  );
  // No cause may be named: prod's own producer is available, and the blocked
  // mid carries no deficit of its own.
  expect(strip.textContent).not.toContain("here");
  expect(strip.textContent).not.toContain("mid");
});

test("the same plan in the settlement that has both recipes is READY", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "hub");
  window.location.hash = "#" + (await encodePlan(PROD_PLAN));
  render(<App />);

  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("status")).toBeNull();
});
