// @vitest-environment jsdom
//
// Event-cohort overrides against the whole app (#144): the v1.5 cohort
// defaults on (it matches the pack's own version), so a plan targeting an
// event item solves; a stored `false` flips it off, and the boot validation
// failure names the cohort in the UI language (default locale zh - no
// aef.locale is seeded). A mid-session flip is driven through the `storage`
// event a second browser tab would fire, which routes through the same
// override writer the T5 settings panel will use: the committed plan must
// re-validate WITHOUT clearing the render, and flipping back must re-solve.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { defaultPlan, encodePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";
import { pickerTile } from "./components/panel.testkit";

// The lung is v1.5 event content whose only producer is the event recipe of
// the same id: with the cohort on it solves through that recipe, with it off
// the target has no available producer at all.
const LUNG_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "activity_xiranite_lung", ratePerSec: { num: "1", denom: "1" } },
  ],
};

// The localized producer-unavailable copy the splash and banner must render:
// raw item id plus the cohort, per the T3 string.
const zhCohortError = loadI18n("zh").t("app.error.producer-unavailable.event", {
  itemId: "activity_xiranite_lung",
  cohort: "v1.5",
});

// Simulate another tab flipping a cohort: same-document writes fire no
// `storage` event, so the test writes the key and then dispatches the event
// the browser would have delivered to the other windows.
function flipStoredOverrides(json: string): void {
  window.localStorage.setItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY, json);
  fireEvent(
    window,
    new StorageEvent("storage", { key: EVENT_COHORT_OVERRIDES_STORAGE_KEY }),
  );
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
  // Deliberately no aef.locale: these tests run the default zh locale, which
  // is what the localized assertions below pin. Anything left from an earlier
  // test would silently switch them to English.
  window.localStorage.clear();
  canvasSpy.status = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

test("the lung plan boots solved with no stored override (pack cohort on)", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  expect(await screen.findAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a stored on override boots the same plan solved", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": true}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  expect(await screen.findAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a stored off override boots to the localized cohort validation error", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  // No plan ever commits, so the failure owns the viewport as the themed
  // recovery splash - not the dismissible banner over a live canvas.
  const alert = await screen.findByRole("alert");
  expect(alert.closest(".ak-app-shell")).not.toBeNull();
  expect(alert.textContent).toContain(zhCohortError);
  expect(alert.textContent).toContain("v1.5");
  expect(screen.queryByTestId("side-panel")).toBeNull();
  expect(screen.queryByTestId("target-row")).toBeNull();
});

test("a mid-session flip off banners without clearing the render; flipping back re-solves", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  // Another tab switches v1.5 off. The committed plan re-validates against
  // the new availability set: banner plus stale, but the last render stays.
  flipStoredOverrides('{"v1.5": false}');

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhCohortError);
  // Routed through the edit wrapper ("cannot apply this change"), not load.
  expect(banner.textContent).toContain("无法应用此更改");
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  // Flipping the cohort back re-solves the same plan: the banner clears and
  // the canvas returns to READY.
  flipStoredOverrides('{"v1.5": true}');

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
});

// The settings panel (T5) is the in-app writer for those overrides: the header
// gear button opens the modal, whose Events section names the cohort in the UI
// language. Escape is one of its three close paths.
test("the header gear button opens the settings panel; Escape closes it", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("v1.5");
  expect(dialog.textContent).toContain("当前");
  expect(
    (screen.getByRole("switch", { name: "切换 v1.5 活动" }) as HTMLInputElement)
      .checked,
  ).toBe(true);

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Reopening works after a close.
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

// The pickers (T6): App derives the off-cohort item map from the stored
// overrides and hands it to both panels, so their tiles dim and the hint names
// the cohort the validation error also names - default zh locale here.
test("a stored off override dims the cohort's items in both pickers with the hint", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  render(<App />);
  await screen.findByTestId("side-panel");

  // Targets picker: the add-target draft's choose trigger.
  fireEvent.click(screen.getByRole("button", { name: "添加目标" }));
  fireEvent.click(screen.getByLabelText("选择物品…"));
  const lungTile = pickerTile("activity_xiranite_lung")!;
  expect(lungTile).not.toBeNull();
  expect(lungTile.disabled).toBe(true);
  const targetHint = document.querySelector('[data-testid="picker-hint"]')!;
  expect(targetHint.textContent).toBe(
    loadI18n("zh").t("picker.event.off", { cohorts: "v1.5" }),
  );
  fireEvent.keyDown(document, { key: "Escape" });

  // Inputs picker: same cohort, same dimming, same hint line.
  fireEvent.click(screen.getByRole("button", { name: "添加输入" }));
  const polyTile = pickerTile("activity_copper_poly")!;
  expect(polyTile).not.toBeNull();
  expect(polyTile.disabled).toBe(true);
  const inputHint = document.querySelector('[data-testid="picker-hint"]')!;
  expect(inputHint.textContent).toBe(
    loadI18n("zh").t("picker.event.off", { cohorts: "v1.5" }),
  );
});
