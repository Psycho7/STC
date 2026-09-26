// @vitest-environment jsdom
//
// The header's non-default settings indicator: display only, hidden while the
// area is the latest settlement and every event cohort follows its default
// rule, and naming each setting that departs from that otherwise.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({
      nodes: [],
      edges: [],
      gaps: [],
      baseEdges: [],
    })),
  };
});

import App from "./App";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n, type Locale } from "./data/i18n";
import { latestArea, packCohortOf } from "./data/availability";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
} from "./data/storage-keys";

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

async function boot(locale: Locale): Promise<void> {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);
  await screen.findAllByTestId("target-row");
}

const nonLatestArea = pack.locations.find((l) => l.id !== latestArea(pack))!.id;
const packCohort = packCohortOf(pack);

describe.each<Locale>(["en", "zh"])("locale %s", (locale) => {
  const i18n = loadI18n(locale);

  test("hidden at the default area and events", async () => {
    await boot(locale);
    expect(screen.queryByTestId("settings-indicator")).toBeNull();
  });

  test("hidden when a stored override equals the cohort's default", async () => {
    window.localStorage.setItem(
      EVENT_COHORT_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [packCohort]: true }),
    );
    await boot(locale);
    expect(screen.queryByTestId("settings-indicator")).toBeNull();
  });

  test("names the area when it is not the latest settlement", async () => {
    window.localStorage.setItem(AREA_STORAGE_KEY, nonLatestArea);
    await boot(locale);
    const indicator = screen.getByTestId("settings-indicator");
    expect(indicator.textContent).toBe(i18n.displayName(nonLatestArea));
  });

  test("names an event cohort override that departs from its default", async () => {
    window.localStorage.setItem(
      EVENT_COHORT_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [packCohort]: false }),
    );
    await boot(locale);
    const indicator = screen.getByTestId("settings-indicator");
    expect(indicator.textContent).toBe(
      i18n.t("app.settings.event.off", { cohort: packCohort }),
    );
    expect(indicator.textContent).toContain(packCohort);
  });

  test("lists the area and the event override together", async () => {
    window.localStorage.setItem(AREA_STORAGE_KEY, nonLatestArea);
    window.localStorage.setItem(
      EVENT_COHORT_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [packCohort]: false }),
    );
    await boot(locale);
    const text = screen.getByTestId("settings-indicator").textContent ?? "";
    expect(text).toContain(i18n.displayName(nonLatestArea));
    expect(text).toContain(
      i18n.t("app.settings.event.off", { cohort: packCohort }),
    );
  });
});

test("the event override wording per locale", () => {
  expect(loadI18n("en").t("app.settings.event.off", { cohort: "v1.5" })).toBe(
    "v1.5 off",
  );
  expect(loadI18n("en").t("app.settings.event.on", { cohort: "v1.5" })).toBe(
    "v1.5 on",
  );
  expect(loadI18n("zh").t("app.settings.event.off", { cohort: "v1.5" })).toBe(
    "v1.5 活动已关闭",
  );
  expect(loadI18n("zh").t("app.settings.event.on", { cohort: "v1.5" })).toBe(
    "v1.5 活动已开启",
  );
});
