// @vitest-environment jsdom
//
// A plan that decodes is plan state even when the viewer's area or event
// settings leave a target with no producer. The panels adopt it, nothing is
// solved for it, and a banner names each blocked item by display name with
// the setting that blocks it. That holds on a first load, on a navigation over
// a drawn plan, on a live settings flip, and on an edit made while blocked:
// never the damaged-link splash, never "cannot apply this change".
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

import App from "./App";
import { defaultPlan, encodePlan, loadPlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n, type Locale } from "./data/i18n";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY,
} from "./data/storage-keys";
import { LUNG_PLAN, flipStoredOverrides } from "./App.testkit";

// copper_nugget is Wuling-only: under Valley IV (tundra) none of its producers
// can be built.
const NUGGET_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } }],
};

// Solves in full under either area, so it can stand as a drawn plan.
const POWDER_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "iron_powder", ratePerSec: { num: "1", denom: "1" } }],
};

// Blocked under Valley IV through copper_nugget; shares no target with
// POWDER_PLAN and has one more row.
const NUGGET_AND_BOTTLE_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
  ],
};

const NUGGET_AND_POWDER_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "iron_powder", ratePerSec: { num: "1", denom: "1" } },
  ],
};

const VALLEY = "tundra";
const WULING = "jinlong";

// The texts that belong to other outcomes and must never show for a blocked
// plan: the damaged-link splash and the edit rejection wrapper.
function expectNoRejection(locale: Locale): void {
  const i18n = loadI18n(locale);
  const text = document.body.textContent ?? "";
  expect(text).not.toContain(i18n.t("app.error.corrupt"));
  expect(text).not.toContain(i18n.t("app.error.reset"));
  expect(text).not.toContain(i18n.t("app.error.edit", { message: "" }).trim());
}

function flipStoredArea(area: string): void {
  window.localStorage.setItem(AREA_STORAGE_KEY, area);
  fireEvent(window, new StorageEvent("storage", { key: AREA_STORAGE_KEY }));
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
  window.location.hash = "";
  window.localStorage.clear();
  canvasSpy.status = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

const LOAD_CASES = [
  {
    name: "an area-blocked target",
    plan: NUGGET_PLAN,
    itemId: "copper_nugget",
    setting: (locale: Locale) => loadI18n(locale).displayName(VALLEY),
    seed: () => window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY),
  },
  {
    name: "an event-blocked target",
    plan: LUNG_PLAN,
    itemId: "activity_xiranite_lung",
    setting: () => "v1.5",
    seed: () =>
      window.localStorage.setItem(
        EVENT_COHORT_OVERRIDES_STORAGE_KEY,
        '{"v1.5": false}',
      ),
  },
];

const LOCALES: Locale[] = ["en", "zh"];

test.each(
  LOCALES.flatMap((locale) => LOAD_CASES.map((c) => ({ ...c, locale }))),
)(
  "first load of $name adopts the plan under the blocked banner ($locale)",
  async ({ plan, itemId, setting, seed, locale }) => {
    const i18n = loadI18n(locale);
    window.localStorage.setItem("aef.locale", locale);
    seed();
    const hash = "#" + (await encodePlan(plan));
    window.location.hash = hash;
    render(<App />);

    const rows = await screen.findAllByTestId("target-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.innerHTML).toContain(i18n.displayName(itemId));
    expect(screen.getByTestId("header-strip")).toBeTruthy();

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain(i18n.displayName(itemId));
    expect(banner.textContent).not.toContain(itemId);
    expect(banner.textContent).toContain(setting(locale));
    expect(banner.textContent).toContain(i18n.t("app.error.blocked.settings"));
    // The gear the banner points at is the header's own.
    expect(
      screen.getByRole("button", { name: i18n.t("settings.open.label") }),
    ).toBeTruthy();
    expectNoRejection(locale);

    // Nothing was solved for it: the empty canvas reads as stale.
    await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
    expect(window.location.hash).toBe(hash);
  },
);

test("a navigation to a blocked plan over a drawn plan adopts it and marks the drawing stale", async () => {
  const en = loadI18n("en");
  window.localStorage.setItem("aef.locale", "en");
  window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY);
  window.location.hash = "#" + (await encodePlan(POWDER_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  expect(screen.getAllByTestId("target-row")[0]!.innerHTML).toContain(
    en.displayName("iron_powder"),
  );

  // A different item set and a different row count, so only an adoption of
  // the navigated plan can satisfy the panel asserts below.
  const hash = "#" + (await encodePlan(NUGGET_AND_BOTTLE_PLAN));
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await waitFor(() =>
    expect(screen.getAllByTestId("target-row").length).toBe(2),
  );
  const panelText = screen
    .getAllByTestId("target-row")
    .map((row) => row.innerHTML)
    .join("\n");
  expect(panelText).toContain(en.displayName("copper_nugget"));
  expect(panelText).toContain(en.displayName("copper_bottle"));
  expect(panelText).not.toContain(en.displayName("iron_powder"));
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(en.displayName("copper_nugget"));
  expect(banner.textContent).toContain(en.displayName(VALLEY));
  expectNoRejection("en");
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
  // No restore: the URL keeps the adopted plan's hash.
  await new Promise((r) => setTimeout(r, 25));
  expect(window.location.hash).toBe(hash);
});

test("a settings-panel area flip that orphans a target keeps the area and adopts the blocked state; flipping back re-solves", async () => {
  const en = loadI18n("en");
  window.localStorage.setItem("aef.locale", "en");
  window.location.hash = "#" + (await encodePlan(NUGGET_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: en.displayName(VALLEY) }),
  );

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(en.displayName("copper_nugget"));
  expect(banner.textContent).toContain(en.displayName(VALLEY));
  expectNoRejection("en");
  expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBe(VALLEY);
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: en.displayName(WULING),
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBe(WULING);
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
});

test("a cross-tab event flip that orphans a target adopts the blocked state in zh; flipping back re-solves", async () => {
  const zh = loadI18n("zh");
  window.localStorage.setItem("aef.locale", "zh");
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  flipStoredOverrides('{"v1.5": false}');

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(
    zh.displayName("activity_xiranite_lung"),
  );
  expect(banner.textContent).not.toContain("activity_xiranite_lung");
  expect(banner.textContent).toContain("v1.5");
  expectNoRejection("zh");
  expect(
    window.localStorage.getItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY),
  ).toContain('"v1.5":false');
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  flipStoredOverrides('{"v1.5": true}');
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

// The rule has no edit-rejection branch either: an edit to another row while
// a target is blocked commits into the panels under the same banner, and it
// is part of the plan that solves once the setting is flipped back.
test("an edit made while a target is blocked is adopted, not rejected", async () => {
  const en = loadI18n("en");
  window.localStorage.setItem("aef.locale", "en");
  window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY);
  window.location.hash = "#" + (await encodePlan(NUGGET_AND_POWDER_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await screen.findByRole("alert");

  const input = screen.getByLabelText(
    `Rate for ${en.displayName("iron_powder")}`,
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "600" } });
  fireEvent.blur(input);

  await waitFor(() =>
    expect(
      (
        screen.getByLabelText(
          `Rate for ${en.displayName("iron_powder")}`,
        ) as HTMLInputElement
      ).value,
    ).toBe("600"),
  );
  const banner = screen.getByRole("alert");
  expect(banner.textContent).toContain(en.displayName("copper_nugget"));
  expectNoRejection("en");
  expect(canvasSpy.status).toBe("ERROR");

  flipStoredArea(WULING);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  const outcome = await loadPlan(window.location.hash, pack);
  expect(outcome.kind).toBe("loaded");
  if (outcome.kind !== "loaded") return;
  const powder = outcome.plan.targets.find((t) => t.itemId === "iron_powder");
  expect(powder?.ratePerSec).toEqual({ num: "10", denom: "1" });
});
